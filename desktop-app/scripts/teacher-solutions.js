'use strict';
// 老師（Claude）的解答：照約定寫 `def solve(<輸入變數>):`——輸入已經由 read_input 讀好，solve 只用這些變數，不再讀 stdin。
// 變數名稱＝程式讀情境（algo_intent_core）從題目讀出來的名稱。每一份都要過判題器（含隱藏測資）才會被收成內建的課，見 scripts/teach-builtin-lessons.js。
module.exports = {
    'is-palindrome': `def solve(s):
    t = [c.lower() for c in s if c.isalnum()]
    print("YES" if t == t[::-1] else "NO")
`,
    'two-sum': `def solve(n, t, a):
    for i in range(n):
        for j in range(i + 1, n):
            if a[i] + a[j] == t:
                print(i, j)
                return
`,
    'word-frequency': `def solve(n, w):
    c = {}
    for x in w:
        c[x] = c.get(x, 0) + 1
    for k, v in sorted(c.items(), key=lambda kv: (-kv[1], kv[0])):
        print(k, v)
`,
    'lower-bound': `def solve(n, q, a, x):
    for v in x:
        lo, hi = 0, n
        while lo < hi:
            mid = (lo + hi) // 2
            if a[mid] >= v:
                hi = mid
            else:
                lo = mid + 1
        print(lo)
`,
    'range-sum': `def solve(n, q, a, rows):
    p = [0]
    for v in a:
        p.append(p[-1] + v)
    for l, r in rows:
        print(p[r] - p[l - 1])
`,
    'fibonacci': `def solve(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    print(a)
`,
    'coin-change': `def solve(n, T, a):
    INF = float("inf")
    dp = [0] + [INF] * T
    for s in range(1, T + 1):
        for c in a:
            if c <= s and dp[s - c] + 1 < dp[s]:
                dp[s] = dp[s - c] + 1
    print(dp[T] if dp[T] != INF else -1)
`,
    'lis': `def solve(n, a):
    dp = [1] * n
    for i in range(n):
        for j in range(i):
            if a[j] < a[i] and dp[j] + 1 > dp[i]:
                dp[i] = dp[j] + 1
    print(max(dp))
`,
    'valid-brackets': `def solve(s):
    st = []
    pair = {")": "(", "]": "[", "}": "{"}
    for c in s:
        if c in "([{":
            st.append(c)
        elif not st or st.pop() != pair[c]:
            print("NO")
            return
    print("YES" if not st else "NO")
`,
    'gcd-lcm': `def gcd(x, y):
    while y:
        x, y = y, x % y
    return x

def solve(a, b):
    g = gcd(a, b)
    print(g, a // g * b)
`,
    'count-primes': `def solve(n):
    if n < 2:
        print(0)
        return
    s = [True] * (n + 1)
    s[0] = s[1] = False
    i = 2
    while i * i <= n:
        if s[i]:
            for j in range(i * i, n + 1, i):
                s[j] = False
        i += 1
    print(sum(s))
`,
    'grid-bfs': `from collections import deque

def solve(r, c, g):
    for i in range(r):
        for j in range(c):
            if g[i][j] == "S":
                s = (i, j)
            if g[i][j] == "T":
                t = (i, j)
    dist = {s: 0}
    q = deque([s])
    while q:
        x, y = q.popleft()
        if (x, y) == t:
            print(dist[t])
            return
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < r and 0 <= ny < c and g[nx][ny] != "#" and (nx, ny) not in dist:
                dist[(nx, ny)] = dist[(x, y)] + 1
                q.append((nx, ny))
    print(-1)
`,
    'components': `def solve(n, m, rows):
    adj = [[] for _ in range(n + 1)]
    for u, v in rows:
        adj[u].append(v)
        adj[v].append(u)
    seen = [False] * (n + 1)
    cnt = 0
    for s in range(1, n + 1):
        if seen[s]:
            continue
        cnt += 1
        seen[s] = True
        st = [s]
        while st:
            x = st.pop()
            for y in adj[x]:
                if not seen[y]:
                    seen[y] = True
                    st.append(y)
    print(cnt)
`,
    'merge-intervals': `def solve(n, rows):
    out = []
    for l, r in sorted(rows):
        if out and l <= out[-1][1]:
            out[-1][1] = max(out[-1][1], r)
        else:
            out.append([l, r])
    for l, r in out:
        print(l, r)
`,
    'kth-largest': `def solve(n, k, a):
    b = sorted(a, reverse=True)
    print(b[k - 1])
`,
    'anagram': `def solve(s, t):
    print("YES" if sorted(s) == sorted(t) else "NO")
`,
    'knapsack': `def solve(n, W, rows):
    dp = [0] * (W + 1)
    for w, v in rows:
        for c in range(W, w - 1, -1):
            if dp[c - w] + v > dp[c]:
                dp[c] = dp[c - w] + v
    print(dp[W])
`,
};
