// 送出延遲量測（真實 Electron、假 LLM）：同一個對話連送 3 則（畫貓 → 換話題「創作音樂」 → 拉回「再畫一張狗」），
// 用 performance.now() 包住送出到第一次呼叫主模型之前的每個前置步驟，輸出每則訊息每步耗時與各次模型呼叫種類。
// 只在本評估檔裡包裝（不改來源）。結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/send_latency.eval.js
const fa = window.fa;
const R = { messages: [] };
let cur = null; // 目前這一則訊息的紀錄
let t0 = 0;
const now = () => performance.now();
const rel = () => +(now() - t0).toFixed(1);

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }

// 包裝：非同步步驟（回傳 Promise）
function wrapAsync(name, label) {
  const orig = fa[name];
  fa[name] = async function (...args) {
    const s = rel(); const st = { step: label, startMs: s };
    try { return await orig.apply(fa, args); }
    finally { st.ms = +(rel() - s).toFixed(1); if (cur) cur.steps.push(st); }
  };
}
// 包裝：同步步驟
function wrapSync(name, label) {
  const orig = fa[name];
  fa[name] = function (...args) {
    const s = rel(); const st = { step: label, startMs: s };
    try { return orig.apply(fa, args); }
    finally { st.ms = +(rel() - s).toFixed(1); if (cur) cur.steps.push(st); }
  };
}
wrapSync('_getInitialFallbackConfig', '_getInitialFallbackConfig(同步,無網路)');
wrapAsync('_ensureNativeToolSupportProbed', '_ensureNativeToolSupportProbed(首次會打探測請求)');
wrapAsync('_checkTopicTransition', '_checkTopicTransition(阻塞式話題判斷,可能含摘要)');
wrapAsync('_loopFetch', '_loopFetch(主模型呼叫,含工具迴圈)');

// 假 LLM：立即回覆；依 system/最後訊息辨識是哪一種呼叫
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const sys = String((body.messages[0] || {}).content || '');
  const mk = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let kind, reply;
  if (/對話分析專家/.test(sys)) {
    kind = 'topic_check(模型呼叫)';
    const m = /最新發送的訊息為：「([^」]*)」/.exec(sys);
    reply = JSON.stringify({ isShifted: !!(m && /音樂/.test(m[1])), reason: 'fake', newTopicSummary: '音樂' });
  } else if (/議題切割摘要|過渡摘要/.test(sys)) {
    kind = 'shift_summary(模型呼叫)'; reply = '摘要：畫貓';
  } else {
    kind = 'main_chat(模型呼叫)'; reply = '完成';
  }
  if (cur) cur.modelCalls.push({ kind, atMs: rel() });
  return mk(reply);
};

// 兩組：topicShiftCheck 關（預設）與開；每組先清空對話，各自從乾淨狀態送同樣三則。
const texts = ['幫我畫一張貓的圖', '幫我創作一首音樂', '再畫一張狗'];
R.passes = {};
for (const [label, on] of [['off', false], ['on', true]]) {
  fa.advancedSettings.topicShiftCheck = on;
  fa._clearChatHistory();
  R.messages = [];
  for (const text of texts) {
    cur = { text, steps: [], modelCalls: [] };
    t0 = now();
    let err = null;
    await Promise.race([fa.executeChat(text), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]).catch((e) => { err = String(e && e.message || e); });
    cur.totalMs = rel();
    cur.firstModelCallMs = cur.modelCalls.length ? cur.modelCalls[0].atMs : null;
    cur.err = err;
    R.messages.push(cur);
    cur = null;
  }
  R.passes[label] = R.messages;
}
delete R.messages;
fa.advancedSettings.topicShiftCheck = false;
R.loadedScripts = Array.from(document.scripts).map((s) => s.src).filter(Boolean).slice(0, 30);
window.fetch = realFetch;
return R;
