// 壓縮工具索引（真實 Electron、假 LLM）：開關關閉時提示與工具清單不變；開啟後索引大小、快取、描述式申請、路由目錄大小。
// 用法：FA_DISABLE_MAIN_OVERLAY=1 FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_BROWSER_CONTROL_PORT=<非17923的埠> electron <desktop-app> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
const fa = window.fa; const B = FaToolBudget; const R = {};
R.loaded = { hasCompact: typeof FaCompactIndex !== 'undefined', mode: fa.multiSubAgentMode };
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => true;
const snap = () => { const names = fa._getRootToolNames() || []; const sys = fa._getFinalSystemPrompt(); const schema = fa._buildNativeToolsSchema(names); return { on: fa._compactIxOn(), hasReq: !!fa.tools.request_additional_tools, noteLen: fa._compactRootNote().length, rootN: names.length, rootHash: FaCompactIndex.hash(names.join('|')), sysChars: sys.length, sysHash: FaCompactIndex.hash(sys), sysTokens: B.estimateTokens(sys), schemaTokens: B.estimateTokens(JSON.stringify(schema)) }; };
const realFetch = window.fetch.bind(window); let routerPrompt = null;
window.fetch = async (url, init) => { if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init); const body = JSON.parse(init.body); const sys = String((body.messages[0] || {}).content || ''); const mk = (m) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, m), finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); if (/工具領域路由器/.test(sys)) { routerPrompt = sys; return mk({ content: JSON.stringify({ domains: [] }) }); } return mk({ content: 'ok' }); };
const routerSize = async () => { routerPrompt = null; await fa._delegateToSubagentAuto('把這幾張照片合併成一個pdf'); return routerPrompt ? { chars: routerPrompt.length, tokens: B.estimateTokens(routerPrompt) } : null; };
// 1) 關閉（預設）
localStorage.removeItem('fa.compactToolIndex'); R.off = snap(); R.off.router = await routerSize();
// 2) 開啟：註冊根層級工具後量
localStorage.setItem('fa.compactToolIndex', '1'); fa._cixCache = null; { const gated = new Set(fa._domainGatedToolNames); fa._registerBuiltinAiTools(); fa._domainGatedToolNames = gated; } // 重新註冊會重設領域閘門：還原，不然量到的根層級工具數是假的
R.on = snap(); R.on.router = await routerSize();
const t0 = performance.now(); const ix = fa._compactIndex(); R.index = { tools: Object.keys(ix.tools).length, domains: Object.keys(ix.domains).length, recomputed: ix.recomputed, reused: ix.reused, ms: Math.round(performance.now() - t0) };
const t1 = performance.now(); const ix2 = fa._compactIndex(); R.index2 = { recomputed: ix2.recomputed, reused: ix2.reused, sameSet: ix2.setHash === ix.setHash, ms: Math.round(performance.now() - t1) };
const full = FaCompactIndex.text(ix); const l0 = FaCompactIndex.text(ix, { level: 0 }); R.text0 = { chars: l0.chars, tokens: B.estimateTokens(l0.text) };
R.text = { level1Chars: full.chars, level1Tokens: B.estimateTokens(full.text), budgetChars: fa._compactBudgetChars(), level: FaCompactIndex.text(ix, { budgetChars: fa._compactBudgetChars() }).level };
R.cacheSaved = (localStorage.getItem('fa.compactIndexCache') || '').length;
// 3) 描述式申請
const call = async (a) => JSON.parse(await fa.tools.request_additional_tools.callback.call(fa, JSON.stringify(a)));
R.req = {}; for (const q of ['把幾張圖片合成一份 PDF', '朗讀這段文字', '合併兩個 PDF', '做一份簡報']) { const r = await call({ description: q }); R.req[q] = { added: r.added_tools, choice: !!r.need_choice, note: r.note }; }
R.req_exact = await call({ names: ['images_to_pdf', 'no_such_tool'] }); R.req_empty = await call({});
const ch = await call({ description: '處理檔案' }); R.req_vague = { choice: !!ch.need_choice, q: ch.question && ch.question.slice(0, 80) };
R.rootAfter = (fa._getRootToolNames() || []).length;
// 4) 還原
localStorage.removeItem('fa.compactToolIndex'); localStorage.removeItem('fa.compactIndexCache'); window.fetch = realFetch;
return R;
