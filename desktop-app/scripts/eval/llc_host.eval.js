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
// 4b. SDL2 音訊（佇列模式）＋影像＋鍵盤：小鋼琴；自動模式每 20 幀彈一個音（150 ms 方波經 SDL_QueueAudio）
r = await tool('job_run', { lang: 'llvm', code: ex('game/sdl2_piano.ll'), args: ['500'], detach: true, timeout_s: 60 }); const aj = r.job_id; await wait(300);
g = await tool('job_gui', { job_id: aj, action: 'snapshot' }); const acv = g.windows[0] && g.windows[0].nodes.find((n) => n.kind === 'canvas'); const mid = fa._audioHost ? fa._audioHost.stats() : null;
R.audio = { windows: g.windows.length, canvas: !!acv, streams_mid: mid && mid.streams, state: mid && mid.state };
if (acv) { const k = await tool('job_gui', { job_id: aj, action: 'key', node: acv.id, value: { key: 'g', down: true }, wait_ms: 200 }); R.audio.key_ok = k.ok === true; }
waited = 0; while (waited < 15000 && (await tool('job_list', {})).jobs.find((j) => j.job_id === aj).running) { await wait(250); waited += 250; }
const ae = (await tool('job_list', {})).jobs.find((j) => j.job_id === aj); g = await tool('job_gui', { job_id: aj, action: 'snapshot' });
R.audio.done = { running: ae.running, exit: ae.exit_code, out: (g.output || '').trim().slice(-80) }; R.audio.streams_after = fa._audioHost.stats().streams;
// 4c. 不支援的 callback 模式要明確報錯（不是悄悄沒聲音）
r = await tool('job_run', { lang: 'llvm', timeout_s: 30, code: 'declare i32 @SDL_OpenAudioDevice(ptr, i32, ptr, ptr, i32)\ndeclare i32 @printf(ptr, ...)\n@s = private constant [8 x i8] c"dev=%d\\0A\\00"\ndefine i32 @main() {\n  %spec = alloca [32 x i8], align 8\n  store i64 0, ptr %spec\n  %a = getelementptr i8, ptr %spec, i32 8\n  store i64 0, ptr %a\n  %b = getelementptr i8, ptr %spec, i32 16\n  store i64 0, ptr %b\n  %c = getelementptr i8, ptr %spec, i32 24\n  store i64 0, ptr %c\n  store i32 22050, ptr %spec\n  %f0 = getelementptr i8, ptr %spec, i32 4\n  store i8 16, ptr %f0\n  %f1 = getelementptr i8, ptr %spec, i32 5\n  store i8 -128, ptr %f1\n  %ch = getelementptr i8, ptr %spec, i32 6\n  store i8 1, ptr %ch\n  %cb = getelementptr i8, ptr %spec, i32 16\n  store i32 1, ptr %cb\n  %d = call i32 @SDL_OpenAudioDevice(ptr null, i32 0, ptr %spec, ptr null, i32 0)\n  call i32 (ptr, ...) @printf(ptr @s, i32 %d)\n  ret i32 0\n}\n' });
R.audio.callback_mode = { out: (r.output || '').trim().slice(0, 200) };
// 4d. 四個新範例：nbody3d／fluid3d（CPU 的 3D 模擬＋OpenGL 點精靈）、music_player（即時合成）、midi_player（解析 MIDI；檔案走 fopen 讀沙盒）
R.more = {};
for (const [name, file, args, expect] of [['nbody3d', 'gpgpu/nbody3d.ll', ['3072','100000','60'], /frames=60 bodies=3072 cx=/], ['fluid3d', 'gpgpu/fluid3d.ll', ['150'], /frames=150 n=1000 y_mean=0\.\d+/], ['music_player', 'gui/music_player.ll', ['400'], /frames=400 samples=\d+ bpm=110 ok/], ['midi_player_demo', 'gui/midi_player.ll', ['-', '400'], /notes=45 tempos=1 div=480 seconds=30 played=\d+ ok/]]) {
  const jr = await tool('job_run', { lang: 'llvm', code: ex(file), args, detach: true, timeout_s: 120 }); const jid = jr.job_id; await wait(1200);
  const sn = await tool('job_gui', { job_id: jid, action: 'snapshot' }); const e = { windows: sn.windows.length, streams_mid: (name === 'nbody3d' || name === 'fluid3d') ? undefined : fa._audioHost.stats().streams }; if (e.streams_mid !== undefined && e.streams_mid !== 1) e.stream_err = true;
  let wt = 0; while (wt < 40000 && (await tool('job_list', {})).jobs.find((j) => j.job_id === jid).running) { await wait(300); wt += 300; }
  const fin = await tool('job_gui', { job_id: jid, action: 'snapshot' }); e.exit = (await tool('job_list', {})).jobs.find((j) => j.job_id === jid).exit_code; e.out = (fin.output || '').trim().slice(-90); e.ok = e.exit === 0 && expect.test(e.out) && e.windows === 1 && !e.stream_err;
  R.more[name] = e;
}
// 檔案系統：沙盒裡的 .mid 經 fopen／fread 讀進來（shell 的 lli 走同一條路）
r = await tool('job_run', { lang: 'shell', code: 'ls examples/llc/gui; lli examples/llc/gui/midi_player.ll examples/llc/gui/demo.mid 100', timeout_s: 120 });
R.more.midi_player_file = { exit: r.exit_code, out: (r.output || '').trim().slice(-120), ok: /notes=45 tempos=1 div=480 seconds=30/.test(r.output || '') };
r = await tool('job_run', { lang: 'shell', code: 'lli examples/llc/gui/midi_player.ll nope.mid 5', timeout_s: 60 }); R.more.midi_player_missing = { out: (r.output || '').trim().slice(-60), ok: /cannot open nope\.mid/.test(r.output || '') };
// 5. 錯誤路徑：宣告了主機函式但簽名不對、用了沒有實作的函式
r = await tool('job_run', { lang: 'llvm', code: 'declare i32 @SDL_Init(i64)\ndeclare void @SDL_NoSuchThing()\ndefine i32 @main() {\n  call i32 @SDL_Init(i64 1)\n  ret i32 0\n}\n' });
R.errors = { exit: r.exit_code, out: (r.output || '').slice(0, 300) };
R.ok = R.seeded && R.host_api && R.pong.windows === 1 && !!R.pong.canvas && R.pong.done.exit === 0 && /frames=150/.test(R.pong.done.out) && R.gtk_auto.exit === 0 && /count=3/.test(R.gtk_auto.out) && /Pressed 2 times, entry: hello/.test(R.gtk.label1 || '') && R.gtk.stopped && R.gl.canvas && R.gl.done.exit === 0 && R.errors.exit !== 0 && R.audio.canvas && R.audio.streams_mid === 1 && R.audio.done.exit === 0 && /notes=\d+ queued=\d+ ok/.test(R.audio.done.out) && R.audio.streams_after === 0 && /callback/.test(R.audio.callback_mode.out) && /dev=0/.test(R.audio.callback_mode.out) && Object.values(R.more).every((e) => e.ok);
console.log('LLC_RESULT ' + JSON.stringify(R));
return R;
