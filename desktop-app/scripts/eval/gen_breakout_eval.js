// 用法：node scripts/eval/gen_breakout_eval.js <輸出評估檔>（程式是 scripts/eval/gui_examples/breakout.py，跟著 repo 走，不用外部資料夾）
// 產生的評估檔同 gen_map_eval.js 的啟動方式（scripts/eval/run_eval.js）。做法：在終端機跑 python3 breakout.py，
// 先按空白鍵發球（看球會動），再按左右方向鍵（看擋板會動），最後用一個很簡單的機器人追球（每 100 毫秒按一次左或右），
// 驗證球真的打到磚塊（磚塊數減少）。最後按視窗的 × 讓程式結束，看結束碼。
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
if (!out) { console.error('usage: node gen_breakout_eval.js <out file>'); process.exit(2); }
const src = fs.readFileSync(path.join(__dirname, 'gui_examples', 'breakout.py')).toString('base64');
const body = `
const FILES = { 'breakout.py': ${JSON.stringify(src)} };
const fa = window.fa; const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) {} await wait(100); } return null; };
const termText = (s) => { const b = s.term.buffer.active; const o = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); } return o.join(String.fromCharCode(10)); };
R.loaded = { scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)) };
const t = await fa._createTerminalForAI({ name: 'breakout-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
for (const n of Object.keys(FILES)) { const bin = atob(FILES[n]); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); fa._writeBytesToTerminalFs(fsStore, '/work/' + n, u); }
const runP = fa._runTerminalCommand(session, 'python3 breakout.py');
const cv = await until(() => document.querySelector('.gui-window[data-window] canvas'));
R.canvas = cv && [cv.width, cv.height]; if (!cv) { R.tail = termText(session).split(String.fromCharCode(10)).slice(-8); return R; }
await wait(1200);
const states = () => (termText(session).match(/STATE -?[0-9]+ -?[0-9]+ -?[0-9]+ [0-9]+ [0-9]+ [0-9]+/g) || []).map((s) => s.split(' ').slice(1).map(Number));
const last = () => { const a = states(); return a[a.length - 1] || null; };
// 欄位：[擋板x, 球x, 球y, 磚塊數, 命數, 分數]
const key = (k, code, type) => cv.dispatchEvent(new KeyboardEvent(type, { key: k, code, bubbles: true }));
const tap = async (k, code, ms) => { key(k, code, 'keydown'); await wait(ms); key(k, code, 'keyup'); await wait(150); };
R.start = last();
cv.focus();
// 1. 空白鍵發球：球會動
await tap(' ', 'Space', 300);
await wait(800);
R.served = [R.start, last()];
// 2. 按住左鍵：擋板往左
const p0 = last();
await tap('ArrowLeft', 'ArrowLeft', 500);
R.left = [p0, last()];
// 3. 追球機器人：擋板往球的方向移，直到磚塊少於 32 或時間到
const bricks0 = (last() || [0, 0, 0, 32])[3];
const t0 = Date.now(); let steps = 0;
while (Date.now() - t0 < 25000) {
  const s = last(); if (!s) { await wait(100); continue; }
  if (s[4] <= 0 || s[3] < bricks0) break;
  const toward = s[1] > s[0] + 35 ? 'ArrowRight' : (s[1] < s[0] + 35 ? 'ArrowLeft' : null);
  if (toward) { key(toward, toward, 'keydown'); await wait(100); key(toward, toward, 'keyup'); } else { await wait(100); }
  steps++;
}
R.bot = { steps, ms: Date.now() - t0, bricks_before: bricks0, end: last() };
R.bricks_hit = bricks0 - ((last() || [0, 0, 0, bricks0])[3]);
// 4. 按視窗的 ×：程式收到 QUIT 後結束
const close = Array.from(document.querySelectorAll('.gui-window[data-window] .gui-close'))[0];
if (close) close.click();
await Promise.race([runP, wait(10000)]);
R.exit_code = session.lastExitCode;
R.window_closed = !document.querySelector('.gui-window[data-window]');
R.tail = termText(session).split(String.fromCharCode(10)).filter((l) => l.trim() && !/^STATE/.test(l)).slice(-4);
return R;
`;
fs.writeFileSync(out, '// 由 gen_breakout_eval.js 產生\n' + body);
console.log('wrote', out);
