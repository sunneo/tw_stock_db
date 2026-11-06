"""第二批保留題庫（held-out 2）：圖與格子、矩陣相關。2026-11-07 在「還沒實作邊表／格子形狀與 L3 半環範本之前」寫好。
凍結規則：寫好之後不依它調整合成器／範式；之後新增的範本要另寫第三批。答案由 ref 實際執行產生（bench_lib.Bench）。
記憶體與時間：圖都很小（n≤8）；邊一律從「所有可能的邊」抽樣，不會因為要求的邊數超過可能邊數而空轉。
用法：python3 scripts/eval/gen_heldout2.py   → renderer/src/recipe/seed/heldout2_graph.jsonl"""
import itertools, random
from bench_lib import Bench

B = Bench('heldout2_graph.jsonl', 20261107)
R = random.randint


def pick_edges(n, m, directed, dag=False, simple=True, base=1):
    if dag: pool = [(u, v) for u in range(base, base + n) for v in range(u + 1, base + n)]
    elif directed: pool = [(u, v) for u in range(base, base + n) for v in range(base, base + n) if u != v]
    else: pool = [(u, v) for u in range(base, base + n) for v in range(u + 1, base + n)]
    m = min(m, len(pool)); es = random.sample(pool, m)
    if not directed and not dag: es = [(v, u) if R(0, 1) else (u, v) for u, v in es]
    return es


def graph_text(n, es, head_extra='', weights=False, tail=''):
    out = ['%d %d%s' % (n, len(es), head_extra)]
    for e in es:
        out.append(' '.join(map(str, e if not weights else (e[0], e[1], R(1, 9)))))
    return '\n'.join(out) + '\n' + tail


def weighted(n, es):
    return [(u, v, R(1, 9)) for u, v in es]


def wtext(n, wes, head_extra=''):
    return '%d %d%s\n' % (n, len(wes), head_extra) + ''.join('%d %d %d\n' % e for e in wes)


READ = "    n, m = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n"

# ---- 圖：計數／可達／距離 ----
B.add('h2-dag-count', 'DAG 路徑數', 'L3', '有向無環圖，節點編號 1..n。第一行 n m，接著 m 行 u v 表示一條 u→v 的邊（保證 u<v）。輸出從節點 1 走到節點 n 的路徑條數，對 1000000007 取模。',
      'def main():\n' + READ + '    M = 10**9 + 7\n    f = [0] * (n + 1)\n    f[1] = 1\n    adj = [[] for _ in range(n + 1)]\n    for u, v in E: adj[u].append(v)\n    for u in range(1, n + 1):\n        for v in adj[u]: f[v] = (f[v] + f[u]) % M\n    print(f[n])\n',
      lambda i: graph_text(*(lambda n: (n, pick_edges(n, R(n, 2 * n), True, dag=True)))(R(3, 8))))
B.add('h2-hops', '最少邊數（無向，給起終點）', 'L3', '無向圖，節點 0..n-1。輸入第一行 n m，接著 m 行每行兩個節點編號表示一條邊，最後一行是 s t。輸出從 s 到 t 最少要經過幾條邊；走不到就輸出 -1。',
      'def main():\n    n, m = map(int, input().split())\n    adj = [[] for _ in range(n)]\n    for _ in range(m):\n        a, b = map(int, input().split()); adj[a].append(b); adj[b].append(a)\n    s, t = map(int, input().split())\n    d = [-1] * n; d[s] = 0; q = [s]\n    for u in q:\n        for v in adj[u]:\n            if d[v] < 0: d[v] = d[u] + 1; q.append(v)\n    print(d[t])\n',
      lambda i: (lambda n: graph_text(n, pick_edges(n, R(1, n + 2), False, base=0), tail='%d %d\n' % (R(0, n - 1), R(0, n - 1))))(R(3, 8)))
B.add('h2-cycle-dir', '有向圖有沒有環', 'L3', '有向圖，節點 1..n。第一行 n m，接著 m 行 a b 表示 a→b。圖中有沒有環？有就輸出 CYCLE，沒有輸出 OK。',
      'def main():\n' + READ + '    adj = [[] for _ in range(n + 1)]\n    ind = [0] * (n + 1)\n    for a, b in E: adj[a].append(b); ind[b] += 1\n    q = [v for v in range(1, n + 1) if ind[v] == 0]; seen = 0\n    for u in q:\n        seen += 1\n        for v in adj[u]:\n            ind[v] -= 1\n            if ind[v] == 0: q.append(v)\n    print("OK" if seen == n else "CYCLE")\n',
      lambda i: (lambda n: graph_text(n, pick_edges(n, R(1, n + 1), True, dag=(i % 2 == 0))))(R(3, 7)))
B.add('h2-cycle-undir', '無向圖有沒有環', 'L3', '無向簡單圖（沒有重邊與自環），節點 1..n。第一行 n m，接著 m 行每行一條邊。圖裡有環就輸出 YES，否則輸出 NO。',
      'def main():\n' + READ + '    p = list(range(n + 1))\n    def f(x):\n        while p[x] != x: p[x] = p[p[x]]; x = p[x]\n        return x\n    cyc = False\n    for a, b in E:\n        ra, rb = f(a), f(b)\n        if ra == rb: cyc = True\n        else: p[ra] = rb\n    print("YES" if cyc else "NO")\n',
      lambda i: (lambda n: graph_text(n, pick_edges(n, R(1, n + 1) if i % 2 else R(1, n - 1), False)))(R(3, 7)))
B.add('h2-longest-w', '加權 DAG 最長路', 'L3', 'DAG，節點 1..n。第一行 n m，接著 m 行 u v w（u<v，邊權 w）。輸出從節點 1 到節點 n 的最長路徑長度（邊權總和）；到不了就輸出 -1。',
      'def main():\n    n, m = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n    NEG = -10**18\n    f = [NEG] * (n + 1); f[1] = 0\n    for u in range(1, n + 1):\n        for a, b, w in E:\n            if a == u and f[u] > NEG: f[b] = max(f[b], f[u] + w)\n    print(f[n] if f[n] > NEG else -1)\n',
      lambda i: (lambda n: wtext(n, weighted(n, pick_edges(n, R(n - 1, 2 * n), True, dag=True))))(R(3, 7)))
B.add('h2-reach', '可到達的節點數', 'L3', '有向圖，節點 1..n。第一行 n m，接著 m 行 u v 表示 u→v。從節點 1 出發，最多能到達幾個不同的節點？（包含節點 1 自己）',
      'def main():\n' + READ + '    adj = [[] for _ in range(n + 1)]\n    for u, v in E: adj[u].append(v)\n    seen = {1}; st = [1]\n    while st:\n        u = st.pop()\n        for v in adj[u]:\n            if v not in seen: seen.add(v); st.append(v)\n    print(len(seen))\n',
      lambda i: (lambda n: graph_text(n, pick_edges(n, R(1, n + 1), True)))(R(3, 8)))
B.add('h2-dist-all', '節點 1 到每個節點的距離', 'L3', '無向圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。依序輸出節點 1 到節點 1、2、…、n 的最少邊數，用空白隔開；到不了的輸出 -1。',
      'def main():\n' + READ + '    adj = [[] for _ in range(n + 1)]\n    for u, v in E: adj[u].append(v); adj[v].append(u)\n    d = [-1] * (n + 1); d[1] = 0; q = [1]\n    for u in q:\n        for v in adj[u]:\n            if d[v] < 0: d[v] = d[u] + 1; q.append(v)\n    print(*d[1:])\n',
      lambda i: (lambda n: graph_text(n, pick_edges(n, R(1, n + 1), False)))(R(3, 8)))
B.add('h2-dijkstra', '加權最短距離', 'L3', '無向加權圖，節點 1..n。第一行 n m，接著 m 行 u v w。輸出節點 1 到節點 n 的最短距離；不連通輸出 -1。',
      'def main():\n    import heapq\n    n, m = map(int, input().split())\n    adj = [[] for _ in range(n + 1)]\n    for _ in range(m):\n        u, v, w = map(int, input().split()); adj[u].append((v, w)); adj[v].append((u, w))\n    INF = 10**18; d = [INF] * (n + 1); d[1] = 0; h = [(0, 1)]\n    while h:\n        x, u = heapq.heappop(h)\n        if x > d[u]: continue\n        for v, w in adj[u]:\n            if x + w < d[v]: d[v] = x + w; heapq.heappush(h, (d[v], v))\n    print(d[n] if d[n] < INF else -1)\n',
      lambda i: (lambda n: wtext(n, weighted(n, pick_edges(n, R(n - 1, 2 * n), False))))(R(3, 8)))
B.add('h2-walks-k', '恰好 k 步的走法數', 'L3', '有向圖，節點 1..n。第一行 n m k，接著 m 行 u v 表示 u→v。計算從節點 1 出發、恰好走 k 步到達節點 n 的走法數（節點可以重複經過），對 1000000007 取模。',
      'def main():\n    n, m, k = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n    M = 10**9 + 7\n    f = [0] * (n + 1); f[1] = 1\n    for _ in range(k):\n        g = [0] * (n + 1)\n        for u, v in E: g[v] = (g[v] + f[u]) % M\n        f = g\n    print(f[n])\n',
      lambda i: (lambda n: graph_text(n, pick_edges(n, R(n, 2 * n), True), head_extra=' %d' % R(1, 25)))(R(3, 6)))
B.add('h2-degree', '每個節點的度數', 'L3', '無向簡單圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。依序輸出節點 1..n 的度數，空白分隔。',
      'def main():\n' + READ + '    d = [0] * (n + 1)\n    for u, v in E: d[u] += 1; d[v] += 1\n    print(*d[1:])\n',
      lambda i: (lambda n: graph_text(n, pick_edges(n, R(1, n + 2), False)))(R(3, 8)))
B.add('h2-indeg0', '入度為 0 的節點數', 'L3', '有向圖，節點 1..n。第一行 n m，接著 m 行 u v 表示 u→v。輸出入度為 0 的節點個數。',
      'def main():\n' + READ + '    ind = [0] * (n + 1)\n    for u, v in E: ind[v] += 1\n    print(sum(1 for v in range(1, n + 1) if ind[v] == 0))\n',
      lambda i: (lambda n: graph_text(n, pick_edges(n, R(1, n + 1), True)))(R(3, 8)))
B.add('h2-path-exists', '有向圖 s 能不能到 t', 'L3', '有向圖，節點 1..n。第一行 n m s t，接著 m 行 u v 表示 u→v。如果能從 s 走到 t 輸出 YES，否則輸出 NO。',
      'def main():\n    n, m, s, t = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n    adj = [[] for _ in range(n + 1)]\n    for u, v in E: adj[u].append(v)\n    seen = {s}; st = [s]\n    while st:\n        u = st.pop()\n        for v in adj[u]:\n            if v not in seen: seen.add(v); st.append(v)\n    print("YES" if t in seen else "NO")\n',
      lambda i: (lambda n: graph_text(n, pick_edges(n, R(1, n + 1), True), head_extra=' %d %d' % (R(1, n), R(1, n))))(R(3, 8)))
B.add('h2-comp-max', '最大連通分量的點數', 'L3', '無向圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。輸出最大的連通分量含有幾個節點。',
      'def main():\n' + READ + '    p = list(range(n + 1))\n    def f(x):\n        while p[x] != x: p[x] = p[p[x]]; x = p[x]\n        return x\n    for a, b in E: p[f(a)] = f(b)\n    c = {}\n    for v in range(1, n + 1): c[f(v)] = c.get(f(v), 0) + 1\n    print(max(c.values()))\n',
      lambda i: (lambda n: graph_text(n, pick_edges(n, R(0, n), False)))(R(3, 8)))
B.add('h2-topo', '字典序最小的拓撲排序', 'L3', 'DAG，節點 1..n。第一行 n m，接著 m 行 u v 表示 u→v。輸出字典序最小的拓撲排序（節點編號空白分隔）。',
      'def main():\n    import heapq\n' + READ + '    adj = [[] for _ in range(n + 1)]; ind = [0] * (n + 1)\n    for u, v in E: adj[u].append(v); ind[v] += 1\n    h = [v for v in range(1, n + 1) if ind[v] == 0]; heapq.heapify(h); out = []\n    while h:\n        u = heapq.heappop(h); out.append(u)\n        for v in adj[u]:\n            ind[v] -= 1\n            if ind[v] == 0: heapq.heappush(h, v)\n    print(*out)\n',
      lambda i: (lambda n: graph_text(n, pick_edges(n, R(1, n + 1), True, dag=True)))(R(3, 7)))

# ---- 格子與矩陣 ----
def grid_ints(r, c):
    return '%d %d\n' % (r, c) + ''.join(' '.join(str(R(-9, 9)) for _ in range(c)) + '\n' for _ in range(r))


def grid_chars(r, c, alpha='.#'):
    return '%d %d\n' % (r, c) + ''.join(''.join(random.choice(alpha) for _ in range(c)) + '\n' for _ in range(r))


B.add('h2-transpose', '矩陣轉置', 'other', '第一行 r c，接著 r 行，每行 c 個以空白分隔的整數。輸出轉置後的矩陣（c 行，每行 r 個數，以空白分隔）。',
      'def main():\n    r, c = map(int, input().split())\n    a = [list(map(int, input().split())) for _ in range(r)]\n    for j in range(c): print(*[a[i][j] for i in range(r)])\n',
      lambda i: grid_ints(R(1, 5), R(1, 5)))
B.add('h2-flip-v', '圖形上下顛倒', 'other', '第一行 r c，接著 r 行，每行 c 個字元（. 或 #）。把整個圖形上下顛倒後輸出（還是 r 行）。',
      'def main():\n    r, c = map(int, input().split())\n    g = [input().strip() for _ in range(r)]\n    for row in g[::-1]: print(row)\n',
      lambda i: grid_chars(R(1, 5), R(1, 5)))
B.add('h2-rot90', '圖形順時針轉 90 度', 'other', '第一行 r c，接著 r 行，每行 c 個字元。把圖形順時針旋轉 90 度後輸出（c 行，每行 r 個字元）。',
      'def main():\n    r, c = map(int, input().split())\n    g = [input().strip() for _ in range(r)]\n    for j in range(c): print("".join(g[i][j] for i in range(r - 1, -1, -1)))\n',
      lambda i: grid_chars(R(1, 5), R(1, 5), 'abc'))
B.add('h2-count-hash', '格子裡牆的個數', 'other', '第一行 r c，接著 r 行，每行 c 個字元，# 是牆、. 是空地。輸出牆（#）的個數。',
      'def main():\n    r, c = map(int, input().split())\n    print(sum(input().count("#") for _ in range(r)))\n',
      lambda i: grid_chars(R(1, 6), R(1, 6)))
B.add('h2-row-sums', '每一列的和', 'other', '第一行 r c，接著 r 行，每行 c 個整數。每一列輸出一個數：該列的總和（每行一個）。',
      'def main():\n    r, c = map(int, input().split())\n    for _ in range(r): print(sum(map(int, input().split())))\n',
      lambda i: grid_ints(R(1, 5), R(1, 5)))
B.add('h2-islands', '島嶼個數', 'other', '第一行 r c，接著 r 行，每行 c 個字元，# 是陸地、. 是海。上下左右相連的陸地算同一座島。輸出島嶼個數。',
      'def main():\n    r, c = map(int, input().split())\n    g = [input().strip() for _ in range(r)]\n    seen = set(); cnt = 0\n    for i in range(r):\n        for j in range(c):\n            if g[i][j] == "#" and (i, j) not in seen:\n                cnt += 1; st = [(i, j)]; seen.add((i, j))\n                while st:\n                    x, y = st.pop()\n                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):\n                        a, b = x + dx, y + dy\n                        if 0 <= a < r and 0 <= b < c and g[a][b] == "#" and (a, b) not in seen: seen.add((a, b)); st.append((a, b))\n    print(cnt)\n',
      lambda i: grid_chars(R(1, 6), R(1, 6)))
B.add('h2-matpow-trace', '矩陣 k 次方的跡', 'L3', '第一行 n k，接著 n 行，每行 n 個整數（方陣 A，元素 0..5）。計算 A 的 k 次方，輸出它的跡（對角線元素之和），對 1000000007 取模。',
      'def main():\n    n, k = map(int, input().split())\n    A = [list(map(int, input().split())) for _ in range(n)]\n    M = 10**9 + 7\n    def mul(X, Y): return [[sum(X[i][t] * Y[t][j] for t in range(n)) % M for j in range(n)] for i in range(n)]\n    R = [[int(i == j) for j in range(n)] for i in range(n)]\n    while k:\n        if k & 1: R = mul(R, A)\n        A = mul(A, A); k >>= 1\n    print(sum(R[i][i] for i in range(n)) % M)\n',
      lambda i: (lambda n: '%d %d\n' % (n, R(1, 30)) + ''.join(' '.join(str(R(0, 5)) for _ in range(n)) + '\n' for _ in range(n)))(R(2, 4)))
B.add('h2-matmul', '兩個方陣相乘', 'L3', '第一行 n，接著 n 行是方陣 A（每行 n 個整數），再接著 n 行是方陣 B。輸出 A×B：n 行，每行 n 個整數，以空白分隔。',
      'def main():\n    n = int(input())\n    A = [list(map(int, input().split())) for _ in range(n)]\n    Bm = [list(map(int, input().split())) for _ in range(n)]\n    for i in range(n): print(*[sum(A[i][t] * Bm[t][j] for t in range(n)) for j in range(n)])\n',
      lambda i: (lambda n: '%d\n' % n + ''.join(' '.join(str(R(-4, 6)) for _ in range(n)) + '\n' for _ in range(2 * n)))(R(2, 4)))

B.write()
