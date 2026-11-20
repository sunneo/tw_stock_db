// node renderer/src/gpu/cl_icd_test.js — OpenCL ICD 載入器＋KIR 驅動（DESIGN.pyopencl.md）。
// 驗證：ICD 登記與探測、端到端結果、錯誤碼、各項執行期優化（用裝置層的真實呼叫次數證明，不是只看載入器自己的計數）、優化不破壞正確性。
const assert = require('assert');
const ICD = require('./cl_icd.js'), K = require('./kir.js'), F = require('./cl_front.js');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.stack || e.message).split('\n').slice(0, 8).join('\n   ')); } };

// 計數用的裝置：包住內建 JS 裝置，記下真正的上傳／下載／派送次數
function countingDevice() {
    const d = ICD.jsDevice(K), c = { alloc: 0, upload: 0, download: 0, dispatch: 0, free: 0 };
    return { c, dev: { alloc: (...a) => { c.alloc++; return d.alloc(...a); }, upload: (...a) => { c.upload++; return d.upload(...a); }, download: (...a) => { c.download++; return d.download(...a); }, dispatch: (...a) => { c.dispatch++; return d.dispatch(...a); }, free: (...a) => { c.free++; return d.free(...a); } } };
}
function setup() {
  const L = ICD.createLoader(), cd = countingDevice();
  L.registerDriver(ICD.makeKirDriver({ mods: { FaClFront: F, FaKir: K }, device: cd.dev, kind: 'js', name: 'test-js' }));
  const plat = L.platforms()[0], dev = L.devices(plat)[0], ctx = L.createContext([dev]), q = L.createQueue(ctx, dev);
  return { L, cd, plat, dev, ctx, q };
}
const f32 = (a) => new Uint8Array(new Float32Array(a).buffer);
const asF = (u8) => new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength >> 2);
const VADD = '__kernel void vadd(__global const float* a, __global const float* b, __global float* c, int n) { int i = get_global_id(0); if (i < n) c[i] = a[i] + b[i]; }';
const SCALE = '__kernel void scale(__global const float* x, __global float* y, int n, float s) { int i = get_global_id(0); if (i < n) y[i] = x[i] * s; }';

(async () => {
    await t('ICD：登記、探測失敗的驅動不列出、裝置類型過濾', async () => {
        const L = ICD.createLoader();
        L.registerDriver(ICD.makeKirDriver({ mods: { FaClFront: F, FaKir: K }, name: 'cpu-ref', kind: 'js' }));
        L.registerDriver(ICD.makeKirDriver({ mods: { FaClFront: F, FaKir: K }, name: 'fake-gpu', kind: 'webgpu', probe: () => ({ ok: false, reason: '沒有 WebGPU' }) }));
        assert.deepStrictEqual(L.platforms().map((p) => p.name), ['cpu-ref']);
        const rep = L.probeReport(); assert.strictEqual(rep.find((r) => r.name === 'fake-gpu').reason, '沒有 WebGPU');
        const p = L.platforms()[0]; assert.strictEqual(L.devices(p, 'CPU').length, 1);
        assert.throws(() => L.devices(p, 'GPU'), (e) => e.clName === 'DEVICE_NOT_FOUND' && e.code === -1);
        assert.throws(() => L.registerDriver(ICD.makeKirDriver({ mods: { FaClFront: F, FaKir: K }, name: 'cpu-ref' })), /已登記/);
    });

    await t('端到端：vecadd 結果正確', async () => {
        const { L, ctx, q } = setup(); const N = 1000, a = new Float32Array(N).map((_, i) => i), b = new Float32Array(N).map((_, i) => 2 * i);
        const A = L.createBuffer(ctx, {}, N * 4, new Uint8Array(a.buffer)), B = L.createBuffer(ctx, {}, N * 4, new Uint8Array(b.buffer)), C = L.createBuffer(ctx, {}, N * 4);
        const prog = L.build(L.createProgram(ctx, VADD)), k = L.createKernel(prog, 'vadd'); L.setArg(k, 0, A); L.setArg(k, 1, B); L.setArg(k, 2, C); L.setArg(k, 3, N);
        await L.enqueueNDRange(q, k, [N]); const r = asF((await L.enqueueRead(q, C)).data);
        assert.strictEqual(r[0], 0); assert.strictEqual(r[500], 1500); assert.strictEqual(r[999], 2997);
    });

    await t('優化 1：建置快取（跨 Program 物件、失敗結果也快取）', async () => {
        const { L, ctx } = setup(); L.build(L.createProgram(ctx, VADD)); L.build(L.createProgram(ctx, VADD)); L.build(L.createProgram(ctx, VADD));
        assert.strictEqual(L.stats().builds, 1); assert.strictEqual(L.stats().buildHits, 2);
        const BAD = '__kernel void f(__global float* o, int n) { int i = get_global_id(0); o[i] = i % 3; }';
        for (let i = 0; i < 2; i++) assert.throws(() => L.build(L.createProgram(ctx, BAD)), (e) => e.clName === 'BUILD_PROGRAM_FAILURE' && /%/.test(e.message) === true || e.clName === 'BUILD_PROGRAM_FAILURE');
        assert.strictEqual(L.stats().builds, 2, '壞原始碼只編譯一次');
    });

    await t('優化 2：延遲同步——連續執行不重傳、重複讀不重下載', async () => {
        const { L, cd, ctx, q } = setup(); const N = 256;
        const A = L.createBuffer(ctx, {}, N * 4, f32(new Array(N).fill(1))), Y = L.createBuffer(ctx, {}, N * 4), Z = L.createBuffer(ctx, {}, N * 4);
        const prog = L.build(L.createProgram(ctx, SCALE)); const k1 = L.createKernel(prog, 'scale'), k2 = L.createKernel(prog, 'scale');
        L.setArg(k1, 0, A); L.setArg(k1, 1, Y); L.setArg(k1, 2, N); L.setArg(k1, 3, 3);       // Y = A*3
        L.setArg(k2, 0, Y); L.setArg(k2, 1, Z); L.setArg(k2, 2, N); L.setArg(k2, 3, 2);       // Z = Y*2（Y 留在裝置上，不該下載再上傳）
        await L.enqueueNDRange(q, k1, [N]); await L.enqueueNDRange(q, k2, [N]);
        assert.strictEqual(cd.c.upload, 1, '只有 A 上傳了一次（Y 是上一個核心的輸出，Z 純輸出）'); assert.strictEqual(cd.c.download, 0, '中途沒有讀回');
        const z1 = asF((await L.enqueueRead(q, Z)).data), z2 = asF((await L.enqueueRead(q, Z)).data);
        assert.strictEqual(z1[7], 6); assert.strictEqual(z2[255], 6); assert.strictEqual(cd.c.download, 1, '第二次讀取由主機副本供應'); assert.strictEqual(L.stats().lazyReadsServedFromHost, 1);
    });

    await t('優化 3：內容相同的重複寫入不上傳；內容變了才上傳', async () => {
        const { L, cd, ctx, q } = setup(); const N = 64;
        const X = L.createBuffer(ctx, {}, N * 4), Y = L.createBuffer(ctx, {}, N * 4); const k = L.createKernel(L.build(L.createProgram(ctx, SCALE)), 'scale');
        L.setArg(k, 0, X); L.setArg(k, 1, Y); L.setArg(k, 2, N); L.setArg(k, 3, 1);
        const data = f32(new Array(N).fill(5));
        await L.enqueueWrite(q, X, data); await L.enqueueNDRange(q, k, [N]); assert.strictEqual(cd.c.upload, 1);
        await L.enqueueWrite(q, X, data); await L.enqueueNDRange(q, k, [N]); assert.strictEqual(cd.c.upload, 1, '相同內容不重傳'); assert.strictEqual(L.stats().elidedUploads, 1);
        await L.enqueueWrite(q, X, f32(new Array(N).fill(6))); await L.enqueueNDRange(q, k, [N]); assert.strictEqual(cd.c.upload, 2, '內容變了要重傳');
        assert.strictEqual(asF((await L.enqueueRead(q, Y)).data)[0], 6);
    });

    await t('優化 4：純輸出（主機端沒寫過）不上傳', async () => {
        const { L, cd, ctx, q } = setup(); const N = 32;
        const X = L.createBuffer(ctx, {}, N * 4, f32(new Array(N).fill(2))), Y = L.createBuffer(ctx, {}, N * 4); const k = L.createKernel(L.build(L.createProgram(ctx, SCALE)), 'scale');
        L.setArg(k, 0, X); L.setArg(k, 1, Y); L.setArg(k, 2, N); L.setArg(k, 3, 4); await L.enqueueNDRange(q, k, [N]);
        assert.strictEqual(cd.c.upload, 1, '只上傳 X'); assert.strictEqual(L.stats().skippedOutputUploads, 1);
    });

    await t('正確性：核心只寫一部分時，主機端寫過的輸出緩衝區其餘部分要保留（優化 4 不能把它變成零）', async () => {
        const { L, ctx, q } = setup(); const N = 8;
        const X = L.createBuffer(ctx, {}, N * 4, f32(new Array(N).fill(1))), Y = L.createBuffer(ctx, {}, N * 4, f32(new Array(N).fill(7)));
        const k = L.createKernel(L.build(L.createProgram(ctx, SCALE)), 'scale'); L.setArg(k, 0, X); L.setArg(k, 1, Y); L.setArg(k, 2, 4); L.setArg(k, 3, 10);   // n=4：只寫前 4 格
        await L.enqueueNDRange(q, k, [N]); const y = asF((await L.enqueueRead(q, Y)).data);
        assert.deepStrictEqual(Array.from(y), [10, 10, 10, 10, 7, 7, 7, 7]);
    });

    await t('讀寫順序：寫入後核心結果、再寫入部分範圍、再讀', async () => {
        const { L, ctx, q } = setup(); const N = 8;
        const X = L.createBuffer(ctx, {}, N * 4, f32([1, 2, 3, 4, 5, 6, 7, 8])), Y = L.createBuffer(ctx, {}, N * 4); const k = L.createKernel(L.build(L.createProgram(ctx, SCALE)), 'scale');
        L.setArg(k, 0, X); L.setArg(k, 1, Y); L.setArg(k, 2, N); L.setArg(k, 3, 2); await L.enqueueNDRange(q, k, [N]);
        await L.enqueueWrite(q, Y, f32([100]), 4);   // 在裝置較新時做部分寫入：要先把裝置內容拿回主機再覆蓋，不能丟掉其他格
        assert.deepStrictEqual(Array.from(asF((await L.enqueueRead(q, Y)).data)), [2, 100, 6, 8, 10, 12, 14, 16]);
        const D = L.createBuffer(ctx, {}, N * 4); await L.enqueueCopy(q, Y, D); assert.deepStrictEqual(Array.from(asF((await L.enqueueRead(q, D)).data)), [2, 100, 6, 8, 10, 12, 14, 16]);
    });

    await t('死的全域常數宣告被忽略（pyopencl 的編譯器快取會追加）；被引用的全域常數仍如實報錯', async () => {
        const { L, ctx } = setup();
        const tail = '\n\n__constant int pyopencl_defeat_cache_ab12cd34 = 0;';
        L.build(L.createProgram(ctx, VADD + tail));   // 不丟例外
        assert.deepStrictEqual(L.kernelNames(L.build(L.createProgram(ctx, VADD + tail))), ['vadd']);
        const USED = '__constant int K = 3;\n__kernel void f(__global float* o, int n) { int i = get_global_id(0); o[i] = K; }';
        assert.throws(() => L.build(L.createProgram(ctx, USED)), (e) => e.clName === 'BUILD_PROGRAM_FAILURE' && /__constant|全域/.test(e.message));
    });

    await t('clc 驅動經載入器：pyopencl 風格核心、寫入追蹤（只讀的輸入不會被當成被改過）、二維與 global offset', async () => {
        const CLC = require('./clc_js.js'); const L = ICD.createLoader(); L.registerDriver(ICD.makeClcDriver({ mods: { FaClc: CLC }, name: 'clc' }));
        const dev = L.devices(L.platforms()[0])[0], ctx = L.createContext([dev]), q = L.createQueue(ctx, dev);
        const src = '__kernel void f(__global float* in, __global float* out, long n, float s) { long i = get_global_id(0); if (i < n) out[i] = in[i] * s; }';   // in 沒標 const：靠執行期的寫入追蹤判斷
        const X = L.createBuffer(ctx, {}, 32, f32([1, 2, 3, 4, 5, 6, 7, 8])), Y = L.createBuffer(ctx, {}, 32);
        const k = L.createKernel(L.build(L.createProgram(ctx, src)), 'f'); L.setArg(k, 0, X); L.setArg(k, 1, Y); L.setArg(k, 2, 8); L.setArg(k, 3, 2.5);
        await L.enqueueNDRange(q, k, [8]);
        assert.deepStrictEqual(Array.from(asF((await L.enqueueRead(q, X)).data)), [1, 2, 3, 4, 5, 6, 7, 8]);
        assert.deepStrictEqual(Array.from(asF((await L.enqueueRead(q, Y)).data)), [2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20]);
        assert.strictEqual(L.stats().uploads + L.stats().downloads, 0, 'clc 驅動走主機路線：直接在主機副本上跑，零上傳、零下載'); assert.strictEqual(L.stats().routedHost, 1);
        // 二維與 global offset
        const src2 = '__kernel void g(__global int* o, int w) { int x = get_global_id(0), y = get_global_id(1); o[y * w + x] = x * 100 + y; }';
        const O = L.createBuffer(ctx, {}, 48); const k2 = L.createKernel(L.build(L.createProgram(ctx, src2)), 'g'); L.setArg(k2, 0, O); L.setArg(k2, 1, 4);
        await L.enqueueNDRange(q, k2, [4, 3]); const o = new Int32Array((await L.enqueueRead(q, O)).data.buffer.slice(0)); assert.deepStrictEqual(Array.from(o.subarray(0, 12)), [0, 100, 200, 300, 1, 101, 201, 301, 2, 102, 202, 302]);
        await assert.rejects(L.enqueueNDRange(q, k2, [2, 2, 2, 2]), (e) => e.clName === 'INVALID_WORK_DIMENSION');
        // KIR 驅動不支援多維與 offset
        const L2 = ICD.createLoader(); L2.registerDriver(ICD.makeKirDriver({ mods: { FaClFront: F, FaKir: K }, name: 'kir' })); const d2 = L2.devices(L2.platforms()[0])[0], c2 = L2.createContext([d2]), q2 = L2.createQueue(c2, d2);
        const k3 = L2.createKernel(L2.build(L2.createProgram(c2, VADD)), 'vadd'); const B = L2.createBuffer(c2, {}, 16); [0, 1, 2].forEach((i) => L2.setArg(k3, i, B)); L2.setArg(k3, 3, 4);
        await assert.rejects(L2.enqueueNDRange(q2, k3, [2, 2]), (e) => e.clName === 'INVALID_WORK_DIMENSION'); await assert.rejects(L2.enqueueNDRange(q2, k3, [4], null, [1]), (e) => e.clName === 'INVALID_GLOBAL_OFFSET' && e.code === -56);
    });

    // ---- GPU 驅動（WebGPU／WebGL2 的 KIR 裝置層＋clc 主機退路）：用帶計數器的假 GPU 裝置驗證路由與傳輸 ----
    const CLC2 = require('./clc_js.js');
    function gpuSetup(smallN) {
        const cd = countingDevice(); const L = ICD.createLoader();
        L.registerDriver(ICD.makeGpuDriver({ mods: { FaClFront: F, FaKir: K, FaClc: CLC2 }, device: cd.dev, backend: 'webgpu', smallN }));
        const dev = L.devices(L.platforms()[0])[0], ctx = L.createContext([dev]), q = L.createQueue(ctx, dev); return { L, cd, ctx, q, dev };
    }
    await t('GPU 驅動：裝置資訊（GPU 類型）、KIR 能收的核心走裝置、結果正確', async () => {
        const { L, cd, ctx, q, dev } = gpuSetup(0); assert.strictEqual(dev.info.type, 'GPU'); assert.ok(/WebGPU/.test(dev.info.name));
        const N = 256, X = L.createBuffer(ctx, {}, N * 4, f32(new Array(N).fill(3))), Y = L.createBuffer(ctx, {}, N * 4);
        const k = L.createKernel(L.build(L.createProgram(ctx, SCALE)), 'scale'); L.setArg(k, 0, X); L.setArg(k, 1, Y); L.setArg(k, 2, N); L.setArg(k, 3, 2);
        await L.enqueueNDRange(q, k, [N]); assert.strictEqual(cd.c.dispatch, 1); assert.strictEqual(L.stats().routedDev, 1);
        assert.strictEqual(asF((await L.enqueueRead(q, Y)).data)[10], 6);
    });
    await t('GPU 驅動：小問題走主機（零傳輸）、大問題走裝置；核心鏈留在裝置不讀回', async () => {
        const { L, cd, ctx, q } = gpuSetup(1000);
        const mk = (n, v) => L.createBuffer(ctx, {}, n * 4, f32(new Array(n).fill(v)));
        const prog = L.build(L.createProgram(ctx, SCALE));
        const small = [mk(8, 1), L.createBuffer(ctx, {}, 32)], ks = L.createKernel(prog, 'scale'); L.setArg(ks, 0, small[0]); L.setArg(ks, 1, small[1]); L.setArg(ks, 2, 8); L.setArg(ks, 3, 5);
        await L.enqueueNDRange(q, ks, [8]); assert.strictEqual(L.stats().routedHost, 1); assert.strictEqual(cd.c.dispatch + cd.c.upload + cd.c.download, 0, '小問題不碰 GPU');
        assert.deepStrictEqual(Array.from(asF((await L.enqueueRead(q, small[1])).data)), [5, 5, 5, 5, 5, 5, 5, 5]);
        const N = 4096, A = mk(N, 1), B = L.createBuffer(ctx, {}, N * 4), C = L.createBuffer(ctx, {}, N * 4);
        const k1 = L.createKernel(prog, 'scale'), k2 = L.createKernel(prog, 'scale'); L.setArg(k1, 0, A); L.setArg(k1, 1, B); L.setArg(k1, 2, N); L.setArg(k1, 3, 2); L.setArg(k2, 0, B); L.setArg(k2, 1, C); L.setArg(k2, 2, N); L.setArg(k2, 3, 3);
        await L.enqueueNDRange(q, k1, [N]); await L.enqueueNDRange(q, k2, [N]);
        assert.strictEqual(L.stats().routedDev, 2); assert.strictEqual(cd.c.upload, 1, '只有 A 上傳一次'); assert.strictEqual(cd.c.download, 0, '中間結果 B 留在 GPU');
        assert.strictEqual(asF((await L.enqueueRead(q, C)).data)[100], 6); assert.strictEqual(cd.c.download, 1);
    });
    await t('GPU 驅動：KIR 不收的核心（int 緩衝區、%、二維、global offset）走主機，結果正確；資料只在 GPU 時先讀回', async () => {
        const { L, cd, ctx, q } = gpuSetup(0);
        const N = 64, A = L.createBuffer(ctx, {}, N * 4, new Uint8Array(new Int32Array(N).map((_, i) => i).buffer)), O = L.createBuffer(ctx, {}, N * 4);
        const k = L.createKernel(L.build(L.createProgram(ctx, '__kernel void m(__global const int* a, __global int* o) { int i = get_global_id(0); o[i] = a[i] % 7; }')), 'm'); L.setArg(k, 0, A); L.setArg(k, 1, O);
        await L.enqueueNDRange(q, k, [N]); assert.strictEqual(L.stats().routedHost, 1); assert.strictEqual(cd.c.dispatch, 0);
        assert.deepStrictEqual(Array.from(new Int32Array((await L.enqueueRead(q, O)).data.buffer.slice(0))).slice(0, 10), [0, 1, 2, 3, 4, 5, 6, 0, 1, 2]);
        // 二維核心 + offset
        const g = L.createKernel(L.build(L.createProgram(ctx, '__kernel void g(__global float* o, int w) { int x = get_global_id(0), y = get_global_id(1); o[y * w + x] = x + y * 10; }')), 'g'); const G = L.createBuffer(ctx, {}, 48); L.setArg(g, 0, G); L.setArg(g, 1, 4);
        await L.enqueueNDRange(q, g, [4, 3]); assert.deepStrictEqual(Array.from(asF((await L.enqueueRead(q, G)).data)), [0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23]);
        // KIR 核心的結果只在 GPU：接著跑一個必須走主機的核心（int 緩衝區讀它），要先把 GPU 內容讀回
        const Nn = 64, X = L.createBuffer(ctx, {}, Nn * 4, f32(new Array(Nn).fill(2))), Y = L.createBuffer(ctx, {}, Nn * 4);
        const ks = L.createKernel(L.build(L.createProgram(ctx, SCALE)), 'scale'); L.setArg(ks, 0, X); L.setArg(ks, 1, Y); L.setArg(ks, 2, Nn); L.setArg(ks, 3, 4); await L.enqueueNDRange(q, ks, [Nn]);
        const dl0 = cd.c.download; const kk = L.createKernel(L.build(L.createProgram(ctx, '__kernel void p(__global float* a, __global float* b) { int i = get_global_id(0); b[i] = a[i] + 1.0f; }')), 'p'); const Z = L.createBuffer(ctx, {}, Nn * 4); L.setArg(kk, 0, Y); L.setArg(kk, 1, Z);
        await L.enqueueNDRange(q, kk, [Nn, 1]); assert.strictEqual(asF((await L.enqueueRead(q, Z)).data)[5], 9);   // 二維 → 主機；Y 在 GPU 上，要先讀回一次
        assert.strictEqual(cd.c.download, dl0 + 1);
    });
    await t('GPU 驅動：主機核心改了已上傳到 GPU 的緩衝區 → 裝置副本要標成過期，之後的 GPU 核心看到新資料', async () => {
        const { L, cd, ctx, q } = gpuSetup(0); const N = 64;
        const X = L.createBuffer(ctx, {}, N * 4, f32(new Array(N).fill(1))), Y = L.createBuffer(ctx, {}, N * 4);
        const prog = L.build(L.createProgram(ctx, SCALE)); const ks = L.createKernel(prog, 'scale'); L.setArg(ks, 0, X); L.setArg(ks, 1, Y); L.setArg(ks, 2, N); L.setArg(ks, 3, 2);
        await L.enqueueNDRange(q, ks, [N]); assert.strictEqual(cd.c.upload, 1); assert.strictEqual(asF((await L.enqueueRead(q, Y)).data)[0], 2);
        const inc = L.createKernel(L.build(L.createProgram(ctx, '__kernel void inc(__global float* a) { int i = get_global_id(0); a[i] = a[i] + 1.0f; }')), 'inc'); L.setArg(inc, 0, X);
        await L.enqueueNDRange(q, inc, [N, 1]);   // 二維 → 主機路線，就地改 X
        await L.enqueueNDRange(q, ks, [N]);       // 再走 GPU：X 必須重新上傳，Y 才會是 (1+1)*2
        assert.strictEqual(asF((await L.enqueueRead(q, Y)).data)[5], 4, 'GPU 核心看到了主機核心的修改'); assert.strictEqual(cd.c.upload, 2, 'X 因為被主機改過而重新上傳');
    });
    await t('子緩衝區：與父共用記憶體、讀寫複製帶偏移、核心參數帶偏移（走主機路線）、範圍檢查', async () => {
        const CLC3 = require('./clc_js.js'); const L = ICD.createLoader(); L.registerDriver(ICD.makeClcDriver({ mods: { FaClc: CLC3 }, name: 'clc' }));
        const dev = L.devices(L.platforms()[0])[0], ctx = L.createContext([dev]), q = L.createQueue(ctx, dev);
        const P = L.createBuffer(ctx, {}, 64, f32([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])), S = L.createSubBuffer(P, 16, 32);   // 父的 [16, 48) ＝ 元素 4..11
        assert.deepStrictEqual(Array.from(asF((await L.enqueueRead(q, S)).data)), [4, 5, 6, 7, 8, 9, 10, 11]);
        await L.enqueueWrite(q, S, f32([100]), 8);      // 子的位元組 8 ＝ 父的位元組 24 ＝ 元素 6
        assert.strictEqual(asF((await L.enqueueRead(q, P)).data)[6], 100, '寫子緩衝區，父看得到');
        const k = L.createKernel(L.build(L.createProgram(ctx, '__kernel void f(__global float* a, float s) { int i = get_global_id(0); a[i] = a[i] * s; }')), 'f'); L.setArg(k, 0, S); L.setArg(k, 1, 2);
        await L.enqueueNDRange(q, k, [8]);              // 只乘子區間的 8 個元素
        assert.deepStrictEqual(Array.from(asF((await L.enqueueRead(q, P)).data)), [0, 1, 2, 3, 8, 10, 200, 14, 16, 18, 20, 22, 12, 13, 14, 15]);
        const D = L.createBuffer(ctx, {}, 32); await L.enqueueCopy(q, S, D); assert.strictEqual(asF((await L.enqueueRead(q, D)).data)[0], 8);
        assert.throws(() => L.createSubBuffer(P, 40, 32), (e) => e.clName === 'INVALID_VALUE'); assert.throws(() => L.createSubBuffer(S, 0, 8), (e) => e.clName === 'INVALID_MEM_OBJECT');
        await assert.rejects(L.enqueueRead(q, S, 40), (e) => e.clName === 'INVALID_VALUE');
    });
    await t('GPU 驅動：finish 會刷新並同步 GPU 命令', async () => {
        let flushed = 0, synced = 0; const cd = countingDevice(); cd.dev.flush = () => { flushed++; }; cd.dev.sync = async () => { synced++; };
        const L = ICD.createLoader(); L.registerDriver(ICD.makeGpuDriver({ mods: { FaClFront: F, FaKir: K, FaClc: CLC2 }, device: cd.dev, smallN: 0 })); const dev = L.devices(L.platforms()[0])[0], ctx = L.createContext([dev]), q = L.createQueue(ctx, dev);
        await L.finish(q); assert.strictEqual(flushed, 1); assert.strictEqual(synced, 1);
    });

    await t('錯誤碼', async () => {
        const { L, ctx, q } = setup(); const N = 8; const X = L.createBuffer(ctx, {}, N * 4), Y = L.createBuffer(ctx, {}, N * 4);
        const prog = L.createProgram(ctx, SCALE); assert.throws(() => L.createKernel(prog, 'scale'), (e) => e.clName === 'INVALID_PROGRAM_EXECUTABLE');
        L.build(prog); assert.throws(() => L.createKernel(prog, '不存在'), (e) => e.clName === 'INVALID_KERNEL_NAME' && e.code === -46);
        const k = L.createKernel(prog, 'scale'); assert.throws(() => L.setArg(k, 9, X), (e) => e.clName === 'INVALID_ARG_INDEX');
        assert.throws(() => L.setArg(k, 0, 5), (e) => e.clName === 'INVALID_MEM_OBJECT');
        L.setArg(k, 0, X); L.setArg(k, 1, Y); L.setArg(k, 2, N);
        await assert.rejects(L.enqueueNDRange(q, k, [N]), (e) => e.clName === 'INVALID_KERNEL_ARGS' && /s/.test(e.message));
        L.setArg(k, 3, 1); await assert.rejects(L.enqueueNDRange(q, k, [N], [3]), (e) => e.clName === 'INVALID_WORK_GROUP_SIZE');
        await assert.rejects(L.enqueueNDRange(q, k, [N, N]), (e) => e.clName === 'INVALID_WORK_DIMENSION');
        await assert.rejects(L.enqueueRead(q, X, 100, 4), (e) => e.clName === 'INVALID_VALUE');
        assert.throws(() => L.createBuffer(ctx, {}, 0), (e) => e.clName === 'INVALID_BUFFER_SIZE');
        L.releaseMem(X); await assert.rejects(L.enqueueRead(q, X), (e) => e.clName === 'INVALID_MEM_OBJECT');
    });

    await t('事件計時（profiling 佇列）', async () => {
        const L = ICD.createLoader(); L.registerDriver(ICD.makeKirDriver({ mods: { FaClFront: F, FaKir: K }, name: 'p' }));
        const dev = L.devices(L.platforms()[0])[0], ctx = L.createContext([dev]), q = L.createQueue(ctx, dev, { profiling: true });
        const X = L.createBuffer(ctx, {}, 16, f32([1, 2, 3, 4])), Y = L.createBuffer(ctx, {}, 16); const k = L.createKernel(L.build(L.createProgram(ctx, SCALE)), 'scale');
        L.setArg(k, 0, X); L.setArg(k, 1, Y); L.setArg(k, 2, 4); L.setArg(k, 3, 2); const ev = await L.enqueueNDRange(q, k, [4]);
        assert.ok(ev.end >= ev.start && ev.cmd === 'kernel'); assert.ok(q.events.length >= 1);
    });

    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
