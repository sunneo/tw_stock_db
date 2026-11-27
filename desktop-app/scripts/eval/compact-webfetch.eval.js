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
// 使用者另外三份記錄的重現
// (1) 選擇題字母要穩定：同一個 description＋names 連呼兩次（第二次帶 choice:'C'），C 必得同一個工具；中間有工具進清單也不變
setFlag(null); fa.advancedSettings.multiSubAgentMode = 'full'; fa._amMode = 'full'; fa._compactExtra = new Set(); fa._cixChoice = null;
const req = async (a) => JSON.parse(await fa.tools.request_additional_tools.callback.call(fa, JSON.stringify(a)));
const D1 = '需要瀏覽器控制工具來開啟並讀取指定網頁內容'; const q1 = await req({ description: D1, names: ['browser_control'] });
const letterC = q1.question && (/C\. ([a-z0-9_]+)/.exec(q1.question) || [])[1]; fa._compactExtra.add('browser_scroll'); // 中間清單變了
const q2 = await req({ description: D1, names: ['browser_control'], choice: 'C' });
R.letters = { firstQuestion: q1.question, needChoice: !!q1.need_choice, didYouMean: q1.did_you_mean, C_first: letterC, added_second: q2.added_tools, stable: !!letterC && Array.isArray(q2.added_tools) && q2.added_tools.length === 1 && q2.added_tools[0] === letterC };
// (2) 編出來的工具名：get_tool_details 給最接近的真工具
const gd = JSON.parse(await fa.tools.get_tool_details.callback.call(fa, JSON.stringify({ names: ['browser_control', 'code_execution'] }))); R.hallucinated = { notFound: gd.notFound, did_you_mean: gd.did_you_mean, next: !!gd.next };
setFlag('0'); const gd0 = JSON.parse(await fa.tools.get_tool_details.callback.call(fa, JSON.stringify({ names: ['browser_control'] }))); R.hallucinated.flagOffKeys = Object.keys(gd0).sort(); setFlag(null);
// (3) 讀網址任務的判斷（四份記錄裡的委派任務＋應該排除的）
const RT = { read1: DELEGATED_TASK, read2: '請抓取並閱讀以下網頁內容：https://www.aiposthub.com/x/\n\n請用繁體中文總結這篇文章在說什麼', read3: '請擷取 https://www.aiposthub.com/x/ 這篇文章的完整內容，並用繁體中文詳細總結', bare: 'https://www.aiposthub.com/x/', op1: '開啟 https://example.com 並點擊登入按鈕', op2: '對 https://example.com 截圖', yt: '總結 https://www.youtube.com/watch?v=abc', nourl: '這篇文章在說什麼' };
R.readUrlTask = Object.fromEntries(Object.entries(RT).map(([k, v]) => [k, !!fa._readUrlTask(v)]));
// (4) 委派到 browser_control／research／music：讀網址的任務，系統先讀（這裡把讀網址換成假的，量本地開銷），子agent拿到全文，不開瀏覽器
const calls = []; let brief = 0; fa._deckUrlBrief = async () => { brief++; return { title: '測試文章', text: '這是預先讀好的文章全文。'.repeat(50) }; };
window.fetch = async (url, init) => { if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init); const b = JSON.parse(init.body); calls.push({ sys: String(b.messages[0].content), user: String(b.messages[b.messages.length - 1].content), tools: (b.tools || []).map((t) => t.function.name) }); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的，總結如下。' }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
fa._shouldUseNativeToolCalls = () => true; R.delegate = {};
for (const dom of ['browser_control', 'research', 'music']) { calls.length = 0; brief = 0; const t = performance.now(); let r; try { r = await fa._delegateToSubagentDomain(dom, DELEGATED_TASK); } catch (e) { r = { error: String(e) }; } const first = calls[0] || {}; R.delegate[dom] = { ms: Math.round(performance.now() - t), briefCalls: brief, rounds: calls.length, taskHasBrief: /系統已讀好這個網址/.test(first.user + first.sys), hasFetchTool: (first.tools || []).includes('fetch_web_page'), openedBrowserTools: (first.tools || []).filter((n) => /^browser_(create_tab|get_page_structure)$/.test(n)), result: String((r && (r.result || r.error)) || '').slice(0, 40) }; }
window.fetch = realFetch; setFlag(null);
return R;
