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

t('id→物件的對照表、很多欄位的大物件：一個欄位一行，逐頁讀完相等', () => {
  const map = {}; for (let i = 0; i < 400; i++) map['k' + i] = { name: '項目' + i, tags: ['a', 'b'], n: i };
  const rec = P.toRecords(JSON.stringify(map)); assert.strictEqual(rec.shape, 'entries'); assert.strictEqual(rec.lines.length, 400);
  const r = readAll(rec.lines, { source: 'm', chars: 3000 });
  const back = {}; r.records.forEach((x) => { back[x.key] = x.value; }); assert.deepStrictEqual(back, map);
  assert.strictEqual(P.toRecords({ a: 1, b: 2 }), null, '欄位太少不當清單');
});

t('head 太大就不塞；continue 提示帶 cursor', () => {
  const rec = P.toRecords(mk(50));
  const p1 = P.parsePage(P.page(rec.lines, { source: 'a', chars: 3000, head: { big: 'x'.repeat(5000) }, continueWith: 'big_content({"id":"a","action":"page","cursor":"<CURSOR>"})' }).text).meta;
  assert.strictEqual(p1.head_omitted, true); assert.ok(!p1.head);
  assert.ok(p1.continue.indexOf(p1.next_cursor) > 0 && p1.continue.indexOf('<CURSOR>') < 0);
});

t('超深結構攤平成 JSONL：節點一行、可逐字還原、自動判斷', () => {
  let d = { x: 1 }, c = d; for (let i = 0; i < 40; i++) { c.n = { a: [i, '中\n文', { 'k/~': null }], b: i % 2 === 0 }; c = c.n; }
  const f = P.flatten(d); assert.strictEqual(JSON.stringify(P.unflatten(f.lines)), JSON.stringify(d));
  assert.ok(f.lines.every((l) => l.indexOf('\n') < 0));
  const r = P.toRecords(JSON.stringify(d)); assert.strictEqual(r.shape, 'flat'); assert.strictEqual(r.lines.length, f.lines.length);
  assert.strictEqual(P.toRecords({ a: { b: 1 }, c: 2, d: 3 }).shape, 'entries'); // 不深就維持原本
  assert.strictEqual(P.toRecords(d, { flatten: true }).shape, 'flat');
  // 逐頁讀完能還原
  let cur = null, ls = []; for (let g = 0; g < 999; g++) { const pg = P.page(r.lines, { source: 'z', cursor: cur, chars: 600 }); ls = ls.concat(pg.text.split('\n').slice(1)); if (!pg.meta.has_more) break; cur = pg.meta.next_cursor; }
  assert.strictEqual(JSON.stringify(P.unflatten(ls)), JSON.stringify(d));
});

t('程式結構（AST）攤平：一個節點一行，帶 id／parent／field', () => {
  const ast = { type: 'Program', body: [
    { type: 'IfStatement', loc: { start: { line: 1 }, end: { line: 3 } }, test: { type: 'Identifier', name: 'a' },
      consequent: { type: 'BlockStatement', body: [{ type: 'ExpressionStatement', expression: { type: 'CallExpression', callee: { type: 'Identifier', name: 'f' }, arguments: [{ type: 'Literal', value: 1 }] } }] }, alternate: null },
    { type: 'ReturnStatement', argument: { type: 'Literal', value: 2 } }] };
  const f = P.flattenAst(ast); const ns = f.lines.map((l) => JSON.parse(l));
  assert.strictEqual(ns.length, 10); assert.deepStrictEqual(ns.map((n) => n.id), ns.map((_, i) => i));
  assert.strictEqual(ns[0].parent, null); assert.strictEqual(ns[0].children, 2);
  const iff = ns.find((n) => n.type === 'IfStatement'); assert.strictEqual(iff.parent, 0); assert.strictEqual(iff.field, 'body'); assert.strictEqual(iff.index, 0); assert.strictEqual(iff.props.loc.end.line, 3); assert.strictEqual(iff.props.alternate, null);
  const call = ns.find((n) => n.type === 'CallExpression'); assert.strictEqual(ns[call.parent].type, 'ExpressionStatement'); assert.strictEqual(call.field, 'expression');
  assert.strictEqual(ns.find((n) => n.type === 'Literal' && n.props.value === 1).field, 'arguments');
  assert.strictEqual(P.toRecords(ast).shape, 'ast');
});

t('AST 分頁：切在樹中間時標出不完整的節點，分頁讀完串回去等於整棵樹', () => {
  const mkn = (i) => ({ type: 'IfStatement', test: { type: 'Identifier', name: 'v' + i }, consequent: { type: 'BlockStatement', body: [{ type: 'ReturnStatement', argument: { type: 'Literal', value: i } }] } });
  const ast = { type: 'Program', body: Array.from({ length: 60 }, (_, i) => mkn(i)) };
  const f = P.flattenAst(ast); const all = f.lines.map((l) => JSON.parse(l));
  assert.strictEqual(all[0].size, all.length); assert.strictEqual(all[2].path, 'Program>IfStatement>Identifier');
  let cur = null, seen = [], sawInc = 0;
  for (let g = 0; g < 999; g++) {
    const pg = P.page(f.lines, { source: 'ast', cursor: cur, chars: 1500 }); const ls = pg.text.split('\n').slice(1).map((l) => JSON.parse(l)); seen = seen.concat(ls);
    if (pg.meta.incomplete) { sawInc++; const lastId = ls[ls.length - 1].id; pg.meta.incomplete.forEach((x) => { assert.ok(x.missing[0] === lastId + 1 && x.missing[1] >= x.missing[0]); const nd = all[x.id]; assert.strictEqual(nd.id + nd.size - 1, x.missing[1]); }); assert.ok(pg.meta.incomplete_note); }
    if (!pg.meta.has_more) { assert.ok(!pg.meta.incomplete); break; }
    cur = pg.meta.next_cursor;
  }
  assert.ok(sawInc > 0); assert.strictEqual(seen.length, all.length); assert.deepStrictEqual(seen.map((x) => x.id), all.map((x) => x.id));
  const p0 = P.page(f.lines, { source: 'ast', chars: 1500 }); assert.ok(!p0.meta.starts_inside);
  assert.ok(P.page(f.lines, { source: 'ast', cursor: p0.meta.next_cursor, chars: 1500 }).meta.starts_inside);
});
t('先看全貌再往下鑽：maxDepth 收合、expand 展開、合起來逐字還原', () => {
  const model = { name: 'M', classes: [{ name: 'A', attrs: [{ n: 'x', t: 'int' }], ops: [{ n: 'f', params: [{ n: 'p' }] }] }, { name: 'B', attrs: [], ops: [] }], relations: [{ from: 'A', to: 'B', kind: 'uses' }], meta: { a: { b: { c: [1, 2, { d: '深' }] } } } };
  const top = P.flatten(model, { maxDepth: 1 }); const tops = top.lines.map((l) => JSON.parse(l));
  assert.ok(tops.every((x) => x.depth <= 1)); assert.ok(tops.find((x) => x.path === '/classes').collapsed); assert.ok(tops.find((x) => x.path === '/classes').size > 5);
  const u0 = P.unflattenInfo(top.lines); assert.deepStrictEqual(u0.value.classes, []); assert.ok(u0.collapsedPaths.indexOf('/classes') >= 0);
  // 往下鑽幾次後（每次只多一層）還原成完整
  let lines = top.lines.slice(), pending = u0.collapsedPaths.slice(), guard = 0;
  while (pending.length && guard++ < 100) { const pth = pending.shift(); const ex = P.expand(model, pth, { levels: 1 }); assert.ok(ex.ok); lines = lines.concat(ex.lines); pending = P.unflattenInfo(lines).collapsedPaths; }
  assert.strictEqual(JSON.stringify(P.unflatten(lines)), JSON.stringify(model));
  assert.strictEqual(P.expand(model, '/nope').ok, false);
  assert.strictEqual(JSON.stringify(P.unflatten(P.expand(model, '', { levels: 99 }).lines)), JSON.stringify(model));
});
t('頁面 meta 帶 pages_left 估計；最後一頁與分段單筆不帶', () => {
  const lines = []; for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ id: i, text: 'x'.repeat(40) }));
  const p1 = P.page(lines, { source: 's', chars: 1200 }); assert.ok(p1.meta.pages_left >= 1 && p1.meta.pages_left === Math.ceil((100 - p1.to) / (p1.to - p1.from)), p1.meta);
  let cur = p1.nextCursor, last = p1; while (cur) { last = P.page(lines, { source: 's', cursor: cur, chars: 1200 }); cur = last.nextCursor; }
  assert.strictEqual(last.meta.pages_left, undefined);
  const big = [JSON.stringify({ a: 'y'.repeat(3000) }), JSON.stringify({ b: 1 })]; const pb = P.page(big, { source: 'b', chars: 600 }); assert.strictEqual(pb.meta.pages_left, undefined);
});
t('token 預算：中文 JSON 不再低估（4096 窗口一頁不超過比例），分段與全部讀完仍成立', () => {
  const est = (x) => { let c = 0; for (const ch of String(x)) { const k = ch.charCodeAt(0); if (k >= 0x3000 && k <= 0x9fff) c++; } return Math.ceil(c + (String(x).length - c) / 3.5); };
  const recs = []; for (let i = 0; i < 200; i++) recs.push({ id: i, name: '項目' + i, desc: '這是第' + i + '個項目的說明文字，大約三十個字左右。' });
  const rc = P.toRecords(JSON.stringify(recs)); const maxTokens = Math.floor(4096 * 0.15 * 0.9);
  const old = P.page(rc.lines, { source: 'b', chars: Math.floor(4096 * 0.15 * 3 * 0.9) });
  const pg = P.page(rc.lines, { source: 'b', maxTokens, tokensOf: est });
  assert.ok(est(pg.text) <= maxTokens + 10 && est(old.text) > maxTokens, [est(pg.text), est(old.text), maxTokens]);
  let cur = pg.nextCursor, got = pg.to - pg.from, guard = 0; while (cur && guard++ < 200) { const n = P.page(rc.lines, { source: 'b', cursor: cur, maxTokens, tokensOf: est }); got += n.to - n.from; cur = n.nextCursor; }
  assert.strictEqual(got, 200);
  const huge = [JSON.stringify({ t: '中'.repeat(3000) })]; const hp = P.page(huge, { source: 'h', maxTokens: 400, tokensOf: est });
  assert.ok(hp.meta.record_part && hp.meta.record_part.of > 1 && est(hp.text) <= 400 + 20, [hp.meta.record_part, est(hp.text)]);
});
console.log(n + ' passed, 0 failed');
