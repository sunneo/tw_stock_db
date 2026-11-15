// cudaweb 真 WebGPU 檢查（DESIGN.webgpu-cuda.md 第一階段、§8）。在產品視窗（真 Electron 渲染程序）內執行，由 cudaweb_gpu.run.js 啟動。
// 不改產品程式：只呼叫 window.fa._cudawebRuntime()（與 Python 模擬器 cudaweb 用的是同一份執行期）。
// 檢查：介面卡與功能清單（照實記錄）、向量加／矩陣乘／歸約的結果與 CPU 參考版比對、每次呼叫的層（T1 或 T4）與原因。
// 沒有 WebGPU 時仍會印結果（層會是 T4、原因寫明），但 pass 只在 T1 的結果都正確時才為 true，所以不會把降級誤判為通過。
return (async () => {
    const R = { checks: [], t0: Date.now() };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const fin = (e) => {
        R.error = e ? String((e && e.stack) || e).slice(0, 1500) : undefined;
        R.totalMs = Date.now() - R.t0;
        R.pass = !e && R.checks.every((c) => c.ok);
        console.log('[eval-file] cudaweb ' + JSON.stringify(R));
        return R;
    };
    try {
        for (let i = 0; i < 100 && !(window.fa && window.fa._cudawebRuntime); i++) await wait(100);
        const rt = window.fa._cudawebRuntime();
        const bi0 = await rt.backendInfo();
        R.navigatorGpu = !!navigator.gpu;
        R.probe = { hasWebGPU: bi0.hasWebGPU, hasAdapter: bi0.hasAdapter, reason: bi0.probeReason, features: bi0.features, limits: bi0.limits, deviceReady: bi0.deviceReady };

        const va = await rt.vectorAdd([1, 2, 3, 4], [10, 20, 30, 40]);
        ck('vector_add 結果正確', JSON.stringify(va.result) === JSON.stringify([11, 22, 33, 44]), va.result);
        ck('vector_add 在 T1（真 WebGPU）', va.info.layer === 'T1', va.info);

        const m = 17, k = 19, n = 21;
        const A = [], B = [];
        for (let i = 0; i < m * k; i++) A.push(((i * 37) % 29) / 7 - 2);
        for (let i = 0; i < k * n; i++) B.push(((i * 53) % 31) / 9 - 1.5);
        const mm = await rt.matmul(A, B, m, k, n);
        const ref = window.FaGpuCore.matmulRef(Float32Array.from(A), Float32Array.from(B), m, k, n);
        let maxRel = 0;
        for (let i = 0; i < ref.length; i++) maxRel = Math.max(maxRel, Math.abs(mm.result[i] - ref[i]) / Math.max(1, Math.abs(ref[i])));
        const tolMm = window.FaGpuCore.tolerance(k);
        ck('matmul 與 CPU 參考版的最大相對誤差在暫定容差內', maxRel <= tolMm, { maxRel, tol: tolMm });
        ck('matmul 在 T1（真 WebGPU）', mm.info.layer === 'T1', mm.info);

        const xs = []; for (let i = 0; i < 1000; i++) xs.push(((i * 7919) % 2001) / 1000 - 1);
        const sm = await rt.sum(xs);
        const exact = window.FaGpuCore.sumExact(xs);
        const relS = Math.abs(sm.result - exact) / Math.max(1, Math.abs(exact));
        ck('sum 與高精度參考的相對誤差在暫定容差內', relS <= window.FaGpuCore.tolerance(1000), { got: sm.result, exact, relS });
        ck('sum 在 T1（真 WebGPU）', sm.info.layer === 'T1', sm.info);

        R.lastInfos = { vector_add: va.info, matmul: mm.info, sum: sm.info };
        R.final = await rt.backendInfo();
        return fin(null);
    } catch (e) {
        return fin(e);
    }
})();
