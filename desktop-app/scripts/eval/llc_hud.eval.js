// llc 互動範例的螢幕說明（HUD）真 Electron 檢查（DESIGN.run-terminal.md §21.y）。
// 做法：跑範例的 job，等幾幀，從畫布（preserveDrawingBuffer）讀出像素，與「依 _gen 的 text() 規則算出的期望像素」比對。
//   期望像素：字串每個字元是 7×13 點陣（字型＝_font_data.py），第 k 個字元的第 r 列第 c 欄（最高位在左）畫在 (x0+7k+c, y0+r−2)。
//   覆蓋率＝期望像素中「夠亮」（R+G+B 平均 > 100）的比例；≥ 0.95 視為文字正確顯示。
// 另外：nbody3d_cl 預設 GPU（開場檢查狀態行與按鈕底色）；用 gui 的滑鼠事件點 CPU／GPU 按鈕，檢查狀態行與按鈕底色（選中＝綠）真的變；比對 CPU 與 OpenCL（預設 GPU）的最終叢集中心。
// 由 scripts/eval/llc_hud.build.js 產生。結果：LLC_HUD {…} 一行 JSON。
const SRC = __SRC__;
const fa = window.fa; const R = { rows: [], output: {} };
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 期望像素（與 _gen 的 text() 同一個規則）
const glyphPts = (str, x0, y0) => {
    const pts = [];
    for (let k = 0; k < str.length; k++) {
        const code = str.charCodeAt(k) & 255;
        if (code < 32 || code > 126) continue;
        const base = (code - 32) * 13;
        for (let r = 0; r < 13; r++) {
            const bits = SRC.ROWS[base + r];
            if (!bits) continue;
            for (let c = 0; c < 7; c++) if (bits & (1 << (6 - c))) pts.push([x0 + k * 7 + c, y0 + r - 2]);
        }
    }
    return pts;
};
// 畫布像素（GL 原點在左下；畫面座標 y 向下）
const grab = (cv) => {
    const gl = cv.getContext('webgl2'); const w = cv.width, h = cv.height;
    const a = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, a);
    return { a, w, h };
};
const coverage = (img, pts) => {
    let lit = 0;
    for (const [x, y] of pts) {
        if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
        const i = ((img.h - 1 - y) * img.w + x) * 4;
        if ((img.a[i] + img.a[i + 1] + img.a[i + 2]) / 3 > 100) lit++;
    }
    return pts.length ? +(lit / pts.length).toFixed(3) : 0;
};
const findCanvas = (w, h) => [...document.querySelectorAll('canvas')].find((c) => c.width === w && c.height === h && c.getContext('webgl2'));
// 等畫布出現（新的 job 建立視窗需要時間）
const waitCanvas = async (w, h, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const c = findCanvas(w, h); if (c) return c; await wait(300); } return null; };
const canvasNode = async (jobId) => {
    const g = await tool('job_gui', { job_id: jobId, action: 'snapshot' });
    const cv = g.windows && g.windows[0] && g.windows[0].nodes.find((n) => n.kind === 'canvas');
    return cv ? cv.id : null;
};
const click = async (jobId, node, x, y) => {
    await tool('job_gui', { job_id: jobId, action: 'mouse', node, value: { kind: 'move', x, y, button: 0 }, wait_ms: 50 });
    await tool('job_gui', { job_id: jobId, action: 'mouse', node, value: { kind: 'down', x, y, button: 0 }, wait_ms: 50 });
    await tool('job_gui', { job_id: jobId, action: 'mouse', node, value: { kind: 'up', x, y, button: 0 }, wait_ms: 150 });
};
// 檢查一段文字：candidates 取覆蓋率最高者
const check = (example, state, label, x, y, candidates, cv) => {
    const img = grab(cv);
    const scored = candidates.map((t) => ({ text: t, coverage: coverage(img, glyphPts(t, x, y)) }));
    scored.sort((p, q) => q.coverage - p.coverage);
    const best = scored[0];
    R.rows.push({ example, state, label, shown: best.coverage >= 0.95 ? best.text : null, best_coverage: best.coverage, pass: best.coverage >= 0.95 });
    return best;
};
const startJob = async (file, args) => (await tool('job_run', { lang: 'llvm', code: SRC.LL[file], args, detach: true, timeout_s: 900 })).job_id;
const stopJob = async (id) => { try { await tool('job_stop', { job_id: id }); } catch (_) { /* 已結束 */ } };
const jobOutput = async (id) => { const g = await tool('job_gui', { job_id: id, action: 'snapshot' }); return String(g.output || ''); };
const waitExit = async (id, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const j = (await tool('job_list', {})).jobs.find((q) => q.job_id === id); if (!j || !j.running) return true; await wait(500); } return false; };

const NB = ['512', '100000', '0'];
// 1. nbody3d（CPU 版）：文字與按鈕
{
    const id = await startJob('nbody3d', NB); await wait(5000);
    const cv = findCanvas(800, 560);
    if (!cv) R.rows.push({ example: 'nbody3d', label: 'canvas', pass: false, note: '找不到 800×560 的 WebGL 畫布' });
    else {
        check('nbody3d', '0.4 s 後', '"compute source:" 標題', 5, 125, ['compute source:'], cv);
        check('nbody3d', '0.4 s 後', 'GPU 按鈕行（CPU 版）', 5, 145, ['GPU: run nbody3d_cl.ll (OpenCL) instead'], cv);
        check('nbody3d', '0.4 s 後', 'CPU 按鈕字', 152, 125, ['CPU'], cv);
        check('nbody3d', '0.4 s 後', 'GPU 按鈕字', 212, 125, ['GPU'], cv);
    }
    await stopJob(id);
}
// 2. nbody3d_cl（OpenCL 版）：預設 GPU；狀態行與按鈕底色（選中＝綠、未選中＝灰）隨模式變；GPU 不可用時退回 CPU 並說明
const GREEN_PX = [143, 139], CPU_BTN = [143, 139], GPU_BTN = [203, 139];
const isGreen = (img, x, y) => { const i = ((img.h - 1 - y) * img.w + x) * 4; const r = img.a[i], g = img.a[i + 1], b = img.a[i + 2]; return g > 100 && g > r + 40 && g > b + 40; };
const btnRow = (example, state, img) => {
    const cpuG = isGreen(img, CPU_BTN[0], CPU_BTN[1]), gpuG = isGreen(img, GPU_BTN[0], GPU_BTN[1]);
    R.rows.push({ example, state, label: '按鈕底色（CPU 按鈕、GPU 按鈕）', shown: (cpuG ? 'CPU 綠' : 'CPU 非綠') + '、' + (gpuG ? 'GPU 綠' : 'GPU 非綠'), best_coverage: null, pass: null, cpu_green: cpuG, gpu_green: gpuG });
    return { cpuG, gpuG };
};
{
    const id = await startJob('nbody3d_cl', NB); await wait(5000);
    const cv = findCanvas(800, 560); const node = await canvasNode(id);
    if (!cv || !node) R.rows.push({ example: 'nbody3d_cl', label: 'canvas', pass: false, note: '找不到畫布或節點' });
    else {
        const CANDS = ['GPU: OpenCL kernels (WebGL2 backend)', 'GPU: OpenCL JS shim (not GPU)', 'GPU: OpenCL not dispatched yet', 'GPU unavailable: WebGL2 float render not supported', 'CPU: wasm integration'];
        const st0 = check('nbody3d_cl', '開場（預設）', '狀態行', 5, 145, CANDS, cv);
        const defaultGpu = st0.text.startsWith('GPU');
        R.rows[R.rows.length - 1].pass = defaultGpu || st0.text.startsWith('GPU unavailable') ? (st0.coverage >= 0.95) : false;
        R.rows[R.rows.length - 1].note = defaultGpu ? '預設是 GPU' : '預設 GPU 不可用，已退回 CPU（應顯示原因）';
        const img0 = grab(cv); const b0 = btnRow('nbody3d_cl', '開場（預設）', img0);
        if (defaultGpu) R.rows[R.rows.length - 1].pass = b0.gpuG && !b0.cpuG;
        else R.rows[R.rows.length - 1].pass = b0.cpuG && !b0.gpuG;

        await click(id, node, 165, 132); await wait(2500);
        const img1 = grab(findCanvas(800, 560));
        check('nbody3d_cl', '點 CPU 後', '狀態行', 5, 145, ['CPU: wasm integration'], findCanvas(800, 560));
        const b1 = btnRow('nbody3d_cl', '點 CPU 後', img1);
        R.rows[R.rows.length - 1].pass = b1.cpuG && !b1.gpuG;

        await click(id, node, 225, 132); await wait(3500);
        const img2 = grab(findCanvas(800, 560));
        const st2 = check('nbody3d_cl', '再點 GPU 後', '狀態行', 5, 145, CANDS.slice(0, 4), findCanvas(800, 560));
        const b2 = btnRow('nbody3d_cl', '再點 GPU 後', img2);
        R.rows[R.rows.length - 1].pass = b2.gpuG && !b2.cpuG;
    }
    await stopJob(id);
}
// 2b. 模擬沒有 WebGL2 浮點渲染（把 EXT_color_buffer_float 藏起來）：應該自動退回 CPU，狀態行寫出原因，CPU 按鈕綠
{
    const P = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
    const origGet = P.getExtension;
    P.getExtension = function (n) { return n === 'EXT_color_buffer_float' ? null : origGet.call(this, n); };
    try {
        const id = await startJob('nbody3d_cl', NB); await wait(6000);
        const cv = findCanvas(800, 560); const node = await canvasNode(id);
        if (!cv || !node) R.rows.push({ example: 'nbody3d_cl', state: '無浮點渲染', label: 'canvas', pass: false, note: '找不到畫布' });
        else {
            const st = check('nbody3d_cl', '無浮點渲染（模擬）', '狀態行（應說明退回 CPU 的原因）', 5, 145, ['GPU unavailable: WebGL2 float render not supported', 'CPU: wasm integration'], cv);
            const b = btnRow('nbody3d_cl', '無浮點渲染（模擬）', grab(cv));
            R.rows[R.rows.length - 1].pass = b.cpuG && !b.gpuG;
            R.rows[R.rows.length - 1].note = '退回 CPU 後，CPU 按鈕應為綠色';
        }
        await stopJob(id);
    } finally { P.getExtension = origGet; }
}
// 3. 輸出一致性：CPU 版 vs OpenCL 版（預設 GPU，不點按鈕）；結束行印出叢集中心
{
    const FR = ['512', '100000', '200'];
    const a = await startJob('nbody3d', FR); await waitExit(a, 240000); const outA = await jobOutput(a); await stopJob(a);
    const b = await startJob('nbody3d_cl', FR); await waitExit(b, 240000); const outB = await jobOutput(b); await stopJob(b);
    const cen = (s) => (s.match(/cx=[-0-9.]+ cy=[-0-9.]+ cz=[-0-9.]+/) || [null])[0];
    R.output.nbody = { cpu: cen(outA), cl_default: cen(outB), same: !!cen(outA) && cen(outA) === cen(outB) };
}
// 4. fluid3d（CPU）與 fluid3d_cl（OpenCL）：狀態文字（不限幀數，檢查完再停）；輸出另外用 200 幀比對
{
    const FL = ['100000'];
    const a = await startJob('fluid3d', FL); await wait(4000);
    const cvA = await waitCanvas(640, 480, 8000);
    if (cvA) {
        check('fluid3d', '4 s 後', '狀態行前綴', 5, 5, ['1000 particles | source: CPU (wasm) | step '], cvA);
        check('fluid3d', '4 s 後', '操作說明行', 5, 25, ['[drag]rotate [wheel]zoom [space]splash [P]pause [R]reset'], cvA);
    } else R.rows.push({ example: 'fluid3d', label: 'canvas', pass: false, note: '找不到 640×480 的 WebGL 畫布' });
    await stopJob(a);
    const b = await startJob('fluid3d_cl', FL); await wait(4000);
    const cvB = await waitCanvas(640, 480, 8000);
    if (cvB) check('fluid3d_cl', '4 s 後', '狀態行前綴', 5, 5, ['1000 particles | source: OpenCL WebGL2 | step ', '1000 particles | source: OpenCL JS shim (not GPU) | step ', '1000 particles | source: OpenCL not dispatched yet | step '], cvB);
    else R.rows.push({ example: 'fluid3d_cl', label: 'canvas', pass: false, note: '找不到 640×480 的 WebGL 畫布' });
    await stopJob(b);
    const ym = (s) => (s.match(/y_mean=[-0-9.]+/) || [null])[0];
    const a2 = await startJob('fluid3d', ['200']); await waitExit(a2, 240000); const outA = await jobOutput(a2); await stopJob(a2);
    const b2 = await startJob('fluid3d_cl', ['200']); await waitExit(b2, 240000); const outB = await jobOutput(b2); await stopJob(b2);
    R.output.fluid = { cpu: ym(outA), cl: ym(outB), same: !!ym(outA) && ym(outA) === ym(outB) };
}
console.log('LLC_HUD ' + JSON.stringify(R));
return R;
