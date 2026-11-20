/* OpenCL C「出」：核心 IR（已過 FaIrPrep.prepare）→ OpenCL C 核心原始碼。純函式 UMD。
 *   emit(ir, opts) → { code, kernels:[{name, params, globalSize}], diags }
 *
 * 輸出目標是 renderer/src/gpu/cl_front.js 能解析的子集（再往下是 KIR → WebGL2／WebGPU／JS），所以範圍刻意很小，超出就報 error、不亂翻：
 *   一個「核心函式」＝只含一個最外層的平行迴圈：  for i in range(n): 本體   （起點 0、步長 1；n 是整數參數或整數字面值）
 *   - 參數：list[float]（緩衝區）、int、float。緩衝區只能讀或只能寫，不能同時（KIR 的限制）；沒有 int 緩衝區。
 *   - 平行安全檢查：寫入只能是 buf[i]（i＝迴圈變數，一個工作項只寫自己那格）；迴圈外的變數不能在迴圈內被改（歸約、前綴和不是逐元素核心）；
 *     不能對緩衝區做 aug（讀寫同一個）。
 *   - 本體語句：區域變數宣告／賦值（int、float）、x op= e（+ - * /）、buf[i] = e、內層 for j in range(常數或整數參數)、if（沒有 else）。
 *   - 運算式：+ - * /、一元負號、比較、條件式（條件須是比較）、buf[整數運算式]、abs／min／max／math.sqrt／math.floor、int()／float()。
 *   - 不支援（報錯）：%、//（Python 向下取整，與 C 不同，cl_front 也沒有）、and／or／not、else、while、foreach、字串、串列、
 *     math.sin／cos／exp／pow（標準操作目錄還沒有這幾個，會是 native）。
 * 精度：OpenCL 核心用 float32，Python 是 float64；對照時要用容差，不是逐位元相同。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js')); else root.FaIrOutOpenCL = factory(root.FaIr); })(typeof self !== 'undefined' ? self : this, function (IR) {
    'use strict';
    const RESERVED = new Set(['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', 'uint', 'uchar', 'ushort', 'ulong', 'half', 'bool', 'kernel', 'global', 'local', 'constant', 'private', 'float4', 'int4', 'get_global_id', 'get_local_id', 'get_group_id', 'get_global_size', 'sqrt', 'rsqrt', 'min', 'max', 'abs', 'fabs', 'floor', 'pow', 'exp', 'sin', 'cos', 'barrier']);
    const safe = (n) => (RESERVED.has(n) ? 'u_' + n : n);
    const PREC = { cond: 3, '==': 9, '!=': 9, '<': 10, '<=': 10, '>': 10, '>=': 10, '+': 12, '-': 12, '*': 13, '/': 13, un: 15, atom: 20 };

    class Stop extends Error {}   // 這個函式放棄（已記 error）

    function emit(ir, opts) {
        opts = opts || {};
        const diags = [], kernels = [], out = [];
        const diag = (level, msg, n) => diags.push({ level, msg, pos: n && n.pos });
        for (const f of IR.funcs(ir)) {
            if (opts.only && opts.only.indexOf(f.name) < 0) continue;
            const loop = kernelLoop(f);
            if (!loop) { if (opts.only) diag('error', f.name + '：不是核心函式（本體要是單一個 for i in range(n)）', f); else diag('info', f.name + '：不是核心函式，略過', f); continue; }
            try { const k = oneKernel(f, loop, diag); out.push(k.code); kernels.push(k.meta); } catch (e) { if (!(e instanceof Stop)) throw e; }
        }
        return { code: out.join('\n'), kernels, diags };
    }

    // 函式本體剝掉註解／pass 之後只剩一個 forrange，才算核心函式
    function kernelLoop(f) {
        const body = (f.body || []).filter((s) => s.k !== 'comment' && s.k !== 'pass' && !(s.k === 'expr' && s.e && s.e.k === 'lit' && s.e.t === 'str'));
        return body.length === 1 && body[0].k === 'forrange' ? body[0] : null;
    }

    function oneKernel(f, loop, diag) {
        const fail = (msg, n) => { diag('error', f.name + '：' + msg, n || f); throw new Stop(); };
        const isLit0 = (e) => e && e.k === 'lit' && e.t === 'int' && String(e.v) === '0';
        if (!isLit0(loop.from)) fail('平行迴圈的起點要是 0', loop);
        if (loop.step && !(loop.step.k === 'lit' && String(loop.step.v) === '1')) fail('平行迴圈的步長要是 1', loop);
        const gid = loop.var;

        // ---- 參數 ----
        const params = [], bufs = {}, scal = {}; const env = {};   // env：名稱 → 'int'|'float'
        for (const p of f.params || []) {
            const t = p.ty || { t: 'unknown' };
            if (t.t === 'list') {
                const el = t.a && t.a[0] && t.a[0].t;
                if (el !== 'float') fail('緩衝區 ' + p.name + ' 的元素型別是 ' + IR.tyStr(t) + '；KIR 只有 float 緩衝區（list[float]）');
                bufs[p.name] = { name: p.name, reads: 0, writes: 0 }; params.push({ kind: 'buf', name: p.name, elem: 'f32' });
            } else if (t.t === 'int' || t.t === 'float') { scal[p.name] = t.t; env[p.name] = t.t; params.push({ kind: 'scalar', name: p.name, type: t.t === 'int' ? 'i32' : 'f32' }); }
            else fail('參數 ' + p.name + ' 的型別 ' + IR.tyStr(t) + ' 不支援（要是 list[float]、int、float；沒標註請補上）');
        }
        // ---- 迴圈上界 ----
        const to = loop.to; let bound;
        if (to.k === 'lit' && to.t === 'int') bound = String(to.v);
        else if (to.k === 'name' && scal[to.v] === 'int') bound = safe(to.v);
        else fail('平行迴圈的上界要是整數參數或整數字面值（用 len(buf) 不行，請多傳一個 n）', loop);
        env[gid] = 'int';

        // ---- 先掃一遍：迴圈內宣告的區域變數（其餘被賦值的外部變數＝迴圈承載相依） ----
        const locals = new Set([gid]);
        IR.walkStmts(loop.body, (s) => { if (s.k === 'assign' && s.to.k === 'name' && s.decl) locals.add(s.to.v); if (s.k === 'forrange') locals.add(s.var); });

        let tmp = 0; const lines = [];
        const ind = (d) => '  '.repeat(d);

        // ---- 運算式：回傳 {s, p, t} ----
        const wrap = (x, min) => (x.p < min ? '(' + x.s + ')' : x.s);
        const cast = (x, t) => (x.t === t ? x : { s: '(' + t + ')' + wrap(x, PREC.un), p: PREC.un, t });
        const numLit = (e) => {
            if (e.t === 'int') return { s: String(e.v), p: PREC.atom, t: 'int' };
            if (e.t === 'float') { let v = String(e.v); if (!/[.eE]/.test(v)) v += '.0'; return { s: v + 'f', p: PREC.atom, t: 'float' }; }
            return fail('不支援的字面值型別 ' + e.t + '（只有 int、float）', e);
        };
        function ex(e) {
            switch (e.k) {
                case 'lit': return numLit(e);
                case 'name': { const t = env[e.v]; if (!t) fail('變數 ' + e.v + ' 沒有型別（未宣告、是緩衝區本身，或型別推不出）', e); return { s: safe(e.v), p: PREC.atom, t }; }
                case 'bin': {
                    if (['+', '-', '*', '/'].indexOf(e.op) < 0) fail('運算子 ' + e.op + ' 不支援（// 與 % 的 Python 語意與 C 不同；** 請用標準操作）', e);
                    let l = ex(e.l), r = ex(e.r); const t = e.op === '/' || l.t === 'float' || r.t === 'float' ? 'float' : 'int';
                    l = cast(l, t); r = cast(r, t); const p = PREC[e.op]; return { s: wrap(l, p) + ' ' + e.op + ' ' + wrap(r, p + 1), p, t };
                }
                case 'un': { if (e.op !== '-') fail('一元運算子 ' + e.op + ' 不支援', e); const x = ex(e.e); return { s: '-' + wrap(x, PREC.un), p: PREC.un, t: x.t }; }
                case 'cond': { const c = cmp(e.c); let a = ex(e.a), b = ex(e.b); const t = a.t === 'float' || b.t === 'float' ? 'float' : 'int'; a = cast(a, t); b = cast(b, t); return { s: c + ' ? ' + wrap(a, PREC.cond + 1) + ' : ' + wrap(b, PREC.cond + 1), p: PREC.cond, t }; }
                case 'index': {
                    if (e.o.k !== 'name' || !bufs[e.o.v]) return fail('索引的對象不是緩衝區參數', e);
                    const i = ex(e.i); if (i.t !== 'int') fail('緩衝區索引要是整數', e);
                    bufs[e.o.v].reads++; return { s: safe(e.o.v) + '[' + i.s + ']', p: PREC.atom, t: 'float' };
                }
                case 'call': return call(e);
                case 'logic': case 'not': return fail('and／or／not 不支援（cl_front 沒有 && || !）；請改成巢狀 if 或條件式', e);
                case 'native': return fail('原生片段 ' + e.src + ' 不能翻譯（' + (e.why || '不在標準操作目錄') + '；math.sin／cos／exp／pow 尚未進目錄）', e);
                default: return fail('運算式種類 ' + e.k + ' 不支援', e);
            }
        }
        function call(e) {
            if (!e.op) return fail('呼叫使用者函式 ' + e.fn + ' 不支援（核心裡沒有自定義函式）', e);
            const a = (e.args || []).map(ex), op = e.op, f1 = (n) => ({ s: n + '(' + a[0].s + ')', p: PREC.atom });
            switch (op) {
                case 'math.sqrt': return Object.assign(f1('sqrt'), { s: 'sqrt(' + cast(a[0], 'float').s + ')', t: 'float' });
                case 'math.floor': return { s: '(int)floor(' + cast(a[0], 'float').s + ')', p: PREC.un, t: 'int' };
                case 'num.abs': return { s: (a[0].t === 'float' ? 'fabs(' : 'abs(') + a[0].s + ')', p: PREC.atom, t: a[0].t };
                case 'num.min': case 'num.max': { const t = a[0].t === 'float' || a[1].t === 'float' ? 'float' : 'int'; return { s: (op === 'num.min' ? 'min(' : 'max(') + cast(a[0], t).s + ', ' + cast(a[1], t).s + ')', p: PREC.atom, t }; }
                case 'num.div': return { s: wrap(cast(a[0], 'float'), PREC['/']) + ' / ' + wrap(cast(a[1], 'float'), PREC['/'] + 1), p: PREC['/'], t: 'float' };
                case 'conv.int': return { s: '(int)' + wrap(a[0], PREC.un), p: PREC.un, t: 'int' };
                case 'conv.float': return { s: '(float)' + wrap(a[0], PREC.un), p: PREC.un, t: 'float' };
                case 'int.mod': case 'int.floordiv': return fail(op === 'int.mod' ? '整數 % 不支援（Python 的餘數跟除數同號，C 跟被除數同號；cl_front 也沒有 %）' : '整數 // 不支援（Python 向下取整，C 向零取整）', e);
                default: return fail('標準操作 ' + op + ' 在 OpenCL 輸出器沒有對應', e);
            }
        }
        function cmp(e) {
            if (!e || e.k !== 'cmp') return fail('條件要是單一個比較（cl_front 的 if 只收比較式；and／or／not 請改寫）', e);
            if (['<', '<=', '>', '>=', '==', '!='].indexOf(e.op) < 0) fail('比較運算子 ' + e.op + ' 不支援', e);
            let l = ex(e.l), r = ex(e.r); const t = l.t === 'float' || r.t === 'float' ? 'float' : 'int'; l = cast(l, t); r = cast(r, t);
            return wrap(l, PREC[e.op] + 1) + ' ' + e.op + ' ' + wrap(r, PREC[e.op] + 1);
        }

        // ---- 敘述 ----
        function block(body, d) { body.forEach((s) => stmt(s, d)); }
        function stmt(s, d) {
            switch (s.k) {
                case 'comment': lines.push(ind(d) + '// ' + String(s.s).replace(/[\r\n]+/g, ' ')); return;
                case 'pass': return;
                case 'assign': {
                    if (s.to.k === 'index') {   // 緩衝區寫入
                        const o = s.to.o; if (o.k !== 'name' || !bufs[o.v]) return fail('賦值的對象不是緩衝區參數', s);
                        if (!(s.to.i.k === 'name' && s.to.i.v === gid)) fail('寫入 ' + o.v + ' 的位置不是 ' + gid + '（工作項只能寫自己那一格；否則多個工作項會寫到同一處，不是逐元素核心）', s);
                        bufs[o.v].writes++; const v = cast(ex(s.val), 'float'); lines.push(ind(d) + safe(o.v) + '[' + safe(gid) + '] = ' + v.s + ';'); return;
                    }
                    if (s.to.k !== 'name') return fail('賦值的對象不支援', s);
                    const n = s.to.v; if (scal[n] || bufs[n] || n === gid) fail('不能改參數或迴圈變數 ' + n, s);
                    if (!locals.has(n)) fail('迴圈外的變數 ' + n + ' 在平行迴圈內被改（迴圈承載相依：歸約、前綴和不是逐元素核心；請改用歸約範本）', s);
                    const v = ex(s.val);
                    if (s.decl) { if (env[n] && !locals.has(n)) fail('區域變數 ' + n + ' 與外部同名', s); env[n] = v.t; lines.push(ind(d) + v.t + ' ' + safe(n) + ' = ' + v.s + ';'); }
                    else { const t = env[n]; if (!t) fail('變數 ' + n + ' 用前沒有宣告', s); lines.push(ind(d) + safe(n) + ' = ' + cast(v, t).s + ';'); }
                    return;
                }
                case 'aug': {
                    if (s.to.k === 'index') fail('對緩衝區做 ' + s.op + '=（同一個緩衝區又讀又寫，KIR 不支援）', s);
                    if (s.to.k !== 'name') return fail('賦值的對象不支援', s);
                    const n = s.to.v; if (!locals.has(n) || n === gid) fail('迴圈外的變數或迴圈變數 ' + n + ' 被改（歸約不是逐元素核心）', s);
                    if (['+', '-', '*', '/'].indexOf(s.op) < 0) fail('複合賦值 ' + s.op + '= 不支援', s);
                    const t = env[n]; if (!t) fail('變數 ' + n + ' 用前沒有宣告', s);
                    if (s.op === '/' && t === 'int') fail('整數變數 ' + n + ' 做 /=（Python 結果是浮點）', s);
                    const v = ex(s.val); if (t === 'int' && v.t === 'float') fail('整數變數 ' + n + ' 加上浮點值（Python 會變成浮點）', s);
                    lines.push(ind(d) + safe(n) + ' ' + s.op + '= ' + cast(v, t).s + ';'); return;
                }
                case 'if': {
                    if (s.else && s.else.length) fail('if 有 else（cl_front 沒有 else；請改成兩個 if 或條件式）', s);
                    const c = cmp(s.cond); lines.push(ind(d) + 'if (' + c + ') {'); block(s.then, d + 1); lines.push(ind(d) + '}'); return;
                }
                case 'forrange': {
                    if (!(s.from && s.from.k === 'lit' && String(s.from.v) === '0')) fail('內層迴圈的起點要是 0', s);
                    if (s.step && !(s.step.k === 'lit' && String(s.step.v) === '1')) fail('內層迴圈的步長要是 1', s);
                    let b; if (s.to.k === 'lit' && s.to.t === 'int') b = String(s.to.v); else if (s.to.k === 'name' && scal[s.to.v] === 'int') b = safe(s.to.v); else fail('內層迴圈的上界要是整數字面值或整數參數', s);
                    const v = safe(s.var); lines.push(ind(d) + 'for (int ' + v + ' = 0; ' + v + ' < ' + b + '; ' + v + '++) {'); env[s.var] = 'int'; block(s.body, d + 1); lines.push(ind(d) + '}'); return;
                }
                default: return fail('敘述種類 ' + s.k + ' 不支援（核心本體只有賦值、if、內層 for）', s);
            }
        }
        block(loop.body, 2);

        // ---- 緩衝區讀寫權限 ----
        params.forEach((p) => {
            if (p.kind !== 'buf') return; const b = bufs[p.name];
            if (b.reads && b.writes) fail('緩衝區 ' + p.name + ' 又讀又寫（KIR 的緩衝區只能讀或只能寫）');
            p.access = b.writes ? 'out' : 'in';
            if (!b.reads && !b.writes) diag('warn', f.name + '：緩衝區 ' + p.name + ' 沒被用到', f);
        });
        const sig = params.map((p) => p.kind === 'buf' ? '__global ' + (p.access === 'in' ? 'const ' : '') + 'float* ' + safe(p.name) : (p.type === 'i32' ? 'int ' : 'float ') + safe(p.name)).join(', ');
        const code = '__kernel void ' + safe(f.name) + '(' + sig + ') {\n  int ' + safe(gid) + ' = get_global_id(0);\n  if (' + safe(gid) + ' < ' + bound + ') {\n' + lines.join('\n') + '\n  }\n}\n';
        diag('info', f.name + '：OpenCL 核心使用 float32，與 Python 的 float64 比對要用容差');
        return { code, meta: { name: f.name, params, globalSize: bound } };
    }

    return { emit, kernelLoop };
});
