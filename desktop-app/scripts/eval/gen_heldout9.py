"""第九批保留題庫（held-out 9）：L5／L6 清單與堆疊類（n＋清單進，整數／清單／標籤出）。
2026-11-11 在「補矩陣層清單草圖」之前先寫、先量基線；凍結，補完後只再跑一次。題目不抄 heldout7（旋轉、合併、逆序對、括號深度、相鄰消除）。
用法：python gen_heldout9.py   → renderer/src/recipe/seed/heldout9_list.jsonl"""
import random
from bench_lib import Bench

B = Bench('heldout9_list.jsonl', 20261113)
R = random.randint
def lst(n_lo, n_hi, lo, hi, extra=None):
    def g(i):
        n = R(n_lo, n_hi)
        a = ' '.join(str(R(lo, hi)) for _ in range(n))
        return ('%d%s\n%s\n' % (n, (' ' + str(extra())) if extra else '', a))
    return g
def kfirst(n_lo, n_hi, lo, hi, klo, khi):  # 第一行 n k
    return lst(n_lo, n_hi, lo, hi, lambda: R(klo, khi))

B.add('h9-second-max', '第二大的不同值', 'L6', '第一行是 n，第二行是 n 個整數（至少有兩個不同的值）。輸出第二大的「不同值」（例如 5 5 3 → 3）。',
      'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    print(sorted(set(a))[-2])\n',
      lambda i: (lambda n: '%d\n%s\n' % (n, ' '.join(str(R(0, 15)) for _ in range(n))))(R(3, 8)))
B.add('h9-above-avg', '大於平均的個數', 'L6', '第一行是 n，第二行是 n 個整數。輸出有幾個數嚴格大於全部數的平均值。',
      'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    s = sum(a)\n    print(sum(1 for x in a if x * n > s))\n', lst(2, 9, -20, 40))
B.add('h9-longest-run', '最長連續相同', 'L6', '第一行是 n，第二行是 n 個整數。輸出最長的一段「連續相同的數」有多長。',
      'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    best = cur = 1\n    for i in range(1, n):\n        cur = cur + 1 if a[i] == a[i - 1] else 1\n        best = max(best, cur)\n    print(best)\n', lst(2, 10, 1, 3))
B.add('h9-kadane', '最大子陣列和', 'L6', '第一行是 n，第二行是 n 個整數。輸出所有「連續一段」（至少一個數）的和中最大的那個。',
      'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    best = cur = a[0]\n    for x in a[1:]:\n        cur = max(x, cur + x)\n        best = max(best, cur)\n    print(best)\n', lst(2, 9, -9, 9))
B.add('h9-pair-sum-k', '和為 k 的配對數', 'L6', '第一行是 n 與 k，第二行是 n 個整數。輸出有幾對 (i, j)（i < j）滿足 a[i] + a[j] 等於 k。',
      'def main():\n    n, k = map(int, input().split())\n    a = list(map(int, input().split()))\n    print(sum(1 for i in range(n) for j in range(i + 1, n) if a[i] + a[j] == k))\n', kfirst(3, 9, 0, 8, 3, 10))
B.add('h9-sort-desc', '由大到小排序', 'L6', '第一行是 n，第二行是 n 個整數。把它們由大到小排序後輸出，以空白分隔。',
      'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    print(*sorted(a, reverse=True))\n', lst(2, 8, -20, 20))
B.add('h9-prefix-max', '前綴最大值', 'L6', '第一行是 n，第二行是 n 個整數。輸出一行 n 個數，第 i 個是前 i 個數中的最大值。',
      'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    out = []\n    m = a[0]\n    for x in a:\n        m = max(m, x)\n        out.append(m)\n    print(*out)\n', lst(2, 9, -9, 20))
B.add('h9-dedup-keep-order', '去重保留順序', 'L6', '第一行是 n，第二行是 n 個整數。去掉重複的數（每個值只保留第一次出現的位置），輸出剩下的數，以空白分隔。',
      'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    seen = set()\n    out = []\n    for x in a:\n        if x not in seen:\n            seen.add(x)\n            out.append(x)\n    print(*out)\n', lst(3, 10, 1, 6))
B.add('h9-median-odd', '中位數', 'L6', '第一行是奇數 n，第二行是 n 個整數。輸出排序後正中間的那個數。',
      'def main():\n    n = int(input())\n    a = sorted(map(int, input().split()))\n    print(a[n // 2])\n', lambda i: (lambda n: '%d\n%s\n' % (n, ' '.join(str(R(-30, 30)) for _ in range(n))))(R(1, 5) * 2 - 1))
B.add('h9-peaks', '山峰個數', 'L6', '第一行是 n，第二行是 n 個整數。如果一個位置不是頭尾，且比左右兩邊都大，它就是山峰。輸出山峰有幾個。',
      'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    print(sum(1 for i in range(1, n - 1) if a[i] > a[i - 1] and a[i] > a[i + 1]))\n', lst(3, 10, 1, 9))
B.add('h9-window-sum', '滑動視窗和', 'L6', '第一行是 n 與 k，第二行是 n 個整數。輸出每一個長度為 k 的連續視窗的和（共 n-k+1 個），以空白分隔。',
      'def main():\n    n, k = map(int, input().split())\n    a = list(map(int, input().split()))\n    print(*[sum(a[i:i + k]) for i in range(n - k + 1)])\n', lambda i: (lambda n: '%d %d\n%s\n' % (n, R(1, n), ' '.join(str(R(0, 20)) for _ in range(n))))(R(3, 9)))
B.add('h9-mode', '眾數', 'L6', '第一行是 n，第二行是 n 個整數。輸出出現次數最多的數；如果有好幾個一樣多，輸出其中最小的。',
      'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    from collections import Counter\n    c = Counter(a)\n    m = max(c.values())\n    print(min(x for x in c if c[x] == m))\n', lst(3, 10, 1, 5))
B.add('h9-common-count', '兩個有序陣列的共同元素個數', 'L6', '第一行是 n，第二行是 n 個遞增整數（不重複）；第三行是 m，第四行是 m 個遞增整數（不重複）。輸出兩個陣列共同擁有的數有幾個。',
      'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    m = int(input())\n    b = list(map(int, input().split()))\n    print(len(set(a) & set(b)))\n',
      lambda i: (lambda n, m: '%d\n%s\n%d\n%s\n' % (n, ' '.join(map(str, sorted(random.sample(range(0, 15), n)))), m, ' '.join(map(str, sorted(random.sample(range(0, 15), m))))))(R(2, 7), R(2, 7)))
B.add('h9-brackets3', '三種括號是否合法', 'L5', '輸入一行只含 ( ) [ ] { } 的字串。如果括號都正確配對且巢狀順序合法，輸出 OK，否則輸出 BAD。',
      'def main():\n    s = input().strip()\n    st = []\n    pair = {")": "(", "]": "[", "}": "{"}\n    for ch in s:\n        if ch in "([{":\n            st.append(ch)\n        elif not st or st.pop() != pair[ch]:\n            print("BAD")\n            return\n    print("OK" if not st else "BAD")\n',
      lambda i: ''.join(random.choice('()[]{}') for _ in range(R(2, 8))) + '\n' if R(0, 1) else (lambda f: f(f, R(1, 4)))(lambda f, k: ''.join(random.choice(['()', '[]', '{}', '([])', '{()}']) for _ in range(k)) + '\n'))
B.add('h9-subarray-k', '和為 k 的連續段個數', 'L6', '第一行是 n 與 k，第二行是 n 個整數。輸出有幾段連續子陣列（至少一個數）的和剛好等於 k。',
      'def main():\n    n, k = map(int, input().split())\n    a = list(map(int, input().split()))\n    c = 0\n    for i in range(n):\n        s = 0\n        for j in range(i, n):\n            s += a[j]\n            if s == k:\n                c += 1\n    print(c)\n', lambda i: (lambda n: '%d %d\n%s\n' % (n, R(0, 6), ' '.join(str(R(-2, 4)) for _ in range(n))))(R(3, 9)))
B.add('h9-rotate-left', '陣列左旋', 'L6', '第一行是 n 與 k，第二行是 n 個整數。把陣列向左旋轉 k 個位置（最前面 k 個移到最後面），輸出旋轉後的陣列，以空白分隔。',
      'def main():\n    n, k = map(int, input().split())\n    a = list(map(int, input().split()))\n    k %= n\n    print(*(a[k:] + a[:k]))\n', kfirst(2, 8, 0, 50, 0, 12))
B.write()
