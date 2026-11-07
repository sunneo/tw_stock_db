'use strict';
// 矩陣層 graph／grid 模組的回歸：
//  - heldout2（被範本「吃掉」的第二批，只當回歸下限）：verified ≥ 20/22。
//  - heldout3（graph／grid 模組做完後另寫的第三批；修掉三個通用小缺口後的數字）：verified ≥ 15/21；
//    其中 6 題刻意是範本庫沒有的題型（出度、最小生成樹、連通分量個數、每列最大值、方陣乘法、方陣冪的跡），必須誠實回 ok:false，不能硬湊。
//  - 邊界：形狀不認得時要明確失敗；沒有範例要明確失敗。
const assert = require('assert'), fs = require('fs'), path = require('path');
const S = require('./matrix_synth_core.js'); const G = require('./matrix_graph_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
assert.strictEqual(G.install(S), true); const names = S.list().map((x) => x.name); assert.ok(names.includes('graph') && names.includes('grid'), '模組有註冊'); assert.ok(names.indexOf('graph') < names.indexOf('formula'), 'graph 要排在公式枚舉之前');
const dir = path.join(__dirname, '..', 'recipe', 'seed'); const load = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
async function run(f) { const out = []; for (const p of load(f)) { const ex = p.tests.slice(0, 2), hid = p.tests.slice(2).concat(p.hidden || []); const problem = { id: p.id, tests: ex, hidden: hid, checker: p.checker || 'tokens' }; const r = await S.synth({ statement: p.statement, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } }); out.push({ id: p.id, ok: r.ok, verified: !!r.verified }); } return out; }
(async () => {
    const h2 = await run('heldout2_graph.jsonl'); const v2 = h2.filter((x) => x.verified).length; console.log('heldout2 verified ' + v2 + '/' + h2.length); assert.ok(v2 >= 20, 'heldout2 回歸下限 20：' + v2);
    const h3 = await run('heldout3_graph.jsonl'); const v3 = h3.filter((x) => x.verified).length; console.log('heldout3 verified ' + v3 + '/' + h3.length); assert.ok(v3 >= 15, 'heldout3 下限 15：' + v3);
    for (const id of ['h3-outdeg', 'h3-mst', 'h3-comp-count', 'h3-row-max', 'h3-matmul', 'h3-trace-pow']) { const x = h3.find((y) => y.id === id); assert.ok(x && !x.ok, id + ' 範本庫沒有，必須誠實失敗'); }
    const bad = await S.synth({ statement: '輸入一些東西，輸出答案。', examples: [{ in: '1 2\n3 4\n', out: '5\n' }] }); assert.ok(!bad.ok || !bad.verified, '不認得的形狀不能被說成 verified');
    const none = await G.synthGraph({ statement: '第一行 n m，接著 m 行 u v。', examples: [] }); assert.strictEqual(none.ok, false);
    console.log('7 passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
