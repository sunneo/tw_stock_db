// node renderer/src/gpu/cl_real_layer.test.js — 真 pyopencl 的純 Python 層＋我們的 _cl.py 的整合測試（官方 vector add 範例原封不動）。
// 需要下載來的第三方檔案（不隨儲存庫出貨），沒設環境變數就略過：
//   FA_PYOPENCL_ROOT＝解開的 pyopencl wheel 根目錄；FA_PYOPENCL_DEPS＝pytools／platformdirs／typing_extensions／mako／markupsafe 的 site 目錄（os.pathsep 分隔）
const cp = require('child_process'), path = require('path');
if (!process.env.FA_PYOPENCL_ROOT || !process.env.FA_PYOPENCL_DEPS) { console.log('略過：沒有設 FA_PYOPENCL_ROOT／FA_PYOPENCL_DEPS（見 pybridge/pyopencl_backend/_real_layer_test.py 檔頭）\n0 passed, 0 failed'); process.exit(0); }
const py = ['python3', 'python'].find((c) => { const r = cp.spawnSync(c, ['-I', '-c', 'import numpy;print(1)'], { encoding: 'utf8' }); return r.status === 0 && r.stdout.trim() === '1'; });
if (!py) { console.log('略過：找不到有 numpy 的 python\n0 passed, 0 failed'); process.exit(0); }
const r = cp.spawnSync(py, ['-I', path.join(__dirname, '..', 'pybridge', 'pyopencl_backend', '_real_layer_test.py')], { encoding: 'utf8', timeout: 300000, env: Object.assign({}, process.env, { FA_OPENCL_HOST: path.join(__dirname, 'cl_host_stdio.js') }) });
process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
process.exit(r.status === 0 ? 0 : 1);
