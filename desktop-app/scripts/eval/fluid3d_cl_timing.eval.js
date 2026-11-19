// fluid3d：CPU 版（gpgpu/fluid3d.ll）與 OpenCL 版（gpgpu/fluid3d_cl.ll）每幀耗時（真 Electron，job 跑完整個程式）。
// 前提：examples 已經 embed／build（FA_PY_EXAMPLES 裡要有 llc/gpgpu/fluid3d_cl.ll）。
// 量法：程式的參數 [frames]＝跑幾幀後離開。量 frames=20 與 frames=120 的牆鐘時間，斜率＝每幀耗時（啟動、建立視窗的成本抵銷）。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/fluid3d_cl_timing.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=<空目錄>
// 注意：SwiftShader 是軟體 GL，繪圖（點精靈）的耗時也在裡面；看「計算」的差別要比較同一環境下兩個版本的斜率。
const fa = window.fa; const R = {};
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
const ex = (n) => FA_PY_EXAMPLES['llc/' + n];
R.has_cpu = !!ex('gpgpu/fluid3d.ll'); R.has_cl = !!ex('gpgpu/fluid3d_cl.ll');
const timeRun = async (file, frames) => {
    const t0 = Date.now();
    const r = await tool('job_run', { lang: 'llvm', code: ex(file), args: [String(frames)], timeout_s: 600 });
    return { ms: Date.now() - t0, exit: r.exit_code, tail: String(r.output || '').trim().slice(-120) };
};
if (R.has_cpu && R.has_cl) {
    for (const [label, file] of [['cpu', 'gpgpu/fluid3d.ll'], ['cl', 'gpgpu/fluid3d_cl.ll']]) {
        const a = await timeRun(file, 20), b = await timeRun(file, 120);
        R[label] = { ms_20: a.ms, ms_120: b.ms, ms_per_frame: +((b.ms - a.ms) / 100).toFixed(2), exit_120: b.exit, tail_120: b.tail };
    }
}
console.log('FLUID_CL_TIMING ' + JSON.stringify(R));
return R;
