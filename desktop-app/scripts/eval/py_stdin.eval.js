// 第 1 條：Python 的 input()／sys.stdin 真的讀得到。互動（鍵盤輸入處理 _handleTerminalInput）、管線、AI 路徑沒給輸入（EOF）、Ctrl+C、回歸（不讀輸入的 python）
const fa = window.fa; const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const termText = (s) => { const b = s.term.buffer.active; const o = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); } return o.join(String.fromCharCode(10)); };
const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (_) { /* 還沒好 */ } await wait(150); } return false; };
R.loaded = { scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)), has_read: typeof fa._terminalReadStdinLine === 'function' };
const t = await fa._createTerminalForAI({ name: 'stdin-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
const put = (n, s) => fa._writeBytesToTerminalFs(fsStore, '/work/' + n, new TextEncoder().encode(s));
put('ask.py', 'n = input("name? ")\nprint("hi", n)\nimport sys\nl = sys.stdin.readline()\nprint("line=" + l.strip())\n');
put('all.py', 'import sys\nd = sys.stdin.read()\nprint("n=" + str(len(d.split())))\nfor ln in sys.stdin:\n    print("never")\n');
put('plain.py', 'print(1 + 1)\n');
put('eof.py', 'try:\n    input("x? ")\nexcept EOFError:\n    print("got-eof")\n');
// 1. 互動：鍵盤輸入
const p1 = fa._handleTerminalInput(session, 'python3 ask.py\r');
R.prompt_shown = await until(() => termText(session).includes('name? '));
await fa._handleTerminalInput(session, 'Bob\r');
R.second_wait = await until(() => session._stdinWaiter);
for (const ch of 'x yz') await fa._handleTerminalInput(session, ch);
await fa._handleTerminalInput(session, '\x7f');
await fa._handleTerminalInput(session, '\r');
await Promise.race([p1, wait(20000)]);
let txt = termText(session);
R.inter = { hi_bob: txt.includes('hi Bob'), line_ok: txt.includes('line=x y'), busy_after: session.busy, lec: session.lastExitCode };
// 2. 管線（AI 入口）
const r2 = await fa._terminalRunCommand(session, 'echo Zed | python3 ask.py', { guiTimeoutSec: 30 });
R.pipe_ai = { exit: r2.exit_code, out: String(r2.stdout).slice(0, 80), err: String(r2.stderr).slice(0, 120) };
const r3 = await fa._terminalRunCommand(session, 'printf "a b\\nc d e\\n" | python3 all.py', { guiTimeoutSec: 30 });
R.pipe_read_all = { exit: r3.exit_code, out: String(r3.stdout).slice(0, 80), err: String(r3.stderr).slice(0, 120) };
// 3. AI 沒給輸入：EOF，不等
const t0 = Date.now();
const r4 = await fa._terminalRunCommand(session, 'python3 eof.py', { guiTimeoutSec: 30 });
R.ai_no_input = { exit: r4.exit_code, out: String(r4.stdout).slice(0, 60), ms: Date.now() - t0 };
// 4. 互動管線
await fa._runTerminalCommand(session, 'echo Q | python3 ask.py');
txt = termText(session);
R.inter_pipe = { hi_q: txt.includes('hi Q') };
// 5. Ctrl+C 打斷等輸入
const p5 = fa._handleTerminalInput(session, 'python3 ask.py\r');
await until(() => session._stdinWaiter);
await fa._handleTerminalInput(session, '\x03');
await Promise.race([p5, wait(8000)]);
R.ctrl_c = { busy: session.busy, lec: session.lastExitCode, waiter_cleared: !session._stdinWaiter };
// 6. 回歸
const r6 = await fa._terminalRunCommand(session, 'python3 plain.py', { guiTimeoutSec: 30 });
R.plain = { out: String(r6.stdout).trim(), exit: r6.exit_code };
return R;
