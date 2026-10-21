// Agent Model Configure（真實 Electron、假 LLM）：設定畫面（階段圖、開關、偏好清單、重置、自動決定、補跑基準、讓 AI 決定）、
// 執行時真的照偏好選模型（Orchestrator／路由／領域子Agent／Reducer），預設關閉時完全照原順序；另外驗證遠端群組面板換主題會重上色。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/agent-model.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false;
const keepRows = JSON.parse(JSON.stringify(fa.advancedSettings.llmModelRows)); const keepCfg = JSON.stringify(fa.advancedSettings.agentModels); const keepMode = fa.advancedSettings.multiSubAgentMode; const keepCards = localStorage.getItem(fa.MODEL_CARDS_KEY);
const mkRow = (id, name, extra) => Object.assign({ id, apiUrl: 'http://fake.local/v1', apiKey: 'k', modelName: name, temperature: null, maxOutputTokens: null }, extra || {});
fa.advancedSettings.llmModelRows = [mkRow('r1', 'fake/main-20b'), mkRow('r2', 'fake/ultra-550b', { contextWindowTokens: 128000 }), mkRow('r3', 'fake/super-120b', { contextWindowTokens: 256000 }), mkRow('r4', 'fake/lightning-8b')];
localStorage.removeItem(fa.MODEL_CARDS_KEY); fa.advancedSettings.multiSubAgentMode = 'router'; fa.advancedSettings.agentModels = { v: 1, enabled: false, useBuiltin: true, modes: {} };
if (typeof FaLlm !== 'undefined') FaLlm.realFetch = null; const realFetch = window.fetch.bind(window); let seen = []; let reply = '{"domains":[]}';
window.fetch = async (url, init) => { if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init); const b = JSON.parse(init.body); seen.push(b.model); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof reply === 'function' ? reply(b) : reply }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
const root = () => document.getElementById('ai-agent-model-config'); const q = (sel) => root().querySelector(sel); const qa = (sel) => [...root().querySelectorAll(sel)];
const click = async (el) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await wait(30); }; const change = async (el, v) => { if (v !== undefined) { if (el.type === 'checkbox') el.checked = v; else el.value = v; } el.dispatchEvent(new Event('change', { bubbles: true })); await wait(30); };
const cfg = () => fa.advancedSettings.agentModels;

// 1) 預設：關閉，完全照原順序
fa._amMode = null; fa._agentModelRender();
R.default = { exists: !!root(), enabledChecked: q('[data-am=enable]').checked === false, ids: fa._agentStageIds('orchestrator'), groupOrder: fa._computeModelRowGroups('domain_agent').map((g) => g.rows[0].id).join(), init: fa._getInitialFallbackConfig().apiModel, nodes: qa('[data-am=stage]').length, modeTabs: qa('[data-am=mode]').length };
// 2) 啟用：沒自訂的階段用內建預設（依名稱）；設定畫面顯示來源
await change(q('[data-am=enable]'), true);
R.enabled = { saved: cfg().enabled, orchBuiltin: fa._agentStageIds('orchestrator'), reducerBuiltin: fa._agentStageIds('reducer'), badge: root().textContent.includes('內建') };
// 3) 點節點、加入偏好、排序、移除
await click(qa('[data-am=stage][data-st=domain_agent]')[0]); const sel = q('[data-am=addsel]'); await change(sel, 'r3'); await change(q('[data-am=addsel]'), 'r1');
R.prefs = { stored: JSON.stringify(cfg().modes.router.stages.domain_agent.prefs), listRows: qa('[data-am=up]').length };
await click(qa('[data-am=down]')[0]); R.moved = JSON.stringify(cfg().modes.router.stages.domain_agent.prefs); await click(qa('[data-am=rm]')[1]); R.removed = JSON.stringify(cfg().modes.router.stages.domain_agent.prefs);
// 4) 執行時真的照偏好：子Agent、備援順序不丟模型、根對話的第一個選擇
R.runtime = { groups: fa._computeModelRowGroups('domain_agent').map((g) => g.rows[0].id).join(), allKept: fa._computeModelRowGroups('domain_agent').length === 4, other: fa._computeModelRowGroups('router').map((g) => g.rows[0].id).join() };
seen = []; reply = '好了'; await fa._runSubAgentTask('hello', 2, { allowedToolNames: [], noMoreTools: true, noExtend: true }); R.subagent_model = seen[0];
// 路由
seen = []; reply = '{"domains":[]}'; await fa._callRouterLLM('sys', 'user', 'router'); R.router_model = seen[0]; seen = []; await fa._callRouterLLM('sys', 'user', 'category_router'); R.category_model = seen[0];
// Reducer：委派結果回來之後下一輪換模型；沒委派就不換
const cur = { apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'fake/main-20b', genOverrides: {} }; const nx = fa._agentReducerNext(['delegate_to_subagent'], cur); const nx2 = fa._agentReducerNext(['get_tool_details'], cur);
R.reducer = { switched: nx.apiModel, notSwitched: nx2 === cur };
// 5) 模式不同、設定各自獨立；模式關閉
fa.advancedSettings.multiSubAgentMode = 'full'; R.other_mode = { domainAgent: fa._agentStageIds('domain_agent').join(), source: fa.advancedSettings.agentModels.modes.full }; fa.advancedSettings.multiSubAgentMode = 'router'; fa._amMode = 'router'; fa._agentModelRender();
await change(q('[data-am=modeon]'), false); R.mode_off = { ids: fa._agentStageIds('domain_agent').length, kept: !!cfg().modes.router.stages.domain_agent }; await change(q('[data-am=modeon]'), true);
// 6) 關閉再開：設定不變
const before = JSON.stringify(cfg().modes); await change(q('[data-am=enable]'), false); R.off_ids = fa._agentStageIds('domain_agent').length; await change(q('[data-am=enable]'), true); R.toggle_keeps = JSON.stringify(cfg().modes) === before;
// 7) 自動決定（不呼叫模型）：不覆蓋已自訂的階段
seen = []; await click(q('[data-am=auto]')); R.auto = { llmCalls: seen.length, domainKept: JSON.stringify(cfg().modes.router.stages.domain_agent.prefs) === R.removed, filled: Object.keys(cfg().modes).length, status: q('[data-am=status]').textContent.slice(0, 60) };
// 8) 補跑基準測試：只對沒有資料的模型（假的測試函式），結果存進模型卡，然後自動決定
const t1 = fa._benchmarkTest1, t2 = fa._benchmarkTest2; let benched = []; fa._ensureNativeToolSupportProbed = async () => true; fa._benchmarkTest1 = async (k, u, m) => { benched.push(m); return { score: m.includes('lightning') ? 95 : 40 }; }; fa._benchmarkTest2 = async (k, u, m) => ({ score: m.includes('ultra') ? 95 : 60 }); const confirm0 = window.confirm; window.confirm = () => true;
fa._amSet((c) => { c.modes = {}; }); await click(q('[data-am=bench]')); await wait(300); R.bench = { models: benched.length, cards: Object.keys(fa._getModelCards()).length, lightningSpeed: (fa._getModelCards()['fake/lightning-8b'] || {}).test1Score, orchestrator: cfg().modes.router && cfg().modes.router.stages.orchestrator && cfg().modes.router.stages.orchestrator.prefs[0] };
benched = []; await click(q('[data-am=bench]')); await wait(200); R.bench_again_skips = benched.length === 0; fa._benchmarkTest1 = t1; fa._benchmarkTest2 = t2;
// 9) 讓 AI 決定：封閉 JSON；壞回覆退回程式決定
fa._amSet((c) => { c.modes = {}; }); reply = '{"orchestrator":["D"],"router":["C","A"],"domain_agent":["B","Z"],"reducer":["B"],"category_router":[]}'; seen = []; await click(q('[data-am=ai]')); await wait(200);
R.ai = { llmCalls: seen.length, orch: cfg().modes.router.stages.orchestrator.prefs.join(), domain: cfg().modes.router.stages.domain_agent.prefs.join(), status: q('[data-am=status]').textContent.slice(0, 50) };
fa._amSet((c) => { c.modes = {}; }); reply = '我覺得都可以'; await click(q('[data-am=ai]')); await wait(200); R.ai_bad = { filled: Object.keys(cfg().modes).length > 0, status: q('[data-am=status]').textContent.slice(0, 40) };
// 10) 全部重置：自訂清掉、總開關不變
fa._amSet((c, A) => { A.setPrefs(c, 'router', 'reducer', ['r1']); }); await click(q('[data-am=reset]')); R.reset = { modes: Object.keys(cfg().modes).length, enabled: cfg().enabled, useBuiltin: cfg().useBuiltin };
window.confirm = confirm0;
// 11) 設定正規化：壞資料不丟例外
R.normalize_bad = (() => { try { return JSON.stringify(FaAgentModel.normalize({ enabled: 1, modes: { router: 'x' } }).modes); } catch (e) { return 'threw'; } })();
// 12) 遠端群組面板換主題會重上色（面板收著也一樣），表單填到一半的欄位會保留
const panel = document.getElementById('ai-rg-panel'); if (panel) { fa._rgView = 'form'; fa._rgOpen = false; panel.dataset.view = ''; panel.dataset.built = ''; fa._rgThemeSig = null; fa._rgRender(); const nameInput = panel.querySelector('[data-rg="name"]'); nameInput.value = '我的電腦'; const light0 = fa._isLightTheme; const sigBefore = fa._rgThemeSig;
  fa._rgThemeSig = 'old'; const btnBg0 = panel.querySelector('[data-rg-act="tab"]').style.background; fa._isLightTheme = () => !light0.call(fa); fa._applyThemeStyles(); const inp2 = panel.querySelector('[data-rg="name"]');
  R.rg_theme = { rebuilt: inp2 !== nameInput, kept: inp2.value, scheme: panel.style.colorScheme, sigChanged: fa._rgThemeSig !== 'old' }; fa._isLightTheme = light0; fa._rgThemeSig = null; fa._applyThemeStyles(); }
// 還原
window.fetch = realFetch; fa.advancedSettings.llmModelRows = keepRows; fa.advancedSettings.agentModels = JSON.parse(keepCfg); fa.advancedSettings.multiSubAgentMode = keepMode; if (keepCards == null) localStorage.removeItem(fa.MODEL_CARDS_KEY); else localStorage.setItem(fa.MODEL_CARDS_KEY, keepCards);
return R;
