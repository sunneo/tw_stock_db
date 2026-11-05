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

t('沒有來源欄位時，續讀參數（offset）不影響來源鍵，三頁讀完後清空', () => {
  let g = L.createLedger();
  g = L.record(g, 'test_paged_read', { offset: 0 }, { ok: true, has_more: true, next_offset: 1 });
  g = L.record(g, 'test_paged_read', { offset: 1 }, { ok: true, has_more: true, next_offset: 2 });
  assert.strictEqual(L.pending(g).length, 1, '兩頁讀完前仍只有一個未完成來源');
  g = L.record(g, 'test_paged_read', { offset: 2 }, { ok: true, has_more: false });
  assert.strictEqual(L.pending(g).length, 0);
});

// ===== 覆蓋範圍（JSONL 分頁的 _page meta）=====
const P = require('./jsonl_pager.js');
const mkLines = (c) => Array.from({ length: c }, (_, i) => JSON.stringify({ id: i, v: '資料' + i }));
// 用真的分頁器產生每一頁的 meta，再餵給帳本
function metas(lines, chars) { const out = []; let cur = null; for (;;) { const r = P.page(lines, { source: 'bc_1', chars, cursor: cur }); const m = P.parsePage(r.text).meta; out.push(m); if (!m.has_more) break; cur = m.next_cursor; } return out; }
const rec = (g, m, tool, args) => L.record(g, tool || 'big_content', args || { id: 'bc_1' }, { ok: true, _page: m });

t('覆蓋：逐頁讀完 → 清空', () => {
  const ms = metas(mkLines(500), 3000); assert.ok(ms.length > 2);
  let g = L.createLedger(); ms.forEach((m, i) => { g = rec(g, m); if (i < ms.length - 1) assert.strictEqual(L.pending(g).length, 1); });
  assert.strictEqual(L.pending(g).length, 0);
});

t('覆蓋：跳到最後一頁不能清掉中間沒讀的部分（缺口 1）', () => {
  const ms = metas(mkLines(500), 3000);
  let g = rec(L.createLedger(), ms[0]); g = rec(g, ms[ms.length - 1]);
  const p = L.pending(g); assert.strictEqual(p.length, 1, '最後一頁沒有 has_more，但中間有洞，不能清掉');
  assert.strictEqual(p[0].blocking, true); assert.ok(p[0].gaps.length === 1 && p[0].gaps[0][0] === ms[0].to && p[0].gaps[0][1] === ms[ms.length - 1].from);
  assert.ok(L.reminderText(p).indexOf('還沒讀：第 ' + (ms[0].to + 1) + '～') > 0);
  assert.ok(L.describe(p[0]).indexOf('沒讀到') > 0);
  // 補讀中間的頁就完成
  for (let i = 1; i < ms.length - 1; i++) g = rec(g, ms[i]);
  assert.strictEqual(L.pending(g).length, 0);
});

t('覆蓋：反向讀、亂序讀、重複讀同一頁，最後都能合併成完整', () => {
  const ms = metas(mkLines(300), 2500); let g = L.createLedger();
  [...ms].reverse().forEach((m) => { g = rec(g, m); g = rec(g, m); });
  assert.strictEqual(L.pending(g).length, 0);
});

t('覆蓋：不同工具回的第一頁與後續頁算同一個來源（以 source 為準）', () => {
  const ms = metas(mkLines(300), 2500); let g = rec(L.createLedger(), ms[0], 'interpret_image', { file_id: 'f1' });
  for (let i = 1; i < ms.length; i++) g = rec(g, ms[i], 'big_content', { id: 'bc_1', action: 'page', cursor: ms[i - 1].next_cursor });
  assert.strictEqual(L.pending(g).length, 0);
});

t('覆蓋：兩個來源互不影響', () => {
  const a = metas(mkLines(200), 2500), b = P.page(mkLines(200), { source: 'bc_2', chars: 2500 });
  let g = rec(L.createLedger(), a[0]); g = L.record(g, 'big_content', { id: 'bc_2' }, { ok: true, _page: P.parsePage(b.text).meta });
  assert.strictEqual(L.pending(g).length, 2);
});

t('覆蓋：單筆太大分段，沒讀到最後一段不算讀完', () => {
  const lines = [JSON.stringify({ id: 0 }), JSON.stringify({ id: 1, blob: '資'.repeat(5000) }), JSON.stringify({ id: 2 })];
  const ms = metas(lines, 800); assert.ok(ms.some((m) => m.record_part));
  let g = L.createLedger(); ms.slice(0, -1).forEach((m) => { g = rec(g, m); }); assert.strictEqual(L.pending(g).length, 1);
  g = rec(g, ms[ms.length - 1]); assert.strictEqual(L.pending(g).length, 0);
});

t('覆蓋：只讀了第一頁，提醒裡有可直接用的 cursor 與缺口', () => {
  const ms = metas(mkLines(500), 3000); const g = rec(L.createLedger(), ms[0]);
  const txt = L.reminderText(L.pending(g), { cursorFor: (s, i) => P.encodeCursor({ source: s, index: i, part: 0, page: 0 }) });
  assert.ok(txt.indexOf('c1:bc_1:' + ms[0].to + ':0:0') > 0, txt);
});

t('覆蓋：失敗結果不改帳本；舊式 has_more 來源與新式並存', () => {
  const ms = metas(mkLines(300), 2500); let g = rec(L.createLedger(), ms[0]);
  g = L.record(g, 'big_content', { id: 'bc_1' }, { ok: false, _page: ms[1] }); assert.strictEqual(L.pending(g)[0].covered.length, 1);
  g = L.record(g, 'fap_read_file', A, { ok: true, has_more: true, next_offset: 100 }); assert.strictEqual(L.pending(g).length, 2);
});

console.log(n + ' tests passed');
