// 壓縮工具索引（預設開）的真實 Electron 評估（假 LLM）：各模式前後提示大小、核心工具照常、路由不退步、逃生口、描述式申請、快取。
// 用法：FA_DISABLE_MAIN_OVERLAY=1 FA_DEBUG_EVAL_FILE=<本檔> FA_BROWSER_CONTROL_PORT=<非17923> electron <desktop-app> --no-sandbox --disable-gpu --user-data-dir=<全新資料夾>
const fa = window.fa; const B = FaToolBudget; const C = FaCompactIndex; const R = {};
R.loaded = { hasCompact: typeof C !== 'undefined', flagDefaultOn: (localStorage.removeItem('fa.compactToolIndex'), fa._compactIxOn()) };
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
fa._getGroundingContext = () => '[固定的環境資訊]';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => true;
const realFetch = window.fetch.bind(window); let routerPrompt = null; const routerBodies = [];
window.fetch = async (url, init) => { if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init); const body = JSON.parse(init.body); const sys = String((body.messages[0] || {}).content || ''); const mk = (m) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, m), finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); if (/工具領域路由器/.test(sys)) { routerPrompt = sys; routerBodies.push(body); const dm = /^## ([A-Za-z0-9_]+)/m.exec(sys) || /^\[([^\]]+)\]/m.exec(sys); return mk({ content: JSON.stringify({ domains: dm ? [dm[1]] : [] }) }); } return mk({ content: 'ok' }); };
const setFlag = (v) => { if (v == null) localStorage.removeItem('fa.compactToolIndex'); else localStorage.setItem('fa.compactToolIndex', v); };
const prep = (mode, task) => { fa.advancedSettings.multiSubAgentMode = mode; fa._amMode = mode; fa._intentWiden = false; fa._intentExtra = new Set(); fa._intentMiss = new Set(); fa._intentPlanCache = null; fa._splitDirty = true; fa._compactWiden = false; fa._compactExtra = new Set(); fa._cixHiddenMemo = null; fa._currentTurnUserText = task || '把幾張圖片合成一份 PDF'; };
const snap = (mode) => { prep(mode); const names = fa._getRootToolNames() || []; const sys = fa._getFinalSystemPrompt(); const schema = JSON.stringify(fa._buildNativeToolsSchema(names)); return { rootN: names.length, sysTokens: B.estimateTokens(sys), schemaTokens: B.estimateTokens(schema), total: B.estimateTokens(sys) + B.estimateTokens(schema), noteTokens: B.estimateTokens(fa._compactRootNote()) }; };
// 1) 各模式 關／開
R.modes = {}; for (const mode of ['off', 'router', 'full', 'hierarchical', 'intent']) { setFlag('0'); const off = snap(mode); setFlag(null); const on = snap(mode); R.modes[mode] = { off, on, delta: on.total - off.total }; }
// 2) off 模式：核心／host／自訂工具照常、被收起的都在索引裡
setFlag(null); prep('off'); const ixo = fa._compactIndex(); const hid = fa._compactHidden(); const rootOn = new Set(fa._getRootToolNames()); setFlag('0'); prep('off'); const rootOff = new Set(fa._getRootToolNames()); setFlag(null);
const nonGated = Object.keys(fa.tools).filter((n) => !fa._domainGatedToolNames.has(n) && n !== 'delegate_to_subagent');
R.off_mode = { rootOff: rootOff.size, rootOn: rootOn.size, hidden: hid.size, hiddenAllInIndex: Array.from(hid).every((n) => !!ixo.tools[n]), nonGatedAllKept: nonGated.filter((n) => rootOff.has(n)).every((n) => rootOn.has(n)), coreKept: ['get_tool_details', 'request_additional_tools'].every((n) => rootOn.has(n)), customKept: fa.advancedSettings.customTools.every((t) => rootOn.has(t.name)), gatedStillVisible: Array.from(fa._domainGatedToolNames).filter((n) => rootOn.has(n) && fa.tools[n]).length };
// 3) 逃生口：放寬後 off 模式回到完整清單；模型直接叫了收起來的工具會被補進；申請後出現在清單
prep('off'); fa._compactWiden = true; const widened = new Set(fa._getRootToolNames()); widened.delete('request_additional_tools'); R.escape = { widenRestoresFull: widened.size === rootOff.size && Array.from(rootOff).every((n) => widened.has(n)) }; // 開著時多一個申請工具，其餘要跟關閉時完全相同
prep('off'); const victim = Array.from(hid)[0]; fa._toolCallLog = fa._toolCallLog || { calls: [] }; await fa._callToolGuarded(fa._toolCallLog, victim, '{}', async () => 'x'); R.escape.directCallAdmitted = !!victim && fa._compactExtra.has(victim) && fa._getRootToolNames().includes(victim);
prep('off'); const call = async (a) => JSON.parse(await fa.tools.request_additional_tools.callback.call(fa, JSON.stringify(a)));
R.req = {}; for (const q of ['把幾張圖片合成一份 PDF', '朗讀這段文字', '合併兩個 PDF', '做一份簡報', '處理檔案']) { const r = await call({ description: q }); R.req[q] = { added: r.added_tools, choice: !!r.need_choice }; }
R.req_exact = await call({ names: ['no_such_tool'] }); R.req_empty = await call({}); R.escape.requestedVisible = (R.req['合併兩個 PDF'].added || []).every((n) => fa._getRootToolNames().includes(n));
// 4) 路由不退步：關／開的路由提示，領域與工具名稱一個都不能少
const TASKS = ['把幾張圖片合成一份 PDF', '朗讀這段文字', '做一份簡報', '幫我看一下這個專案的程式結構', '畫一個 3D 場景', '轉換影片格式並加字幕', '分析一個大檔案', '搜尋網路上的資料並摘要'];
const rp = async (task) => { prep('full', task); routerPrompt = null; await fa._delegateToSubagentAuto(task); return routerPrompt || ''; };
R.routing = []; for (const task of TASKS) { setFlag('0'); const a = await rp(task); setFlag(null); const b = await rp(task);
  const keysA = Array.from(a.matchAll(/^\[([^\]]+)\]/gm)).map((m) => m[1]); const keysB = new Set(Array.from(b.matchAll(/^## ([A-Za-z0-9_]+)/gm)).map((m) => m[1]).concat(Array.from(b.matchAll(/^\[([^\]]+)\]/gm)).map((m) => m[1])));
  const toolsA = Array.from(a.matchAll(/^- ([a-z0-9_]+):/gm)).map((m) => m[1]); const toolsB = new Set(Array.from(b.matchAll(/^- ([a-z0-9_]+):/gm)).map((m) => m[1]));
  R.routing.push({ task, offTokens: B.estimateTokens(a), onTokens: B.estimateTokens(b), domainsOff: keysA.length, domainsMissing: keysA.filter((k) => !keysB.has(k)), toolsOff: toolsA.length, toolsMissing: toolsA.filter((n) => !toolsB.has(n)).length }); }
// 5) 索引與快取
const t0 = performance.now(); const ix = fa._compactIndex(); R.index = { tools: Object.keys(ix.tools).length, domains: Object.keys(ix.domains).length, recomputed: ix.recomputed, reused: ix.reused, ms: Math.round(performance.now() - t0) };
const l0 = C.text(ix, { level: 0 }); R.text0 = { chars: l0.chars, tokens: B.estimateTokens(l0.text), budgetChars: fa._compactBudgetChars() }; R.cacheSaved = (localStorage.getItem('fa.compactIndexCache') || '').length;
R.siteWords = /台股|twse|stock/i.test(String(C.build) + String(C.select) + String(C.text));
// 6) 路由子代理：認識所有工具、常駐（不重建）、無記憶（只有這一題）、不限制提問長短；如實量延遲與輸入
setFlag(null); prep('full'); fa._routerResident = null; fa._routerStats = { builds: 0, hits: 0 };
const QS = ['pdf', '把幾張圖片合成一份 PDF', '朗讀這段文字然後轉成字幕再做成簡報', 'merge some pdf files and then read them aloud', '請幫我' + '把一份很長很長的需求做完，內容包含：圖片、語音、簡報、3D、動畫、網頁搜尋。'.repeat(150), '{"need":"x"}', '   ', 'a'.repeat(30000)];
const rt = []; const lat = []; routerBodies.length = 0;
for (const q of QS) { const t = performance.now(); const r = await fa._routeTaskToDomains(q); lat.push(Math.round((performance.now() - t) * 10) / 10); rt.push({ len: q.length, ok: !!r.ok }); }
const sysSame = routerBodies.every((b) => b.messages[0].content === routerBodies[0].messages[0].content);
R.router = { n: QS.length, allOk: rt.every((x) => x.ok), asked: routerBodies.length, builds: fa._routerStats.builds, hits: fa._routerStats.hits, systemIdentical: sysSame, messagesPerCall: Array.from(new Set(routerBodies.map((b) => b.messages.length))), userEqualsQuestion: routerBodies.every((b, i) => b.messages[1].content === QS[i]), noTruncation: routerBodies[routerBodies.length - 1].messages[1].content.length === 30000, temp0: routerBodies.every((b) => b.temperature === 0), stream: routerBodies.some((b) => b.stream), systemTokens: B.estimateTokens(routerBodies[0].messages[0].content), localMsEach: lat };
// 無狀態：A、B、A 再問一次，A 的請求逐位元組相同
routerBodies.length = 0; await fa._routeTaskToDomains('朗讀這段文字'); await fa._routeTaskToDomains('做一份簡報'); await fa._routeTaskToDomains('朗讀這段文字'); R.router.noResidue = JSON.stringify(routerBodies[0]) === JSON.stringify(routerBodies[2]);
// 工具集沒變：不重做壓縮；工具變多：只重做一次、只重算新增的那一個
const ixA = fa._compactIndex({ all: true }); R.router.recomputedWhenSame = ixA.recomputed; const b0 = fa._routerStats.builds;
const domKey = Object.keys(fa.domains).find((k) => fa.domains[k].enabled && !fa.domains[k].internal && Array.isArray(fa.domains[k].toolNames)); fa.register_openai_tool('zz_probe_tool', '探針工具：只用來測試工具變多時的快取更新。', async () => '{}', { type: 'object', properties: {} }); fa.domains[domKey].toolNames.push('zz_probe_tool'); fa._cixHiddenMemo = null;
const ixB = fa._compactIndex({ all: true }); await fa._routeTaskToDomains('朗讀這段文字'); await fa._routeTaskToDomains('朗讀這段文字');
R.router.grow = { recomputed: ixB.recomputed, setHashChanged: ixB.setHash !== ixA.setHash, rebuilds: fa._routerStats.builds - b0, inPrompt: routerBodies[routerBodies.length - 1].messages[0].content.indexOf('zz_probe_tool') >= 0 };
fa.domains[domKey].toolNames.pop(); delete fa.tools.zz_probe_tool;
// 還原
setFlag(null); localStorage.removeItem('fa.compactIndexCache'); window.fetch = realFetch;
return R;
