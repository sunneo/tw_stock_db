// 子對話 S4b 步驟 3：子對話的表單（requestUserForm）冒泡到父對話的連結卡片，父對話可以回答。
// 案例：
//   F1 背景子對話，選項表單：子對話 waiting_user、父對話連結卡片顯示題目與選項按鈕、父對話按選項 → 子對話的表單拿到答案。
//   F2 欄位表單（fields）：父對話填欄位送出 → 拿到 values。
//   F3 不允許補充的選項表單：父對話打字回答（表單與卡片兩條路）都要被拒絕，仍停在 waiting_user；按選項後才算答完。
//   F4 允許補充的選項表單：父對話打字 → 當成補充（skipped＋supplement）。
//   F5 子對話在畫面上：表單顯示在子對話；父對話回答後，子對話畫面的表單被收掉。
//   F6 子對話在畫面上：子對話自己按選項先回答 → 父對話的等待取消，之後父對話回答被拒絕。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_form.eval.js 17968
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (fn) => { try { return fn(); } catch (e) { return { ok: false, error: 'throw: ' + String((e && e.message) || e) }; } };
const raceTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => '__timeout__')]);

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }

let shiftReply = true;
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = String((msgs[0] || {}).content || '');
  const mk = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let reply = '完成';
  if (/對話分析專家/.test(sys)) reply = JSON.stringify({ isShifted: shiftReply, reason: 'fake', newTopicSummary: '音樂' });
  if (/議題切割摘要|過渡摘要/.test(sys)) reply = '摘要';
  return mk(reply);
};
async function sendOne(text) {
  let err = null;
  await Promise.race([fa.executeChat(text), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]).catch((e) => { err = String((e && e.message) || e); });
  return err;
}

// 前置：開出一個子對話
fa.advancedSettings.topicShiftCheck = true;
fa._clearChatHistory();
delete fa._lastTopicShift;
const pid = fa._chatIndex.currentId;
const parentCtx = fa._ctx;
for (const t of ['幫我畫一張貓的圖', '再加一隻狗', '幫我創作一首音樂']) { await sendOne(t); }
let kid = null;
for (let i = 0; i < 300; i++) {
  const kids = ((fa._chatIndex && fa._chatIndex.chats) || []).filter((c) => c.parentId === pid);
  if (kids.length && kids.every((k) => k.status === 'done' || k.status === 'failed')) { kid = kids[0]; break; }
  await sleep(200);
}
fa.advancedSettings.topicShiftCheck = false;
R.info.hasKid = !!kid;
const cctx = kid ? await fa._chatCtxLoad(kid.id) : null;
const cr = cctx ? fa._chatRunner(cctx) : null;
const statusOf = () => { const e = kid && fa._chatEntry(kid.id); return e ? e.status : null; };
const linkEl = () => document.querySelector('.fa-subchat-link[data-child-id="' + (kid && kid.id) + '"]');
const formDom = () => document.querySelector('[id^="ai-form-"]');

// F1：背景子對話，選項表單，父對話按選項回答
fa._chatActivate(parentCtx);
// 表單只會在子對話執行中（running）要求：模擬一輪開始（done 是終態，ask 會被忽略）
safe(() => fa._subchatSetStatus(kid.id, 'start'));
const p1 = safe(() => cr.requestUserForm({ title: '要哪個配色？', description: '選一個', choices: ['紅色', '藍色'] }));
await sleep(150);
R.checks.f1_waitingUser = statusOf() === 'waiting_user';
const e1 = kid && fa._chatEntry(kid.id);
R.checks.f1_questionShown = !!(e1 && e1.subInfo && e1.subInfo.question === '要哪個配色？');
R.checks.f1_parentLinkShowsForm = !!linkEl() && linkEl().textContent.indexOf('要哪個配色？') >= 0 && linkEl().querySelectorAll('.fa-subchat-answer-send').length >= 2;
const a1r = safe(() => fa._subchatAnswerForm(kid.id, { kind: 'choice', answer: '藍色' }));
R.checks.f1_answerOk = !!a1r && a1r.ok === true;
const a1 = await raceTimeout(p1, 3000);
R.info.forms_a1 = document.querySelectorAll('[id^="ai-form-"]').length;
R.checks.f1_resolvedChoice = !!a1 && a1 !== '__timeout__' && a1.confirmed === true && a1.answer === '藍色';
await sleep(100);
R.checks.f1_notWaitingAfter = statusOf() !== 'waiting_user';

// F2：欄位表單，父對話送出 values
safe(() => fa._subchatSetStatus(kid.id, 'start'));
const p2 = safe(() => cr.requestUserForm({ title: '填名字', fields: [{ key: 'name', label: '名字', value: '' }] }));
await sleep(150);
const r2 = safe(() => fa._subchatAnswerForm(kid.id, { kind: 'values', values: { name: '小明' } }));
const a2 = await raceTimeout(p2, 3000);
R.info.forms_a2 = document.querySelectorAll('[id^="ai-form-"]').length;
R.checks.f2_valuesResolved = !!r2 && r2.ok === true && !!a2 && a2 !== '__timeout__' && a2.values && a2.values.name === '小明';

// F3：不允許補充的選項表單，打字要被拒絕（表單路與卡片路都要）
safe(() => fa._subchatSetStatus(kid.id, 'start'));
const p3 = safe(() => cr.requestUserForm({ title: '只能按', choices: ['X', 'Y'] }));
await sleep(150);
const r3a = safe(() => fa._subchatAnswerForm(kid.id, { kind: 'supplement', text: '隨便打字' }));
const r3b = safe(() => fa._subchatAnswer(kid.id, '隨便打字'));
R.checks.f3_typingRejectedForm = !!r3a && r3a.ok === false;
R.checks.f3_typingRejectedText = !!r3b && r3b.ok === false;
R.checks.f3_stillWaiting = statusOf() === 'waiting_user';
const r3c = safe(() => fa._subchatAnswerForm(kid.id, { kind: 'choice', answer: 'Y' }));
const a3 = await raceTimeout(p3, 3000);
R.info.forms_a3 = document.querySelectorAll('[id^="ai-form-"]').length;
R.checks.f3_choiceResolves = !!r3c && r3c.ok === true && !!a3 && a3 !== '__timeout__' && a3.answer === 'Y';

// F4：允許補充的選項表單，打字當成補充
safe(() => fa._subchatSetStatus(kid.id, 'start'));
const p4 = safe(() => cr.requestUserForm({ title: '可以補充', choices: ['A', 'B'], allowSupplement: true }));
await sleep(150);
const r4 = safe(() => fa._subchatAnswer(kid.id, '自己補充的條件'));
const a4 = await raceTimeout(p4, 3000);
R.info.forms_a4 = document.querySelectorAll('[id^="ai-form-"]').length;
R.checks.f4_supplementAccepted = !!r4 && r4.ok === true && !!a4 && a4 !== '__timeout__' && a4.skipped === true && a4.supplement === '自己補充的條件';

// F5：子對話在畫面上 → 表單顯示在子對話，父對話回答後子對話畫面的表單被收掉
safe(() => fa._chatActivate(cctx));
await sleep(150);
safe(() => fa._subchatSetStatus(kid.id, 'start'));
const p5 = safe(() => cr.requestUserForm({ title: '看得到的表單', choices: ['好', '不好'] }));
await sleep(200);
R.checks.f5_formShownInChild = !!formDom() && formDom().textContent.indexOf('看得到的表單') >= 0;
safe(() => fa._chatActivate(parentCtx));
await sleep(150);
R.info.forms_afterF5ParentSwitch = document.querySelectorAll('[id^="ai-form-"]').length;
const r5 = safe(() => fa._subchatAnswerForm(kid.id, { kind: 'choice', answer: '不好' }));
const a5 = await raceTimeout(p5, 3000);
R.info.forms_a5 = document.querySelectorAll('[id^="ai-form-"]').length;
R.info.forms_a5_visibleNow = fa._chatIsVisible();
R.checks.f5_parentAnswerResolves = !!r5 && r5.ok === true && !!a5 && a5 !== '__timeout__' && a5.answer === '不好';
R.checks.f5_childFormRemoved = !formDom();

// F6：子對話在畫面上，子對話自己按選項 → 先回答的算數；之後父對話回答被拒絕
R.info.forms_beforeF6Activate = document.querySelectorAll('[id^="ai-form-"]').length;
safe(() => fa._chatActivate(cctx));
R.info.forms_afterF6Activate = document.querySelectorAll('[id^="ai-form-"]').length;
await sleep(150);
safe(() => fa._subchatSetStatus(kid.id, 'start'));
const p6 = safe(() => cr.requestUserForm({ title: '子對話先按', choices: ['甲', '乙'] }));
await sleep(200);
R.info.f6FormPresent = !!formDom();
R.info.f6Buttons = document.querySelectorAll('[id^="ai-form-"] [data-choice-idx]').length;
R.info.f6Status = statusOf();
const btn6 = formDom() && formDom().querySelector('[data-choice-idx="1"]');
R.info.f6BtnFound = !!btn6;
R.info.f6Forms = Array.from(document.querySelectorAll('[id^="ai-form-"]')).map((e) => ({ t: e.textContent.slice(0, 16), n: e.querySelectorAll('[data-choice-idx]').length }));
// 只點「子對話先按」這張表單的選項（畫面上可能還有別的表單）
const mine = Array.from(document.querySelectorAll('[id^="ai-form-"]')).find((e) => e.textContent.indexOf('子對話先按') >= 0);
const btn6b = mine && mine.querySelector('[data-choice-idx="1"]');
R.info.f6MineFound = !!btn6b;
if (btn6b) btn6b.click();
const a6 = await raceTimeout(p6, 3000);
R.checks.f6_childAnswerResolves = !!a6 && a6 !== '__timeout__' && a6.answer === '乙';
await sleep(150);
const r6 = safe(() => fa._subchatAnswerForm(kid.id, { kind: 'choice', answer: '甲' }));
R.checks.f6_lateParentAnswerRejected = !!r6 && r6.ok === false;
safe(() => fa._chatActivate(parentCtx));

// F7（由 F5 推出）：父對話已回答的表單，切回子對話時不再重新顯示
R.checks.f7_noStaleFormOnSwitchBack = R.info.forms_afterF6Activate === 0;
// 載入的是工作目錄的實作（字串常值，不用變數名）
R.checks.loadedWorkdirImpl = /沒有這個選項/.test(String(fa._subchatAnswerForm)) && /_subchatAskForm/.test(String(fa.requestUserForm));

// 還原
fa.advancedSettings.topicShiftCheck = false;
window.fetch = realFetch;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
