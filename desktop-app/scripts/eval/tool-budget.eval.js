// 工具預算與領域切割（真實 Electron、假 LLM）：短說明＋精簡參數的原則、預算報告、coding／prog_* 變成協調者＋階段子領域、協調者交辦給階段子 agent（只拿自己那一組工具）、
// 路由先檢索（提示大小固定）、第一次呼叫失敗時附完整說明。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/tool-budget.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const B = FaToolBudget; const R = {};
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; } // 離線橋接層啟動時存了一份原始 fetch；設成 null 它就改用目前的 window.fetch（這裡的假 LLM）
// 1) 預算報告
const rep = fa._toolBudgetReport(); R.report = { ok: rep.ok, violations: rep.violations.map((v) => v.kind + ':' + v.key), tokens: rep.tokens, split: rep.split && { mixers: rep.split.mixers.length, groups: rep.split.groups, skipped: rep.split.skipped.map((x) => x.key + '(' + x.reason + ')') } };
// 2) 切割後的領域
const dom = (k) => fa.domains[k]; const info = (k) => { const d = dom(k); return d ? { own: fa._resolveOwnDomainToolNames(d).length, union: fa._resolveDomainToolNames(d).length, mixer: !!d.mixer, children: d.mixer ? d.mixer.children.map((c) => c.domain + ':' + c.tools.length) : null } : null; };
R.coding = info('coding'); R.prog_bmc = info('prog_bmc'); R.prog_graphics = info('prog_graphics'); R.ph_repo = dom('ph_repo') && { internal: dom('ph_repo').internal, tools: dom('ph_repo').toolNames.length };
R.maxOwn = Math.max(...Object.entries(fa.domains).filter(([, d]) => d.enabled && !d.internal).map(([k, d]) => fa._resolveRunToolNames(d).length));
R.public_domains = Object.entries(fa.domains).filter(([, d]) => d.enabled && !d.internal).length; R.internal_domains = Object.entries(fa.domains).filter(([, d]) => d.internal).length;
R.delegate_desc_lists_internal = /ph_repo|ph_files/.test(fa._buildDelegateToSubagentDescription());
// 3) 假 LLM：prog_bmc 協調者 → 交辦 ph_repo → 子 agent 交接單
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => true;
const realFetch = window.fetch.bind(window); const seen = []; let routerPrompt = null;
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body); const sys = String((body.messages[0] || {}).content || ''); const names = (body.tools || []).map((t) => t.function.name);
  const mk = (msg) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, msg), finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/工具領域路由器/.test(sys)) { routerPrompt = sys; return mk({ content: JSON.stringify({ domains: ['prog_bmc'] }) }); }
  const isMixer = /你是「.*」的協調者/.test(sys), isPhase = /階段的子 agent/.test(sys); const rec = { role: isMixer ? 'mixer' : (isPhase ? 'phase' : 'other'), n_tools: names.length, tools: names.slice(0, 14), hasDelegate: names.includes('delegate_subtask'), hasRequestMore: names.includes('request_additional_tools'), hasDetails: names.includes('get_tool_details'), delegateEnum: (((body.tools || []).find((t) => t.function.name === 'delegate_subtask') || {}).function || {}).parameters };
  const calledTool = body.messages.some((m) => m.role === 'tool'); seen.push(rec);
  if (isMixer && !calledTool) return mk({ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'delegate_subtask', arguments: JSON.stringify({ domain: 'ph_repo', task: '看一下 repo 的結構' }) } }] });
  if (isPhase) return mk({ content: '【階段】understand\n【已完成】看過了\n【產出】無\n【未解決】無\n【建議下一步】實作' });
  return mk({ content: '協調完成：' + (calledTool ? '收到交接單' : '') });
};
const r = await fa._delegateToSubagentDomain('prog_bmc', '幫我看一下這個 BMC 專案的結構'); R.mixer_result = String(r.result || r.error).slice(0, 120);
R.runs = seen.map((x) => ({ role: x.role, n_tools: x.n_tools, hasDelegate: x.hasDelegate, hasRequestMore: x.hasRequestMore, hasDetails: x.hasDetails, tools: x.tools.join(','), enumOk: x.delegateEnum && x.delegateEnum.properties && x.delegateEnum.properties.domain && x.delegateEnum.properties.domain.enum ? x.delegateEnum.properties.domain.enum.length : null }));
// 4) 路由先檢索：自動路由（沒指定 domain）時，路由器提示的大小
seen.length = 0; routerPrompt = null; await fa._delegateToSubagentAuto('把這幾張照片合併成一個pdf'); R.router = routerPrompt ? { chars: routerPrompt.length, tokens: B.estimateTokens(routerPrompt), sections: (routerPrompt.match(/^\[[a-z0-9_-]+\]/gm) || []).length, mentionsInternal: /\[ph_/.test(routerPrompt) } : 'no router call';
window.fetch = realFetch;
// 5) 第一次呼叫失敗時附完整說明
const log = { calls: [] }; const res1 = await fa._callToolGuarded(log, 'images_to_pdf', '{"files":["nope.png"]}', async () => await fa.tools.images_to_pdf.callback.call(fa, '{"files":["nope.png"]}'));
const o1 = JSON.parse(res1); const res2 = await fa._callToolGuarded(log, 'images_to_pdf', '{"files":["nope2.png"]}', async () => await fa.tools.images_to_pdf.callback.call(fa, '{"files":["nope2.png"]}')); const o2 = JSON.parse(res2);
R.first_error = { ok: o1.ok, has_usage: !!o1.usage, usage_len: o1.usage ? String(o1.usage.description).length : 0, second_has_usage: !!o2.usage };
const det = JSON.parse(await fa.tools.get_tool_details.callback.call(fa, '{"names":["images_to_pdf"]}')); R.details = { has_desc: String(det.tools.images_to_pdf.description).length, has_params: !!det.tools.images_to_pdf.parameters };
const sch = fa._buildNativeToolsSchema(['images_to_pdf'])[0].function; R.native_schema = { desc: sch.description, tokens: B.estimateTokens(JSON.stringify(sch)) };
return R;
