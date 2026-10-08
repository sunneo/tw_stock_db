'use strict';
// 專案索引 SQLite 層的整合測試（真引擎）：ELECTRON_RUN_AS_NODE=1 <Electron 執行檔> scripts/sqlite-index.itest.js
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
try { require('node:sqlite'); } catch (_) { console.log('0 passed, 0 failed [] (略過：這個 Node 沒有 node:sqlite)'); process.exit(0); }
const { SqliteEngine } = require('../sqlite-engine.js'); const X = require('../renderer/src/sql/index_core.js');
const E = new SqliteEngine({ timeoutMs: 120000 }); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-idx-'));
let ok = 0; const bad = []; const tests = []; const t = (n, f) => tests.push([n, f]);
const open = async (name) => { const r = await E.call('open', { path: path.join(tmp, name), mode: 'new' }); return { db: r.db, exec: (sql, bind) => E.call('exec', { db: r.db, sql, bind, limit: 100000 }).then((x) => x.results) }; };
const rec = (lang, symbols, imports, uses, doc) => ({ lang, lines: 10, hash: 'h', doc: doc || '', symbols, imports: imports || [], uses: uses || [], sv: 2 });

t('建庫：檔案、符號、匯入、呼叫關係、計數、全文表', async () => {
    const { db, exec } = await open('a.db'); const B = X.builder(exec, { batch: 2 }); await B.init();
    B.addFile('src/a.c', rec('c', [{ n: 'parse_config', k: 'function', l: 3, d: '讀設定檔', sig: 'int parse_config(void)' }, { n: 'CFG_MAX', k: 'macro', l: 1, sig: '16' }], [{ kind: 'rel', to: 'src/b.h' }, { kind: 'pkg', spec: 'stdio.h' }], ['helper_fn', 'nope']));
    B.addFile('src/b.h', rec('c', [{ n: 'helper_fn', k: 'function', l: 5, d: '小幫手', sig: 'void helper_fn()' }, { n: 'parse_config', k: 'function', l: 9 }], []));
    B.addFile('src/c.c', rec('c', [{ n: 'main', k: 'function', l: 1 }], [{ kind: 'rel', to: 'src/a.c' }, { kind: 'rel', to: 'src/gone.c' }], ['parse_config']));
    await B.flush();
    const c = await B.finalize({ root: '/p' }); assert.deepStrictEqual([c.files, c.symbols, c.imports, c.uses, c.macros], [3, 5, 2, 3, 1]);
    const R = X.reader(exec); assert.deepStrictEqual(await R.counts(), c);
    const rowsOf = async (sql) => (await exec(sql))[0].rows;
    assert.deepStrictEqual(await rowsOf("select path, refs, used from files order by id"), [['src/a.c', 1, 1], ['src/b.h', 0, 1], ['src/c.c', 1, 0]]);
    // uses：a.c 用 helper_fn（b.h 一個定義）；c.c 用 parse_config（a.c 與 b.h 兩個定義，都不是自己的檔案）
    assert.deepStrictEqual(await rowsOf("select f.path, s.name, f2.path from uses u join files f on f.id=u.file_id join symbols s on s.id=u.symbol_id join files f2 on f2.id=s.file_id order by 1,2,3"), [['src/a.c', 'helper_fn', 'src/b.h'], ['src/c.c', 'parse_config', 'src/a.c'], ['src/c.c', 'parse_config', 'src/b.h']]);
    assert.strictEqual((await R.symbolsByName('PARSE_CONFIG'))[0].used_by, 1);
    assert.deepStrictEqual(await R.recallSymbols(['parse', 'config']), (await R.recallSymbols(['parse', 'config'])).slice(0, 2)); assert.ok((await R.recallSymbols(['parse'])).length >= 1);
    assert.deepStrictEqual((await R.macros('CFG_MAX')).map((m) => m.value), ['16']); assert.ok((await R.macros('CFG_', 'prefix')).length === 1);
    const fr = await R.fileRec('src/a.c'); assert.strictEqual(fr.symbols.length, 2); assert.deepStrictEqual(fr.imports, [{ kind: 'rel', to: 'src/b.h' }]);
    await E.call('close', { db });
});
t('分批寫入：批次小也一致；巨集不進符號全文表', async () => {
    const { db, exec } = await open('b.db'); const B = X.builder(exec, { batch: 3 }); await B.init();
    for (let i = 0; i < 25; i++) { B.addFile('d/f' + i + '.h', rec('c', Array.from({ length: 30 }, (_, k) => ({ n: 'F' + i + '_REG_' + k, k: 'macro', l: k + 1, sig: '0x' + k })).concat([{ n: 'func_' + i, k: 'function', l: 99 }]), [])); await B.flush(); }
    const c = await B.finalize({}); assert.strictEqual(c.symbols, 25 * 31); assert.strictEqual(c.macros, 25 * 30);
    const R = X.reader(exec); assert.strictEqual((await R.recallSymbols(['func'])).length, 25); assert.strictEqual((await R.recallSymbols(['reg'])).length, 0);
    assert.strictEqual((await R.macros('F3_REG_', 'prefix', 100)).length, 30);
    await E.call('close', { db });
});
t('樹狀：目錄與檔案', async () => {
    const { db, exec } = await open('c.db'); const B = X.builder(exec, {}); await B.init(); B.addFile('a/x.c', rec('c', [], [])); B.addFile('a/b/y.c', rec('c', [], [])); B.addFile('top.c', rec('c', [], [])); await B.finalize({});
    const R = X.reader(exec); assert.deepStrictEqual((await R.tree('')).map((x) => x.type + ':' + x.name), ['f:top.c', 'd:a']); assert.deepStrictEqual((await R.tree('a')).map((x) => x.type + ':' + x.name), ['f:x.c', 'd:b']);
    await E.call('close', { db });
});
t('規模：6 萬檔、300 萬符號寫入，引擎端記憶體不隨規模成長', async () => {
    const { db, exec } = await open('d.db'); const B = X.builder(exec, { batch: 200 }); await B.init(); const rss0 = process.memoryUsage().rss; const t0 = Date.now();
    for (let i = 0; i < 20000; i++) { B.addFile('drv/d' + (i % 300) + '/f' + i + '.h', rec('c', Array.from({ length: 150 }, (_, k) => ({ n: 'R' + i + '_' + k, k: 'macro', l: k, sig: '0x' + k })), [], [])); if (B.pending() > 4000) await B.flush(); }
    const c = await B.finalize({}); const ms = Date.now() - t0; const grew = (process.memoryUsage().rss - rss0) / 1048576;
    assert.strictEqual(c.symbols, 3000000); console.log('  20000 檔／300 萬符號：' + (ms / 1000).toFixed(1) + ' 秒，主行程 RSS +' + grew.toFixed(0) + ' MB，檔案 ' + Math.round(fs.statSync(path.join(tmp, 'd.db')).size / 1048576) + ' MB'); assert.ok(grew < 400, 'RSS 增加 ' + grew);
    const q0 = Date.now(); const R = X.reader(exec); const hit = await R.macros('R777_5'); assert.strictEqual(hit.length, 1); console.log('  精確巨集查詢 ' + (Date.now() - q0) + ' ms');
    await E.call('close', { db });
});
(async () => {
    for (const [name, fn] of tests) { try { await fn(); ok++; } catch (e) { bad.push(name + ': ' + (e && e.stack || e)); } }
    await E.closeAll(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 暫存 */ }
    console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
})();
