'use strict';
const assert = require('assert'); const T = require('./teacher_check_core.js'); let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
t('normalize：種類與大小限制、judge 要有 tests、regex 要合法、字串形式的 JSON 也接受', () => {
    assert.strictEqual(T.normalize(null).check, null); assert.strictEqual(T.normalize({ kind: 'evil' }).ok, false); assert.strictEqual(T.normalize({ kind: 'judge', tests: [] }).ok, false); assert.strictEqual(T.normalize({ kind: 'regex', value: '(' }).ok, false); assert.strictEqual(T.normalize('不是json').ok, false);
    const j = T.normalize('{"kind":"judge","tests":[{"in":"1 2\\n","out":"3\\n"},{"in":5}],"lang":"cobol","checker":"evil"}'); assert.ok(j.ok); assert.strictEqual(j.check.tests.length, 1); assert.strictEqual(j.check.lang, 'python'); assert.strictEqual(j.check.checker, 'tokens');
    assert.strictEqual(T.normalize({ kind: 'judge', lang: 'c', tests: Array.from({ length: 100 }, () => ({ in: 'a', out: 'b' })) }).check.tests.length, 60);
});
t('checkSync：contains／notcontains／regex／equals 的通過與失敗都帶原因；judge 在這裡不能判（要執行環境）', () => {
    assert.ok(T.checkSync({ kind: 'contains', value: 'YES' }, 'x YES y').ok); assert.ok(/沒有/.test(T.checkSync({ kind: 'contains', value: 'YES' }, 'NO').detail));
    assert.ok(T.checkSync({ kind: 'notcontains', value: 'error' }, 'fine').ok); assert.strictEqual(T.checkSync({ kind: 'notcontains', value: 'error' }, 'an error').ok, false);
    assert.ok(T.checkSync({ kind: 'regex', value: '^\\d+$' }, '123').ok); assert.strictEqual(T.checkSync({ kind: 'regex', value: '^\\d+$' }, '12a').ok, false); assert.ok(T.checkSync({ kind: 'equals', value: '42' }, ' 42\n').ok);
    assert.strictEqual(T.checkSync({ kind: 'judge', tests: [] }, 'x').ok, false); assert.ok(T.isJudge({ kind: 'judge' })); assert.ok(!T.isJudge({ kind: 'contains' })); assert.ok(T.checkSync(null, 'x').ok);
});
t('extractCode：工具結果的 JSON（source／code）、最後一個圍欄、純程式碼', () => {
    assert.strictEqual(T.extractCode(JSON.stringify({ ok: true, source: 'print(1)\n' })), 'print(1)\n'); assert.strictEqual(T.extractCode('{"result":{"code":"x=1"}}'), 'x=1');
    assert.strictEqual(T.extractCode('先寫這個\n```python\na=1\n```\n改成這個\n```py\nprint(2)\n```\n'), 'print(2)\n'); assert.strictEqual(T.extractCode('print(3)'), 'print(3)');
});
t('judgeProblem 與 summary', () => { const c = T.normalize({ kind: 'judge', tests: [{ in: 'a', out: 'b' }], hidden: [{ in: 'c', out: 'd' }] }).check; const p = T.judgeProblem(c, '../x y'); assert.strictEqual(p.id, '.._x_y'); assert.strictEqual(p.tests.length, 1); assert.strictEqual(p.hidden.length, 1); assert.ok(/判題器 python（1 筆＋隱藏 1 筆）/.test(T.summary(c))); });
console.log('\n' + n + ' passed, 0 failed');
