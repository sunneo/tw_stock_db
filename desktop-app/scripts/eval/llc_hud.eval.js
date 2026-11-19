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
    const w = cv.width, h = cv.height;
    const gl = cv.getContext('webgl2');
    if (gl) { const a = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, a); return { a, w, h, flip: true }; }
    // SDL 的 2D 畫布（gui_render.js）：原點在左上，不翻轉
    const a = cv.getContext('2d').getImageData(0, 0, w, h).data;
    return { a, w, h, flip: false };
};
const pixIdx = (img, x, y) => ((img.flip ? img.h - 1 - y : y) * img.w + x) * 4;
const coverage = (img, pts) => {
    let lit = 0;
    for (const [x, y] of pts) {
        if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
        const i = pixIdx(img, x, y);
        if ((img.a[i] + img.a[i + 1] + img.a[i + 2]) / 3 > 100) lit++;
    }
    return pts.length ? +(lit / pts.length).toFixed(3) : 0;
};
const findCanvas = (w, h) => [...document.querySelectorAll('canvas')].find((c) => c.width === w && c.height === h && c.getContext('webgl2'));
// 任何種類的畫布（SDL 是 2D、GL 是 webgl2）：取最後建立的（同尺寸的舊畫布可能還在）
const findAnyCanvas = (w, h) => [...document.querySelectorAll('canvas')].filter((c) => c.width === w && c.height === h).pop() || null;
const waitAnyCanvas = async (w, h, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const c = findAnyCanvas(w, h); if (c) return c; await wait(300); } return null; };
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
// 完全吻合：候選中只有一個的覆蓋率 ≥ 0.999，其餘 < 0.999（WebGL2 與 WebGPU 的字只差幾個像素，0.95 的門檻分不出來）
const exactBest = (cands, x, y, cv) => {
    const img = grab(cv);
    const sc = cands.map((t) => ({ text: t, coverage: coverage(img, glyphPts(t, x, y)) })).sort((p, q) => q.coverage - p.coverage);
    return { best: sc[0], second: sc[1], ok: sc[0].coverage >= 0.999 && sc[1].coverage < 0.999 };
};
const GREEN_PX = [143, 139], CPU_BTN = [143, 139], GPU_BTN = [203, 139];
const isGreen = (img, x, y) => { const i = pixIdx(img, x, y); const r = img.a[i], g = img.a[i + 1], b = img.a[i + 2]; return g > 100 && g > r + 40 && g > b + 40; };
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
        const CANDS = ['GPU: OpenCL kernels (WebGPU backend)', 'GPU: OpenCL kernels (WebGL2 backend)', 'GPU: OpenCL JS shim (not GPU)', 'GPU: OpenCL not dispatched yet', 'GPU unavailable: WebGL2 float render not supported', 'CPU: wasm integration'];
        const ex0 = exactBest(CANDS, 5, 145, cv); const defaultGpu = ex0.best.text.startsWith('GPU');
        R.rows.push({ example: 'nbody3d_cl', state: '開場（預設）', label: '狀態行（完全吻合）', shown: ex0.best.text, best_coverage: ex0.best.coverage, pass: ex0.ok && defaultGpu });
        const img0 = grab(cv); const b0 = btnRow('nbody3d_cl', '開場（預設）', img0);
        R.rows[R.rows.length - 1].pass = defaultGpu ? (b0.gpuG && !b0.cpuG) : (b0.cpuG && !b0.gpuG);

        await click(id, node, 165, 132); await wait(2500);
        const img1 = grab(findCanvas(800, 560));
        check('nbody3d_cl', '點 CPU 後', '狀態行', 5, 145, ['CPU: wasm integration'], findCanvas(800, 560));
        const b1 = btnRow('nbody3d_cl', '點 CPU 後', img1);
        R.rows[R.rows.length - 1].pass = b1.cpuG && !b1.gpuG;

        await click(id, node, 225, 132); await wait(3500);
        const img2 = grab(findCanvas(800, 560));
        const ex2 = exactBest(CANDS.slice(0, 4), 5, 145, findCanvas(800, 560));
        R.rows.push({ example: 'nbody3d_cl', state: '再點 GPU 後', label: '狀態行（完全吻合）', shown: ex2.best.text, best_coverage: ex2.best.coverage, pass: ex2.ok && ex2.best.text.startsWith('GPU') });
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
    // WebGPU 也要藏起來：只藏浮點擴充的話，v492 之後後端會走 WebGPU（不需要那個擴充），就不會退回 CPU
    const NAVGPU = Object.getOwnPropertyDescriptor(navigator, 'gpu'); Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
    try {
        const id = await startJob('nbody3d_cl', NB); await wait(6000);
        const cv = findCanvas(800, 560); const node = await canvasNode(id);
        if (!cv || !node) R.rows.push({ example: 'nbody3d_cl', state: '無浮點渲染', label: 'canvas', pass: false, note: '找不到畫布' });
        else {
            const ex = exactBest(['GPU unavailable: WebGL2 float render not supported', 'CPU: wasm integration'], 5, 145, cv);
            R.rows.push({ example: 'nbody3d_cl', state: '無浮點渲染（模擬）', label: '狀態行（應說明退回 CPU 的原因，完全吻合）', shown: ex.best.text, best_coverage: ex.best.coverage, pass: ex.ok && ex.best.text.startsWith('GPU unavailable') });
            const b = btnRow('nbody3d_cl', '無浮點渲染（模擬）', grab(cv));
            R.rows[R.rows.length - 1].pass = b.cpuG && !b.gpuG;
            R.rows[R.rows.length - 1].note = '退回 CPU 後，CPU 按鈕應為綠色';
        }
        await stopJob(id);
    } finally { P.getExtension = origGet; if (NAVGPU) Object.defineProperty(navigator, 'gpu', NAVGPU); else delete navigator.gpu; }
}
// 3. 輸出一致性：CPU 版 vs OpenCL 版（預設 GPU，不點按鈕）；結束行印出叢集中心
{
    const FR = ['512', '100000', '200'];
    const a = await startJob('nbody3d', FR); await waitExit(a, 240000); const outA = await jobOutput(a); await stopJob(a);
    const b = await startJob('nbody3d_cl', FR); await waitExit(b, 240000); const outB = await jobOutput(b); await stopJob(b);
    const cen = (s) => (s.match(/cx=[-0-9.]+ cy=[-0-9.]+ cz=[-0-9.]+/) || [null])[0];
    R.output.nbody = { cpu: cen(outA), cl_default: cen(outB), same: !!cen(outA) && cen(outA) === cen(outB) };
}
// 4. fluid3d（CPU，純 CPU 版）與 fluid3d_cl（OpenCL 版：預設 GPU、底部 CPU／GPU 按鈕）
const FB_CPU = [495, 450], FB_GPU = [555, 450], FBTN_CPU_PX = [474, 457], FBTN_GPU_PX = [534, 457];
const fluidState = async (example, state, cv) => {
    const cands = ['1000 particles | source: GPU (OpenCL WebGPU) | step ', '1000 particles | source: GPU (OpenCL WebGL2) | step ', '1000 particles | source: GPU (OpenCL JS shim, not GPU) | step ', '1000 particles | source: GPU (OpenCL, not dispatched) | step ', '1000 particles | source: CPU (wasm) | step ', '1000 particles | source: CPU, GPU unavailable (no WebGL2 float) | step '];
    const ex = exactBest(cands, 5, 5, cv);
    R.rows.push({ example, state, label: '狀態行前綴（完全吻合）', shown: ex.best.text, best_coverage: ex.best.coverage, pass: ex.ok });
    const st = { text: ex.best.text, coverage: ex.best.coverage, exact: ex.ok };
    const img = grab(cv);
    const cpuG = isGreen(img, FBTN_CPU_PX[0], FBTN_CPU_PX[1]), gpuG = isGreen(img, FBTN_GPU_PX[0], FBTN_GPU_PX[1]);
    R.rows.push({ example, state, label: '按鈕底色（CPU 按鈕、GPU 按鈕）', shown: (cpuG ? 'CPU 綠' : 'CPU 非綠') + '、' + (gpuG ? 'GPU 綠' : 'GPU 非綠'), best_coverage: null, pass: null, cpu_green: cpuG, gpu_green: gpuG });
    return { st, cpuG, gpuG };
};
{
    const a = await startJob('fluid3d', ['100000']); await wait(4000);
    const cvA = await waitCanvas(640, 480, 8000);
    if (cvA) {
        check('fluid3d', '4 s 後', '狀態行前綴', 5, 5, ['1000 particles | source: CPU (wasm) | step '], cvA);
        check('fluid3d', '4 s 後', '操作說明行', 5, 25, ['[drag]rotate [wheel]zoom [space]splash [P]pause [R]reset'], cvA);
    } else R.rows.push({ example: 'fluid3d', label: 'canvas', pass: false, note: '找不到 640×480 的 WebGL 畫布' });
    await stopJob(a);
}
{
    const b = await startJob('fluid3d_cl', ['100000']); await wait(4000);
    const cvB = await waitCanvas(640, 480, 8000); const node = await canvasNode(b);
    if (!cvB || !node) R.rows.push({ example: 'fluid3d_cl', label: 'canvas', pass: false, note: '找不到 640×480 的畫布或節點' });
    else {
        const d = await fluidState('fluid3d_cl', '開場（預設）', cvB);
        R.rows[R.rows.length - 1].pass = d.st.exact && (d.st.text.indexOf('GPU') >= 0 || d.st.text.indexOf('CPU, GPU unavailable') >= 0) && (d.st.text.indexOf('GPU') >= 0 ? (d.gpuG && !d.cpuG) : (d.cpuG && !d.gpuG));
        await click(b, node, FB_CPU[0], FB_CPU[1]); await wait(2500);
        const c1 = await fluidState('fluid3d_cl', '點 CPU 後', findCanvas(640, 480));
        R.rows[R.rows.length - 1].pass = c1.st.exact && c1.st.text.indexOf('CPU (wasm)') >= 0 && c1.cpuG && !c1.gpuG;
        await click(b, node, FB_GPU[0], FB_GPU[1]); await wait(3000);
        const c2 = await fluidState('fluid3d_cl', '再點 GPU 後', findCanvas(640, 480));
        R.rows[R.rows.length - 1].pass = c2.st.exact && c2.st.text.indexOf('GPU') >= 0 && c2.gpuG && !c2.cpuG;
    }
    await stopJob(b);
}
// 4b. fluid3d_cl 模擬沒有浮點渲染：應退回 CPU，狀態行寫出原因，CPU 按鈕綠
{
    const P = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
    const origGet = P.getExtension;
    P.getExtension = function (n) { return n === 'EXT_color_buffer_float' ? null : origGet.call(this, n); };
    // WebGPU 也要藏起來：只藏浮點擴充的話，v492 之後後端會走 WebGPU（不需要那個擴充），就不會退回 CPU
    const NAVGPU = Object.getOwnPropertyDescriptor(navigator, 'gpu'); Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
    try {
        const b = await startJob('fluid3d_cl', ['100000']); await wait(6000);
        const cvB = await waitCanvas(640, 480, 8000);
        if (!cvB) R.rows.push({ example: 'fluid3d_cl', state: '無浮點渲染（模擬）', label: 'canvas', pass: false, note: '找不到畫布' });
        else {
            const f = await fluidState('fluid3d_cl', '無浮點渲染（模擬）', cvB);
            R.rows[R.rows.length - 1].pass = f.st.exact && f.st.text.indexOf('CPU, GPU unavailable') >= 0 && f.cpuG && !f.gpuG;
            R.rows[R.rows.length - 1].note = '應顯示 CPU, GPU unavailable，CPU 按鈕綠';
        }
        await stopJob(b);
    } finally { P.getExtension = origGet; if (NAVGPU) Object.defineProperty(navigator, 'gpu', NAVGPU); else delete navigator.gpu; }
}
// 輸出：CPU 版（200 幀）vs OpenCL 版（200 幀，預設 GPU）vs OpenCL 版途中切到 CPU 再切回 GPU；y_mean 都要一致
{
    const a2 = await startJob('fluid3d', ['200']); await waitExit(a2, 240000); const outA = await jobOutput(a2); await stopJob(a2);
    const b2 = await startJob('fluid3d_cl', ['200']); await waitExit(b2, 240000); const outB = await jobOutput(b2); await stopJob(b2);
    const c3 = await startJob('fluid3d_cl', ['200']); await wait(1000); const node3 = await canvasNode(c3);
    if (node3) { await click(c3, node3, FB_CPU[0], FB_CPU[1]); await wait(1500); await click(c3, node3, FB_GPU[0], FB_GPU[1]); }
    await waitExit(c3, 240000); const outC = await jobOutput(c3); await stopJob(c3);
    const ym = (t) => (t.match(/y_mean=[-0-9.]+/) || [null])[0];
    R.output.fluid = { cpu: ym(outA), cl_default_gpu: ym(outB), cl_switched_cpu_then_gpu: ym(outC), same: !!ym(outA) && ym(outA) === ym(outB) && ym(outA) === ym(outC) };
}
// 5. 螢幕說明（HUD）有無檢查表：手寫與產生的互動範例，畫面上都要有可讀的操作說明；狀態文字要跟真實狀態一致（按鍵後會變）。
//    文字位置（與 _gen/_hud.py 的 hud_text 相同）：字串第 k 字元的第 r 列畫在 (x+7k+c, y+r)。
//    通過＝期望字串的覆蓋率 ≥ 0.95，且在候選字串中覆蓋率最高。
const hudPts = (str, x0, y0) => {
    const pts = [];
    for (let k = 0; k < str.length; k++) {
        let code = str.charCodeAt(k) & 255; if (code < 32 || code > 126) code = 32;
        const base = (code - 32) * 13;
        for (let r = 0; r < 13; r++) {
            const bits = SRC.ROWS[base + r];
            for (let c = 0; c < 7; c++) if (bits & (1 << (6 - c))) pts.push([x0 + k * 7 + c, y0 + r]);
        }
    }
    return pts;
};
const hudRow = (example, state, label, x, y, expected, alts, cv) => {
    const img = grab(cv);
    const cands = [expected, ...(alts || [])].map((t) => ({ text: t, coverage: coverage(img, hudPts(t, x, y)) }));
    const best = cands.slice().sort((p, q) => q.coverage - p.coverage)[0];
    const exp = cands[0];
    R.rows.push({ example, state, label, expected, shown: best.coverage >= 0.95 ? best.text : null, expected_coverage: exp.coverage, best_coverage: best.coverage, pass: best.text === expected && exp.coverage >= 0.95 });
};
const hudStatic = (example, state, label, x, y, text, cv) => {
    const img = grab(cv); const c = coverage(img, hudPts(text, x, y));
    R.rows.push({ example, state, label, expected: text, best_coverage: c, pass: c >= 0.95 });
};
const pressKey = async (id, node, k) => {
    await tool('job_gui', { job_id: id, action: 'key', node, value: { key: k, down: true }, wait_ms: 200 });
    await wait(300);
};

// 5a. music_player（640×280）：狀態（播放／暫停、波形、BPM）每幀重畫；按 2、空白、↑ 後要變
{
    const id = await startJob('music_player', ['0']); await wait(4000);
    const cv = await waitAnyCanvas(640, 280, 8000); const node = cv ? await canvasNode(id) : null;
    if (!cv || !node) R.rows.push({ example: 'music_player', label: 'canvas', pass: false, note: '找不到 640×280 的畫布或節點' });
    else {
        hudStatic('music_player', '開場', '操作說明（第 2 行）', 8, 244, 'SPACE PAUSE  1 2 3 WAVE', cv);
        hudStatic('music_player', '開場', '操作說明（第 3 行）', 8, 262, 'UP DOWN TEMPO', cv);
        hudRow('music_player', '開場', '播放狀態', 8, 198, 'PLAYING', ['PAUSED '], cv);
        hudRow('music_player', '開場', '目前波形（預設 TRIANGLE）', 64, 198, 'TRIANGLE', ['SQUARE  ', 'SINE    '], cv);
        hudRow('music_player', '開場', 'BPM 數字', 127, 198, '110', ['120', '100'], cv);
        await pressKey(id, node, '1');
        hudRow('music_player', '按 1 後', '目前波形', 64, 198, 'SQUARE  ', ['TRIANGLE', 'SINE    '], findAnyCanvas(640, 280));
        await pressKey(id, node, ' ');
        hudRow('music_player', '按空白後', '播放狀態', 8, 198, 'PAUSED ', ['PLAYING'], findAnyCanvas(640, 280));
        await pressKey(id, node, 'ArrowUp');
        hudRow('music_player', '按 ↑ 後（暫停中）', 'BPM 數字', 127, 198, '120', ['110'], findAnyCanvas(640, 280));
    }
    await stopJob(id);
}
// 5b. midi_player（640×320）：內嵌示範曲；狀態（播放／暫停、音符數、來源）
{
    const id = await startJob('midi_player', ['-', '0']); await wait(4000);
    const cv = await waitAnyCanvas(640, 320, 8000); const node = cv ? await canvasNode(id) : null;
    if (!cv || !node) R.rows.push({ example: 'midi_player', label: 'canvas', pass: false, note: '找不到 640×320 的畫布或節點' });
    else {
        hudRow('midi_player', '開場', '播放狀態', 8, 262, 'PLAYING', ['PAUSED '], cv);
        hudRow('midi_player', '開場', '音符數（hud_int 補空白）', 106, 262, ' 45', ['  0', '100'], cv);
        hudStatic('midi_player', '開場', '操作說明（第 2 行）', 8, 280, 'SPACE PAUSE  R RESTART  ESC QUIT', cv);
        hudRow('midi_player', '開場', '來源（沒有檔案參數＝示範曲）', 8, 298, 'SOURCE: DEMO', ['SOURCE: FILE'], cv);
        await pressKey(id, node, ' ');
        hudRow('midi_player', '按空白後', '播放狀態', 8, 262, 'PAUSED ', ['PLAYING'], findAnyCanvas(640, 320));
    }
    await stopJob(id);
}
// 5c. sdl2_piano（640×250）：琴鍵下方的說明；按 A 後已彈音符數加一
{
    const id = await startJob('sdl2_piano', ['0']); await wait(3500);
    const cv = await waitAnyCanvas(640, 250, 8000); const node = cv ? await canvasNode(id) : null;
    if (!cv || !node) R.rows.push({ example: 'sdl2_piano', label: 'canvas', pass: false, note: '找不到 640×250 的畫布或節點' });
    else {
        hudStatic('sdl2_piano', '開場', '操作說明（第 1 行）', 8, 200, 'A S D F G H J K = C4 TO C5', cv);
        hudStatic('sdl2_piano', '開場', '操作說明（第 2 行）', 8, 218, 'ESC QUIT  NOTES PLAYED ', cv);
        hudRow('sdl2_piano', '開場', '已彈音符數（hud_int 補空白）', 169, 218, '  0', ['  1'], cv);
        await pressKey(id, node, 'a');
        hudRow('sdl2_piano', '按 A 後', '已彈音符數', 169, 218, '  1', ['  0'], findAnyCanvas(640, 250));
    }
    await stopJob(id);
}
// 5d. sdl2_pong（640×440）：底部的說明與回擊數（RALLY）、最佳紀錄（BEST）
{
    const id = await startJob('sdl2_pong', ['0']); await wait(3500);
    const cv = await waitAnyCanvas(640, 440, 8000);
    if (!cv) R.rows.push({ example: 'sdl2_pong', label: 'canvas', pass: false, note: '找不到 640×440 的畫布' });
    else {
        hudStatic('sdl2_pong', '開場', '操作說明', 8, 412, 'W/S OR UP DOWN: MOVE', cv);
        hudStatic('sdl2_pong', '開場', '回擊數標籤', 8, 428, 'RALLY ', cv);
        hudRow('sdl2_pong', '開場', '回擊數', 50, 428, '  0', ['  1', '  2'], cv);
        hudStatic('sdl2_pong', '開場', '最佳紀錄標籤', 77, 428, 'BEST ', cv);
        hudRow('sdl2_pong', '開場', '最佳紀錄', 112, 428, '  0', ['  1'], cv);
        hudStatic('sdl2_pong', '開場', 'ESC 說明', 147, 428, 'ESC QUIT', cv);
    }
    await stopJob(id);
}
// 5e. sdl2_gl_triangle（640×480，OpenGL）：底部操作說明；左上角狀態（拖曳中／閒置）跟著滑鼠按下與放開變
{
    const id = await startJob('sdl2_gl_triangle', ['0']); await wait(4000);
    const cv = await waitAnyCanvas(640, 480, 8000); const node = cv ? await canvasNode(id) : null;
    if (!cv || !node) R.rows.push({ example: 'sdl2_gl_triangle', label: 'canvas', pass: false, note: '找不到 640×480 的 OpenGL 畫布或節點' });
    else {
        hudStatic('sdl2_gl_triangle', '開場', '操作說明（第 1 行）', 8, 440, 'DRAG: ROTATE   WHEEL: ZOOM', cv);
        hudStatic('sdl2_gl_triangle', '開場', '操作說明（第 2 行）', 8, 458, 'ESC QUIT', cv);
        hudRow('sdl2_gl_triangle', '開場', '拖曳狀態', 8, 8, 'IDLE', ['DRAGGING'], cv);
        await tool('job_gui', { job_id: id, action: 'mouse', node, value: { kind: 'down', x: 320, y: 240, button: 0 }, wait_ms: 200 });
        await tool('job_gui', { job_id: id, action: 'mouse', node, value: { kind: 'move', x: 340, y: 240, button: 0 }, wait_ms: 300 });
        hudRow('sdl2_gl_triangle', '滑鼠按下拖曳後', '拖曳狀態', 8, 8, 'DRAGGING', ['IDLE'], findAnyCanvas(640, 480));
        await tool('job_gui', { job_id: id, action: 'mouse', node, value: { kind: 'up', x: 340, y: 240, button: 0 }, wait_ms: 300 });
        hudRow('sdl2_gl_triangle', '滑鼠放開後', '拖曳狀態', 8, 8, 'IDLE', ['DRAGGING'], findAnyCanvas(640, 480));
    }
    await stopJob(id);
}
R.output.hud_checklist = { total: R.rows.filter((r) => r.pass !== null && r.pass !== undefined).length, passed: R.rows.filter((r) => r.pass === true).length };
console.log('LLC_HUD ' + JSON.stringify(R));
return R;
