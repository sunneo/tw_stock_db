// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17932 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
// 驗證宿主工具 gui_template_find／gui_template_compose：找範本 → 組合 → 產出的程式在模擬器終端機（Worker 路徑）真的開窗、點按鈕、關窗；
// 再用模型自寫的 jsonl（沒有 py）走同一條路。
const fa = window.fa;
const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒好 */ } await wait(150); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };

R.tools = { find: !!fa.tools.gui_template_find, compose: !!fa.tools.gui_template_compose };
const call = async (name, args) => JSON.parse(await fa.tools[name].callback(JSON.stringify(args)));
const f = await call('gui_template_find', { query: '幫我做一個待辦清單' });
R.find = { status: f.status, top: f.candidates.slice(0, 3).map((c) => c.id), questions: (f.candidates[0] || {}).questions };
const c = await call('gui_template_compose', { id: f.candidates[0].id, params: { title: '工具測試清單' } });
R.compose = { ok: c.ok, id: c.id, defaulted: c.defaulted, scenes: (c.scenes || []).map((s) => s.id) };

const t = await fa._createTerminalForAI({ name: 'guitpl-ai-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
const put = (name, text) => fa._writeBytesToTerminalFs(fsStore, '/work/' + name, new TextEncoder().encode(text));

async function runCode(label, code) {
  const r = { window_rendered: false };
  R[label] = r;
  const cnt = (re) => (termText(session).match(re) || []).length;
  const endBefore = cnt(/RUN-END/g);
  put('ai_run.py', 'import gui\n' + code + 'print("RUN-END")\n');
  let done = false;
  fa._runTerminalCommand(session, 'python3 ai_run.py').then(() => { done = true; }, () => { done = true; });
  const el = await until(() => document.querySelector('.gui-window[data-window] .gui-button, .gui-window[data-window] .gui-label'), 25000);
  r.window_rendered = !!el;
  await wait(1200);
  const winEl = (el && el.closest('.gui-window')) || document.querySelector('.gui-window[data-window]');
  r.title = winEl && (winEl.querySelector('.gui-titlebar') || {}).textContent;
  const buttons = winEl ? Array.from(winEl.querySelectorAll('.gui-button')) : [];
  r.buttons = buttons.length;
  for (const b of buttons) { if (document.body.contains(b)) { b.click(); await wait(250); } }
  const closeBtn = document.querySelector('.gui-window[data-window] .gui-close');
  if (closeBtn) closeBtn.click();
  await until(() => done, 20000);
  await until(() => cnt(/RUN-END/g) > endBefore, 10000);
  const out = termText(session);
  r.traceback = (out.match(/Traceback/g) || []).length > (R._tb || 0) ? out.slice(-600) : ''; R._tb = (out.match(/Traceback/g) || []).length;
  r.run_end = cnt(/RUN-END/g) > endBefore;
  r.tail = out.slice(-300);
  r.ok = r.window_rendered && done && r.run_end && !r.traceback;
}
await runCode('run_template', c.code);

const custom = [
  '{"kind":"meta","id":"user/hello","title":"打招呼","keywords":["招呼"],"standalone":true}',
  '{"kind":"param","name":"who","default":"世界","ask":"跟誰打招呼？"}',
  '{"kind":"require","module":"gui","source":"builtin"}',
  '{"kind":"layout","window":{"title":"招呼視窗","width":300},"tree":[{"kind":"column","children":[{"id":"t","kind":"label","text":"哈囉 {{who}}"},{"id":"b","kind":"button","text":"好"}]}]}'
].join('\n');
const c2 = await call('gui_template_compose', { name: 'user/hello', jsonl: custom, params: { who: '你' } });
R.compose_custom = { ok: c2.ok, errors: c2.errors };
if (c2.ok) { await runCode('run_custom', c2.code); }
R.all_ok = !!(R.run_template && R.run_template.ok && R.run_custom && R.run_custom.ok);
return R;
