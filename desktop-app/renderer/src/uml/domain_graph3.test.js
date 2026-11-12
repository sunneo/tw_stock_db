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
H.main({ name: '領域包 graph3', packs: [G3], seeds: H.loadSeeds(require('path').join(__dirname, 'seeds', 'domain_graph3.json')), minSkeletons: 7 });
