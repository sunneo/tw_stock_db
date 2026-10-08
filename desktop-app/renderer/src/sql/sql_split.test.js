'use strict';
const assert = require('assert');
const S = require('./sql_split.js');
let ok = 0; const bad = []; const t = (name, fn) => { try { fn(); ok++; } catch (e) { bad.push(name + ': ' + e.message); } };

t('基本切分', () => assert.deepStrictEqual(S.split('select 1; select 2;'), ['select 1;', 'select 2;']));
t('最後沒分號也算一句', () => assert.deepStrictEqual(S.split('select 1; select 2'), ['select 1;', 'select 2']));
t('字串裡的分號', () => assert.deepStrictEqual(S.split("insert into t values('a;b'); select 1;"), ["insert into t values('a;b');", 'select 1;']));
t('跳脫的單引號', () => assert.strictEqual(S.split("select 'it''s;ok';").length, 1));
t('雙引號與反引號識別字', () => assert.strictEqual(S.split('select "a;b", `c;d`;').length, 1));
t('註解裡的分號', () => assert.strictEqual(S.split('select 1 -- a;b\n; select /* ; */ 2;').length, 2));
t('觸發器內的分號', () => {
    const sql = 'create trigger tr after insert on t begin insert into log values(new.id); update c set n=n+1; end; select 1;';
    assert.deepStrictEqual(S.split(sql).length, 2); assert.ok(S.split(sql)[0].endsWith('end;'));
});
t('觸發器裡的 CASE … END 不會提早結束', () => {
    const sql = 'create trigger tr after insert on t begin update c set n = case when new.x>0 then 1 else 0 end; end; select 2;';
    assert.strictEqual(S.split(sql).length, 2);
});
t('完整性：缺分號', () => assert.strictEqual(S.isComplete('select 1'), false));
t('完整性：有分號', () => assert.strictEqual(S.isComplete('select 1;'), true));
t('完整性：字串沒關', () => assert.strictEqual(S.isComplete("select 'abc;"), false));
t('完整性：觸發器沒到 END', () => assert.strictEqual(S.isComplete('create trigger tr after insert on t begin select 1;'), false));
t('完整性：空白與註解', () => assert.strictEqual(S.isComplete('  -- hi\n'), true));
t('點指令不屬於 SQL（呼叫端先處理）— 純註解不產生語句', () => assert.deepStrictEqual(S.split('-- only comment\n'), []));
console.log(ok + ' passed, ' + bad.length + ' failed', bad);
