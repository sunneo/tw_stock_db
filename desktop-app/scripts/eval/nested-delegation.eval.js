// 巢狀委派（領域／技能請另一個領域／技能的子agent幫忙）的端到端檢查：用假的 LLM 端點（不打真的模型），在真實 Electron 裡跑。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/nested-delegation.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
// 預期：A 有 delegate_subtask、被它委派的 B 沒有（深度上限）；B 的結果回到 A；委派給自己會被擋；領域顯示名稱也能當 domain。
const fa = window.fa; const R = { reqs: [] };
fa.register_domain('test_a', { label: '甲領域', toolNames: [], systemPrompt: '你是甲。AAA' });
fa.register_domain('test_b', { label: '乙領域', toolNames: [], systemPrompt: '你是乙。BBB' });
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
let scenario = 'ok';
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body); const sys = String((body.messages[0] || {}).content || '');
  const who = /AAA/.test(sys) ? 'A' : (/BBB/.test(sys) ? 'B' : '?');
  const toolNames = (body.tools || []).map((t) => t.function && t.function.name);
  const hasToolMsg = body.messages.some((m) => m.role === 'tool');
  R.reqs.push({ who, tools: toolNames.filter((n) => /delegate_subtask|request_additional/.test(n)), hasToolMsg, sysHasCatalog: /可選（domain/.test(sys) ? (sys.match(/可選（domain[^）]*）：([^。]*)。/) || [])[1] : null });
  const mk = (msg) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, msg), finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (who === 'A' && !hasToolMsg) {
    const args = scenario === 'self' ? { task: 'x', domain: 'test_a' } : (scenario === 'label' ? { task: '請給我一個關鍵字', domain: '乙領域' } : { task: '請給我一個關鍵字', domain: 'test_b' });
    return mk({ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'delegate_subtask', arguments: JSON.stringify(args) } }] });
  }
  if (who === 'B') return mk({ content: 'B的結果：KEYWORD-42' });
  const last = body.messages.filter((m) => m.role === 'tool').pop();
  return mk({ content: 'A最後整理：' + String(last && last.content).slice(0, 300) });
};
const r1 = await fa._delegateToSubagentDomain('test_a', '做一件需要乙的事'); R.ok = { ok: r1.ok, result: String(r1.result || r1.error).slice(0, 400) };
scenario = 'self'; R.reqs.push('---self');
const r2 = await fa._delegateToSubagentDomain('test_a', '亂來'); R.self = { ok: r2.ok, result: String(r2.result || r2.error).slice(0, 500) };
scenario = 'label'; R.reqs.push('---label'); const r3 = await fa._delegateToSubagentDomain('test_a', '用名稱委派'); R.label = { ok: r3.ok, result: String(r3.result || r3.error).slice(0, 200) };
window.fetch = realFetch;
return R;
