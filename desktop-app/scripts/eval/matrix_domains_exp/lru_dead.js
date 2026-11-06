const MF = require('' + require('path').resolve(__dirname, '..', '..', '..', 'renderer') + '/src/algo/matrix_forms_core.js');
let sd = 3; const rnd = (n) => { sd = (Math.imul(sd, 1103515245) + 12345) & 0x7fffffff; return (sd >>> 8) % n; };
// ---- 1) LRU：槽位內容 S（k×V 0/1 矩陣，第 0 列最近用）；查詢＝S·e_x（線性），移到最前＝置換矩陣 P_p·S；未命中＝P_{k-1}·S 再把第 0 列換成 e_x ----
function lruMatrix(k, V, seq) {
    let S = Array.from({ length: k }, () => Array(V).fill(0)); let hits = 0;
    const perm = (p) => { const P = Array.from({ length: k }, () => Array(k).fill(0)); P[0][p] = 1; let r = 1; for (let i = 0; i < k; i++) if (i !== p) P[r++][i] = 1; return P; };
    const mul = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((s, a, t) => s + a * B[t][j], 0)));
    for (const x of seq) {
        const h = S.map((row) => row[x]);               // S·e_x：關聯查詢（線性）
        const p = h.indexOf(1);                          // ← 控制：argmax／索引（不是矩陣運算）
        if (p >= 0) { hits++; S = mul(perm(p), S); } else { S = mul(perm(k - 1), S); S[0] = Array(V).fill(0); S[0][x] = 1; }
    }
    return hits;
}
function lruRef(k, seq) { const c = []; let hits = 0; for (const x of seq) { const i = c.indexOf(x); if (i >= 0) { hits++; c.splice(i, 1); } else if (c.length === k) c.pop(); c.unshift(x); } return hits; }
let ok = 0, N = 300; for (let t = 0; t < N; t++) { const k = 1 + rnd(4), V = 2 + rnd(7), seq = Array.from({ length: 5 + rnd(30) }, () => rnd(V)); if (lruMatrix(k, V, seq) === lruRef(k, seq)) ok++; }
console.log('LRU（置換矩陣＋one-hot 關聯查詢）對字典版參考：', ok + '/' + N);
// ---- 2) 死結偵測：等待圖 → 布林半環傳遞閉包，對角線有 1 ＝ 有環 ----
function hasCycleDFS(n, E) { const adj = Array.from({ length: n }, () => []); for (const [a, b] of E) adj[a].push(b); const st = Array(n).fill(0); const go = (u) => { st[u] = 1; for (const v of adj[u]) { if (st[v] === 1) return true; if (st[v] === 0 && go(v)) return true; } st[u] = 2; return false; }; for (let i = 0; i < n; i++) if (st[i] === 0 && go(i)) return true; return false; }
ok = 0; N = 500; for (let t = 0; t < N; t++) { const n = 2 + rnd(8), m = rnd(n + 3); const E = []; for (let i = 0; i < m; i++) E.push([rnd(n), rnd(n)]);
    const A = MF.zeros(n, n, MF.SR.bool); for (const [a, b] of E) A[a][b] = true === MF.SR.bool.one ? MF.SR.bool.one : 1; 
    const C = MF.transitiveClosure(A.map((r) => r.map((x) => (x && x !== MF.SR.bool.zero ? MF.SR.bool.one : MF.SR.bool.zero)))); let cyc = false; for (let i = 0; i < n; i++) if (C[i][i] !== MF.SR.bool.zero && C[i][i]) cyc = true;
    if (cyc === hasCycleDFS(n, E)) ok++; }
console.log('死結偵測（布林閉包對角線）對 DFS：', ok + '/' + N);
// 修正版：reach = (A∨I)^(2^k)；有環 ⇔ (A·reach) 的對角線有 1
ok = 0; for (let t = 0; t < 500; t++) { const n = 2 + rnd(8), m = rnd(n + 3); const E = []; for (let i = 0; i < m; i++) E.push([rnd(n), rnd(n)]);
    const S = MF.SR.bool; const A = MF.zeros(n, n, S); const AI = MF.zeros(n, n, S); for (let i = 0; i < n; i++) AI[i][i] = S.one; for (const [a, b] of E) { A[a][b] = S.one; AI[a][b] = S.one; }
    let R = AI; for (let l = 1; l < n; l *= 2) R = MF.matMul(R, R, S); const X = MF.matMul(A, R, S); let cyc = false; for (let i = 0; i < n; i++) if (X[i][i] !== S.zero) cyc = true; if (cyc === hasCycleDFS(n, E)) ok++; }
console.log('死結偵測（修正：(A∨I) 冪、A·reach 對角線）對 DFS：', ok + '/500');
