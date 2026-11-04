// 子對話 S8 步驟 B（提問在根、回答在子要同步）真實桌面版評估。
// 提問種類：卡片（askCard）、表單選項（requestUserForm choices）、表單欄位（requestUserForm fields）、資料夾授權（FAP 權限框）。
// 每一種兩條路徑：
//   路徑 root：在父對話（根）回答 → 子對話接續，根對話的連結卡片留下問答紀錄（where:'root'）。
//   路徑 child：使用者切到子對話在那裡回答 → 根對話連結卡片同步為「已回答」、留下紀錄（where:'child'），狀態不再 waiting_user，根對話沒有可回答的欄位。
// 子對話端的回答：表單與授權按真實的 DOM 按鈕；卡片以 FaCard.setAnswer／submitStep＋_cardFinish 模擬子對話畫面上的送出（卡片的 DOM 按鈕未逐一點擊，見限制）。
// 另：紀錄存檔後重讀仍在；紀錄上限 20 筆（超過丟掉最舊）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_qa_sync.eval.js 17966
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return !!pred(); }
const safe = (fn) => { try { return fn(); } catch (e) { return { __err: String((e && e.message) || e) }; } };

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.multiSubAgentMode = 'full';
fa.advancedSettings.topicShiftCheck = false;
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const mk = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return mk('收到');
};

const fakeRec = (id) => ({ id: id, label: '測試資料夾' + id, handle: { queryPermission: async () => 'prompt', requestPermission: async () => 'granted' } });
const KINDS = [
  { k: 'card', ask: (cr) => cr.askCard({ title: '選配色', questions: [{ id: 'color', type: 'text', label: '配色' }] }), q: '選配色', root: (kid) => fa._subchatAnswer(kid, '紅色'), answerText: '紅色' },
  { k: 'form', ask: (cr) => cr.requestUserForm({ title: '選顏色', choices: ['紅色', '藍色'] }), q: '選顏色', root: (kid) => fa._subchatAnswerForm(kid, { kind: 'choice', answer: '紅色' }), answerText: '紅色' },
  { k: 'fields', ask: (cr) => cr.requestUserForm({ title: '填名字', fields: [{ key: 'name', label: '名字', value: '' }] }), q: '填名字', root: (kid) => fa._subchatAnswerForm(kid, { kind: 'values', values: { name: '小明' } }), answerText: '小明' },
  { k: 'fap', ask: (cr, tag) => cr._checkFapPermission(fakeRec(tag), 'read'), q: '需要資料夾授權', root: (kid) => fa._subchatAnswerFap(kid, true), answerText: '授權' },
];

async function mkCase(tag) {
  const now = Date.now();
  const pid = 'qa_p_' + tag, kid = 'qa_k_' + tag;
  fa._chatIndex.chats.push({ id: pid, title: 'P' + tag, groupId: null, createdAt: now, updatedAt: now });
  fa._chatIndex.chats.push({ id: kid, title: 'K' + tag, groupId: null, createdAt: now, updatedAt: now, parentId: pid, status: 'done', fingerprint: { kw: ['K' + tag] } });
  const pctx = await fa._chatCtxLoad(pid); fa._chatCtxs.set(pid, pctx);
  pctx.messages.push({ role: 'user', content: 'P' + tag });
  const link = { role: 'assistant', content: '↳ 子對話' }; link._subchatLink = { childId: kid, title: 'K' + tag }; pctx.messages.push(link);
  fa._chatRunner(pctx)._persistChatHistory();
  const cctx = await fa._chatCtxLoad(kid); fa._chatCtxs.set(kid, cctx);
  cctx.messages.push({ role: 'user', content: 'K' + tag });
  fa._chatRunner(cctx)._persistChatHistory();
  fa._subchatSetStatus(kid, 'start');
  await sleep(700); // 存檔是延遲寫入（350ms）；子對話路徑會從磁碟重讀父對話，要等寫完
  return { pid, kid, pctx, cctx, tag };
}
const entryOf = (id) => fa._chatEntry(id);
const linkEl = (kid) => document.querySelector('.fa-subchat-link[data-child-id="' + kid + '"]');
const qaText = (kid) => { const el = linkEl(kid); const b = el && el.querySelector('.fa-subchat-qa'); return b ? b.textContent : ''; };
const answerBtns = (kid) => { const el = linkEl(kid); if (!el) return []; return Array.from(el.querySelectorAll('button, input.fa-subchat-answer')).filter((b) => ['回答', '授權', '拒絕', '紅色', '藍色', '送出', '取消', '用文字回答'].includes(b.textContent) || (b.tagName === 'INPUT' && b.placeholder === '回答子對話…')); };
const lastQA = (kid) => { const q = safe(() => fa._subchatQAFor(kid)); return Array.isArray(q) && q.length ? q[q.length - 1] : null; };

// 子對話端回答（畫面上的操作）
function childAnswer(kind, c) {
  if (kind.k === 'form' || kind.k === 'fields') {
    const fs = document.querySelectorAll('[id^="ai-form-"]'); const f = fs.length ? fs[fs.length - 1] : null; if (!f) return 'no-form-dom';
    if (kind.k === 'form') { const b = Array.from(f.querySelectorAll('button')).find((x) => x.textContent === '紅色'); if (!b) return 'no-btn'; b.click(); return 'ok'; }
    const inp = f.querySelector('input'); if (!inp) return 'no-input';
    inp.value = '小明'; const bs = Array.from(f.querySelectorAll('button')); const b = bs.find((x) => x.textContent.indexOf('送出') >= 0); if (!b) return 'no-submit'; R.info.fieldsBtnLabels = bs.map((x) => x.textContent); b.click(); return 'ok';
  }
  if (kind.k === 'fap') { const b = document.getElementById('fa-fapperm-allow'); if (!b) return 'no-fap-dialog'; b.click(); return 'ok'; }
  // 卡片：模擬子對話畫面上的送出（同 FaCard 的步驟送出，再呼叫 _cardFinish）
  const msg = c.cctx.messages.find((m) => m && m._card && m._card.state && m._card.state.status === 'open');
  if (!msg) return 'no-card';
  const FC = (typeof FaCard !== 'undefined') ? FaCard : null; if (!FC) return 'no-FaCard';
  const spec = msg._card.spec; const st = msg._card.state;
  const sid = spec.steps[0].id; const qid = spec.steps[0].questions[0].id;
  let okSet = FC.setAnswer(spec, st, sid, qid, '紅色');
  if (JSON.stringify(st.answers || {}).indexOf('紅色') < 0) okSet = FC.setAnswer(spec, st, sid, qid, { v: '紅色', x: {}, a: {} });
  c.cardSetOk = okSet; c.cardAnswers = JSON.stringify(st.answers || {});
  const sr = FC.submitStep(spec, st);
  R.info.cardSim = { okSet, answers: c.cardAnswers, submit: sr && sr.ok, done: sr && sr.done };
  fa._chatRunner(c.cctx)._cardFinish(msg);
  return sr && sr.ok ? 'ok' : 'submit-' + JSON.stringify(sr && sr.errors || '');
}

const cases = [];
for (const kind of KINDS) for (const path of ['root', 'child']) cases.push({ kind, path });

let n = 0;
for (const cs of cases) {
  n++;
  const tag = cs.kind.k + '_' + cs.path + '_' + n;
  const c = await mkCase(tag);
  const parentCtx = c.pctx;
  fa._chatActivate(parentCtx); fa._renderMessageHistory();
  const cr = fa._chatRunner(c.cctx);
  const asked = safe(() => cs.kind.ask(cr, tag)); if (asked && asked.__err) R.info['ask_' + tag] = asked.__err;
  const waiting = await waitFor(() => safe(() => fa._subchatPendingMap().has(c.kid)) === true, 5000);
  const K = cs.kind.k + '_' + cs.path;
  R.checks[K + '_pending'] = waiting;
  if (!waiting) continue;
  if (cs.path === 'root') {
    // 在父對話（根）回答；子對話不在畫面上
    const r = cs.kind.root(c.kid);
    R.info[K + '_rootReturn'] = safe(() => (r && r.ok === false) ? r.error : (r && r.ok) ? 'ok' : JSON.stringify(r));
  } else {
    // 切到子對話，在那裡回答
    await fa._chatSwitch(c.kid);
    await sleep(300);
    const how = childAnswer(cs.kind, c);
    R.info[K + '_childHow'] = how;
    await waitFor(() => !!safe(() => lastQA(c.kid)) && lastQA(c.kid) !== null, 4000);
    await sleep(800);
    await fa._chatSwitch(c.pid);
  }
  await waitFor(() => entryOf(c.kid).status !== 'waiting_user', 5000);
  if (cs.path === 'child') {
    // 診斷：子對話回答後，快取裡父對話的連結有沒有問答紀錄（不切換畫面）
    await sleep(900);
    R.info[K + '_probe'] = safe(() => { const cc = fa._chatCtxs.get(c.pid); const l = cc && (cc.messages || []).find((x) => x && x._subchatLink && x._subchatLink.childId === c.kid); return { ctxInCache: !!cc, linkFound: !!l, qaLen: l && l._subchatLink.qa ? l._subchatLink.qa.length : -1, ctxIsActive: cc === fa._activeCtx, curId: fa._chatIndex.currentId }; });
  }
  await sleep(500);
  // 用快取裡的父對話（開頭那份 parentCtx 可能已被換掉，不能再拿來覆蓋）
  fa._chatActivate(fa._chatCtxs.get(c.pid) || parentCtx); fa._renderMessageHistory();
  await sleep(300);
  const last = lastQA(c.kid);
  R.checks[K + '_answered'] = entryOf(c.kid).status !== 'waiting_user' && !safe(() => fa._subchatPendingMap().has(c.kid));
  R.checks[K + '_qaRecorded'] = !!last && last.kind === (cs.kind.k === 'fields' ? 'form' : cs.kind.k) && last.where === cs.path && String(last.a).indexOf(cs.kind.answerText) >= 0;
  R.checks[K + '_rootShowsQA'] = qaText(c.kid).indexOf(cs.kind.q) >= 0 && qaText(c.kid).indexOf(cs.path === 'root' ? '在根對話回答' : '在子對話回答') >= 0;
  R.checks[K + '_rootNoAnswerField'] = answerBtns(c.kid).length === 0;
  // 存檔後重讀仍在
  let raw = null; try { raw = await fa._chatBackend().read(c.pid); } catch (_) { raw = null; }
  R.checks[K + '_savedQA'] = !!raw && String(raw).indexOf('"where":"' + cs.path + '"') >= 0 && String(raw).indexOf(cs.kind.q) >= 0;
  R.info[K + '_qa'] = safe(() => fa._subchatQAFor(c.kid));
  R.info[K + '_dbg'] = safe(() => {
    const cached = fa._chatCtxs.get(c.pid);
    const cl = cached && (cached.messages || []).find((x) => x && x._subchatLink && x._subchatLink.childId === c.kid);
    const act = (fa.messages || []).find((x) => x && x._subchatLink && x._subchatLink.childId === c.kid);
    return { cur: fa._chatIndex.currentId, ctx: fa._ctx && fa._ctx.id, pid: c.pid, cachedSame: cached === c.pctx, cachedQA: cl && cl._subchatLink.qa ? cl._subchatLink.qa.length : -1, activeQA: act && act._subchatLink.qa ? act._subchatLink.qa.length : -1, hasLinkEl: !!linkEl(c.kid) };
  });
}

// 上限：同一子對話加 25 筆，只留最近 20 筆，最後一筆是最新的
{
  const c = await mkCase('cap');
  fa._chatActivate(c.pctx); fa._renderMessageHistory();
  for (let i = 0; i < 25; i++) await safe(() => fa._subchatQARecord(c.kid, { kind: 'card', q: 'q' + i, where: 'child', a: 'a' + i }));
  await sleep(300);
  const q = safe(() => fa._subchatQAFor(c.kid));
  R.checks.capAt20 = Array.isArray(q) && q.length === 20;
  R.checks.capNewest = Array.isArray(q) && q.length && q[q.length - 1].a === 'a24';
}

// 載入來源：工作目錄的實作（修後才有的標記字串）
R.checks.loadedWorkdirImpl = String(fa._subchatLinkDecorate || '').indexOf('fa-subchat-qa') >= 0;

window.fetch = realFetch;
R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
