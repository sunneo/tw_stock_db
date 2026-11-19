// nbody 的 IR 直接在真 Electron 裡跑（新版 llvm_host＋KIR 裝置掛鉤＋GUI 的假實作），不經過 job 與線上版的 host。
// 用來逐幀除錯：印出 CPU 版與 OpenCL 版的最終輸出行（與逐幀的 printf）。
// 由 scripts/eval/nbody_inline.build.js 產生。
const SRC = __SRC__;
const load = (src) => new Function('module', 'require', 'self', src)(undefined, undefined, window);
load(SRC.kir); load(SRC.gen); load(SRC.webgl); load(SRC.front); load(SRC.host);
const K = window.FaKir, W = window.FaKirWebGL2, FR = window.FaClFront, H = window.FaLlvmHost;
const R = {};
const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
const gl = cv.getContext('webgl2');
R.supports = !!gl && W.supportsWebGL2(gl);
const runIR = async (ir, args, useDevice) => {
    const dev = useDevice && R.supports ? W.createDevice(gl) : null;
    const kirDev = dev ? { alloc: (N, e) => dev.alloc(N, e), allocPacked: (a, b) => dev.allocPacked(a, b), view: (p, k) => dev.view(p, k), upload: (b, a) => dev.upload(b, a), download: (b) => dev.download(b), dispatch: (k, bi, o, s, N) => dev.dispatch(k, bi, o, s, N), free: (b) => dev.free(b) } : null;
    const warns = [];
    const host = H.create({
        gui: async () => null, fs: { read: () => null, write: () => {}, exists: () => false, remove: () => {} },
        sleep: async () => {}, warn: (t) => warns.push(String(t)),
        kirTranslate: dev ? (src) => { const r = FR.parseKernels(src); if (!r.ok) return null; const m = {}; for (const k of r.kernels) { if (K.validate(k).ok && window.FaKirGen.toGlsl(k).ok) m[k.name] = k; } return m; } : undefined,
        kirRun: dev ? () => { throw new Error('no kirRun'); } : undefined,
        kirDev: kirDev || undefined,
    });
    host.install(FaLlvm);
    const c = FaLlvm.compileIr(ir, {});
    let out = null;
    if (c.wasm) {
        const dec = {}; for (const d of FaLlvm.parse(ir).mod.declares) dec[d.name] = d;
        try { out = await FaLlvm.runHost(c.wasm, { args }, host.impls, undefined, dec); } catch (e) { out = { error: String(e && e.stack || e).slice(0, 400) }; }
    } else out = { compile_errors: c.errors };
    host.uninstall(FaLlvm);
    return { out: out && out.stdout !== undefined ? String(out.stdout).slice(-600) : out, exit: out && out.exitCode, warns: warns.slice(0, 3) };
};
R.cpu = await runIR(SRC.cpu, ['512', '3', '3'], false);
R.cl = await runIR(SRC.cl, ['512', '3', '3'], true);
R.cl_cpu = await runIR(SRC.cl, ['512', '3', '3'], false);
console.log('NBODY_INLINE ' + JSON.stringify(R));
return R;
