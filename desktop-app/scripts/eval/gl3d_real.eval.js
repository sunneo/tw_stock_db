// gl3d（建在真的 PyOpenGL 之上）與桌面版的 3D 範例（真實 Electron）：每個範例開視窗、畫面是 WebGL2 的 PNG、不丟例外、事件進得去。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/gl3d_real.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
R.examples = {};
for (const name of ['python/gui/gl_scene.py', 'python/gpgpu/nbody3d.py', 'python/gpgpu/fluid3d.py']) {
  const j = await tool('job_run', { lang: 'python', code: FA_PY_EXAMPLES[name], args: name.includes('nbody') || name.includes('fluid') ? ['--device', 'cpu'] : [], detach: true, timeout_s: 120 });
  let waited = 0, s; do { await wait(1000); waited += 1000; s = await tool('job_gui', { job_id: j.job_id, action: 'snapshot' }); } while (waited < 70000 && s.windows.length === 0 && s.running);
  await wait(2500); s = await tool('job_gui', { job_id: j.job_id, action: 'snapshot' });
  const cvs = s.windows[0] ? s.windows[0].nodes.filter((n) => n.kind === 'canvas') : []; const e = { running: s.running, windows: s.windows.length, canvases: cvs.length };
  if (cvs.length) { const sh = await tool('job_gui', { job_id: j.job_id, action: 'screenshot', canvas: 0 }); e.shot = sh.ok ? sh.screenshot.bytes : sh.error; await tool('job_gui', { job_id: j.job_id, action: 'mouse', node: cvs[cvs.length - 1].id, value: { kind: 'down', x: 50, y: 50, button: 0 }, wait_ms: 100 }); await tool('job_gui', { job_id: j.job_id, action: 'mouse', node: cvs[cvs.length - 1].id, value: { kind: 'move', x: 120, y: 60, button: 0 }, wait_ms: 600 }); const s2 = await tool('job_gui', { job_id: j.job_id, action: 'snapshot' }); e.after_drag_running = s2.running; }
  if (!s.running || /Traceback|Error/.test(s.output || '')) e.err = (s.output || '').slice(-500);
  await tool('job_stop', { job_id: j.job_id });
  R.examples[name.split('/').pop()] = e;
}
R.ok = Object.values(R.examples).every((e) => e.running && e.windows === 1 && e.canvases >= 1 && e.after_drag_running && !e.err && e.shot > 1000);
console.log('GL3D_RESULT ' + JSON.stringify(R));
return R;
