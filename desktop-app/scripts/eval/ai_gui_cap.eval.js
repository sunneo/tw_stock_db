// 驗證 AI 工具路徑（terminal_run → _terminalRunCommand）的 GUI 時間上限：沒有人能按視窗時，zenity／gui wait／含 gui 的 python 與 node 不會永遠等。
// 做法：上限設為 4 秒（同 terminal_run 包裝裡的 guiTimeoutSec: 120，這裡換小一點省時間），每個案例都不按任何按鈕。
// 用法：node scripts/eval/run_eval.js scripts/eval/ai_gui_cap.eval.js
const fa = window.fa; const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const windows = () => document.querySelectorAll('.gui-window[data-window]').length;
const GUI_PY = `import gui
w = gui.Window("hang", width=300)
w.label("沒有人會按")
ok = w.button("OK")
while True:
    ev = w.wait(timeout=60)
    if ev is None or ev["event"] == "close" or ev["node"] == ok:
        break
print("py done")
`;
const GUI_JS = 'const w = await gui.open("hang", 300); await w.label("沒有人會按"); await w.button("OK"); for (;;) { const ev = await w.wait(60); if (!ev || ev.event === "close") break; } console.log("js done");\n';
const t = await fa._createTerminalForAI({ name: 'ai-cap-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
fa._writeBytesToTerminalFs(fsStore, '/work/hang.py', new TextEncoder().encode(GUI_PY));
fa._writeBytesToTerminalFs(fsStore, '/work/gui.js', new TextEncoder().encode(GUI_JS));
const CAP = 4;   // 同 terminal_run 包裝裡傳的 guiTimeoutSec（這裡換小一點省時間）
const run = async (name, cmd) => {
  const w0 = windows(); const t0 = Date.now();
  const r = await fa._terminalRunCommand(session, cmd, { guiTimeoutSec: CAP });
  R[name] = { ok: r.ok, exit_code: r.exit_code, stdout: String(r.stdout || '').slice(0, 300), stderr: String(r.stderr || '').slice(-300), ms: Date.now() - t0, windows_before: w0, windows_after: windows() };
};
// A. zenity 在 shell 管線裡（之前走 busybox 找不到指令）：沒有人按，4 秒後 exit 5，後面的 echo 照跑
await run('zenity_shell', 'zenity --entry --text=hi; echo code=$?');
// B. zenity 單獨（JS 攔截路徑）
await run('zenity_plain', 'zenity --entry --text=hi');
// C. python 含 gui：超時 124、印出逾時訊息、視窗關閉
await run('python_gui', 'python3 hang.py');
// D. node 含 gui：超時 124、視窗關閉
await run('node_gui', 'node gui.js');
// E. gui wait 沒有人按：先開窗（單獨一次呼叫），再單獨 gui wait：4 秒內超時 exit 124（同一行的 $? 跨段不會帶過去，這裡分開測）
await run('gui_open', 'echo \'@gui {"v":1,"op":"open","id":"gw","title":"w","width":200,"height":100}\'');
await run('gui_wait', 'gui wait gw');
// F. 回歸：不含 gui 的 python 照常走 wasm
await run('python_plain', 'python3 -c "print(2)"');
R.session_has_cap = "guiAiTimeoutSec" in session;   // 上限不放在 session 上
return R;
