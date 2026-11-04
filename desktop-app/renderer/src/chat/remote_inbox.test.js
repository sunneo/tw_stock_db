// node renderer/src/chat/remote_inbox.test.js
'use strict';
const assert = require('assert');
const R = require('./remote_inbox.js');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok - ' + name); }
function seqIds(prefix) { let k = 0; return () => prefix + (++k); }

t('inboxIdFor：沒有收件對話 → id null、標題「遠端需求 · 節點」、existing false', () => {
  const r = R.inboxIdFor([], 'B機');
  assert.strictEqual(r.id, null);
  assert.strictEqual(r.title, '遠端需求 · B機');
  assert.strictEqual(r.existing, false);
});

t('inboxIdFor：nodeName 空白 → invalid', () => {
  assert.strictEqual(R.inboxIdFor([], '  ').invalid, true);
  assert.strictEqual(R.inboxIdFor([], null).invalid, true);
});

t('ensureInbox：第一次建立，第二次沿用（只建一次）', () => {
  const a = R.ensureInbox([], 'B機', { newId: seqIds('in'), now: 10 });
  assert.strictEqual(a.created, true);
  assert.strictEqual(a.inboxId, 'in1');
  assert.strictEqual(a.chats.length, 1);
  assert.strictEqual(a.chats[0].kind, 'remote-inbox');
  assert.strictEqual(a.chats[0].nodeName, 'B機');
  assert.strictEqual(a.chats[0].parentId, null);
  assert.strictEqual(a.chats[0].shared, false);
  const b = R.ensureInbox(a.chats, 'B機', { newId: seqIds('zz'), now: 20 });
  assert.strictEqual(b.created, false);
  assert.strictEqual(b.inboxId, 'in1');
  assert.strictEqual(b.chats.length, 1);
});

t('ensureInbox：不同節點各自一個收件對話', () => {
  const gen = seqIds('in');
  let r = R.ensureInbox([], 'A機', { newId: gen, now: 1 });
  r = R.ensureInbox(r.chats, 'B機', { newId: gen, now: 2 });
  r = R.ensureInbox(r.chats, 'A機', { newId: gen, now: 3 });
  assert.strictEqual(r.chats.filter(R.isInbox).length, 2);
  assert.strictEqual(R.inboxIdFor(r.chats, 'A機').id, 'in1');
  assert.strictEqual(R.inboxIdFor(r.chats, 'B機').id, 'in2');
});

t('ensureInbox：節點名去除前後空白後比對', () => {
  let r = R.ensureInbox([], ' B機 ', { newId: seqIds('in'), now: 1 });
  r = R.ensureInbox(r.chats, 'B機', { newId: seqIds('in'), now: 2 });
  assert.strictEqual(r.chats.filter(R.isInbox).length, 1);
  assert.strictEqual(r.chats[0].nodeName, 'B機');
});

t('ensureInbox 不修改傳入的陣列', () => {
  const src = [{ id: 'x', title: '甲', createdAt: 1 }];
  const r = R.ensureInbox(src, 'B機', { newId: seqIds('in'), now: 1 });
  assert.strictEqual(src.length, 1);
  assert.strictEqual(r.chats.length, 2);
});

t('attachRemoteChild：同節點多筆都掛到同一個收件對話', () => {
  let chats = [];
  const a = R.attachRemoteChild(chats, 'B機', { id: 'c1' }, { newId: seqIds('in'), now: 1 });
  assert.strictEqual(a.parentId, 'in1');
  assert.strictEqual(a.nodeName, 'B機');
  assert.strictEqual(a.created, true);
  const b = R.attachRemoteChild(a.chats, 'B機', { id: 'c2' }, { newId: seqIds('in'), now: 2 });
  assert.strictEqual(b.parentId, 'in1');
  assert.strictEqual(b.created, false);
  assert.strictEqual(b.chats.filter(R.isInbox).length, 1);
});

t('attachRemoteChild：不同節點各掛各的收件對話', () => {
  const gen = seqIds('in');
  let r = R.attachRemoteChild([], 'A機', { id: 'c1' }, { newId: gen, now: 1 });
  const b = R.attachRemoteChild(r.chats, 'B機', { id: 'c2' }, { newId: gen, now: 2 });
  assert.strictEqual(b.parentId, 'in2');
});

t('attachRemoteChild：節點名空白 → parentId null，不建收件對話', () => {
  const r = R.attachRemoteChild([], '', { id: 'c1' });
  assert.strictEqual(r.parentId, null);
  assert.strictEqual(r.chats.length, 0);
});

t('migrateRemoteChats：舊的遠端對話（有 remote、沒有 parentId）收進收件對話，只改索引欄位', () => {
  const old = [
    { id: 'o1', title: '來自 B機：寫程式', groupId: null, createdAt: 5, updatedAt: 6, touched: true, shared: true, remote: { fromName: 'B機', fromId: 'n2', taskId: 't1', at: 5, fp: '' } },
    { id: 'o2', title: '來自 B機：畫圖', groupId: 'g1', createdAt: 7, updatedAt: 8, touched: true, shared: true, remote: { fromName: 'B機', fromId: 'n2', taskId: 't2', at: 7, fp: '' } },
  ];
  const out = R.migrateRemoteChats(old, { newId: seqIds('in'), now: 1 });
  const inbox = out.filter(R.isInbox);
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].id, 'in1');
  const c1 = out.find((c) => c.id === 'o1'), c2 = out.find((c) => c.id === 'o2');
  assert.strictEqual(c1.parentId, 'in1');
  assert.strictEqual(c2.parentId, 'in1');
  assert.strictEqual(c1.nodeName, 'B機');
  // 內容欄位不動
  assert.strictEqual(c1.title, '來自 B機：寫程式');
  assert.strictEqual(c2.groupId, 'g1');
  assert.deepStrictEqual(c1.remote, old[0].remote);
  // 原陣列不被改寫
  assert.strictEqual(old[0].parentId, undefined);
  assert.strictEqual(old[0].nodeName, undefined);
});

t('migrateRemoteChats：已經有 parentId 的不動（包括子對話）', () => {
  const src = [
    { id: 'p', title: '父', createdAt: 1, parentId: null },
    { id: 'k', title: '子', createdAt: 2, parentId: 'p', remote: { fromName: 'B機' } },
  ];
  const out = R.migrateRemoteChats(src, { newId: seqIds('in'), now: 1 });
  assert.deepStrictEqual(out.find((c) => c.id === 'k'), src[1]);
  assert.strictEqual(out.filter(R.isInbox).length, 0);
});

t('migrateRemoteChats：已有 nodeName 的保留；沒有 nodeName 用 remote.fromName 補', () => {
  const src = [
    { id: 'a', title: '甲', createdAt: 1, remote: { fromName: '舊名' }, nodeName: '新名' },
    { id: 'b', title: '乙', createdAt: 2, remote: { fromName: 'C機' } },
  ];
  const out = R.migrateRemoteChats(src, { newId: seqIds('in'), now: 1 });
  assert.strictEqual(out.find((c) => c.id === 'a').nodeName, '新名');
  assert.strictEqual(out.find((c) => c.id === 'a').parentId, 'in1'); // 收件對話用已有的 nodeName「新名」
  assert.strictEqual(out.find((c) => c.id === 'b').nodeName, 'C機');
  assert.strictEqual(out.filter(R.isInbox).length, 2);
});

t('migrateRemoteChats：沒有 remote 欄位的對話不動（即使有 nodeName）', () => {
  const src = [{ id: 'z', title: '本機', createdAt: 1, nodeName: 'B機' }];
  const out = R.migrateRemoteChats(src, { newId: seqIds('in'), now: 1 });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].parentId, undefined);
});

t('migrateRemoteChats：remote 沒有節點名 → 不動（留在根）', () => {
  const src = [{ id: 'q', title: '無名', createdAt: 1, remote: {} }];
  const out = R.migrateRemoteChats(src, { newId: seqIds('in'), now: 1 });
  assert.strictEqual(out[0].parentId, undefined);
  assert.strictEqual(out.filter(R.isInbox).length, 0);
});

t('migrateRemoteChats：重跑一次結果不變（冪等）', () => {
  const src = [{ id: 'o1', title: 'x', createdAt: 1, remote: { fromName: 'B機' } }];
  const once = R.migrateRemoteChats(src, { newId: seqIds('in'), now: 1 });
  const twice = R.migrateRemoteChats(once, { newId: seqIds('zz'), now: 2 });
  assert.deepStrictEqual(twice, once);
});

t('migrateRemoteChats：不是陣列或含非物件 → 回傳乾淨陣列', () => {
  assert.deepStrictEqual(R.migrateRemoteChats(null), []);
  assert.deepStrictEqual(R.migrateRemoteChats([null, 3, 'x']), []);
});

console.log('全部通過：' + n + ' 項');
