// 子對話 S5 步驟3（父對話的 AI 子對話工具）真實桌面版評估：假 LLM。
// 工具：chat_list_children、chat_send_to_child、chat_get_child_summary（只在目前對話有子對話時送進工具清單）。
// 檢查：
//   - 沒有子對話：送出的 tools 不含三個工具；另外記一個「工具清單校驗值」（名稱數量＋字元碼總和），用來跟改之前的基準比對（回歸：必須完全相同）
//   - 有子對話：tools 含三個工具
//   - 假模型呼叫 chat_send_to_child → 子對話多一輪（使用者訊息進子對話）、工具結果回傳 ok:true 與狀態
//   - chat_list_children／chat_get_child_summary 回傳 id、標題、狀態、摘要、最後一則助理回覆
//   - 非子對話、遠端子對話（nodeName 有值）回 ok:false 並說明原因
// 另外：載入來源（工作目錄的實作，用正規表示式接受兩種引號）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_tools_ai.eval.js 17965
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOOLS3 = ['chat_list_children', 'chat_send_to_child', 'chat_get_child_summary'];

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa.advancedSettings.topicShiftCheck = false;
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
const realConfirm = window.confirm;
window.confirm = () => true;

// 假模型：子對話（交接內文）→ 回「完成」；父對話：使用者訊息含 TOOLCALL 且還沒有工具結果 → 呼叫 chat_send_to_child；有工具結果 → 回「好的」；其餘回「收到」
let toolTarget = null;
const reqs = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const child = msgs.some((m) => m && m.role === 'system' && String(m.content || '').indexOf('從〈') >= 0);
  const names = Array.isArray(body.tools) ? body.tools.map((t) => (t.function ? t.function.name : t.name)) : [];
  reqs.push({ child, names, lastRole: (msgs[msgs.length - 1] || {}).role });
  const mk = (msg, finish) => new Response(JSON.stringify({ choices: [{ message: msg, finish_reason: finish || 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (child) return mk({ role: 'assistant', content: '完成' });
  const lastUser = msgs.filter((m) => m && m.role === 'user').slice(-1)[0];
  const hasToolResult = msgs.some((m) => m && m.role === 'tool');
  if (lastUser && String(lastUser.content).indexOf('TOOLCALL') >= 0 && !hasToolResult && toolTarget) {
    return mk({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'chat_send_to_child', arguments: JSON.stringify({ chat_id: toolTarget, message: '補充：用水彩風格' }) } }] }, 'tool_calls');
  }
  return mk({ role: 'assistant', content: hasToolResult ? '好的' : '收到' });
};

const pid = fa._chatIndex.currentId;
const kidsOf = (id) => ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId === id);
// 先清掉目前對話底下殘留的子對話，讓「沒有子對話」的情境乾淨
for (const k of kidsOf(pid)) { try { await fa._chatDelete(k.id); } catch (_) { /* */ } }
await sleep(200);
const checksum = (names) => { const s = names.slice().sort().join('|'); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000000007; return { count: names.length, hash: h }; };

fa._clearChatHistory();
// ----- 沒有子對話 -----
reqs.length = 0;
await Promise.race([fa.executeChat('你好'), sleep(60000)]);
const noKidReq = reqs.filter((r) => !r.child)[0] || { names: [] };
R.checks.noChildToolsAbsent = TOOLS3.every((n) => noKidReq.names.indexOf(n) < 0);
R.info.noChildChecksum = checksum(noKidReq.names);

// ----- 有子對話 -----
const A = await fa._chatNew(null, { parentId: pid, title: '畫貓', noActivate: true, status: 'done', summary: '畫了一張貓' });
R.info.childId = A;
reqs.length = 0;
await Promise.race([fa.executeChat('再說一次你好'), sleep(60000)]);
const kidReq = reqs.filter((r) => !r.child)[0] || { names: [] };
R.checks.withChildToolsPresent = TOOLS3.every((n) => kidReq.names.indexOf(n) >= 0);
R.info.withChildChecksum = checksum(kidReq.names);

// ----- 工具：列出子對話、取摘要 -----
const host = fa;
const callTool = async (name, args) => {
  const t = host.tools[name];
  if (!t) return { ok: false, error: '沒有這個工具' };
  const out = await t.callback.call(fa, JSON.stringify(args || {}));
  try { return JSON.parse(out); } catch (_) { return { raw: out }; }
};
const listed = await callTool('chat_list_children', {});
R.info.listed = listed;
R.checks.listChildrenHasA = !!listed && listed.ok === true && Array.isArray(listed.children) && listed.children.some((c) => c.chat_id === A && c.title === '畫貓' && c.status === 'done' && String(c.summary || '').indexOf('畫了一張貓') >= 0);
const sum0 = await callTool('chat_get_child_summary', { chat_id: A });
R.checks.summaryReturned = !!sum0 && sum0.ok === true && String(sum0.summary || '').indexOf('畫了一張貓') >= 0 && 'last_reply' in sum0;

// ----- 假模型呼叫 chat_send_to_child → 子對話多一輪 -----
const cctxBefore = await fa._chatCtxLoad(A);
const userBefore = cctxBefore.messages.filter((m) => m.role === 'user').length;
toolTarget = A;
let parentToolResult = null;
reqs.length = 0;
await Promise.race([fa.executeChat('請用工具傳給子對話 TOOLCALL'), sleep(60000)]);
const toolResMsg = fa.messages.filter((m) => m && m.role === 'tool').slice(-1)[0];
R.info.toolResMsg = toolResMsg ? String(toolResMsg.content || '').slice(0, 300) : null;
R.checks.parentGotToolResultOk = !!toolResMsg && String(toolResMsg.content || '').indexOf('"ok":true') >= 0;
await sleep(300);
for (let i = 0; i < 200; i++) { const e = fa._chatEntry(A); if (e && (e.status === 'done' || e.status === 'failed')) break; await sleep(200); }
const cctxAfter = await fa._chatCtxLoad(A);
const userAfter = cctxAfter.messages.filter((m) => m.role === 'user').length;
R.checks.childGotOneMoreRound = userAfter === userBefore + 1 && cctxAfter.messages.some((m) => m.role === 'user' && m.content === '補充：用水彩風格');
R.checks.childRoundCompleted = (fa._chatEntry(A) || {}).status === 'done';

// ----- 非子對話／遠端子對話：ok:false -----
// 非子對話：另外建一個獨立的根對話（不是 pid 的子對話）
const otherId = await fa._chatNew(null, { noActivate: true, title: '獨立對話' });
const r1 = await callTool('chat_send_to_child', { chat_id: otherId, message: 'x' });
const r2 = await callTool('chat_get_child_summary', { chat_id: otherId });
R.checks.nonChildRejected = r1.ok === false && r2.ok === false && String(r1.error || r1.reason || '').length > 0;
R.info.nonChildReason = r1.error || r1.reason || null;
const REMOTE = await fa._chatNew(null, { parentId: pid, title: '遠端需求', noActivate: true, status: 'done', summary: 'r' });
const re = fa._chatEntry(REMOTE); if (re) re.nodeName = '節點甲';
const r3 = await callTool('chat_send_to_child', { chat_id: REMOTE, message: 'x' });
R.checks.remoteRejected = r3.ok === false && String(r3.error || r3.reason || '').indexOf('遠端') >= 0;
R.info.remoteReason = r3.error || r3.reason || null;

// 載入來源：工作目錄的實作（正規表示式，接受兩種引號）
R.checks.loadedWorkdirImpl = /chat_get_child_summary/.test(String(fa._subchatToolFilter || '')) && /chat_send_to_child/.test(String(fa._subchatToolFilter || ''));

// 清理
for (const k of kidsOf(pid)) { try { await fa._chatDelete(k.id); } catch (_) { /* */ } }
fa.advancedSettings.topicShiftCheck = false;
window.fetch = realFetch;
window.confirm = realConfirm;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
