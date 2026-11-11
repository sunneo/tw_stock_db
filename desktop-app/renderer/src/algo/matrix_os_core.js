/* 矩陣層：作業系統小模型的範本與矩陣版（G9 Petri 網、頁面置換的置換矩陣、排程）。純函式 UMD，不問模型。設計：DESIGN.matrix-fallback.md §12.2「作業系統」。
 *
 * 範本（register 到 FaMatrixSynth）：
 *   os-cache     「k n」＋ n 個請求編號：LRU／FIFO／MRU，輸出命中數／缺頁（未命中）數／淘汰次數／最後留在快取的內容
 *   os-sched     排程：輪轉（「q n」＋n 個執行時間）→ 總時間／每個工作的完成時間／完成順序；先來先服務／最短工作優先（「n」＋n 個執行時間）→ 總等待／最大等待／各自等待
 *   os-petri     Petri 網：「p t」、初始標記、t 行（消耗向量＋產生向量）、發射序列 → 最後標記（M' = M + C·f，count 半環的線性）
 * 矩陣版（純函式，測試對照清單／字典版）：
 *   lruMatrix(k, V, seq)    槽位內容 S（k×V 的 0/1）；查詢＝ S·e_x（one-hot 乘矩陣，線性）；命中位置 p 之後 S ← P_p·S（移到最前）；未命中 S ← P_{k-1}·S 後覆寫第 0 列
 *   fifoMatrix(k, V, seq)   環形移位矩陣
 *   petriMatrix(C, M0, seq) 標記向量 += C 的第 t 欄（C = 產生 − 消耗，p×t）
 * 只有「由命中向量取出位置 p」是控制步（argmax），不是矩陣運算（設計 §12.1 實測）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixOS = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const isInt = (s) => /^-?\d+$/.test(s);
    // ---- 矩陣版 ----
    const zeros = (r, c) => Array.from({ length: r }, () => Array(c).fill(0));
    const mulVec = (S, x) => S.map((row) => row.reduce((a, v, j) => a + v * x[j], 0));
    function permMoveFront(k, p) { // P_p：把第 p 列移到第 0 列，其餘 0..p-1 依序往後
        const P = zeros(k, k); P[0][p] = 1; for (let i = 1; i <= p; i++) P[i][i - 1] = 1; for (let i = p + 1; i < k; i++) P[i][i] = 1; return P;
    }
    const matMulSmall = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((a, v, t) => a + v * B[t][j], 0)));
    function lruMatrix(k, V, seq) {
        let S = zeros(k, V); let hits = 0; const filled = []; let used = 0;
        for (const x of seq) {
            const e = Array(V).fill(0); e[x] = 1; const hit = mulVec(S, e); const p = hit.indexOf(1); // 控制步：命中位置
            if (p >= 0) { hits++; S = matMulSmall(permMoveFront(k, p), S); }
            else { S = matMulSmall(permMoveFront(k, k - 1), S); S[0] = e.slice(); used = Math.min(k, used + 1); }
        }
        void filled; return { hits, S };
    }
    function fifoMatrix(k, V, seq) { // 環形：每次缺頁把所有槽位往後移一格（置換矩陣 C），新頁寫第 0 列
        let S = zeros(k, V); let faults = 0; const C = zeros(k, k); for (let i = 0; i < k; i++) C[(i + 1) % k][i] = 1;
        for (const x of seq) { const e = Array(V).fill(0); e[x] = 1; if (mulVec(S, e).indexOf(1) >= 0) continue; faults++; S = matMulSmall(C, S); S[0] = e.slice(); }
        return { faults, S };
    }
    function petriMatrix(C, M0, seq) { // C[p][t]；M ← M + C·f，f 是 one-hot 發射向量
        let M = M0.slice(); for (const t of seq) M = M.map((v, i) => v + C[i][t]); return M;
    }
    // ---- 清單版（參考與輸出程式用）----
    function cacheSim(policy, k, seq) {
        const c = []; let hits = 0, miss = 0, ev = 0;
        for (const x of seq) {
            const i = c.indexOf(x);
            if (i >= 0) { hits++; if (policy === 'lru') { c.splice(i, 1); c.push(x); } else if (policy === 'mru') { c.splice(i, 1); c.push(x); } }
            else { miss++; if (c.length === k) { if (policy === 'mru') c.pop(); else c.shift(); ev++; } c.push(x); }
        }
        return { hits, miss, ev, final: c.slice() };
    }
    // ---- 形狀 ----
    const toks = (l) => String(l).trim().split(/\s+/).filter(Boolean);
    const intsOf = (l) => { const t = toks(l); return t.every(isInt) ? t.map(Number) : null; };
    function parseHL(e) { const l = String(e.in).replace(/\n$/, '').split('\n'); if (l.length !== 2) return null; const h = intsOf(l[0]), a = intsOf(l[1]); if (!h || !a) return null; return { h, a }; }
    const outLine = (e) => String(e.out).replace(/\s+$/, '');
    // ---- os-cache ----
    function synthCache(o) {
        const exs = o.examples || []; if (!exs.length) return { ok: false, reason: '沒有範例' }; const st = String(o.statement || '');
        const P = exs.map(parseHL); if (P.some((p) => !p || p.h.length !== 2 || p.h[1] !== p.a.length || p.h[0] < 1)) return { ok: false, reason: '不是「k n ＋ n 個請求」的形狀' };
        const hits = []; const POL = [['lru', /LRU|最近最少|最久未使用/i], ['fifo', /FIFO|先進先出/i], ['mru', /MRU|最近使用的先/i]];
        const OUT = [['hits', (r) => String(r.hits), /命中|hit/i], ['faults', (r) => String(r.miss), /缺頁|未命中|miss|fault|載入/i], ['evictions', (r) => String(r.ev), /淘汰|換出|evict/i], ['final', (r) => r.final.join(' '), /最後.*(內容|留在)|剩下|最終/]];
        for (const [pol, pkw] of POL) for (const [ok, fn, okw] of OUT) {
            if (exs.every((e, i) => { const r = cacheSim(pol, P[i].h[0], P[i].a); return fn(r) === outLine(e).trim() || (ok === 'final' && fn({ final: r.final.slice().sort((a, b) => a - b) }) === outLine(e).trim()); })) hits.push({ pol, ok, fn, score: (pkw.test(st) ? 3 : 0) + (okw.test(st) ? 3 : 0) });
        }
        if (!hits.length) return { ok: false, reason: '快取模擬（LRU／FIFO／MRU × 命中／缺頁／淘汰／內容）裡沒有符合所有範例的' };
        hits.sort((a, b) => b.score - a.score); const mk = (h) => {
            const L = ['def main():', '    k, n = map(int, input().split())', '    seq = list(map(int, input().split()))', '    cache = []', '    hits = miss = ev = 0', '    for x in seq:', '        if x in cache:', '            hits += 1'];
            if (h.pol !== 'fifo') L.push('            cache.remove(x)', '            cache.append(x)');
            else L.push('            pass');
            L.push('        else:', '            miss += 1', '            if len(cache) == k:', h.pol === 'mru' ? '                cache.pop()' : '                cache.pop(0)', '                ev += 1', '            cache.append(x)');
            L.push(h.ok === 'hits' ? '    print(hits)' : h.ok === 'faults' ? '    print(miss)' : h.ok === 'evictions' ? '    print(ev)' : '    print(*cache)');
            return { ok: true, source: L.join('\n') + '\n', kind: 'os-cache', level: 'L6', size: L.length, tried: 12, ambiguous: false, desc: '快取模擬：' + h.pol.toUpperCase() + ' → ' + h.ok + '（矩陣版：' + (h.pol === 'lru' ? '置換矩陣移到最前' : '環形移位矩陣') + '）', matrixForm: { kind: 'os-cache', policy: h.pol, out: h.ok } };
        };
        const r0 = mk(hits[0]); r0.ambiguous = hits.length > 1 && hits[1].score === hits[0].score; r0.alternatives = hits.slice(1, 10).map(mk); return r0;
    }
    // ---- os-sched ----
    function rrSim(q, a) { const d = a.map((x, i) => [i, x]); let t = 0; const fin = Array(a.length).fill(0), order = []; while (d.length) { const [i, x] = d.shift(); const r = Math.min(q, x); t += r; if (x - r) d.push([i, x - r]); else { fin[i] = t; order.push(i + 1); } } return { total: t, fin, order }; }
    function fcfsSim(a, sjf) { const idx = a.map((x, i) => i); if (sjf) idx.sort((i, j) => a[i] - a[j] || i - j); let t = 0; const w = Array(a.length).fill(0); for (const i of idx) { w[i] = t; t += a[i]; } return { w, total: w.reduce((x, y) => x + y, 0), max: Math.max(...w), turn: a.map((x, i) => w[i] + x) }; }
    function synthSched(o) {
        const exs = o.examples || []; if (!exs.length) return { ok: false, reason: '沒有範例' }; const st = String(o.statement || ''); const P = exs.map(parseHL); if (P.some((p) => !p)) return { ok: false, reason: '不是兩行整數' };
        const hits = [];
        if (P.every((p) => p.h.length === 2 && p.h[1] === p.a.length && p.h[0] >= 1)) {
            const OUT = [['total', (r) => String(r.total), /總時間|最後.*完成|全部.*完成|總執行/], ['finish', (r) => r.fin.join(' '), /各.*完成時間|每個.*完成/], ['order', (r) => r.order.join(' '), /完成.*順序|依序完成/]];
            for (const [ok, fn, kw] of OUT) if (exs.every((e, i) => fn(rrSim(P[i].h[0], P[i].a)) === outLine(e).trim())) hits.push({ alg: 'rr', ok, score: (/輪轉|round.?robin|時間片/i.test(st) ? 3 : 0) + (kw.test(st) ? 3 : 0) });
        }
        if (P.every((p) => p.h.length === 1 && p.h[0] === p.a.length)) for (const sjf of [false, true]) {
            const OUT = [['totalwait', (r) => String(r.total)], ['maxwait', (r) => String(r.max)], ['waits', (r) => r.w.join(' ')], ['turnaround', (r) => r.turn.join(' ')], ['totalturn', (r) => String(r.turn.reduce((x, y) => x + y, 0))]];
            for (const [ok, fn] of OUT) if (exs.every((e, i) => fn(fcfsSim(P[i].a, sjf)) === outLine(e).trim())) hits.push({ alg: sjf ? 'sjf' : 'fcfs', ok, score: (sjf ? /最短|SJF|shortest/i : /先來先服務|FCFS|依序|先到/i).test(st) ? 3 : 0 });
        }
        if (!hits.length) return { ok: false, reason: '排程模擬（輪轉／先來先服務／最短工作優先）裡沒有符合所有範例的' };
        hits.sort((a, b) => b.score - a.score); const mk = (h) => {
            let L;
            if (h.alg === 'rr') { L = ['def main():', '    q, n = map(int, input().split())', '    a = list(map(int, input().split()))', '    from collections import deque', '    d = deque(enumerate(a))', '    t = 0', '    fin = [0] * n', '    order = []', '    while d:', '        i, x = d.popleft()', '        r = min(q, x)', '        t += r', '        if x - r:', '            d.append((i, x - r))', '        else:', '            fin[i] = t', '            order.push(i + 1)'.replace('push', 'append'), h.ok === 'total' ? '    print(t)' : h.ok === 'finish' ? '    print(*fin)' : '    print(*order)']; }
            else { L = ['def main():', '    n = int(input())', '    a = list(map(int, input().split()))', h.alg === 'sjf' ? '    idx = sorted(range(n), key=lambda i: (a[i], i))' : '    idx = list(range(n))', '    t = 0', '    w = [0] * n', '    for i in idx:', '        w[i] = t', '        t += a[i]', h.ok === 'totalwait' ? '    print(sum(w))' : h.ok === 'maxwait' ? '    print(max(w))' : h.ok === 'waits' ? '    print(*w)' : h.ok === 'turnaround' ? '    print(*[w[i] + a[i] for i in range(n)])' : '    print(sum(w[i] + a[i] for i in range(n)))']; }
            return { ok: true, source: L.join('\n') + '\n', kind: 'os-sched', level: 'L6', size: L.length, tried: 8, ambiguous: false, desc: '排程模擬：' + h.alg + ' → ' + h.ok, matrixForm: { kind: 'os-sched', alg: h.alg, out: h.ok } };
        };
        const r0 = mk(hits[0]); r0.ambiguous = hits.length > 1 && hits[1].score === hits[0].score; r0.alternatives = hits.slice(1, 10).map(mk); return r0;
    }
    // ---- os-petri ----
    function parsePetri(raw) {
        const l = String(raw).replace(/\n$/, '').split('\n'); const h = intsOf(l[0]); if (!h || h.length !== 2) return null; const [p, t] = h; if (p < 1 || t < 1 || l.length !== 2 + t + 1) return null;
        const m0 = intsOf(l[1]); if (!m0 || m0.length !== p) return null; const tr = []; for (let i = 0; i < t; i++) { const v = intsOf(l[2 + i]); if (!v || v.length !== 2 * p) return null; tr.push({ c: v.slice(0, p), g: v.slice(p) }); }
        const z = intsOf(l[2 + t]); if (!z || z.length < 1 || z[0] !== z.length - 1 || z.slice(1).some((x) => x < 0 || x >= t)) return null; return { p, t, m0, tr, seq: z.slice(1) };
    }
    function synthPetri(o) {
        const exs = o.examples || []; if (!exs.length) return { ok: false, reason: '沒有範例' }; const P = exs.map((e) => parsePetri(e.in)); if (P.some((x) => !x)) return { ok: false, reason: '不是 Petri 網的形狀（p t／初始標記／t 行消耗＋產生／發射序列）' };
        const run = (x) => { const C = Array.from({ length: x.p }, (_, i) => x.tr.map((t) => t.g[i] - t.c[i])); return petriMatrix(C, x.m0, x.seq); };
        if (!exs.every((e, i) => run(P[i]).join(' ') === outLine(e).trim())) return { ok: false, reason: 'Petri 網的最後標記與範例不符' };
        const L = ['def main():', '    p, t = map(int, input().split())', '    mk = list(map(int, input().split()))', '    # 變化矩陣 C（p×t）：C[i][j] = 轉換 j 產生 − 消耗的第 i 個位置；發射 j 就是 M ← M + C 的第 j 欄（count 半環的線性）', '    cols = []', '    for _ in range(t):', '        v = list(map(int, input().split()))', '        cols.append([v[p + i] - v[i] for i in range(p)])', '    z = list(map(int, input().split()))', '    for j in z[1:]:', '        mk = [mk[i] + cols[j][i] for i in range(p)]', '    print(*mk)'];
        return { ok: true, source: L.join('\n') + '\n', kind: 'os-petri', level: 'L6', size: L.length, tried: 1, ambiguous: false, desc: 'Petri 網：標記 M ← M + C·f（變化矩陣逐次累加）', matrixForm: { kind: 'os-petri' } };
    }
    function install(M) { if (!M || !M.register) return false; M.register('os-cache', synthCache, { order: 47, level: 'L6', note: '頁面置換／快取（LRU／FIFO／MRU；置換矩陣）' }); M.register('os-sched', synthSched, { order: 48, level: 'L6', note: '排程（輪轉／先來先服務／最短工作優先）' }); M.register('os-petri', synthPetri, { order: 49, level: 'L6', note: 'Petri 網發射序列（M ← M + C·f）' }); return true; }
    return { install, lruMatrix, fifoMatrix, petriMatrix, cacheSim, rrSim, fcfsSim, parsePetri, synthCache, synthSched, synthPetri, permMoveFront };
});
