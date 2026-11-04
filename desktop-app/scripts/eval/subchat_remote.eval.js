// 子對話 S6（遠端需求統一成子對話）真實桌面版評估：不需要真的遠端，模擬 _rgRunTask 的兩個呼叫（建立與結果回寫）。
// 序列：
//   1. B機 的需求「寫一首詩」          → B機 收件對話（父）＋子對話 1
//   2. C機 的需求「畫一張貓」          → C機 收件對話＋子對話 2
//   3. B機 的需求「寫一首短歌」        → 沿用 B機 收件對話，子對話 3
//   4. 舊格式索引（有 remote、沒有 parentId）→ migrateRemoteChats 收進 D機 收件對話
// 檢查：收件對話只建一次、子對話的 parentId／nodeName／status、側欄樹狀（收合時子對話不出現）、
//       建立時不切換畫面、不呼叫模型、載入路徑有接上遷移。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_remote.eval.js 17966
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fa.advancedSettings.offlineMode = false;
let modelCalls = 0;
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  modelCalls++;
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const hasMod = typeof fa._remoteInboxMod === 'function';
R.checks.hasRemoteInboxMod = hasMod;

function allChats() { return (fa._chatIndex && fa._chatIndex.chats) || []; }
function inboxes() { return allChats().filter((c) => c.kind === 'remote-inbox'); }
function inboxOf(name) { return inboxes().find((c) => c.nodeName === name) || null; }
function kidsOf(pid) { return allChats().filter((c) => c.parentId === pid); }

// 模擬 _rgRunTask：建立（_rgCreateRemoteChat）→ 結果回寫（_rgChatRecord）
async function remoteRequest(fromName, text, taskId) {
  const job = { taskId, from: 'node-' + fromName, fromName, text, files: [], events: [], done: false, stop: false, sub: false, at: Date.now(), trace: [] };
  job.chatCtx = await fa._rgCreateRemoteChat(job);
  const beforeSwitch = fa._chatIndex.currentId;
  fa._rgChatRecord(job, { kind: 'done', text: '完成：' + text });
  return { job, beforeSwitch };
}

// 初始化：乾淨的對話（不用 _clearChatHistory，避免影響索引中的其他對話）
const callsBefore = modelCalls;
const cur0 = fa._chatIndex.currentId;
const r1 = await remoteRequest('B機', '寫一首詩', 'task-1');
const r2 = await remoteRequest('C機', '畫一張貓', 'task-2');
const r3 = await remoteRequest('B機', '寫一首短歌', 'task-3');
await sleep(300);

const bIn = inboxOf('B機'), cIn = inboxOf('C機');
const bKids = bIn ? kidsOf(bIn.id) : [];
const cKids = cIn ? kidsOf(cIn.id) : [];
R.info.inboxCount = inboxes().length;
R.info.bKidTitles = bKids.map((k) => k.title);
R.info.cKidTitles = cKids.map((k) => k.title);
R.info.bKidStatus = bKids.map((k) => k.status);

R.checks.inboxOnePerNode = inboxes().filter((c) => c.nodeName === 'B機').length === 1 && inboxes().filter((c) => c.nodeName === 'C機').length === 1;
R.checks.inboxTitle = !!bIn && bIn.title === '遠端需求 · B機';
R.checks.inboxKindAndNoRemote = !!bIn && bIn.kind === 'remote-inbox' && !bIn.remote && bIn.parentId === null;
R.checks.bHasTwoChildren = bKids.length === 2;
R.checks.cHasOneChild = cKids.length === 1;
R.checks.childNodeName = bKids.every((k) => k.nodeName === 'B機') && cKids.every((k) => k.nodeName === 'C機');
R.checks.childKeepsRemoteSource = bKids.every((k) => k.remote && k.remote.fromName === 'B機');
R.checks.childTitleHasRequest = bKids.some((k) => String(k.title).indexOf('寫一首詩') >= 0);
R.checks.childStatusDone = bKids.every((k) => k.status === 'done') && cKids.every((k) => k.status === 'done');
R.checks.noRootRemoteChats = allChats().filter((c) => c.remote).every((c) => typeof c.parentId === 'string' && c.parentId !== '');
R.checks.noModelCallOnRemote = modelCalls === callsBefore;
R.checks.noSwitchOnCreate = r1.beforeSwitch === cur0 && r2.beforeSwitch === cur0 && r3.beforeSwitch === cur0 && fa._chatIndex.currentId === cur0;

// 側欄樹狀：收件對話在根（收合），子對話不出現在扁平清單裡（預設收合）
const rows = hasMod ? fa._chatTreeMod().flattenTree(allChats(), (fa._chatIndex && fa._chatIndex.expanded) || {}, {}) : [];
const bRow = rows.find((x) => bIn && x.chat.id === bIn.id);
R.info.bRowChildCount = bRow ? bRow.childCount : -1;
R.checks.sidebarInboxRowCollapsedWithCount = !!bRow && bRow.depth === 0 && bRow.open === false && bRow.childCount === 2;
R.checks.sidebarChildrenHiddenWhenCollapsed = !rows.some((x) => bKids.some((k) => k.id === x.chat.id));
// DOM：收件對話列存在
R.checks.sidebarDomHasInbox = !!bIn && !!document.querySelector('#ai-chatlist-list [data-chat-id="' + bIn.id + '"]');

// 舊格式索引遷移（D機）：有 remote、沒有 parentId 的舊遠端需求，收進 D機 收件對話
const oldEntry = { id: 'old_remote_1', title: '來自 D機：舊需求', groupId: null, createdAt: 1, updatedAt: 1, touched: true, shared: true, remote: { fromName: 'D機', fromId: 'node-D', taskId: 'task-old', at: 1, fp: '' } };
const before = allChats().slice();
fa._chatIndex.chats = before.concat([oldEntry]);
const migrated = hasMod ? fa._remoteInboxMod().migrateRemoteChats(fa._chatIndex.chats, { newId: () => fa._chatNewId('c'), now: Date.now() }) : [];
const oldAfter = migrated.find((c) => c.id === 'old_remote_1');
const dIn = migrated.find((c) => c.kind === 'remote-inbox' && c.nodeName === 'D機');
R.info.migratedParent = oldAfter ? oldAfter.parentId : null;
R.checks.migrateOldRemoteUnderInbox = !!oldAfter && !!dIn && oldAfter.parentId === dIn.id && oldAfter.nodeName === 'D機' && oldAfter.title === '來自 D機：舊需求';
R.checks.migrateKeepsOldRemoteField = !!oldAfter && oldAfter.remote.taskId === 'task-old';
// 載入路徑有接上遷移（字串常值）
R.checks.loadPathWiresMigrate = String(fa._chatListInit).indexOf('migrateRemoteChats') >= 0;
// 還原：移除假的舊格式對話，恢復原索引（遷移結果只在記憶體，不存檔）
fa._chatIndex.chats = before;

// 載入來源：工作目錄的實作（字串常值）
R.checks.loadedWorkdirImpl = String(fa._rgCreateRemoteChat).indexOf('ensureInbox') >= 0;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
