// llvm_host 的打包路徑 + 真的 FaKirWebGL2 裝置（不是假裝置）：opencl_vecadd.ll 的輸出改成兩部分打包緩衝區的第 1 部分（view），讀回 view。
// 檢查：輸出正確；派送 1 次；打包 1 次；view 1 次；上傳 3 次（兩個輸入加打包的 root）；讀回 1 次（view）。
// 由 scripts/eval/llvm_packed_device.build.js 產生（內嵌 KIR 模組、新版 llvm_host.js、vecadd 的 IR）。
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
    const st = { alloc: 0, allocPacked: 0, view: 0, upload: 0, download: 0, dispatch: 0 };
    const kirDev = {
        alloc: (N, e) => { st.alloc++; return dev.alloc(N, e); },
        allocPacked: (Np, parts) => { st.allocPacked++; return dev.allocPacked(Np, parts); },
        view: (p, k) => { st.view++; return dev.view(p, k); },
        upload: (b, a) => { st.upload++; return dev.upload(b, a); },
        download: (b) => { st.download++; return dev.download(b); },
        dispatch: (k, binds, out, scal, N) => { st.dispatch++; return dev.dispatch(k, binds, out, scal, N); },
        free: (b) => dev.free(b),
    };
    const warns = [];
    const host = H.create({
        gui: async () => null, fs: { read: () => null, write: () => {}, exists: () => false, remove: () => {} },
        warn: (t) => warns.push(String(t)),
        kirTranslate: (src) => { const r = FR.parseKernels(src); if (!r.ok) return null; const m = {}; for (const k of r.kernels) { if (K.validate(k).ok && window.FaKirGen.toGlsl(k).ok) m[k.name] = k; } return m; },
        kirRun: () => { throw new Error('本檢查不走 kirRun'); },
        kirDev,
    });
    const rep = (t, a, b) => { if (t.split(a).length !== 2) throw new Error('替換失敗：' + a); return t.replace(a, b); };
    let ir = rep(SRC.vecadd, 'declare ptr @malloc(i32)', 'declare ptr @malloc(i32)\ndeclare i32 @fa_cl_pack(ptr, i32)\ndeclare ptr @fa_cl_view(ptr, i32)');
    ir = rep(ir, '  %bc = call ptr @clCreateBuffer(ptr %c, i64 2, i64 %bytes, ptr null, ptr %rc)    ; WRITE_ONLY',
        '  %bytes2 = mul i64 %bytes, 2\n  %bc = call ptr @clCreateBuffer(ptr %c, i64 2, i64 %bytes2, ptr null, ptr %rc)\n  %pk = call i32 @fa_cl_pack(ptr %bc, i32 2)\n  %vc = call ptr @fa_cl_view(ptr %bc, i32 1)');
    ir = rep(ir, '  store ptr %bc, ptr %dc', '  store ptr %vc, ptr %dc');
    ir = rep(ir, 'call i32 @clEnqueueReadBuffer(ptr %q, ptr %bc,', 'call i32 @clEnqueueReadBuffer(ptr %q, ptr %vc,');
    host.install(FaLlvm);
    const c = FaLlvm.compileIr(ir, {});
    if (c.wasm) {
        const dec = {}; for (const d of FaLlvm.parse(ir).mod.declares) dec[d.name] = d;
        const o = await FaLlvm.runHost(c.wasm, { args: ['prog', '1000'] }, host.impls, undefined, dec);
        R.run = { exit: o.exitCode, stdout: o.stdout.trim() };
    } else R.compile_errors = c.errors;
    host.uninstall(FaLlvm);
    R.stats = st; R.warns = warns;
}
console.log('LLVM_PACKED_DEVICE ' + JSON.stringify(R));
return R;
