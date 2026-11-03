// 第 2 條：Ctrl+C 中止前景程式（走真的鍵盤輸入處理 _handleTerminalInput）：python 死迴圈、python 等視窗、node 死迴圈、zenity；結束碼 130、視窗收掉、回提示字元、下一個指令正常
const fa = window.fa; const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const wins = () => Array.from(document.querySelectorAll('.gui-window[data-window]')).length;
const termText = (s) => { const b = s.term.buffer.active; const o = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); } return o.join(String.fromCharCode(10)); };
R.loaded = { scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)), has_interrupt: typeof fa._terminalInterrupt === 'function' };
const t = await fa._createTerminalForAI({ name: 'ctrlc-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
const put = (n, s) => fa._writeBytesToTerminalFs(fsStore, '/work/' + n, new TextEncoder().encode(s));
put('spin.py', 'import gui\nw = gui.Window("spin", width=200)\nw.button("OK")\nn = 0\nwhile True:\n    n += 1\n');
put('waitwin.py', 'import gui\nw = gui.Window("ww", width=200)\nw.button("OK")\nwhile True:\n    ev = w.wait(timeout=60)\n    print("ev", ev)\n');
put('spin.js', 'const w = await gui.open("sj", 200); await w.button("OK"); for (;;) { }\n');
put('ok.py', 'import gui\nprint("after-ok")\n');
const cases = [['py_spin', 'python3 spin.py'], ['py_wait', 'python3 waitwin.py'], ['js_spin', 'node spin.js'], ['zenity', 'zenity --entry']];
for (const [n, c] of cases) {
  const p = fa._handleTerminalInput(session, c + '\r');
  const t1 = Date.now(); while (Date.now() - t1 < 40000 && !(n !== 'js_spin' ? wins() > 0 : wins() > 0)) await wait(200);
  await wait(500);
  const busy = session.busy, w1 = wins();
  const t0 = Date.now();
  await fa._handleTerminalInput(session, '\x03');
  await Promise.race([p, wait(8000)]);
  R[n] = { busy_before: busy, wins_before: w1, ms: Date.now() - t0, busy_after: session.busy, wins_after: wins(), lec: session.lastExitCode, tail: termText(session).slice(-80) };
}
await fa._runTerminalCommand(session, 'python3 ok.py');
R.next_ok = termText(session).includes('after-ok');
return R;
