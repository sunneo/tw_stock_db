#!/usr/bin/env python3
"""涵蓋率基準 L3（半環圖）、L4（計數器／標量機）題目 → renderer/src/recipe/seed/bench_L3_L4.jsonl。用法：python3 scripts/eval/gen_bench_L3_L4.py"""
import os, random, sys
sys.path.insert(0, os.path.dirname(__file__))
from bench_lib import Bench

B = Bench('bench_L3_L4.jsonl', 20261107)
R = random.randint


def graph(n, m, w=None, directed=True):
    L = ['%d %d' % (n, m)]
    es = set()
    while len(es) < m:
        a, b = R(1, n), R(1, n)
        if a == b or (a, b) in es or (not directed and (b, a) in es): continue
        es.add((a, b))
    for a, b in sorted(es): L.append('%d %d' % (a, b) + (' %d' % R(1, w) if w else ''))
    return '\n'.join(L) + '\n'


# ---------- L3：半環圖 ----------
B.add('b-grid-paths', '格子路徑數', 'L3', '第一行 n m（1≤n,m≤12），接著 n 行每行 m 個字元，"." 可走、"#" 是牆。只能向右或向下走，從左上走到右下有幾種走法？輸出答案（左上或右下是牆則輸出 0）。',
      'def main():\n    n, m = map(int, input().split())\n    g = [input().strip() for _ in range(n)]\n    d = [[0] * m for _ in range(n)]\n    if g[0][0] == ".": d[0][0] = 1\n    for i in range(n):\n        for j in range(m):\n            if g[i][j] == "#": d[i][j] = 0; continue\n            if i: d[i][j] += d[i - 1][j]\n            if j: d[i][j] += d[i][j - 1]\n    print(d[n - 1][m - 1])\n',
      lambda i: (lambda n, m: '%d %d\n' % (n, m) + '\n'.join(''.join('#' if (R(0, 9) < 2 and (r, c) not in ((0, 0), (n - 1, m - 1))) else '.' for c in range(m)) for r in range(n)) + '\n')(R(1, 10), R(1, 10)), tags=['semiring', 'grid'])
B.add('b-shortest-weighted', '加權最短路', 'L3', '第一行 n m（有向圖，1≤n≤8），接著 m 行 a b w 表示 a 到 b 權重 w（1≤w≤9）。輸出 1 到 n 的最短距離，到不了輸出 -1。',
      'def main():\n    n, m = map(int, input().split())\n    INF = 10**9\n    d = [INF] * (n + 1); d[1] = 0\n    es = [tuple(map(int, input().split())) for _ in range(m)]\n    for _ in range(n):\n        for a, b, w in es:\n            if d[a] + w < d[b]: d[b] = d[a] + w\n    print(d[n] if d[n] < INF else -1)\n',
      lambda i: (lambda n: graph(n, R(n - 1, min(n * (n - 1), 14)), 9))(R(3, 8)), tags=['semiring', 'min-plus'])
B.add('b-reachable-count', '可達點數', 'L3', '第一行 n m（有向圖，1≤n≤9），接著 m 行 a b。輸出從 1 出發能到達的點數（含 1）。',
      'def main():\n    n, m = map(int, input().split())\n    adj = [[] for _ in range(n + 1)]\n    for _ in range(m):\n        a, b = map(int, input().split()); adj[a].append(b)\n    seen = {1}; st = [1]\n    while st:\n        u = st.pop()\n        for v in adj[u]:\n            if v not in seen: seen.add(v); st.append(v)\n    print(len(seen))\n',
      lambda i: (lambda n: graph(n, R(1, min(n * (n - 1), 12))))(R(3, 9)), tags=['semiring', 'boolean'])
B.add('b-walks-k', '長度恰為 k 的路徑數', 'L3', '第一行 n m k（有向圖，1≤n≤7，1≤k≤20），接著 m 行 a b。輸出從 1 出發、走恰好 k 步（可重複經過點與邊）的路徑條數，除以 10^9+7 的餘數。',
      'def main():\n    n, m, k = map(int, input().split())\n    M = 10**9 + 7\n    adj = [[] for _ in range(n + 1)]\n    for _ in range(m):\n        a, b = map(int, input().split()); adj[a].append(b)\n    v = [0] * (n + 1); v[1] = 1\n    for _ in range(k):\n        w = [0] * (n + 1)\n        for u in range(1, n + 1):\n            for x in adj[u]: w[x] = (w[x] + v[u]) % M\n        v = w\n    print(sum(v) % M)\n',
      lambda i: (lambda n: (lambda g: g.split('\n', 1)[0] + ' %d\n' % R(1, 20) + g.split('\n', 1)[1])(graph(n, R(2, min(n * (n - 1), 12)))))(R(3, 7)), tags=['semiring', 'counting'])
B.add('b-coin-ways', '硬幣組合數', 'L3', '第一行 k 與目標 t（1≤k≤5，t≤60），第二行 k 個面額。輸出湊出 t 的組合數（面額可重複使用，順序不計）。',
      'def main():\n    k, t = map(int, input().split())\n    cs = list(map(int, input().split()))\n    d = [1] + [0] * t\n    for c in cs:\n        for x in range(c, t + 1): d[x] += d[x - c]\n    print(d[t])\n',
      lambda i: (lambda k: '%d %d\n' % (k, R(1, 60)) + ' '.join(str(x) for x in random.sample(range(1, 12), k)) + '\n')(R(1, 5)), tags=['semiring', 'dp'])
B.add('b-floyd-closure', '兩點間是否有路', 'L3', '第一行 n m q（有向圖，1≤n≤8），接著 m 行 a b，再 q 行 x y。對每個查詢輸出 yes／no 表示 x 是否能走到 y（x=y 視為 yes）。',
      'def main():\n    n, m, q = map(int, input().split())\n    r = [[i == j for j in range(n + 1)] for i in range(n + 1)]\n    for _ in range(m):\n        a, b = map(int, input().split()); r[a][b] = True\n    for k in range(1, n + 1):\n        for i in range(1, n + 1):\n            for j in range(1, n + 1):\n                if r[i][k] and r[k][j]: r[i][j] = True\n    for _ in range(q):\n        x, y = map(int, input().split()); print("yes" if r[x][y] else "no")\n',
      lambda i: (lambda n: (lambda g, q: g.split('\n', 1)[0] + ' %d\n' % q + g.split('\n', 1)[1] + ''.join('%d %d\n' % (R(1, n), R(1, n)) for _ in range(q)))(graph(n, R(1, min(n * (n - 1), 10))), R(1, 4)))(R(3, 8)), tags=['semiring', 'closure'])

# ---------- L4：計數器／標量機 ----------
B.add('b-gcd', '最大公因數', 'L4', '輸入兩個正整數 a b（≤10^12），輸出 gcd(a,b)。',
      'def main():\n    a, b = map(int, input().split())\n    while b: a, b = b, a % b\n    print(a)\n', lambda i: '%d %d\n' % (R(1, 10**12), R(1, 10**12)), tags=['counter'])
B.add('b-collatz-steps', '考拉茲步數', 'L4', '輸入正整數 n（≤10^6）。每步：偶數除以 2，奇數變成 3n+1。輸出變成 1 需要幾步。',
      'def main():\n    n = int(input()); c = 0\n    while n != 1:\n        n = n // 2 if n % 2 == 0 else 3 * n + 1; c += 1\n    print(c)\n', lambda i: '%d\n' % R(1, 10**6), tags=['counter'])
B.add('b-digit-sum', '數字和', 'L4', '輸入非負整數 n（≤10^18），輸出各位數字的和。',
      'def main():\n    n = int(input()); s = 0\n    while n: s += n % 10; n //= 10\n    print(s)\n', lambda i: '%d\n' % R(0, 10**18), tags=['counter'])
B.add('b-isqrt', '整數平方根', 'L4', '輸入非負整數 n（≤10^12），輸出最大的整數 r 使得 r*r ≤ n。',
      'def main():\n    n = int(input()); lo, hi = 0, 10**6 + 1\n    while lo < hi - 1:\n        mid = (lo + hi) // 2\n        if mid * mid <= n: lo = mid\n        else: hi = mid\n    print(lo)\n', lambda i: '%d\n' % R(0, 10**12), tags=['counter', 'binary-search'])
B.add('b-power-mod', '快速冪取模', 'L4', '輸入 a e m（1≤a,e≤10^18，2≤m≤10^9），輸出 a^e mod m。',
      'def main():\n    a, e, m = map(int, input().split()); r = 1; a %= m\n    while e:\n        if e & 1: r = r * a % m\n        a = a * a % m; e >>= 1\n    print(r)\n', lambda i: '%d %d %d\n' % (R(1, 10**18), R(1, 10**18), R(2, 10**9)), tags=['counter'])
B.add('b-count-divisors', '因數個數', 'L4', '輸入正整數 n（≤10^9），輸出 n 的正因數個數。',
      'def main():\n    n = int(input()); c = 0; d = 1\n    while d * d <= n:\n        if n % d == 0: c += 1 if d * d == n else 2\n        d += 1\n    print(c)\n', lambda i: '%d\n' % R(1, 10**8), tags=['counter'])
B.add('b-trailing-zeros', '階乘末尾 0 的個數', 'L4', '輸入 n（≤10^18），輸出 n! 末尾有幾個 0。',
      'def main():\n    n = int(input()); c = 0\n    while n: n //= 5; c += n\n    print(c)\n', lambda i: '%d\n' % R(0, 10**18), tags=['counter'])
B.add('b-bit-count', '二進位 1 的個數', 'L4', '輸入非負整數 n（≤10^18），輸出它的二進位表示中 1 的個數。',
      'def main():\n    n = int(input()); c = 0\n    while n: c += n & 1; n >>= 1\n    print(c)\n', lambda i: '%d\n' % R(0, 10**18), tags=['counter'])

B.write()
