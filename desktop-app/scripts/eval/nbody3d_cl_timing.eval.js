// nbody3d：CPU 版（gpgpu/nbody3d.ll）與 OpenCL 版（gpgpu/nbody3d_cl.ll）每幀耗時（真 Electron，job 跑完整個程式）。
// 前提：examples 已經 embed／build（FA_PY_EXAMPLES 裡要有 llc/gpgpu/nbody3d_cl.ll）。沒有的話會直接回報缺少。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/nbody3d_cl_timing.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=<空目錄>
// 程式的參數：lli nbody3d.ll [N] [LOOP] [frames]。LOOP＝frames，程式在每個週期結束時印 "N 秒數"（整個週期的牆鐘時間，含繪圖與 SDL_Delay）。
// 注意：軟體 GL（SwiftShader）下繪圖的耗時也算在內；要看純計算的差別，看 OpenCL 行的 "step" 時間（若有印）。
const fa = window.fa; const R = { sw: 'swiftshader' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
const ex = (n) => FA_PY_EXAMPLES['llc/' + n];
R.has_cpu = !!ex('gpgpu/nbody3d.ll'); R.has_cl = !!ex('gpgpu/nbody3d_cl.ll');
const runOne = async (file, args) => {
    const r = await tool('job_run', { lang: 'llvm', code: ex(file), args, timeout_s: 240 });
    const out = String(r.output || '');
    const m = out.match(/^(\d+) ([0-9.]+)$/m);
    return { exit: r.exit_code, secs: m ? Number(m[2]) : null, bodies: m ? Number(m[1]) : null, backend: (out.match(/\[OpenCL 後端[^\]]*\]/) || [null])[0], tail: out.trim().slice(-200) };
};
if (R.has_cpu && R.has_cl) {
    // 斜率法：每個版本跑 30 幀與 150 幀（LOOP＝frames，各一個週期），(第二次−第一次)／120＝每幀耗時；啟動與第一次建立 OpenCL 的成本抵銷。
    const N = 512;
    for (const [label, file] of [['cpu', 'gpgpu/nbody3d.ll'], ['cl', 'gpgpu/nbody3d_cl.ll']]) {
        const a = await runOne(file, [String(N), '30', '30']);
        const b = await runOne(file, [String(N), '150', '150']);
        R[label] = {
            cycle_secs_30: a.secs, cycle_secs_150: b.secs,
            ms_per_frame_slope: (a.secs !== null && b.secs !== null) ? +((b.secs - a.secs) * 1000 / 120).toFixed(2) : null,
            exit_150: b.exit, backend_150: b.backend, tail_150: b.tail,
        };
    }
}
console.log('NBODY_CL_TIMING ' + JSON.stringify(R));
return R;
