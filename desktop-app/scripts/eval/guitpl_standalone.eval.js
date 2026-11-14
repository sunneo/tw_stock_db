// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17935 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
// 編譯成單一 Python 檔在真 Electron 模擬器實跑：對十三個領域的 main，用 gui_template_compose（standalone）產生的程式寫出 <領域>_app.py，
// 然後直接 python3 執行那個檔（不經過 guitpl 的 jsonl 檔案）：開窗、點每個按鈕、關窗、沒有錯誤輸出。
const fa = window.fa;
const R = { apps: {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒好 */ } await wait(150); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };
const t = await fa._createTerminalForAI({ name: 'standalone-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
const put = (name, text) => fa._writeBytesToTerminalFs(fsStore, '/work/' + name, new TextEncoder().encode(text));
const cnt = (re) => (termText(session).match(re) || []).length;

const find = JSON.parse(await fa.tools.gui_template_find.callback(JSON.stringify({ query: '待辦', limit: 1 })));
R.found = find.candidates.map((c) => c.id);
const ids = ['beauty', 'document', 'game', 'idphoto', 'image', 'inventory', 'media', 'midi', 'office', 'project', 'slides', 'text-editor', 'web-design'].map((d) => d + '/main');
for (const id of ids) {
  const r = { generated: false };
  R.apps[id] = r;
  const out = id.replace('/', '_') + '_app.py';
  const c = JSON.parse(await fa.tools.gui_template_compose.callback(JSON.stringify({ id, standalone: true, output: out })));
  if (!c.ok) { r.error = (c.errors || []).join(); continue; }
  put('gen.py', c.code);
  const g0 = cnt(/已寫出單一檔案程式/g);
  await fa._runTerminalCommand(session, 'python3 gen.py');
  await until(() => cnt(/已寫出單一檔案程式/g) > g0, 15000);
  r.generated = cnt(/已寫出單一檔案程式/g) > g0;
  if (!r.generated) r.tail = termText(session).replace(/\n+/g, '\n').slice(-700);
  if (!r.generated) continue;
  // 把產生的檔案複製成沒有任何範本檔案可用的情況：直接執行它（它只依賴 gui）
  const e0 = cnt(/APP-END/g);
  put('run_app.py', 'import gui\nimport runpy\nrunpy.run_path(' + JSON.stringify('/work/' + out) + ', run_name="__main__")\nprint("APP-END")\n');
  let done = false;
  fa._runTerminalCommand(session, 'python3 run_app.py').then(() => { done = true; }, () => { done = true; });
  const el = await until(() => document.querySelector('.gui-window[data-window] .gui-button, .gui-window[data-window] .gui-label'), 25000);
  r.window_rendered = !!el;
  await wait(1200);
  const winEl = (el && el.closest('.gui-window')) || document.querySelector('.gui-window[data-window]');
  const buttons = winEl ? Array.from(winEl.querySelectorAll('.gui-button')) : [];
  r.buttons = buttons.length;
  for (const b of buttons) { if (document.body.contains(b)) { b.click(); await wait(250); } }
  const closeBtn = document.querySelector('.gui-window[data-window] .gui-close');
  if (closeBtn) closeBtn.click();
  await until(() => done, 20000);
  await until(() => cnt(/APP-END/g) > e0, 8000);
  r.ended = cnt(/APP-END/g) > e0;
  r.ok = r.window_rendered && r.ended;
}
R.traceback = cnt(/Traceback/g);
R.failed = ids.filter((i) => !(R.apps[i] && R.apps[i].ok));
R.all_ok = R.failed.length === 0 && !R.traceback;
return R;
