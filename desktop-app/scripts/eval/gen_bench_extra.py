#!/usr/bin/env python3
"""涵蓋率基準補充 10 題（湊足 60 題）→ renderer/src/recipe/seed/bench_extra.jsonl。用法：python3 scripts/eval/gen_bench_extra.py"""
import os, random, sys
sys.path.insert(0, os.path.dirname(__file__))
from bench_lib import Bench

B = Bench('bench_extra.jsonl', 20261109)
R = random.randint
MM = 'def mul(A, B, M):\n    n = len(A)\n    return [[sum(A[i][k] * B[k][j] for k in range(n)) % M for j in range(n)] for i in range(n)]\n'

B.add('b-pad-seq', '四項遞推第 n 項', 'L1', 'a(0)=1，a(1)=1，a(2)=2，a(3)=3，a(n)=a(n-1)+a(n-2)+a(n-4)。輸入 n（0≤n≤70），輸出 a(n)。',
      'def main():\n    n = int(input()); a = [1, 1, 2, 3]\n    while len(a) <= n: a.append(a[-1] + a[-2] + a[-4])\n    print(a[n])\n', lambda i: '%d\n' % R(0, 70), tags=['recurrence'])
B.add('b-stairs-123', '爬樓梯（一二三階）取模', 'L1', '每次爬 1、2 或 3 階，爬到第 n 階（1≤n≤10^18）有幾種方法？輸出除以 10^9+7 的餘數。',
      MM + 'def main():\n    n = int(input()); M = 10**9 + 7\n    R_ = [[1 if i == j else 0 for j in range(3)] for i in range(3)]; A = [[1, 1, 1], [1, 0, 0], [0, 1, 0]]; e = n\n    while e:\n        if e & 1: R_ = mul(R_, A, M)\n        A = mul(A, A, M); e >>= 1\n    # 向量 (f(n), f(n-1), f(n-2)) = A^n (f(0), f(-1), f(-2)) = A^n (1, 0, 0)\n    print(R_[0][0] % M)\n',
      lambda i: '%d\n' % random.choice([R(1, 30), R(10**9, 10**18)]), tags=['recurrence', 'big-n'])
B.add('b-no-aa', '不含連續兩個 a', 'L2', '輸入一個由 a、b 組成的字串（長度 1～40），若不含連續兩個 a 印 yes，否則印 no。',
      'def main():\n    print("no" if "aa" in input().strip() else "yes")\n', lambda i: ''.join(random.choice('ab') for _ in range(R(1, 25))) + '\n', tags=['dfa'])
B.add('b-mod-count-3', '1 的個數除以 3 的餘數', 'L2', '輸入一個由 0、1 組成的字串（長度 1～40），輸出其中 1 的個數除以 3 的餘數。',
      'def main():\n    print(input().strip().count("1") % 3)\n', lambda i: ''.join(random.choice('01') for _ in range(R(1, 40))) + '\n', tags=['dfa', 'count'])
B.add('b-in-degree-max', '最大入度', 'L3', '第一行 n m，接著 m 行 a b（有向邊）。輸出所有點中最大的入度。',
      'def main():\n    n, m = map(int, input().split()); d = [0] * (n + 1)\n    for _ in range(m):\n        a, b = map(int, input().split()); d[b] += 1\n    print(max(d))\n',
      lambda i: (lambda n, m: '%d %d\n' % (n, m) + ''.join('%d %d\n' % (R(1, n), R(1, n)) for _ in range(m)))(R(2, 8), R(1, 10)), tags=['semiring'])
B.add('b-lattice-binom', '組合數（格子路徑）', 'L3', '輸入 n k（0≤k≤n≤30），輸出 C(n,k)。',
      'def main():\n    n, k = map(int, input().split()); d = [[0] * (k + 1) for _ in range(n + 1)]\n    for i in range(n + 1):\n        d[i][0] = 1\n        for j in range(1, min(i, k) + 1): d[i][j] = d[i - 1][j - 1] + (d[i - 1][j] if j <= i - 1 else 0)\n    print(d[n][k])\n',
      lambda i: (lambda n: '%d %d\n' % (n, R(0, n)))(R(0, 30)), tags=['semiring', 'dp'])
B.add('b-lcm', '最小公倍數', 'L4', '輸入兩個正整數 a b（≤10^9），輸出 lcm(a,b)。',
      'def main():\n    a, b = map(int, input().split()); x, y = a, b\n    while y: x, y = y, x % y\n    print(a // x * b)\n', lambda i: '%d %d\n' % (R(1, 10**9), R(1, 10**9)), tags=['counter'])
B.add('b-is-prime', '質數判斷', 'L4', '輸入正整數 n（≤10^9），是質數印 yes，否則 no。',
      'def main():\n    n = int(input()); ok = n > 1; d = 2\n    while ok and d * d <= n:\n        if n % d == 0: ok = False\n        d += 1\n    print("yes" if ok else "no")\n', lambda i: '%d\n' % random.choice([R(1, 100), R(10**8, 10**9)]), tags=['counter'])
B.add('b-valid-tags', '標籤配對', 'L5', '輸入一行以空格分隔的標籤，<x> 是開、</x> 是關（x 為小寫單字母）。若全部正確配對印 yes，否則 no。',
      'def main():\n    st = []\n    for t in input().split():\n        if t.startswith("</"):\n            if not st or st.pop() != t[2:-1]:\n                print("no"); return\n        else: st.append(t[1:-1])\n    print("yes" if not st else "no")\n',
      lambda i: ' '.join(random.choice(['<a>', '<b>', '</a>', '</b>']) if R(0, 2) == 0 else x for x in random.choice([['<a>', '</a>'], ['<a>', '<b>', '</b>', '</a>'], ['<b>', '</b>', '<a>', '</a>']])) + '\n', tags=['stack'])
B.add('b-dedupe-sorted', '去重並排序', 'L6', '第一行 n，第二行 n 個整數。輸出去重後由小到大排序的結果（以空格分隔）。',
      'def main():\n    input(); print(*sorted(set(map(int, input().split()))))\n', lambda i: (lambda n: '%d\n' % n + ' '.join(str(R(-5, 5)) for _ in range(n)) + '\n')(R(1, 12)), tags=['array', 'hash'])

B.write()
