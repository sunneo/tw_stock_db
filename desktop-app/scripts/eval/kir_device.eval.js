// KIR 裝置層（步驟 1）：緩衝區常駐 GPU 紋理，跨多次派送保留，只在 upload／download 時傳輸。
// 檢查：nbody3d_cl 的四個核心在裝置上連續派送（上傳一次、派送 K 次、讀回一次），結果與 KIR JS 後端（runJs）一致；
// 並量：(a) 每次派送都走 runGl（每次上傳＋讀回）、(b) 裝置連續派送（上傳一次、讀回一次）的耗時。
// 由 scripts/eval/kir_device.build.js 產生（內嵌 KIR 模組與 nbody 的 OpenCL 原始碼）。
const SRC = __SRC__;
const load = (src) => new Function('module', 'require', 'self', src)(undefined, undefined, window);
load(SRC.kir); load(SRC.gen); load(SRC.webgl); load(SRC.front);
const K = window.FaKir, W = window.FaKirWebGL2, FR = window.FaClFront;
const R = {};
const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
const gl = cv.getContext('webgl2');
R.supports = !!gl && W.supportsWebGL2(gl);
const maxErr = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
if (R.supports) {
    const kernels = {}; for (const k of FR.parseKernels(SRC.nbody).kernels) kernels[k.name] = k;
    const N = 512, G = 0.8, e2 = 0.01;
    let seed = 99; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const X = new Float32Array(N), Y = new Float32Array(N), Z = new Float32Array(N), MS = new Float32Array(N);
    for (let i = 0; i < N; i++) { X[i] = rnd() * 10; Y[i] = rnd() * 10; Z[i] = rnd() * 10; MS[i] = 200 + rnd() * 100; }
    // 參考：JS 後端
    const outOf = { accx: 'ax', accy: 'ay', accz: 'az', accpot: 'pot' };
    const ref = {};
    for (const n of Object.keys(outOf)) {
        const k = kernels[n]; const B = {};
        for (const p of k.params) if (p.kind === 'buf') B[p.name] = p.access === 'out' ? new Float32Array(N) : ({ x: X, y: Y, z: Z, ms: MS })[p.name];
        K.runJs(k, B, { n: N, G, e2 }, N);
        ref[outOf[n]] = B[outOf[n]];
    }
    // 裝置路徑
    const dev = W.createDevice(gl);
    const bx = dev.alloc(N, 'f32'), by = dev.alloc(N, 'f32'), bz = dev.alloc(N, 'f32'), bm = dev.alloc(N, 'f32');
    const oa = { ax: dev.alloc(N, 'f32'), ay: dev.alloc(N, 'f32'), az: dev.alloc(N, 'f32'), pot: dev.alloc(N, 'f32') };
    const binds = { x: bx, y: by, z: bz, ms: bm };
    const scal = { n: N, G, e2 };
    const K_ITER = 20;
    // (b) 裝置連續派送：上傳一次，派送 K 次，讀回一次
    dev.upload(bx, X); dev.upload(by, Y); dev.upload(bz, Z); dev.upload(bm, MS);
    const s0 = { ...dev.stats };
    let t0 = performance.now();
    for (let it = 0; it < K_ITER; it++) {
        for (const n of Object.keys(outOf)) dev.dispatch(kernels[n], binds, oa[outOf[n]], scal, N);
    }
    gl.finish();
    const tDev = (performance.now() - t0) / K_ITER;
    const res = {}; for (const key of Object.keys(oa)) res[key] = dev.download(oa[key]);
    const dStats = { uploads: dev.stats.uploads - s0.uploads, downloads: dev.stats.downloads, dispatches: dev.stats.dispatches - s0.dispatches };
    // (a) 每次派送都走 runGl（上傳＋讀回）
    t0 = performance.now();
    for (let it = 0; it < K_ITER; it++) {
        for (const n of Object.keys(outOf)) W.runGl(gl, kernels[n], { x: X, y: Y, z: Z, ms: MS }, scal, N);
    }
    gl.finish();
    const tRun = (performance.now() - t0) / K_ITER;
    const errs = {}; let maxE = 0;
    for (const key of Object.keys(ref)) { errs[key] = maxErr(res[key], ref[key]); maxE = Math.max(maxE, errs[key]); }
    R.device = { N, ms_per_iter_device: +tDev.toFixed(2), ms_per_iter_runGl: +tRun.toFixed(2), stats: dStats, err: errs, ok: maxE <= 1e-3 };
    // 負向測試：輸出等於輸入要被拒絕（feedback）
    let threw = false; try { dev.dispatch(kernels.accx, binds, bx, scal, N); } catch (e) { threw = /feedback/.test(String(e)); }
    R.feedback_rejected = threw;
    for (const k of Object.keys(oa)) dev.free(oa[k]);
    dev.free(bx); dev.free(by); dev.free(bz); dev.free(bm);
}
console.log('KIR_DEVICE ' + JSON.stringify(R));
return R;
