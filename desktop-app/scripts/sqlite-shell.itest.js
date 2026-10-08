'use strict';
// sqlite3 命令列核心的整合測試（真引擎）。用 Electron 內建的 Node 跑：
//   ELECTRON_RUN_AS_NODE=1 <Electron 執行檔> scripts/sqlite-shell.itest.js
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
try { require('node:sqlite'); } catch (_) { console.log('0 passed, 0 failed [] (略過：這個 Node 沒有 node:sqlite)'); process.exit(0); }
const { SqliteEngine } = require('../sqlite-engine.js'); const SH = require('../renderer/src/sql/shell_core.js');
const E = new SqliteEngine({ timeoutMs: 20000 }); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sh-'));
const files = new Map();
function mkHost() {
    const h = { out: '', err: '', version: '3.53.4',
        write: (s) => { h.out += s; }, writeErr: (s) => { h.err += s; },
        open: async (p, o) => E.call('open', { path: p, readonly: o.readonly, mode: o.create ? 'new' : undefined }),
        close: (db) => E.call('close', { db }), exec: (db, sql, o) => E.call('exec', Object.assign({ db, sql }, o || {})),
        io: { readText: async (p) => { if (files.has(p)) return files.get(p); return fs.readFileSync(p, 'utf8'); }, writeText: async (p, txt, o) => { files.set(p, (o && o.append && files.has(p) ? files.get(p) : '') + txt); } },
        backup: async () => { throw new Error('x'); } };
    return h;
}
async function cli(argv, stdin) { const h = mkHost(); const r = await SH.runCli(argv, h, { stdin: stdin == null ? null : stdin }); return { out: h.out, err: h.err, code: r.exitCode }; }
let ok = 0; const bad = []; const tests = []; const t = (n, f) => tests.push([n, f]);

t('list 模式：型別與 NULL', async () => { const r = await cli([':memory:', "select 1,'a',null,1.5,2.0"]); assert.strictEqual(r.out, '1|a||1.5|2.0\n'); assert.strictEqual(r.code, 0); });
t('-header -column（欄位補齊空白，包含最後一欄）', async () => { const r = await cli(['-column', '-header', ':memory:', "select 1 a,'xyz' b union all select 22,'p'"]); assert.strictEqual(r.out, 'a   b  \n--  ---\n1   xyz\n22  p  \n'); });
t('-json', async () => { const r = await cli(['-json', ':memory:', "select 1 a,'x' b union all select 2,null"]); assert.strictEqual(r.out, '[{"a":1,"b":"x"},\n{"a":2,"b":null}]\n'); });
t('-csv 與 .mode csv 的列尾不同', async () => { let r = await cli(['-csv', '-header', ':memory:', "select 1 a,'x,y' b"]); assert.strictEqual(r.out, 'a,b\n1,"x,y"\n'); r = await cli([':memory:', '.headers on', '.mode csv', "select 1 a,'q\"r' b"]); assert.strictEqual(r.out, 'a,b\r\n1,"q""r"\r\n'); });
t('-table 與 -box（數字靠右）', async () => {
    let r = await cli(['-table', ':memory:', "select 'ab' s, 7 n"]); assert.strictEqual(r.out, '+----+---+\n| s  | n |\n+----+---+\n| ab | 7 |\n+----+---+\n');
    r = await cli(['-box', ':memory:', "select 'a' s, 100 n"]); assert.strictEqual(r.out, '┌───┬─────┐\n│ s │  n  │\n├───┼─────┤\n│ a │ 100 │\n└───┴─────┘\n'.replace('│  n  │', '│ n   │'));
});
t('-markdown、-line、-quote、-tabs、-html', async () => {
    assert.strictEqual((await cli(['-markdown', ':memory:', "select 1 a,'x' b"])).out, '| a | b |\n|---|---|\n| 1 | x |\n');
    assert.strictEqual((await cli(['-line', ':memory:', "select 1 a,'x' bb"])).out, ' a = 1\nbb = x\n');
    assert.strictEqual((await cli(['-quote', ':memory:', "select 1,'it''s',null,x'AB'"])).out, "1,'it''s',NULL,X'AB'\n");
    assert.strictEqual((await cli(['-tabs', ':memory:', "select 1,'a'"])).out, '1\ta\n');
    assert.strictEqual((await cli(['-html', ':memory:', "select '<b>'"])).out, '<TR><TD>&lt;b&gt;</TD>\n</TR>\n');
});
t('錯誤：stderr 與結束碼 1；-bail 停止', async () => {
    let r = await cli([':memory:', 'select * from nope']); assert.strictEqual(r.code, 1); assert.ok(/^Error: .*no such table: nope/.test(r.err), r.err); assert.strictEqual(r.out, '');
    r = await cli(['-bail', ':memory:', 'select 1; select * from nope; select 2;']); assert.strictEqual(r.out, '1\n'); assert.strictEqual(r.code, 1);
    r = await cli([':memory:', 'select 1; select * from nope; select 2;']); assert.strictEqual(r.out, '1\n'); assert.strictEqual(r.code, 1);
    r = await cli([':memory:'], 'select 1;\nselect * from nope;\nselect 2;\n'); assert.strictEqual(r.out, '1\n2\n'); assert.strictEqual(r.code, 1);
});
t('stdin 腳本與點指令', async () => { const r = await cli([':memory:'], 'create table t(a,b);\ninsert into t values(1,\'x\');\n.headers on\n.mode column\nselect * from t;\n.tables\n'); assert.strictEqual(r.out, 'a  b\n-  -\n1  x\nt\n'); });
t('.dump', async () => { const r = await cli([':memory:'], "create table t(a,b); insert into t values(1,'x'),(2.5,null); create index i on t(a);\n.dump\n"); assert.strictEqual(r.out, "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE t(a,b);\nINSERT INTO t VALUES(1,'x');\nINSERT INTO t VALUES(2.5,NULL);\nCREATE INDEX i on t(a);\nCOMMIT;\n".replace('CREATE INDEX i on t(a)', 'CREATE INDEX i on t(a)')); });
t('.schema 與 .indexes', async () => { const r = await cli([':memory:'], 'create table t(a); create index ia on t(a);\n.schema\n.indexes\n'); assert.strictEqual(r.out, 'CREATE TABLE t(a);\nCREATE INDEX ia on t(a);\nia\n'); });
t('.import csv 並自動建表；.read；.output', async () => {
    files.set('/v/in.csv', 'n,s\n1,a\n2,"b,c"\n'); files.set('/v/s.sql', 'create table z(x); insert into z values(5);\n');
    const r = await cli([':memory:'], '.mode csv\n.import /v/in.csv imp\n.headers off\nselect count(*), max(s) from imp;\n.read /v/s.sql\nselect x from z;\n.output /v/o.txt\nselect 9;\n.output\nselect 10;\n');
    assert.strictEqual(r.out, '2,"b,c"\r\n5\r\n10\r\n'); assert.strictEqual(files.get('/v/o.txt'), '9\r\n');
});
t('.once、.print、.echo、.nullvalue、.separator', async () => {
    files.delete('/v/once.txt'); const r = await cli([':memory:'], '.nullvalue NULL\n.separator , ;\n.print hello\n.echo on\nselect 1,null;\n.echo off\n.once /v/once.txt\nselect 2;\nselect 3;\n');
    assert.strictEqual(r.out, 'hello\nselect 1,null;\n1,NULL;3;'); assert.strictEqual(files.get('/v/once.txt'), '2;');
});
t('多行語句與沒有分號的最後一句', async () => { const r = await cli([':memory:'], 'select 1,\n 2\n;\nselect 3'); assert.strictEqual(r.out, '1|2\n3\n'); });
t('唯讀開啟拒絕寫入，檔案不存在報錯', async () => {
    const p = path.join(tmp, 'ro.db'); await cli([p, 'create table t(x); insert into t values(1)']); let r = await cli(['-readonly', p, 'insert into t values(2)']); assert.strictEqual(r.code, 1); assert.ok(/readonly/i.test(r.err), r.err);
    r = await cli(['-readonly', path.join(tmp, 'nope.db'), 'select 1']); assert.strictEqual(r.code, 1); assert.ok(/unable to open/.test(r.err));
});
t('未知選項', async () => { const r = await cli(['-nosuch']); assert.strictEqual(r.code, 1); assert.ok(/unknown option: -nosuch/.test(r.err)); });
t('REPL 提示字元與多行', async () => {
    const h = mkHost(); const r = await SH.runCli([':memory:'], h, { interactive: true }); assert.ok(r.interactive); const sh = r.shell; assert.strictEqual(sh.prompt(), 'sqlite> ');
    await sh.feedLine('select 1,'); assert.strictEqual(sh.prompt(), '   ...> '); await sh.feedLine("'a';"); assert.strictEqual(h.out.endsWith('1|a\n'), true); assert.strictEqual(sh.prompt(), 'sqlite> '); await sh.feedLine('.quit'); assert.strictEqual(sh.state.quit, true); await sh.close();
});

(async () => {
    for (const [name, fn] of tests) { try { await fn(); ok++; } catch (e) { bad.push(name + ': ' + (e && e.message || e)); } }
    await E.closeAll(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 暫存 */ }
    console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
})();
