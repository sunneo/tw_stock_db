// 子對話 S3（開出真正的子對話）真實桌面版評估：假 LLM，比對 topicShiftCheck 開／關兩組。
// 檢查（開）：送「幫我畫一張貓的圖」「再加一隻狗」「幫我創作一首音樂」。
//   - 索引多一個子對話，parentId 指向原對話，標題是「幫我創作一首音樂」，最後 status 是 done。
//   - 子對話訊息：system 提示、交接 system 訊息、使用者訊息、假模型的回覆。
//   - 父對話的模型呼叫：前兩則各一次，第三則 0 次（子對話的呼叫不算父對話）。
//   - 父對話有一則連結卡片（_subchatLink 指向子對話），使用者訊息照常顯示，isResponding 已回到 false。
// 檢查（關）：三則都只在父對話處理，沒有子對話、沒有連結卡片，模型呼叫各一次（與 S2 之前一樣）。
// 另外：載入來源（原始碼含字串常值「已開出子對話」）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_open.eval.js 17962
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }

// 每次模型呼叫記一筆：child＝這次呼叫的訊息裡有交接內文（子對話的呼叫）
let cur = null;
const calls = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = String((msgs[0] || {}).content || '');
  const child = msgs.some((m) => m && m.role === 'system' && String(m.content || '').indexOf('從〈') >= 0);
  const mk = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let kind = 'main_chat', reply = '完成';
  if (/對話分析專家/.test(sys)) { kind = 'topic_check'; reply = JSON.stringify({ isShifted: true, reason: 'fake', newTopicSummary: '音樂' }); }
  if (/議題切割摘要|過渡摘要/.test(sys)) { kind = 'shift_summary'; reply = '摘要'; }
  calls.push({ kind, child, at: Date.now() });
  if (cur) cur.modelCalls.push({ kind, child });
  return mk(reply);
};

const texts = ['幫我畫一張貓的圖', '再加一隻狗', '幫我創作一首音樂'];
const NEW_TITLE = '幫我創作一首音樂';

function childrenOf(pid) { return ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId === pid); }
function linkCards() { return fa.messages.filter((m) => m && m._subchatLink); }

async function runPass(on) {
  fa.advancedSettings.topicShiftCheck = on;
  fa._clearChatHistory();
  delete fa._lastTopicShift;
  const pid = fa._chatIndex.currentId;
  const childBefore = ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId).length;
  const rows = [];
  for (const text of texts) {
    cur = { text, modelCalls: [] };
    let err = null;
    await Promise.race([fa.executeChat(text), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]).catch((e) => { err = String((e && e.message) || e); });
    rows.push({ text, calls: cur.modelCalls.slice(), err });
    cur = null;
  }
  // 等子對話跑完（只在開啟時會有）
  let kids = childrenOf(pid);
  for (let i = 0; on && i < 300 && kids.every((k) => k.status !== 'done' && k.status !== 'failed'); i++) { await sleep(200); kids = childrenOf(pid); }
  const childNew = ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId).length - childBefore;
  return { pid, rows, kids, childNew, cards: linkCards(), isResponding: !!fa.isResponding };
}

const off = await runPass(false);
const on = await runPass(true);
R.info.offRows = off.rows.map((r) => ({ calls: r.calls.length, err: r.err }));
R.info.onRows = on.rows.map((r) => ({ calls: r.calls.map((c) => (c.child ? 'child' : c.kind)), err: r.err }));

// ----- 關 -----
R.checks.offNoChild = off.childNew === 0;
R.checks.offNoLinkCard = off.cards.length === 0;
R.checks.offEachTurnOneParentCall = off.rows.length === 3 && off.rows.every((r) => r.calls.length === 1 && r.calls[0].kind === 'main_chat' && !r.calls[0].child);

// ----- 開 -----
const kid = on.kids[0] || null;
R.info.childCount = on.kids.length;
R.checks.onOneChild = on.kids.length === 1 && on.childNew === 1;
R.checks.onChildParentIdPoints = !!kid && kid.parentId === on.pid;
R.checks.onChildTitle = !!kid && kid.title === NEW_TITLE;
R.checks.onChildStatusDone = !!kid && kid.status === 'done';
R.checks.onParentCallsFirstTwoOnly = on.rows.length === 3
  && on.rows[0].calls.length === 1 && !on.rows[0].calls[0].child
  && on.rows[1].calls.length === 1 && !on.rows[1].calls[0].child
  && on.rows[2].calls.filter((c) => !c.child).length === 0; // 子對話的呼叫可能在父對話這一輪結束前就被記到（背景執行），所以只數「不帶交接內文」的呼叫（父對話）
R.checks.onNoParentErrors = on.rows.every((r) => !r.err);
R.checks.onChildCalledModel = calls.some((c) => c.child && c.kind === 'main_chat');
R.checks.onParentLinkCard = !!kid && on.cards.length === 1 && on.cards[0]._subchatLink.childId === kid.id && on.cards[0]._subchatLink.title === NEW_TITLE;
R.checks.onParentUserMsgShown = fa.messages.some((m) => m.role === 'user' && m.content === NEW_TITLE);
R.checks.onParentNotResponding = on.isResponding === false;

// 子對話的訊息：system 提示、交接 system、使用者訊息、假模型回覆（從存檔讀，因為背景對話可能已被移出記憶體）
let childMsgs = null;
try {
  if (kid) { const cctx = await fa._chatCtxLoad(kid.id); childMsgs = cctx && cctx.messages ? cctx.messages.slice() : null; }
} catch (e) { R.info.loadErr = String((e && e.message) || e); }
R.checks.onChildHasHandoffSystem = !!childMsgs && childMsgs.some((m) => m.role === 'system' && String(m.content).indexOf('從〈') >= 0);
R.checks.onChildHasUserMsg = !!childMsgs && childMsgs.some((m) => m.role === 'user' && m.content === NEW_TITLE);
R.checks.onChildHasAssistantReply = !!childMsgs && childMsgs.some((m) => m.role === 'assistant' && m.content === '完成');
R.checks.onChildOrder = !!childMsgs && childMsgs[0].role === 'system' && childMsgs[1].role === 'system' && String(childMsgs[1].content).indexOf('從〈') >= 0;

// 載入來源：工作目錄的實作（字串常值）
R.checks.loadedWorkdirImpl = String(fa._subchatOpenFor || '').indexOf('已開出子對話') >= 0;

// 還原
fa.advancedSettings.topicShiftCheck = false;
window.fetch = realFetch;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
