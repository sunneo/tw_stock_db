/* Python：範式骨架庫。純函式 UMD，Python 專屬（每個語言各自一份，不共用）。
 * 一個範式骨架 = 一個「帶槽位的區塊骨架」：骨架固定（這種算法該有的迴圈／資料結構／輸出），槽位是 1～3 個小選單
 *（初值、比較方向、邊界、索引起點…）。選單很小，所以由程式窮舉組合（上限 limit，預設 12）交沙盒判題，第一個 AC 就用——
 * 不靠 0.6B 那種接近隨機的選擇。pick（模型）只決定窮舉順序（可省略）。
 * 新題只要套到某個範式、填幾個槽位，不必每題各教一堂課；課是範式的實例（deriveLesson 可記 paradigm＋slots）。
 *
 *   PARADIGMS                      骨架表：{id, paradigm, algo, label, slots:[{id,label,options:[{id,label,v}]}], py(c, N)}
 *   forIntent(intent, statement?) → 骨架[]   這題的算法有哪些骨架（用 intent.algo 查；有 when 的骨架再用敘述篩，例如費氏「取餘數」才用矩陣快速冪）
 *   combos(skeleton, {limit, rank}) → [choice]   窮舉組合（choice = {槽位id: 選項id}）；rank(skeleton, choice) 給分數，高的先試
 *   render(skeleton, choice, intent) → CNL   solve 的受控自然語言（用「程式區塊：」包 Python；之後走 parseCNL → 區塊 → IR）
 *   solve({intent, skeleton?, judge, parse, limit, rank}) → Promise<{ok, skeleton, choice, cnl, tried, verdict, trace}>
 *        judge(cnl) → Promise<{verdict, detail}>（呼叫端把 CNL 組成完整程式交沙盒）；第一個 AC 就停
 * N = 題目讀出來的變數：N.sc（整數變數依序）、N.ls（清單變數依序）、N.s（字串變數依序）、N.g（網格）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPyParadigms = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const O = (id, v, label) => ({ id, v, label: label || String(v) });
    const S = (id, label, opts) => ({ id, label, options: opts.map((x) => (Array.isArray(x) ? O(x[0], x[1], x[2]) : O(x, x))) });
    const KEEP = new Set(['range', 'min', 'max', 'sum', 'len', 'sorted', 'print', 'set', 'list', 'int', 'float', 'abs', 'enumerate', 'zip', 'map', 'str', 'dict', 'tuple', 'any', 'all', 'lambda', 'for', 'in', 'if', 'else', 'elif', 'while', 'return', 'break', 'continue', 'def', 'not', 'and', 'or', 'is', 'True', 'False', 'None', 'import', 'from', 'pass', 'deque']);
    const code = (lines) => lines.join('\n');
    // 每個骨架的 py(c, N)：c = 選項值（槽位 id → v）；N = 題目的變數。回傳 solve 的 Python 本文（多行）
    const PARADIGMS = [
        { id: 'dp.fib', paradigm: 'dynamic-programming', algo: 'fib', when: /^(?![\s\S]*(餘數|取模|mod))/i, label: '一維 DP：費氏數（滾動兩個值）', slots: [S('init', '起始兩個值', [['01', '0, 1'], ['11', '1, 1']]), S('loops', '迴圈次數', [['n', '{n}'], ['n-1', '{n} - 1'], ['n+1', '{n} + 1']]), S('out', '輸出哪一個', [['a', 'a'], ['b', 'b']])],
            py: (c, N) => code(['a, b = ' + c.init, 'for _ in range(' + c.loops.replace('{n}', N.sc[0]) + '):', '    a, b = b, a + b', 'print(' + c.out + ')']) },
        { id: 'dp.coin-min', paradigm: 'dynamic-programming', algo: 'coin-min', label: '一維 DP：硬幣最少（dp[金額]）', slots: [S('order', '迴圈順序', ['amount', 'coin']), S('inf', '「湊不出」的值', [['T+1', '{T} + 1'], ['inf', 'float("inf")']]), S('step', '轉移加幾', [['1', '1'], ['0', '0']])],
            py: (c, N) => { const T = N.sc[1], a = N.ls[0]; const tr = c.order === 'amount' ? ['for x in range(1, ' + T + ' + 1):', '    for c in ' + a + ':', '        if c <= x:', '            dp[x] = min(dp[x], dp[x - c] + ' + c.step + ')'] : ['for c in ' + a + ':', '    for x in range(c, ' + T + ' + 1):', '        dp[x] = min(dp[x], dp[x - c] + ' + c.step + ')']; return code(['INF = ' + c.inf.replace('{T}', T), 'dp = [INF] * (' + T + ' + 1)', 'dp[0] = 0'].concat(tr, ['print(dp[' + T + '] if dp[' + T + '] < INF else -1)'])); } },
        { id: 'dp.lis', paradigm: 'dynamic-programming', algo: 'lis', label: '一維 DP：最長遞增子序列（dp[i] = 以 i 結尾）', slots: [S('cmp', '前一個與目前的比較', [['<', '<'], ['<=', '<=']]), S('init', 'dp 初值', [['1', '1'], ['0', '0']])],
            py: (c, N) => { const n = N.sc[0], a = N.ls[0]; return code(['dp = [' + c.init + '] * ' + n, 'for i in range(' + n + '):', '    for j in range(i):', '        if ' + a + '[j] ' + c.cmp + ' ' + a + '[i]:', '            dp[i] = max(dp[i], dp[j] + 1)', 'print(max(dp))']); } },
        { id: 'dp.knapsack', paradigm: 'dynamic-programming', algo: 'knapsack', label: '一維 DP：0/1 背包（容量由大到小）', slots: [S('dir', '容量走向', [['down', 'down'], ['up', 'up']]), S('ans', '答案', [['dp[W]', 'W'], ['max', 'max']])],
            py: (c, N) => { const W = N.sc[1], rows = N.ls[0]; const rg = c.dir === 'down' ? 'range(' + W + ', w - 1, -1)' : 'range(w, ' + W + ' + 1)'; return code(['dp = [0] * (' + W + ' + 1)', 'for w, v in ' + rows + ':', '    for j in ' + rg + ':', '        dp[j] = max(dp[j], dp[j - w] + v)', 'print(' + (c.ans === 'W' ? 'dp[' + W + ']' : 'max(dp)') + ')']); } },
        { id: 'bfs.grid', paradigm: 'bfs', algo: 'grid-bfs', label: 'BFS：網格最短步數', slots: [S('dirs', '可走的方向', [['4', '(1, 0), (-1, 0), (0, 1), (0, -1)'], ['8', '(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)'], ['rd', '(1, 0), (0, 1)']]), S('pass', '哪些格子能走', [['not-wall', "!= '#'"], ['dot', "== '.'"]])],
            py: (c, N) => { const r = N.sc[0], cc = N.sc[1], g = N.g; return code(['from collections import deque', 'for i in range(' + r + '):', '    for j in range(' + cc + '):', "        if " + g + "[i][j] == 'S':", '            si, sj = i, j', "        if " + g + "[i][j] == 'T':", '            ti, tj = i, j', 'dist = [[-1] * ' + cc + ' for _ in range(' + r + ')]', 'dist[si][sj] = 0', 'q = deque([(si, sj)])', 'while q:', '    x, y = q.popleft()', '    for dx, dy in [' + c.dirs + ']:', '        nx, ny = x + dx, y + dy', '        if 0 <= nx < ' + r + ' and 0 <= ny < ' + cc + ' and ' + g + '[nx][ny] ' + c.pass + ' and dist[nx][ny] == -1:', '            dist[nx][ny] = dist[x][y] + 1', '            q.append((nx, ny))', 'print(dist[ti][tj])']); } },
        { id: 'dfs.components', paradigm: 'dfs', algo: 'components', label: 'DFS／並查集：連通分量個數', slots: [S('method', '做法', ['dfs', 'union-find']), S('base', '節點編號從幾開始', [['1', '1'], ['0', '0']])],
            py: (c, N) => { const n = N.sc[0], rows = N.ls[0]; if (c.method === 'dfs') return code(['adj = [[] for _ in range(' + n + ' + 1)]', 'for u, v in ' + rows + ':', '    adj[u].append(v)', '    adj[v].append(u)', 'seen = [False] * (' + n + ' + 1)', 'cnt = 0', 'for s in range(' + c.base + ', ' + n + ' + ' + (c.base === '1' ? '1' : '0') + '):', '    if not seen[s]:', '        cnt += 1', '        seen[s] = True', '        st = [s]', '        while st:', '            u = st.pop()', '            for w in adj[u]:', '                if not seen[w]:', '                    seen[w] = True', '                    st.append(w)', 'print(cnt)']);
                return code(['p = list(range(' + n + ' + 1))', 'def find(x):', '    while p[x] != x:', '        p[x] = p[p[x]]', '        x = p[x]', '    return x', 'for u, v in ' + rows + ':', '    a1, b1 = find(u), find(v)', '    if a1 != b1:', '        p[a1] = b1', 'print(sum(1 for x in range(' + c.base + ', ' + n + ' + ' + (c.base === '1' ? '1' : '0') + ') if find(x) == x))']); } },
        { id: 'dc.inversions', paradigm: 'divide-and-conquer', algo: 'inversions', label: '分治：由下而上歸併排序數逆序對（不用巢狀函式，區塊寫得出）', slots: [S('cmp', '左右相等時先取誰', [['<=', '<='], ['<', '<']]), S('add', '取右邊時加多少', [['rest', 'len(l) - i'], ['one', '1']])],
            py: (c, N) => code(['b = list(' + N.ls[0] + ')', 'w = 1', 'cnt = 0', 'while w < len(b):', '    for lo in range(0, len(b), 2 * w):', '        mid = min(lo + w, len(b))', '        hi = min(lo + 2 * w, len(b))', '        l = b[lo:mid]', '        r = b[mid:hi]', '        res = []', '        i = 0', '        j = 0', '        while i < len(l) and j < len(r):', '            if l[i] ' + c.cmp + ' r[j]:', '                res.append(l[i])', '                i += 1', '            else:', '                res.append(r[j])', '                j += 1', '                cnt += ' + c.add, '        res += l[i:]', '        res += r[j:]', '        b[lo:hi] = res', '    w *= 2', 'print(cnt)']) },
        { id: 'tree.traversal', paradigm: 'tree-traversal', algo: 'tree-traversal', label: '樹走訪：前序／中序／後序（用明確的堆疊模擬遞迴）', slots: [S('visit', '什麼時候記下節點', ['pre', 'in', 'post']), S('kids', '先走哪個子樹', [['lr', 'l, r'], ['rl', 'r, l']])],
            py: (c, N) => { const rows = N.ls[0]; const [k1, k2] = c.kids.split(', '); const seq = c.visit === 'pre' ? ['v', k1, k2] : c.visit === 'in' ? [k1, 'v', k2] : [k1, k2, 'v']; const push = seq.slice().reverse().map((x) => '    st.append(' + (x === 'v' ? '(u, 1)' : '(' + x + ', 0)') + ')'); return code(['out = []', 'st = [(1, 0)]', 'while st:', '    u, vis = st.pop()', '    if vis:', '        out.append(u)', '    elif u != 0:', '        l, r = ' + rows + '[u - 1]'].concat(push.map((x) => '    ' + x), ['print(*out)'])); } },
        { id: 'heap.kth-smallest', paradigm: 'heap', algo: 'kth-smallest', label: '堆積：第 k 小', slots: [S('method', '做法', ['pop', 'nsmallest']), S('off', 'k 的位移', [['0', '0'], ['-1', '-1']])],
            py: (c, N) => { const k = N.sc[1], a = N.ls[0]; if (c.method === 'pop') return code(['import heapq', 'h = list(' + a + ')', 'heapq.heapify(h)', 'for _ in range(' + k + ' + (' + c.off + ')):', '    x = heapq.heappop(h)', 'print(x)']); return code(['import heapq', 'print(heapq.nsmallest(' + k + ' + (' + c.off + '), ' + a + ')[-1])']); } },
        { id: 'dp.lps', paradigm: 'dynamic-programming', algo: 'lps', label: '區間 DP：最長回文子序列', slots: [S('base', 'dp[i][i]', [['1', '1'], ['0', '0']]), S('add', '兩端相同時加多少', [['2', '2'], ['1', '1']])],
            py: (c, N) => { const s = N.s[0]; return code(['n_ = len(' + s + ')', 'dp = [[0] * n_ for _ in range(n_)]', 'for i in range(n_ - 1, -1, -1):', '    dp[i][i] = ' + c.base, '    for j in range(i + 1, n_):', '        if ' + s + '[i] == ' + s + '[j]:', '            dp[i][j] = dp[i + 1][j - 1] + ' + c.add, '        else:', '            dp[i][j] = max(dp[i + 1][j], dp[i][j - 1])', 'print(dp[0][n_ - 1])']); } },
        { id: 'dp.lcs', paradigm: 'dynamic-programming', algo: 'lcs', label: '二維 DP：最長公共子序列', slots: [S('add', '字元相同時加多少', [['1', '1'], ['2', '2']]), S('miss', '字元不同時', [['max', 'max(dp[i - 1][j], dp[i][j - 1])'], ['up', 'dp[i - 1][j]']])],
            py: (c, N) => { const s = N.s[0], t = N.s[1]; return code(['n_ = len(' + s + ')', 'm_ = len(' + t + ')', 'dp = [[0] * (m_ + 1) for _ in range(n_ + 1)]', 'for i in range(1, n_ + 1):', '    for j in range(1, m_ + 1):', '        if ' + s + '[i - 1] == ' + t + '[j - 1]:', '            dp[i][j] = dp[i - 1][j - 1] + ' + c.add, '        else:', '            dp[i][j] = ' + c.miss, 'print(dp[n_][m_])']); } },
        { id: 'matrix.fib-mod', paradigm: 'matrix-power', algo: 'fib', when: /餘數|取模|mod/i, label: '矩陣快速冪：費氏數（n 很大、取餘數；2x2 矩陣用四個變數）', slots: [S('mod', '模數', [['1e9+7', '1000000007'], ['998244353', '998244353']]), S('el', '答案取哪一格', [['rb', 'rb'], ['ra', 'ra']])],
            py: (c, N) => code(['M = ' + c.mod, 'ra, rb, rc, rd = 1, 0, 0, 1', 'ma, mb, mc, md = 1, 1, 1, 0', 'k = ' + N.sc[0], 'while k:', '    if k & 1:', '        ra, rb, rc, rd = (ra * ma + rb * mc) % M, (ra * mb + rb * md) % M, (rc * ma + rd * mc) % M, (rc * mb + rd * md) % M', '    ma, mb, mc, md = (ma * ma + mb * mc) % M, (ma * mb + mb * md) % M, (mc * ma + md * mc) % M, (mc * mb + md * md) % M', '    k >>= 1', 'print(' + c.el + ' % M)']) },
        { id: 'bs.lower-bound', paradigm: 'binary-search', algo: 'lower-bound', label: '二分：第一個滿足條件的位置', slots: [S('cmp', '往左收的條件', [['>=', '>='], ['>', '>']]), S('hi', 'hi 的初值', [['n', 'n'], ['n-1', 'n - 1']])],
            py: (c, N) => { const n = N.sc[0], a = N.ls[0], xs = N.ls[1]; return code(['for xq in ' + xs + ':', '    lo, hi = 0, ' + (c.hi === 'n' ? n : n + ' - 1'), '    while lo < hi:', '        mid = (lo + hi) // 2', '        if ' + a + '[mid] ' + c.cmp + ' xq:', '            hi = mid', '        else:', '            lo = mid + 1', '    print(lo)']); } },
        { id: 'prefix.range-sum', paradigm: 'prefix-sum', algo: 'range-sum', label: '前綴和：區間和', slots: [S('lo', '左端用哪個索引', [['l-1', 'l - 1'], ['l', 'l']]), S('hi', '右端用哪個索引', [['r', 'r'], ['r+1', 'r + 1']])],
            py: (c, N) => { const a = N.ls[0], rows = N.ls[1]; return code(['p = [0]', 'for v in ' + a + ':', '    p.append(p[-1] + v)', 'for l, r in ' + rows + ':', '    print(p[' + c.hi + '] - p[' + c.lo + '])']); } },
        { id: 'hash.word-count', paradigm: 'data-structure-mapping', algo: 'word-count', label: '雜湊計數：字典＋排序輸出', slots: [S('key', '排序依據', [['cnt-desc-word', '-kv[1], kv[0]'], ['cnt-asc-word', 'kv[1], kv[0]'], ['word', 'kv[0]']])],
            py: (c, N) => { const w = N.ls[0]; return code(['cnt = {}', 'for tok in ' + w + ':', '    cnt[tok] = cnt.get(tok, 0) + 1', 'for k, v in sorted(cnt.items(), key=lambda kv: (' + c.key + ')):', '    print(k, v)']); } },
        { id: 'stack.brackets', paradigm: 'data-structure-mapping', algo: 'brackets', label: '堆疊：括號配對', slots: [S('match', '遇到右括號時', [['top-match', 'st and st[-1] == pair[ch]'], ['any', 'st']]), S('fin', '最後要求', [['empty', 'not st'], ['true', 'True']])],
            py: (c, N) => { const s = N.s[0]; return code(['st = []', "pair = {')': '(', ']': '[', '}': '{'}", 'ok = True', 'for ch in ' + s + ':', "    if ch in '([{':", '        st.append(ch)', '    elif ' + c.match + ':', '        st.pop()', '    else:', '        ok = False', '        break', 'print("YES" if ok and ' + c.fin + ' else "NO")']); } },
        { id: 'sweep.merge-intervals', paradigm: 'sort-and-sweep', algo: 'intervals-merge', label: '排序後掃描：合併區間', slots: [S('touch', '端點相接算重疊嗎', [['<=', '<='], ['<', '<']]), S('sort', '先怎麼排', [['asc', 'sorted({R})'], ['desc', 'sorted({R}, key=lambda t: -t[0])']])],
            py: (c, N) => { const rows = N.ls[0]; return code(['res = []', 'for l, r in ' + c.sort.replace(/\{R\}/g, rows) + ':', '    if res and l ' + c.touch + ' res[-1][1]:', '        res[-1][1] = max(res[-1][1], r)', '    else:', '        res.append([l, r])', 'for l, r in res:', '    print(l, r)']); } },
        { id: 'brute.pair-sum', paradigm: 'brute-force', algo: 'pair-sum', label: '暴力雙迴圈：找兩數之和', slots: [S('start', 'j 從哪裡開始', [['i+1', 'i + 1'], ['i', 'i']])],
            py: (c, N) => { const n = N.sc[0], t = N.sc[1], a = N.ls[0]; return code(['for i in range(' + n + '):', '    for j in range(' + c.start + ', ' + n + '):', '        if ' + a + '[i] + ' + a + '[j] == ' + t + ':', '            print(i, j)', '            return']); } },
        { id: 'sort.kth-largest', paradigm: 'sort', algo: 'kth-largest', label: '排序後取第 k 個', slots: [S('dedupe', '重複的數怎麼算', [['keep', '{A}'], ['set', 'set({A})']]), S('dir', '排序方向', [['desc', 'True'], ['asc', 'False']]), S('idx', '第 k 個的索引', [['k-1', '{k} - 1'], ['k', '{k}']])],
            py: (c, N) => { const k = N.sc[1], a = N.ls[0]; return code(['b = sorted(' + c.dedupe.replace('{A}', a) + ', reverse=' + c.dir + ')', 'print(b[' + c.idx.replace('{k}', k) + '])']); } },
        { id: 'sieve.primes', paradigm: 'sieve', algo: 'primes', label: '篩法：質數個數', slots: [S('lim', '外層迴圈到哪', [['sqrt+1', 'int({n} ** 0.5) + 1'], ['sqrt', 'int({n} ** 0.5)'], ['n+1', '{n} + 1']]), S('start', '劃掉從哪開始', [['i*i', 'i * i'], ['2i', '2 * i']])],
            py: (c, N) => { const n = N.sc[0]; return code(['p = [True] * (' + n + ' + 1)', 'p[0] = p[1] = False', 'for i in range(2, ' + c.lim.replace(/\{n\}/g, n) + '):', '    if p[i]:', '        for j in range(' + c.start + ', ' + n + ' + 1, i):', '            p[j] = False', 'print(sum(p))']); } },
        { id: 'nt.gcd-lcm', paradigm: 'number-theory', algo: 'gcd-lcm', label: '數論：輾轉相除求 gcd、由 gcd 求 lcm', slots: [S('lcm', 'lcm 公式', [['a//g*b', '{a} // g * {b}'], ['a*b//g', '{a} * {b} // g'], ['a*b', '{a} * {b}']]), S('order', '輸出順序', [['gl', 'g, l'], ['lg', 'l, g']])],
            py: (c, N) => { const a = N.sc[0], b = N.sc[1]; return code(['x, y = ' + a + ', ' + b, 'while y:', '    x, y = y, x % y', 'g = x', 'l = ' + c.lcm.replace(/\{a\}/g, a).replace(/\{b\}/g, b), 'print(' + c.order + ')']); } },
        { id: 'tp.palindrome', paradigm: 'two-pointers', algo: 'palindrome', label: '雙指標／反轉比較：迴文', slots: [S('filt', '保留哪些字元', [['isalnum', 'isalnum()'], ['isalpha', 'isalpha()']]), S('case', '大小寫', [['lower', 'c.lower()'], ['same', 'c']])],
            py: (c, N) => { const s = N.s[0]; return code(['t = [' + c.case + ' for c in ' + s + ' if c.' + c.filt + ']', 'print("YES" if t == t[::-1] else "NO")']); } },
        { id: 'hash.anagram', paradigm: 'data-structure-mapping', algo: 'anagram', label: '雜湊／排序：變位詞', slots: [S('eq', '比什麼', [['sorted', 'sorted({s}) == sorted({t})'], ['set', 'set({s}) == set({t})'], ['len', 'len({s}) == len({t})']])],
            py: (c, N) => { const s = N.s[0], t = N.s[1]; return 'print("YES" if ' + c.eq.replace(/\{s\}/g, s).replace(/\{t\}/g, t) + ' else "NO")'; } },
        { id: 'bt.n-queens', paradigm: 'backtracking', algo: 'n-queens', label: '回溯：N 皇后方案數（用 p[row] 與 row 指標模擬遞迴）', slots: [S('diag', '斜線衝突', [['both', 'abs(p[i] - p[row]) == row - i'], ['one', 'p[i] - p[row] == row - i']]), S('last', '放完最後一列的判斷', [['n-1', 'row == {n} - 1'], ['n', 'row == {n}']])],
            py: (c, N) => { const n = N.sc[0]; return code(['p = [-1] * ' + n, 'row = 0', 'cnt = 0', 'while row >= 0:', '    p[row] = p[row] + 1', '    if p[row] >= ' + n + ':', '        p[row] = -1', '        row -= 1', '    else:', '        ok = True', '        for i in range(row):', '            if p[i] == p[row] or ' + c.diag + ':', '                ok = False', '        if ok:', '            if ' + c.last.replace('{n}', n) + ':', '                cnt += 1', '            else:', '                row += 1', 'print(cnt)']); } },
        { id: 'sp.dijkstra', paradigm: 'shortest-path', algo: 'dijkstra', label: '圖最短路：Dijkstra（堆積）', slots: [S('dir', '邊的方向', [['undirected', 'undirected'], ['directed', 'directed']]), S('un', '不可達輸出', [['-1', '-1'], ['INF', 'INF']]), S('base', '輸出節點範圍', [['1', '1'], ['0', '0']])],
            py: (c, N) => { const n = N.sc[0], s = N.sc[2], rows = N.ls[0]; return code(['import heapq', 'adj = [[] for _ in range(' + n + ' + 1)]', 'for u, v, w in ' + rows + ':', '    adj[u].append((v, w))'].concat(c.dir === 'undirected' ? ['    adj[v].append((u, w))'] : [], ['INF = 10 ** 18', 'dist = [INF] * (' + n + ' + 1)', 'dist[' + s + '] = 0', 'h = [(0, ' + s + ')]', 'while h:', '    d, u = heapq.heappop(h)', '    if d > dist[u]:', '        continue', '    for v, w in adj[u]:', '        if d + w < dist[v]:', '            dist[v] = d + w', '            heapq.heappush(h, (d + w, v))', 'out = []', 'for i in range(' + c.base + ', ' + n + ' + 1):', '    if dist[i] < INF:', '        out.append(dist[i])', '    else:', '        out.append(' + c.un + ')', 'print(*out)'])); } },
        { id: 'fenwick.point-range', paradigm: 'fenwick-tree', algo: 'fenwick', label: '樹狀陣列：單點加、區間和', slots: [S('lo', '區間左端扣掉', [['x-1', 'x - 1'], ['x', 'x']]), S('hi', '區間右端', [['y', 'y'], ['y+1', 'y + 1']])],
            py: (c, N) => { const n = N.sc[0], a = N.ls[0], rows = N.ls[1]; return code(['bit = [0] * (' + n + ' + 1)', 'for i in range(' + n + '):', '    j = i + 1', '    while j <= ' + n + ':', '        bit[j] = bit[j] + ' + a + '[i]', '        j = j + (j & -j)', 'for tp, x, y in ' + rows + ':', '    if tp == 1:', '        j = x', '        while j <= ' + n + ':', '            bit[j] = bit[j] + y', '            j = j + (j & -j)', '    else:', '        hi_s = 0', '        j = ' + c.hi, '        while j > 0:', '            hi_s = hi_s + bit[j]', '            j = j - (j & -j)', '        lo_s = 0', '        j = ' + c.lo, '        while j > 0:', '            lo_s = lo_s + bit[j]', '            j = j - (j & -j)', '        print(hi_s - lo_s)']); } },
        { id: 'str.kmp-count', paradigm: 'kmp', algo: 'str-match', label: '字串匹配：KMP 數出現次數', slots: [S('ov', '配到一次後 j 回到', [['f[j-1]', 'f[j - 1]'], ['0', '0']]), S('fb', '失配時退幾次', [['while', 'while'], ['if', 'if']])],
            py: (c, N) => { const s = N.s[0], t = N.s[1]; return code(['f = [0] * len(' + t + ')', 'k = 0', 'for i in range(1, len(' + t + ')):', '    ' + c.fb + ' k > 0 and ' + t + '[i] != ' + t + '[k]:', '        k = f[k - 1]', '    if ' + t + '[i] == ' + t + '[k]:', '        k = k + 1', '    f[i] = k', 'cnt = 0', 'j = 0', 'for i in range(len(' + s + ')):', '    ' + c.fb + ' j > 0 and ' + s + '[i] != ' + t + '[j]:', '        j = f[j - 1]', '    if ' + s + '[i] == ' + t + '[j]:', '        j = j + 1', '    if j == len(' + t + '):', '        cnt = cnt + 1', '        j = ' + c.ov.replace('j-1', 'j - 1'), 'print(cnt)']); } },
    ];
    const byId = {}; PARADIGMS.forEach((p) => { byId[p.id] = p; });
    // 領域包註冊：把領域的骨架加進骨架表（id 不可重複）
    function addSkeletons(list, domain) { let n = 0; for (const sk of list || []) { if (byId[sk.id]) continue; if (domain) sk.domain = domain; PARADIGMS.push(sk); byId[sk.id] = sk; n++; } return n; }
    const forIntent = (intent, statement) => (intent && intent.algo ? PARADIGMS.filter((p) => p.algo === intent.algo && (!p.when || statement == null || p.when.test(String(statement)))) : []);
    const namesOf = (intent) => {
        const N = { sc: [], ls: [], s: [], g: null }; for (const v of intent.vars) { if (v.type === 'list') N.ls.push(v.name); else if (v.type === 'str') N.s.push(v.name); else N.sc.push(v.name); }
        const grid = intent.inputs.find((i) => i.k === 'grid'); if (grid) { N.g = grid.name; N.ls = N.ls.filter((x) => x !== grid.name); }
        return N;
    };
    // 窮舉組合（各槽位選項的笛卡兒積）；rank 越高越先試；超過 limit 只留前 limit 個
    function combos(sk, o) {
        o = o || {}; const limit = o.limit || 12; let out = [{}];
        for (const sl of sk.slots) { const nx = []; for (const c of out) for (const op of sl.options) nx.push(Object.assign({}, c, { [sl.id]: op.id })); out = nx; }
        if (o.rank) out = out.map((c, i) => ({ c, i, r: o.rank(sk, c) || 0 })).sort((a, b) => b.r - a.r || a.i - b.i).map((x) => x.c);
        return out.slice(0, limit);
    }
    // 題目的變數名稱先用 \u0001名稱\u0002 包起來；骨架裡的局部變數若撞到某個題目變數的名稱，就改成 名稱_2，最後拿掉標記
    const MARK = /\u0001([^\u0002]*)\u0002/g;
    function render(sk, choice, intent) {
        const N0 = namesOf(intent); const params = intent.vars.map((v) => v.name); const w = (x) => '\u0001' + x + '\u0002';
        const N = { sc: N0.sc.map(w), ls: N0.ls.map(w), s: N0.s.map(w), g: N0.g && w(N0.g) }; const vals = {};
        for (const sl of sk.slots) { const op = sl.options.find((x) => x.id === choice[sl.id]); if (!op) throw new Error('槽位 ' + sl.id + ' 沒有選項 ' + choice[sl.id]); vals[sl.id] = op.v; }
        const P = new Set(params); let py = sk.py(vals, N);
        py = py.replace(/\u0001[^\u0002]*\u0002|'[^']*'|"[^"]*"|\b[A-Za-z_]\w*\b/g, (t) => (P.has(t) && !KEEP.has(t) ? t + '_2' : t)).replace(MARK, '$1');
        return '程式區塊：\n' + py.split('\n').map((l) => '  ' + l).join('\n');
    }
    async function solve(o) {
        const intent = o.intent; const sks = o.skeleton ? [o.skeleton] : forIntent(intent, o.statement); const trace = []; let tried = 0;
        if (!sks.length) return { ok: false, reason: '這題的算法（' + (intent && intent.algo) + '）沒有範式骨架', tried, trace };
        for (const sk of sks) {
            for (const choice of combos(sk, { limit: o.limit, rank: o.rank })) {
                let cnl; try { cnl = render(sk, choice, intent); } catch (e) { trace.push({ skeleton: sk.id, choice, verdict: 'RENDER_ERROR', detail: String(e.message || e) }); continue; }
                tried++; let v; try { v = await o.judge(cnl); } catch (e) { v = { verdict: 'JUDGE_ERROR', detail: String(e.message || e) }; }
                trace.push({ skeleton: sk.id, choice, verdict: v.verdict, detail: v.detail });
                if (v.verdict === 'AC' || v.verdict === 'UNCHECKED') return { ok: true, skeleton: sk.id, paradigm: sk.paradigm, choice, cnl, tried, verdict: v.verdict, trace };
            }
        }
        return { ok: false, reason: '範式骨架的所有槽位組合（' + tried + ' 個）都沒通過沙盒', tried, trace };
    }
    return { PARADIGMS, byId, forIntent, combos, render, solve, namesOf, addSkeletons, dsl: { S, O, code } };
});
