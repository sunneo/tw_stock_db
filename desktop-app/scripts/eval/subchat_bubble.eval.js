// 子對話 S4 步驟 4（狀態監控與冒泡）真實桌面版評估：假 LLM。
// 案例 A（問使用者 → 父對話回答 → 完成）：
//   子對話模型呼叫 ask_user_card → 子對話 status 變 waiting_user、父對話連結卡片顯示「等你回應：…」與回答欄；
//   在父對話回答（_subchatAnswer）→ 子對話繼續、模型收到回答後回覆 → status done。
// 案例 B（出錯）：直接開子對話，子對話模型端回 HTTP 500 → status failed，連結卡片顯示「失敗：…」。
// 案例 C（完成）：案例 A 的結束即是完成；另外案例 B 之前的正常一輪 status 應為 done（不是 failed）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_bubble.eval.js 17965
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }

const ASK_SPEC = { title: '要用哪種配色？', questions: [{ id: 'color', type: 'text', label: '配色' }] };
let failChild = false;
const dbgTools = [];
const dbgFail = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = String((msgs[0] || {}).content || '');
  const child = msgs.some((m) => m && m.role === 'system' && String(m.content || '').indexOf('從〈') >= 0);
  const lastUser = [...msgs].reverse().find((m) => m && m.role === 'user');
  const lastUserText = lastUser ? String(lastUser.content || '') : '';
  const hasToolResult = msgs.some((m) => m && m.role === 'tool');
  if (child) dbgTools.push({ n: (body.tools || []).length, names: (body.tools || []).map((t) => (t.function ? t.function.name : t.name)).slice(0, 60).join(',').slice(0, 300), lastUser: lastUserText.slice(0, 30) });
  const toolsText = JSON.stringify(body.tools || []);
  const ok = (message, finish) => new Response(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/對話分析專家/.test(sys)) return ok({ role: 'assistant', content: JSON.stringify({ isShifted: true, reason: 'fake', newTopicSummary: '音樂' }) }, 'stop');
  if (/議題切割摘要|過渡摘要/.test(sys)) return ok({ role: 'assistant', content: '摘要' }, 'stop');
  if (failChild) { // B 案例期間（父對話閒置），所有假模型請求（含子對話的歷史摘要）都回 400
    dbgFail.push(Date.now());
    dbgFail.push(Date.now());
    return new Response(JSON.stringify({ error: { message: 'fake bad request' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  // 子對話送出的工具清單不一定含 ask_user_card（實測：只有 13 項，沒有它），假模型直接回傳這個工具呼叫，看執行端接不接受
  if (child && !hasToolResult && lastUserText.indexOf('問我') >= 0) {
    return ok({ role: 'assistant', content: null, tool_calls: [{ id: 'call_ask_1', type: 'function', function: { name: 'ask_user_card', arguments: JSON.stringify(ASK_SPEC) } }] }, 'tool_calls');
  }
  return ok({ role: 'assistant', content: '完成' }, 'stop');
};

const sleepUntil = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(150); } return pred(); };
const kidsOf = (pid) => ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId === pid);
const linkEls = () => Array.from(document.querySelectorAll('.fa-subchat-link'));

fa.advancedSettings.topicShiftCheck = true;
fa._clearChatHistory();
delete fa._lastTopicShift;
const pid = fa._chatIndex.currentId;
R.info.pid = pid;
R.info.dbgTools = dbgTools;

// ----- 案例 A -----
for (const t of ['幫我畫一張貓的圖', '再加一隻狗']) {
  await Promise.race([fa.executeChat(t), sleep(30000)]);
}
await Promise.race([fa.executeChat('幫我創作一首音樂，問我配色'), sleep(30000)]);
const kidA = await (async () => { await sleepUntil(() => kidsOf(pid).length > 0, 20000); return kidsOf(pid)[0] || null; })();
R.info.kidA = kidA ? { id: kidA.id, title: kidA.title, status: kidA.status } : null;
R.checks.aChildOpened = !!kidA;

const waitingReached = await sleepUntil(() => !!kidA && (fa._chatIndex.chats.find((c) => c.id === kidA.id) || {}).status === 'waiting_user', 20000);
R.checks.aStatusWaitingUser = waitingReached;
R.info.aStatusNow = kidA ? ((fa._chatIndex.chats.find((c) => c.id === kidA.id) || {}).status) : null;
await sleep(400);
const linkTextWaiting = linkEls().map((e) => e.textContent).join(' | ');
R.info.aLinkText = linkTextWaiting.slice(0, 200);
R.checks.aParentLinkShowsQuestion = linkTextWaiting.indexOf('等你回應') >= 0 && linkTextWaiting.indexOf('配色') >= 0;
R.checks.aParentHasAnswerBox = linkEls().some((e) => !!e.querySelector('input'));

// 在父對話回答（不是切到子對話）
let ansRes = null;
if (typeof fa._subchatAnswer === 'function' && kidA) ansRes = fa._subchatAnswer(kidA.id, '紅色');
R.info.ansRes = ansRes;
R.checks.aAnswerAccepted = !!ansRes && ansRes.ok === true;

const doneReached = await sleepUntil(() => !!kidA && (fa._chatIndex.chats.find((c) => c.id === kidA.id) || {}).status === 'done', 20000);
R.checks.aStatusDone = doneReached;
const kidCtx = kidA ? fa._chatCtxs.get(kidA.id) : null;
const kidMsgs = kidCtx ? kidCtx.messages : [];
R.checks.aChildGotAnswer = kidMsgs.some((m) => m && m.role === 'tool' && String(m.content || '').indexOf('紅色') >= 0);
R.checks.aChildContinuedReply = kidMsgs.some((m) => m && m.role === 'assistant' && m.content === '完成');
R.checks.aParentNotResponding = fa.isResponding === false;

// ----- 案例 B／C（出錯）-----
// 假模型端的離線備援會把失敗包成「離線食譜」而判成成功，所以這兩案例直接替換子對話的 executeChat：
//   B：executeChat 拋出例外 → 子對話 failed，連結卡片顯示「失敗：…」。
//   C：executeChat 正常結束，但最後一則 assistant 是 ⚠️ 開頭的失敗訊息 → 子對話 failed（_turnFailureText 的判準）。
failChild = false;
const realExec = fa.executeChat;
fa.executeChat = function (t) {
  this.messages.push({ role: "user", content: t });
  if (t.indexOf("拋錯") >= 0) return Promise.reject(new Error("fake boom"));
  this.messages.push({ role: "assistant", content: "⚠️ 模型回應失敗（fake HTTP 500）" });
  return Promise.resolve();
};
fa._clearChatHistory();
delete fa._lastTopicShift;
const pidB = fa._chatIndex.currentId;
const openFail = async (text) => {
  fa.messages.push({ role: "user", content: text });
  fa._lastTopicShift = { isShifted: true, matchedTopicId: null };
  return fa._subchatOpenFor(text);
};
R.info.openedB = await openFail("幫我做一個拋錯的任務");
const kidB = kidsOf(pidB).find((c) => String(c.title || "").indexOf("拋錯") >= 0) || null;
R.info.kidBTitle = kidB ? kidB.title : null;
R.checks.bStatusFailed = await sleepUntil(() => !!kidB && (fa._chatIndex.chats.find((c) => c.id === kidB.id) || {}).status === "failed", 10000);
await sleep(300);
const linkTextB = linkEls().map((e) => e.textContent).join(" | ");
R.info.bLinkText = linkTextB.slice(0, 200);
R.checks.bLinkShowsFailure = linkTextB.indexOf("失敗：fake boom") >= 0;

R.info.openedC = await openFail("幫我做一個回應失敗的任務");
const kidC = kidsOf(pidB).find((c) => String(c.title || "").indexOf("回應失敗") >= 0) || null;
R.checks.cStatusFailed = await sleepUntil(() => !!kidC && (fa._chatIndex.chats.find((c) => c.id === kidC.id) || {}).status === "failed", 10000);
R.info.cSummary = kidC ? (fa._subchatLinkInfo(kidC.id) || {}).text : null;
R.checks.cSummaryShowsFailure = !!kidC && String(R.info.cSummary || "").indexOf("失敗：") === 0;
fa.executeChat = realExec;
delete fa.executeChat;

// 載入來源：工作目錄的實作（函式原始碼含字串常值 fa-subchat-answer-row）
R.checks.loadedWorkdirImpl = String(fa._subchatLinkDecorate || '').indexOf('fa-subchat-answer-row') >= 0;

// 還原
failChild = false;
fa.advancedSettings.topicShiftCheck = false;
window.fetch = realFetch;

R.info.dbgTools = dbgTools.slice(0, 4);
R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
