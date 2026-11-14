// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17931 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
// GUI 範本在 Python 模擬器（真 Electron 的終端機 python3，走 Worker 路徑）裡實跑：
//   1. 在模擬器裡 import guitpl，列出 guitpl.catalog() 的 standalone 範本代號（證明範本庫與框架都在模擬器的檔案系統裡）；
//   2. 對每個 standalone 範本：python3 執行 guitpl.run(代號)→等視窗→點每個按鈕一次→關視窗→讀終端機輸出（有沒有 Traceback、[guitpl] 外部呼叫錯誤）。
// 結果以 [eval-file] result 輸出：R.templates[代號] = {window_rendered, buttons, clicked, closed, traceback, guitpl_errors}。
const fa = window.fa;
const R = { templates: {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒就緒 */ } await wait(150); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };

const t = await fa._createTerminalForAI({ name: 'guitpl-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
R.terminal_mounted = !!session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
const put = (name, text) => fa._writeBytesToTerminalFs(fsStore, '/work/' + name, new TextEncoder().encode(text));

// 1. 目錄
put('catalog.py', 'import guitpl\nids = [e["id"] for e in guitpl.catalog() if e["standalone"]]\nprint("IDS=" + ",".join(ids))\nprint("ALL=%d" % len(guitpl.catalog()))\n');
await fa._runTerminalCommand(session, 'python3 catalog.py');
const txt = termText(session);
const m = /IDS=([^\n\r]*)/.exec(txt);
R.catalog_output_tail = txt.split('\n').slice(-6).join('\n');
// 變體（main_dark 等）只是覆寫 style 與參數，這裡只實跑每個領域的 main（變體由本機 lint 檢查）
R.all_standalone = m && m[1] ? m[1].split(',').filter(Boolean) : [];
const ids = R.all_standalone.filter((i) => /\/main$/.test(i));
R.standalone_ids = ids;

// 2. 逐個範本
for (const id of ids) {
  const r = { window_rendered: false };
  R.templates[id] = r;
  const before = termText(session).length;
  put('run_one.py', 'import guitpl\nguitpl.run(' + JSON.stringify(id) + ')\nprint("RUN-END")\n');
  let done = false;
  const p = fa._runTerminalCommand(session, 'python3 run_one.py').then(() => { done = true; }, () => { done = true; });
  const el = await until(() => document.querySelector('.gui-window[data-window] .gui-button, .gui-window[data-window] .gui-label'), 20000);
  r.window_rendered = !!el;
  const winEl = el && el.closest('.gui-window');
  r.title = winEl && (winEl.querySelector('.gui-titlebar') || {}).textContent;
  const buttons = winEl ? Array.from(winEl.querySelectorAll('.gui-button')) : [];
  r.buttons = buttons.map((b) => b.textContent.trim());
  r.clicked = 0;
  for (const b of buttons) {
    if (!document.body.contains(b)) continue;
    b.click();
    r.clicked++;
    await wait(300);
  }
  const closeBtn = document.querySelector('.gui-window[data-window] .gui-close');
  if (closeBtn) closeBtn.click();
  await until(() => done, 20000);
  r.finished = done;
  const out = termText(session).slice(before);
  r.traceback = /Traceback/.test(out) ? out.slice(out.indexOf('Traceback')).slice(0, 600) : '';
  r.guitpl_errors = (out.match(/\[guitpl\][^\n\r]*/g) || []).slice(0, 5);
  r.run_end = /RUN-END/.test(out);
  r.closed = !document.querySelector('.gui-window[data-window]');
  r.ok = r.window_rendered && r.finished && r.run_end && !r.traceback && r.closed;
  await wait(300);
}
R.passed = ids.filter((i) => R.templates[i].ok);
R.failed = ids.filter((i) => !R.templates[i].ok);
return R;
