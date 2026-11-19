// KIR 裝置層：打包緩衝區（一張紋理裝四個部分）。四個 nbody 加速度核心各寫一個 view，讀回一次（download(packed)）。
// 檢查：四個部分與 KIR JS 後端一致；計時：每次迭代「4 次派送＋1 次讀回（打包）」對「4 次派送＋4 次讀回（各自的緩衝區）」。
// 由 scripts/eval/kir_packed.build.js 產生。
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
    const names = ['accx', 'accy', 'accz', 'accpot'];
    const ref = {};
    for (const n of names) {
        const k = kernels[n]; const B = {};
        for (const p of k.params) if (p.kind === 'buf') B[p.name] = p.access === 'out' ? new Float32Array(N) : ({ x: X, y: Y, z: Z, ms: MS })[p.name];
        K.runJs(k, B, { n: N, G, e2 }, N);
        ref[n] = B[k.params.find((p) => p.access === 'out').name];
    }
    const dev = W.createDevice(gl);
    const bx = dev.alloc(N, 'f32'), by = dev.alloc(N, 'f32'), bz = dev.alloc(N, 'f32'), bm = dev.alloc(N, 'f32');
    dev.upload(bx, X); dev.upload(by, Y); dev.upload(bz, Z); dev.upload(bm, MS);
    const binds = { x: bx, y: by, z: bz, ms: bm };
    const scal = { n: N, G, e2 };
    // 打包：部分 0..3 ＝ ax、ay、az、pot
    const packed = dev.allocPacked(N, 4);
    const views = [0, 1, 2, 3].map((k) => dev.view(packed, k));
    const outIdx = { accx: 0, accy: 1, accz: 2, accpot: 3 };
    // 正確性：一次派送四個 view，讀回一次
    for (const n of names) dev.dispatch(kernels[n], binds, views[outIdx[n]], scal, N);
    const all = dev.download(packed);
    const errs = {}; let maxE = 0;
    names.forEach((n, k) => { const part = all.subarray(k * N, (k + 1) * N); errs[n] = maxErr(part, ref[n]); maxE = Math.max(maxE, errs[n]); });
    // 計時（K_ITER 次迭代）
    const KI = 20;
    const bufs = names.map(() => dev.alloc(N, 'f32'));
    let t0 = performance.now();
    for (let it = 0; it < KI; it++) { for (const n of names) dev.dispatch(kernels[n], binds, views[outIdx[n]], scal, N); dev.download(packed); }
    gl.finish(); const tPacked = (performance.now() - t0) / KI;
    t0 = performance.now();
    for (let it = 0; it < KI; it++) { names.forEach((n, k) => dev.dispatch(kernels[n], binds, bufs[k], scal, N)); for (const b of bufs) dev.download(b); }
    gl.finish(); const tSep = (performance.now() - t0) / KI;
    R.packed = { N, ms_per_iter_packed_1dl: +tPacked.toFixed(2), ms_per_iter_4dl: +tSep.toFixed(2), err: errs, ok: maxE <= 1e-3, downloads_packed: 1, downloads_separate: 4 };
    try {
    // 輸入也是打包的 view（與 nbody IR 相同）：x、y、z、ms 各是一個打包緩衝區 pkIn 的部分 0..3；輸出寫進 packed（部分 0..3）
    const pkIn = dev.allocPacked(N, 4);
    const inV = [0, 1, 2, 3].map((k) => dev.view(pkIn, k));
    dev.upload(inV[0], X); dev.upload(inV[1], Y); dev.upload(inV[2], Z); dev.upload(inV[3], MS);
    const viewBinds = { x: inV[0], y: inV[1], z: inV[2], ms: inV[3] };
    for (const n of names) dev.dispatch(kernels[n], viewBinds, views[outIdx[n]], scal, N);
    const allV = dev.download(packed);
    const errsV = {}; let maxV = 0;
    names.forEach((n, k) => { const part = allV.subarray(k * N, (k + 1) * N); errsV[n] = maxErr(part, ref[n]); maxV = Math.max(maxV, errsV[n]); });
    R.packedInputViews = { err: errsV, ok: maxV <= 1e-3 };
    } catch (e) { R.packedInputViewsError = String(e && e.stack || e); }
    // 負向：輸出 view 與輸入 x 同一張紋理要被拒絕
    const pk2 = dev.allocPacked(N, 2);
    const inV = dev.view(pk2, 0), outV = dev.view(pk2, 1);
    const bind2 = { x: inV, y: by, z: bz, ms: bm };
    let threw = false; try { dev.dispatch(kernels.accx, bind2, outV, scal, N); } catch (e) { threw = /feedback/.test(String(e)); }
    R.feedback_rejected = threw;
}
console.log('KIR_PACKED ' + JSON.stringify(R));
return R;
