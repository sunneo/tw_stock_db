// 用法同 gui_py_worker.eval.js。shell 腳本用 echo '@gui {...}' 開視窗（@gui 行不顯示），gui wait 等按鈕事件並存進變數；另測 --timeout 超時 exit 124。
const fa = window.fa;
const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒就緒 */ } await wait(100); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };
R.loaded = { scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)), has_gui_cmd: typeof fa._terminalGui === 'function' };
const t = await fa._createTerminalForAI({ name: 'gui-shell-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
const script = [
  `echo '@gui {"v":1,"op":"open","id":"w1","title":"T","width":300}'`,
  `echo '@gui {"v":1,"op":"add","id":"w1","parent":"root","node":{"id":"b1","kind":"button","text":"GO"}}'`,
  `echo before`,
  `gui wait w1 EV`,
  `echo "got:$EV"`,
  `gui wait w1 --timeout 1 EV2`,
  `gui wait w1 --timeout 1 EV3 || echo timedout`,
].join('\n');
const done = fa._terminalRunShellText(session, script, { streamToWidget: true });
const btn = await until(() => Array.from(document.querySelectorAll('.gui-window[data-window="w1"] .gui-button')).find((b) => b.textContent === 'GO'));
R.window_opened = !!btn;
if (btn) btn.click();
const res = await Promise.race([done, wait(30000).then(() => ({ timeout: true }))]);
R.result = res && { exit: res.exit_code, stdout: res.stdout };
await wait(300);
R.screen = termText(session).split('\n').filter((l) => l.trim());
R.leaked_at_gui = R.screen.some((l) => l.includes('@gui'));
return R;
