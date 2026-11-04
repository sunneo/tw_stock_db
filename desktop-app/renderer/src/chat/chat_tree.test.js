// node renderer/src/chat/chat_tree.test.js
'use strict';
const assert = require('assert');
const T = require('./chat_tree.js');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok - ' + name); }
function ids(rows) { return rows.map((r) => r.chat.id + '@' + r.depth); }

t('舊資料（沒有新欄位）補 null，既有欄位不變', () => {
  const old = { id: 'a', title: '舊對話', groupId: 'g1', createdAt: 1, updatedAt: 2, touched: true, remote: { fromName: 'X' } };
  const out = T.normalizeChatEntry(old);
  assert.strictEqual(out.parentId, null);
  assert.strictEqual(out.status, null);
  assert.strictEqual(out.topicId, null);
  assert.strictEqual(out.fingerprint, null);
  assert.strictEqual(out.summary, null);
  assert.strictEqual(out.nodeName, null);
  assert.strictEqual(out.id, 'a');
  assert.strictEqual(out.title, '舊對話');
  assert.strictEqual(out.groupId, 'g1');
  assert.strictEqual(out.createdAt, 1);
  assert.strictEqual(out.updatedAt, 2);
  assert.strictEqual(out.touched, true);
  assert.deepStrictEqual(out.remote, { fromName: 'X' });
  assert.ok(!('parentId' in old), '不改傳入的物件');
});

t('normalizeChatEntry：非法 status 與空字串 parentId 正規化為 null；已有的合法值保留', () => {
  assert.strictEqual(T.normalizeChatEntry({ id: 'x', status: 'bogus' }).status, null);
  assert.strictEqual(T.normalizeChatEntry({ id: 'x', parentId: '' }).parentId, null);
  assert.strictEqual(T.normalizeChatEntry({ id: 'x', parentId: 'p', status: 'waiting_user', summary: 's' }).status, 'waiting_user');
  assert.strictEqual(T.normalizeChatEntry({ id: 'x', parentId: 'p', summary: 's' }).summary, 's');
  assert.strictEqual(T.normalizeChatEntry(null), null);
});

t('normalizeChats 過濾非物件並逐筆補齊', () => {
  const out = T.normalizeChats([{ id: 'a' }, null, 'junk', { id: 'b', parentId: 'a' }]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].parentId, 'a');
});

t('根與子：沒有 parentId 的是根；childrenOf 依建立時間舊到新', () => {
  const chats = [
    { id: 'p', createdAt: 10 },
    { id: 'q', createdAt: 20 },
    { id: 'c2', parentId: 'p', createdAt: 30 },
    { id: 'c1', parentId: 'p', createdAt: 15 },
  ];
  assert.deepStrictEqual(T.rootChats(chats).map((c) => c.id), ['q', 'p']); // 根：新到舊
  assert.deepStrictEqual(T.childrenOf(chats, 'p').map((c) => c.id), ['c1', 'c2']); // 子：舊到新
  assert.deepStrictEqual(T.childrenOf(chats, 'q'), []);
  assert.deepStrictEqual(T.childrenOf(chats, '不存在'), []);
});

t('孤兒子對話（parent 不存在）視為根', () => {
  const chats = [{ id: 'o', parentId: '已刪除', createdAt: 5 }, { id: 'r', createdAt: 1 }];
  assert.deepStrictEqual(T.rootChats(chats).map((c) => c.id), ['o', 'r']);
  const rows = T.flattenTree(chats, {});
  assert.deepStrictEqual(ids(rows), ['o@0', 'r@0']);
});

t('自己指自己、兩個互指：環上的每一筆都當根，不無限迴圈', () => {
  const chats = [
    { id: 'self', parentId: 'self', createdAt: 1 },
    { id: 'a', parentId: 'b', createdAt: 2 },
    { id: 'b', parentId: 'a', createdAt: 3 },
    { id: 'tail', parentId: 'a', createdAt: 4 }, // 掛在環上的子：變成環上某一根的子對話，不是環的一部分
  ];
  const roots = T.rootChats(chats).map((c) => c.id);
  assert.deepStrictEqual(roots.slice().sort(), ['a', 'b', 'self']);
  const rows = T.flattenTree(chats, { a: true, b: true });
  assert.strictEqual(rows.length, 4, '四筆都要出現且只出現一次');
  const tail = rows.find((r) => r.chat.id === 'tail');
  assert.strictEqual(tail.depth, 1, 'tail 是 a 的子對話（a 在環上，變根）');
});

t('巢狀三層：父→子→孫，收合時只顯示父，展開後順序為父、子、孫', () => {
  const chats = [
    { id: 'p', createdAt: 1 },
    { id: 'c', parentId: 'p', createdAt: 2 },
    { id: 'g', parentId: 'c', createdAt: 3 },
    { id: 'q', createdAt: 0 },
  ];
  assert.deepStrictEqual(ids(T.flattenTree(chats, {})), ['p@0', 'q@0']);
  const p0 = T.flattenTree(chats, {}).find((r) => r.chat.id === 'p');
  assert.strictEqual(p0.childCount, 1);
  assert.strictEqual(p0.open, false);
  assert.deepStrictEqual(ids(T.flattenTree(chats, { p: true })), ['p@0', 'c@1', 'q@0']);
  assert.deepStrictEqual(ids(T.flattenTree(chats, { p: true, c: true })), ['p@0', 'c@1', 'g@2', 'q@0']);
});

t('expanded 只認 true；revealId 會展開祖先', () => {
  const chats = [{ id: 'p', createdAt: 1 }, { id: 'c', parentId: 'p', createdAt: 2 }, { id: 'g', parentId: 'c', createdAt: 3 }];
  assert.deepStrictEqual(ids(T.flattenTree(chats, { p: 'yes' })), ['p@0']);
  assert.deepStrictEqual(ids(T.flattenTree(chats, {}, { revealId: 'g' })), ['p@0', 'c@1', 'g@2']);
});

t('沒有任何子對話時，扁平結果與舊側欄的根清單順序一致（回歸）', () => {
  const chats = [{ id: 'a', createdAt: 1 }, { id: 'b', createdAt: 3 }, { id: 'c', createdAt: 2 }];
  assert.deepStrictEqual(T.flattenTree(chats, {}).map((r) => r.chat.id), ['b', 'c', 'a']);
  assert.ok(T.flattenTree(chats, {}).every((r) => r.depth === 0 && r.childCount === 0));
});

t('空輸入與壞輸入不丟例外', () => {
  assert.deepStrictEqual(T.flattenTree(undefined, undefined), []);
  assert.deepStrictEqual(T.flattenTree([null, 3], {}), []);
  assert.deepStrictEqual(T.rootChats(null), []);
});

console.log(n + ' tests passed');
