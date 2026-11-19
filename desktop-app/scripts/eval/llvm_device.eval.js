// 步驟 1b 的真 Electron 檢查：llvm_host 的常駐裝置路徑（kirDev）跑 opencl_vecadd.ll。
// 用的是內嵌的 llvm_host.js（新版，含 kirDev）與 KIR 模組，跑在 app 既有的 FaLlvm 編譯器上。
// 檢查：輸出正確；派送次數（核心在 WebGL2 裝置上跑）；上傳次數（只有輸入 a、b）；讀回次數（只有 c，於 clEnqueueReadBuffer 時）。
// 由 scripts/eval/llvm_device.build.js 產生。
const SRC = __SRC__;
const load = (src) => new Function('module', 'require', 'self', src)(undefined, undefined, window);
load(SRC.kir); load(SRC.gen); load(SRC.webgl); load(SRC.front); load(SRC.host);
const K = window.FaKir, W = window.FaKirWebGL2, FR = window.FaClFront, H = window.FaLlvmHost;
const R = {};
const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
const gl = cv.getContext('webgl2');
R.supports = !!gl && W.supportsWebGL2(gl);
if (R.supports) {
    const dev = W.createDevice(gl);
    const st = { alloc: 0, upload: 0, download: 0, dispatch: 0 };
    const kirDev = {
        alloc: (N, e) => { st.alloc++; return dev.alloc(N, e); },
        upload: (b, a) => { st.upload++; return dev.upload(b, a); },
        download: (b) => { st.download++; return dev.download(b); },
        dispatch: (k, binds, out, scal, N) => { st.dispatch++; return dev.dispatch(k, binds, out, scal, N); },
        free: (b) => dev.free(b),
    };
    const warns = [];
    const host = H.create({
        gui: async () => null, fs: { read: () => null, write: () => {}, exists: () => false, remove: () => {} },
        warn: (t) => warns.push(String(t)),
        kirTranslate: (src) => { const r = FR.parseKernels(src); if (!r.ok) return null; const m = {}; for (const k of r.kernels) { if (K.validate(k).ok && GENok(k)) m[k.name] = k; } return m; },
        kirRun: () => { throw new Error('本檢查不走 kirRun'); },
        kirDev,
    });
    function GENok(k) { return window.FaKirGen.toGlsl(k).ok; }
    host.install(FaLlvm);
    const ir = SRC.vecadd;
    const c = FaLlvm.compileIr(ir, {});
    if (c.wasm) {
        const dec = {}; for (const d of FaLlvm.parse(ir).mod.declares) dec[d.name] = d;
        const o = await FaLlvm.runHost(c.wasm, { args: ['prog', '1000'] }, host.impls, undefined, dec);
        R.run = { exit: o.exitCode, stdout: o.stdout.trim() };
    } else R.compile_errors = c.errors;
    host.uninstall(FaLlvm);
    R.stats = st; R.warns = warns;
}
console.log('LLVM_DEVICE ' + JSON.stringify(R));
return R;
