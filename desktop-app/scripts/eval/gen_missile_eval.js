// 用法：node scripts/eval/gen_missile_eval.js <examples資料夾> <輸出評估檔>（examples 資料夾有 missile_command.py 與四張 missile_*.png，例如 Redmine 外掛的 examples）
// 產生的評估檔同 gui_py_worker.eval.js 的啟動方式。做法：包一層程式，把 missile_command.draw 換成會在砲台位置或砲彈數改變時印一行的版本，
// 再用 DOM 事件（mousedown／mousemove／wheel／keydown）操作畫布，從終端機輸出核對遊戲狀態的變化（點擊發射、拖曳、滾輪、方向鍵、空白鍵）。
const fs = require('fs');
const path = require('path');
const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error('usage: node gen_missile_eval.js <examples dir> <out file>'); process.exit(2); }
const files = { 'missile_command.py': fs.readFileSync(path.join(dir, 'missile_command.py')).toString('base64') };
for (const n of ['missile_city.png', 'missile_enemy.png', 'missile_shot.png', 'missile_turret.png']) { try { files[n] = fs.readFileSync(path.join(dir, n)).toString('base64'); } catch (_) { /* 程式自己會產生貼圖 */ } }
const wrapper = [
  'import pygame  # 含 pygame 才會走 Worker（py_async 只看這支檔案本身）',
  'src = open("missile_command.py").read().rsplit("\\nmain()", 1)[0]  # 範例檔尾端直接呼叫 main()：去掉它，才能先換掉 draw',
  'ns = {"__name__": "missile_command"}',
  'exec(compile(src, "missile_command.py", "exec"), ns)',
  'last = [None]',
  'orig = ns["draw"]',
  'def draw(screen, pics, g):',
  '    cur = (g["turret"], len(g["shots"]))',
  '    if cur != last[0]:',
  '        last[0] = cur',
  '        print("STATE", cur[0], cur[1], flush=True)',
  '    return orig(screen, pics, g)',
  'ns["draw"] = draw',
  'ns["main"]()',
].join('\n');
const body = `
const FILES = ${JSON.stringify(files)};
const WRAPPER = ${JSON.stringify(wrapper)};
const fa = window.fa; const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) {} await wait(100); } return null; };
const termText = (s) => { const b = s.term.buffer.active; const o = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); } return o.join(String.fromCharCode(10)); };
R.loaded = { scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)) };
const t = await fa._createTerminalForAI({ name: 'missile-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
for (const n of Object.keys(FILES)) { const bin = atob(FILES[n]); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); fa._writeBytesToTerminalFs(fsStore, '/work/' + n, u); }
fa._writeBytesToTerminalFs(fsStore, '/work/run.py', new TextEncoder().encode(WRAPPER));
const runP = fa._runTerminalCommand(session, 'python3 run.py');
const startBtn = await until(() => Array.from(document.querySelectorAll('.gui-window[data-window] .gui-button')).find((b) => b.textContent.trim() === '開始'));
R.dialog = !!startBtn; if (!startBtn) return R;
startBtn.click();
const cv = await until(() => document.querySelector('.gui-window[data-window] canvas'));
R.canvas = cv && [cv.width, cv.height]; if (!cv) return R;
await wait(1500);
const states = () => (termText(session).match(/STATE -?[0-9]+ [0-9]+/g) || []).map((s) => s.split(' ').slice(1).map(Number));
const last = () => { const a = states(); return a[a.length - 1] || null; };
const at = (x, y) => { const r = cv.getBoundingClientRect(); return { clientX: r.left + x * r.width / cv.width, clientY: r.top + y * r.height / cv.height, bubbles: true, buttons: 1 }; };
const fire = (type, init) => cv.dispatchEvent(new MouseEvent(type, init));
R.start = last();
// 1. click: a shot
cv.focus(); fire('mousedown', Object.assign(at(200, 100), { button: 0 })); fire('mouseup', Object.assign(at(200, 100), { button: 0, buttons: 0 })); await wait(300);
R.after_click = last();
// 2. drag: turret follows the pointer
fire('mousedown', Object.assign(at(60, 150), { button: 0 })); await wait(100);
fire('mousemove', at(60, 150)); await wait(200); R.after_drag_60 = last();
fire('mousemove', at(250, 150)); await wait(200); R.after_drag_250 = last();
fire('mouseup', Object.assign(at(250, 150), { button: 0, buttons: 0 })); await wait(100);
// 3. wheel: 12 px per notch
const w0 = last();
cv.dispatchEvent(new WheelEvent('wheel', Object.assign(at(100, 100), { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }))); await wait(300); R.wheel_up = [w0, last()];
const w1 = last();
cv.dispatchEvent(new WheelEvent('wheel', Object.assign(at(100, 100), { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }))); await wait(300); R.wheel_down = [w1, last()];
// 4. arrow keys and space
const k0 = last();
for (let i = 0; i < 3; i++) { cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true })); cv.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true })); await wait(120); }
R.arrow_right = [k0, last()];
const s0 = last();
await wait(600);
cv.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })); cv.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true })); await wait(300);
R.space = [s0, last()];
R.states_count = states().length;
// pixels: the canvas is not empty and is changing
const px = () => { const c = cv.getContext('2d'); const d = c.getImageData(0, 0, cv.width, cv.height).data; const set = new Set(); for (let i = 0; i < d.length; i += 4 * 17) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); return set.size; };
R.colors_on_canvas = px();
const close = Array.from(document.querySelectorAll('.gui-window[data-window] .gui-close'))[0]; if (close) close.click();
await Promise.race([runP, wait(10000)]);
R.tail = termText(session).split(String.fromCharCode(10)).filter((l) => l.trim() && !/^STATE/.test(l)).slice(-6);
return R;
`;
fs.writeFileSync(out, '// 由 gen_missile_eval.js 產生\n' + body);
console.log('wrote', out);
