// node renderer/src/gpu/cl_host_page_test.js — 頁面端 OpenCL 主機（驅動註冊順序、經 JSON／位元組介面跑完整流程、GPU 路由）。
// 沒有真 GPU：用 kir_host_hooks 的 force:'js'（只有 CPU 驅動），以及一個假的「WebGPU」掛鉤（帶計數器的裝置）驗證 GPU 驅動的路由與傳輸。
const assert = require('assert');
const ICD = require('./cl_icd.js'), OPS = require('./cl_host_ops.js'), CLC = require('./clc_js.js'), F = require('./cl_front.js'), K = require('./kir.js'), HOOKS = require('./kir_host_hooks.js'), PAGE = require('./cl_host_page.js');
let pass = 0, fail = 0; const t = async (n, f) => { try { await f(); pass++; } catch (e) { fail++; console.error('FAIL ' + n + '\n   ' + String(e.stack || e.message).split('\n').slice(0, 8).join('\n   ')); } };
const mods = { FaClIcd: ICD, FaClHostOps: OPS, FaClc: CLC, FaClFront: F, FaKir: K, FaKirGen: require('./kir_gen.js'), FaKirHostHooks: HOOKS };
const f32 = (a) => new Uint8Array(new Float32Array(a).buffer), asF = (u8) => new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength >> 2);
const SCALE = '__kernel void scale(__global const float* x, __global float* y, int n, float s) { int i = get_global_id(0); if (i < n) y[i] = x[i] * s; }';
async function run(H, plat, N, data) {   // 走 _fa_opencl.call 的 JSON＋位元組介面的完整流程
    const c = async (op, a, b) => { const r = await H.call(op, JSON.stringify(a || {}), b); const j = JSON.parse(r.json); assert.ok(!j.error, op + '：' + JSON.stringify(j.error)); return { j, data: r.data }; };
    const devs = (await c('devices', { platform: plat.h, type: 'ALL' })).j.devices, ctx = (await c('ctx_create', { devices: [devs[0].h] })).j.h, q = (await c('queue_create', { ctx, device: devs[0].h })).j.h;
    const X = (await c('buf_create', { ctx, flags: 4, size: N * 4 }, f32(data))).j.h, Y = (await c('buf_create', { ctx, flags: 2, size: N * 4 })).j.h;
    const prog = (await c('prog_create', { ctx, src: SCALE })).j.h; await c('prog_build', { prog, options: '' }); const k = (await c('kernel_create', { prog, name: 'scale' })).j.h;
    await c('kernel_set_arg', { kernel: k, index: 0, mem: X }); await c('kernel_set_arg', { kernel: k, index: 1, mem: Y }); await c('kernel_set_arg', { kernel: k, index: 2, scalar: N }); await c('kernel_set_arg', { kernel: k, index: 3, scalar: 3 });
    await c('nd_range', { queue: q, kernel: k, global: [N], local: null }); return asF((await c('buf_read', { queue: q, mem: Y, offset: 0, size: N * 4 })).data);
}
(async () => {
    await t('沒有 GPU（force js）：只有 CPU 驅動，經 JSON＋位元組介面算對', async () => {
        const H = await PAGE.create({ mods, force: 'js' }); const plats = JSON.parse((await H.call('platforms', '{}')).json).platforms;
        assert.deepStrictEqual(plats.map((p) => p.name), ['fa-cpu-clc']); assert.ok(/JS/.test(H.describe()));
        const out = await run(H, plats[0], 8, [1, 2, 3, 4, 5, 6, 7, 8]); assert.deepStrictEqual(Array.from(out), [3, 6, 9, 12, 15, 18, 21, 24]); assert.strictEqual(H.stats().routedHost, 1);
    });
    await t('有 GPU（假的 WebGPU 掛鉤）：GPU 平台排第一、CPU 第二；大問題走 GPU、小問題走主機', async () => {
        const dev = ICD.jsDevice(K), c = { dispatch: 0, upload: 0, download: 0, flush: 0 };
        const kirDev = { alloc: (...a) => dev.alloc(...a), upload: (...a) => { c.upload++; return dev.upload(...a); }, download: (...a) => { c.download++; return dev.download(...a); }, dispatch: (...a) => { c.dispatch++; return dev.dispatch(...a); }, free: () => {}, flush: () => { c.flush++; }, sync: async () => {} };
        const fakeHooks = { setup: async () => ({ backend: 'webgpu', hooks: { kirDev }, reasons: {}, describe: () => '後端：WebGPU（KIR）', stats: () => ({}) }) };
        const H = await PAGE.create({ mods: Object.assign({}, mods, { FaKirHostHooks: fakeHooks }), smallN: 1000 });
        const plats = JSON.parse((await H.call('platforms', '{}')).json).platforms; assert.deepStrictEqual(plats.map((p) => p.name), ['fa-gpu-webgpu', 'fa-cpu-clc']);
        const devs = JSON.parse((await H.call('devices', JSON.stringify({ platform: plats[0].h, type: 'GPU' }))).json).devices; assert.strictEqual(devs[0].type, 'GPU'); assert.ok(/WebGPU/.test(devs[0].name));
        const big = await run(H, plats[0], 4096, new Array(4096).fill(2)); assert.strictEqual(big[100], 6); assert.strictEqual(c.dispatch, 1, '大問題走 GPU 派送');
        const small = await run(H, plats[0], 16, new Array(16).fill(2)); assert.strictEqual(small[3], 6); assert.strictEqual(c.dispatch, 1, '小問題走主機，不再派送');
        assert.strictEqual(H.stats().routedDev, 1); assert.strictEqual(H.stats().routedHost, 1);
        assert.ok(/WebGPU/.test(H.describe()) && /fa-gpu-webgpu/.test(H.describe()));
        await H.call('finish', JSON.stringify({ queue: 1 }));
    });
    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
