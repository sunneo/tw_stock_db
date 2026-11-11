'use strict';
// 平行排程原語（par_sched_core）：分割性質、已知值、各工作量分布的推薦。
const assert = require('assert'); const S = require('./par_sched_core.js');
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };
for (const kind of ['static', 'cyclic', 'chunked', 'dynamic', 'guided']) for (const n of [0, 1, 7, 10, 33]) for (const p of [1, 2, 3, 4]) for (const k of [1, 3]) {
    const cost = Array.from({ length: n }, (_, i) => 1 + (i * 7) % 5); const a = S.schedule(kind, n, p, k, cost);
    const all = [].concat(...a).sort((x, y) => x - y); ok(all.length === n && all.every((v, i) => v === i), kind + ' n=' + n + ' p=' + p + ' k=' + k + ' 要恰好分完');
    ok(a.length === p, '執行緒數');
}
assert.deepStrictEqual(S.schedule('static', 10, 4), [[0, 1, 2], [3, 4, 5], [6, 7], [8, 9]]); pass++;
assert.deepStrictEqual(S.schedule('cyclic', 7, 3), [[0, 3, 6], [1, 4], [2, 5]]); pass++;
assert.deepStrictEqual(S.schedule('chunked', 10, 2, 3), [[0, 1, 2, 6, 7, 8], [3, 4, 5, 9]]); pass++;
// 動態：工作量 [5,1,1,1,1,1]，p=2，k=1 → 執行緒0 拿 0（5），執行緒1 連拿 1..5
assert.deepStrictEqual(S.schedule('dynamic', 6, 2, 1, [5, 1, 1, 1, 1, 1]), [[0], [1, 2, 3, 4, 5]]); pass++;
// 引導式 n=10 p=2 k=1：塊大小 5,3,1,1，各 5 個
assert.deepStrictEqual(S.schedule('guided', 10, 2, 1).map((x) => x.length), [5, 5]); pass++;
const m = S.metrics([6, 2, 2, 2]); ok(m.work === 12 && m.span === 6 && Math.abs(m.speedup - 2) < 1e-9 && Math.abs(m.imbalance - 1) < 1e-9, '指標');
// 推薦：均勻 → static；遞增 → cyclic 或 dynamic（不是 static）；尾端很重 → dynamic／guided 系
const uni = Array(16).fill(3); ok(S.recommend(uni, 4).best.kind === 'static', '均勻推薦 static');
const inc = Array.from({ length: 16 }, (_, i) => i + 1); ok(S.recommend(inc, 4).best.kind !== 'static', '遞增不推薦 static'); ok(S.classify(inc) === 'increasing', '遞增分類');
const tail = Array.from({ length: 20 }, (_, i) => i >= 18 ? 40 : 1); const rt = S.recommend(tail, 4); ok(S.classify(tail) === 'tail', '尾端分類'); ok(rt.best.span < rt.rows[0].span, '尾端重：推薦的 span 比 static 小');
ok(/schedule\(/.test(S.explain(tail, 4).text), '理由文字');
console.log(pass + ' passed, 0 failed');
