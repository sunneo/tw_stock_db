// 根層級意圖判斷交給路由子代理（真實 Electron；路由模型是「模擬」的假回覆——沒有真模型可用，這裡驗的是機制：提示內容、驗證、執行、常駐、無記憶、關閉時不呼叫）。
// 用法同 compact-tool-index.eval.js。
const fa = window.fa; const R = {};
const SENT = 'https://www.aiposthub.com/nemotron-parse-open-datasets-document-adaptation-recipe/ 這篇在說什麼';
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
fa._getGroundingContext = () => '[固定]';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 }); fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => true;
const realFetch = window.fetch.bind(window); const bodies = []; let reply = '{"tools":["fetch_web_page"],"domains":[],"reason":"使用者要知道這個網址的文章在說什麼：抓網頁內容是最少的做法"}';
window.fetch = async (url, init) => { if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init); const b = JSON.parse(init.body); bodies.push(b); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
const setFlag = (v) => { if (v == null) localStorage.removeItem('fa.compactToolIndex'); else localStorage.setItem('fa.compactToolIndex', v); };
const turn = async (flag, text, mode) => { setFlag(flag); fa.advancedSettings.multiSubAgentMode = mode || 'full'; fa._amMode = mode || 'full'; fa._currentTurnUserText = text; fa._compactWiden = false; fa._compactExtra = new Set(); fa._cixHiddenMemo = null; fa._compactRoute = null; fa._intentPlanCache = null; fa.messages = [{ role: 'system', content: 'x' }, { role: 'user', content: text }]; bodies.length = 0;
  await fa._compactRootRoute(text); const names = fa._getRootToolNames() || []; const sys = fa._getFinalSystemPrompt(); const first = bodies[0];
  return { flag: flag === null ? '(預設開)' : flag, routerCalls: bodies.length, routerSystemChars: first ? first.messages[0].content.length : 0, routerSawFetchLine: first ? /- fetch_web_page:/.test(first.messages[0].content) : null, routerMessages: first ? first.messages.length : 0, routerUserIsSentence: first ? first.messages[1].content === text : null, route: fa._compactRoute && { tools: fa._compactRoute.tools, domains: fa._compactRoute.domains, reason: fa._compactRoute.reason, source: fa._compactRoute.source }, rootHasFetch: names.includes('fetch_web_page'), rootN: names.length, rootNames: names, noteInPrompt: /路由建議/.test(sys), noteText: (/【路由建議[^\n]*/.exec(sys) || [''])[0].slice(0, 220) }; };
fa._routeRootResident = null; fa._routerStats = { builds: 0, hits: 0 };
R.on = await turn(null, SENT); R.off = await turn('0', SENT);
// 常駐與無記憶：連問三句（含很短與很長），系統提示相同、每次只有兩則訊息、使用者那則就是原話
fa._routerStats = { builds: 0, hits: 0 }; fa._routeRootResident = null; const seen = []; for (const q of ['hi', SENT, '請幫我' + '把一份很長的需求做完：圖片、語音、簡報、3D、動畫、網頁搜尋。'.repeat(200)]) { await turn(null, q); seen.push({ len: q.length, msgs: bodies[0].messages.length, userExact: bodies[0].messages[1].content === q, sysChars: bodies[0].messages[0].content.length }); }
R.resident = { seen, stats: { rootBuilds: fa._routerStats.rootBuilds, rootHits: fa._routerStats.rootHits }, sysSame: new Set(seen.map((x) => x.sysChars)).size === 1 };
// 路由答不出來／亂答：不猜
reply = '這不是 JSON'; R.garbage = await turn(null, SENT); reply = '{"tools":["no_such_tool","fetch_web_page_pro"],"domains":["nope"],"reason":"x"}'; R.invented = await turn(null, '你好'); reply = '{"tools":[],"domains":[],"reason":"打招呼"}'; R.none = await turn(null, '你好');
// 斜線指令不問路由
bodies.length = 0; setFlag(null); await fa._compactRootRoute('/help'); R.slash = { routerCalls: bodies.length };
window.fetch = realFetch; setFlag(null);
return R;
