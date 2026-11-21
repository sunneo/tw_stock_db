/* OpenCL C → SPIR-V 前端（FaClc2Spv，UMD，純邏輯）：source→IL 這一步。
 *   const r = FaClc2Spv.compile(src, options);  →  { ok:true, il:Uint8Array } 或 { ok:false, unsupported:true, log }（子集之外，呼叫端退回 clc 直接編譯）
 *   FaClc2Spv.toIL(src, options) → Uint8Array 或 null（給 cl_cache 的 frontends.toIL；不支援就回 null，絕不丟例外）
 * 輸出風格同 clang -O0＋llvm-spirv：Kernel 能力、Physical64、OpenCL 記憶體模型；區域變數用 OpVariable Function（先存再讀；spv_js 後端會把只被 Load／Store 的變數提升成 JS 區域變數）；
 * 內建變數用 Input 變數＋BuiltIn 裝飾；數學函式用 OpenCL.std 的 OpExtInst；結構化控制流（OpSelectionMerge／OpLoopMerge）。size_t 是 64 位元（ulong）。
 * 前處理與詞法共用 clc_js.js（巨集、-D、預定義常數），所以 -I 展開後的 source、CLK_* 常數行為與直接編譯一致。
 * 支援的子集（超出一律明確回報 unsupported）：
 *   型別：void、bool、char／uchar／short／ushort／int／uint／long／ulong／size_t、float、double、指標（__global／__local／__constant／__private）、一維陣列（__local 與私有）。
 *   宣告：__kernel／輔助函式（含前向宣告）、區域變數（含初值、多個宣告子）、kernel 範圍的 __local 陣列。
 *   運算式：字面值、四則與餘數、位元與移位、比較、&& ||（短路）、?:、! ~ 一元負、賦值與複合賦值、++／--（前後置）、[]、*、&、轉型、sizeof、函式呼叫、逗號。
 *   敘述：if／else、for、while、do-while、break、continue、return、區塊、barrier、運算式。
 *   內建：get_*_id／size／num_groups／work_dim／global_offset、barrier、數學（OpenCL.std）、min／max／abs／clamp／select／mad／fma／mix／step／sign…、原子操作、mul24／mad24、popcount／clz、isnan／isinf。
 * 不支援：向量型別、struct／union／enum／typedef、圖像／取樣器／pipe、全域變數、多維陣列、函式指標、printf、convert_*／as_*、字串。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./spv_tables.js'), require('./clc_js.js'));
    else root.FaClc2Spv = factory(root.FaSpvTables, root.FaClc);
})(typeof self !== 'undefined' ? self : this, function (T, CLC) {
    'use strict';
    class Unsup extends Error { constructor(m, line) { super((line ? '第 ' + line + ' 行：' : '') + m); this.name = 'Unsup'; } }
    const unsup = (m, line) => { throw new Unsup(m, line); };
    const OP = (n) => { const e = T.ops[n]; if (!e) throw new Error('未知的 SPIR-V 指令 ' + n); return e[0]; };
    const EN = (kind, name) => { const v = T.enums[kind][name]; return Array.isArray(v) ? v[0] : v; };
    const strWords = (s) => { const b = new TextEncoder().encode(s), n = (b.length >> 2) + 1, w = new Array(n).fill(0); for (let i = 0; i < b.length; i++) w[i >> 2] |= b[i] << (8 * (i & 3)); return w; };
    const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), f64 = new Float64Array(1), u32x2 = new Uint32Array(f64.buffer);

    // ---------------------------------------------------------------- C 型別
    const INT = (w, s) => ({ k: 'int', w, s }), FLT = (w) => ({ k: 'float', w }), BOOL = { k: 'bool' }, VOID = { k: 'void' };
    const SCALARS = { char: INT(8, true), uchar: INT(8, false), short: INT(16, true), ushort: INT(16, false), int: INT(32, true), uint: INT(32, false), long: INT(64, true), ulong: INT(64, false), float: FLT(32), double: FLT(64), bool: INT(32, true), void: VOID, size_t: INT(64, false), ptrdiff_t: INT(64, true), intptr_t: INT(64, true), uintptr_t: INT(64, false) };
    const SC = { global: 'CrossWorkgroup', local: 'Workgroup', constant: 'UniformConstant', private: 'Function' };
    const isInt = (t) => t.k === 'int', isFlt = (t) => t.k === 'float', isPtr = (t) => t.k === 'ptr', isArith = (t) => t.k === 'int' || t.k === 'float' || t.k === 'bool';
    const sameT = (a, b) => a.k === b.k && (a.k === 'int' ? a.w === b.w && a.s === b.s : a.k === 'float' ? a.w === b.w : a.k === 'ptr' ? a.as === b.as && sameT(a.to, b.to) : true);
    const sizeOf = (t) => (t.k === 'int' || t.k === 'float' ? t.w / 8 : t.k === 'bool' ? 1 : t.k === 'ptr' ? 8 : t.k === 'arr' ? t.n * sizeOf(t.to) : 0);
    const promote = (t) => (t.k === 'bool' ? INT(32, true) : t.k === 'int' && t.w < 32 ? INT(32, true) : t);
    function commonType(a, b) {
        a = promote(a); b = promote(b);
        if (isFlt(a) || isFlt(b)) return FLT(Math.max(isFlt(a) ? a.w : 0, isFlt(b) ? b.w : 0));
        if (a.w !== b.w) return a.w > b.w ? a : b;
        return a.s && b.s ? a : INT(a.w, false);
    }

    // ---------------------------------------------------------------- 模組建構（SPIR-V 二進位）
    class Mod {
        constructor() { this.next = 1; this.caps = new Set(['Addresses', 'Kernel']); this.names = []; this.annot = []; this.tys = []; this.entry = []; this.funcs = []; this.tmap = new Map(); this.cmap = new Map(); this.bi = new Map(); this.ocl = 0; }
        id() { return this.next++; }
        ins(op, ...ops) { const w = [0]; for (const o of ops) if (Array.isArray(o)) w.push(...o); else w.push(o >>> 0); w[0] = ((w.length << 16) | OP(op)) >>> 0; return w; }
        defT(key, mk) { let id = this.tmap.get(key); if (id === undefined) { id = this.id(); this.tys.push(this.ins(...mk(id))); this.tmap.set(key, id); } return id; }
        tVoid() { return this.defT('void', (id) => ['OpTypeVoid', id]); }
        tBool() { return this.defT('bool', (id) => ['OpTypeBool', id]); }
        tInt(w) { if (w === 64) this.caps.add('Int64'); if (w === 16) this.caps.add('Int16'); if (w === 8) this.caps.add('Int8'); return this.defT('i' + w, (id) => ['OpTypeInt', id, w, 0]); }
        tFloat(w) { if (w === 64) this.caps.add('Float64'); return this.defT('f' + w, (id) => ['OpTypeFloat', id, w]); }
        tPtr(sc, to) { return this.defT('p' + sc + ':' + to, (id) => ['OpTypePointer', id, EN('StorageClass', sc), to]); }
        tArr(el, n) { const len = this.cInt(this.tInt(32), n); return this.defT('a' + el + ':' + n, (id) => ['OpTypeArray', id, el, len]); }
        tFn(ret, params) { return this.defT('fn' + ret + ':' + params.join(','), (id) => ['OpTypeFunction', id, ret, ...params]); }
        tyId(t) {
            switch (t.k) {
                case 'void': return this.tVoid(); case 'bool': return this.tBool(); case 'int': return this.tInt(t.w); case 'float': return this.tFloat(t.w);
                case 'ptr': return this.tPtr(SC[t.as], this.tyId(t.to)); case 'arr': return this.tArr(this.tyId(t.to), t.n);
            }
            unsup('型別 ' + t.k);
        }
        cInt(tid, v) { const key = 'ci' + tid + ':' + v; let id = this.cmap.get(key); if (id === undefined) { id = this.id(); const big = BigInt.asUintN(64, BigInt(v)), wide = this.tmap.get('i64') === tid; this.tys.push(this.ins('OpConstant', tid, id, ...(wide ? [Number(big & 0xFFFFFFFFn), Number(big >> 32n)] : [Number(BigInt.asUintN(32, BigInt(v)))]))); this.cmap.set(key, id); } return id; }
        cFloat(w, v) { const tid = this.tFloat(w), key = 'cf' + w + ':' + (Object.is(v, -0) ? '-0' : v); let id = this.cmap.get(key); if (id === undefined) { id = this.id(); let ws; if (w === 32) { f32[0] = v; ws = [u32[0]]; } else { f64[0] = v; ws = [u32x2[0], u32x2[1]]; } this.tys.push(this.ins('OpConstant', tid, id, ...ws)); this.cmap.set(key, id); } return id; }
        cBool(v) { const key = 'cb' + v; let id = this.cmap.get(key); if (id === undefined) { id = this.id(); this.tys.push(this.ins(v ? 'OpConstantTrue' : 'OpConstantFalse', this.tBool(), id)); this.cmap.set(key, id); } return id; }
        cNull(tid) { const key = 'cn' + tid; let id = this.cmap.get(key); if (id === undefined) { id = this.id(); this.tys.push(this.ins('OpConstantNull', tid, id)); this.cmap.set(key, id); } return id; }
        // 內建變數：Input 變數＋BuiltIn 裝飾（vec3<ulong> 或 uint）
        builtin(name) {
            let v = this.bi.get(name); if (v) return v;
            const scalar = name === 'WorkDim', ty = scalar ? this.tInt(32) : this.defT('v3ulong', (id) => ['OpTypeVector', id, this.tInt(64), 3]);
            const id = this.id(); this.tys.push(this.ins('OpVariable', this.tPtr('Input', ty), id, EN('StorageClass', 'Input')));
            this.annot.push(this.ins('OpDecorate', id, EN('Decoration', 'BuiltIn'), EN('BuiltIn', name))); this.annot.push(this.ins('OpDecorate', id, EN('Decoration', 'Constant')));
            this.names.push(this.ins('OpName', id, strWords('__spirv_BuiltIn' + name))); v = { id, ty, scalar }; this.bi.set(name, v); return v;
        }
        oclSet() { if (!this.ocl) this.ocl = this.id(); return this.ocl; }
        binary() {
            const head = []; for (const c of [...this.caps].sort()) head.push(this.ins('OpCapability', EN('Capability', c)));
            if (this.ocl) head.push(this.ins('OpExtInstImport', this.ocl, strWords('OpenCL.std')));
            head.push(this.ins('OpMemoryModel', EN('AddressingModel', 'Physical64'), EN('MemoryModel', 'OpenCL')));
            const all = [].concat(head, this.entry, this.names, this.annot, this.tys, this.funcs), n = all.reduce((a, w) => a + w.length, 0), out = new Uint32Array(5 + n);
            out[0] = T.magic; out[1] = 0x00010000; out[2] = 0; out[3] = this.next; out[4] = 0; let p = 5; for (const w of all) for (const x of w) out[p++] = x;
            return new Uint8Array(out.buffer);
        }
    }

    // ---------------------------------------------------------------- 編譯器
    function compile(src, options) {
        try { return { ok: true, il: new Compiler(src, options).run() }; }
        catch (e) {
            if (e instanceof Unsup) return { ok: false, unsupported: true, log: e.message };
            if (e && e.name === 'CErr') return { ok: false, unsupported: false, log: e.message };   // 語法錯誤等：交給 clc 直接編譯報行號
            throw e;
        }
    }
    const toIL = (src, options) => { try { const r = compile(src, options); return r.ok ? r.il : null; } catch (_) { return null; } };

    const MATH1 = { acos: 'acos', acosh: 'acosh', asin: 'asin', asinh: 'asinh', atan: 'atan', atanh: 'atanh', cbrt: 'cbrt', ceil: 'ceil', cos: 'cos', cosh: 'cosh', exp: 'exp', exp2: 'exp2', exp10: 'exp10', expm1: 'expm1', fabs: 'fabs', floor: 'floor', log: 'log', log2: 'log2', log10: 'log10', log1p: 'log1p', rint: 'rint', round: 'round', rsqrt: 'rsqrt', sin: 'sin', sinh: 'sinh', sqrt: 'sqrt', tan: 'tan', tanh: 'tanh', trunc: 'trunc', tgamma: 'tgamma', erf: 'erf', erfc: 'erfc', logb: 'logb', degrees: 'degrees', radians: 'radians', sign: 'sign' };
    const MATH2 = { atan2: 'atan2', copysign: 'copysign', fdim: 'fdim', fmax: 'fmax', fmin: 'fmin', fmod: 'fmod', hypot: 'hypot', pow: 'pow', powr: 'powr', remainder: 'remainder', nextafter: 'nextafter', step: 'step' };
    const MATH3 = { fma: 'fma', mad: 'mad', mix: 'mix', smoothstep: 'smoothstep' };
    const ATOMIC = { add: 'OpAtomicIAdd', sub: 'OpAtomicISub', xchg: 'OpAtomicExchange', min: 'min', max: 'max', and: 'OpAtomicAnd', or: 'OpAtomicOr', xor: 'OpAtomicXor', inc: 'OpAtomicIIncrement', dec: 'OpAtomicIDecrement', cmpxchg: 'OpAtomicCompareExchange' };
    const WORKITEM = { get_global_id: 'GlobalInvocationId', get_local_id: 'LocalInvocationId', get_group_id: 'WorkgroupId', get_global_size: 'GlobalSize', get_local_size: 'WorkgroupSize', get_num_groups: 'NumWorkgroups', get_global_offset: 'GlobalOffset' };

    class Compiler {
        constructor(src, options) { this.t = CLC.tokensOf(src, options); this.i = 0; this.m = new Mod(); this.fns = new Map(); this.scopes = []; this.fn = null; this.cur = null; this.loops = []; this.globalsLocal = []; }
        // ---- 記號
        get tk() { return this.t[this.i]; }
        line() { const x = this.tk || this.t[this.t.length - 1]; return x ? x.line : 0; }
        is(v) { const x = this.tk; return !!x && x.v === v && (x.t === 'p' || x.t === 'id'); }
        eat(v) { if (this.is(v)) { this.i++; return true; } return false; }
        need(v) { if (!this.eat(v)) { const e = new Error('這裡需要「' + v + '」（第 ' + this.line() + ' 行）'); e.name = 'CErr'; throw e; } }
        err(m) { const e = new Error(m + '（第 ' + this.line() + ' 行）'); e.name = 'CErr'; throw e; }
        // ---- 區塊與指令
        newBlock() { return { id: this.m.id(), ins: [], term: false }; }
        startBlock(b) { this.fn.blocks.push(b); this.cur = b; }
        emit(op, ...ops) { if (this.cur.term) this.startBlock(this.newBlock()); this.cur.ins.push(this.m.ins(op, ...ops)); }
        res(op, tid, ...ops) { const id = this.m.id(); this.emit(op, tid, id, ...ops); return id; }
        term(op, ...ops) { if (this.cur.term) this.startBlock(this.newBlock()); this.cur.ins.push(this.m.ins(op, ...ops)); this.cur.term = true; }
        br(b) { this.term('OpBranch', b.id); }
        // ---- 作用域
        push() { this.scopes.push(new Map()); } pop() { this.scopes.pop(); }
        lookup(n) { for (let k = this.scopes.length - 1; k >= 0; k--) if (this.scopes[k].has(n)) return this.scopes[k].get(n); return null; }
        declareVar(name, ty, as) {   // Function 變數放進入口區塊；__local 是模組層的 Workgroup 變數
            const pt = this.m.tPtr(SC[as || 'private'], this.m.tyId(ty)), id = this.m.id();
            if (as === 'local') { this.m.tys.push(this.m.ins('OpVariable', pt, id, EN('StorageClass', 'Workgroup'))); this.m.names.push(this.m.ins('OpName', id, strWords(name))); }
            else this.fn.vars.push(this.m.ins('OpVariable', pt, id, EN('StorageClass', 'Function')));
            const v = { ptr: id, ty, as: as || 'private' }; this.scopes[this.scopes.length - 1].set(name, v); return v;
        }
        // ---- 型別剖析
        isTypeStart(k) {
            const x = this.t[this.i + (k || 0)]; if (!x || x.t !== 'id') return false;
            return !!SCALARS[x.v] || ['unsigned', 'signed', 'const', 'volatile', '__global', 'global', '__local', 'local', '__constant', 'constant', '__private', 'private', 'restrict', '__restrict', 'struct', 'union', 'enum', 'half', 'read_only', 'write_only', 'read_write', '__read_only', '__write_only', '__read_write'].includes(x.v) || /^(char|uchar|short|ushort|int|uint|long|ulong|float|double)(2|3|4|8|16)$/.test(x.v) || /^(image|sampler|pipe|event)/.test(x.v) || x.v === 'typedef';
        }
        parseBase() {
            let as = null, cst = false, sign = null, base = null, longs = 0, any = false;
            for (;;) {
                const x = this.tk; if (!x || x.t !== 'id') break; const v = x.v;
                if (v === 'const') { cst = true; this.i++; any = true; continue; }
                if (v === 'volatile' || v === 'restrict' || v === '__restrict' || v === 'static' || v === 'inline') { this.i++; any = true; continue; }
                if (/^(__)?(global|local|constant|private)$/.test(v)) { as = v.replace(/^__/, ''); this.i++; any = true; continue; }
                if (v === 'unsigned' || v === 'signed') { sign = v; this.i++; any = true; continue; }
                if (v === 'long') { longs++; this.i++; any = true; base = 'long'; continue; }
                if (v === 'struct' || v === 'union' || v === 'enum' || v === 'typedef') unsup(v + ' 型別');
                if (/^(__)?(read_only|write_only|read_write)$/.test(v)) unsup('圖像／pipe 的存取限定詞 ' + v, x.line);
                if (v === 'half' || /^(char|uchar|short|ushort|int|uint|long|ulong|float|double)(2|3|4|8|16)$/.test(v)) unsup('向量／half 型別 ' + v, x.line);
                if (/^(image|sampler|pipe|event)/.test(v)) unsup('型別 ' + v, x.line);
                if (SCALARS[v] && !(base && base !== 'long')) { if (base === 'long' && v === 'int') { this.i++; continue; } base = v; this.i++; any = true; continue; }
                break;
            }
            if (!any) this.err('這裡需要型別');
            if (!base) base = 'int';
            if (base === 'long' && longs > 1) base = 'long';
            let t = SCALARS[base]; if (sign === 'unsigned') { const m = { char: 'uchar', short: 'ushort', int: 'uint', long: 'ulong' }[base]; if (!m) this.err('unsigned ' + base); t = SCALARS[m]; }
            return { t, as, cst };
        }
        parsePtrs(base, defAs) {
            let t = base.t; let cst = base.cst;
            while (this.is('*')) { this.i++; t = { k: 'ptr', as: base.as || defAs || 'private', to: t, cst }; cst = false; while (this.tk && this.tk.t === 'id' && ['const', 'volatile', 'restrict', '__restrict'].includes(this.tk.v)) { if (this.tk.v === 'const') cst = true; this.i++; } base = { t, as: null, cst: false }; defAs = null; }
            return t;
        }
        parseTypeName() { const b = this.parseBase(); return this.parsePtrs(b, 'private'); }

        // ---- 轉換
        toBool(v) {
            if (v.ty.k === 'bool') return v.id;
            if (isInt(v.ty)) return this.res('OpINotEqual', this.m.tBool(), v.id, this.m.cInt(this.m.tyId(v.ty), 0));
            if (isFlt(v.ty)) return this.res('OpFUnordNotEqual', this.m.tBool(), v.id, this.m.cFloat(v.ty.w, 0));
            if (isPtr(v.ty)) unsup('指標當條件');
            this.err('不能當作條件');
        }
        conv(v, to) {
            const from = v.ty; if (sameT(from, to)) return v;
            const M = this.m, tid = M.tyId(to);
            if (to.k === 'bool') return { id: this.toBool(v), ty: to };
            if (from.k === 'bool') { if (isInt(to)) return { id: this.res('OpSelect', tid, v.id, M.cInt(tid, 1), M.cInt(tid, 0)), ty: to }; if (isFlt(to)) return { id: this.res('OpSelect', tid, v.id, M.cFloat(to.w, 1), M.cFloat(to.w, 0)), ty: to }; }
            if (isInt(from) && isInt(to)) { if (from.w === to.w) return { id: v.id, ty: to }; return { id: this.res(from.s ? 'OpSConvert' : 'OpUConvert', tid, v.id), ty: to }; }
            if (isInt(from) && isFlt(to)) return { id: this.res(from.s ? 'OpConvertSToF' : 'OpConvertUToF', tid, v.id), ty: to };
            if (isFlt(from) && isInt(to)) return { id: this.res(to.s ? 'OpConvertFToS' : 'OpConvertFToU', tid, v.id), ty: to };
            if (isFlt(from) && isFlt(to)) return { id: this.res('OpFConvert', tid, v.id), ty: to };
            if (isPtr(from) && isPtr(to)) return { id: this.res('OpBitcast', tid, v.id), ty: to };
            unsup('轉型 ' + from.k + ' → ' + to.k, this.line());
        }
        rv(o) {   // 取值：lvalue 就載入；陣列衰變成指標
            if (!o.lv) return o;
            const t = o.lv.ty;
            if (t.k === 'arr') { const pe = { k: 'ptr', as: o.lv.as, to: t.to }; return { id: this.res('OpInBoundsAccessChain', this.m.tyId(pe), o.lv.ptr, this.m.cInt(this.m.tInt(32), 0)), ty: pe }; }
            return { id: this.res('OpLoad', this.m.tyId(t), o.lv.ptr), ty: t };
        }

        // ---- 運算式
        PREC = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
        expr() { let o = this.assign(); while (this.is(',')) { this.i++; this.rv(o); o = this.assign(); } return o; }
        assign() {
            const lhs = this.ternary();
            const x = this.tk; if (x && x.t === 'p' && /^(=|\+=|-=|\*=|\/=|%=|<<=|>>=|&=|\|=|\^=)$/.test(x.v)) {
                if (!lhs.lv) this.err('= 的左邊不能指定'); if (lhs.lv.ty.k === 'arr') this.err('不能指定整個陣列'); this.i++; const rhs = this.assign(); let val;
                if (x.v === '=') val = this.conv(this.rv(rhs), lhs.lv.ty);
                else { const cur = this.rv(lhs); val = this.conv(this.binop(x.v.slice(0, -1), cur, this.rv(rhs)), lhs.lv.ty); }
                this.emit('OpStore', lhs.lv.ptr, val.id); return val;
            }
            return lhs;
        }
        ternary() {
            const c = this.binary(1); if (!this.is('?')) return c;
            this.i++; const cond = this.toBool(this.rv(c)), A = this.newBlock(), B = this.newBlock(), E = this.newBlock();
            this.emit('OpSelectionMerge', E.id, 0); this.term('OpBranchConditional', cond, A.id, B.id);
            this.startBlock(A); const va = this.rv(this.expr()); const endA = this.cur; this.need(':');
            this.startBlock(B); const vb = this.rv(this.ternary()); const endB = this.cur;
            let ty; if (isPtr(va.ty) && isPtr(vb.ty)) ty = va.ty; else if (isArith(va.ty) && isArith(vb.ty)) ty = va.ty.k === 'bool' && vb.ty.k === 'bool' ? BOOL : commonType(va.ty, vb.ty); else this.err('?: 兩邊型別不相容');
            const conv = (blk, v) => { const save = this.cur; this.cur = blk; const r = this.conv(v, ty); this.cur = save; return r; };
            this.cur = endA; const ca = this.conv(va, ty); const brA = endA; this.br(E);
            this.cur = endB; const cb = this.conv(vb, ty); this.br(E); void conv; void brA;
            this.startBlock(E); const id = this.res('OpPhi', this.m.tyId(ty), ca.id, endA.id, cb.id, endB.id); return { id, ty };
        }
        binary(minPrec) {
            let lhs = this.unary();
            for (;;) {
                const x = this.tk; if (!x || x.t !== 'p' || !this.PREC[x.v] || this.PREC[x.v] < minPrec) return lhs;
                const op = x.v, p = this.PREC[op]; this.i++;
                if (op === '&&' || op === '||') {
                    const l = this.toBool(this.rv(lhs)), R = this.newBlock(), E = this.newBlock(), L = this.cur;
                    this.emit('OpSelectionMerge', E.id, 0); this.term('OpBranchConditional', l, op === '&&' ? R.id : E.id, op === '&&' ? E.id : R.id);
                    this.startBlock(R); const r = this.toBool(this.rv(this.binary(p + 1))); const endR = this.cur; this.br(E);
                    this.startBlock(E); const id = this.res('OpPhi', this.m.tBool(), this.m.cBool(op === '||'), L.id, r, endR.id); lhs = { id, ty: BOOL }; continue;
                }
                const rhs = this.binary(p + 1); lhs = this.binop(op, this.rv(lhs), this.rv(rhs));
            }
        }
        binop(op, a, b) {
            const M = this.m;
            if (isPtr(a.ty) || isPtr(b.ty)) {
                if ((op === '+' || op === '-') && isPtr(a.ty) && isInt(b.ty)) { let idx = this.conv(b, INT(64, true)); if (op === '-') idx = { id: this.res('OpSNegate', M.tInt(64), idx.id), ty: idx.ty }; return { id: this.res('OpInBoundsPtrAccessChain', M.tyId(a.ty), a.id, idx.id), ty: a.ty }; }
                if (op === '+' && isInt(a.ty) && isPtr(b.ty)) return this.binop('+', b, a);
                if (['==', '!=', '<', '>', '<=', '>='].includes(op) && isPtr(a.ty) && isPtr(b.ty)) { const bt = M.tBool(); if (op === '==') return { id: this.res('OpPtrEqual', bt, a.id, b.id), ty: BOOL }; if (op === '!=') return { id: this.res('OpPtrNotEqual', bt, a.id, b.id), ty: BOOL }; unsup('指標的大小比較'); }
                unsup('指標運算 ' + op, this.line());
            }
            if (['<<', '>>'].includes(op)) { const lt = promote(a.ty); if (!isInt(lt) || !isInt(promote(b.ty))) this.err('移位要整數'); const x = this.conv(a, lt), y = this.conv(b, lt); return { id: this.res(op === '<<' ? 'OpShiftLeftLogical' : lt.s ? 'OpShiftRightArithmetic' : 'OpShiftRightLogical', M.tyId(lt), x.id, y.id), ty: lt }; }
            const ct = commonType(a.ty, b.ty), x = this.conv(a, ct), y = this.conv(b, ct), tid = M.tyId(ct), bt = M.tBool();
            if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
                const i = { '==': ['OpIEqual', 'OpIEqual'], '!=': ['OpINotEqual', 'OpINotEqual'], '<': ['OpSLessThan', 'OpULessThan'], '>': ['OpSGreaterThan', 'OpUGreaterThan'], '<=': ['OpSLessThanEqual', 'OpULessThanEqual'], '>=': ['OpSGreaterThanEqual', 'OpUGreaterThanEqual'] }[op];
                const f = { '==': 'OpFOrdEqual', '!=': 'OpFUnordNotEqual', '<': 'OpFOrdLessThan', '>': 'OpFOrdGreaterThan', '<=': 'OpFOrdLessThanEqual', '>=': 'OpFOrdGreaterThanEqual' }[op];
                return { id: this.res(isFlt(ct) ? f : i[ct.s ? 0 : 1], bt, x.id, y.id), ty: BOOL };
            }
            if (isFlt(ct)) { const n = { '+': 'OpFAdd', '-': 'OpFSub', '*': 'OpFMul', '/': 'OpFDiv' }[op]; if (!n) this.err('浮點數不能做 ' + op); return { id: this.res(n, tid, x.id, y.id), ty: ct }; }
            const n = { '+': 'OpIAdd', '-': 'OpISub', '*': 'OpIMul', '/': ct.s ? 'OpSDiv' : 'OpUDiv', '%': ct.s ? 'OpSRem' : 'OpUMod', '&': 'OpBitwiseAnd', '|': 'OpBitwiseOr', '^': 'OpBitwiseXor' }[op];
            if (!n) this.err('不認得的運算 ' + op); return { id: this.res(n, tid, x.id, y.id), ty: ct };
        }
        unary() {
            const x = this.tk; if (!x) this.err('運算式提早結束');
            if (x.t === 'p') {
                if (x.v === '-') { this.i++; const v = this.rv(this.unary()); const t = promote(v.ty), c = this.conv(v, t); return { id: this.res(isFlt(t) ? 'OpFNegate' : 'OpSNegate', this.m.tyId(t), c.id), ty: t }; }
                if (x.v === '+') { this.i++; const v = this.rv(this.unary()); return this.conv(v, promote(v.ty)); }
                if (x.v === '!') { this.i++; const v = this.rv(this.unary()); return { id: this.res('OpLogicalNot', this.m.tBool(), this.toBool(v)), ty: BOOL }; }
                if (x.v === '~') { this.i++; const v = this.rv(this.unary()); const t = promote(v.ty); if (!isInt(t)) this.err('~ 要整數'); return { id: this.res('OpNot', this.m.tyId(t), this.conv(v, t).id), ty: t }; }
                if (x.v === '*') { this.i++; const v = this.rv(this.unary()); if (!isPtr(v.ty)) this.err('* 的對象不是指標'); return { lv: { ptr: v.id, ty: v.ty.to, as: v.ty.as } }; }
                if (x.v === '&') { this.i++; const o = this.unary(); if (!o.lv) this.err('& 要左值'); if (o.lv.ty.k === 'arr') unsup('& 陣列'); return { id: o.lv.ptr, ty: { k: 'ptr', as: o.lv.as, to: o.lv.ty } }; }
                if (x.v === '++' || x.v === '--') { this.i++; const o = this.unary(); if (!o.lv) this.err(x.v + ' 要左值'); const cur = this.rv(o), one = { id: this.m.cInt(this.m.tInt(32), 1), ty: INT(32, true) }; const nv = this.conv(this.binop(x.v === '++' ? '+' : '-', cur, one), o.lv.ty); this.emit('OpStore', o.lv.ptr, nv.id); return nv; }
                if (x.v === '(' && this.isTypeStart(1)) { this.i++; const t = this.parseTypeName(); this.need(')'); if (this.is('{')) unsup('複合字面值'); const v = this.rv(this.unary()); return this.conv(v, t); }
            }
            if (x.t === 'id' && x.v === 'sizeof') { this.i++; let sz; if (this.is('(') && this.isTypeStart(1)) { this.i++; sz = sizeOf(this.parseTypeName()); this.need(')'); } else { const save = this.cur.ins.length, o = this.unary(); sz = o.lv ? sizeOf(o.lv.ty) : sizeOf(o.ty); this.cur.ins.length = save; } return { id: this.m.cInt(this.m.tInt(64), sz), ty: INT(64, false) }; }
            return this.postfix();
        }
        postfix() {
            let o = this.primary();
            for (;;) {
                if (this.is('[')) {
                    this.i++; const idx = this.rv(this.expr()); this.need(']'); const base = this.rv(o); if (!isPtr(base.ty)) this.err('[] 的對象不是指標或陣列'); if (!isInt(promote(idx.ty))) this.err('索引要整數');
                    const ii = this.conv(idx, INT(64, true)); const pe = base.ty; const ptr = this.res('OpInBoundsPtrAccessChain', this.m.tyId(pe), base.id, ii.id);
                    if (pe.to.k === 'ptr' || pe.to.k === 'arr') unsup('指標的指標／多維陣列'); o = { lv: { ptr, ty: pe.to, as: pe.as } }; continue;
                }
                if (this.is('++') || this.is('--')) { const op = this.tk.v; this.i++; if (!o.lv) this.err(op + ' 要左值'); const cur = this.rv(o), one = { id: this.m.cInt(this.m.tInt(32), 1), ty: INT(32, true) }; const nv = this.conv(this.binop(op === '++' ? '+' : '-', cur, one), o.lv.ty); this.emit('OpStore', o.lv.ptr, nv.id); o = cur; continue; }
                if (this.is('.') || this.is('->')) unsup('成員存取（struct／向量分量）', this.line());
                return o;
            }
        }
        primary() {
            const x = this.tk; if (!x) this.err('運算式提早結束');
            if (x.t === 'num') { this.i++; return this.number(x); }
            if (x.t === 'str' || x.t === 'chr') unsup('字串／字元字面值');
            if (this.is('(')) { this.i++; const o = this.expr(); this.need(')'); return o; }
            if (x.t === 'id') {
                this.i++;
                if (this.is('(')) return this.call(x);
                const v = this.lookup(x.v); if (!v) { if (/^CLK_/.test(x.v)) unsup('常數 ' + x.v); this.err('未宣告的名稱 ' + x.v); }
                return { lv: { ptr: v.ptr, ty: v.ty, as: v.as } };
            }
            this.err('不認得的運算式「' + x.v + '」');
        }
        number(x) {
            const s = x.v, M = this.m;
            if (/^0[xX][0-9a-fA-F]+[uUlL]*$/.test(s) || /^\d+[uUlL]*$/.test(s)) {
                const u = /[uU]/.test(s), l = /[lL]/.test(s), digits = s.replace(/[uUlL]+$/, ''), v = BigInt(digits); let t;
                if (!l && !u) t = v <= 0x7FFFFFFFn ? INT(32, true) : v <= 0xFFFFFFFFn && /^0[xX]/.test(digits) ? INT(32, false) : INT(64, true); else if (u && !l) t = v <= 0xFFFFFFFFn ? INT(32, false) : INT(64, false); else t = u ? INT(64, false) : INT(64, true);
                return { id: M.cInt(M.tyId(t), v), ty: t };
            }
            const f = /[fF]$/.test(s), body = s.replace(/[fFlL]+$/, ''), v = Number(body); if (Number.isNaN(v)) this.err('不是數字 ' + s);
            return { id: M.cFloat(f ? 32 : 64, f ? Math.fround(v) : v), ty: FLT(f ? 32 : 64) };
        }
        call(nameTok) {
            const name = nameTok.v, line = nameTok.line, M = this.m; this.need('('); const args = [];
            if (!this.is(')')) for (;;) { args.push(this.assign()); if (!this.eat(',')) break; } this.need(')');
            const A = () => args.map((a) => this.rv(a));
            if (name === 'barrier' || name === 'work_group_barrier') { const u = M.tInt(32); this.emit('OpControlBarrier', M.cInt(u, 2), M.cInt(u, 2), M.cInt(u, 0x308)); return { id: 0, ty: VOID }; }
            if (name === 'mem_fence' || name === 'read_mem_fence' || name === 'write_mem_fence') { const u = M.tInt(32); this.emit('OpMemoryBarrier', M.cInt(u, 2), M.cInt(u, 0x308)); return { id: 0, ty: VOID }; }
            if (WORKITEM[name]) {
                if (args.length !== 1) this.err(name + ' 要 1 個引數'); const bi = M.builtin(WORKITEM[name]), vec = this.res('OpLoad', bi.ty, bi.id), d = this.conv(this.rv(args[0]), INT(32, false));
                return { id: this.res('OpVectorExtractDynamic', M.tInt(64), vec, d.id), ty: INT(64, false) };
            }
            if (name === 'get_work_dim') { const bi = M.builtin('WorkDim'); return { id: this.res('OpLoad', bi.ty, bi.id), ty: INT(32, false) }; }
            const fn = this.fns.get(name); if (fn) {
                if (args.length !== fn.params.length) this.err('函式 ' + name + ' 需要 ' + fn.params.length + ' 個引數');
                const vs = A().map((v, k) => this.conv(v, fn.params[k])); return { id: this.res('OpFunctionCall', M.tyId(fn.ret), fn.id, ...vs.map((v) => v.id)), ty: fn.ret };
            }
            return this.builtinCall(name, A(), line);
        }
        ext(name, rt, ids) { const set = this.m.oclSet(); return this.res('OpExtInst', this.m.tyId(rt), set, T.oclOps[name][0], ...ids); }
        builtinCall(name, a, line) {
            const M = this.m, base = name.replace(/^(native_|half_)/, '');
            const needF = (n) => { if (a.length !== n) this.err(name + ' 要 ' + n + ' 個引數'); };
            const toFloat = (vs) => { const ty = vs.some((v) => v.ty.k === 'float' && v.ty.w === 64) ? FLT(64) : FLT(32); return { ty, vs: vs.map((v) => this.conv(v, ty)) }; };
            if (MATH1[base] && a.length === 1) { const f = toFloat(a); return { id: this.ext(MATH1[base], f.ty, [f.vs[0].id]), ty: f.ty }; }
            if (MATH2[base] && a.length === 2) { const f = toFloat(a); return { id: this.ext(MATH2[base], f.ty, f.vs.map((v) => v.id)), ty: f.ty }; }
            if (MATH3[base] && a.length === 3) { const f = toFloat(a); return { id: this.ext(MATH3[base], f.ty, f.vs.map((v) => v.id)), ty: f.ty }; }
            if ((base === 'divide' || base === 'recip') && a.length === (base === 'divide' ? 2 : 1)) { const f = toFloat(a); return base === 'divide' ? { id: this.res('OpFDiv', M.tyId(f.ty), f.vs[0].id, f.vs[1].id), ty: f.ty } : { id: this.res('OpFDiv', M.tyId(f.ty), M.cFloat(f.ty.w, 1), f.vs[0].id), ty: f.ty }; }
            if (name === 'min' || name === 'max' || name === 'fmin' || name === 'fmax') { needF(2); const ct = commonType(a[0].ty, a[1].ty), x = this.conv(a[0], ct), y = this.conv(a[1], ct); const en = isFlt(ct) ? (name.endsWith('min') ? 'fmin' : 'fmax') : (name === 'min' ? (ct.s ? 's_min' : 'u_min') : (ct.s ? 's_max' : 'u_max')); return { id: this.ext(en, ct, [x.id, y.id]), ty: ct }; }
            if (name === 'abs') { needF(1); const t = promote(a[0].ty); if (isFlt(t)) return { id: this.ext('fabs', t, [this.conv(a[0], t).id]), ty: t }; const ut = INT(t.w, false); return { id: this.ext(t.s ? 's_abs' : 'u_abs', ut, [this.conv(a[0], t).id]), ty: ut }; }
            if (name === 'clamp') { needF(3); const ct = commonType(commonType(a[0].ty, a[1].ty), a[2].ty), xs = a.map((v) => this.conv(v, ct).id); return { id: this.ext(isFlt(ct) ? 'fclamp' : ct.s ? 's_clamp' : 'u_clamp', ct, xs), ty: ct }; }
            if (name === 'select') { needF(3); const ct = commonType(a[0].ty, a[1].ty), x = this.conv(a[0], ct), y = this.conv(a[1], ct); return { id: this.res('OpSelect', M.tyId(ct), this.toBool(a[2]), y.id, x.id), ty: ct }; }
            if (name === 'mul24' || name === 'mad24') { const n = name === 'mul24' ? 2 : 3; needF(n); const ct = commonType(a[0].ty, a[1].ty), xs = a.map((v) => this.conv(v, ct).id); return { id: this.ext((ct.s ? 's_' : 'u_') + name, ct, xs), ty: ct }; }
            if (name === 'popcount' || name === 'clz' || name === 'ctz') { needF(1); const t = promote(a[0].ty); return { id: this.ext(name, t, [this.conv(a[0], t).id]), ty: t }; }
            if (name === 'isnan' || name === 'isinf' || name === 'isfinite') { needF(1); const f = toFloat(a), op = { isnan: 'OpIsNan', isinf: 'OpIsInf', isfinite: 'OpIsFinite' }[name]; return { id: this.res(op, M.tBool(), f.vs[0].id), ty: BOOL }; }
            if (name === 'pown' || name === 'rootn' || name === 'ldexp') { needF(2); const f = toFloat([a[0]]); return { id: this.ext(name, f.ty, [f.vs[0].id, this.conv(a[1], INT(32, true)).id]), ty: f.ty }; }
            const am = /^(?:atomic|atom)_(add|sub|inc|dec|xchg|cmpxchg|min|max|and|or|xor)$/.exec(name);
            if (am) {
                const p = a[0]; if (!p || !isPtr(p.ty) || !isInt(p.ty.to) || p.ty.to.w < 32) this.err(name + ' 的第一個引數要是 int／uint／long／ulong 的指標'); const t = p.ty.to, u = M.tInt(32), scope = M.cInt(u, p.ty.as === 'local' ? 2 : 1), sem = M.cInt(u, 0), tid = M.tyId(t); let opn = ATOMIC[am[1]];
                if (opn === 'min') opn = t.s ? 'OpAtomicSMin' : 'OpAtomicUMin'; else if (opn === 'max') opn = t.s ? 'OpAtomicSMax' : 'OpAtomicUMax';
                if (am[1] === 'inc' || am[1] === 'dec') return { id: this.res(opn, tid, p.id, scope, sem), ty: t };
                if (am[1] === 'cmpxchg') { const cmp = this.conv(a[1], t), val = this.conv(a[2], t); return { id: this.res(opn, tid, p.id, scope, sem, sem, val.id, cmp.id), ty: t }; }
                const v = this.conv(a[1], t); return { id: this.res(opn, tid, p.id, scope, sem, v.id), ty: t };
            }
            unsup('函式 ' + name + '（內建函式不在子集內，或沒有定義）', line);
        }

        // ---- 敘述
        stmt() {
            const x = this.tk; if (!x) this.err('敘述提早結束');
            if (this.is('{')) { this.i++; this.push(); while (!this.is('}')) { if (!this.tk) this.err('缺少 }'); this.stmt(); } this.i++; this.pop(); return; }
            if (this.eat(';')) return;
            if (x.t === 'id') {
                switch (x.v) {
                    case 'if': { this.i++; this.need('('); const c = this.toBool(this.rv(this.expr())); this.need(')'); const A = this.newBlock(), E = this.newBlock(); let B = E; const hasElse = (() => { return true; })(); void hasElse; const Belse = this.newBlock();
                        this.emit('OpSelectionMerge', E.id, 0); this.term('OpBranchConditional', c, A.id, Belse.id); this.startBlock(A); this.stmt(); if (!this.cur.term) this.br(E);
                        this.startBlock(Belse); if (this.eat('else')) this.stmt(); if (!this.cur.term) this.br(E); void B; this.startBlock(E); return; }
                    case 'while': { this.i++; const H = this.newBlock(), Bd = this.newBlock(), C = this.newBlock(), E = this.newBlock(); this.br(H); this.startBlock(H); this.need('('); const c = this.toBool(this.rv(this.expr())); this.need(')');
                        this.emit('OpLoopMerge', E.id, C.id, 0); this.term('OpBranchConditional', c, Bd.id, E.id); this.startBlock(Bd); this.loops.push({ brk: E, cont: C }); this.stmt(); this.loops.pop(); if (!this.cur.term) this.br(C); this.startBlock(C); this.br(H); this.startBlock(E); return; }
                    case 'do': { this.i++; const Bd = this.newBlock(), C = this.newBlock(), E = this.newBlock(), H = this.newBlock(); this.br(H); this.startBlock(H); this.emit('OpLoopMerge', E.id, C.id, 0); this.br(Bd); this.startBlock(Bd); this.loops.push({ brk: E, cont: C }); this.stmt(); this.loops.pop(); if (!this.cur.term) this.br(C);
                        this.startBlock(C); this.need('while'); this.need('('); const c = this.toBool(this.rv(this.expr())); this.need(')'); this.need(';'); this.term('OpBranchConditional', c, H.id, E.id); this.startBlock(E); return; }
                    case 'for': { this.i++; this.need('('); this.push();
                        if (!this.is(';')) { if (this.isTypeStart()) this.declaration(); else { this.rv(this.expr()); this.need(';'); } } else this.i++;
                        const H = this.newBlock(), Bd = this.newBlock(), C = this.newBlock(), E = this.newBlock(); this.br(H); this.startBlock(H);
                        let c = null; if (!this.is(';')) c = this.toBool(this.rv(this.expr())); this.need(';');
                        // 遞增式要放在 continue 區塊：先記下記號範圍，稍後再解析
                        const incStart = this.i; let depth = 0; while (!(depth === 0 && this.is(')'))) { if (this.is('(')) depth++; if (this.is(')')) depth--; this.i++; if (!this.tk) this.err('for 缺少 )'); } const incEnd = this.i; this.need(')');
                        this.emit('OpLoopMerge', E.id, C.id, 0); this.term('OpBranchConditional', c === null ? this.m.cBool(true) : c, Bd.id, E.id);
                        this.startBlock(Bd); this.loops.push({ brk: E, cont: C }); this.stmt(); this.loops.pop(); if (!this.cur.term) this.br(C);
                        this.startBlock(C); const resume = this.i; this.i = incStart; if (incStart < incEnd) { this.rv(this.expr()); } this.i = resume; this.br(H); this.startBlock(E); this.pop(); return; }
                    case 'break': { this.i++; this.need(';'); if (!this.loops.length) this.err('break 不在迴圈裡'); this.br(this.loops[this.loops.length - 1].brk); return; }
                    case 'continue': { this.i++; this.need(';'); if (!this.loops.length) this.err('continue 不在迴圈裡'); this.br(this.loops[this.loops.length - 1].cont); return; }
                    case 'return': { this.i++; if (this.eat(';')) { this.term('OpReturn'); return; } const v = this.conv(this.rv(this.expr()), this.fn.ret); this.need(';'); this.term('OpReturnValue', v.id); return; }
                    case 'switch': case 'goto': unsup(x.v + ' 敘述', x.line);
                }
                if (this.isTypeStart()) { this.declaration(); return; }
            }
            this.rv(this.expr()); this.need(';');
        }
        declaration() {
            const base = this.parseBase();
            for (;;) {
                let t = this.parsePtrs(base, 'private'); const nm = this.tk; if (!nm || nm.t !== 'id') this.err('宣告需要名稱'); this.i++;
                if (this.is('[')) { this.i++; const e = this.expr(); this.need(']'); const n = this.constOf(e); if (this.is('[')) unsup('多維陣列'); t = { k: 'arr', to: t, n }; }
                const as = base.as === 'local' ? 'local' : base.as === 'constant' ? unsup('函式內的 __constant 變數') : null;
                if (as === 'local' && this.fn.kernel !== true) unsup('輔助函式內的 __local 變數');
                const v = this.declareVar(nm.v, t, as || 'private');
                if (this.eat('=')) { if (t.k === 'arr' || as === 'local') unsup('陣列／__local 的初始化'); const val = this.conv(this.rv(this.assign()), t); this.emit('OpStore', v.ptr, val.id); }
                if (!this.eat(',')) break;
            }
            this.need(';');
        }
        constOf(o) {   // 陣列長度：只收整數常數（最後一個指令是 OpConstant）
            const last = this.cur.ins[this.cur.ins.length - 1]; void last;
            const ids = o.id; for (const [k, id] of this.m.cmap) if (id === ids && k.startsWith('ci')) { const v = Number(k.split(':')[1]); if (v > 0) return v; }
            unsup('陣列長度要是整數常數');
        }

        // ---- 函式與頂層
        run() {
            const M = this.m; const kernels = [];
            while (this.i < this.t.length) {
                if (this.is('__attribute__')) { this.i++; this.need('('); this.need('('); let d = 2; while (d > 0) { if (this.is('(')) d++; if (this.is(')')) d--; this.i++; } continue; }
                if (this.eat(';')) continue;
                let kernel = false; while (this.tk && this.tk.t === 'id' && ['__kernel', 'kernel'].includes(this.tk.v)) { kernel = true; this.i++; }
                if (!this.isTypeStart()) unsup('頂層的「' + (this.tk ? this.tk.v : '') + '」（全域變數、typedef、struct 等）', this.line());
                const rb = this.parseBase(), ret = this.parsePtrs(rb, 'private'); const nm = this.tk; if (!nm || nm.t !== 'id') this.err('需要函式名稱'); this.i++;
                if (!this.is('(')) unsup('全域變數 ' + nm.v, nm.line);
                this.need('('); const params = []; const pnames = [];
                if (!this.is(')')) { if (this.is('void') && this.t[this.i + 1] && this.t[this.i + 1].v === ')') this.i++; else for (;;) {
                    const pb = this.parseBase(); const pt = this.parsePtrs(pb, 'private'); let pn = null; if (this.tk && this.tk.t === 'id' && !this.is(',') ) { pn = this.tk.v; this.i++; }
                    if (this.is('[')) unsup('陣列參數'); let ty = pt; if (kernel && isPtr(ty) && ty.as === 'private') ty = Object.assign({}, ty, { as: 'global' });   // 沒標位址空間的指標參數：kernel 當 __global
                    if (pt.k === 'ptr' && pb.cst) ty = Object.assign({}, ty, { cst: true }); params.push(ty); pnames.push(pn || ''); if (!this.eat(',')) break; } }
                this.need(')');
                const prior = this.fns.get(nm.v), fid = prior ? prior.id : M.id(); const info = { id: fid, ret, params, kernel, name: nm.v, defined: false };
                if (prior && (prior.params.length !== params.length)) this.err('函式 ' + nm.v + ' 的宣告不一致'); this.fns.set(nm.v, Object.assign(info, prior ? { id: prior.id } : {}));
                if (this.eat(';')) continue;
                if (!this.is('{')) this.err('函式 ' + nm.v + ' 需要本體');
                this.func(info, pnames, rb, nm.v); if (kernel) kernels.push(info);
            }
            if (!kernels.length) unsup('沒有 __kernel 函式');
            return M.binary();
        }
        func(info, pnames, rb, name) {
            const M = this.m; const fnTy = M.tFn(M.tyId(info.ret), info.params.map((p) => M.tyId(p))); void rb;
            this.fn = { id: info.id, ret: info.ret, kernel: info.kernel, blocks: [], vars: [] }; this.scopes = []; this.push(); this.loops = [];
            const out = [M.ins('OpFunction', M.tyId(info.ret), info.id, 0, fnTy)]; const pids = info.params.map(() => M.id());
            info.params.forEach((p, k) => { out.push(M.ins('OpFunctionParameter', M.tyId(p), pids[k])); if (pnames[k]) M.names.push(M.ins('OpName', pids[k], strWords(pnames[k]))); if (p.k === 'ptr' && p.cst) M.annot.push(M.ins('OpDecorate', pids[k], EN('Decoration', 'FuncParamAttr'), EN('FunctionParameterAttribute', 'NoWrite'))); });
            M.names.push(M.ins('OpName', info.id, strWords(name)));
            this.startBlock(this.newBlock());
            info.params.forEach((p, k) => { if (!pnames[k]) return; const v = this.declareVar(pnames[k], p, 'private'); this.emit('OpStore', v.ptr, pids[k]); });
            this.stmt();   // 本體（區塊）
            if (!this.cur.term) { if (info.ret.k === 'void') this.term('OpReturn'); else this.term('OpUnreachable'); }
            // 組裝：入口區塊的 OpLabel 後面接變數
            this.fn.blocks.forEach((b, bi) => { out.push(M.ins('OpLabel', b.id)); if (bi === 0) out.push(...this.fn.vars); for (const w of b.ins) out.push(w); });
            out.push(M.ins('OpFunctionEnd')); for (const w of out) M.funcs.push(w);
            if (info.kernel) { if (info.ret.k !== 'void') this.err('核心要回傳 void'); M.entry.push(M.ins('OpEntryPoint', EN('ExecutionModel', 'Kernel'), info.id, strWords(name))); }
            info.defined = true; this.pop(); this.fn = null;
        }
    }
    return { compile, toIL };
});
