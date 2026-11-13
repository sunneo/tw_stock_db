// node renderer/src/studio/lora_scope.test.js —— 適用範圍（scope）與單邊退化（§32.2）：範圍外的組不計入把關；正例或負例全錯都算退化
const R = require('./lora_registry_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); } };

// 1. 範圍外的輸組不擋把關（decompose：think_stack 輸、範圍內全贏）
const dec = { groups: {
  'fn_template/code_split': { adapter: 23, base: 0, n: 60 },
  'uml/edit_real': { adapter: 30, base: 18, n: 30 },
  'think_stack/plan_check': { adapter: 0, base: 5, n: 60, scope: 'out' },
} };
const v1 = R.evalVerdict(dec);
check('範圍外的輸組不計入 lose', v1.lose.length === 0, v1);
check('範圍外的組列在 outOfScope', v1.outOfScope.indexOf('think_stack/plan_check') >= 0, v1);
check('範圍內全贏 → 把關通過', R.gateOf(dec).pass === true, R.gateOf(dec));
// 2. 範圍內輸組仍擋
const dec2 = { groups: { 'uml/edit_real': { adapter: 10, base: 18, n: 30 }, 'think_stack/x': { adapter: 0, base: 5, n: 60, scope: 'out' } } };
check('範圍內輸組仍不通過', R.gateOf(dec2).pass === false && /uml\/edit_real/.test(R.gateOf(dec2).reason), R.gateOf(dec2));
// 3. 範圍外的組不列入 win、degenerate、noData
const dec3 = { groups: { 'a/x': { adapter: 9, base: 0, n: 30 }, 'think_stack/y': { adapter: 0, base: 0, n: 60, scope: 'out' } } };
const v3 = R.evalVerdict(dec3);
check('範圍外的無資料不列入 noData', v3.noData.length === 0 && v3.win.indexOf('a/x') >= 0, v3);
// 4. 單邊退化：正例全錯（pos.tuned==0）也算退化（原本只擋負例全錯）
const sv = { groups: { 'think_stack/self_validate': { adapter: 30, base: 0, n: 60, neg: { n: 39, base: 0, tuned: 30 }, pos: { n: 21, base: 0, tuned: 0 } } } };
const v4 = R.evalVerdict(sv);
check('正例全錯 → 退化，不算贏', v4.degenerate.indexOf('think_stack/self_validate') >= 0 && v4.win.length === 0, v4);
check('正例全錯 → 把關不通過，原因寫明', R.gateOf(sv).pass === false && /退化/.test(R.gateOf(sv).reason || JSON.stringify(R.gateOf(sv))), R.gateOf(sv));
// 5. 負例全錯仍是退化（既有行為）
const sv2 = { groups: { g: { adapter: 21, base: 0, n: 60, neg: { n: 39, base: 0, tuned: 0 }, pos: { n: 21, base: 0, tuned: 21 } } } };
check('負例全錯 → 退化（不變）', R.evalVerdict(sv2).degenerate.indexOf('g') >= 0);
// 6. 乾淨（正負都有對）→ 贏
const sv3 = { groups: { g: { adapter: 40, base: 0, n: 60, neg: { n: 39, base: 0, tuned: 20 }, pos: { n: 21, base: 0, tuned: 20 } } } };
check('正負都有對 → 贏', R.evalVerdict(sv3).win.indexOf('g') >= 0);
// 7. 整體 DO NOT SHIP 的判定：範圍外組存在時不當成擋下的原因（判定含範圍外目標組）
const sv4 = { groups: { 'uml/x': { adapter: 30, base: 18, n: 30 }, 'think_stack/p': { adapter: 0, base: 0, n: 60, scope: 'out' } }, verdict: { ship: false, not_winning: ['think_stack/p'] } };
check('範圍外的 not_winning 不擋', R.gateOf(sv4).pass === true, R.gateOf(sv4));
// 8. n < 20 只報告：不計入輸贏（§18.2）
{
  const small = { groups: { 'group/git': { adapter: 0, base: 2, n: 3 }, 'big/x': { adapter: 30, base: 10, n: 40 } } };
  const v = R.evalVerdict(small);
  check('n<20 的輸組不擋把關', R.gateOf(small).pass === true, R.gateOf(small));
  check('n<20 列在 smallN', v.smallN.indexOf('group/git') >= 0 && v.lose.length === 0, v);
  console.log('（n<20 測試完成）');
}
console.log('lora_scope 測試：通過 ' + ok + '、失敗 ' + bad);
if (bad) process.exit(1);
