// 壓縮工具索引的「關閉時逐位元組不變」基準樣本（真實 Electron、假 LLM）。
// 在改動前的版本跑一次存成 scripts/eval/baselines/compact-off-baseline.json；之後在現在的版本把開關設成 '0' 再跑，用 scripts/compact-off-baseline.test.js 比對。
// 不依賴 FaCompactIndex（改動前的版本沒有它）；雜湊自己帶。
// 用法：FA_DISABLE_MAIN_OVERLAY=1 FA_DEBUG_EVAL_FILE=<本檔> FA_BROWSER_CONTROL_PORT=<非17923> FA_COMPACT_FLAG=0 electron <desktop-app> --no-sandbox --disable-gpu --user-data-dir=<全新資料夾>
const fa = window.fa; const R = {};
const H = (str) => { str = String(str == null ? '' : str); let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); };
try { localStorage.setItem('fa.compactToolIndex', '0'); } catch (_) { /* */ }
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
fa._getGroundingContext = () => '[固定的環境資訊]'; // 時鐘不固定，換成常數
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
const realFetch = window.fetch.bind(window); let routerPrompt = null;
window.fetch = async (url, init) => { if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init); const body = JSON.parse(init.body); const sys = String((body.messages[0] || {}).content || ''); const mk = (m) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, m), finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); if (/工具領域路由器/.test(sys)) { routerPrompt = sys; return mk({ content: JSON.stringify({ domains: [] }) }); } return mk({ content: 'ok' }); };
const TASKS = ['把幾張圖片合成一份 PDF', '朗讀這段文字', '做一份簡報', '幫我看一下這個專案的程式結構'];
const snap = async (mode, task, native) => {
  fa.advancedSettings.multiSubAgentMode = mode; fa._amMode = mode; fa._intentWiden = false; fa._intentExtra = new Set(); fa._intentMiss = new Set(); fa._intentPlanCache = null; fa._splitDirty = true; fa._currentTurnUserText = task;
  fa._shouldUseNativeToolCalls = () => native;
  const names = fa._getRootToolNames() || []; const sys = fa._getFinalSystemPrompt(); const schema = JSON.stringify(fa._buildNativeToolsSchema(names));
  return { n: names.length, names: H(names.join('|')), sysLen: sys.length, sys: H(sys), schemaLen: schema.length, schema: H(schema), delegate: H(fa._buildDelegateToSubagentDescription ? fa._buildDelegateToSubagentDescription() : '') };
};
R.modes = {};
for (const mode of ['off', 'router', 'full', 'hierarchical', 'intent']) { R.modes[mode] = {}; for (const native of [true, false]) { R.modes[mode][native ? 'native' : 'text'] = await snap(mode, TASKS[0], native); } }
R.tasks = {}; for (const task of TASKS) R.tasks[task] = await snap('intent', task, true);
fa.advancedSettings.multiSubAgentMode = 'full'; fa._amMode = 'full'; fa._shouldUseNativeToolCalls = () => true;
R.router = {}; for (const task of TASKS) { routerPrompt = null; try { await fa._delegateToSubagentAuto(task); } catch (_) { /* */ } R.router[task] = routerPrompt ? { len: routerPrompt.length, h: H(routerPrompt) } : null; }
window.fetch = realFetch; R.meta = { hasCompact: typeof FaCompactIndex !== 'undefined', defaultMode: 'n/a' };
return R;
