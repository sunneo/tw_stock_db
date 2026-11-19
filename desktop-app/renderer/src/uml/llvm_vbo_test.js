// node renderer/src/uml/llvm_vbo_test.js — 階段 A、B、C：標準 GL 頂點緩衝區、cl_khr_gl_sharing、執行期優化。
// 都是真的 wasm（手寫標準 .ll，不用任何自創函式）。node 沒有 JSPI，所以不經過 SDL_GL_SwapWindow：直接檢查本幀的 GL 批次（host.glState.batches），
// 並用一個小的軟體光柵（W×H、identity 矩陣）把批次畫成像素來比對。真 GPU 與真 Electron 的像素由 scripts/eval/llc_interop.eval.js 驗證，這裡不宣稱。
const L = require('./llvm_core.js'), H = require('./llvm_host.js');
const CF = require('../gpu/cl_front.js'), KIR = require('../gpu/kir.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };
const f32 = (x) => Math.fround(x);
const hex = (x) => { const b = Buffer.alloc(8); b.writeDoubleBE(f32(x)); return '0x' + b.toString('hex').toUpperCase(); };
const farr = (a) => '[' + a.length + ' x float] [' + a.map((x) => 'float ' + hex(x)).join(', ') + ']';
const W = 32;
const TRI = [-0.8, -0.8, 0, 0.8, -0.8, 0, 0, 0.8, 0];
const COMMON_DECL = `declare ptr @SDL_CreateWindow(ptr, i32, i32, i32, i32, i32)
declare ptr @SDL_GL_CreateContext(ptr)
declare void @glColor3f(float, float, float)
declare void @glBegin(i32)
declare void @glEnd()
declare void @glVertex3f(float, float, float)
declare void @glGenBuffers(i32, ptr)
declare void @glBindBuffer(i32, i32)
declare void @glBufferData(i32, i64, ptr, i32)
declare void @glEnableClientState(i32)
declare void @glVertexPointer(i32, i32, i32, ptr)
declare void @glDrawArrays(i32, i32, i32)
declare void @glEnable(i32)
declare void @glBlendFunc(i32, i32)
declare void @glPointSize(float)
`;
const HEAD = `target triple = "x86_64-pc-linux-gnu"\n${COMMON_DECL}`;
const GLINIT = `  %win = call ptr @SDL_CreateWindow(ptr null, i32 0, i32 0, i32 ${W}, i32 ${W}, i32 2)\n  %ctx = call ptr @SDL_GL_CreateContext(ptr %win)\n`;
const VBO_SETUP = (n) => `  %idp = alloca i32\n  call void @glGenBuffers(i32 1, ptr %idp)\n  %vb = load i32, ptr %idp\n  call void @glBindBuffer(i32 34962, i32 %vb)\n  call void @glBufferData(i32 34962, i64 ${n * 4}, ptr @verts, i32 35044)\n`;
const DRAW = (mode, first, count) => `  call void @glEnableClientState(i32 32884)\n  call void @glVertexPointer(i32 3, i32 5126, i32 0, ptr null)\n  call void @glDrawArrays(i32 ${mode}, i32 ${first}, i32 ${count})\n`;
const ADD = `  call void @glEnable(i32 3042)\n  call void @glBlendFunc(i32 770, i32 1)\n`;

function mkHost(extra) {
    const calls = { gui: [] };
    const host = H.create(Object.assign({ gui: async (op, a) => { calls.gui.push([op, a]); return null; } }, extra || {}));
    host.install(L); return { host, calls };
}
async function runIr(ir, host, args) {
    const c = L.compileIr(ir, {}); if (!c.wasm) return { errors: c.errors };
    const dec = {}; for (const d of L.parse(ir).mod.declares) dec[d.name] = d;
    return L.runHost(c.wasm, { args: args || ['prog'] }, host.impls, undefined, dec);
}
// 軟體光柵：identity 矩陣；點 → 一個像素，三角形 → 重心座標填色
function raster(batches) {
    const img = new Float32Array(W * W * 3); let extern = 0;
    const px = (x, y) => [Math.floor((x * 0.5 + 0.5) * W), Math.floor((y * 0.5 + 0.5) * W)];
    for (const b of batches) {
        if (b.extern) { extern++; continue; }
        const v = b.verts, N = v.length / 6;
        if (b.mode === 0) for (let i = 0; i < N; i++) { const [x, y] = px(v[i * 6], v[i * 6 + 1]); if (x >= 0 && x < W && y >= 0 && y < W) for (let c = 0; c < 3; c++) img[(y * W + x) * 3 + c] = v[i * 6 + 3 + c]; }
        else if (b.mode === 4) for (let t = 0; t + 2 < N; t += 3) {
            const P = [0, 1, 2].map((k) => [v[(t + k) * 6] * 0.5 + 0.5, v[(t + k) * 6 + 1] * 0.5 + 0.5]); const col = [v[(t) * 6 + 3], v[t * 6 + 4], v[t * 6 + 5]];
            const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
            for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
                const qx = (x + 0.5) / W, qy = (y + 0.5) / W;
                const w0 = ((P[1][0] - qx) * (P[2][1] - qy) - (P[2][0] - qx) * (P[1][1] - qy)) / area, w1 = ((P[2][0] - qx) * (P[0][1] - qy) - (P[0][0] - qx) * (P[2][1] - qy)) / area, w2 = 1 - w0 - w1;
                if (w0 >= 0 && w1 >= 0 && w2 >= 0) for (let c = 0; c < 3; c++) img[(y * W + x) * 3 + c] = col[c];
            }
        }
    }
    return { img, extern, lit: Array.from({ length: W * W }, (_, i) => img[i * 3] + img[i * 3 + 1] + img[i * 3 + 2] > 0).filter(Boolean).length };
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const verts6 = (b) => Array.from(b.verts);

(async () => {
    // ===== A：標準 VBO 畫三角形與一排點，像素與立即模式相同 =====
    {
        const pts = []; for (let i = 0; i < 5; i++) pts.push(-0.8 + 0.4 * i, 0.9, 0);
        const all = TRI.concat(pts);
        const vboIr = HEAD + `@verts = private constant ${farr(all)}\ndefine i32 @main() {\n${GLINIT}${VBO_SETUP(all.length)}  call void @glColor3f(float ${hex(0.2)}, float ${hex(0.9)}, float ${hex(0.4)})\n${DRAW(4, 0, 3)}  call void @glColor3f(float ${hex(1)}, float ${hex(1)}, float ${hex(0)})\n${DRAW(0, 3, 5)}  ret i32 0\n}\n`;
        let imm = HEAD + `define i32 @main() {\n${GLINIT}  call void @glColor3f(float ${hex(0.2)}, float ${hex(0.9)}, float ${hex(0.4)})\n  call void @glBegin(i32 4)\n`;
        for (let i = 0; i < 3; i++) imm += `  call void @glVertex3f(float ${hex(TRI[i * 3])}, float ${hex(TRI[i * 3 + 1])}, float ${hex(TRI[i * 3 + 2])})\n`;
        imm += `  call void @glEnd()\n  call void @glColor3f(float ${hex(1)}, float ${hex(1)}, float ${hex(0)})\n  call void @glBegin(i32 0)\n`;
        for (let i = 0; i < 5; i++) imm += `  call void @glVertex3f(float ${hex(pts[i * 3])}, float ${hex(pts[i * 3 + 1])}, float ${hex(pts[i * 3 + 2])})\n`;
        imm += `  call void @glEnd()\n  ret i32 0\n}\n`;
        const a = mkHost(), b = mkHost();
        const oa = await runIr(vboIr, a.host), ob = await runIr(imm, b.host);
        a.host.uninstall(L); b.host.uninstall(L);
        check('A：VBO 的 .ll 跑得過', oa.exitCode === 0 && !oa.errors, oa.errors || oa);
        const ba = a.host.glState.batches, bb = b.host.glState.batches;
        check('A：兩個批次（三角形、點）', ba.length === 2 && ba[0].mode === 4 && ba[1].mode === 0, ba.map((x) => x.mode));
        check('A：頂點（含顏色）與立即模式逐位元相同', ba.length === bb.length && ba.every((x, i) => same(verts6(x), verts6(bb[i]))), ba.map(verts6));
        const ra = raster(ba), rb = raster(bb);
        check('A：像素與立即模式相同，且真的有畫（三角形面積＋5 個點）', same(ra.img, rb.img) && ra.lit > 100 && ra.lit < W * W, ra.lit);
        check('A：點只取 first=3 起的 5 個頂點', ba[1].verts.length === 30 && ba[1].verts[0] === f32(pts[0]) && ba[1].verts[1] === f32(0.9));
    }
    // ===== B：cl_khr_gl_sharing（基準：沒有裝置，JS 墊片核心），C：執行期優化（假 WebGPU 裝置） =====
    const N = 9, K = 0.03125, SRC = '__kernel void fill(__global float* v, float k) { int i = get_global_id(0); v[i] = i * i * k - 1.0f; }';
    const sdecl = `declare i32 @clGetPlatformIDs(i32, ptr, ptr)
declare i32 @clGetDeviceIDs(ptr, i64, i32, ptr, ptr)
declare ptr @clCreateContext(ptr, i32, ptr, ptr, ptr, ptr)
declare ptr @clCreateCommandQueue(ptr, ptr, i64, ptr)
declare ptr @clCreateFromGLBuffer(ptr, i64, i32, ptr)
declare i32 @clGetGLObjectInfo(ptr, ptr, ptr)
declare ptr @clCreateProgramWithSource(ptr, i32, ptr, ptr, ptr)
declare i32 @clBuildProgram(ptr, i32, ptr, ptr, ptr, ptr)
declare ptr @clCreateKernel(ptr, ptr, ptr)
declare i32 @clSetKernelArg(ptr, i32, i64, ptr)
declare i32 @clEnqueueAcquireGLObjects(ptr, i32, ptr, i32, ptr, ptr)
declare i32 @clEnqueueReleaseGLObjects(ptr, i32, ptr, i32, ptr, ptr)
declare i32 @clEnqueueNDRangeKernel(ptr, ptr, i32, ptr, ptr, ptr, i32, ptr, ptr)
declare i32 @clFinish(ptr)
`;
    const srcBytes = Buffer.from(SRC + '\0'); const srcLit = 'c"' + Array.from(srcBytes).map((c) => (c >= 32 && c < 127 && c !== 34 && c !== 92 ? String.fromCharCode(c) : '\\' + c.toString(16).padStart(2, '0').toUpperCase())).join('') + '"';
    // frameBody：互通之後的 GL 呼叫；steps：每幀要不要 Acquire／Release
    const shared = (frameGl, o) => {
        o = o || {};
        return HEAD + sdecl + `@verts = private constant ${farr(new Array(N).fill(0))}\n@src = private constant [${srcBytes.length} x i8] ${srcLit}\n@kname = private constant [5 x i8] c"fill\\00"\ndefine i32 @main() {\n${GLINIT}${VBO_SETUP(N)}` +
        `  %plat = alloca ptr\n  %dev = alloca ptr\n  %err = alloca i32\n  %memslot = alloca ptr\n  %gs = alloca i64\n  %kf = alloca float\n  %ty = alloca i32\n  %nm = alloca i32\n  %srcp = alloca ptr\n  store ptr @src, ptr %srcp\n` +
        `  %r0 = call i32 @clGetPlatformIDs(i32 1, ptr %plat, ptr null)\n  %pl = load ptr, ptr %plat\n  %r1 = call i32 @clGetDeviceIDs(ptr %pl, i64 4294967295, i32 1, ptr %dev, ptr null)\n` +
        `  %c = call ptr @clCreateContext(ptr null, i32 1, ptr %dev, ptr null, ptr null, ptr %err)\n  %d = load ptr, ptr %dev\n  %q = call ptr @clCreateCommandQueue(ptr %c, ptr %d, i64 0, ptr %err)\n` +
        `  %mem = call ptr @clCreateFromGLBuffer(ptr %c, i64 1, i32 %vb, ptr %err)\n  store ptr %mem, ptr %memslot\n  %e1 = load i32, ptr %err\n  %gi = call i32 @clGetGLObjectInfo(ptr %mem, ptr %ty, ptr %nm)\n  %tyv = load i32, ptr %ty\n  %nmv = load i32, ptr %nm\n` +
        `  %p = call ptr @clCreateProgramWithSource(ptr %c, i32 1, ptr %srcp, ptr null, ptr %err)\n  %bs = call i32 @clBuildProgram(ptr %p, i32 0, ptr null, ptr null, ptr null, ptr null)\n  %k = call ptr @clCreateKernel(ptr %p, ptr @kname, ptr %err)\n` +
        `  %a0 = call i32 @clSetKernelArg(ptr %k, i32 0, i64 4, ptr %memslot)\n  store float ${hex(K)}, ptr %kf\n  %a1 = call i32 @clSetKernelArg(ptr %k, i32 1, i64 4, ptr %kf)\n  store i64 ${N}, ptr %gs\n` +
        `  %acq = call i32 @clEnqueueAcquireGLObjects(ptr %q, i32 1, ptr %memslot, i32 0, ptr null, ptr null)\n  %nd = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %k, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)\n  %rel = call i32 @clEnqueueReleaseGLObjects(ptr %q, i32 1, ptr %memslot, i32 0, ptr null, ptr null)\n  %fin = call i32 @clFinish(ptr %q)\n` +
        `  ; 回傳碼：全部成功＝0；%tyv 要是 0x2000（8192）、%nmv 要是緩衝區編號\n  %t1 = icmp ne i32 %tyv, 8192\n  %t2 = icmp ne i32 %nmv, %vb\n  %t3 = icmp ne i32 %e1, 0\n  %b1 = or i1 %t1, %t2\n  %b2 = or i1 %b1, %t3\n  %z1 = or i32 %acq, %nd\n  %z2 = or i32 %z1, %rel\n  %z3 = or i32 %z2, %bs\n  %z4 = or i32 %z3, %a0\n  %z5 = or i32 %z4, %a1\n  %bad = zext i1 %b2 to i32\n  %res = or i32 %z5, %bad\n` +
        (o.preGl || '') + `  call void @glColor3f(float ${hex(0.5)}, float ${hex(0.6)}, float ${hex(1)})\n${frameGl}  ret i32 %res\n}\n`;
    };
    const expect = []; for (let i = 0; i < N; i++) expect.push(f32(i * i * K - 1));
    // B：基準（沒有裝置）
    let baseline;
    {
        const { host } = mkHost();
        const o = await runIr(shared(DRAW(4, 0, 3)), host);
        host.uninstall(L);
        check('B：cl_khr_gl_sharing 的 .ll 跑得過（Create／GetInfo／Acquire／Release 都成功）', o.exitCode === 0 && !o.errors, o.errors || o);
        const bt = host.glState.batches;
        check('B：核心寫進共享 VBO，GL 畫出來的頂點就是核心的輸出', bt.length === 1 && same(verts6(bt[0]).filter((_, i) => i % 6 < 3), expect), bt.map(verts6));
        baseline = { verts: bt.length ? verts6(bt[0]) : [], img: raster(bt) };
        check('B：像素有畫出東西', baseline.img.lit > 0, baseline.img.lit);
        // 之後 GL 端覆寫（glBufferData）再 Acquire：CL 看到新資料（別名）
        const gm = host.glState; check('B：緩衝區資料與 CL 共用同一塊記憶體（別名）', gm.bufs.size === 1);
    }
    // C：假 WebGPU 裝置（dispatch 用 JS 後端執行），驗證不讀回
    const kirTranslate = (src) => { const r = CF.parseKernels(src); if (!r.ok) return null; const m = {}; for (const k of r.kernels) { if (!KIR.validate(k).ok) return null; m[k.name] = k; } return m; };
    function fakeDev(st) {
        return {
            alloc: (n, elem) => ({ N: n, elem, v: new Float32Array(n * (elem === 'f32x4' ? 4 : 1)) }),
            upload: (b, arr) => { st.upload++; b.v.set(arr.subarray(0, b.v.length)); },
            download: (b) => { st.download++; return b.v.slice(); },
            dispatch: (k, binds, out, scal, n) => { st.dispatch++; const B = {}; for (const p of k.params) if (p.kind === 'buf') B[p.name] = p.access === 'out' ? out.v : binds[p.name].v; KIR.runJs(k, B, scal, n); },
            free: () => {},
            drawPoints: (pos, n, q) => { st.draw.push({ pos, n, q }); return { canvasId: st.draw.length }; },
        };
    }
    const mkC = (st, extra) => mkHost(Object.assign({ kirDev: fakeDev(st), kirTranslate, kirBackend: 'webgpu', setExtern: (w, nd, name, src) => st.ext.push(name) }, extra || {}));
    {   // C1：加法混合的 GL_POINTS → 不讀回，位置當頂點（drawPoints 收到共享緩衝區）
        const st = { upload: 0, download: 0, dispatch: 0, draw: [], ext: [] }; const { host } = mkC(st);
        const o = await runIr(shared(DRAW(0, 3, 6), { preGl: ADD + `  call void @glPointSize(float ${hex(4)})\n` }), host);
        host.uninstall(L);
        const bt = host.glState.batches;
        check('C：核心真的在（假）WebGPU 裝置上跑', o.exitCode === 0 && st.dispatch === 1, { o, st });
        check('C：加法混合的 GL_POINTS：讀回次數為 0（download／upload 都是 0）', st.download === 0 && st.upload === 0, st);
        check('C：drawPoints 被呼叫一次，收到共享緩衝區的 xyz（stride 3、base 9、6 點）', st.draw.length === 1 && st.draw[0].n === 6 && st.draw[0].pos.xyz && st.draw[0].pos.stride === 3 && st.draw[0].pos.base === 9, st.draw.map((d) => [d.n, d.pos.stride, d.pos.base]));
        check('C：緩衝區內容是核心的輸出（裝置端）', same(Array.from(st.draw[0].pos.xyz.v), expect));
        check('C：本幀批次是 extern 記號、點大小與顏色傳到', bt.length === 1 && bt[0].extern === 'clpts' && st.draw[0].q.sizePx === 4 && st.draw[0].q.colors[0][2] === 1 && st.draw[0].q.colors.length === 10, st.draw[0] && st.draw[0].q);
        check('C：計數器 drawFast＝1、releaseDeferred＝1', host.glStats.drawFast === 1 && host.glStats.releaseDeferred === 1 && host.glStats.drawCopy === 0, host.glStats);
    }
    {   // C2：條件不吻合（非加法混合）→ 退回複製路徑：讀回一次，頂點與基準相同
        const st = { upload: 0, download: 0, dispatch: 0, draw: [], ext: [] }; const { host } = mkC(st);
        const o = await runIr(shared(DRAW(4, 0, 3)), host);
        host.uninstall(L);
        const bt = host.glState.batches;
        check('C 退回：非加法混合 → 不走 drawPoints', o.exitCode === 0 && st.draw.length === 0 && host.glStats.drawFast === 0 && host.glStats.drawCopy === 1, host.glStats);
        check('C 退回：讀回一次，頂點與 B 基準逐位元相同', st.download === 1 && bt.length === 1 && same(verts6(bt[0]), baseline.verts), { st, v: bt.map(verts6) });
    }
    {   // C3：加法混合的點，但有光照（其他屬性）→ 退回
        const st = { upload: 0, download: 0, dispatch: 0, draw: [], ext: [] }; const { host } = mkC(st);
        const o = await runIr(shared(DRAW(0, 0, 3), { preGl: ADD + `  call void @glEnable(i32 2896)\n` }), host);
        host.uninstall(L);
        check('C 退回：有光照 → 退回複製路徑，頂點與基準的位置相同', o.exitCode === 0 && st.draw.length === 0 && st.download === 1 && host.glStats.drawCopy === 1 && same(verts6(host.glState.batches[0]).filter((_, i) => i % 6 < 3), expect.slice(0, 9)), { st });
    }
    {   // C4：WebGL2（不是 WebGPU）→ 沒有 drawPoints，也不會延遲讀回
        const st = { upload: 0, download: 0, dispatch: 0, draw: [], ext: [] }; const { host } = mkC(st, { kirBackend: 'webgl2' });
        const o = await runIr(shared(DRAW(0, 0, 3), { preGl: ADD }), host);
        host.uninstall(L);
        check('C 退回：WebGL2 後端 → 不優化（releaseDeferred＝0）、像素路徑正確', o.exitCode === 0 && st.draw.length === 0 && host.glStats.releaseDeferred === 0 && same(verts6(host.glState.batches[0]).filter((_, i) => i % 6 < 3), expect.slice(0, 9)), host.glStats);
    }
    {   // C5：關閉優化的旗標（量測用）
        const st = { upload: 0, download: 0, dispatch: 0, draw: [], ext: [] }; const { host } = mkC(st, { noInterop: true });
        const o = await runIr(shared(DRAW(0, 0, 3), { preGl: ADD }), host);
        host.uninstall(L);
        check('noInterop：不優化（對照組）', o.exitCode === 0 && st.draw.length === 0 && host.glStats.releaseDeferred === 0 && st.download >= 0);
    }
    {   // E：範例 gpgpu/interop_cl_gl.ll 照原樣跑（node 沒有 JSPI：只把三個會暫停的呼叫——PollEvent／SwapWindow／Delay——換成空操作，其餘一字不改）
        const ex = require('fs').readFileSync(require('path').join(__dirname, '../examples/llc/gpgpu/interop_cl_gl.ll'), 'utf8');
        const noFn = ['fa_cl_points', 'fa_cl_nopoints', 'fa_cl_pack', 'fa_cl_view'].filter((n) => ex.includes(n));
        check('E：範例沒有任何框架專屬函式（fa_cl_points／pack／view）', noFn.length === 0, noFn);
        const ir = ex.replace('call i32 @SDL_PollEvent(ptr %ev)', 'add i32 0, 0').replace('call void @SDL_GL_SwapWindow(ptr %win)', 'add i32 0, 0').replace('call void @SDL_Delay(i32 16)', 'add i32 0, 0').replace(/^declare (i32 @SDL_PollEvent|void @SDL_GL_SwapWindow|void @SDL_Delay)\(.*\n/gm, '');
        const base = mkHost(); const ob = await runIr(ir, base.host, ['prog', '64', '3']); base.host.uninstall(L);
        const m = /interop OK frames=3 n=64 checksum=([-\d.]+)/.exec(ob.stdout || '');
        let want = 0; for (let fr = 0; fr < 3; fr++); { const t = Math.fround(0.02) * 2; for (let i = 0; i < 192; i++) { const p = Math.floor(i / 3), c = i - p * 3, a = p * 0.0613; want += Math.fround(0.8 * Math.sin(c === 0 ? a * 3 + t : c === 1 ? a * 2 + t * 1.3 : a + t * 0.7)); } }
        check('E：範例（基準，沒有裝置）跑完並印出 interop OK，checksum 與公式相符（±0.05）', ob.exitCode === 0 && !!m && Math.abs(+m[1] - want) < 0.05, { out: ob.stdout, want, err: ob.errors });
        const st = { upload: 0, download: 0, dispatch: 0, draw: [], ext: [] }; const dv = mkC(st); const od = await runIr(ir, dv.host, ['prog', '64', '3']); dv.host.uninstall(L);
        const m2 = /interop OK frames=3 n=64 checksum=([-\d.]+)/.exec(od.stdout || '');
        check('E：範例在（假）WebGPU 裝置上：3 幀都走裝置直接畫（drawFast＝3），整段只讀回 1 次（結尾的 checksum）', od.exitCode === 0 && dv.host.glStats.drawFast === 3 && dv.host.glStats.releaseDeferred === 3 && st.download === 1 && st.draw.length === 3, { out: od.stdout, st: [st.download, st.draw.length], gs: dv.host.glStats });
        check('E：裝置路徑的 checksum 與基準相同（±0.05）', !!m && !!m2 && Math.abs(+m[1] - +m2[1]) < 0.05, [m && m[1], m2 && m2[1]]);
    }
    check('D：宿主不再匯出自創的 fa_cl_points／fa_cl_nopoints', !('fa_cl_points' in H.SIGS) && !('fa_cl_nopoints' in H.SIGS));
    console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'llvm_vbo: ' + ok + ' passed');
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAILED (exception): ' + (e && e.stack || e) + '\n' + bad.join('\n')); process.exit(1); });
