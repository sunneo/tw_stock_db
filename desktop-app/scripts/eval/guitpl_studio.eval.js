// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17933 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
// 設計工作室在真 Electron 模擬器實跑：開工作室 → 改配色與標題 → 預覽（真的開第二個視窗）→ 分鏡 → 存成我的範本 → 關閉；
// 檢查 localStorage 存了 user/ 範本、gui_template_find 找得到它並標 user、之後 python3 用 guitpl.run("user/...") 能開窗。
const fa = window.fa;
const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒好 */ } await wait(150); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };
try { localStorage.removeItem('fa_gui_user_templates'); } catch (_) { /* 沒有就算了 */ }

const t = await fa._createTerminalForAI({ name: 'guitpl-studio-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
const put = (name, text) => fa._writeBytesToTerminalFs(fsStore, '/work/' + name, new TextEncoder().encode(text));
const cnt = (re) => (termText(session).match(re) || []).length;
const wins = () => Array.from(document.querySelectorAll('.gui-window[data-window]'));
const winByTitle = (re) => wins().find((w) => re.test((w.querySelector('.gui-titlebar') || {}).textContent || ''));
const btn = (w, text) => Array.from(w.querySelectorAll('.gui-button')).find((b) => b.textContent.trim() === text);
const setEntry = (w, idx, value) => { const inputs = Array.from(w.querySelectorAll('input')); const el = inputs[idx]; el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };

put('studio_run.py', 'import gui\nimport guitpl\nguitpl.studio("office/main")\nprint("STUDIO-END")\n');
const before = cnt(/STUDIO-END/g);
let done = false;
fa._runTerminalCommand(session, 'python3 studio_run.py').then(() => { done = true; }, () => { done = true; });
await until(() => winByTitle(/設計工作室/), 25000);
const SW = () => winByTitle(/設計工作室/);
const studioWin = SW();
R.studio_opened = !!studioWin;
await wait(1500);
if (studioWin) {
  const inputs = Array.from(SW().querySelectorAll('input'));
  R.input_count = inputs.length;
  // 第 0、1 個是參數（title、owner）；接著五個配色
  setEntry(SW(), 0, '工作室測試清單');
  setEntry(SW(), 2, '#102030');
  await wait(400);
  btn(SW(), '預覽').click();
  const pw = await until(() => winByTitle(/工作室測試清單/), 15000);
  R.preview_opened = !!pw;
  R.preview_bg = pw ? (pw.style.background || pw.style.backgroundColor || getComputedStyle(pw).backgroundColor) : null;
  await wait(500);
  btn(SW(), '分鏡').click();
  await wait(500);
  R.storyboard_shown = !!Array.from(SW().querySelectorAll("textarea")).find((x) => /分鏡：/.test(x.value));
  btn(SW(), '存成我的範本').click();
  await wait(1200);
  const saved = JSON.parse(localStorage.getItem('fa_gui_user_templates') || '{}');
  R.saved_ids = Object.keys(saved);
  R.saved_jsonl = (saved['user/my_main'] || {}).jsonl;
  const close = SW().querySelector('.gui-close');
  if (close) close.click();
  await until(() => done, 20000);
  await until(() => cnt(/STUDIO-END/g) > before, 8000);
  R.studio_ended = cnt(/STUDIO-END/g) > before;
  R.windows_left = wins().length;
  wins().forEach((w) => { const c = w.querySelector('.gui-close'); if (c) c.click(); });
}
// 工具找得到使用者範本
const f = JSON.parse(await fa.tools.gui_template_find.callback(JSON.stringify({ query: '我的待辦清單' })));
R.find_top = f.candidates.slice(0, 2).map((c) => [c.id, c.user]);
// 用使用者範本組合並實跑（含從頁面讀我的範本進 Python 的路徑）
const c = JSON.parse(await fa.tools.gui_template_compose.callback(JSON.stringify({ id: 'user/my_main' })));
R.compose_ok = c.ok;
if (c.ok) {
  put('mine_run.py', 'import gui\nimport guitpl\nguitpl.run("user/my_main")\nprint("MINE-END")\n');
  const b2 = cnt(/MINE-END/g);
  let d2 = false;
  fa._runTerminalCommand(session, 'python3 mine_run.py').then(() => { d2 = true; }, () => { d2 = true; });
  const mw = await until(() => winByTitle(/工作室測試清單/), 25000);
  R.mine_opened = !!mw;
  await wait(800);
  const cl = mw && mw.querySelector('.gui-close');
  if (cl) cl.click();
  await until(() => d2, 15000);
  await until(() => cnt(/MINE-END/g) > b2, 8000);
  R.mine_end = cnt(/MINE-END/g) > b2;
}
R.traceback = cnt(/Traceback/g);
R.all_ok = !!(R.studio_opened && R.preview_opened && R.storyboard_shown && R.saved_ids && R.saved_ids.indexOf('user/my_main') >= 0 && R.studio_ended && R.compose_ok && R.mine_opened && R.mine_end && !R.traceback && R.find_top[0] && R.find_top[0][0] === 'user/my_main');
return R;
