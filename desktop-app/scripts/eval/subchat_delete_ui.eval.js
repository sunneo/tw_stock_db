// 子對話 S7 步驟 4（側欄批次刪除的選取模式與確認）真實桌面版評估：讀 DOM，用 window.confirm 假裝使用者按確認／取消。
// 建立：1 父對話 P，底下 4 個子對話：a1（完成）、a2（失敗）、a3（進行中）、a4（完成）。
// 檢查：
//   - 進入選取模式（_chatSelectMode）：父對話展開，底下 4 列都有核取方塊（.cl-select），工具列（.cl-batch）出現；根對話列沒有核取方塊。
//   - 勾選 a1、a2 後工具列顯示「已選 2」。
//   - 按「刪除選取的」→ 確認框列出 a1、a2 的標題與數量；按取消後什麼都沒變（索引仍 4 個子對話、a1 還在側欄）。
//   - 按「取消」退出選取模式：核取方塊與工具列都消失。
//   - 再進入、勾 a1、a2，按確認 → a1、a2 從索引與側欄消失，a3、a4 還在。
//   - 勾選進行中的 a3 加上完成的 a4、a5 → 第一次確認後，因為選到進行中的，會問第二次「連它們一起刪？」；選「取消」→ 只刪 a4、a5，a3 還在。
//   - 「刪除已完成／失敗的」沒有符合的（只剩進行中）→ 不問、不刪。
//   - 沒有子對話或沒有選取模式時側欄沒有 .cl-select／.cl-batch（回歸）。
//   - 載入來源：工作目錄的實作（字串常值）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_delete_ui.eval.js 17965
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uncaught = [];
window.addEventListener('error', (e) => { uncaught.push(String(e && e.message || e)); });
async function waitFor(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return !!pred(); }

fa.advancedSettings.offlineMode = false;

// 假的 confirm：依序回傳 answers，並記錄訊息
const realConfirm = window.confirm; const realAlert = window.alert;
let confirmAnswers = []; const confirmLog = [];
window.confirm = (msg) => { confirmLog.push(String(msg)); return confirmAnswers.length ? !!confirmAnswers.shift() : false; };
window.alert = () => {};

async function mkChat(id, title, parentId, status) {
  const now = Date.now();
  fa._chatIndex.chats.push({ id, title, groupId: null, createdAt: now, updatedAt: now, parentId, status, fingerprint: { kw: [title] } });
  const prev = fa._ctx;
  await fa._chatSwitch(id);
  fa.messages.push({ role: 'user', content: title });
  fa._persistChatHistory();
  await fa._chatSwitch(prev.id);
}
const rowOf = (id) => document.querySelector(`[data-chat-id="${id}"]`);
const btnByText = (t) => Array.from(document.querySelectorAll('.cl-batch-btn')).find((b) => b.textContent.indexOf(t) === 0) || null;
const kidIds = (pid) => fa._chatIndex.chats.filter((c) => c.parentId === pid).map((c) => c.id).sort();

try {
  await fa._chatNew();
  const P = fa._chatIndex.currentId;
  R.info.parentId = P;
  fa._chatIndex.chats.find((c) => c.id === P).title = 'S7UI父';
  await mkChat('a1', '子甲完成', P, 'done');
  await mkChat('a2', '子乙失敗', P, 'failed');
  await mkChat('a3', '子丙進行中', P, 'running');
  await mkChat('a4', '子丁完成', P, 'done');
  await fa._chatSwitch(P);
  R.checks.normalBefore = document.querySelectorAll('.cl-select').length === 0 && !document.querySelector('.cl-batch');

  // 1. 進入選取模式
  fa._chatSelectMode(P);
  await waitFor(() => document.querySelectorAll('.cl-select').length === 4, 4000);
  R.info.selectBoxes = document.querySelectorAll('.cl-select').length;
  R.checks.fourBoxes = R.info.selectBoxes === 4;
  R.checks.boxesOnlyChildren = Array.from(document.querySelectorAll('.cl-select')).every((cb) => { const row = cb.closest('[data-chat-id]'); const e = row && fa._chatEntry(row.dataset.chatId); return !!e && e.parentId === P; });
  R.checks.batchBarShown = !!document.querySelector('.cl-batch');

  // 2. 勾選 a1、a2
  const cbOf = (id) => rowOf(id) && rowOf(id).querySelector('.cl-select');
  cbOf('a1').click(); await waitFor(() => fa._chatSelect.has('a1'), 2000);
  await waitFor(() => { const c = cbOf('a2'); return !!c; }, 2000);
  cbOf('a2').click(); await sleep(200);
  R.checks.selectedTwo = fa._chatSelect.size === 2 && !!document.querySelector('.cl-batch') && document.querySelector('.cl-batch').textContent.indexOf('已選 2') >= 0;

  // 3. 刪除選取的 → 確認框列出標題；按取消 → 不動
  confirmAnswers = [false]; confirmLog.length = 0;
  btnByText('刪除選取的').click();
  await sleep(400);
  R.info.confirmMsg1 = confirmLog[0] || '';
  R.checks.confirmListsTitles = confirmLog.length === 1 && confirmLog[0].indexOf('子甲完成') >= 0 && confirmLog[0].indexOf('子乙失敗') >= 0 && confirmLog[0].indexOf('2') >= 0;
  R.checks.cancelKeepsAll = kidIds(P).join(',') === 'a1,a2,a3,a4' && !!rowOf('a1');
  R.checks.cancelKeepsSelection = fa._chatSelect.size === 2;

  // 4. 取消選取模式
  btnByText('取消').click();
  await sleep(400);
  R.checks.exitClears = document.querySelectorAll('.cl-select').length === 0 && !document.querySelector('.cl-batch');

  // 5. 再進入、勾 a1、a2，確認
  fa._chatSelectMode(P);
  await waitFor(() => document.querySelectorAll('.cl-select').length === 4, 4000);
  cbOf('a1').click(); await sleep(200); cbOf('a2').click(); await sleep(200);
  confirmAnswers = [true]; confirmLog.length = 0;
  btnByText('刪除選取的').click();
  await waitFor(() => kidIds(P).join(',') === 'a3,a4', 6000);
  await sleep(300);
  R.info.kidsAfterSelect = kidIds(P);
  R.checks.selectedDeleted = kidIds(P).join(',') === 'a3,a4';
  R.checks.deletedRowsGone = !rowOf('a1') && !rowOf('a2') && !!rowOf('a3') && !!rowOf('a4');
  R.checks.modeExitedAfterDelete = !document.querySelector('.cl-batch') && fa._chatSelectParent == null;

  // 6. 選取的裡面含進行中的 a3 + 完成的 a5 → 第一次確認（刪）後，第二次問「連進行中一起刪？」，選取消 → 只刪 a5，a3 還在
  await mkChat('a5', '子戊完成', P, 'done');
  fa._chatSelectMode(P);
  await waitFor(() => document.querySelectorAll('.cl-select').length === 3, 4000);
  cbOf('a3').click(); await sleep(200); cbOf('a4').click(); await sleep(200); cbOf('a5').click(); await sleep(200);
  confirmAnswers = [true, false]; confirmLog.length = 0;
  btnByText('刪除選取的').click();
  await waitFor(() => kidIds(P).join(',') === 'a3', 6000);
  await sleep(300);
  R.info.confirmCount = confirmLog.length;
  R.info.kidsAfterInProgressPrompt = kidIds(P);
  R.checks.secondAskedForRunning = confirmLog.length === 2 && confirmLog[1].indexOf('進行中') >= 0;
  R.checks.onlyRunningLeft = kidIds(P).join(',') === 'a3';
  // 6b. 快捷「刪除已完成／失敗的」沒有符合的（只剩進行中）→ 不問、不刪
  fa._chatSelectMode(P);
  await waitFor(() => document.querySelectorAll('.cl-select').length === 1, 4000);
  confirmAnswers = []; confirmLog.length = 0;
  btnByText('刪除已完成').click();
  await sleep(500);
  R.checks.quickNoMatchNoPrompt = confirmLog.length === 0 && kidIds(P).join(',') === 'a3';
  fa._chatSelectExit();
  await sleep(200);

  // 7. 回歸：退出選取模式後，側欄沒有核取方塊與工具列；被刪的列不見
  fa._chatSelectExit();
  await sleep(300);
  R.checks.regressionNoBoxes = document.querySelectorAll('.cl-select').length === 0 && !document.querySelector('.cl-batch');
  R.checks.deletedNotInSidebar = !rowOf('a1') && !rowOf('a4');

  // 載入來源：工作目錄的實作（字串常值）
  R.checks.loadedWorkdirImpl = String(fa._chatBatchDelete || '').indexOf('還沒有選取要刪除的子對話') >= 0;
} catch (e) {
  R.info.fatal = String((e && e.message) || e);
  R.checks.fatal = false;
} finally {
  window.confirm = realConfirm; window.alert = realAlert;
}
R.info.uncaught = uncaught.slice(0, 5);
R.checks.noUncaught = uncaught.length === 0;
R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
