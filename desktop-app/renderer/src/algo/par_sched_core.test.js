'use strict';
// par_sched_core.js 的單元測試：每種排程都要把 0..n-1 恰好分一次、區塊／循環的公式、metrics 與 recommend 的數字可驗證。
const assert = require('assert'), S = require('./par_sched_core.js');
let seed = 77; const rnd = (a, b) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return a + ((seed >> 8) % (b - a + 1)); };
let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
// 1) 分割是劃分：每個索引恰好出現一次
for (let t = 0; t < 300; t++) {
    const N = rnd(0, 30), P = rnd(1, 6), K = rnd(1, 5), cost = Array.from({ length: N }, () => rnd(1, 9));
    for (const [kind, k] of S.CANDS) {
        const rows = S.schedule(kind, N, P, k, cost); const all = rows.flat().sort((a, b) => a - b);
        ok(rows.length === P, kind + ' 執行緒數');
        ok(JSON.stringify(all) === JSON.stringify([...Array(N).keys()]), kind + ' 不是劃分 n=' + N + ' p=' + P);
    }
    for (const kind of ['dynamic', 'guided']) { const rows = S.schedule(kind, N, P, K, cost); ok(JSON.stringify(rows.flat().sort((a, b) => a - b)) === JSON.stringify([...Array(N).keys()]), kind + ' 劃分'); }
}
// 2) 區塊（static）：連續、前 n%p 個多一個
ok(JSON.stringify(S.schedule('static', 7, 3, 1)) === JSON.stringify([[0, 1, 2], [3, 4], [5, 6]]), 'static 7/3');
ok(JSON.stringify(S.schedule('static', 2, 4, 1)) === JSON.stringify([[0], [1], [], []]), 'static 空執行緒');
// 3) 循環：i mod p；分塊循環 k=2 p=2：[0,1]→0、[2,3]→1、[4,5]→0
ok(JSON.stringify(S.schedule('cyclic', 5, 2, 1)) === JSON.stringify([[0, 2, 4], [1, 3]]), 'cyclic');
ok(JSON.stringify(S.schedule('chunked', 6, 2, 2)) === JSON.stringify([[0, 1, 4, 5], [2, 3]]), 'chunked k=2');
// 4) 動態：工作量 [5,1,1,1]、p=2、k=1：執行緒0 領 5（fin 5），執行緒1 領 1、1、1（fin 3）
ok(JSON.stringify(S.schedule('dynamic', 4, 2, 1, [5, 1, 1, 1])) === JSON.stringify([[0], [1, 2, 3]]), 'dynamic 事件模擬');
// 5) 引導式：n=10,p=2,k=1，第一塊 ceil(10/2)=5（取 0..4），剩 5 迭代塊 3，…
const g = S.schedule('guided', 10, 2, 1); ok(g[0][0] === 0 && g.flat().length === 10, 'guided 第一塊');
// 6) metrics：work、span、speedup、imbalance
const m = S.metrics([6, 2]); ok(m.work === 8 && m.span === 6 && Math.abs(m.speedup - 8 / 6) < 1e-12 && Math.abs(m.imbalance - 0.5) < 1e-12, 'metrics');
ok(S.metrics([4, 4]).imbalance === 0, '均衡時不均衡度為 0');
// 7) recommend：span 最小者；平手依 CANDS 順序（static 先）
const rec = S.recommend([1, 1, 1, 1], 2); ok(rec.best.kind === 'static', '全相等時推薦 static');
const rec2 = S.recommend([1, 1, 1, 1, 1, 1, 1, 1, 1, 50], 2); ok(rec2.best.span <= Math.min(...rec2.rows.map((r) => r.span)), 'recommend 不是最小 span');
// 8) classify 分布分類
ok(S.classify([3, 3, 3, 3]) === 'uniform' && S.classify([1, 2, 3, 4, 5]) === 'increasing' && S.classify([5, 4, 3, 2, 1]) === 'decreasing', 'classify 單調');
ok(S.classify([1, 9, 1, 1, 1, 1, 1, 1, 1, 60]) === 'tail', 'classify 尾端重');
console.log(n + ' 項斷言通過（par_sched_core）'); console.log(n + ' passed, 0 failed');
