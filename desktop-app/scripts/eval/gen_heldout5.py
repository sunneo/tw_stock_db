"""第五批保留題庫（held-out 5）：L0 公式類（條件判斷、多輸出、小數）。2026-11-07 在 matrix_l0_core.js（predicate／multi／real）寫好之後另寫：措辭與題目都不是 heldout_all 凍結題（ho-avg4／ho-range3／ho-clock／ho-leap），並混入範本沒有的題型（最大公因數、階乘、冪取模、兩數和奇偶）看它會不會誠實說做不到。
用法：python3 scripts/eval/gen_heldout5.py   → renderer/src/recipe/seed/heldout5_l0.jsonl"""
import random
from bench_lib import Bench

B = Bench('heldout5_l0.jsonl', 20261110)
R = random.randint
def ints(*ranges): return lambda i: ' '.join(str(R(a, b)) for a, b in ranges) + '\n'

B.add('h5-leap', '是否閏年（Leap／Common）', 'L0', '輸入一個年份 y（1 到 3000）。如果 y 能被 4 整除但不能被 100 整除，或者 y 能被 400 整除，就輸出 Leap，否則輸出 Common。',
      'def main():\n    y = int(input())\n    print("Leap" if (y % 4 == 0 and y % 100 != 0) or y % 400 == 0 else "Common")\n', ints((1, 3000)))
B.add('h5-triangle', '能否構成三角形', 'L0', '輸入三個正整數 a b c（1 到 30）。如果可以當作三角形的三邊（任意兩邊的和都大於第三邊）輸出 OK，否則輸出 NO。',
      'def main():\n    a, b, c = map(int, input().split())\n    print("OK" if a + b > c and a + c > b and b + c > a else "NO")\n', ints((1, 30), (1, 30), (1, 30)))
B.add('h5-in-range', '是否在區間內', 'L0', '輸入三個整數 x l r（-50 到 50，保證 l<=r）。如果 x 落在 l 到 r 之間（含兩端）輸出 in，否則輸出 out。',
      'def main():\n    x, l, r = map(int, input().split())\n    print("in" if l <= x <= r else "out")\n', lambda i: (lambda l: '%d %d %d\n' % (R(-50, 50), l, R(l, 50)))(R(-50, 40)))
B.add('h5-mult35', '3 或 5 的倍數', 'L0', '輸入一個整數 n（1 到 1000）。如果 n 是 3 的倍數或 5 的倍數，輸出 Yes，否則輸出 No。',
      'def main():\n    n = int(input())\n    print("Yes" if n % 3 == 0 or n % 5 == 0 else "No")\n', ints((1, 1000)))
B.add('h5-seconds', '秒數換成時分秒', 'L0', '輸入一個秒數 s（0 到 99999）。輸出對應的時、分、秒三個整數（分與秒都是 0 到 59），以空白分隔。',
      'def main():\n    s = int(input())\n    print(s // 3600, s % 3600 // 60, s % 60)\n', ints((0, 99999)))
B.add('h5-divmod', '商與餘數', 'L0', '輸入兩個整數 a b（a 為 0 到 1000，b 為 1 到 50）。輸出 a 除以 b 的商與餘數，以空白分隔。',
      'def main():\n    a, b = map(int, input().split())\n    print(a // b, a % b)\n', ints((0, 1000), (1, 50)))
B.add('h5-avg3', '三數平均（兩位小數）', 'L0', '輸入三個整數 a b c（0 到 100）。輸出它們的平均值，保留 2 位小數。',
      'def main():\n    a, b, c = map(int, input().split())\n    print("%.2f" % ((a + b + c) / 3))\n', ints((0, 100), (0, 100), (0, 100)))
B.add('h5-bmi', 'BMI（一位小數）', 'L0', '輸入體重 w（公斤）與身高 h（公分）兩個整數（w 為 30 到 150，h 為 120 到 200）。BMI＝體重除以身高（公尺）的平方。輸出 BMI，保留 1 位小數。',
      'def main():\n    w, h = map(int, input().split())\n    print("%.1f" % (w / (h / 100) ** 2))\n', ints((30, 150), (120, 200)))
B.add('h5-gcd', '最大公因數（範本沒有，預期做不到）', 'L0', '輸入兩個正整數 a b（1 到 500），輸出它們的最大公因數。',
      'def main():\n    import math\n    a, b = map(int, input().split())\n    print(math.gcd(a, b))\n', ints((1, 500), (1, 500)))
B.add('h5-fact', '階乘（範本沒有，預期做不到）', 'L0', '輸入一個整數 n（0 到 15），輸出 n 的階乘。',
      'def main():\n    n = int(input())\n    r = 1\n    for i in range(2, n + 1): r *= i\n    print(r)\n', ints((0, 15)))
B.add('h5-powmod', '冪取模（範本沒有，預期做不到）', 'L0', '輸入兩個整數 a b（1 到 50），輸出 a 的 b 次方除以 1000000007 的餘數。',
      'def main():\n    a, b = map(int, input().split())\n    print(pow(a, b, 10**9 + 7))\n', ints((1, 50), (1, 50)))
B.add('h5-sum-parity', '兩數和的奇偶（四個原子，預期做不到）', 'L0', '輸入兩個整數 a b（1 到 100）。如果 a+b 是偶數輸出 even，否則輸出 odd。',
      'def main():\n    a, b = map(int, input().split())\n    print("even" if (a + b) % 2 == 0 else "odd")\n', ints((1, 100), (1, 100)))

B.write()
