// cudaweb 真 WebGPU／WebGL2 檢查（DESIGN.webgpu-cuda.md §9）。在產品視窗（真 Electron 渲染程序）內執行，由 cudaweb_gpu.run.js 啟動。
// 不改產品程式：只呼叫 window.fa._cudawebRuntime()、window.fa._cudawebCall()、window.FaGpuCore，以及執行器注入的 NN（gpu/nn_ops.js）。
// 檢查：介面卡資訊（features、limits、isFallbackAdapter）、backend_info()、三個核心與 CPU 參考版的誤差（T1）、
//       矩陣乘的 WebGL2 層（T3）、五個訓練核心的 T1 與 T3 誤差、Python 橋接的 JS 端（_cudawebCall）。
// 每項都記下層、誤差（範數相對誤差、最大絕對誤差）、暫定容差與耗時。pass 只在全部檢查通過時為 true。
return (async () => {
    const R = { checks: [], errs: [], t0: Date.now() };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const fin = (e) => {
        R.error = e ? String((e && e.stack) || e).slice(0, 1500) : undefined;
        R.totalMs = Date.now() - R.t0;
        R.pass = !e && R.checks.every((c) => c.ok);
        console.log('[eval-file] cudaweb ' + JSON.stringify(R));
        return R;
    };
    // 範數相對誤差 ||a−b||₂ / ||b||₂（與 lora_ref_train_async_test.js 的量測一致）
    const normRel = (a, b) => { let n = 0, d = 0; for (let i = 0; i < b.length; i++) { const x = a[i] - b[i]; n += x * x; d += b[i] * b[i]; } return d > 0 ? Math.sqrt(n / d) : Math.sqrt(n); };
    const maxAbs = (a, b) => { let m = 0; for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
    // 記錄一個核心的誤差：tol 用 tolerance(k)，k 是歸約長度
    const cmp = (name, got, ref, k, layer, ms) => {
        const e = { name, layer, n: ref.length, k, normRel: normRel(got, ref), maxAbs: maxAbs(got, ref), tol: window.FaGpuCore.tolerance(k), ms: Math.round(ms * 100) / 100 };
        e.ok = got.length === ref.length && e.normRel <= e.tol;
        R.errs.push(e);
        ck(name + ' 與 CPU 在容差內（' + layer + '）', e.ok, e);
    };
    const timed = async (f) => { const t = performance.now(); const r = await f(); return { r: r, ms: performance.now() - t }; };
    const seeded = (n, seed) => { let s = seed >>> 0 || 1; const out = new Float32Array(n); for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = ((s % 2001) - 1000) / 500; } return out; };
    try {
        for (let i = 0; i < 100 && !(window.fa && window.fa._cudawebRuntime && window.FaGpuCore); i++) await wait(100);
        // 下一行會被執行器（cudaweb_gpu.run.js）換成 nn_ops.js 的模組載入程式；必須在等待之後執行，才拿得到 window.FaGpuCore
        /*__NN_MODULE__*/
        if (typeof NN === 'undefined') throw new Error('NN（nn_ops）沒有注入');
        // ---- 介面卡 ----
        const ad = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
        R.adapter = ad ? {
            isFallbackAdapter: ad.isFallbackAdapter,
            features: Array.from(ad.features).sort(),
            info: ad.info ? { vendor: ad.info.vendor, architecture: ad.info.architecture, device: ad.info.device, description: ad.info.description } : null,
            limits: { maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize, maxComputeWorkgroupStorageSize: ad.limits.maxComputeWorkgroupStorageSize, maxBufferSize: ad.limits.maxBufferSize, maxComputeInvocationsPerWorkgroup: ad.limits.maxComputeInvocationsPerWorkgroup },
        } : null;
        ck('有 WebGPU 介面卡（真機）', !!ad && !ad.isFallbackAdapter, R.adapter);
        // ---- backend_info ----
        const rt = window.fa._cudawebRuntime();
        R.backendInfo = await rt.backendInfo();
        R.nnBackendInfo = await NN.nnBackendInfo({ navigator: navigator });

        // ---- 核心（T1，真 WebGPU）：向量加、矩陣乘、歸約、axpy ----
        const va = [], vb = []; for (let i = 0; i < 1000; i++) { va.push(Math.fround(Math.sin(i))); vb.push(Math.fround(Math.cos(i * 0.5))); }
        const vaT = await timed(() => rt.vectorAdd(va, vb));
        cmp('vector_add', Float32Array.from(vaT.r.result), window.FaGpuCore.vectorAddRef(Float32Array.from(va), Float32Array.from(vb)), 1, vaT.r.info.layer, vaT.ms);
        const m = 17, k = 19, n = 21;
        const A = [], B = []; for (let i = 0; i < m * k; i++) A.push(((i * 37) % 29) / 7 - 2); for (let i = 0; i < k * n; i++) B.push(((i * 53) % 31) / 9 - 1.5);
        const mmT = await timed(() => rt.matmul(A, B, m, k, n));
        cmp('matmul 17×19×21', Float32Array.from(mmT.r.result), window.FaGpuCore.matmulRef(Float32Array.from(A), Float32Array.from(B), m, k, n), k, mmT.r.info.layer, mmT.ms);
        const xs = []; for (let i = 0; i < 1000; i++) xs.push(((i * 7919) % 2001) / 1000 - 1);
        const smT = await timed(() => rt.sum(xs));
        cmp('sum（n=1000）', [smT.r.result], [window.FaGpuCore.sumExact(xs)], 1000, smT.r.info.layer, smT.ms);
        const axT = await timed(() => rt.axpy(2, [1, 2, 3, 4], [10, 20, 30, 40]));
        ck('axpy 結果正確（T1）', JSON.stringify(axT.r.result) === JSON.stringify([12, 24, 36, 48]) && axT.r.info.layer === 'T1', axT.r.info);
        // ---- 其餘 BLAS 一級／二級與 T2 替代（真機補測；這些以前只在假裝置上跑過）----
        const sx = seeded(1000, 10);
        const scT = await timed(() => rt.scal(1.5, Array.from(sx)));
        cmp('scal（n=1000）', Float32Array.from(scT.r.result), window.FaGpuCore.scalRef(1.5, sx), 1, scT.r.info.layer, scT.ms);
        const dtT = await timed(() => rt.dot(Array.from(va), Array.from(vb)));
        cmp('dot（n=1000）', [dtT.r.result], [window.FaGpuCore.dotRef(Float32Array.from(va), Float32Array.from(vb))], 1000, dtT.r.info.layer, dtT.ms);
        const nrT = await timed(() => rt.nrm2(Array.from(sx)));
        cmp('nrm2（n=1000）', [nrT.r.result], [window.FaGpuCore.nrm2Ref(sx)], 1000, nrT.r.info.layer, nrT.ms);
        const GA = seeded(16 * 32, 11), gx = seeded(32, 12);
        const gvT = await timed(() => rt.gemv(Array.from(GA), Array.from(gx), 16, 32));
        cmp('gemv（16×32）', Float32Array.from(gvT.r.result), window.FaGpuCore.gemvRef(Float32Array.from(GA), Float32Array.from(gx), 16, 32), 32, gvT.r.info.layer, gvT.ms);
        const sdT = await timed(() => rt.sumDd(xs));
        cmp('sum_dd（雙 f32 歸約，n=1000，對精確和）', [sdT.r.result], [window.FaGpuCore.sumExact(xs)], 1000, sdT.r.info.layer, sdT.ms);
        const sIdx = []; for (let i = 0; i < 512; i++) sIdx.push((i * 7) % 16);
        const sVals = Array.from(seeded(512, 13));
        const saT = await timed(() => rt.scatterAdd(sIdx, sVals, 16));
        cmp('scatter_add（512 筆、16 桶）', Float32Array.from(saT.r.result), window.FaGpuCore.scatterAddRef(sIdx, Float32Array.from(sVals), 16), 32, saT.r.info.layer, saT.ms);
        // ---- createBatch：一個 command encoder 內串接 RMSNorm → SiLU → softmax，只 submit 一次、只回讀一次 ----
        const bT = 16, bd = 64;
        const bx = seeded(bT * bd, 14), bg = seeded(bd, 15);
        const navDev = (await NN.getDevice(navigator)).dev;
        if (!navDev) throw new Error('createBatch：沒有 WebGPU 裝置');
        const bt = NN.createBatch(navDev);
        const bxb = bt.upload(bx), bgb = bt.upload(bg);
        const bn1 = bt.rmsnorm(bxb, bgb, bT, bd, 1e-6), bs1 = bt.silu(bn1), bs2 = bt.softmax(bs1, bT, bd);
        const bT0 = performance.now();
        const [bOut] = await bt.read([[bs2, bT * bd]]);
        const bMs = performance.now() - bT0;
        R.batchStats = bt.stats;
        cmp('createBatch（rmsnorm→silu→softmax）', bOut, NN.softmaxRef(NN.siluRef(NN.rmsnormRef(bx, bg, bT, bd, 1e-6)), bT, bd), bd, 'T1（批次）', bMs);
        ck('createBatch 只 submit 一次、只回讀一次', bt.stats.dispatches === 3 && bt.stats.readbacks === 1, bt.stats);

        // ---- WebGL2 層（T3）：矩陣乘 ----
        const rtGl = window.FaGpuCore.createRuntime({ navigator: {} });
        const mg = await timed(() => rtGl.matmul(A, B, m, k, n));
        cmp('matmul 17×19×21（WebGL2）', Float32Array.from(mg.r.result), window.FaGpuCore.matmulRef(Float32Array.from(A), Float32Array.from(B), m, k, n), k, mg.r.info.layer, mg.ms);
        ck('matmul 確實走 T3（WebGL2）', mg.r.info.layer === 'T3', mg.r.info);

        // ---- Python 橋接的 JS 端（_cudawebCall，與 cudaweb.py 呼叫的是同一個入口） ----
        if (typeof window.fa._cudawebCall === 'function') {
            const bc = await window.fa._cudawebCall('vector_add', { a: [1, 2, 3], b: [4, 5, 6] });
            const bcv = bc && bc.result !== undefined ? bc.result : bc;
            ck('_cudawebCall(vector_add) 結果正確（Python 橋接的 JS 端）', JSON.stringify(bcv) === JSON.stringify([5, 7, 9]), bc);
            const bi = await window.fa._cudawebCall('backend_info', {});
            R.bridgeBackendInfo = bi && bi.result;
        } else ck('_cudawebCall 存在', false, '沒有這個入口');

        // ---- 五個訓練核心：T1（真 WebGPU）與 T3（WebGL2，不給 WebGPU） ----
        const T = 16, d = 64, rows = 16, cols = 37, N = 1000, H = 4, hd = 16, Tt = 8;
        const x1 = seeded(T * d, 1), g1 = seeded(d, 2), xs2 = seeded(rows * cols, 3), xsilu = seeded(N, 4), xrope = seeded(Tt * H * hd, 5);
        const pp = seeded(N, 6), gg = seeded(N, 7), mm0 = seeded(N, 8).map((z) => z * 0.1), vv0 = seeded(N, 9).map((z) => Math.abs(z) * 0.1);
        const cases = [
            { name: 'rmsnorm（T=16，d=64）', k: d, ref: () => NN.rmsnormRef(x1, g1, T, d, 1e-6), run: (o) => NN.rmsnorm(x1, g1, T, d, 1e-6, o), out: (r) => r.result },
            { name: 'softmax（16×37）', k: cols, ref: () => NN.softmaxRef(xs2, rows, cols), run: (o) => NN.softmax(xs2, rows, cols, o), out: (r) => r.result },
            { name: 'silu（n=1000）', k: 1, ref: () => NN.siluRef(xsilu), run: (o) => NN.silu(xsilu, o), out: (r) => r.result },
            { name: 'rope（T=8，H=4，hd=16）', k: 1, ref: () => NN.ropeRef(xrope, Tt, H, hd, 1), run: (o) => NN.rope(xrope, Tt, H, hd, 1, o), out: (r) => r.result },
            { name: 'adamw（n=1000，p 輸出）', k: 1, ref: () => NN.adamwRef(pp, gg, mm0, vv0, 3, 0.01, 0.9, 0.999, 1e-8, 0.01).p, run: (o) => NN.adamw(pp, gg, mm0, vv0, 3, 0.01, 0.9, 0.999, 1e-8, 0.01, o), out: (r) => r.result.p },
        ];
        R.nnLayers = {};
        for (const c of cases) {
            const t1 = await timed(() => c.run({ navigator: navigator }));
            R.nnLayers[c.name + ' T1'] = t1.r.info;
            cmp('訓練核心 ' + c.name, Float32Array.from(c.out(t1.r)), c.ref(), c.k, t1.r.info.layer, t1.ms);
            const t3 = await timed(() => c.run({ navigator: {} }));
            R.nnLayers[c.name + ' T3'] = t3.r.info;
            cmp('訓練核心 ' + c.name, Float32Array.from(c.out(t3.r)), c.ref(), c.k, t3.r.info.layer, t3.ms);
        }
        // AdamW 的 m、v 也要比（同一趟計算）
        const aw = await NN.adamw(pp, gg, mm0, vv0, 3, 0.01, 0.9, 0.999, 1e-8, 0.01, { navigator: navigator });
        const awRef = NN.adamwRef(pp, gg, mm0, vv0, 3, 0.01, 0.9, 0.999, 1e-8, 0.01);
        cmp('訓練核心 adamw（m 輸出）', Float32Array.from(aw.result.m), awRef.m, 1, aw.info.layer, 0);
        cmp('訓練核心 adamw（v 輸出）', Float32Array.from(aw.result.v), awRef.v, 1, aw.info.layer, 0);

        R.final = await rt.backendInfo();
        return fin(null);
    } catch (e) {
        return fin(e);
    }
})();
