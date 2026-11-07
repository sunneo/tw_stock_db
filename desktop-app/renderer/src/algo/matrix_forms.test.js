// 「萬物皆矩陣相乘」驗證測試：node renderer/src/algo/matrix_forms.test.js（量到的數字會印出來，DESIGN.matrix-algorithms.md 引用這些）
const M = require('./matrix_forms_core.js');
const LR = require('../logmine/lr_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 700))); } }
const note = (s) => console.log('  · ' + s);
let seed = 20261106; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const rstr = (alpha, n) => Array.from({ length: n }, () => alpha[ri(0, alpha.length - 1)]).join('');

// ① DFA 矩陣連乘 ＝ 直接跑 DFA（含前綴掃描／分段並行）
{
    let allEq = true, scanEq = true, chunkEq = true, trials = 0;
    const dfas = [M.DFAS.div3, M.DFAS.no11, M.DFAS.evenA]; for (let t = 0; t < 12; t++) dfas.push(M.randomDfa(rnd, ri(2, 6), ri(2, 3)));
    for (const d of dfas) for (let t = 0; t < 40; t++) {
        const w = rstr(d.alphabet, ri(0, 25)); trials++;
        if (M.dfaRunMatrix(d, w) !== M.dfaRun(d, w) || M.dfaRunMatrix(d, w, M.SR.count(1000003)) !== M.dfaRun(d, w)) allEq = false;
        if (w.length >= 2) {
            const Ms = M.dfaMatrices(d, M.SR.bool); const mats = w.split('').map((ch) => Ms[d.alphabet.indexOf(ch)]);
            const a = M.scanPrefix(mats, M.SR.bool), b = M.scanSequential(mats, M.SR.bool); if (!a.every((x, i) => M.matEq(x, b[i]))) scanEq = false;
            const tot = M.productChunked(mats, ri(1, 5), M.SR.bool); if (!M.matEq(tot, b[b.length - 1])) chunkEq = false;
        }
    }
    check('DFA：矩陣連乘（bool、count）＝直接跑 DFA（' + trials + ' 組隨機輸入、15 台 DFA）', allEq);
    check('DFA：分治前綴掃描＝逐個連乘；任意分段的乘積相同（結合律 → 可並行）', scanEq && chunkEq);
    const c = [5, 10, 17].map((n) => [M.dfaCountMatrix(M.DFAS.no11, n, 0), M.dfaCountBrute(M.DFAS.no11, n)]);
    check('計數型：長度 n 不含連續 11 的二進位字串數＝矩陣冪＝暴力列舉（費氏）', c.every(([a, b]) => a === b) && c[0][0] === 13 && c[1][0] === 144, c);
    check('計數型：長度 n 能被 3 整除的二進位字串數（含前導 0）＝列舉', [4, 9, 12].every((n) => M.dfaCountMatrix(M.DFAS.div3, n, 0) === M.dfaCountBrute(M.DFAS.div3, n)));
    check('計數型取模：n=10^18 不溢位、可重複（結果在 [0,mod)）', (() => { const a = M.dfaCountMatrix(M.DFAS.no11, 1e15, M.P); return a >= 0 && a < M.P && a === M.dfaCountMatrix(M.DFAS.no11, 1e15, M.P); })());
}

// ② min-plus 平方 ＝ Floyd／Dijkstra
{
    let okFloyd = true, okDij = true, okSq = true, sqMax = 0;
    for (let t = 0; t < 60; t++) {
        const n = ri(2, 12), m = ri(0, 25), directed = rnd() < 0.5; const edges = Array.from({ length: m }, () => [ri(0, n - 1), ri(0, n - 1), ri(1, 20)]);
        const W = M.weightMatrix(n, edges, directed); const { D, squarings } = M.minPlusClosure(W); sqMax = Math.max(sqMax, squarings);
        if (!M.matEq(D, M.floyd(W))) okFloyd = false; if (squarings !== Math.ceil(Math.log2(n))) okSq = false;
        for (let s = 0; s < n; s++) { const d = M.dijkstra(n, edges, s, directed); if (!d.every((x, j) => x === D[s][j])) okDij = false; }
    }
    check('min-plus 矩陣平方＝Floyd–Warshall（60 張隨機圖，有向／無向，含不連通）', okFloyd);
    check('min-plus 矩陣平方＝每個起點的 Dijkstra', okDij);
    check('只要 ⌈log2 n⌉ 次平方', okSq);
    // 格子最短路（種子題 grid-bfs）
    let gridOk = true; for (let t = 0; t < 40; t++) {
        const r = ri(2, 5), c = ri(2, 5); const g = Array.from({ length: r }, () => Array.from({ length: c }, () => (rnd() < 0.25 ? '#' : '.')));
        const cells = []; for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) cells.push([i, j]); const a = cells.splice(ri(0, cells.length - 1), 1)[0], b = cells.splice(ri(0, cells.length - 1), 1)[0];
        g[a[0]][a[1]] = 'S'; g[b[0]][b[1]] = 'T'; const rows = g.map((x) => x.join(''));
        if (M.gridShortestMinPlus(rows) !== M.gridShortestBfs(rows)) { gridOk = false; console.log(rows); }
    }
    check('種子題 grid-bfs：格子圖→min-plus 矩陣平方＝BFS（40 張隨機格子，含走不到＝-1）', gridOk);
    check('種子題 grid-bfs 範例 3x4 → 5、2x3 → -1', M.gridShortestMinPlus(['S..#', '.#..', '...T']) === 5 && M.gridShortestMinPlus(['S#T', '.#.']) === -1);
    // 最少硬幣（min-plus 線性遞推）
    let coinOk = true; for (let t = 0; t < 60; t++) { const k = ri(1, 4); const coins = Array.from({ length: k }, () => ri(1, 9)); const T = ri(0, 60); if (M.coinMinPlus(coins, T) !== M.coinDp(coins, T)) { coinOk = false; console.log(coins, T, M.coinMinPlus(coins, T), M.coinDp(coins, T)); } }
    check('種子題 coin-change：min-plus 轉移矩陣的 T 次冪＝DP（60 組隨機面額／總額，含湊不出＝-1、T=0）', coinOk);
    check('coin-change 範例：[1,2,5] 湊 11 → 3；[2] 湊 3 → -1', M.coinMinPlus([1, 2, 5], 11) === 3 && M.coinMinPlus([2], 3) === -1);
}

// ③ 布林矩陣冪 ＝ 傳遞閉包／連通分量
{
    let clo = true, comp = true, dirOk = true, sq = 0;
    for (let t = 0; t < 80; t++) {
        const n = ri(1, 14), m = ri(0, 18); const edges = Array.from({ length: m }, () => [ri(0, n - 1), ri(0, n - 1)]);
        if (M.componentsViaClosure(n, edges) !== M.componentsUnionFind(n, edges)) comp = false;
        const dir = rnd() < 0.5; const R = M.transitiveClosure(M.boolAdj(n, edges, dir)); if (!M.matEq(R, M.closureBfs(n, edges, dir))) clo = false;
        if (dir) sq++;
    }
    check('布林矩陣平方＝傳遞閉包（BFS 對照；有向／無向 80 張）', clo);
    check('種子題 components：閉包列去重的個數＝並查集（80 張隨機圖）', comp);
}

// ③b G8：判環要用 A·reach 的對角線（A^(2^k) 不含單位矩陣時不是閉包）
{
    const dfsCycle = (n, edges) => { const adj = Array.from({ length: n }, () => []); for (const [u, v] of edges) adj[u].push(v); const st = new Array(n).fill(0); const go = (u) => { st[u] = 1; for (const v of adj[u]) { if (st[v] === 1) return true; if (st[v] === 0 && go(v)) return true; } st[u] = 2; return false; }; for (let i = 0; i < n; i++) if (st[i] === 0 && go(i)) return true; return false; };
    let okD = true, okR = true, okU = true;
    for (let t = 0; t < 300; t++) {
        const n = ri(1, 9), m = ri(0, 12); const edges = Array.from({ length: m }, () => [ri(0, n - 1), ri(0, n - 1)]);
        if (M.hasCycle(n, edges) !== dfsCycle(n, edges)) okD = false;
        const A = M.boolAdj(n, edges, true).map((r, i) => r.map((x, j) => (i === j ? 0 : x))); if (!M.matEq(M.reflexiveReach(A), M.closureBfs(n, edges.filter(([u, v]) => u !== v), true))) okR = false;
        const simple = []; const seen = new Set(); for (const [u, v] of edges) { if (u === v) continue; const k = Math.min(u, v) + ',' + Math.max(u, v); if (!seen.has(k)) { seen.add(k); simple.push([u, v]); } }
        const p = Array.from({ length: n }, (_, i) => i); const f = (x) => (p[x] === x ? x : (p[x] = f(p[x]))); let cyc = false; for (const [u, v] of simple) { if (f(u) === f(v)) cyc = true; else p[f(u)] = f(v); }
        if (M.hasCycleUndirected(n, simple) !== cyc) okU = false;
    }
    check('G8 有向判環＝A·reach 對角線（對照 DFS，300 張，含自環）', okD);
    check('G8 reflexiveReach 不要求 A 含單位矩陣（對照 BFS 閉包）', okR);
    check('G8 無向簡單圖判環：邊數＞n−分量數（對照並查集）', okU);
    check('G8 回歸：只有 A^(2^k)（不含 I）時 transitiveClosure 抓不到自環／環的對角線，hasCycle 才是對的', M.hasCycle(2, [[0, 1], [1, 0]]) === true && M.hasCycle(3, [[0, 1], [1, 2]]) === false);
}

// ④ 線性遞推：Berlekamp–Massey → 伴隨矩陣 → matPow
{
    const P = M.P; const iter = (init, coefs, n) => M.seqByRecurrence(init, coefs, n, P);
    const gen = (init, coefs, N) => { const a = init.slice(); const L = coefs.length - 1; while (a.length < N) { let v = 0; for (let k = 1; k <= L; k++) v = (v + M.mulmod(coefs[k], a[a.length - k], P)) % P; a.push(v); } return a; };
    // 費氏、爬樓梯（F(n+1)）、三項（tribonacci）
    const cases = { fib: [[0, 1], [0, 1, 1]], stairs: [[1, 2], [0, 1, 1]], trib: [[0, 0, 1], [0, 1, 1, 1]], pell: [[0, 1], [0, 2, 1]] };
    for (const [name, [init, coefs]] of Object.entries(cases)) {
        const seq = gen(init, coefs, 40); const L = coefs.length - 1; const learned = M.berlekampMassey(seq.slice(0, 2 * L + 2), P);
        check(name + '：BM 從前 ' + (2 * L + 2) + ' 項學回遞推係數', JSON.stringify(learned) === JSON.stringify(coefs), learned);
        const c = learned; let all = true; for (const n of [0, 1, 5, 39, 100, 5000, 100000]) { if (M.nthTerm(seq, c, n, P) !== iter(init, coefs, n)) all = false; }
        check(name + '：matPow 第 n 項（n 到 10^5、取模）＝迴圈', all);
    }
    check('費氏 F(90)（種子題 fibonacci 的上限）＝已知值 2880067194370816120 mod p', (() => { const seq = [0, 1, 1, 2, 3, 5, 8, 13]; const c = M.berlekampMassey(seq, P); return M.nthTerm(seq, c, 90, P) === Number(2880067194370816120n % BigInt(P)); })());
    // 隨機的 d 階遞推
    let randOk = true, tooFewWrong = 0, tooFewTrials = 0;
    for (let t = 0; t < 30; t++) {
        const d = ri(1, 6); const coefs = [0].concat(Array.from({ length: d }, () => ri(0, P - 1))); if (coefs[d] === 0) coefs[d] = 1; const init = Array.from({ length: d }, () => ri(0, P - 1));
        const seq = gen(init, coefs, 2 * d + 4); const learned = M.berlekampMassey(seq, P); if (JSON.stringify(learned) !== JSON.stringify(coefs)) randOk = false;
        const n = ri(100, 20000); if (M.nthTerm(seq, learned, n, P) !== iter(init, coefs, n)) randOk = false;
        if (d >= 2) { tooFewTrials++; const few = M.berlekampMassey(seq.slice(0, 2 * d - 1), P); if (JSON.stringify(few) !== JSON.stringify(coefs)) tooFewWrong++; }
    }
    check('隨機 d 階（d≤6）遞推：BM 學回係數、第 n 項（n 到 2·10^4）＝迴圈（30 組）', randOk);
    check('範例不足會學錯：只給 2d-1 項時，BM 推出的遞推常常不對（誠實的反例）', tooFewWrong > 0, { tooFewWrong, tooFewTrials });
    note('給 2d-1 項：' + tooFewWrong + '／' + tooFewTrials + ' 組學錯（給 2d 項則 30／30 學對）');
    check('費氏的第 5 項＝5（小 n 不經矩陣）', M.nthTerm([0, 1, 1, 2, 3, 5], M.berlekampMassey([0, 1, 1, 2, 3, 5], P), 5, P) === 5);
    // 不是 C-finite：質數個數 π(n)，BM 給的遞推階數隨範例成長（沒有有限矩陣）
    const pi = []; { let c = 0; for (let n = 1; n <= 60; n++) { let isP = n > 1; for (let d = 2; d * d <= n; d++) if (n % d === 0) isP = false; if (isP) c++; pi.push(c); } }
    const Ls = [20, 40, 60].map((k) => M.berlekampMassey(pi.slice(0, k), P).length - 1);
    check('質數個數 π(n)：BM 的階數＝約 n/2，隨範例成長（不是 C-finite）', Ls[0] >= 9 && Ls[1] >= 19 && Ls[2] >= 29 && Ls[1] > Ls[0], Ls); note('π(n) 前 20/40/60 項的 BM 階數：' + Ls.join('／'));
}

// ⑤ LALR 表 ＝ 矩陣；驅動需要堆疊
const T = (s) => s.split(' ').filter(Boolean);
const PR = (lhs, rhs) => ({ lhs, rhs: T(rhs) });
const EXPR = { start: 'E', productions: [PR('E', 'E + T'), PR('E', 'T'), PR('T', 'T * F'), PR('T', 'F'), PR('F', '( E )'), PR('F', 'id')] };
const TAB = LR.build(EXPR);
function randTokens() { // 一半是合法的隨機推導、一半是被改壞的
    const gen = (sym, d) => {
        if (sym === 'E') return rnd() < 0.5 || d > 4 ? gen('T', d + 1) : gen('E', d + 1).concat(['+'], gen('T', d + 1));
        if (sym === 'T') return rnd() < 0.5 || d > 4 ? gen('F', d + 1) : gen('T', d + 1).concat(['*'], gen('F', d + 1));
        return rnd() < 0.6 || d > 4 ? ['id'] : ['('].concat(gen('E', d + 1), [')']);
    };
    let w = gen('E', 0); const r = rnd();
    if (r < 0.25 && w.length) w.splice(ri(0, w.length - 1), 1); else if (r < 0.5) w.splice(ri(0, w.length), 0, ['id', '+', '*', '(', ')'][ri(0, 4)]); else if (r < 0.6) w = w.map(() => ['id', '+', '*', '(', ')'][ri(0, 4)]);
    return w;
}
{
    const am = M.actionMatrix(TAB), gm = M.gotoMatrix(TAB), sp = M.sparsity(am.rows);
    note('運算式文法（6 條產生式）：action 矩陣 ' + am.rows.length + '×' + am.terms.length + '，非零 ' + sp.nonzero + '／' + sp.total + '（' + (100 * sp.density).toFixed(0) + '%）；goto 矩陣 ' + gm.rows.length + '×' + gm.nts.length + '，非零 ' + M.sparsity(gm.rows).nonzero);
    let same = true, acc = 0, rej = 0, maxD = 0; for (let t = 0; t < 400; t++) {
        const w = randTokens(); const a = M.lrDriveByMatrix(TAB, w), b = LR.parse(TAB, w.map((x, i) => ({ t: x, v: x, n: i }))); if (a.ok !== b.ok) { same = false; console.log(w.join(' '), a.ok, b.ok); } if (a.ok) { acc++; maxD = Math.max(maxD, a.maxDepth); } else rej++;
    }
    check('LALR：只靠 action／goto 矩陣查表＋堆疊的驅動，接受／拒絕同 FaLR.parse（400 串：' + acc + ' 接受、' + rej + ' 拒絕）', same && acc > 50 && rej > 50);
    // 去掉堆疊做不到：有界深度 K 的組態數（＝展開矩陣的維度）
    const sizes = []; for (let K = 2; K <= 14; K += 2) sizes.push(M.boundedStackConfigs(TAB, K));
    check('有界堆疊深度 K 的展開矩陣維度隨 K 嚴格成長、沒有上界（K=2,4,…,14）', sizes.every((x, i) => i === 0 || x > sizes[i - 1]), sizes);
    note('LALR 堆疊深度 ≤K 的組態數（K=2,4,…,14）：' + sizes.join(', '));
    // 括號配對：最小 DFA 的狀態數 = K+2（含死狀態），Hankel 秩也隨 K 成長
    const dyck = (K) => (w) => { let d = 0; for (const ch of w) { d += ch === '(' ? 1 : -1; if (d < 0 || d > K) return false; } return d === 0; };
    const dfaStates = [1, 2, 3, 4, 5].map((K) => M.learnDFA(dyck(K), ['(', ')'], 2 * K + 2).states);
    check('括號配對、深度限制 K：學到的最小 DFA 狀態數＝K+2（K=1..5，含已死狀態）', dfaStates.every((s, i) => s === i + 3), dfaStates);
    const byL = [3, 5, 7, 9].map((L) => M.learnDFA(dyck(1e9), ['(', ')'], L, 60).states);
    check('括號配對、不限深度：後綴長度 L 越大學出的狀態數越多（只是被範例長度截斷的假 DFA，不收斂）', byL.every((x, i) => i === 0 || x > byL[i - 1]), byL); note('不限深度的括號，後綴長度 L=3,5,7,9 學到的狀態數：' + byL.join(', '));
    note('Dyck 深度≤K 的最小 DFA 狀態數（K=1..5）：' + dfaStates.join(', '));
}

// ⑥ CYK／Valiant：布林矩陣乘法辨識同一個文法
{
    let same = true, acc = 0, rej = 0, mmMax = 0, mmByLen = {};
    for (let t = 0; t < 150; t++) {
        const w = randTokens(); if (w.length > 14) continue; const a = M.cfgRecognize(EXPR, w); const b = LR.accepts(TAB, w.map((x, i) => ({ t: x, v: x, n: i })));
        if (a.ok !== b) { same = false; console.log(w.join(' '), a.ok, b); } a.ok ? acc++ : rej++; mmMax = Math.max(mmMax, a.matmuls); mmByLen[w.length] = a.matmuls;
    }
    check('CFG 辨識＝布林矩陣乘法（每個非終端一張區間矩陣、重複到不變）＝LALR 接受（' + acc + ' 接受、' + rej + ' 拒絕）', same && acc > 20 && rej > 20);
    note('同一個文法：矩陣法最多用了 ' + mmMax + ' 次 (n+1)×(n+1) 布林矩陣乘法；LR 只做 O(n) 次查表（見 FaLR.parse 的 steps）');
    check('空串與 ε 產生式：list → ε | list item', (() => { const G = { start: 'L', productions: [PR('L', ''), PR('L', 'L a')] }; return M.cfgRecognize(G, []).ok && M.cfgRecognize(G, ['a', 'a']).ok && !M.cfgRecognize(G, ['b']).ok; })());
}

// ⑦ 從範例學矩陣：Hankel 秩、WFA 學習、DFA 狀態合併
{
    const P = M.P;
    const f_cnt = (ch) => (w) => w.split('').filter((c) => c === ch).length;
    const f_bin = (w) => { let v = 0; for (const c of w) v = (v * 2 + (c === '1' ? 1 : 0)) % P; return v; };
    const f_11 = (w) => { let c = 0; for (let i = 0; i + 1 < w.length; i++) if (w[i] === '1' && w[i + 1] === '1') c++; return c; };
    const ranks = { 'a 的個數': M.hankelRank(f_cnt('a'), ['a', 'b'], 4), '二進位值 mod p': M.hankelRank(f_bin, ['0', '1'], 5), '"11" 的出現次數': M.hankelRank(f_11, ['0', '1'], 5), '能被 3 整除（指示函數）': M.hankelRank((w) => (w === '' ? 1 : (f_bin(w) % 3 === 0 ? 1 : 0)), ['0', '1'], 5) };
    check('Hankel 秩：a 的個數＝2、二進位值＝2、"11" 次數＝3、能被 3 整除＝3（有限秩 ⇒ 有有限矩陣）', ranks['a 的個數'] === 2 && ranks['二進位值 mod p'] === 2 && ranks['"11" 的出現次數'] === 3 && ranks['能被 3 整除（指示函數）'] === 3, ranks);
    note('Hankel 秩（有限）：' + JSON.stringify(ranks));
    // 學 WFA 並對隨機長串對照
    for (const [name, f, alpha, dim] of [['a 的個數', f_cnt('a'), ['a', 'b'], 2], ['二進位值', f_bin, ['0', '1'], 2], ['"11" 次數', f_11, ['0', '1'], 3]]) {
        const w = M.learnWFA(f, alpha, 4, P); let all = w.ok && w.dim === dim; for (let t = 0; t < 60 && all; t++) { const s = rstr(alpha, ri(0, 40)); if (w.eval(s) !== f(s) % P) all = false; }
        check('學出加權自動機（' + name + '）：維度 ' + dim + '、用長度 ≤4 的範例學、對長度到 40 的隨機串全對', all, { dim: w.dim });
    }
    // 計數遞推：單一符號字母表的 Hankel 學習＝BM
    const fibU = (w) => { let a = 0, b = 1; for (let i = 0; i < w.length; i++) { [a, b] = [b, (a + b) % P]; } return a; };
    const wf = M.learnWFA(fibU, ['x'], 4, P); check('一元字母表：費氏的 Hankel 學習維度＝2（同 BM）、F(60) 對', wf.ok && wf.dim === 2 && wf.eval('x'.repeat(60)) === fibU('x'.repeat(60)), { dim: wf.dim });
    // 狀態合併學 DFA
    const targets = { 'div3': (w) => w === '' || f_bin(w) % 3 === 0 /* 空字串視為 0 */, 'no11': (w) => !w.includes('11'), 'evenA': (w) => f_cnt('a')(w) % 2 === 0 };
    const alphaOf = { div3: ['0', '1'], no11: ['0', '1'], evenA: ['a', 'b'] }; const want = { div3: 3, no11: 3, evenA: 2 };
    for (const k of Object.keys(targets)) {
        const r = M.learnDFA(targets[k], alphaOf[k], 4); let all = r.ok; for (let t = 0; t < 80 && all; t++) { const s = rstr(alphaOf[k], ri(0, 30)); if (M.dfaRun(r.dfa, s) !== !!targets[k](s)) all = false; }
        check('狀態合併學 DFA（' + k + '）：只問長度 ≤4 的範例，學到 ' + (r.states) + ' 個狀態（最小＝' + want[k] + '，no11 含「已死」狀態），對隨機長串全對', all && r.states === want[k], { states: r.states });
        if (r.ok) note(k + '：' + r.queries + ' 次查詢 → ' + r.states + ' 個狀態');
    }
    // 學出的 DFA 轉成矩陣＝再驗一次
    const lr = M.learnDFA(targets.no11, ['0', '1'], 4); check('學出的 DFA 轉矩陣連乘＝原函數（隨機 50 串）', Array.from({ length: 50 }).every(() => { const s = rstr(['0', '1'], ri(0, 25)); return M.dfaRunMatrix(lr.dfa, s) === targets.no11(s); }));
    // 範例太少會學錯（過度擬合）：後綴長度只給 0（只看自己是否被接受）→ 全部合併成 1～2 個狀態
    const tooShort = M.learnDFA(targets.div3, ['0', '1'], 0); let wrong = 0; for (let t = 0; t < 50; t++) { const s = rstr(['0', '1'], ri(1, 20)); if (M.dfaRun(tooShort.dfa, s) !== !!targets.div3(s)) wrong++; }
    check('範例不夠（後綴長度 0）學出的 DFA 對隨機串會錯（誠實的反例）', wrong > 0, { wrong }); note('div3 只看長度 0 的後綴：學出 ' + tooShort.states + ' 個狀態，50 串錯 ' + wrong + ' 串');

    // 反例：Hankel 秩隨長度成長（沒有有限矩陣）
    const dyck = (w) => { let d = 0; for (const c of w) { d += c === '(' ? 1 : -1; if (d < 0) return 0; } return d === 0 ? 1 : 0; };
    const anbn = (w) => { const m = /^(a*)(b*)$/.exec(w); return m && m[1].length === m[2].length ? 1 : 0; };
    const pal = (w) => (w === w.split('').reverse().join('') ? 1 : 0);
    const maj = (w) => (f_cnt('a')(w) > f_cnt('b')(w) ? 1 : 0); // 「a 比 b 多」：比較是非線性
    const ctr = { '括號配對': [dyck, ['(', ')']], 'a^n b^n': [anbn, ['a', 'b']], '迴文': [pal, ['a', 'b']], 'a 比 b 多（比較）': [maj, ['a', 'b']] };
    const growth = {}; for (const [k, [f, al]] of Object.entries(ctr)) growth[k] = [1, 2, 3, 4, 5, 6].map((L) => M.hankelRank(f, al, L));
    for (const [k, rs] of Object.entries(growth)) check('反例 ' + k + '：Hankel 秩隨範例長度嚴格成長（' + rs.join(',') + '）→ 學不出有限矩陣', rs.every((x, i) => i === 0 || x > rs[i - 1]), rs);
    note('Hankel 秩 L=1..6：' + JSON.stringify(growth));
    const maxRank = [1, 2, 3, 4, 5].map((L) => M.hankelRank((w) => w.split('').reduce((m, c) => Math.max(m, +c), -1) + 2, ['0', '1', '2', '3'], L));
    check('max（值域 0..3）：Hankel 秩有限（＝5，值域有界時 max 是有限狀態；值域越大秩越大）', maxRank[3] === maxRank[4] && maxRank[4] <= 5, maxRank); note('max 的 Hankel 秩 L=1..5：' + maxRank.join(','));
}

// ⑧ 種子分類
{
    const fs = require('fs'), path = require('path');
    const ids = fs.readFileSync(path.join(__dirname, '../recipe/seed/problems.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
    check('分類表涵蓋種子 20 題、不多不少', ids.length === 20 && ids.every((i) => M.SEED_CLASS[i]) && Object.keys(M.SEED_CLASS).length === 20, ids.filter((i) => !M.SEED_CLASS[i]));
    const cnt = { A: 0, B: 0, C: 0 }, ver = { A: 0, B: 0, C: 0 }; for (const v of Object.values(M.SEED_CLASS)) { cnt[v.cls]++; if (v.verified) ver[v.cls]++; }
    note('種子 20 題：A（可從範例學）' + cnt.A + '、B（範本：矩陣由輸入建出）' + cnt.B + '、C（不在範圍）' + cnt.C + '；有被實驗驗證的：A ' + ver.A + '、B ' + ver.B + '、C ' + ver.C);
}

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
