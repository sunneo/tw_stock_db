/* 領域包：平行運算與排程（階段 3）：歸約、競爭條件（原子／臨界區／無同步）、熵編碼位元打包（兩趟）、整數 Haar 有損框變換。
 * 格式同 domain_par_core.js。骨架：
 *   par.reduce：parallel for 的 reduction（sum／max／min）；排程 block（連續）或 cyclic（循環）；每個執行緒先算部分結果，最後合併。
 *   par.race：p 個執行緒各做 n 次計數器加一。sync＝atomic／critical（都不遺失）、unsync（每一輪大家讀到同一個值再寫回 v+1，遺失更新）；out＝final（最後值）或 lost（應有次數減最後值）。
 *   par.bitpack：熵編碼的位元打包兩趟：第一趟各區段算位元長度和，第二趟算位移後平行寫入；out＝位元串或總位元數。切法 block／blockceil。
 *   par.haar：有損整數 Haar 提升（低頻 (a+b)>>1、高頻 a-b），每框 k 個取樣，框用 block／cyclic／dynamic／guided 排程分給 p 個執行緒；係數 //4 量化，out＝總和或絕對值總和。
 * 槽位由沙盒窮舉；骨架的 py 只把選項轉成 Python。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainPar3 = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, paradigm, label, slots, py, extra) => Object.assign({ id, algo, paradigm, label, slots, py }, extra || {});
        const need = (N, n) => { if (N.sc.length < n) throw new Error('要 ' + n + ' 個整數變數'); };
        // 索引（或框）的擁有者清單：block（連續）、cyclic（循環）、dynamic（最早閒者領一個）、guided（剩餘／p 的塊，最早閒者領）
        const ownIdx = (kind, cnt, p) => {
            if (kind === 'block') return ['own = [[] for _ in range(' + p + ')]', 'q, r = divmod(' + cnt + ', ' + p + ')', 's = 0', 'for t in range(' + p + '):', '    ln = q + (1 if t < r else 0)', '    own[t] = list(range(s, s + ln))', '    s += ln'];
            if (kind === 'cyclic') return ['own = [list(range(t, ' + cnt + ', ' + p + ')) for t in range(' + p + ')]'];
            throw new Error('未知 ' + kind);
        };
        const ownFrames = (kind, n, k, p) => {
            const len = 'min(' + n + ', (f + 1) * ' + k + ') - f * ' + k;
            if (kind === 'block' || kind === 'cyclic') return ownIdx(kind, 'nf', p);
            if (kind === 'dynamic') return ['own = [[] for _ in range(' + p + ')]', 'load = [0] * ' + p, 'for f in range(nf):', '    t = min(range(' + p + '), key=lambda j: (load[j], j))', '    own[t].append(f)', '    load[t] += ' + len];
            return ['own = [[] for _ in range(' + p + ')]', 'load = [0] * ' + p, 's = 0', 'while s < nf:', '    sz = max(1, -(-(nf - s) // ' + p + '))', '    t = min(range(' + p + '), key=lambda j: (load[j], j))', '    for f in range(s, min(nf, s + sz)):', '        own[t].append(f)', '        load[t] += ' + len, '    s += sz'];
        };
        const bounds = (split, n, p) => split === 'block' ? ['q, r = divmod(' + n + ', ' + p + ')', 'bnd = [0]', 'for t in range(' + p + '):', '    bnd.append(bnd[-1] + q + (1 if t < r else 0))']
            : ['cs = (' + n + ' + ' + p + ' - 1) // ' + p, 'bnd = [min(' + n + ', t * cs) for t in range(' + p + ' + 1)]'];
        const skeletons = [
            D('par.reduce', 'par-reduce', 'reduction', '平行 for 的歸約（reduction）：迭代以區塊或循環排程分給 p 個執行緒，各執行緒先算部分結果（和、最大、最小），最後合併',
                [S('kind', '排程', [['block', 'block'], ['cyclic', 'cyclic']]), S('op', '歸約運算', [['sum', 'sum'], ['max', 'max'], ['min', 'min']])],
                (c, N) => { need(N, 2); if (N.ls.length < 1) throw new Error('要陣列'); const n = N.sc[0], p = N.sc[1], x = N.ls[0];
                    const init = c.op === 'sum' ? '0' : c.op === 'max' ? '-1' : '10 ** 9';
                    const step = c.op === 'sum' ? 'part[t] += ' + x + '[i]' : 'part[t] = ' + c.op + '(part[t], ' + x + '[i])';
                    return code(ownIdx(c.kind, n, p).concat(['part = [' + init + '] * ' + p, 'for t in range(' + p + '):', '    for i in own[t]:', '        ' + step, 'print(' + c.op + '(part))'] )); }, { limit: 6 }),
            D('par.race', 'par-race', 'race-condition', '計數器的競爭條件：p 個執行緒各做 n 次加一；原子或臨界區保護的版本不遺失更新，沒有同步的版本每一輪大家讀同一值再寫回加一，會遺失更新',
                [S('sync', '同步', [['atomic', 'atomic'], ['critical', 'critical'], ['unsync', 'unsync']]), S('out', '輸出', [['final', 'final'], ['lost', 'lost']])],
                (c, N) => { need(N, 2); const n = N.sc[0], p = N.sc[1];
                    const body = c.sync === 'unsync' ? ['c = 0', 'for _ in range(' + n + '):', '    v = c', '    c = v + 1'] : ['c = 0', 'for _ in range(' + n + '):', '    for t in range(' + p + '):', '        c += 1'];
                    return code(body.concat([c.out === 'final' ? 'print(c)' : 'print(' + n + ' * ' + p + ' - c)'])); }, { limit: 6 }),
            D('par.bitpack', 'par-pack', 'two-pass-scan', '熵編碼位元打包（兩趟）：第一趟各區段算位元長度和，第二趟算每塊寫入位移後平行寫入位元；輸出位元串或總位元數',
                [S('split', '區段切法', [['block', 'block'], ['blockceil', 'blockceil']]), S('out', '輸出', [['bits', 'bits'], ['total', 'total']])],
                (c, N) => { need(N, 2); if (N.ls.length < 2) throw new Error('要兩個清單（位元長度、值）'); const n = N.sc[0], p = N.sc[1], L = N.ls[0], v = N.ls[1];
                    const pre = bounds(c.split, n, p).concat(['loc = [0] * ' + p, 'for t in range(' + p + '):', '    loc[t] = sum(' + L + '[bnd[t]:bnd[t + 1]])', 'off = [0] * ' + p, 'for t in range(1, ' + p + '):', '    off[t] = off[t - 1] + loc[t - 1]']);
                    if (c.out === 'total') return code(['print(sum(' + L + '))']);
                    return code(pre.concat(['bits = ["0"] * sum(' + L + ')', 'for t in range(' + p + '):', '    pos = off[t]', '    for i in range(bnd[t], bnd[t + 1]):', '        for b in range(' + L + '[i]):', '            bits[pos + b] = str((' + v + '[i] >> (' + L + '[i] - 1 - b)) & 1)', '        pos += ' + L + '[i]', 'print("".join(bits))'])); }, { limit: 4 }),
            D('par.haar', 'par-haar', 'parallel-map', '有損整數 Haar 提升：每 k 個取樣一框，框內每兩個相鄰取樣做 (a+b)>>1、a-b，係數 //4 量化；框以 block／cyclic／dynamic／guided 排程分給 p 個執行緒；輸出量化係數的總和或絕對值總和',
                [S('kind', '框的排程', [['block', 'block'], ['cyclic', 'cyclic'], ['dynamic', 'dynamic'], ['guided', 'guided']]), S('out', '輸出', [['sumq', 'sumq'], ['sumabs', 'sumabs']])],
                (c, N) => { need(N, 3); const n = N.sc[0], p = N.sc[1], k = N.sc[2], x = N.ls[0];
                    const term = c.out === 'sumq' ? 'lo // 4 + hi // 4' : 'abs(lo // 4) + abs(hi // 4)';
                    return code(['nf = ' + n + ' // ' + k].concat(ownFrames(c.kind, n, k, p), ['tot = [0] * ' + p, 'for t in range(' + p + '):', '    for f in own[t]:', '        for j in range(f * ' + k + ', f * ' + k + ' + ' + k + ', 2):', '            lo = (' + x + '[j] + ' + x + '[j + 1]) >> 1', '            hi = ' + x + '[j] - ' + x + '[j + 1]', '            tot[t] += ' + term, 'print(sum(tot))'])); }, { limit: 8 }),
            D('par.hist', 'par-hist', 'private-reduction', '直方圖的私有副本歸約：迭代以區塊或循環排程分給 p 個執行緒，每個執行緒用私有直方圖統計，最後逐格加總；輸出 8 格的次數或次數最多的格號',
                [S('kind', '排程', [['block', 'block'], ['cyclic', 'cyclic']]), S('out', '輸出', [['counts', 'counts'], ['maxbin', 'maxbin']])],
                (c, N) => { need(N, 2); if (N.ls.length < 1) throw new Error('要陣列'); const n = N.sc[0], p = N.sc[1], x = N.ls[0];
                    return code(ownIdx(c.kind, n, p).concat(['K = 8', 'priv = [[0] * K for _ in range(' + p + ')]', 'for t in range(' + p + '):', '    for i in own[t]:', '        priv[t][' + x + '[i]] += 1', 'cnt = [sum(priv[t][b] for t in range(' + p + ')) for b in range(K)]', c.out === 'counts' ? 'print(" ".join(str(v) for v in cnt))' : 'print(cnt.index(max(cnt)))'])); }, { limit: 4 }),
        ];
        const algos = [
            ['par-haar', /Haar|haar|小波|整數提升|提升.{0,10}(變換|係數)/],
            ['par-hist', /直方圖|histogram|出現次數/],
            ['par-race', /競爭條件|race|原子|atomic|臨界區|critical|遺失.{0,6}更新|lost\s*update/i],
            ['par-reduce', /歸約|reduction|reduce/i],
            ['par-pack', /位元(打包|寫入)|熵編碼.{0,20}(平行|位移|寫入|位元)|寫入位元|寫成.{0,8}位元|位元.{0,8}(接|串)|位元位移/],
        ].map(([key, re]) => ({ key, re, pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = [sk.paradigm];
        return { id: 'par3', label: '平行運算：歸約、競爭條件、熵編碼打包、Haar 有損框變換', requires: [], judge: { checker: 'tokens' }, algos, paradigms, skeletons };
    }
    return { make };
});
