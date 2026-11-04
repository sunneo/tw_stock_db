// 子對話 S5 步驟2（@對話名稱）真實桌面版評估：假 LLM。
// 檢查：
//   - 輸入 @ 出現自動完成清單（DOM：#ai-mention-menu .ai-mention-item，data-insert 為插入文字）
//   - 選取（Enter）後插入 @名稱；名稱含空白時用 @[…] 寫法
//   - 送出 @畫貓 幫我看看：使用者看到的訊息不變；送給模型的請求裡有「[提及對話] …〈畫貓〉… id=…」提示
//   - 同名歧義（@重複名）不送出，輸入框保留原文，沒有新的使用者訊息、沒有模型呼叫
//   - 找不到（@不存在的對話）當一般文字送出，請求裡沒有提示
// 另外：載入來源（工作目錄的實作，用正規表示式接受兩種引號）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/chat_mention.eval.js 17964
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa.advancedSettings.topicShiftCheck = false;
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
const realConfirm = window.confirm;
window.confirm = () => true;

// 記下每一次主模型請求的訊息陣列
const requests = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  requests.push(msgs.map((m) => ({ role: m && m.role, content: String((m && m.content) || '') })));
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const pid = fa._chatIndex.currentId;
const mkChild = (title, status, summary) => fa._chatNew(null, { parentId: pid, title, noActivate: true, status, summary });
const A = await mkChild('畫貓', 'done', '畫了一張貓');
const B1 = await mkChild('重複名', 'done', '第一個');
const B2 = await mkChild('重複名', 'done', '第二個');
const C = await mkChild('音樂 創作', 'running', '正在寫歌');
R.info.ids = { A, B1, B2, C };

const inp = document.getElementById('ai-input-text');
const menuItems = () => [...document.querySelectorAll('#ai-mention-menu .ai-mention-item')];
const menuVisible = () => { const m = document.getElementById('ai-mention-menu'); return !!m && m.style.display !== 'none' && menuItems().length > 0; };
const typeText = async (v) => {
  inp.focus(); inp.value = v; inp.setSelectionRange(v.length, v.length);
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(80);
};
const pressKey = async (key) => {
  inp.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await sleep(60);
};

// ----- 自動完成 -----
await typeText('@');
const insertsAtAt = menuItems().map((e) => e.dataset.insert);
R.info.atItems = insertsAtAt;
R.checks.acShowsOnAt = menuVisible() && insertsAtAt.indexOf('@畫貓') >= 0 && insertsAtAt.indexOf('@[音樂 創作]') >= 0;
R.checks.acLocalFirst = insertsAtAt.length > 0 && insertsAtAt[0].indexOf('@[') !== 0 && insertsAtAt.indexOf('@畫貓') >= 0;

await typeText('@畫');
await pressKey('Enter');
R.checks.acEnterInsertsName = inp.value === '@畫貓 ';
R.checks.acMenuClosedAfterPick = !menuVisible();

await typeText('@音');
await pressKey('Enter');
R.checks.acBracketInsertForSpace = inp.value === '@[音樂 創作] ';

// ----- 送出：有效名稱 → 提示只給模型，使用者看到的文字不變 -----
inp.value = '@畫貓 幫我看看';
let requestsBefore = requests.length;
const msgsBefore = fa.messages.length;
await Promise.race([fa._submitChatInput(inp, null), sleep(60000)]);
await sleep(300);
const userMsgs = fa.messages.filter((m) => m && m.role === 'user');
const lastUser = userMsgs[userMsgs.length - 1];
R.checks.sendVisibleTextUnchanged = !!lastUser && lastUser.content === '@畫貓 幫我看看';
const reqA = requests.slice(requestsBefore);
const hintInReq = reqA.length >= 1 && reqA[0].some((m) => m.role === 'system' && m.content.indexOf('[提及對話]') >= 0 && m.content.indexOf('〈畫貓〉') >= 0 && m.content.indexOf('id=' + A) >= 0);
R.checks.sendHintInRequest = hintInReq;
R.info.hintSample = reqA.length ? (reqA[0].filter((m) => m.role === 'system').map((m) => m.content.slice(0, 160))) : [];

// ----- 歧義：不送出，保留原文 -----
requestsBefore = requests.length;
const msgsBeforeAmb = fa.messages.length;
inp.value = '@重複名 你好';
await Promise.race([fa._submitChatInput(inp, null), sleep(5000)]);
await sleep(200);
R.checks.ambiguousNotSent = inp.value === '@重複名 你好' && fa.messages.length === msgsBeforeAmb && requests.length === requestsBefore;

// ----- 找不到：當一般文字 -----
requestsBefore = requests.length;
inp.value = '@不存在的對話 你好';
await Promise.race([fa._submitChatInput(inp, null), sleep(60000)]);
await sleep(300);
const lastUser2 = fa.messages.filter((m) => m && m.role === 'user').slice(-1)[0];
const reqN = requests.slice(requestsBefore);
R.checks.notFoundSentAsPlain = !!lastUser2 && lastUser2.content === '@不存在的對話 你好';
R.checks.notFoundNoHintInReq = reqN.length >= 1 && !reqN[0].some((m) => m.content.indexOf('[提及對話]') >= 0);

// 載入來源：工作目錄的實作（正規表示式，接受兩種引號）
R.checks.loadedWorkdirImpl = /提及對話/.test(String(fa._mentionPrepare || ''));

// 清理：刪掉本評估建立的子對話，還原
for (const id of [A, B1, B2, C]) { try { await fa._chatDelete(id); } catch (_) { /* 清理失敗不影響結果 */ } }
inp.value = '';
window.fetch = realFetch;
window.confirm = realConfirm;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
