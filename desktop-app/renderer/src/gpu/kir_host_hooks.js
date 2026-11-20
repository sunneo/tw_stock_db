/* KIR 的主機掛鉤（DESIGN.webgpu-cuda.md §13 階段 7）：決定 OpenCL 核心實際用哪個後端，並把它交給 llvm_host。UMD，瀏覽器掛 FaKirHostHooks。
 * 退路順序：WebGPU（需要 JSPI，因為讀回是非同步的）→ WebGL2（同步）→ JS 墊片（host 內建）。每一步失敗都記下具體原因（reasons），
 * 不靜默降級：setup 的結果 describe() 會說實際用的後端，以及沒用上 WebGPU 的原因。
 *   setup({ mods, nav, makeCanvas, jspi }) → Promise<{ backend: 'webgpu'|'webgl2'|'js', hooks, reasons, describe(), stats() }>
 *     mods：{ FaKir, FaKirGen, FaKirWebGL2, FaKirWebGPU, FaClFront }（缺哪個就不用哪個後端）
 *     nav：navigator（需要 gpu）；makeCanvas()：回傳可以 getContext('webgl2') 的畫布（離屏）；jspi：WebAssembly.Suspending 與 promising 都存在
 *   hooks：{ kirTranslate, kirRun, kirDev, kirBackend, asyncReadback }，直接展開給 FaLlvmHost.create。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaKirHostHooks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const LABEL = { webgpu: 'WebGPU（KIR）', webgl2: 'WebGL2（KIR）', js: 'JS 墊片' };

    // 裝置包一層計數（給 HUD 與終端機訊息用）；錯誤原因記下最後一次
    function wrapDevice(dev, kind, st) {
        const count = (name) => { st.calls[name] = (st.calls[name] || 0) + 1; };
        const fail = (name, e) => { st.lastError = name + '：' + String((e && e.message) || e).slice(0, 200); throw e; };
        return {
            alloc: (N, elem) => dev.alloc(N, elem),
            allocPacked: (Npart, parts) => { if (!dev.allocPacked) throw new Error('這個裝置沒有打包緩衝區'); return dev.allocPacked(Npart, parts); },
            view: (parent, k) => { if (!dev.view) throw new Error('這個裝置沒有 view'); return dev.view(parent, k); },
            upload: (b, arr) => dev.upload(b, arr),
            download: (b) => { count('download'); try { const r = dev.download(b); if (r && typeof r.then === 'function') return r.catch((e) => fail('download', e)); return r; } catch (e) { return fail('download', e); } },
            dispatch: (k, binds, out, scal, N) => { try { dev.dispatch(k, binds, out, scal, N); st.dispatches[kind]++; } catch (e) { fail('dispatch', e); } },
            free: (b) => { try { dev.free(b); } catch (_) { /* 釋放失敗不影響結果 */ } },
            // 命令佇列控制與工作群調校（只有 WebGPU 裝置有）：OpenCL 的 finish 要刷新並等 GPU 做完；local_work_size 與自動調校走這裡
            ...(dev.flush ? { flush: () => dev.flush() } : {}), ...(dev.sync ? { sync: () => dev.sync() } : {}),
            ...(dev.setWorkgroup ? { setWorkgroup: (k, n) => dev.setWorkgroup(k, n) } : {}), ...(dev.ensureTuned ? { ensureTuned: (...a) => dev.ensureTuned(...a) } : {}),
            // 只有 WebGPU 裝置有點精靈（drawPoints）；失敗就記下原因，呼叫端退回讀回＋GL 點
            ...(dev.drawPoints ? { drawPoints: (pos, n, q) => { count('drawPoints'); try { return dev.drawPoints(pos, n, q); } catch (e) { return fail('drawPoints', e); } } } : {}),
        };
    }

    async function setup(o) {
        const mods = o.mods || {}, nav = o.nav, reasons = {}, st = { dispatches: { webgpu: 0, webgl2: 0 }, calls: {}, lastError: '' };
        const jspi = !!o.jspi;
        // 測試用的強制後端（評測要比較三種路徑）：'webgl2'＝不試 WebGPU；'js'＝兩個 GPU 都不試。只影響選擇，不影響結果。
        const force = o.force === 'webgl2' || o.force === 'js' ? o.force : '';
        // 1. WebGPU
        let gpuDev = null;
        if (force) reasons.webgpu = '強制後端：' + force + '（測試用）';
        else if (!mods.FaKirWebGPU) reasons.webgpu = 'KIR 的 WebGPU 模組沒有嵌入';
        else if (!jspi) reasons.webgpu = '這個環境沒有 JSPI（WebAssembly.Suspending），WebGPU 的讀回要用它';
        else if (!nav || !nav.gpu || typeof nav.gpu.requestAdapter !== 'function') reasons.webgpu = '此環境沒有 WebGPU（navigator.gpu 不存在）';
        else {
            try {
                const ad = await nav.gpu.requestAdapter();
                if (!ad) reasons.webgpu = '沒有可用的顯示卡介面卡（requestAdapter 回傳空值）';
                else {
                    const gd = await ad.requestDevice();
                    gpuDev = mods.FaKirWebGPU.createDevice(gd, { wg: 64 });
                }
            } catch (e) { reasons.webgpu = 'WebGPU 初始化失敗：' + String((e && e.message) || e).slice(0, 200); gpuDev = null; }
        }
        // 2. WebGL2（同步；沒有 WebGPU 時的退路）
        let glDev = null, gl = null;
        if (force === 'js') reasons.webgl2 = '強制後端：js（測試用）';
        else if (!mods.FaKirWebGL2) reasons.webgl2 = 'KIR 的 WebGL2 模組沒有嵌入';
        else {
            try {
                const cv = typeof o.makeCanvas === 'function' ? o.makeCanvas() : null;
                gl = cv && typeof cv.getContext === 'function' ? cv.getContext('webgl2') : null;
                if (!gl) reasons.webgl2 = 'WebGL2 上下文不可用';
                else if (!mods.FaKirWebGL2.supportsWebGL2(gl)) reasons.webgl2 = '缺 EXT_color_buffer_float（浮點渲染目標）';
                else glDev = mods.FaKirWebGL2.createDevice(gl);
            } catch (e) { reasons.webgl2 = 'WebGL2 初始化失敗：' + String((e && e.message) || e).slice(0, 200); glDev = null; }
        }
        // 3. 選擇
        const backend = gpuDev ? 'webgpu' : (glDev ? 'webgl2' : 'js');
        const dev = backend === 'webgpu' ? wrapDevice(gpuDev, 'webgpu', st) : (backend === 'webgl2' ? wrapDevice(glDev, 'webgl2', st) : null);
        // 翻譯：只收 KIR 驗證通過、而且該後端能產生程式的核心（WebGPU 收 WGSL，WebGL2 收 GLSL）
        const kirTranslate = (src) => {
            if (!mods.FaClFront || !mods.FaKir) return null;
            const r = mods.FaClFront.parseKernels(src); if (!r.ok) return null;
            const m = {};
            for (const k of r.kernels) {
                if (!mods.FaKir.validate(k).ok) continue;
                const ok = backend === 'webgpu' ? (mods.FaKirGen && mods.FaKirGen.toWgsl(k, { wg: 64 }).ok) : (mods.FaKirGen && mods.FaKirGen.toGlsl(k).ok);
                if (ok) m[k.name] = k;
            }
            return m;
        };
        // kirRun 是同步的：只有 WebGL2 後端有（WebGPU 的讀回是非同步，不能給同步的 kirRun）
        const kirRun = backend === 'webgl2' ? (k, bufs, scal, N) => {
            const r = mods.FaKirWebGL2.runGl(gl, k, bufs, scal, N); st.dispatches.webgl2++; return r;
        } : null;
        const hooks = backend === 'js'
            ? {}
            : { kirTranslate, kirRun, kirDev: dev, kirBackend: backend, asyncReadback: backend === 'webgpu' };
        const describe = () => {
            let s = '後端：' + LABEL[backend];
            if (backend !== 'webgpu' && reasons.webgpu) s += '（WebGPU 未使用：' + reasons.webgpu + '）';
            if (backend === 'js' && reasons.webgl2) s += '（WebGL2 未使用：' + reasons.webgl2 + '）';
            return s;
        };
        return { backend, hooks, reasons, describe, stats: () => ({ backend, dispatches: st.dispatches.webgpu + st.dispatches.webgl2, byBackend: Object.assign({}, st.dispatches), calls: Object.assign({}, st.calls), lastError: st.lastError }) };
    }

    return { setup, LABEL };
});
