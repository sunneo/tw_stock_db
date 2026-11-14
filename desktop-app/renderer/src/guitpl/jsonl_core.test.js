// node renderer/src/guitpl/jsonl_core.test.js -- 範本索引：讀 lib 底下所有 jsonl，檢索與逐步詢問
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const X = require('./jsonl_core.js');
let n = 0; const ok = () => { n++; };

const lib = path.join(__dirname, 'lib');
const files = {};
(function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { walk(p); }
    else if (/\.jsonl$/.test(d.name)) { files[path.relative(lib, p).replace(/\\/g, '/').replace(/\.jsonl$/, '')] = fs.readFileSync(p, 'utf8'); }
  });
}(lib));

const idx = X.buildIndex(files);
assert.deepStrictEqual(idx.errors, [], idx.errors.join('；')); ok();
assert.ok(idx.entries.some((e) => e.id === 'demo/notes'), '標 standalone 的是入口'); ok();
assert.ok(idx.parts.some((e) => e.id === 'common/toolbar_basic'), '沒標的是元件'); ok();
assert.ok(idx.entries.some((e) => e.id === 'demo/notes_dark'), 'extends 的變體也是入口'); ok();

const r = X.search(idx, '幫我做一個筆記程式', 3);
assert.strictEqual(r[0].id, 'demo/notes'); ok();
assert.strictEqual(X.search(idx, '完全不相干', 3).length, 0); ok();

const entry = idx.entries.filter((e) => e.id === 'demo/notes')[0];
assert.deepStrictEqual(X.questions(entry), [{ name: 'title', ask: '視窗標題要寫什麼？', default: '我的筆記' }]); ok();
assert.deepStrictEqual(entry.scenes.map((s) => s.id), ['edit', 'help']); ok();
assert.deepStrictEqual(entry.slots, [{ name: 'toolbar', use: 'common/toolbar_basic' }]); ok();
assert.ok(entry.requires.indexOf('gui') >= 0); ok();

assert.ok(X.summarize('x', '{bad').error); ok();
assert.ok(X.summarize('x', '{"kind":"param","name":"a","default":1}').error.indexOf('meta') >= 0); ok();
assert.deepStrictEqual(X.parseJsonl('# 註解\n\n{"kind":"meta","id":"a"}\n').records.length, 1); ok();

console.log('jsonl_core.test.js: ' + n + ' groups OK，' + Object.keys(files).length + ' 個檔案');
