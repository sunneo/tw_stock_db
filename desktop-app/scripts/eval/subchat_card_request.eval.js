// 子對話 S4 步驟 1：父對話有連結卡片（role:'tool' 的顯示訊息）之後，使用者在父對話再送一則訊息，
// 連結卡片是否被送進模型請求。假 LLM 抓請求 body。
// 檢查：
//   - 父對話 fa.messages 裡確實有連結卡片（前置條件，否則評估無意義）。
//   - 送進模型的 messages 裡沒有任何連結卡片內容（「↳ 子對話」）。
//   - 送進模型的 messages 裡沒有孤兒 tool 訊息（每則 role:'tool' 前面都要有對應 assistant.tool_calls）。
//   - 送進模型的 messages 數量比 fa.messages 少（卡片被過濾）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_card_request.eval.js 17964
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }

// 話題判斷的假回覆：前三則要開子對話；第四則（父對話後續）不要再開
let shiftReply = true;
let captured = [];
const seen = [];
let cur = null;
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = String((msgs[0] || {}).content || '');
  const child = msgs.some((m) => m && m.role === 'system' && String(m.content || '').indexOf('從〈') >= 0);
  const mk = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let kind = 'main_chat', reply = '完成';
  if (/對話分析專家/.test(sys)) { kind = 'topic_check'; reply = JSON.stringify({ isShifted: shiftReply, reason: 'fake', newTopicSummary: '音樂' }); }
  if (/議題切割摘要|過渡摘要/.test(sys)) { kind = 'shift_summary'; reply = '摘要'; }
  seen.push({ kind, child, n: msgs.length, sys: sys.slice(0, 20) });
  if (kind === 'main_chat' && !child) captured.push(msgs.map((m) => ({ role: m.role, tool_call_id: m.tool_call_id || null, has_tc: Array.isArray(m.tool_calls), content: String(m.content || '') })));
  return mk(reply);
};

const texts = ['幫我畫一張貓的圖', '再加一隻狗', '幫我創作一首音樂'];
const NEW_TITLE = '幫我創作一首音樂';

function linkCards() { return fa.messages.filter((m) => m && m._subchatLink); }

async function sendOne(text) {
  let err = null;
  await Promise.race([fa.executeChat(text), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]).catch((e) => { err = String((e && e.message) || e); });
  return err;
}

fa.advancedSettings.topicShiftCheck = true;
fa._clearChatHistory();
delete fa._lastTopicShift;
const pid = fa._chatIndex.currentId;
for (const t of texts) { await sendOne(t); }
// 等子對話跑完
for (let i = 0; i < 300; i++) {
  const kids = ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId === pid);
  if (kids.length && kids.every((k) => k.status === 'done' || k.status === 'failed')) break;
  await sleep(200);
}
R.checks.preCardExists = linkCards().length === 1;

// 父對話第四則：話題判斷改為「不轉換」，抓這次父對話的模型請求
shiftReply = false;
// 本地話題偵測會把任何不相關的新一則判成新話題（已實測：「還有一句話」開出第三個子對話、父對話不呼叫模型），
// 所以這一則在話題偵測關閉時送出，確保是父對話自己送模型請求、且連結卡片仍在父對話的訊息列表裡。
fa.advancedSettings.topicShiftCheck = false;
captured = [];
const err4 = await sendOne('還有一句話');
R.info.err4 = err4;
R.info.seenLast = seen.slice(-6);
R.info.parentTopicMode = fa.advancedSettings.topicShiftCheck;
R.info.childrenNow = ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId === pid).map((c) => ({ t: c.title, s: c.status }));
R.info.lastMsgs = fa.messages.slice(-3).map((m) => ({ r: m.role, c: String(m.content || '').slice(0, 30), card: !!m._subchatLink }));
const req = captured[0] || [];
R.info.reqMsgCount = req.length;
R.info.reqRoles = req.map((m) => (m.role + (m.has_tc ? '(tool_calls)' : '') + (m.tool_call_id ? '(tool)' : '')));
R.info.uiMsgCount = fa.messages.length;

R.checks.parentRequestCaptured = req.length > 0;
R.checks.noCardTextInRequest = req.every((m) => m.content.indexOf('↳ 子對話') < 0);
// 孤兒 tool：每則 tool 前面（同一請求內）必須有帶 tool_calls 的 assistant，且 tool_call_id 對得上
R.checks.noOrphanToolInRequest = req.every((m, i) => {
  if (m.role !== 'tool') return true;
  for (let j = i - 1; j >= 0; j--) {
    if (req[j].role === 'tool') continue;
    return req[j].role === 'assistant' && req[j].has_tc;
  }
  return false;
});
R.checks.requestSmallerThanUi = req.length < fa.messages.length;
R.checks.parentNoError = !err4;

// 還原
fa.advancedSettings.topicShiftCheck = false;
window.fetch = realFetch;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
