// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17931 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
// 在真的渲染頁裡：建立終端機→把 PROGRAM 寫進 /work→在終端機執行 python3（會走 Worker 路徑，因為含 import gui）→
// 模擬使用者（在視窗主機的輸入框填值、點按鈕）→讀回終端機輸出與視窗狀態。結果以 [eval-file] result 輸出。
// FILES 是要一起放進 /work 的檔案（base64），missile 範例用來放貼圖。
const PROGRAM = `import gui
w = gui.Window("hello", width=300)
w.label("你好 Python")
name = w.entry("Alice")
ok = w.button("OK")
while True:
    ev = w.wait(timeout=60)
    if ev is None or ev["event"] == "close" or ev["node"] == ok:
        break
print("answer: " + str(w.value(name)))
w.close()
print("done")
`;
const FILES = {};
const PROGRAM_NAME = 'gui_test.py';
const ACTIONS = [
  { type: 'entry', value: 'Alice' },
  { type: 'click', text: 'OK' },
];
const fa = window.fa;
const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒就緒 */ } await wait(150); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };
R.loaded = {
  scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)),
  has_py_worker: typeof fa._terminalRunPythonWorker === 'function',
  has_py_gui: typeof fa._pyBridgeGui === 'function',
  has_py_async_route: typeof fa._terminalTryPythonAsync === 'function',
};

const t = await fa._createTerminalForAI({ name: 'gui-py-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
R.terminal_mounted = !!session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
fa._writeBytesToTerminalFs(fsStore, '/work/' + PROGRAM_NAME, new TextEncoder().encode(PROGRAM));
for (const name of Object.keys(FILES)) {
  const bin = atob(FILES[name]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  fa._writeBytesToTerminalFs(fsStore, '/work/' + name, bytes);
}
R.cwd = session.cwd;

let runDone = false; let runErr = null;
const runP = fa._runTerminalCommand(session, 'python3 ' + PROGRAM_NAME).then(() => { runDone = true; }, (e) => { runErr = String((e && e.message) || e); runDone = true; });

const win = await until(() => document.querySelector('.gui-window[data-window] .gui-entry, .gui-window[data-window] .gui-button'));
R.window_rendered = !!win;
const winEl = win && win.closest('.gui-window');
R.window_title = winEl && (winEl.querySelector('.gui-titlebar') || {}).textContent;
R.button_labels_at_open = winEl ? Array.from(winEl.querySelectorAll('.gui-button')).map((b) => b.textContent.trim()) : [];

// 模擬使用者：依序做 ACTIONS（填值、點按鈕）；按鈕找不到就記下來
R.actions = [];
for (const a of ACTIONS) {
  const el = document.querySelector('.gui-window[data-window]');
  if (!el) { R.actions.push({ type: a.type, error: 'no window' }); break; }
  if (a.type === 'entry') {
    const input = el.querySelector('.gui-entry');
    if (input) { input.focus(); input.value = a.value; input.dispatchEvent(new Event('input', { bubbles: true })); }
    R.actions.push({ type: 'entry', ok: !!input });
  } else if (a.type === 'click') {
    const btn = Array.from(el.querySelectorAll('.gui-button')).find((b) => b.textContent.trim() === a.text);
    if (btn) btn.click();
    R.actions.push({ type: 'click', text: a.text, ok: !!btn });
  }
  await wait(400);
}

await until(() => runDone, 20000);
R.run_finished = runDone;
R.run_error = runErr;
R.window_closed = !document.querySelector('.gui-window[data-window]');
R.last_exit_code = session.lastExitCode;
const text = termText(session);
R.answer_on_terminal = /answer: Alice/.test(text);
R.done_on_terminal = /done/.test(text);
R.terminal_tail = text.split('\n').filter((l) => l.trim()).slice(-12);
return R;
