'use strict';
// 同一輪內，同一網址、同一種輸出格式重複呼叫 fetch_web_page 要被攔下（實測：模型重打 23 次，每次檔案代號不同，舊的攔阻沒涵蓋）。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
assert(/const FA_DEDUP_EXACT_TOOLS = new Set\([^)]*'fetch_web_page'/.test(src), 'fetch_web_page 要在精確比對集合');
assert(/const FA_DEDUP_TOOLS = new Set\([^)]*'fetch_web_page'/.test(src), 'fetch_web_page 要在攔阻集合');
assert(src.indexOf("name === 'fetch_web_page'") > 0 && src.indexOf('這個網址、這種輸出格式在這一輪已經抓過了') > 0, '缺少專用比對或提示');
console.log('通過  原始碼：fetch_web_page 加入精確重複攔阻與專用提示');

// 行為：抽出鍵的算法
function key(rawArgs) {
  try { const a = JSON.parse(rawArgs); const o = {}; for (const k of Object.keys(a).sort()) { if (a[k] === '' || a[k] == null) continue; o[k] = typeof a[k] === 'string' ? a[k].trim() : a[k]; } return JSON.stringify(o); } catch (_) { return String(rawArgs || ''); }
}
const u = 'https://www.aiposthub.com/x/';
assert.strictEqual(key(JSON.stringify({ url: u, output: 'jsonl' })), key(JSON.stringify({ output: 'jsonl', url: u + ' ' })), '欄位順序與空白不影響');
assert.notStrictEqual(key(JSON.stringify({ url: u, output: 'jsonl' })), key(JSON.stringify({ url: u, output: 'text' })), '換輸出格式是不同的呼叫');
assert.notStrictEqual(key(JSON.stringify({ url: u })), key(JSON.stringify({ url: u.toUpperCase() })), '網址大小寫有意義');
assert.strictEqual(key(JSON.stringify({ url: u, output: '' })), key(JSON.stringify({ url: u })), '空值不算');
console.log('通過  行為：同網址同格式同鍵、換格式或換網址不同鍵');
console.log('fetch-web-page-dedup 測試：全部通過');
