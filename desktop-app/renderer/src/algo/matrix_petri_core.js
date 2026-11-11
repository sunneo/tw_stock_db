/* G9 Petri 網／向量加法系統（DESIGN.matrix-fallback.md §12.3 G9、§13）：
 *   網：P 個庫所、T 個變遷；pre[t][p]＝變遷 t 消耗庫所 p 的權重，post[t][p]＝產生的權重；關聯矩陣 C = post − pre。
 *   標記 M（每庫所的權杖數，非負整數向量）。變遷 t 可發火 ⇔ M ≥ pre[t]（逐元素）；發火 M' = M + Cᵀ·e_t（一次線性加法）。
 *   狀態方程：發火序列的計數向量 x（每個變遷發火幾次）給出 M = M0 + C·x（計數半環上的線性式；與順序無關）。
 *   可達集用 BFS，有上限 limit；回報：可達標記數、死結標記（沒有變遷可發火）、各庫所最大權杖數、是否被截斷。
 * 純函式（UMD）。不做：有色 Petri 網、時間 Petri 網、不變量的符號計算（都寫在 §13 未做）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaMatrixPetri = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function incidence(net) { // C[t][p] = post − pre
        return net.pre.map((row, t) => row.map((v, p) => net.post[t][p] - v));
    }
    function enabled(net, M, t) { return net.pre[t].every((need, p) => M[p] >= need); }
    function fire(net, M, t) {
        if (!enabled(net, M, t)) return null;
        return M.map((v, p) => v - net.pre[t][p] + net.post[t][p]);
    }
    // 狀態方程：M0 + Σ_t x[t]·C[t]（與發火順序無關）
    function stateEquation(net, M0, x) {
        const C = incidence(net); const M = M0.slice();
        for (let t = 0; t < C.length; t++) for (let p = 0; p < M.length; p++) M[p] += x[t] * C[t][p];
        return M;
    }
    // 可達集 BFS：回傳 { reachable, deadlocks, maxTokens, truncated }
    function reach(net, M0, limit) {
        const L = limit || 10000; const key = (M) => M.join(',');
        const seen = new Set([key(M0)]); const queue = [M0.slice()]; const deadlocks = []; const maxTokens = M0.map(() => 0);
        let truncated = false; let head = 0;
        while (head < queue.length) {
            const M = queue[head++];
            M.forEach((v, p) => { if (v > maxTokens[p]) maxTokens[p] = v; });
            let any = false;
            for (let t = 0; t < net.pre.length; t++) {
                if (!enabled(net, M, t)) continue; any = true;
                const N = fire(net, M, t); const k = key(N);
                if (!seen.has(k)) {
                    if (seen.size >= L) { truncated = true; continue; }
                    seen.add(k); queue.push(N);
                }
            }
            if (!any) deadlocks.push(M.slice());
        }
        return { reachable: seen.size, deadlocks: deadlocks.length, deadlockMarkings: deadlocks, maxTokens, truncated };
    }

    return { incidence, enabled, fire, stateEquation, reach };
});
