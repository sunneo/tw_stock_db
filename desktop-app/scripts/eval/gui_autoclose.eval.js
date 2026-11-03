// 第 3 條：python／node 程式結束後收掉它開的視窗（互動與 AI 路徑）；@gui 行開的視窗不受影響
const fa = window.fa; const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const wins = () => Array.from(document.querySelectorAll('.gui-window[data-window]')).map((e) => e.getAttribute('data-window'));
R.loaded = { scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)), has_scope: typeof fa._terminalGuiScope === 'function' };
const t = await fa._createTerminalForAI({ name: 'autoclose-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
const put = (n, s) => fa._writeBytesToTerminalFs(fsStore, '/work/' + n, new TextEncoder().encode(s));
put('done.py', 'import gui\nw = gui.Window("auto", width=200)\nw.button("OK")\nprint("py-done")\n');
put('done.js', 'const w = await gui.open("auto", 200); await w.button("OK"); console.log("js-done");\n');
put('boom.py', 'import gui\nw = gui.Window("auto", width=200)\nw.button("OK")\nraise SystemExit(3)\n');
put('boom_sys.py', 'import gui\nw = gui.Window("auto", width=200)\nw.button("OK")\nimport sys\nsys.exit(3)\n');
put('boom_exit.py', 'import gui\nw = gui.Window("auto", width=200)\nw.button("OK")\nexit(3)\n');
put('err.py', 'import gui\nw = gui.Window("auto", width=200)\nw.button("OK")\nraise ValueError("boom")\n');
const Q = String.fromCharCode(39);
R.keep_open = fa._terminalGuiHost(session).apply('@gui {"v":1,"op":"open","id":"keep","title":"k","width":200}');
await wait(500);
R.keep_before = wins();
let seen = new Set();
const mo = new MutationObserver(() => wins().forEach((w) => seen.add(w)));
mo.observe(document.body, { childList: true, subtree: true });
const cases = [['py', 'python3 done.py'], ['js', 'node done.js'], ['py_exit3', 'python3 boom.py'], ['py_sysexit3', 'python3 boom_sys.py'], ['py_exit_fn3', 'python3 boom_exit.py'], ['py_err', 'python3 err.py']];
R.keep_ids = Object.keys(fa._terminalGuiHost(session).session.windows);
R.ai = {}; R.inter = {};
for (const [n, c] of cases) {
  seen = new Set();
  const r = await fa._terminalRunCommand(session, c, { guiTimeoutSec: 20 });
  R.ai[n] = { seen: Array.from(seen), exit: r.exit_code, out: String(r.stdout).slice(0, 40), after: wins() };
}
for (const [n, c] of cases) {
  seen = new Set();
  await fa._runTerminalCommand(session, c);
  R.inter[n] = { seen: Array.from(seen), after: wins(), lec: session.lastExitCode };
}
R.keep_end = Object.keys(fa._terminalGuiHost(session).session.windows);
return R;
