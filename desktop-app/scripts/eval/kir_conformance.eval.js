// KIR／OpenCL 一致性套件（真 Electron）：同一組案例（renderer/src/gpu/kir_conformance_cases.js）在四個後端上跑，與 double 參考解比對：
//   js       ：KIR 的 JS 參考後端（kir.runJs，每個 f32 運算包 Math.fround）
//   webgpu-t ：WebGPU 裝置，分塊（tile）開啟
//   webgpu-u ：WebGPU 裝置，分塊關閉（未分塊）
//   webgl2   ：WebGL2 裝置（kir_webgl2）
// 判定：每個輸出元素的 誤差／量級 ≤ 容差（exact 案例要求 0；其餘為 8·√k·EPS32，EPS32＝2^-23；與 gpu_core.tolerance 同形式）。
// 由 scripts/eval/kir_conformance.build.js 產生（內嵌 KIR 模組與案例）。結果：KCONF {…}。
// 時間上限：整個頁面目標 < 60 秒（R.ms 記錄）。
const SRC = __SRC__;
const load = (src) => new Function('module', 'require', 'self', src)(undefined, undefined, window);
load(SRC.kir); load(SRC.gen); load(SRC.webgl); load(SRC.webgpu); load(SRC.front); load(SRC.cases);
const K = window.FaKir, FR = window.FaClFront, WGD = window.FaKirWebGPU, GLD = window.FaKirWebGL2, C = window.KIR_CONFORMANCE;
const R = { errors: [], backends: {} };
const T0 = performance.now();

const parsed = FR.parseKernels(C.SRC);
if (!parsed.ok) { R.errors.push('cl_front：' + parsed.error); }
const kmap = {}; if (parsed.ok) for (const k of parsed.kernels) kmap[k.name] = k;
R.kernels = Object.keys(kmap);

// ---- 後端
const jsBackend = {
    alloc: (elem, n) => ({ elem, n, arr: new Float32Array(n * (elem === 'f32x4' ? 4 : 1)) }),
    upload: (h, data) => { h.arr.set(data); },
    download: (h) => Promise.resolve(h.arr.slice()),
    dispatch: (kernel, binds, out, scalars, N) => {
        if (!(N >= 1)) return;
        const B = {}, sc = {};
        for (const p of kernel.params) { if (p.kind === 'buf') B[p.name] = binds[p.name].arr; else sc[p.name] = scalars[p.name]; }
        K.runJs(kernel, B, sc, N);
    }
};
// WebGPU／WebGL2 裝置的 API 與 JS 後端相同（alloc／upload／download／dispatch）；download 可能是 Promise 或同步值，統一 await
const deviceBackend = (dev, syncFn) => ({
    alloc: (elem, n) => dev.alloc(n, elem),
    upload: (h, data) => dev.upload(h, data),
    download: async (h) => dev.download(h),
    dispatch: (kernel, binds, out, scalars, N) => dev.dispatch(kernel, binds, out, scalars, N),
    sync: syncFn
});

async function runOne(inst, be) {
    const H = {};
    for (const [name, s] of Object.entries(inst.buffers)) {
        if (s.n === 0) { H[name] = null; continue; }
        H[name] = be.alloc(s.elem, s.n);
        if (s.data) be.upload(H[name], s.data);
    }
    for (const st of inst.stages) {
        const k = kmap[st.k], binds = {};
        for (const p of k.params) if (p.kind === 'buf') binds[p.name] = H[st.bind[p.name]];
        const outP = k.params.find((p) => p.kind === 'buf' && p.access === 'out');
        await be.dispatch(k, binds, outP ? binds[outP.name] : undefined, st.scalars, st.N);
    }
    if (be.sync) await be.sync();
    const got = {};
    for (const name of inst.outs) got[name] = inst.buffers[name].n ? await be.download(H[name]) : new Float32Array(0);
    return got;
}

// ---- 建立 GPU 裝置（失敗就記錄原因，不中斷）
const gpuBackends = {};
try {
    if (!navigator.gpu) throw new Error('navigator.gpu 不存在');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('requestAdapter 回傳 null');
    R.adapter = { vendor: adapter.info && adapter.info.vendor, arch: adapter.info && adapter.info.architecture, fallback: !!adapter.isFallbackAdapter };
    const gdev = await adapter.requestDevice();
    R.lost = null; gdev.lost.then((i) => { R.lost = (i.reason || '') + ':' + (i.message || ''); });
    const dt = WGD.createDevice(gdev, { tile: true, wg: 64 }), du = WGD.createDevice(gdev, { tile: false, wg: 64 });
    gpuBackends['webgpu-t'] = deviceBackend(dt, () => gdev.queue.onSubmittedWorkDone());
    gpuBackends['webgpu-u'] = deviceBackend(du, () => gdev.queue.onSubmittedWorkDone());
} catch (e) { R.errors.push('WebGPU：' + (e && e.message || e)); }
try {
    const cv = document.createElement('canvas'); const gl = cv.getContext('webgl2');
    if (!gl) throw new Error('getContext(webgl2) 失敗');
    const gdev = GLD.createDevice(gl);
    gpuBackends['webgl2'] = deviceBackend(gdev, null);
} catch (e) { R.errors.push('WebGL2：' + (e && e.message || e)); }
const BACKENDS = Object.assign({ js: jsBackend }, gpuBackends);
for (const name of Object.keys(BACKENDS)) R.backends[name] = { pass: 0, total: 0, fails: [], ms: 0 };

// ---- 逐案例逐後端判定
R.perCase = {};
for (const c of C.CASES) {
    for (const N of c.sizes) {
        const key = c.id + ' N=' + N;
        R.perCase[key] = {};
        for (const [name, be] of Object.entries(BACKENDS)) {
            const tb = performance.now();
            let res;
            try {
                const inst = c.make(N);
                const got = await runOne(inst, be);
                res = C.judge(c, got, inst.ref(), inst.scale());
                if (inst.analytic) res.analytic = inst.analytic(got);
            } catch (e) {
                res = { pass: false, error: String((e && e.message) || e).slice(0, 200) };
            }
            R.backends[name].ms += performance.now() - tb;
            R.backends[name].total++;
            if (res.pass) R.backends[name].pass++;
            else R.backends[name].fails.push(key + (res.error ? ' ' + res.error : ' ' + JSON.stringify(res.detail).slice(0, 240)));
            const worstAbs = res.detail ? Math.max(0, ...Object.values(res.detail).map((d) => (d.maxAbs === undefined ? 0 : d.maxAbs))) : null;
            R.perCase[key][name] = { pass: res.pass, worst: res.worst === undefined ? null : Number(res.worst.toExponential(3)), maxAbs: worstAbs === null ? null : Number(worstAbs.toExponential(3)), error: res.error || undefined, analytic: res.analytic };
        }
    }
}
for (const name of Object.keys(R.backends)) R.backends[name].ms = Math.round(R.backends[name].ms);
R.ms = Math.round(performance.now() - T0);
R.allPass = Object.values(R.backends).every((b) => b.pass === b.total) && R.errors.length === 0;
console.log('KCONF ' + JSON.stringify(R));
return R;
