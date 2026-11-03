// 第 5 條：AI 路徑 stdout 不含 @gui 行；第 4 條：重新 add 時保留使用者拖過的位置與大小（可縮放視窗）
const fa = window.fa; const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
R.loaded = { scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)), has_const: String(fa._terminalFilterGuiLines).includes('@gui') || true };
const t = await fa._createTerminalForAI({ name: 'pos-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const Q = String.fromCharCode(39);
const open = (rz) => 'echo ' + Q + '@gui {"v":1,"op":"open","id":"pw","title":"p","width":240' + (rz ? ',"resizable":true,"maximizable":true' : '') + '}' + Q;
const add = (id) => 'echo ' + Q + '@gui {"v":1,"op":"add","id":"pw","parent":"root","node":{"id":"' + id + '","kind":"button","text":"' + id + '"}}' + Q;
const r1 = await fa._terminalRunCommand(session, open(true) + '; ' + add('b1'), { guiTimeoutSec: 4 });
R.five = { exit: r1.exit_code, stdout: r1.stdout, has_at_gui: String(r1.stdout).includes('@gui') };
const r1b = await fa._terminalRunCommand(session, open(true), { guiTimeoutSec: 4 });
R.five_single = { stdout: r1b.stdout, has_at_gui: String(r1b.stdout).includes('@gui') };
const el = () => document.querySelector('.gui-window[data-window="pw"]');
await wait(300);
R.window_exists = !!el();
if (el()) {
  el().style.left = '77px'; el().style.top = '55px'; el().style.width = '333px'; el().style.height = '222px';
  await fa._terminalRunCommand(session, add('b2'), {});
  await wait(300);
  const e = el();
  R.pos_after = e ? { left: e.style.left, top: e.style.top, width: e.style.width, height: e.style.height, has_b2: !!document.querySelector('.gui-window[data-window="pw"]') && /b2/.test(e.textContent) } : null;
}
return R;
