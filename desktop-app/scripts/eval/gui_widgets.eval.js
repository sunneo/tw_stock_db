// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17934 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
// 新元件在真 Electron 模擬器實跑：分頁（tabs）、分割（split）、選單列（menubar／menu／menuitem，含快捷鍵提示）、對話框（confirm）。
const fa = window.fa;
const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒好 */ } await wait(150); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };
const t = await fa._createTerminalForAI({ name: 'widgets-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
const put = (name, text) => fa._writeBytesToTerminalFs(fsStore, '/work/' + name, new TextEncoder().encode(text));
const cnt = (re) => (termText(session).match(re) || []).length;
const wins = () => Array.from(document.querySelectorAll('.gui-window[data-window]'));
const winByTitle = (re) => wins().find((w) => re.test((w.querySelector('.gui-titlebar') || {}).textContent || ''));

put('widgets.py', [
  'import gui',
  'w = gui.Window("元件測試", width=500)',
  'mb = w.menubar()',
  'm = w.menu("檔案", mb)',
  'mi = w.menuitem("存檔", m, keys="Ctrl+S")',
  'sp = w.split("row", 30)',
  'w.label("左欄", parent=sp)',
  'w.label("右欄", parent=sp)',
  'tb = w.tabs()',
  'p1 = w.tab("一", tb)',
  'p2 = w.tab("二", tb)',
  'w.label("第一頁內容", parent=p1)',
  'w.label("第二頁內容", parent=p2)',
  'w.shortcut("Ctrl+S", "save")',
  'seen = 0',
  'while seen < 2:',
  '    ev = w.poll()',
  '    if ev is None:',
  '        import time',
  '        time.sleep(0.05)',
  '        continue',
  '    if ev["event"] == "select":',
  '        print("TAB-IS-PAGE2=" + str(w.value(tb) == p2))',
  '        seen += 1',
  '    elif ev["event"] == "click" and ev["node"] == mi:',
  '        print("CONFIRM=" + str(gui.confirm("確定存檔？", title="確認存檔", yes="是", no="否")))',
  '        seen += 1',
  '    elif ev["event"] == "close":',
  '        break',
  'w.close()',
  'print("WIDGETS-END")', ''
].join('\n'));
let done = false;
fa._runTerminalCommand(session, 'python3 widgets.py').then(() => { done = true; }, () => { done = true; });
await until(() => winByTitle(/元件測試/), 25000);
await wait(1500);
const W = () => winByTitle(/元件測試/);
const w0 = W();
R.menubar = !!w0.querySelector('.gui-menubar .gui-menu summary');
R.menuitem_text = (w0.querySelector('.gui-menuitem') || {}).textContent;
const split = w0.querySelector('.gui-split');
R.split = split ? { display: split.style.display, first: split.children[0].style.flex } : null;
const bar = w0.querySelector('.gui-tabbar');
R.tab_buttons = bar ? Array.from(bar.children).map((b) => b.textContent) : null;
const pages = () => Array.from(W().querySelectorAll('.gui-tab')).map((p) => p.hidden);
R.pages_before = pages();
Array.from(W().querySelector('.gui-tabbar').children).find((b) => b.textContent === '二').click();
await wait(600);
R.pages_after = pages();
// 選單項目：點下去 → Python 彈出確認對話框 → 點「是」
W().querySelector('.gui-menuitem').click();
const dlg = await until(() => winByTitle(/確認存檔/), 15000);
R.dialog_opened = !!dlg;
if (dlg) { await wait(800); const yes = Array.from(winByTitle(/確認存檔/).querySelectorAll('.gui-button')).find((b) => b.textContent.trim() === '是'); if (yes) yes.click(); }
await until(() => done, 20000);
await until(() => cnt(/WIDGETS-END/g) > 0, 8000);
R.tab_value_seen = cnt(/TAB-IS-PAGE2=True/g) > 0;
R.confirm_true = cnt(/CONFIRM=True/g) > 0;
R.ended = cnt(/WIDGETS-END/g) > 0;
R.traceback = cnt(/Traceback/g);
R.all_ok = !!(R.menubar && /存檔/.test(R.menuitem_text || '') && /Ctrl\+S/.test(R.menuitem_text || '') && R.split && R.split.display === 'flex' && R.tab_buttons && R.tab_buttons.length === 2
  && R.pages_before[0] === false && R.pages_before[1] === true && R.pages_after[0] === true && R.pages_after[1] === false
  && R.dialog_opened && R.tab_value_seen && R.confirm_true && R.ended && !R.traceback);
return R;
