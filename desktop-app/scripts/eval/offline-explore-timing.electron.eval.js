// 真桌面版量「離線探索」每一步的實際耗時（用法：FA_DISABLE_MAIN_OVERLAY=1 FA_DEBUG_EVAL_FILE=<本檔> FA_BROWSER_CONTROL_PORT=17951 electron . --no-sandbox --disable-gpu --user-data-dir=<全新資料夾>；絕不用 17923）
// 回傳：知識庫查詢、模型載入檢查、整段探索（問使用者那步自動回「不回答」）各花幾毫秒，以及卡片上的過程文字。
const fa = window.fa; fa.advancedSettings.offlineMode = true;
const T = window.__evalText || '把那份財報叫出來 [附件：q1（file_id=f1）]';
const out = { loaded: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)) };
const time = async (name, fn) => { const t = Date.now(); let r, err = null; try { r = await fn(); } catch (e) { err = String((e && e.message) || e).slice(0, 80); } out[name] = { ms: Date.now() - t, err, r: r === undefined ? null : r }; };
await time('knowledge_ask', async () => { if (!fa.tools.knowledge_ask) return 'no-tool'; const j = JSON.parse(await fa.tools.knowledge_ask.callback.call(fa, JSON.stringify({ question: '財報', limit: 3 }))); return Object.keys(j || {}).join(','); });
await time('omInstalled', async () => { const i = await fa._omInstalled(); return Array.from(i.set).join(',') || 'none'; });
await time('gateModel', async () => { const m = await fa._otGateModel(); return m ? (m.modelId || 'injected') : null; });
fa.requestUserForm = async () => null;
const runOnce = async (label) => { const plan = { text: T, slots: {}, decision: { status: 'no_match', chosen: null } }; const ga = fa._otGateApply(plan, T); const t = Date.now(); let ok = null; try { ok = await fa._otGateExplore(ga.plan, T); } catch (e) { ok = 'error ' + e.message; } out[label] = { ms: Date.now() - t, ok, trace: (ga.plan.gate.trace || []) }; };
await runOnce('explore_withModel');
const keep = fa._omInstalled; fa._omInstalled = async () => ({ usage: {}, set: new Set() });
await runOnce('explore_noModel');
fa._omInstalled = keep;
return out;
