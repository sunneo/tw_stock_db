// 子對話 S7 步驟 3（批次刪除的執行：清理與連結卡片）真實桌面版評估。
// 建立：1 父對話 P，底下 5 個子對話：c1（完成，有孫 g1）、c2（失敗）、c3（進行中）、c4（完成）、c5（完成）。
// 父對話放 5 張連結卡片（c1..c5）。用 planDelete（done_or_failed）產生清單，交給 _chatDeleteMany 執行。
// 檢查：
//   - 計畫：刪除 c1、c2、c4、c5、g1（descendantsDeleted=1）；c3 列在 skipped（in_progress）。
//   - 執行後：索引裡 P 的子對話只剩 c3；g1 不在索引；被刪的 ctx 不在 _chatCtxs；存檔讀不到被刪的（c3 讀得到）。
//   - 父對話連結卡片：c1/c2/c4/c5 的「打開」按鈕是「已刪除」且停用；c3 的仍可用。
//   - 點被刪的連結卡片不拋錯（沒有未捕捉的錯誤，目前對話仍是 P）。
//   - 側欄：被刪對話的列不存在；@ 候選清單不含被刪的標題。
//   - 目前對話不是被刪的（仍是 P）；結果 deleted/failed 正確（failed 為空）。
//   - 載入來源：工作目錄的實作（_chatDeleteMany 的字串常值）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_delete.eval.js 17964
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uncaught = [];
window.addEventListener('error', (e) => { uncaught.push(String(e && e.message || e)); });

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';

async function waitFor(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return !!pred(); }

// 建一個子對話：索引＋一則訊息存檔（用 _persistChatHistory 寫入，與真實流程相同的存檔格式）
async function mkChat(id, title, parentId, status) {
  const now = Date.now();
  fa._chatIndex.chats.push({ id, title, groupId: null, createdAt: now, updatedAt: now, parentId, status, fingerprint: { kw: [title] } });
  const prev = fa._ctx;
  await fa._chatSwitch(id);
  fa.messages.push({ role: 'user', content: title });
  fa._persistChatHistory();
  await fa._chatSwitch(prev.id);
}

try {
  await fa._chatNew();
  const parentId = fa._chatIndex.currentId;
  R.info.parentId = parentId;
  await fa._chatNew();
  const PARK = fa._chatIndex.currentId; // 停靠用的另一個對話（切來切去才會重畫父對話的訊息）
  await fa._chatSwitch(parentId);
  fa._chatIndex.chats.find((c) => c.id === parentId).title = 'S7父對話';
  const specs = [
    ['c1', '子一完成', 'done'], ['c2', '子二失敗', 'failed'], ['c3', '子三進行中', 'running'], ['c4', '子四完成', 'done'], ['c5', '子五完成', 'done'],
  ];
  for (const [id, title, st] of specs) await mkChat(id, title, parentId, st);
  await mkChat('g1', '孫一', 'c1', 'done');
  // 父對話放連結卡片（與 S3 相同：訊息上的 _subchatLink）
  await fa._chatSwitch(parentId);
  for (const [id, title] of specs) { const m = fa._buildToolResultMessage('display', JSON.stringify({ ok: true, note: '子對話' }), {}); m.content = '↳ 子對話：' + title; m._subchatLink = { childId: id, title }; fa.messages.push(m); }
  fa._renderMessageHistory();
  fa._persistChatHistory();
  await fa._chatSwitch(PARK);
  await fa._chatSwitch(parentId);
  await waitFor(() => document.querySelectorAll('.fa-subchat-link').length >= 5, 4000);
  R.info.linksBefore = document.querySelectorAll('.fa-subchat-link').length;
  R.checks.fiveLinksBefore = R.info.linksBefore === 5;
  R.checks.sidebarHasC1Before = !!document.querySelector('[data-chat-id="c1"]') || fa._chatIndex.chats.some((c) => c.id === 'c1');

  // 計畫
  const plan = fa._chatDeleteMod().planDelete(fa._chatIndex.chats, { parentId, filter: 'done_or_failed' });
  R.info.plan = plan;
  R.checks.planIds = JSON.stringify(plan.toDelete.map((x) => x.id).sort()) === JSON.stringify(['c1', 'c2', 'c4', 'c5', 'g1']);
  R.checks.planDescendants = plan.descendantsDeleted === 1;
  R.checks.planNoSkip = plan.skipped.length === 0;
  const plan2 = fa._chatDeleteMod().planDelete(fa._chatIndex.chats, { parentId, filter: 'all' });
  R.checks.planAllSkipsRunning = plan2.skipped.some((x) => x.id === 'c3' && x.reason === 'in_progress');

  // 執行
  const res = await fa._chatDeleteMany(plan);
  R.info.res = res;
  R.checks.resDeletedCount = Array.isArray(res.deleted) && res.deleted.length === 5;
  R.checks.resNoFailed = Array.isArray(res.failed) && res.failed.length === 0;

  // 索引
  const kids = fa._chatIndex.chats.filter((c) => c.parentId === parentId).map((c) => c.id);
  R.info.kidsAfter = kids;
  R.info.dbg = { c1Entry: !!fa._chatEntry('c1'), visible: fa._chatIsVisible(), cur: fa._chatIndex.currentId, parentId, linksNow: document.querySelectorAll('.fa-subchat-link').length, sameCtx: fa._ctx === fa._activeCtx };
  R.checks.onlyC3Left = JSON.stringify(kids) === JSON.stringify(['c3']);
  R.checks.g1Gone = !fa._chatIndex.chats.some((c) => c.id === 'g1');
  R.checks.parentStays = fa._chatIndex.chats.some((c) => c.id === parentId);

  // ctx 與存檔
  R.checks.ctxGone = ['c1', 'c2', 'c4', 'c5', 'g1'].every((id) => !fa._chatCtxs.has(id));
  let storedGone = true; const storedErr = [];
  for (const id of ['c1', 'c2', 'c4', 'c5', 'g1']) {
    try { const raw = await fa._chatBackend().read(id); if (raw) storedGone = false; } catch (e) { storedErr.push(id); }
  }
  R.checks.storageGone = storedGone;
  let c3Stored = false; try { c3Stored = !!(await fa._chatBackend().read('c3')); } catch (_) { c3Stored = false; }
  R.checks.c3StorageKept = c3Stored;

  // 父對話連結卡片
  await fa._chatSwitch(PARK);
  await fa._chatSwitch(parentId);
  await waitFor(() => document.querySelectorAll('.fa-subchat-link').length >= 1, 3000);
  const cards = Array.from(document.querySelectorAll('.fa-subchat-link'));
  const byChild = {};
  cards.forEach((w) => { const id = w.getAttribute('data-child-id'); const b = w.querySelector('.fa-subchat-open'); byChild[id] = { text: b ? b.textContent : null, disabled: b ? !!b.disabled : null }; });
  R.info.cards = byChild;
  R.checks.goneLinksShowDeleted = ['c1', 'c2', 'c4', 'c5'].every((id) => byChild[id] && byChild[id].text === '已刪除' && byChild[id].disabled === true);
  R.checks.keptLinkUsable = !!byChild.c3 && byChild.c3.text === '打開' && byChild.c3.disabled === false;

  // 點被刪的連結卡片：不拋錯、目前對話仍是父對話
  const errBefore = uncaught.length;
  const goneBtn = document.querySelector('.fa-subchat-link[data-child-id="c1"] .fa-subchat-open');
  try { if (goneBtn) goneBtn.click(); } catch (e) { R.info.clickErr = String((e && e.message) || e); }
  await sleep(300);
  R.checks.clickNoThrow = uncaught.length === errBefore && !R.info.clickErr;
  R.checks.stillOnParent = fa._chatIndex.currentId === parentId;

  // 側欄與 @ 候選
  R.checks.sidebarNoDeleted = !document.querySelector('[data-chat-id="c1"]') && !document.querySelector('[data-chat-id="g1"]');
  const cand = (fa._subchatChildCandidates() || []).map((x) => String(x.id));
  R.info.cand = cand;
  R.checks.mentionNoDeleted = !cand.some((id) => ['c1', 'c2', 'c4', 'c5', 'g1'].indexOf(id) >= 0);
  R.checks.mentionKeepsC3 = cand.indexOf('c3') >= 0;

  // 載入來源：工作目錄的實作（字串常值）
  R.checks.loadedWorkdirImpl = String(fa._chatDeleteMany || '').indexOf('S7:chat_delete_many') >= 0;
} catch (e) {
  R.info.fatal = String((e && e.message) || e);
  R.info.stack = String((e && e.stack) || '').split('\n').slice(0, 4).join(' | ');
  R.checks.fatal = false;
}
R.info.uncaught = uncaught.slice(0, 5);
R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
