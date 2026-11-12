/* G7 增量動態霍夫曼（FGK，DESIGN.matrix-fallback.md §13.4 阻礙 1 的解除）：
 *   樹本身就是狀態，編碼端與解碼端各自用同一套規則增量更新，不重建整張表。
 *   ① 位置序（order）：由低到高排列所有節點；權重沿位置序不遞減（兄弟性質）。
 *   ② 新符號：NYT（未傳過）節點拆成 [新 NYT(0)、新葉(1)、內部節點 q(1)]，放在原 NYT 的位置；碼路徑＝NYT 的路徑＋原始 W 位元。
 *   ③ 已知符號：從葉子開始往上，每一層先與「同權重中位置最高的節點」交換（若它不是自己的祖先），再把權重加一；
 *      從 q 的父節點（新符號）或葉子（已知符號）開始往根走。
 *   ④ 交換時節點連同子樹一起換位置（父指標與子指標都要改）。
 * 正確性：往返一致；每一步檢查兄弟性質與父子權重和（check 選項）；與獨立 Python 參照（同一演算法的另一份實作）逐位元相同（見測試）。
 * 純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaMatrixFgk = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const NYT = -2;

    function rawWidth(n) { let w = 1; while ((1 << w) < n) w++; return w; }

    function newTree(n) {
        const t = { n, W: [], P: [], L: [], R: [], SYM: [], order: [], root: 0, nyt: 0, leafOf: new Array(n).fill(-1), seen: new Array(n).fill(false) };
        t.W.push(0); t.P.push(-1); t.L.push(-1); t.R.push(-1); t.SYM.push(NYT); t.order.push(0);
        return t;
    }
    function mk(t, w, p, sym) { t.W.push(w); t.P.push(p); t.L.push(-1); t.R.push(-1); t.SYM.push(sym); return t.W.length - 1; }
    function isAncestor(t, a, v) { for (let u = t.P[v]; u !== -1; u = t.P[u]) if (u === a) return true; return false; }
    function swapNodes(t, a, b) {
        const ia = t.order.indexOf(a), ib = t.order.indexOf(b);
        t.order[ia] = b; t.order[ib] = a;
        const pa = t.P[a], pb = t.P[b];
        if (pa === pb) { const tmp = t.L[pa]; t.L[pa] = t.R[pa]; t.R[pa] = tmp; return; }
        if (t.L[pa] === a) t.L[pa] = b; else t.R[pa] = b;
        if (t.L[pb] === b) t.L[pb] = a; else t.R[pb] = a;
        t.P[a] = pb; t.P[b] = pa;
    }
    function update(t, v) {
        while (v !== -1) {
            const w = t.W[v];
            let lead = v;
            for (let k = t.order.length - 1; k >= 0; k--) { if (t.W[t.order[k]] === w) { lead = t.order[k]; break; } }
            if (lead !== v && !isAncestor(t, lead, v)) swapNodes(t, v, lead);
            t.W[v]++;
            v = t.P[v];
        }
    }
    function addNew(t, s) {
        const nyt = t.nyt, p = t.P[nyt];
        const q = mk(t, 1, p, -1), newNyt = mk(t, 0, q, NYT), leaf = mk(t, 1, q, s);
        t.L[q] = newNyt; t.R[q] = leaf;
        if (p === -1) t.root = q; else if (t.L[p] === nyt) t.L[p] = q; else t.R[p] = q;
        const pos = t.order.indexOf(nyt); t.order.splice(pos, 1, newNyt, leaf, q);
        t.leafOf[s] = leaf; t.seen[s] = true; t.nyt = newNyt;
        if (p !== -1) update(t, p);
    }
    function codePath(t, v) {
        const bits = [];
        for (let u = v; t.P[u] !== -1; u = t.P[u]) bits.push(t.L[t.P[u]] === u ? 0 : 1);
        return bits.reverse();
    }
    // 檢查：位置序上權重不遞減；父權重＝子權重和；父在位置序上高於子；各節點形成單一根（給測試用）
    function check(t) {
        for (let i = 0; i + 1 < t.order.length; i++) if (t.W[t.order[i]] > t.W[t.order[i + 1]]) return '權重沒有沿位置序不遞減（位置 ' + i + '）';
        const pos = new Map(t.order.map((v, i) => [v, i]));
        for (const v of t.order) {
            if (t.SYM[v] !== -1 && t.L[v] !== -1) return '葉子有子節點';
            if (t.L[v] !== -1) {
                if (t.W[v] !== t.W[t.L[v]] + t.W[t.R[v]]) return '父權重不等於子權重和';
                if (pos.get(t.L[v]) >= pos.get(v) || pos.get(t.R[v]) >= pos.get(v)) return '子節點位置不低於父節點';
                if (t.P[t.L[v]] !== v || t.P[t.R[v]] !== v) return '父指標不一致';
            }
        }
        return null;
    }
    function bitsFor(n) { return rawWidth(n); }

    // 編碼：回傳位元陣列（0/1）；check 為真時每一步檢查不變量，違反就丟錯。
    function encode(n, symbols, opts) {
        const t = newTree(n), out = [], W = bitsFor(n), doCheck = !!(opts && opts.check);
        for (const s of symbols) {
            if (!t.seen[s]) {
                for (const b of codePath(t, t.nyt)) out.push(b);
                for (let i = W - 1; i >= 0; i--) out.push((s >> i) & 1);
                addNew(t, s);
            } else {
                for (const b of codePath(t, t.leafOf[s])) out.push(b);
                update(t, t.leafOf[s]);
            }
            if (doCheck) { const e = check(t); if (e) throw new Error('FGK 不變量失敗：' + e); }
        }
        return out;
    }
    // 解碼：bits 為位元陣列，count 為符號數。回傳 { symbols, consumed }。
    function decode(n, bits, count, opts) {
        const t = newTree(n), W = bitsFor(n), doCheck = !!(opts && opts.check), out = []; let i = 0;
        for (let k = 0; k < count; k++) {
            let v = t.root;
            while (t.SYM[v] === -1) { if (i >= bits.length) throw new Error('FGK 串流提早結束'); v = bits[i++] ? t.R[v] : t.L[v]; }
            let s;
            if (t.SYM[v] === NYT) {
                if (i + W > bits.length) throw new Error('FGK 串流提早結束（原始符號）');
                s = 0; for (let b = 0; b < W; b++) s = (s << 1) | bits[i++];
                if (s >= n) throw new Error('FGK 解出的符號超出字母表');
                addNew(t, s);
            } else { s = t.SYM[v]; update(t, v); }
            out.push(s);
            if (doCheck) { const e = check(t); if (e) throw new Error('FGK 不變量失敗：' + e); }
        }
        return { symbols: out, consumed: i };
    }

    return { encode, decode, check: (n, syms) => { const t = newTree(n); for (const s of syms) { if (!t.seen[s]) addNew(t, s); else update(t, t.leafOf[s]); const e = check(t); if (e) return e; } return null; }, rawWidth, NYT };
});
