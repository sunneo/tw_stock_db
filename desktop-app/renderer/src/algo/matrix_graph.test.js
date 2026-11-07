'use strict';
// 矩陣層 graph／grid 模組的回歸：
//  - heldout2（被範本「吃掉」的第二批，只當回歸下限）：verified ≥ 20/22。
//  - heldout3（graph／grid 模組做完後另寫的第三批；第一次量測 13/21，修三個通用缺口 15/21，之後補了 6 個題型 → 21/21）。
//  - heldout3 補了出度／入度／連通分量／MST／每列欄最值／方陣乘法冪跡之後變 21/21（已被吃掉，只當回歸）；heldout4（再換一輪措辭＋5 題新題型）：第一次 13/19，修「第一行為 n m」後 14/19 verified；
//    5 題新題型（二分圖、奇度數個數、對角線和、對稱判斷、行列式）必須誠實回 ok:false。
//  - 邊界：形狀不認得時要明確失敗；沒有範例要明確失敗。
const assert = require('assert'), fs = require('fs'), path = require('path');
const S = require('./matrix_synth_core.js'); const G = require('./matrix_graph_core.js'); const L0 = require('./matrix_l0_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
assert.strictEqual(G.install(S), true); assert.strictEqual(L0.install(S), true); const names = S.list().map((x) => x.name); assert.ok(names.includes('graph') && names.includes('grid'), '模組有註冊'); assert.ok(names.indexOf('graph') < names.indexOf('formula'), 'graph 要排在公式枚舉之前');
const dir = path.join(__dirname, '..', 'recipe', 'seed'); const load = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
async function run(f) { const out = []; for (const p of load(f)) { const ex = p.tests.slice(0, 2), hid = p.tests.slice(2).concat(p.hidden || []); const problem = { id: p.id, tests: ex, hidden: hid, checker: p.checker || 'tokens' }; const r = await S.synth({ statement: p.statement, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } }); out.push({ id: p.id, ok: r.ok, verified: !!r.verified }); } return out; }
(async () => {
    const h2 = await run('heldout2_graph.jsonl'); const v2 = h2.filter((x) => x.verified).length; console.log('heldout2 verified ' + v2 + '/' + h2.length); assert.ok(v2 >= 20, 'heldout2 回歸下限 20：' + v2);
    const h3 = await run('heldout3_graph.jsonl'); const v3 = h3.filter((x) => x.verified).length; console.log('heldout3 verified ' + v3 + '/' + h3.length); assert.ok(v3 >= 21, 'heldout3 回歸下限 21：' + v3);
    const h4 = await run('heldout4_graph.jsonl'); const v4 = h4.filter((x) => x.verified).length; console.log('heldout4 verified ' + v4 + '/' + h4.length); assert.ok(v4 >= 14, 'heldout4 下限 14：' + v4);
    for (const id of ['h4-bipartite', 'h4-euler-deg', 'h4-diag-sum', 'h4-symmetric', 'h4-det']) { const x = h4.find((y) => y.id === id); assert.ok(x && !x.ok, id + ' 範本庫沒有，必須誠實失敗'); }
        // heldout5（L0：條件判斷／多輸出／小數）：基線 0/12；modules 後 7/12 合成成功、4 verified（另 3 題是範例太少湊出的 ambiguous，不算 verified）；
    // 5 題範本沒有的題型（gcd、階乘、冪取模、兩數和奇偶）必須誠實失敗，不能被說成 verified。
    const h5 = await run('heldout5_l0.jsonl'); const v5 = h5.filter((y) => y.verified).length; console.log('heldout5 verified ' + v5 + '/' + h5.length); assert.ok(v5 >= 4, 'heldout5 下限 4：' + v5);
    for (const id of ['h5-gcd', 'h5-fact', 'h5-powmod', 'h5-sum-parity']) { const y = h5.find((z) => z.id === id); assert.ok(y && !y.verified, id + ' 不能是 verified'); }
    const bad = await S.synth({ statement: '輸入一些東西，輸出答案。', examples: [{ in: '1 2\n3 4\n', out: '5\n' }] }); assert.ok(!bad.ok || !bad.verified, '不認得的形狀不能被說成 verified');
    const none = await G.synthGraph({ statement: '第一行 n m，接著 m 行 u v。', examples: [] }); assert.strictEqual(none.ok, false);
    console.log('7 passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
