/* 「萬物皆矩陣相乘」的驗證程式（評估用，不進產品）：把 DESIGN.matrix-algorithms.md 的主張用純函式一條一條量出來。
 *
 *   ① 半環矩陣：count（可取模）、bool、min-plus、max-times；matMul／matPow／前綴掃描（結合律 → 可分段並行）
 *   ② DFA：每個符號一個轉移矩陣，輸入一串＝矩陣連乘；計數型（長度 n 有幾個被接受）
 *   ③ 圖：min-plus 平方＝最短路、布林冪＝傳遞閉包／連通分量
 *   ④ 線性遞推：Berlekamp–Massey（模質數）→ 伴隨矩陣 → matPow 算第 n 項
 *   ⑤ LALR：用 FaLR（logmine/lr_core.js）的表，action／goto 攤成矩陣；驅動迴圈只靠矩陣查表＋明確的堆疊；有界堆疊展開後的組態數
 *   ⑥ CFG 辨識＝布林矩陣乘法（每個非終端一張「區間 i..j 能推導出它」的矩陣，產生式 A→B C 就是 R_A |= R_B·R_C）
 *   ⑦ 從範例學矩陣：Hankel 矩陣的秩、Ho–Kalman 式的加權自動機學習（模質數）、Myhill–Nerode 狀態合併學 DFA
 *   ⑧ 種子 20 題的分類表（哪些在範圍內；每題標明有沒有被實驗驗證）
 * 純函式（UMD）；質數取 1e9+7，乘法用拆 16 位元避免超過 2^53。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('../logmine/lr_core.js'));
    else root.FaMatrixForms = factory(root.FaLR);
})(typeof self !== 'undefined' ? self : this, function (LR) {
    'use strict';

    const P = 1000000007, INF = Infinity;
    const mulmod = (a, b, p) => ((a * (b >>> 16)) % p * 65536 + a * (b & 65535)) % p;
    const powmod = (a, e, p) => { let r = 1; a %= p; while (e > 0) { if (e & 1) r = mulmod(r, a, p); a = mulmod(a, a, p); e = Math.floor(e / 2); } return r; };
    const invmod = (a, p) => powmod(((a % p) + p) % p, p - 2, p);

    // ---------- ① 半環與矩陣 ----------
    const SR = {
        count: (mod) => mod ? { name: 'count%' + mod, zero: 0, one: 1, add: (a, b) => (a + b) % mod, mul: (a, b) => mulmod(a, b, mod) } : { name: 'count', zero: 0, one: 1, add: (a, b) => a + b, mul: (a, b) => a * b },
        bool: { name: 'bool', zero: 0, one: 1, add: (a, b) => (a || b ? 1 : 0), mul: (a, b) => (a && b ? 1 : 0) },
        minplus: { name: 'min-plus', zero: INF, one: 0, add: Math.min, mul: (a, b) => a + b },
        maxtimes: { name: 'max-times', zero: 0, one: 1, add: Math.max, mul: (a, b) => a * b },
    };
    const zeros = (r, c, sr) => Array.from({ length: r }, () => new Array(c).fill(sr.zero));
    const identity = (n, sr) => { const m = zeros(n, n, sr); for (let i = 0; i < n; i++) m[i][i] = sr.one; return m; };
    function matMul(A, B, sr) {
        const n = A.length, k = B.length, m = B[0].length; const C = zeros(n, m, sr);
        for (let i = 0; i < n; i++) for (let t = 0; t < k; t++) { const a = A[i][t]; if (a === sr.zero) continue; for (let j = 0; j < m; j++) C[i][j] = sr.add(C[i][j], sr.mul(a, B[t][j])); }
        return C;
    }
    function matPow(A, e, sr) { let R = identity(A.length, sr), B = A; while (e > 0) { if (e % 2) R = matMul(R, B, sr); B = matMul(B, B, sr); e = Math.floor(e / 2); } return R; }
    const matEq = (A, B) => A.length === B.length && A.every((r, i) => r.length === B[i].length && r.every((x, j) => x === B[i][j]));
    const matAdd = (A, B, sr) => A.map((r, i) => r.map((x, j) => sr.add(x, B[i][j])));
    // 前綴積：用分治（左半的總積乘進右半每個前綴）；跟逐個連乘的結果相同，深度只有 O(log n)，這是並行掃描的骨架
    function scanPrefix(mats, sr) {
        if (mats.length === 1) return [mats[0]];
        const mid = mats.length >> 1; const L = scanPrefix(mats.slice(0, mid), sr), R = scanPrefix(mats.slice(mid), sr); const tot = L[L.length - 1];
        return L.concat(R.map((m) => matMul(tot, m, sr)));
    }
    const scanSequential = (mats, sr) => { const out = []; let acc = null; for (const m of mats) { acc = acc ? matMul(acc, m, sr) : m; out.push(acc); } return out; };
    const productChunked = (mats, chunk, sr) => { const parts = []; for (let i = 0; i < mats.length; i += chunk) parts.push(mats.slice(i, i + chunk).reduce((a, m) => matMul(a, m, sr))); return parts.reduce((a, m) => matMul(a, m, sr)); };

    // ---------- ② DFA ----------
    // dfa = { n, alphabet: [..], start, accept: [bool], delta: delta[state][symbolIndex] }
    const dfaRun = (d, w) => { let s = d.start; for (const ch of w) s = d.delta[s][d.alphabet.indexOf(ch)]; return !!d.accept[s]; };
    const dfaMatrices = (d, sr) => d.alphabet.map((_, a) => { const M = zeros(d.n, d.n, sr); for (let i = 0; i < d.n; i++) M[i][d.delta[i][a]] = sr.one; return M; });
    const dfaVec = (d, sr) => { const v = new Array(d.n).fill(sr.zero); v[d.start] = sr.one; return v; };
    const dfaAcceptVec = (d, sr) => d.accept.map((x) => (x ? sr.one : sr.zero));
    function dfaRunMatrix(d, w, sr) {
        sr = sr || SR.bool; const Ms = dfaMatrices(d, sr); let v = [dfaVec(d, sr)];
        for (const ch of w) v = matMul(v, Ms[d.alphabet.indexOf(ch)], sr);
        const f = dfaAcceptVec(d, sr); return v[0].some((x, i) => x !== sr.zero && f[i] !== sr.zero);
    }
    // 長度 n、被接受的字串有幾個：v0 · (ΣM_a)^n · f，取模
    function dfaCountMatrix(d, n, mod) {
        const sr = SR.count(mod); const Ms = dfaMatrices(d, sr); let T = zeros(d.n, d.n, sr); for (const M of Ms) T = matAdd(T, M, sr);
        const v = matMul([dfaVec(d, sr)], matPow(T, n, sr), sr)[0]; const f = dfaAcceptVec(d, sr); return v.reduce((a, x, i) => sr.add(a, sr.mul(x, f[i])), 0);
    }
    const dfaCountBrute = (d, n) => { let c = 0; const rec = (w) => { if (w.length === n) { if (dfaRun(d, w)) c++; return; } for (const a of d.alphabet) rec(w + a); }; rec(''); return c; };
    const DFAS = {
        // 二進位字串（高位在前）能被 3 整除：狀態＝目前餘數
        div3: { n: 3, alphabet: ['0', '1'], start: 0, accept: [true, false, false], delta: [[0, 1], [2, 0], [1, 2]] },
        // 不含連續兩個 1：狀態 0＝上一個不是 1、1＝上一個是 1、2＝已死
        no11: { n: 3, alphabet: ['0', '1'], start: 0, accept: [true, true, false], delta: [[0, 1], [0, 2], [2, 2]] },
        // a 的個數是偶數（字母 a、b）
        evenA: { n: 2, alphabet: ['a', 'b'], start: 0, accept: [true, false], delta: [[1, 0], [0, 1]] },
    };
    function randomDfa(rnd, n, k) { const alphabet = 'abcdefgh'.slice(0, k).split(''); return { n, alphabet, start: 0, accept: Array.from({ length: n }, () => rnd() < 0.5), delta: Array.from({ length: n }, () => alphabet.map(() => Math.floor(rnd() * n))) }; }

    // ---------- ③ 圖 ----------
    // 邊 [u,v,w]（節點 0..n-1）；有向或無向
    function weightMatrix(n, edges, directed) { const W = zeros(n, n, SR.minplus); for (let i = 0; i < n; i++) W[i][i] = 0; for (const [u, v, w] of edges) { if (w < W[u][v]) W[u][v] = w; if (!directed && w < W[v][u]) W[v][u] = w; } return W; }
    function minPlusClosure(W) { let D = W, steps = 0; for (let len = 1; len < W.length; len *= 2) { D = matMul(D, D, SR.minplus); steps++; } return { D, squarings: steps }; }
    function floyd(W) { const n = W.length, D = W.map((r) => r.slice()); for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (D[i][k] + D[k][j] < D[i][j]) D[i][j] = D[i][k] + D[k][j]; return D; }
    function dijkstra(n, edges, src, directed) {
        const adj = Array.from({ length: n }, () => []); for (const [u, v, w] of edges) { adj[u].push([v, w]); if (!directed) adj[v].push([u, w]); }
        const dist = new Array(n).fill(INF), done = new Array(n).fill(false); dist[src] = 0;
        for (let it = 0; it < n; it++) { let u = -1; for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i; if (u < 0 || dist[u] === INF) break; done[u] = true; for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) dist[v] = dist[u] + w; }
        return dist;
    }
    function boolAdj(n, edges, directed) { const A = zeros(n, n, SR.bool); for (let i = 0; i < n; i++) A[i][i] = 1; for (const [u, v] of edges) { A[u][v] = 1; if (!directed) A[v][u] = 1; } return A; }
    // 注意：transitiveClosure 只給 A^(2^k)——A 必須已含單位矩陣（boolAdj 有加）才是「自反傳遞閉包」；A 不含單位矩陣時它不是閉包（判環就會錯）。
    const transitiveClosure = (A) => { let R = A; for (let len = 1; len < A.length; len *= 2) R = matMul(R, R, SR.bool); return R; };
    // G8：不管 A 有沒有單位矩陣都正確的版本。reflexiveReach＝(A∨I)^(2^k)；hasCycle＝A·reach 的對角線（走一步再走到回自己）。
    const reflexiveReach = (A) => { const n = A.length; const R0 = A.map((r, i) => r.map((x, j) => (x || i === j ? 1 : 0))); let R = R0; for (let len = 1; len < n; len *= 2) R = matMul(R, R, SR.bool); return R; };
    function hasCycle(n, edges) { const A = zeros(n, n, SR.bool); for (const [u, v] of edges) A[u][v] = 1; const P = matMul(A, reflexiveReach(A), SR.bool); for (let i = 0; i < n; i++) if (P[i][i]) return true; return false; }
    function hasCycleUndirected(n, edges) { const comp = componentsViaClosure(n, edges); return edges.length > n - comp; } // 無向簡單圖：邊數超過森林的 n−分量數就有環
    function componentsViaClosure(n, edges) { const R = transitiveClosure(boolAdj(n, edges, false)); return new Set(R.map((r) => r.join(''))).size; }
    function componentsUnionFind(n, edges) { const p = Array.from({ length: n }, (_, i) => i); const f = (x) => (p[x] === x ? x : (p[x] = f(p[x]))); for (const [u, v] of edges) p[f(u)] = f(v); return new Set(p.map((_, i) => f(i))).size; }
    const closureBfs = (n, edges, directed) => { const adj = Array.from({ length: n }, () => []); for (const [u, v] of edges) { adj[u].push(v); if (!directed) adj[v].push(u); } return Array.from({ length: n }, (_, s) => { const seen = new Array(n).fill(0); seen[s] = 1; const q = [s]; while (q.length) { const u = q.pop(); for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; q.push(v); } } return seen; }); };
    // 種子題 grid-bfs：格子圖 → min-plus 矩陣 → S 到 T 的最少步數（不可達 -1）
    function gridShortestMinPlus(rows) {
        const r = rows.length, c = rows[0].length; const id = (i, j) => i * c + j; const edges = []; let S = -1, T = -1;
        for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) { const ch = rows[i][j]; if (ch === '#') continue; if (ch === 'S') S = id(i, j); if (ch === 'T') T = id(i, j); if (i + 1 < r && rows[i + 1][j] !== '#') edges.push([id(i, j), id(i + 1, j), 1]); if (j + 1 < c && rows[i][j + 1] !== '#') edges.push([id(i, j), id(i, j + 1), 1]); }
        const D = minPlusClosure(weightMatrix(r * c, edges, false)).D; const d = D[S][T]; return d === INF ? -1 : d;
    }
    function gridShortestBfs(rows) {
        const r = rows.length, c = rows[0].length; let S, T; for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) { if (rows[i][j] === 'S') S = [i, j]; if (rows[i][j] === 'T') T = [i, j]; }
        const dist = new Map([[S.join(), 0]]); const q = [S]; while (q.length) { const [i, j] = q.shift(); for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= r || b >= c || rows[a][b] === '#' || dist.has(a + ',' + b)) continue; dist.set(a + ',' + b, dist.get(i + ',' + j) + 1); q.push([a, b]); } }
        return dist.has(T.join()) ? dist.get(T.join()) : -1;
    }
    // 種子題 coin-change（最少硬幣）：狀態向量 (dp[x], dp[x-1], …, dp[x-m+1])，一步 = min-plus 矩陣乘法（轉移矩陣只跟面額有關，跟總額無關）；總額用 matPow
    function coinMinPlus(coins, T) {
        if (T === 0) return 0; const m = Math.max(...coins); const M = zeros(m, m, SR.minplus);
        // 新 dp[x] = min over c of (dp[x-c] + 1)；狀態向量第 k 個分量是 dp[x-k]（k=0..m-1），一步後移位
        for (const c of coins) M[c - 1][0] = Math.min(M[c - 1][0], 1);   // 舊向量 col 的分量 c-1 = dp[x-c] → 新分量 0
        for (let k = 1; k < m; k++) M[k - 1][k] = 0;                      // 舊分量 k-1 → 新分量 k（移位）
        // x=0 時的向量：dp[0]=0，dp[負]=INF
        const v0 = new Array(m).fill(INF); v0[0] = 0; const v = matMul([v0], matPow(M, T, SR.minplus), SR.minplus)[0]; return v[0] === INF ? -1 : v[0];
    }
    function coinDp(coins, T) { const dp = new Array(T + 1).fill(INF); dp[0] = 0; for (let x = 1; x <= T; x++) for (const c of coins) if (x >= c && dp[x - c] + 1 < dp[x]) dp[x] = dp[x - c] + 1; return dp[T] === INF ? -1 : dp[T]; }

    // ---------- ④ 線性遞推：Berlekamp–Massey（模質數 p） ----------
    // 回傳 c[1..L]：s[n] = Σ c[i]·s[n-i]
    function berlekampMassey(s, p) {
        p = p || P; let C = [1], B = [1], L = 0, m = 1, b = 1;
        for (let n = 0; n < s.length; n++) {
            let d = s[n] % p; for (let i = 1; i <= L; i++) d = (d + mulmod(C[i] || 0, s[n - i] % p, p)) % p;
            if (d === 0) { m++; continue; }
            const coef = mulmod(d, invmod(b, p), p); const T = C.slice(); const need = B.length + m; while (C.length < need) C.push(0);
            for (let i = 0; i < B.length; i++) C[i + m] = ((C[i + m] - mulmod(coef, B[i], p)) % p + p) % p;
            if (2 * L <= n) { L = n + 1 - L; B = T; b = d; m = 1; } else m++;
        }
        const c = [0]; for (let i = 1; i <= L; i++) c.push((p - ((C[i] || 0) % p)) % p); return c;
    }
    function companion(c, p) { const L = c.length - 1; const sr = SR.count(p); const M = zeros(L, L, sr); for (let i = 0; i + 1 < L; i++) M[i][i + 1] = 1; for (let j = 0; j < L; j++) M[L - 1][j] = c[L - j]; return M; }
    // 第 n 項（0 起算）：初始向量 (s0..s_{L-1}) 乘 M^n 取第 0 分量
    function nthTerm(s, c, n, p) {
        p = p || P; const L = c.length - 1; if (L === 0) return 0; if (n < L) return s[n] % p; const sr = SR.count(p); const Mn = matPow(companion(c, p), n, sr);
        let r = 0; for (let j = 0; j < L; j++) r = (r + mulmod(Mn[0][j], s[j] % p, p)) % p; return r;
    }
    function seqByRecurrence(init, coefs, n, p) { // 參考：直接照遞推迭代到 n（c[1..L]）
        p = p || P; const L = coefs.length - 1; const a = init.slice(0, L); for (let i = L; i <= n; i++) { let v = 0; for (let k = 1; k <= L; k++) v = (v + mulmod(coefs[k], a[i - k], p)) % p; a.push(v); } return a[n] % p;
    }

    // ---------- ⑤ LALR 表 ＝ 矩陣；驅動 ＝ 矩陣查表 ＋ 堆疊 ----------
    const termsOf = (table) => Array.from(table.terms).sort();
    function actionMatrix(table) { // 列＝狀態、欄＝終端；格子＝動作碼：null 錯誤、{type,n}
        const ts = termsOf(table); return { terms: ts, rows: table.action.map((m) => ts.map((t) => m.get(t) || null)) };
    }
    function gotoMatrix(table) { const nts = Array.from(table.nts).filter((n) => n !== '$accept').sort(); return { nts, rows: table.goto.map((m) => nts.map((n) => (m.has(n) ? m.get(n) : -1))) }; }
    const sparsity = (rows) => { let nz = 0, tot = 0; for (const r of rows) for (const x of r) { tot++; if (x !== null && x !== -1) nz++; } return { nonzero: nz, total: tot, density: tot ? nz / tot : 0 }; };
    // 只用「one-hot 狀態向量 × 動作矩陣」取列＋明確堆疊的驅動程式；回傳是否接受、最大堆疊深度、步數
    function lrDriveByMatrix(table, tokens) {
        const AM = actionMatrix(table), GM = gotoMatrix(table); const col = new Map(AM.terms.map((t, i) => [t, i])), gcol = new Map(GM.nts.map((t, i) => [t, i]));
        const toks = tokens.concat(['$end']); const stack = [0]; let i = 0, steps = 0, maxDepth = 1;
        for (;;) {
            steps++; const act = AM.rows[stack[stack.length - 1]][col.has(toks[i]) ? col.get(toks[i]) : -1] || null; if (!act || act.type === 'error') return { ok: false, steps, maxDepth };
            if (act.type === 'shift') { stack.push(act.n); i++; if (stack.length > maxDepth) maxDepth = stack.length; }
            else if (act.type === 'reduce') { const p = table.prods[act.n]; stack.length -= p.rhs.length; stack.push(GM.rows[stack[stack.length - 1]][gcol.get(p.lhs)]); if (stack.length > maxDepth) maxDepth = stack.length; }
            else return { ok: true, steps, maxDepth };
        }
    }
    // 把堆疊深度限制在 K：「組態＝整個堆疊內容」的集合大小（一個 token 讀完、堆疊穩定時的組態）。深度 K 的展開矩陣維度就是它。
    function boundedStackConfigs(table, K) {
        const terms = termsOf(table).filter((t) => t !== '$end'); const seen = new Set(['0']); let frontier = [[0]];
        while (frontier.length) {
            const next = [];
            for (const st of frontier) for (const t of terms) {
                const s = st.slice(); let ok = false;
                for (let guard = 0; guard < 1000 && s.length <= K; guard++) {
                    const act = table.action[s[s.length - 1]].get(t); if (!act || act.type === 'error' || act.type === 'accept') break;
                    if (act.type === 'shift') { s.push(act.n); ok = s.length <= K; break; }
                    const p = table.prods[act.n]; s.length -= p.rhs.length; s.push(table.goto[s[s.length - 1]].get(p.lhs));
                }
                if (ok) { const key = s.join(','); if (!seen.has(key)) { seen.add(key); next.push(s); } }
            }
            frontier = next;
        }
        return seen.size;
    }

    // ---------- ⑥ CFG 辨識 ＝ 布林矩陣乘法 ----------
    // 每個非終端 A 一張 (n+1)×(n+1) 的上三角矩陣 R_A，R_A[i][j]=1 表示 w[i..j) 能由 A 推導出來。
    // 產生式 A → X1 … Xk：R_A |= R_X1 · R_X2 ·…· R_Xk（終端 a 的矩陣：R[i][i+1]=1 若 w[i]=a；ε：單位矩陣）。重複到不變為止。
    function cfgRecognize(grammar, tokens) {
        const n = tokens.length, N = n + 1; const nts = new Set(grammar.productions.map((p) => p.lhs)); const R = new Map(); let matmuls = 0;
        for (const A of nts) R.set(A, zeros(N, N, SR.bool));
        const termMat = (a) => { const M = zeros(N, N, SR.bool); for (let i = 0; i < n; i++) if (tokens[i] === a) M[i][i + 1] = 1; return M; };
        const tmCache = new Map(); const mat = (X) => (nts.has(X) ? R.get(X) : (tmCache.has(X) ? tmCache.get(X) : (tmCache.set(X, termMat(X)), tmCache.get(X))));
        let changed = true, iterations = 0;
        while (changed && iterations < N * 4 + 4) {
            changed = false; iterations++;
            for (const p of grammar.productions) {
                let M = identity(N, SR.bool); for (const X of p.rhs) { M = matMul(M, mat(X), SR.bool); matmuls++; }
                const T = R.get(p.lhs); for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (M[i][j] && !T[i][j]) { T[i][j] = 1; changed = true; }
            }
        }
        return { ok: !!R.get(grammar.start)[0][n], matmuls, iterations };
    }

    // ---------- ⑦ 從範例學矩陣 ----------
    const allStrings = (alphabet, L) => { const out = ['']; let layer = ['']; for (let l = 1; l <= L; l++) { const nx = []; for (const w of layer) for (const a of alphabet) nx.push(w + a); out.push(...nx); layer = nx; } return out; };
    // 模質數的列化簡：回傳秩與主元欄；M 為數字陣列的陣列（會複製）
    function rankMod(M, p) {
        p = p || P; const A = M.map((r) => r.map((x) => ((x % p) + p) % p)); const rows = A.length, cols = rows ? A[0].length : 0; let r = 0; const pivots = [];
        for (let c = 0; c < cols && r < rows; c++) {
            let piv = -1; for (let i = r; i < rows; i++) if (A[i][c] !== 0) { piv = i; break; } if (piv < 0) continue;
            [A[r], A[piv]] = [A[piv], A[r]]; const inv = invmod(A[r][c], p); A[r] = A[r].map((x) => mulmod(x, inv, p));
            for (let i = 0; i < rows; i++) if (i !== r && A[i][c] !== 0) { const f = A[i][c]; A[i] = A[i].map((x, j) => ((x - mulmod(f, A[r][j], p)) % p + p) % p); }
            pivots.push(c); r++;
        }
        return { rank: r, pivots };
    }
    const hankel = (f, alphabet, L) => { const S = allStrings(alphabet, L); return { prefixes: S, suffixes: S, H: S.map((u) => S.map((v) => f(u + v))) }; };
    const hankelRank = (f, alphabet, L, p) => rankMod(hankel(f, alphabet, L).H, p).rank;
    function invertMod(M, p) { // Gauss-Jordan；奇異就回傳 null
        const n = M.length; const A = M.map((r, i) => r.map((x) => ((x % p) + p) % p).concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
        for (let c = 0; c < n; c++) {
            let piv = -1; for (let i = c; i < n; i++) if (A[i][c] !== 0) { piv = i; break; } if (piv < 0) return null;
            [A[c], A[piv]] = [A[piv], A[c]]; const inv = invmod(A[c][c], p); A[c] = A[c].map((x) => mulmod(x, inv, p));
            for (let i = 0; i < n; i++) if (i !== c && A[i][c] !== 0) { const f = A[i][c]; A[i] = A[i].map((x, j) => ((x - mulmod(f, A[c][j], p)) % p + p) % p); }
        }
        return A.map((r) => r.slice(n));
    }
    // Ho–Kalman／譜學習的精確版：選出 r 個線性獨立的前綴列、r 個獨立的後綴欄，A_a = H0^-1 · H_a，α = H[ε,S]，β = H0^-1 · H[P,ε]
    function learnWFA(f, alphabet, L, p) {
        p = p || P; const { prefixes, suffixes, H } = hankel(f, alphabet, L);
        const rowSel = rankMod(H[0].map((_, j) => H.map((r) => r[j])), p).pivots;      // 轉置的主元欄＝獨立的列
        const Prow = rowSel.map((i) => prefixes[i]); const colSel = rankMod(rowSel.map((i) => H[i]), p).pivots;
        const Ssuf = colSel.map((j) => suffixes[j]); const r = Prow.length; if (r === 0) return { dim: 0, ok: false };
        const H0 = Prow.map((u) => Ssuf.map((v) => f(u + v) % p)); const H0inv = invertMod(H0, p); if (!H0inv) return { dim: r, ok: false };
        const mm = (X, Y) => X.map((row) => Y[0].map((_, j) => row.reduce((s, x, k) => (s + mulmod(x, Y[k][j], p)) % p, 0)));
        const A = {}; for (const a of alphabet) A[a] = mm(H0inv, Prow.map((u) => Ssuf.map((v) => f(u + a + v) % p)));
        const alpha = [Ssuf.map((v) => f(v) % p)]; const beta = mm(H0inv, Prow.map((u) => [f(u) % p]));
        const evalW = (w) => { let v = alpha; for (const ch of w) v = mm(v, A[ch]); return mm(v, beta)[0][0]; };
        return { ok: true, dim: r, A, alpha, beta, eval: evalW, prefixes: Prow, suffixes: Ssuf, queries: prefixes.length * suffixes.length * (alphabet.length + 1) };
    }
    // Myhill–Nerode 狀態合併：列特徵（對所有短後綴的答案）相同的前綴合成一個狀態；轉移 = 代表字串加一個符號後的列特徵。
    // f 回傳 true／false（或 0／1）；L＝後綴長度上限；maxStates 防止發散（不是有限狀態時狀態數會一直長）。
    function learnDFA(f, alphabet, L, maxStates) {
        maxStates = maxStates || 64; const suffixes = allStrings(alphabet, L); const sig = (u) => suffixes.map((v) => (f(u + v) ? 1 : 0)).join('');
        const reps = [''], sigs = new Map([[sig(''), 0]]); const delta = []; let queries = suffixes.length;
        for (let i = 0; i < reps.length; i++) {
            delta[i] = []; for (const a of alphabet) {
                const s = sig(reps[i] + a); queries += suffixes.length; if (!sigs.has(s)) { if (reps.length >= maxStates) return { ok: false, states: reps.length, reason: '狀態數超過 ' + maxStates + '（不像有限狀態）', queries }; sigs.set(s, reps.length); reps.push(reps[i] + a); }
                delta[i].push(sigs.get(s));
            }
        }
        return { ok: true, dfa: { n: reps.length, alphabet: alphabet.slice(), start: 0, accept: reps.map((u) => !!f(u)), delta }, states: reps.length, reps, queries };
    }

    // ---------- ⑧ 種子 20 題分類 ----------
    // cls：A＝輸出是輸入的有限秩（線性／半環）函數，可從範例學；B＝「矩陣由輸入建出來」的範本（程式建矩陣＋連乘），學不出來但能當範式骨架；C＝不在範圍。
    // verified：本檔的測試有實際跑過（含隨機對照）的主張；沒有的是推測。
    const SEED_CLASS = {
        'a-plus-b': { cls: 'A', why: '兩個數的和是線性函數（1×… 的矩陣）；沒有「串」的結構，意義不大', verified: false },
        'max-of-array': { cls: 'A', why: '值域有界時，max 是 (值域+1) 狀態的 DFA／max-plus 向量；值域大時狀態數隨值域長', verified: true },
        'reverse-words': { cls: 'C', why: '輸出是序列（不是半環裡的純量），需要無界記憶', verified: false },
        'is-palindrome': { cls: 'C', why: 'Hankel 秩隨長度成長，需要無界記憶', verified: true },
        'two-sum': { cls: 'C', why: '需要雜湊或比較；輸出是位置', verified: false },
        'word-frequency': { cls: 'C', why: '計數表大小無界、還要排序', verified: false },
        'lower-bound': { cls: 'C', why: '二分搜尋是資料相依的分支', verified: false },
        'range-sum': { cls: 'B', why: '前綴和＝下三角全 1 矩陣乘向量；矩陣由 n 建出來', verified: false },
        'fibonacci': { cls: 'A', why: 'C-finite 數列：Berlekamp–Massey 從前幾項學出遞推、轉成矩陣、matPow', verified: true },
        'coin-change': { cls: 'B', why: 'min-plus 線性遞推：轉移矩陣由面額建出來（不是從範例學）', verified: true },
        'lis': { cls: 'C', why: '遞增比較是資料相依；耐心排序需要有序堆', verified: false },
        'valid-brackets': { cls: 'C', why: 'Dyck 語言：有限矩陣不夠，Hankel 秩無界（單一括號種類有計數器；多種需要堆疊）', verified: true },
        'gcd-lcm': { cls: 'C', why: '輾轉相除是資料相依迴圈；不是半環函數', verified: false },
        'count-primes': { cls: 'C', why: '質數個數不是 C-finite 數列，沒有有限矩陣', verified: false },
        'grid-bfs': { cls: 'B', why: '格子圖 → min-plus 鄰接矩陣平方；矩陣由網格建出來', verified: true },
        'components': { cls: 'B', why: '布林傳遞閉包；矩陣由邊建出來', verified: true },
        'merge-intervals': { cls: 'C', why: '要排序＋貪心合併', verified: false },
        'kth-largest': { cls: 'C', why: '排序／選擇是比較；固定 k 與有界值域時有限狀態，但狀態數隨值域與 k 暴增', verified: false },
        'anagram': { cls: 'C', why: '兩半字串的多重集合相等：Hankel 秩隨字母出現次數的組合成長', verified: false },
        'knapsack': { cls: 'B', why: '(max,+) 半環：每件物品一個 (W+1)×(W+1) 矩陣，但矩陣由 w、v、W 建出來，W 隨輸入變', verified: false },
    };

    return {
        P, INF, mulmod, powmod, invmod, SR, zeros, identity, matMul, matPow, matEq, matAdd, scanPrefix, scanSequential, productChunked,
        dfaRun, dfaMatrices, dfaRunMatrix, dfaCountMatrix, dfaCountBrute, DFAS, randomDfa,
        weightMatrix, minPlusClosure, floyd, dijkstra, boolAdj, transitiveClosure, reflexiveReach, hasCycle, hasCycleUndirected, componentsViaClosure, componentsUnionFind, closureBfs, gridShortestMinPlus, gridShortestBfs, coinMinPlus, coinDp,
        berlekampMassey, companion, nthTerm, seqByRecurrence,
        actionMatrix, gotoMatrix, sparsity, lrDriveByMatrix, boundedStackConfigs,
        cfgRecognize,
        allStrings, rankMod, hankel, hankelRank, learnWFA, learnDFA, SEED_CLASS,
    };
});
