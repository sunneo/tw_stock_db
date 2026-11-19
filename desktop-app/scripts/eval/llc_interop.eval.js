// nbody3d_cl 的 interop 真機量測（DESIGN.webgpu-cuda.md §13 階段 9，步驟 5）：走 app 的 lli job（同 llc_kir_e2e.eval.js）。
// 三種模式：
//   points_webgpu   ：WebGPU 裝置，點精靈（fa_cl_points）；位置留在 GPU，每 30 幀讀回統計量
//   readback_webgpu ：同一顆 WebGPU 裝置，但每幀讀回位置再 glVertex（window.FA_KIR_NO_POINTS＝true；讀回對照組）
//   webgl2_readback ：WebGL2 後端（window.FA_KIR_FORCE_BACKEND＝'webgl2'），每幀讀回再 glVertex
//   cpu_wasm        ：CPU 版（nbody3d，不走 OpenCL）
// 量的東西：每步毫秒（每 10 步的週期時間÷10，含繪圖，穩態取第 2 個以後的週期中位數）；同一幀（第 3 幀）的畫布像素（三種路徑互相比對）；
// 頁面計數器：GPUBuffer.mapAsync（＝讀回）、GPUCommandEncoder.beginRenderPass（＝點精靈繪圖）、GPUQueue.writeBuffer（＝上傳）、GPUQueue.submit。
// 由 scripts/eval/llc_interop.build.js 產生。結果：LLC_INTEROP {…}。
const SRC = __SRC__;
const fa = window.fa; const R = { errors: [] };
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const startJob = async (file, args) => (await tool('job_run', { lang: 'llvm', code: SRC.LL[file], args, detach: true, timeout_s: 900 })).job_id;
const stopJob = async (id) => { try { await tool('job_stop', { job_id: id }); } catch (_) { /* 已結束 */ } };
const jobOutput = async (id) => { const g = await tool('job_gui', { job_id: id, action: 'snapshot' }); return String(g.output || ''); };
const waitExit = async (id, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const j = (await tool('job_list', {})).jobs.find((q) => q.job_id === id); if (!j || !j.running) return true; await wait(500); } return false; };
const runJob = async (file, args, maxMs) => {
    const id = await startJob(file, args);
    const ok = await waitExit(id, maxMs);
    const out = await jobOutput(id);
    if (!ok) await stopJob(id);
    return { ok, out };
};
const parseNbody = (out) => {
    const m = /frames=(\d+) bodies=(\d+) cx=([-\d.]+) cy=([-\d.]+) cz=([-\d.]+)/.exec(out);
    const cyc = [...out.matchAll(/^(\d+) ([\d.]+)$/gm)].map((x) => +x[2]);
    return m ? { frames: +m[1], bodies: +m[2], cen: [+m[3], +m[4], +m[5]], cycles_s: cyc } : { raw: out.slice(-300) };
};
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const findCanvas = (w, h) => [...document.querySelectorAll('canvas')].find((c) => c.width === w && c.height === h && c.getContext('webgl2'));

// 頁面計數器（只數這個頁面；量測前後各讀一次）
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

// 同一幀的畫布像素：GUI 每畫完一幀就呼叫 FA_GUI_AFTER_GLFRAME；第 CAP_SEQ 幀時讀下來
const CAP_SEQ = 3, W = 800, H = 560;
window.__capDone = false; window.__cap = null;
window.FA_GUI_AFTER_GLFRAME = (winId, nodeId, seq) => {
    if (seq !== CAP_SEQ || window.__capDone) return;
    window.__capDone = true;
    const cv = findCanvas(W, H); if (!cv) return;
    const gl = cv.getContext('webgl2'); const a = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, a);
    window.__cap = a;
};

const MODES = [
    { name: 'points_webgpu', file: 'nbody3d_cl', force: '', noPoints: false },
    { name: 'readback_webgpu', file: 'nbody3d_cl', force: '', noPoints: true },
    { name: 'webgl2_readback', file: 'nbody3d_cl', force: 'webgl2', noPoints: false },
    { name: 'cpu_wasm', file: 'nbody3d', force: '', noPoints: false }
];
const TIME_ARGS = ['3072', '10', '40'];   // 40 幀＝4 個週期（每 10 幀印一行）
const CAP_ARGS = ['3072', '10', '6'];     // 6 幀後結束；第 3 幀抓像素
const pix = {};
try {
    R.webgpu = !!navigator.gpu;
    installCounters();
    R.by = {};
    for (const m of MODES) {
        window.FA_KIR_FORCE_BACKEND = m.force;
        window.FA_KIR_NO_POINTS = m.noPoints;
        resetCounters();
        const t = await runJob(m.file, TIME_ARGS, 900000);
        const perRun = Object.assign({}, counters);
        const tp = parseNbody(t.out);
        window.__capDone = false; window.__cap = null;
        const c = await runJob(m.file, CAP_ARGS, 900000);
        pix[m.name] = window.__cap;
        // 有沒有畫東西：非黑像素數（任一通道 > 20）；全黑就代表這次抓到的是空畫面，像素比對不算數
        let lit = 0; if (window.__cap) { const a = window.__cap; for (let i = 0; i < a.length; i += 4) if (a[i] > 20 || a[i + 1] > 20 || a[i + 2] > 20) lit++; }
        const cyc = tp.cycles_s || [];
        R.by[m.name] = {
            ok: t.ok && c.ok, cen_40: tp.cen, cycles_s: cyc,
            per_step_ms_median: cyc.length > 1 ? +(median(cyc.slice(1)) / 10 * 1000).toFixed(2) : null,
            per_step_ms_first: cyc.length ? +(cyc[0] / 10 * 1000).toFixed(2) : null,
            counters_40_frames: perRun,
            captured: !!window.__cap, lit_pixels: lit
        };
    }
    window.FA_KIR_FORCE_BACKEND = ''; window.FA_KIR_NO_POINTS = false;
    // 像素比對（同一幀、同一個 GUI 畫布）
    const diffStats = (a, b) => {
        if (!a || !b) return null;
        let max = 0, sum = 0, over8 = 0, over32 = 0;
        for (let i = 0; i < a.length; i += 4) {
            let d = 0;
            for (let k = 0; k < 3; k++) { const e = Math.abs(a[i + k] - b[i + k]); if (e > d) d = e; }
            if (d > max) max = d; sum += d; if (d > 8) over8++; if (d > 32) over32++;
        }
        const n = a.length / 4;
        return { max_channel_diff: max, mean_channel_diff: +(sum / n).toFixed(4), pixels_over_8: over8, pixels_over_32: over32, pixels: n };
    };
    R.pixels = {
        points_vs_readback_webgpu: diffStats(pix.points_webgpu, pix.readback_webgpu),
        points_vs_webgl2: diffStats(pix.points_webgpu, pix.webgl2_readback),
        readback_webgpu_vs_webgl2: diffStats(pix.readback_webgpu, pix.webgl2_readback),
        points_vs_cpu: diffStats(pix.points_webgpu, pix.cpu_wasm)
    };
} catch (e) { R.errors.push(String((e && e.stack) || e).slice(0, 400)); }
console.log('LLC_INTEROP ' + JSON.stringify(R));
return R;
