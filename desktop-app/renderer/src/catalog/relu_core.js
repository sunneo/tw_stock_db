/* CoLU 的 ReLU 形式（UMD，純函式）：把接線矩陣的核心運算（可達性、最佳接線分數）寫成「矩陣連乘＋ReLU」，
 * 結果跟位元壓縮版（matrix_core.js）逐位元相同。設計見 DESIGN.unit-catalog.md 第三十節。
 * 為什麼要有這個形式：(1) 概念一致——CoLU 的運算就是「矩陣連乘加 ReLU」，跟 Handwired 同一種語言；
 * (2) 後端可替換——所有矩陣連乘都經過 matmul(X, Y, n)，之後換成 Web Worker 平行版或 WebGPU 版，只要通過這裡的一致性檢查（selfCheck）就能啟用；
 * (3) 可以接進計算圖——跟學出來的排名模型放在同一張圖裡。它不比位元版快（密集 n³ 對位元壓縮 n³/32），預設仍用位元版。
 * 三個基本零件（x 是非負整數時精確成立）：
 *   relu(x)   = max(0, x)
 *   sat(x)    = x − relu(x − 1)        → min(1, x)：把「有幾條路」壓成「有／沒有」（布林矩陣連乘的壓縮）
 *   max2(a,b) = b + relu(a − b)        → max(a, b)：取最佳（最佳接線分數用） */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog_core.js'), require('./matrix_core.js'));
    else root.FaCatalogRelu = factory(root.FaCatalog || (typeof FaCatalog !== 'undefined' ? FaCatalog : undefined), root.FaCatalogMatrix || (typeof FaCatalogMatrix !== 'undefined' ? FaCatalogMatrix : undefined));
})(typeof self !== 'undefined' ? self : this, function (Cat, MX) {
    'use strict';
    const relu = (x) => (x > 0 ? x : 0);
    const sat = (x) => x - relu(x - 1);
    const max2 = (a, b) => b + relu(a - b);

    // ===== 密集矩陣（Float32Array，列優先；計數在 2^24 以內精確，所以單元數要小於 1600 萬，實際用不到）=====
    function zeros(n) { return { n, data: new Float32Array(n * n) }; }
    function fromBits(A) { const D = zeros(A.n); for (let i = 0; i < A.n; i++) for (let j = 0; j < A.n; j++) if ((A.rows[i][j >>> 5] >>> (j & 31)) & 1) D.data[i * A.n + j] = 1; return D; }
    function toBits(D) { const n = D.n, w = (n + 31) >>> 5; const rows = []; for (let i = 0; i < n; i++) { const r = new Uint32Array(w); for (let j = 0; j < n; j++) if (D.data[i * n + j] > 0) r[j >>> 5] |= (1 << (j & 31)) >>> 0; rows.push(r); } return { n, w, rows }; }
    // 預設的矩陣連乘（i-k-j 迴圈，跳過 0）。後端要換就換這一個：matmul(X, Y, n) → Float32Array(n*n)
    function matmulJs(X, Y, n) {
        const C = new Float32Array(n * n);
        for (let i = 0; i < n; i++) { const ci = i * n; for (let k = 0; k < n; k++) { const a = X[ci + k]; if (a === 0) continue; const bk = k * n; for (let j = 0; j < n; j++) C[ci + j] += a * Y[bk + j]; } }
        return C;
    }
    let backend = { name: 'js', matmul: matmulJs };
    function use(b) { backend = b && b.matmul ? { name: b.name || 'custom', matmul: b.matmul } : { name: 'js', matmul: matmulJs }; return backend.name; }
    function current() { return backend.name; }
    const satAll = (data) => { const out = new Float32Array(data.length); for (let i = 0; i < data.length; i++) out[i] = sat(data[i]); return out; };

    // ===== 可達性（等於 matrix_core.reachWithin）：P_k = sat(P_{k-1}·A)，累計 = sat(累計 + P_k) =====
    function reachWithin(Abits, L, opts) {
        const mm = (opts && opts.matmul) || backend.matmul; const A = fromBits(Abits), n = A.n; const out = [null, Abits]; let P = A.data, acc = A.data;
        for (let k = 2; k <= L; k++) { P = satAll(mm(P, A.data, n)); const s = new Float32Array(n * n); for (let i = 0; i < s.length; i++) s[i] = sat(acc[i] + P[i]); acc = s; out.push(toBits({ n, data: acc })); }
        return out;
    }

    // ===== 真正的 ReLU 網路：x → relu(Wx + b) 的層疊，輸入是起點向量，輸出是「最多走 L 步」到得了的單元 =====
    // 一步：R' = sat((I + Aᵀ)R)。sat(z) = z − relu(z − 1)，所以一步＝一層 relu([M;M]·R + [0;−1])（2n 個單元）再接一個線性的 [I −I]。
    // 把線性的 [I −I] 併進下一層的權重，就是純粹的「relu 層疊」。
    function reachNet(Abits, L) {
        const A = fromBits(Abits), n = A.n; const M = new Float32Array(n * n); for (let i = 0; i < n; i++) { M[i * n + i] = 1; for (let j = 0; j < n; j++) if (A.data[j * n + i] > 0) M[i * n + j] = 1; } // M = I + Aᵀ（(i,j)＝j 走一步能到 i）
        const stack = (c) => { const W = new Float32Array(2 * n * c); return W; };
        const layers = []; const b = new Float32Array(2 * n); for (let i = 0; i < n; i++) b[n + i] = -1;
        // 第 1 層：輸入 n 維
        const W1 = stack(n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { W1[i * n + j] = M[i * n + j]; W1[(n + i) * n + j] = M[i * n + j]; } layers.push({ r: 2 * n, c: n, W: W1, b, act: 'relu' });
        // 第 2…L 層：輸入是上一層的 2n 維 [h1; h2]，R = h1 − h2，所以權重是 [M;M]·[I −I]
        for (let k = 2; k <= L; k++) { const W = stack(2 * n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const m = M[i * n + j]; W[i * 2 * n + j] = m; W[i * 2 * n + n + j] = -m; W[(n + i) * 2 * n + j] = m; W[(n + i) * 2 * n + n + j] = -m; } layers.push({ r: 2 * n, c: 2 * n, W, b, act: 'relu' }); }
        // 最後：線性 [I −I]
        const Wo = new Float32Array(n * 2 * n); for (let i = 0; i < n; i++) { Wo[i * 2 * n + i] = 1; Wo[i * 2 * n + n + i] = -1; } layers.push({ r: n, c: 2 * n, W: Wo, b: new Float32Array(n), act: 'linear' });
        return { n, L, layers };
    }
    function forward(net, x) {
        let v = Float32Array.from(x);
        for (const ly of net.layers) { const o = new Float32Array(ly.r); for (let i = 0; i < ly.r; i++) { let s = ly.b[i]; const wi = i * ly.c; for (let j = 0; j < ly.c; j++) s += ly.W[wi + j] * v[j]; o[i] = ly.act === 'relu' ? relu(s) : s; } v = o; }
        return v;
    }

    // ===== 最佳接線分數（等於 matrix_core.findPipelines 的第一名分數）=====
    // 分數都 ≤ 1 而且每多一個單元只會再乘上 ≤ 1 的數，所以走迴圈不會更好——「最佳的走法」＝「最佳的不重複走法」，可以用動態規劃：
    //   s_1[i] = 起點分數 × 缺必填參數的折扣；s_k[j] = max_i( s_{k-1}[i] × 邊分數[i][j] ) × 0.9 × 折扣[j]；答案 = max_k max_j( s_k[j] × 終點分數[j] )
    // 其中的 max 全部用 max2（ReLU）算。這裡只算『分數』與一條最佳路徑，不列前 K 名（要前 K 名還是用 findPipelines）。
    function bestPipeline(M, query, opts) {
        opts = Object.assign({ maxLen: 4, minScore: M.opts.minScore }, opts || {}); const n = M.units.length; if (!n) return { score: 0, units: [] };
        const mt = (a, b) => a * b; const start = new Float32Array(n), goal = new Float32Array(n);
        const pickIn = (i, ft) => { let best = 0; for (const p of M.ins[i]) { const s = MX.matchScore(ft, p.type); if (s >= opts.minScore && s > best) best = s; } return best; };
        const pickOut = (i, tt) => { let best = 0; for (const o of M.outs[i]) { const s = MX.matchScore(o.type, tt); if (s >= opts.minScore && s > best) best = s; } return best; };
        if (query.from && query.from.unit) { if (M.index.has(query.from.unit)) start[M.index.get(query.from.unit)] = 1; } else { const ft = Cat.parseType(query.from); for (let i = 0; i < n; i++) start[i] = pickIn(i, ft); }
        if (query.to && query.to.unit) { if (M.index.has(query.to.unit)) goal[M.index.get(query.to.unit)] = 1; } else { const tt = Cat.parseType(query.to); for (let i = 0; i < n; i++) goal[i] = pickOut(i, tt); }
        const pen = new Float32Array(n); for (let i = 0; i < n; i++) { const miss = Math.max(0, M.ins[i].filter((p) => p.required).length - ((i < n && query.from && query.from.unit && M.index.get(query.from.unit) === i) ? 0 : 1)); pen[i] = 1 / (1 + 0.1 * miss); }
        const E = zeros(n); for (let i = 0; i < n; i++) for (const [j, e] of M.edges[i]) E.data[i * n + j] = e.score;
        let s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = mt(start[i], pen[i]); let best = 0, bestK = 0, bestJ = -1; const parents = [null];
        const consider = (k) => { for (let j = 0; j < n; j++) { const v = mt(s[j], goal[j]) * Math.pow(0.9, k - 1); const m = max2(v, best); if (v > best) { best = m; bestK = k; bestJ = j; } } };
        consider(1);
        for (let k = 2; k <= opts.maxLen; k++) { const nx = new Float32Array(n), par = new Int32Array(n).fill(-1); for (let j = 0; j < n; j++) { let m = 0, arg = -1; for (let i = 0; i < n; i++) { const e = E.data[i * n + j]; if (!e || !s[i]) continue; const v = mt(s[i], e); const nm = max2(v, m); if (v > m) { m = nm; arg = i; } } nx[j] = mt(m, pen[j]); par[j] = arg; } s = nx; parents.push(par); consider(k); }
        if (bestJ < 0) return { score: 0, units: [] };
        // 往回找路徑（重算每一層的 s 找最佳來源）
        const path = [bestJ]; let j = bestJ; for (let k = bestK; k >= 2; k--) { j = parents[k - 1][j]; path.unshift(j); }
        return { score: Math.round(best * 1000) / 1000, length: bestK, units: path.map((u) => M.ids[u]), names: path.map((u) => M.units[u].name) };
    }

    // ===== 後端一致性檢查：新的矩陣連乘後端（Worker、WebGPU…）要先通過這個才可以啟用 =====
    // 用固定種子產生幾個隨機矩陣，要求 (1) 乘積與預設後端逐位元相同 (2) 壓縮後的可達矩陣與位元版相同。回傳 { ok, cases, failed:[…] }
    function selfCheck(candidateMatmul, opts) {
        opts = Object.assign({ sizes: [1, 2, 5, 17, 33, 64], density: 0.15, seed: 12345 }, opts || {}); let seed = opts.seed; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        const failed = []; let cases = 0;
        for (const n of opts.sizes) {
            const A = MX.newBits(n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (rnd() < opts.density) MX.setBit(A, i, j);
            const D = fromBits(A); const want = matmulJs(D.data, D.data, n), got = candidateMatmul(D.data, D.data, n); cases++;
            let same = got && got.length === want.length; if (same) for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) { same = false; break; } if (!same) failed.push('n=' + n + ' 乘積不一致');
            const ref = MX.reachWithin(A, 3), rl = reachWithin(A, 3, { matmul: candidateMatmul }); cases++;
            for (let k = 1; k <= 3; k++) { for (let i = 0; i < n; i++) for (let w = 0; w < A.w; w++) if (ref[k].rows[i][w] !== rl[k].rows[i][w]) { failed.push('n=' + n + ' 可達矩陣 k=' + k + ' 不一致'); k = 9; break; } if (k === 9) break; }
        }
        return { ok: !failed.length, cases, failed };
    }
    return { relu, sat, max2, zeros, fromBits, toBits, matmulJs, use, current, reachWithin, reachNet, forward, bestPipeline, selfCheck };
});
