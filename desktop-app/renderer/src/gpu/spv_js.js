/* SPIR-V（OpenCL「Kernel」風格）→ JS（FaSpv，UMD，純邏輯）：clCreateProgramWithIL 的後端。
 *   const r = FaSpv.compile(il /* Uint8Array 或 ArrayBuffer *\/, { spec: { 規格常數編號: 位元組 } });
 *   r → { ok, log, kernels:{名:{params:[{name,kind,type,access,size}]}}, mkptr, run(name, args, gs, ls, off) }    —— 與 FaClc.compile 的回傳完全相同，所以載入器的驅動、runClc、
 *   工作群排程（__local＋barrier 的產生器、發散偵測）、圖像／pipe／原子的執行期全部共用 clc_js.js 的（FaClc.runtime／runKernel）。
 * 為什麼比 OpenCL C 快建置：沒有前處理、詞法、語法與型別檢查——二進位解碼、一次掃描建型別與常數、逐指令轉成 JS，最後 new Function。
 * 範圍（OpenCL 環境規格的子集；不支援的指令、擴充指令、能力會在建置時明確回報，不會默默錯算）：
 *   型別：void／bool／int（8／16／32／64）／float（32／64）／vector／array／struct／pointer（Function／Workgroup／CrossWorkgroup／UniformConstant）／image／sampler／pipe／reserve id。
 *   指令：整數與浮點算術、比較、轉換、位元操作、複合值（construct／extract／insert／shuffle）、Select、Phi、分支（含 switch）、函式呼叫、
 *         變數與載入／存放／複製、AccessChain／PtrAccessChain、原子操作、OpControlBarrier／OpMemoryBarrier、OpenCL.std 的常用數學／整數／幾何／vloadn／vstoren／shuffle、
 *         圖像讀寫與查詢、取樣器常數、pipe 的讀寫與保留、規格常數（OpSpecConstant*，可由 options.spec 覆寫）。
 *   內建變數：Global／Local／Workgroup 的 Id、Size、NumWorkgroups、GlobalOffset、WorkDim、LocalInvocationIndex。GlobalInvocationId 含 global offset（等同 OpenCL C 的 get_global_id）。
 * 不支援：Shader（Vulkan）風格的模組、GenericPointer（generic 位址空間）、群組操作（work_group_reduce 等）、device enqueue、half、printf、指標存進記憶體。
 * 數值：int 一律是「有號正規形」的 JS 數字（8／16／32 位元精確；64 位元精確到 2^53，與 clc 相同）；float 逐步 Math.fround；向量與聚合值是 JS 陣列。
 * 控制流：函式有多個基本區塊時用「switch 狀態機」（phi 在分支邊上賦值），不還原結構化迴圈。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./spv_tables.js'), require('./clc_js.js'));
    else root.FaSpv = factory(root.FaSpvTables, root.FaClc);
})(typeof self !== 'undefined' ? self : this, function (T, CLC) {
    'use strict';
    class SpvError extends Error { constructor(m) { super(m); this.name = 'SpvError'; } }
    const fail = (m) => { throw new SpvError(m); };
    const OPN = {}; for (const k of Object.keys(T.ops)) OPN[T.ops[k][0]] = k;
    const OCLN = {}; for (const k of Object.keys(T.oclOps)) OCLN[T.oclOps[k][0]] = k;
    const EN = (kind, v) => { const e = T.enums[kind]; for (const k of Object.keys(e)) { const x = Array.isArray(e[k]) ? e[k][0] : e[k]; if (x === v && k !== '__bit') return k; } return String(v); };
    const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), f64 = new Float64Array(1), u32x2 = new Uint32Array(f64.buffer);

    // ---------------------------------------------------------------- 1. 解碼
    function decode(input) {
        const u8 = input instanceof Uint8Array ? input : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength);
        if (u8.length < 20 || u8.length % 4) fail('不是 SPIR-V：長度要是 4 的倍數且至少 20 位元組（得到 ' + u8.length + '）');
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let le = true;
        if (dv.getUint32(0, true) !== T.magic) { if (dv.getUint32(0, false) === T.magic) le = false; else fail('不是 SPIR-V：magic number 不對'); }
        const w = (i) => dv.getUint32(i * 4, le), n = u8.length / 4, version = w(1), bound = w(3), insts = [];
        for (let i = 5; i < n;) {
            const first = w(i), wc = first >>> 16, op = first & 0xFFFF;
            if (wc === 0 || i + wc > n) fail('指令長度錯誤（字 ' + i + '，wordcount ' + wc + '）');
            const ws = []; for (let k = 1; k < wc; k++) ws.push(w(i + k)); insts.push({ op, name: OPN[op] || ('Op#' + op), w: ws }); i += wc;
        }
        return { version, bound, insts };
    }
    const strOf = (ws, from) => { const b = []; for (let i = from; i < ws.length; i++) for (let k = 0; k < 4; k++) { const c = (ws[i] >>> (8 * k)) & 255; if (!c) return { s: new TextDecoder().decode(Uint8Array.from(b)), next: i + 1 }; b.push(c); } return { s: new TextDecoder().decode(Uint8Array.from(b)), next: ws.length }; };
    const num64 = (lo, hi, signed) => { const b = (BigInt(hi) << 32n) | BigInt(lo); return Number(signed ? BigInt.asIntN(64, b) : BigInt.asUintN(64, b)); };

    // ---------------------------------------------------------------- 2. 模組分析
    function analyze(dec, opts) {
        const M = { types: new Map(), consts: new Map(), globals: [], funcs: new Map(), funcOrder: [], entries: [], names: new Map(), mnames: new Map(), deco: new Map(), mdeco: new Map(), exts: new Map(), caps: new Set(), spec: opts.spec || {}, entryModes: [] };
        let cur = null, curBlock = null;
        const T0 = (id) => M.types.get(id);
        for (const ins of dec.insts) {
            const w = ins.w, nm = ins.name;
            switch (nm) {
                case 'OpCapability': M.caps.add(EN('Capability', w[0])); break;
                case 'OpExtInstImport': M.exts.set(w[0], strOf(w, 1).s); break;
                case 'OpMemoryModel': M.addressing = EN('AddressingModel', w[0]); M.memModel = EN('MemoryModel', w[1]); break;
                case 'OpEntryPoint': { const s = strOf(w, 2); M.entries.push({ model: EN('ExecutionModel', w[0]), fn: w[1], name: s.s }); break; }
                case 'OpExecutionMode': M.entryModes.push({ fn: w[0], mode: EN('ExecutionMode', w[1]), args: w.slice(2) }); break;
                case 'OpName': M.names.set(w[0], strOf(w, 1).s); break;
                case 'OpMemberName': M.mnames.set(w[0] + ':' + w[1], strOf(w, 2).s); break;
                case 'OpDecorate': { const d = M.deco.get(w[0]) || []; d.push({ k: EN('Decoration', w[1]), a: w.slice(2) }); M.deco.set(w[0], d); break; }
                case 'OpMemberDecorate': { const key = w[0] + ':' + w[1]; const d = M.mdeco.get(key) || []; d.push({ k: EN('Decoration', w[2]), a: w.slice(3) }); M.mdeco.set(key, d); break; }
                case 'OpTypeVoid': M.types.set(w[0], { id: w[0], k: 'void' }); break;
                case 'OpTypeBool': M.types.set(w[0], { id: w[0], k: 'bool' }); break;
                case 'OpTypeInt': M.types.set(w[0], { id: w[0], k: 'int', w: w[1], signed: w[2] }); break;
                case 'OpTypeFloat': M.types.set(w[0], { id: w[0], k: 'float', w: w[1] }); break;
                case 'OpTypeVector': M.types.set(w[0], { id: w[0], k: 'vec', elem: w[1], n: w[2] }); break;
                case 'OpTypeArray': M.types.set(w[0], { id: w[0], k: 'arr', elem: w[1], lenId: w[2] }); break;
                case 'OpTypeRuntimeArray': M.types.set(w[0], { id: w[0], k: 'arr', elem: w[1], lenId: 0 }); break;
                case 'OpTypeStruct': M.types.set(w[0], { id: w[0], k: 'struct', members: w.slice(1) }); break;
                case 'OpTypePointer': M.types.set(w[0], { id: w[0], k: 'ptr', sc: EN('StorageClass', w[1]), pointee: w[2] }); break;
                case 'OpTypeFunction': M.types.set(w[0], { id: w[0], k: 'fn', ret: w[1], params: w.slice(2) }); break;
                case 'OpTypeImage': M.types.set(w[0], { id: w[0], k: 'image', sampled: w[1], dim: EN('Dim', w[2]), arrayed: w[4], access: w.length > 8 ? EN('AccessQualifier', w[8]) : 'ReadOnly' }); break;
                case 'OpTypeSampler': M.types.set(w[0], { id: w[0], k: 'sampler' }); break;
                case 'OpTypeSampledImage': M.types.set(w[0], { id: w[0], k: 'simg', image: w[1] }); break;
                case 'OpTypePipe': M.types.set(w[0], { id: w[0], k: 'pipe', access: EN('AccessQualifier', w[1]) }); break;
                case 'OpTypeReserveId': M.types.set(w[0], { id: w[0], k: 'reserve' }); break;
                case 'OpTypeEvent': case 'OpTypeOpaque': case 'OpTypeQueue': case 'OpTypeDeviceEvent': M.types.set(w[0], { id: w[0], k: 'opaque', what: nm }); break;
                case 'OpConstantTrue': M.consts.set(w[1], { ty: w[0], op: 'bool', v: true }); break;
                case 'OpConstantFalse': M.consts.set(w[1], { ty: w[0], op: 'bool', v: false }); break;
                case 'OpConstant': M.consts.set(w[1], { ty: w[0], op: 'num', words: w.slice(2) }); break;
                case 'OpConstantComposite': M.consts.set(w[1], { ty: w[0], op: 'comp', ids: w.slice(2) }); break;
                case 'OpConstantNull': case 'OpUndef': M.consts.set(w[1], { ty: w[0], op: 'null' }); break;
                case 'OpConstantSampler': M.consts.set(w[1], { ty: w[0], op: 'sampler', addr: EN('SamplerAddressingMode', w[2]), norm: w[3], filter: EN('SamplerFilterMode', w[4]) }); break;
                case 'OpSpecConstantTrue': M.consts.set(w[1], { ty: w[0], op: 'bool', v: true, spec: true }); break;
                case 'OpSpecConstantFalse': M.consts.set(w[1], { ty: w[0], op: 'bool', v: false, spec: true }); break;
                case 'OpSpecConstant': M.consts.set(w[1], { ty: w[0], op: 'num', words: w.slice(2), spec: true }); break;
                case 'OpSpecConstantComposite': M.consts.set(w[1], { ty: w[0], op: 'comp', ids: w.slice(2), spec: true }); break;
                case 'OpSpecConstantOp': M.consts.set(w[1], { ty: w[0], op: 'specop', opcode: w[2], ids: w.slice(3) }); break;
                case 'OpFunction': cur = { id: w[1], retTy: w[0], fnTy: w[3], params: [], blocks: [], paramAttrs: new Map() }; M.funcs.set(w[1], cur); M.funcOrder.push(w[1]); break;
                case 'OpFunctionParameter': cur.params.push({ id: w[1], ty: w[0] }); break;
                case 'OpFunctionEnd': cur = null; curBlock = null; break;
                case 'OpLabel': curBlock = { id: w[0], ins: [] }; cur.blocks.push(curBlock); break;
                case 'OpVariable': {
                    const v = { id: w[1], ty: w[0], sc: EN('StorageClass', w[2]), init: w.length > 3 ? w[3] : 0 };
                    if (cur) { if (!curBlock) fail('OpVariable 在基本區塊之外'); curBlock.ins.push(Object.assign({ op: nm }, { w, v })); } else M.globals.push(v); break;
                }
                case 'OpNop': case 'OpSource': case 'OpSourceExtension': case 'OpSourceContinued': case 'OpString': case 'OpLine': case 'OpNoLine': case 'OpModuleProcessed': case 'OpExtension': case 'OpGroupDecorate': case 'OpGroupMemberDecorate': case 'OpDecorationGroup': case 'OpDecorateId': break;
                default:
                    if (!cur) fail('函式之外的指令 ' + nm + ' 不支援'); if (!curBlock) fail('指令 ' + nm + ' 在基本區塊之外');
                    curBlock.ins.push({ op: nm, w });
            }
        }
        void T0; return M;
    }

    // ---------------------------------------------------------------- 3. 型別、佈局、常數
    function makeTypes(M) {
        const ty = (id) => { const t = M.types.get(id); if (!t) fail('找不到型別 id ' + id); return t; };
        const memo = new Map();
        const layout = (id) => {   // → { size, align, offs? }（自然對齊的 C 佈局；結構成員有 Offset 裝飾就用它）
            if (memo.has(id)) return memo.get(id); const t = ty(id); let r;
            switch (t.k) {
                case 'bool': r = { size: 1, align: 1 }; break;
                case 'int': case 'float': r = { size: t.w / 8, align: t.w / 8 }; break;
                case 'vec': { const e = layout(t.elem); const n = t.n === 3 ? 4 : t.n; r = { size: e.size * n, align: e.size * n }; break; }
                case 'arr': { const e = layout(t.elem), stride = Math.ceil(e.size / e.align) * e.align, len = t.lenId ? constNum(M, t.lenId) : 0; r = { size: stride * len, align: e.align, stride, len }; break; }
                case 'struct': {
                    let off = 0, al = 1; const offs = [];
                    t.members.forEach((m, i) => { const l = layout(m), d = (M.mdeco.get(id + ':' + i) || []).find((x) => x.k === 'Offset'); const o = d ? d.a[0] : Math.ceil(off / l.align) * l.align; offs.push(o); off = o + l.size; al = Math.max(al, l.align); });
                    r = { size: Math.ceil(off / al) * al, align: al, offs }; break;
                }
                case 'ptr': r = { size: 8, align: 8 }; break;
                default: r = { size: 0, align: 1 };
            }
            memo.set(id, r); return r;
        };
        return { ty, layout };
    }
    function constNum(M, id) { const c = M.consts.get(id); if (!c || c.op !== 'num') fail('陣列長度要是常數整數（id ' + id + '）'); return c.words.length > 1 ? num64(c.words[0], c.words[1], false) : c.words[0]; }
    function zeroLit(M, TY, id) {
        const t = TY.ty(id);
        switch (t.k) {
            case 'bool': return false; case 'int': case 'float': return 0;
            case 'vec': return new Array(t.n).fill(0); case 'arr': return Array.from({ length: constNum(M, t.lenId) }, () => zeroLit(M, TY, t.elem));
            case 'struct': return t.members.map((m) => zeroLit(M, TY, m));
            default: return null;
        }
    }
    function samplerBits(c) { const A = { None: 0, ClampToEdge: 2, Clamp: 4, Repeat: 6, RepeatMirrored: 8 }[c.addr] || 0, F = { Nearest: 16, Linear: 32 }[c.filter] || 16; return (c.norm ? 1 : 0) | A | F; }
    function constValue(M, TY, id, seen) {
        const c = M.consts.get(id); if (!c) fail('找不到常數 id ' + id); const t = TY.ty(c.ty); let spec = null;
        if (c.spec) { const d = (M.deco.get(id) || []).find((x) => x.k === 'SpecId'); if (d && M.spec[d.a[0]] !== undefined) spec = M.spec[d.a[0]]; }
        switch (c.op) {
            case 'bool': return spec ? !!spec[0] : c.v;
            case 'null': return zeroLit(M, TY, c.ty);
            case 'sampler': return samplerBits(c);
            case 'num': {
                let words = c.words; if (spec) { const b = Uint8Array.from(spec), dvs = new DataView(b.buffer); words = [dvs.getUint32(0, true)]; if (t.w === 64) words.push(b.length >= 8 ? dvs.getUint32(4, true) : 0); if (b.length < t.w / 8 && t.w >= 32) fail('規格常數 ' + id + ' 的資料太短'); else if (t.w < 32) words = [b.length >= 4 ? dvs.getUint32(0, true) : b[0] | ((b[1] || 0) << 8)]; }
                if (t.k === 'float') { if (t.w === 32) { u32[0] = words[0]; return f32[0]; } if (t.w === 64) { u32x2[0] = words[0]; u32x2[1] = words[1]; return f64[0]; } fail('不支援 ' + t.w + ' 位元浮點常數（half 沒有實作）'); }
                if (t.w === 64) return num64(words[0], words[1], true); if (t.w === 32) return words[0] | 0; if (t.w === 16) return (words[0] << 16) >> 16; if (t.w === 8) return (words[0] << 24) >> 24; fail('不支援 ' + t.w + ' 位元整數常數');
            }
            case 'comp': return c.ids.map((x) => constValue(M, TY, x, seen));
            case 'specop': fail('OpSpecConstantOp 沒有實作（規格常數的運算）');
        }
        fail('常數 id ' + id + ' 種類不明');
    }
    const lit = (v) => (Array.isArray(v) ? '[' + v.map(lit).join(',') + ']' : typeof v === 'boolean' ? String(v) : Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : Object.is(v, -0) ? '-0' : v === null ? 'null' : String(v));

    // ---------------------------------------------------------------- 4. 執行期輔助（生成的程式用 $S）
    const BIG = 2 ** 64;
    const S = {
        u64: (x) => (x < 0 ? x + BIG : x), s64: (x) => (x >= BIG / 2 ? x - BIG : x),
        sdiv: (w, a, b) => (b === 0 ? 0 : w === 64 ? Math.trunc(a / b) : wrapW(w, Math.trunc(a / b))), srem: (w, a, b) => (b === 0 ? 0 : wrapW(w, a % b)),
        smod: (w, a, b) => { if (b === 0) return 0; const r = a % b; return wrapW(w, r !== 0 && (r < 0) !== (b < 0) ? r + b : r); },
        udiv: (w, a, b) => { const x = unW(w, a), y = unW(w, b); return y === 0 ? 0 : fromUn(w, Math.floor(x / y)); }, umod: (w, a, b) => { const x = unW(w, a), y = unW(w, b); return y === 0 ? 0 : fromUn(w, x % y); },
        bit64: (a, b, op) => { const x = BigInt(a), y = BigInt(b); return Number(BigInt.asIntN(64, op === '&' ? x & y : op === '|' ? x | y : x ^ y)); },
        shl64: (a, b) => Number(BigInt.asIntN(64, BigInt(a) << BigInt(Math.trunc(b) & 63))), shr64: (a, b, logical) => Number(logical ? BigInt.asIntN(64, BigInt.asUintN(64, BigInt(a)) >> BigInt(Math.trunc(b) & 63)) : BigInt(a) >> BigInt(Math.trunc(b) & 63)),
        f2s: (w, x) => (Number.isNaN(x) ? 0 : wrapW(w, Math.trunc(x))), f2u: (w, x) => (Number.isNaN(x) ? 0 : fromUn(w, Math.max(0, Math.trunc(x)))),
        i2f32: (x) => { u32[0] = x; return f32[0]; }, f322i: (x) => { f32[0] = x; return u32[0] | 0; },
        i2f64: (x) => { const b = BigInt.asUintN(64, BigInt(x)); u32x2[0] = Number(b & 0xFFFFFFFFn); u32x2[1] = Number(b >> 32n); return f64[0]; }, f642i: (x) => { f64[0] = x; return num64(u32x2[0], u32x2[1], true); },
        shuf: (a, b, c) => { const all = a.concat(b); return c.map((i) => (i === 0xFFFFFFFF ? 0 : all[i])); }, flat: (xs) => [].concat(...xs),
        ins: (comp, path, obj) => { if (!path.length) return obj; const c = comp.slice(); c[path[0]] = S.ins(comp[path[0]], path.slice(1), obj); return c; },
        dot: (a, b, f) => { let s = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; if (f) s = Math.fround(s); } return s; },
        arrLoad: (p, n, stride, f) => { const r = new Array(n); for (let i = 0; i < n; i++) r[i] = f({ v: p.v, o: p.o + i * stride }); return r; },
        arrStore: (p, n, stride, val, f) => { for (let i = 0; i < n; i++) f({ v: p.v, o: p.o + i * stride }, val[i]); },
        popcount: (w, x) => { let v = unW(w, x), c = 0; if (w === 64) { let b = BigInt.asUintN(64, BigInt(x)); while (b) { c += Number(b & 1n); b >>= 1n; } return c; } while (v) { c += v & 1; v >>>= 1; } return c; },
        clz: (w, x) => { if (w === 64) { let b = BigInt.asUintN(64, BigInt(x)), n = 0; for (let i = 63; i >= 0 && !((b >> BigInt(i)) & 1n); i--) n++; return n; } const v = unW(w, x); return v === 0 ? w : w - 1 - Math.floor(Math.log2(v)); },
        ctz: (w, x) => { let v = unW(w, x); if (v === 0) return w; let n = 0; while (!(v % 2)) { v = Math.floor(v / 2); n++; } return n; },
        rotl: (w, x, k) => { const m = w; k = ((k % m) + m) % m; if (w === 32) return ((x << k) | (x >>> (32 - k))) | 0; const v = BigInt.asUintN(w, BigInt(x)); return fromUn(w, Number(BigInt.asUintN(w, (v << BigInt(k)) | (v >> BigInt(w - k))))); },
        mulhi: (w, a, b, sg) => { const x = sg ? BigInt(a) : BigInt.asUintN(w, BigInt(a)), y = sg ? BigInt(b) : BigInt.asUintN(w, BigInt(b)), r = (x * y) >> BigInt(w); return sg ? Number(BigInt.asIntN(w, r)) : fromUn(w, Number(BigInt.asUintN(w, r))); },
        sat: (w, v, sg) => { const lo = sg ? -(2 ** (w - 1)) : 0, hi = sg ? 2 ** (w - 1) - 1 : 2 ** w - 1; return v < lo ? lo : v > hi ? hi : v; },
        fmax: (a, b) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b)), fmin: (a, b) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.min(a, b)),
        sign: (x) => (Number.isNaN(x) ? 0 : x > 0 ? 1 : x < 0 ? -1 : x), smooth: (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); },
        nextafter: (a, b, f) => { if (Number.isNaN(a) || Number.isNaN(b)) return NaN; if (a === b) return b; if (f) { if (a === 0) return b > 0 ? 1.401298464324817e-45 : -1.401298464324817e-45; f32[0] = a; let u = u32[0]; u = (a < b) === (a > 0) ? u + 1 : u - 1; u32[0] = u >>> 0; return f32[0]; } f64[0] = a; if (a === 0) return b > 0 ? 5e-324 : -5e-324; const big = (BigInt(u32x2[1]) << 32n) | BigInt(u32x2[0]); const n = (a < b) === (a > 0) ? big + 1n : big - 1n; u32x2[0] = Number(n & 0xFFFFFFFFn); u32x2[1] = Number(n >> 32n); return f64[0]; },
        tgamma: (x) => { if (x === Math.floor(x) && x > 0 && x < 171) { let r = 1; for (let i = 2; i < x; i++) r *= i; return r; } const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]; if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * S.tgamma(1 - x)); x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < g + 2; i++) a += c[i] / (x + i); return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a; },
        erfc: (x) => 1 - S.erf(x), logb: (x) => Math.floor(Math.log2(Math.abs(x))),
        erf: (x) => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; },
    };
    function wrapW(w, x) { return w === 32 ? x | 0 : w === 16 ? (x << 16) >> 16 : w === 8 ? (x << 24) >> 24 : x; }
    function unW(w, x) { return w === 32 ? x >>> 0 : w === 16 ? x & 65535 : w === 8 ? x & 255 : (x < 0 ? x + BIG : x); }
    function fromUn(w, x) { return w === 32 ? x | 0 : w === 16 ? (x << 16) >> 16 : w === 8 ? (x << 24) >> 24 : (x >= BIG / 2 ? x - BIG : x); }

    // ---------------------------------------------------------------- 5. 轉成 JS
    const VIEW = (t) => (t.k === 'float' ? (t.w === 32 ? 'f32' : 'f64') : 'i' + t.w);
    const SCAL_NAME = (t) => (t.k === 'float' ? (t.w === 32 ? 'float' : 'double') : t.k === 'bool' ? 'int' : { 8: 'char', 16: 'short', 32: 'int', 64: 'long' }[t.w]);
    const BUILTIN = { NumWorkgroups: () => '[$W.ng[0],$W.ng[1],$W.ng[2]]', WorkgroupSize: () => '[$W.ls[0],$W.ls[1],$W.ls[2]]', WorkgroupId: () => '[$W.grp[0],$W.grp[1],$W.grp[2]]', LocalInvocationId: () => '[$W.l[0],$W.l[1],$W.l[2]]',
        GlobalInvocationId: () => '[$W.g[0],$W.g[1],$W.g[2]]', LocalInvocationIndex: () => '($W.l[0]+$W.l[1]*$W.ls[0]+$W.l[2]*$W.ls[0]*$W.ls[1])', WorkDim: () => '$W.dim', GlobalSize: () => '[$W.gs[0],$W.gs[1],$W.gs[2]]',
        EnqueuedWorkgroupSize: () => '[$W.ls[0],$W.ls[1],$W.ls[2]]', GlobalOffset: () => '[$W.off[0],$W.off[1],$W.off[2]]', GlobalLinearId: () => '(($W.g[2]-$W.off[2])*$W.gs[1]*$W.gs[0]+($W.g[1]-$W.off[1])*$W.gs[0]+($W.g[0]-$W.off[0]))',
        SubgroupSize: () => '1', SubgroupMaxSize: () => '1', NumSubgroups: () => '1', SubgroupId: () => '0', SubgroupLocalInvocationId: () => '0' };

    function compileModule(M, opts) {
        const TY = makeTypes(M), { ty, layout } = TY, errors = [];
        const unsupported = (what) => fail(what + ' 尚未支援');
        if (M.caps.has('Shader') || M.caps.has('Matrix')) fail('這是 Shader（Vulkan／GLSL 風格）的 SPIR-V；OpenCL 的 SPIR-V 要用 Kernel 能力（clang＋llvm-spirv 產生）');
        if (!M.caps.has('Kernel')) fail('缺少 Kernel 能力：不是 OpenCL 的 SPIR-V');
        if (M.memModel && M.memModel !== 'OpenCL') fail('記憶體模型是 ' + M.memModel + '，要 OpenCL');
        // 常數
        const constLines = []; const constIds = new Set(M.consts.keys());
        for (const id of M.consts.keys()) { try { constLines.push('const K' + id + '=' + lit(constValue(M, TY, id)) + ';'); } catch (e) { if (!(e instanceof SpvError)) throw e; errors.push(e.message); constLines.push('const K' + id + '=null;'); } }
        // 全域變數
        const gvars = new Map(); const gLines = []; const builtinVars = new Map();
        for (const g of M.globals) {
            const pt = ty(ty(g.ty).pointee); const d = M.deco.get(g.id) || []; const bi = d.find((x) => x.k === 'BuiltIn');
            if (g.sc === 'Input' && bi) { builtinVars.set(g.id, EN('BuiltIn', bi.a[0])); continue; }
            if (g.sc === 'Workgroup') { gvars.set(g.id, { sc: 'Workgroup', size: layout(pt.id).size }); continue; }
            if (g.sc === 'UniformConstant' || g.sc === 'CrossWorkgroup') {
                if (pt.k === 'sampler' || pt.k === 'image' || pt.k === 'pipe') { errors.push('全域的 ' + pt.k + ' 變數不支援（用核心參數或 OpConstantSampler）'); continue; }
                const sz = Math.max(8, layout(pt.id).size); gvars.set(g.id, { sc: g.sc }); gLines.push('const G' + g.id + '=$rt.alloc(' + sz + ');');
                if (g.init) { gLines.push('{' + storeCode(pt.id, 'G' + g.id, 'K' + g.init, 'gi') + '}'); } continue;
            }
            errors.push('全域變數的儲存類別 ' + g.sc + ' 不支援');
        }
        // 型別化的載入／存放（回傳表達式／敘述字串）
        function ld(tid, p) {
            const t = ty(tid);
            switch (t.k) {
                case 'bool': return '($rt.ld_u8(' + p + ',0)!==0)';
                case 'int': return '$rt.ld_i' + t.w + '(' + p + ',0)';
                case 'float': return '$rt.ld_f' + t.w + '(' + p + ',0)';
                case 'vec': { const e = ty(t.elem); if (e.k === 'bool') unsupported('bool 向量的記憶體載入'); return '$rt.vld(' + p + ',0,' + JSON.stringify(VIEW(e)) + ',' + t.n + ')'; }
                case 'arr': { const l = layout(tid); return '$S.arrLoad(' + p + ',' + l.len + ',' + l.stride + ',(q)=>' + ld(t.elem, 'q') + ')'; }
                case 'struct': { const l = layout(tid); return '[' + t.members.map((m, i) => ld(m, l.offs[i] ? '$rt.padd(' + p + ',' + l.offs[i] + ',1)' : p)).join(',') + ']'; }
                default: unsupported('載入型別 ' + t.k);
            }
        }
        let tmpN = 0;
        function storeCode(tid, p, val, tag) {
            const t = ty(tid);
            switch (t.k) {
                case 'bool': return '$rt.st_u8(' + p + ',0,(' + val + ')?1:0);';
                case 'int': return '$rt.st_i' + t.w + '(' + p + ',0,' + val + ');';
                case 'float': return '$rt.st_f' + t.w + '(' + p + ',0,' + val + ');';
                case 'vec': { const e = ty(t.elem); if (e.k === 'bool') unsupported('bool 向量的記憶體存放'); return '$rt.vst(' + p + ',0,' + JSON.stringify(VIEW(e)) + ',' + t.n + ',' + val + ');'; }
                case 'arr': { const l = layout(tid); return '$S.arrStore(' + p + ',' + l.len + ',' + l.stride + ',' + val + ',(q,x)=>{' + storeCode(t.elem, 'q', 'x', tag) + '});'; }
                case 'struct': { const l = layout(tid), a = '$a' + (tag || '') + (++tmpN); return '{const ' + a + '=' + val + ';' + t.members.map((m, i) => storeCode(m, l.offs[i] ? '$rt.padd(' + p + ',' + l.offs[i] + ',1)' : p, a + '[' + i + ']', tag)).join('') + '}'; }
                default: unsupported('存放型別 ' + t.k);
            }
        }
        const hasBarrier = [...M.funcs.values()].some((f) => f.blocks.some((b) => b.ins.some((i) => i.op === 'OpControlBarrier')));
        const funcLines = [];
        for (const fid of M.funcOrder) {
            if (!M.funcs.get(fid).blocks.length) continue;   // 只有宣告（Import 的 linkage）：被呼叫時才報錯
            try { funcLines.push(genFunction(M.funcs.get(fid))); } catch (e) { if (!(e instanceof SpvError)) throw e; errors.push((M.names.get(fid) || 'id ' + fid) + '：' + e.message); }
        }
        // 核心與參數描述
        const kernels = {}, exportsLine = [];
        for (const en of M.entries) {
            if (en.model !== 'Kernel') { errors.push('入口點 ' + en.name + ' 的執行模型是 ' + en.model + '（要 Kernel）'); continue; }
            const f = M.funcs.get(en.fn); if (!f) { errors.push('入口點 ' + en.name + ' 沒有函式'); continue; }
            try { kernels[en.name] = { params: kernelParams(f) }; exportsLine.push(JSON.stringify(en.name) + ':f' + en.fn); } catch (e) { if (!(e instanceof SpvError)) throw e; errors.push('核心 ' + en.name + '：' + e.message); }
        }
        if (errors.length) return { errors };
        return { code: constLines.join('') + gLines.join('') + funcLines.join('\n') + '\nreturn {' + exportsLine.join(',') + '};', kernels, gen: hasBarrier };

        function kernelParams(f) {
            const decAttrs = (id) => (M.deco.get(id) || []).filter((d) => d.k === 'FuncParamAttr').map((d) => EN('FunctionParameterAttribute', d.a[0]));
            return f.params.map((p, i) => {
                const t = ty(p.ty), name = M.names.get(p.id) || 'arg' + i, attrs = decAttrs(p.id);
                if (t.k === 'ptr') {
                    const pt = ty(t.pointee);
                    if (t.sc === 'CrossWorkgroup' || t.sc === 'UniformConstant') {
                        const et = pt.k === 'struct' || pt.k === 'arr' ? 'struct' : pt.k === 'vec' ? SCAL_NAME(ty(pt.elem)) + pt.n : pt.k === 'void' || pt.k === 'opaque' ? 'char' : SCAL_NAME(pt);
                        return { name, kind: 'buf', type: et, access: attrs.includes('NoWrite') || t.sc === 'UniformConstant' ? 'in' : 'rw' };
                    }
                    if (t.sc === 'Workgroup') return { name, kind: 'local', type: pt.k === 'vec' ? SCAL_NAME(ty(pt.elem)) + pt.n : pt.k === 'struct' ? 'struct' : SCAL_NAME(pt) };
                    if (t.sc === 'Function' && attrs.includes('ByVal')) return { name, kind: 'scalar', type: 'struct', size: layout(pt.id).size };
                    fail('參數 ' + name + '：指標的儲存類別 ' + t.sc + ' 不支援');
                }
                if (t.k === 'image') { const dimN = { '1D': '1d', '2D': '2d', '3D': '3d', Buffer: '1d_buffer' }[t.dim]; if (!dimN) fail('圖像的 Dim ' + t.dim + ' 不支援'); const base = 'image' + (t.dim === 'Buffer' ? '1d_buffer' : dimN + (t.arrayed ? '_array' : '')); return { name, kind: 'image', type: base, access: { ReadOnly: 'in', WriteOnly: 'out', ReadWrite: 'rw' }[t.access] || 'in' }; }
                if (t.k === 'sampler') return { name, kind: 'scalar', type: 'uint' };
                if (t.k === 'pipe') return { name, kind: 'pipe', type: 'char', access: 'rw' };
                if (t.k === 'vec') return { name, kind: 'scalar', type: SCAL_NAME(ty(t.elem)) + t.n };
                if (t.k === 'int' || t.k === 'float' || t.k === 'bool') return { name, kind: 'scalar', type: SCAL_NAME(t) };
                fail('參數 ' + name + '：型別 ' + t.k + ' 不支援');
            });
        }

        // ---- 函式
        function genFunction(f) {
            const lines = [], decl = new Set(), usedWG = new Set(), L = (s) => lines.push(s);
            const resTy = new Map();   // 結果 id → 型別 id
            for (const p of f.params) resTy.set(p.id, p.ty);
            // 變數提升：Function 的標量／向量變數若只被 OpLoad／OpStore（當位址）用到，就當成 JS 區域變數
            const varUses = new Map(), promoted = new Set(), allIns = []; for (const b of f.blocks) for (const i of b.ins) allIns.push(i);
            const loadStoreOnly = (i, vid) => (i.op === 'OpLoad' && i.w[2] === vid) || (i.op === 'OpStore' && i.w[0] === vid && i.w[1] !== vid);
            for (const i of allIns) if (i.op === 'OpVariable' && i.v.sc === 'Function') { const pt = ty(ty(i.v.ty).pointee); if (['bool', 'int', 'float'].includes(pt.k) || (pt.k === 'vec')) varUses.set(i.v.id, true); }
            for (const i of allIns) { if (i.op === 'OpVariable') continue; const w = i.w; for (const vid of varUses.keys()) { if (varUses.get(vid) === false) continue; if (!w.includes(vid)) continue; if (loadStoreOnly(i, vid)) continue; if (['OpName', 'OpDecorate'].includes(i.op)) continue; varUses.set(vid, false); } }
            for (const [vid, ok] of varUses) if (ok) promoted.add(vid);
            const bi = (id) => builtinVars.get(id);
            const V = (id) => { if (constIds.has(id)) return 'K' + id; if (gvars.has(id)) { const g = gvars.get(id); if (g.sc === 'Workgroup') usedWG.add(id); return 'G' + id; } return 'v' + id; };
            const tyOfId = (id) => { if (constIds.has(id)) return M.consts.get(id).ty; if (resTy.has(id)) return resTy.get(id); const g = M.globals.find((x) => x.id === id); if (g) return g.ty; fail('找不到 id ' + id + ' 的型別'); };
            const T1 = (id) => ty(tyOfId(id));
            const isVecT = (t) => t.k === 'vec';
            const elemOf = (t) => (t.k === 'vec' ? ty(t.elem) : t);
            const wrap = (w, e) => (w === 32 ? '(' + e + '|0)' : w === 16 ? '((' + e + ')<<16>>16)' : w === 8 ? '((' + e + ')<<24>>24)' : '(' + e + ')');
            const un = (w, e) => (w === 32 ? '(' + e + '>>>0)' : w === 16 ? '(' + e + '&65535)' : w === 8 ? '(' + e + '&255)' : '$S.u64(' + e + ')');
            const fromUnE = (w, e) => (w === 32 ? '(' + e + '|0)' : w === 16 ? '((' + e + ')<<16>>16)' : w === 8 ? '((' + e + ')<<24>>24)' : '$S.s64(' + e + ')');
            const fw = (t, e) => (t.w === 32 ? 'Math.fround(' + e + ')' : e);
            // 逐分量：t 是結果型別（向量就逐分量），operands 是表達式；fn 收「純量表達式」回傳純量表達式
            const lane = (rt, ids, fn) => {
                if (rt.k !== 'vec') return fn(ids.map((id) => V(id)));
                const names = ids.map((_, i) => '$' + i), sc = ids.map((id) => T1(id).k !== 'vec');
                const args = ids.map((id, i) => V(id));
                void sc; return '$rt.vmapN((' + names.join(',') + ')=>' + fn(names) + ',[' + args.join(',') + '],' + rt.n + ')';
            };
            const set = (id, e) => { decl.add(id); L('v' + id + '=' + e + ';'); };
            const intOps = (op, w, a, b) => {
                switch (op) {
                    case 'OpIAdd': return w === 32 ? '(' + a + '+' + b + '|0)' : wrap(w, a + '+' + b); case 'OpISub': return w === 32 ? '(' + a + '-' + b + '|0)' : wrap(w, a + '-' + b);
                    case 'OpIMul': return w === 64 ? '(' + a + '*' + b + ')' : wrap(w, 'Math.imul(' + a + ',' + b + ')');
                    case 'OpSDiv': return '$S.sdiv(' + w + ',' + a + ',' + b + ')'; case 'OpUDiv': return '$S.udiv(' + w + ',' + a + ',' + b + ')';
                    case 'OpSRem': return '$S.srem(' + w + ',' + a + ',' + b + ')'; case 'OpSMod': return '$S.smod(' + w + ',' + a + ',' + b + ')'; case 'OpUMod': return '$S.umod(' + w + ',' + a + ',' + b + ')';
                    case 'OpBitwiseAnd': return w === 64 ? '$S.bit64(' + a + ',' + b + ',"&")' : '(' + a + '&' + b + ')'; case 'OpBitwiseOr': return w === 64 ? '$S.bit64(' + a + ',' + b + ',"|")' : '(' + a + '|' + b + ')'; case 'OpBitwiseXor': return w === 64 ? '$S.bit64(' + a + ',' + b + ',"^")' : '(' + a + '^' + b + ')';
                    case 'OpShiftLeftLogical': return w === 64 ? '$S.shl64(' + a + ',' + b + ')' : wrap(w, a + '<<' + b);
                    case 'OpShiftRightLogical': return w === 64 ? '$S.shr64(' + a + ',' + b + ',1)' : w === 32 ? '(' + a + '>>>' + b + '|0)' : wrap(w, '(' + un(w, a) + '>>>' + b + ')');
                    case 'OpShiftRightArithmetic': return w === 64 ? '$S.shr64(' + a + ',' + b + ',0)' : '(' + a + '>>' + b + ')';
                    case 'OpIEqual': return '(' + a + '===' + b + ')'; case 'OpINotEqual': return '(' + a + '!==' + b + ')';
                    case 'OpSGreaterThan': return '(' + a + '>' + b + ')'; case 'OpSGreaterThanEqual': return '(' + a + '>=' + b + ')'; case 'OpSLessThan': return '(' + a + '<' + b + ')'; case 'OpSLessThanEqual': return '(' + a + '<=' + b + ')';
                    case 'OpUGreaterThan': return '(' + un(w, a) + '>' + un(w, b) + ')'; case 'OpUGreaterThanEqual': return '(' + un(w, a) + '>=' + un(w, b) + ')'; case 'OpULessThan': return '(' + un(w, a) + '<' + un(w, b) + ')'; case 'OpULessThanEqual': return '(' + un(w, a) + '<=' + un(w, b) + ')';
                }
                return null;
            };
            const fltOps = (op, t, a, b) => {
                const F = (e) => fw(t, e);
                switch (op) {
                    case 'OpFAdd': return F(a + '+' + b); case 'OpFSub': return F(a + '-' + b); case 'OpFMul': return F(a + '*' + b); case 'OpFDiv': return F(a + '/' + b); case 'OpFRem': return F('(' + a + '%' + b + ')');
                    case 'OpFMod': return F('$rt.$fmod2(' + a + ',' + b + ')');
                    case 'OpFOrdEqual': return '(' + a + '===' + b + ')'; case 'OpFOrdNotEqual': return '(' + a + '!==' + b + '&&' + a + '===' + a + '&&' + b + '===' + b + ')';
                    case 'OpFOrdLessThan': return '(' + a + '<' + b + ')'; case 'OpFOrdGreaterThan': return '(' + a + '>' + b + ')'; case 'OpFOrdLessThanEqual': return '(' + a + '<=' + b + ')'; case 'OpFOrdGreaterThanEqual': return '(' + a + '>=' + b + ')';
                    case 'OpFUnordEqual': return '(' + a + '===' + b + '||' + a + '!==' + a + '||' + b + '!==' + b + ')'; case 'OpFUnordNotEqual': return '(' + a + '!==' + b + ')';
                    case 'OpFUnordLessThan': return '!(' + a + '>=' + b + ')'; case 'OpFUnordGreaterThan': return '!(' + a + '<=' + b + ')'; case 'OpFUnordLessThanEqual': return '!(' + a + '>' + b + ')'; case 'OpFUnordGreaterThanEqual': return '!(' + a + '<' + b + ')';
                    case 'OpOrdered': return '(' + a + '===' + a + '&&' + b + '===' + b + ')'; case 'OpUnordered': return '(' + a + '!==' + a + '||' + b + '!==' + b + ')';
                }
                return null;
            };
            // OpenCL.std 擴充指令
            const FLT1 = { acos: 'Math.acos', acosh: 'Math.acosh', asin: 'Math.asin', asinh: 'Math.asinh', atan: 'Math.atan', atanh: 'Math.atanh', cbrt: 'Math.cbrt', ceil: 'Math.ceil', cos: 'Math.cos', cosh: 'Math.cosh', exp: 'Math.exp', exp2: '$rt.$exp2', exp10: '$rt.$exp10', expm1: 'Math.expm1', fabs: 'Math.abs', floor: 'Math.floor', log: 'Math.log', log2: 'Math.log2', log10: 'Math.log10', log1p: 'Math.log1p', rint: '$rt.$rint', round: '$rt.$round', rsqrt: '$rt.$rsqrt', sin: 'Math.sin', sinh: 'Math.sinh', sqrt: 'Math.sqrt', tan: 'Math.tan', tanh: 'Math.tanh', trunc: 'Math.trunc', tgamma: '$S.tgamma', erf: '$S.erf', erfc: '$S.erfc', sign: '$S.sign', degrees: '$rt.$deg', radians: '$rt.$rad', logb: '$S.logb', fract: '$rt.$fract' };
            const ocl = (id, rt, name, argIds) => {
                const base = name.replace(/^(native_|half_)/, ''), A = argIds, st = elemOf(rt);
                const f = (t, e) => (t.k === 'float' ? fw(t, e) : e), isF = st.k === 'float', w = st.w;
                if (FLT1[base] && A.length === 1 && isF) return lane(rt, A, (a) => f(st, FLT1[base] + '(' + a[0] + ')'));
                const pi = /^(acos|asin|atan|cos|sin|tan)pi$/.exec(base); if (pi && isF) return lane(rt, A, (a) => f(st, pi[1] === 'cos' || pi[1] === 'sin' || pi[1] === 'tan' ? 'Math.' + pi[1] + '(Math.PI*' + a[0] + ')' : 'Math.' + pi[1] + '(' + a[0] + ')/Math.PI'));
                const two = { atan2: 'Math.atan2', copysign: '$rt.$copysign', fdim: '$rt.$fdim', fmod: '$rt.$fmod', hypot: 'Math.hypot', pow: 'Math.pow', powr: 'Math.pow', remainder: '$rt.$remainder', fmax: '$S.fmax', fmin: '$S.fmin', fmax_common: '$S.fmax', fmin_common: '$S.fmin', maxmag: '((a,b)=>Math.abs(a)>Math.abs(b)?a:Math.abs(b)>Math.abs(a)?b:Math.max(a,b))', minmag: '((a,b)=>Math.abs(a)<Math.abs(b)?a:Math.abs(b)<Math.abs(a)?b:Math.min(a,b))', native_divide: '', divide: '' };
                if (two[base] && A.length === 2 && isF) return lane(rt, A, (a) => f(st, two[base] + '(' + a[0] + ',' + a[1] + ')'));
                if (base === 'divide') return lane(rt, A, (a) => f(st, a[0] + '/' + a[1])); if (base === 'recip') return lane(rt, A, (a) => f(st, '1/' + a[0]));
                if (base === 'atan2pi') return lane(rt, A, (a) => f(st, 'Math.atan2(' + a[0] + ',' + a[1] + ')/Math.PI'));
                if (base === 'nextafter') return lane(rt, A, (a) => '$S.nextafter(' + a[0] + ',' + a[1] + ',' + (w === 32 ? 1 : 0) + ')');
                if (base === 'ldexp' || base === 'pown' || base === 'rootn') return lane(rt, A, (a) => f(st, base === 'ldexp' ? a[0] + '*Math.pow(2,' + a[1] + ')' : base === 'pown' ? 'Math.pow(' + a[0] + ',' + a[1] + ')' : '$rt.$rootn(' + a[0] + ',' + a[1] + ')'));
                if (base === 'fma' || base === 'mad') return lane(rt, A, (a) => f(st, '(' + a[0] + '*' + a[1] + '+' + a[2] + ')'));
                if (base === 'mix') return lane(rt, A, (a) => f(st, '(' + a[0] + '+(' + a[1] + '-' + a[0] + ')*' + a[2] + ')'));
                if (base === 'fclamp') return lane(rt, A, (a) => 'Math.min(Math.max(' + a[0] + ',' + a[1] + '),' + a[2] + ')');
                if (base === 'step') return lane(rt, A, (a) => '(' + a[1] + '<' + a[0] + '?0:1)'); if (base === 'smoothstep') return lane(rt, A, (a) => f(st, '$S.smooth(' + a[0] + ',' + a[1] + ',' + a[2] + ')'));
                if (base === 'ilogb') return lane(rt, A, (a) => 'Math.floor(Math.log2(Math.abs(' + a[0] + ')))');
                if (base === 'sincos' || base === 'modf' || base === 'frexp' || base === 'lgamma_r' || base === 'remquo' || base === 'fract' && A.length === 2) unsupported('OpenCL.std ' + name + '（要經由指標回傳第二個結果）');
                // 整數
                const IW = isF ? 0 : w;
                switch (base) {
                    case 's_abs': case 'u_abs': return lane(rt, A, (a) => wrap(IW, 'Math.abs(' + a[0] + ')'));
                    case 's_min': return lane(rt, A, (a) => 'Math.min(' + a[0] + ',' + a[1] + ')'); case 's_max': return lane(rt, A, (a) => 'Math.max(' + a[0] + ',' + a[1] + ')');
                    case 'u_min': return lane(rt, A, (a) => fromUnE(IW, 'Math.min(' + un(IW, a[0]) + ',' + un(IW, a[1]) + ')')); case 'u_max': return lane(rt, A, (a) => fromUnE(IW, 'Math.max(' + un(IW, a[0]) + ',' + un(IW, a[1]) + ')'));
                    case 's_clamp': return lane(rt, A, (a) => 'Math.min(Math.max(' + a[0] + ',' + a[1] + '),' + a[2] + ')'); case 'u_clamp': return lane(rt, A, (a) => fromUnE(IW, 'Math.min(Math.max(' + un(IW, a[0]) + ',' + un(IW, a[1]) + '),' + un(IW, a[2]) + ')'));
                    case 's_abs_diff': return lane(rt, A, (a) => 'Math.abs(' + a[0] + '-' + a[1] + ')'); case 'u_abs_diff': return lane(rt, A, (a) => fromUnE(IW, 'Math.abs(' + un(IW, a[0]) + '-' + un(IW, a[1]) + ')'));
                    case 's_add_sat': return lane(rt, A, (a) => '$S.sat(' + IW + ',' + a[0] + '+' + a[1] + ',true)'); case 'u_add_sat': return lane(rt, A, (a) => fromUnE(IW, '$S.sat(' + IW + ',' + un(IW, a[0]) + '+' + un(IW, a[1]) + ',false)'));
                    case 's_sub_sat': return lane(rt, A, (a) => '$S.sat(' + IW + ',' + a[0] + '-' + a[1] + ',true)'); case 'u_sub_sat': return lane(rt, A, (a) => fromUnE(IW, '$S.sat(' + IW + ',' + un(IW, a[0]) + '-' + un(IW, a[1]) + ',false)'));
                    case 's_hadd': return lane(rt, A, (a) => wrap(IW, 'Math.floor((' + a[0] + '+' + a[1] + ')/2)')); case 'u_hadd': return lane(rt, A, (a) => fromUnE(IW, 'Math.floor((' + un(IW, a[0]) + '+' + un(IW, a[1]) + ')/2)'));
                    case 's_rhadd': return lane(rt, A, (a) => wrap(IW, 'Math.floor((' + a[0] + '+' + a[1] + '+1)/2)')); case 'u_rhadd': return lane(rt, A, (a) => fromUnE(IW, 'Math.floor((' + un(IW, a[0]) + '+' + un(IW, a[1]) + '+1)/2)'));
                    case 'clz': return lane(rt, A, (a) => '$S.clz(' + IW + ',' + a[0] + ')'); case 'ctz': return lane(rt, A, (a) => '$S.ctz(' + IW + ',' + a[0] + ')'); case 'popcount': return lane(rt, A, (a) => '$S.popcount(' + IW + ',' + a[0] + ')');
                    case 'rotate': return lane(rt, A, (a) => '$S.rotl(' + IW + ',' + a[0] + ',' + a[1] + ')');
                    case 's_mul_hi': return lane(rt, A, (a) => '$S.mulhi(' + IW + ',' + a[0] + ',' + a[1] + ',true)'); case 'u_mul_hi': return lane(rt, A, (a) => '$S.mulhi(' + IW + ',' + a[0] + ',' + a[1] + ',false)');
                    case 's_mul24': case 'u_mul24': return lane(rt, A, (a) => wrap(IW, 'Math.imul(' + a[0] + ',' + a[1] + ')')); case 's_mad24': case 'u_mad24': return lane(rt, A, (a) => wrap(IW, 'Math.imul(' + a[0] + ',' + a[1] + ')+' + a[2]));
                    case 's_mad_hi': return lane(rt, A, (a) => wrap(IW, '$S.mulhi(' + IW + ',' + a[0] + ',' + a[1] + ',true)+' + a[2])); case 'u_mad_hi': return lane(rt, A, (a) => wrap(IW, '$S.mulhi(' + IW + ',' + a[0] + ',' + a[1] + ',false)+' + a[2]));
                    case 'bitselect': if (!isF) return lane(rt, A, (a) => '((' + a[0] + '&~' + a[2] + ')|(' + a[1] + '&' + a[2] + '))'); break;
                    case 'select': return selectExpr(rt, A);
                    case 'prefetch': return '0';
                }
                if (base === 'length' || base === 'fast_length') return fw(st, 'Math.sqrt($S.dot(' + V(A[0]) + ',' + V(A[0]) + ',' + (w === 32 ? 1 : 0) + '))');
                if (base === 'distance' || base === 'fast_distance') return fw(st, 'Math.sqrt($S.dot(' + V(A[0]) + '.map((x,i)=>x-' + V(A[1]) + '[i]),' + V(A[0]) + '.map((x,i)=>x-' + V(A[1]) + '[i]),0))');
                if (base === 'normalize' || base === 'fast_normalize') return '(($v)=>{const l=Math.sqrt($S.dot($v,$v,0));return l===0?$v.map(()=>0):$v.map((x)=>' + fw(st, 'x/l') + ');})(' + V(A[0]) + ')';
                if (base === 'cross') return '(($a,$b)=>[' + [fw(st, '$a[1]*$b[2]-$a[2]*$b[1]'), fw(st, '$a[2]*$b[0]-$a[0]*$b[2]'), fw(st, '$a[0]*$b[1]-$a[1]*$b[0]'), ...(rt.n === 4 ? ['0'] : [])].join(',') + '])(' + V(A[0]) + ',' + V(A[1]) + ')';
                if (base === 'shuffle') { const vt = T1(A[0]); return '$S.shuf(' + V(A[0]) + ',[],' + V(A[1]) + '.map((x)=>x&' + (vt.n - 1 + (vt.n === 3 ? 1 : 0)) + '))'; }
                if (base === 'shuffle2') { const vt = T1(A[0]); return '$S.shuf(' + V(A[0]) + ',' + V(A[1]) + ',' + V(A[2]) + '.map((x)=>x&' + (vt.n * 2 - 1) + '))'; }
                unsupported('OpenCL.std 指令 ' + name);
            };
            const selectExpr = (rt, A) => {   // OpSelect(cond, a, b)；cond 的最高位決定（OpenCL select 的 c 是整數向量）
                const [c, a, b] = A; const ct = T1(c);
                if (rt.k === 'vec') { if (ct.k === 'vec') return '$rt.vmapN(($c,$a,$b)=>$c?$a:$b,[' + V(c) + ',' + V(a) + ',' + V(b) + '],' + rt.n + ')'; return '(' + V(c) + '?' + V(a) + ':' + V(b) + ')'; }
                return '(' + V(c) + '?' + V(a) + ':' + V(b) + ')';
            };
            // 位址：AccessChain
            const chain = (id, base, idxIds, isPtrChain) => {
                let pt = ty(ty(tyOfId(base)).pointee), terms = [], rest = idxIds;
                const baseT = ty(tyOfId(base)); void baseT;
                if (isPtrChain) { const e = rest[0]; terms.push(constIds.has(e) ? String(constValue(M, TY, e) * layout(pt.id).size) : '(' + V(e) + ')*' + layout(pt.id).size); rest = rest.slice(1); }
                for (const e of rest) {
                    if (pt.k === 'struct') { if (!constIds.has(e)) fail('struct 的索引要是常數'); const k = constValue(M, TY, e), l = layout(pt.id); if (l.offs[k]) terms.push(String(l.offs[k])); pt = ty(pt.members[k]); }
                    else if (pt.k === 'arr') { const st = layout(pt.id).stride; terms.push(constIds.has(e) ? String(constValue(M, TY, e) * st) : '(' + V(e) + ')*' + st); pt = ty(pt.elem); }
                    else if (pt.k === 'vec') { const es = layout(pt.elem).size; terms.push(constIds.has(e) ? String(constValue(M, TY, e) * es) : '(' + V(e) + ')*' + es); pt = ty(pt.elem); }
                    else fail('AccessChain 無法再深入型別 ' + pt.k);
                }
                const off = terms.join('+'); return !off || off === '0' ? V(base) : '$rt.padd(' + V(base) + ',' + off + ',1)';
            };
            // ---- 解析整個函式
            const blockIds = f.blocks.map((b) => b.id), single = f.blocks.length === 1, phis = new Map();   // 目標區塊 → [{id, pairs}]
            for (const b of f.blocks) for (const i of b.ins) if (i.op === 'OpPhi') { const pairs = []; for (let k = 2; k + 1 < i.w.length; k += 2) pairs.push({ val: i.w[k], from: i.w[k + 1] }); if (!phis.has(b.id)) phis.set(b.id, []); phis.get(b.id).push({ id: i.w[1], ty: i.w[0], pairs }); resTy.set(i.w[1], i.w[0]); decl.add(i.w[1]); }
            for (const b of f.blocks) for (const i of b.ins) if (i.w && T_HAS_RESULT[i.op]) resTy.set(i.w[1], i.w[0]);
            const edge = (from, to) => {   // 分支邊上的 phi 賦值（平行語意）
                const ps = phis.get(to); if (!ps || !ps.length) return '';
                const pairs = ps.map((p) => { const e = p.pairs.find((x) => x.from === from); if (!e) fail('phi 在區塊 ' + to + ' 沒有來自 ' + from + ' 的值'); return [p.id, V(e.val)]; });
                return pairs.length === 1 ? 'v' + pairs[0][0] + '=' + pairs[0][1] + ';' : '{' + pairs.map((p, k) => 'const $p' + k + '=' + p[1] + ';').join('') + pairs.map((p, k) => 'v' + p[0] + '=$p' + k + ';').join('') + '}';
            };
            const yieldCall = (e) => (hasBarrier ? '(yield* ' + e + ')' : e);
            let curBlockId = 0;
            const goto = (to) => (single ? '' : edge(curBlockId, to) + '$b=' + to + ';continue $L;');
            const emit = (i) => {
                const w = i.w, op = i.op, rt = () => ty(w[0]);
                switch (op) {
                    case 'OpPhi': case 'OpLoopMerge': case 'OpSelectionMerge': case 'OpLifetimeStart': case 'OpLifetimeStop': case 'OpNop': return;
                    case 'OpVariable': {
                        const v = i.v, pt = ty(ty(v.ty).pointee); resTy.set(v.id, v.ty);
                        if (v.sc !== 'Function') fail('函式內的變數儲存類別 ' + v.sc + ' 不支援');
                        if (promoted.has(v.id)) set(v.id, v.init ? V(v.init) : lit(zeroLit(M, TY, pt.id)));
                        else { set(v.id, '$rt.alloc(' + Math.max(8, layout(pt.id).size) + ')'); if (v.init) L(storeCode(pt.id, 'v' + v.id, V(v.init), 'i')); }
                        return;
                    }
                    case 'OpLoad': { const p = w[2]; if (builtinVars.has(p)) { const b = BUILTIN[bi(p)]; if (!b) fail('不支援的內建變數 ' + bi(p)); return set(w[1], b()); } if (promoted.has(p)) return set(w[1], 'v' + p); if (pseudo.has(p)) { const ps = pseudo.get(p); return set(w[1], ps.expr); } return set(w[1], ld(w[0], V(p))); }
                    case 'OpStore': { const p = w[0], vt = T1(w[1]); if (promoted.has(p)) return L('v' + p + '=' + V(w[1]) + ';'); void vt; const pt = ty(ty(tyOfId(p)).pointee); return L(storeCode(pt.id, V(p), V(w[1]), 's')); }
                    case 'OpAccessChain': case 'OpInBoundsAccessChain': case 'OpPtrAccessChain': case 'OpInBoundsPtrAccessChain': {
                        const base = w[2], idx = w.slice(3), isP = op.includes('Ptr');
                        if (builtinVars.has(base)) { const b = BUILTIN[bi(base)]; if (!b) fail('不支援的內建變數 ' + bi(base)); if (!constIds.has(idx[idx.length - 1])) fail('內建變數的分量索引要是常數'); pseudo.set(w[1], { expr: b() + '[' + constValue(M, TY, idx[idx.length - 1]) + ']' }); resTy.set(w[1], w[0]); return; }
                        return set(w[1], chain(w[1], base, idx, isP));
                    }
                    case 'OpCopyObject': return set(w[1], V(w[2]));
                    case 'OpCopyMemory': { const pt = ty(ty(tyOfId(w[0])).pointee); return L('$rt.cpy(' + V(w[0]) + ',' + V(w[1]) + ',' + layout(pt.id).size + ');'); }
                    case 'OpCopyMemorySized': return L('$rt.cpy(' + V(w[0]) + ',' + V(w[1]) + ',' + V(w[2]) + ');');
                    case 'OpBitcast': {
                        const to = rt(), from = T1(w[2]);
                        if (to.k === 'ptr' && from.k === 'ptr') return set(w[1], V(w[2]));
                        const f1 = elemOf(from), t1 = elemOf(to); if (f1.k === t1.k && (f1.w === t1.w)) return set(w[1], V(w[2]));
                        const fn = f1.k === 'float' && t1.k === 'int' ? (f1.w === 32 ? '$S.f322i' : '$S.f642i') : f1.k === 'int' && t1.k === 'float' ? (t1.w === 32 ? '$S.i2f32' : '$S.i2f64') : null;
                        if (!fn || f1.w !== t1.w) fail('OpBitcast ' + f1.k + f1.w + '→' + t1.k + t1.w + ' 不支援'); return set(w[1], to.k === 'vec' ? V(w[2]) + '.map(' + fn + ')' : fn + '(' + V(w[2]) + ')');
                    }
                    case 'OpSelect': return set(w[1], selectExpr(rt(), [w[2], w[3], w[4]]));
                    case 'OpCompositeConstruct': {
                        const t = rt(); if (t.k === 'vec') { const allScalar = w.slice(2).every((id) => T1(id).k !== 'vec'); return set(w[1], allScalar ? '[' + w.slice(2).map(V).join(',') + ']' : '$S.flat([' + w.slice(2).map(V).join(',') + '].map((x)=>Array.isArray(x)?x:[x]))'); }
                        return set(w[1], '[' + w.slice(2).map(V).join(',') + ']');
                    }
                    case 'OpCompositeExtract': return set(w[1], V(w[2]) + w.slice(3).map((k) => '[' + k + ']').join(''));
                    case 'OpCompositeInsert': return set(w[1], '$S.ins(' + V(w[3]) + ',[' + w.slice(4).join(',') + '],' + V(w[2]) + ')');
                    case 'OpVectorShuffle': return set(w[1], '$S.shuf(' + V(w[2]) + ',' + V(w[3]) + ',[' + w.slice(4).join(',') + '])');
                    case 'OpVectorExtractDynamic': return set(w[1], V(w[2]) + '[' + V(w[3]) + ']');
                    case 'OpVectorInsertDynamic': return set(w[1], '(($v,$i)=>{const c=$v.slice();c[$i]=' + V(w[3]) + ';return c;})(' + V(w[2]) + ',' + V(w[4]) + ')');
                    case 'OpVectorTimesScalar': { const t = rt(); return set(w[1], '$rt.vmapN(($x)=>' + fw(t.k === 'vec' ? ty(t.elem) : t, '$x*' + V(w[3])) + ',[' + V(w[2]) + '],' + t.n + ')'); }
                    case 'OpDot': { const vt = T1(w[2]); return set(w[1], '$S.dot(' + V(w[2]) + ',' + V(w[3]) + ',' + (ty(vt.elem).w === 32 ? 1 : 0) + ')'); }
                    case 'OpFunctionCall': { const callee = w[2]; if (!M.funcs.get(callee) || !M.funcs.get(callee).blocks.length) fail('呼叫了沒有本體的函式 ' + (M.names.get(callee) || callee) + '（Import 的 linkage，例如 __spirv_ocl_* 函式；這個後端沒有實作）'); return set(w[1], yieldCall('f' + callee + '(' + w.slice(3).map(V).join(',') + ')')); }
                    case 'OpExtInst': {
                        const set_ = M.exts.get(w[2]); if (set_ !== 'OpenCL.std') fail('不認得的擴充指令集 ' + set_);
                        const name = OCLN[w[3]]; if (!name) fail('OpenCL.std 指令 #' + w[3] + ' 不認得');
                        if (name === 'vloadn') { const n = w[6], t = ty(w[0]); return set(w[1], '$rt.vld(' + V(w[5]) + ',' + V(w[4]) + ',' + JSON.stringify(VIEW(ty(t.elem))) + ',' + n + ')'); }
                        if (name === 'vstoren') { const vt = T1(w[4]), ptrT = ty(ty(tyOfId(w[6])).pointee); void ptrT; return L('$rt.vst(' + V(w[6]) + ',' + V(w[5]) + ',' + JSON.stringify(VIEW(ty(vt.elem))) + ',' + vt.n + ',' + V(w[4]) + ');'); }
                        if (name === 'printf') fail('printf 沒有實作');
                        const r = ocl(w[1], rt(), name, w.slice(4)); return rt().k === 'void' ? L(r + ';') : set(w[1], r);
                    }
                    case 'OpControlBarrier': { if (!hasBarrier) return; return L('yield 0;'); }
                    case 'OpMemoryBarrier': return;
                    case 'OpBranch': return L(goto(w[0]));
                    case 'OpBranchConditional': return L('if(' + V(w[0]) + '){' + goto(w[1]) + '}else{' + goto(w[2]) + '}');
                    case 'OpSwitch': {
                        const selT = T1(w[0]), lw = selT.w === 64 ? 2 : 1, cases = []; for (let k = 2; k < w.length; k += lw + 1) cases.push({ lit: lw === 2 ? num64(w[k], w[k + 1], true) : (selT.w === 32 ? w[k] | 0 : wrapW(selT.w, w[k])), to: w[k + lw] });
                        return L('switch(' + V(w[0]) + '){' + cases.map((c) => 'case ' + c.lit + ':{' + goto(c.to) + '}').join('') + 'default:{' + goto(w[1]) + '}}');
                    }
                    case 'OpReturn': return L('return;'); case 'OpReturnValue': return L('return ' + V(w[0]) + ';'); case 'OpUnreachable': return L('throw new Error("OpUnreachable");');
                    // 原子
                    case 'OpAtomicLoad': return set(w[1], ld(w[0], V(w[2])));
                    case 'OpAtomicStore': return L(storeCode(ty(ty(tyOfId(w[0])).pointee).id, V(w[0]), V(w[3]), 'a'));
                    case 'OpAtomicExchange': case 'OpAtomicCompareExchange': case 'OpAtomicCompareExchangeWeak': case 'OpAtomicIIncrement': case 'OpAtomicIDecrement': case 'OpAtomicIAdd': case 'OpAtomicISub': case 'OpAtomicSMin': case 'OpAtomicUMin': case 'OpAtomicSMax': case 'OpAtomicUMax': case 'OpAtomicAnd': case 'OpAtomicOr': case 'OpAtomicXor': {
                        const t = rt(); const unsignedOp = op === 'OpAtomicUMin' || op === 'OpAtomicUMax'; const cty = t.k === 'float' ? 'float' : t.w === 64 ? (unsignedOp ? 'ulong' : 'long') : (unsignedOp ? 'uint' : 'int');
                        const name = { OpAtomicExchange: 'xchg', OpAtomicCompareExchange: 'cmpxchg', OpAtomicCompareExchangeWeak: 'cmpxchg', OpAtomicIIncrement: 'inc', OpAtomicIDecrement: 'dec', OpAtomicIAdd: 'add', OpAtomicISub: 'sub', OpAtomicSMin: 'min', OpAtomicUMin: 'min', OpAtomicSMax: 'max', OpAtomicUMax: 'max', OpAtomicAnd: 'and', OpAtomicOr: 'or', OpAtomicXor: 'xor' }[op];
                        let a1 = '0', a2 = '0'; if (op === 'OpAtomicCompareExchange' || op === 'OpAtomicCompareExchangeWeak') { a1 = V(w[7]); a2 = V(w[6]); } else if (name !== 'inc' && name !== 'dec') a1 = V(w[5]);
                        const call = '$rt.atomic(' + JSON.stringify(name) + ',' + V(w[2]) + ',' + JSON.stringify(cty) + ',' + a1 + ',' + a2 + ')'; return set(w[1], t.k === 'int' && t.w < 64 ? wrapPlain(t.w, call) : call);
                    }
                    // 圖像
                    case 'OpSampledImage': return set(w[1], '[' + V(w[2]) + ',' + V(w[3]) + ']');
                    case 'OpImage': return set(w[1], V(w[2]) + '[0]');
                    case 'OpImageRead': case 'OpImageSampleExplicitLod': case 'OpImageFetch': {
                        const t = rt(), isSamp = op === 'OpImageSampleExplicitLod', src = T1(w[2]), imgT = src.k === 'simg' ? ty(src.image) : src; if (imgT.k !== 'image') fail(op + ' 的來源不是圖像');
                        const coordT = T1(w[3]), isFC = elemOf(coordT).k === 'float', kind = elemOf(t).k === 'float' ? 'f' : (imgSampledSigned(imgT) ? 'i' : 'ui');
                        const img = isSamp ? V(w[2]) + '[0]' : V(w[2]), smp = isSamp ? V(w[2]) + '[1]' : '-1', coord = coordT.k === 'vec' ? V(w[3]) : '[' + V(w[3]) + ']';
                        return set(w[1], '$rt.rimg(' + img + ',' + smp + ',' + coord + ',' + JSON.stringify(kind) + ',' + (isFC && isSamp ? 1 : 0) + ')' + (t.k === 'vec' && t.n < 4 ? '.slice(0,' + t.n + ')' : ''));
                    }
                    case 'OpImageWrite': { const imgT = T1(w[0]), coordT = T1(w[1]), valT = T1(w[2]); const kind = elemOf(valT).k === 'float' ? 'f' : (imgSampledSigned(imgT) ? 'i' : 'ui'); return L('$rt.wimg(' + V(w[0]) + ',' + (coordT.k === 'vec' ? V(w[1]) : '[' + V(w[1]) + ']') + ',' + V(w[2]) + ',' + JSON.stringify(kind) + ');'); }
                    case 'OpImageQuerySize': case 'OpImageQuerySizeLod': { const t = rt(), imgT = T1(w[2]), dimsN = imgT.dim === '3D' ? 3 : imgT.dim === '2D' ? 2 : 1; const sizes = ['$rt.gimg(' + V(w[2]) + ',"width")', '$rt.gimg(' + V(w[2]) + ',"height")', '$rt.gimg(' + V(w[2]) + ',"depth")']; const parts = sizes.slice(0, dimsN); if (imgT.arrayed) parts.push('$rt.gimg(' + V(w[2]) + ',"array_size")'); return set(w[1], t.k === 'vec' ? '[' + parts.slice(0, t.n).join(',') + ']' : parts[0]); }
                    case 'OpImageQueryFormat': return set(w[1], '$rt.gimg(' + V(w[2]) + ',"channel_data_type")');
                    case 'OpImageQueryOrder': return set(w[1], '$rt.gimg(' + V(w[2]) + ',"channel_order")');
                    // pipe（ptr 的指向型別決定封包；size 在指令裡）
                    case 'OpReadPipe': case 'OpWritePipe': { const isW = op === 'OpWritePipe', size = constNum(M, w[4]); return set(w[1], '$rt.pipeop(' + V(w[2]) + ',' + size + ',' + (isW ? 1 : 0) + ',0,0,0,($q)=>{' + (isW ? '$rt.cpy($q,' + V(w[3]) + ',' + size + ')' : '$rt.cpy(' + V(w[3]) + ',$q,' + size + ')') + '})'); }
                    case 'OpReservedReadPipe': case 'OpReservedWritePipe': { const isW = op === 'OpReservedWritePipe', size = constNum(M, w[6]); return set(w[1], '$rt.pipeop(' + V(w[2]) + ',' + size + ',' + (isW ? 1 : 0) + ',' + V(w[3]) + ',' + V(w[4]) + ',1,($q)=>{' + (isW ? '$rt.cpy($q,' + V(w[5]) + ',' + size + ')' : '$rt.cpy(' + V(w[5]) + ',$q,' + size + ')') + '})'); }
                    case 'OpReserveReadPipePackets': case 'OpReserveWritePipePackets': return set(w[1], '$rt.pipereserve(' + V(w[2]) + ',' + V(w[3]) + ',' + (op === 'OpReserveWritePipePackets' ? 1 : 0) + ')');
                    case 'OpCommitReadPipe': case 'OpCommitWritePipe': return;
                    case 'OpIsValidReserveId': return set(w[1], '(' + V(w[2]) + '!==0)');
                    case 'OpGetNumPipePackets': return set(w[1], '$rt.pipeinfo(' + V(w[2]) + ',0)'); case 'OpGetMaxPipePackets': return set(w[1], '$rt.pipeinfo(' + V(w[2]) + ',1)');
                    case 'OpPtrEqual': return set(w[1], '(' + V(w[2]) + '.o===' + V(w[3]) + '.o&&' + V(w[2]) + '.v===' + V(w[3]) + '.v)'); case 'OpPtrNotEqual': return set(w[1], '!(' + V(w[2]) + '.o===' + V(w[3]) + '.o&&' + V(w[2]) + '.v===' + V(w[3]) + '.v)');
                    case 'OpPtrDiff': return set(w[1], '((' + V(w[2]) + '.o-' + V(w[3]) + '.o)/' + layout(ty(ty(tyOfId(w[2])).pointee).id).size + ')');
                }
                // 算術
                const t = rt();
                if (op === 'OpLogicalAnd') return set(w[1], lane(t, [w[2], w[3]], (a) => '(' + a[0] + '&&' + a[1] + ')')); if (op === 'OpLogicalOr') return set(w[1], lane(t, [w[2], w[3]], (a) => '(' + a[0] + '||' + a[1] + ')'));
                if (op === 'OpLogicalEqual') return set(w[1], lane(t, [w[2], w[3]], (a) => '(' + a[0] + '===' + a[1] + ')')); if (op === 'OpLogicalNotEqual') return set(w[1], lane(t, [w[2], w[3]], (a) => '(' + a[0] + '!==' + a[1] + ')'));
                if (op === 'OpLogicalNot') return set(w[1], lane(t, [w[2]], (a) => '!' + a[0]));
                if (op === 'OpNot') { const e = elemOf(t); return set(w[1], lane(t, [w[2]], (a) => (e.w === 64 ? '(-' + a[0] + '-1)' : '(~' + a[0] + ')'))); }
                if (op === 'OpSNegate') { const e = elemOf(t); return set(w[1], lane(t, [w[2]], (a) => wrap(e.w, '-' + a[0]))); }
                if (op === 'OpFNegate') return set(w[1], lane(t, [w[2]], (a) => '(-' + a[0] + ')'));
                if (op === 'OpAny') return set(w[1], V(w[2]) + '.some((x)=>x)'); if (op === 'OpAll') return set(w[1], V(w[2]) + '.every((x)=>x)');
                if (op === 'OpIsNan') return set(w[1], lane(t, [w[2]], (a) => '(' + a[0] + '!==' + a[0] + ')')); if (op === 'OpIsInf') return set(w[1], lane(t, [w[2]], (a) => '$rt.$isinf(' + a[0] + ')')); if (op === 'OpIsFinite') return set(w[1], lane(t, [w[2]], (a) => 'Number.isFinite(' + a[0] + ')'));
                if (op === 'OpSignBitSet') return set(w[1], lane(t, [w[2]], (a) => '(' + a[0] + '<0||Object.is(' + a[0] + ',-0))'));
                const conv = { OpSConvert: 1, OpUConvert: 1, OpFConvert: 1, OpConvertFToS: 1, OpConvertFToU: 1, OpConvertSToF: 1, OpConvertUToF: 1, OpSatConvertSToU: 1, OpSatConvertUToS: 1 }[op];
                if (conv) {
                    const to = elemOf(t), from = elemOf(T1(w[2]));
                    return set(w[1], lane(t, [w[2]], (a) => {
                        switch (op) {
                            case 'OpSConvert': return wrap(to.w, a[0]); case 'OpUConvert': return from.w <= to.w ? fromUnE(to.w, un(from.w, a[0])) : wrap(to.w, a[0]); case 'OpFConvert': return fw(to, a[0]);
                            case 'OpConvertFToS': return '$S.f2s(' + to.w + ',' + a[0] + ')'; case 'OpConvertFToU': return '$S.f2u(' + to.w + ',' + a[0] + ')';
                            case 'OpConvertSToF': return fw(to, a[0]); case 'OpConvertUToF': return fw(to, un(from.w, a[0]));
                        }
                        return unsupportedOp(op);
                    }));
                }
                const A2 = w.length >= 4 ? [w[2], w[3]] : null;
                if (A2 && T_BINARY.has(op)) {
                    const a0 = elemOf(T1(w[2]));
                    return set(w[1], lane(t, A2, (a) => { const e = a0.k === 'float' ? fltOps(op, a0, a[0], a[1]) : intOps(op, a0.w || elemOf(t).w, a[0], a[1]); if (e === null || e === '') unsupportedOp(op); return e; }));
                }
                unsupportedOp(op);
            };
            const unsupportedOp = (op) => fail('SPIR-V 指令 ' + op + ' 尚未支援');
            const pseudo = new Map();
            const imgSampledSigned = (imgT) => { const st = M.types.get(imgT.sampledTypeId); return !!(st && st.k === 'int' && st.signed); };
            const wrapPlain = (w, e) => wrap(w, e);
            // 收集結果型別（給 T1 用）：沿著區塊順序，先登記有 IdResultType 的指令
            // 輸出函式
            const params = f.params.map((p) => 'v' + p.id);
            const body = [];
            const saveL = lines;
            void saveL;
            if (single) { curBlockId = f.blocks[0].id; for (const i of f.blocks[0].ins) emit(i); }
            else {
                L('let $b=' + f.blocks[0].id + ';');
                L('$L:for(;;){switch($b){');
                for (const b of f.blocks) { curBlockId = b.id; L('case ' + b.id + ':{'); for (const i of b.ins) emit(i); L('}'); }
                L('default:throw new Error("bad block");}}');
            }
            void body; void blockIds;
            const decls = [...decl].filter((id) => !f.params.some((p) => p.id === id)).map((id) => 'v' + id);
            const wgDecl = [...usedWG].map((id) => 'const G' + id + '=$rt.lmem(' + id + ',' + Math.max(8, gvars.get(id).size) + ');').join('');
            return 'function' + (hasBarrier ? '*' : '') + ' f' + f.id + '(' + params.join(',') + '){' + wgDecl + (decls.length ? 'let ' + decls.join(',') + ';' : '') + lines.join('\n') + '}';
        }
    }
    // 沒有 IdResultType／IdResult 的指令集合（用來判斷 w[0]、w[1] 是不是結果型別與結果 id）
    const T_HAS_RESULT = {}; for (const k of Object.keys(T.ops)) { const kinds = T.ops[k][1]; T_HAS_RESULT[k] = kinds[0] === 'IdResultType' && kinds[1] === 'IdResult'; }
    const T_BINARY = new Set(['OpIAdd', 'OpISub', 'OpIMul', 'OpSDiv', 'OpUDiv', 'OpSRem', 'OpSMod', 'OpUMod', 'OpBitwiseAnd', 'OpBitwiseOr', 'OpBitwiseXor', 'OpShiftLeftLogical', 'OpShiftRightLogical', 'OpShiftRightArithmetic', 'OpIEqual', 'OpINotEqual', 'OpSGreaterThan', 'OpSGreaterThanEqual', 'OpSLessThan', 'OpSLessThanEqual', 'OpUGreaterThan', 'OpUGreaterThanEqual', 'OpULessThan', 'OpULessThanEqual',
        'OpFAdd', 'OpFSub', 'OpFMul', 'OpFDiv', 'OpFRem', 'OpFMod', 'OpFOrdEqual', 'OpFOrdNotEqual', 'OpFOrdLessThan', 'OpFOrdGreaterThan', 'OpFOrdLessThanEqual', 'OpFOrdGreaterThanEqual', 'OpFUnordEqual', 'OpFUnordNotEqual', 'OpFUnordLessThan', 'OpFUnordGreaterThan', 'OpFUnordLessThanEqual', 'OpFUnordGreaterThanEqual', 'OpOrdered', 'OpUnordered']);

    // ---------------------------------------------------------------- 6. 對外：compile
    function compile(il, options) {
        options = options || {};
        try {
            const dec = decode(il); const M = analyze(dec, options);
            for (const t of M.types.values()) if (t.k === 'image') { /* 取樣型別：OpTypeImage 的第 1 個運算元 */ }
            // 補圖像的「取樣型別」資訊（整數有號與否決定 read_imagei／ui）
            for (const ins of dec.insts) if (ins.name === 'OpTypeImage') { const t = M.types.get(ins.w[0]); t.sampledTypeId = ins.w[1]; }
            const c = compileModule(M, options);
            if (c.errors) return { ok: false, log: 'SPIR-V 建置失敗：\n  ' + c.errors.join('\n  '), kernels: {} };
            const rt = CLC.runtime(); Object.assign(rt, CLC.imageRuntime());
            rt.$fmod2 = (a, b) => { if (b === 0) return NaN; const r = a % b; return r !== 0 && (r < 0) !== (b < 0) ? r + b : r; };
            const prologue = Object.keys(rt).filter((k) => k[0] === '$').map((k) => 'const ' + k + '=$rt.' + k + ';').join('') + 'const $S=$rt.$S;\n';
            rt.$S = S;
            let mod; try { mod = new Function('$rt', prologue + c.code)(rt); } catch (e) { return { ok: false, log: 'SPIR-V 轉出的 JS 無法編譯：' + e.message + '\n' + c.code.slice(0, 600), kernels: {} }; }
            return { ok: true, kind: 'spv', log: '', kernels: c.kernels, mkptr: rt.mkptr, run: (name, args, gs, ls, off) => CLC.runKernel(rt, mod, c.kernels, name, args, gs, ls, off, c.gen), js: prologue + c.code, gen: c.gen };
        } catch (e) {
            if (e instanceof SpvError) return { ok: false, log: 'SPIR-V 建置失敗：' + e.message, kernels: {} };
            throw e;
        }
    }
    const VERSION = 1;
    function instantiate(art) {   // 從快取的產物重建（不解碼、不轉換）；規格常數已烘進 js
        const rt = CLC.runtime(); Object.assign(rt, CLC.imageRuntime());
        rt.$fmod2 = (a, b) => { if (b === 0) return NaN; const r = a % b; return r !== 0 && (r < 0) !== (b < 0) ? r + b : r; }; rt.$S = S;
        const mod = new Function('$rt', art.js)(rt);
        return { ok: true, kind: 'spv', log: '', kernels: art.kernels, mkptr: rt.mkptr, run: (name, args, gs, ls, off) => CLC.runKernel(rt, mod, art.kernels, name, args, gs, ls, off, art.gen), js: art.js, gen: art.gen };
    }
    return { VERSION, instantiate, compile, decode, SpvError, coerceScalar: CLC.coerceScalar };
});
