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
  // 使用者明確收合（false）過的父對話，不會被目前對話的路徑自動展開
  assert.deepStrictEqual(ids(T.flattenTree(chats, { p: false }, { revealId: 'g' })), ['p@0']);
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

const SELF = '本機';
const M = [
  { id: 'l1', title: '畫貓', createdAt: 1 },
  { id: 'l2', title: '寫 作業', createdAt: 2 },
  { id: 'l3', title: 'a/b', createdAt: 3 },
  { id: 'l4', title: '重複名', createdAt: 4 },
  { id: 'r1', title: '寫程式', nodeName: 'B機', createdAt: 5 },
  { id: 'r2', title: 'a/b', nodeName: 'n', createdAt: 6 }, // 完整名稱 n/a/b，對話名本身含 /
  { id: 'r3', title: '重複名', nodeName: 'B機', createdAt: 7 },
  { id: 'r4', title: '重複名', nodeName: 'C機', createdAt: 8 },
  { id: 'r5', title: '重複名', nodeName: 'B機', createdAt: 9 },
];

t('@ 解析：本機對話省略節點名', () => {
  const r = T.resolveMention(M, '@畫貓', SELF);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.chatId, 'l1');
  assert.strictEqual(r.remote, false);
  assert.strictEqual(r.nodeName, null);
});

t('@ 解析：遠端對話用「節點名/對話名」', () => {
  const r = T.resolveMention(M, '@B機/寫程式', SELF);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.chatId, 'r1');
  assert.strictEqual(r.remote, true);
  assert.strictEqual(r.nodeName, 'B機');
  assert.strictEqual(r.title, '寫程式');
});

t('@ 解析：遠端對話只寫對話名 → needNode，不會誤指', () => {
  const r = T.resolveMention(M, '@寫程式', SELF);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.needNode, true);
  assert.deepStrictEqual(r.candidates.map((c) => c.label), ['B機/寫程式']);
});

t('@ 解析：同名本機對話 → ambiguous 並列出候選', () => {
  const r = T.resolveMention([{ id: 'x1', title: 'dup', createdAt: 1 }, { id: 'x2', title: 'dup', createdAt: 2 }], '@dup', SELF);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.ambiguous, true);
  assert.deepStrictEqual(r.candidates.map((c) => c.chatId).sort(), ['x1', 'x2']);
});

t('@ 解析：同一節點內同名 → ambiguous；加上不同節點名就唯一', () => {
  const amb = T.resolveMention(M, '@B機/重複名', SELF);
  assert.strictEqual(amb.ambiguous, true);
  assert.deepStrictEqual(amb.candidates.map((c) => c.chatId).sort(), ['r3', 'r5']);
  const one = T.resolveMention(M, '@C機/重複名', SELF);
  assert.strictEqual(one.ok, true);
  assert.strictEqual(one.chatId, 'r4');
});

t('@ 解析：找不到與不是 @ 開頭', () => {
  assert.strictEqual(T.resolveMention(M, '@不存在', SELF).notFound, true);
  assert.strictEqual(T.resolveMention(M, 'hello', SELF).notMention, true);
  assert.strictEqual(T.resolveMention(M, '@', SELF).notMention, true);
  assert.strictEqual(T.resolveMention(M, '@   ', SELF).notMention, true);
});

t('@ 解析：忽略大小寫與前後空白', () => {
  const chats = [{ id: 'h', title: 'Hello World', createdAt: 1 }];
  assert.strictEqual(T.resolveMention(chats, '@  hello world  ', SELF).chatId, 'h');
});

t('@ 解析：含空白的名稱用方括號', () => {
  assert.strictEqual(T.resolveMention(M, '@[寫 作業]', SELF).chatId, 'l2');
  assert.strictEqual(T.resolveMention(M, '@[B機/寫程式]', SELF).chatId, 'r1');
});

t('@ 解析：對話名稱本身含 "/" 時，本機與遠端不互相誤指', () => {
  assert.strictEqual(T.resolveMention(M, '@a/b', SELF).chatId, 'l3');
  assert.strictEqual(T.resolveMention(M, '@n/a/b', SELF).chatId, 'r2');
});

t('@ 解析：節點名等於本機名稱的對話視為本機', () => {
  const chats = [{ id: 'me', title: '甲', nodeName: '本機', createdAt: 1 }];
  const r = T.resolveMention(chats, '@甲', SELF);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.remote, false);
});

t('listMentionCandidates：空前綴列出全部，本機在前；含空白用方括號插入', () => {
  const all = T.listMentionCandidates(M, '@', SELF);
  assert.strictEqual(all.length, M.length);
  assert.strictEqual(all[0].remote, false);
  assert.strictEqual(all[all.length - 1].remote, true);
  const sp = all.find((c) => c.chatId === 'l2');
  assert.strictEqual(sp.insert, '@[寫 作業]');
  assert.strictEqual(all.find((c) => c.chatId === 'l1').insert, '@畫貓');
});

t('listMentionCandidates：前綴比對完整名稱（遠端用節點名開頭）', () => {
  const r = T.listMentionCandidates(M, '@b機/', SELF).map((c) => c.chatId).sort();
  assert.deepStrictEqual(r, ['r1', 'r3', 'r5']);
  assert.deepStrictEqual(T.listMentionCandidates(M, '寫', SELF).map((c) => c.chatId), ['l2']);
  assert.deepStrictEqual(T.listMentionCandidates(M, '[寫', SELF).map((c) => c.chatId), ['l2']);
  assert.deepStrictEqual(T.listMentionCandidates(M, 'zzz', SELF), []);
});

console.log(n + ' tests passed');
