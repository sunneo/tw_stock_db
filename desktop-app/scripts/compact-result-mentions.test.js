'use strict';
// 壓縮索引：工具結果提到被收起來的工具時，要補進清單（網頁讀回章節索引叫模型用 big_content，卻看不到它就一直重打 fetch_web_page）。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
const i = src.indexOf('工具結果自己叫模型去用某個被收起來的工具');
assert(i > 0, '找不到結果提到被收起來工具的補進邏輯');
const body = src.slice(i, i + 1600);
assert(/_compactHidden\(\)/.test(body) && /_compactExtra\.add\(n\)/.test(body) && /_intentRefreshPrompt\(\)/.test(body), '補進邏輯不完整');
assert(/_compactIxOn\(\)/.test(body) && /_compactWiden/.test(body), '必須只在壓縮索引開著、沒放寬時作用');
console.log('通過  原始碼：結果提到被收起來的工具會補進清單');

// 行為：把比對那段抽出來單獨跑
function mentions(hidden, extra, result) {
  const add = [];
  for (const n of hidden) { if (add.length >= 6) break; if (extra.has(n)) continue; if (/^[A-Za-z0-9_]{6,}$/.test(n) && new RegExp('(^|[^A-Za-z0-9_])' + n + '([^A-Za-z0-9_]|$)').test(result)) add.push(n); }
  return add;
}
const hidden = new Set(['big_content', 'parse_uploaded_file', 'article_section', 'fs_read_file']);
const r1 = '三層：要讀某章的區塊，用該行的 read_blocks（big_content({"id":"bc_1"})）；原文用 parse_uploaded_file 或 article_section';
assert.deepStrictEqual(mentions(hidden, new Set(), r1).sort(), ['article_section', 'big_content', 'parse_uploaded_file']);
assert.deepStrictEqual(mentions(hidden, new Set(['big_content']), r1).sort(), ['article_section', 'parse_uploaded_file'], '已補進的不重複');
assert.deepStrictEqual(mentions(hidden, new Set(), '一般內容 my_big_content_x'), [], '名稱只是別的字的一部分不算');
assert.deepStrictEqual(mentions(hidden, new Set(), '沒有提到任何工具'), []);
console.log('通過  行為：只比對完整名稱、不重複、不誤抓');
console.log('compact-result-mentions 測試：全部通過');
