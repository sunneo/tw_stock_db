/* 矩陣 → Blockly 區塊（DESIGN.matrix-fallback.md §11.2～11.4，路 B）：把矩陣層合成出的程式，依「矩陣形態」拆成有名字的段落，每段是現有範本庫（py_blocks_core）的區塊，
 * 使用者可以在區塊上改（轉移表、接受集、係數、初值、取模；組合層可換向量／過濾／歸約積木），再編回 Python、交判題器重驗。純函式 UMD，Python 專屬。
 *   makeMatrixBlocks({B, C2U, parseTree, CP}) → M       B＝py_blocks_core.makeBlocks(...) 的結果；CP＝matrix_compose_core（組合層換積木才需要）
 *   M.decompile(res) → dec | {ok:false, reason}
 *       dec = { ok, kind, form, ops:[{name, params, blocks}], main:'main', segments:[{role, title, blocks}] }
 *       segments 是 main 區塊序列的分段（concat 起來 ＝ main 的區塊）；role：read／table／start／scan／graph／compute／vector／filter／reduce／print…
 *   M.compile(dec) → Python 原始碼（區塊 → 敘述 IR → Python；其他 def 也一起）
 *   M.cnl(dec) → 每段一個標題＋受控自然語言（給使用者看／貼回）
 *   M.readForm(dec) → 從區塊讀回形態（dfa／recurrence／compose），讀不回來回 null＝離開矩陣模式
 *   M.setForm(dec, patch) → 新的 dec：只改槽位內容（dfa：delta／start／accept；recurrence：coef／init／mod），其餘區塊原樣
 *   M.setCompose(dec, {vector, filter, reducer}) → 新的 dec：換掉向量／過濾／歸約三段（輸出型態要一樣；不同型態回 {ok:false}）
 * 往返要求（測試條件）：矩陣合成 → 區塊 → Python 與原程式在隨機輸入上輸出一致；改槽位後輸出照新形態的定義變。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixBlocks = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const clone = (x) => JSON.parse(JSON.stringify(x));
    function makeMatrixBlocks(env) {
        const { B, C2U, parseTree } = env; const CP = env.CP || null;
        const modelOf = (src) => { const tree = parseTree(src); if (!tree || tree.rootNode.hasError()) return null; return C2U.fromTree(tree.rootNode, { source: src }).model; };
        const stmtsOf = (src) => B.stmtsOfSource(src);
        const line1 = (b) => B.toCNL([b]).split('\n')[0];
        const pyOf = (b) => { try { return C2U.toPython({ name: 'M', classes: [], relations: [], prelude: B.toIR([b]), order: [] }); } catch (e) { return ''; } };
        const isAssignTo = (b, name) => b && b.slots && b.slots.x && b.slots.x.n === 'name' && b.slots.x.v === name;
        const isPrint = (b) => b && (/^print_/.test(b.t) || (b.t === 'stmt' && /^print\(/.test(pyOf(b).trim())));
        const isRead = (b) => b && (/^read_/.test(b.t) || (b.t === 'stmt' && /input\(\)/.test(pyOf(b))) || (b.t === 'assign' && /input\(\)/.test(pyOf(b))) || (b.t === 'to_int' && /input\(\)|h\[/.test(pyOf(b))) || (b.t === 'stmt' && /^\w+ = int\(h\[\d+\]\)/.test(pyOf(b).trim())));
        const findIdx = (bl, f, from) => { for (let i = from || 0; i < bl.length; i++) if (f(bl[i], i)) return i; return -1; };

        // ---- 段落 ----
        const seg = (role, title, blocks) => ({ role, title, blocks });
        function splitComments(src) { // 組合層：依「# 向量／過濾／歸約」註解把 main 的本體拆成文字段
            const L = String(src).replace(/\n+$/, '').split('\n'); if (!/^def main\(\):/.test(L[0])) return null; const marks = []; L.forEach((l, i) => { const m = /^ {4}# (向量|過濾|歸約)/.exec(l); if (m) marks.push([i, m[1]]); }); if (marks.length !== 3) return null;
            const chunk = (a, b) => L.slice(a, b).map((l) => l.replace(/^ {4}/, '')).filter((l) => !/^\s*#/.test(l)).join('\n') + '\n';
            const printAt = L.findIndex((l, i) => i > marks[2][0] && /^ {4}print\(/.test(l)); if (printAt < 0) return null;
            const redStmtEnd = printAt; return { pre: chunk(1, marks[0][0]), vector: chunk(marks[0][0] + 1, marks[1][0]), filter: chunk(marks[1][0] + 1, marks[2][0]), reduce: chunk(marks[2][0] + 1, redStmtEnd), out: chunk(printAt, L.length) };
        }
        function composeSegments(src) {
            const s = splitComments(src); if (!s) return null; const out = []; const names = [['pre', 'read', '讀入與前置（讀入輸入、建圖或格子）'], ['vector', 'vector', '向量積木（把輸入變成每個節點／每列一個數）'], ['filter', 'filter', '過濾（全部／只看 ≥ 0／只看 > 0）'], ['reduce', 'reduce', '歸約積木（向量 → 答案）'], ['out', 'print', '輸出']];
            for (const [k, role, title] of names) { const st = s[k].trim() ? stmtsOf(s[k]) : []; if (!st) return null; out.push(seg(role, title, B.fromIR(st))); } return out;
        }
        function landmarkSegments(kind, bl) {
            const segs = []; let i = 0; const take = (role, title, n) => { if (n > 0) { segs.push(seg(role, title, bl.slice(i, i + n))); i += n; } };
            let nRead = 0; while (nRead < bl.length && isRead(bl[nRead])) nRead++;
            let nOut = 0; while (nOut < bl.length - nRead && isPrint(bl[bl.length - 1 - nOut])) nOut++;
            if (kind === 'dfa') {
                const ti = findIdx(bl, (b) => isAssignTo(b, 'T')); const qi = findIdx(bl, (b) => isAssignTo(b, 'q')); const fi = findIdx(bl, (b) => b.t === 'for_each', Math.max(ti, qi));
                if (ti < 0 || qi < 0 || fi < 0) return null; take('read', '讀入輸入', ti); take('table', '轉移表 T[狀態][字元]＝下一個狀態', qi - ti); take('start', '起點狀態', fi - qi); take('scan', '掃描輸入：逐字轉移', bl.length - nOut - fi); take('print', '輸出（q 在接受集裡的判斷）', nOut); return segs;
            }
            if (kind === 'recurrence') {
                const ci = findIdx(bl, (b) => isAssignTo(b, 'coef')); const ii = findIdx(bl, (b) => isAssignTo(b, 'init')); if (ci < 0 || ii < 0) return null; const first = Math.min(ci, ii);
                take('read', '讀入輸入', first); take('params', '係數、初值、取模', bl.length - nOut - first); take('print', '輸出', nOut); return segs;
            }
            if (kind === 'graph') { const ai = findIdx(bl, (b) => isAssignTo(b, 'adj')); if (ai >= 0 && ai >= nRead) { const fi = findIdx(bl, (b) => b.t === 'for_each' && /\bE\b/.test(pyOf(b).split('\n')[0]), ai); if (fi >= 0) { take('read', '讀入輸入', ai); take('graph', '建圖（鄰接表）', fi + 1 - ai); take('compute', '圖演算法（走訪／半環）', bl.length - nOut - fi - 1); take('print', '輸出', nOut); return segs; } } }
            take('read', '讀入輸入', nRead); take('compute', '計算', bl.length - nRead - nOut); take('print', '輸出', nOut); return segs;
        }

        // ---- 分解 ----
        function decompile(res) {
            if (!res || !res.ok || !res.source) return { ok: false, reason: '沒有合成結果' };
            const form = res.matrixForm || {}; const kind = form.kind || 'other'; const model = modelOf(res.source); if (!model || !model.classes.length) return { ok: false, reason: '程式解析失敗' };
            const ops = model.classes[0].ops.map((o) => ({ name: o.name, params: o.params, blocks: B.fromIR(o.body) })); const mi = ops.findIndex((o) => o.name === 'main'); if (mi < 0) return { ok: false, reason: '沒有 main' };
            let segments = null; if (kind === 'compose') { segments = composeSegments(res.source); if (segments) ops[mi].blocks = [].concat(...segments.map((s) => s.blocks)); } if (!segments) segments = landmarkSegments(kind, ops[mi].blocks);
            if (!segments) segments = [seg('compute', '整段程式（形態無法再細分）', ops[mi].blocks)];
            const raw = ops.reduce((n, o) => n + B.stats(o.blocks).generic, 0), all = ops.reduce((n, o) => n + B.stats(o.blocks).blocks, 0);
            return { ok: true, kind, form: clone(form), model, ops, segments, stats: { blocks: all, generic: raw } };
        }
        const flat = (dec) => [].concat(...dec.segments.map((s) => s.blocks));
        function syncMain(dec) { const m = dec.ops.find((o) => o.name === 'main'); m.blocks = flat(dec); return dec; }
        function compile(dec) {
            syncMain(dec); const m = clone(dec.model); const bodies = {}; for (const d of dec.ops) bodies[d.name] = B.toIR(d.blocks);
            // toPython 依 model.order 輸出（order 裡的函式物件 clone 後是另一份），所以 ops 與 order 兩邊都要換本體
            for (const o of m.classes[0].ops) if (bodies[o.name]) o.body = bodies[o.name]; for (const it of m.order || []) if (it.t === 'f' && bodies[it.o.name]) it.o.body = bodies[it.o.name];
            return C2U.toPython(m);
        }
        function cnl(dec) { const out = []; for (const o of dec.ops) { if (o.name !== 'main') { out.push('【函式 ' + o.name + '】'); out.push(B.toCNL(o.blocks)); } } for (const s of dec.segments) { out.push('【' + s.title + '】'); out.push(B.toCNL(s.blocks)); } return out.filter((l) => l !== '').join('\n'); }

        // ---- 形態讀寫（在區塊的槽位上）----
        const pyLit = (txt) => { try { return JSON.parse(String(txt).replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')); } catch (e) { return undefined; } };
        const slotLit = (b) => (b ? pyLit(B.exprText(b.slots.e)) : undefined);
        const walkBlocks = (bl, f) => { for (const b of bl) { f(b); if (b.t === 'if') { b.branches.forEach((x) => walkBlocks(x.body, f)); if (b.els) walkBlocks(b.els, f); } else if (b.bodies) Object.values(b.bodies).forEach((x) => walkBlocks(x, f)); } };
        function acceptBlock(dec) { let hit = null; walkBlocks(flat(dec), (b) => { if (hit) return; for (const k of Object.keys(b.slots || {})) { if (b.slots[k] && typeof b.slots[k] === 'object' && /\bq in \[[\d, ]*\]/.test(B.exprText(b.slots[k]))) { hit = { b, k }; return; } } }); return hit; }
        function readForm(dec) {
            const bl = flat(dec); const get = (n) => bl.find((b) => isAssignTo(b, n));
            if (dec.kind === 'dfa') { const T = slotLit(get('T')), q = slotLit(get('q')); if (!Array.isArray(T) || typeof q !== 'number' || !T.every((r) => r && typeof r === 'object')) return null; const o = { kind: 'dfa', start: q, delta: T }; const a = acceptBlock(dec); if (a) o.accept = pyLit(/\bq in (\[[\d, ]*\])/.exec(B.exprText(a.b.slots[a.k]))[1]); return o; }
            if (dec.kind === 'recurrence') { const c = slotLit(get('coef')), i = slotLit(get('init')); if (!Array.isArray(c) || !Array.isArray(i)) return null; const m = get('M'); const mv = m ? slotLit(m) : null; return { kind: 'recurrence', coef: c, init: i, offset: dec.form.offset || 0, mod: typeof mv === 'number' ? mv : null }; }
            if (dec.kind === 'compose') return clone(dec.form); return null;
        }
        const setSlot = (b, text) => { const e = B.exprOf(text); if (!e) throw new Error('槽位不是合法運算式：' + text); b.slots.e = e; };
        const dumpDelta = (d) => '[' + d.map((r) => '{' + Object.keys(r).map((c) => JSON.stringify(c) + ': ' + r[c]).join(', ') + '}').join(', ') + ']';
        function setForm(dec, patch) {
            const d = { ok: true, kind: dec.kind, form: clone(dec.form), model: dec.model, ops: clone(dec.ops), segments: clone(dec.segments), stats: dec.stats }; const bl = flat(d); const get = (n) => bl.find((b) => isAssignTo(b, n));
            try {
                if (d.kind === 'dfa') {
                    if (patch.delta) { const b = get('T'); if (!b) return { ok: false, reason: '找不到轉移表區塊' }; setSlot(b, dumpDelta(patch.delta)); }
                    if (patch.start != null) { const b = get('q'); if (!b) return { ok: false, reason: '找不到起點區塊' }; setSlot(b, String(patch.start)); }
                    if (patch.accept) { const a = acceptBlock(d); if (!a) return { ok: false, reason: '找不到接受集的判斷' }; a.b.slots[a.k] = B.exprOf(B.exprText(a.b.slots[a.k]).replace(/\bq in \[[\d, ]*\]/, 'q in ' + JSON.stringify(patch.accept))); }
                } else if (d.kind === 'recurrence') {
                    if (patch.coef) { const b = get('coef'); if (!b) return { ok: false, reason: '找不到係數區塊' }; setSlot(b, JSON.stringify(patch.coef)); const dd = get('d'); if (dd) setSlot(dd, String(patch.coef.length)); }
                    if (patch.init) { const b = get('init'); if (!b) return { ok: false, reason: '找不到初值區塊' }; setSlot(b, JSON.stringify(patch.init)); }
                    if (patch.mod !== undefined) { const b = get('M'); if (!b) return { ok: false, reason: '找不到取模區塊' }; setSlot(b, patch.mod == null ? 'None' : String(patch.mod)); }
                } else return { ok: false, reason: '這種形態沒有可直接改的槽位：' + d.kind };
            } catch (e) { return { ok: false, reason: String(e.message || e) }; }
            const f = readForm(d); if (!f) return { ok: false, reason: '改完讀不回形態（離開矩陣模式，請當一般區塊編輯）' }; d.form = Object.assign(d.form, f); return d;
        }
        // 組合層：換掉三段積木
        function setCompose(dec, sel) {
            if (dec.kind !== 'compose' || !CP) return { ok: false, reason: '不是組合層結果' };
            const V = CP.GV.find((x) => x.id === (sel.vector || dec.form.vector)), R = CP.RD.find((x) => x.id === (sel.reducer || dec.form.reducer)), fid = sel.filter || dec.form.filter; const F = CP.FLT.find((x) => x[0] === fid);
            if (!V || !R || !F) return { ok: false, reason: '沒有這個積木' }; const cur = CP.RD.find((x) => x.id === dec.form.reducer); if (cur && cur.out !== R.out) return { ok: false, reason: '輸出型態不同（' + cur.out + ' → ' + R.out + '），要連輸出段一起改，請改用一般區塊編輯' };
            if ((V.uses === 'graph') !== (CP.GV.find((x) => x.id === dec.form.vector).uses === 'graph')) return { ok: false, reason: '圖與格子的向量積木不能互換' };
            const d = { ok: true, kind: 'compose', form: Object.assign(clone(dec.form), { vector: V.id, filter: fid, reducer: R.id }), model: dec.model, ops: clone(dec.ops), segments: clone(dec.segments), stats: dec.stats };
            const ch = dec.segments.find((s) => s.role === 'vector'); let vpy = typeof V.py === 'function' ? V.py(sel.ch || 'x') : V.py; if (typeof V.py === 'function' && !sel.ch) return { ok: false, reason: '這個向量積木需要指定字元（ch）' };
            const part = (role, lines) => { const s = d.segments.find((x) => x.role === role); const st = stmtsOf(lines.join('\n') + '\n'); if (!st) throw new Error('積木程式解析失敗'); s.blocks = B.fromIR(st); };
            try { part('vector', vpy); part('filter', [F[2], 'idx = [i for i, x in enumerate(vec) if ' + (fid === 'all' ? 'True' : fid === 'ge0' ? 'x >= 0' : 'x > 0') + ']', 'BASE = ' + (dec.form.base == null ? String(baseOf(dec)) : dec.form.base)]); part('reduce', [R.py]); } catch (e) { return { ok: false, reason: String(e.message || e) }; }
            return d;
        }
        function baseOf(dec) { const b = flat(dec).find((x) => isAssignTo(x, 'BASE')); return b ? B.exprText(b.slots.e) : '0'; }
        return { decompile, compile, cnl, readForm, setForm, setCompose, flat };
    }
    return { makeMatrixBlocks };
});
