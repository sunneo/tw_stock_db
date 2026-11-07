"""第四批保留題庫（held-out 4）：圖與格子。2026-11-07 在 heldout3 被「吃掉」（補了出度／入度／連通分量個數／MST／每列欄最值／方陣乘法冪跡）之後另寫：措辭再換一輪，混入範本庫沒有的新題型（二分圖、尤拉度數、對角線和、對稱判斷、方陣行列式、最長遞增格路徑），看它會不會誠實說做不到。
凍結規則：寫好之後不依它調整合成器／範式；之後新增的範本要另寫第三批。答案由 ref 實際執行產生（bench_lib.Bench）。
記憶體與時間：圖都很小（n≤8）；邊一律從「所有可能的邊」抽樣，不會因為要求的邊數超過可能邊數而空轉。
用法：python3 scripts/eval/gen_heldout4.py   → renderer/src/recipe/seed/heldout4_graph.jsonl"""
import itertools, random
from bench_lib import Bench

B = Bench('heldout4_graph.jsonl', 20261109)
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


RD1 = "    n, m = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n"
def gtext(n, es, extra='', tail='', w=False):
    return graph_text(n, es, head_extra=extra, weights=w, tail=tail)

B.add('h4-count-routes', 'DAG 方法數（換說法）', 'L3', '給一個有向無環圖，點的編號是 1 到 n，輸入第一行為 n m，之後 m 行每行 a b，表示可以從 a 走到 b（保證 a<b）。問從點 1 走到點 n 共有幾種走法？答案很大，請輸出除以 1000000007 的餘數。',
      'def main():\n' + RD1 + '    M = 10**9 + 7\n    f = [0] * (n + 1); f[1] = 1\n    for u in range(1, n + 1):\n        for a, b in E:\n            if a == u: f[b] = (f[b] + f[u]) % M\n    print(f[n])\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(n, 2 * n), True, dag=True)))(R(3, 8)))
B.add('h4-min-edges', '最少經過幾條邊（0 起算、尾行 s t）', 'L3', '無向圖，點編號 0..n-1。第一行 n m，接著 m 行每行 a b 是一條邊，最後一行 s t。輸出 s 與 t 之間最少要經過幾條邊，如果不連通就輸出 -1。',
      'def main():\n    n, m = map(int, input().split())\n    adj = [[] for _ in range(n)]\n    for _ in range(m):\n        a, b = map(int, input().split()); adj[a].append(b); adj[b].append(a)\n    s, t = map(int, input().split())\n    d = [-1] * n; d[s] = 0; q = [s]\n    for u in q:\n        for v in adj[u]:\n            if d[v] < 0: d[v] = d[u] + 1; q.append(v)\n    print(d[t])\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(1, n + 2), False, base=0), tail='%d %d\n' % (R(0, n - 1), R(0, n - 1))))(R(3, 8)))
B.add('h4-loop-exists', '有向圖含迴圈（Y／N）', 'L3', '有向圖，節點 1..n。第一行 n m，接著 m 行 a b 表示一條由 a 指向 b 的邊。圖裡面有沒有迴圈？有的話輸出 Y，沒有輸出 N。',
      'def main():\n' + RD1 + '    adj = [[] for _ in range(n + 1)]\n    ind = [0] * (n + 1)\n    for a, b in E: adj[a].append(b); ind[b] += 1\n    q = [v for v in range(1, n + 1) if ind[v] == 0]\n    for u in q:\n        for v in adj[u]:\n            ind[v] -= 1\n            if ind[v] == 0: q.append(v)\n    print("Y" if len(q) < n else "N")\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(1, n + 1), True, dag=(i % 2 == 0))))(R(3, 7)))
B.add('h4-heaviest', '加權 DAG 最重路徑', 'L3', '有向無環圖，節點 1..n。第一行 n m，接著 m 行 a b c（a<b，邊的重量 c）。輸出從節點 1 到節點 n 的路徑中，重量總和最大的是多少；沒有路徑就輸出 -1。',
      'def main():\n    n, m = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n    NEG = -10**18\n    f = [NEG] * (n + 1); f[1] = 0\n    for u in range(1, n + 1):\n        for a, b, w in E:\n            if a == u and f[u] > NEG: f[b] = max(f[b], f[u] + w)\n    print(f[n] if f[n] > NEG else -1)\n',
      lambda i: (lambda n: wtext(n, weighted(n, pick_edges(n, R(n, 2 * n), True, dag=True))))(R(4, 8)))
B.add('h4-reach-from-1', '從 1 可達個數（換說法）', 'L3', '有向圖，節點 1..n。第一行 n m，接著 m 行 u v 表示單向道路 u→v。從 1 號出發沿著道路走，最多可以經過多少個不同的節點？（1 號本身算一個）',
      'def main():\n' + RD1 + '    adj = [[] for _ in range(n + 1)]\n    for a, b in E: adj[a].append(b)\n    seen = {1}; st = [1]\n    while st:\n        u = st.pop()\n        for v in adj[u]:\n            if v not in seen: seen.add(v); st.append(v)\n    print(len(seen))\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(1, 2 * n), True)))(R(3, 8)))
B.add('h4-shortest-undir-w', '無向加權最短距離（換說法）', 'L3', '無向有權重的圖，節點 1..n。第一行 n m，接著 m 行 a b c 表示 a、b 之間的路長 c。求從 1 到 n 的最短總長度，到不了輸出 -1。',
      'def main():\n    import heapq\n    n, m = map(int, input().split())\n    adj = [[] for _ in range(n + 1)]\n    for _ in range(m):\n        u, v, w = map(int, input().split()); adj[u].append((v, w)); adj[v].append((u, w))\n    d = [float("inf")] * (n + 1); d[1] = 0; pq = [(0, 1)]\n    while pq:\n        du, u = heapq.heappop(pq)\n        if du > d[u]: continue\n        for v, w in adj[u]:\n            if du + w < d[v]: d[v] = du + w; heapq.heappush(pq, (d[v], v))\n    print(d[n] if d[n] < float("inf") else -1)\n',
      lambda i: (lambda n: wtext(n, weighted(n, pick_edges(n, R(n - 1, 2 * n), False))))(R(3, 8)))
B.add('h4-degrees', '每個點連幾條邊', 'L3', '無向簡單圖，節點 1..n。第一行 n m，接著 m 行每行 a b 表示一條邊。依編號順序輸出每個節點連著幾條邊，以空白分隔。',
      'def main():\n' + RD1 + '    d = [0] * (n + 1)\n    for a, b in E: d[a] += 1; d[b] += 1\n    print(*d[1:])\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(1, n + 2), False)))(R(3, 8)))
B.add('h4-mst-cost', '最小總成本連通（MST 換說法）', 'L3', '有 n 個城市（編號 1..n）和 m 條可以修的道路。第一行 n m，接著 m 行 a b c 表示在 a、b 之間修路要花 c。要讓所有城市互相連通，最少要花多少錢？（保證可以連通）',
      'def main():\n    n, m = map(int, input().split())\n    E = sorted((tuple(map(int, input().split())) for _ in range(m)), key=lambda e: e[2])\n    p = list(range(n + 1))\n    def f(x):\n        while p[x] != x: p[x] = p[p[x]]; x = p[x]\n        return x\n    t = 0\n    for a, b, w in E:\n        ra, rb = f(a), f(b)\n        if ra != rb: p[ra] = rb; t += w\n    print(t)\n',
      lambda i: (lambda n: wtext(n, [(j, R(1, j - 1), R(1, 9)) for j in range(2, n + 1)] + [(R(1, n - 1), n, R(1, 9))]))(R(3, 8)))
B.add('h4-bipartite', '二分圖判定（新題型，預期做不到）', 'L3', '無向圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。判斷這張圖是不是二分圖，是輸出 YES，否則輸出 NO。',
      'def main():\n' + RD1 + '    adj = [[] for _ in range(n + 1)]\n    for a, b in E: adj[a].append(b); adj[b].append(a)\n    col = [-1] * (n + 1); ok = True\n    for s in range(1, n + 1):\n        if col[s] >= 0: continue\n        col[s] = 0; q = [s]\n        for u in q:\n            for v in adj[u]:\n                if col[v] < 0: col[v] = 1 - col[u]; q.append(v)\n                elif col[v] == col[u]: ok = False\n    print("YES" if ok else "NO")\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(1, n + 2), False)))(R(3, 7)))
B.add('h4-euler-deg', '度數為奇數的點個數（新題型，預期做不到）', 'L3', '無向簡單圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。輸出度數是奇數的節點有幾個。',
      'def main():\n' + RD1 + '    d = [0] * (n + 1)\n    for a, b in E: d[a] += 1; d[b] += 1\n    print(sum(1 for x in d[1:] if x % 2))\n',
      lambda i: (lambda n: gtext(n, pick_edges(n, R(1, n + 2), False)))(R(3, 8)))

def grid_int(r, c, lo=-5, hi=9): return '%d %d\n' % (r, c) + ''.join(' '.join(str(R(lo, hi)) for _ in range(c)) + '\n' for _ in range(r))
def grid_chr(r, c, al='.#'): return '%d %d\n' % (r, c) + ''.join(''.join(random.choice(al) for _ in range(c)) + '\n' for _ in range(r))
def sq(n, hi=4, extra=''): return '%d%s\n' % (n, extra) + ''.join(' '.join(str(R(0, hi)) for _ in range(n)) + '\n' for _ in range(n))
B.add('h4-flip-ud', '倒過來（上下）', 'L4', '第一行 r c，接著 r 行，每行 c 個以空白隔開的整數。把這些列的順序整個倒過來輸出（第一列變最後一列，每列內容不變）。',
      'def main():\n    r, c = map(int, input().split())\n    G = [input() for _ in range(r)]\n    print("\\n".join(G[::-1]))\n',
      lambda i: grid_int(R(2, 4), R(2, 5)))
B.add('h4-rot-cw', '順轉九十度', 'L4', '第一行 r c，接著 r 行，每行 c 個字元。把這張圖往右（順時針）轉 90 度後輸出，共 c 行、每行 r 個字元。',
      'def main():\n    r, c = map(int, input().split())\n    G = [input().strip() for _ in range(r)]\n    for j in range(c): print("".join(G[i][j] for i in range(r - 1, -1, -1)))\n',
      lambda i: grid_chr(R(2, 4), R(2, 5), 'xyz'))
B.add('h4-count-star', '星號個數', 'L4', '第一行 r c，接著 r 行，每行 c 個字元，只有 * 和 . 兩種。輸出 * 的總數。',
      'def main():\n    r, c = map(int, input().split())\n    print(sum(input().count("*") for _ in range(r)))\n',
      lambda i: grid_chr(R(2, 5), R(2, 5), '*.'))
B.add('h4-col-min', '每欄最小', 'L4', '第一行 r c，接著 r 行，每行 c 個整數。對每一欄輸出最小的那個數，共 c 個數，以空白分隔。',
      'def main():\n    r, c = map(int, input().split())\n    G = [list(map(int, input().split())) for _ in range(r)]\n    print(*[min(G[i][j] for i in range(r)) for j in range(c)])\n',
      lambda i: grid_int(R(2, 4), R(2, 5)))
B.add('h4-diag-sum', '主對角線和（新題型，預期做不到）', 'L4', '第一行 n n，接著 n 行，每行 n 個整數。輸出主對角線（左上到右下）上的數字總和。',
      'def main():\n    n, _ = map(int, input().split())\n    G = [list(map(int, input().split())) for _ in range(n)]\n    print(sum(G[i][i] for i in range(n)))\n',
      lambda i: (lambda n: '%d %d\n' % (n, n) + ''.join(' '.join(str(R(-5, 9)) for _ in range(n)) + '\n' for _ in range(n)))(R(2, 5)))
B.add('h4-symmetric', '是否對稱（新題型，預期做不到）', 'L4', '第一行 n n，接著 n 行，每行 n 個整數。如果這個矩陣等於它的轉置就輸出 YES，否則輸出 NO。',
      'def main():\n    n, _ = map(int, input().split())\n    G = [list(map(int, input().split())) for _ in range(n)]\n    print("YES" if all(G[i][j] == G[j][i] for i in range(n) for j in range(n)) else "NO")\n',
      lambda i: (lambda n: '%d %d\n' % (n, n) + ''.join(' '.join(str(R(0, 1)) for _ in range(n)) + '\n' for _ in range(n)))(R(2, 4)))
B.add('h4-mat-product', '兩矩陣的乘積（換說法）', 'L3', '第一行 n，接著 n 行為 n×n 矩陣 P，再 n 行為 n×n 矩陣 Q。請輸出矩陣乘積 P×Q（n 行 n 列，數字以空白隔開）。',
      'def main():\n    n = int(input())\n    A = [list(map(int, input().split())) for _ in range(n)]\n    Bm = [list(map(int, input().split())) for _ in range(n)]\n    for i in range(n): print(*[sum(A[i][k] * Bm[k][j] for k in range(n)) for j in range(n)])\n',
      lambda i: (lambda n: '%d\n' % n + ''.join(' '.join(str(R(-3, 5)) for _ in range(n)) + '\n' for _ in range(2 * n)))(R(2, 4)))
B.add('h4-pow-trace', '矩陣冪的對角線和', 'L3', '第一行 n k，接著 n 行是 n×n 矩陣 M（元素在 0 到 3 之間）。計算 M 的 k 次方，輸出它對角線元素的總和，結果對 998244353 取模。',
      'def main():\n    n, k = map(int, input().split())\n    A = [list(map(int, input().split())) for _ in range(n)]\n    M = 998244353\n    def mm(X, Y): return [[sum(X[i][t] * Y[t][j] for t in range(n)) % M for j in range(n)] for i in range(n)]\n    R_ = [[int(i == j) for j in range(n)] for i in range(n)]\n    while k:\n        if k & 1: R_ = mm(R_, A)\n        A = mm(A, A); k >>= 1\n    print(sum(R_[i][i] for i in range(n)) % M)\n',
      lambda i: sq(R(2, 4), 3, ' %d' % R(1, 9)))
B.add('h4-det', '行列式（新題型，預期做不到）', 'L3', '第一行 n，接著 n 行是 n×n 整數方陣（n≤3，元素 -3..3）。輸出它的行列式。',
      'def main():\n    n = int(input())\n    A = [list(map(int, input().split())) for _ in range(n)]\n    if n == 1: print(A[0][0])\n    elif n == 2: print(A[0][0] * A[1][1] - A[0][1] * A[1][0])\n    else: print(A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]))\n',
      lambda i: (lambda n: '%d\n' % n + ''.join(' '.join(str(R(-3, 3)) for _ in range(n)) + '\n' for _ in range(n)))(R(1, 3)))

B.write()
