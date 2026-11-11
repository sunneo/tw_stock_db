"""第七批保留題庫（held-out 7）：L4–L6 數論迴圈／模擬、逐行文字轉換、十六進位與位元組、有輸出的轉換器、作業系統小模型。
2026-11-11 在「補矩陣層剩餘缺口」之前先寫、先量基線（凍結：之後不依它調整合成器；補完後只再跑一次對照）。
題目與措辭不是 heldout_all／heldout2~6／bench_linux_all 的題。答案由 ref 實際執行得出。
用法：python3 scripts/eval/gen_heldout7.py   → renderer/src/recipe/seed/heldout7_mixed.jsonl"""
import random
import string
from bench_lib import Bench

B = Bench('heldout7_mixed.jsonl', 20261111)
R = random.randint
C = random.choice
def ints(*ranges): return lambda i: ' '.join(str(R(a, b)) for a, b in ranges) + '\n'
def word(lo, hi, al=string.ascii_lowercase): return ''.join(C(al) for _ in range(R(lo, hi)))
def lines_in(n_lo, n_hi, mk): return lambda i: (lambda n: str(n) + '\n' + ''.join(mk() + '\n' for _ in range(n)))(R(n_lo, n_hi))

# ---- A. L4 數論／計數迴圈 ----
B.add('h7-digital-root', '數位根', 'L4', '輸入一個正整數 n（1 到 10^9）。反覆把 n 換成它各位數字的和，直到只剩一位數，輸出那個一位數。',
      'def main():\n    n = int(input())\n    while n >= 10:\n        n = sum(int(c) for c in str(n))\n    print(n)\n', ints((1, 10**9)))
B.add('h7-sigma', '因數和', 'L4', '輸入一個正整數 n（1 到 5000）。輸出 n 的所有正因數（含 1 與 n 自己）的總和。',
      'def main():\n    n = int(input())\n    print(sum(d for d in range(1, n + 1) if n % d == 0))\n', ints((1, 5000)))
B.add('h7-num-divisors', '因數個數', 'L4', '輸入一個正整數 n（1 到 100000）。輸出 n 有幾個正因數。',
      'def main():\n    n = int(input())\n    print(sum(1 for d in range(1, n + 1) if n % d == 0))\n', ints((1, 100000)))
B.add('h7-collatz', '考拉茲步數', 'L4', '輸入一個正整數 n（1 到 5000）。若 n 是偶數就除以 2，奇數就變成 3n+1，重複直到 n 變成 1，輸出需要幾步。',
      'def main():\n    n = int(input())\n    c = 0\n    while n != 1:\n        n = n // 2 if n % 2 == 0 else 3 * n + 1\n        c += 1\n    print(c)\n', ints((1, 5000)))
B.add('h7-popcount', '二進位 1 的個數', 'L4', '輸入一個非負整數 n（0 到 10^9）。輸出 n 的二進位表示中有幾個 1。',
      'def main():\n    n = int(input())\n    print(bin(n).count("1"))\n', ints((0, 10**9)))
B.add('h7-big-prime-factor', '最大質因數', 'L4', '輸入一個整數 n（2 到 100000）。輸出 n 的最大質因數。',
      'def main():\n    n = int(input())\n    p = 2\n    best = 1\n    while n > 1:\n        while n % p == 0:\n            best = p\n            n //= p\n        p += 1\n    print(best)\n', ints((2, 100000)))
B.add('h7-omega', '質因數個數（含重複）', 'L4', '輸入一個整數 n（2 到 100000）。把 n 分解成質因數的乘積，輸出質因數一共有幾個（相同的質因數重複算，例如 12=2*2*3 有 3 個）。',
      'def main():\n    n = int(input())\n    p = 2\n    c = 0\n    while n > 1:\n        while n % p == 0:\n            c += 1\n            n //= p\n        p += 1\n    print(c)\n', ints((2, 100000)))
B.add('h7-trailing-zeros', '階乘末尾 0 的個數', 'L4', '輸入一個整數 n（1 到 10^6）。輸出 n 的階乘（n!）十進位寫法末尾有幾個 0。',
      'def main():\n    n = int(input())\n    c = 0\n    while n:\n        n //= 5\n        c += n\n    print(c)\n', ints((1, 10**6)))
B.add('h7-rev-digits', '反轉數字', 'L4', '輸入一個正整數 n（1 到 10^9）。輸出把它的十進位數字順序反過來後的整數（前導 0 去掉，例如 120 → 21）。',
      'def main():\n    n = int(input())\n    print(int(str(n)[::-1]))\n', ints((1, 10**9)))

# ---- B. L5/L6 堆疊與陣列 ----
B.add('h7-max-depth', '括號最大深度', 'L5', '輸入一行只含 ( 與 ) 的合法括號字串（長度 2 到 20）。輸出括號巢狀的最大深度。',
      'def main():\n    s = input().strip()\n    d = m = 0\n    for ch in s:\n        d += 1 if ch == "(" else -1\n        m = max(m, d)\n    print(m)\n',
      lambda i: (lambda f: f(f, R(1, 10)))(lambda f, k: ''.join(C(['()', '(())', '()()']) for _ in range(k)) + '\n'))
B.add('h7-dedup-adj', '消除相鄰重複', 'L5', '輸入一行小寫字母字串。反覆刪除相鄰且相同的兩個字元，直到沒有相鄰相同的字元為止，輸出剩下的字串（若為空輸出 EMPTY）。',
      'def main():\n    s = input().strip()\n    st = []\n    for ch in s:\n        if st and st[-1] == ch:\n            st.pop()\n        else:\n            st.append(ch)\n    print("".join(st) or "EMPTY")\n',
      lambda i: word(3, 14, 'abc') + '\n')
B.add('h7-rotate', '陣列右旋', 'L6', '第一行是 n 與 k，第二行是 n 個整數。把陣列向右旋轉 k 個位置（最後 k 個移到最前面），輸出旋轉後的陣列，以空白分隔。',
      'def main():\n    n, k = map(int, input().split())\n    a = list(map(int, input().split()))\n    k %= n\n    print(*(a[-k:] + a[:-k] if k else a))\n',
      lambda i: (lambda n: '%d %d\n%s\n' % (n, R(0, 12), ' '.join(str(R(0, 99)) for _ in range(n))))(R(2, 9)))
B.add('h7-merge-sorted', '合併兩個有序陣列', 'L6', '第一行是 n，第二行是 n 個遞增整數；第三行是 m，第四行是 m 個遞增整數。輸出把兩個陣列合併後的遞增陣列，以空白分隔。',
      'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    m = int(input())\n    b = list(map(int, input().split()))\n    print(*sorted(a + b))\n',
      lambda i: (lambda n, m: '%d\n%s\n%d\n%s\n' % (n, ' '.join(map(str, sorted(R(0, 50) for _ in range(n)))), m, ' '.join(map(str, sorted(R(0, 50) for _ in range(m))))))(R(1, 6), R(1, 6)))
B.add('h7-inversions', '逆序對個數', 'L6', '第一行是 n，第二行是 n 個整數。輸出有幾對 (i, j) 滿足 i < j 且 a[i] > a[j]。',
      'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    print(sum(1 for i in range(n) for j in range(i + 1, n) if a[i] > a[j]))\n',
      lambda i: (lambda n: '%d\n%s\n' % (n, ' '.join(str(R(0, 30)) for _ in range(n))))(R(2, 9)))

# ---- C. 逐行文字轉換 ----
B.add('h7-number-lines-colon', '行號加冒號', 'L6', '第一行是 n，接著 n 行文字。輸出每一行，前面加上「行號: 」（行號從 1 起算，冒號後面一個空白）。',
      'def main():\n    n = int(input())\n    for i in range(1, n + 1):\n        print("%d: %s" % (i, input()))\n', lines_in(1, 5, lambda: word(1, 8) + ' ' + word(1, 5)))
B.add('h7-upper-lines', '每行轉大寫', 'L6', '第一行是 n，接著 n 行文字。輸出每一行轉成大寫之後的結果。',
      'def main():\n    n = int(input())\n    for _ in range(n):\n        print(input().upper())\n', lines_in(1, 5, lambda: word(2, 9) + ' ' + word(1, 5)))
B.add('h7-reverse-each-line', '每行內容反轉', 'L6', '第一行是 n，接著 n 行文字。把每一行的字元順序反過來輸出（行的順序不變）。',
      'def main():\n    n = int(input())\n    for _ in range(n):\n        print(input()[::-1])\n', lines_in(1, 5, lambda: word(2, 9)))
B.add('h7-word-count-lines', '每行單字數', 'L6', '第一行是 n，接著 n 行文字（單字以空白分隔，每行至少一個單字）。輸出 n 行，每行是對應那一行的單字個數。',
      'def main():\n    n = int(input())\n    for _ in range(n):\n        print(len(input().split()))\n', lines_in(1, 5, lambda: ' '.join(word(1, 5) for _ in range(R(1, 5)))))
B.add('h7-grep-v', '輸出不含某字串的行', 'L6', '第一行是字串 pat，第二行是 n，接著 n 行文字。依序輸出「不」含有 pat 的行（原樣）。若沒有任何行符合就什麼都不輸出。',
      'def main():\n    pat = input()\n    n = int(input())\n    for _ in range(n):\n        s = input()\n        if pat not in s:\n            print(s)\n',
      lambda i: (lambda n: word(1, 2, 'abc') + '\n%d\n' % n + ''.join(word(2, 7, 'abcd') + '\n' for _ in range(n)))(R(2, 6)))
B.add('h7-grep-count', '符合行數', 'L6', '第一行是字串 pat，第二行是 n，接著 n 行文字。輸出含有 pat 的行有幾行。',
      'def main():\n    pat = input()\n    n = int(input())\n    c = 0\n    for _ in range(n):\n        if pat in input():\n            c += 1\n    print(c)\n',
      lambda i: (lambda n: word(1, 2, 'abc') + '\n%d\n' % n + ''.join(word(2, 7, 'abcd') + '\n' for _ in range(n)))(R(2, 6)))

# ---- D. 十六進位與位元組 ----
B.add('h7-hex-upper', '轉大寫十六進位', 'L6', '輸入一行只含英數字的文字。輸出它每個字元 ASCII 碼的兩位大寫十六進位，全部相連。',
      'def main():\n    s = input().strip()\n    print("".join("%02X" % ord(c) for c in s))\n', lambda i: word(1, 8, string.ascii_letters + string.digits) + '\n')
B.add('h7-hex-decode', '十六進位轉文字', 'L6', '輸入一行偶數長度的小寫十六進位字串，每兩位代表一個 ASCII 字元。輸出還原後的文字。',
      'def main():\n    h = input().strip()\n    print("".join(chr(int(h[i:i + 2], 16)) for i in range(0, len(h), 2)))\n', lambda i: ''.join('%02x' % ord(C(string.ascii_letters + string.digits)) for _ in range(R(1, 8))) + '\n')
B.add('h7-byte-sum', '位元組總和取 256', 'L6', '輸入一行只含英數字的文字。把每個字元的 ASCII 碼加起來，輸出總和除以 256 的餘數。',
      'def main():\n    s = input().strip()\n    print(sum(ord(c) for c in s) % 256)\n', lambda i: word(1, 12, string.ascii_letters + string.digits) + '\n')
B.add('h7-xor-all', '位元組互斥或', 'L6', '輸入一行只含英數字的文字。把每個字元的 ASCII 碼全部做互斥或（XOR），輸出結果（十進位）。',
      'def main():\n    s = input().strip()\n    r = 0\n    for c in s:\n        r ^= ord(c)\n    print(r)\n', lambda i: word(1, 12, string.ascii_letters + string.digits) + '\n')
B.add('h7-crc32-text', '文字的 CRC-32', 'L6', '輸入一行只含英數字的文字。輸出它的 CRC-32 校驗碼（與 zlib.crc32 相同），以 8 位小寫十六進位表示（左補 0）。',
      'def main():\n    import zlib\n    s = input().strip()\n    print("%08x" % (zlib.crc32(s.encode()) & 0xffffffff))\n', lambda i: word(1, 14, string.ascii_letters + string.digits) + '\n')
B.add('h7-fletcher16', 'Fletcher-16', 'L6', '輸入一行只含英數字的文字。Fletcher-16：s1、s2 初值 0；對每個位元組 b：s1=(s1+b) mod 255，s2=(s2+s1) mod 255。輸出 s2*256+s1（十進位）。',
      'def main():\n    s = input().strip()\n    s1 = s2 = 0\n    for c in s:\n        s1 = (s1 + ord(c)) % 255\n        s2 = (s2 + s1) % 255\n    print(s2 * 256 + s1)\n', lambda i: word(1, 12, string.ascii_letters + string.digits) + '\n')
B.add('h7-base64-enc', 'Base64 編碼', 'L6', '輸入一行只含英數字的文字。輸出它的標準 Base64 編碼（含結尾的 = 補齊）。',
      'def main():\n    import base64\n    s = input().strip()\n    print(base64.b64encode(s.encode()).decode())\n', lambda i: word(1, 12, string.ascii_letters + string.digits) + '\n')

# ---- E. 有輸出的轉換器（Mealy） ----
B.add('h7-caesar', '凱薩移位 3', 'L2', '輸入一行小寫字母字串。把每個字母往後移 3 位（z 接回 a），輸出結果。',
      'def main():\n    s = input().strip()\n    print("".join(chr((ord(c) - 97 + 3) % 26 + 97) for c in s))\n', lambda i: word(1, 10) + '\n')
B.add('h7-rle-decode-digit', '游程解碼（次數在前）', 'L2', '輸入一行游程編碼：每一段是一位數字（1～9）接一個小寫字母，表示該字母重複幾次。輸出還原後的字串。',
      'def main():\n    s = input().strip()\n    print("".join(s[i + 1] * int(s[i]) for i in range(0, len(s), 2)))\n', lambda i: ''.join(str(R(1, 5)) + C('abcd') for _ in range(R(1, 5))) + '\n')
B.add('h7-swapcase', '大小寫互換', 'L2', '輸入一行只含英文字母的字串。把大寫換成小寫、小寫換成大寫後輸出。',
      'def main():\n    print(input().strip().swapcase())\n', lambda i: word(1, 10, string.ascii_letters) + '\n')
B.add('h7-drop-vowels', '刪除母音', 'L2', '輸入一行小寫字母字串。刪除其中的母音字母（a e i o u），輸出剩下的字串（若全被刪光，輸出空行）。',
      'def main():\n    print("".join(c for c in input().strip() if c not in "aeiou"))\n', lambda i: word(2, 12) + '\n')

# ---- F. 作業系統小模型 ----
B.add('h7-lru-hits', 'LRU 命中次數', 'L6', '第一行是快取容量 k 與請求數 n，第二行是 n 個請求編號（整數）。快取採 LRU（最近最少使用）淘汰。輸出總共命中幾次。',
      'def main():\n    k, n = map(int, input().split())\n    seq = list(map(int, input().split()))\n    cache = []\n    hits = 0\n    for x in seq:\n        if x in cache:\n            hits += 1\n            cache.remove(x)\n        elif len(cache) == k:\n            cache.pop(0)\n        cache.append(x)\n    print(hits)\n',
      lambda i: (lambda n: '%d %d\n%s\n' % (R(1, 4), n, ' '.join(str(R(1, 6)) for _ in range(n))))(R(5, 20)))
B.add('h7-fifo-faults', 'FIFO 缺頁次數', 'L6', '第一行是記憶體框數 k 與請求數 n，第二行是 n 個頁面編號。頁面置換採 FIFO（先進先出）。輸出缺頁（要載入的次數）一共幾次。',
      'def main():\n    k, n = map(int, input().split())\n    seq = list(map(int, input().split()))\n    q = []\n    f = 0\n    for x in seq:\n        if x not in q:\n            f += 1\n            if len(q) == k:\n                q.pop(0)\n            q.append(x)\n    print(f)\n',
      lambda i: (lambda n: '%d %d\n%s\n' % (R(1, 4), n, ' '.join(str(R(1, 6)) for _ in range(n))))(R(5, 20)))
B.add('h7-rr-finish', '輪轉排程完成時間', 'L6', '第一行是時間片 q 與工作數 n，第二行是 n 個工作所需的執行時間（皆在時間 0 到達，依序排隊）。採輪轉排程：每次最多跑 q 單位，沒跑完就排到隊尾。輸出最後一個完成的時間（也就是總執行時間）。',
      'def main():\n    q, n = map(int, input().split())\n    a = list(map(int, input().split()))\n    t = 0\n    from collections import deque\n    d = deque(a)\n    while d:\n        x = d.popleft()\n        r = min(q, x)\n        t += r\n        if x - r:\n            d.append(x - r)\n    print(t)\n',
      lambda i: (lambda n: '%d %d\n%s\n' % (R(1, 4), n, ' '.join(str(R(1, 9)) for _ in range(n))))(R(2, 6)))
B.add('h7-petri', 'Petri 網發射序列', 'L6', '第一行是位置數 p 與轉換數 t，第二行是 p 個整數的初始標記。接著 t 行，每行 2p 個整數：前 p 個是該轉換消耗的量、後 p 個是產生的量。最後一行是 m 與 m 個轉換編號（從 0 起）。依序發射這些轉換（保證每次都夠用），輸出最後的標記，以空白分隔。',
      'def main():\n    p, t = map(int, input().split())\n    mk = list(map(int, input().split()))\n    tr = []\n    for _ in range(t):\n        v = list(map(int, input().split()))\n        tr.append((v[:p], v[p:]))\n    z = list(map(int, input().split()))\n    for i in z[1:]:\n        c, g = tr[i]\n        mk = [mk[j] - c[j] + g[j] for j in range(p)]\n    print(*mk)\n',
      lambda i: (lambda m: '3 2\n5 5 5\n1 0 0 0 1 0\n0 1 0 0 0 1\n%d %s\n' % (m, ' '.join(str(R(0, 1)) for _ in range(m))))(R(2, 7)))

B.write()
