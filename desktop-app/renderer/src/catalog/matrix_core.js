/* 型別接線矩陣與路徑搜尋（UMD，純函式）：由單元目錄（FaCatalog）的參數型別與回傳型別，算出「單元 A 的輸出接得上單元 B 的哪個輸入」的鄰接矩陣，
 * 用布林矩陣連乘找出「從起始型別走到目標型別」的前 K 條接線（pipeline），並給每條一個接線合法度得分。設計見 DESIGN.unit-catalog.md。
 * 模型不參與：這一層是純程式，模型之後只在排序與填參數時介入。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog_core.js'));
    else root.FaCatalogMatrix = factory(root.FaCatalog || (typeof FaCatalog !== 'undefined' ? FaCatalog : undefined));
})(typeof self !== 'undefined' ? self : this, function (Cat) {
    'use strict';

    // ===== 型別的「具體程度」：越具體，接得上越有意義（text 接 text 幾乎什麼都接得上，不能當作有意義的接線）=====
    const SPEC = { bytes: 0.3, callable: 0, file_id: 1, pdf_file: 1, video_file: 1, audio_file: 1, image_file: 1, gif_file: 1, subtitle_file: 1, path: 1, url: 1, yaml: 1, code: 0.9, query: 0.3, text: 0.15, number: 0.1, int: 0.12, bool: 0.1, dict: 0, json: 0, any: 0, null: 0 };
    function spec(t) {
        if (typeof t === 'string') t = Cat.parseType(t);
        if (t.k === 'list') { const s = spec(t.of); return s >= 0.5 ? 0.6 : (s > 0 ? 0.25 : 0.1); }
        if (t.k === 'enum') return 0.6;
        if (t.k === 'object') { const ks = Object.keys(t.fields); return ks.length ? Math.min(0.8, 0.4 + 0.1 * ks.length) : 0.1; }
        if (t.k === 'union') return Math.max(0, ...t.of.map(spec)) * 0.8;
        return SPEC[t.k] !== undefined ? SPEC[t.k] : 0.2;
    }
    // 輸出 o 能接到輸入 p 的程度（0＝接不上；越具體越高）。比較的是「接收端要的型別」的具體程度，因為接收端決定了這次接線有多有意義。
    function matchScore(out, inp) {
        if (typeof out === 'string') out = Cat.parseType(out); if (typeof inp === 'string') inp = Cat.parseType(inp);
        if (out.k === 'any' || (out.k === 'json' && inp.k !== 'dict' && inp.k !== 'json' && inp.k !== 'list')) return 0; // 不明的輸出不接任何具體輸入
        if (!Cat.isAssignable(out, inp)) { if (out.k === 'file_id' && /_file$/.test(inp.k)) return 0.5; return 0; } // 種類不明的 file_id 可以接到指定種類的位置，但只有一半把握（要使用者或執行時確認）
        const looseElem = (t) => t.k === 'any' || t.k === 'json' || (t.k === 'list' && looseElem(t.of));
        if (out.k === 'list' && looseElem(out.of) && spec(inp) >= 0.5) return 0; // list<any> 不能當作具體清單用（元素是什麼不知道），只能走強制轉型
        return Math.min(spec(inp), out.k === 'json' ? 0.1 : 1);
    }

    const isOpaque = (t) => t.k === 'json' || t.k === 'any' || (t.k === 'dict');
    // 單元的輸出清單：整個回傳值，加上物件的每個欄位（欄位名稱放進 name，之後知道要取哪一欄）
    function outputsOf(u) {
        const out = []; const t = Cat.parseType(u.returns && u.returns.type); out.push({ name: '$', type: t });
        if (t.k === 'object') for (const k of Object.keys(t.fields)) out.push({ name: k, type: t.fields[k] });
        return out;
    }
    const inputsOf = (u) => u.params.map((p) => ({ name: p.name, type: Cat.parseType(p.type), required: !!p.required }));

    // ===== 布林矩陣（位元列）=====
    function newBits(n) { const w = (n + 31) >>> 5; const rows = []; for (let i = 0; i < n; i++) rows.push(new Uint32Array(w)); return { n, w, rows }; }
    const setBit = (m, i, j) => { m.rows[i][j >>> 5] |= (1 << (j & 31)) >>> 0; };
    const getBit = (m, i, j) => (m.rows[i][j >>> 5] >>> (j & 31)) & 1;
    function boolMul(A, B) { // C = A × B：C 的第 i 列 ＝ A 第 i 列裡每個 1 對應的 B 列 的 OR
        const C = newBits(A.n);
        for (let i = 0; i < A.n; i++) { const ci = C.rows[i]; const ai = A.rows[i]; for (let wi = 0; wi < A.w; wi++) { let x = ai[wi]; while (x) { const b = 31 - Math.clz32(x & -x); x &= x - 1; const j = (wi << 5) + b; const bj = B.rows[j]; for (let k = 0; k < A.w; k++) ci[k] |= bj[k]; } } }
        return C;
    }
    function bitsOr(A, B) { const C = newBits(A.n); for (let i = 0; i < A.n; i++) for (let k = 0; k < A.w; k++) C.rows[i][k] = A.rows[i][k] | B.rows[i][k]; return C; }
    // within[k]＝「最多走 k 步」的可達矩陣（k=1..L）：A、A∪A²、A∪A²∪A³…
    function reachWithin(A, L) { const out = [null, A]; let P = A, acc = A; for (let k = 2; k <= L; k++) { P = boolMul(P, A); acc = bitsOr(acc, P); out.push(acc); } return out; }

    // ===== 建矩陣 =====
    function eligible(u, o) {
        if (u.tier !== 1) return false; if (!o.includeUnavailable && u.avail.state !== 'builtin') return false;
        if (u.effects.includes('unknown')) return false; if (o.excludeEffects && u.effects.some((e) => o.excludeEffects.includes(e))) return false; return true;
    }
    function buildMatrix(catalogOrUnits, opts) {
        opts = Object.assign({ minScore: 0.5, allowOpaque: false, castScore: 0.2 }, opts || {}); const all = Array.isArray(catalogOrUnits) ? catalogOrUnits : catalogOrUnits.units;
        const units = all.filter((u) => eligible(u, opts)); const n = units.length; const index = new Map(units.map((u, i) => [u.id, i]));
        const outs = units.map(outputsOf), ins = units.map(inputsOf); const A = newBits(n); const edges = units.map(() => new Map()); let nEdges = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            if (i === j) continue; let best = null;
            for (const o of outs[i]) for (const p of ins[j]) {
                let s = matchScore(o.type, p.type), cast = false;
                // 萬用結構（json／any）的輸出：預設接不到任何具體輸入；allowOpaque 時可以「強制轉型」接上去（分數很低，執行時要檢查實際內容符不符合）
                if (!s && opts.allowOpaque && isOpaque(o.type) && p.type.k !== 'any') { s = opts.castScore; cast = true; }
                if ((s >= opts.minScore || cast) && (!best || s > best.score)) best = { score: s, out: o.name, param: p.name, type: Cat.typeToString(p.type), cast };
            }
            if (best) { setBit(A, i, j); edges[i].set(j, best); nEdges++; }
        }
        return { units, ids: units.map((u) => u.id), index, outs, ins, A, edges, opts, stats: matrixStats(units, edges, nEdges) };
    }
    function matrixStats(units, edges, nEdges) {
        const n = units.length; const outDeg = edges.map((m) => m.size); const inDeg = new Array(n).fill(0); edges.forEach((m) => m.forEach((_, j) => { inDeg[j]++; }));
        const typed = units.filter((u) => { const t = Cat.parseType(u.returns.type); return t.k !== 'json' && t.k !== 'any'; }).length;
        const top = (deg, k) => deg.map((d, i) => [units[i].name, d]).sort((a, b) => b[1] - a[1]).slice(0, k);
        return { units: n, edges: nEdges, density_pct: n > 1 ? Math.round((nEdges / (n * (n - 1))) * 10000) / 100 : 0, isolated: units.filter((_, i) => !outDeg[i] && !inDeg[i]).length, no_out: outDeg.filter((d) => !d).length, no_in: inDeg.filter((d) => !d).length, typed_returns: typed, top_out: top(outDeg, 8), top_in: top(inDeg, 8) };
    }

    // ===== 找接線 =====
    // query: { from: 型別字串 | { unit: id }, to: 型別字串 | { unit: id } }；opts: { maxLen=4, k=5, minScore, maxExpand }
    function findPipelines(M, query, opts) {
        opts = Object.assign({ maxLen: 4, k: 5, minScore: M.opts.minScore, maxExpand: 200000 }, opts || {}); const n = M.units.length; if (!n) return { paths: [], expanded: 0 };
        // 起點：能吃下 from 型別的單元（或指定的單元）；終點：輸出能接到 to 型別的單元（或指定的單元）
        const start = new Map(), goal = new Map();
        if (query.from && query.from.unit) { if (M.index.has(query.from.unit)) start.set(M.index.get(query.from.unit), { score: 1, param: null }); }
        else { const ft = Cat.parseType(query.from); for (let i = 0; i < n; i++) { let best = null; for (const p of M.ins[i]) { const s = matchScore(ft, p.type); if (s >= opts.minScore && (!best || s > best.score)) best = { score: s, param: p.name }; } if (best) start.set(i, best); } }
        if (query.to && query.to.unit) { if (M.index.has(query.to.unit)) goal.set(M.index.get(query.to.unit), { score: 1, out: '$' }); }
        else { const tt = Cat.parseType(query.to); for (let i = 0; i < n; i++) { let best = null; for (const o of M.outs[i]) { const s = matchScore(o.type, tt); if (s >= opts.minScore && (!best || s > best.score)) best = { score: s, out: o.name }; } if (best) goal.set(i, best); } }
        if (!start.size || !goal.size) return { paths: [], expanded: 0, start: start.size, goal: goal.size };
        const W = reachWithin(M.A, opts.maxLen - 1); const gmask = new Uint32Array((n + 31) >>> 5); for (const g of goal.keys()) gmask[g >>> 5] |= (1 << (g & 31)) >>> 0;
        const canReachGoal = (u, steps) => { if (goal.has(u)) return true; if (steps < 1) return false; const row = W[Math.min(steps, W.length - 1)].rows[u]; for (let k = 0; k < gmask.length; k++) if (row[k] & gmask[k]) return true; return false; };
        const results = []; let expanded = 0;
        const reqCount = (j, satisfied) => M.ins[j].filter((p) => p.required).length - satisfied;
        function dfs(path, score, via) {
            if (expanded++ > opts.maxExpand) return; const u = path[path.length - 1];
            if (goal.has(u)) { const g = goal.get(u); results.push({ path: path.slice(), score: score * g.score, via: via.slice(), goal: g }); }
            if (path.length >= opts.maxLen) return;
            for (const [v, e] of M.edges[u]) { if (path.includes(v)) continue; if (!canReachGoal(v, opts.maxLen - path.length - 1)) continue; path.push(v); via.push(e); dfs(path, score * e.score, via); path.pop(); via.pop(); }
        }
        for (const [s, sc] of start) { if (!canReachGoal(s, opts.maxLen - 1)) continue; dfs([s], sc.score, []); }
        const paths = results.map((r) => {
            const len = r.path.length; let pen = 1; const extra = []; r.path.forEach((u, idx) => { const sat = (idx === 0 && query.from && query.from.unit) ? 0 : 1; const miss = Math.max(0, reqCount(u, sat)); if (miss) { extra.push({ unit: M.ids[u], missing: M.ins[u].filter((p) => p.required).map((p) => p.name).slice(sat) }); pen *= 1 / (1 + 0.1 * miss); } });
            const score = Math.round(r.score * Math.pow(0.9, len - 1) * pen * 1000) / 1000;
            return { units: r.path.map((u) => M.ids[u]), names: r.path.map((u) => M.units[u].name), score, via: r.via.map((e) => ({ out: e.out, param: e.param, type: e.type, score: e.score, cast: !!e.cast })), start: start.get(r.path[0]).param, goal: r.goal.out, extra_required: extra, effects: Array.from(new Set([].concat(...r.path.map((u) => M.units[u].effects)))) };
        });
        paths.sort((a, b) => b.score - a.score || a.units.length - b.units.length || (a.units.join() < b.units.join() ? -1 : 1));
        return { paths: paths.slice(0, opts.k), found: paths.length, expanded, start: start.size, goal: goal.size };
    }
    function explain(p) { return p.names.map((n, i) => (i ? ' →(' + p.via[i - 1].out + '→' + p.via[i - 1].param + ') ' : (p.start ? '(' + p.start + ') ' : '')) + n).join('') + '　得分 ' + p.score; }

    return { spec, matchScore, outputsOf, inputsOf, newBits, setBit, getBit, boolMul, bitsOr, reachWithin, buildMatrix, findPipelines, explain };
});
