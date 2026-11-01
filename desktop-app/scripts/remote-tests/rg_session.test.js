// node scripts/remote-tests/rg_session.test.js -- 多人同編核心：主持機排序、副本收斂、衝突略過、唯讀、各人獨立復原、離線暫存、重連補漏
const S = require('../../renderer/src/remote/rg_session.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const J = (x) => JSON.stringify(x);
const A = { nodeId: 'a', name: '小明', kind: 'desktop' }, B = { nodeId: 'b', name: '阿華', kind: 'web' }, C = { nodeId: 'c', name: '小美', kind: 'desktop' };
const doc0 = { title: 'T', objects: [{ id: 'o1', x: 1, name: '一' }, { id: 'o2', x: 2, name: '二' }, { id: 'o3', x: 3, name: '三' }] };
const mk = () => { const host = S.createHost({ spec: doc0 }); const rs = {}; for (const w of [A, B, C]) { host.join(w); rs[w.nodeId] = S.createReplica({ spec: doc0, rev: 0, nodeId: w.nodeId }); } return { host, rs }; };
const bcast = (host, rs, r) => { if (r.ok) for (const k in rs) rs[k].receive(r.commit); return r; };
const edit = (rep, fn) => { const next = JSON.parse(J(rep.spec)); fn(next); return rep.diffTo(next); };   // 提出者在自己的副本上改完,送差異

// 1. 一個人改 → 所有副本收斂
let { host, rs } = mk();
let r = bcast(host, rs, host.propose(A, { patch: edit(rs.a, (d) => { d.objects[0].x = 10; }), summary: '移動一' }));
check('提出被編號', r.ok && r.commit.rev === 1 && r.commit.by.name === '小明' && r.commit.by.src === 'user');
check('三個副本一樣', J(rs.a.spec) === J(host.spec) && J(rs.b.spec) === J(host.spec) && J(rs.c.spec) === J(host.spec) && rs.b.rev === 1);
// 2. 並發：兩人同時改不同物件 → 都保留
{ const m = mk(); const pa = edit(m.rs.a, (d) => { d.objects[0].x = 11; }), pb = edit(m.rs.b, (d) => { d.objects[1].name = '二改'; });
  bcast(m.host, m.rs, m.host.propose(A, { patch: pa })); bcast(m.host, m.rs, m.host.propose(B, { patch: pb }));
  check('不同物件並發都保留', m.host.spec.objects[0].x === 11 && m.host.spec.objects[1].name === '二改' && J(m.rs.c.spec) === J(m.host.spec)); }
// 3. 並發：同一屬性 → 後到者贏;對象被刪 → 略過並回報
{ const m = mk(); const pa = edit(m.rs.a, (d) => { d.objects[0].x = 11; }), pb = edit(m.rs.b, (d) => { d.objects[0].x = 22; }), pc = edit(m.rs.c, (d) => { d.objects[2].name = '三改'; });
  const pdel = edit(m.rs.a, (d) => { d.objects.splice(2, 1); });
  bcast(m.host, m.rs, m.host.propose(A, { patch: pa })); bcast(m.host, m.rs, m.host.propose(B, { patch: pb }));
  check('同屬性後到者贏', m.host.spec.objects[0].x === 22);
  bcast(m.host, m.rs, m.host.propose(A, { patch: pdel }));
  const r3 = m.host.propose(C, { patch: pc }); check('改到被刪的對象：全被略過、不編號', !r3.ok && r3.error === 'all-rejected' && r3.rejected.length > 0 && m.host.rev === 3, r3);
  const mixed = pc.concat(edit(m.rs.c, (d) => { d.title = 'T2'; })); const r4 = m.host.propose(C, { patch: mixed });
  check('部分略過：其餘照套且 commit 只含套上的', r4.ok && r4.rejected.length > 0 && m.host.spec.title === 'T2' && r4.commit.patch.length < mixed.length, r4); }
// 4. 唯讀、移除
{ const m = mk(); m.host.setReadonly('c', true); const r5 = m.host.propose(C, { patch: edit(m.rs.c, (d) => { d.title = 'x'; }) }); check('唯讀者被拒', !r5.ok && r5.error === 'readonly' && m.host.rev === 0);
  m.host.setReadonly('c', false); check('解除唯讀', m.host.propose(C, { patch: edit(m.rs.c, (d) => { d.title = 'x'; }) }).ok);
  check('成員清單', m.host.members().length === 3 && m.host.members().find((x) => x.nodeId === 'b').kind === 'web'); }
// 5. 各人獨立復原
{ const m = mk();
  bcast(m.host, m.rs, m.host.propose(A, { patch: edit(m.rs.a, (d) => { d.objects[0].x = 100; }), summary: 'A 改 o1' }));
  bcast(m.host, m.rs, m.host.propose(B, { patch: edit(m.rs.b, (d) => { d.objects[1].x = 200; }), summary: 'B 改 o2' }));
  bcast(m.host, m.rs, m.host.propose(A, { patch: edit(m.rs.a, (d) => { d.objects.push({ id: 'o4', x: 4, name: '四' }); }), summary: 'A 加 o4' }));
  check('A 有 2 步可復原、B 有 1 步、C 沒有', m.rs.a.undoable() && m.rs.b.undoable() && !m.rs.c.undoable());
  let u = m.rs.a.undoPatch(); r = bcast(m.host, m.rs, m.host.propose(A, Object.assign({}, u))); check('A 復原最近一步＝移掉 o4，B 的改動留著', r.ok && !m.host.spec.objects.some((o) => o.id === 'o4') && m.host.spec.objects[1].x === 200, m.host.spec);
  u = m.rs.a.undoPatch(); bcast(m.host, m.rs, m.host.propose(A, Object.assign({}, u))); check('A 再復原＝o1 回原值，B 的 o2 不受影響', m.host.spec.objects[0].x === 1 && m.host.spec.objects[1].x === 200);
  check('A 沒得復原了；B 還有', !m.rs.a.undoable() && m.rs.b.undoable());
  u = m.rs.b.undoPatch(); bcast(m.host, m.rs, m.host.propose(B, Object.assign({}, u))); check('B 復原自己的', m.host.spec.objects[1].x === 2 && J(m.rs.c.spec) === J(m.host.spec));
  u = m.rs.a.redoPatch(); r = bcast(m.host, m.rs, m.host.propose(A, Object.assign({}, u))); check('A 重做', r.ok && m.host.spec.objects[0].x === 100 && m.rs.a.undoable());
  bcast(m.host, m.rs, m.host.propose(A, { patch: edit(m.rs.a, (d) => { d.title = '新'; }) })); check('新的步驟清掉重做', !m.rs.a.redoable()); }
// 6. 復原遇到對象被別人刪了:略過;全被略過 → 步驟放回
{ const m = mk();
  bcast(m.host, m.rs, m.host.propose(A, { patch: edit(m.rs.a, (d) => { d.objects[0].x = 50; }), summary: '改 o1' }));
  bcast(m.host, m.rs, m.host.propose(B, { patch: edit(m.rs.b, (d) => { d.objects.shift(); }), summary: '刪 o1' }));
  const u = m.rs.a.undoPatch(); const r6 = m.host.propose(A, Object.assign({}, u)); check('復原目標已被刪：全略過', !r6.ok && r6.error === 'all-rejected');
  m.rs.a.undoFailed(); check('復原失敗後步驟放回', m.rs.a.undoable() && !m.rs.a.redoable()); }
// 7. 漏了 commit → gap;補送後收斂;太舊要整份
{ const m = mk(); const cs = []; for (let i = 1; i <= 5; i++) { const x = m.host.propose(A, { patch: edit({ get spec() { return m.host.spec; }, diffTo: (n) => require('../../renderer/src/remote/rg_patch.js').diff(m.host.spec, n) }, (d) => { d.objects[0].x = 100 + i; }) }); cs.push(x.commit); }
  const late = S.createReplica({ spec: doc0, rev: 0, nodeId: 'z' }); check('跳號回報 gap', late.receive(cs[2]) === 'gap');
  const miss = m.host.since(0); check('補送序列', miss.length === 5 && miss.every((c, i) => late.receive(c) === 'ok') && J(late.spec) === J(m.host.spec));
  check('重複的 commit 是 dup', late.receive(cs[0]) === 'dup');
  const small = S.createHost({ spec: doc0, maxLog: 2 }); for (let i = 0; i < 4; i++) small.propose(A, { patch: [{ op: 'set', at: ['title'], value: 't' + i }] }); check('log 太短時 since 回 null（要整份）', small.since(0) === null && small.since(3).length === 1);
  const bad = S.createReplica({ spec: { title: 'zzz', objects: [] }, rev: 0 }); check('文件對不上（hashAfter）回報 diverged', bad.receive(cs[0]) === 'diverged'); }
// 8. 主持機離線:暫存、回來依序送
{ const m = mk(); const q = m.rs.b; q.enqueue({ patch: edit(q, (d) => { d.title = '離線1'; }) }); q.enqueue({ patch: edit(q, (d) => { d.objects[1].name = '離線2'; }) });
  check('暫存兩筆', q.queued().length === 2); const items = q.drain(); let okc = 0; for (const it of items) { const r8 = bcast(m.host, m.rs, m.host.propose(B, it)); if (r8.ok) okc++; }
  check('回來後依序送出', okc === 2 && m.host.spec.title === '離線1' && m.host.spec.objects[1].name === '離線2' && q.queued().length === 0 && J(m.rs.a.spec) === J(m.host.spec)); }
// 9. 空提出、顏色
check('空 patch 不編號', !mk().host.propose(A, { patch: [] }).ok && S.color('小明') === S.color('小明') && S.color('小明') !== S.color('阿華'));
check('by 帶 AI 資訊', (() => { const m = mk(); const x = m.host.propose(B, { patch: [{ op: 'set', at: ['title'], value: 'AI' }], src: 'ai', exec: { nodeId: 'c', name: '小美' }, req: { nodeId: 'b', name: '阿華' } }); return x.commit.by.src === 'ai' && x.commit.by.exec.name === '小美' && x.commit.by.req.name === '阿華'; })());
console.log('rg_session: ' + ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '：\n  ' + bad.join('\n  ') : ''));
process.exit(bad.length ? 1 : 0);
