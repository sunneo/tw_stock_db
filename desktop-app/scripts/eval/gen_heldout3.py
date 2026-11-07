"""第三批保留題庫（held-out 3）：圖與格子。2026-11-07 在 graph／grid 模組做完、heldout2 已被範本「吃掉」之後另寫：措辭、起點編號、標籤、header 形狀都換過，並刻意混入範本庫沒有的題型（出度、最小生成樹、連通分量個數、每列最大值、方陣乘法）看它會不會誠實說做不到。
凍結規則：寫好之後不依它調整合成器／範式；之後新增的範本要另寫第三批。答案由 ref 實際執行產生（bench_lib.Bench）。
記憶體與時間：圖都很小（n≤8）；邊一律從「所有可能的邊」抽樣，不會因為要求的邊數超過可能邊數而空轉。
用法：python3 scripts/eval/gen_heldout3.py   → renderer/src/recipe/seed/heldout3_graph.jsonl"""
import itertools, random
from bench_lib import Bench

B = Bench('heldout3_graph.jsonl', 20261108)
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


RD1 = "    n, m = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n"
def gtext(n, es, extra='', tail='', w=False):
    return graph_text(n, es, head_extra=extra, weights=w, tail=tail)

B.add('h3-paths-0', 'DAG 路線數（0 起算、模 998244353）', 'L3', '有向無環圖，節點編號 0 到 n-1。首行 n m，之後 m 行每行 a b 代表一條 a→b 的邊（a<b）。請算出從 0 走到 n-1 有幾條不同的路線，答案模 998244353。',
      'def main():\n' + RD1 + '    M = 998244353\n    f = [0] * n\n    f[0] = 1\n    for u in range(n):\n        for a, b in E:\n            if a == u: f[b] = (f[b] + f[u]) % M\n    print(f[n - 1])\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(n, 2 * n), True, dag=True, base=0)))(R(3, 8)))
B.add('h3-steps-st', '最少步數（header 給 s t）', 'L3', '無向圖，節點 1..n。第一行 n m s t，接著 m 行各描述一條邊。輸出從 s 走到 t 最少要幾步；不連通就輸出 -1。',
      'def main():\n    n, m, s, t = map(int, input().split())\n    adj = [[] for _ in range(n + 1)]\n    for _ in range(m):\n        a, b = map(int, input().split()); adj[a].append(b); adj[b].append(a)\n    d = [-1] * (n + 1); d[s] = 0; q = [s]\n    for u in q:\n        for v in adj[u]:\n            if d[v] < 0: d[v] = d[u] + 1; q.append(v)\n    print(d[t])\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(1, n + 2), False), extra=' %d %d' % (R(1, n), R(1, n))))(R(3, 8)))
B.add('h3-cycle-yn', '有向圖是否存在環（YES／NO）', 'L3', '有向圖，節點 1..n。第一行 n m，接著 m 行 x y 表示 x→y。若圖中存在環就輸出 YES，否則輸出 NO。',
      'def main():\n' + RD1 + '    adj = [[] for _ in range(n + 1)]\n    ind = [0] * (n + 1)\n    for a, b in E: adj[a].append(b); ind[b] += 1\n    q = [v for v in range(1, n + 1) if ind[v] == 0]\n    for u in q:\n        for v in adj[u]:\n            ind[v] -= 1\n            if ind[v] == 0: q.append(v)\n    print("YES" if len(q) < n else "NO")\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(1, n + 1), True, dag=(i % 2 == 0))))(R(3, 7)))
B.add('h3-cycle-undir-lab', '無向圖含環（HAS_CYCLE／NO_CYCLE）', 'L3', '無向簡單圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。偵測圖是否含有環：有環輸出 HAS_CYCLE，沒有輸出 NO_CYCLE。',
      'def main():\n' + RD1 + '    p = list(range(n + 1))\n    def f(x):\n        while p[x] != x: p[x] = p[p[x]]; x = p[x]\n        return x\n    c = False\n    for a, b in E:\n        ra, rb = f(a), f(b)\n        if ra == rb: c = True\n        else: p[ra] = rb\n    print("HAS_CYCLE" if c else "NO_CYCLE")\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(1, n + 1) if i % 2 else R(1, n - 1), False)))(R(3, 7)))
B.add('h3-longest-st', '加權 DAG 最長路（尾行給 s t）', 'L3', '有向無環圖，節點 1..n。第一行 n m，接著 m 行 u v w（u<v，長度 w），最後一行是 s t。輸出從 s 到 t 的最長路徑長度；走不到輸出 -1。',
      'def main():\n    n, m = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n    s, t = map(int, input().split())\n    NEG = -10**18\n    f = [NEG] * (n + 1); f[s] = 0\n    for u in range(1, n + 1):\n        for a, b, w in E:\n            if a == u and f[u] > NEG: f[b] = max(f[b], f[u] + w)\n    print(f[t] if f[t] > NEG else -1)\n',
      lambda i: (lambda n: wtext(n, weighted(n, pick_edges(n, R(n, 2 * n), True, dag=True))) + '%d %d\n' % (R(1, 2), R(n - 1, n)))(R(4, 8)))
B.add('h3-reach-0', '可達節點個數（0 起算）', 'L3', '有向圖，節點 0..n-1。第一行 n m，接著 m 行 a b 表示 a→b。從節點 0 出發，一共能走到幾個節點（包含 0 自己）？',
      'def main():\n' + RD1 + '    adj = [[] for _ in range(n)]\n    for a, b in E: adj[a].append(b)\n    seen = {0}; st = [0]\n    while st:\n        u = st.pop()\n        for v in adj[u]:\n            if v not in seen: seen.add(v); st.append(v)\n    print(len(seen))\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(1, 2 * n), True, base=0)))(R(3, 8)))
B.add('h3-sssp-dir', '有向加權最短路', 'L3', '有向加權圖，節點 1..n。第一行 n m，接著 m 行 u v w 表示 u→v 長度 w。輸出節點 1 到節點 n 的最短路徑長度，到不了輸出 -1。',
      'def main():\n    import heapq\n    n, m = map(int, input().split())\n    adj = [[] for _ in range(n + 1)]\n    for _ in range(m):\n        u, v, w = map(int, input().split()); adj[u].append((v, w))\n    d = [float("inf")] * (n + 1); d[1] = 0; pq = [(0, 1)]\n    while pq:\n        du, u = heapq.heappop(pq)\n        if du > d[u]: continue\n        for v, w in adj[u]:\n            if du + w < d[v]: d[v] = du + w; heapq.heappush(pq, (d[v], v))\n    print(d[n] if d[n] < float("inf") else -1)\n',
      lambda i: (lambda n: wtext(n, weighted(n, pick_edges(n, R(n, 2 * n + 2), True))))(R(3, 8)))
B.add('h3-walks-k', '長度恰為 k 的路徑數', 'L3', '有向圖，節點 1..n。第一行 n m k，接著 m 行 a b 表示 a→b。從節點 1 出發、剛好走 k 條邊到達節點 n 的路徑有幾條（節點可重複）？答案對 10^9+7 取模。',
      'def main():\n    n, m, k = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n    M = 10**9 + 7\n    f = [0] * (n + 1); f[1] = 1\n    for _ in range(k):\n        g = [0] * (n + 1)\n        for a, b in E: g[b] = (g[b] + f[a]) % M\n        f = g\n    print(f[n])\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(n, 2 * n + 2), True), extra=' %d' % R(1, 6)))(R(3, 7)))
B.add('h3-outdeg', '各節點出度（範本庫沒有，預期做不到）', 'L3', '有向圖，節點 1..n。第一行 n m，接著 m 行 a b 表示 a→b。依序輸出節點 1..n 的出度，以空白分隔。',
      'def main():\n' + RD1 + '    d = [0] * (n + 1)\n    for a, b in E: d[a] += 1\n    print(*d[1:])\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(1, 2 * n), True)))(R(3, 8)))
B.add('h3-mst', '最小生成樹總權重（範本庫沒有，預期做不到）', 'L3', '無向連通加權圖，節點 1..n。第一行 n m，接著 m 行 u v w。輸出最小生成樹的總權重。',
      'def main():\n    n, m = map(int, input().split())\n    E = sorted((tuple(map(int, input().split())) for _ in range(m)), key=lambda e: e[2])\n    p = list(range(n + 1))\n    def f(x):\n        while p[x] != x: p[x] = p[p[x]]; x = p[x]\n        return x\n    t = 0\n    for a, b, w in E:\n        ra, rb = f(a), f(b)\n        if ra != rb: p[ra] = rb; t += w\n    print(t)\n',
      lambda i: (lambda n: wtext(n, [(j, R(1, j - 1), R(1, 9)) for j in range(2, n + 1)] + [(R(1, n - 1), n, R(1, 9))]))(R(3, 8)))
B.add('h3-comp-count', '連通分量個數（範本庫沒有，預期做不到）', 'L3', '無向圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。輸出連通分量的個數。',
      'def main():\n' + RD1 + '    p = list(range(n + 1))\n    def f(x):\n        while p[x] != x: p[x] = p[p[x]]; x = p[x]\n        return x\n    for a, b in E: p[f(a)] = f(b)\n    print(len({f(i) for i in range(1, n + 1)}))\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(0, n), False)))(R(3, 8)))

def grid_int(r, c, lo=-5, hi=9): return '%d %d\n' % (r, c) + ''.join(' '.join(str(R(lo, hi)) for _ in range(c)) + '\n' for _ in range(r))
def grid_chr(r, c, al='.#'): return '%d %d\n' % (r, c) + ''.join(''.join(random.choice(al) for _ in range(c)) + '\n' for _ in range(r))
B.add('h3-swap-rc', '行列互換', 'L4', '第一行 r c，之後 r 行，每行 c 個以空白隔開的整數，代表一張表。把這張表的行與列互換後輸出（共 c 行，每行 r 個數）。',
      'def main():\n    r, c = map(int, input().split())\n    G = [input().split() for _ in range(r)]\n    for j in range(c): print(*[G[i][j] for i in range(r)])\n',
      lambda i: grid_int(R(2, 4), R(2, 5)))
B.add('h3-mirror', '左右對調', 'L4', '第一行 r c，接著 r 行，每行 c 個字元（. 或 #）。把圖形左右對調後輸出，仍然是 r 行。',
      'def main():\n    r, c = map(int, input().split())\n    for _ in range(r): print(input().strip()[::-1])\n',
      lambda i: grid_chr(R(2, 5), R(2, 5)))
B.add('h3-count-dot', '空地個數', 'L4', '第一行 r c，接著 r 行，每行 c 個字元，# 是牆，. 是空地。輸出空地（.）一共有幾格。',
      'def main():\n    r, c = map(int, input().split())\n    print(sum(input().count(".") for _ in range(r)))\n',
      lambda i: grid_chr(R(2, 5), R(2, 5)))
B.add('h3-col-sums', '每欄總和', 'L4', '第一行 r c，接著 r 行，每行 c 個整數。對每一欄計算總和，輸出 c 個數，以空白分隔。',
      'def main():\n    r, c = map(int, input().split())\n    G = [list(map(int, input().split())) for _ in range(r)]\n    print(*[sum(G[i][j] for i in range(r)) for j in range(c)])\n',
      lambda i: grid_int(R(2, 4), R(2, 5)))
B.add('h3-rot-ccw', '逆時針旋轉 90 度', 'L4', '第一行 r c，接著 r 行，每行 c 個字元。把圖形逆時針旋轉 90 度後輸出（變成 c 行，每行 r 個字元）。',
      'def main():\n    r, c = map(int, input().split())\n    G = [input().strip() for _ in range(r)]\n    for j in range(c - 1, -1, -1): print("".join(G[i][j] for i in range(r)))\n',
      lambda i: grid_chr(R(2, 4), R(2, 5), 'abc'))
B.add('h3-lakes', '水池個數（. 四連通）', 'L4', '第一行 r c，接著 r 行，每行 c 個字元，. 是水、# 是土。上下左右相鄰的水算同一個水池。輸出水池個數。',
      'def main():\n    r, c = map(int, input().split())\n    G = [input().strip() for _ in range(r)]\n    seen = set(); k = 0\n    for i in range(r):\n        for j in range(c):\n            if G[i][j] == "." and (i, j) not in seen:\n                k += 1; st = [(i, j)]; seen.add((i, j))\n                while st:\n                    x, y = st.pop()\n                    for a, b in ((x+1, y), (x-1, y), (x, y+1), (x, y-1)):\n                        if 0 <= a < r and 0 <= b < c and G[a][b] == "." and (a, b) not in seen: seen.add((a, b)); st.append((a, b))\n    print(k)\n',
      lambda i: grid_chr(R(2, 5), R(2, 5)))
B.add('h3-total', '全部加總', 'L4', '第一行 r c，接著 r 行，每行 c 個整數。輸出所有數字的總和。',
      'def main():\n    r, c = map(int, input().split())\n    print(sum(sum(map(int, input().split())) for _ in range(r)))\n',
      lambda i: grid_int(R(2, 4), R(2, 5)))
B.add('h3-row-max', '每列最大值（範本庫沒有，預期做不到）', 'L4', '第一行 r c，接著 r 行，每行 c 個整數。每一列輸出一個數：該列最大的數字（每行一個）。',
      'def main():\n    r, c = map(int, input().split())\n    for _ in range(r): print(max(map(int, input().split())))\n',
      lambda i: grid_int(R(2, 4), R(2, 5)))
B.add('h3-matmul', '方陣乘法（方陣形狀還沒做，預期做不到）', 'L3', '第一行 n，接著 n 行是方陣 X，再來 n 行是方陣 Y。輸出 X·Y，共 n 行，每行 n 個數，以空白分隔。',
      'def main():\n    n = int(input())\n    A = [list(map(int, input().split())) for _ in range(n)]\n    Bm = [list(map(int, input().split())) for _ in range(n)]\n    for i in range(n): print(*[sum(A[i][k] * Bm[k][j] for k in range(n)) for j in range(n)])\n',
      lambda i: (lambda n: '%d\n' % n + ''.join(' '.join(str(R(-3, 5)) for _ in range(n)) + '\n' for _ in range(2 * n)))(R(2, 4)))
B.add('h3-trace-pow', '方陣冪的跡（方陣形狀還沒做，預期做不到）', 'L3', '第一行 n k，接著 n 行是 n×n 的方陣 A（元素 0..3）。輸出 A 的 k 次方的跡，對 10^9+7 取模。',
      'def main():\n    n, k = map(int, input().split())\n    A = [list(map(int, input().split())) for _ in range(n)]\n    M = 10**9 + 7\n    def mm(X, Y): return [[sum(X[i][t] * Y[t][j] for t in range(n)) % M for j in range(n)] for i in range(n)]\n    R_ = [[int(i == j) for j in range(n)] for i in range(n)]\n    while k:\n        if k & 1: R_ = mm(R_, A)\n        A = mm(A, A); k >>= 1\n    print(sum(R_[i][i] for i in range(n)) % M)\n',
      lambda i: (lambda n: '%d %d\n' % (n, R(1, 9)) + ''.join(' '.join(str(R(0, 3)) for _ in range(n)) + '\n' for _ in range(n)))(R(2, 4)))

B.write()
