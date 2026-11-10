'use strict';
// 領域包「進階圖第二批」：train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。參考解獨立手寫（暴力枚舉、排列、DFS 找增廣路、迭代加深…，跟骨架做法不同）。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const G3 = require('./domain_graph3_core.js');
const sz = (b) => rnd(3, b ? 9 : 6);
const wedges = (n, m) => { const E = []; for (let i = 0; i < m; i++) { const u = rnd(1, n), v = rnd(1, n); if (u !== v) E.push([u, v, rnd(1, 9)]); } if (!E.length) E.push([1, 2, rnd(1, 9)]); return E; };
const txt = (n, E) => E.map((e) => e.join(' ')).join('\n');
const fGen = (b) => { const n = sz(b); const E = wedges(n, rnd(n, 2 * n)); const q = rnd(2, 5); const Q = Array.from({ length: q }, () => [rnd(1, n), rnd(1, n)]); return n + ' ' + E.length + '\n' + txt(n, E) + '\n' + q + '\n' + Q.map((x) => x.join(' ')).join('\n') + '\n'; };
const f2Gen = (b) => { const n = sz(b); const E = wedges(n, rnd(n, 2 * n)); return n + ' ' + E.length + '\n' + txt(n, E) + '\n'; };
// Floyd 的參考解：每個起點各做一次 Bellman-Ford（dir＝有向／無向）
const FL = (dir, out) => 'import sys\nd = sys.stdin.read().split()\nn, m = int(d[0]), int(d[1])\nes = []\nfor i in range(m):\n    a, b, c = int(d[2+3*i]), int(d[3+3*i]), int(d[4+3*i])\n    es.append((a, b, c))\n    ' + (dir ? 'pass' : 'es.append((b, a, c))') + '\nINF = float("inf")\nD = {}\nfor s in range(1, n+1):\n    t = {v: INF for v in range(1, n+1)}\n    t[s] = 0\n    for _ in range(n):\n        for a, b, c in es:\n            if t[a] + c < t[b]:\n                t[b] = t[a] + c\n    D[s] = t\n' + out + '\n';
const FQ = (dir) => FL(dir, 'q = int(d[2+3*m])\nfor i in range(q):\n    a, b = int(d[3+3*m+2*i]), int(d[4+3*m+2*i])\n    print(-1 if D[a][b] == INF else D[a][b])');
const FSUM = (dir, un) => FL(dir, 'print(sum(D[a][b] for a in D for b in D if ' + (un ? 'a < b' : 'a != b') + ' and D[a][b] < INF))');
const FDI = (dir) => FL(dir, 'print(max(D[a][b] for a in D for b in D if D[a][b] < INF))');
const FRE = (dir) => FL(dir, 'print(sum(1 for a in D for b in D if a != b and D[a][b] < INF))');
const FMX = (dir) => FL(dir, 'for a in range(1, n+1):\n    print(*[-1 if D[a][b] == INF else D[a][b] for b in range(1, n+1)])');
// 二分圖匹配：暴力（遞迴試每個左點配誰）
const bmGen = (b) => { const n = rnd(2, b ? 7 : 5), m = rnd(2, b ? 7 : 5); const E = []; const seen = new Set(); const k = rnd(2, n * m); for (let i = 0; i < k; i++) { const a = rnd(1, n), c = rnd(1, m); if (!seen.has(a + ',' + c)) { seen.add(a + ',' + c); E.push([a, c]); } } return n + ' ' + m + ' ' + E.length + '\n' + txt(0, E) + '\n'; };
const BM = (out) => 'import sys\nd = sys.stdin.read().split()\nn, m, e = int(d[0]), int(d[1]), int(d[2])\nok = {}\nfor i in range(e):\n    ok.setdefault(int(d[3+2*i]), set()).add(int(d[4+2*i]))\ndef best(i, used):\n    if i > n:\n        return 0\n    r = best(i + 1, used)\n    for y in ok.get(i, ()):\n        if y not in used:\n            r = max(r, 1 + best(i + 1, used | {y}))\n    return r\nsize = best(1, frozenset())\n' + out + '\n';
// 指派：排列暴力
const asGen = (b) => { const n = rnd(2, b ? 7 : 5); return n + '\n' + Array.from({ length: n }, () => Array.from({ length: n }, () => rnd(1, 30)).join(' ')).join('\n') + '\n'; };
const AS = (f) => 'import itertools\nn = int(input())\nc = [list(map(int, input().split())) for _ in range(n)]\nprint(' + f + '(sum(c[i][p[i]] for i in range(n)) for p in itertools.permutations(range(n))))\n';
// 最短路變體
const pGen = (b, k) => { const n = rnd(3, b ? 8 : 6); const E = wedges(n, rnd(n, 2 * n)); const s = rnd(1, n); let t = rnd(1, n); if (t === s) t = (s % n) + 1; return n + ' ' + E.length + ' ' + s + ' ' + t + (k ? ' ' + k : '') + '\n' + txt(n, E) + '\n'; };
const pkGen = (b) => pGen(b, rnd(1, 4));
const PHEAD = '\nimport sys\nsys.setrecursionlimit(10000)\nd = sys.stdin.read().split()\nn, m, s, t = int(d[0]), int(d[1]), int(d[2]), int(d[3])\nK = 4\nes = []\nfor i in range(m):\n    a, b, c = int(d[K+3*i]), int(d[K+1+3*i]), int(d[K+2+3*i])\n    es.append((a, b, c))\n';
const SPH = (dir, kk) => 'import sys\nsys.setrecursionlimit(10000)\nd = sys.stdin.read().split()\nn, m, s, t = int(d[0]), int(d[1]), int(d[2]), int(d[3])\nK = ' + (kk ? 5 : 4) + '\n' + (kk ? 'k = int(d[4])\n' : '') + 'adj = {i: [] for i in range(1, n+1)}\nfor i in range(m):\n    a, b, c = int(d[K+3*i]), int(d[K+1+3*i]), int(d[K+2+3*i])\n    adj[a].append((b, c))\n' + (dir ? '' : '    adj[b].append((a, c))\n');
const ALLP = 'allp = []\ndef go(x, path, w):\n    if x == t:\n        allp.append((w, path))\n        return\n    for y, c in adj[x]:\n        if y not in path:\n            go(y, path + [y], w + c)\ngo(s, [s], 0)\nallp.sort()\n';
const PATH = (dir) => SPH(dir, false) + ALLP + 'if not allp:\n    print(-1)\nelse:\n    bw = allp[0][0]\n    print(*min(p for w, p in allp if w == bw))\n';
const HOPS = (dir) => SPH(dir, false) + ALLP + 'if not allp:\n    print(-1)\nelse:\n    bw = allp[0][0]\n    print(min(len(p) - 1 for w, p in allp if w == bw))\n';
const CNT = (dir, f) => SPH(dir, false) + ALLP + 'if not allp:\n    print(0)\nelse:\n    c = sum(1 for w, p in allp if w == allp[0][0])\n    ' + f + '\n';
const KSIMPLE = (dir) => SPH(dir, true) + ALLP + 'ls = [w for w, p in allp]\nprint(ls[k-1] if len(ls) >= k else -1)\n';
const KWALK = (dir) => SPH(dir, true) + 'B = 5\nwhile True:\n    cnt = []\n    def dfs(x, w):\n        if x == t:\n            cnt.append(w)\n        for y, c in adj[x]:\n            if w + c <= B:\n                dfs(y, w + c)\n    dfs(s, 0)\n    if len(cnt) >= k:\n        cnt.sort()\n        print(cnt[k-1])\n        break\n    if B > 60:\n        print(-1)\n        break\n    B *= 2\n';
const LIM = (dir, exact) => SPH(dir, true) + 'INF = None\nlayer = {s: 0}\n' + (exact ? '' : 'best = {s: 0}\n') + 'for _ in range(k):\n    nl = {}\n    for x, w in layer.items():\n        for y, c in adj[x]:\n            if y not in nl or w + c < nl[y]:\n                nl[y] = w + c\n' + (exact ? '    layer = nl\nprint(layer.get(t, -1))\n' : '    for y, w in nl.items():\n        if y not in best or w < best[y]:\n            best[y] = w\n    layer = nl\nprint(best.get(t, -1))\n');
const kWalkGen = (b) => pGen(b, rnd(1, 3));
const rw = (s) => s.replace(/\bm\b/g, 'e');
const E1 = '接著 m 行每行 u v w 表示 u 到 v 有一條權重為 w 的有向邊。';
const E2 = '接著 m 行每行 u v w 表示 u 和 v 之間有一條權重為 w 的無向邊。';
const SEEDS = [
    { id: 'fl-q', want: 'graph3.floyd', st: '第一行 n m，' + E1 + '接著一行 q，再接 q 行每行 a b。用 Floyd-Warshall 求所有點對的最短路，對每個查詢輸出 a 到 b 的最短距離，不可達輸出 -1。', ref: FQ(true), gen: fGen, rw },
    { id: 'fl-sum', want: 'graph3.floyd', st: '第一行 n m，' + E2 + '用 Floyd 演算法算出每一對點的最短距離，輸出所有不同點對 (i, j)（i < j）的最短距離總和；不連通的點對不計入。', ref: FSUM(false, true), gen: f2Gen, rw },
    { id: 'fl-diam', want: 'graph3.floyd', st: '第一行 n m，' + E2 + '用 Floyd 求出全點對最短路後，輸出所有最短距離裡最大的有限值（圖的直徑）。', ref: FDI(false), gen: f2Gen, rw },
    { id: 'fl-reach', want: 'graph3.floyd', st: '第一行 n m，' + E1 + '用 Floyd 求所有點對的最短路，輸出有幾對 (a, b)（a ≠ b）可以從 a 走到 b。', ref: FRE(true), gen: f2Gen, rw },
    { id: 'fl-matrix', want: 'graph3.floyd', st: '第一行 n m，' + E1 + '用 Floyd 求所有點對最短路，輸出 n 行，第 i 行有 n 個整數，是 i 到每個點的最短距離，不可達輸出 -1。', ref: FMX(true), gen: f2Gen, rw },
    { id: 'bm-size', want: 'graph3.matching', st: '第一行 n m e，二分圖左邊有 n 個點、右邊有 m 個點，接著 e 行每行 a b 表示左邊的 a 和右邊的 b 之間有一條邊。輸出最大匹配數。', ref: BM('print(size)'), gen: bmGen },
    { id: 'bm-perfect', want: 'graph3.matching', st: '第一行 n m e，二分圖左邊有 n 個點、右邊有 m 個點，接著 e 行每行 a b 表示左邊的 a 和右邊的 b 之間有一條邊。如果左邊每個點都能配到不同的右邊點輸出 YES，否則輸出 NO。', ref: BM('print("YES" if size == n else "NO")'), gen: bmGen },
    { id: 'bm-free', want: 'graph3.matching', st: '第一行 n m e，二分圖左邊有 n 個點、右邊有 m 個點，接著 e 行每行 a b 表示左邊的 a 和右邊的 b 之間有一條邊。求最大匹配後，左邊有幾個點沒有配到對象？', ref: BM('print(n - size)'), gen: bmGen },
    { id: 'bm-indep', want: 'graph3.matching', st: '第一行 n m e，二分圖左邊有 n 個點、右邊有 m 個點，接著 e 行每行 a b 表示左邊的 a 和右邊的 b 之間有一條邊。輸出最大獨立集的大小（提示：點數總和減去最大匹配數）。', ref: BM('print(n + m - size)'), gen: bmGen },
    { id: 'as-min', want: 'graph3.assignment', st: '第一行 n，接著 n 行，每行 n 個整數，第 i 行第 j 個數是第 i 位工人做第 j 件工作的成本。每位工人恰好做一件工作，每件工作恰好由一位工人完成，用匈牙利演算法求最小總成本。', ref: AS('min'), gen: asGen, rw: (s) => s.replace(/\bn\b/g, 'k') },
    { id: 'as-max', want: 'graph3.assignment', st: '第一行 n，接著 n 行，每行 n 個整數，第 i 行第 j 個數是第 i 位工人做第 j 件工作的收益。每位工人恰好做一件工作，每件工作恰好由一位工人完成，求最大總收益（指派問題）。', ref: AS('max'), gen: asGen },
    { id: 'sp-path', want: 'graph3.sp-path', st: '第一行 n m s t，' + E1 + '輸出從 s 到 t 的最短路徑上依序經過的節點編號，用空白隔開；若有多條最短路徑，輸出字典序最小的那一條；s 到不了 t 輸出 -1。', ref: PATH(true), gen: (b) => pGen(b), rw },
    { id: 'sp-hops', want: 'graph3.sp-path', st: '第一行 n m s t，' + E2 + '在所有權重總和最小的 s 到 t 的路徑中，輸出最少需要經過幾條邊；到不了輸出 -1。', ref: HOPS(false), gen: (b) => pGen(b), rw },
    { id: 'sp-count', want: 'graph3.sp-count', st: '第一行 n m s t，' + E1 + '輸出從 s 到 t 的最短路有幾條（權重總和最小的路徑條數）；到不了輸出 0。', ref: CNT(true, 'print(c)'), gen: (b) => pGen(b), rw },
    { id: 'sp-unique', want: 'graph3.sp-count', st: '第一行 n m s t，' + E2 + '如果從 s 到 t 的最短路徑只有一條輸出 UNIQUE，有多條輸出 MULTI，到不了也輸出 MULTI。', ref: CNT(false, 'print("UNIQUE" if c == 1 else "MULTI")').replace("print(0)", 'print("MULTI")'), gen: (b) => pGen(b), rw },
    { id: 'sp-kth', want: 'graph3.sp-kth', st: '第一行 n m s t k，' + E1 + '路徑不能重複經過同一個點。輸出從 s 到 t 第 k 短的路徑長度，若路徑不到 k 條輸出 -1。', ref: KSIMPLE(true), gen: pkGen, rw },
    { id: 'sp-kwalk', want: 'graph3.sp-kth', st: '第一行 n m s t k，' + E1 + '走的路線可以重複經過同一個點與同一條邊。輸出 s 到 t 第 k 短的走法的總長度（長度相同的走法算不同的走法），不存在輸出 -1。', ref: KWALK(true), gen: kWalkGen, rw },
    { id: 'sp-atmost', want: 'graph3.sp-limit', st: '第一行 n m s t k，' + E1 + '輸出從 s 到 t 最多使用 k 條邊的最短距離，辦不到輸出 -1。', ref: LIM(true, false), gen: pkGen, rw },
    { id: 'sp-exact', want: 'graph3.sp-limit', st: '第一行 n m s t k，' + E2 + '輸出從 s 到 t 恰好走 k 條邊（可以重複經過點）的最短距離，辦不到輸出 -1。', ref: LIM(false, true), gen: pkGen, rw },
    // ── holdout：另寫措辭，只量測 ──
    { id: 'ho-floyd', split: 'holdout', st: '第一行 n m，接著 m 行每行 a b c，代表 a 與 b 之間有條長度 c 的道路（雙向通行）。接著一行 q，再有 q 行每行 x y，每次詢問 x 到 y 的最短路程，到不了就輸出 -1。請對所有點對先預處理（O(n^3) 的 Floyd）。', ref: FQ(false), gen: fGen },
    { id: 'ho-match', split: 'holdout', st: '第一行 n m e：有 n 位學生和 m 間社團，接著 e 行每行 a b，表示學生 a 願意加入社團 b；每位學生最多加入一個社團，每個社團最多收一位學生。輸出最多可以讓幾位學生成功入社。', ref: BM('print(size)'), gen: bmGen },
    { id: 'ho-assign', split: 'holdout', st: '第一行 n，之後 n 行各 n 個整數，第 i 行第 j 個數是派第 i 台機器去做第 j 個任務所需的時間。一台機器只做一個任務、一個任務只由一台機器做，求全部任務完成所需的最小時間總和。', ref: AS('min'), gen: asGen },
    { id: 'ho-path', split: 'holdout', st: '第一行 n m s t，接著 m 行每行 a b c，表示從 a 到 b 的單向道路長 c。請印出從 s 走到 t 最短的一條路線所經過的所有路口編號（依序，空白隔開）；最短的路線有好幾條時，取編號依序比較最小的那條；走不到就印 -1。', ref: PATH(true), gen: (b) => pGen(b) },
    { id: 'ho-count', split: 'holdout', st: '第一行 n m s t，接著 m 行每行 a b c，表示 a 和 b 之間有一條長度 c 的雙向道路。有多少種不同的走法可以用最短的總長度從 s 抵達 t？走不到輸出 0。', ref: CNT(false, 'print(c)'), gen: (b) => pGen(b) },
    { id: 'ho-kth', split: 'holdout', st: '第一行 n m s t k，接著 m 行每行 a b c，表示 a 到 b 的單向邊長 c。把 s 到 t 所有不經過重複點的路徑按總長由小到大排好，輸出第 k 條的總長，沒有這麼多條就輸出 -1。', ref: KSIMPLE(true), gen: pkGen },
    { id: 'ho-limit', split: 'holdout', st: '第一行 n m s t k，接著 m 行每行 a b c，表示 a 到 b 的單向邊長 c。你最多只能搭 k 段路（用 k 條邊以內），求 s 到 t 的最短總長，走不到輸出 -1。', ref: LIM(true, false), gen: pkGen },
    // ── 第二輪 holdout（ho2）：補完同義詞彙之後才另外出的新措辭（同一個人寫，仍不算冷啟動）；只量測 ──
    { id: 'ho2-floyd', split: 'holdout', st: '第一行 n m，接著 m 行每行 a b c，表示城市 a 與城市 b 之間有一條長度 c 的雙向公路。接著一行 q，再接 q 行每行 x y。先用 O(n³) 的 Floyd–Warshall 把所有城市兩兩之間的最短距離算好，每次詢問輸出 x 到 y 的最短距離，不連通輸出 -1。', ref: FQ(false), gen: fGen },
    { id: 'ho2-floyd-diam', split: 'holdout', st: '第一行 n m，接著 m 行每行 a b c，代表 a 和 b 之間有條長度 c 的無向邊。用 Floyd 算出所有點對的最短路後，輸出其中最大的那個距離（只看互相到得了的點對）。', ref: FDI(false), gen: f2Gen },
    { id: 'ho2-match', split: 'holdout', st: '第一行 n m e，二分圖左側 n 個頂點、右側 m 個頂點，接著 e 行每行 a b 表示左頂點 a 與右頂點 b 相連。請輸出最大匹配的邊數。', ref: BM('print(size)'), gen: bmGen },
    { id: 'ho2-assign', split: 'holdout', st: '第一行 n，接著 n 行各 n 個整數，第 i 行第 j 個數是工人 i 完成工作 j 的費用。每位工人必須分配到不同的工作，這是一個指派問題，請輸出總費用最低是多少。', ref: AS('min'), gen: asGen },
    { id: 'ho2-path', split: 'holdout', st: '第一行 n m s t，接著 m 行每行 a b c，表示車站 a 到車站 b 的單向軌道長度為 c。請輸出從 s 到 t 的最短路徑經過的車站編號（依序），若有多條最短路徑則輸出字典序最小的；無法到達輸出 -1。', ref: PATH(true), gen: (b) => pGen(b) },
    { id: 'ho2-count', split: 'holdout', st: '第一行 n m s t，接著 m 行每行 a b c，表示 a 與 b 之間有一條長度 c 的雙向道路。請問從 s 到 t 的最短路徑共有幾條？到不了輸出 0。', ref: CNT(false, 'print(c)'), gen: (b) => pGen(b) },
    { id: 'ho2-kth', split: 'holdout', st: '第一行 n m s t k，接著 m 行每行 a b c，表示 a 到 b 的有向邊長度 c。路徑不可重複經過同一個點。請輸出從 s 到 t 第 k 短的路徑長度，不足 k 條輸出 -1。', ref: KSIMPLE(true), gen: pkGen },
    { id: 'ho2-limit', split: 'holdout', st: '第一行 n m s t k，接著 m 行每行 a b c，表示 a 到 b 的有向邊長度 c。請輸出 s 到 t 在最多使用 k 條邊的限制下的最短距離，辦不到輸出 -1。', ref: LIM(true, false), gen: pkGen },
];
H.main({ name: '領域包 graph3', packs: [G3], seeds: SEEDS, minSkeletons: 7 });
