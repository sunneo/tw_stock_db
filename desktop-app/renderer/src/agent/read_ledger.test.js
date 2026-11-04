// node renderer/src/agent/read_ledger.test.js
'use strict';
const assert = require('assert');
const L = require('./read_ledger.js');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok - ' + name); }

const A = { path: 'log.txt', cwd_abs: 'C:/x' };
const B = { ref: 'att-9' };

t('單來源分三頁讀完後清空', () => {
  let g = L.createLedger();
  g = L.record(g, 'fap_read_file', A, { ok: true, has_more: true, next_offset: 100, total: 300 });
  assert.strictEqual(L.pending(g).length, 1);
  g = L.record(g, 'fap_read_file', A, { ok: true, has_more: true, next_offset: 200, total: 300 });
  assert.strictEqual(L.pending(g).length, 1);
  assert.strictEqual(L.pending(g)[0].nextOffset, 200, '續讀位置要更新成最新一頁的');
  g = L.record(g, 'fap_read_file', A, { ok: true, has_more: false });
  assert.strictEqual(L.pending(g).length, 0);
});

t('兩來源只讀完一個，另一個仍列為未完成', () => {
  let g = L.createLedger();
  g = L.record(g, 'fap_read_file', A, { ok: true, has_more: true, next_offset: 50 });
  g = L.record(g, 'parse_uploaded_file', B, { ok: true, has_more: true, next_offset: 10 });
  g = L.record(g, 'fap_read_file', A, { ok: true, has_more: false });
  const p = L.pending(g);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].toolName, 'parse_uploaded_file');
});

t('讀到一半換別的來源，原來源仍未完成', () => {
  let g = L.createLedger();
  g = L.record(g, 'fap_read_file', A, { ok: true, has_more: true, next_offset: 80 });
  g = L.record(g, 'browser_get_page_text', { url: 'https://a.test' }, { ok: true, has_more: false });
  const p = L.pending(g);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].nextOffset, 80);
});

t('ok:false 不改帳本（未完成的仍在，失敗的不新增）', () => {
  let g = L.createLedger();
  g = L.record(g, 'fap_read_file', A, { ok: true, has_more: true, next_offset: 40 });
  const before = JSON.stringify(g);
  g = L.record(g, 'fap_read_file', A, { ok: false, has_more: false, error: '檔案不存在' });
  assert.strictEqual(JSON.stringify(g), before);
  const g2 = L.record(L.createLedger(), 'fap_read_file', B, { ok: false, has_more: true, next_offset: 5 });
  assert.strictEqual(L.pending(g2).length, 0);
});

t('駝峰格式 chunk.hasMore / chunk.nextOffset（技能包參考檔）', () => {
  let g = L.createLedger();
  g = L.record(g, 'skill_reference', { ref: 'ref.md' }, { ok: true, chunk: { hasMore: true, nextOffset: 4000, total: 9000 } });
  const p = L.pending(g);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].nextOffset, 4000);
  assert.strictEqual(p[0].total, 9000);
  g = L.record(g, 'skill_reference', { ref: 'ref.md' }, { ok: true, chunk: { hasMore: false } });
  assert.strictEqual(L.pending(g).length, 0);
});

t('蛇形格式 next_start_line 也能續讀', () => {
  const g = L.record(L.createLedger(), 'read_project_file', { path: 'a.js' }, { ok: true, has_more: true, next_start_line: 301 });
  assert.strictEqual(L.pending(g)[0].nextStartLine, 301);
  assert.strictEqual(L.pending(g)[0].blocking, true);
});

t('只有 truncated、沒有續讀參數：列為提醒（不阻擋）', () => {
  const g = L.record(L.createLedger(), 'article_section', { file_id: 'f1' }, { ok: true, truncated: true });
  const p = L.pending(g);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].blocking, false);
});

t('truncated 且有 next_offset：阻擋', () => {
  const g = L.record(L.createLedger(), 'article_section', { file_id: 'f1' }, { ok: true, truncated: true, next_offset: 7 });
  assert.strictEqual(L.pending(g)[0].blocking, true);
});

t('reminderText 空清單回傳空字串，有項目時列出來源與續讀位置', () => {
  assert.strictEqual(L.reminderText([]), '');
  let g = L.record(L.createLedger(), 'fap_read_file', A, { ok: true, has_more: true, next_offset: 123, total: 999 });
  const s = L.reminderText(L.pending(g));
  assert.ok(s.indexOf('fap_read_file') >= 0);
  assert.ok(s.indexOf('123') >= 0);
  assert.ok(s.indexOf('讀完之前不可下結論') >= 0);
});

t('path 與 cwd_abs 組合成不同的來源鍵', () => {
  assert.notStrictEqual(L.sourceKey('fap_read_file', { path: 'a', cwd_abs: 'X' }), L.sourceKey('fap_read_file', { path: 'a', cwd_abs: 'Y' }));
});

t('record 不改傳入的帳本（純函式）', () => {
  const g0 = L.createLedger();
  const g1 = L.record(g0, 'fap_read_file', A, { ok: true, has_more: true, next_offset: 1 });
  assert.strictEqual(L.pending(g0).length, 0);
  assert.strictEqual(L.pending(g1).length, 1);
});

console.log(n + ' tests passed');
