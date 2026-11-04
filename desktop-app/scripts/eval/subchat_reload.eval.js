// 子對話 S4b 步驟 5：重新整理（重新載入頁面）後的子對話狀態。
// 模擬：子對話設成 waiting_user（或 running）→ 存進索引 → 清掉記憶體裡的等待（重新整理後不存在）→ 呼叫真正的
// 索引載入 _chatListInit（與開啟頁面時走同一條路）。
// 檢查：
//   R1 waiting_user → failed，原因「頁面重新整理，等待中的問題已失效」；父對話連結卡片顯示失敗（不是「等你回應」）。
//   R2 running → failed，原因「頁面重新整理，這一輪被中斷」。
//   R3 修正函式不動 done／沒有父對話的項目（回傳 0）。
//   R4 failed 的子對話仍可繼續：父對話傳訊息 → 開新一輪（mode turn）→ 最後 done。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_reload.eval.js 17970
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (fn) => { try { return fn(); } catch (e) { return { ok: false, error: 'throw: ' + String((e && e.message) || e) }; } };

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }

let shiftReply = true;
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = String((msgs[0] || {}).content || '');
  const mk = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let reply = '完成';
  if (/對話分析專家/.test(sys)) reply = JSON.stringify({ isShifted: shiftReply, reason: 'fake', newTopicSummary: '音樂' });
  if (/議題切割摘要|過渡摘要/.test(sys)) reply = '摘要';
  return mk(reply);
};
async function sendOne(text) {
  let err = null;
  await Promise.race([fa.executeChat(text), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]).catch((e) => { err = String((e && e.message) || e); });
  return err;
}

// 前置：子對話
fa.advancedSettings.topicShiftCheck = true;
fa._clearChatHistory();
delete fa._lastTopicShift;
const pid = fa._chatIndex.currentId;
for (const t of ['幫我畫一張貓的圖', '再加一隻狗', '幫我創作一首音樂']) { await sendOne(t); }
let kid = null;
for (let i = 0; i < 300; i++) {
  const kids = ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId === pid);
  if (kids.length && kids.every((k) => k.status === 'done' || k.status === 'failed')) { kid = kids[0]; break; }
  await sleep(200);
}
fa.advancedSettings.topicShiftCheck = false;
R.info.hasKid = !!kid;
const kidEntry = () => fa._chatIndex.chats.find((c) => c.id === kid.id);

// R1：等待中 → 存檔 → 清記憶體等待 → 真正的載入
fa._subchatSetStatus(kid.id, 'start');
fa._subchatSetStatus(kid.id, 'ask', { question: '重新整理前的問題' });
R.info.beforeR1 = kidEntry().status;
await fa._saveChatIndex(); // 存檔是非同步的，要等寫入完成，載入才會讀到新狀態
fa._subchatPendingMap().clear();
const load1 = await safe(async () => { await fa._chatListInit(); return 'ok'; });
R.info.load1 = typeof load1 === 'string' ? load1 : String((load1 && load1.error) || load1);
const k1 = kid && fa._chatIndex.chats.find((c) => c.id === kid.id);
R.checks.r1_failedAfterReload = !!k1 && k1.status === 'failed';
R.checks.r1_reasonText = !!k1 && !!k1.subInfo && k1.subInfo.reason === '頁面重新整理，等待中的問題已失效';
const linkText = safe(() => fa._subchatLinkInfo(kid.id).text);
R.info.r1LinkText = String(linkText);
R.checks.r1_linkShowsFailedNotWaiting = String(linkText).indexOf('失敗') >= 0 && String(linkText).indexOf('等你回應') < 0;
R.checks.r1_notSavedAsWaiting = fa._chatIndex.chats.find((c) => c.id === kid.id).status !== 'waiting_user';

// R2：執行中 → 存檔 → 載入
fa._subchatSetStatus(kid.id, 'start');
R.info.beforeR2 = kidEntry().status;
await fa._saveChatIndex();
await safe(async () => { await fa._chatListInit(); return 'ok'; });
const k2 = fa._chatIndex.chats.find((c) => c.id === kid.id);
R.checks.r2_failedRunning = !!k2 && k2.status === 'failed' && !!k2.subInfo && k2.subInfo.reason === '頁面重新整理，這一輪被中斷';

// R3：修正函式不動 done、不動沒有父對話的項目
const r3 = safe(() => fa._subchatRecoverAfterReload([{ id: 'x', parentId: 'p', status: 'done' }, { id: 'y', status: 'waiting_user' }]));
R.info.r3Count = r3;
R.checks.r3_untouchedDoneAndRoot = r3 === 0;

// R4：failed 的子對話仍可由父對話傳訊息繼續 → 新一輪 → done
const r4 = await safe(async () => fa._subchatSend(kid.id, '繼續'));
R.info.r4Mode = r4 && r4.mode;
R.checks.r4_sendTurn = !!r4 && r4.ok === true && r4.mode === 'turn';
let finalStatus = null;
for (let i = 0; i < 150; i++) {
  const cur = fa._chatIndex.chats.find((c) => c.id === kid.id);
  finalStatus = cur && cur.status;
  if (finalStatus === 'done' || finalStatus === 'failed') { if (i > 2) break; }
  await sleep(200);
}
R.info.r4Final = finalStatus;
R.checks.r4_doneAfterContinue = finalStatus === 'done';

// 載入的是工作目錄的實作（字串常值，不用變數名）
R.checks.loadedWorkdirImpl = /頁面重新整理，等待中的問題已失效/.test(String(fa._subchatRecoverAfterReload)) && /_subchatRecoverAfterReload/.test(String(fa._chatListInit));

// 還原
window.fetch = realFetch;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
