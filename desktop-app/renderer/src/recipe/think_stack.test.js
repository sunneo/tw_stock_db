// node renderer/src/recipe/think_stack.test.js
const S = require('./think_stack.js'); const assert = require('assert');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
t('push／pop：結果摘要變成上層的已定決定', () => {
  const s = S.create('做一個線上商店的 UML'); S.push(s, { path: 'system', question: '整體有哪些套件？' });
  S.push(s, { path: 'class:Order', question: '補 Order 的屬性與操作' }); S.decide(s, '訂單狀態用 enum OrderStatus');
  const r = S.pop(s, { summary: 'Order：id、total、pay()' }); assert.ok(r.ok); assert.strictEqual(s.frames.length, 1);
  assert.ok(S.current(s).decisions.some((d) => d.indexOf('class:Order：Order：id') === 0)); assert.strictEqual(S.pop(S.create('x'), {}).ok, false);
});
t('標頭：目標、路徑、現在這題、已定；深度與字元有上限', () => {
  const s = S.create('做一個線上商店的 UML');
  for (let i = 0; i < 8; i++) { S.push(s, { path: 'p' + i, question: '第' + i + '層的問題內容很長很長'.repeat(3) }); for (let k = 0; k < 8; k++) S.decide(s, '決定' + i + '-' + k + ' 這是一條比較長的決定內容用來撐字數'); }
  const h = S.header(s); assert.ok(h.length <= 600, h.length); assert.ok(h.startsWith('【目標】做一個線上商店的 UML')); assert.ok(h.indexOf('【現在這題】第7層') > 0); assert.ok(h.indexOf('… > p4 > p5 > p6 > p7') > 0 && h.indexOf('p0 >') < 0);
  assert.ok(h.indexOf('決定7-7') > 0, '最新的決定優先保留'); assert.ok(S.header(s, { maxHeaderChars: 120 }).length <= 120);
  assert.strictEqual(S.header(S.create('空')), '');
});
t('wrap：標頭放在最後一則 user 訊息前，repeat 在最後再說一次，不改原 messages', () => {
  const s = S.create('G'); S.push(s, { path: 'a', question: '這題？' });
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: '請回答' }]; const w = S.wrap(msgs, s, { repeat: true });
  assert.strictEqual(msgs[1].content, '請回答'); assert.ok(w[1].content.startsWith('【目標】G')); assert.ok(w[1].content.endsWith('這題？）')); assert.strictEqual(w[0].content, 'sys');
  assert.strictEqual(S.wrap(msgs, S.create('x')), msgs);
});
t('pop 的 verify：不過先重試一次，再放行並標 failed', () => {
  const s = S.create('G'); S.push(s, { path: 'a', question: 'q' });
  const bad = () => ({ ok: false, reason: '沒有 pay' }); const r1 = S.pop(s, { verify: bad, result: {} }); assert.ok(!r1.ok && r1.retry && s.frames.length === 1 && S.current(s).retries === 1);
  const r2 = S.pop(s, { verify: bad, result: {}, summary: 'x' }); assert.ok(r2.ok && r2.frame.state === 'failed' && s.frames.length === 0);
  S.push(s, { path: 'b', question: 'q2' }); assert.ok(S.pop(s, { verify: () => true, summary: 'ok' }).ok);
});
t('JSONL 往返：開放與已完成的框架都還原', () => {
  const s = S.create('G'); S.push(s, { path: 'a', question: 'qa' }); S.push(s, { path: 'b', question: 'qb' }); S.decide(s, 'd1'); S.pop(s, { summary: 'sb' }); S.push(s, { path: 'c', question: 'qc' });
  const ls = S.toJsonl(s); assert.ok(ls.every((l) => l.indexOf('\n') < 0)); const b = S.fromJsonl(ls);
  assert.deepStrictEqual(b.frames.map((f) => f.path), ['a', 'c']); assert.deepStrictEqual(b.done.map((f) => f.path), ['b']); assert.strictEqual(S.header(b), S.header(s)); assert.strictEqual(S.fromJsonl(['x']), null);
  const f = S.push(b, { path: 'z', question: 'q' }); assert.ok(f.id > 3);
});
t('標頭大小：典型 4 層約 200～300 字元（小窗口 4096 的 5% 以內）', () => {
  const s = S.create('做一個線上商店的 UML：顧客下單、付款、出貨');
  [['system', '整體有哪些套件？'], ['package:Billing', '補這個套件的類別'], ['class:Invoice', '補 Invoice 的屬性與操作'], ['members', '寫 pay 的參數']].forEach(([p, q]) => { S.push(s, { path: p, question: q }); S.decide(s, p + ' 已決定一件事'); });
  const h = S.header(s); assert.ok(h.length > 80 && h.length < 400, h.length);
});
(async () => {
  const mk = () => { const s = S.create('做一個線上商店'); S.push(s, { path: 'package:Billing', question: '重新設計套件 Billing' }); return s; };
  const ok = (v) => async (msgs, validate) => { assert.deepStrictEqual(validate(v), []); return v; };
  // planChecks：模型給的最多 3 項、去重、截短；失敗用程式預設
  let s = mk(); let seen = null; let r = await S.planChecks(s, { next: '逐一重做 3 個類別', defaults: ['預設一'], ask: async (m, v) => { seen = m; return { checks: [{ check: 'a', standard: '每個都有 id' }, 'a', 'b', { check: 'c' }, 'd'] }; } });
  assert.deepStrictEqual(r.checks, [{ check: 'a', standard: '每個都有 id' }, { check: 'b', standard: '' }, { check: 'c', standard: '' }]); assert.strictEqual(r.by, 'model'); assert.strictEqual(S.current(s).checks.length, 3); assert.ok(seen[0].content.includes('standard')); assert.ok(seen[1].content.startsWith('【目標】') && seen[1].content.includes('逐一重做 3 個類別'));
  s = mk(); r = await S.planChecks(s, { next: 'x', defaults: ['預設一', '預設二'], ask: async () => null }); assert.deepStrictEqual(r.checks.map((c) => c.check), ['預設一', '預設二']); assert.strictEqual(r.by, 'program');
  s = mk(); r = await S.planChecks(s, { next: 'x', defaults: [] }); assert.deepStrictEqual(r.checks, []);
  // 下一層的標頭帶上層待檢查
  s = mk(); await S.planChecks(s, { next: 'x', ask: ok({ checks: [{ check: '名稱不重複', standard: '全部類別名稱互不相同' }] }) }); S.push(s, { path: 'class:Invoice', question: '補 Invoice' }); assert.ok(S.header(s).includes('【回到上層後要檢查】名稱不重複（標準：全部類別名稱互不相同）'));
  // reviewReturn：逐項核對，有問題列出；問不出來 unsure
  S.pop(s, { summary: '屬性 id' }); let rv = await S.reviewReturn(s, { returned: 'class:Invoice 屬性 id', ask: ok({ results: [{ i: 1, ok: false, fix: '名稱和 Order 重複' }] }) });
  assert.strictEqual(rv.problems.length, 1); assert.strictEqual(rv.problems[0].fix, '名稱和 Order 重複'); assert.strictEqual(rv.problems[0].standard, '全部類別名稱互不相同'); assert.strictEqual(S.current(s).reviews.length, 1);
  rv = await S.reviewReturn(s, { returned: 'x', ask: async () => null }); assert.ok(rv.unsure && rv.problems.length === 0);
  rv = await S.reviewReturn(mk(), { returned: 'x', ask: ok({ results: [] }) }); assert.ok(!rv.unsure && rv.items.length === 0); // 沒有檢查項
  // selfValidate：自問
  s = mk(); S.push(s, { path: 'class:A', question: '補類別 A 的屬性與操作' });
  let sv = await S.selfValidate(s, { result: '屬性 id', ask: ok({ ok: false, missing: '沒有操作' }) }); assert.deepStrictEqual([sv.ok, sv.missing], [false, '沒有操作']);
  sv = await S.selfValidate(s, { result: 'x', ask: ok({ ok: true, missing: '' }) }); assert.strictEqual(sv.ok, true);
  sv = await S.selfValidate(s, { result: 'x', ask: async () => ({ nope: 1 }) }); assert.ok(sv.ok && sv.unsure); sv = await S.selfValidate(s, { result: 'x' }); assert.ok(sv.unsure);
  const seen2 = []; await S.selfValidate(s, { result: 'x', repeat: true, ask: async (m, v) => { seen2.push(m); return { ok: true, missing: '' }; } }); assert.ok(seen2[0][1].content.endsWith('補類別 A 的屬性與操作）'));
  // checks 在 JSONL 往返裡保留
  s = mk(); await S.planChecks(s, { next: 'x', ask: ok({ checks: [{ check: 'c1', standard: 's1' }] }) }); assert.deepStrictEqual(S.fromJsonl(S.toJsonl(s)).frames[0].checks, [{ check: 'c1', standard: 's1' }]);
  n++; console.log('ok - 往下之前列檢查、回來核對、離開前自問');
  console.log(n + ' passed, 0 failed');
})().catch((e) => { console.error(e); process.exit(1); });
