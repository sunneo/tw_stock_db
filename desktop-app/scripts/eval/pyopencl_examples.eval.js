// 真的 Electron 裡、在「終端機」逐個跑 examples/python/opencl 的範例（python3 x.py），回報每個的結束碼與輸出尾端。
// 跑法：FA_DEBUG_EVAL_FILE=scripts/eval/pyopencl_examples.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
// 需要網路（Pyodide 套件與 PyPI 的 pyopencl）。全部 code 0 才算過；all_ok 是總結。
// 為什麼要有它：只在 node／獨立 Pyodide 驗證過不夠——終端機的 python3 對「不含 gui／pygame／OpenGL」的腳本走同步內建路徑，那裡不會準備 pyopencl 也不會載入 numpy（py_async.js 的判斷要含 pyopencl）。
const fa = window.fa; const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t = await fa._createTerminalForAI({ name: 'pyopencl-examples', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work/examples/python/opencl');
const list = ['vector_add', 'nbody_float4', 'array_ops', 'device_info', 'complex_mandelbrot', 'image_filter', 'image_formats_1d_buffer', 'local_memory_reduction', 'matmul_tiled', 'spirv_vector_add', 'gl_interop', 'gl_texture_interop', 'svm_demo', 'pipe_demo'];
const extra = { 'gpgpu/nbody3d_cl --bench': 'cd ../gpgpu && python3 nbody3d_cl.py --bench 256 --steps 3', 'gpgpu/nbody3d --bench（cudaweb 的 CPU 原生路線）': 'cd ../gpgpu && python3 nbody3d.py --bench 128 --steps 2' };
list.push(...Object.keys(extra));
for (const f of list) {
  const t0 = Date.now();
  try { const r = await fa._terminalRunCommand(session, extra[f] || ('python3 ' + f + '.py'), { guiTimeoutSec: 20 }); const o = String(r.stdout || '') + String(r.stderr || ''); R[f] = { code: r.exit_code, ms: Date.now() - t0, tail: o.slice(-260) }; }
  catch (e) { R[f] = { code: -1, error: String(e).slice(0, 200) }; }
}
R.all_ok = list.every((f) => R[f].code === 0);
return R;
