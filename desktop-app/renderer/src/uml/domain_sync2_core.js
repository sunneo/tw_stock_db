/* 領域包：作業系統／同步原語第二批（純函式，Python 專屬）。格式見 domain_registry_core.js。
 * 範式：哲學家用餐（事件模擬：每個事件讓某位哲學家往前一步；以及「同時最多幾位能吃」）、死結偵測（等待圖／資源配置圖找環；多個實例的 Allocation／Request 矩陣偵測）。
 * 輸入形狀：事件序列＝「之後 q 行事件」（N.g）或 q 行文字；邊表＝rows（整數）或 lines（P1 R1 這種有名字的節點）；
 *           Available 那一行沒寫幾個整數時，長度由讀取器從第一行沒被當行數用的那個整數推（algo_intent_core.js 的通用規則，唯一時才推）。
 * 差異點（先拿左或右筷子、奇偶不同、編號從幾開始、只算行程節點、沒有死結時印什麼、零配置的行程算不算已完成）是槽位，由沙盒窮舉；骨架不含 def。
 * train／holdout 見 domain_sync2.test.js。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainSync2 = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, paradigm, label, slots, py, extra) => Object.assign({ id, algo, paradigm, label, slots, py }, extra || {});
        const q = (s) => JSON.stringify(s);
        const need = (v, what) => { if (v === undefined || v === null || v === '') throw new Error('抽不到' + what); return v; };
        const ynOf = (I) => { if (I.facts && I.facts.yn) return I.facts.yn; const m = /輸出\s*([^\s，,。；]+?)\s*[，,]\s*(?:否則|不然|其餘)\s*(?:輸出|印)?\s*([^\s，,。；]+)/.exec(String(I.statement)); if (m) return [m[1], m[2]]; const m2 = /輸出\s*([A-Z][A-Z_]{1,})[^輸]{0,16}輸出\s*([A-Z][A-Z_]{1,})/.exec(String(I.statement)); return m2 ? [m2[1], m2[2]] : ['YES', 'NO']; };
        const BASE = S('base', '編號從幾開始', [['0', '0'], ['1', '1']]);
        const EMPTY = S('empty', '沒有時印', [['blank', 'blank'], ['none', 'none'], ['-1', '-1']]);
        const emp = (c) => (c.empty === 'none' ? '"none"' : c.empty === 'blank' ? '""' : '-1');
        const skeletons = [
            D('sync2.philosophers', 'philo-sim', 'simulation', '哲學家用餐事件模擬：n 位哲學家圍桌，筷子 i 在哲學家 i 與 i+1（環狀）之間；每位的流程是拿第一支筷子、拿第二支筷子、吃完放下兩支（一餐）；每個事件讓指定的哲學家往前一步，需要的筷子被別人拿著就卡住（事件白費）；輸出總餐數、每人餐數、是否死結（每人都握著第一支筷子）或完成餐點的順序',
                [BASE, S('first', '先拿哪支', [['left', 'left'], ['right', 'right'], ['alt', 'alt']]), S('out', '輸出', [['meals', 'meals'], ['per', 'per'], ['dead', 'dead'], ['order', 'order']])],
                (c, N, I) => { const n = need(N.sc[0], '哲學家人數 n'), ev = need(N.g || N.L[0], '事件行'); const yn = ynOf(I);
                    const fst = c.first === 'left' ? 'i' : c.first === 'right' ? '(i + 1) % ' + n : 'i if i % 2 == 0 else (i + 1) % ' + n, snd = c.first === 'left' ? '(i + 1) % ' + n : c.first === 'right' ? 'i' : '(i + 1) % ' + n + ' if i % 2 == 0 else i';
                    const o = { meals: 'print(sum(meals))', per: 'print(*meals)', dead: 'print(' + q(yn[0]) + ' if all(st[i] == 1 for i in range(' + n + ')) else ' + q(yn[1]) + ')', order: 'print(*order)' }[c.out];
                    return code(['hold = [-1] * ' + n, 'st = [0] * ' + n, 'meals = [0] * ' + n, 'order = []', 'for line in ' + ev + ':', '    p = line.split()', '    if len(p) < 1:', '        continue', '    i = int(p[0]) - ' + c.base, '    a = ' + fst, '    b = ' + snd, '    if st[i] == 0:', '        if hold[a] == -1:', '            hold[a] = i', '            st[i] = 1', '    elif st[i] == 1:', '        if hold[b] == -1:', '            hold[b] = i', '            st[i] = 2', '    else:', '        hold[a] = -1', '        hold[b] = -1', '        st[i] = 0', '        meals[i] += 1', '        order.append(i + ' + c.base + ')', o]); }, { limit: 24 }),
            D('sync2.philo-max', 'philo-max', 'search', '哲學家同時最多幾位能吃：相鄰的哲學家共用一支筷子，不能同時吃；只有想吃的人才可能吃；枚舉所有子集，取沒有兩位相鄰者的最大子集大小（環狀）；想吃的人用 0/1 旗標或編號列表給',
                [BASE, S('form', '想吃的人怎麼給', [['flags', 'flags'], ['ids', 'ids']])],
                (c, N) => { const n = need(N.sc[0], '哲學家人數 n'), a = need(N.ls[0], '想吃的人'); const hungry = c.form === 'flags' ? '[i for i in range(' + n + ') if ' + a + '[i] == 1]' : '[x - ' + c.base + ' for x in ' + a + ']';
                    return code(['hungry = ' + hungry, 'best = 0', 'for mask in range(1 << len(hungry)):', '    pick = [hungry[j] for j in range(len(hungry)) if (mask >> j) & 1]', '    ok = True', '    for x in pick:', '        if (x + 1) % ' + n + ' in pick and (x + 1) % ' + n + ' != x:', '            ok = False', '    if ok:', '        best = max(best, len(pick))', 'print(best)']); }, { limit: 4 }),
            D('sync2.deadlock-graph', 'deadlock-graph', 'graph-traversal', '死結偵測（等待圖／資源配置圖找環）：有向邊 u→v（行程等行程，或行程要資源、資源給行程）；有環就有死結；能走回自己的節點就在環上；輸出有沒有死結、環上節點數（可只算行程）或環上節點列表',
                [S('out', '輸出', [['yn', 'yn'], ['count', 'count'], ['list', 'list']]), S('only', '計算的節點', [['all', 'all'], ['proc', 'proc']]), EMPTY],
                (c, N, I) => { const raw = N.L[0] && !N.ls[0]; const E = need(raw ? N.L[0] : N.ls[0], '邊表'); const yn = ynOf(I);
                    const rd = raw ? ['    p = e.split()'] : ['    p = [str(t) for t in e]'];
                    const flt = c.only === 'proc' ? ['cyc = [x for x in cyc if x[0] in "Pp"]'] : [];
                    const o = c.out === 'yn' ? 'print(' + q(yn[0]) + ' if cyc else ' + q(yn[1]) + ')' : c.out === 'count' ? 'print(len(cyc))' : 'print(" ".join(cyc) if cyc else ' + emp(c) + ')';
                    return code(['adj = {}', 'for e in ' + E + ':'].concat(rd, ['    adj.setdefault(p[0], []).append(p[1])', '    adj.setdefault(p[1], [])', 'cyc = []', 'for x in sorted(adj, key=lambda z: (len(z), z)):', '    seen = set()', '    st = list(adj[x])', '    while st:', '        y = st.pop()', '        if y not in seen:', '            seen.add(y)', '            st.extend(adj[y])', '    if x in seen:', '        cyc.append(x)'], flt, [o])); }, { limit: 18 }),
            D('sync2.deadlock-detect', 'deadlock-detect', 'simulation', '死結偵測（多個實例，Available／Allocation／Request 矩陣）：反覆找一個目前請求能被可用資源滿足的行程，讓它跑完並歸還它配置的資源；最後還沒完成的行程就是死結的行程；輸出死結行程列表、個數或有沒有死結',
                [S('ord', '兩個矩陣的順序', [['alloc-req', 'alloc-req'], ['req-alloc', 'req-alloc']]), S('zero', '沒配置任何資源的行程', [['done', 'done'], ['normal', 'normal']]), S('out', '輸出', [['list', 'list'], ['count', 'count'], ['yn', 'yn']]), BASE, EMPTY],
                (c, N, I) => { const n = N.sc[0], m = N.sc[1], av = N.ls[0], A = N.L[0], B = N.L[1]; if (!n || !m || !av || !A || !B) throw new Error('死結偵測要有 n m、可用向量、兩個矩陣'); const yn = ynOf(I);
                    const L = ['al = [list(map(int, s.split())) for s in ' + A + ']', 'rq = [list(map(int, s.split())) for s in ' + B + ']']; if (c.ord === 'req-alloc') L.push('al, rq = rq, al');
                    L.push('work = list(' + av + ')', 'fin = [' + (c.zero === 'done' ? 'sum(al[i]) == 0' : 'False') + ' for i in range(' + n + ')]', 'prog = True', 'while prog:', '    prog = False', '    for i in range(' + n + '):', '        if not fin[i] and all(rq[i][j] <= work[j] for j in range(' + m + ')):', '            for j in range(' + m + '):', '                work[j] = work[j] + al[i][j]', '            fin[i] = True', '            prog = True', 'dead = [i + ' + c.base + ' for i in range(' + n + ') if not fin[i]]');
                    L.push(c.out === 'list' ? 'print(*dead if dead else [' + emp(c) + '])' : c.out === 'count' ? 'print(len(dead))' : 'print(' + q(yn[0]) + ' if dead else ' + q(yn[1]) + ')'); return code(L); }, { limit: 72 }),
        ];
        const algos = [
            ['philo-max', /哲學家[\s\S]{0,60}(?:同時|最多)[\s\S]{0,20}(?:幾|多少)(?:位|個|人)|(?:同時|最多)[\s\S]{0,12}(?:幾|多少)(?:位|個|人)[\s\S]{0,12}(?:吃|用餐)/i],
            ['philo-sim', /哲學家|dining\s*philosophers?|筷子/i],
            ['deadlock-detect', /(?:死結|死鎖|deadlock)[\s\S]*(?:Allocation|Request|已配置|請求矩陣)|(?:Allocation|Request|已配置|請求矩陣)[\s\S]*(?:死結|死鎖|deadlock)/i, /Max\b|最大需求|銀行家|安全序列|安全狀態/i],
            ['deadlock-graph', /死結|死鎖|deadlock|資源配置圖|等待圖|wait[\s-]*for\s*graph/i, /Max\b|最大需求|銀行家|安全序列|安全狀態/i],
        ].map(([key, re, veto]) => (veto ? { key, re, pri: true, veto } : { key, re, pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = [sk.paradigm];
        return { id: 'sync2', label: '作業系統：哲學家用餐、死結偵測', requires: [], judge: { checker: 'tokens' }, algos, paradigms, skeletons };
    }
    return { make };
});
