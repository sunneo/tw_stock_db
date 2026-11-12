/* 領域包：平行運算與排程（階段 1：迴圈排程原語）。純函式，不真的開執行緒；格式見 domain_registry_core.js。
 * 範式：靜態區塊／循環／分塊循環排程的索引分配、各執行緒負載（工作量加總）與不均衡度、動態與引導式排程的事件模擬、對一組工作量推薦排程。
 * 輸入形狀：第一行 n p［k］（迭代數、執行緒數、可選的區塊大小），需要工作量時第二行是 n 個工作量。
 * 差異點（區塊餘數給前面幾個執行緒或用 ceil 切塊、tie 時誰先、候選排程的集合）是槽位，由沙盒窮舉。骨架不含 def。train／holdout 見 domain_par.test.js。
 * 同一套規則的 JS 版在 renderer/src/algo/par_sched_core.js（給分析工具鏈用）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainPar = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, paradigm, label, slots, py, extra) => Object.assign({ id, algo, paradigm, label, slots, py }, extra || {});
        const KIND = [['block', 'block'], ['blockceil', 'blockceil'], ['cyclic', 'cyclic'], ['chunked', 'chunked']];
        const need = (N, n) => { if (N.sc.length < n) throw new Error('要 ' + n + ' 個整數變數'); };
        // 第 i 個迭代屬於哪個執行緒（運算式字串）
        const owner = (kind, N) => {
            const n = N.sc[0], p = N.sc[1];
            if (kind === 'block') return '(i // (q + 1) if i < r * (q + 1) else r + (i - r * (q + 1)) // q)';
            if (kind === 'blockceil') return '(i // cs)';
            if (kind === 'cyclic') return '(i % ' + p + ')';
            need(N, 3); void n; return '((i // ' + N.sc[2] + ') % ' + p + ')';
        };
        const pre = (kind, N) => kind === 'block' ? ['q, r = divmod(' + N.sc[0] + ', ' + N.sc[1] + ')'] : kind === 'blockceil' ? ['cs = (' + N.sc[0] + ' + ' + N.sc[1] + ' - 1) // ' + N.sc[1]] : [];
        const skeletons = [
            D('par.sched-assign', 'par-assign', 'simulation', '靜態排程的索引分配：n 個迭代（0 起算）分給 p 個執行緒；區塊＝連續切塊、循環＝i mod p、分塊循環＝每 k 個輪流；輸出每個執行緒分到的索引（每個執行緒一行）',
                [S('kind', '排程', KIND), S('empty', '沒分到時', [['blank', 'blank'], ['dash', 'dash']])],
                (c, N) => { need(N, 2); const k = c.kind; return code(pre(k, N).concat(['asg = [[] for _ in range(' + N.sc[1] + ')]', 'for i in range(' + N.sc[0] + '):', '    asg[' + owner(k, N) + '].append(i)', 'for row in asg:', c.empty === 'blank' ? '    print(" ".join(str(x) for x in row))' : '    print(" ".join(str(x) for x in row) if row else "-")'])); }, { limit: 8 }),
            D('par.sched-load', 'par-load', 'simulation', '排程下的負載：n 個迭代各有工作量，依排程分給 p 個執行緒；輸出每個執行緒的負載、最忙者（span）、理論加速比（總量／span）或不均衡度（span／平均−1）',
                [S('kind', '排程', KIND), S('out', '輸出', [['loads', 'loads'], ['span', 'span'], ['speedup', 'speedup'], ['imb', 'imb']])],
                (c, N) => { need(N, 2); if (N.ls.length < 1) throw new Error('要工作量清單'); const k = c.kind, a = N.ls[0], p = N.sc[1]; return code(pre(k, N).concat(['ld = [0] * ' + p, 'for i in range(' + N.sc[0] + '):', '    ld[' + owner(k, N) + '] += ' + a + '[i]'], c.out === 'loads' ? ['print(" ".join(str(x) for x in ld))'] : c.out === 'span' ? ['print(max(ld))'] : c.out === 'speedup' ? ['print("%.3f" % (sum(ld) / max(ld)))'] : ['print("%.3f" % (max(ld) * ' + p + ' / sum(ld) - 1))'])); }, { limit: 16 }),
            D('par.sched-dynamic', 'par-dyn', 'simulation', '動態與引導式排程：迭代按編號切塊，最早閒下來的執行緒（同時閒取編號小）領下一塊；動態＝每塊 k 個，引導式＝每塊 max(k, ceil(剩餘/p)) 個；輸出完成時間（makespan）或每個執行緒領到的索引',
                [S('kind', '排程', [['dynamic', 'dynamic'], ['guided', 'guided']]), S('out', '輸出', [['makespan', 'makespan'], ['assign', 'assign'], ['chunks', 'chunks']])],
                (c, N) => { need(N, 2); if (N.ls.length < 1) throw new Error('要工作量清單'); const n = N.sc[0], p = N.sc[1], a = N.ls[0], kk = N.sc.length > 2 ? N.sc[2] : '1'; return code(['fin = [0] * ' + p, 'asg = [[] for _ in range(' + p + ')]', 'nc = 0', 's = 0', 'while s < ' + n + ':', c.kind === 'dynamic' ? '    sz = ' + kk : '    sz = max(' + kk + ', (' + n + ' - s + ' + p + ' - 1) // ' + p + ')', '    e = min(' + n + ', s + sz)', '    t = fin.index(min(fin))', '    for i in range(s, e):', '        asg[t].append(i)', '        fin[t] += ' + a + '[i]', '    nc += 1', '    s = e', c.out === 'makespan' ? 'print(max(fin))' : c.out === 'chunks' ? 'print(nc)' : 'for row in asg:\n    print(" ".join(str(x) for x in row))']); }, { limit: 8 }),
            D('par.sched-pick', 'par-pick', 'simulation', '推薦排程：對一組工作量，比較 static（區塊）、cyclic（循環）、dynamic（k=1）、guided（k=1）四種排程的 span，推薦 span 最小者；輸出排程名稱或其 span',
                [S('cand', '候選', [['all4', 'all4'], ['no-guided', 'no-guided']]), S('tie', '平手', [['first', 'first'], ['last', 'last']]), S('out', '輸出', [['name', 'name'], ['span', 'span']])],
                (c, N) => { need(N, 2); if (N.ls.length < 1) throw new Error('要工作量清單'); const n = N.sc[0], p = N.sc[1], a = N.ls[0]; const kinds = c.cand === 'all4' ? '["static", "cyclic", "dynamic", "guided"]' : '["static", "cyclic", "dynamic"]'; return code(['best = ""', 'bs = -1', 'for kd in ' + kinds + ':', '    fin = [0] * ' + p, '    if kd == "static":', '        q, r = divmod(' + n + ', ' + p + ')', '        s = 0', '        for t in range(' + p + '):', '            ln = q + (1 if t < r else 0)', '            fin[t] = sum(' + a + '[s:s + ln])', '            s += ln', '    elif kd == "cyclic":', '        for i in range(' + n + '):', '            fin[i % ' + p + '] += ' + a + '[i]', '    else:', '        s = 0', '        while s < ' + n + ':', '            sz = 1 if kd == "dynamic" else max(1, (' + n + ' - s + ' + p + ' - 1) // ' + p + ')', '            e = min(' + n + ', s + sz)', '            t = fin.index(min(fin))', '            fin[t] += sum(' + a + '[s:e])', '            s = e', '    m = max(fin)', '    if bs < 0 or m ' + (c.tie === 'first' ? '<' : '<=') + ' bs:', '        bs = m', '        best = kd', c.out === 'name' ? 'print(best)' : 'print(bs)']); }, { limit: 8 }),
        ];
        const algos = [
            ['par-pick', /推薦.{0,8}排程|推薦.{0,20}排程|比較.{0,30}排程|挑.{0,6}排程|選.{0,8}排程|最佳排程|哪(一)?種排程|最忙.{0,20}負載最小|best\s*schedule|recommend.{0,12}schedul/i],
            ['par-dyn', /動態排程|引導式|guided|schedule\s*\(\s*(dynamic|guided)|dynamic\s*schedul|dynamic\s*排程|guided\s*排程|領取.{0,8}塊/i],
            ['par-load', /排程.{0,24}(負載|不均衡|最忙|加速比)|(負載|不均衡|加速比).{0,24}排程|不均衡度|load\s*imbalance|最忙.{0,20}負載|每個執行緒.{0,8}負載|執行緒的負載|span|耗時.{0,20}(執行緒|總)|總耗時/i],
            ['par-assign', /(靜態|區塊|循環|分塊循環|cyclic|block|static).{0,4}排程|schedule\s*\(\s*static|索引.{0,10}分給.{0,6}執行緒|分給.{0,4}執行緒/i],
        ].map(([key, re]) => ({ key, re, pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = [sk.paradigm];
        return { id: 'par', label: '平行運算：迴圈排程原語（區塊／循環／動態／引導式）', requires: [], judge: { checker: 'tokens' }, algos, paradigms, skeletons };
    }
    return { make };
});
