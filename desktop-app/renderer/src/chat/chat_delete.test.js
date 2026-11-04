// node renderer/src/chat/chat_delete.test.js
'use strict';
const assert = require('assert');
const D = require('./chat_delete.js');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok - ' + name); }
function delIds(r) { return r.toDelete.map((x) => x.id).sort(); }
function skipMap(r) { const m = {}; r.skipped.forEach((x) => { m[x.id] = x.reason; }); return m; }

// 基本資料：根 R（一般對話）、父 P（根），底下五個子對話 c1..c5，c1 有孫 g1
function base() {
  return [
    { id: 'R', title: '一般對話', createdAt: 1, updatedAt: 1, parentId: null, status: null },
    { id: 'P', title: '父對話', createdAt: 2, updatedAt: 2, parentId: null, status: null },
    { id: 'c1', title: '子1完成', createdAt: 3, updatedAt: 3, parentId: 'P', status: 'done' },
    { id: 'g1', title: '孫1', createdAt: 4, updatedAt: 4, parentId: 'c1', status: 'done' },
    { id: 'c2', title: '子2失敗', createdAt: 5, updatedAt: 5, parentId: 'P', status: 'failed' },
    { id: 'c3', title: '子3進行中', createdAt: 6, updatedAt: 6, parentId: 'P', status: 'running' },
    { id: 'c4', title: '子4等待', createdAt: 7, updatedAt: 7, parentId: 'P', status: 'waiting_user' },
    { id: 'c5', title: '子5完成', createdAt: 8, updatedAt: 8, parentId: 'P', status: 'done' },
  ];
}

t('done：刪已完成的直接子對話，孫一併刪，數量正確', () => {
  const r = D.planDelete(base(), { parentId: 'P', filter: 'done' });
  assert.deepStrictEqual(delIds(r), ['c1', 'c5', 'g1']);
  assert.strictEqual(r.descendantsDeleted, 1);
  assert.deepStrictEqual(r.skipped, []);
});

t('failed：只刪失敗的', () => {
  const r = D.planDelete(base(), { parentId: 'P', filter: 'failed' });
  assert.deepStrictEqual(delIds(r), ['c2']);
  assert.strictEqual(r.descendantsDeleted, 0);
});

t('done_or_failed：完成與失敗都刪，進行中與等待不在清單也不列入跳過', () => {
  const r = D.planDelete(base(), { parentId: 'P', filter: 'done_or_failed' });
  assert.deepStrictEqual(delIds(r), ['c1', 'c2', 'c5', 'g1']);
  assert.deepStrictEqual(skipMap(r), {});
});

t('all：預設跳過進行中與等待中的，其餘全刪', () => {
  const r = D.planDelete(base(), { parentId: 'P', filter: 'all' });
  assert.deepStrictEqual(delIds(r), ['c1', 'c2', 'c5', 'g1']);
  assert.strictEqual(skipMap(r).c3, 'in_progress');
  assert.strictEqual(skipMap(r).c4, 'in_progress');
});

t('all + includeRunning：進行中與等待中的也刪', () => {
  const r = D.planDelete(base(), { parentId: 'P', filter: 'all', includeRunning: true });
  assert.deepStrictEqual(delIds(r), ['c1', 'c2', 'c3', 'c4', 'c5', 'g1']);
  assert.deepStrictEqual(r.skipped, []);
});

t('busyIds：執行端標記的進行中（isResponding）同樣預設跳過', () => {
  const chats = base().map((c) => (c.id === 'c5' ? Object.assign({}, c, { status: 'done' }) : c));
  const r = D.planDelete(chats, { parentId: 'P', filter: 'done', busyIds: ['c1'] });
  assert.deepStrictEqual(delIds(r), ['c5']);
  assert.strictEqual(skipMap(r).c1, 'in_progress');
});

t('進行中的孫：子樹整棵跳過（reason descendant_in_progress），不只刪一段', () => {
  const chats = base().map((c) => (c.id === 'g1' ? Object.assign({}, c, { status: 'running' }) : c));
  const r = D.planDelete(chats, { parentId: 'P', filter: 'done' });
  assert.deepStrictEqual(delIds(r), ['c5']);
  assert.strictEqual(skipMap(r).c1, 'descendant_in_progress');
});

t('進行中的孫 + includeRunning：整棵都刪', () => {
  const chats = base().map((c) => (c.id === 'g1' ? Object.assign({}, c, { status: 'running' }) : c));
  const r = D.planDelete(chats, { parentId: 'P', filter: 'done', includeRunning: true });
  assert.deepStrictEqual(delIds(r), ['c1', 'c5', 'g1']);
});

t('三層巢狀：子→孫→曾孫一併刪，descendantsDeleted 計兩層', () => {
  const chats = base().concat([{ id: 'gg1', title: '曾孫', createdAt: 9, updatedAt: 9, parentId: 'g1', status: 'done' }]);
  const r = D.planDelete(chats, { parentId: 'P', filter: 'done' });
  assert.deepStrictEqual(delIds(r), ['c1', 'c5', 'g1', 'gg1']);
  assert.strictEqual(r.descendantsDeleted, 2);
});

t('受保護：根對話 P 與一般對話 R 永遠不刪（即使 parentId 指它們）', () => {
  const r = D.planDelete(base(), { parentId: 'P', filter: 'all', includeRunning: true, ids: [] });
  assert.ok(!delIds(r).includes('P') && !delIds(r).includes('R'));
});

t('受保護：遠端收件對話不刪；收件對話底下的子對話（ids 指定）也可以刪', () => {
  const chats = base().concat([
    { id: 'IN', title: '收件對話', createdAt: 9, updatedAt: 9, parentId: null, status: null, kind: 'remote-inbox' },
    { id: 'rk1', title: '遠端子1', createdAt: 10, updatedAt: 10, parentId: 'IN', status: 'done' },
  ]);
  const r1 = D.planDelete(chats, { filter: 'ids', ids: ['IN'] });
  assert.deepStrictEqual(r1.toDelete, []);
  assert.strictEqual(skipMap(r1).IN, 'remote_inbox');
  const r2 = D.planDelete(chats, { parentId: 'IN', filter: 'done' });
  assert.deepStrictEqual(delIds(r2), ['rk1']);
});

t('ids：不存在的 id 列在 skipped（not_found）；根對話列 not_child；其餘正常', () => {
  const r = D.planDelete(base(), { filter: 'ids', ids: ['c2', 'nope', 'P', 'R'] });
  assert.deepStrictEqual(delIds(r), ['c2']);
  const m = skipMap(r);
  assert.strictEqual(m.nope, 'not_found');
  assert.strictEqual(m.P, 'not_child');
  assert.strictEqual(m.R, 'not_child');
});

t('ids：指定 parentId 時，不在該父對話底下的子對話列 not_under_parent', () => {
  const chats = base().concat([
    { id: 'Q', title: '另一父', createdAt: 9, updatedAt: 9, parentId: null, status: null },
    { id: 'qc', title: '別人的子', createdAt: 10, updatedAt: 10, parentId: 'Q', status: 'done' },
  ]);
  const r = D.planDelete(chats, { parentId: 'P', filter: 'ids', ids: ['qc', 'c1'] });
  assert.deepStrictEqual(delIds(r), ['c1', 'g1']);
  assert.strictEqual(skipMap(r).qc, 'not_under_parent');
});

t('ids：同一個 id 重複只處理一次；子與其孫同時指定時不重複計數', () => {
  const r = D.planDelete(base(), { filter: 'ids', ids: ['c1', 'c1', 'g1'] });
  assert.deepStrictEqual(delIds(r), ['c1', 'g1']);
  assert.strictEqual(r.descendantsDeleted, 1);
});

t('孤兒：parentId 指向不存在的對話，視為根，不刪（不會被 done 篩到）', () => {
  const chats = base().concat([{ id: 'orph', title: '孤兒', createdAt: 9, updatedAt: 9, parentId: 'GONE', status: 'done' }]);
  const r = D.planDelete(chats, { parentId: 'P', filter: 'done' });
  assert.ok(!delIds(r).includes('orph'));
  const r2 = D.planDelete(chats, { filter: 'ids', ids: ['orph'] });
  assert.strictEqual(skipMap(r2).orph, 'not_child');
});

t('循環 parentId：環上的節點視為根，不無限迴圈，也不刪', () => {
  const chats = [
    { id: 'A', title: 'A', createdAt: 1, updatedAt: 1, parentId: 'B', status: 'done' },
    { id: 'B', title: 'B', createdAt: 2, updatedAt: 2, parentId: 'A', status: 'done' },
    { id: 'P', title: 'P', createdAt: 3, updatedAt: 3, parentId: null, status: null },
  ];
  const r = D.planDelete(chats, { filter: 'ids', ids: ['A', 'B'] });
  assert.deepStrictEqual(r.toDelete, []);
  assert.strictEqual(skipMap(r).A, 'not_child');
  const r2 = D.planDelete(chats, { parentId: 'P', filter: 'all' });
  assert.deepStrictEqual(r2.toDelete, []);
});

t('空結果：沒有子對話、沒有符合的、ids 為空，都回傳空清單且沒有 error', () => {
  const none = [{ id: 'P', title: 'P', createdAt: 1, updatedAt: 1, parentId: null, status: null }];
  const a = D.planDelete(none, { parentId: 'P', filter: 'all' });
  assert.deepStrictEqual(a, { toDelete: [], skipped: [], descendantsDeleted: 0 });
  const b = D.planDelete(base(), { parentId: 'P', filter: 'failed', ids: [] });
  assert.deepStrictEqual(b.toDelete.map((x) => x.id), ['c2']);
  const c = D.planDelete(base(), { filter: 'ids', ids: [] });
  assert.deepStrictEqual(c, { toDelete: [], skipped: [], descendantsDeleted: 0 });
});

t('參數錯誤：未知 filter、非 ids 卻沒有 parentId，回 error 且不刪', () => {
  assert.strictEqual(D.planDelete(base(), { parentId: 'P', filter: 'bogus' }).error, 'unknown_filter');
  assert.strictEqual(D.planDelete(base(), { filter: 'done' }).error, 'no_parent');
  assert.deepStrictEqual(D.planDelete(base(), { filter: 'done' }).toDelete, []);
});

t('不改傳入的陣列與物件', () => {
  const chats = base();
  const snap = JSON.stringify(chats);
  D.planDelete(chats, { parentId: 'P', filter: 'all', includeRunning: true });
  assert.strictEqual(JSON.stringify(chats), snap);
});

console.log(`\n${n} 項全過`);
