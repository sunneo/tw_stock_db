/* ReLU 電路實驗（評估用，不進產品）：把 max／abs／clamp／min-plus 一步／排序／整數除法與取餘編成「線性組合＋ReLU 閘」的電路，
 * 驗證它們精確（或只對整數精確），並數 ReLU 單元（閘）的個數。對應 DESIGN.matrix-algorithms.md 第 10 節。
 * 電路 = 一串節點：{lin: [[節點, 係數]…], c} 或 {relu: 節點}；輸入是前 n 個節點。純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaRelu = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    class Net {
        constructor(nIn) { this.nIn = nIn; this.nodes = []; for (let i = 0; i < nIn; i++) this.nodes.push({ in: i }); this.out = []; }
        lin(terms, c) { this.nodes.push({ lin: terms, c: c || 0 }); return this.nodes.length - 1; }
        relu(src) { this.nodes.push({ relu: src }); return this.nodes.length - 1; }
        get gates() { return this.nodes.filter((n) => n.relu !== undefined).length; }
        // 深度＝最長的 relu 串（每過一個 relu 算一層）
        get depth() { const d = []; this.nodes.forEach((n, i) => { d[i] = n.in !== undefined ? 0 : n.relu !== undefined ? d[n.relu] + 1 : Math.max(0, ...n.lin.map(([k]) => d[k])); }); return Math.max(0, ...this.out.map((o) => d[o])); }
        eval(x) { const v = []; this.nodes.forEach((n, i) => { v[i] = n.in !== undefined ? x[n.in] : n.relu !== undefined ? Math.max(0, v[n.relu]) : n.lin.reduce((s, [k, c]) => s + c * v[k], n.c); }); return this.out.map((o) => v[o]); }
    }
    // max(a,b) = b + relu(a−b)：1 個閘（用跳接）；嚴格單隱藏層、無跳接版本：relu(a−b)+relu(b)−relu(−b)：3 個閘
    function maxNet(skip) { const n = new Net(2); if (skip) { const d = n.lin([[0, 1], [1, -1]]); const r = n.relu(d); n.out = [n.lin([[r, 1], [1, 1]])]; } else { const d = n.lin([[0, 1], [1, -1]]), r1 = n.relu(d), r2 = n.relu(1), m = n.lin([[1, -1]]), r3 = n.relu(m); n.out = [n.lin([[r1, 1], [r2, 1], [r3, -1]])]; } return n; }
    function minNet() { const n = new Net(2); const r = n.relu(n.lin([[0, 1], [1, -1]])); n.out = [n.lin([[0, 1], [r, -1]])]; return n; }
    function absNet() { const n = new Net(1); const r1 = n.relu(0), r2 = n.relu(n.lin([[0, -1]])); n.out = [n.lin([[r1, 1], [r2, 1]])]; return n; }
    // clamp(x, lo, hi) = lo + relu(x−lo) − relu(x−hi)（lo ≤ hi）
    function clampNet(lo, hi) { const n = new Net(1); const r1 = n.relu(n.lin([[0, 1]], -lo)), r2 = n.relu(n.lin([[0, 1]], -hi)); n.out = [n.lin([[r1, 1], [r2, -1]], lo)]; return n; }
    // 在電路裡加一個 max／min 閘（用跳接，每個 1 閘），回傳節點
    const gmax = (n, a, b) => { const r = n.relu(n.lin([[a, 1], [b, -1]])); return n.lin([[b, 1], [r, 1]]); };
    const gmin = (n, a, b) => { const r = n.relu(n.lin([[a, 1], [b, -1]])); return n.lin([[a, 1], [r, -1]]); };
    // min-plus 的一步：v'_j = min_i (v_i + M[i][j])；M 的 Infinity 項省略。每個輸出 (有限項數−1) 個 min 閘
    function minPlusStepNet(M) {
        const k = M.length, m = M[0].length, n = new Net(k); n.out = [];
        for (let j = 0; j < m; j++) { const terms = []; for (let i = 0; i < k; i++) if (M[i][j] !== Infinity) terms.push(n.lin([[i, 1]], M[i][j])); if (!terms.length) throw new Error('第 ' + j + ' 欄全是 Infinity（輸出是 Infinity，電路表示不出來）'); n.out.push(terms.slice(1).reduce((a, t) => gmin(n, a, t), terms[0])); }
        return n;
    }
    // 排序網路（氣泡法的比較交換序列）：每個比較交換 = 1 個 relu（max 與 min 共用同一個）
    function sortNet(size) {
        const n = new Net(size); const cur = Array.from({ length: size }, (_, i) => i); let gates = 0;
        for (let p = 0; p < size - 1; p++) for (let j = 0; j < size - 1 - p; j++) { const a = cur[j], b = cur[j + 1]; const r = n.relu(n.lin([[a, 1], [b, -1]])); cur[j] = n.lin([[a, 1], [r, -1]]); cur[j + 1] = n.lin([[b, 1], [r, 1]]); gates++; }
        n.out = cur; return n;
    }
    // 整數 x∈[0,N) 的 floor(x/m)：Σ_{t≥1} step(x − t·m)，step(z)=relu(z+1)−relu(z)（z 是整數時恰為 [z≥0]）：每個門檻 2 閘；非整數輸入只是折線插值
    function floorDivNet(m, N) { const n = new Net(1); const terms = []; for (let t = 1; t * m <= N - 1; t++) { const a = n.relu(n.lin([[0, 1]], 1 - t * m)), b = n.relu(n.lin([[0, 1]], -t * m)); terms.push([a, 1], [b, -1]); } n.out = [n.lin(terms)]; return n; }
    function modNet(m, N) { const n = floorDivNet(m, N); const q = n.out[0]; n.out = [n.lin([[0, 1], [q, -m]])]; return n; }
    // 雙調排序網路（不經意：比較序列只跟 size 有關）：每個比較交換 1 個 relu 閘；size 要是 2 的次方
    function bitonicNet(size) {
        const n = new Net(size); const cur = Array.from({ length: size }, (_, i) => i);
        for (let k = 2; k <= size; k *= 2) for (let j = k / 2; j >= 1; j /= 2) for (let i = 0; i < size; i++) { const l = i ^ j; if (l <= i) continue; const a = cur[i], b = cur[l]; const r = n.relu(n.lin([[a, 1], [b, -1]])); const mn = n.lin([[a, 1], [r, -1]]), mx = n.lin([[b, 1], [r, 1]]); if ((i & k) === 0) { cur[i] = mn; cur[l] = mx; } else { cur[i] = mx; cur[l] = mn; } }
        n.out = cur; return n;
    }
    function maxArrayNet(size) { const n = new Net(size); let acc = 0; for (let i = 1; i < size; i++) acc = gmax(n, acc, i); n.out = [acc]; return n; }
    return { Net, maxNet, minNet, absNet, clampNet, minPlusStepNet, sortNet, floorDivNet, modNet, bitonicNet, maxArrayNet };
});
