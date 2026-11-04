// 子對話 S5（拉回舊話題）真實桌面版評估：假 LLM，topicShiftCheck 開啟。
// 序列：
//   1. 「幫我畫一張貓的圖」              → 父對話自己處理（父模型 1 次）
//   2. 「幫我創作一首音樂」              → 新話題，開子對話 A（父模型 0 次）
//   3. 「幫我畫一張貓的圖」              → 仍屬父對話的話題，不開新子對話（父模型 1 次）
//   4. 「再創作一首不同風格的音樂」      → 拉回子對話 A：A 多一輪、父對話沒有新子對話、父模型 0 次、父對話有指向 A 的連結卡片
//   5. 刪掉 A 後「幫我寫一首搖滾音樂的歌」 → 找不到可拉回的子對話，開新子對話 B
//      （不用「來一首音樂的歌」：「來」開頭會命中 S2 既有的延續句規則，判成延續而不轉移）
// 另外：載入來源（工作目錄的實作，用正規表示式接受兩種引號）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_pullback.eval.js 17963
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
// _chatDelete 會跳確認框；評估中一律按確認
const realConfirm = window.confirm;
window.confirm = () => true;

// 每次模型呼叫記一筆：child＝這次呼叫的訊息裡有子對話交接內文（子對話的呼叫）
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

function kidsOf(pid) { return ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId === pid); }
function linkCards() { return fa.messages.filter((m) => m && m._subchatLink); }
async function waitKidsSettled(pid) {
  for (let i = 0; i < 300; i++) {
    const ks = kidsOf(pid);
    if (ks.every((k) => k.status === 'done' || k.status === 'failed' || k.status === null)) break;
    await sleep(200);
  }
}
async function sendOne(text) {
  cur = { text, modelCalls: [] };
  let err = null;
  await Promise.race([fa.executeChat(text), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]).catch((e) => { err = String((e && e.message) || e); });
  const row = { text, calls: cur.modelCalls.slice(), err };
  cur = null;
  return row;
}
async function userCountOf(id) {
  const cctx = await fa._chatCtxLoad(id);
  return cctx && cctx.messages ? cctx.messages.filter((m) => m && m.role === 'user').length : -1;
}

fa.advancedSettings.topicShiftCheck = true;
fa._clearChatHistory();
delete fa._lastTopicShift;
const pid = fa._chatIndex.currentId;
const kidsBefore = kidsOf(pid).length;

const r1 = await sendOne('幫我畫一張貓的圖');
const r2 = await sendOne('幫我創作一首音樂');
const kidsAfter2 = kidsOf(pid);
const A = kidsAfter2[0] || null;
R.info.afterMsg2KidCount = kidsAfter2.length;
const aUsersBefore4 = A ? await userCountOf(A.id) : -1;

const r3 = await sendOne('幫我畫一張貓的圖');
const kidsAfter3 = kidsOf(pid);
const callsBefore4 = calls.length;
const r4 = await sendOne('再創作一首不同風格的音樂');
await waitKidsSettled(pid);
const kidsAfter4 = kidsOf(pid);
const aUsersAfter4 = A ? await userCountOf(A.id) : -1;
const parentCardsAfter4 = linkCards();
const r4ParentMainCalls = r4.calls.filter((c) => !c.child && c.kind === 'main_chat').length;
const r4ChildCalls = calls.slice(callsBefore4).filter((c) => c.child && c.kind === 'main_chat').length;

// 刪掉 A，再送音樂相關的一句 → 應開新子對話 B
if (A) await fa._chatDelete(A.id);
const kidsAfterDelete = kidsOf(pid);
const r5 = await sendOne('幫我寫一首搖滾音樂的歌');
await waitKidsSettled(pid);
const kidsAfter5 = kidsOf(pid);
const B = kidsAfter5.find((k) => !A || k.id !== A.id) || null;

R.info.rows = [r1, r2, r3, r4, r5].map((r) => ({ text: r.text, calls: r.calls.map((c) => (c.child ? 'child' : c.kind)), err: r.err }));
R.info.kidCounts = { before: kidsBefore, after2: kidsAfter2.length, after3: kidsAfter3.length, after4: kidsAfter4.length, afterDelete: kidsAfterDelete.length, after5: kidsAfter5.length };
R.info.aUsers = { before4: aUsersBefore4, after4: aUsersAfter4 };

// ----- 開子對話 A（第二則）-----
R.checks.openedChildA = !!A && kidsAfter2.length === 1 && A.title === '幫我創作一首音樂';
R.checks.parentFirstTurnOneCall = r1.calls.length === 1 && !r1.calls[0].child;
R.checks.parentNoNewChildOnCatAgain = kidsAfter3.length === 1 && r3.calls.filter((c) => !c.child).length === 1;
// ----- 拉回 A（第四則）-----
R.checks.pullbackNoNewChild = kidsAfter4.length === 1 && !!A && kidsAfter4[0].id === A.id;
R.checks.pullbackChildGotOneRound = !!A && aUsersAfter4 === aUsersBefore4 + 1;
R.checks.pullbackParentNoModelCall = r4ParentMainCalls === 0;
R.checks.pullbackChildModelCalled = r4ChildCalls >= 1;
R.checks.pullbackParentLinkCardToA = !!A && parentCardsAfter4.some((m) => m._subchatLink && m._subchatLink.childId === A.id);
R.checks.pullbackParentLinkCardText = !!A && parentCardsAfter4.some((m) => m._subchatLink && m._subchatLink.childId === A.id && String(m.content).indexOf('回到子對話') >= 0);
R.checks.pullbackUserMsgShownInParent = fa.messages.some((m) => m && m.role === 'user' && m.content === '再創作一首不同風格的音樂');
R.checks.pullbackNoErrors = !r4.err;
// ----- 刪除 A 後，音樂句開新子對話 B -----
R.checks.afterDeleteNewChildB = !!B && kidsAfter5.length === 1 && B.id !== (A && A.id) && kidsAfterDelete.length === 0;

// 載入來源：工作目錄的實作（正規表示式，接受兩種引號）
R.checks.loadedWorkdirImpl = /回到子對話/.test(String(fa._subchatPullback || ''));

// 還原
fa.advancedSettings.topicShiftCheck = false;
window.fetch = realFetch;
window.confirm = realConfirm;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
