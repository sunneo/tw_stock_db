// 用法：node scripts/eval/gen_map_eval.js <examples資料夾> <輸出評估檔>（examples 資料夾有 map_viewer.py，例如 Redmine 外掛的 examples）
// 做法同 gen_missile_eval.js：包一層程式，把 map_viewer.draw 換成狀態（中心座標與縮放）改變時印一行的版本，
// 再用 DOM 事件（Ctrl+滾輪、拖曳、方向鍵、空白鍵）操作畫布，從終端機輸出核對。map_viewer 沒有開始按鈕，視窗直接出現。
const fs = require('fs');
const path = require('path');
const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error('usage: node gen_map_eval.js <examples dir> <out file>'); process.exit(2); }
const files = { 'map_viewer.py': fs.readFileSync(path.join(dir, 'map_viewer.py')).toString('base64') };
const wrapper = [
  'import pygame  # 含 pygame 才會走 Worker（py_async 只看這支檔案本身）',
  'src = open("map_viewer.py").read().rsplit("\\nmain()", 1)[0]  # 範例檔尾端直接呼叫 main()：去掉它，才能先換掉 draw',
  'ns = {"__name__": "map_viewer"}',
  'exec(compile(src, "map_viewer.py", "exec"), ns)',
  'last = [None]',
  'orig = ns["draw"]',
  'def draw(screen, g, hud):',
  '    cur = (round(g["cx"], 2), round(g["cy"], 2), round(g["z"], 3))',
  '    if cur != last[0]:',
  '        last[0] = cur',
  '        print("STATE %s %s %s" % cur, flush=True)',
  '    return orig(screen, g, hud)',
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
const t = await fa._createTerminalForAI({ name: 'map-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
for (const n of Object.keys(FILES)) { const bin = atob(FILES[n]); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); fa._writeBytesToTerminalFs(fsStore, '/work/' + n, u); }
fa._writeBytesToTerminalFs(fsStore, '/work/run.py', new TextEncoder().encode(WRAPPER));
const runP = fa._runTerminalCommand(session, 'python3 run.py');
const cv = await until(() => document.querySelector('.gui-window[data-window] canvas'));
R.canvas = cv && [cv.width, cv.height]; if (!cv) { R.tail = termText(session).split(String.fromCharCode(10)).slice(-8); return R; }
await wait(1500);
const states = () => (termText(session).match(/STATE -?[0-9.]+ -?[0-9.]+ -?[0-9.]+/g) || []).map((s) => s.split(' ').slice(1).map(Number));
const last = () => { const a = states(); return a[a.length - 1] || null; };
const at = (x, y, extra) => { const r = cv.getBoundingClientRect(); return Object.assign({ clientX: r.left + x * r.width / cv.width, clientY: r.top + y * r.height / cv.height, bubbles: true, buttons: 1 }, extra || {}); };
const fire = (type, init) => cv.dispatchEvent(new MouseEvent(type, init));
const key = (k, code) => { cv.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true })); cv.dispatchEvent(new KeyboardEvent('keyup', { key: k, code, bubbles: true })); };
R.start = last();
// 1. Ctrl+wheel up zooms in (factor 1.25), keeping the point under the pointer
cv.focus();
// 先按一下（不做事）：滾輪與滑鼠事件只有在點擊進入視窗後才會送給程式（ai-chat-wheel-on）
fire('mousedown', at(5, 5, { button: 0 })); fire('mouseup', at(5, 5, { button: 0, buttons: 0 })); await wait(300);
const z0 = last();
cv.dispatchEvent(new WheelEvent('wheel', at(100, 100, { deltaY: -100, ctrlKey: true, cancelable: true }))); await wait(400);
const z1 = last(); R.wheel_up = [z0, z1];
cv.dispatchEvent(new WheelEvent('wheel', at(100, 100, { deltaY: 100, ctrlKey: true, cancelable: true }))); await wait(400);
R.wheel_down = [z1, last()];
// 2. drag with the left button pans: moving the pointer +40,+20 moves the center by -40,-20 at zoom 1
fire('mousedown', at(100, 100, { button: 0 })); await wait(120);
fire('mousemove', at(100, 100)); await wait(150);
const d0 = last();
fire('mousemove', at(140, 120)); await wait(300);
R.drag = [d0, last()];
fire('mouseup', at(140, 120, { button: 0, buttons: 0 })); await wait(150);
// 3. arrow right x3 pans +20 each
const a0 = last();
for (let i = 0; i < 3; i++) { key('ArrowRight', 'ArrowRight'); await wait(150); }
R.arrow_right = [a0, last()];
// 4. space resets to 0,0,1
await wait(500); key(' ', 'Space'); await wait(400);
R.space = last();
R.states_count = states().length;
const px = () => { const c = cv.getContext('2d'); const d = c.getImageData(0, 0, cv.width, cv.height).data; const set = new Set(); for (let i = 0; i < d.length; i += 4 * 17) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); return set.size; };
R.colors_on_canvas = px();
const close = Array.from(document.querySelectorAll('.gui-window[data-window] .gui-close'))[0]; if (close) close.click();
await Promise.race([runP, wait(10000)]);
R.tail = termText(session).split(String.fromCharCode(10)).filter((l) => l.trim() && !/^STATE/.test(l)).slice(-6);
return R;
`;
fs.writeFileSync(out, '// 由 gen_map_eval.js 產生\n' + body);
console.log('wrote', out);
