// 子對話 S7 步驟 5（AI 工具 chat_delete_children）真實桌面版評估：假模型、假 confirm（window.confirm）。
// 建立：1 父 P，子對話 a1（完成）、a2（失敗）、a3（進行中）、a4（完成，有孫 g4 完成）；另有一般對話 N（沒有子對話）。
// 檢查：
//   - 工具清單：有子對話時 _getRootToolNames 與假模型收到的 tools 含 chat_delete_children；在沒有子對話的 N 時不含（回歸）。
//   - dry_run：只回傳預覽（would_delete 含 a1、a2、a4、g4），不跳確認、不刪。
//   - 未確認：直接呼叫工具（確認回答「否」）→ ok:false，什麼都沒刪。
//   - 非子對話：ids 含 P 自己（根）與不存在的 id → 列在 skipped（not_child／not_found），不刪。
//   - 假模型呼叫（TOOLDEL）→ 先確認（確認框含 a1、a2、a4、g4 的標題）→ 按確認後才刪；工具結果 ok:true、deleted 4 筆、descendants_deleted 1；a3 留下；存檔與 ctx 清掉；目前對話仍是 P。
//   - 工具結果在假模型第二次請求的 tool 訊息裡可讀（JSON）。
//   - 載入來源：工作目錄的實作（字串常值「AI 要求刪除」）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_delete_ai.eval.js 17966
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return !!pred(); }

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa.advancedSettings.topicShiftCheck = false;
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }

// 假 confirm：依序回答，記錄訊息
const realConfirm = window.confirm; const realAlert = window.alert;
let confirmAnswers = []; const confirmLog = [];
window.confirm = (msg) => { confirmLog.push(String(msg)); return confirmAnswers.length ? !!confirmAnswers.shift() : false; };
window.alert = () => {};

// 假模型：TOOLDEL → 呼叫 chat_delete_children（參數 delArgs）；有工具結果後回「好的」；其餘回「收到」
let delArgs = {};
const modelReqs = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const names = Array.isArray(body.tools) ? body.tools.map((t) => (t.function ? t.function.name : t.name)) : [];
  modelReqs.push({ names, toolMsgs: msgs.filter((m) => m && m.role === 'tool').map((m) => String(m.content || '')) });
  const mk = (msg, finish) => new Response(JSON.stringify({ choices: [{ message: msg, finish_reason: finish || 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const lastUser = msgs.filter((m) => m && m.role === 'user').slice(-1)[0];
  const hasToolResult = msgs.some((m) => m && m.role === 'tool');
  if (lastUser && String(lastUser.content).indexOf('TOOLDEL') >= 0 && !hasToolResult) {
    return mk({ role: 'assistant', content: null, tool_calls: [{ id: 'call_del', type: 'function', function: { name: 'chat_delete_children', arguments: JSON.stringify(delArgs) } }] }, 'tool_calls');
  }
  return mk({ role: 'assistant', content: hasToolResult ? '好的' : '收到' });
};

async function mkChat(id, title, parentId, status) {
  const now = Date.now();
  fa._chatIndex.chats.push({ id, title, groupId: null, createdAt: now, updatedAt: now, parentId, status, fingerprint: { kw: [title] } });
  const prev = fa._ctx;
  await fa._chatSwitch(id);
  fa.messages.push({ role: 'user', content: title });
  fa._persistChatHistory();
  await fa._chatSwitch(prev.id);
}
const tool = (name) => (fa.tools && fa.tools[name]) || null;
const callTool = async (name, args) => { const t = tool(name); if (!t) return { ok: false, error: '沒有這個工具' }; const out = await t.callback.call(fa, JSON.stringify(args || {})); try { return JSON.parse(out); } catch (_) { return { raw: out }; } };
const kidIds = (pid) => fa._chatIndex.chats.filter((c) => c.parentId === pid).map((c) => c.id).sort();

try {
  await fa._chatNew();
  const P = fa._chatIndex.currentId;
  R.info.parentId = P;
  await mkChat('a1', '子甲完成', P, 'done');
  await mkChat('a2', '子乙失敗', P, 'failed');
  await mkChat('a3', '子丙進行中', P, 'running');
  await mkChat('a4', '子丁完成', P, 'done');
  await mkChat('g4', '孫四完成', 'a4', 'done');
  await fa._chatSwitch(P);

  // 工具清單
  R.checks.toolRegistered = !!tool('chat_delete_children');
  R.checks.inRootListWithKids = (fa._getRootToolNames() || []).indexOf('chat_delete_children') >= 0;
  fa.messages.push({ role: 'user', content: 'P 有內容，免得 _chatNew 重用空對話' });
  fa._persistChatHistory();
  await fa._chatNew();
  const N = fa._chatIndex.currentId; // 沒有子對話的一般對話（根）
  R.info.N = N;
  R.checks.notInRootListNoKids = (fa._getRootToolNames() || []).indexOf('chat_delete_children') < 0;
  await fa._chatSwitch(P);

  // dry_run：只預覽
  confirmLog.length = 0; confirmAnswers = [];
  const dry = await callTool('chat_delete_children', { filter: 'done_or_failed', dry_run: true, parent_id: P });
  R.info.dry = dry;
  R.checks.dryNoConfirm = confirmLog.length === 0;
  R.checks.dryPreview = dry.ok === true && dry.dry_run === true && JSON.stringify((dry.would_delete || []).map((x) => x.id).sort()) === JSON.stringify(['a1', 'a2', 'a4', 'g4']);
  R.checks.dryNothingDeleted = kidIds(P).join(',') === 'a1,a2,a3,a4' && !!fa._chatEntry('g4');

  // 未確認：確認回答否 → ok:false，什麼都沒刪
  confirmAnswers = [false]; confirmLog.length = 0;
  const no = await callTool('chat_delete_children', { filter: 'done_or_failed', parent_id: P });
  R.info.no = no;
  R.checks.unconfirmedAsked = confirmLog.length === 1 && confirmLog[0].indexOf('子甲完成') >= 0 && confirmLog[0].indexOf('孫四完成') >= 0;
  R.checks.unconfirmedRefused = no.ok === false && kidIds(P).join(',') === 'a1,a2,a3,a4' && !!fa._chatEntry('g4');

  // 非子對話：根（P 自己）與不存在的 id → skipped，不刪
  const bad = await callTool('chat_delete_children', { filter: 'ids', ids: [P, 'nope', N], parent_id: P, dry_run: true });
  R.info.bad = bad;
  const reasons = {}; (bad.skipped || []).forEach((x) => { reasons[x.id] = x.reason; });
  R.checks.nonChildSkipped = reasons[P] === 'not_child' && reasons.nope === 'not_found' && reasons[N] === 'not_child' && (bad.deleted || []).length === 0;
  R.checks.badNothingDeleted = !!fa._chatEntry(P) && !!fa._chatEntry(N);

  // 假模型呼叫 → 先確認 → 按確認才刪
  delArgs = { filter: 'done_or_failed' };
  confirmAnswers = [true]; confirmLog.length = 0; modelReqs.length = 0;
  const turn = Promise.race([fa.executeChat('請清理子對話 TOOLDEL'), sleep(60000)]);
  await waitFor(() => kidIds(P).join(',') === 'a3', 60000);
  await turn;
  await sleep(300);
  R.info.confirmCount = confirmLog.length;
  R.info.kidsAfterModel = kidIds(P);
  R.checks.modelConfirmAsked = confirmLog.length === 1 && confirmLog[0].indexOf('子丁完成') >= 0;
  R.checks.modelDeletedRest = kidIds(P).join(',') === 'a3' && !fa._chatEntry('g4') && !fa._chatEntry('a1');
  R.checks.storageGone = await (async () => { try { return !(await fa._chatBackend().read('a1')) && !(await fa._chatBackend().read('g4')); } catch (_) { return true; } })();
  R.checks.stillOnParent = fa._chatIndex.currentId === P;
  const secondReq = modelReqs.find((r) => r.toolMsgs.length > 0);
  R.info.toolMsg = secondReq ? secondReq.toolMsgs[0].slice(0, 300) : null;
  R.checks.toolResultReadable = !!secondReq && /"ok":\s*true/.test(secondReq.toolMsgs[0]) && /"descendants_deleted":\s*1/.test(secondReq.toolMsgs[0]);

  // 沒有子對話的情境（N）：工具不在清單（由 fake 模型收到的 tools 判斷）
  await fa._chatSwitch(N);
  modelReqs.length = 0;
  await Promise.race([fa.executeChat('一般問題'), sleep(30000)]);
  await sleep(300);
  R.checks.noKidsToolsOmitted = modelReqs.length > 0 && modelReqs[0].names.indexOf('chat_delete_children') < 0;
  await fa._chatSwitch(P);

  // 載入來源：工作目錄的實作（字串常值）
  R.checks.loadedWorkdirImpl = String(fa._chatDeleteChildrenTool || '').indexOf('AI 要求刪除') >= 0;
} catch (e) {
  R.info.fatal = String((e && e.message) || e);
  R.checks.fatal = false;
} finally {
  window.confirm = realConfirm; window.alert = realAlert; window.fetch = realFetch;
}
R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
