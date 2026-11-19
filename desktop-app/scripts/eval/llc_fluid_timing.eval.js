// fluid3d 讀回路徑的耗時（真 GPU，app 的 lli job）。三種：
//   cpu            ：CPU 版（gpgpu/fluid3d.ll，wasm）
//   cl_webgpu      ：OpenCL 版，WebGPU 後端（目前的 sph_gpu 路徑：每步上傳位置與速度、讀回密度與加速度）
//   cl_webgl2      ：OpenCL 版，WebGL2 後端（window.FA_KIR_FORCE_BACKEND＝'webgl2'）
// 量法：跑 frames=20 與 frames=120 的牆鐘時間，斜率＝每幀耗時（抵銷啟動與建窗）。
// 另外計 WebGPU 的 mapAsync（讀回）、writeBuffer（上傳）、beginRenderPass（繪圖）次數，取 (120 幀−20 幀)／100 得每幀次數。
// 由 scripts/eval/llc_fluid_timing.build.js 產生。結果：LLC_FLUID {…}。
const SRC = __SRC__;
const fa = window.fa; const R = { errors: [] };
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
const counters = { map: 0, rp: 0, write: 0, submit: 0 };
const installCounters = () => {
    if (window.__ctrInstalled) return;
    window.__ctrInstalled = true;
    const P = (C, name, key) => { if (!C || !C.prototype || !C.prototype[name]) return; const o = C.prototype[name]; C.prototype[name] = function (...a) { counters[key]++; return o.apply(this, a); }; };
    P(typeof GPUBuffer !== 'undefined' ? GPUBuffer : null, 'mapAsync', 'map');
    P(typeof GPUCommandEncoder !== 'undefined' ? GPUCommandEncoder : null, 'beginRenderPass', 'rp');
    P(typeof GPUQueue !== 'undefined' ? GPUQueue : null, 'writeBuffer', 'write');
    P(typeof GPUQueue !== 'undefined' ? GPUQueue : null, 'submit', 'submit');
};
const resetCounters = () => { for (const k of Object.keys(counters)) counters[k] = 0; };
const runFrames = async (file, frames) => {
    resetCounters();
    const t0 = performance.now();
    const r = await tool('job_run', { lang: 'llvm', code: SRC.LL[file], args: [String(frames)], timeout_s: 900 });
    const ms = performance.now() - t0;
    return { ms: +ms.toFixed(1), exit: r.exit_code, out: String(r.output || '').trim().slice(-160), counters: Object.assign({}, counters) };
};
const MODES = [
    { name: 'cpu', file: 'fluid3d', force: '' },
    { name: 'cl_webgpu', file: 'fluid3d_cl', force: '' },
    { name: 'cl_webgl2', file: 'fluid3d_cl', force: 'webgl2' }
];
try {
    R.webgpu = !!navigator.gpu;
    installCounters();
    R.by = {};
    for (const m of MODES) {
        window.FA_KIR_FORCE_BACKEND = m.force;
        const a = await runFrames(m.file, 20);
        const b = await runFrames(m.file, 120);
        const perFrame = {};
        for (const k of Object.keys(counters)) perFrame[k] = +((b.counters[k] - a.counters[k]) / 100).toFixed(2);
        R.by[m.name] = {
            exit: [a.exit, b.exit],
            ms_20: a.ms, ms_120: b.ms,
            ms_per_frame: +((b.ms - a.ms) / 100).toFixed(3),
            per_frame_counters: perFrame,
            tail_120: b.out
        };
    }
    window.FA_KIR_FORCE_BACKEND = '';
} catch (e) { R.errors.push(String((e && e.stack) || e).slice(0, 400)); }
console.log('LLC_FLUID ' + JSON.stringify(R));
return R;
