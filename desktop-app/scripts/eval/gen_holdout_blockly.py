"""Blockly 補範式後的「沒用來開發」驗證題（holdout）：同一家族但換說法、換參數、換輸出字樣；另含幾題家族之外的題（預期解不出，如實呈現）。
輸出 renderer/src/recipe/seed/holdout_blockly.jsonl（檔名不以 bench_ 開頭，不會被 bench_coverage.js 的 60 題基準撿到）。
跑法：FA_TS_DIR=/tmp/fa-ts-cache node scripts/eval/bench_coverage.js --files holdout_blockly.jsonl（見 DESIGN.blockly-gap.md）。"""
import random, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from bench_lib import Bench
B = Bench('holdout_blockly.jsonl', 20261107)
add = B.add
def ri(lo, hi): return lambda i: '%d\n' % random.randint(lo, hi)
def rs(alpha, lo, hi): return lambda i: ''.join(random.choice(alpha) for _ in range(random.randint(lo, hi))) + '\n'
def seq_ref(init, coef, mod=None):
    return ('def main():\n    n = int(input())\n    f = %r\n    for i in range(len(f), n + 1):\n        f.append(sum(c * f[i - 1 - j] for j, c in enumerate(%r))%s)\n    print(f[n]%s)\n' % (init, coef, (' %% %d' % mod) if mod else '', (' %% %d' % mod) if mod else ''))
def mat_ref(init, coef, mod):
    k = len(coef)
    return ('def main():\n    n = int(input())\n    M = %d\n    K = %d\n    T = [%r] + [[1 if j == i - 1 else 0 for j in range(K)] for i in range(1, K)]\n    R = [[1 if i == j else 0 for j in range(K)] for i in range(K)]\n'
            '    def mul(A, B):\n        return [[sum(A[i][t] * B[t][j] for t in range(K)) %% M for j in range(K)] for i in range(K)]\n    while n:\n        if n & 1: R = mul(R, T)\n        T = mul(T, T); n >>= 1\n    s0 = %r\n    print(sum(R[K - 1][j] * s0[j] for j in range(K)) %% M)\n' % (mod, k, coef, init[::-1]))
# ---- 遞推（換係數、換名稱、換階數）----
add('h-rec-g', 'G 遞推', 'L1', 'G(0)=1，G(1)=1，G(n)=G(n-1)+2G(n-2)。輸入 n（0≤n≤60），輸出 G(n)。', seq_ref([1, 1], [1, 2]), ri(0, 60))
add('h-stairs-23', '爬樓梯 2 或 3 階', 'L1', '每次可以爬 2 或 3 階，爬到第 n 階（1≤n≤70）有幾種方法？輸出答案。', seq_ref([1, 0, 1], [0, 1, 1]), ri(1, 70))
add('h-rec-mod3', '三階遞推取模', 'L1', 'H(0)=1，H(1)=2，H(2)=3，H(n)=H(n-1)+H(n-3)。輸入 n（0≤n≤10^18），輸出 H(n) 除以 998244353 的餘數。', mat_ref([1, 2, 3], [1, 0, 1], 998244353), lambda i: '%d\n' % random.choice([random.randint(0, 20), random.randint(10**9, 10**18)]))
add('h-rec-order4', '四階遞推', 'L1', 'Q(0)=1，Q(1)=1，Q(2)=1，Q(3)=2，Q(n)=Q(n-1)+Q(n-4)。輸入 n（0≤n≤80），輸出 Q(n)。', seq_ref([1, 1, 1, 2], [1, 0, 0, 1]), ri(0, 80))
# ---- 字串條件（換字母、換長度、換用字）----
add('h-sd-bbb', '含連續三個 b', 'L2', '輸入一個由 a、b 組成的字串（長度 1～40），若含有連續三個 b 印 YES，否則印 NO。', 'def main():\n    s = input().strip()\n    print("YES" if "bbb" in s else "NO")\n', rs('ab', 1, 40))
add('h-sd-start', '以 "ba" 開頭', 'L2', '輸入一個由 a、b 組成的字串（長度 1～40），若以 "ba" 開頭印 yes，否則印 no。', 'def main():\n    s = input().strip()\n    print("yes" if s.startswith("ba") else "no")\n', rs('ab', 1, 8))
add('h-sd-mod11', '十進位除以 11', 'L2', '輸入一個很長的非負整數（以十進位字串給，長度 1～50，無前導零），輸出它除以 11 的餘數。', 'def main():\n    s = input().strip()\n    print(int(s) % 11)\n', lambda i: str(random.randint(1, 9)) + ''.join(random.choice('0123456789') for _ in range(random.randint(0, 49))) + '\n')
add('h-sd-ones-odd', '1 出現奇數次', 'L2', '輸入一個由 0、1 組成的字串（長度 1～40），若 1 出現奇數次印 yes，否則印 no。', 'def main():\n    s = input().strip()\n    print("yes" if s.count("1") % 2 == 1 else "no")\n', rs('01', 1, 40))
add('h-sd-count-11', '"11" 次數（可重疊）', 'L2', '輸入一個由 0、1 組成的字串（長度 1～40），輸出子字串 "11" 出現的次數（可重疊）。', 'def main():\n    s = input().strip()\n    print(sum(1 for i in range(len(s) - 1) if s[i:i + 2] == "11"))\n', rs('01', 1, 40))
add('h-sd-div4', '二進位能被 5 整除', 'L2', '輸入一個由 0、1 組成的字串（長度 1～30），輸出它當成二進位數是否能被 5 整除，是印 Y，否則印 N。', 'def main():\n    s = input().strip()\n    print("Y" if int(s, 2) % 5 == 0 else "N")\n', rs('01', 1, 30))
# ---- 圖／格子 ----
def graph(n, m, w=False, directed=True):
    es = [(random.randint(1, n), random.randint(1, n)) for _ in range(m)]
    return es
def gen_graph(nlo, nhi, wt=False, q=False):
    def g(i):
        n = random.randint(nlo, nhi); m = random.randint(0, 2 * n); es = graph(n, m)
        L = ['%d %d' % (n, m)] if not q else ['%d %d %d' % (n, m, 3)]
        for a, b in es: L.append('%d %d' % (a, b) + ((' %d' % random.randint(1, 9)) if wt else ''))
        if q:
            for _ in range(3): L.append('%d %d' % (random.randint(1, n), random.randint(1, n)))
        return '\n'.join(L) + '\n'
    return g
add('h-grid-paths-mod', '格子路徑數取模', 'L3', '第一行 n m（1≤n,m≤15），接著 n 行每行 m 個字元，"." 可走、"#" 是牆。只能向右或向下走，從左上走到右下有幾種走法？輸出答案除以 1000000007 的餘數（起點或終點是牆輸出 0）。',
    'def main():\n    n, m = map(int, input().split())\n    g = [input().strip() for _ in range(n)]\n    dp = [[0] * m for _ in range(n)]\n    for i in range(n):\n        for j in range(m):\n            if g[i][j] == "#": continue\n            if i == 0 and j == 0: dp[i][j] = 1\n            else:\n                dp[i][j] = ((dp[i - 1][j] if i else 0) + (dp[i][j - 1] if j else 0)) % 1000000007\n    print(dp[n - 1][m - 1])\n',
    lambda i: (lambda n, m: '%d %d\n' % (n, m) + '\n'.join(''.join('#' if random.random() < 0.2 else '.' for _ in range(m)) for _ in range(n)) + '\n')(random.randint(1, 15), random.randint(1, 15)))
add('h-reach-from-k', '從 1 能到的點數（無向）', 'L3', '第一行 n m（無向圖，1≤n≤10），接著 m 行 a b。輸出從 1 出發能到達的點數（含 1）。',
    'def main():\n    n, m = map(int, input().split())\n    adj = [[] for _ in range(n + 1)]\n    for _ in range(m):\n        a, b = map(int, input().split())\n        adj[a].append(b); adj[b].append(a)\n    seen = {1}; st = [1]\n    while st:\n        u = st.pop()\n        for v in adj[u]:\n            if v not in seen: seen.add(v); st.append(v)\n    print(len(seen))\n', gen_graph(1, 10))
add('h-walks-small', '恰好 k 步路徑數', 'L3', '第一行 n m k（有向圖，1≤n≤6，1≤k≤12），接著 m 行 a b。輸出從 1 出發、走恰好 k 步（可重複經過點與邊）的路徑條數。',
    'def main():\n    n, m, k = map(int, input().split())\n    A = [[0] * n for _ in range(n)]\n    for _ in range(m):\n        a, b = map(int, input().split()); A[a - 1][b - 1] += 1\n    v = [1] + [0] * (n - 1)\n    for _ in range(k):\n        v = [sum(v[i] * A[i][j] for i in range(n)) for j in range(n)]\n    print(sum(v))\n',
    lambda i: (lambda n: (lambda es: '%d %d %d\n' % (n, len(es), random.randint(1, 12)) + ''.join('%d %d\n' % e for e in es))([(random.randint(1, n), random.randint(1, n)) for _ in range(random.randint(0, 2 * n))]))(random.randint(1, 6)))
add('h-coin-ways2', '湊出金額方法數', 'L3', '第一行 k 與目標 t（1≤k≤4，t≤50），第二行 k 個面額。輸出湊出 t 的組合數（面額可重複使用，順序不計）。',
    'def main():\n    k, t = map(int, input().split())\n    a = list(map(int, input().split()))\n    dp = [1] + [0] * t\n    for c in a:\n        for x in range(c, t + 1): dp[x] += dp[x - c]\n    print(dp[t])\n', lambda i: (lambda k: '%d %d\n' % (k, random.randint(1, 50)) + ' '.join(str(random.randint(1, 9)) for _ in range(k)) + '\n')(random.randint(1, 4)))
add('h-out-degree', '最大出度', 'L3', '第一行 n m，接著 m 行 a b（有向邊 a→b）。輸出所有點中最大的出度。',
    'def main():\n    n, m = map(int, input().split())\n    d = [0] * (n + 1)\n    for _ in range(m):\n        a, b = map(int, input().split()); d[a] += 1\n    print(max(d))\n', gen_graph(1, 8))
# ---- 數論／迴圈 ----
add('h-popcount-small', '二進位 0 的個數', 'L4', '輸入正整數 n（≤10^18），輸出它的二進位表示中 0 的個數（不含前導零）。', 'def main():\n    n = int(input())\n    print(bin(n)[2:].count("0"))\n', lambda i: '%d\n' % random.randint(1, 10**18))
add('h-sum-divisors', '因數和', 'L4', '輸入正整數 n（≤10^6），輸出 n 的所有正因數的和。', 'def main():\n    n = int(input())\n    print(sum(d for d in range(1, n + 1) if n % d == 0))\n', ri(1, 10**6))
add('h-digit-prod', '各位數字的積', 'L4', '輸入正整數 n（≤10^9），輸出各位數字的積。', 'def main():\n    n = int(input())\n    r = 1\n    for ch in str(n): r *= int(ch)\n    print(r)\n', ri(1, 10**9))
add('h-fact-zeros-base', 'n! 末尾 0', 'L4', '輸入 n（≤10^12），輸出 n! 末尾有幾個 0。', 'def main():\n    n = int(input())\n    c = 0\n    p = 5\n    while n // p:\n        c += n // p; p *= 5\n    print(c)\n', ri(0, 10**12))
add('h-lcm-only', '最小公倍數', 'L4', '輸入兩個正整數 x y（≤10^9），輸出 lcm(x,y)。', 'def main():\n    a, b = map(int, input().split())\n    import math\n    print(a // math.gcd(a, b) * b)\n', lambda i: '%d %d\n' % (random.randint(1, 10**9), random.randint(1, 10**9)))
add('h-prime-YN', '質數 Y/N', 'L4', '輸入正整數 n（≤10^6），是質數印 Y，否則 N。', 'def main():\n    n = int(input())\n    print("Y" if n > 1 and all(n % d for d in range(2, int(n ** 0.5) + 1)) else "N")\n', ri(1, 10**6))
# ---- 堆疊／佇列／字串 ----
add('h-cmd-queue2', '佇列指令（換字樣）', 'L5', '第一行 q，之後 q 行指令：enq x、deq、front。deq 與 front 在佇列空時輸出 none；deq 輸出被移除的值，front 輸出隊首。',
    'def main():\n    q = int(input())\n    st = []\n    for _ in range(q):\n        p = input().split()\n        if p[0] == "enq": st.append(p[1])\n        elif p[0] == "deq": print(st.pop(0) if st else "none")\n        else: print(st[0] if st else "none")\n',
    lambda i: (lambda q: '%d\n' % q + ''.join(random.choice(['enq %d' % random.randint(1, 9), 'deq', 'front']) + '\n' for _ in range(q)))(random.randint(1, 10)))
add('h-depth-brackets', '方括號深度', 'L5', '輸入只含 [ ] 且配對正確的字串（長度 2～40），輸出巢狀最大深度。', 'def main():\n    s = input().strip()\n    d = b = 0\n    for ch in s:\n        d += 1 if ch == "[" else -1\n        b = max(b, d)\n    print(b)\n',
    lambda i: (lambda: (lambda f: f(f, random.randint(1, 5)))(lambda f, k: ''.join(('[' + (f(f, k - 1) if k > 1 and random.random() < 0.6 else '') + ']') for _ in range(random.randint(1, 3)))) + '\n')())
add('h-ng-ge', '右邊第一個更大（換說法）', 'L5', '第一行 n，第二行 n 個整數。對每個位置輸出它右邊第一個比它大的數，沒有則輸出 0，以空格分隔。',
    'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    r = [0] * n; st = []\n    for i in range(n):\n        while st and a[st[-1]] < a[i]: r[st.pop()] = a[i]\n        st.append(i)\n    print(*r)\n', lambda i: (lambda n: '%d\n' % n + ' '.join(str(random.randint(1, 20)) for _ in range(n)) + '\n')(random.randint(1, 10)))
add('h-rev-sort-desc', '去重由大到小', 'L6', '第一行 n，第二行 n 個整數。去重後由大到小輸出（以空格分隔）。', 'def main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    print(*sorted(set(a), reverse=True))\n', lambda i: (lambda n: '%d\n' % n + ' '.join(str(random.randint(1, 9)) for _ in range(n)) + '\n')(random.randint(1, 10)))
add('h-topo-large', '拓撲序（字典序最大）', 'L6', '第一行 n m（有向無環圖），接著 m 行 a b 表示 a 必須在 b 之前。輸出字典序最大的拓撲序（以空格分隔）。',
    'import heapq\ndef main():\n    n, m = map(int, input().split())\n    adj = [[] for _ in range(n + 1)]; ind = [0] * (n + 1)\n    for _ in range(m):\n        a, b = map(int, input().split()); adj[a].append(b); ind[b] += 1\n    h = [-i for i in range(1, n + 1) if ind[i] == 0]; heapq.heapify(h); out = []\n    while h:\n        u = -heapq.heappop(h); out.append(u)\n        for v in adj[u]:\n            ind[v] -= 1\n            if ind[v] == 0: heapq.heappush(h, -v)\n    print(*out)\n',
    lambda i: (lambda n: (lambda es: '%d %d\n' % (n, len(es)) + ''.join('%d %d\n' % e for e in es))([(a, b) for a in range(1, n + 1) for b in range(a + 1, n + 1) if random.random() < 0.3]))(random.randint(1, 7)))
add('h-grid-bfs-dots', '網格最短路（換說法）', 'L6', '第一行 n m（≤8），接著 n 行字元 "." 或 "#"。從左上走到右下（四方向，不能穿牆）最少幾步？到不了輸出 -1。',
    'from collections import deque\ndef main():\n    n, m = map(int, input().split())\n    g = [input().strip() for _ in range(n)]\n    d = {}\n    if g[0][0] != "#":\n        d[(0, 0)] = 0\n    q = deque(d)\n    while q:\n        x, y = q.popleft()\n        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):\n            a, b = x + dx, y + dy\n            if 0 <= a < n and 0 <= b < m and g[a][b] != "#" and (a, b) not in d:\n                d[(a, b)] = d[(x, y)] + 1; q.append((a, b))\n    print(d.get((n - 1, m - 1), -1))\n',
    lambda i: (lambda n, m: '%d %d\n' % (n, m) + '\n'.join(''.join('#' if random.random() < 0.25 else '.' for _ in range(m)) for _ in range(n)) + '\n')(random.randint(1, 8), random.randint(1, 8)))
# ---- 其他字串 ----
add('h-caesar-back', '凱薩往前移', 'other', '第一行偏移量 k（0≤k≤25），第二行小寫英文字串。把每個字母往前移 k 位（a 前接 z），輸出結果。', 'def main():\n    k = int(input())\n    s = input().strip()\n    print("".join(chr((ord(c) - 97 - k) % 26 + 97) for c in s))\n', lambda i: '%d\n%s\n' % (random.randint(0, 25), ''.join(random.choice('abcdefghijklmnopqrstuvwxyz') for _ in range(random.randint(1, 20)))))
add('h-roman-rev', '整數轉羅馬數字', 'other', '輸入一個整數 n（1～3999），輸出它的羅馬數字（標準減法寫法）。', 'def main():\n    n = int(input())\n    v = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]\n    out = ""\n    for x, r in v:\n        while n >= x: out += r; n -= x\n    print(out)\n', ri(1, 3999))
add('h-vowel-count', '母音個數', 'other', '輸入一行小寫英文字串，輸出其中母音（a e i o u）的個數。', 'def main():\n    s = input().strip()\n    print(sum(1 for c in s if c in "aeiou"))\n', rs('abcdefghij', 1, 30))
add('h-seq-given-hold', '給前幾項求第 n 項', 'L1', '數列前 6 項為 1 3 4 7 11 18，之後每一項都是前面若干項的固定線性組合。輸入 n（1≤n≤50，從 1 起算），輸出第 n 項。', 'def main():\n    n = int(input())\n    f = [1, 3]\n    while len(f) < n: f.append(f[-1] + f[-2])\n    print(f[n - 1])\n', ri(1, 50))
B.write()
