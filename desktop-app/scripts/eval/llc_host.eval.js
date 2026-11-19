// LLVM IR 的主機函式庫（真實 Electron）：同一份 examples/llc 的 .ll（SDL2／OpenGL／GTK3）在模擬環境的 wasm 裡跑：視窗、畫布、事件、printf。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/llc_host.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
const ex = (n) => FA_PY_EXAMPLES['llc/' + n];
R.seeded = !!ex('game/sdl2_pong.ll') && !!ex('gui/gtk3_widgets.ll') && !!ex('gui/sdl2_gl_triangle.ll');
R.host_api = typeof FaLlvmHost === 'object' && typeof FaLlvm.runHost === 'function' && typeof FaLlvm.registerHost === 'function' && !FaLlvm.HOST.SDL_Init;   // 登記只在程式執行期間
// 1. SDL2 乒乓球：跑 150 幀；中途看視窗、注入按鍵
let r = await tool('job_run', { lang: 'llvm', code: ex('game/sdl2_pong.ll'), args: ['150'], detach: true, timeout_s: 60 });
const pj = r.job_id; await wait(300);
let g = await tool('job_gui', { job_id: pj, action: 'snapshot' });
const cv = g.windows[0] && g.windows[0].nodes.find((n) => n.kind === 'canvas');
R.pong = { running: g.running, windows: g.windows.length, title: g.windows[0] && g.windows[0].title, canvas: cv && [cv.width, cv.height] };
if (cv) { const k = await tool('job_gui', { job_id: pj, action: 'key', node: cv.id, value: { key: 'w', down: true }, wait_ms: 100 }); R.pong.key = k.ok === true; const m = await tool('job_gui', { job_id: pj, action: 'mouse', node: cv.id, value: { kind: 'move', x: 100, y: 120, button: 0 }, wait_ms: 100 }); R.pong.mouse = m.ok === true; const sh = await tool('job_gui', { job_id: pj, action: 'screenshot', canvas: 0 }); R.pong.shot = sh.ok ? sh.screenshot.bytes : sh.error; }
let waited = 0; while (waited < 15000 && (await tool('job_list', {})).jobs.find((j) => j.job_id === pj).running) { await wait(250); waited += 250; }
const pe = (await tool('job_list', {})).jobs.find((j) => j.job_id === pj); g = await tool('job_gui', { job_id: pj, action: 'snapshot' });
R.pong.done = { running: pe.running, exit: pe.exit_code, out: (g.output || '').trim().slice(-120) };
// 2. GTK3：自動模式（參數 3＝程式自己按 3 次，200ms 後離開）
r = await tool('job_run', { lang: 'llvm', code: ex('gui/gtk3_widgets.ll'), args: ['3'], timeout_s: 60 });
R.gtk_auto = { exit: r.exit_code, out: (r.output || '').trim().slice(-100) };
// 3. GTK3：互動模式——看 widget、注入點擊與輸入、標籤更新、關閉視窗結束程式
r = await tool('job_run', { lang: 'llvm', code: ex('gui/gtk3_widgets.ll'), detach: true, timeout_s: 60 }); const gj = r.job_id; await wait(500);
g = await tool('job_gui', { job_id: gj, action: 'snapshot' }); const nodes = (g.windows[0] && g.windows[0].nodes) || [];
const btn = nodes.find((n) => n.kind === 'button'), ent = nodes.find((n) => n.kind === 'entry'), chk = nodes.find((n) => n.kind === 'checkbox'), lab = nodes.find((n) => n.kind === 'label');
R.gtk = { windows: g.windows.length, kinds: nodes.map((n) => n.kind).join(','), label0: lab && lab.text };
if (btn && ent && chk) {
  await tool('job_gui', { job_id: gj, action: 'input', node: ent.id, value: 'hello', wait_ms: 200 });
  await tool('job_gui', { job_id: gj, action: 'change', node: chk.id, value: true, wait_ms: 200 });
  await tool('job_gui', { job_id: gj, action: 'click', node: btn.id, wait_ms: 200 });
  g = await tool('job_gui', { job_id: gj, action: 'click', node: btn.id, wait_ms: 500 });
  const l2 = g.windows[0] && g.windows[0].nodes.find((n) => n.kind === 'label'); R.gtk.label1 = l2 && l2.text;
  await tool('job_gui', { job_id: gj, action: 'close', wait_ms: 300 });
}
waited = 0; while (waited < 6000 && (await tool('job_list', {})).jobs.find((j) => j.job_id === gj).running) { await wait(250); waited += 250; }
R.gtk.stopped = !(await tool('job_list', {})).jobs.find((j) => j.job_id === gj).running;
// 4. OpenGL（SDL2＋固定管線）：400 幀；畫布是 WebGL2，不能截圖，只看有視窗與 gl 畫布、沒有 trap／glerror、結束碼 0
r = await tool('job_run', { lang: 'llvm', code: ex('gui/sdl2_gl_triangle.ll'), args: ['400'], detach: true, timeout_s: 60 }); const lj = r.job_id; await wait(400);
g = await tool('job_gui', { job_id: lj, action: 'snapshot' }); const glc = g.windows[0] && g.windows[0].nodes.find((n) => n.kind === 'canvas');
R.gl = { windows: g.windows.length, canvas: !!glc };
if (glc) { const m = await tool('job_gui', { job_id: lj, action: 'mouse', node: glc.id, value: { kind: 'down', x: 10, y: 10, button: 0 }, wait_ms: 50 }); await tool('job_gui', { job_id: lj, action: 'mouse', node: glc.id, value: { kind: 'move', x: 60, y: 10, button: 0 }, wait_ms: 50 }); R.gl.mouse = m.ok === true; }
waited = 0; while (waited < 15000 && (await tool('job_list', {})).jobs.find((j) => j.job_id === lj).running) { await wait(250); waited += 250; }
const le = (await tool('job_list', {})).jobs.find((j) => j.job_id === lj); g = await tool('job_gui', { job_id: lj, action: 'snapshot' }); R.gl.done = { running: le.running, exit: le.exit_code, out: (g.output || '').trim().slice(-160) };
// 5. 錯誤路徑：宣告了主機函式但簽名不對、用了沒有實作的函式
r = await tool('job_run', { lang: 'llvm', code: 'declare i32 @SDL_Init(i64)\ndeclare void @SDL_NoSuchThing()\ndefine i32 @main() {\n  call i32 @SDL_Init(i64 1)\n  ret i32 0\n}\n' });
R.errors = { exit: r.exit_code, out: (r.output || '').slice(0, 300) };
R.ok = R.seeded && R.host_api && R.pong.windows === 1 && !!R.pong.canvas && R.pong.done.exit === 0 && /frames=150/.test(R.pong.done.out) && R.gtk_auto.exit === 0 && /count=3/.test(R.gtk_auto.out) && /Pressed 2 times, entry: hello/.test(R.gtk.label1 || '') && R.gtk.stopped && R.gl.canvas && R.gl.done.exit === 0 && R.errors.exit !== 0;
console.log('LLC_RESULT ' + JSON.stringify(R));
return R;
