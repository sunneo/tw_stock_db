// 子對話 S8 步驟 F（ask_user_card 只在父對話）真實桌面版評估。
// 使用者 2026-11-04 原話：「ask_user_card只在parent」。
// 檢查：
//   - 根層級：ask_user_card 回到 registerOptional（domain-gated）註冊，沒有啟用領域的父對話工具清單不含它（與 d12293d1^ 一致）。
//   - 父對話經由領域取得：根對話的領域工具清單含 ask_user_card（只在 parent）。
//   - 子對話：根層級清單、領域委派清單都不含 ask_user_card。
//   - 子對話呼叫它：ok:false，訊息說明提問由根對話負責（工具實作擋下；不論經由哪條路徑取得）。
//   - 工具實作的來源是工作目錄的版本（字串常值「提問由根對話負責」）。
// 結果以 [eval-file] result 輸出。
// 用法：node scripts/eval/run_eval.js scripts/eval/subchat_no_ask.eval.js 17966
const fa = window.fa;
const R = { checks: {}, info: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (fn) => { try { return fn(); } catch (e) { return { __err: String((e && e.message) || e) }; } };

fa.advancedSettings.offlineMode = false;
fa.advancedSettings.topicShiftCheck = false;

// 建立父 P 與子 K（子對話不必跑模型，只要有 parentId）
const now = Date.now();
const pid = 'noask_p', kid = 'noask_k';
fa._chatIndex.chats.push({ id: pid, title: 'NA-P', groupId: null, createdAt: now, updatedAt: now });
fa._chatIndex.chats.push({ id: kid, title: 'NA-K', groupId: null, createdAt: now, updatedAt: now, parentId: pid, status: 'done', fingerprint: { kw: ['NA-K'] } });
const pctx = await fa._chatCtxLoad(pid); fa._chatCtxs.set(pid, pctx);
const cctx = await fa._chatCtxLoad(kid); fa._chatCtxs.set(kid, cctx);
await sleep(300);
const cr = fa._chatRunner(cctx);
const pr = fa._chatRunner(pctx);

// 根層級清單（沒有子對話、沒有領域啟用）
const rootNames = safe(() => fa._getRootToolNames()) || [];
R.checks.rootListNoAsk = Array.isArray(rootNames) && rootNames.indexOf('ask_user_card') < 0;
R.checks.gatedRegistration = safe(() => fa._domainGatedToolNames.has('ask_user_card')) === true;

// 領域：找出有 ask_user_card 的領域（父對話路徑）
const dk = safe(() => Object.keys(fa.domains).find((k) => { const t = fa.domains[k] && fa.domains[k].toolNames; return Array.isArray(t) && t.indexOf("ask_user_card") >= 0; }));
R.info.domainKey = dk;
const dom = dk ? fa.domains[dk] : null;
const parentDomainNames = safe(() => pr._resolveDomainToolNames(dom)) || [];
const childDomainNames = safe(() => cr._resolveDomainToolNames(dom)) || [];
R.checks.parentDomainHasAsk = !!dom && Array.isArray(parentDomainNames) && parentDomainNames.indexOf('ask_user_card') >= 0;
R.checks.childDomainNoAsk = !!dom && Array.isArray(childDomainNames) && childDomainNames.indexOf('ask_user_card') < 0;

// 子對話根層級清單（子對話的模型看到的清單）
const childNames = safe(() => cr._getRootToolNames()) || [];
R.checks.childListNoAsk = Array.isArray(childNames) && childNames.indexOf('ask_user_card') < 0;

// 子對話呼叫 ask_user_card：工具實作擋下，回 ok:false（用 race 防止等待使用者造成卡住）
const tool = fa.tools && fa.tools.ask_user_card;
R.checks.toolExists = !!tool;
let callRes = null;
if (tool) {
  const raw = JSON.stringify({ title: '選色', questions: [{ id: 'c', type: 'text', label: '色' }] });
  callRes = await Promise.race([
    Promise.resolve().then(() => tool.callback.call(cr, raw)).then((x) => x, (e) => ({ __err: String((e && e.message) || e) })),
    sleep(4000).then(() => ({ __timeout: true })),
  ]);
}
R.info.childCallRes = typeof callRes === 'string' ? callRes.slice(0, 200) : JSON.stringify(callRes).slice(0, 200);
let parsed = null; try { parsed = typeof callRes === 'string' ? JSON.parse(callRes) : null; } catch (_) { parsed = null; }
R.checks.childCallNotOk = !!parsed && parsed.ok === false;
R.checks.childCallExplains = !!parsed && /子對話/.test(String(parsed.error || '')) && /根對話/.test(String(parsed.error || ''));
// 擋下之後不能留下卡片（不在子對話、也不在父對話）
R.checks.noCardLeft = !(cctx.messages || []).some((m) => m && m._card) && !(pctx.messages || []).some((m) => m && m._card);

// 載入來源：工作目錄的實作（修後才有的字串常值）
R.checks.loadedWorkdirImpl = !!parsed && String(parsed.error || '').indexOf('提問由根對話負責') >= 0; // 行為驗證：這句只在工作目錄的實作裡

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
