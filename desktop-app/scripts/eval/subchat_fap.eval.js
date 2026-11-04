// 子對話 S4b 步驟 4：子對話的資料夾授權（FAP 權限框）冒泡到父對話連結卡片，父對話按「授權／拒絕」才算數；
// 權限問題不可自動回答，文字也不接受。
// 案例：
//   P1 子對話發起讀取授權：子對話 waiting_user、權限框顯示「來自子對話」、連結卡片有「授權」按鈕；
//      父對話打字被拒絕；等 800ms 仍未回答（沒有自動回答）；父對話按「授權」→ 檢查結束（未拋錯）、框消失、等待清除。
//   P2 子對話發起讀寫授權，父對話按「拒絕」→ 檢查拋出「拒絕」錯誤。
//   P3 子對話發起授權，使用者直接在權限框按「授權」→ 檢查結束，連結卡片的等待也清除（兩條路一致）。
//   P4 父對話自己發起授權：不冒泡到任何子對話（子對話狀態不變、沒有等待記錄）。
// 權限物件是假的 handle（queryPermission 回 prompt、requestPermission 回 granted），不碰真的檔案系統。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_fap.eval.js 17969
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (fn) => { try { return fn(); } catch (e) { return Promise.reject(e); } };
const tag = (p) => Promise.resolve(p).then(() => 'ok', (e) => 'err:' + String((e && e.message) || e));
const raceTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => '__timeout__')]);
const fakeRec = (id) => ({ id: id, label: '測試資料夾' + id, handle: { queryPermission: async () => 'prompt', requestPermission: async () => 'granted' } });

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
const parentCtx = fa._ctx;
for (const t of ['幫我畫一張貓的圖', '再加一隻狗', '幫我創作一首音樂']) { await sendOne(t); }
let kid = null;
for (let i = 0; i < 300; i++) {
  const kids = ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId === pid);
  if (kids.length && kids.every((k) => k.status === 'done' || k.status === 'failed')) { kid = kids[0]; break; }
  await sleep(200);
}
fa.advancedSettings.topicShiftCheck = false;
R.info.hasKid = !!kid;
const cctx = kid ? await fa._chatCtxLoad(kid.id) : null;
const cr = cctx ? fa._chatRunner(cctx) : null;
const statusOf = () => { const e = kid && fa._chatEntry(kid.id); return e ? e.status : null; };
const linkEl = () => document.querySelector('.fa-subchat-link[data-child-id="' + (kid && kid.id) + '"]');
const modalAllow = () => document.getElementById('fa-fapperm-allow');
const bubbleHas = () => (kid ? fa._subchatPendingMap().has(kid.id) : null);

// P1：子對話發起讀取授權，父對話只能按按鈕
fa._chatActivate(parentCtx);
fa._subchatSetStatus(kid.id, 'start');
const pA = tag(safe(() => cr._checkFapPermission(fakeRec('A'), 'read')));
await sleep(200);
const eA = fa._chatEntry(kid.id);
R.checks.p1_waitingUser = statusOf() === 'waiting_user';
R.checks.p1_questionShown = !!(eA && eA.subInfo && String(eA.subInfo.question).indexOf('需要資料夾授權') >= 0 && String(eA.subInfo.question).indexOf('測試資料夾A') >= 0);
R.checks.p1_modalShownFromChild = !!modalAllow() && document.body.innerHTML.indexOf('來自子對話：') >= 0;
R.checks.p1_cardHasAllowButton = !!linkEl() && Array.from(linkEl().querySelectorAll('button')).some((b) => b.textContent === '授權');
const rTyped = safe(() => fa._subchatAnswer(kid.id, '好，授權'));
R.checks.p1_typingRejected = !!rTyped && rTyped.ok === false;
const early = await raceTimeout(pA, 800);
R.checks.p1_notAutoAnswered = early === '__timeout__';
const rAllow = safe(() => fa._subchatAnswerFap(kid.id, true));
R.checks.p1_answerOk = !!rAllow && rAllow.ok === true;
const resA = await raceTimeout(pA, 3000);
R.checks.p1_resolvedOk = resA === 'ok';
await sleep(100);
R.checks.p1_modalGone = !modalAllow();
R.checks.p1_bubbleCleared = bubbleHas() === false;
R.checks.p1_notWaitingAfter = statusOf() !== 'waiting_user';

// P2：子對話發起讀寫授權，父對話按「拒絕」→ 拋錯
fa._subchatSetStatus(kid.id, 'start');
const pB = tag(safe(() => cr._checkFapPermission(fakeRec('B'), 'readwrite')));
await sleep(200);
const rDeny = safe(() => fa._subchatAnswerFap(kid.id, false));
R.checks.p2_denyOk = !!rDeny && rDeny.ok === true;
const resB = await raceTimeout(pB, 3000);
R.checks.p2_deniedThrows = typeof resB === 'string' && resB.indexOf('err:') === 0 && resB.indexOf('拒絕') >= 0;
await sleep(100);
R.checks.p2_bubbleCleared = bubbleHas() === false;

// P3：子對話發起授權，直接在權限框按「授權」（使用者點框）
fa._subchatSetStatus(kid.id, 'start');
const pC = tag(safe(() => cr._checkFapPermission(fakeRec('C'), 'read')));
await sleep(200);
R.checks.p3_waitingUser = statusOf() === 'waiting_user';
const allowC = modalAllow();
if (allowC) allowC.click();
const resC = await raceTimeout(pC, 3000);
R.checks.p3_modalPathResolves = resC === 'ok';
await sleep(100);
R.checks.p3_bubbleClearedByModal = bubbleHas() === false && statusOf() !== 'waiting_user';

// P4：父對話自己發起授權 → 不冒泡（子對話狀態不變、沒有等待記錄）
const before4 = statusOf();
const pD = tag(safe(() => fa._checkFapPermission(fakeRec('D'), 'read')));
await sleep(200);
R.checks.p4_parentNoBubble = statusOf() === before4 && bubbleHas() === false && !!modalAllow();
const allowD = modalAllow();
if (allowD) allowD.click();
R.info.p4Result = await raceTimeout(pD, 3000);

// 載入的是工作目錄的實作（字串常值，不用變數名）
R.checks.loadedWorkdirImpl = /權限問題只能按/.test(String(fa._subchatAnswer)) && /_subchatFapBubble/.test(String(fa._checkFapPermission));

// 還原
fa.advancedSettings.topicShiftCheck = false;
window.fetch = realFetch;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
