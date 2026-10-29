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
t('除錯定位器（schema 3）：log 訊息字串、呼叫邊（只留 1–8 個定義的被呼叫名稱）、樹版本；舊版索引 available:false', async () => {
    const { db, exec } = await open('loc.db'); const B = X.builder(exec, { batch: 2 }); await B.init();
    B.addFile('src/exec.c', Object.assign(rec('c', [{ n: 'helper', k: 'function', l: 2 }, { n: 'run_main', k: 'function', l: 6 }]), {
        logs: [{ l: 8, fn: 'printk', fmt: 'ipmi: BMC not responding after %d retries', key: 'ipmi: bmc not responding after' }],
        calls: [{ c: 'run_main', cl: 6, f: 'helper', l: 8 }, { c: 'run_main', cl: 6, f: 'printk', l: 9 }] }));
    B.addFile('src/main.c', Object.assign(rec('c', [{ n: 'main', k: 'function', l: 1 }]), { calls: [{ c: 'main', cl: 1, f: 'run_main', l: 3 }] }));
    const c = await B.finalize({ root: 'x', treeRef: { git: 'abc123', ref: 'refs/heads/main', at: 1, v: 1 } });
    assert.strictEqual(c.logmsgs, 1); assert.strictEqual(c.calls, 2, 'printk 沒有定義，那條邊不留');
    const R = X.reader(exec);
    assert.strictEqual(await R.schemaVersion(), 3);
    const lc = await R.logCandidates('ipmid: ipmi: BMC not responding after 3 retries', 50);
    assert.ok(lc.available && lc.total === 1 && lc.rows.length === 1 && lc.rows[0].path === 'src/exec.c' && lc.rows[0].line === 8);
    assert.strictEqual((await R.logCandidates('something else entirely', 50)).rows.length, 0);
    const cb = await R.callers('helper', 10); assert.ok(cb.available && cb.rows.length === 1 && cb.rows[0].caller === 'run_main' && cb.rows[0].line === 8);
    assert.deepStrictEqual((await R.treeRef()).git, 'abc123');
    assert.deepStrictEqual(await R.filesByName('MAIN.C', 5), ['src/main.c']);
    // 舊版（schema 1）索引：沒有這兩張表，要回 available:false，不是「找不到」
    await exec('DROP TABLE logmsgs'); await exec('DROP TABLE calls'); await exec("UPDATE meta SET v='1' WHERE k='schema'");
    assert.strictEqual((await R.logCandidates('x', 5)).available, false); assert.strictEqual((await R.callers('helper', 5)).available, false); assert.strictEqual(await R.schemaVersion(), 1);
});
t('樹狀：目錄與檔案', async () => {
    const { db, exec } = await open('c.db'); const B = X.builder(exec, {}); await B.init(); B.addFile('a/x.c', rec('c', [], [])); B.addFile('a/b/y.c', rec('c', [], [])); B.addFile('top.c', rec('c', [], [])); await B.finalize({});
    const R = X.reader(exec); assert.deepStrictEqual((await R.tree('')).map((x) => x.type + ':' + x.name), ['f:top.c', 'd:a']); assert.deepStrictEqual((await R.tree('a')).map((x) => x.type + ':' + x.name), ['f:x.c', 'd:b']);
    await E.call('close', { db });
});
t('說明庫 notes.sqlite3：寫入、讀回、較新者勝、同時間 user 優先、重複初始化、重開仍在', async () => {
    const f = path.join(tmp, 'notes.sqlite3');
    const openNotes = async () => { const r = await E.call('open', { path: f, mode: 'new' }); return { db: r.db, exec: (sql, bind) => E.call('exec', { db: r.db, sql, bind, limit: 100000 }).then((x) => x.results) }; };
    let h = await openNotes(); await X.notesInit(h.exec); await X.notesInit(h.exec); // 冪等
    const t0 = 1000;
    await X.notesWrite(h.exec, { files: { 'src/a.c': { note: '第一版說明：讀設定檔', by: 'ai', at: t0, h: 'h1' }, 'src': { note: '資料夾：原始碼', by: 'ai', at: t0 } }, symbols: { 'src/a.c#parse_config': { note: '解析設定檔並回傳錯誤碼', by: 'ai', at: t0, h: 'h1' } }, glossary: { MCU: { definition: '微控制器', by: 'user', at: t0 } } });
    let got = await X.notesRead(h.exec); assert.deepStrictEqual(Object.keys(got.files).sort(), ['src', 'src/a.c']); assert.strictEqual(got.symbols['src/a.c#parse_config'].note, '解析設定檔並回傳錯誤碼'); assert.strictEqual(got.glossary.MCU.definition, '微控制器');
    // 較舊的不能蓋掉較新的；較新的可以蓋掉較舊的
    await X.notesWrite(h.exec, { files: { 'src/a.c': { note: '舊的、不該生效', by: 'ai', at: t0 - 1 } } }); got = await X.notesRead(h.exec); assert.strictEqual(got.files['src/a.c'].note, '第一版說明：讀設定檔');
    await X.notesWrite(h.exec, { files: { 'src/a.c': { note: '第二版說明：讀並驗證設定檔', by: 'ai', at: t0 + 5, h: 'h2' } } }); got = await X.notesRead(h.exec); assert.strictEqual(got.files['src/a.c'].note, '第二版說明：讀並驗證設定檔'); assert.strictEqual(got.files['src/a.c'].h, 'h2');
    // 同一個時間點：user 蓋過 ai，ai 蓋不過 user
    await X.notesWrite(h.exec, { files: { 'src/a.c': { note: '使用者改的', by: 'user', at: t0 + 5 } } }); got = await X.notesRead(h.exec); assert.strictEqual(got.files['src/a.c'].note, '使用者改的'); assert.strictEqual(got.files['src/a.c'].by, 'user');
    await X.notesWrite(h.exec, { files: { 'src/a.c': { note: 'ai 想蓋掉', by: 'ai', at: t0 + 5 } } }); got = await X.notesRead(h.exec); assert.strictEqual(got.files['src/a.c'].note, '使用者改的');
    // 多行（表格、清單）要原樣保存；超過一批（150 筆）也要全部寫進去
    const many = {}; for (let i = 0; i < 400; i++) many['m/f' + i + '.c'] = { note: '第 ' + i + ' 個檔案\n| a | b |\n|---|---|\n| 1 | 2 |', by: 'ai', at: t0 };
    await X.notesWrite(h.exec, { files: many }); const cn = await X.notesCounts(h.exec); assert.strictEqual(cn.files, 402); assert.strictEqual(cn.symbols, 1); assert.strictEqual(cn.glossary, 1);
    got = await X.notesRead(h.exec); assert.ok(got.files['m/f399.c'].note.indexOf('\n| a | b |') > 0);
    // 路徑裡有 # 時（既有鍵格式 path#name 以第一個 # 切）：至少不丟資料、不拋錯（這是既有鍵格式的限制，不是這層新增的）
    await X.notesWrite(h.exec, { symbols: { 'a#b/x.c#fn': { note: '路徑含井字號的定義說明', by: 'ai', at: t0 } } }); got = await X.notesRead(h.exec); assert.ok(Object.keys(got.symbols).some((k) => k.endsWith('#fn')));
    await E.call('close', { db: h.db });
    h = await openNotes(); got = await X.notesRead(h.exec); assert.strictEqual(got.files['src/a.c'].note, '使用者改的'); assert.strictEqual((await X.notesCounts(h.exec)).files, 402); await E.call('close', { db: h.db });
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
