/* 領域包：作業系統／同步原語的確定性事件模擬（純函式，不真的開執行緒）。格式見 domain_registry_core.js。
 * 範式：計數信號量（P／V、等待佇列）、互斥鎖（lock／unlock、擁有者、交棒）、條件變數（wait／signal／broadcast）、有限緩衝區生產者消費者。
 * 輸入形狀：「第一行 … q，之後 q 行事件」＝N.g；事件字（wait／P／signal／V／lock…）骨架兩種寫法都認，不靠敘述猜。
 * 差異點（喚醒順序 FIFO／LIFO、信號量值能否為負、解鎖者非擁有者的處理…）是槽位，由沙盒窮舉。骨架不含 def。train／holdout 見 domain_sync.test.js。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainSync = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, paradigm, label, slots, py, extra) => Object.assign({ id, algo, paradigm, label, slots, py }, extra || {});
        const lines = (N) => N.g || N.L[0];
        const q = (s) => JSON.stringify(s);
        const WK = [['fifo', 'fifo'], ['lifo', 'lifo']];
        const POP = (k, arr) => '        ' + k + ' = ' + arr + '.pop(0)' ;
        void POP;
        const skeletons = [
            D('sync.semaphore', 'sync-sem', 'simulation', '計數信號量：初值 s；wait／P 取一個（沒有就排隊阻塞）、signal／V 還一個（有人排隊就喚醒一個）；喚醒順序與輸出由窮舉決定',
                [S('wk', '喚醒', WK), S('out', '輸出', [['order', 'order'], ['blocked', 'blocked'], ['value', 'value'], ['value-neg', 'value-neg']])],
                (c, N) => code(['val = ' + N.sc[0], 'wq = []', 'got = []', 'idx = 0', 'for line in ' + lines(N) + ':', '    p = line.split()', '    if len(p) < 1:', '        continue', '    idx = idx + 1', '    who = p[1] if len(p) > 1 else str(idx)', '    op = p[0].lower()', '    if op in ("wait", "p", "down", "acquire", "sem_wait"):', '        if val > 0:', '            val = val - 1', '            got.append(who)', '        else:', '            wq.append(who)', '    else:', '        if wq:', '            nxt = wq.pop(' + (c.wk === 'fifo' ? '0' : '-1') + ')', '            got.append(nxt)', '        else:', '            val = val + 1', c.out === 'order' ? 'print(" ".join(got))' : c.out === 'blocked' ? 'print(len(wq))' : c.out === 'value' ? 'print(val)' : 'print(val - len(wq))']), { limit: 8 }),
            D('sync.mutex', 'sync-mutex', 'simulation', '互斥鎖：lock t 拿鎖（被占用就排隊）、unlock t 放鎖（擁有者才有效，有人排隊就交棒給下一個）；輸出取得鎖的順序、最後擁有者、被阻塞次數或非法解鎖次數',
                [S('wk', '交棒給', WK), S('out', '輸出', [['order', 'order'], ['owner', 'owner'], ['blocks', 'blocks'], ['bad', 'bad']])],
                (c, N) => code(['owner = None', 'wq = []', 'got = []', 'blocks = 0', 'bad = 0', 'for line in ' + lines(N) + ':', '    p = line.split()', '    if len(p) < 2:', '        continue', '    op = p[0].lower()', '    t = p[1]', '    if op in ("lock", "acquire", "mutex_lock"):', '        if owner is None:', '            owner = t', '            got.append(t)', '        else:', '            blocks = blocks + 1', '            wq.append(t)', '    else:', '        if owner != t:', '            bad = bad + 1', '        elif wq:', '            owner = wq.pop(' + (c.wk === 'fifo' ? '0' : '-1') + ')', '            got.append(owner)', '        else:', '            owner = None', c.out === 'order' ? 'print(" ".join(got))' : c.out === 'owner' ? 'print(owner if owner is not None else "none")' : c.out === 'blocks' ? 'print(blocks)' : 'print(bad)']), { limit: 8 }),
            D('sync.condvar', 'sync-cond', 'simulation', '條件變數：wait t 睡眠排隊、signal 喚醒一個、broadcast 喚醒全部（沒人在等就白費）；輸出被喚醒的順序、最後還在等的人數或白費的 signal 次數',
                [S('wk', 'signal 喚醒', WK), S('out', '輸出', [['woken', 'woken'], ['waiting', 'waiting'], ['lost', 'lost']])],
                (c, N) => code(['wq = []', 'woken = []', 'lost = 0', 'for line in ' + lines(N) + ':', '    p = line.split()', '    if len(p) < 1:', '        continue', '    op = p[0].lower()', '    if op in ("wait", "cond_wait"):', '        if len(p) > 1:', '            wq.append(p[1])', '    elif op in ("signal", "notify", "cond_signal"):', '        if wq:', '            woken.append(wq.pop(' + (c.wk === 'fifo' ? '0' : '-1') + '))', '        else:', '            lost = lost + 1', '    elif op in ("broadcast", "notify_all", "cond_broadcast"):', '        if wq:', '            woken.extend(wq if ' + q(c.wk) + ' == "fifo" else wq[::-1])', '            wq = []', '        else:', '            lost = lost + 1', c.out === 'woken' ? 'print(" ".join(woken))' : c.out === 'waiting' ? 'print(len(wq))' : 'print(lost)']), { limit: 8 }),
            D('sync.prodcons', 'sync-prodcons', 'simulation', '有限緩衝區生產者消費者：容量 cap；produce x 放入（滿了就阻塞，等有空位再進）、consume 取出（空了就阻塞，等有貨再拿）；輸出被取走的物品順序、最後緩衝區大小或最後阻塞數',
                [S('out', '輸出', [['taken', 'taken'], ['size', 'size'], ['blocked', 'blocked']])],
                (c, N) => code(['cap = ' + N.sc[0], 'buf = []', 'pend = []', 'cw = 0', 'taken = []', 'for line in ' + lines(N) + ':', '    p = line.split()', '    if len(p) < 1:', '        continue', '    op = p[0].lower()', '    if op in ("produce", "put", "push", "add"):', '        if cw > 0:', '            cw = cw - 1', '            taken.append(p[1])', '        elif len(buf) < cap:', '            buf.append(p[1])', '        else:', '            pend.append(p[1])', '    else:', '        if buf:', '            taken.append(buf.pop(0))', '            if pend:', '                buf.append(pend.pop(0))', '        else:', '            cw = cw + 1', c.out === 'taken' ? 'print(" ".join(taken))' : c.out === 'size' ? 'print(len(buf))' : 'print(len(pend) + cw)']), { limit: 4 }),
        ];
        const algos = [
            ['sync-prodcons', /生產者.{0,6}消費者|有限緩衝|bounded\s*buffer|producer.{0,8}consumer/i],
            ['sync-cond', /條件變數|condition\s*variable|cond_wait|pthread_cond/i],
            ['sync-mutex', /互斥鎖|mutex|互斥量|pthread_mutex/i],
            ['sync-sem', /信號量|訊號量|semaphore|[PV]\s*操作|sem_wait/i],
        ].map(([key, re]) => ({ key, re, pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = [sk.paradigm];
        return { id: 'sync', label: '作業系統：同步原語事件模擬', requires: [], judge: { checker: 'tokens' }, algos, paradigms, skeletons };
    }
    return { make };
});
