/* 領域包：平行運算與排程（階段 2：相依分析、兩趟前綴和／位元位移、框式量化）。純函式格式同 domain_par_core.js。
 * 三個骨架：
 *   par.scan2：兩趟區段前綴和（第一趟各段加總、第二趟加上前段總和）；輸出 incl（前綴和）、excl（位元位移＝排他前綴和）、total。槽位：區段切法 block／blockceil。
 *   par.frame：框式有損量化（每 k 個取樣一框，框用 block／cyclic／dynamic 排程分給 p 個執行緒）；輸出量化值總和或最大誤差。
 *   par.wave：迴圈攜帶相依 a[i]=a[i-d]+x[i] 的波前（按層平行）；輸出陣列、層數（平行步數）、最多同時執行的迭代數。
 * 槽位（排程、切法、輸出）由沙盒窮舉；骨架的 py 只負責把選項變成 Python。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainPar2 = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, paradigm, label, slots, py, extra) => Object.assign({ id, algo, paradigm, label, slots, py }, extra || {});
        const need = (N, n) => { if (N.sc.length < n) throw new Error('要 ' + n + ' 個整數變數'); if (N.ls.length < 1) throw new Error('要陣列'); };
        const skeletons = [
            D('par.scan2', 'par-scan', 'parallel-scan', '兩趟區段前綴和／位元位移：各段先加總（第一趟），再加上前段總和（第二趟）；輸出前綴和、排他前綴和或總和',
                [S('split', '區段切法', [['block', 'block'], ['blockceil', 'blockceil']]), S('out', '輸出', [['incl', 'incl'], ['excl', 'excl'], ['total', 'total']])],
                (c, N) => { need(N, 2); const n = N.sc[0], p = N.sc[1], x = N.ls[0];
                    const pre = c.split === 'block' ? ['q, r = divmod(' + n + ', ' + p + ')', 'bnd = [0]', 'for t in range(' + p + '):', '    bnd.append(bnd[-1] + q + (1 if t < r else 0))']
                        : ['cs = (' + n + ' + ' + p + ' - 1) // ' + p, 'bnd = [min(' + n + ', t * cs) for t in range(' + p + ' + 1)]'];
                    const body = ['loc = [0] * ' + p, 'for t in range(' + p + '):', '    loc[t] = sum(' + x + '[bnd[t]:bnd[t + 1]])',
                        'off = [0] * ' + p, 'for t in range(1, ' + p + '):', '    off[t] = off[t - 1] + loc[t - 1]'];
                    if (c.out === 'total') return code(pre.concat(body, ['print(off[' + p + ' - 1] + loc[' + p + ' - 1])']));
                    const inner = c.out === 'incl' ? ['        s += ' + x + '[i]', '        out[i] = s'] : ['        out[i] = s', '        s += ' + x + '[i]'];
                    return code(pre.concat(body, ['out = [0] * ' + n, 'for t in range(' + p + '):', '    s = off[t]', '    for i in range(bnd[t], bnd[t + 1]):'], inner, ['print(" ".join(str(v) for v in out))'])); }, { limit: 6 }),
            D('par.frame', 'par-frame', 'parallel-map', '框式有損量化：每 k 個取樣為一框，框用區塊／循環／動態排程分給 p 個執行緒；每個取樣量化為 x // 4、誤差為 x 除以 4 的餘數；輸出量化值總和或最大誤差',
                [S('kind', '框的排程', [['block', 'block'], ['cyclic', 'cyclic'], ['dynamic', 'dynamic']]), S('out', '輸出', [['sumq', 'sumq'], ['maxerr', 'maxerr']])],
                (c, N) => { need(N, 3); const n = N.sc[0], p = N.sc[1], k = N.sc[2], x = N.ls[0];
                    const own = c.kind === 'block' ? ['own = [[] for _ in range(' + p + ')]', 'q, r = divmod(nf, ' + p + ')', 's = 0', 'for t in range(' + p + '):', '    ln = q + (1 if t < r else 0)', '    own[t] = list(range(s, s + ln))', '    s += ln']
                        : c.kind === 'cyclic' ? ['own = [list(range(t, nf, ' + p + ')) for t in range(' + p + ')]']
                        : ['own = [[] for _ in range(' + p + ')]', 'load = [0] * ' + p, 'for f in range(nf):', '    t = min(range(' + p + '), key=lambda j: (load[j], j))', '    own[t].append(f)', '    load[t] += min(' + n + ', (f + 1) * ' + k + ') - f * ' + k];
                    const comp = ['tot = [0] * ' + p, 'mx = [0] * ' + p, 'for t in range(' + p + '):', '    for f in own[t]:', '        for i in range(f * ' + k + ', min(' + n + ', (f + 1) * ' + k + ')):', '            tot[t] += ' + x + '[i] // 4', '            mx[t] = max(mx[t], ' + x + '[i] % 4)'];
                    return code(['nf = (' + n + ' + ' + k + ' - 1) // ' + k].concat(own, comp, [c.out === 'sumq' ? 'print(sum(tot))' : 'print(max(mx))'])); }, { limit: 6 }),
            D('par.wave', 'par-wave', 'wavefront', '迴圈攜帶相依的波前：a[i]＝a[i-d]＋x[i]（i≥d），迭代依距離 d 分層，同層互不相依；輸出陣列、層數或最多同時執行的迭代數',
                [S('out', '輸出', [['array', 'array'], ['steps', 'steps'], ['width', 'width']])],
                (c, N) => { need(N, 2); const n = N.sc[0], d = N.sc[1], x = N.ls[0];
                    if (c.out === 'steps') return code(['print(len(range(0, ' + n + ', ' + d + ')))']);
                    if (c.out === 'width') return code(['print(min(' + d + ', ' + n + '))']);
                    return code(['a = [0] * ' + n, 'for s in range(0, ' + n + ', ' + d + '):', '    for i in range(s, min(' + n + ', s + ' + d + ')):', '        a[i] = ' + x + '[i] if i < ' + d + ' else a[i - ' + d + '] + ' + x + '[i]', 'print(" ".join(str(v) for v in a))']); }, { limit: 3 }),
        ];
        const algos = [
            ['par-scan', /前綴和.{0,30}(區段|區塊|平行|兩趟|排程)|(區段|區塊|平行|兩趟).{0,30}前綴和|位元位移|排他前綴和|exclusive\s*scan/i],
            ['par-frame', /(框|frame)|取樣.{0,30}(量化|排程)|量化.{0,30}(排程|框|區塊)|像素.{0,30}(量化|框)/i],
            ['par-wave', /攜帶相依|迴圈.{0,12}相依|相依.{0,20}(迭代|距離|i-d)|wavefront|loop[\s-]*carried/i],
        ].map(([key, re]) => ({ key, re, pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = [sk.paradigm];
        return { id: 'par2', label: '平行運算：相依分析、兩趟前綴和、框式量化', requires: [], judge: { checker: 'tokens' }, algos, paradigms, skeletons };
    }
    return { make };
});
