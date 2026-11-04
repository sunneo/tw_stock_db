// 本地話題偵測（子對話 S2）真實桌面版評估：假 LLM，比對 topicShiftCheck 關／開兩組。
// 檢查：
//   關：每則訊息的模型呼叫序列只有主模型；_lastTopicShift 不存在；沒有呼叫 _localTopicCheck。
//   開：模型呼叫序列與關相同（沒有話題判斷、沒有摘要呼叫）；_lastTopicShift 依序為
//       不轉移／不轉移／轉移／轉移（matchedTopicId 有值）／不轉移；this.messages 沒被縮成摘要；
//       archivedDisplayBlocks 沒有新增；每則偵測耗時 < 5 ms。
//   載入來源：_localTopicCheck 的原始碼含字串常值「判定新話題」，且本地偵測行為正確（證明跑的是工作目錄的實作）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/topic_local.eval.js
const fa = window.fa;
const R = { checks: {}, passes: {} };
const now = () => performance.now();

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }

// 模型呼叫紀錄（目前這一則）
let cur = null;

// 假 LLM：依 system／最後訊息辨識呼叫種類；話題判斷與摘要若被呼叫會被記下來（開啟時應該都不會出現）
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const sys = String((body.messages[0] || {}).content || '');
  const mk = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let kind, reply;
  if (/對話分析專家/.test(sys)) { kind = 'topic_check'; reply = JSON.stringify({ isShifted: true, reason: 'fake', newTopicSummary: '音樂' }); }
  else if (/議題切割摘要|過渡摘要/.test(sys)) { kind = 'shift_summary'; reply = '摘要'; }
  else { kind = 'main_chat'; reply = '完成'; }
  if (cur) cur.modelCalls.push(kind);
  return mk(reply);
};

// 包住判斷函式：量每則的偵測耗時；同時記錄舊的阻塞式判斷是否被呼叫
let localMs = null;
const origLocal = fa._localTopicCheck;
const loadedLocalSrc = typeof origLocal === 'function' ? String(origLocal) : ''; // 包裝前取原始碼（來源檢查用）
if (typeof origLocal === 'function') {
  fa._localTopicCheck = function (text) {
    const s = now();
    try { return origLocal.call(this, text); } finally { localMs = now() - s; }
  };
}
let blockingCalls = 0;
const origBlocking = fa._checkTopicTransition;
fa._checkTopicTransition = async function (...args) { blockingCalls++; return origBlocking.apply(this, args); };

const texts = ['幫我畫一張貓的圖', '再加一隻狗', '幫我創作一首音樂', '再畫一張狗的圖', '好'];

async function runPass(on) {
  fa.advancedSettings.topicShiftCheck = on;
  fa._clearChatHistory();
  delete fa._lastTopicShift;
  const archivedBefore = fa.archivedDisplayBlocks.length;
  const rows = [];
  for (const text of texts) {
    cur = { text, modelCalls: [] };
    localMs = null;
    let err = null;
    await Promise.race([fa.executeChat(text), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]).catch((e) => { err = String(e && e.message || e); });
    rows.push({
      text,
      calls: cur.modelCalls.slice(),
      shift: fa._lastTopicShift ? { isShifted: fa._lastTopicShift.isShifted, matchedTopicId: fa._lastTopicShift.matchedTopicId, reason: fa._lastTopicShift.reason } : null,
      localMs: localMs === null ? null : +localMs.toFixed(3),
      err,
    });
    cur = null;
  }
  const hasSummaryMsg = fa.messages.some((m) => /Topic Transition Summary/.test(String(m.content || '')));
  return {
    rows,
    archivedAdded: fa.archivedDisplayBlocks.length - archivedBefore,
    hasSummaryMsg,
    messageCount: fa.messages.length,
  };
}

// 開與關各跑一次（每組從清空後開始）
R.passes.off = await runPass(false);
R.passes.on = await runPass(true);
const off = R.passes.off, on = R.passes.on;

const MAIN = ['main_chat'];
// 1. 關：每則只有主模型呼叫；_lastTopicShift 不存在
R.checks.offOnlyMainCalls = off.rows.every((r) => r.calls.length === 1 && r.calls[0] === 'main_chat');
R.checks.offNoShiftRecord = off.rows.every((r) => r.shift === null);
R.checks.offNoLocalCall = off.rows.every((r) => r.localMs === null);

// 2. 開：模型呼叫序列與關相同，沒有判斷與摘要呼叫
R.checks.onCallsSameAsOff = on.rows.length === off.rows.length && on.rows.every((r, i) => JSON.stringify(r.calls) === JSON.stringify(off.rows[i].calls));
R.checks.onNoTopicCheckOrSummaryCalls = on.rows.every((r) => r.calls.every((k) => MAIN.indexOf(k) >= 0));
// 整個評估過程都不應呼叫舊的阻塞式判斷（開與關兩組都是）
R.checks.noBlockingJudgeCall = blockingCalls === 0;

// 3. 開：_lastTopicShift 依序 不轉移／不轉移／轉移／轉移（有 matchedTopicId）／不轉移
const expect = [false, false, true, true, false];
R.checks.onShiftSequence = on.rows.every((r, i) => r.shift && r.shift.isShifted === expect[i]);
R.checks.onMatchedOnReturn = !!(on.rows[3].shift && on.rows[3].shift.matchedTopicId);
R.checks.onNoMatchOnNewTopic = !!(on.rows[2].shift && on.rows[2].shift.matchedTopicId === null);

// 4. 開：this.messages 沒被縮成摘要，archivedDisplayBlocks 沒有新增
R.checks.onNoSummaryReplacement = on.hasSummaryMsg === false && on.archivedAdded === 0;

// 5. 開：每則偵測耗時 < 5 ms
R.checks.onLocalUnder5ms = on.rows.every((r) => r.localMs !== null && r.localMs < 5);

// 6. 載入來源：工作目錄的實作（原始碼含常值 'pastTopics'；本地偵測行為正確）
R.checks.loadedWorkdirImpl = loadedLocalSrc.indexOf('判定新話題') >= 0;
const L = typeof fa._topicLocalMod === 'function' ? fa._topicLocalMod() : null; // 修前版本沒有這個函式
R.checks.loadedBehaviorOk = !!L && (() => {
  const demoCur = L.fingerprintOf('幫我畫一張貓的圖');
  return L.detectShift(demoCur, [], '幫我創作一首音樂').isShifted === true
    && L.detectShift(demoCur, [], '好').isShifted === false;
})();

// 還原
fa.advancedSettings.topicShiftCheck = false;
if (origLocal) fa._localTopicCheck = origLocal;
fa._checkTopicTransition = origBlocking;
window.fetch = realFetch;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
