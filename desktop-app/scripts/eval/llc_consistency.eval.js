// 逐步一致性檢查（真 Electron，app 的 lli job）：範例維持標準寫法（不改範例），框架在每幀交換前把 GL 批次交給 FA_FRAME_HOOK。
// CPU 版與 GPU 版從同一個初始狀態往前走；在第 1、2、5、10、30、100 幀取繪製的位置（nbody：所有天體；fluid：所有粒子），
// 算最大相對誤差：max|CPU−GPU| ÷ max|CPU|。fluid 另外用繪製的顏色（由速度大小決定）還原每顆粒子的速度大小 |v|，算同樣的相對誤差。
// 容差 TOL 在看到結果之前就定好（1e-5），不因結果放寬。
// nbody 的結尾印出的那一行（frames=… cx=… cy=… cz=…）也必須與 CPU 版逐字相同。
//   nbody：CPU（nbody3d）對 OpenCL 版：WebGPU（預設）、WebGL2（FA_KIR_FORCE_BACKEND＝'webgl2'）
//   fluid：CPU（fluid3d）對 OpenCL 版：WebGPU、WebGL2、JS 墊片（FA_KIR_FORCE_BACKEND＝'js'）
// 由 scripts/eval/llc_consistency.build.js 產生。結果：LLC_CONSIST {…}。
const SRC = __SRC__;
const TOL = 1e-5;
const CHECK = [1, 2, 5, 10, 30, 100];
const NB_N = 3072, FL_N = 1000;
const fa = window.fa; const R = { errors: [], TOL, CHECK };
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));

// 每幀收集：只留檢查點那幾幀；找本幀最大的 GL_POINTS（mode 0）批次，那就是天體／粒子（文字是小批次）
let frameNo = 0, collect = null;
globalThis.FA_FRAME_HOOK = (batches) => {
    frameNo++;
    if (!collect || !CHECK.includes(frameNo)) return;
    let best = null;
    for (const b of batches) if (b.mode === 0 && b.verts && (!best || b.verts.length > best.verts.length)) best = b;
    if (!best) return;
    const n = best.verts.length / 6;
    const pos = new Float64Array(n * 3), spd = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        pos[i * 3] = best.verts[i * 6]; pos[i * 3 + 1] = best.verts[i * 6 + 1]; pos[i * 3 + 2] = best.verts[i * 6 + 2];
        const r = best.verts[i * 6 + 3];   // 顏色的 r＝0.1+0.8t，t＝|v|/3（上限 1）
        spd[i] = Math.max(0, (r - 0.1) / 0.8) * 3;
    }
    collect.set(frameNo, { pos, spd, n });
};

const runJob = async (file, args, force) => {
    window.FA_KIR_FORCE_BACKEND = force || '';
    frameNo = 0; collect = new Map();
    const r = await tool('job_run', { lang: 'llvm', code: SRC.LL[file], args, timeout_s: 1500 });
    window.FA_KIR_FORCE_BACKEND = '';
    const out = String(r.output || '');
    const fin = /frames=\d+ bodies=\d+ cx=[-\d.]+ cy=[-\d.]+ cz=[-\d.]+|frames=\d+ n=\d+ y_mean=[-\d.]+/.exec(out);
    return { exit: r.exit_code, frames: frameNo, data: collect, final: fin ? fin[0] : null, tail: out.slice(-200) };
};
// 比較：key＝檢查點幀數；kind＝'pos'（取 pos）或 'spd'（取速度大小）
const compareKind = (ref, test, kind) => {
    const res = {};
    for (const k of CHECK) {
        const a = ref.data.get(k), b = test.data.get(k);
        if (!a || !b || a.n !== b.n) { res[k] = { worst: null, pass: false, note: 'missing' }; continue; }
        const A = kind === 'pos' ? a.pos : a.spd, B = kind === 'pos' ? b.pos : b.spd;
        let maxd = 0, maxa = 0;
        for (let i = 0; i < A.length; i++) { const d = Math.abs(A[i] - B[i]); if (d > maxd || Number.isNaN(d)) maxd = Number.isNaN(d) ? Infinity : d; const v = Math.abs(A[i]); if (v > maxa) maxa = v; }
        const rel = maxa > 0 ? maxd / maxa : maxd;
        res[k] = { worst: Number(rel.toExponential(3)), pass: rel <= TOL };
    }
    res.allPass = CHECK.every((k) => res[k].pass);
    return res;
};
try {
    R.webgpu = !!navigator.gpu;
    // nbody：標準範例，參數 [N, LOOP, frames]
    const NB = ['3072', '1000000', '100'];
    const nbCpu = await runJob('nbody3d', NB);
    const nbWg = await runJob('nbody3d_cl', NB);
    const nbGl = await runJob('nbody3d_cl', NB, 'webgl2');
    R.nbody = {
        exit: [nbCpu.exit, nbWg.exit, nbGl.exit], frames: [nbCpu.frames, nbWg.frames, nbGl.frames],
        final: { cpu: nbCpu.final, webgpu: nbWg.final, webgl2: nbGl.final },
        finalSame: { webgpu: nbCpu.final !== null && nbCpu.final === nbWg.final, webgl2: nbCpu.final !== null && nbCpu.final === nbGl.final },
        pos_webgpu: compareKind(nbCpu, nbWg, 'pos'), pos_webgl2: compareKind(nbCpu, nbGl, 'pos')
    };
    if (!nbCpu.final) R.nbody.cpu_tail = nbCpu.tail;
    // fluid：標準範例，參數 [frames]
    const FL = ['100'];
    const flCpu = await runJob('fluid3d', FL);
    const flWg = await runJob('fluid3d_cl', FL);
    const flGl = await runJob('fluid3d_cl', FL, 'webgl2');
    const flJs = await runJob('fluid3d_cl', FL, 'js');
    R.fluid = {
        exit: [flCpu.exit, flWg.exit, flGl.exit, flJs.exit], frames: [flCpu.frames, flWg.frames, flGl.frames, flJs.frames],
        pos_webgpu: compareKind(flCpu, flWg, 'pos'), pos_webgl2: compareKind(flCpu, flGl, 'pos'), pos_js: compareKind(flCpu, flJs, 'pos'),
        spd_webgpu: compareKind(flCpu, flWg, 'spd'), spd_webgl2: compareKind(flCpu, flGl, 'spd'), spd_js: compareKind(flCpu, flJs, 'spd')
    };
    R.allPass = R.nbody.pos_webgpu.allPass && R.nbody.pos_webgl2.allPass && R.nbody.finalSame.webgpu && R.nbody.finalSame.webgl2
        && R.fluid.pos_webgpu.allPass && R.fluid.pos_webgl2.allPass && R.fluid.pos_js.allPass
        && R.fluid.spd_webgpu.allPass && R.fluid.spd_webgl2.allPass && R.fluid.spd_js.allPass;
} catch (e) { R.errors.push(String((e && e.stack) || e).slice(0, 400)); }
globalThis.FA_FRAME_HOOK = null;
console.log('LLC_CONSIST ' + JSON.stringify(R));
return R;
