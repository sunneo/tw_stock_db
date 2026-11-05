// node renderer/src/agent/jsonl_pager.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const P = require('./jsonl_pager.js');
// 也驗證 new Function 載入（嵌入版就是這樣載入的）
const holder = { exports: {} }; new Function('module', fs.readFileSync(require.resolve('./jsonl_pager.js'), 'utf8'))(holder);
assert.strictEqual(typeof holder.exports.page, 'function');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok - ' + name); }
const mk = (c) => Array.from({ length: c }, (_, i) => ({ id: i, name: '物件' + i, bbox: [i, i + 1, i + 2, i + 3], label: '標籤 emoji 😀 \n換行' }));

// 逐頁讀完，回傳 { records, parts, pages, metas }
function readAll(lines, opts, maxPages) {
  let cursor = null, pages = 0; const records = [], metas = []; const partsByRec = {};
  for (; pages < (maxPages || 100000);) {
    const r = P.page(lines, Object.assign({}, opts, { cursor }));
    assert.ok(r.ok, r.error);
    const pp = P.parsePage(r.text); assert.ok(pp, '第一行要是 _page');
    assert.strictEqual(pp.bad.length, 0);
    pages++; metas.push(pp.meta);
    pp.records.forEach((x) => records.push(x));
    pp.parts.forEach((x) => { (partsByRec[x.record] = partsByRec[x.record] || []).push(x); });
    if (!pp.meta.has_more) break;
    cursor = pp.meta.next_cursor;
  }
  return { records, partsByRec, pages, metas };
}

t('頂層陣列：逐頁讀完串回去逐筆相等', () => {
  const data = mk(1000), rec = P.toRecords(JSON.stringify(data));
  assert.strictEqual(rec.shape, 'array'); assert.strictEqual(rec.lines.length, 1000);
  const r = readAll(rec.lines, { source: 'bc_1', ctxTokens: 4096, fraction: 0.15 });
  assert.deepStrictEqual(r.records, data);
  assert.ok(r.pages > 1);
  assert.strictEqual(r.metas[r.metas.length - 1].done, true);
  assert.strictEqual(r.metas[r.metas.length - 1].read_records, 1000);
});

t('物件含一個大陣列：head 只在第一頁，記錄串回去相等', () => {
  const data = { ok: true, image: 'a.png', objects: mk(300) }, rec = P.toRecords(data);
  assert.strictEqual(rec.shape, 'field:objects'); assert.strictEqual(rec.head.ok, true); assert.strictEqual(rec.head.image, 'a.png');
  const r = readAll(rec.lines, { source: 'x', ctxTokens: 2048, fraction: 0.15, head: rec.head });
  assert.deepStrictEqual(r.records, data.objects);
  assert.ok(r.metas[0].head && !r.metas[1].head);
});

t('巢狀兩層的大陣列', () => {
  const rec = P.toRecords({ result: { items: mk(50) }, note: 'x' });
  assert.strictEqual(rec.shape, 'field:result.items'); assert.strictEqual(rec.lines.length, 50);
});

t('不是記錄清單回 null：純量、空、單筆、沒有大陣列、不是 JSON', () => {
  [null, '', '123', '"abc"', '[]', '[1]', '{"a":1,"b":"x"}', '一般文字', '{"a":[1,2],"b":"' + 'x'.repeat(500) + '"}'].forEach((x) => assert.strictEqual(P.toRecords(x), null, String(x).slice(0, 30)));
});

t('JSONL 文字：好行＋壞行混合，壞行不丟', () => {
  const text = '{"a":1}\n{"a":2}\n{壞掉\n\n{"a":3}\n';
  const rec = P.toRecords(text);
  assert.strictEqual(rec.shape, 'jsonl'); assert.strictEqual(rec.bad, 1); assert.strictEqual(rec.lines.length, 4);
  assert.ok(rec.lines.some((l) => l.indexOf('_bad_line') >= 0));
});

t('JSONL 文字：壞行過半就不當 JSONL', () => {
  assert.strictEqual(P.toRecords('{"a":1}\n{x\n{y\n{z'), null);
});

t('parseLines：空行略過但行號照算、CRLF、BOM', () => {
  const r = P.parseLines('﻿{"a":1}\r\n\r\n{"a":2}\r\nxx');
  assert.deepStrictEqual(r.values.map((v) => v.line), [1, 3]); assert.strictEqual(r.bad[0].line, 4);
});

t('單筆比一頁大：分段續傳，串回去逐字相等，不丟', () => {
  const big = { id: 9, text: '很長的內容😀'.repeat(400) };
  const data = [{ id: 1 }, big, { id: 3 }];
  const rec = P.toRecords(data);
  const r = readAll(rec.lines, { source: 's', chars: 900 });
  assert.deepStrictEqual(r.records.map((x) => x.id), [1, 3]);
  const parts = r.partsByRec[1]; assert.ok(parts.length > 1);
  parts.forEach((p, i) => assert.strictEqual(p.part, i));
  assert.deepStrictEqual(JSON.parse(parts.map((p) => p.text).join('')), big);
});

t('窗口大小：2048／4096／32768／1000000，每頁至少 1 筆，頁越大筆數越多', () => {
  const rec = P.toRecords(mk(5000));
  let last = 0;
  [2048, 4096, 32768, 1000000].forEach((ctx) => {
    const r = P.page(rec.lines, { source: 'w', ctxTokens: ctx, fraction: 0.15 });
    assert.ok(r.to - r.from >= 1);
    assert.ok(r.to - r.from >= last, '窗口越大一頁筆數不能變少');
    last = r.to - r.from;
  });
  const tiny = P.page(rec.lines, { source: 'w', chars: 1 });
  assert.ok(tiny.ok && tiny.hasMore && tiny.nextCursor && P.parsePage(tiny.text).parts.length === 1, '預算小到放不下也至少給 1 段，而且游標往前走');
});

t('原始碼沒有寫死的字元下限（budgetChars 只由窗口決定）', () => {
  assert.strictEqual(P.budgetChars({ ctxTokens: 100, fraction: 0.1 }), 30);
  assert.strictEqual(P.budgetChars({ ctxTokens: 0 }), 1);
});

t('cursor：竄改、別的來源、超出範圍、版本不對都回明確錯誤', () => {
  const rec = P.toRecords(mk(100)); const first = P.page(rec.lines, { source: 'a', chars: 2000 });
  const cur = first.nextCursor; assert.ok(cur);
  assert.ok(!P.page(rec.lines, { source: 'b', chars: 2000, cursor: cur }).ok);
  assert.ok(!P.page(rec.lines, { source: 'a', chars: 2000, cursor: 'zzz' }).ok);
  assert.ok(!P.page(rec.lines, { source: 'a', chars: 2000, cursor: 'c1:a:9999:0:1' }).ok);
  assert.ok(!P.page(rec.lines, { source: 'a', chars: 2000, cursor: 'c2:a:1:0:1' }).ok);
  assert.ok(!P.page(rec.lines, { source: 'a', chars: 2000, cursor: 'c1:a:-1:0:1' }).ok);
  assert.ok(P.page(rec.lines, { source: 'a', chars: 2000, cursor: cur }).ok);
});

t('讀到最後之後再讀：回空頁 done', () => {
  const rec = P.toRecords(mk(3)); const end = P.page(rec.lines, { source: 'a', cursor: P.encodeCursor({ source: 'a', index: 3, part: 0, page: 2 }) });
  assert.ok(end.ok); assert.strictEqual(P.parsePage(end.text).meta.done, true);
});

t('反向讀、重複讀同一頁：同一個 cursor 得到同一份', () => {
  const rec = P.toRecords(mk(200)); const a = P.page(rec.lines, { source: 'a', chars: 3000 });
  const b1 = P.page(rec.lines, { source: 'a', chars: 3000, cursor: a.nextCursor }), b2 = P.page(rec.lines, { source: 'a', chars: 3000, cursor: a.nextCursor });
  assert.strictEqual(b1.text, b2.text);
  assert.strictEqual(P.parsePage(b1.text).meta.digest, P.parsePage(b2.text).meta.digest);
});

t('8000 個物件：逐頁讀完相等', () => {
  const data = mk(8000), rec = P.toRecords(JSON.stringify({ objects: data }));
  const r = readAll(rec.lines, { source: 'v', ctxTokens: 8192, fraction: 0.15 });
  assert.strictEqual(r.records.length, 8000); assert.deepStrictEqual(r.records[7999], data[7999]);
});

t('每一頁的記錄行都是單行（內容的換行已跳脫）', () => {
  const rec = P.toRecords(mk(20)); const r = P.page(rec.lines, { source: 'a', chars: 100000 });
  r.text.split('\n').forEach((l, i) => { if (l) JSON.parse(l); });
});

t('head 太大就不塞；continue 提示帶 cursor', () => {
  const rec = P.toRecords(mk(50));
  const p1 = P.parsePage(P.page(rec.lines, { source: 'a', chars: 3000, head: { big: 'x'.repeat(5000) }, continueWith: 'big_content({"id":"a","action":"page","cursor":"<CURSOR>"})' }).text).meta;
  assert.strictEqual(p1.head_omitted, true); assert.ok(!p1.head);
  assert.ok(p1.continue.indexOf(p1.next_cursor) > 0 && p1.continue.indexOf('<CURSOR>') < 0);
});

console.log('全部通過：' + n);
