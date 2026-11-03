// 驗證複合指令裡，JS 攔截段（zenity、sleep、gui wait、python gui、node gui、ask-ai-chat）的結束碼會帶到下一段：
// `;` 後的 $?、&& 與 || 的短路、if／for 內的 $?。兩個入口各跑一次：
//   AI：fa._terminalRunCommand（terminal_run 的入口，回傳 stdout 與 exit_code）
//   互動：fa._runTerminalCommand（畫面上打字的入口，從終端機文字讀輸出）
// 每個案例的輸出都帶一個唯一標記 M<n>，避免跟別的輸出混在一起。不按任何視窗按鈕，靠短的 timeout。
const fa = window.fa; const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const termText = (s) => { const b = s.term.buffer.active; const o = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); } return o.join(String.fromCharCode(10)); };
const GUI_PY = 'import gui\nw = gui.Window("hang", width=300)\nw.button("OK")\nwhile True:\n    ev = w.wait(timeout=60)\n    if ev is None or ev["event"] == "close":\n        break\n';
const GUI_JS = 'const w = await gui.open("hang", 300); await w.button("OK"); for (;;) { const ev = await w.wait(60); if (!ev || ev.event === "close") break; }\n';
const OPEN = 'echo \'@gui {"v":1,"op":"open","id":"gw","title":"w","width":200,"height":100}\'';
// [名稱, 指令（不含標記）, 預期：標記 M<n> 之後的 $?（null＝不檢查）, 不該出現的字串]
const CASES = [
  ['semi_zenity', 'zenity --entry --timeout=1; echo M1:$?', 'M1:5'],
  ['semi_sleep', 'sleep 0; echo M2:$?', 'M2:0'],
  ['and_fail', 'zenity --entry --timeout=1 && echo ANDBAD; echo M3:$?', 'M3:5', 'ANDBAD'],
  ['or_fail', 'zenity --entry --timeout=1 || echo ORGOOD; echo M4:$?', 'M4:0', null, 'ORGOOD'],
  ['and_ok', 'sleep 0 && echo ANDGOOD; echo M5:$?', 'M5:0'],   // sleep 成功，所以 ANDGOOD 應該出現（上一版把它寫成不該出現，是評估檔的錯）
  ['or_ok', 'sleep 0 || echo ORBAD; echo M6:$?', 'M6:0', 'ORBAD'],
  ['if_zenity', 'if zenity --entry --timeout=1; then echo IFBAD; else echo IFGOOD; fi; echo M7:$?', 'M7:0', 'IFBAD'],
  ['for_zenity', 'for i in 1; do zenity --entry --timeout=1; echo M8:$?; done', 'M8:5'],
  ['semi_gui_wait', OPEN + '; gui wait gw --timeout 1; echo M9:$?', 'M9:124'],
  ['semi_python_gui', 'python3 hang.py; echo M10:$?', 'M10:124'],
  ['semi_node_gui', 'node gui.js; echo M11:$?', 'M11:124'],
  ['semi_ask_usage', 'ask-ai-chat; echo M12:$?', 'M12:'],
];
const CAP = 4;
const t = await fa._createTerminalForAI({ name: 'exit-chain-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
fa._writeBytesToTerminalFs(fsStore, '/work/hang.py', new TextEncoder().encode(GUI_PY));
fa._writeBytesToTerminalFs(fsStore, '/work/gui.js', new TextEncoder().encode(GUI_JS));
const check = (out, c) => {
  const [, , want, bad] = c;
  const ok = out.includes(want) && !(bad && out.includes(bad));
  return { ok, want, bad: bad || null };
};
R.ai = {}; R.inter = {};
for (const c of CASES) {
  const r = await fa._terminalRunCommand(session, c[1], { guiTimeoutSec: CAP });
  const aiOut = String(r.stdout || '') + String(r.stderr || '');
  R.ai[c[0]] = Object.assign({ exit_code: r.exit_code, shown: aiOut.slice(0, 160) }, check(aiOut, c));
}
// 互動入口沒有時間上限：會等視窗的三個案例在 2 秒後替使用者按 ×，程式收到關閉事件後正常結束，結束碼 0
// 標記改成 I<n>（xterm 有捲動上限，不能用長度切片）；整個終端機文字裡找「I<n>:值」，不該出現的字串只看不含提示字元的行（指令回顯會含它）
const HANG_CLOSED = { semi_gui_wait: 'M9:124', semi_python_gui: 'M10:0', semi_node_gui: 'M11:0' };
for (const c of CASES) {
  const cmd = c[1].replace(/M(\d+):/g, 'I$1:');
  const want = (HANG_CLOSED[c[0]] || c[2]).replace(/^M/, 'I');
  const closer = setTimeout(() => document.querySelectorAll('.gui-window[data-window] .gui-close').forEach((b) => b.click()), 2000);
  await fa._runTerminalCommand(session, cmd);
  clearTimeout(closer);
  await wait(200);
  const all = termText(session);
  const lines = all.split(String.fromCharCode(10)).filter((l) => !/\$ /.test(l) && !/\/work/.test(l));
  const ok = all.includes(want) && !(c[3] && lines.some((l) => l.includes(c[3])));
  R.inter[c[0]] = { ok, want, bad: c[3] || null, tail: all.slice(-100) };
}
R.session_has_cap = 'guiAiTimeoutSec' in session;
return R;
