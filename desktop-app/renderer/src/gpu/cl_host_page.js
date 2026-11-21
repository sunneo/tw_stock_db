/* OpenCL 的頁面端主機（FaClHostPage，UMD）：建立載入器、依環境註冊驅動，回傳 Python 端 `_fa_opencl.call` 要的介面。
 *   const H = await FaClHostPage.create({ mods, nav, makeCanvas, jspi, force, smallN });
 *   H.call(op, argsJson, bytes) → Promise<{ json, data }>      （Pyodide 的 _PyodideTransport 呼叫它；data 是 Uint8Array 或 undefined）
 * 驅動（依序，第一個就是 create_some_context 的預設）：
 *   1. GPU：WebGPU（cudaweb／KIR 的 WGSL）→ WebGL2（GLSL）——kir_host_hooks.setup 選，每一步失敗都記原因；沒有 GPU 就沒有這個驅動
 *   2. CPU：clc（OpenCL C 前端→JS），也是 GPU 驅動的主機退路
 * mods 要有：FaClIcd、FaClHostOps、FaClc、FaClFront、FaKir、FaKirHostHooks（及其用到的 FaKirGen／FaKirWebGL2／FaKirWebGPU）。
 * 接進 floating-assistant.js（pyodide.registerJsModule('_fa_opencl', …)）與嵌入腳本是另一步（見 DESIGN.pyopencl.md §10.3）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaClHostPage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    async function create(o) {
        const M = o.mods || {};
        for (const k of ['FaClIcd', 'FaClHostOps', 'FaClc', 'FaClFront', 'FaKir']) if (!M[k]) throw new Error('FaClHostPage.create 需要 mods.' + k);
        const hk = o.setup ? o.setup : M.FaKirHostHooks ? await M.FaKirHostHooks.setup({ mods: M, nav: o.nav, makeCanvas: o.makeCanvas, jspi: !!o.jspi, force: o.force }) : { backend: 'js', hooks: {}, reasons: { webgpu: 'KIR 的主機掛鉤沒有嵌入' }, describe: () => '後端：JS（沒有 GPU 掛鉤）' };
        // 快取永遠開著（無痕）：瀏覽器／Electron 用 IndexedDB（頁面與 Worker 共用同一個庫），開不起來就退記憶體；多層與目標見 cl_cache.js
        let cache = null;
        if (M.FaClCache) {
            let storage = null; try { if (typeof indexedDB !== 'undefined' && indexedDB) storage = M.FaClCache.idbAdapter(indexedDB, 'fa-cl-cache'); } catch (_) { storage = null; }
            cache = M.FaClCache.createCache({ storage: storage || M.FaClCache.memoryAdapter(), now: o.now, toIL: M.FaClc2Spv ? M.FaClc2Spv.toIL : null });   // toIL：source→SPIR-V 前端（偏好 IL 的驅動才會用）
            if (typeof addEventListener === 'function') { const k = () => cache.kick(); try { addEventListener('pagehide', k); addEventListener('visibilitychange', () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') k(); }); } catch (_) { /* 沒有頁面事件（Worker）：寫入照樣在背景進行 */ } }   // 沖出位置：頁面隱藏／離開
        }
        const loader = M.FaClIcd.createLoader({ cache });
        if (hk.backend !== 'js' && hk.hooks && hk.hooks.kirDev) {
            const gen = M.FaKirGen;
            const canGenerate = (k) => (hk.backend === 'webgpu' ? !!(gen && gen.toWgsl(k, { wg: 64 }).ok) : !!(gen && gen.toGlsl(k).ok));
            loader.registerDriver(M.FaClIcd.makeGpuDriver({ mods: M, device: hk.hooks.kirDev, backend: hk.backend, canGenerate, smallN: o.smallN, wasm: true }));   // 主機路線（小問題等）用 wasm
        }
        loader.registerDriver(M.FaClIcd.makeClcDriver({ mods: M, wasm: true }));   // cpu 預設是 wasm（M.FaSpvWasm 不在就等同 clc 直接編譯的 JS）；不支援的核心自動退回
        const host = M.FaClHostOps.create(loader);
        const u8 = (b) => (b == null ? null : b instanceof Uint8Array ? b : new Uint8Array(b.buffer || b, b.byteOffset || 0, b.byteLength));
        return {
            backend: hk.backend, reasons: hk.reasons, loader, hooks: hk,
            describe: () => hk.describe() + '；OpenCL 平台：' + loader.platforms().map((p) => p.name).join('、'),
            stats: () => Object.assign({}, loader.stats(), { gpu: hk.stats ? hk.stats() : null, cache: cache ? cache.stats() : null }),
            call: async (op, argsJson, bytes) => { const r = await host.call(op, argsJson ? JSON.parse(argsJson) : {}, u8(bytes)); return { json: JSON.stringify(r.result), data: r.data }; }
        };
    }
    // ======================================================================================
    // 安裝進 Pyodide（頁面的 Pyodide 與 GUI 程式的 Worker 共用）：沒有 import pyopencl 的程式什麼都不做。
    //   await FaClHostPage.prepare(py, { mods, nav, makeCanvas, jspi, files, onProgress, version })
    //   files：FA_PYBRIDGE_FILES（相對 pybridge 的路徑 → 內容）。做的事：
    //   1. 把 fa_pyopencl.py、pyopencl_backend/_cl.py、test_support/siphash24.py、fa_opengl_platform.py 寫進 /fa_pyopencl_boot
    //   2. 註冊 JS 模組 _fa_opencl（Python 端 _cl.py 的 _PyodideTransport 呼叫它）；載入器與 GPU 驅動在第一次呼叫時才建立
    //   3. 取得真的 pyopencl：從 PyPI 下載 wheel（只要純 Python 檔案；不隨產品出貨，每次由使用者的瀏覽器取得，授權是 MIT），去掉 C 擴充與 libOpenCL，
    //      放上我們的 _cl.py（由 _cl.py 取代 C 擴充），micropip 裝 pytools／mako（platformdirs、markupsafe、typing-extensions 是 Pyodide 內建套件；deps=False：pytools 要 siphash24，那是 C 擴充，由我們的純 Python 後備取代）
    //   4. sys.path 與 fa_pyopencl.install()（import 鉤子：get_gl_sharing_context_properties 改用我們的 GL 上下文回應）
    // **這一段沒有在真 Pyodide 驗證**（本機沒有 Pyodide；Python 端的 _cl.py、鉤子、整合測試都在一般 CPython 驗證過）。
    // ======================================================================================
    const ASSEMBLE_PY = [
        'import os, shutil, sys',
        "src, dst = '/fa_pyopencl_tmp', '/fa_pyopencl'",
        'os.makedirs(dst, exist_ok=True)',
        "ign = lambda d, names: [n for n in names if n.endswith('.so') or n in ('.libs', '_cl.pyi', '__pycache__')]",
        "shutil.copytree(src + '/pyopencl', dst + '/pyopencl', ignore=ign, dirs_exist_ok=True)",
        "for n in os.listdir(src):",
        "    if n.endswith('.dist-info'): shutil.copytree(src + '/' + n, dst + '/' + n, dirs_exist_ok=True)",
        "shutil.copy('/fa_pyopencl_boot/_cl.py', dst + '/pyopencl/_cl.py')",
        "shutil.copy('/fa_pyopencl_boot/siphash24.py', dst + '/siphash24.py')",
        'shutil.rmtree(src, ignore_errors=True)',
        "for p in (dst, '/fa_pyopencl_boot'):",
        '    if p not in sys.path: sys.path.insert(0, p)',
        'import fa_pyopencl',
        'fa_pyopencl.install()'
    ].join('\n');

    async function prepare(py, o) {
        o = o || {};
        const full = lastText === null || wantsPy(lastText);   // 沒有記錄（舊的呼叫方式）就當完整
        if (py.__faClReady || (!full && py.__faClCoreReady)) {   // 已準備好：但 numpy 若不在了（上一次失敗、或環境被重設）要補載，不然腳本 import numpy 會失敗
            if (!(py.loadedPackages && py.loadedPackages.numpy)) { try { await py.loadPackage('numpy'); } catch (e) { throw new Error('numpy 載入失敗（多半是下載 Pyodide 套件時網路／CDN 暫時不通）；稍後重新執行會再試一次'); } }
            return;
        }
        if (py.__faClPreparing) return py.__faClPreparing;
        py.__faClPreparing = (async () => {
            const log = o.onProgress || (() => {}), files = o.files || {}, FS = py.FS;
            const put = (dst, key) => { if (files[key] == null) throw new Error('缺少 ' + key + '（FA_PYBRIDGE_FILES 沒有嵌入）'); try { FS.mkdirTree(dst.slice(0, dst.lastIndexOf('/'))); } catch (_) { /* 已存在 */ } FS.writeFile(dst, files[key]); };
            put('/fa_pyopencl_boot/fa_pyopencl.py', 'fa_pyopencl.py'); put('/fa_pyopencl_boot/_cl.py', 'pyopencl_backend/_cl.py'); put('/fa_pyopencl_boot/siphash24.py', 'pyopencl_backend/test_support/siphash24.py');
            if (files['fa_opengl_platform.py'] != null) put('/fa_pyopencl_boot/fa_opengl_platform.py', 'fa_opengl_platform.py');   // GL 互通（GLBuffer）用；沒有 OpenGL 的程式不會載入它
            let hostP = null; const host = () => (hostP = hostP || create(o));
            if (!py.__faClModule) py.registerJsModule('_fa_opencl', { call: async (op, argsJson, bytes) => { const H = await host(); return H.call(String(op), String(argsJson || '{}'), bytes == null ? null : bytes); }, describe: async () => (await host()).describe() });
            log('載入 numpy 與相依套件…');
            // Pyodide 發行版有的套件（名字以 pyodide-lock.json 為準；逐一載入，缺哪個就略過並記下，不讓整個準備失敗）
            for (const name of ['micropip', 'numpy', 'markupsafe', 'typing-extensions', 'platformdirs']) { try { await py.loadPackage(name); } catch (e) { log('套件 ' + name + ' 載入失敗：' + String((e && e.message) || e).slice(0, 120)); } }
            if (!(py.loadedPackages && py.loadedPackages.numpy)) throw new Error('numpy 載入失敗（多半是下載 Pyodide 套件時網路／CDN 暫時不通）；稍後重新執行會再試一次');   // 不能在 numpy 沒載入時標成「已準備好」，否則之後的執行都會直接略過、腳本 import numpy 失敗
            if (!full) { py.runPython("import sys\nif '/fa_pyopencl_boot' not in sys.path:\n    sys.path.insert(0, '/fa_pyopencl_boot')"); py.__faClCoreReady = true; py.__faClModule = true; log('OpenCL 後端（核心）已準備好'); return; }   // 只有核心：cudaweb 的 CPU 原生路線用 _cl，不下載 pyopencl
            py.__faClModule = true;
            const fetchFn = o.fetch || (typeof fetch === 'function' ? fetch : null); if (!fetchFn) throw new Error('沒有 fetch，無法取得 pyopencl');
            const version = o.version || '2026.1.5';
            log('從 PyPI 取得 pyopencl ' + version + '（只取純 Python 檔案）…');
            const meta = await (await fetchFn('https://pypi.org/pypi/pyopencl/' + version + '/json')).json();
            const wheel = (meta.urls || []).find((u) => u.packagetype === 'bdist_wheel'); if (!wheel) throw new Error('PyPI 上找不到 pyopencl ' + version + ' 的 wheel');
            const buf = await (await fetchFn(wheel.url)).arrayBuffer();
            py.unpackArchive(buf, 'zip', { extractDir: '/fa_pyopencl_tmp' });
            log('安裝 pytools、mako…');
            await py.runPythonAsync("import micropip\nawait micropip.install(['pytools', 'mako'], deps=False)");   // 兩個都是純 Python wheel；pytools 的相依 siphash24 是 C 擴充，由我們的純 Python 後備取代
            py.runPython(ASSEMBLE_PY);
            py.__faClReady = true;
        })();
        try { await py.__faClPreparing; } finally { py.__faClPreparing = null; }
    }
    // 程式原始碼有沒有 import pyopencl（呼叫端用它決定要不要 prepare）
    // 腳本要不要準備 OpenCL 後端：import pyopencl（要完整的 pyopencl，從 PyPI 取純 Python 檔案）；或用 numba／cudaweb（GPU 不能跑時，cudaweb 的 CPU 原生路線要用，只要 _fa_opencl 與 _cl.py，不下載 pyopencl）。
    // wantsPyopencl 記下最後一次檢查的腳本，prepare 據此決定完整或只有核心（呼叫端的接線是「先 wantsPyopencl(text)、再 prepare(...)」，不用改）。
    let lastText = null;
    const wantsPy = (src) => /(?:^|\n)[ \t]*(?:import|from)[ \t]+pyopencl\b/.test(String(src || ''));
    const wantsCore = (src) => /(?:^|\n)[ \t]*(?:import|from)[ \t]+(?:numba|cudaweb)\b/.test(String(src || ''));
    const wantsPyopencl = (src) => { lastText = String(src || ''); return wantsPy(src) || wantsCore(src); };

    return { create, prepare, wantsPyopencl, ASSEMBLE_PY };
});
