// 子對話 S1 步驟 5（真實 Electron）：側欄樹狀呈現。
// 建立一個父對話 P、兩個子對話 C1／C2（C2 再有孫 G），讀 DOM 確認縮排順序、收合展開、子對話數；
// 點展開鈕不切換對話；目前對話藏在收合的父對話底下時會自動展開；刪父對話後子對話提升為根；
// 沒有任何子對話時，列表沒有樹狀元件（回歸）。
// 結果以 [eval-file] result 輸出。用法：node scripts/eval/run_eval.js scripts/eval/chat_tree.eval.js 17952
const fa = window.fa; const R = {};
const list = () => document.getElementById('ai-chatlist-list');
const render = () => { fa._chatListSig = null; fa._renderChatList(); };
const rows = () => Array.from(list().querySelectorAll('.cl-item')).map((el) => {
  const tg = el.querySelector('.cl-tree-toggle'); const cnt = el.querySelector('.cl-children-count');
  return { id: el.dataset.chatId, depth: Number(el.dataset.depth || 0), toggle: tg ? tg.dataset.open : null, count: cnt ? cnt.textContent : null };
});
const shape = () => rows().map((r) => r.id + '@' + r.depth);
const tog = (id) => list().querySelector('.cl-tree-toggle[data-chat-id="' + id + '"]');
const clickTog = (id) => { const t = tog(id); if (!t) return false; t.click(); return true; };
const mk = (id, extra) => Object.assign({ id, title: '對話' + id, groupId: null, createdAt: 0, updatedAt: 0, touched: true }, extra);

// 1) 建立索引：P（根）、Q（根，目前對話）、C1／C2 掛在 P 底下、G 掛在 C2 底下
fa._chatIndex.groups = [];
fa._chatIndex.chats = [
  mk('P', { createdAt: 1000 }),
  mk('Q', { createdAt: 500 }),
  mk('C1', { parentId: 'P', createdAt: 2000 }),
  mk('C2', { parentId: 'P', createdAt: 3000 }),
  mk('G', { parentId: 'C2', createdAt: 4000 }),
];
fa._chatIndex.expanded = {};
fa._chatIndex.currentId = 'Q';
render();

// 2) 預設收合：只看到根 P、Q；P 顯示子對話數 2、狀態 ▸（0）
R.default_collapsed = JSON.stringify(shape()) === JSON.stringify(['P@0', 'Q@0']);
R.parent_count_toggle = JSON.stringify(rows()[0]) === JSON.stringify({ id: 'P', depth: 0, toggle: '0', count: '2' });

// 3) 點 P 的展開鈕：不切換對話、展開 P，C1、C2 依建立時間舊到新出現在 P 底下（縮排 1）
const cur0 = fa._chatIndex.currentId;
R.click_toggle_hit = clickTog('P');
R.toggle_not_switch = fa._chatIndex.currentId === cur0;
R.expanded_P = fa._chatIndex.expanded.P === true;
R.after_expand_P = JSON.stringify(shape()) === JSON.stringify(['P@0', 'C1@1', 'C2@1', 'Q@0']);

// 4) 展開 C2：孫 G 出現，縮排 2；C2 的子對話數 1
clickTog('C2');
R.after_expand_C2 = JSON.stringify(shape()) === JSON.stringify(['P@0', 'C1@1', 'C2@1', 'G@2', 'Q@0']);
R.grandchild_count = rows().find((r) => r.id === 'C2').count === '1';

// 5) 收合 P：整棵子樹隱藏（包含已展開的 C2），P 明確記為收合（false）
clickTog('P');
R.collapse_P = JSON.stringify(shape()) === JSON.stringify(['P@0', 'Q@0']) && fa._chatIndex.expanded.P === false;

// 6) 目前對話是孫 G，但 P 已被使用者明確收合：不自動展開（尊重收合）
fa._chatIndex.currentId = 'G'; render();
R.explicit_collapse_respected = JSON.stringify(shape()) === JSON.stringify(['P@0', 'Q@0']);

// 7) 清掉 P 的紀錄（從沒設定過）：目前對話在 P 底下時，P 與路徑上的 C2 自動展開
delete fa._chatIndex.expanded.P; render();
R.reveal_when_unset = JSON.stringify(shape()) === JSON.stringify(['P@0', 'C1@1', 'C2@1', 'G@2', 'Q@0']);
fa._chatIndex.currentId = 'Q'; render();

// 8) 群組：Q 放進群組「組」，群組標題的計數只算根對話；群組裡的子對話跟著父對話
fa._chatIndex.groups = [{ id: 'g1', name: '組', collapsed: false }];
fa._chatIndex.chats.find((c) => c.id === 'Q').groupId = 'g1';
render();
const head = list().querySelector('.cl-group[data-group-id="g1"]');
R.group_head_count = !!head && head.querySelector('.cl-count').textContent === '1';
// 群組成員以 nested 類別標示（與以前相同）；未分組的項目不算在內
R.group_members = JSON.stringify(Array.from(list().querySelectorAll('.cl-item.nested')).map((el) => el.dataset.chatId)) === JSON.stringify(['Q']);
fa._chatIndex.chats.find((c) => c.id === 'Q').groupId = null; fa._chatIndex.groups = []; render();

// 9) 刪父對話 P：子對話 C1、C2 提升為根（不連帶刪除）；G 仍在 C2 底下；P 的展開紀錄清掉
const origConfirm = window.confirm; window.confirm = () => true;
try { await fa._chatDelete('P'); } finally { window.confirm = origConfirm; }
const byId = (id) => fa._chatIndex.chats.find((c) => c.id === id);
R.deleted_P = !byId('P');
R.children_promoted = !!byId('C1') && byId('C1').parentId === null && !!byId('C2') && byId('C2').parentId === null;
R.grandchild_kept = !!byId('G') && byId('G').parentId === 'C2';
R.expanded_P_cleared = !('P' in (fa._chatIndex.expanded || {}));
render();
R.shape_after_delete = JSON.stringify(shape());
// 提升後：C2（3000）、C1（2000）、Q（500）依建立時間新到舊為根；C2 仍展開（步驟 10 之前的狀態），G 在它底下
R.promoted_shape_ok = JSON.stringify(shape()) === JSON.stringify(['C2@0', 'G@1', 'C1@0', 'Q@0']);

// 10) 索引寫回後端：展開狀態存在 expanded（重新讀取）
fa._chatIndex.expanded = { C2: true }; render(); await fa._saveChatIndex();
const persisted = JSON.parse(await fa._chatBackend().readIndex());
R.expanded_persisted = JSON.stringify(persisted.expanded) === JSON.stringify({ C2: true });

// 11) 回歸：沒有任何子對話時，列表沒有樹狀元件，順序與以前相同（新到舊）
fa._chatIndex.chats = [mk('A', { createdAt: 1 }), mk('B', { createdAt: 2 })];
fa._chatIndex.currentId = 'A'; fa._chatIndex.expanded = {};
render();
R.regression_no_children = list().querySelectorAll('.cl-tree-toggle, .cl-child, .cl-children-count').length === 0 && JSON.stringify(shape()) === JSON.stringify(['B@0', 'A@0']);
R.regression_class_names = Array.from(list().querySelectorAll('.cl-item')).every((el) => el.className === 'cl-item' || el.className === 'cl-item active');

return R;
