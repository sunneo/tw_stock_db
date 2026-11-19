// 標準互通範例 gpgpu/interop_cl_gl.ll 的真 Electron 評測（DESIGN.webgpu-cuda.md §13 階段 10）：走 app 的 lli job。
// 三種模式（同一份標準 .ll，不改寫）：
//   fast_webgpu ：WebGPU 裝置，框架執行期優化開（共享緩衝區由 WebGPU 核心寫、glDrawArrays(GL_POINTS) 加法混合 → 不讀回直接畫）
//   copy_webgpu ：同一顆 WebGPU 裝置，優化關（window.FA_KIR_NO_INTEROP＝true）：Release 時讀回、GL 走複製路徑（標準語意的基準）
//   webgl2      ：WebGL2 後端（window.FA_KIR_FORCE_BACKEND＝'webgl2'）：優化不適用，走複製路徑
// 量的東西：程式自己印的 "interop OK frames=… n=… checksum=…"（結尾讀回總和，三種模式要相同）；頁面計數器 GPUBuffer.mapAsync（＝讀回）、
// GPUCommandEncoder.beginRenderPass（＝裝置直接畫點）、GPUQueue.writeBuffer、GPUQueue.submit；整段 N 幀的耗時；第 3 幀的畫布像素互相比對。
// 由 scripts/eval/llc_interop.build.js 產生。結果：LLC_INTEROP {…}。沒有真 GPU 時 WebGPU 是軟體 Vulkan（swiftshader），數字只代表正確性，不代表速度。
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
const parseOut = (out) => { const m = /interop OK frames=(\d+) n=(\d+) checksum=([-\d.]+)/.exec(out); return m ? { frames: +m[1], n: +m[2], checksum: +m[3] } : { raw: out.slice(-300) }; };
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
const CAP_SEQ = 3, W = 640, H = 480;
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
    { name: 'fast_webgpu', force: '', noInterop: false },
    { name: 'copy_webgpu', force: '', noInterop: true },
    { name: 'webgl2', force: 'webgl2', noInterop: false }
];
const FILE = 'interop_cl_gl', TIME_ARGS = ['4096', '60'], CAP_ARGS = ['4096', '6'];
const pix = {};
try {
    R.webgpu = !!navigator.gpu;
    installCounters();
    R.by = {};
    for (const m of MODES) {
        window.FA_KIR_FORCE_BACKEND = m.force;
        window.FA_KIR_NO_INTEROP = m.noInterop;
        resetCounters();
        const t0 = Date.now();
        const t = await runJob(FILE, TIME_ARGS, 300000);
        const ms = Date.now() - t0;
        const perRun = Object.assign({}, counters);
        const tp = parseOut(t.out);
        window.__capDone = false; window.__cap = null;
        const c = await runJob(FILE, CAP_ARGS, 300000);
        pix[m.name] = window.__cap;
        let lit = 0; if (window.__cap) { const a = window.__cap; for (let i = 0; i < a.length; i += 4) if (a[i] > 20 || a[i + 1] > 20 || a[i + 2] > 20) lit++; }
        R.by[m.name] = { ok: t.ok && c.ok, out: tp, total_ms_60_frames: ms, counters_60_frames: perRun, captured: !!window.__cap, lit_pixels: lit };
    }
    window.FA_KIR_FORCE_BACKEND = ''; window.FA_KIR_NO_INTEROP = false;
    const base = R.by.copy_webgpu.out;
    R.same_checksum = {};
    for (const k of ['fast_webgpu', 'webgl2']) R.same_checksum[k] = !!(R.by[k].out.checksum !== undefined && base.checksum !== undefined && Math.abs(R.by[k].out.checksum - base.checksum) < 0.05);
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
    R.pixels = { fast_vs_copy_webgpu: diffStats(pix.fast_webgpu, pix.copy_webgpu), fast_vs_webgl2: diffStats(pix.fast_webgpu, pix.webgl2), copy_webgpu_vs_webgl2: diffStats(pix.copy_webgpu, pix.webgl2) };
    // 判定：快速路徑 mapAsync 只有結尾那一次讀回（每個 job 一次，計時＋截圖兩個 job 共 2 次內）、有畫點精靈的 render pass；複製路徑每幀讀回
    R.verdict = { fast_no_per_frame_readback: R.by.fast_webgpu.counters_60_frames.map <= 4, fast_used_device_draw: R.by.fast_webgpu.counters_60_frames.rp >= 60, copy_reads_back_each_frame: R.by.copy_webgpu.counters_60_frames.map >= 60 };
} catch (e) { R.errors.push(String((e && e.stack) || e).slice(0, 400)); }
console.log('LLC_INTEROP ' + JSON.stringify(R));
return R;
