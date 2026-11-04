// 子對話 S6 步驟 4（遠端子對話的冒泡與 @）真實桌面版評估：假 LLM，不需要真的遠端。
// 序列：
//   1. B機 的需求「畫一張貓」→ 收件對話 + 子對話 C1（同 subchat_remote 的建立路徑）
//   2. 子對話 C1 要使用者選風格（表單）→ 子對話狀態 waiting_user；收件對話的連結卡片可以回答
//   3. 在收件對話回答「水彩」→ 表單結束，子對話離開等待
//   4. @[B機/來自 B機：畫一張貓] 能解析到 C1，送出提示含節點名
//   5. 收件對話不呼叫模型：在收件對話打字只會提示，模型呼叫數不變
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_remote_bubble.eval.js 17968
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fa.advancedSettings.offlineMode = false;
let modelCalls = 0;
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  modelCalls++;
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

function allChats() { return (fa._chatIndex && fa._chatIndex.chats) || []; }
const origCtx = fa._activeCtx;

try {
  const job = { taskId: 'task-bub-1', from: 'node-B', fromName: 'B機', text: '畫一張貓', files: [], events: [], done: false, stop: false, sub: false, at: Date.now(), trace: [] };
  job.chatCtx = await fa._rgCreateRemoteChat(job);
  const childId = job.chatCtx && job.chatCtx.id;
  const inbox = allChats().find((c) => c.kind === 'remote-inbox' && c.nodeName === 'B機') || null;
  const ictx = inbox ? await fa._chatCtxLoad(inbox.id) : null;
  R.info.childId = childId || null;
  R.info.inboxId = inbox ? inbox.id : null;

  // 子對話要使用者選風格（表單）：走子對話的 ctx（與 _rgRunTask 的執行相同）
  const run = fa._chatRunner(job.chatCtx);
  let answered = null;
  const p = run._subchatAskForm(childId, { title: '選風格', choices: ['水彩', '油畫'] });
  p.then((r) => { answered = r; });
  await sleep(200);

  const ent = fa._chatEntry(childId) || {};
  R.info.childStatusWaiting = ent.status;
  R.checks.childWaitingUser = ent.status === 'waiting_user';
  R.checks.inboxHasLinkCard = !!ictx && ictx.messages.some((m) => m && m._subchatLink && m._subchatLink.childId === childId);
  const info = fa._subchatLinkInfo(childId) || {};
  R.info.linkInfo = { pending: info.pending || null, canAnswer: !!info.canAnswer };
  R.checks.inboxCardCanAnswer = info.pending === 'form' && info.canAnswer === true;

  // 只有選項的題目：打字回答要被拒絕（與本機子對話相同）
  const typed = fa._subchatAnswer(childId, '水彩');
  R.info.typedResult = typed && typed.ok;
  R.checks.typedRejectedForChoiceOnly = !!typed && typed.ok === false;
  // 在收件對話按選項回答（與卡片按鈕相同的路徑 _subchatAnswerForm）
  const ans = fa._subchatAnswerForm(childId, { kind: 'choice', answer: '水彩' });
  R.info.answerResult = ans ? ans.ok : null;
  await sleep(300);
  R.checks.answerResolvedForm = answered !== null;
  R.checks.childLeftWaiting = (fa._chatEntry(childId) || {}).status !== 'waiting_user';
  R.checks.pendingCleared = !fa._subchatPendingMap().has(childId);

  // @：本機之外的遠端子對話用 @節點名/對話名 能解析到（完整名稱含空白要用方括號）
  const cands = fa._chatTreeMod().listMentionCandidates(allChats(), '@B機/', '');
  R.info.mentionCandidates = cands.map((c) => c.label);
  R.checks.mentionAutocompleteFindsRemoteChild = cands.some((c) => c.chatId === childId && c.remote === true);
  const title = (fa._chatEntry(childId) || {}).title || '';
  const prep = fa._mentionPrepare('@[B機/' + title + '] 再加水彩');
  R.info.mentionHint = String(prep.hint || '').slice(0, 160);
  R.checks.mentionResolvesRemoteChild = prep.blocked === false && String(prep.hint || '').indexOf('id=' + childId) >= 0 && String(prep.hint || '').indexOf('節點=B機') >= 0;
  // 只用對話名（沒寫節點名）→ 要求補上節點名，不送出
  const bare = fa._mentionPrepare('@[' + title + ']');
  R.checks.mentionBareNeedsNode = bare.blocked === true && String(bare.message || '').indexOf('節點名') >= 0;

  // 收件對話不呼叫模型：切到收件對話後打字，只提示
  fa._chatActivate(ictx);
  await sleep(200);
  R.checks.inboxShowsLinkDom = !!document.querySelector('.fa-subchat-link[data-child-id="' + childId + '"]');
  const beforeCalls = modelCalls;
  await fa.executeChat('你好');
  await sleep(200);
  const last = fa.messages[fa.messages.length - 1] || {};
  R.checks.inboxNoModelCall = modelCalls === beforeCalls;
  R.checks.inboxNoticeShown = String(last.content || '').indexOf('收件對話') >= 0;
} catch (e) {
  R.info.error = String((e && e.message) || e);
}

// 還原：回到原本的對話
try { if (origCtx) fa._chatActivate(origCtx); } catch (_) { /* */ }

// 載入來源：工作目錄的實作（字串常值）
// （executeChat 在這個環境是 bound 函式，字串裡看不到本體；守衛改用 inboxNoModelCall 的行為驗證）
R.checks.loadedWorkdirImpl = String(fa._remoteInboxLink || '').indexOf('_subchatLink') >= 0;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
