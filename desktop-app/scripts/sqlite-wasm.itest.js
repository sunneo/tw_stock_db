'use strict';
// 網頁版 SQLite 引擎操作（wasm_ops.js）的整合測試：需要 sqlite-wasm 的 node 版。
//   FA_SQLITE_WASM_DIR=<含 node.mjs 與 sqlite3.wasm 的資料夾> ELECTRON_RUN_AS_NODE=1 <Electron 執行檔> scripts/sqlite-wasm.itest.js
// 沒有設定時略過（run-core-tests 不受影響）。node.mjs／sqlite3.wasm 來自 npm 套件 @sqlite.org/sqlite-wasm（dist/ 底下）。
const assert = require('assert'); const path = require('path'); const { pathToFileURL } = require('url');
const dir = process.env.FA_SQLITE_WASM_DIR; if (!dir) { console.log('0 passed, 0 failed [] (略過：沒有設定 FA_SQLITE_WASM_DIR)'); process.exit(0); }
const SPLIT = require('../renderer/src/sql/sql_split.js'); const W = require('../renderer/src/sql/wasm_ops.js');
let ok = 0; const bad = []; const tests = []; const t = (n, f) => tests.push([n, f]);
(async () => {
    const mod = await import(pathToFileURL(path.join(dir, 'node.mjs')).href); const sqlite3 = await mod.default({ print() {}, printErr() {} });
    const mk = () => W.create(sqlite3, SPLIT).ops;
    t('建表、寫入、查詢（與桌面版同一個協定）', () => {
        const o = mk(); o.open({}); const r = o.exec({ sql: "create table t(id integer primary key, name text, v real, b blob); insert into t(name,v,b) values('a',1.5,x'0102'),('b',null,null); select * from t order by id;" });
        assert.strictEqual(r.results.length, 3); assert.strictEqual(r.results[1].changes, 2); assert.deepStrictEqual(r.results[2].columns, ['id', 'name', 'v', 'b']); assert.deepStrictEqual(r.results[2].rows[0], [1, 'a', 1.5, { $blob: 'AQI=' }]); assert.strictEqual(r.results[2].rows[1][2], null);
    });
    t('typed：整數值的實數 1.0 與整數分得出來', () => { const o = mk(); o.open({}); const r = o.exec({ sql: 'select 1, 2.0, 2.5, null', typed: true }); assert.deepStrictEqual(r.results[0].rows[0], [1, { $real: '2.0' }, 2.5, null]); const r2 = o.exec({ sql: 'select 1, 2.0', typed: false }); assert.deepStrictEqual(r2.results[0].rows[0], [1, 2]); });
    t('大整數、BLOB 往返；具名參數可不帶前綴', () => {
        const o = mk(); o.open({}); o.exec({ sql: 'create table n(x integer, y blob)' }); o.exec({ sql: 'insert into n values(?,?)', bind: [{ $int: '9223372036854775807' }, { $blob: 'AAEC' }] });
        assert.deepStrictEqual(o.exec({ sql: 'select x,y from n' }).results[0].rows[0], [{ $int: '9223372036854775807' }, { $blob: 'AAEC' }]);
        assert.deepStrictEqual(o.exec({ sql: 'select count(*) from n where x = :v', bind: { v: { $int: '9223372036854775807' } } }).results[0].rows[0], [1]);
    });
    t('語句錯誤只回報那一句，前面的結果保留；錯誤訊息不帶 sqlite3 result code 前綴', () => { const o = mk(); o.open({}); const r = o.exec({ sql: 'select 1; select * from nope; select 3;' }); assert.strictEqual(r.results.length, 2); assert.ok(/^no such table: nope/.test(r.results[1].error), r.results[1].error); });
    t('觸發器與分號切分、結果列數上限', () => {
        const o = mk(); o.open({}); o.exec({ sql: 'create table a(x); create table log(n); create trigger tr after insert on a begin insert into log values(new.x); insert into log values(-1); end; insert into a values(5);' });
        assert.strictEqual(o.exec({ sql: 'select count(*) from log' }).results[0].rows[0][0], 2);
        o.exec({ sql: 'create table n(x); with recursive c(i) as (select 1 union all select i+1 from c where i<500) insert into n select i from c;' }); const r = o.exec({ sql: 'select * from n', limit: 100 }); assert.strictEqual(r.results[0].rows.length, 100); assert.strictEqual(r.results[0].truncated, true);
    });
    t('瀏覽用 query：過濾、排序、總數、rowid；注入字串不會執行', () => {
        const o = mk(); o.open({}); o.exec({ sql: "create table p(name text, n int); insert into p values('apple',3),('apricot',5),('banana',7),('Cherry',1);" });
        let r = o.query({ table: 'p', filters: [{ col: 'name', op: 'like', value: 'ap' }], sort: [{ col: 'n', desc: true }] }); assert.deepStrictEqual(r.rows.map((x) => x[1]), ['apricot', 'apple']); assert.strictEqual(r.total, 2); assert.strictEqual(r.columns[0], '__rowid__');
        assert.strictEqual(o.query({ table: 'p', filters: [{ col: 'name', op: 'like', value: "x'; drop table p;--" }] }).total, 0); assert.strictEqual(o.query({ table: 'p' }).total, 4);
    });
    t('schema：表、欄位、索引、檢視、FTS5', () => {
        const o = mk(); o.open({}); o.exec({ sql: "create table t(id integer primary key, a text not null default 'x'); create index ia on t(a); create view v as select a from t; create virtual table f using fts5(body); insert into f values('hello world');" });
        const s = o.schema(); assert.ok(s.tables.some((x) => x.name === 't' && x.columns[0].pk === 1 && x.rows === 0)); assert.ok(s.indices.some((x) => x.name === 'ia')); assert.ok(s.views.some((x) => x.name === 'v')); assert.ok(s.tables.find((x) => x.name === 'f').virtual);
        assert.strictEqual(o.exec({ sql: "select rowid from f where f match 'world'" }).results[0].rows.length, 1);
    });
    t('export／open(bytes)：序列化後再開，資料不變；唯讀開啟拒絕寫入；壞檔案報錯', () => {
        const o = mk(); o.open({}); o.exec({ sql: "create table z(x); insert into z values(1),(2),(3)" }); const bytes = o.export().bytes; assert.ok(bytes.length >= 4096 && bytes[0] === 0x53, 'SQLite format 3');
        const o2 = mk(); const r = o2.open({ bytes, readonly: true }); assert.strictEqual(r.size, bytes.length); assert.deepStrictEqual(o2.exec({ sql: 'select sum(x) from z' }).results[0].rows, [[6]]); assert.ok(o2.exec({ sql: 'insert into z values(9)' }).results[0].error, '唯讀要拒絕寫入');
        const o3 = mk(); o3.open({ bytes }); o3.exec({ sql: 'insert into z values(9)' }); assert.deepStrictEqual(o3.exec({ sql: 'select count(*) from z' }).results[0].rows, [[4]]);
        assert.throws(() => mk().open({ bytes: new Uint8Array(200).fill(7) }), /SQLite|deserialize|不是/);
    });
    t('pragma：只讀一般設定，擋掉 load_extension', () => { const o = mk(); o.open({}); assert.strictEqual(o.pragma({ name: 'foreign_keys' }).rows[0][0], 1); assert.throws(() => o.pragma({ name: 'load_extension' }), /不允許/); });
    for (const [name, fn] of tests) { try { fn(); ok++; } catch (e) { bad.push(name + ': ' + (e && e.message || e)); } }
    console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
})();
