// 子對話 S8 步驟 A（被刪子對話不復活）真實桌面版評估：假模型、假 confirm。
// 情境 1（模型忽略 abort）：子對話 C 正在回應（假模型延遲 1200ms 才回，且不理會 abort），使用者刪除 C。
//   回應結束後，C 的存檔、索引、_chatCtxs、待寫入 pending 都不能出現 C。
// 情境 2（存檔寫入中途被刪）：C 的存檔寫入被人為拖慢 1500ms（寫入已開始、尚未落盤），寫入期間刪除 C。
//   寫入完成後，檔案不能復活。
// 檢查：
//   - 情境 1：索引沒有 C；後端讀不到 C；_chatCtxs 沒有 C；_chatPendingMap 沒有 C。
//   - 情境 2：索引沒有 C；後端讀不到 C（寫入落盤之後再讀）。
//   - 載入來源：工作目錄的實作（字串常值「_deleted」或「S8:resurrect」，見修法）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_resurrect.eval.js 17966
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

const realConfirm = window.confirm; const realAlert = window.alert;
window.confirm = () => true;
window.alert = () => {};

// 假模型：含「慢」的請求延遲 1200ms 才回，而且不理會 abort（模擬背景跑、已 abort 但仍會回來的情況）
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...msgs].reverse().find((m) => m && m.role === 'user');
  const lastUserText = lastUser ? String(lastUser.content || '') : '';
  const mk = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (lastUserText.indexOf('慢') >= 0) { await sleep(1200); return mk('慢的回覆'); }
  return mk('收到');
};

const be0 = fa._chatBackend.bind(fa);
let slowId = null;
function setSlowWrite(id) {
  slowId = id;
  fa._chatBackend = () => {
    const b = be0();
    return Object.assign({}, b, {
      write: async (id2, text) => { if (id2 === slowId) { await sleep(1500); } return b.write(id2, text); },
    });
  };
}
function clearSlowWrite() { slowId = null; fa._chatBackend = be0; }

async function mkParentAndChild(tag) {
  const now = Date.now();
  const pid = 'res_p_' + tag, cid = 'res_c_' + tag;
  fa._chatIndex.chats.push({ id: pid, title: 'P' + tag, groupId: null, createdAt: now, updatedAt: now });
  fa._chatIndex.chats.push({ id: cid, title: 'C' + tag, groupId: null, createdAt: now, updatedAt: now, parentId: pid, status: 'done', fingerprint: { kw: ['C' + tag] } });
  const prev = fa._ctx;
  await fa._chatSwitch(pid);
  fa.messages.push({ role: 'user', content: 'P' + tag });
  fa._persistChatHistory();
  await fa._chatSwitch(cid);
  fa.messages.push({ role: 'user', content: 'C' + tag });
  fa._persistChatHistory();
  await fa._chatSwitch(prev.id);
  await sleep(600);
  return { pid, cid };
}

// ----- 情境 1 -----
{
  const { cid } = await mkParentAndChild('1');
  const sendP = fa._subchatSend(cid, '慢：請回答');
  const running = await waitFor(() => { const c = fa._chatCtxs.get(cid); return !!c && c.isResponding === true; }, 5000);
  R.checks.s1Running = running;
  await fa._chatDelete(cid);
  await sendP.catch(() => {});
  await sleep(2500);
  await sleep(800);
  R.checks.s1NotInIndex = !fa._chatIndex.chats.some((c) => c.id === cid);
  let raw = null; try { raw = await fa._chatBackend().read(cid); } catch (_) { raw = null; }
  R.checks.s1NoFile = !raw;
  R.checks.s1NoCtx = !fa._chatCtxs.has(cid);
  R.checks.s1NoPending = !(fa._chatPendingMap && fa._chatPendingMap.has(cid));
  R.info.s1Raw = raw ? String(raw).slice(0, 120) : null;
}

// ----- 情境 2 -----
{
  const { cid } = await mkParentAndChild('2');
  setSlowWrite(cid);
  // 讓 C 寫入：在 C 的 ctx 裡推一則訊息並排程存檔；寫入會被拖慢
  const cctx = await fa._chatCtxLoad(cid);
  cctx.messages.push({ role: 'assistant', content: '寫入中的回覆' });
  fa._chatCtxs.set(cid, cctx);
  const prev = fa._ctx;
  await fa._chatSwitch(cid);
  fa._persistChatHistory();
  await sleep(400); // 排程的寫入已開始（被拖慢中）
  await fa._chatDelete(cid); // 寫入未落盤時刪除
  await fa._chatSwitch(prev.id).catch(() => {});
  await sleep(2500);
  clearSlowWrite();
  await sleep(300);
  let raw2 = null; try { raw2 = await fa._chatBackend().read(cid); } catch (_) { raw2 = null; }
  R.checks.s2NotInIndex = !fa._chatIndex.chats.some((c) => c.id === cid);
  R.checks.s2NoFile = !raw2;
  R.info.s2Raw = raw2 ? String(raw2).slice(0, 120) : null;
}

// 載入來源：工作目錄的實作（修法留下的字串常值）
R.checks.loadedWorkdirImpl = String(fa._flushChatWrite || '').indexOf('S8:resurrect') >= 0;

window.confirm = realConfirm; window.alert = realAlert; window.fetch = realFetch;
R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
