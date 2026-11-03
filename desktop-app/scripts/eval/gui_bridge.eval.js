// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_BROWSER_CONTROL_PORT=17931 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
// 在真的渲染頁裡執行（可用fa與DOM）：建立終端機→執行 zenity --entry --text=hi→模擬使用者在視窗主機的輸入框打字並點確定→讀回終端機輸出。
// 結果以 [eval-file] result 輸出；這裡回傳的物件就是驗證結果。
const fa = window.fa;
const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒就緒 */ } await wait(150); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };

const t = await fa._createTerminalForAI({ name: 'zenity-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
R.terminal_mounted = !!session;
await wait(800);

// 先不 await：zenity 會等使用者回答
let runDone = false; let runErr = null;
const runP = fa._runTerminalCommand(session, 'zenity --entry --text=hi').then(() => { runDone = true; }, (e) => { runErr = String((e && e.message) || e); runDone = true; });

// 等視窗主機把視窗畫出來
const win = await until(() => document.querySelector('.gui-window[data-window] .gui-entry'));
R.window_rendered = !!win;
const winEl = win && win.closest('.gui-window');
R.window_title = winEl && (winEl.querySelector('.gui-titlebar') || {}).textContent;
R.button_labels = winEl ? Array.from(winEl.querySelectorAll('.gui-button')).map((b) => b.textContent.trim()) : [];

// 模擬使用者：在輸入框打字，再按確定
if (win) {
  win.focus();
  win.value = 'Alice';
  win.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(200);
  const okBtn = Array.from(winEl.querySelectorAll('.gui-button')).find((b) => /^(OK|確定|好)$/i.test(b.textContent.trim())) || winEl.querySelector('.gui-button');
  R.clicked_button = okBtn ? okBtn.textContent.trim() : null;
  if (okBtn) okBtn.click();
}

// 等指令結束（zenity 關閉後 runP 完成）
await until(() => runDone, 15000);
R.run_finished = runDone;
R.run_error = runErr;
R.window_closed = !document.querySelector('.gui-window[data-window] .gui-entry');

// 讀回終端機：答案應該印在終端機裡
const text = termText(session);
R.answer_on_terminal = /Alice/.test(text);
R.terminal_tail = text.split('\n').filter((l) => l.trim()).slice(-8);

fa._persistChatHistory && fa._persistChatHistory();
return R;
