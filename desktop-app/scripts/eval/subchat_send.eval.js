// 子對話 S4 步驟 5（父對話傳訊息給子對話）真實桌面版評估：假 LLM。
// 案例 1（閒置 → 新一輪）：子對話 done 後，父對話連結卡片送訊息 → mode 'turn'，狀態會回 running、最後 done，子對話多一則使用者訊息與回覆。
// 案例 2（回應中 → 插話）：子對話正在回應時送訊息 → mode 'steer'，子對話訊息裡多一則 [Steering]（既有插話規則），最後 done。
// 案例 3（父對話自己的輸入框）：父對話 executeChat 只問父對話：父對話模型多一次呼叫，子對話訊息不增加。
// 案例 4（畫面按鈕）：連結卡片的「傳給子對話」按鈕，點擊後子對話收到輸入框裡的文字。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_send.eval.js 17966
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }

let parentCalls = 0;
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = String((msgs[0] || {}).content || '');
  const child = msgs.some((m) => m && m.role === 'system' && String(m.content || '').indexOf('從〈') >= 0);
  const lastUser = [...msgs].reverse().find((m) => m && m.role === 'user');
  const lastUserText = lastUser ? String(lastUser.content || '') : '';
  const mk = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/對話分析專家/.test(sys)) return mk(JSON.stringify({ isShifted: true, reason: 'fake', newTopicSummary: '音樂' }));
  if (/議題切割摘要|過渡摘要/.test(sys)) return mk('摘要');
  if (!child) { parentCalls++; return mk('父對話回覆'); }
  // 子對話：文字含「慢」的那一輪故意停 2.5 秒，讓案例 1、2 能觀察到 running 與插話
  if (lastUserText.indexOf('慢') >= 0) await sleep(2500);
  return mk('完成');
};

const sleepUntil = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(150); } return pred(); };
const kidsOf = (pid) => ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId === pid);
const entryOf = (id) => (fa._chatIndex.chats.find((c) => c.id === id) || {});
const userTexts = (msgs) => msgs.filter((m) => m && m.role === 'user').map((m) => String(m.content || ''));

// ----- 建一個子對話（與 S3 相同的三則）-----
fa.advancedSettings.topicShiftCheck = true;
fa._clearChatHistory();
delete fa._lastTopicShift;
const pid = fa._chatIndex.currentId;
for (const t of ['幫我畫一張貓的圖', '再加一隻狗', '幫我創作一首音樂']) {
  await Promise.race([fa.executeChat(t), sleep(30000)]);
}
await sleepUntil(() => kidsOf(pid).length > 0, 20000);
const kid = kidsOf(pid)[0] || null;
R.info.kid = kid ? { id: kid.id, title: kid.title, status: kid.status } : null;
R.checks.childOpened = !!kid;
await sleepUntil(() => !!kid && entryOf(kid.id).status === 'done', 20000);
const cctx = kid ? fa._chatCtxs.get(kid.id) : null;

// ----- 案例 1：閒置 → 新一輪 -----
const calls0 = parentCalls;
const r1 = kid ? await fa._subchatSend(kid.id, '慢：請再說一次') : null;
R.info.r1 = r1;
R.checks.idleSendOk = !!r1 && r1.ok === true && r1.mode === 'turn';
let sawRunning = false;
await sleepUntil(() => { if (kid && entryOf(kid.id).status === 'running') sawRunning = true; return !!kid && entryOf(kid.id).status === 'done' && sawRunning; }, 20000);
R.checks.idleSawRunning = sawRunning;
R.checks.idleDoneAgain = !!kid && entryOf(kid.id).status === 'done';
R.checks.idleChildTurn = !!cctx && userTexts(cctx.messages).some((t) => t === '慢：請再說一次')
  && cctx.messages.some((m, i, a) => m && m.role === 'assistant' && m.content === '完成' && a.slice(0, i).some((x) => x && x.role === 'user' && x.content === '慢：請再說一次'));
R.checks.idleNoParentCall = parentCalls === calls0;

// ----- 案例 2：回應中 → 插話 -----
const busy = kid ? fa._subchatSend(kid.id, '慢：再說一次，詳細一點') : null;
await sleepUntil(() => !!cctx && cctx.isResponding === true, 5000);
R.info.busyObserved = !!cctx && cctx.isResponding === true;
const r2 = kid ? await fa._subchatSend(kid.id, '插話：改成紅色') : null;
R.info.r2 = r2;
R.checks.steerMode = !!r2 && r2.ok === true && r2.mode === 'steer';
await busy;
await sleepUntil(() => !!kid && entryOf(kid.id).status === 'done', 20000);
R.checks.steerInChild = !!cctx && cctx.messages.some((m) => m && m.role === 'system' && String(m.content || '').indexOf('插話：改成紅色') >= 0);
R.checks.steerDone = !!kid && entryOf(kid.id).status === 'done';

// ----- 案例 3：父對話自己的輸入框只問父對話 -----
fa.advancedSettings.topicShiftCheck = false;
const parentCallsBefore = parentCalls;
const childCountBefore = kidsOf(pid).length;
const childMsgsBefore = cctx ? cctx.messages.length : 0;
await Promise.race([fa.executeChat('父對話自己的問題'), sleep(30000)]);
R.checks.parentOwnCalled = parentCalls === parentCallsBefore + 1;
R.checks.parentOwnInParent = fa.messages.some((m) => m && m.role === 'user' && m.content === '父對話自己的問題');
R.checks.parentOwnNotInChild = !!cctx && !cctx.messages.some((m) => m && m.content === '父對話自己的問題');
R.checks.parentOwnChildCountSame = cctx ? cctx.messages.length === childMsgsBefore : false;
R.checks.parentOwnNoNewChild = kidsOf(pid).length === childCountBefore;

// ----- 案例 4：連結卡片的「傳給子對話」按鈕 -----
const linkEl = document.querySelector('.fa-subchat-link[data-child-id="' + (kid ? kid.id : '') + '"]');
R.checks.uiLinkExists = !!linkEl;
const btn = linkEl ? linkEl.querySelector('.fa-subchat-answer-send') : null;
const inp = linkEl ? linkEl.querySelector('input.fa-subchat-answer') : null;
R.checks.uiButtonLabel = !!btn && btn.textContent === '傳給子對話';
if (btn && inp) { inp.value = '從按鈕送出'; btn.click(); }
R.checks.uiSendReachesChild = await sleepUntil(() => !!cctx && cctx.messages.some((m) => m && m.role === 'user' && m.content === '從按鈕送出'), 15000);
await sleepUntil(() => !!kid && entryOf(kid.id).status === 'done', 15000);
R.checks.uiInputCleared = !!inp && inp.value === '';

// 載入來源：工作目錄的實作
R.checks.loadedWorkdirImpl = String(fa._subchatSend || '').indexOf("mode: 'steer'") >= 0 || String(fa._subchatSend || '').indexOf('steer') >= 0;

// 還原
fa.advancedSettings.topicShiftCheck = false;
window.fetch = realFetch;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
