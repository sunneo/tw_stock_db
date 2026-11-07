/* 矩陣層「組合」模組：把未知題拆成「已知積木」的組合（design pattern：Pipeline＋Strategy——輸入積木 → 向量積木 → 歸約積木 → 輸出）。純函式 UMD。
 *   向量積木（VECTORS）：把輸入變成「每個節點／每列／每欄一個數」的向量（BFS 距離、加權最短距離、度數、入度、分量大小；列和、欄和、列最大／最小、某字元的列／欄個數）。
 *   歸約積木（REDUCERS）：向量 → 答案（最大、最小、總和、個數、不同個數、排序後輸出、最大者的編號、是否全部／有沒有、取某一格、整個輸出），可先過濾（全部／只看 ≥0／只看 >0）。
 *   組合：向量積木 × 過濾 × 歸約，用範例驗證（敘述關鍵字只當先驗排序），第一個全對的就用；輸出的 Python 是「讀入 → 向量段 → 歸約段 → 列印」三段，每段有註解，好編輯。
 *   這讓「最遠距離」「奇度數個數」「各分量大小排序」「總和最大的列號」這種沒有整題範本的新組合也解得出，不必每個組合都寫一個範本。
 *   install(FaMatrixSynth, FaMatrixGraph)：註冊 'compose'（order 37）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixCompose = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    let GM = null; const isInt = (s) => /^-?\d+$/.test(s); const norm = (s) => String(s).trim().split(/\s+/).join(' ');
    // ---------- 向量積木 ----------
    const bfsD = (adj, s) => { const d = adj.map(() => -1); d[s] = 0; const q = [s]; for (let i = 0; i < q.length; i++) for (const [y] of adj[q[i]]) if (d[y] < 0) { d[y] = d[q[i]] + 1; q.push(y); } return d; };
    const dijk = (adj, s) => { const n = adj.length, d = Array(n).fill(Infinity), done = Array(n).fill(false); d[s] = 0; for (let it = 0; it < n; it++) { let u = -1; for (let i = 0; i < n; i++) if (!done[i] && d[i] < Infinity && (u < 0 || d[i] < d[u])) u = i; if (u < 0) break; done[u] = true; for (const [y, w] of adj[u]) if (d[u] + w < d[y]) d[y] = d[u] + w; } return d.map((x) => (x === Infinity ? -1 : x)); };
    const compSize = (adj) => { const n = adj.length, id = Array(n).fill(-1); const sz = []; for (let s = 0; s < n; s++) { if (id[s] >= 0) continue; id[s] = sz.length; let k = 0; const st = [s]; while (st.length) { const x = st.pop(); k++; for (const [y] of adj[x]) if (id[y] < 0) { id[y] = sz.length; st.push(y); } } sz.push(k); } return { per: id.map((c) => sz[c]), sizes: sz }; };
    const tr = (G) => G[0].map((_, j) => G.map((r) => r[j]));
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const GV = [
        { id: 'comp-sizes', kw: /每個連通分量|各連通分量|分量.*由大到小/, uses: 'graph', dirNeed: false, js: (c) => compSize(c.adj).sizes, py: ['cid = [-1] * n', 'vec = []', 'for s in range(n):', '    if cid[s] >= 0:', '        continue', '    cid[s] = len(vec)', '    k = 0', '    st = [s]', '    while st:', '        x = st.pop()', '        k += 1', '        for y, w in adj[x]:', '            if cid[y] < 0:', '                cid[y] = len(vec)', '                st.append(y)', '    vec.append(k)'], note: '向量：每個連通分量的大小' },
        { id: 'bfs-dist', kw: /最遠|距離|邊數|步數|走不到|到不了/, uses: 'graph', noW: true, js: (c) => bfsD(c.adj, c.s0), py: ['dist = [-1] * n', 'dist[s0] = 0', 'q = [s0]', 'for x in q:', '    for y, w in adj[x]:', '        if dist[y] < 0:', '            dist[y] = dist[x] + 1', '            q.append(y)', 'vec = dist'], note: '向量：從起點出發的最少邊數（走不到＝-1）' },
        { id: 'wdist', kw: /最短|路長|權重|距離/, uses: 'graph', needW: true, js: (c) => dijk(c.adj, c.s0), py: ['import heapq', 'INFD = float("inf")', 'dd = [INFD] * n', 'dd[s0] = 0', 'pq = [(0, s0)]', 'while pq:', '    du, u = heapq.heappop(pq)', '    if du > dd[u]:', '        continue', '    for v, w in adj[u]:', '        if du + w < dd[v]:', '            dd[v] = du + w', '            heapq.heappush(pq, (dd[v], v))', 'vec = [-1 if x == INFD else x for x in dd]'], note: '向量：從起點出發的最短距離（走不到＝-1）' },
        { id: 'degree', kw: /度數|連著幾條|連幾條/, uses: 'graph', dirNeed: false, js: (c) => c.adj.map((a) => a.length), py: ['vec = [len(adj[i]) for i in range(n)]'], note: '向量：每個節點的度數' },
        { id: 'outdeg', kw: /出度/, uses: 'graph', dirNeed: true, js: (c) => c.adj.map((a) => a.length), py: ['vec = [len(adj[i]) for i in range(n)]'], note: '向量：每個節點的出度' },
        { id: 'indeg', kw: /入度/, uses: 'graph', dirNeed: true, js: (c) => { const d = Array(c.n).fill(0); c.adj.forEach((a) => a.forEach(([y]) => d[y]++)); return d; }, py: ['vec = [0] * n', 'for u in range(n):', '    for v, w in adj[u]:', '        vec[v] += 1'], note: '向量：每個節點的入度' },
        { id: 'comp-size', kw: /連通分量|分量/, uses: 'graph', dirNeed: false, js: (c) => compSize(c.adj).per, py: ['cid = [-1] * n', 'sizes = []', 'for s in range(n):', '    if cid[s] >= 0:', '        continue', '    cid[s] = len(sizes)', '    k = 0', '    st = [s]', '    while st:', '        x = st.pop()', '        k += 1', '        for y, w in adj[x]:', '            if cid[y] < 0:', '                cid[y] = len(sizes)', '                st.append(y)', '    sizes.append(k)', 'vec = [sizes[c] for c in cid]'], note: '向量：每個節點所在分量的大小', comp: true, compJs: (c) => compSize(c.adj).sizes, compPy: 'vec = sizes' },
        { id: 'row-sum', kw: /每一列|每列|列.*總和|總和最大的列/, uses: 'grid', kind: 'int', js: (g) => g.G.map(sum), py: ['vec = [sum(row) for row in G]'], note: '向量：每一列的總和' },
        { id: 'col-sum', kw: /每一欄|每欄|欄.*總和|總和.*欄/, uses: 'grid', kind: 'int', js: (g) => tr(g.G).map(sum), py: ['vec = [sum(x) for x in zip(*G)]'], note: '向量：每一欄的總和' },
        { id: 'row-max', kw: /每列.*最大|每一列.*最大/, uses: 'grid', kind: 'int', js: (g) => g.G.map((r) => Math.max(...r)), py: ['vec = [max(row) for row in G]'], note: '向量：每一列的最大值' },
        { id: 'col-max', kw: /每欄.*最大|每一欄.*最大|各欄最大/, uses: 'grid', kind: 'int', js: (g) => tr(g.G).map((r) => Math.max(...r)), py: ['vec = [max(x) for x in zip(*G)]'], note: '向量：每一欄的最大值' },
        { id: 'col-min', kw: /每欄.*最小|每一欄.*最小|各欄最小/, uses: 'grid', kind: 'int', js: (g) => tr(g.G).map((r) => Math.min(...r)), py: ['vec = [min(x) for x in zip(*G)]'], note: '向量：每一欄的最小值' },
        { id: 'row-cnt', kw: /每列|每一列|單一列|一列/, uses: 'grid', kind: 'chr', needCh: true, js: (g, ch) => g.G.map((r) => r.filter((x) => x === ch).length), py: (ch) => ['vec = [row.count(' + JSON.stringify(ch) + ') for row in G]'], note: '向量：每一列某字元的個數' },
        { id: 'col-cnt', kw: /每欄|每一欄|單一欄/, uses: 'grid', kind: 'chr', needCh: true, js: (g, ch) => tr(g.G).map((r) => r.filter((x) => x === ch).length), py: (ch) => ['vec = [list(x).count(' + JSON.stringify(ch) + ') for x in zip(*G)]'], note: '向量：每一欄某字元的個數' },
    ];
    // ---------- 歸約積木：out 為 'int'／'list'／'bool'（要兩個標籤）；v 是已過濾的向量，idx 是過濾後保留的原始位置 ----------
    const RD = [
        { id: 'max', kw: /最大|最遠|最多/, out: 'int', js: (v) => (v.length ? Math.max(...v) : null), py: 'ans = max(v)' },
        { id: 'min', kw: /最小|最少|最近/, out: 'int', js: (v) => (v.length ? Math.min(...v) : null), py: 'ans = min(v)' },
        { id: 'sum', kw: /總和|加總|總共|合計/, out: 'int', js: (v) => sum(v), py: 'ans = sum(v)' },
        { id: 'len', kw: /個數|幾個|有幾|多少/, out: 'int', js: (v) => v.length, py: 'ans = len(v)' },
        { id: 'distinct', kw: /不同|相異/, out: 'int', js: (v) => new Set(v).size, py: 'ans = len(set(v))' },
        { id: 'count-odd', kw: /奇數/, out: 'int', js: (v) => v.filter((x) => x % 2 !== 0).length, py: 'ans = sum(1 for x in v if x % 2)' },
        { id: 'count-even', kw: /偶數/, out: 'int', js: (v) => v.filter((x) => x % 2 === 0).length, py: 'ans = sum(1 for x in v if x % 2 == 0)' },
        { id: 'count-pos', kw: /大於\s*0|為正|正的/, out: 'int', js: (v) => v.filter((x) => x > 0).length, py: 'ans = sum(1 for x in v if x > 0)' },
        { id: 'count-zero', kw: /等於\s*0|為\s*0|沒有/, out: 'int', js: (v) => v.filter((x) => x === 0).length, py: 'ans = sum(1 for x in v if x == 0)' },
        { id: 'count-neg', kw: /走不到|到不了|不可達|-1/, out: 'int', js: (v) => v.filter((x) => x < 0).length, py: 'ans = sum(1 for x in v if x < 0)' },
        { id: 'argmax', kw: /編號|第幾|列號|欄號/, out: 'int', arg: true, js: (v, ix, base) => (v.length ? ix[v.indexOf(Math.max(...v))] + base : null), py: 'ans = idx[v.index(max(v))] + BASE' },
        { id: 'argmin', kw: /編號|第幾|列號|欄號/, out: 'int', arg: true, js: (v, ix, base) => (v.length ? ix[v.indexOf(Math.min(...v))] + base : null), py: 'ans = idx[v.index(min(v))] + BASE' },
        { id: 'sorted-desc', kw: /由大到小|從大到小|遞減/, out: 'list', js: (v) => v.slice().sort((a, b) => b - a), py: 'ans = sorted(v, reverse=True)' },
        { id: 'sorted-asc', kw: /由小到大|從小到大|遞增|排序/, out: 'list', js: (v) => v.slice().sort((a, b) => a - b), py: 'ans = sorted(v)' },
        { id: 'all-list', kw: /依序|每個節點|每個/, out: 'list', js: (v) => v, py: 'ans = v' },
        { id: 'all-even', kw: /都是偶數|全部.*偶數|每個.*偶數|都為偶數/, out: 'bool', js: (v) => v.every((x) => x % 2 === 0), py: 'ans = all(x % 2 == 0 for x in v)' },
        { id: 'all-odd', kw: /都是奇數|全部.*奇數/, out: 'bool', js: (v) => v.every((x) => x % 2 !== 0), py: 'ans = all(x % 2 != 0 for x in v)' },
        { id: 'all-equal', kw: /都相同|全部相同|都一樣|相等/, out: 'bool', js: (v) => new Set(v).size === 1, py: 'ans = len(set(v)) == 1' },
        { id: 'any-zero', kw: /有沒有|是否有|存在/, out: 'bool', js: (v) => v.some((x) => x === 0), py: 'ans = any(x == 0 for x in v)' },
        { id: 'all-nonneg', kw: /都能|全部能|全都|都可以|連通/, out: 'bool', js: (v, ix, base, full) => full.every((x) => x >= 0), py: 'ans = all(x >= 0 for x in vec)', raw: true },
    ];
    const FLT = [['all', (x) => true, 'v = vec'], ['ge0', (x) => x >= 0, 'v = [x for x in vec if x >= 0]'], ['gt0', (x) => x > 0, 'v = [x for x in vec if x > 0]']];
    const stmtLabels = (st, exs) => { const outs = [...new Set(exs.map((e) => norm(e.out)))]; const caps = [...String(st).matchAll(/(?:輸出|印出|印)\s*([A-Za-z_]+)|[，,、]\s*([A-Z][A-Z_]+)/g)].map((m) => m[1] || m[2]); const ordered = []; for (const w of caps) if (!ordered.includes(w)) ordered.push(w); return { outs, ordered }; };
    function combos(st, vecs, exs, mk) {
        // mk(vecDef) → {vals:[…每個範例的向量], ctx} ；回傳全對的 (向量,過濾,歸約) 命中表
        const hits = []; let tried = 0; const { outs, ordered } = stmtLabels(st, exs);
        for (const V of vecs) { const per = mk(V); if (!per) continue; for (const [fid, ff] of FLT) for (const R of RD) {
            if (R.raw && fid !== 'all') continue; tried++; let vals; try { vals = per.map((p) => { const full = p.vec; const ix = []; const v = []; full.forEach((x, i) => { if (ff(x)) { ix.push(i); v.push(x); } }); const r = R.js(v, ix, p.base, full); return r; }); } catch (e) { continue; } if (vals.some((x) => x === null || x === undefined)) continue;
            let yes = null, no = null;
            if (R.out === 'bool') { const ls = outs.length === 2 ? outs : outs.concat(ordered.filter((x) => !outs.includes(x))).slice(0, 2); if (ls.length < 2) continue; const cand = ordered.filter((x) => ls.includes(x)); const pairs = cand.length === 2 ? [[cand[0], cand[1]]] : [[ls[0], ls[1]], [ls[1], ls[0]]]; let f = false; for (const [y, n_] of pairs) if (exs.every((e, i) => norm(e.out) === (vals[i] ? y : n_))) { yes = y; no = n_; f = true; break; } if (!f) continue; }
            else if (R.out === 'list') { if (!exs.every((e, i) => norm(e.out) === vals[i].join(' ') )) continue; }
            else if (!exs.every((e, i) => norm(e.out) === String(vals[i]))) continue;
            hits.push({ V, fid, R, yes, no, score: (V.kw.test(st) ? 2 : 0) + (R.kw.test(st) ? 2 : 0) + (fid === 'all' ? 1 : 0) }); } }
        return { hits, tried };
    }
    function emit(h, readLines, preLines, baseExpr, ch) {
        const vpy = typeof h.V.py === 'function' ? h.V.py(ch) : h.V.py; const fl = FLT.find((f) => f[0] === h.fid)[2];
        const L = ['def main():'].concat(readLines, preLines, ['    # ' + h.V.note], vpy.map((l) => '    ' + l), ['    # 過濾：' + (h.fid === 'all' ? '全部' : h.fid === 'ge0' ? '只看 ≥ 0 的' : '只看 > 0 的'), '    ' + fl, '    idx = [i for i, x in enumerate(vec) if x in set(v)] if False else [i for i, x in enumerate(vec) if ' + (h.fid === 'all' ? 'True' : h.fid === 'ge0' ? 'x >= 0' : 'x > 0') + ']', '    BASE = ' + baseExpr, '    # 歸約：' + h.R.id, '    ' + h.R.py]);
        const pr = h.R.out === 'bool' ? '    print(' + JSON.stringify(h.yes) + ' if ans else ' + JSON.stringify(h.no) + ')' : h.R.out === 'list' ? "    print(' '.join(map(str, ans)))" : '    print(ans)';
        return L.concat([pr]).join('\n') + '\n';
    }
    function synthGraphCompose(o) {
        const st = String(o.statement), exs = o.examples || []; if (!GM || !exs.length) return { ok: false, reason: '沒有範例' };
        const names = GM.hdrNames(st); if (!names || names[0] !== 'n' || names[1] !== 'm') return { ok: false, reason: '不是圖輸入形狀' };
        const B = GM.baseOf(st), sd = GM.dirOf(st); const gs = exs.map((e) => GM.parseGraphFull(st, e.in, names)); if (gs.some((g) => !g)) return { ok: false, reason: '範例不是邊表' };
        const w = gs[0].w; const dirs = sd === null ? [false, true] : [sd]; const all = [];
        for (const directed of dirs) {
            const vecs = GV.filter((V) => V.uses === 'graph' && !(V.noW && w) && !(V.needW && !w) && (V.dirNeed === undefined || V.dirNeed === directed));
            const ctxs = gs.map((g) => { const adj = GM.build(g, B, directed); if (!adj) return null; const sv = g.v.s !== undefined ? g.v.s : g.tail && g.tail.length >= 2 ? g.tail[0] : B; return { adj, n: g.v.n, s0: sv - B }; }); if (ctxs.some((c) => !c)) continue;
            const r = combos(st, vecs, exs, (V) => { try { return ctxs.map((c) => ({ vec: V.js(c), base: B })); } catch (e) { return null; } }); for (const h of r.hits) all.push(Object.assign(h, { directed }));
        }
        if (!all.length) return { ok: false, reason: '組合積木（向量 ' + GV.filter((v) => v.uses === 'graph').length + ' × 過濾 × 歸約 ' + RD.length + '）裡沒有符合所有範例的' };
        all.sort((a, b) => b.score - a.score); const g0 = gs[0];
        const rd = ['    h = input().split()'].concat(names.map((nm, i) => '    ' + nm + ' = int(h[' + i + '])'), ['    E = [tuple(map(int, input().split())) for _ in range(m)]']); const hasTail = g0.tail && g0.tail.length === 2 && g0.v.s === undefined; if (hasTail) rd.push('    s, t = map(int, input().split())');
        const s0 = (g0.v.s !== undefined || hasTail) ? 's - B' : '0';
        const mk = (h) => { const pre = ['    B = ' + B, '    adj = [[] for _ in range(n)]', '    for e in E:', '        u = e[0] - B', '        v = e[1] - B', '        w = e[2] if len(e) > 2 else 1', '        adj[u].append((v, w))'].concat(h.directed ? [] : ['        adj[v].append((u, w))'], ['    s0 = ' + s0]); return { ok: true, source: emit(h, rd, pre, 'B'), kind: 'compose', level: 'L3', size: h.V.py.length, tried: all.length, ambiguous: false, desc: '組合：' + h.V.id + ' → ' + (h.fid === 'all' ? '' : h.fid + ' → ') + h.R.id, matrixForm: { kind: 'compose', vector: h.V.id, filter: h.fid, reducer: h.R.id, directed: h.directed } }; };
        const r0 = mk(all[0]); r0.ambiguous = all.length > 1 && all[1].score === all[0].score; r0.alternatives = all.slice(1, 30).map((h) => Object.assign(mk(h), { ambiguous: true })); return r0;
    }
    function synthGridCompose(o) {
        const st = String(o.statement), exs = o.examples || []; if (!GM || !exs.length) return { ok: false, reason: '沒有範例' };
        const parse = (raw) => { const L = String(raw).replace(/\s+$/, '').split('\n'); const hd = L[0].trim().split(/\s+/).map(Number); if (hd.length !== 2 || hd.some(Number.isNaN)) return null; const [r, c] = hd; const rows = L.slice(1); if (rows.length !== r) return null; const toks = rows.map((l) => l.trim().split(/\s+/)); if (toks.every((t) => t.length === c && t.every(isInt))) return { r, c, kind: 'int', G: toks.map((t) => t.map(Number)) }; if (rows.every((l) => l.length === c && !/\s/.test(l))) return { r, c, kind: 'chr', G: rows.map((l) => [...l]) }; return null; };
        const gs = exs.map((e) => parse(e.in)); if (gs.some((g) => !g || g.kind !== gs[0].kind)) return { ok: false, reason: '不是格子輸入' }; const kind = gs[0].kind;
        const q = [...st.matchAll(/[「"'『]\s*(\S)\s*[」"'』]/g)].map((m) => m[1]); const seen = [...new Set(exs.flatMap((e) => [...e.in.split('\n').slice(1).join('')].filter((x) => !/\s/.test(x))))]; const chs = [...new Set(q.concat([...st].filter((x) => /[#.*@+oOxX]/.test(x) && seen.includes(x)), seen))].slice(0, 5);
        const all = []; let tried = 0;
        for (const ch of (kind === 'chr' ? chs : [null])) { const vecs = GV.filter((V) => V.uses === 'grid' && V.kind === kind && (!V.needCh || ch)); const r = combos(st, vecs, exs, (V) => { try { return gs.map((g) => ({ vec: V.js(g, ch), base: 1 })); } catch (e) { return null; } }); tried += r.tried; for (const h of r.hits) all.push(Object.assign(h, { ch, score: h.score + (ch && st.includes(ch) ? 1 : 0) })); }
        if (!all.length) return { ok: false, reason: '格子組合積木裡沒有符合所有範例的', tried };
        all.sort((a, b) => b.score - a.score);
        const rd = ['    r, c = map(int, input().split())', kind === 'int' ? '    G = [list(map(int, input().split())) for _ in range(r)]' : '    G = [input().strip() for _ in range(r)]'];
        const mk = (h) => ({ ok: true, source: emit(h, rd, [], '1', h.ch), kind: 'compose', level: 'L4', size: 0, tried: all.length, ambiguous: false, desc: '組合：' + h.V.id + (h.ch ? '(' + h.ch + ')' : '') + ' → ' + (h.fid === 'all' ? '' : h.fid + ' → ') + h.R.id, matrixForm: { kind: 'compose', vector: h.V.id, filter: h.fid, reducer: h.R.id } });
        const r0 = mk(all[0]); r0.ambiguous = all.length > 1 && all[1].score === all[0].score; r0.alternatives = all.slice(1, 30).map((h) => Object.assign(mk(h), { ambiguous: true })); return r0;
    }
    function install(M, G) { if (!M || !M.register || !G) return false; GM = G; M.register('compose-graph', synthGraphCompose, { order: 37, level: 'L3', note: '圖：向量積木 × 過濾 × 歸約積木' }); M.register('compose-grid', synthGridCompose, { order: 38, level: 'L4', note: '格子：向量積木 × 過濾 × 歸約積木' }); return true; }
    return { install, synthGraphCompose, synthGridCompose, GV, RD };
});
