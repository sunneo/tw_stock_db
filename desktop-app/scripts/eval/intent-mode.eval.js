// 模式5「意圖過濾」（真實 Electron、假 LLM）：根層級只送跟這句話有關的工具；模型直接叫了沒列出的工具就補進來並學起來；
// 沒有依據不過濾；說沒有工具就放寬；委派時本地挑領域（不呼叫路由模型）；裝備不足時靜默放寬、不問使用者。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/intent-mode.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {};
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
fa.advancedSettings.offlineMode = false; // 測試用的使用者資料夾可能留著離線模式，會把請求攔去離線流程
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => true; fa._ensureNativeToolSupportProbed = async () => true;
const topics = ['invoice', 'payroll', 'shipping', 'inventory', 'refund', 'tax', 'audit', 'vendor', 'budget', 'contract'];
const names = [];
for (const t of topics) for (const v of ['lookup', 'create', 'cancel']) {
  const n = `biz_${t}_${v}`; names.push(n);
  fa.register_openai_tool(n, `${v} a ${t} record in the company ${t} system. Long details about ${t} handling follow here.`, async () => JSON.stringify({ ok: true, tool: n }), { type: 'object', properties: { id: { type: 'string' } } });
}
// 每個主題一個領域（本地挑領域用）
for (const t of topics) fa.register_domain(`biz_${t}`, { label: `${t}領域`, toolNames: names.filter((n) => n.indexOf('biz_' + t + '_') === 0), systemPrompt: `你是${t}助手。` });
fa._checkTopicTransition = async () => {};
const realFetch = window.fetch.bind(window); let seen = []; let routerCalls = 0; let scenario = 'miss';
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body); const sys = String((body.messages[0] || {}).content || ''); const tnames = (body.tools || []).map((t) => t.function.name);
  const mk = (msg) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, msg), finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/工具領域路由器/.test(sys)) { routerCalls++; return mk({ content: JSON.stringify({ domains: [] }) }); }
  const called = body.messages.filter((m) => m.role === 'tool').length; seen.push({ n: tnames.length, tools: tnames, called, roster: /\[其他工具/.test(sys) });
  if (scenario === 'miss' && called === 0) return mk({ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'biz_payroll_create', arguments: '{}' } }] });
  return mk({ content: '完成' });
};
const run = async (text) => { seen = []; fa.messages = []; await Promise.race([fa.executeChat(text), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]).catch((e) => { R.err = String(e && e.message || e); }); return seen.slice(); };

// 0) 基準：其他模式不過濾
fa.advancedSettings.multiSubAgentMode = 'full'; fa._currentTurnUserText = 'look up the invoice record'; R.full_root = fa._getRootToolNames().length;

// 1) 模式5：只送相關的
fa.advancedSettings.multiSubAgentMode = 'intent';
let r1 = await run('please look up the invoice record');
R.first_round = r1[0] && { n: r1[0].n, hasInvoiceLookup: r1[0].tools.includes('biz_invoice_lookup'), hasPayrollCreate: r1[0].tools.includes('biz_payroll_create'), hasDelegate: r1[0].tools.includes('delegate_to_subagent'), hasDetails: r1[0].tools.includes('get_tool_details'), roster: r1[0].roster };
R.saved = r1[0] ? Math.round((1 - r1[0].n / R.full_root) * 100) + '%' : null;
// 2) 模型直接叫了沒列出的工具：照常執行、下一輪補進清單、記成別名
R.miss_flow = r1[1] && { n: r1[1].n, hasPayrollCreate: r1[1].tools.includes('biz_payroll_create'), rounds: r1.length };
R.alias_learned = !!(fa._capAliasStore && fa._capAliasStore.tools && fa._capAliasStore.tools['biz_payroll_create']);
// 3) 下一輪（新的一句話）：上一輪用過的工具還留著（黏著），但補進清單是每輪重算
scenario = 'plain'; let r3 = await run('please look up the invoice record again'); R.sticky = r3[0] && r3[0].tools.includes('biz_payroll_create');
// 4) 沒有任何依據：不過濾
let r4 = await run('hello there'); R.no_basis = r4[0] && r4[0].n === R.full_root;
// 5) 放寬
fa._currentTurnUserText = 'please look up the invoice record'; fa._intentWiden = true; fa._intentPlanCache = null; R.widen_all = fa._getRootToolNames().length === R.full_root; fa._intentWiden = false;
// 6) 本地挑領域：0 次路由模型呼叫
routerCalls = 0; const loc = fa._intentRouteLocal('look up the invoice record and cancel the refund'); R.local = loc && { domains: loc.domains, local: loc.local, hasInvoice: loc.toolNames.includes('biz_invoice_lookup'), hasReflectionNote: /request_additional_tools/.test(loc.systemPrompt) }; R.router_calls_for_local = routerCalls;
R.local_none = fa._intentRouteLocal('hello there') === null;
// 7) 裝備不足的判斷
R.under = [fa._intentLooksUnderEquipped({ ok: false, error: '找不到符合這個需求的額外工具' }), fa._intentLooksUnderEquipped('【未解決】缺工具 xyz'), fa._intentLooksUnderEquipped({ ok: true, result: '做完了' })];
// 8) 靜默放寬重做：第一次裝備不足 → 第二次用完整路由（路由模型被呼叫），整個過程沒有問使用者
let calls = []; const once = fa._delegateToSubagentAutoOnce; const localBefore = fa._intentRouteLocal;
fa._delegateToSubagentAutoOnce = async function (task, ctx) { calls.push(!!(ctx && ctx.intentWide)); if (!(ctx && ctx.intentWide)) { this._intentLocalUsed = true; return { ok: false, error: '找不到符合這個需求的額外工具' }; } return { ok: true, result: '好了' }; };
const rr = await fa._delegateToSubagentAuto('look up the invoice', {}); R.silent_retry = { calls, final: rr && rr.ok };
fa._delegateToSubagentAutoOnce = once;
// 9) 模式切回去：不再過濾
fa.advancedSettings.multiSubAgentMode = 'full'; fa._currentTurnUserText = 'look up the invoice record'; R.back_to_full = fa._getRootToolNames().length === R.full_root;
window.fetch = realFetch; return R;
