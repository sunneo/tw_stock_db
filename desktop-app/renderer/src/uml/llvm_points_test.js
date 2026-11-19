// node renderer/src/uml/llvm_points_test.js — 宿主函式 fa_cl_points（DESIGN.webgpu-cuda.md §13 階段 9）。
// 直接呼叫宿主的實作（不跑 .ll）：假的 OpenCL 記憶體（一塊 ArrayBuffer）、假的 WebGPU 裝置（drawPoints 只記錄參數）、假的 GUI。
// 驗證：WebGPU 時回傳 1、drawPoints 的參數（點數、中心、縮放、顏色、寬高、變換矩陣）、本幀 flush 時 GUI 收到 extern 記號（在 use 之後）；
// 非 WebGPU、沒有 GL 視窗、畫圖丟例外時回傳 0（呼叫端會退回讀回）。真 GPU 的結果由 scripts/eval/llc_kir_e2e 驗證，這裡不宣稱。
const H = require('./llvm_host.js');
let ok = 0; const bad = [];
const check = (name, c, info) => { if (c) ok++; else bad.push(name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 240) : '')); };
(async () => {

const mem = new ArrayBuffer(1 << 16);
const ctx = { dv: () => new DataView(mem), u8: () => new Uint8Array(mem), mem: () => ({ buffer: mem }) };
const PAL = 1024, CTR = 2048;
function writePal() {
    const dv = new DataView(mem);
    for (let i = 0; i < 10; i++) { dv.setFloat32(PAL + 12 * i, i / 10, true); dv.setFloat32(PAL + 12 * i + 4, 0.5, true); dv.setFloat32(PAL + 12 * i + 8, 1, true); }
    dv.setFloat32(PAL + 120, 0.1, true);
    dv.setFloat32(CTR, 10, true); dv.setFloat32(CTR + 4, 20, true); dv.setFloat32(CTR + 8, 30, true);
}

function mkHost(kind, drawFn) {
    const calls = { draw: [], setExt: [], gui: [], warn: [], up: 0 };
    const dev = {
        alloc: (N, elem) => ({ N, elem, v: new Float32Array(N) }),
        upload: (b, arr) => { calls.up++; b.v.set(arr.subarray(0, b.v.length)); },
        download: (b) => b.v.slice(), dispatch: () => {}, free: () => {},
        drawPoints: drawFn || ((pos, n, q) => { calls.draw.push({ pos, n, q }); return { canvasId: calls.draw.length }; })
    };
    const host = H.create({
        gui: async (op, args) => { calls.gui.push([op, args]); return null; },
        kirDev: dev, kirBackend: kind,
        setExtern: (w, n, name, src) => calls.setExt.push([w, n, name, src]),
        warn: (t) => calls.warn.push(String(t))
    });
    return { host, calls, dev };
}

// 建好：cl 上下文、三個位置緩衝區（12 位元組＝3 個 float）、一個 GL 視窗（會把 gl.win 設上）
function setup(host) {
    const I = host.impls;
    const c = I.clCreateContext(ctx, 0, 1, 0, 0, 0, 0);
    const bx = I.clCreateBuffer(ctx, c, 1, 12, 0, 0), by = I.clCreateBuffer(ctx, c, 1, 12, 0, 0), bz = I.clCreateBuffer(ctx, c, 1, 12, 0, 0);
    const win = I.SDL_CreateWindow(ctx, 0, 0, 0, 800, 560, 2);
    I.SDL_GL_CreateContext(ctx, win);
    writePal();
    return { bx, by, bz, win };
}

// 1. WebGPU：回傳 1，drawPoints 收到正確的參數；flush 時 GUI 收到 extern 記號，且在 use 之後
{
    const { host, calls } = mkHost('webgpu');
    const s = setup(host);
    const r = host.impls.fa_cl_points(ctx, s.bx, s.by, s.bz, 3, PAL, CTR);
    check('WebGPU 時回傳 1', r === 1, r);
    const d = calls.draw[0];
    check('drawPoints 只叫一次，點數 3', calls.draw.length === 1 && d.n === 3, calls.draw.length);
    check('位置是三個裝置緩衝區', d.pos && d.pos.x && d.pos.y && d.pos.z && d.pos.x.N === 3, d && d.pos);
    check('中心（offset）來自 ctr 指標', d.q.offset[0] === 10 && d.q.offset[1] === 20 && d.q.offset[2] === 30, d.q.offset);
    check('縮放來自 pal[30]（0.1）', Math.abs(d.q.scale - 0.1) < 1e-6, d.q.scale);
    check('顏色 10 組，第 1 組 [0.1, 0.5, 1]', d.q.colors.length === 10 && Math.abs(d.q.colors[1][0] - 0.1) < 1e-6 && d.q.colors[1][1] === 0.5 && d.q.colors[1][2] === 1, d.q.colors[1]);
    check('寬高來自 GL 視窗（800×560）', d.q.width === 800 && d.q.height === 560, [d.q.width, d.q.height]);
    check('變換矩陣 16 個數（單位矩陣的 P×MV）', d.q.mvp.length === 16 && d.q.mvp[0] === 1 && d.q.mvp[5] === 1 && d.q.mvp[15] === 1, d.q.mvp);
    check('gain 與 GL 路徑相同（gl.alpha＝1）', d.q.gain === 1, d.q.gain);
    check('點大小 sizePx＝glPointSize 的預設 1', d.q.sizePx === 1, d.q.sizePx);
    // flush：SDL_GL_SwapWindow → ensureWindow → flushGl → setExtern + glframe 的 cmds
    await host.impls.SDL_GL_SwapWindow(ctx, s.win);
    const se = calls.setExt[0];
    check('flush 時 setExtern 收到 clpts 與那張畫布', calls.setExt.length === 1 && !!se && se[2] === 'clpts' && !!se[3] && se[3].canvasId === 1, se);
    const glf = calls.gui.find((g) => g[0] === 'glframe');
    const cmds = glf ? glf[1].cmds : [];
    const ei = cmds.findIndex((c) => c[0] === 'extern' && c[1] === 'clpts'), ui = cmds.findIndex((c) => c[0] === 'use');
    check('glframe 的 cmds 有 ["extern","clpts"]，在 use 之後', ei > 0 && ui >= 0 && ei > ui, cmds.map((c) => c[0]));
}

// 2. 非 WebGPU（WebGL2）：回傳 0，不叫 drawPoints（沒有 drawPoints 的裝置也一樣）
{
    const { host, calls } = mkHost('webgl2');
    const s = setup(host);
    check('WebGL2 時回傳 0', host.impls.fa_cl_points(ctx, s.bx, s.by, s.bz, 3, PAL, CTR) === 0);
    check('WebGL2 時不叫 drawPoints', calls.draw.length === 0);
}
// 3. 沒有 GL 視窗：回傳 0
{
    const { host, calls } = mkHost('webgpu');
    const I = host.impls;
    const c = I.clCreateContext(ctx, 0, 1, 0, 0, 0, 0);
    const bx = I.clCreateBuffer(ctx, c, 1, 12, 0, 0), by = I.clCreateBuffer(ctx, c, 1, 12, 0, 0), bz = I.clCreateBuffer(ctx, c, 1, 12, 0, 0);
    writePal();
    check('沒有 GL 視窗時回傳 0，不畫', I.fa_cl_points(ctx, bx, by, bz, 3, PAL, CTR) === 0 && calls.draw.length === 0);
}
// 4. 畫圖丟例外：回傳 0，記一筆警告（呼叫端退回讀回）
{
    const { host, calls } = mkHost('webgpu', () => { throw new Error('假的失敗'); });
    const s = setup(host);
    const r = host.impls.fa_cl_points(ctx, s.bx, s.by, s.bz, 3, PAL, CTR);
    check('畫圖失敗時回傳 0', r === 0, r);
    check('畫圖失敗時有警告（含原因）', calls.warn.some((w) => w.indexOf('假的失敗') >= 0), calls.warn);
}
// 5. 點數不對（0）：回傳 0，不叫 drawPoints
{
    const { host, calls } = mkHost('webgpu');
    const s = setup(host);
    check('點數 0 時回傳 0', host.impls.fa_cl_points(ctx, s.bx, s.by, s.bz, 0, PAL, CTR) === 0 && calls.draw.length === 0);
}

})().then(() => {
    console.log('llvm_points: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED: ' + bad.join(' | ') : ''));
    if (bad.length) process.exitCode = 1;
});
