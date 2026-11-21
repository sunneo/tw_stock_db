/* SPIR-V → KIR（FaSpvKir，UMD，純邏輯）：把 SPIR-V 核心反編譯成 cudaweb 的 KIR（kir.js），讓 clCreateProgramWithIL 的程式也能走 GPU（WebGPU／WebGL2 的 KIR 裝置層）。
 * 子集與 source→KIR 前端（cl_front）相同：一維 gid、f32 緩衝區、f32／i32 純量、i32／f32 運算、從 0 數到常數或純量的 for、if（else 用旗標變數）、select、phi（用變數）。
 * 不在子集的核心回報原因，由載入器走主機路線（wasm／JS），不影響正確性。
 *   compile(il) → { ok:true, kernels:{ 名稱: { kir } | { reason } } } 或 { ok:false, log }
 * 吃的是 clc_spv（O0 風格：Function 變數、Load／Store、結構化合併）與一般 llvm-spirv 的簡單輸出。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./spv_tables.js'), require('./spv_js.js'));
    else root.FaSpvKir = factory(root.FaSpvTables, root.FaSpv);
})(typeof self !== 'undefined' ? self : this, function (T, SJ) {
    'use strict';
    const VERSION = 1;
    class Bail extends Error { constructor(m) { super(m); this.name = 'Bail'; } }
    const bail = (m) => { throw new Bail(m); };
    const OPN = {}; for (const [n, v] of Object.entries(T.ops)) OPN[v[0]] = n;
    const OCLN = {}; for (const [n, v] of Object.entries(T.oclOps)) OCLN[v[0]] = n;
    const strOf = (w, from) => { const b = []; for (let i = from; i < w.length; i++) for (let k = 0; k < 4; k++) { const c = (w[i] >>> (8 * k)) & 255; if (!c) return new TextDecoder().decode(Uint8Array.from(b)); b.push(c); } return new TextDecoder().decode(Uint8Array.from(b)); };
    const f32b = new Float32Array(1), u32b = new Uint32Array(f32b.buffer);
    const CMP = { SLessThan: '<', SLessThanEqual: '<=', SGreaterThan: '>', SGreaterThanEqual: '>=', IEqual: '==', INotEqual: '!=', FOrdLessThan: '<', FOrdLessThanEqual: '<=', FOrdGreaterThan: '>', FOrdGreaterThanEqual: '>=', FOrdEqual: '==', FOrdNotEqual: '!=', FUnordNotEqual: '!=', FUnordLessThan: '<', FUnordGreaterThan: '>', FUnordLessThanEqual: '<=', FUnordGreaterThanEqual: '>=', FUnordEqual: '==' };
    const ARITH = { IAdd: ['+', 'i32'], ISub: ['-', 'i32'], IMul: ['*', 'i32'], FAdd: ['+', 'f32'], FSub: ['-', 'f32'], FMul: ['*', 'f32'], FDiv: ['/', 'f32'], SDiv: ['/', 'i32'], SRem: ['%', 'i32'], SMod: ['%', 'i32'] };
    const EXT1 = { floor: 'floor', sqrt: 'sqrt', rsqrt: 'rsqrt', fabs: 'abs', exp: 'exp', sin: 'sin', cos: 'cos', native_sqrt: 'sqrt', native_rsqrt: 'rsqrt', native_exp: 'exp', native_sin: 'sin', native_cos: 'cos' };
    const EXT2 = { fmin: 'min', fmax: 'max', pow: 'pow' };

    function convertKernel(m, ep) {
        const { types, consts, insts, names, decos } = m;
        const fn = m.funcs.get(ep.fn); if (!fn) bail('找不到入口函式');
        // 參數：指標（CrossWorkgroup）→ f32 緩衝區；float／int 純量
        const params = [], paramOf = new Map(), usedNames = new Set(['gid']);
        const uniq = (base) => { let n = base.replace(/[^A-Za-z0-9_]/g, '_') || 'p'; if (/^\d/.test(n)) n = 'p' + n; while (usedNames.has(n)) n += '_'; usedNames.add(n); return n; };
        fn.params.forEach((p, i) => {
            const ty = types.get(p.type); const nm = uniq(names.get(p.id) || ('p' + i));
            if (ty.k === 'ptr') { if (ty.sc !== 5) bail('參數指標要在 global（CrossWorkgroup）'); const el = types.get(ty.to); if (el.k !== 'float' || el.w !== 32) bail('緩衝區元素不是 float'); const q = { kind: 'buf', name: nm, elem: 'f32', access: null }; params.push(q); paramOf.set(p.id, { buf: q }); }
            else if (ty.k === 'float' && ty.w === 32) { params.push({ kind: 'scalar', name: nm, type: 'f32' }); paramOf.set(p.id, { sc: nm, t: 'f32' }); }
            else if (ty.k === 'int' && ty.w === 32) { params.push({ kind: 'scalar', name: nm, type: 'i32' }); paramOf.set(p.id, { sc: nm, t: 'i32' }); }
            else bail('參數型別不支援（' + ty.k + (ty.w || '') + '）');
        });
        // 區塊
        const blocks = new Map(); let cur = null;
        for (const ins of fn.body) { if (ins.name === 'OpLabel') { cur = { id: ins.w[0], insts: [] }; blocks.set(cur.id, cur); } else if (cur) cur.insts.push(ins); }
        const entry = fn.body.find((i) => i.name === 'OpLabel').w[0];
        // 區域變數與它的 store 統計
        const vars = new Map();   // id → { type(pointee), stores:[], loads:0 }
        for (const b of blocks.values()) for (const ins of b.insts) if (ins.name === 'OpVariable' && ins.w[2] === 7) vars.set(ins.w[1], { id: ins.w[1], pty: types.get(ins.w[0]).to, stores: [], name: null });
        for (const b of blocks.values()) for (const ins of b.insts) if (ins.name === 'OpStore' && vars.has(ins.w[0])) vars.get(ins.w[0]).stores.push({ b: b.id, val: ins.w[1] });
        // 別名變數：唯一的 store 是參數值（O0 的「參數存進區域變數」）
        const alias = new Map();
        for (const v of vars.values()) if (v.stores.length === 1 && paramOf.has(v.stores[0].val) && v.stores[0].b === entry) alias.set(v.id, paramOf.get(v.stores[0].val));
        // 輸出：KIR 的敘述樹
        const top = [], declared = [];
        const val = new Map();   // SSA id → { t:'f32'|'i32'|'bool'|'i64'|'gvec'|'ptr', e, buf, idx }
        const ivMap = new Map(); let uid = 0;
        const fresh = (p) => uniq(p + (uid++));
        const phis = new Map();   // phi 結果 id → 變數名；phiIn: 目標區塊 → [{from, val, name, t}]
        const phiIn = new Map();
        for (const b of blocks.values()) for (const ins of b.insts) if (ins.name === 'OpPhi') {
            const t = tyTag(types, ins.w[0]); if (t !== 'f32' && t !== 'i32') bail('phi 型別不支援');
            const nm = fresh('ph'); phis.set(ins.w[1], { name: nm, t }); declared.push({ k: 'let', name: nm, t, e: { k: 'num', v: 0, t } });
            val.set(ins.w[1], { t, e: { k: 'var', name: nm, t } });
            if (!phiIn.has(b.id)) phiIn.set(b.id, []);
            for (let i = 2; i + 1 < ins.w.length; i += 2) phiIn.get(b.id).push({ val: ins.w[i], from: ins.w[i + 1], name: nm, t });
        }
        for (const v of vars.values()) {
            if (alias.has(v.id)) continue;
            const pt = types.get(v.pty); let t;
            if (pt.k === 'float' && pt.w === 32) t = 'f32'; else if (pt.k === 'int' && pt.w === 32) t = 'i32'; else bail('區域變數型別不支援');
            v.name = fresh('v'); v.t = t; declared.push({ k: 'let', name: v.name, t, e: { k: 'num', v: 0, t } });
        }
        const num = (v, t) => ({ k: 'num', v, t });
        const valOf = (id) => {
            if (val.has(id)) return val.get(id);
            if (paramOf.has(id)) { const p = paramOf.get(id); return p.buf ? { t: 'ptr', buf: p.buf, idx: null } : { t: p.t, e: { k: 'var', name: p.sc, t: p.t } }; }
            if (consts.has(id)) { const c = consts.get(id); const ty = types.get(c.type); if (ty.k === 'float' && ty.w === 32) { u32b[0] = c.lo >>> 0; return { t: 'f32', e: num(f32b[0], 'f32') }; } if (ty.k === 'int' && ty.w === 32) return { t: 'i32', e: num(c.lo | 0, 'i32') }; if (ty.k === 'int' && ty.w === 64) return { t: 'i64', e: num(c.lo | 0, 'i32') }; bail('常數型別不支援'); }
            return bail('用到還沒定義的值 %' + id);
        };
        const typed = (id, t) => { const x = valOf(id); const xt = x.t === 'i64' ? 'i32' : x.t; if (xt !== t) bail('型別不符：要 ' + t + '，得到 ' + x.t); return x.e; };
        const ptrOf = (id) => {
            const v = vars.get(id); if (v) return { var: v };
            const x = val.get(id); if (x && x.t === 'ptr') return x;
            const p = paramOf.get(id); if (p && p.buf) return { t: 'ptr', buf: p.buf, idx: null };
            return bail('指標來源不支援');
        };
        let out = null;   // 目前輸出的敘述陣列
        const emitLet = (id, t, e) => { const nm = fresh('t'); out.push({ k: 'let', name: nm, t, e }); val.set(id, { t, e: { k: 'var', name: nm, t } }); };
        const markAccess = (buf, a) => { if (buf.access && buf.access !== a) bail('緩衝區 ' + buf.name + ' 同時讀寫（KIR 不允許）'); buf.access = a; };

        function runInst(ins, blk) {
            const w = ins.w, n = ins.name;
            if (n === 'OpVariable' || n === 'OpName' || n === 'OpPhi' || n === 'OpLine' || n === 'OpNoLine') return;
            if (n === 'OpLoad') {
                const rt = w[0], id = w[1], p = w[2]; const pv = types.get(rt);
                if (m.builtinVars.has(p)) { if (m.builtinVars.get(p) !== 28) bail('只支援 GlobalInvocationId'); val.set(id, { t: 'gvec' }); return; }
                if (vars.has(p)) {
                    const v = vars.get(p);
                    if (alias.has(p)) { const a = alias.get(p); val.set(id, a.buf ? { t: 'ptr', buf: a.buf, idx: null } : { t: a.t, e: { k: 'var', name: a.sc, t: a.t } }); return; }
                    if (ivMap.has(p)) { val.set(id, { t: 'i32', e: { k: 'var', name: ivMap.get(p), t: 'i32' } }); return; }
                    if (!v.name) bail('讀指標型別的區域變數');
                    emitLet(id, v.t, { k: 'var', name: v.name, t: v.t }); return;
                }
                const q = ptrOf(p); if (q.var) bail('讀變數');
                if (pv.k !== 'float' || pv.w !== 32) bail('只能讀 float 緩衝區元素'); if (q.idx == null) bail('指標沒有索引');
                markAccess(q.buf, 'in'); emitLet(id, 'f32', { k: 'load', buf: q.buf.name, idx: q.idx, comp: null }); return;
            }
            if (n === 'OpStore') {
                const p = w[0], x = w[1];
                if (vars.has(p)) {
                    if (alias.has(p)) return;
                    const v = vars.get(p); if (ivMap.has(p)) bail('迴圈變數在迴圈內被改寫');
                    out.push({ k: 'set', name: v.name, e: typed(x, v.t) }); return;
                }
                const q = ptrOf(p); if (q.var || q.idx == null) bail('寫入目標不支援');
                markAccess(q.buf, 'out'); out.push({ k: 'store', buf: q.buf.name, idx: q.idx, e: typed(x, 'f32') }); return;
            }
            if (n === 'OpInBoundsPtrAccessChain' || n === 'OpPtrAccessChain' || n === 'OpAccessChain' || n === 'OpInBoundsAccessChain') {
                const base = ptrOf(w[2]); if (base.var || base.idx != null) bail('巢狀指標運算不支援');
                const isPtrAcc = n.endsWith('PtrAccessChain'); const idxIds = w.slice(3);
                if (isPtrAcc) { if (idxIds.length !== 1) bail('PtrAccessChain 只支援一個索引'); val.set(w[1], { t: 'ptr', buf: base.buf, idx: typed(idxIds[0], 'i32') }); }
                else { if (idxIds.length !== 1) bail('AccessChain 只支援一個索引'); val.set(w[1], { t: 'ptr', buf: base.buf, idx: typed(idxIds[0], 'i32') }); }
                return;
            }
            if (n === 'OpVectorExtractDynamic' || n === 'OpCompositeExtract') {
                const src = valOf(w[2]); if (src.t !== 'gvec') bail('向量運算只支援 gid');
                let idx; if (n === 'OpCompositeExtract') idx = w[3]; else { const c = valOf(w[3]); if (c.e.k !== 'num') bail('gid 維度不是常數'); idx = c.e.v; }
                if (idx !== 0) bail('只支援一維（get_global_id(0)）'); val.set(w[1], { t: 'i64', e: { k: 'gid' } }); return;
            }
            if (n === 'OpUConvert' || n === 'OpSConvert') { const x = valOf(w[2]); if (x.t !== 'i32' && x.t !== 'i64') bail('整數轉換的來源'); val.set(w[1], { t: types.get(w[0]).w === 64 ? 'i64' : 'i32', e: x.e }); return; }
            if (n === 'OpBitcast') { const x = valOf(w[2]); const to = tyTag(types, w[0]); if (x.t === to || (x.t === 'i64' && to === 'i32')) { val.set(w[1], { t: to, e: x.e }); return; } bail('Bitcast 不支援'); }
            if (ARITH[n.slice(2)]) { const [op, t] = ARITH[n.slice(2)]; emitLet(w[1], t, { k: 'bin', op, a: typed(w[2], t), b: typed(w[3], t), t }); return; }
            if (n === 'OpFNegate') { emitLet(w[1], 'f32', { k: 'bin', op: '-', a: num(0, 'f32'), b: typed(w[2], 'f32'), t: 'f32' }); return; }
            if (n === 'OpSNegate') { emitLet(w[1], 'i32', { k: 'bin', op: '-', a: num(0, 'i32'), b: typed(w[2], 'i32'), t: 'i32' }); return; }
            if (n === 'OpConvertSToF') { emitLet(w[1], 'f32', { k: 'cast', to: 'f32', a: typed(w[2], 'i32') }); return; }
            if (n === 'OpConvertFToS') { emitLet(w[1], 'i32', { k: 'cast', to: 'i32', a: typed(w[2], 'f32') }); return; }
            if (CMP[n.slice(2)]) {
                const a = valOf(w[2]); const t = a.t === 'f32' ? 'f32' : 'i32';
                val.set(w[1], { t: 'bool', e: { k: 'cmp', op: CMP[n.slice(2)], a: typed(w[2], t), b: typed(w[3], t) } }); return;
            }
            if (n === 'OpSelect') { const c = valOf(w[2]); if (c.t !== 'bool') bail('select 的條件'); const t = tyTag(types, w[0]); if (t !== 'f32' && t !== 'i32') bail('select 型別'); emitLet(w[1], t, { k: 'sel', c: c.e, a: typed(w[3], t), b: typed(w[4], t), t }); return; }
            if (n === 'OpExtInst') {
                const nm = OCLN[w[3]]; if (!nm) bail('不認得的 OpenCL.std 指令 ' + w[3]);
                const args = w.slice(4);
                if (EXT1[nm]) { emitLet(w[1], 'f32', { k: 'call', fn: EXT1[nm], args: [typed(args[0], 'f32')], t: 'f32' }); return; }
                if (EXT2[nm]) { emitLet(w[1], 'f32', { k: 'call', fn: EXT2[nm], args: [typed(args[0], 'f32'), typed(args[1], 'f32')], t: 'f32' }); return; }
                if (nm === 'fma' || nm === 'mad') { const m1 = { k: 'bin', op: '*', a: typed(args[0], 'f32'), b: typed(args[1], 'f32'), t: 'f32' }; emitLet(w[1], 'f32', { k: 'bin', op: '+', a: m1, b: typed(args[2], 'f32'), t: 'f32' }); return; }
                bail('OpenCL.std ' + nm + ' 不在 KIR 子集'); return;
            }
            bail('指令 ' + n + ' 不在 KIR 子集');
        }
        const phiSets = (from, to) => { for (const p of phiIn.get(to) || []) if (p.from === from) out.push({ k: 'set', name: p.name, e: typed(p.val, p.t) }); };
        const termOf = (b) => b.insts[b.insts.length - 1];

        // 迴圈：for (v = 0; v < bound; v++)
        function emitLoop(hdr, lm) {
            const merge = lm.w[0], cont = lm.w[1];
            const hi = hdr.insts, br = hi[hi.length - 1];
            if (br.name !== 'OpBranchConditional') bail('迴圈標頭不是條件分支');
            if ((phiIn.get(hdr.id) || []).length) bail('迴圈標頭有 phi');
            const bodyL = br.w[1], exitL = br.w[2]; if (exitL !== merge) bail('迴圈的離開分支不是 merge');
            // 標頭：Load iv（與上界的 Load）; SLessThan; LoopMerge; Branch
            const cmpI = hi.filter((i) => i.name === 'OpSLessThan'); const loads = hi.filter((i) => i.name === 'OpLoad');
            if (cmpI.length !== 1 || hi.filter((i) => i.name !== 'OpLabel' && i.name !== 'OpLoad' && i.name !== 'OpSLessThan' && i.name !== 'OpLoopMerge' && i.name !== 'OpBranchConditional').length) bail('迴圈條件不是「i < 上界」');
            const ldIv = loads.find((l) => l.w[1] === cmpI[0].w[2]); if (!ldIv) bail('迴圈條件的左邊不是迴圈變數');
            const ivId = ldIv.w[2]; const iv = vars.get(ivId); if (!iv || iv.t !== 'i32' || alias.has(ivId)) bail('迴圈變數');
            for (const l of loads) if (l !== ldIv) runInst(l);
            const bnd = valOf(cmpI[0].w[3]);
            let bound; if (bnd.e && bnd.e.k === 'num') bound = bnd.e.v; else if (bnd.e && bnd.e.k === 'var' && params.some((p) => p.kind === 'scalar' && p.type === 'i32' && p.name === bnd.e.name)) bound = bnd.e.name; else bail('迴圈上界要是常數或 i32 純量');
            if (typeof bound === 'number' && bound < 0) bail('負的上界');
            // 起點要是 0：進入標頭前，目前區塊最後一次對 iv 的 store 是常數 0
            const lastSt = [...out].reverse().find((s) => s.k === 'set' && s.name === iv.name);
            if (!lastSt || lastSt.e.k !== 'num' || lastSt.e.v !== 0) bail('迴圈起點不是常數 0');
            // continue 區塊：Load iv; IAdd 1; Store iv; Branch hdr
            const cb = blocks.get(cont); const ci = cb.insts.filter((i) => i.name !== 'OpLabel');
            if (ci.length !== 4 || ci[0].name !== 'OpLoad' || ci[0].w[2] !== ivId || ci[1].name !== 'OpIAdd' || ci[1].w[2] !== ci[0].w[1] || ci[2].name !== 'OpStore' || ci[2].w[0] !== ivId || ci[2].w[1] !== ci[1].w[1] || ci[3].name !== 'OpBranch' || ci[3].w[0] !== hdr.id) bail('迴圈的遞增不是 i++');
            const one = valOf(ci[1].w[3]); if (!one.e || one.e.k !== 'num' || one.e.v !== 1) bail('迴圈步進不是 1');
            const lv = fresh('i'); ivMap.set(ivId, lv);
            const saved = out; const stmts = []; out = stmts;
            walk(bodyL, cont, hdr.id);
            out = saved; ivMap.delete(ivId);
            out.push({ k: 'for', v: lv, bound, body: stmts });
            // 迴圈後 iv 的值：max(0, bound)
            const bexp = typeof bound === 'number' ? num(bound, 'i32') : { k: 'var', name: bound, t: 'i32' };
            out.push({ k: 'set', name: iv.name, e: { k: 'sel', c: { k: 'cmp', op: '>', a: bexp, b: num(0, 'i32') }, a: bexp, b: num(0, 'i32'), t: 'i32' } });
            return merge;
        }

        // 走一段區域：從 label 走到 stop（不含）。from＝進入這段時的前一個區塊（給 phi 用）
        function walk(label, stop, from) {
            let prev = from;
            for (let guard = 0; guard < 100000; guard++) {
                if (label === stop) { phiSets(prev, stop); return; }
                const b = blocks.get(label); if (!b) bail('不存在的區塊');
                if (b.insts.length) {
                    const t = termOf(b);
                    // 先跑一般指令（保持順序）；迴圈標頭另外處理
                    const lmIdx = b.insts.findIndex((i) => i.name === 'OpLoopMerge');
                    if (lmIdx >= 0) { const merge = emitLoop(b, b.insts[lmIdx]); prev = label; label = merge; prev = label; /* 合併區塊的 phi 來自迴圈：不支援 */ if ((phiIn.get(merge) || []).length) bail('迴圈合併區塊有 phi'); continue; }
                    for (const ins of b.insts) { if (ins === t || ins.name === 'OpSelectionMerge') continue; runInst(ins, b); }
                    const smI = b.insts.find((i) => i.name === 'OpSelectionMerge');
                    if (t.name === 'OpBranch') { phiSets(label, t.w[0]); if (t.w[0] === stop) return; prev = label; label = t.w[0]; continue; }
                    if (t.name === 'OpReturn') return 'ret';
                    if (t.name === 'OpBranchConditional') {
                        if (!smI) bail('沒有結構化合併的條件分支');
                        const M = smI.w[0]; const c = valOf(t.w[0]); if (c.t !== 'bool') bail('分支條件不是比較式');
                        const Tl = t.w[1], Fl = t.w[2];
                        const isRet = (l) => { const x = blocks.get(l); return x && x.insts.length === 1 && x.insts[0].name === 'OpReturn'; };
                        if (isRet(Tl) || isRet(Fl)) {   // if (c) return; 其餘只在「沒提早離開」時做：用旗標包起來（只允許在函式最外層）
                            if (stop !== null) bail('巢狀區域內提早 return');
                            const retSide = isRet(Tl), other = retSide ? Fl : Tl;
                            const fl = fresh('f'); out.push({ k: 'let', name: fl, t: 'i32', e: num(retSide ? 1 : 0, 'i32') });
                            out.push({ k: 'if', c: c.e, body: [{ k: 'set', name: fl, e: num(retSide ? 0 : 1, 'i32') }] });
                            const saved = out; const stmts = []; out = stmts; walk(other, stop, label); out = saved;
                            out.push({ k: 'if', c: { k: 'cmp', op: '==', a: { k: 'var', name: fl, t: 'i32' }, b: num(1, 'i32') }, body: stmts });
                            return 'ret';
                        }
                        const hasElse = Fl !== M, saved0 = out;
                        let flag = null;
                        if (hasElse) { flag = fresh('f'); out.push({ k: 'let', name: flag, t: 'i32', e: num(0, 'i32') }); }
                        const thenS = [];
                        out = thenS; if (hasElse) out.push({ k: 'set', name: flag, e: num(1, 'i32') });
                        const r1 = walk(Tl, M, label); out = saved0;
                        if (r1 === 'ret') bail('分支內提早 return');
                        saved0.push({ k: 'if', c: c.e, body: thenS });
                        if (hasElse) {
                            const elseS = []; out = elseS; const r2 = walk(Fl, M, label); out = saved0; if (r2 === 'ret') bail('分支內提早 return');
                            saved0.push({ k: 'if', c: { k: 'cmp', op: '==', a: { k: 'var', name: flag, t: 'i32' }, b: num(0, 'i32') }, body: elseS });
                        }
                        prev = label; label = M; if (M === stop) { return; } continue;
                    }
                    bail('終結指令 ' + t.name + ' 不支援');
                }
            }
            bail('區塊太多（可能有迴圈沒結構化）');
        }
        out = top; walk(entry, null, null);
        for (const p of params) if (p.kind === 'buf' && !p.access) p.access = 'in';
        return { name: ep.name, params, body: declared.concat(top) };
    }

    function tyTag(types, id) { const t = types.get(id); if (!t) return null; if (t.k === 'float' && t.w === 32) return 'f32'; if (t.k === 'int' && t.w === 32) return 'i32'; if (t.k === 'bool') return 'bool'; return t.k; }

    function parse(il) {
        const d = SJ.internals.decode(il);
        const types = new Map(), consts = new Map(), names = new Map(), builtinVars = new Map(), funcs = new Map(), eps = [];
        let curFn = null; const insts = [];
        for (const ins of d.insts) {
            const name = OPN[ins.op] || ('Op' + ins.op), w = ins.w; const I = { name, w }; insts.push(I);
            switch (name) {
                case 'OpTypeVoid': types.set(w[0], { k: 'void' }); break;
                case 'OpTypeBool': types.set(w[0], { k: 'bool' }); break;
                case 'OpTypeInt': types.set(w[0], { k: 'int', w: w[1] }); break;
                case 'OpTypeFloat': types.set(w[0], { k: 'float', w: w[1] }); break;
                case 'OpTypeVector': types.set(w[0], { k: 'vec', of: w[1], n: w[2] }); break;
                case 'OpTypePointer': types.set(w[0], { k: 'ptr', sc: w[1], to: w[2] }); break;
                case 'OpTypeFunction': types.set(w[0], { k: 'fn' }); break;
                case 'OpConstant': consts.set(w[1], { type: w[0], lo: w[2], hi: w[3] || 0 }); break;
                case 'OpName': names.set(w[0], strOf(w, 1)); break;
                case 'OpDecorate': if (w[1] === 11) builtinVars.set(w[0], w[2]); break;   // BuiltIn
                case 'OpEntryPoint': if (w[0] === 6) eps.push({ fn: w[1], name: strOf(w, 2) }); break;
                case 'OpFunction': curFn = { id: w[1], params: [], body: [] }; funcs.set(w[1], curFn); break;
                case 'OpFunctionParameter': curFn.params.push({ type: w[0], id: w[1] }); break;
                case 'OpFunctionEnd': curFn = null; break;
                default: if (curFn) curFn.body.push(I);
            }
            if (curFn && name === 'OpFunctionParameter') continue;
            if (curFn && name === 'OpLabel') curFn.body.push(I);
        }
        // builtin 變數：OpVariable 的 id 要有 BuiltIn 裝飾（decorate 的目標是變數 id）
        return { types, consts, names, builtinVars, funcs, eps, insts, decos: null };
    }

    function compile(il) {
        let m; try { m = parse(il); } catch (e) { return { ok: false, log: 'SPIR-V 解析失敗：' + e.message }; }
        const kernels = {};
        for (const ep of m.eps) {
            try { kernels[ep.name] = { kir: convertKernel(m, ep) }; } catch (e) { if (e instanceof Bail) kernels[ep.name] = { reason: e.message }; else kernels[ep.name] = { reason: '轉換出錯：' + e.message }; }
        }
        return { ok: true, kernels };
    }
    return { VERSION, compile };
});
