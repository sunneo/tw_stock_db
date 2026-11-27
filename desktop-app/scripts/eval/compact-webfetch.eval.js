// 「這篇網址在說什麼」出錯的根因查證（真實 Electron；沒有真模型，提示與工具清單是真的，模型回覆用使用者記錄檔裡的原文）。
// 用法同 compact-tool-index.eval.js。印出：根層級工具清單、索引區塊、delegate_to_subagent 的說明與領域清單、fetch_web_page 在哪個領域、逃生口的判斷、專用工具提示的判斷；關／開各一次。
const fa = window.fa; const R = {};
const SENT = 'https://www.aiposthub.com/nemotron-parse-open-datasets-document-adaptation-recipe/ 這篇在說什麼';
const MODEL_REPLY = '我目前沒有直接瀏覽外部網頁的工具，無法即時抓取該網頁內容。不過從網址結構可以推斷，這篇文章應該是關於 NVIDIA Nemotron 模型的文件解析。';
const DELEGATED_TASK = '請抓取以下網頁的完整內容，並用繁體中文總結這篇文章在說什麼：https://www.aiposthub.com/nemotron-parse-open-datasets-document-adaptation-recipe/\n請保留使用者原始語言（繁體中文），不要翻譯成其他語言，也不要改寫使用者的字句。';
fa._getGroundingContext = () => '[固定]';
const setFlag = (v) => { if (v == null) localStorage.removeItem('fa.compactToolIndex'); else localStorage.setItem('fa.compactToolIndex', v); };
const hintIds = (t) => (typeof _faTaskToolHints === 'function' ? _faTaskToolHints(t) : []).map((h) => h.id);
const where = (name) => Object.entries(fa.domains).filter(([, d]) => d.enabled && !d.internal && (() => { try { return fa._resolveRunToolNames(d).includes(name); } catch (_) { return false; } })()).map(([k]) => k);
const run = (flag) => {
  setFlag(flag); fa.advancedSettings.multiSubAgentMode = 'full'; fa._amMode = 'full'; fa._compactWiden = false; fa._compactExtra = new Set(); fa._cixHiddenMemo = null; fa._intentPlanCache = null;
  fa.messages = [{ role: 'system', content: 'x' }, { role: 'user', content: SENT }]; fa._currentTurnUserText = SENT; fa._toolCallLog = { calls: [] }; fa._intentGuard = { count: 0 };
  const names = fa._getRootToolNames() || []; const sys = fa._getFinalSystemPrompt(); const del = fa._buildDelegateToSubagentDescription ? fa._buildDelegateToSubagentDescription() : '';
  const note = fa._compactRootNote(); const m = /^- (?:web|net)[^\n]*$/gim.exec(note) || [];
  return { flag: flag === null ? '(預設)' : flag, rootNames: names, hasFetchAtRoot: names.includes('fetch_web_page'), taskHintsRoot: hintIds(SENT), noteHasFetch: /fetch_web_page/.test(note), noteChars: note.length, noteWebLines: (note.match(/^.*(網路|瀏覽器|網頁).*$/gm) || []).slice(0, 4), sysChars: sys.length, delegateChars: del.length, delegateMentionsFetch: /fetch_web_page/.test(del), delegateMusicLine: (del.match(/^.*music.*$/gm) || []).slice(0, 2).map((x) => x.slice(0, 200)), delegateWebLines: (del.match(/^.*(網路|瀏覽器|fetch_web_page).*$/gm) || []).slice(0, 3).map((x) => x.slice(0, 200)) };
};
R.fetchDomains = where('fetch_web_page'); R.fetchExists = !!fa.tools.fetch_web_page; R.music = { tools: (() => { try { return fa._resolveRunToolNames(fa.domains.music).slice(0, 12); } catch (_) { return null; } })(), label: fa.domains.music && fa.domains.music.label };
R.on = run(null); R.off = run('0'); setFlag(null);
// 逃生口：模型這句話是不是被認成「說沒有工具」
const claim = FaCapReflect.claimsNoTool(MODEL_REPLY); R.claim = claim;
fa.messages = [{ role: 'system', content: 'x' }, { role: 'user', content: SENT }]; fa._currentTurnUserText = SENT; fa._toolCallLog = { calls: [] }; fa._intentGuard = { count: 0 }; fa._forceNoTools = false;
R.nudge = { forceNoTools: !!fa._forceNoTools, result: (fa._noToolClaimNudge(MODEL_REPLY, fa._intentGuard) || '').split('\n').filter((l) => /^\d+\. |domain 填|直接呼叫/.test(l)).map((l) => l.slice(0, 150)) };
// 專用工具提示：委派任務文字（含「不要翻譯成其他語言」）
R.hints = { userSentence: hintIds(SENT), delegatedTask: hintIds(DELEGATED_TASK), delegatedTaskNoNegation: hintIds(DELEGATED_TASK.replace('，不要翻譯成其他語言，也不要改寫使用者的字句', '')) };
// 路由：用同一個任務問路由子代理（假回覆；只看它「看到」什麼）
let seen = null; const realFetch = window.fetch.bind(window); if (typeof FaLlm !== 'undefined') FaLlm.realFetch = null;
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 }); fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
window.fetch = async (url, init) => { if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init); const b = JSON.parse(init.body); seen = b; return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ domains: [] }) }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
setFlag(null); fa._routerResident = null; await fa._routeTaskToDomains(DELEGATED_TASK); const sys2 = seen ? String(seen.messages[0].content) : '';
R.route = { sysChars: sys2.length, sawFetch: /fetch_web_page/.test(sys2), fetchLines: (sys2.match(/^.*fetch_web_page.*$/gm) || []).slice(0, 3).map((x) => x.slice(0, 160)), userMsg: seen && String(seen.messages[1].content).slice(0, 80) };
window.fetch = realFetch; setFlag(null);
return R;
