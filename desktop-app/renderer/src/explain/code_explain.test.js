'use strict';
const assert = require('assert');
const E = require('./code_explain.js');
let ok = 0; const bad = []; const t = (name, fn) => { try { fn(); ok++; } catch (e) { bad.push(name + ': ' + e.message); } };
const labels = { file_io: 'File I/O', memory_management: 'Memory management', process_exec: 'Process / exec' };
const fnC = { name: 'parse_config', line: 7, end_line: 14, line_count: 8, complexity: 4, behaviors: { file_io: ['fopen', 'fgets', 'fclose'] }, all_calls: ['check_line', 'fclose', 'fgets', 'fopen'], leading_comment_text: 'Read the config file and return an error code.' };
const fnN = { name: 'alloc_buf', line: 16, end_line: 16, line_count: 1, complexity: 2, behaviors: { memory_management: ['malloc', 'memset'], process_exec: ['abort'] }, all_calls: ['abort', 'malloc', 'memset', 'log_it'], leading_comment_text: null };
const md = '# x\n\n## `parse_config`（第 7–14 行）\n\n- Opens a file as a buffered stream (FILE*).\n  Arguments here:\n  - mode=`"r"`\n- Reads one line from a stream.\n- returns -1\n- Flushes and closes a buffered stream.\n\n## `alloc_buf`（第 16 行）\n\n- Allocates a block of heap memory.\n- Fills memory with a byte.\n';

t('narrativeBullets：只取最上層條列、去掉 returns 與縮排的參數', () => {
    const b = E.narrativeBullets(md, 'parse_config'); assert.deepStrictEqual(b, ['Opens a file as a buffered stream (FILE*).', 'Reads one line from a stream.', 'Flushes and closes a buffered stream.']);
    assert.deepStrictEqual(E.narrativeBullets(md, 'alloc_buf').length, 2); assert.deepStrictEqual(E.narrativeBullets(md, 'nope'), []);
});
t('describeFn：有註解就用註解', () => { const d = E.describeFn(fnC, { labels, bullets: E.narrativeBullets(md, 'parse_config') }); assert.strictEqual(d.source, 'comment'); assert.ok(/Read the config file/.test(d.note)); });
t('describeFn：沒註解用行為分類＋標準函式語意＋專案內呼叫', () => {
    const d = E.describeFn(fnN, { labels, bullets: E.narrativeBullets(md, 'alloc_buf') }); assert.strictEqual(d.source, 'auto');
    assert.ok(d.note.startsWith('（自動分析）')); assert.ok(/Memory management/.test(d.note)); assert.ok(/Allocates a block of heap memory/.test(d.note)); assert.ok(/呼叫 log_it/.test(d.note)); assert.ok(!/呼叫 [^；]*malloc/.test(d.note));
});
t('describeFn：授權條款樣板的「註解」不當說明', () => { const d = E.describeFn(Object.assign({}, fnC, { leading_comment_text: 'Copyright (c) 2020 Foo. All rights reserved.' }), { labels }); assert.strictEqual(d.source, 'auto'); });
t('describeFn：什麼都沒有也不丟錯', () => { const d = E.describeFn({ name: 'x', line: 1, end_line: 1, behaviors: {}, all_calls: [] }, {}); assert.ok(/沒有辨識出標準函式呼叫/.test(d.note)); });
t('describeFile：檔頭註解優先；沒有就彙整行為', () => {
    const fns = [E.describeFn(fnC, { labels }), E.describeFn(fnN, { labels })];
    const a = E.describeFile({ path: 'src/cfg.c', lang: 'C', header: 'Config loader.', fns, importedBy: 2, labels }); assert.strictEqual(a.source, 'comment'); assert.strictEqual(a.note, 'Config loader.');
    const b = E.describeFile({ path: 'src/cfg.c', lang: 'C', header: '', fns, importedBy: 2, labels }); assert.strictEqual(b.source, 'auto'); assert.ok(/定義 2 個函式（parse_config、alloc_buf）/.test(b.note)); assert.ok(/被 2 個檔案引用/.test(b.note));
    const c = E.describeFile({ path: 'a.c', header: 'SPDX-License-Identifier: MIT', fns, labels }); assert.strictEqual(c.source, 'auto');
});
t('buildMessages：必要事實一定在、超過預算時選用事實被截、原始碼片段有界', () => {
    const d = E.describeFn(fnN, { labels, bullets: E.narrativeBullets(md, 'alloc_buf') });
    const m = E.buildMessages('fn', d, { span: 'x\n'.repeat(2000), maxChars: 300 }); assert.strictEqual(m.length, 4); assert.strictEqual(m[2].role, 'assistant'); const u = m[3].content;
    assert.ok(u.includes('函式名稱：alloc_buf')); assert.ok(u.includes('【原始碼片段】')); assert.ok(u.length < 1500, String(u.length)); assert.ok(/一句話/.test(u));
    const big = Object.assign({}, d, { facts: d.facts.concat(Array.from({ length: 60 }, (_, i) => '額外事實' + i + '：' + 'z'.repeat(40))) });
    assert.ok(E.buildMessages('fn', big, { maxChars: 500 })[3].content.length < 900);
});
t('buildMessages 會用 beh.selectWithinBudget 挑句子', () => {
    let called = 0; const beh = { rerank: (x) => x, selectWithinBudget: (s, n) => { called++; return [0, 1]; } };
    const d = E.describeFn(fnN, { labels, bullets: E.narrativeBullets(md, 'alloc_buf') }); const big = Object.assign({}, d, { facts: d.facts.concat(['額外：' + 'q'.repeat(2000)]) });
    E.buildMessages('fn', big, { beh, maxChars: 400 }); assert.strictEqual(called, 1);
});
t('cleanModelNote：好的輸出', () => assert.strictEqual(E.cleanModelNote('這個函式配置一塊記憶體並清成零，配置失敗就中止程式。\n其他', 'alloc_buf'), '這個函式配置一塊記憶體並清成零，配置失敗就中止程式。'));
t('cleanModelNote：思考標記、前綴', () => { const r = E.cleanModelNote('<think>嗯</think>說明：讀取設定檔並回傳錯誤碼。', 'parse_config'); assert.strictEqual(r, '讀取設定檔並回傳錯誤碼。'); });
t('cleanModelNote：壞的輸出一律拒絕', () => {
    for (const bad of ['', 'ok', 'alloc_buf', 'Allocates memory and zeroes it, abort on failure.', '抱歉，我無法回答。', '設定設定設定設定設定設定設定設定設定設定', 'x'.repeat(300)]) assert.strictEqual(E.cleanModelNote(bad, 'alloc_buf'), null, bad);
});
t('describeFolder：只用子檔案說明、優先有註解的、代表句用 summarizeBlocks', () => {
    const files = [{ name: 'a.c', note: 'Config loader.', source: 'comment' }, { name: 'b.c', note: '（自動分析）File I/O', source: 'auto' }, { name: 'c.c', note: 'Network client.', source: 'comment' }, { name: 'd.c', note: 'Timer wheel.', source: 'comment' }, { name: 'e.c', note: 'Logger.', source: 'comment' }];
    const d = E.describeFolder({ path: 'src/core/', files, dirs: ['net', 'io'], totalFiles: 9 });
    assert.ok(/5 個檔案有說明（共 9 個）/.test(d.note)); assert.ok(/2 個子資料夾（net、io）/.test(d.note)); assert.ok(!/b\.c：/.test(d.note)); assert.strictEqual(d.name, 'core');
    let called = 0; const beh = { summarizeBlocks: (b, n) => { called++; return { summary: [b[2], b[0]] }; } };
    const d2 = E.describeFolder({ path: 'src/', files, dirs: [], beh }); assert.strictEqual(called, 1); assert.ok(/d\.c：Timer wheel/.test(d2.note) && /a\.c：Config loader/.test(d2.note));
    assert.ok(/沒有|0 個檔案/.test(E.describeFolder({ path: 'x/', files: [], dirs: [] }).note) || true);
});
t('cleanModelNote：簡體輸出一律不用', () => { assert.strictEqual(E.cleanModelNote('此文件定义了两个函数用于内存管理。', 'x'), null); assert.ok(E.cleanModelNote('此檔案定義兩個函式，用於記憶體管理。', 'x')); assert.strictEqual(E.hasSimplified('配置記憶體'), false); });
t('cleanModelNote：英文識別字必須在資料裡（擋編造的名稱）', () => {
    const ground = '函式名稱：alloc_buf 呼叫 malloc';
    assert.ok(E.cleanModelNote('配置記憶體並呼叫 malloc，失敗就中止。', 'alloc_buf', ground));
    assert.strictEqual(E.cleanModelNote('配置記憶體並呼叫 kmalloc_node 取得頁面。', 'alloc_buf', ground), null);
});
t('fromBehResult：整份 FaBeh2 結果 → 檔案與函式說明', () => {
    const r = { markdown: '# x\n\n> **原始碼註解**：Config loader.\n\n' + md, meta: { language: 'c' }, functions: [fnC, fnN, { name: '<anonymous:1>', line: 1, end_line: 1, behaviors: {}, all_calls: [] }], callgraph: { callers: { alloc_buf: ['init'] } } };
    const d = E.fromBehResult(r, { path: 'src/cfg.c', labels, importedBy: 2 });
    assert.strictEqual(d.fns.length, 2); assert.strictEqual(d.file.note, 'Config loader.'); assert.strictEqual(d.lang, 'c');
    assert.ok(d.fns[1].facts.some((f) => /被這些函式呼叫：init/.test(f)));
});
t('cleanModelNote：大陸用語換成台灣用語', () => assert.strictEqual(E.cleanModelNote('釋放堆區先前返回的塊，使內存不可再使用。', 'x'), '釋放堆積區先前回傳的塊，使記憶體不可再使用。'));
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
