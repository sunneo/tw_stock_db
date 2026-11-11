"""第八批保留題庫（held-out 8）：L4 單一／兩個整數進、整數或標籤出的迴圈題（數論、計數、進位、迭代）。
2026-11-11 在「補矩陣層 L4 草圖（sketch）法」之前先寫、先量基線；凍結，補完後只再跑一次。題目不抄 heldout_all 的 ho-phi／ho-perfect／ho-halve／ho-base-k，也不抄 heldout7。
用法：python gen_heldout8.py   → renderer/src/recipe/seed/heldout8_l4.jsonl"""
import random
from bench_lib import Bench

B = Bench('heldout8_l4.jsonl', 20261112)
R = random.randint
def ints(*ranges): return lambda i: ' '.join(str(R(a, b)) for a, b in ranges) + '\n'

B.add('h8-sum-squares', '平方和', 'L4', '輸入一個正整數 n（1 到 1000）。輸出 1² + 2² + … + n² 的值。',
      'def main():\n    n = int(input())\n    print(sum(i * i for i in range(1, n + 1)))\n', ints((1, 1000)))
B.add('h8-count-primes', '質數個數', 'L4', '輸入一個正整數 n（1 到 3000）。輸出不超過 n 的質數有幾個。',
      'def main():\n    n = int(input())\n    c = 0\n    for x in range(2, n + 1):\n        if all(x % d for d in range(2, int(x ** 0.5) + 1)):\n            c += 1\n    print(c)\n', ints((1, 3000)))
B.add('h8-sum-multiples', '3 或 5 的倍數之和', 'L4', '輸入一個正整數 n（1 到 5000）。輸出所有小於 n 且是 3 的倍數或 5 的倍數的正整數之和。',
      'def main():\n    n = int(input())\n    print(sum(x for x in range(1, n) if x % 3 == 0 or x % 5 == 0))\n', ints((1, 5000)))
B.add('h8-prime-divisors', '質因數種類數', 'L4', '輸入一個正整數 n（2 到 100000）。輸出 n 有幾種不同的質因數（例如 12 = 2·2·3 有 2 種）。',
      'def main():\n    n = int(input())\n    s = set()\n    p = 2\n    while n > 1:\n        while n % p == 0:\n            s.add(p)\n            n //= p\n        p += 1\n    print(len(s))\n', ints((2, 100000)))
B.add('h8-smallest-prime-factor', '最小質因數', 'L4', '輸入一個整數 n（2 到 100000）。輸出 n 的最小質因數。',
      'def main():\n    n = int(input())\n    p = 2\n    while n % p:\n        p += 1\n    print(p)\n', ints((2, 100000)))
B.add('h8-lcm', '最小公倍數', 'L4', '輸入兩個正整數 a b（1 到 200）。輸出它們的最小公倍數。',
      'def main():\n    import math\n    a, b = map(int, input().split())\n    print(a * b // math.gcd(a, b))\n', ints((1, 200), (1, 200)))
B.add('h8-powmod', '冪取模', 'L4', '輸入三個正整數 a b m（a、b 為 1 到 1000，m 為 2 到 1000）。輸出 a 的 b 次方除以 m 的餘數。',
      'def main():\n    a, b, m = map(int, input().split())\n    print(pow(a, b, m))\n', ints((1, 1000), (1, 1000), (2, 1000)))
B.add('h8-binom', '組合數', 'L4', '輸入兩個整數 n k（0 ≤ k ≤ n ≤ 20）。輸出從 n 個東西裡取 k 個的組合數。',
      'def main():\n    import math\n    n, k = map(int, input().split())\n    print(math.comb(n, k))\n', lambda i: (lambda n: '%d %d\n' % (n, R(0, n)))(R(0, 20)))
B.add('h8-to-base', '轉成 k 進位', 'L4', '輸入兩個整數 n k（n 為 0 到 100000，k 為 2 到 9）。輸出 n 以 k 進位表示的數字（不加前導 0；n = 0 時輸出 0）。',
      'def main():\n    n, k = map(int, input().split())\n    ds = []\n    while n:\n        ds.append(str(n % k))\n        n //= k\n    print("".join(reversed(ds)) or "0")\n', ints((0, 100000), (2, 9)))
B.add('h8-digits-count-base2', '二進位尾端連續 0 的個數', 'L4', '輸入一個正整數 n（1 到 10^9）。輸出 n 的二進位表示末尾連續有幾個 0。',
      'def main():\n    n = int(input())\n    c = 0\n    while n % 2 == 0:\n        n //= 2\n        c += 1\n    print(c)\n', ints((1, 10**9)))
B.add('h8-greedy-squares', '最少用幾個平方數', 'L4', '輸入一個正整數 n（1 到 10000）。每一步都扣掉「不超過目前數的最大完全平方數」，直到變成 0。輸出總共扣了幾步。',
      'def main():\n    n = int(input())\n    c = 0\n    while n:\n        r = int(n ** 0.5)\n        while r * r > n:\n            r -= 1\n        while (r + 1) * (r + 1) <= n:\n            r += 1\n        n -= r * r\n        c += 1\n    print(c)\n', ints((1, 10000)))
B.add('h8-happy', '快樂數', 'L4', '輸入一個正整數 n（1 到 1000）。反覆把 n 換成它各位數字平方的和；如果最後會變成 1 輸出 Happy，否則輸出 Sad。',
      'def main():\n    n = int(input())\n    seen = set()\n    while n != 1 and n not in seen:\n        seen.add(n)\n        n = sum(int(c) ** 2 for c in str(n))\n    print("Happy" if n == 1 else "Sad")\n', ints((1, 1000)))
B.add('h8-hailstone-max', '考拉茲最大值', 'L4', '輸入一個正整數 n（1 到 3000）。若 n 為偶數就除以 2，奇數就變成 3n+1，重複直到 1。輸出過程中出現過的最大數。',
      'def main():\n    n = int(input())\n    m = n\n    while n != 1:\n        n = n // 2 if n % 2 == 0 else 3 * n + 1\n        m = max(m, n)\n    print(m)\n', ints((1, 3000)))
B.add('h8-triangular-index', '累加到超過', 'L4', '輸入一個正整數 n（1 到 10^6）。從 1 開始依序加 1、2、3…，輸出第一次讓總和大於等於 n 時加到的那個數。',
      'def main():\n    n = int(input())\n    s = 0\n    k = 0\n    while s < n:\n        k += 1\n        s += k\n    print(k)\n', ints((1, 10**6)))
B.add('h8-even-digit-count', '偶數數字個數', 'L4', '輸入一個正整數 n（1 到 10^9）。輸出 n 的十進位表示裡有幾個偶數數字（0 也算偶數）。',
      'def main():\n    n = int(input())\n    print(sum(1 for c in str(n) if int(c) % 2 == 0))\n', ints((1, 10**9)))
B.add('h8-abundant', '盈數判斷', 'L4', '輸入一個正整數 n（1 到 2000）。如果 n 的所有真因數（不含 n 自己）之和大於 n，輸出 Abundant，否則輸出 Not。',
      'def main():\n    n = int(input())\n    print("Abundant" if sum(d for d in range(1, n) if n % d == 0) > n else "Not")\n', ints((1, 2000)))
B.add('h8-fact-digits', 'n! 的位數', 'L4', '輸入一個整數 n（1 到 60）。輸出 n 的階乘（n!）有幾位數。',
      'def main():\n    import math\n    print(len(str(math.factorial(int(input())))))\n', ints((1, 60)))
B.write()
