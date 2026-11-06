/* 領域包：進階圖與樹（純函式，Python 專屬）。格式見 domain_registry_core.js。
 * 範式：最小生成樹（Kruskal）、強連通分量（Kosaraju，迭代）、Bellman-Ford（負權、負環）、樹的直徑、最近共同祖先（LCA）、二分圖判定、最大流（Edmonds-Karp）。
 * 輸入形狀：「第一行 n m（或 n q），接著 m（或 n-1）行每行 u v [w]」＝邊表（讀取器的 rows，數量可寫 n-1）；樹的查詢段是第二個 rows。
 * 差異點（有向／無向、節點編號從 0 或 1、輸出形式、不可達或不連通怎麼印）是槽位，由沙盒窮舉；標籤只在敘述裡有唯一的全大寫輸出詞時才用，抽不到就拒絕渲染。骨架不含 def。
 * train／holdout 見 domain_graph2.test.js。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainGraph2 = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, paradigm, label, slots, py, extra) => Object.assign({ id, algo, paradigm, label, slots, py }, extra || {});
        const q = (x) => JSON.stringify(x);
        const ynOf = (I) => { if (I.facts && I.facts.yn) return I.facts.yn; const m = /輸出\s*([^\s，,。；]+?)\s*[，,]\s*(?:否則|不然|其餘)\s*(?:輸出|印)?\s*([^\s，,。；]+)/.exec(String(I.statement)); if (m) return [m[1], m[2]]; const m2 = /輸出\s*([A-Za-z_]+|[^\s，,。；：:]{1,8})\s*[，,；;]\s*[^，,。；]{0,8}?輸出\s*([A-Za-z_]+|[^\s，,。；：:]{1,8})/.exec(String(I.statement)); return m2 ? [m2[1], m2[2]] : ['YES', 'NO']; };
        // 敘述裡唯一的全大寫輸出詞（不連通、有負環時要印的標籤）；抽不到回 null，骨架選到 label 就拒絕渲染，不猜
        const capsLabel = (I) => { const caps = [...new Set([...String(I.statement).matchAll(/(?:輸出|印出)\s*([A-Z][A-Z_]{2,})/g)].map((x) => x[1]))]; return caps.length === 1 ? caps[0] : null; };
        const need = (v, what) => { if (!v) throw new Error('抽不到' + what); return v; };
        const BASE = S('base', '節點編號從幾開始', [['1', '1'], ['0', '0']]);
        const skeletons = [
            D('graph2.mst', 'mst', 'greedy', '最小生成樹（Kruskal＋並查集）：邊依權重排序，連得起來就收；輸出總權重、最大邊權或用掉的邊數；不連通（邊數不夠 n-1）時印 -1 或敘述裡的標籤',
                [S('out', '輸出', [['weight', 'total'], ['maxe', 'mx'], ['count', 'used']]), S('bad', '不連通時', [['-1', '-1'], ['label', 'label'], ['none', 'none']])],
                (c, N, I) => { const n = need(N.sc[0], '節點數 n'), rows = need(N.ls[0], '邊表'); const lab = capsLabel(I); if (c.bad === 'label' && !lab) throw new Error('抽不到不連通的標籤');
                    const bad = c.bad === 'none' ? [] : ['if used != ' + n + ' - 1:', '    print(' + (c.bad === 'label' ? q(lab) : '-1') + ')', 'else:', '    print(' + c.out + ')'];
                    return code(['par = list(range(' + n + ' + 2))', 'total = 0', 'used = 0', 'mx = 0', 'for e in sorted(' + rows + ', key=lambda e: e[2]):', '    a = e[0]', '    while par[a] != a:', '        par[a] = par[par[a]]', '        a = par[a]', '    b = e[1]', '    while par[b] != b:', '        par[b] = par[par[b]]', '        b = par[b]', '    if a != b:', '        par[a] = b', '        total += e[2]', '        used += 1', '        mx = max(mx, e[2])'].concat(c.bad === 'none' ? ['print(' + c.out + ')'] : bad)); }, { limit: 12 }),
            D('graph2.scc', 'scc', 'graph-traversal', '強連通分量（Kosaraju，迭代，不用遞迴）：先在原圖記完成順序，再在反圖依逆序收集；輸出分量個數、最大分量的點數，或整張圖是不是強連通',
                [BASE, S('out', '輸出', [['count', 'cnt'], ['largest', 'max(sizes)'], ['one', 'one']])],
                (c, N, I) => { const n = need(N.sc[0], '節點數 n'), rows = need(N.ls[0], '邊表'); const yn = ynOf(I);
                    return code(['adj = [[] for _ in range(' + n + ' + 1)]', 'radj = [[] for _ in range(' + n + ' + 1)]', 'for e in ' + rows + ':', '    adj[e[0]].append(e[1])', '    radj[e[1]].append(e[0])', 'order = []', 'seen = [False] * (' + n + ' + 1)', 'for s in range(' + c.base + ', ' + c.base + ' + ' + n + '):', '    if seen[s]:', '        continue', '    seen[s] = True', '    st = [(s, 0)]', '    while st:', '        x, i = st.pop()', '        if i < len(adj[x]):', '            st.append((x, i + 1))', '            y = adj[x][i]', '            if not seen[y]:', '                seen[y] = True', '                st.append((y, 0))', '        else:', '            order.append(x)', 'comp = [-1] * (' + n + ' + 1)', 'cnt = 0', 'sizes = []', 'for s in reversed(order):', '    if comp[s] >= 0:', '        continue', '    comp[s] = cnt', '    sz = 0', '    st = [s]', '    while st:', '        x = st.pop()', '        sz += 1', '        for y in radj[x]:', '            if comp[y] < 0:', '                comp[y] = cnt', '                st.append(y)', '    sizes.append(sz)', '    cnt += 1', c.out === 'one' ? 'print(' + q(yn[0]) + ' if cnt == 1 else ' + q(yn[1]) + ')' : 'print(' + c.out + ')']); }, { limit: 12 }),
            D('graph2.bellman', 'bellman-ford', 'shortest-path', '最短路（Bellman-Ford，有向、可有負權）：從起點鬆弛 n 輪，第 n 輪還能鬆弛表示有負環；輸出到終點 n 的距離或所有點的距離；不可達印 -1 或 INF；有負環時印敘述裡的標籤',
                [BASE, S('tgt', '輸出', [['to-n', 'to-n'], ['all', 'all']]), S('un', '不可達', [['-1', '-1'], ['INF', 'INF']]), S('neg', '有負環時', [['ignore', 'ignore'], ['label', 'label']])],
                (c, N, I) => { const n = need(N.sc[0], '節點數 n'), rows = need(N.ls[0], '邊表'); const lab = capsLabel(I); if (c.neg === 'label' && !lab) throw new Error('抽不到負環的標籤'); const un = c.un === 'INF' ? '"INF"' : '-1';
                    const L = ['INF = 10 ** 18', 'dist = [INF] * (' + n + ' + 1)', 'dist[' + c.base + '] = 0', 'ch = False', 'for _ in range(' + n + '):', '    ch = False', '    for e in ' + rows + ':', '        if dist[e[0]] < INF and dist[e[0]] + e[2] < dist[e[1]]:', '            dist[e[1]] = dist[e[0]] + e[2]', '            ch = True', '    if not ch:', '        break'];
                    const out = c.tgt === 'to-n' ? ['print(' + un + ' if dist[' + n + ' - 1 + ' + c.base + '] >= INF else dist[' + n + ' - 1 + ' + c.base + '])'] : ['print(*[(' + un + ' if d >= INF else d) for d in dist[' + c.base + ':' + c.base + ' + ' + n + ']])'];
                    return code(c.neg === 'label' ? L.concat(['if ch:', '    print(' + q(lab) + ')', 'else:'], out.map((x) => '    ' + x)) : L.concat(out)); }, { limit: 24 }),
            D('graph2.tree-diameter', 'tree-diameter', 'graph-traversal', '樹的直徑：從任一點走到最遠點 a，再從 a 走到最遠點，距離就是直徑（邊有權重就用權重，沒有就每條邊 1）；輸出直徑長度或直徑上的點數',
                [BASE, S('out', '輸出', [['len', '0'], ['nodes', '1']])],
                (c, N) => { const n = need(N.sc[0], '節點數 n'), rows = need(N.ls[0], '邊表');
                    return code(['adj = [[] for _ in range(' + n + ' + 1)]', 'for e in ' + rows + ':', '    w = e[2] if len(e) > 2 else 1', '    adj[e[0]].append((e[1], w))', '    adj[e[1]].append((e[0], w))', 'dist = [-1] * (' + n + ' + 1)', 'dist[' + c.base + '] = 0', 'st = [' + c.base + ']', 'while st:', '    x = st.pop()', '    for y, w in adj[x]:', '        if dist[y] < 0:', '            dist[y] = dist[x] + w', '            st.append(y)', 'far = max(range(' + n + ' + 1), key=lambda i: dist[i])', 'dist = [-1] * (' + n + ' + 1)', 'dist[far] = 0', 'st = [far]', 'while st:', '    x = st.pop()', '    for y, w in adj[x]:', '        if dist[y] < 0:', '            dist[y] = dist[x] + w', '            st.append(y)', 'print(max(dist) + ' + c.out + ')']); }, { limit: 12 }),
            D('graph2.lca', 'lca', 'graph-traversal', '最近共同祖先（LCA）：從根 BFS 記父親與深度，兩點先爬到同一深度再一起往上；輸出每個查詢的祖先編號，或兩點的樹上距離',
                [BASE, S('out', '輸出', [['lca', 'lca'], ['dist', 'dist']])],
                (c, N) => { const n = need(N.sc[0], '節點數 n'), E = need(N.ls[0], '邊表'), Q = need(N.ls[1], '查詢表');
                    return code(['adj = [[] for _ in range(' + n + ' + 1)]', 'for e in ' + E + ':', '    adj[e[0]].append(e[1])', '    adj[e[1]].append(e[0])', 'par = [0] * (' + n + ' + 1)', 'dep = [0] * (' + n + ' + 1)', 'seen = [False] * (' + n + ' + 1)', 'seen[' + c.base + '] = True', 'qu = [' + c.base + ']', 'for x in qu:', '    for y in adj[x]:', '        if not seen[y]:', '            seen[y] = True', '            par[y] = x', '            dep[y] = dep[x] + 1', '            qu.append(y)', 'for e in ' + Q + ':', '    a = e[0]', '    b = e[1]', '    a0 = a', '    b0 = b', '    while dep[a] > dep[b]:', '        a = par[a]', '    while dep[b] > dep[a]:', '        b = par[b]', '    while a != b:', '        a = par[a]', '        b = par[b]', c.out === 'lca' ? '    print(a)' : '    print(dep[a0] + dep[b0] - 2 * dep[a])']); }, { limit: 12 }),
            D('graph2.bipartite', 'bipartite', 'graph-traversal', '二分圖判定：用兩種顏色 BFS 著色，遇到同色的邊就不是二分圖（每個連通塊都要著色）；輸出是否二分圖',
                [BASE],
                (c, N, I) => { const n = need(N.sc[0], '節點數 n'), rows = need(N.ls[0], '邊表'); const yn = ynOf(I);
                    return code(['adj = [[] for _ in range(' + n + ' + 1)]', 'for e in ' + rows + ':', '    adj[e[0]].append(e[1])', '    adj[e[1]].append(e[0])', 'col = [-1] * (' + n + ' + 1)', 'ok = True', 'for s in range(' + c.base + ', ' + c.base + ' + ' + n + '):', '    if col[s] >= 0:', '        continue', '    col[s] = 0', '    qu = [s]', '    for x in qu:', '        for y in adj[x]:', '            if col[y] < 0:', '                col[y] = 1 - col[x]', '                qu.append(y)', '            elif col[y] == col[x]:', '                ok = False', 'print(' + q(yn[0]) + ' if ok else ' + q(yn[1]) + ')']); }, { limit: 12 }),
            D('graph2.maxflow', 'maxflow', 'flow', '最大流（Edmonds-Karp：每次用 BFS 找最短的增廣路）：容量矩陣，邊 u v c；起點 1、終點 n（或相反）；有向邊，或每條邊兩個方向都有容量；輸出最大流量',
                [BASE, S('dir', '邊的方向', [['directed', 'directed'], ['undirected', 'undirected']]), S('st', '起點到終點', [['1-n', '1-n'], ['n-1', 'n-1']])],
                (c, N) => { const n = need(N.sc[0], '節點數 n'), rows = need(N.ls[0], '邊表'); const s0 = c.st === '1-n' ? c.base : n + ' - 1 + ' + c.base, t0 = c.st === '1-n' ? n + ' - 1 + ' + c.base : c.base;
                    return code(['cap = [[0] * (' + n + ' + 1) for _ in range(' + n + ' + 1)]', 'for e in ' + rows + ':', '    cap[e[0]][e[1]] += e[2]'].concat(c.dir === 'undirected' ? ['    cap[e[1]][e[0]] += e[2]'] : [], ['S = ' + s0, 'T = ' + t0, 'flow = 0', 'while True:', '    prev = [-1] * (' + n + ' + 1)', '    prev[S] = S', '    qu = [S]', '    for x in qu:', '        for y in range(' + n + ' + 1):', '            if prev[y] < 0 and cap[x][y] > 0:', '                prev[y] = x', '                qu.append(y)', '    if prev[T] < 0:', '        break', '    b = 10 ** 18', '    y = T', '    while y != S:', '        b = min(b, cap[prev[y]][y])', '        y = prev[y]', '    y = T', '    while y != S:', '        cap[prev[y]][y] -= b', '        cap[y][prev[y]] += b', '        y = prev[y]', '    flow += b', 'print(flow)'])); }, { limit: 12 }),
        ];
        const algos = [
            ['maxflow', /最大流|網路流|max[\s-]*flow|Edmonds|Dinic|Ford[\s-]*Fulkerson/i], ['mst', /最小生成樹|最小支撐樹|\bMST\b|Kruskal|Prim\b|minimum\s*spanning|(?:所有|每個).{0,8}(?:互通|連通|連起來|相連).{0,24}最(?:少|小).{0,6}(?:成本|花費|總長|權重|代價)/i], ['scc', /強連通|強連結|\bSCC\b|strongly\s*connected|Kosaraju|Tarjan|互相(?:可以)?(?:到達|抵達|連到)|彼此(?:可達|可以到達)/i],
            ['bellman-ford', /Bellman|負權|負邊|負環|負權重/i], ['lca', /最近共同祖先|最低共同祖先|\bLCA\b|lowest\s*common\s*ancestor|共同(?:的)?最深祖先|最深的共同祖先/i], ['tree-diameter', /樹的直徑|樹直徑|tree\s*diameter|相距最遠的兩\s*(?:個)?\s*(?:點|節點)|最遠的兩\s*(?:個)?\s*(?:點|節點)/i], ['bipartite', /二分圖|bipartite|染成兩種顏色|兩種顏色.{0,12}(?:相鄰|不同)/i],
        ].map(([key, re]) => ({ key, re, pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = [sk.paradigm];
        return { id: 'graph2', label: '進階圖與樹（最小生成樹、強連通、Bellman-Ford、樹直徑、LCA、二分圖、最大流）', requires: [], judge: { checker: 'tokens' }, algos, paradigms, skeletons };
    }
    return { make };
});
