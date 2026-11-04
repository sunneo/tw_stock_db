// 子對話 S1 步驟 4（真實 Electron）：舊格式的對話索引載入後，新欄位補齊、既有欄位完全不變；
// _chatNew 不傳選項時行為不變，傳 { parentId, nodeName } 時寫入這兩個欄位。
// 載入來源檢查：用字串常值（STATUSES 的內容）驗證跑的是工作目錄的建置產物，不靠變數名。
// 用法：node scripts/eval/run_eval.js scripts/eval/chat_tree_index.eval.js
const fa = window.fa; const R = {};
const tree = fa._chatTreeMod();
R.loaded = {
  scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)),
  statuses: tree.STATUSES.join(','),
  has_mention: typeof tree.resolveMention === 'function',
};

// 1) 舊索引（沒有任何新欄位）寫進後端，重新載入
const be = fa._chatBackend();
const oldChats = [
  { id: 'c_old1', title: '舊對話甲', groupId: null, createdAt: 100, updatedAt: 200, touched: true },
  { id: 'c_old2', title: '舊對話乙', groupId: null, createdAt: 50, updatedAt: 60, shared: true, remote: { fromName: 'B機', fromId: 'nid', taskId: 't1', at: 50, fp: 'fp' } },
];
const oldIdx = { version: 1, currentId: 'c_old1', sidebarCollapsed: false, groups: [], chats: oldChats };
await be.write('c_old1', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
await be.write('c_old2', JSON.stringify({ messages: [] }));
await be.writeIndex(JSON.stringify(oldIdx));
await fa._chatListInit();

const NEW = ['parentId', 'status', 'topicId', 'fingerprint', 'summary', 'nodeName'];
const byId = (id) => fa._chatIndex.chats.find((c) => c.id === id);
const a1 = byId('c_old1'), a2 = byId('c_old2');
R.count_after_load = fa._chatIndex.chats.length;
// S6 有意改變：舊格式的遠端對話（有 remote、沒有 parentId）會被遷移收進來源節點的收件對話底下（parentId＝收件對話、nodeName＝來源節點）。
// 本機舊對話仍然是所有新欄位補 null。遷移的結果另外用 remote_migrated_to_inbox 驗證。
R.new_fields_filled = !!a1 && NEW.every((f) => a1[f] === null) && !!a2 && ['status', 'topicId', 'fingerprint', 'summary'].every((f) => a2[f] === null);
R.remote_migrated_to_inbox = !!a2 && !!a2.parentId && a2.nodeName === 'B機' && ((fa._chatIndex.chats.find((c) => c.id === a2.parentId) || {}).kind === 'remote-inbox');
// 既有欄位逐一比對（與舊索引的原始值相等）
// updatedAt 不比：目前對話在載入時會被既有的「訊息變動才更新時間」邏輯（floating-assistant.js 約 79543）改掉，與補欄位無關
const kept = (orig, now) => Object.keys(orig).filter((k) => k !== 'updatedAt').every((k) => JSON.stringify(orig[k]) === JSON.stringify(now[k]));
R.existing_fields_kept = !!a1 && !!a2 && kept(oldChats[0], a1) && kept(oldChats[1], a2);
R.updatedAt_note = { active_c_old1: a1 && a1.updatedAt, inactive_c_old2: a2 && a2.updatedAt };
R.remote_kept = !!a2 && JSON.stringify(a2.remote) === JSON.stringify(oldChats[1].remote);

// 2) 補齊後的索引會寫回後端：重新讀取，新欄位存在、舊欄位不變
const persisted = JSON.parse(await be.readIndex());
const p2 = persisted.chats.find((c) => c.id === 'c_old2');
R.persisted_new_fields = !!p2 && NEW.every((f) => f in p2);
R.persisted_existing_kept = !!p2 && kept(oldChats[1], p2);

// 3) _chatNew 不傳選項：不帶 parentId／nodeName（預設行為不變）
const n0 = fa._chatIndex.chats.length;
await fa._chatNew();
const created = fa._chatIndex.chats.slice(n0);
R.default_new_chat = created.length === 1 ? { parentId_absent: !('parentId' in created[0]), nodeName_absent: !('nodeName' in created[0]), title: created[0].title } : { created: created.length };

// 4) _chatNew 傳 { parentId, nodeName }：寫入這兩個欄位，且不被「空對話不重複建立」擋下
const n1 = fa._chatIndex.chats.length;
await fa._chatNew(null, { parentId: 'c_old1', nodeName: '  B機  ' });
const child = fa._chatIndex.chats.slice(n1)[0];
R.child_new_chat = child ? { parentId: child.parentId, nodeName: child.nodeName } : null;

return R;
