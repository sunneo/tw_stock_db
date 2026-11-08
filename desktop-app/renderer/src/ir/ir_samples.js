/* 中間語言端到端驗證用的 Python 樣本（含註解、docstring、型別標註）。每個樣本是一個完整程式：從標準輸入讀、寫標準輸出。
 * langs＝預期能翻譯的目標語言（c 只支援整數、整數串列與唯讀字串；字典不支援，見 DESIGN.core-ir.md）。測試輸入的期望輸出由 Python 實際執行得出。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaIrSamples = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const S = [];
    S.push({
        id: 'sum-array', langs: ['nodejs', 'java', 'c'], inputs: ['3\n1 2 3\n', '4\n-5 10 -3 7\n', '1\n0\n', '5\n1000000000 1000000000 1000000000 1000000000 1000000000\n'],
        py: `# 計算陣列總和
from typing import List


def total(a: List[int]) -> int:
    """Return the sum of all elements."""
    # accumulator
    s = 0
    for x in a:  # walk the list
        s += x
    return s


def main():
    n = int(input())
    a = list(map(int, input().split()))
    print(total(a))  # 輸出總和


if __name__ == "__main__":
    main()
`
    });
    S.push({
        id: 'max-index', langs: ['nodejs', 'java', 'c'], inputs: ['5\n3 9 2 7 1\n', '3\n-5 -2 -9\n', '1\n7\n', '6\n4 4 8 8 1 8\n'],
        py: `from typing import List


def best(a: List[int]) -> int:
    # 最大值的第一個位置
    m = a[0]
    k = 0
    for i in range(1, len(a)):
        if a[i] > m:
            m = a[i]
            k = i
    return k


def main():
    n = int(input())
    a = list(map(int, input().split()))
    print(best(a))
    print(a[-1])


if __name__ == "__main__":
    main()
`
    });
    S.push({
        id: 'count-primes', langs: ['nodejs', 'java', 'c'], inputs: ['10\n', '2\n', '100\n', '1\n', '1000\n'],
        py: `def is_prime(n: int) -> bool:
    if n < 2:
        return False
    i = 2
    while i * i <= n:
        if n % i == 0:
            return False
        i += 1
    return True


def main():
    n = int(input())
    c = 0
    for k in range(2, n + 1):
        if is_prime(k):
            c += 1
    print(c)


if __name__ == "__main__":
    main()
`
    });
    S.push({
        id: 'palindrome', langs: ['nodejs', 'java', 'c'], inputs: ['abcba\n', 'abca\n', 'x\n', '  racecar  \n', 'ab\n'],
        py: `def is_pal(s: str) -> bool:
    i = 0
    j = len(s) - 1
    while i < j:
        if s[i] != s[j]:
            return False
        i += 1
        j -= 1
    return True


def main():
    s = input().strip()
    if is_pal(s):
        print("YES")
    else:
        print("NO")


if __name__ == "__main__":
    main()
`
    });
    S.push({
        id: 'frequency', langs: ['nodejs', 'java'], inputs: ['6\n3 1 3 2 1 3\n', '1\n5\n', '4\n-1 -1 2 -1\n'],
        py: `from typing import Dict, List


def freq(a: List[int]) -> Dict[int, int]:
    d = {}
    for x in a:
        d[x] = d.get(x, 0) + 1
    return d


def main():
    n = int(input())
    a = list(map(int, input().split()))
    d = freq(a)
    for k in sorted(d):
        print(str(k) + " " + str(d[k]))


if __name__ == "__main__":
    main()
`
    });
    S.push({
        id: 'bubble-sort', langs: ['nodejs', 'java', 'c'], inputs: ['5\n5 2 9 1 5\n', '1\n3\n', '4\n4 3 2 1\n', '6\n-1 0 -3 8 8 2\n'],
        py: `from typing import List


def bubble(a: List[int]) -> List[int]:
    n = len(a)
    for i in range(n):
        for j in range(0, n - i - 1):
            if a[j] > a[j + 1]:
                a[j], a[j + 1] = a[j + 1], a[j]  # 交換
    return a


def main():
    n = int(input())
    a = list(map(int, input().split()))
    print(" ".join(map(str, bubble(a))))


if __name__ == "__main__":
    main()
`
    });
    S.push({
        id: 'floor-div-mod', langs: ['nodejs', 'java', 'c'], inputs: ['-7 2\n', '7 -2\n', '-7 -2\n', '7 2\n', '0 5\n', '-1 3\n'],
        py: `def main():
    a, b = map(int, input().split())
    print(a // b)
    print(a % b)


if __name__ == "__main__":
    main()
`
    });
    S.push({
        id: 'gcd-lcm', langs: ['nodejs', 'java', 'c'], inputs: ['12 18\n', '-12 18\n', '7 13\n', '0 5\n', '100 75\n'],
        py: `def gcd_(a: int, b: int) -> int:
    while b != 0:
        a, b = b, a % b
    return abs(a)


def main():
    a, b = map(int, input().split())
    g = gcd_(a, b)
    print(g)
    if g == 0:
        print(0)
    else:
        print(abs(a // g * b))


if __name__ == "__main__":
    main()
`
    });
    S.push({
        id: 'average-fixed', langs: ['nodejs', 'java', 'c'], inputs: ['3\n1 2 4\n', '8\n0 0 0 0 0 0 0 1\n', '2\n1 2\n', '4\n10 20 30 41\n'],
        py: `from typing import List


def average(a: List[int]) -> float:
    return sum(a) / len(a)


def main():
    n = int(input())
    a = list(map(int, input().split()))
    print("{:.2f}".format(average(a)))


if __name__ == "__main__":
    main()
`
    });
    S.push({
        id: 'text-words', langs: ['nodejs', 'java'], inputs: ['Hello   World foo\n', 'a\n', '  spaced  out  \n'],
        py: `def shout(s: str) -> str:
    return s.upper() + "!"


def main():
    line = input()
    words = line.split()
    print(len(words))
    out = ""
    for w in words:
        if out != "":
            out = out + "-"
        out = out + shout(w)
    print(out)


if __name__ == "__main__":
    main()
`
    });
    return S;
});
