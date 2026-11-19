// GPGPU 基準（真 GPU 機器用）：印出 WebGL2 的 renderer／vendor、EXT_color_buffer_float，並量 nbody3d（N＝512／1024／3072）與 fluid3d
// 的每幀耗時：CPU 版（wasm）、OpenCL 版（實際用的後端：WebGL2 的 KIR 路徑；若沒有就是 JS 墊片）。
// 不要加 swiftshader 旗標（那是軟體 GL）：用 scripts/eval/run_eval.js 的 FA_EVAL_GL=gpu（不加任何 GL 旗標）。
// 量法：斜率。nbody：LOOP＝frames，跑 10 與 40 幀，(40 幀的週期秒數−10 幀的)／30＝每幀毫秒。fluid：跑 10 與 40 幀，牆鐘時間差／30。
// fluid3d 的粒子數寫死在產生器裡（1000），所以 fluid 只有一個 N。
// 由 scripts/eval/gpgpu_bench.build.js 產生（把 .ll 內嵌進來）。結果是一行 JSON，見 DESIGN.run-terminal.md §21。
const SRC = __SRC__;
const fa = window.fa; const R = { env: {}, nbody: {}, fluid: {} };
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
const ex = (n) => SRC[n];

// 環境
{
    const c = document.createElement('canvas'); const gl = c.getContext('webgl2');
    R.env.webgl2 = !!gl;
    if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        R.env.renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
        R.env.vendor = String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
        R.env.version = String(gl.getParameter(gl.VERSION));
        R.env.ext_color_buffer_float = !!gl.getExtension('EXT_color_buffer_float');
        R.env.max_texture_size = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    }
    try { R.env.webgpu = navigator.gpu ? ((await navigator.gpu.requestAdapter()) ? 'adapter' : 'no adapter') : 'no navigator.gpu'; } catch (e) { R.env.webgpu = 'error: ' + e; }
    R.env.user_agent_gpu = navigator.userAgent.match(/Electron\/[\d.]+/) ? 'electron' : 'other';
}

// 隱藏 EXT_color_buffer_float → KIR 退回 JS 墊片（只在評測裡）
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
    const sm = out.match(/^\d+ ([0-9.]+)$/m);
    const gpu = (out.match(/GPU 派送 (\d+) 次/) || [])[1];
    return { ms: Date.now() - t0, exit: r.exit_code, secs: sm ? Number(sm[1]) : null, gpu: gpu ? Number(gpu) : 0, fallback: (out.match(/KIR 執行失敗/g) || []).length, out };
};
// 一個變體的斜率：short、long 兩個長度；nbody 用週期秒數，fluid 用牆鐘時間
const slope = async (kind, file, lo, hi, nbodyN) => {
    const args = (f) => kind === 'nbody' ? [String(nbodyN), String(f), String(f)] : [String(f)];
    const a = await runJob(file, args(lo), 900), b = await runJob(file, args(hi), 900);
    let ms = null;
    if (kind === 'nbody' && a.secs !== null && b.secs !== null) ms = (b.secs - a.secs) * 1000 / (hi - lo);
    if (kind === 'fluid') ms = (b.ms - a.ms) / (hi - lo);
    const backend = b.gpu > 0 ? 'webgl2' : (b.fallback > 0 ? 'js-shim' : 'none');
    return { ms_per_frame: ms === null ? null : +ms.toFixed(2), backend, gpu_dispatch: b.gpu, fallback: b.fallback, exit: [a.exit, b.exit] };
};
const LO = 10, HI = 40;
for (const N of [512, 1024, 3072]) {
    R.nbody[N] = {
        cpu: await slope('nbody', 'gpgpu/nbody3d.ll', LO, HI, N),
        opencl: await slope('nbody', 'gpgpu/nbody3d_cl.ll', LO, HI, N),
    };
}
R.fluid[1000] = { cpu: await slope('fluid', 'gpgpu/fluid3d.ll', 10, 40), opencl: await slope('fluid', 'gpgpu/fluid3d_cl.ll', 10, 40) };
// 對照：同一環境強制 OpenCL 走 JS 墊片（N=512 nbody），看 WebGL2 路徑相對墊片的差
hideFloatRender(true);
try { R.nbody_512_opencl_forced_js = await slope('nbody', 'gpgpu/nbody3d_cl.ll', LO, HI, 512); } finally { hideFloatRender(false); }
console.log('GPGPU_BENCH ' + JSON.stringify(R));
return R;
