// llc 的 GPU 加速計時（nbody3d、fluid3d）：三種後端每幀耗時（真 Electron，run_eval 的 job）。
//   cpu     ：gpgpu/nbody3d.ll、fluid3d.ll（原本的 CPU 版，wasm 內 O(N²)）
//   cl-js   ：gpgpu/*_cl.ll，但評測時把 EXT_color_buffer_float 藏起來 → KIR 執行失敗 → 每次派送退回 JS 墊片（clCompile）
//   cl-gl   ：gpgpu/*_cl.ll，WebGL2 浮點渲染（KIR→GLSL→紋理）；需要 FA_EVAL_GL=swiftshader 啟動（見 run_eval.js）
// 量法：斜率。nbody：LOOP＝frames，跑 30 與 150 幀，(150 幀的週期秒數−30 幀的)／120＝每幀毫秒；fluid：跑 20 與 120 幀的牆鐘時間差／100。
// 由 scripts/eval/llc_gpu_timing.build.js 產生（把 .ll 內嵌進來，不依賴 examples 是否已 embed）。
// 注意：SwiftShader 是軟體 GL，WebGL2 路徑的耗時是軟體光柵化的成本，不是真 GPU 的數字。
const SRC = __SRC__;
const fa = window.fa; const R = { gl: 'swiftshader (software GL)' };
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
const ex = (n) => SRC[n] || (typeof FA_PY_EXAMPLES !== 'undefined' ? FA_PY_EXAMPLES['llc/' + n] : undefined);

// 把 EXT_color_buffer_float 藏起來（只在評測裡）：KIR 的 supportsWebGL2 會回 false → 退回 JS 墊片
const hideFloatRender = (on) => {
    const P = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
    if (!P) return;
    if (on && !P.__origGetExt) { P.__origGetExt = P.getExtension; P.getExtension = function (n) { return n === 'EXT_color_buffer_float' ? null : P.__origGetExt.call(this, n); }; }
    if (!on && P.__origGetExt) { P.getExtension = P.__origGetExt; delete P.__origGetExt; }
};
const runJob = async (file, args, timeout_s) => {
    const t0 = Date.now();
    const r = await tool('job_run', { lang: 'llvm', code: ex(file), args, timeout_s });
    const out = String(r.output || '');
    return {
        ms: Date.now() - t0, exit: r.exit_code, out,
        secs: (out.match(/^\d+ ([0-9.]+)$/m) || [])[1] ? Number(out.match(/^\d+ ([0-9.]+)$/m)[1]) : null,
        gpu: (out.match(/GPU 派送 (\d+) 次/) || [])[1] ? Number(out.match(/GPU 派送 (\d+) 次/)[1]) : 0,
        fallback: (out.match(/KIR 執行失敗/g) || []).length,
    };
};
const variant = async (name, file, mode) => {
    hideFloatRender(mode === 'cl-js');
    try {
        if (name === 'nbody') {
            const a = await runJob(file, ['512', '30', '30'], 600), b = await runJob(file, ['512', '150', '150'], 600);
            return { ms_per_frame: (a.secs !== null && b.secs !== null) ? +((b.secs - a.secs) * 1000 / 120).toFixed(2) : null, exit: [a.exit, b.exit], gpu_dispatch: b.gpu, fallback_warnings: b.fallback, last: b.out.trim().slice(-160) };
        }
        const a = await runJob(file, ['20'], 600), b = await runJob(file, ['120'], 600);
        return { ms_per_frame: +((b.ms - a.ms) / 100).toFixed(2), exit: [a.exit, b.exit], gpu_dispatch: b.gpu, fallback_warnings: b.fallback, last: b.out.trim().slice(-160) };
    } finally { hideFloatRender(false); }
};
R.nbody = {}; R.fluid = {};
if (ex('gpgpu/nbody3d.ll') && ex('gpgpu/nbody3d_cl.ll')) {
    R.nbody.cpu = await variant('nbody', 'gpgpu/nbody3d.ll', 'cpu');
    R.nbody.cl_js = await variant('nbody', 'gpgpu/nbody3d_cl.ll', 'cl-js');
    R.nbody.cl_gl = await variant('nbody', 'gpgpu/nbody3d_cl.ll', 'cl-gl');
}
if (ex('gpgpu/fluid3d.ll') && ex('gpgpu/fluid3d_cl.ll')) {
    R.fluid.cpu = await variant('fluid', 'gpgpu/fluid3d.ll', 'cpu');
    R.fluid.cl_js = await variant('fluid', 'gpgpu/fluid3d_cl.ll', 'cl-js');
    R.fluid.cl_gl = await variant('fluid', 'gpgpu/fluid3d_cl.ll', 'cl-gl');
}
console.log('LLC_GPU_TIMING ' + JSON.stringify(R));
return R;
