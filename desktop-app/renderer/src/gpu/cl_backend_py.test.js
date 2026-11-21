// node renderer/src/gpu/cl_backend_py.test.js — pyopencl._cl 後端的端到端測試（Python → stdio → cl_host_stdio.js → ICD 載入器）。
// 只是把 pybridge/pyopencl_backend/_cl_test.py 跑起來；沒有 python3 或 node 就略過。
const cp = require('child_process'), path = require('path');
const py = ['python3', 'python'].find((c) => { const r = cp.spawnSync(c, ['-I', '-c', 'import numpy;print(1)'], { encoding: 'utf8' }); return r.status === 0 && r.stdout.trim() === '1'; });
if (!py) { console.log('略過：找不到有 numpy 的 python\n0 passed, 0 failed'); process.exit(0); }
let bad = 0;
for (const [file, env] of [['_cl_test.py', {}], ['_cl_image_test.py', { FA_CL_DRIVERS: 'clc' }]]) {   // 圖像測試要用 clc 驅動（KIR 驅動沒有圖像）
    const test = path.join(__dirname, '..', 'pybridge', 'pyopencl_backend', file);
    const r = cp.spawnSync(py, ['-I', test], { encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { FA_OPENCL_HOST: path.join(__dirname, 'cl_host_stdio.js'), PYTHONDONTWRITEBYTECODE: '1' }, env) });
    process.stdout.write('[' + file + '] ' + (r.stdout || '')); process.stderr.write(r.stderr || '');
    if (r.status !== 0) bad++;
}
// 跨行程：同一個快取檔，第一次編譯、第二次（全新行程）直接拿 binary——原本的寫法，沒有任何開關
{
    const os = require('os'), fs = require('fs'), f = path.join(os.tmpdir(), 'fa-cl-cache-py-' + process.pid + '.json'); try { fs.unlinkSync(f); } catch (_) { /* 沒有 */ }
    const test = path.join(__dirname, '..', 'pybridge', 'pyopencl_backend', '_cl_cache_test.py');
    for (const phase of ['first', 'second']) {
        const r = cp.spawnSync(py, ['-I', test, phase], { encoding: 'utf-8', timeout: 120000, env: Object.assign({}, process.env, { FA_OPENCL_HOST: path.join(__dirname, 'cl_host_stdio.js'), FA_CL_DRIVERS: 'clc', FA_CL_CACHE_FILE: f, PYTHONDONTWRITEBYTECODE: '1' }) });
        process.stdout.write('[_cl_cache_test.py ' + phase + '] ' + (r.stdout || '')); process.stderr.write(r.stderr || ''); if (r.status !== 0) bad++;
    }
    try { fs.unlinkSync(f); } catch (_) { /* 沒有 */ }
}
process.exit(bad ? 1 : 0);
