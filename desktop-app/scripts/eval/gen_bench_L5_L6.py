#!/usr/bin/env python3
"""涵蓋率基準 L0（公式）、L5（堆疊）、L6（佇列／陣列）、其他 → renderer/src/recipe/seed/bench_L0_L5_L6.jsonl。用法：python3 scripts/eval/gen_bench_L5_L6.py"""
import os, random, sys
sys.path.insert(0, os.path.dirname(__file__))
from bench_lib import Bench

B = Bench('bench_L0_L5_L6.jsonl', 20261108)
R = random.randint


def arr(n, lo=-50, hi=50):
    return '%d\n' % n + ' '.join(str(R(lo, hi)) for _ in range(n)) + '\n'


# ---------- L0：公式 ----------
B.add('b-triangle-area2', '三角形面積的兩倍', 'L0', '輸入三個點的整數座標 x1 y1 x2 y2 x3 y3（絕對值 ≤10^6），輸出三角形面積的兩倍（整數，非負）。',
      'def main():\n    x1, y1, x2, y2, x3, y3 = map(int, input().split())\n    print(abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)))\n', lambda i: ' '.join(str(R(-10**6, 10**6)) for _ in range(6)) + '\n', tags=['formula'])
B.add('b-clamp', '夾在範圍內', 'L0', '輸入 x lo hi（lo≤hi），輸出 x 夾在 [lo,hi] 之間的值。',
      'def main():\n    x, lo, hi = map(int, input().split())\n    print(min(max(x, lo), hi))\n', lambda i: (lambda a, b: '%d %d %d\n' % (R(-100, 100), min(a, b), max(a, b)))(R(-60, 60), R(-60, 60)), tags=['formula'])
B.add('b-sum-1-to-n', '一到 n 的總和', 'L0', '輸入 n（≤10^9），輸出 1+2+…+n。',
      'def main():\n    n = int(input())\n    print(n * (n + 1) // 2)\n', lambda i: '%d\n' % R(1, 10**9), tags=['formula'])
B.add('b-median3', '三數中位數', 'L0', '輸入三個整數，輸出中間大的那個。',
      'def main():\n    print(sorted(map(int, input().split()))[1])\n', lambda i: '%d %d %d\n' % (R(-20, 20), R(-20, 20), R(-20, 20)), tags=['formula'])
B.add('b-celsius', '攝氏轉華氏取整', 'L0', '輸入攝氏溫度整數 c，輸出華氏溫度 c*9/5+32，無條件捨去到整數（向負無限大）。',
      'def main():\n    c = int(input())\n    print((c * 9) // 5 + 32)\n', lambda i: '%d\n' % R(-100, 100), tags=['formula'])
B.add('b-sort-4', '四個數排序', 'L0', '輸入四個整數，由小到大輸出（以空格分隔）。',
      'def main():\n    print(*sorted(map(int, input().split())))\n', lambda i: ' '.join(str(R(-30, 30)) for _ in range(4)) + '\n', tags=['formula', 'oblivious'])

# ---------- L5：堆疊 ----------
B.add('b-brackets-3', '三種括號配對', 'L5', '輸入只含 ()[]{} 的字串（長度 1～30），若括號正確配對印 yes，否則印 no。',
      'def main():\n    s = input().strip(); st = []; p = {")": "(", "]": "[", "}": "{"}\n    for c in s:\n        if c in "([{": st.append(c)\n        elif not st or st.pop() != p[c]:\n            print("no"); return\n    print("yes" if not st else "no")\n',
      lambda i: ''.join(random.choice('()[]{}') if R(0, 3) == 0 else random.choice(['()', '[]', '{}', '([])', '{()}']) for _ in range(R(1, 6))) + '\n', tags=['stack'])
B.add('b-reverse-string', '字串反轉', 'L5', '輸入一行文字（長度 1～40），輸出反轉後的字串。',
      'def main():\n    print(input().strip()[::-1])\n', lambda i: ''.join(random.choice('abcdxyz') for _ in range(R(1, 30))) + '\n', tags=['stack'])
B.add('b-rpn', '後序運算式', 'L5', '輸入以空格分隔的後序（逆波蘭）運算式，運算子只有 + - *，運算元是整數。輸出結果。',
      'def main():\n    st = []\n    for t in input().split():\n        if t in "+-*":\n            b = st.pop(); a = st.pop()\n            st.append(a + b if t == "+" else a - b if t == "-" else a * b)\n        else: st.append(int(t))\n    print(st[0])\n',
      lambda i: (lambda k: ' '.join([str(R(-9, 9)) for _ in range(1)] + sum(([str(R(-9, 9)), random.choice('+-*')] for _ in range(k)), [])))(R(1, 6)) + '\n', tags=['stack'])
B.add('b-max-depth', '括號最大深度', 'L5', '輸入只含 ( ) 且配對正確的字串（長度 2～40），輸出巢狀最大深度。',
      'def main():\n    d = m = 0\n    for c in input().strip():\n        d += 1 if c == "(" else -1; m = max(m, d)\n    print(m)\n',
      lambda i: (lambda f: f(f, R(1, 8)))(lambda f, k: ''.join(['(' + (f(f, k - 1) if k > 1 and R(0, 1) else '') + ')' for _ in range(R(1, 3))])) + '\n', tags=['stack'])
B.add('b-next-greater', '下一個較大元素', 'L5', '第一行 n，第二行 n 個整數。對每個位置輸出右邊第一個比它大的數，沒有則輸出 -1，以空格分隔。',
      'def main():\n    n = int(input()); a = list(map(int, input().split())); r = [-1] * n; st = []\n    for i, x in enumerate(a):\n        while st and a[st[-1]] < x: r[st.pop()] = x\n        st.append(i)\n    print(*r)\n', lambda i: arr(R(1, 12), 1, 20), tags=['stack'])
B.add('b-stack-ops', '堆疊操作模擬', 'L5', '第一行 q，之後 q 行指令：push x、pop、top。pop 與 top 在堆疊空時輸出 empty；top 輸出頂端值，pop 輸出被移除的值。',
      'def main():\n    q = int(input()); st = []\n    for _ in range(q):\n        t = input().split()\n        if t[0] == "push": st.append(int(t[1]))\n        elif not st: print("empty")\n        elif t[0] == "pop": print(st.pop())\n        else: print(st[-1])\n',
      lambda i: (lambda q: '%d\n' % q + ''.join(random.choice(['push %d\n' % R(1, 9), 'pop\n', 'top\n']) for _ in range(q)))(R(3, 12)), tags=['stack'])

# ---------- L6：佇列／陣列 ----------
B.add('b-bfs-grid', '格子最短步數', 'L6', '第一行 n m（≤10），接著 n 行字元 "." 或 "#"。從左上走到右下（四方向，不能穿牆）最少幾步？到不了輸出 -1。',
      'from collections import deque\ndef main():\n    n, m = map(int, input().split()); g = [input().strip() for _ in range(n)]\n    d = {(0, 0): 0}; q = deque([(0, 0)])\n    if g[0][0] == "#": print(-1); return\n    while q:\n        x, y = q.popleft()\n        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):\n            a, b = x + dx, y + dy\n            if 0 <= a < n and 0 <= b < m and g[a][b] == "." and (a, b) not in d: d[(a, b)] = d[(x, y)] + 1; q.append((a, b))\n    print(d.get((n - 1, m - 1), -1))\n',
      lambda i: (lambda n, m: '%d %d\n' % (n, m) + '\n'.join(''.join('#' if (R(0, 9) < 3 and (r, c) not in ((0, 0), (n - 1, m - 1))) else '.' for c in range(m)) for r in range(n)) + '\n')(R(1, 8), R(1, 8)), tags=['queue'])
B.add('b-sort-array', '陣列排序', 'L6', '第一行 n（≤30），第二行 n 個整數。由小到大輸出（以空格分隔）。',
      'def main():\n    n = int(input()); print(*sorted(map(int, input().split())))\n', lambda i: arr(R(1, 25)), tags=['array'])
B.add('b-kth-smallest', '第 k 小', 'L6', '第一行 n k，第二行 n 個整數。輸出第 k 小的數（k 從 1 起）。',
      'def main():\n    n, k = map(int, input().split()); print(sorted(map(int, input().split()))[k - 1])\n',
      lambda i: (lambda n: '%d %d\n' % (n, R(1, n)) + ' '.join(str(R(-40, 40)) for _ in range(n)) + '\n')(R(1, 15)), tags=['array'])
B.add('b-prefix-queries', '區間和查詢', 'L6', '第一行 n q，第二行 n 個整數，再 q 行 l r（1 起算，含兩端）。對每個查詢輸出區間和。',
      'def main():\n    n, q = map(int, input().split()); a = list(map(int, input().split())); p = [0]\n    for x in a: p.append(p[-1] + x)\n    for _ in range(q):\n        l, r = map(int, input().split()); print(p[r] - p[l - 1])\n',
      lambda i: (lambda n, q: '%d %d\n' % (n, q) + ' '.join(str(R(-9, 9)) for _ in range(n)) + '\n' + ''.join((lambda l: '%d %d\n' % (l, R(l, n)))(R(1, n)) for _ in range(q)))(R(1, 12), R(1, 5)), tags=['array'])
B.add('b-lis-len', '最長嚴格遞增子序列', 'L6', '第一行 n（≤20），第二行 n 個整數，輸出最長嚴格遞增子序列的長度。',
      'def main():\n    n = int(input()); a = list(map(int, input().split())); d = [1] * n\n    for i in range(n):\n        for j in range(i):\n            if a[j] < a[i]: d[i] = max(d[i], d[j] + 1)\n    print(max(d))\n', lambda i: arr(R(1, 15), 1, 20), tags=['array', 'dp'])
B.add('b-union-find', '並查集連通查詢', 'L6', '第一行 n m q，接著 m 行 a b 表示無向邊，再 q 行 x y，輸出 x 與 y 是否連通（yes／no）。',
      'def main():\n    n, m, q = map(int, input().split()); p = list(range(n + 1))\n    def f(x):\n        while p[x] != x: p[x] = p[p[x]]; x = p[x]\n        return x\n    for _ in range(m):\n        a, b = map(int, input().split()); p[f(a)] = f(b)\n    for _ in range(q):\n        x, y = map(int, input().split()); print("yes" if f(x) == f(y) else "no")\n',
      lambda i: (lambda n, m, q: '%d %d %d\n' % (n, m, q) + ''.join('%d %d\n' % (R(1, n), R(1, n)) for _ in range(m + q)))(R(3, 10), R(1, 6), R(1, 4)), tags=['array', 'union-find'])
B.add('b-queue-sim', '佇列操作模擬', 'L6', '第一行 q，之後 q 行指令：enq x、deq、front。deq 與 front 在佇列空時輸出 empty；deq 輸出被移除的值，front 輸出隊首。',
      'from collections import deque\ndef main():\n    q = int(input()); d = deque()\n    for _ in range(q):\n        t = input().split()\n        if t[0] == "enq": d.append(int(t[1]))\n        elif not d: print("empty")\n        elif t[0] == "deq": print(d.popleft())\n        else: print(d[0])\n',
      lambda i: (lambda q: '%d\n' % q + ''.join(random.choice(['enq %d\n' % R(1, 9), 'deq\n', 'front\n']) for _ in range(q)))(R(3, 12)), tags=['queue'])
B.add('b-topo-order', '拓撲排序（字典序最小）', 'L6', '第一行 n m（有向無環圖），接著 m 行 a b 表示 a 必須在 b 之前。輸出字典序最小的拓撲序（以空格分隔）。',
      'import heapq\ndef main():\n    n, m = map(int, input().split()); adj = [[] for _ in range(n + 1)]; ind = [0] * (n + 1)\n    for _ in range(m):\n        a, b = map(int, input().split()); adj[a].append(b); ind[b] += 1\n    h = [i for i in range(1, n + 1) if ind[i] == 0]; heapq.heapify(h); r = []\n    while h:\n        u = heapq.heappop(h); r.append(u)\n        for v in adj[u]:\n            ind[v] -= 1\n            if ind[v] == 0: heapq.heappush(h, v)\n    print(*r)\n',
      lambda i: (lambda n: '%d ' % n + (lambda es: '%d\n' % len(es) + ''.join('%d %d\n' % e for e in es))(sorted({(a, b) for a in range(1, n + 1) for b in range(a + 1, n + 1) if R(0, 3) == 0})))(R(2, 8)), tags=['heap', 'graph'])

# ---------- 其他（需要字串／雜湊／輸出格式處理）----------
B.add('b-word-freq-top', '最常出現的單字', 'other', '輸入一行以空格分隔的單字，輸出出現最多次的單字；若有並列，輸出字典序最小者。',
      'def main():\n    from collections import Counter\n    c = Counter(input().split()); m = max(c.values()); print(min(w for w in c if c[w] == m))\n',
      lambda i: ' '.join(random.choice(['apple', 'bob', 'cat', 'dog', 'eel']) for _ in range(R(1, 10))) + '\n', tags=['hash'])
B.add('b-caesar', '凱撒密碼', 'other', '第一行偏移量 k（0≤k≤25），第二行小寫英文字串。把每個字母往後移 k 位（z 後接 a），輸出結果。',
      'def main():\n    k = int(input()); s = input().strip()\n    print("".join(chr((ord(c) - 97 + k) % 26 + 97) for c in s))\n',
      lambda i: '%d\n' % R(0, 25) + ''.join(random.choice('abcxyz') for _ in range(R(1, 15))) + '\n', tags=['string'])
B.add('b-run-length', '連續字元壓縮', 'other', '輸入小寫字串，輸出連續相同字元壓縮後的結果，如 aaabcc → a3b1c2。',
      'def main():\n    s = input().strip(); r = []; i = 0\n    while i < len(s):\n        j = i\n        while j < len(s) and s[j] == s[i]: j += 1\n        r.append(s[i] + str(j - i)); i = j\n    print("".join(r))\n',
      lambda i: ''.join(random.choice('aab') * R(1, 3) for _ in range(R(1, 6))) + '\n', tags=['string'])
B.add('b-roman', '羅馬數字轉整數', 'other', '輸入一個羅馬數字（1～3999，只含 IVXLCDM，標準減法寫法），輸出對應整數。',
      'def main():\n    v = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}; s = input().strip(); t = 0\n    for i, c in enumerate(s):\n        t += -v[c] if i + 1 < len(s) and v[c] < v[s[i + 1]] else v[c]\n    print(t)\n',
      lambda i: (lambda n: ''.join(sym * (n // val) if False else '' for sym, val in []) or (lambda n: __import__('functools').reduce(lambda acc, sv: (acc[0] + sv[0] * (acc[1] // sv[1]), acc[1] % sv[1]), [("M", 1000), ("CM", 900), ("D", 500), ("CD", 400), ("C", 100), ("XC", 90), ("L", 50), ("XL", 40), ("X", 10), ("IX", 9), ("V", 5), ("IV", 4), ("I", 1)], ('', n))[0])(n))(R(1, 3999)) + '\n', tags=['string'])

B.write()
