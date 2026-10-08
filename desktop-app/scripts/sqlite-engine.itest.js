'use strict';
// SQLite 引擎整合測試。需要 node:sqlite（Node 22.5+ 或 Electron 內建的 Node）：
//   ELECTRON_RUN_AS_NODE=1 <Electron 執行檔> scripts/sqlite-engine.itest.js
// 本機的 Node 太舊時自動略過（run-core-tests 仍然全過）。
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
try { require('node:sqlite'); } catch (_) { console.log('0 passed, 0 failed [] (略過：這個 Node 沒有 node:sqlite)'); process.exit(0); }
const { SqliteEngine } = require('../sqlite-engine.js');
let ok = 0; const bad = [];
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sql-'));
const E = new SqliteEngine({ timeoutMs: 8000 });
const call = (op, args) => E.call(op, args);

t('建立資料庫、建表、寫入、查詢', async () => {
    const o = await call('open', { path: path.join(tmp, 'a.db'), mode: 'new' }); assert.ok(o.db && /^3\./.test(o.version));
    const r = await call('exec', { db: o.db, sql: "create table t(id integer primary key, name text, v real, b blob); insert into t(name,v,b) values('a',1.5,x'0102'),('b',null,null); select * from t order by id;" });
    assert.strictEqual(r.results.length, 3); assert.strictEqual(r.results[1].changes, 2);
    assert.deepStrictEqual(r.results[2].columns, ['id', 'name', 'v', 'b']); assert.deepStrictEqual(r.results[2].rows[0], [1, 'a', 1.5, { $blob: 'AQI=' }]); assert.strictEqual(r.results[2].rows[1][2], null);
    await call('close', { db: o.db });
});
t('大整數不失真、BLOB 往返', async () => {
    const o = await call('open', { path: ':memory:' });
    await call('exec', { db: o.db, sql: 'create table n(x integer, y blob)' });
    await call('exec', { db: o.db, sql: 'insert into n values(?,?)', bind: [{ $int: '9223372036854775807' }, { $blob: 'AAEC' }] });
    const r = await call('exec', { db: o.db, sql: 'select x,y from n' }); assert.deepStrictEqual(r.results[0].rows[0], [{ $int: '9223372036854775807' }, { $blob: 'AAEC' }]);
    await call('close', { db: o.db });
});
t('語句錯誤只回報那一句，前面的結果保留', async () => {
    const o = await call('open', { path: ':memory:' });
    const r = await call('exec', { db: o.db, sql: 'select 1; select * from nope; select 3;' }); assert.strictEqual(r.results.length, 2); assert.ok(/no such table/.test(r.results[1].error));
    await call('close', { db: o.db });
});
t('觸發器與分號切分', async () => {
    const o = await call('open', { path: ':memory:' });
    await call('exec', { db: o.db, sql: 'create table a(x); create table log(n); create trigger tr after insert on a begin insert into log values(new.x); insert into log values(-1); end; insert into a values(5);' });
    const r = await call('exec', { db: o.db, sql: 'select count(*) from log' }); assert.strictEqual(r.results[0].rows[0][0], 2);
    await call('close', { db: o.db });
});
t('結果列數上限與 truncated', async () => {
    const o = await call('open', { path: ':memory:' });
    await call('exec', { db: o.db, sql: 'create table n(x); with recursive c(i) as (select 1 union all select i+1 from c where i<500) insert into n select i from c;' });
    const r = await call('exec', { db: o.db, sql: 'select * from n', limit: 100 }); assert.strictEqual(r.results[0].rows.length, 100); assert.strictEqual(r.results[0].truncated, true);
    await call('close', { db: o.db });
});
t('瀏覽用 query：過濾、排序、總數、rowid', async () => {
    const o = await call('open', { path: ':memory:' });
    await call('exec', { db: o.db, sql: "create table p(name text, n int); insert into p values('apple',3),('apricot',5),('banana',7),('Cherry',1);" });
    let r = await call('query', { db: o.db, table: 'p', filters: [{ col: 'name', op: 'like', value: 'ap' }], sort: [{ col: 'n', desc: true }] });
    assert.deepStrictEqual(r.rows.map((x) => x[1]), ['apricot', 'apple']); assert.strictEqual(r.total, 2); assert.strictEqual(r.hasRowid, true); assert.strictEqual(r.columns[0], '__rowid__');
    r = await call('query', { db: o.db, table: 'p', filters: [{ col: 'n', op: 'between', value: 3, value2: 6 }] }); assert.strictEqual(r.total, 2);
    r = await call('query', { db: o.db, table: 'p', filters: [{ col: 'name', op: 'like', value: "x'; drop table p;--" }] }); assert.strictEqual(r.total, 0);
    r = await call('query', { db: o.db, table: 'p' }); assert.strictEqual(r.total, 4);
    await call('close', { db: o.db });
});
t('schema：表、欄位、索引、檢視、觸發器、FTS5', async () => {
    const o = await call('open', { path: ':memory:' });
    await call('exec', { db: o.db, sql: "create table t(id integer primary key, a text not null default 'x'); create index ia on t(a); create view v as select a from t; create virtual table f using fts5(body); insert into f values('hello world');" });
    const s = await call('schema', { db: o.db }); assert.ok(s.tables.some((x) => x.name === 't' && x.columns[0].pk === 1 && x.rows === 0)); assert.ok(s.indices.some((x) => x.name === 'ia')); assert.ok(s.views.some((x) => x.name === 'v'));
    assert.ok(s.tables.find((x) => x.name === 'f').virtual);
    const r = await call('exec', { db: o.db, sql: "select rowid from f where f match 'world'" }); assert.strictEqual(r.results[0].rows.length, 1);
    await call('close', { db: o.db });
});
t('唯讀連線不能寫、同檔案只允許一個寫入者', async () => {
    const p = path.join(tmp, 'b.db'); const w = await call('open', { path: p, mode: 'new' }); await call('exec', { db: w.db, sql: 'create table z(x); insert into z values(1)' });
    await assert.rejects(() => call('open', { path: p }), /已經被另一個連線/);
    await call('close', { db: w.db });
    const r = await call('open', { path: p, readonly: true }); const x = await call('exec', { db: r.db, sql: 'insert into z values(2)' }); assert.ok(x.results[0].error, JSON.stringify(x));
    const y = await call('exec', { db: r.db, sql: 'select x from z' }); assert.strictEqual(y.results[0].rows.length, 1);
    await call('close', { db: r.db });
});
t('長查詢可以取消，連線自動重開，資料不壞', async () => {
    const p = path.join(tmp, 'c.db'); const o = await call('open', { path: p, mode: 'new' }); await call('exec', { db: o.db, sql: 'create table k(x); insert into k values(1);' });
    const slow = call('exec', { db: o.db, sql: 'with recursive c(i) as (select 1 union all select i+1 from c) select count(*) from c' });
    setTimeout(() => call('cancel', { db: o.db }).catch(() => {}), 300);
    await assert.rejects(slow, /已取消/);
    const r = await call('exec', { db: o.db, sql: 'select x from k' }); assert.deepStrictEqual(r.results[0].rows, [[1]]);
    await call('close', { db: o.db });
});
t('逾時會中止', async () => {
    const E2 = new SqliteEngine({ timeoutMs: 400 }); const o = await E2.call('open', { path: ':memory:' });
    await assert.rejects(E2.call('exec', { db: o.db, sql: 'with recursive c(i) as (select 1 union all select i+1 from c) select count(*) from c' }), /逾時/);
    await E2.closeAll();
});
t('大資料庫不吃主行程記憶體（20 萬列，查詢後 RSS 增量有限）', async () => {
    const p = path.join(tmp, 'big.db'); const o = await call('open', { path: p, mode: 'new' });
    await call('exec', { db: o.db, sql: "create table big(id integer primary key, s text); with recursive c(i) as (select 1 union all select i+1 from c where i<200000) insert into big select i, hex(randomblob(40)) from c;" });
    const before = process.memoryUsage().rss; const r = await call('exec', { db: o.db, sql: "select count(*), max(length(s)) from big where s like '%ABC%'", limit: 10 }); assert.ok(r.results[0].rows.length === 1);
    const grew = (process.memoryUsage().rss - before) / 1048576; assert.ok(grew < 120, 'RSS 增加 ' + grew.toFixed(0) + ' MB');
    await call('close', { db: o.db });
});

(async () => {
    for (const [name, fn] of tests) { try { await fn(); ok++; } catch (e) { bad.push(name + ': ' + (e && e.message || e)); } }
    await E.closeAll(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 暫存 */ }
    console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
})();
