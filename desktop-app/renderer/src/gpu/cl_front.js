/* OpenCL C 子集 → KIR（DESIGN.webgpu-cuda.md §13）。小遞迴下降解析器，純模組。
 * parseKernels(src) → { ok:true, kernels:[KIR…] } 或 { ok:false, error }。超出子集一律報錯（不猜）。
 * 支援：__kernel void f(__global const float4* p, __global float4* q, int n, float eps) { … }
 *   - 指標參數：__global const 型別*＝讀（access 'in'）；__global 型別*（沒有 const）＝寫（'out'）。
 *   - 型別：float、int（純量）；float4 指標（f32x4 緩衝區）；float* 指標（f32 緩衝區）。
 *   - 語句：T x = e;（T＝float、int、float4）、x = e;、x op= e;（op＝+ - * /）、buf[e] = e;、for (int j = 0; j < 上界; j++) 語句或區塊、if (比較) 語句或區塊（沒有 else）。
 *   - 運算式：字面值（2、2.0、2.0f）、+ - * /、一元 -、比較（< <= > >= == !=）、條件 ? a : b（條件要是比較式）、括號、
 *     buf[e]、buf[e].x（f32x4 分量 .x .y .z .w）、float4 變數的 .x 等、get_global_id(0)、sqrt rsqrt min max fabs abs floor pow exp sin cos、
 *     (float)e、(int)e、(float4)(a, b, c, d)（只能用在 float4 宣告與寫入）。
 * 不支援（報錯）：__local、barrier、atomic、struct、vector 運算（float4 之間的加減乘）、%、&&、||、else、while、
 *   自定義函式、uint、double、指標運算、迴圈初值不是 0。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaClFront = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    class ClErr extends Error {}
    const CMP = ['<', '<=', '>', '>=', '==', '!='];
    const fail = (m) => { throw new ClErr(m); };

    // ---- 詞法
    const PUNCT3 = ['<<=', '>>='];
    const PUNCT2 = ['<=', '>=', '==', '!=', '+=', '-=', '*=', '/=', '++', '--', '&&', '||', '<<', '>>'];
    function lex(src) {
        const s = String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/^\s*#[^\n]*/gm, ' ');
        const out = []; let i = 0;
        while (i < s.length) {
            const c = s[i];
            if (/\s/.test(c)) { i++; continue; }
            let m;
            if ((m = /^(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?[fF]?/.exec(s.slice(i)))) {
                const txt = m[0]; const isF = /[.eEfF]/.test(txt);
                out.push({ t: 'num', v: parseFloat(txt.replace(/[fF]$/, '')), f: isF && (/[.eE]/.test(txt) || /[fF]$/.test(txt)) });
                i += txt.length; continue;
            }
            if ((m = /^[A-Za-z_]\w*/.exec(s.slice(i)))) { out.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
            const p3 = PUNCT3.find((p) => s.startsWith(p, i)), p2 = PUNCT2.find((p) => s.startsWith(p, i));
            if (p3) { out.push({ t: 'p', v: p3 }); i += 3; continue; }
            if (p2) { out.push({ t: 'p', v: p2 }); i += 2; continue; }
            if ('(){}[],;.?:+-*/<>=!'.includes(c)) { out.push({ t: 'p', v: c }); i++; continue; }
            fail(`無法辨識的字元 "${c}"（位置 ${i}）`);
        }
        out.push({ t: 'eof' });
        return out;
    }

    // ---- 解析
    let toks = [], pos = 0;
    const peek = (o) => toks[pos + (o || 0)];
    const next = () => toks[pos++];
    const isP = (v, o) => peek(o).t === 'p' && peek(o).v === v;
    const isId = (v, o) => peek(o).t === 'id' && (v === undefined || peek(o).v === v);
    const expectP = (v) => { if (!isP(v)) fail(`預期 "${v}"，遇到 ${JSON.stringify(peek().v ?? peek().t)}`); pos++; };
    const expectId = () => { if (peek().t !== 'id') fail(`預期識別字，遇到 ${JSON.stringify(peek().v ?? peek().t)}`); return next().v; };
    function parseKernels(src) {
        try {
            toks = lex(src); pos = 0;
            const kernels = [];
            while (peek().t !== 'eof') {
                if (!(isId('__kernel') || isId('kernel'))) fail(`只支援 __kernel 函式（頂層遇到 ${JSON.stringify(peek().v ?? peek().t)}）；輔助函式、全域變數、struct 都不支援`);
                next();
                if (!isId('void')) fail('__kernel 函式要回傳 void'); next();
                const name = expectId(); expectP('(');
                const params = [];
                const scopeVars = new Map();   // name → { t:'f32'|'i32' } 或 { vec:true }
                if (!isP(')')) {
                    do {
                        // __global const float4 * name  或  int name
                        let qualGlobal = false, qualConst = false;
                        while (isId('__global') || isId('global') || isId('const') || isId('__constant') || isId('restrict') || isId('__restrict')) {
                            const q = next().v; if (q.endsWith('global')) qualGlobal = true; if (q === 'const') qualConst = true;
                            if (q === '__constant') fail('__constant 參數不支援（用 __global const）');
                        }
                        if (isId('__local') || isId('local')) fail('__local 參數不支援');
                        const ty = expectId();
                        if (!['float', 'float4', 'int'].includes(ty)) fail(`參數型別 ${ty} 不支援（支援 float、int、float4 指標、float 指標）`);
                        if (isP('*')) {
                            next(); if (!qualGlobal) fail('指標參數要加 __global');
                            const pname = expectId();
                            if (ty === 'float4') params.push({ kind: 'buf', name: pname, elem: 'f32x4', access: qualConst ? 'in' : 'out' });
                            else if (ty === 'float') params.push({ kind: 'buf', name: pname, elem: 'f32', access: qualConst ? 'in' : 'out' });
                            else fail('int 指標參數不支援');
                        } else {
                            if (ty === 'float4') fail('float4 純量參數不支援');
                            const pname = expectId();
                            params.push({ kind: 'scalar', name: pname, type: ty === 'float' ? 'f32' : 'i32' });
                            scopeVars.set(pname, { t: ty === 'float' ? 'f32' : 'i32' });
                        }
                    } while (isP(',') && next());
                }
                expectP(')'); expectP('{');
                const bufs = new Map(params.filter((p) => p.kind === 'buf').map((p) => [p.name, p]));
                const scalarsT = new Map(params.filter((p) => p.kind === 'scalar').map((p) => [p.name, p.type]));
                const body = block(scopeVars, bufs, scalarsT, true);
                kernels.push({ name, params, body });
            }
            return { ok: true, kernels };
        } catch (e) {
            if (e instanceof ClErr) return { ok: false, error: e.message };
            throw e;
        }

        // 區塊內的語句；scope 之外的名稱不可見；sc：Map name → {t}|{vec:true,names}
        function block(outer, bufs, scalarsT, top) {
            // 目前的解析狀態（用閉包的 toks／pos）
            const sc = new Map(outer);
            const stmts = [];
            while (true) {
                if (top && isP('}')) { next(); break; }
                if (!top && isP('}')) { next(); break; }
                if (peek().t === 'eof') fail('大括號不成對');
                stmts.push(...stmt(sc, bufs, scalarsT));
            }
            return stmts;
        }

        function stmt(sc, bufs, scalarsT) {
            if (isP(';')) { next(); return []; }
            if (isId('for')) return forStmt(sc, bufs, scalarsT);
            if (isId('if')) {
                next(); expectP('('); const c = expr(sc, bufs, scalarsT); expectP(')');
                if (c.k !== 'cmp') fail('if 的條件要是比較式（例如 if (i < n)）');
                if (isId('else')) fail('else 不支援（改用兩個 if 或 ?:）');
                const inner = new Map(sc); let body;
                if (isP('{')) { next(); body = []; while (!isP('}')) { if (peek().t === 'eof') fail('大括號不成對'); body.push(...stmt(inner, bufs, scalarsT)); } next(); }
                else body = stmt(inner, bufs, scalarsT);
                return [{ k: 'if', c, body }];
            }
            if (isId('while') || isId('do') || isId('switch') || isId('return') || isId('break') || isId('continue')) fail(`${peek().v} 語句不支援`);
            if (isP('{')) { next(); const inner = new Map(sc); const b = []; while (!isP('}')) { if (peek().t === 'eof') fail('大括號不成對'); b.push(...stmt(inner, bufs, scalarsT)); } next(); return b; }
            if (isId('float') || isId('int') || isId('float4')) {
                const ty = next().v;
                const name = expectId();
                if (sc.has(name) || scalarsT.has(name) || bufs.has(name)) fail(`變數 ${name} 重複宣告（本子集不允許遮蔽）`);
                expectP('=');
                if (ty === 'float4') {
                    const vec = vecExpr(sc, bufs, scalarsT);
                    expectP(';');
                    const names = ['x', 'y', 'z', 'w'].map((c) => `${name}_${c}`);
                    sc.set(name, { vec: true, names });
                    return vec.es.map((e, k) => ({ k: 'let', name: names[k], t: 'f32', e }));
                }
                const want = ty === 'float' ? 'f32' : 'i32';
                const e = expr(sc, bufs, scalarsT);
                expectP(';');
                const ce = coerce(e, want);
                sc.set(name, { t: want });
                return [{ k: 'let', name, t: want, e: ce }];
            }
            if (peek().t === 'id' && isP('[', 1)) {
                // 寫入 buffer：buf[idx] = expr;
                const bname = next().v; const b = bufs.get(bname); if (!b) fail(`未宣告的 buffer ${bname}`);
                if (b.access !== 'out') fail(`不能寫入 const（只讀）buffer ${bname}`);
                expectP('['); const idx = coerce(expr(sc, bufs, scalarsT), 'i32'); expectP(']');
                expectP('=');
                if (b.elem === 'f32x4') { const vec = vecExpr(sc, bufs, scalarsT); expectP(';'); return [{ k: 'store', buf: bname, idx, e: vec }]; }
                const e = coerce(expr(sc, bufs, scalarsT), 'f32'); expectP(';');
                return [{ k: 'store', buf: bname, idx, e }];
            }
            if (peek().t === 'id' && (isP('=', 1) || (peek(1).t === 'p' && ['+=', '-=', '*=', '/='].includes(peek(1).v)))) {
                const name = next().v;
                const v = sc.get(name);
                if (!v || v.vec) fail(`賦值到 ${name}：只能賦值給純量區域變數`);
                const op = next().v;
                const rhs = coerce(expr(sc, bufs, scalarsT), v.t);
                const e = op === '=' ? rhs : { k: 'bin', op: op[0], a: { k: 'var', name, t: v.t }, b: rhs, t: v.t };
                expectP(';');
                return [{ k: 'set', name, e }];
            }
            fail(`不支援的語句（從 ${JSON.stringify(peek().v ?? peek().t)} 開始）`);
        }

        function forStmt(sc, bufs, scalarsT) {
            next(); expectP('(');
            if (!isId('int')) fail('for 的初始化要是 int 宣告');
            next(); const v = expectId(); expectP('=');
            if (!(peek().t === 'num' && !peek().f && peek().v === 0)) fail('for 的初值只支援整數 0');
            next(); expectP(';');
            if (!isId(v)) fail('for 的條件要比較迴圈變數');
            next(); if (!isP('<')) fail('for 的條件只支援 <'); next();
            let bound;
            if (peek().t === 'num' && !peek().f) bound = next().v;
            else if (peek().t === 'id' && scalarsT.get(peek().v) === 'i32') bound = next().v;
            else fail('for 的上界要是整數字面值或 int 純量參數');
            expectP(';');
            if (!isId(v)) fail('for 的增量要是 ' + v + '++');
            next(); if (!isP('++')) fail('for 的增量只支援 ++'); next(); expectP(')');
            const inner = new Map(sc); inner.set(v, { t: 'i32' });
            let bodyStmts;
            if (isP('{')) { next(); bodyStmts = []; while (!isP('}')) { if (peek().t === 'eof') fail('大括號不成對'); bodyStmts.push(...stmt(inner, bufs, scalarsT)); } next(); }
            else bodyStmts = stmt(inner, bufs, scalarsT);
            return [{ k: 'for', v, bound, body: bodyStmts }];
        }

        // float4 運算式：float4 變數、buf[i]（整個 float4 元素）、(float4)(a,b,c,d)，回傳 { es:[4 個標量] }
        function vecExpr(sc, bufs, scalarsT) {
            if (isP('(') && isId('float4', 1) && isP(')', 2)) {
                next(); next(); next();
                expectP('(');
                const es = [];
                for (let k = 0; k < 4; k++) { es.push(coerce(expr(sc, bufs, scalarsT), 'f32')); if (k < 3) expectP(','); }
                expectP(')');
                return { k: 'vec', es };
            }
            if (peek().t === 'id' && sc.get(peek().v) && sc.get(peek().v).vec) {
                const v = sc.get(next().v);
                return { k: 'vec', es: v.names.map((n) => ({ k: 'var', name: n, t: 'f32' })) };
            }
            if (peek().t === 'id' && isP('[', 1) && bufs.get(peek().v) && bufs.get(peek().v).elem === 'f32x4') {
                const bname = next().v; expectP('['); const idx = coerce(expr(sc, bufs, scalarsT), 'i32'); expectP(']');
                if (bufs.get(bname).access !== 'in') fail(`不能讀取只寫的 buffer ${bname}`);
                return { k: 'vec', es: [0, 1, 2, 3].map((c) => ({ k: 'load', buf: bname, idx, comp: c })) };
            }
            fail('float4 運算式只支援 float4 變數、buf[i]（整個元素）或 (float4)(a,b,c,d)');
        }

        // 一般運算式（回傳 KIR 運算式；型別在節點的 t 上）
        function expr(sc, bufs, scalarsT) { return ternary(sc, bufs, scalarsT); }
        function ternary(sc, bufs, scalarsT) {
            const c = comparison(sc, bufs, scalarsT);
            if (isP('?')) {
                next();
                if (c.k !== 'cmp') fail('條件運算子的條件要是比較式（例如 (x < y) ? a : b）');
                const a = ternary(sc, bufs, scalarsT); expectP(':'); const b = ternary(sc, bufs, scalarsT);
                const t = promote2(a, b);
                return { k: 'sel', c, a: coerce(a, t), b: coerce(b, t), t };
            }
            return c;
        }
        function comparison(sc, bufs, scalarsT) {
            let a = additive(sc, bufs, scalarsT);
            while (peek().t === 'p' && CMP.includes(peek().v)) {
                const op = next().v; const b = additive(sc, bufs, scalarsT);
                const t = promote2(a, b);
                a = { k: 'cmp', op, a: coerce(a, t), b: coerce(b, t) };
            }
            return a;
        }
        function additive(sc, bufs, scalarsT) {
            let a = multiplicative(sc, bufs, scalarsT);
            while (isP('+') || isP('-')) {
                const op = next().v; const b = multiplicative(sc, bufs, scalarsT);
                const t = promote2(a, b);
                a = { k: 'bin', op, a: coerce(a, t), b: coerce(b, t), t };
            }
            return a;
        }
        function multiplicative(sc, bufs, scalarsT) {
            let a = unary(sc, bufs, scalarsT);
            while (isP('*') || isP('/')) {
                const op = next().v; const b = unary(sc, bufs, scalarsT);
                const t = promote2(a, b);
                a = { k: 'bin', op, a: coerce(a, t), b: coerce(b, t), t };
            }
            return a;
        }
        function unary(sc, bufs, scalarsT) {
            if (isP('-')) { next(); const a = unary(sc, bufs, scalarsT); return { k: 'bin', op: '-', a: { k: 'num', v: 0, t: a.t }, b: a, t: a.t }; }
            if (isP('+')) { next(); return unary(sc, bufs, scalarsT); }
            return postfix(sc, bufs, scalarsT);
        }
        function postfix(sc, bufs, scalarsT) {
            const tk = peek();
            if (tk.t === 'num') { next(); return tk.f ? { k: 'num', v: tk.v, t: 'f32' } : { k: 'num', v: tk.v, t: 'i32' }; }
            if (isP('(')) {
                // (float)e、(int)e，或括號運算式
                if ((isId('float', 1) || isId('int', 1)) && isP(')', 2)) {
                    next(); const to = next().v === 'float' ? 'f32' : 'i32'; next();
                    const a = unary(sc, bufs, scalarsT);
                    return { k: 'cast', to, a: coerce(a, a.t) , t: to };
                }
                if (isId('float4', 1)) fail('(float4)(…) 只能用在 float4 宣告或寫入');
                next(); const e = expr(sc, bufs, scalarsT); expectP(')');
                return e;
            }
            if (tk.t === 'id') {
                const name = tk.v;
                if (name === 'get_global_id') {
                    next(); expectP('('); if (!(peek().t === 'num' && peek().v === 0)) fail('get_global_id 只支援維度 0'); next(); expectP(')');
                    return { k: 'gid', t: 'i32' };
                }
                if (CALL_ARGS[name] !== undefined || name === 'fabs') {
                    next(); expectP('(');
                    const args = [];
                    for (let k = 0; k < (CALL_ARGS[name === 'fabs' ? 'abs' : name] || 1); k++) { args.push(coerce(expr(sc, bufs, scalarsT), 'f32')); if (k < (CALL_ARGS[name === 'fabs' ? 'abs' : name] || 1) - 1) expectP(','); }
                    expectP(')');
                    return { k: 'call', fn: name === 'fabs' ? 'abs' : name, args, t: 'f32' };
                }
                next();
                if (isP('[')) {
                    const b = bufs.get(name); if (!b) fail(`未宣告的 buffer ${name}`);
                    next(); const idx = coerce(expr(sc, bufs, scalarsT), 'i32'); expectP(']');
                    if (b.access !== 'in') fail(`不能讀取只寫的 buffer ${name}`);
                    if (b.elem === 'f32x4') {
                        if (!isP('.')) fail(`float4 緩衝區 ${name} 的元素要取分量 .x .y .z .w（整個 float4 只能用在 float4 宣告或寫入）`);
                        next(); const cm = expectId(); const comp = { x: 0, y: 1, z: 2, w: 3 }[cm];
                        if (comp === undefined) fail('分量要是 .x .y .z .w');
                        return { k: 'load', buf: name, idx, comp, t: 'f32' };
                    }
                    return { k: 'load', buf: name, idx, comp: null, t: 'f32' };
                }
                if (isP('.')) {
                    // float4 區域變數的分量
                    next(); const cm = expectId(); const v = sc.get(name); const comp = { x: 0, y: 1, z: 2, w: 3 }[cm];
                    if (!v || !v.vec || comp === undefined) fail(`${name}.${cm}：不是 float4 區域變數的分量`);
                    return { k: 'var', name: v.names[comp], t: 'f32' };
                }
                const v = sc.get(name);
                if (v && !v.vec) return { k: 'var', name, t: v.t };
                if (scalarsT.has(name)) return { k: 'var', name, t: scalarsT.get(name) };
                if (v && v.vec) fail(`float4 變數 ${name} 不能當純量用（請取 .x .y .z .w）`);
                fail(`未宣告的名稱 ${name}`);
            }
            fail(`運算式在 ${JSON.stringify(tk.v ?? tk.t)} 處不完整`);
        }
    }

    const CALL_ARGS = { sqrt: 1, rsqrt: 1, floor: 1, abs: 1, exp: 1, sin: 1, cos: 1, min: 2, max: 2, pow: 2 };

    // 運算式的型別（節點上的 t；比較式回 'bool'）
    function typeOf(e) { return e.k === 'cmp' ? 'bool' : e.t; }
    // 兩個運算元的共同型別：有 f32 就是 f32（OpenCL 的隱式轉換）
    function promote2(a, b) { return typeOf(a) === 'f32' || typeOf(b) === 'f32' ? 'f32' : 'i32'; }
    // 把運算式轉成型別 want：i32→f32 用 cast；相同則原樣
    function coerce(e, want) {
        const t = typeOf(e);
        if (t === want) return e;
        if (t === 'i32' && want === 'f32') return { k: 'cast', to: 'f32', a: e, t: 'f32' };
        if (t === 'f32' && want === 'i32') fail('不能把 float 隱式轉成 int（請明寫 (int)）');
        if (e.k === 'num' && want === 'f32') return { k: 'num', v: e.v, t: 'f32' };
        fail(`型別不符（要 ${want}，得 ${t}）`);
    }

    return { parseKernels, lex };
});
