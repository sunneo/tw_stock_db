// 子對話 S3 步驟 4（連結卡片的點擊、存檔與還原；側欄樹狀）真實桌面版評估：假 LLM，topicShiftCheck 開啟。
// 檢查：
//   - 開出子對話後，畫面仍停在父對話（不自動切換），父對話有一個「打開」按鈕。
//   - 點「打開」後，目前對話變成子對話（_chatIndex.currentId、fa._ctx.id）。
//   - 切回父對話後，按鈕還在。
//   - 模擬重新載入：移除記憶體中的父對話 ctx，從存檔重讀；存檔的 messages 裡仍有 _subchatLink（可列舉、JSON 往返不遺失）；
//     重讀後按鈕仍在，再點仍切到子對話。
//   - 側欄：父對話列有樹狀開關（.cl-tree-toggle）與子對話數（.cl-children-count）；預設收合，點開關後子對話列（.cl-child）出現；點開關不切換對話。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_link.eval.js 17963
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }

const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const sys = String(((body.messages || [])[0] || {}).content || '');
  const mk = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/對話分析專家/.test(sys)) return mk(JSON.stringify({ isShifted: true, reason: 'fake', newTopicSummary: '音樂' }));
  return mk('完成');
};

const texts = ['幫我畫一張貓的圖', '再加一隻狗', '幫我創作一首音樂'];
const NEW_TITLE = '幫我創作一首音樂';
const btns = () => Array.from(document.querySelectorAll('.fa-subchat-open'));

async function waitFor(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return !!pred(); }

try {
  fa.advancedSettings.topicShiftCheck = true;
  fa._clearChatHistory();
  delete fa._lastTopicShift;
  const pid = fa._chatIndex.currentId;
  R.info.pid = pid;
  for (const text of texts) {
    await Promise.race([fa.executeChat(text), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]).catch(() => {});
  }
  const childOf = () => (fa._chatIndex.chats || []).find((c) => c.parentId === pid) || null;
  await waitFor(() => childOf() && childOf().status === 'done', 60000);
  const kid = childOf();
  const cid = kid ? kid.id : null;
  R.info.childId = cid;
  R.checks.childCreatedAndDone = !!kid && kid.status === 'done';

  // 畫面仍在父對話
  R.checks.staysOnParentAfterShift = fa._chatIndex.currentId === pid && fa._ctx.id === pid;
  R.checks.parentHasOpenButton = btns().length >= 1;

  // 點「打開」→ 子對話
  if (btns().length) btns()[btns().length - 1].click();
  R.checks.clickSwitchesToChild = await waitFor(() => fa._chatIndex.currentId === cid, 5000) && fa._ctx.id === cid;

  // 切回父對話後按鈕還在
  await fa._chatSwitch(pid);
  await waitFor(() => fa._chatIndex.currentId === pid, 5000);
  R.checks.backOnParentButtonStillThere = fa._chatIndex.currentId === pid && btns().length >= 1;

  // 模擬重新載入：先存檔，再把父對話從記憶體拿掉，從存檔重讀
  await fa._flushChatWrite();
  fa._persistChatHistory();
  await fa._saveChatIndex();
  const json = JSON.parse(JSON.stringify(fa.messages.filter((m) => m && m._subchatLink)));
  R.checks.linkSurvivesJson = json.length === 1 && json[0]._subchatLink && json[0]._subchatLink.childId === cid;
  if (fa._chatCtxs.get(pid) !== fa._ctx) fa._chatCtxs.delete(pid);
  const reloaded = await fa._chatCtxLoad(pid);
  const stored = reloaded && reloaded.messages ? reloaded.messages.filter((m) => m && m._subchatLink) : [];
  R.checks.linkRestoredAfterReload = stored.length === 1 && stored[0]._subchatLink.childId === cid && stored[0]._subchatLink.title === NEW_TITLE;

  // 重讀後切到父對話、按鈕要還在、點了仍切到子對話
  await fa._chatSwitch(pid);
  await waitFor(() => fa._chatIndex.currentId === pid, 5000);
  R.checks.buttonAfterReloadRendered = btns().length >= 1;
  if (btns().length) btns()[btns().length - 1].click();
  R.checks.clickAfterReloadSwitches = await waitFor(() => fa._chatIndex.currentId === cid, 5000);
  await fa._chatSwitch(pid);

  // 側欄樹狀：預設收合，點開關後子對話列出現，點開關不切換對話
  fa._renderChatList();
  await sleep(200);
  const toggles = Array.from(document.querySelectorAll('.cl-tree-toggle'));
  R.info.toggleCount = toggles.length;
  R.checks.sidebarHasToggle = toggles.length >= 1;
  const countEl = Array.from(document.querySelectorAll('.cl-children-count')).map((e) => e.textContent.trim());
  R.info.childCountText = countEl;
  R.checks.sidebarShowsChildCount = countEl.some((t) => /1/.test(t));
  R.checks.sidebarDefaultCollapsed = document.querySelectorAll('.cl-child').length === 0;
  const before = fa._chatIndex.currentId;
  if (toggles.length) toggles[0].click();
  await sleep(300);
  R.checks.toggleExpandsChildRow = document.querySelectorAll('.cl-child').length >= 1;
  R.checks.toggleDoesNotSwitch = fa._chatIndex.currentId === before;
} catch (e) {
  R.info.error = String((e && e.message) || e);
}

// 還原
fa.advancedSettings.topicShiftCheck = false;
window.fetch = realFetch;
R.checks = R.checks || {};
R.allPass = Object.keys(R.checks).length > 0 && Object.values(R.checks).every((v) => v === true);
return R;
