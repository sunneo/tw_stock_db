// KIR 主機掛鉤的端到端（真 Electron，走 app 的 lli job，同 llc_hud.eval.js 的做法）：
//   nbody3d_cl（OpenCL 版）與 fluid3d_cl 在三種後端下跑：WebGPU（預設，有 JSPI 時）、WebGL2（window.FA_KIR_FORCE_BACKEND＝'webgl2'）、JS 墊片（'js'）。
//   輸出與 CPU 版（nbody3d、fluid3d 的 wasm）比對；每個後端的每步耗時（nbody：每 10 步的週期時間÷10，含繪圖）；
//   HUD 的狀態行用畫布像素確認實際顯示的後端（覆蓋率 ≥ 0.95 才算顯示）。
// 由 scripts/eval/llc_kir_e2e.build.js 產生。結果：LLC_KIR_E2E {…}。
const SRC = __SRC__;
const fa = window.fa; const R = { errors: [] };
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const startJob = async (file, args) => (await tool('job_run', { lang: 'llvm', code: SRC.LL[file], args, detach: true, timeout_s: 900 })).job_id;
const stopJob = async (id) => { try { await tool('job_stop', { job_id: id }); } catch (_) { /* 已結束 */ } };
const jobOutput = async (id) => { const g = await tool('job_gui', { job_id: id, action: 'snapshot' }); return String(g.output || ''); };
const waitExit = async (id, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const j = (await tool('job_list', {})).jobs.find((q) => q.job_id === id); if (!j || !j.running) return true; await wait(500); } return false; };

// 字型與覆蓋率（同 llc_hud.eval.js）
const glyphPts = (str, x0, y0) => {
    const pts = [];
    for (let k = 0; k < str.length; k++) {
        const code = str.charCodeAt(k) & 255;
        if (code < 32 || code > 126) continue;
        const base = (code - 32) * 13;
        for (let r = 0; r < 13; r++) { const bits = SRC.ROWS[base + r]; if (!bits) continue; for (let c = 0; c < 7; c++) if (bits & (1 << (6 - c))) pts.push([x0 + k * 7 + c, y0 + r - 2]); }
    }
    return pts;
};
const grab = (cv) => { const gl = cv.getContext('webgl2'); const w = cv.width, h = cv.height; const a = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, a); return { a, w, h }; };
const coverage = (img, pts) => { let lit = 0; for (const [x, y] of pts) { if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue; const i = ((img.h - 1 - y) * img.w + x) * 4; if ((img.a[i] + img.a[i + 1] + img.a[i + 2]) / 3 > 100) lit++; } return pts.length ? +(lit / pts.length).toFixed(3) : 0; };
const findCanvas = (w, h) => [...document.querySelectorAll('canvas')].find((c) => c.width === w && c.height === h && c.getContext('webgl2'));
const waitCanvas = async (w, h, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const c = findCanvas(w, h); if (c) return c; await wait(300); } return null; };

// 讀輸出：nbody 的最後一行 frames=… cx=…；週期行 "N 秒數"；fluid 的 frames=… y_mean=…
const parseNbody = (out) => {
    const m = /frames=(\d+) bodies=(\d+) cx=([-\d.]+) cy=([-\d.]+) cz=([-\d.]+)/.exec(out);
    const cyc = [...out.matchAll(/^(\d+) ([\d.]+)$/gm)].map((x) => +x[2]);
    return m ? { frames: +m[1], bodies: +m[2], cen: [+m[3], +m[4], +m[5]], cycles_s: cyc } : { raw: out.slice(-300) };
};
const parseFluid = (out) => { const m = /frames=(\d+) n=(\d+) y_mean=([-\d.]+)/.exec(out); return m ? { frames: +m[1], n: +m[2], y_mean: +m[3] } : { raw: out.slice(-300) }; };
const runJob = async (file, args, maxMs) => {
    const id = await startJob(file, args);
    const ok = await waitExit(id, maxMs);
    const out = await jobOutput(id);
    if (!ok) await stopJob(id);
    return { ok, out };
};

// HUD：用 maxf＝0（不結束）的 job，取畫布上狀態行的像素；candidates 取覆蓋率最高者
const LABELS = ['GPU: OpenCL kernels (WebGPU backend)', 'GPU: OpenCL kernels (WebGL2 backend)', 'GPU: OpenCL JS shim (not GPU)', 'GPU: OpenCL not dispatched yet', 'CPU: wasm integration'];
const hudCheck = async () => {
    const id = await startJob('nbody3d_cl', ['3072', '100000', '0']);
    try {
        await wait(4000);
        const cv = await waitCanvas(800, 560, 20000);
        if (!cv) return { error: '找不到 800×560 畫布' };
        await wait(1500);
        const img = grab(cv);
        const scored = LABELS.map((t) => ({ text: t, coverage: coverage(img, glyphPts(t, 5, 145)) })).sort((p, q) => q.coverage - p.coverage);
        return { best: scored[0].text, coverage: scored[0].coverage, shown: scored[0].coverage >= 0.95 ? scored[0].text : null, all: scored.map((s) => [s.text, s.coverage]) };
    } finally { await stopJob(id); }
};

// 三種後端（window.FA_KIR_FORCE_BACKEND：空＝WebGPU 優先；'webgl2'；'js'）
const configs = [{ name: 'webgpu', force: '' }, { name: 'webgl2', force: 'webgl2' }, { name: 'js', force: 'js' }];
const NB_ARGS = ['3072', '10', '20'], FL_ARGS = ['20'];
try {
    R.jspi = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
    R.gpu = !!navigator.gpu;
    // CPU 參考（wasm）
    const cpuNb = await runJob('nbody3d', NB_ARGS, 900000); R.cpu_nbody = parseNbody(cpuNb.out); R.cpu_nbody.ok = cpuNb.ok;
    const cpuFl = await runJob('fluid3d', FL_ARGS, 900000); R.cpu_fluid = parseFluid(cpuFl.out); R.cpu_fluid.ok = cpuFl.ok;
    R.by = {};
    for (const cfg of configs) {
        window.FA_KIR_FORCE_BACKEND = cfg.force;
        const r = {};
        const nb = await runJob('nbody3d_cl', NB_ARGS, 900000); r.nbody = parseNbody(nb.out); r.nbody.ok = nb.ok;
        const fl = await runJob('fluid3d_cl', FL_ARGS, 900000); r.fluid = parseFluid(fl.out); r.fluid.ok = fl.ok;
        r.hud = await hudCheck();
        R.by[cfg.name] = r;
    }
    window.FA_KIR_FORCE_BACKEND = '';
} catch (e) { R.errors.push(String((e && e.stack) || e).slice(0, 400)); }
console.log('LLC_KIR_E2E ' + JSON.stringify(R));
return R;
