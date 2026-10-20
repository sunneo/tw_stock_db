// AI 開了瀏覽器分頁、做完事情後有沒有通知擴充功能把分頁關掉（turn_end）。假 LLM、假的瀏覽器擴充功能（記下每個指令）、真實 Electron。
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
const fa = window.fa; const R = {}; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => true; fa._ensureNativeToolSupportProbed = async () => true;
const cmds = []; fa._bcTransport = null; const origBc = fa._bcCall.bind(fa);
let turnEndFails = 0; const logs = []; const origLog = fa._log.bind(fa); fa._log = (m) => { logs.push(String(m)); return origLog(m); };
fa._bcCall = async function (cmd, args, t) { if (cmd !== 'ping' && cmd !== 'turn_end') this._bcUsedThisTurn = true; cmds.push(cmd); if (cmd === 'turn_end') { if (turnEndFails > 0) { turnEndFails--; return { ok: false, error: 'TIMEOUT', note: '擴充功能沒有回應' }; } return { ok: true, closed: 1, kept: 0 }; } return { ok: true, tab_id: 7, tabId: 7, url: 'https://example.com', title: 'x', text: 'hi' }; };
const realFetch = window.fetch.bind(window); let scenario = 'direct', n = 0;
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body), toolMsgs = body.messages.filter((m) => m.role === 'tool'), k = toolMsgs.length; n++;
  const mk = (msg) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, msg), finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const call = (name, args) => mk({ tool_calls: [{ id: 'c' + (n), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (n > 12) return mk({ content: '[eval stop]' });
  const names = (body.tools || []).map((t) => t.function.name), hasBc = names.indexOf('browser_create_tab') >= 0;
  if (scenario === 'direct' || scenario === 'flaky' || scenario === 'dead') return k === 0 ? call('browser_create_tab', { url: 'https://example.com' }) : mk({ content: '開好了' });
  if (scenario === 'sub') { (R.reqs = R.reqs || []).push({ k, hasBc, n: names.length, sys: String((body.messages[0] || {}).content).slice(0, 60), first: names.slice(0, 6), lastTool: toolMsgs.length ? String(toolMsgs[toolMsgs.length - 1].content).slice(0, 160) : null }); }
  if (scenario === 'sub') { // 根對話委派給瀏覽器領域子 agent；子 agent 開分頁
    if (hasBc) return k === 0 ? call('browser_create_tab', { url: 'https://example.com' }) : mk({ content: '子任務完成' });
    return k === 0 ? call('delegate_to_subagent', { domain: 'browser_control', task: '開 example.com 看一下標題' }) : mk({ content: '做完了' });
  }
  if (scenario === 'active') return k === 0 ? call('browser_create_tab', { url: 'https://example.com', active: true }) : mk({ content: '開好了' });
  return mk({ content: '好' });
};
fa._checkTopicTransition = async () => {};
const run = async (name, text, pre) => { scenario = name; n = 0; cmds.length = 0; fa.messages = []; if (pre) pre(); const t0 = Date.now(); try { await fa.executeChat(text); } catch (e) { R[name + '_err'] = String(e).slice(0, 200); } await sleep(300); R[name] = { cmds: cmds.slice(), turn_end: cmds.filter((c) => c === 'turn_end').length, create: cmds.filter((c) => c === 'tab_create').length, used_flag_after: fa._bcUsedThisTurn, ms: Date.now() - t0 }; };
await run('direct', '幫我開 example.com 的分頁看一下');
fa.domains.browser_control.enabled = true;
await run('sub', '請用瀏覽器看 example.com 的標題');
await run('active', '幫我開 example.com 的分頁看一下');
// 背景對話：AI 還在跑，使用者切到別的對話；AI 做完時，它開的分頁要照樣關
// 通知暫時失敗（擴充功能在睡、轉接不通）：會再試，最後關成功
turnEndFails = 2; await run('flaky', '幫我開 example.com 的分頁看一下'); await sleep(6500); R.flaky_attempts = cmds.filter((c) => c === 'turn_end').length; R.flaky_log = logs.filter((l) => /回合結束/.test(l)); R.flaky_ok = R.flaky_attempts === 3 && R.flaky_log.some((l) => /已關閉 1/.test(l));
// 一直失敗：試 3 次後在狀態記錄裡說明原因（不再靜默）
logs.length = 0; turnEndFails = 99; await run('dead', '幫我開 example.com 的分頁看一下'); await sleep(6500); R.dead_attempts = cmds.filter((c) => c === 'turn_end').length; R.dead_log = logs.filter((l) => /沒能通知瀏覽器/.test(l)); turnEndFails = 0;
await run('slash', '/help');
return R;
