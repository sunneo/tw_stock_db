// node renderer/src/recipe/judge_core.test.js
const J = require('./judge_core.js'); const assert = require('assert');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
t('validateProblem：必要欄位、checker、tests／hidden 的形狀', () => {
  assert.ok(J.validateProblem({ id: 'a-plus-b', tests: [{ in: '1 2', out: '3' }], hidden: [{ in: '0 0', out: '0' }] }).ok);
  assert.ok(!J.validateProblem(null).ok);
  assert.ok(!J.validateProblem({ id: 'x y', tests: [{ in: '', out: '' }] }).ok, 'id 不能有空白');
  assert.ok(!J.validateProblem({ id: 'x', tests: [] }).ok, 'tests 至少一筆');
  assert.ok(!J.validateProblem({ id: 'x', tests: [{ in: 1, out: '1' }] }).ok, 'in 要是字串');
  assert.ok(!J.validateProblem({ id: 'x', tests: [{ in: '', out: '' }], checker: 'magic' }).ok);
  assert.ok(!J.validateProblem({ id: 'x', tests: [{ in: '', out: '' }], hidden: 'no' }).ok);
});
t('compare tokens：空白、換行不敏感；詞數與內容不同要報錯', () => {
  assert.ok(J.compare('3\n', '3').ok); assert.ok(J.compare(' 1   2\n3 ', '1 2 3').ok);
  const r = J.compare('1 2', '1 3'); assert.ok(!r.ok && /第 2 個詞/.test(r.reason));
  assert.ok(!J.compare('1', '1 2').ok);
});
t('compare lines：去行尾空白、忽略結尾空行，但行內空白與行數要對', () => {
  assert.ok(J.compare('a  \nb\n\n\n', 'a\nb', 'lines').ok); assert.ok(J.compare('a\r\nb', 'a\nb', 'lines').ok);
  assert.ok(!J.compare('a b', 'a  b', 'lines').ok, '行內空白不同');
  assert.ok(!J.compare('a\nb\nc', 'a\nb', 'lines').ok);
});
t('compare float：容許誤差，非數字要字串相等', () => {
  assert.ok(J.compare('3.1415927', '3.14159265', 'float', { eps: 1e-6 }).ok);
  assert.ok(!J.compare('3.15', '3.14159265', 'float', { eps: 1e-6 }).ok);
  assert.ok(J.compare('1e3 abc', '1000 abc', 'float').ok); assert.ok(!J.compare('1 abc', '1 abd', 'float').ok);
  assert.ok(J.compare('1000000.5', '1000000.4999999', 'float', { eps: 1e-6 }).ok, '相對誤差');
});
t('compare unordered：多重集合相等（重複的要算）', () => {
  assert.ok(J.compare('0 1', '1 0', 'unordered-tokens').ok); assert.ok(!J.compare('0 0 1', '0 1', 'unordered-tokens').ok);
  assert.ok(J.compare('b\na\n', 'a\nb', 'unordered-lines').ok); assert.ok(!J.compare('a\na', 'a\nb', 'unordered-lines').ok);
});
t('summarize：全過＝AC，取最先出錯那筆的判決，visible 與 hidden 分開計', () => {
  const ok = J.summarize([{ verdict: 'AC', ms: 5 }, { verdict: 'AC', ms: 9, hidden: true }]);
  assert.strictEqual(ok.verdict, 'AC'); assert.strictEqual(ok.passed, 2); assert.deepStrictEqual(ok.visible, { passed: 1, total: 1 }); assert.deepStrictEqual(ok.hidden, { passed: 1, total: 1 }); assert.strictEqual(ok.maxMs, 9);
  const bad = J.summarize([{ verdict: 'AC' }, { verdict: 'TLE', detail: '逾時' }, { verdict: 'WA', detail: 'x' }]);
  assert.strictEqual(bad.verdict, 'TLE'); assert.strictEqual(bad.failedIndex, 1); assert.ok(bad.detail.startsWith('#2 逾時'));
  const hid = J.summarize([{ verdict: 'AC' }, { verdict: 'WA', hidden: true, detail: '溢位' }]);
  assert.strictEqual(hid.verdict, 'WA'); assert.deepStrictEqual(hid.visible, { passed: 1, total: 1 }); assert.deepStrictEqual(hid.hidden, { passed: 0, total: 1 }); assert.ok(hid.detail.indexOf('[hidden]') >= 0, '過擬合訊號要看得出來');
  assert.strictEqual(J.summarize([]).verdict, 'UNAVAILABLE');
});
console.log(n + ' passed');
