// 聚焦（真實 Electron、假 LLM）：大領域（30 個工具）只給任務最相關的 ≤16 個，需要更多時用 request_additional_tools 在本地補（不問任何模型）；
// 任務跟工具沒有共同詞時不聚焦（給全部）；小領域不受影響。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/tool-focus.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {};
const topics = ['invoice', 'payroll', 'shipping', 'inventory', 'refund', 'tax', 'audit', 'vendor', 'budget', 'contract'];
const names = []; topics.forEach((t) => ['lookup', 'create', 'cancel'].forEach((v) => { const n = `biz_${t}_${v}`; names.push(n); fa.register_openai_tool(n, { description: `${v} a ${t} record in the company ${t} system. Long details about ${t} handling follow here.`, parametersSchema: { type: 'object', properties: { id: { type: 'string' } } }, callback: async () => JSON.stringify({ ok: true, tool: n }) }); }));
fa.register_domain('biz_big', { label: '商務大領域', toolNames: names, systemPrompt: '你是商務助手。' });
fa.register_domain('biz_small', { label: '商務小領域', toolNames: names.slice(0, 5), systemPrompt: '你是小助手。' });
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => true;
const realFetch = window.fetch.bind(window); let seen = []; let routerCalls = 0; let scenario = 'expand';
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body); const sys = String((body.messages[0] || {}).content || ''); const tnames = (body.tools || []).map((t) => t.function.name);
  const mk = (msg) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, msg), finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/工具領域路由器/.test(sys)) { routerCalls++; return mk({ content: JSON.stringify({ domains: [] }) }); }
  const called = body.messages.filter((m) => m.role === 'tool').length; seen.push({ n: tnames.length, tools: tnames, hasMore: tnames.includes('request_additional_tools'), called });
  if (scenario === 'expand' && called === 0) return mk({ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'request_additional_tools', arguments: JSON.stringify({ need: 'I need to cancel a vendor record' }) } }] });
  return mk({ content: '完成' });
};
const sum = () => ({ rounds: seen.length, first: seen[0] && seen[0].n, firstBiz: seen[0] && seen[0].tools.filter((n) => /^biz_/.test(n)).length, last: seen[seen.length - 1] && seen[seen.length - 1].n, lastHasVendorCancel: seen[seen.length - 1] && seen[seen.length - 1].tools.includes('biz_vendor_cancel'), firstHasInvoice: seen[0] && seen[0].tools.includes('biz_invoice_lookup'), hasMore: seen[0] && seen[0].hasMore, routerCalls });
// 1) 聚焦＋本地補工具
seen = []; routerCalls = 0; await fa._delegateToSubagentDomain('biz_big', 'please look up the invoice and create an invoice record'); R.focus_expand = sum();
// 2) 任務跟工具沒有共同詞：不聚焦
scenario = 'plain'; seen = []; routerCalls = 0; await fa._delegateToSubagentDomain('biz_big', '幫我整理一下心情'); R.no_overlap = sum();
// 3) 小領域不聚焦
seen = []; routerCalls = 0; await fa._delegateToSubagentDomain('biz_small', 'look up invoice'); R.small = sum();
// 4) 關掉聚焦
fa.advancedSettings.toolFocus = false; seen = []; await fa._delegateToSubagentDomain('biz_big', 'look up the invoice'); R.focus_off = sum();
window.fetch = realFetch; return R;
