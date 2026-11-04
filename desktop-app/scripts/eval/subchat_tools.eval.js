// 子對話 S4b 步驟 2：同一句話在父對話與子對話送出時，模型請求的工具清單（body.tools）是否一致，
// 以及兩邊是否都含 ask_user_card（子對話要能問使用者的前提）。假 LLM 抓請求 body。
// 檢查：
//   - parentCaptured / childCaptured：兩邊都確實抓到模型請求（前置條件）。
//   - sameNameSet：父與子的工具名稱集合完全相同（不是只看數量）。
//   - parentHasAskCard：父對話的請求含 ask_user_card。
//   - childHasAskCard：子對話的請求含 ask_user_card。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_tools.eval.js 17967
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }

let shiftReply = true;
let caps = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = String((msgs[0] || {}).content || '');
  const child = msgs.some((m) => m && m.role === 'system' && String(m.content || '').indexOf('從〈') >= 0);
  const mk = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let reply = '完成';
  if (/對話分析專家/.test(sys)) reply = JSON.stringify({ isShifted: shiftReply, reason: 'fake', newTopicSummary: '音樂' });
  if (/議題切割摘要|過渡摘要/.test(sys)) reply = '摘要';
  if (!/對話分析專家|議題切割摘要|過渡摘要/.test(sys)) {
    const names = Array.isArray(body.tools) ? body.tools.map((t) => (t && (t.name || (t.function && t.function.name))) || '?').sort() : null;
    caps.push({ child, names });
  }
  return mk(reply);
};

function linkCards() { return fa.messages.filter((m) => m && m._subchatLink); }
async function sendOne(text) {
  let err = null;
  await Promise.race([fa.executeChat(text), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]).catch((e) => { err = String((e && e.message) || e); });
  return err;
}

const TEXT = '幫我畫一張貓的圖';

// 前置：開出一個子對話（前三則，第三則話題轉換）
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
R.info.childCount = ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId === pid).length;
R.info.preCardExists = linkCards().length === 1;

// 父對話：同一句話，不做話題轉換
shiftReply = false;
fa.advancedSettings.topicShiftCheck = false;
caps = [];
const errParent = await sendOne(TEXT);
R.info.errParent = errParent;
const parentCap = caps.filter((c) => !c.child).pop() || null;

// 子對話：同一句話，經由既有的傳訊息入口（閒置 → 新一輪）
caps = [];
let sendRes = null;
if (kid) {
  sendRes = await fa._subchatSend(kid.id, TEXT);
  for (let i = 0; i < 150; i++) {
    const cur = ((fa._chatIndex && fa._chatIndex.chats) || []).find((c) => c.id === kid.id);
    if (cur && (cur.status === 'done' || cur.status === 'failed' || cur.status === 'waiting_user')) break;
    await sleep(200);
  }
}
R.info.sendMode = sendRes && sendRes.mode;
const childCap = caps.filter((c) => c.child).pop() || null;

const pn = parentCap ? parentCap.names : [];
const cn = childCap ? childCap.names : [];
R.info.parentCount = pn.length;
R.info.childCount2 = cn.length;
R.info.onlyParent = pn.filter((n) => cn.indexOf(n) < 0);
R.info.onlyChild = cn.filter((n) => pn.indexOf(n) < 0);

R.checks.parentCaptured = !!parentCap && Array.isArray(parentCap.names);
R.checks.childCaptured = !!childCap && Array.isArray(childCap.names);
// 子對話 S5 起，父對話多出三個子對話工具（chat_list_children 等），子對話不會有（子對話不再有子對話）。
// 判準：父對話扣掉這三個後，與子對話工具清單完全相同；三個工具只出現在父對話。
const SUB3 = ['chat_list_children', 'chat_send_to_child', 'chat_get_child_summary'];
const pnBase = pn.filter((n) => SUB3.indexOf(n) < 0);
R.checks.sameNameSet = R.checks.parentCaptured && R.checks.childCaptured && pnBase.join('|') === cn.join('|') && SUB3.every((n) => pn.indexOf(n) >= 0) && cn.every((n) => SUB3.indexOf(n) < 0);
R.checks.parentHasAskCard = pn.indexOf('ask_user_card') >= 0;
R.checks.childHasAskCard = cn.indexOf('ask_user_card') >= 0;
// 載入的是工作目錄的實作（字串常值，不用變數名）
// 建置會把引號改成雙引號，所以兩種引號都接受；舊版（gated）寫法不能再出現
const regSrc = String(fa._registerBuiltinAiTools);
R.checks.loadedWorkdirImpl = /register_openai_tool\(["']ask_user_card["']/.test(regSrc) && !/registerOptional\(["']ask_user_card["']/.test(regSrc);

// 還原
fa.advancedSettings.topicShiftCheck = false;
window.fetch = realFetch;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
