// node renderer/src/gpu/kir_points_test.js — KIR 點精靈（kir_webgpu.drawPoints，DESIGN.webgpu-cuda.md §13 階段 9）的主機端流程。
// 假裝置：不編譯 WGSL（真 GPU 的結果由 scripts/eval/kir_interop.eval.js 與 llc_kir_e2e 驗證，這裡不宣稱）。
// 驗證：參數檢查、uniform 佈局（272 位元組，與 llvm_host 的 GL 路徑對照的欄位）、一次 draw(4, count)、
// 管線的加法混合與三角帶、綁定的緩衝區是位置 buffer 本身（不是複本）、同大小的畫布只建一次、不讀回（沒有 mapAsync）。
const D = require('./kir_webgpu.js');
let ok = 0; const bad = [];
const check = (name, c, info) => { if (c) ok++; else bad.push(name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 240) : '')); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e.message); } };

function fakeDevice() {
    const dev = { log: [], pipes: [], binds: [], draws: [], mapped: 0 };
    dev.createBuffer = ({ size, usage }) => {
        if (!(size > 0) || size % 4) throw new Error('createBuffer：大小 ' + size + ' 不合法');
        return { size, usage, u8: new Uint8Array(size), destroy() {}, mapAsync() { dev.mapped++; return Promise.resolve(); } };
    };
    dev.createBindGroupLayout = ({ entries }) => ({ entries });
    dev.createPipelineLayout = () => ({});
    dev.createShaderModule = ({ code, label }) => {
        if (!/@vertex\s*\n?fn vs/.test(code) || !/@fragment\s*\n?fn fs/.test(code)) throw new Error('WGSL 沒有 vs／fs 入口');
        return { code, label };
    };
    dev.createComputePipeline = ({ compute }) => ({ module: compute.module });
    dev.createRenderPipeline = (desc) => { dev.pipes.push(desc); return { desc }; };
    dev.createBindGroup = ({ layout, entries }) => { dev.binds.push(entries); return { entries }; };
    dev.createCommandEncoder = () => {
        const ops = [];
        return {
            beginRenderPass(desc) {
                const pass = { desc, pipe: null, bg: null, draw: null };
                ops.push(() => dev.draws.push(pass));
                return { setPipeline(p) { pass.pipe = p; }, setBindGroup(i, bg) { pass.bg = bg; }, draw(v, n) { pass.draw = [v, n]; }, end() {} };
            },
            beginComputePass() { return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }; },
            finish() { return { ops }; }
        };
    };
    dev.queue = {
        writeBuffer(buf, off, data) {
            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            if (off + bytes.length > buf.size) throw new Error('writeBuffer 超出範圍');
            buf.u8.set(bytes, off); dev.log.push('write');
        },
        submit(cmds) { dev.log.push('submit'); for (const c of cmds) for (const op of c.ops) op(); },
        onSubmittedWorkDone: async () => {}
    };
    dev.pushErrorScope = () => {};
    dev.popErrorScope = async () => null;
    dev.addEventListener = () => {};
    return dev;
}
// 假畫布：getContext('webgpu') 給一個記錄 configure 的 context；getCurrentTexture 回傳假的 view
function fakeCanvas(w, h) {
    const cv = { width: w, height: h, ctx: null };
    cv.getContext = (t) => {
        if (t !== 'webgpu') return null;
        cv.ctx = { configured: null, configure(c) { cv.ctx.configured = c; }, getCurrentTexture() { return { createView: () => ({ view: true }) }; } };
        return cv.ctx;
    };
    return cv;
}

const dev = fakeDevice();
const G = D.createDevice(dev, {});
const pos = { x: G.alloc(100, 'f32'), y: G.alloc(100, 'f32'), z: G.alloc(100, 'f32') };
const mvp = Array.from({ length: 16 }, (_, i) => i + 1);
const colors = Array.from({ length: 10 }, (_, i) => [i / 10, 0.5, 1]);
let made = 0;
const mk = (w, h) => { made++; return fakeCanvas(w, h); };
const base = { mvp, offset: [1, 2, 3], scale: 0.1, sizePx: 15, ref: 50, gain: 0.5, colors, width: 800, height: 560, makeCanvas: mk };

// 1. 成功路徑：回傳畫布、configure 用 opaque 與同一個 device
const cv1 = G.drawPoints(pos, 100, base);
check('回傳的是 makeCanvas 建的畫布（800×560）', !!cv1 && cv1.width === 800 && cv1.height === 560, cv1 && [cv1.width, cv1.height]);
check('configure：同一個 device、alphaMode opaque', cv1.ctx.configured && cv1.ctx.configured.device === dev && cv1.ctx.configured.alphaMode === 'opaque', cv1.ctx.configured);
check('configure：預設格式 bgra8unorm', cv1.ctx.configured.format === 'bgra8unorm', cv1.ctx.configured);

// 2. 管線：三角帶、加法混合（src-alpha／one）、無頂點緩衝區
const pd = dev.pipes[0];
check('管線：三角帶', pd && pd.primitive.topology === 'triangle-strip', pd && pd.primitive);
check('管線：加法混合（顏色 src-alpha／one）', pd && pd.fragment.targets[0].blend.color.srcFactor === 'src-alpha' && pd.fragment.targets[0].blend.color.dstFactor === 'one', pd && pd.fragment.targets[0].blend);
check('管線：沒有頂點緩衝區（位置由 storage 讀）', pd && pd.vertex.buffers === undefined, pd && pd.vertex);

// 3. 一次 draw(4, count)；綁定的是位置 buffer 本身（不是複本）、第 4 個綁定是 uniform 272 位元組
const pass = dev.draws[0];
check('一次 draw(4, 100)', pass && pass.draw && pass.draw[0] === 4 && pass.draw[1] === 100, pass && pass.draw);
const entries = dev.binds[0];
check('綁定 0／1／2 是 x、y、z 的 GPU buffer', entries[0].resource.buffer === pos.x.gbuf && entries[1].resource.buffer === pos.y.gbuf && entries[2].resource.buffer === pos.z.gbuf, entries.map((e) => e.resource.buffer && e.resource.buffer.size));
check('綁定 3 是 uniform，大小 272', entries[3].resource.size === 272, entries[3]);

// 4. uniform 內容：mvp、offset、scale、size、ref、gain、寬高、顏色（欄位位置與 WGSL 的 Pm 一致）
const ubuf = entries[3].resource.buffer;
const f = new Float32Array(ubuf.u8.buffer, ubuf.u8.byteOffset, 68);
check('mvp 在 0..15（行主序照傳入的順序）', f[0] === 1 && f[15] === 16, [f[0], f[15]]);
check('offset 在 16..18', f[16] === 1 && f[17] === 2 && f[18] === 3, [f[16], f[17], f[18]]);
check('scl、size、rf、gain 在 20..23', Math.abs(f[20] - 0.1) < 1e-7 && f[21] === 15 && f[22] === 50 && f[23] === 0.5, [f[20], f[21], f[22], f[23]]);
check('寬高在 24、25', f[24] === 800 && f[25] === 560, [f[24], f[25]]);
check('顏色 col[1] 在 32..34', Math.abs(f[32] - 0.1) < 1e-7 && f[33] === 0.5 && f[34] === 1, [f[32], f[33], f[34]]);

// 5. 不讀回：沒有 mapAsync 呼叫；每次 drawPoints 只一次提交（flush 之後）
check('不讀回：沒有 mapAsync', dev.mapped === 0, dev.mapped);
const subsBefore = dev.log.filter((x) => x === 'submit').length;
G.drawPoints(pos, 100, base);
check('每次 drawPoints 一次提交', dev.log.filter((x) => x === 'submit').length === subsBefore + 1, dev.log);

// 6. 同大小同格式的畫布只建一次；不同大小另建
check('同大小第二次不再呼叫 makeCanvas', made === 1, made);
G.drawPoints(pos, 100, Object.assign({}, base, { width: 320, height: 240 }));
check('不同大小另建一個畫布', made === 2, made);

// 7. 參數檢查：每條路都要拒絕（訊息寫出原因）
const expectErr = (name, fn, re) => { const m = throws(fn); check(name, m !== null && re.test(m), m); };
expectErr('缺位置 buffer', () => G.drawPoints({ x: pos.x, y: pos.y }, 10, base), /要 \{x, y, z\}/);
expectErr('點數超過 buffer 大小', () => G.drawPoints(pos, 101, base), /小於點數 101/);
expectErr('點數不是正整數', () => G.drawPoints(pos, 0, base), /點數要是/);
expectErr('mvp 長度不對', () => G.drawPoints(pos, 10, Object.assign({}, base, { mvp: [1, 2, 3] })), /mvp 要是 16/);
expectErr('mvp 含 NaN', () => G.drawPoints(pos, 10, Object.assign({}, base, { mvp: mvp.map((v, i) => (i === 3 ? NaN : v)) })), /mvp 要是 16/);
expectErr('offset 長度不對', () => G.drawPoints(pos, 10, Object.assign({}, base, { offset: [0, 0] })), /offset 要是 3/);
expectErr('colors 不是 10 組', () => G.drawPoints(pos, 10, Object.assign({}, base, { colors: colors.slice(0, 9) })), /colors 要是 10 組/);
expectErr('colors 的一組不是 3 個數', () => G.drawPoints(pos, 10, Object.assign({}, base, { colors: colors.map((c, i) => (i === 2 ? [1, 2] : c)) })), /colors 要是 10 組/);
expectErr('畫布寬度超出', () => G.drawPoints(pos, 10, Object.assign({}, base, { width: 5000 })), /畫布大小/);
expectErr('scale 不是有限數', () => G.drawPoints(pos, 10, Object.assign({}, base, { scale: NaN })), /有限數字/);
// 已釋放的 buffer
const pos2 = { x: G.alloc(10, 'f32'), y: G.alloc(10, 'f32'), z: G.alloc(10, 'f32') };
G.free(pos2.z);
expectErr('已釋放的 buffer', () => G.drawPoints(pos2, 10, base), /未釋放的 f32/);
// f32x4 不行（位置要是純量）
const posV = { x: G.alloc(10, 'f32x4'), y: G.alloc(10, 'f32'), z: G.alloc(10, 'f32') };
expectErr('f32x4 位置被拒絕', () => G.drawPoints(posV, 10, base), /未釋放的 f32/);

// 8. 交錯頂點（標準 glVertexPointer）：{ xyz, stride, base }——三個綁定都是同一個 buffer，uniform 帶 stride 與 base
{
    const aos = G.alloc(3 * 20 + 9, 'f32'), nb = dev.binds.length;
    G.drawPoints({ xyz: aos, stride: 3, base: 9 }, 20, base);
    const e = dev.binds[nb], u = e[3].resource.buffer, g = new Float32Array(u.u8.buffer, u.u8.byteOffset, 68);
    check('AoS：綁定 0／1／2 都是 xyz 那個 buffer', e[0].resource.buffer === aos.gbuf && e[1].resource.buffer === aos.gbuf && e[2].resource.buffer === aos.gbuf);
    check('AoS：uniform stride＝3、base＝9', g[26] === 3 && g[27] === 9, [g[26], g[27]]);
    check('AoS：一般路徑 stride 欄位維持 0', (() => { const nb2 = dev.binds.length; G.drawPoints(pos, 100, base); const u2 = dev.binds[nb2][3].resource.buffer; const g2 = new Float32Array(u2.u8.buffer, u2.u8.byteOffset, 68); return g2[26] === 0 && g2[27] === 0; })());
    expectErr('AoS：buffer 不夠大', () => G.drawPoints({ xyz: aos, stride: 3, base: 9 }, 21, base), /小於點數/);
    expectErr('AoS：stride 小於 3', () => G.drawPoints({ xyz: aos, stride: 2 }, 5, base), /stride 要/);
}

console.log('kir_points: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED: ' + bad.join(' | ') : ''));
if (bad.length) process.exitCode = 1;
