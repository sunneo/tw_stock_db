/* SPIR-V（OpenCL Kernel 風格）→ WebAssembly（FaSpvWasm，UMD，純邏輯）：cpu 路線的「最終產物」是 wasm 位元組（瀏覽器與 Electron 都能跑）。沒有編譯器可用，直接在 JS 組出二進位
 * （像 cpu_gemm_wasm.js 的手組微核心，但這個是通用的核心轉譯）。
 *   const r = FaSpvWasm.compile(il, { spec });  → { ok:true, wasm:Uint8Array, kernels, imports } 或 { ok:false, unsupported:true, log }
 *   const x = FaSpvWasm.instantiate(art);       → 結果（同 FaClc.compile 的形狀：kernels、mkptr、run）；模組小就同步回傳，否則回 Promise（主執行緒的同步編譯上限 4 KB）
 * 轉譯：每個 SPIR-V 函式一個 wasm 函式；指標是 i32 位元組位址；Function 變數若只被 Load／Store 用到就變成 wasm 區域變數（其餘放堆疊框，sp 全域）；多個基本區塊的函式用
 * 「loop＋br_table 的狀態機」（phi 靠運算元堆疊在分支邊上平行賦值）；每個核心一個匯出函式 run_<名>(參數…, dim, gs×3, ls×3, off×3)，工作項的六層迴圈在 wasm 裡，內建變數是可變全域（i64）。
 * 數學：能用 wasm 原生指令的就用（abs／sqrt／floor／ceil／trunc／rint／min／max／copysign；fma／mad 以乘加實作），其餘（sin、cos、exp、log、pow、atan2…）匯入 JS 的 Math。
 * 記憶體：wasm 有自己的線性記憶體，執行時把緩衝區參數複製進去、跑完把「不是唯讀」的複製回來（同一塊緩衝區傳兩次共用同一份），所以大緩衝區＋少量運算時比 clc 的零拷貝 JS 路線慢，
 * 運算密集的核心才划算（實測見 DESIGN.pyopencl.md §15）。
 * 支援（子集；超出一律回 unsupported，驅動自動退回 SPIR-V→JS 或 clc 直接編譯）：純量整數（8–64）、float32／64、bool、指標（Function／CrossWorkgroup／UniformConstant）、一維陣列變數、
 *   OpAccessChain／PtrAccessChain、算術／比較／位元／移位／轉換／Select／Phi／分支／switch／函式呼叫、OpenCL.std 常用數學與整數函式、內建變數。
 * 不支援：向量與 struct 值、__local／Workgroup 與 barrier（工作群協作需要執行緒；本環境沒有 SharedArrayBuffer）、原子、圖像、pipe、全域變數、Float16。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./spv_js.js'), require('./clc_js.js'));
    else root.FaSpvWasm = factory(root.FaSpv, root.FaClc);
})(typeof self !== 'undefined' ? self : this, function (SPV, CLC) {
    'use strict';
    const X = SPV.internals, VERSION = 1;
    class Unsup extends Error { constructor(m) { super(m); this.name = 'Unsup'; } }
    const unsup = (m) => { throw new Unsup(m); };
    const I32 = 0x7f, I64 = 0x7e, F32 = 0x7d, F64 = 0x7c;
    const uleb = (n) => { const o = []; n = BigInt(n); do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; o.push(b); } while (n); return o; };
    const sleb = (n) => { const o = []; n = BigInt(n); for (;;) { const b = Number(n & 0x7fn); n >>= 7n; if ((n === 0n && !(b & 0x40)) || (n === -1n && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
    const f32b = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return Array.from(b); }, f64b = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return Array.from(b); };
    const str = (s) => { const b = Array.from(new TextEncoder().encode(s)); return uleb(b.length).concat(b); };
    const flat = (arrs) => [].concat(...arrs), vec = (items) => uleb(items.length).concat(flat(items)), section = (id, body) => [id].concat(uleb(body.length), body);
    const O = { unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, br_if: 0x0d, br_table: 0x0e, return: 0x0f, call: 0x10, drop: 0x1a, select: 0x1b, lget: 0x20, lset: 0x21, ltee: 0x22, gget: 0x23, gset: 0x24,
        i32_const: 0x41, i64_const: 0x42, f32_const: 0x43, f64_const: 0x44, i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48, i32_lt_u: 0x49, i32_gt_s: 0x4a, i32_gt_u: 0x4b, i32_le_s: 0x4c, i32_le_u: 0x4d, i32_ge_s: 0x4e, i32_ge_u: 0x4f,
        i64_eqz: 0x50, i64_eq: 0x51, i64_ne: 0x52, i64_lt_s: 0x53, i64_lt_u: 0x54, i64_gt_s: 0x55, i64_gt_u: 0x56, i64_le_s: 0x57, i64_le_u: 0x58, i64_ge_s: 0x59, i64_ge_u: 0x5a,
        f32_eq: 0x5b, f32_ne: 0x5c, f32_lt: 0x5d, f32_gt: 0x5e, f32_le: 0x5f, f32_ge: 0x60, f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64, f64_le: 0x65, f64_ge: 0x66,
        i32_clz: 0x67, i32_ctz: 0x68, i32_popcnt: 0x69, i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_div_s: 0x6d, i32_div_u: 0x6e, i32_rem_s: 0x6f, i32_rem_u: 0x70, i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
        i64_clz: 0x79, i64_ctz: 0x7a, i64_popcnt: 0x7b, i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e, i64_div_s: 0x7f, i64_div_u: 0x80, i64_rem_s: 0x81, i64_rem_u: 0x82, i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85, i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88,
        f32_abs: 0x8b, f32_neg: 0x8c, f32_ceil: 0x8d, f32_floor: 0x8e, f32_trunc: 0x8f, f32_nearest: 0x90, f32_sqrt: 0x91, f32_add: 0x92, f32_sub: 0x93, f32_mul: 0x94, f32_div: 0x95, f32_min: 0x96, f32_max: 0x97, f32_copysign: 0x98,
        f64_abs: 0x99, f64_neg: 0x9a, f64_ceil: 0x9b, f64_floor: 0x9c, f64_trunc: 0x9d, f64_nearest: 0x9e, f64_sqrt: 0x9f, f64_add: 0xa0, f64_sub: 0xa1, f64_mul: 0xa2, f64_div: 0xa3, f64_min: 0xa4, f64_max: 0xa5, f64_copysign: 0xa6,
        i32_wrap_i64: 0xa7, i64_extend_i32_s: 0xac, i64_extend_i32_u: 0xad, f32_convert_i32_s: 0xb2, f32_convert_i32_u: 0xb3, f32_convert_i64_s: 0xb4, f32_convert_i64_u: 0xb5, f32_demote_f64: 0xb6, f64_convert_i32_s: 0xb7, f64_convert_i32_u: 0xb8, f64_convert_i64_s: 0xb9, f64_convert_i64_u: 0xba, f64_promote_f32: 0xbb,
        i32_reinterpret_f32: 0xbc, i64_reinterpret_f64: 0xbd, f32_reinterpret_i32: 0xbe, f64_reinterpret_i64: 0xbf, i32_extend8_s: 0xc0, i32_extend16_s: 0xc1 };
    const TSAT = { i32_f32_s: 0, i32_f32_u: 1, i32_f64_s: 2, i32_f64_u: 3, i64_f32_s: 4, i64_f32_u: 5, i64_f64_s: 6, i64_f64_u: 7 };   // 0xFC 前綴的飽和轉換（不陷入，NaN→0）
    const LOAD = { i32: [0x28, 2], i64: [0x29, 3], f32: [0x2a, 2], f64: [0x2b, 3], i8s: [0x2c, 0], i8u: [0x2d, 0], i16s: [0x2e, 1] }, STORE = { i32: [0x36, 2], i64: [0x37, 3], f32: [0x38, 2], f64: [0x39, 3], i8: [0x3a, 0], i16: [0x3b, 1] };
    const GLOBALS = ['g0', 'g1', 'g2', 'l0', 'l1', 'l2', 'grp0', 'grp1', 'grp2', 'gs0', 'gs1', 'gs2', 'ls0', 'ls1', 'ls2', 'ng0', 'ng1', 'ng2', 'off0', 'off1', 'off2'];   // i64；接著 dim、sp（i32）
    const GI = Object.fromEntries(GLOBALS.map((n, i) => [n, i])), G_DIM = GLOBALS.length, G_SP = GLOBALS.length + 1;
    const STACK_TOP = 65536, DATA_BASE = 65536;   // 堆疊在 [1024, 65536)，緩衝區從 65536 起
    const BUILTIN_G = { GlobalInvocationId: 'g', LocalInvocationId: 'l', WorkgroupId: 'grp', GlobalSize: 'gs', WorkgroupSize: 'ls', NumWorkgroups: 'ng', GlobalOffset: 'off', EnqueuedWorkgroupSize: 'ls' };
    const NATIVE1 = { fabs: 'abs', ceil: 'ceil', floor: 'floor', trunc: 'trunc', rint: 'nearest', sqrt: 'sqrt' };
    const IMPORT1 = ['acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'cbrt', 'cos', 'cosh', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'sin', 'sinh', 'tan', 'tanh', 'exp2', 'exp10', 'round', 'rsqrt', 'erf', 'erfc', 'tgamma', 'logb', 'degrees', 'radians', 'sign'];
    const IMPORT2 = ['atan2', 'hypot', 'pow', 'powr', 'fmod', 'fmod2', 'remainder', 'fdim', 'step'], IMPORT3 = ['mix', 'smoothstep'];
    const classify = (n) => n.replace(/^(native_|half_)/, '');

    function compile(il, options) {
        options = options || {};
        try {
            const dec = X.decode(il), M = X.analyze(dec, options);
            for (const ins of dec.insts) if (ins.name === 'OpTypeImage') M.types.get(ins.w[0]).sampledTypeId = ins.w[1];
            return emitModule(M);
        } catch (e) {
            if (e instanceof Unsup) return { ok: false, unsupported: true, log: 'wasm 後端不支援：' + e.message };
            if (e instanceof X.SpvError) return { ok: false, unsupported: false, log: 'SPIR-V 建置失敗：' + e.message };
            throw e;
        }
    }

    function emitModule(M) {
        const TY = X.makeTypes(M), { ty, layout } = TY, EN = X.EN, OCLN = X.OCLN;
        if (M.caps.has('Shader') || !M.caps.has('Kernel')) unsup('不是 OpenCL Kernel 的 SPIR-V');
        if (M.memModel && M.memModel !== 'OpenCL') unsup('記憶體模型 ' + M.memModel);
        const vt = (tid) => { const t = ty(tid); switch (t.k) { case 'int': return t.w === 64 ? I64 : I32; case 'float': if (t.w === 16) unsup('half'); return t.w === 32 ? F32 : F64; case 'bool': return I32; case 'ptr': return I32; } return unsup('型別 ' + t.k + '（向量／struct／圖像等的值）'); };
        const constIds = new Set(M.consts.keys()), builtinVars = new Map();
        for (const g of M.globals) { const d = M.deco.get(g.id) || [], bi = d.find((x) => x.k === 'BuiltIn'); if (g.sc === 'Input' && bi) builtinVars.set(g.id, EN('BuiltIn', bi.a[0])); else unsup('全域變數（儲存類別 ' + g.sc + '）'); }
        // 匯入的數學函式：預掃描（匯入要排在函式索引空間的最前面）
        const imports = new Map(), impKey = (name, t, n) => name + ':' + t + ':' + n;
        const needImport = (name, t, n) => { const key = impKey(name, t, n); if (!imports.has(key)) imports.set(key, { name, t, n, key }); };
        for (const f of M.funcs.values()) for (const b of f.blocks) for (const i of b.ins) {
            if (i.op === 'OpFRem' || i.op === 'OpFMod') { const t = ty(i.w[0]); if (t.k === 'float') needImport(i.op === 'OpFRem' ? 'fmod' : 'fmod2', t.w === 32 ? F32 : F64, 2); }
            if (i.op !== 'OpExtInst') continue; const nm = OCLN[i.w[3]]; if (!nm) continue; const t = ty(i.w[0]); if (t.k !== 'float') continue; const r = t.w === 32 ? F32 : F64, base = classify(nm), n = i.w.length - 4;
            if (IMPORT1.includes(base) && n === 1) needImport(base, r, 1); else if (IMPORT2.includes(base) && n === 2) needImport(base, r, 2); else if (IMPORT3.includes(base) && n === 3) needImport(base, r, 3);
        }
        const impList = [...imports.values()], impIndex = new Map(impList.map((im, k) => [im.key, k]));
        const bodyFuncs = M.funcOrder.filter((id) => M.funcs.get(id).blocks.length), fIndex = new Map(bodyFuncs.map((id, k) => [id, impList.length + k]));
        const sigs = [], sigIndex = (params, ret) => { const key = params.join(',') + '>' + (ret === null ? '' : ret); let k = sigs.findIndex((s) => s.key === key); if (k < 0) { sigs.push({ key, params, ret }); k = sigs.length - 1; } return k; };
        const bodyBytes = (locals, code) => { const groups = []; for (const t of locals) { if (groups.length && groups[groups.length - 1][1] === t) groups[groups.length - 1][0]++; else groups.push([1, t]); } const b = vec(groups.map(([n, t]) => uleb(n).concat([t]))).concat(code, [O.end]); return uleb(b.length).concat(b); };
        const funcs = bodyFuncs.map((id) => genFunction(M.funcs.get(id)));
        const kernels = {}, runs = [];
        for (const en of M.entries) {
            if (en.model !== 'Kernel') unsup('入口點 ' + en.name + ' 的執行模型 ' + en.model); const f = M.funcs.get(en.fn); if (!f || !f.blocks.length) unsup('入口點 ' + en.name + ' 沒有本體');
            const params = f.params.map((p, i) => paramDesc(p, i)); kernels[en.name] = { params, wasmParams: f.params.map((p) => vt(p.ty)) }; runs.push({ name: en.name, fn: en.fn, paramVts: f.params.map((p) => vt(p.ty)) });
        }
        if (!runs.length) unsup('沒有 Kernel 入口點');
        const runFuncs = runs.map((r) => genRun(r));
        const impSigs = impList.map((im) => sigIndex(new Array(im.n).fill(im.t), im.t));
        const typeSec = vec(sigs.map((s) => [0x60].concat(vec(s.params.map((p) => [p])), s.ret === null ? [0] : [1, s.ret])));
        const importSec = vec(impList.map((im, k) => str('env').concat(str(im.name + '_' + (im.t === F32 ? 'f32' : 'f64')), [0x00], uleb(impSigs[k]))));
        const funcSec = vec([...funcs.map((f) => uleb(f.sig)), ...runFuncs.map((f) => uleb(f.sig))]);
        const memSec = vec([[0x00].concat(uleb(2))]);
        const globSec = vec([...GLOBALS.map(() => [I64, 1, O.i64_const, 0, O.end]), [I32, 1, O.i32_const, 0, O.end], [I32, 1, O.i32_const].concat(sleb(STACK_TOP), [O.end])]);
        const exportSec = vec([str('mem').concat([0x02], uleb(0)), ...runs.map((r, k) => str('run_' + r.name).concat([0x00], uleb(impList.length + bodyFuncs.length + k)))]);
        const codeSec = vec([...funcs.map((f) => f.body), ...runFuncs.map((f) => f.body)]);
        const wasm = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0].concat(section(1, typeSec), section(2, importSec), section(3, funcSec), section(5, memSec), section(6, globSec), section(7, exportSec), section(10, codeSec)));
        return { ok: true, wasm, kernels, imports: impList.map((im) => ({ name: im.name + '_' + (im.t === F32 ? 'f32' : 'f64'), base: im.name, f32: im.t === F32 })) };

        function paramDesc(p, i) {
            const t = ty(p.ty), name = M.names.get(p.id) || 'arg' + i, attrs = (M.deco.get(p.id) || []).filter((d) => d.k === 'FuncParamAttr').map((d) => EN('FunctionParameterAttribute', d.a[0]));
            if (t.k === 'ptr') {
                const pt = ty(t.pointee); if (t.sc === 'Workgroup') unsup('__local 參數（工作群協作需要 barrier／執行緒）');
                if (t.sc === 'CrossWorkgroup' || t.sc === 'UniformConstant') { if (!['int', 'float', 'bool'].includes(pt.k)) unsup('緩衝區元素型別 ' + pt.k); return { name, kind: 'buf', type: pt.k === 'float' ? (pt.w === 32 ? 'float' : 'double') : { 8: 'char', 16: 'short', 32: 'int', 64: 'long' }[pt.w] || 'int', access: attrs.includes('NoWrite') || t.sc === 'UniformConstant' ? 'in' : 'rw' }; }
                unsup('指標參數的儲存類別 ' + t.sc);
            }
            if (t.k === 'int' || t.k === 'float' || t.k === 'bool') return { name, kind: 'scalar', type: t.k === 'float' ? (t.w === 32 ? 'float' : 'double') : t.k === 'bool' ? 'int' : { 8: 'char', 16: 'short', 32: 'int', 64: 'long' }[t.w] };
            return unsup('參數型別 ' + t.k);
        }

        function genFunction(f) {
            const fnT = ty(f.fnTy), ret = ty(fnT.ret).k === 'void' ? null : vt(fnT.ret), paramVt = f.params.map((p) => vt(p.ty)), nParams = f.params.length;
            const code = [], locals = [], L = (...b) => { for (const x of b) code.push(x); }, localIdx = new Map(), resTy = new Map(), virt = new Map();
            f.params.forEach((p, k) => { localIdx.set(p.id, k); resTy.set(p.id, p.ty); });
            const newLocal = (type) => { locals.push(type); return nParams + locals.length - 1; };
            const allIns = []; for (const b of f.blocks) for (const i of b.ins) allIns.push(i);
            for (const i of allIns) if (i.w && X.T_HAS_RESULT[i.op]) resTy.set(i.w[1], i.w[0]);
            // 變數提升（同 spv_js）：只被 Load／Store 用到的 Function 變數成為區域變數；其餘放堆疊框
            const varUses = new Map(), promoted = new Set(), lso = (i, v) => (i.op === 'OpLoad' && i.w[2] === v) || (i.op === 'OpStore' && i.w[0] === v && i.w[1] !== v);
            for (const i of allIns) if (i.op === 'OpVariable') { if (i.v.sc !== 'Function') unsup('函式內的變數儲存類別 ' + i.v.sc); const pt = ty(ty(i.v.ty).pointee); if (['bool', 'int', 'float', 'ptr'].includes(pt.k)) varUses.set(i.v.id, true); }
            for (const i of allIns) { if (i.op === 'OpVariable') continue; for (const v of varUses.keys()) { if (varUses.get(v) === false || !i.w.includes(v) || lso(i, v)) continue; varUses.set(v, false); } }
            for (const [v, ok] of varUses) if (ok) promoted.add(v);
            let frame = 0; const frameOff = new Map();
            for (const i of allIns) if (i.op === 'OpVariable' && !promoted.has(i.v.id)) { const l = layout(ty(i.v.ty).pointee), al = Math.max(8, l.align); frame = Math.ceil(frame / al) * al; frameOff.set(i.v.id, frame); frame += Math.max(8, l.size); }
            frame = Math.ceil(frame / 16) * 16; const fb = frame ? newLocal(I32) : -1;
            const lv = (id) => { if (localIdx.has(id)) return localIdx.get(id); const tid = promoted.has(id) ? ty(resTy.get(id)).pointee : resTy.get(id), k = newLocal(vt(tid)); localIdx.set(id, k); return k; };   // 提升的變數：區域變數放的是「值」（指向型別），不是指標
            const T1 = (id) => { if (constIds.has(id)) return M.consts.get(id).ty; if (resTy.has(id)) return resTy.get(id); return unsup('找不到 id ' + id + ' 的型別'); };
            const konst = (tid, v) => { const t = ty(tid); if (Array.isArray(v)) unsup('向量／聚合常數'); if (t.k === 'bool') return L(O.i32_const, v ? 1 : 0); if (t.k === 'ptr') return L(O.i32_const, 0); if (t.k === 'int') return t.w === 64 ? L(O.i64_const, ...sleb(BigInt(v))) : L(O.i32_const, ...sleb(v)); return t.w === 32 ? L(O.f32_const, ...f32b(v)) : L(O.f64_const, ...f64b(v)); };
            const V = (id) => { if (constIds.has(id)) return konst(M.consts.get(id).ty, X.constValue(M, TY, id)); if (builtinVars.has(id) || virt.has(id)) unsup('內建向量要先取分量'); L(O.lget, ...uleb(lv(id))); };
            const set = (id) => L(O.lset, ...uleb(lv(id)));
            const wOf = (tid) => { const t = ty(tid); return t.k === 'bool' ? 1 : t.w; };
            const canon = (w) => { if (w === 8) L(O.i32_extend8_s); else if (w === 16) L(O.i32_extend16_s); };
            const mask = (w) => { if (w === 8) L(O.i32_const, ...sleb(255), O.i32_and); else if (w === 16) L(O.i32_const, ...sleb(65535), O.i32_and); };
            const Vu = (id) => { V(id); mask(wOf(T1(id))); };   // 無號運算用：窄整數先遮罩
            const blockIdx = new Map(f.blocks.map((b, k) => [b.id, k])), N = f.blocks.length, single = N === 1;
            const phis = new Map(); for (const b of f.blocks) for (const i of b.ins) if (i.op === 'OpPhi') { const pairs = []; for (let k = 2; k + 1 < i.w.length; k += 2) pairs.push({ val: i.w[k], from: i.w[k + 1] }); if (!phis.has(b.id)) phis.set(b.id, []); phis.get(b.id).push({ id: i.w[1], pairs }); }
            const bLocal = single ? -1 : newLocal(I32); let depth = 0, curBlock = 0;
            const epilogue = () => { if (frame) L(O.lget, ...uleb(fb), O.i32_const, ...sleb(frame), O.i32_add, O.gset, ...uleb(G_SP)); };
            const goto = (to) => { const ps = phis.get(to); if (ps) { for (const p of ps) { const e = p.pairs.find((x) => x.from === curBlock); if (!e) unsup('phi 缺少來自區塊 ' + curBlock + ' 的值'); V(e.val); } for (let k = ps.length - 1; k >= 0; k--) L(O.lset, ...uleb(lv(ps[k].id))); } L(O.i32_const, ...sleb(blockIdx.get(to)), O.lset, ...uleb(bLocal), O.br, ...uleb(depth)); };
            const memLoad = (tid) => { const t = ty(tid); if (t.k === 'bool') return L(LOAD.i8u[0], LOAD.i8u[1], 0); if (t.k === 'int') { const k = { 8: 'i8s', 16: 'i16s', 32: 'i32', 64: 'i64' }[t.w]; return L(LOAD[k][0], LOAD[k][1], 0); } if (t.k === 'float') { const k = t.w === 32 ? 'f32' : 'f64'; return L(LOAD[k][0], LOAD[k][1], 0); } return unsup('載入型別 ' + t.k); };
            const memStore = (tid) => { const t = ty(tid); if (t.k === 'bool') return L(STORE.i8[0], STORE.i8[1], 0); if (t.k === 'int') { const k = { 8: 'i8', 16: 'i16', 32: 'i32', 64: 'i64' }[t.w]; return L(STORE[k][0], STORE[k][1], 0); } if (t.k === 'float') { const k = t.w === 32 ? 'f32' : 'f64'; return L(STORE[k][0], STORE[k][1], 0); } return unsup('存放型別 ' + t.k); };
            const toI32 = (id) => { V(id); if (vt(T1(id)) === I64) L(O.i32_wrap_i64); };
            const chain = (base, idxIds, isPtr) => {
                let pt = ty(ty(T1(base)).pointee), konstOff = 0; const dyn = []; let rest = idxIds;
                if (isPtr) { const e = rest[0], sz = layout(pt.id).size; if (constIds.has(e)) konstOff += X.constValue(M, TY, e) * sz; else dyn.push([e, sz]); rest = rest.slice(1); }
                for (const e of rest) {
                    if (pt.k === 'struct') { if (!constIds.has(e)) unsup('struct 索引要是常數'); const k = X.constValue(M, TY, e), l = layout(pt.id); konstOff += l.offs[k] || 0; pt = ty(pt.members[k]); }
                    else if (pt.k === 'arr') { const st = layout(pt.id).stride; if (constIds.has(e)) konstOff += X.constValue(M, TY, e) * st; else dyn.push([e, st]); pt = ty(pt.elem); }
                    else unsup('AccessChain 深入 ' + pt.k);
                }
                V(base); for (const [e, sz] of dyn) { toI32(e); L(O.i32_const, ...sleb(sz), O.i32_mul, O.i32_add); } if (konstOff) L(O.i32_const, ...sleb(konstOff), O.i32_add);
            };
            const callImp = (name, r, args) => { const k = impIndex.get(impKey(name, r, args.length)); if (k === undefined) unsup('匯入 ' + name); for (const a of args) V(a); L(O.call, ...uleb(k)); };
            const tmp = (type) => newLocal(type);
            const extInst = (w) => {
                const nm = OCLN[w[3]]; if (!nm) unsup('OpenCL.std 指令 #' + w[3]); const base = classify(nm), t = ty(w[0]), A = w.slice(4);
                if (t.k === 'float') {
                    const r = vt(w[0]), p = r === F32 ? 'f32_' : 'f64_';
                    if (NATIVE1[base] && A.length === 1) { V(A[0]); return L(O[p + NATIVE1[base]]); }
                    if (base === 'fmin' || base === 'fmax' || base === 'fmin_common' || base === 'fmax_common') { V(A[0]); V(A[1]); return L(O[p + (base.includes('min') ? 'min' : 'max')]); }
                    if (base === 'copysign') { V(A[0]); V(A[1]); return L(O[p + 'copysign']); }
                    if (base === 'fma' || base === 'mad') { V(A[0]); V(A[1]); L(O[p + 'mul']); V(A[2]); return L(O[p + 'add']); }
                    if (base === 'fclamp') { V(A[0]); V(A[1]); L(O[p + 'max']); V(A[2]); return L(O[p + 'min']); }
                    if (base === 'divide') { V(A[0]); V(A[1]); return L(O[p + 'div']); }
                    if (base === 'recip') { konst(w[0], 1); V(A[0]); return L(O[p + 'div']); }
                    if ((IMPORT1.includes(base) && A.length === 1) || (IMPORT2.includes(base) && A.length === 2) || (IMPORT3.includes(base) && A.length === 3)) return callImp(base, r, A);
                    return unsup('OpenCL.std ' + nm);
                }
                if (t.k === 'int') {
                    const w2 = t.w; if (w2 !== 32 && w2 !== 64) unsup('OpenCL.std ' + nm + '（' + w2 + ' 位元）'); const p = w2 === 32 ? 'i32_' : 'i64_';
                    const pick = (signed, lt) => { V(A[0]); V(A[1]); V(A[0]); V(A[1]); L(O[p + (lt ? 'lt' : 'gt') + (signed ? '_s' : '_u')], O.select); };   // select(a, b, a<b)：條件為真取 a
                    if (base === 's_min' || base === 'u_min') return pick(base[0] === 's', true); if (base === 's_max' || base === 'u_max') return pick(base[0] === 's', false);
                    if (base === 'u_abs') return V(A[0]);
                    if (base === 's_abs') { konst(w[0], 0); V(A[0]); L(O[p + 'sub']); V(A[0]); V(A[0]); konst(w[0], 0); L(O[p + 'lt_s'], O.select); return; }   // select(0-x, x, x<0)
                    if (base === 'popcount') { V(A[0]); return L(O[p + 'popcnt']); } if (base === 'clz') { V(A[0]); return L(O[p + 'clz']); } if (base === 'ctz') { V(A[0]); return L(O[p + 'ctz']); }
                    if (base === 's_mul24' || base === 'u_mul24') { V(A[0]); V(A[1]); return L(O[p + 'mul']); } if (base === 's_mad24' || base === 'u_mad24') { V(A[0]); V(A[1]); L(O[p + 'mul']); V(A[2]); return L(O[p + 'add']); }
                    if (base === 's_clamp' || base === 'u_clamp') {   // min(max(x, lo), hi)
                        const s = base[0] === 's', sf = s ? '_s' : '_u', ty0 = w2 === 32 ? I32 : I64, m = tmp(ty0);
                        V(A[0]); V(A[1]); V(A[0]); V(A[1]); L(O[p + 'gt' + sf], O.select, O.lset, ...uleb(m));   // m = max(x, lo)
                        L(O.lget, ...uleb(m)); V(A[2]); L(O.lget, ...uleb(m)); V(A[2]); L(O[p + 'lt' + sf], O.select); return;
                    }
                }
                return unsup('OpenCL.std ' + nm);
            };
            const intBin = (op, t, a, b) => {   // 整數二元運算：a、b 是 id
                const w = t.w, p = w === 64 ? 'i64_' : 'i32_', narrow = w < 32;
                switch (op) {
                    case 'OpIAdd': V(a); V(b); L(O[p + 'add']); return canon(w); case 'OpISub': V(a); V(b); L(O[p + 'sub']); return canon(w); case 'OpIMul': V(a); V(b); L(O[p + 'mul']); return canon(w);
                    // 除法與餘數：除以 0 回 0、INT_MIN／-1 不陷入（與 clc 直接編譯的 JS 語意一致；C 裡這些都是未定義行為，wasm 原生會 trap）
                    case 'OpSDiv': case 'OpSRem': case 'OpUDiv': case 'OpUMod': {
                        const ty0 = w === 64 ? I64 : I32, ta = tmp(ty0), tb = tmp(ty0), signed = op === 'OpSDiv' || op === 'OpSRem', isDiv = op === 'OpSDiv' || op === 'OpUDiv', zero = () => (w === 64 ? L(O.i64_const, 0) : L(O.i32_const, 0)), m1 = () => (w === 64 ? L(O.i64_const, ...sleb(-1)) : L(O.i32_const, ...sleb(-1)));
                        if (signed) V(a); else Vu(a); L(O.lset, ...uleb(ta)); if (signed) V(b); else Vu(b); L(O.lset, ...uleb(tb));
                        L(O.lget, ...uleb(tb), O[p + 'eqz'], O.if, ty0); zero(); L(O.else);
                        if (signed) { L(O.lget, ...uleb(tb)); m1(); L(O[p + 'eq'], O.if, ty0); if (isDiv) { zero(); L(O.lget, ...uleb(ta), O[p + 'sub']); } else zero(); L(O.else); }
                        L(O.lget, ...uleb(ta), O.lget, ...uleb(tb), O[p + (isDiv ? (signed ? 'div_s' : 'div_u') : (signed ? 'rem_s' : 'rem_u'))]);
                        if (signed) L(O.end); L(O.end); return canon(w);
                    }
                    case 'OpSMod': { const ty0 = w === 64 ? I64 : I32, tb = tmp(ty0), r = tmp(ty0), ta = tmp(ty0); V(b); L(O.lset, ...uleb(tb)); V(a); L(O.lset, ...uleb(ta));
                        L(O.lget, ...uleb(tb), O[p + 'eqz'], O.lget, ...uleb(tb), w === 64 ? O.i64_const : O.i32_const, ...sleb(-1), O[p + 'eq'], O.i32_or, O.if, 0x40, w === 64 ? O.i64_const : O.i32_const, 0, O.lset, ...uleb(r), O.else, O.lget, ...uleb(ta), O.lget, ...uleb(tb), O[p + 'rem_s'], O.lset, ...uleb(r), O.end);   // b==0 或 b==-1 → 0
                        L(O.lget, ...uleb(r), O.lget, ...uleb(tb), O[p + 'add'], O.lget, ...uleb(r));   // 取 r + b（餘數符號與除數不同時）或 r
                        L(O.lget, ...uleb(r), O.lget, ...uleb(tb), O[p + 'xor']); if (w === 64) L(O.i64_const, 0, O.i64_lt_s); else L(O.i32_const, 0, O.i32_lt_s);
                        L(O.lget, ...uleb(r)); if (w === 64) L(O.i64_const, 0, O.i64_ne); else L(O.i32_const, 0, O.i32_ne); L(O.i32_and, O.select); return canon(w); }
                    case 'OpBitwiseAnd': V(a); V(b); return L(O[p + 'and']); case 'OpBitwiseOr': V(a); V(b); return L(O[p + 'or']); case 'OpBitwiseXor': V(a); V(b); return L(O[p + 'xor']);
                    case 'OpShiftLeftLogical': case 'OpShiftRightLogical': case 'OpShiftRightArithmetic': {
                        if (op === 'OpShiftRightLogical') Vu(a); else V(a);
                        V(b); const bw = vt(T1(b)); if (w === 64 && bw === I32) L(O.i64_extend_i32_u); else if (w !== 64 && bw === I64) L(O.i32_wrap_i64);
                        L(O[p + (op === 'OpShiftLeftLogical' ? 'shl' : op === 'OpShiftRightLogical' ? 'shr_u' : 'shr_s')]); return canon(w);
                    }
                }
                return null;
            };
            const cmpOps = { OpIEqual: ['eq', 0], OpINotEqual: ['ne', 0], OpSLessThan: ['lt_s', 0], OpSLessThanEqual: ['le_s', 0], OpSGreaterThan: ['gt_s', 0], OpSGreaterThanEqual: ['ge_s', 0], OpULessThan: ['lt_u', 1], OpULessThanEqual: ['le_u', 1], OpUGreaterThan: ['gt_u', 1], OpUGreaterThanEqual: ['ge_u', 1] };
            const fltCmp = (op, r, a, b) => {
                const p = r === F32 ? 'f32_' : 'f64_', ord = () => { V(a); V(a); L(O[p + 'eq']); V(b); V(b); L(O[p + 'eq'], O.i32_and); };
                const direct = { OpFOrdEqual: 'eq', OpFOrdLessThan: 'lt', OpFOrdGreaterThan: 'gt', OpFOrdLessThanEqual: 'le', OpFOrdGreaterThanEqual: 'ge', OpFUnordNotEqual: 'ne' };
                if (direct[op]) { V(a); V(b); return L(O[p + direct[op]]); }
                if (op === 'OpFOrdNotEqual') { V(a); V(b); L(O[p + 'ne']); ord(); return L(O.i32_and); }
                if (op === 'OpFUnordEqual') { V(a); V(b); L(O[p + 'eq']); ord(); L(O.i32_eqz, O.i32_or); return; }
                const inv = { OpFUnordLessThan: 'ge', OpFUnordGreaterThan: 'le', OpFUnordLessThanEqual: 'gt', OpFUnordGreaterThanEqual: 'lt' }[op];
                if (inv) { V(a); V(b); return L(O[p + inv], O.i32_eqz); }
                if (op === 'OpOrdered') return ord(); if (op === 'OpUnordered') { ord(); return L(O.i32_eqz); }
                return null;
            };
            const emit = (i) => {
                const w = i.w, op = i.op;
                switch (op) {
                    case 'OpLabel': case 'OpNop': case 'OpLoopMerge': case 'OpSelectionMerge': case 'OpLifetimeStart': case 'OpLifetimeStop': case 'OpPhi': return;
                    case 'OpVariable': { const v = i.v; resTy.set(v.id, v.ty); if (promoted.has(v.id)) { const pt = ty(ty(v.ty).pointee); if (v.init) V(v.init); else konst(pt.id, pt.k === 'bool' ? false : 0); L(O.lset, ...uleb(lv(v.id))); } else { L(O.lget, ...uleb(fb), O.i32_const, ...sleb(frameOff.get(v.id)), O.i32_add, O.lset, ...uleb(lv(v.id))); } return; }
                    case 'OpLoad': { const p = w[2]; if (builtinVars.has(p)) { const nm = builtinVars.get(p); if (nm === 'WorkDim') { L(O.gget, ...uleb(G_DIM)); return set(w[1]); } if (!BUILTIN_G[nm]) unsup('內建變數 ' + nm); virt.set(w[1], nm); return; } if (promoted.has(p)) { L(O.lget, ...uleb(lv(p))); return set(w[1]); } V(p); memLoad(w[0]); return set(w[1]); }
                    case 'OpStore': { const p = w[0]; if (promoted.has(p)) { V(w[1]); return L(O.lset, ...uleb(lv(p))); } V(p); V(w[1]); return memStore(ty(ty(T1(p)).pointee).id); }
                    case 'OpAccessChain': case 'OpInBoundsAccessChain': case 'OpPtrAccessChain': case 'OpInBoundsPtrAccessChain': chain(w[2], w.slice(3), op.includes('Ptr')); return set(w[1]);
                    case 'OpCopyObject': V(w[2]); return set(w[1]);
                    case 'OpBitcast': { const to = ty(w[0]), from = ty(T1(w[2])); V(w[2]); if (to.k === 'ptr' || (to.k === from.k && to.w === from.w)) return set(w[1]); const m = { float32int32: O.i32_reinterpret_f32, int32float32: O.f32_reinterpret_i32, float64int64: O.i64_reinterpret_f64, int64float64: O.f64_reinterpret_i64 }[from.k + from.w + to.k + to.w]; if (!m) unsup('OpBitcast ' + from.k + from.w + '→' + to.k + to.w); L(m); return set(w[1]); }
                    case 'OpSelect': { V(w[3]); V(w[4]); V(w[2]); L(O.select); return set(w[1]); }
                    case 'OpFunctionCall': { const callee = w[2]; if (!fIndex.has(callee)) unsup('呼叫了沒有本體的函式 ' + (M.names.get(callee) || callee)); for (const a of w.slice(3)) V(a); L(O.call, ...uleb(fIndex.get(callee))); return ty(w[0]).k === 'void' ? undefined : set(w[1]); }
                    case 'OpCompositeExtract': { const src = w[2]; if (!virt.has(src) || w.length !== 4) unsup('OpCompositeExtract（向量／聚合值）'); L(O.gget, ...uleb(GI[BUILTIN_G[virt.get(src)] + w[3]])); if (vt(w[0]) === I32) L(O.i32_wrap_i64); return set(w[1]); }
                    case 'OpVectorExtractDynamic': {
                        const src = w[2]; if (!virt.has(src)) unsup('向量值'); const nm = BUILTIN_G[virt.get(src)], idx = tmp(I32); toI32(w[3]); L(O.lset, ...uleb(idx));
                        L(O.gget, ...uleb(GI[nm + 2]), O.gget, ...uleb(GI[nm + 1]), O.gget, ...uleb(GI[nm + 0]), O.lget, ...uleb(idx), O.i32_const, 1, O.i32_eq, O.select, O.lget, ...uleb(idx), O.i32_const, 2, O.i32_eq, O.select);   // idx==2 ? g2 : (idx==1 ? g1 : g0)
                        if (vt(w[0]) === I32) L(O.i32_wrap_i64); return set(w[1]);
                    }
                    case 'OpExtInst': { if (M.exts.get(w[2]) !== 'OpenCL.std') unsup('擴充指令集 ' + M.exts.get(w[2])); extInst(w); return ty(w[0]).k === 'void' ? undefined : set(w[1]); }
                    case 'OpBranch': return goto(w[0]);
                    case 'OpBranchConditional': { V(w[0]); L(O.if, 0x40); depth++; goto(w[1]); L(O.else); goto(w[2]); depth--; L(O.end); return; }
                    case 'OpSwitch': { const selT = ty(T1(w[0])), lw = selT.w === 64 ? 2 : 1; for (let k = 2; k < w.length; k += lw + 1) { const lit = lw === 2 ? X.num64(w[k], w[k + 1], true) : (selT.w === 32 ? w[k] | 0 : w[k]); V(w[0]); if (selT.w === 64) L(O.i64_const, ...sleb(BigInt(lit)), O.i64_eq); else L(O.i32_const, ...sleb(lit), O.i32_eq); L(O.if, 0x40); depth++; goto(w[k + lw]); depth--; L(O.end); } return goto(w[1]); }
                    case 'OpReturn': epilogue(); return L(O.return);
                    case 'OpReturnValue': V(w[0]); epilogue(); return L(O.return);
                    case 'OpUnreachable': return L(O.unreachable);
                    case 'OpControlBarrier': return unsup('OpControlBarrier（工作群協作要執行緒；本環境沒有 SharedArrayBuffer，有 barrier 的核心走 JS）');
                    case 'OpMemoryBarrier': return;
                }
                if (op.startsWith('OpAtomic')) unsup('原子操作'); if (op.startsWith('OpImage') || op.includes('Sampled')) unsup('圖像'); if (op.includes('Pipe') || op.includes('Reserve')) unsup('pipe');
                const t = ty(w[0]);
                if (t.k === 'vec') unsup('向量運算 ' + op);
                if (op === 'OpLogicalNot') { V(w[2]); L(O.i32_eqz); return set(w[1]); }
                if (op === 'OpLogicalAnd' || op === 'OpLogicalOr' || op === 'OpLogicalEqual' || op === 'OpLogicalNotEqual') { V(w[2]); V(w[3]); L({ OpLogicalAnd: O.i32_and, OpLogicalOr: O.i32_or, OpLogicalEqual: O.i32_eq, OpLogicalNotEqual: O.i32_ne }[op]); return set(w[1]); }
                if (op === 'OpSNegate') { konst(w[0], 0); V(w[2]); L(O[(t.w === 64 ? 'i64_' : 'i32_') + 'sub']); canon(t.w); return set(w[1]); }
                if (op === 'OpNot') { V(w[2]); if (t.w === 64) L(O.i64_const, ...sleb(-1), O.i64_xor); else L(O.i32_const, ...sleb(-1), O.i32_xor); return set(w[1]); }
                if (op === 'OpFNegate') { V(w[2]); L(O[(t.w === 32 ? 'f32_' : 'f64_') + 'neg']); return set(w[1]); }
                if (op === 'OpIsNan' || op === 'OpIsInf' || op === 'OpIsFinite') { const at = ty(T1(w[2])), p = at.w === 32 ? 'f32_' : 'f64_'; V(w[2]); if (op === 'OpIsNan') { V(w[2]); L(O[p + 'ne']); } else { L(O[p + 'abs']); if (at.w === 32) L(O.f32_const, ...f32b(Infinity)); else L(O.f64_const, ...f64b(Infinity)); L(O[p + (op === 'OpIsInf' ? 'eq' : 'lt')]); } return set(w[1]); }
                if (op === 'OpFRem' || op === 'OpFMod') { callImp(op === 'OpFRem' ? 'fmod' : 'fmod2', vt(w[0]), [w[2], w[3]]); return set(w[1]); }
                if (op === 'OpPtrEqual' || op === 'OpPtrNotEqual') { V(w[2]); V(w[3]); L(op === 'OpPtrEqual' ? O.i32_eq : O.i32_ne); return set(w[1]); }
                // 轉換
                const cv = { OpSConvert: 1, OpUConvert: 1, OpFConvert: 1, OpConvertFToS: 1, OpConvertFToU: 1, OpConvertSToF: 1, OpConvertUToF: 1 }[op];
                if (cv) {
                    const to = ty(w[0]), from = ty(T1(w[2])), fw = from.w, tw = to.w;
                    if (op === 'OpSConvert') { V(w[2]); if (tw === 64 && fw !== 64) L(O.i64_extend_i32_s); else if (tw !== 64 && fw === 64) { L(O.i32_wrap_i64); canon(tw); } else if (tw !== 64) canon(tw); }
                    else if (op === 'OpUConvert') { if (fw < 32) { V(w[2]); mask(fw); } else V(w[2]); if (tw === 64 && fw !== 64) L(O.i64_extend_i32_u); else if (tw !== 64 && fw === 64) { L(O.i32_wrap_i64); canon(tw); } else if (tw !== 64) canon(tw); }
                    else if (op === 'OpFConvert') { V(w[2]); if (fw === 32 && tw === 64) L(O.f64_promote_f32); else if (fw === 64 && tw === 32) L(O.f32_demote_f64); }
                    else if (op === 'OpConvertSToF') { V(w[2]); L(O[(tw === 32 ? 'f32' : 'f64') + '_convert_' + (fw === 64 ? 'i64' : 'i32') + '_s']); }
                    else if (op === 'OpConvertUToF') { if (fw < 32) { V(w[2]); mask(fw); } else V(w[2]); L(O[(tw === 32 ? 'f32' : 'f64') + '_convert_' + (fw === 64 ? 'i64' : 'i32') + '_u']); }
                    else { V(w[2]); const key = (tw === 64 ? 'i64' : 'i32') + '_' + (fw === 32 ? 'f32' : 'f64') + '_' + (op === 'OpConvertFToS' ? 's' : 'u'); L(0xfc, TSAT[key]); if (tw < 32) canon(tw); }
                    return set(w[1]);
                }
                const a = w[2], b = w[3];
                if (cmpOps[op]) { const at = ty(T1(a)), [name, uns] = cmpOps[op]; if (at.k === 'ptr') unsup('指標比較'); const p = at.w === 64 ? 'i64_' : 'i32_'; if (uns) { Vu(a); Vu(b); } else { V(a); V(b); } L(O[p + name]); return set(w[1]); }
                const at = ty(T1(a));
                if (at.k === 'float') { if (['OpFAdd', 'OpFSub', 'OpFMul', 'OpFDiv'].includes(op)) { V(a); V(b); L(O[(at.w === 32 ? 'f32_' : 'f64_') + { OpFAdd: 'add', OpFSub: 'sub', OpFMul: 'mul', OpFDiv: 'div' }[op]]); return set(w[1]); } const r = fltCmp(op, vt(T1(a)), a, b); if (r !== null) return set(w[1]); }
                if (at.k === 'int') { const r = intBin(op, at, a, b); if (r !== null) return set(w[1]); }
                return unsup('SPIR-V 指令 ' + op);
            };
            // 輸出：單一區塊直接輸出；多個區塊用 loop＋br_table 狀態機
            if (frame) L(O.gget, ...uleb(G_SP), O.i32_const, ...sleb(frame), O.i32_sub, O.ltee, ...uleb(fb), O.gset, ...uleb(G_SP));
            if (single) { curBlock = f.blocks[0].id; depth = 0; for (const i of f.blocks[0].ins) emit(i); }
            else {
                L(O.loop, 0x40); for (let k = 0; k < N; k++) L(O.block, 0x40);
                L(O.lget, ...uleb(bLocal), O.br_table, ...uleb(N), ...flat(f.blocks.map((_, k) => uleb(k))), ...uleb(N - 1));
                f.blocks.forEach((b, k) => { L(O.end); curBlock = b.id; depth = N - 1 - k; for (const i of b.ins) emit(i); });
                L(O.end);
            }
            L(O.unreachable);   // 所有路徑都以 return／br 結束；這行只是讓有回傳值的函式通過型別檢查
            return { sig: sigIndex(paramVt, ret), body: bodyBytes(locals, code) };
        }

        // run_<核心>：工作項的六層迴圈在 wasm 裡，設好內建全域後呼叫核心
        function genRun(r) {
            const pv = r.paramVts, n = pv.length, code = [], locals = [], L = (...b) => { for (const x of b) code.push(x); }, nl = (t) => { locals.push(t); return n + 9 + 1 + locals.length - 1; };
            const P_DIM = n, P_GS = (d) => n + 1 + d, P_LS = (d) => n + 4 + d, P_OFF = (d) => n + 7 + d;
            const gx = [0, 1, 2].map(() => nl(I32)), lx = [0, 1, 2].map(() => nl(I32)), ng = [0, 1, 2].map(() => nl(I32));
            L(O.lget, ...uleb(P_DIM), O.gset, ...uleb(G_DIM));
            for (let d = 0; d < 3; d++) {
                L(O.lget, ...uleb(P_GS(d)), O.i64_extend_i32_u, O.gset, ...uleb(GI['gs' + d]), O.lget, ...uleb(P_LS(d)), O.i64_extend_i32_u, O.gset, ...uleb(GI['ls' + d]), O.lget, ...uleb(P_OFF(d)), O.i64_extend_i32_u, O.gset, ...uleb(GI['off' + d]));
                L(O.lget, ...uleb(P_GS(d)), O.lget, ...uleb(P_LS(d)), O.i32_div_u, O.ltee, ...uleb(ng[d]), O.i64_extend_i32_u, O.gset, ...uleb(GI['ng' + d]));
            }
            const loopOver = (v, lim, body) => { L(O.i32_const, 0, O.lset, ...uleb(v), O.block, 0x40, O.loop, 0x40, O.lget, ...uleb(v), ...lim, O.i32_ge_u, O.br_if, 1); body(); L(O.lget, ...uleb(v), O.i32_const, 1, O.i32_add, O.lset, ...uleb(v), O.br, 0, O.end, O.end); };
            const inner = () => {
                for (let d = 0; d < 3; d++) {
                    L(O.lget, ...uleb(gx[d]), O.i64_extend_i32_u, O.gset, ...uleb(GI['grp' + d]), O.lget, ...uleb(lx[d]), O.i64_extend_i32_u, O.gset, ...uleb(GI['l' + d]));
                    L(O.gget, ...uleb(GI['grp' + d]), O.gget, ...uleb(GI['ls' + d]), O.i64_mul, O.gget, ...uleb(GI['l' + d]), O.i64_add, O.gget, ...uleb(GI['off' + d]), O.i64_add, O.gset, ...uleb(GI['g' + d]));
                }
                L(O.i32_const, ...sleb(STACK_TOP), O.gset, ...uleb(G_SP)); for (let k = 0; k < n; k++) L(O.lget, ...uleb(k)); L(O.call, ...uleb(fIndex.get(r.fn)));
            };
            const lim = (idx) => [O.lget, ...uleb(idx)], limLS = (d) => [O.lget, ...uleb(P_LS(d))];
            loopOver(gx[2], lim(ng[2]), () => loopOver(gx[1], lim(ng[1]), () => loopOver(gx[0], lim(ng[0]), () => loopOver(lx[2], limLS(2), () => loopOver(lx[1], limLS(1), () => loopOver(lx[0], limLS(0), inner))))));
            return { sig: sigIndex([...pv, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32], null), body: bodyBytes(locals, code) };
        }
    }

    // ---------------------------------------------------------------- 執行期：匯入的數學函式、從產物建立可執行結果
    const round = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));
    const IMP = { acos: Math.acos, acosh: Math.acosh, asin: Math.asin, asinh: Math.asinh, atan: Math.atan, atanh: Math.atanh, cbrt: Math.cbrt, cos: Math.cos, cosh: Math.cosh, exp: Math.exp, expm1: Math.expm1, log: Math.log, log2: Math.log2, log10: Math.log10, log1p: Math.log1p, sin: Math.sin, sinh: Math.sinh, tan: Math.tan, tanh: Math.tanh,
        exp2: (x) => 2 ** x, exp10: (x) => 10 ** x, round, rsqrt: (x) => 1 / Math.sqrt(x), erf: (x) => SPV.internals.S.erf(x), erfc: (x) => 1 - SPV.internals.S.erf(x), tgamma: (x) => SPV.internals.S.tgamma(x), logb: (x) => Math.floor(Math.log2(Math.abs(x))), degrees: (x) => x * 180 / Math.PI, radians: (x) => x * Math.PI / 180, sign: (x) => (Number.isNaN(x) ? 0 : x > 0 ? 1 : x < 0 ? -1 : x),
        atan2: Math.atan2, hypot: Math.hypot, pow: Math.pow, powr: Math.pow, fmod: (a, b) => a % b, fmod2: (a, b) => { if (b === 0) return NaN; const r = a % b; return r !== 0 && (r < 0) !== (b < 0) ? r + b : r; }, remainder: (a, b) => a - b * Math.round(a / b), fdim: (a, b) => (a > b ? a - b : 0), step: (e, x) => (x < e ? 0 : 1),
        mix: (x, y, a) => x + (y - x) * a, smoothstep: (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); } };
    const bestDivisor = (n, cap) => { for (let d = Math.min(n, cap); d >= 1; d--) if (n % d === 0) return d; return 1; };
    function instantiate(art) {
        const bytes = art.wasm instanceof Uint8Array ? art.wasm : new Uint8Array(art.wasm), env = {};
        for (const im of art.imports) { const f = IMP[im.base]; if (!f) throw new Error('沒有匯入函式 ' + im.base); env[im.name] = f; }
        const build = (module) => {
            const inst = new WebAssembly.Instance(module, { env }), mem = inst.exports.mem, kernels = art.kernels;
            const run = (name, args, gs, ls, off) => {
                const k = kernels[name]; if (!k) throw new Error('沒有核心 ' + name); const runFn = inst.exports['run_' + name], dim = gs.length; if (dim < 1 || dim > 3) throw new Error('NDRange 維度要是 1–3');
                const G = [1, 1, 1], Lc = [1, 1, 1], Of = [0, 0, 0];
                for (let d = 0; d < dim; d++) { G[d] = gs[d]; Of[d] = (off && off[d]) || 0; Lc[d] = ls && ls[d] ? ls[d] : (d === 0 ? bestDivisor(G[0], 256) : 1); if (G[d] % Lc[d]) throw new Error('global size ' + G[d] + ' 不是 local size ' + Lc[d] + ' 的整數倍'); }
                // 緩衝區參數 → wasm 記憶體裡的位置（同一塊緩衝區傳兩次共用同一份；只要有一個參數可寫就要寫回）
                let cursor = DATA_BASE; const seen = new Map(), slots = [], slotOf = [];
                k.params.forEach((p, i) => { if (p.kind !== 'buf') return; const ptr = args[i], len = ptr.len != null ? ptr.len : (ptr.v.ab.byteLength - ptr.o), key = ptr.v.ab._wid || (ptr.v.ab._wid = ++widSeq), kk = key + ':' + ptr.o + ':' + len; let s = seen.get(kk); if (!s) { const addr = Math.ceil(cursor / 16) * 16; cursor = addr + len; s = { ptr, addr, len, write: false }; seen.set(kk, s); slots.push(s); } if (p.access !== 'in') s.write = true; slotOf[i] = s; });
                const need = cursor + 64, have = mem.buffer.byteLength; if (need > have) mem.grow(Math.ceil((need - have) / 65536));
                const M8 = new Uint8Array(mem.buffer); for (const s of slots) M8.set(new Uint8Array(s.ptr.v.ab, s.ptr.o, s.len), s.addr);
                const vals = k.params.map((p, i) => (p.kind === 'buf' ? slotOf[i].addr : k.wasmParams[i] === I64 ? BigInt(Math.trunc(Number(args[i]))) : Number(args[i])));
                runFn(...vals, dim, G[0], G[1], G[2], Lc[0], Lc[1], Lc[2], Of[0], Of[1], Of[2]);
                const M2 = new Uint8Array(mem.buffer); for (const s of slots) if (s.write) { new Uint8Array(s.ptr.v.ab, s.ptr.o, s.len).set(M2.subarray(s.addr, s.addr + s.len)); s.ptr.v.w = true; }
            };
            return { ok: true, kind: 'wasm', log: '', kernels, mkptr: (ab) => ({ v: { ab, w: false }, o: 0 }), run, art, wasmBytes: bytes.length };
        };
        try { return build(new WebAssembly.Module(bytes)); }
        catch (e) { if (e instanceof RangeError || /synchronous/i.test(String(e && e.message))) return WebAssembly.compile(bytes).then(build); throw e; }
    }
    let widSeq = 0;
    const toArtifact = (r) => ({ kind: 'wasm', wasm: r.wasm, kernels: r.kernels, imports: r.imports });
    return { compile, instantiate, toArtifact, VERSION };
});
