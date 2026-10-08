'use strict';
const assert = require('assert'); const B = require('./browser_core.js');
let ok = 0; const bad = []; const t = (n, f) => { try { f(); ok++; } catch (e) { bad.push(n + ': ' + e.message); } };

t('過濾語法：含有／相等／比較', () => {
    assert.deepStrictEqual(B.parseFilter('abc'), { op: 'like', value: 'abc' }); assert.deepStrictEqual(B.parseFilter('=abc'), { op: 'eq', value: 'abc' }); assert.deepStrictEqual(B.parseFilter('<>x'), { op: 'ne', value: 'x' });
    assert.deepStrictEqual(B.parseFilter('>5'), { op: 'gt', value: 5 }); assert.deepStrictEqual(B.parseFilter('>=5.5'), { op: 'ge', value: 5.5 }); assert.deepStrictEqual(B.parseFilter('<5'), { op: 'lt', value: 5 }); assert.deepStrictEqual(B.parseFilter('<=5'), { op: 'le', value: 5 });
});
t('過濾語法：範圍、GLOB、NULL、空白', () => {
    assert.deepStrictEqual(B.parseFilter('3..9'), { op: 'between', value: 3, value2: 9 }); assert.deepStrictEqual(B.parseFilter('*.c'), { op: 'glob', value: '*.c' }); assert.deepStrictEqual(B.parseFilter('NULL'), { op: 'null' }); assert.deepStrictEqual(B.parseFilter('!null'), { op: 'notnull' });
    assert.strictEqual(B.parseFilter('  '), null); assert.strictEqual(B.parseFilter('>'), null);
});
t('過濾語法：/regex/ 只在本頁；壞的 regex 退回含有', () => {
    const f = B.parseFilter('/^a.c$/'); assert.strictEqual(f.local, true); assert.strictEqual(B.parseFilter('/(/').op, 'like');
    const r = B.buildFilters({ a: 'x', b: '/y+/', c: '' }); assert.strictEqual(r.filters.length, 1); assert.strictEqual(r.local.length, 1); assert.ok(r.local[0].regex.test('yy'));
});
t('DDL 預覽', () => {
    assert.strictEqual(B.ddlCreateTable('t', [{ name: 'id', type: 'INTEGER', pk: true, autoinc: true }, { name: 'n', type: 'TEXT', notnull: true, dflt: "'x'" }]), 'CREATE TABLE "t" (\n  "id" INTEGER PRIMARY KEY AUTOINCREMENT,\n  "n" TEXT NOT NULL DEFAULT \'x\'\n);');
    assert.strictEqual(B.ddlAddColumn('t', { name: 'c', type: 'INT' }), 'ALTER TABLE "t" ADD COLUMN "c" INT;'); assert.strictEqual(B.ddlCreateIndex('i', 't', ['a', 'b'], true), 'CREATE UNIQUE INDEX "i" ON "t" ("a", "b");');
    assert.strictEqual(B.ddlRenameColumn('t', 'a', 'b'), 'ALTER TABLE "t" RENAME COLUMN "a" TO "b";'); assert.strictEqual(B.quoteIdent('a"b'), '"a""b"');
});
t('語句分類與危險語句', () => {
    assert.strictEqual(B.classify('  -- c\nselect 1'), 'read'); assert.strictEqual(B.classify('update t set a=1'), 'write'); assert.strictEqual(B.classify('create table x(a)'), 'ddl'); assert.strictEqual(B.classify('pragma user_version=3'), 'write'); assert.strictEqual(B.classify('pragma user_version'), 'read');
    assert.strictEqual(B.isDangerous('select 1').length, 0); assert.strictEqual(B.isDangerous('drop table t').length, 1); assert.strictEqual(B.isDangerous('delete from t').length, 1); assert.strictEqual(B.isDangerous('delete from t where a=1').length, 0);
    assert.strictEqual(B.isDangerous("update t set a='where' ").length, 1);
});
t('儲存格顯示與輸入', () => {
    assert.strictEqual(B.cellDisplay(null).text, 'NULL'); assert.strictEqual(B.cellDisplay({ $blob: 'AQI=' }).text, '[BLOB 2 位元組]'); assert.strictEqual(B.cellDisplay('a\nb').cls, 'long');
    assert.strictEqual(B.parseCellInput('12', 'INTEGER'), 12); assert.strictEqual(B.parseCellInput('', 'INTEGER'), null); assert.strictEqual(B.parseCellInput('1.5', 'REAL'), 1.5); assert.strictEqual(B.parseCellInput('abc', 'TEXT'), 'abc'); assert.deepStrictEqual(B.parseCellInput("x'0102'", 'BLOB'), { $blob: 'AQI=' });
    assert.deepStrictEqual(B.parseCellInput('9223372036854775807', 'INTEGER'), { $int: '9223372036854775807' });
});
t('hexDump、圖片型別', () => { assert.ok(B.hexDump('AQID').startsWith('00000000  01 02 03')); assert.strictEqual(B.imageType('iVBORw0KGgoAAA'), 'image/png'); assert.strictEqual(B.imageType('AAAA'), null); });
t('匯出', () => {
    assert.strictEqual(B.toCsv(['a', 'b'], [[1, 'x,y'], [null, { $blob: 'AA==' }]]), 'a,b\r\n1,"x,y"\r\n,\r\n'); assert.strictEqual(B.toMarkdown(['a'], [['p|q']]), '| a |\n|---|\n| p\\|q |\n'); assert.deepStrictEqual(JSON.parse(B.toJson(['a'], [[{ $int: '5' }]])), [{ a: '5' }]);
});
t('編輯鍵：rowid 優先，其次主鍵，否則不能編輯', () => {
    assert.deepStrictEqual(B.rowKey({ columns: [] }, ['__rowid__', 'a'], [7, 'x'], true), { sql: 'rowid = ?', bind: [7] });
    assert.deepStrictEqual(B.rowKey({ columns: [{ name: 'k', pk: 1 }, { name: 'j', pk: 2 }] }, ['k', 'j', 'v'], [1, 2, 3], false), { sql: '"k" = ? AND "j" = ?', bind: [1, 2] });
    assert.strictEqual(B.rowKey({ columns: [{ name: 'a', pk: 0 }] }, ['a'], [1], false), null);
});
console.log(ok + ' passed, ' + bad.length + ' failed', bad);
