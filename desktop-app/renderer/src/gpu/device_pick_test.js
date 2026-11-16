'use strict';
const assert = require('assert'), P = require('./device_pick.js');
const real = { vendor: 'nvidia', architecture: 'ada', device: 'rtx', description: 'NVIDIA GeForce RTX 4070' };
let r = P.decide({ hasWebGpu: false }); assert.strictEqual(r.enabled, false); assert.ok(/沒有 WebGPU/.test(r.reason)); assert.strictEqual(r.features.mossGpu.on, false);
r = P.decide({ hasWebGpu: true, adapter: null }); assert.ok(/adapter/.test(r.reason));
r = P.decide({ hasWebGpu: true, adapter: { isFallbackAdapter: true } }); assert.strictEqual(r.enabled, false); assert.ok(/軟體/.test(r.reason));
r = P.decide({ hasWebGpu: true, adapter: { description: 'SwiftShader Vulkan' }, gpuGflops: 999, cpuGflops: 1 }); assert.strictEqual(r.enabled, false, '軟體 adapter 即使基準高也關');
// 2026-11-17：真 GPU 不再用基準門檻擋（使用者：最爛的 GPU 也比舊 CPU 快；每條路徑有失敗退回）——基準沒量到、很低、比 CPU 慢都照樣開
for (const info of [{ gpuGflops: 0 }, { gpuGflops: 5, cpuGflops: 1 }, { gpuGflops: 30, cpuGflops: 15 }, { gpuGflops: 3, cpuGflops: 8 }]) { r = P.decide(Object.assign({ hasWebGpu: true, adapter: real }, info)); assert.strictEqual(r.enabled, true, JSON.stringify(info)); }
r = P.decide({ hasWebGpu: true, adapter: real, gpuGflops: 400, cpuGflops: 8 }); assert.strictEqual(r.enabled, true); for (const f of P.FEATURES) assert.strictEqual(r.features[f].on, true);
assert.ok(P.cpuBench(32) > 0);
(async () => { // probe：沒有 WebGPU 不丟錯；軟體 adapter 不量基準直接關
  let o = await P.probe(undefined, {}); assert.strictEqual(o.decision.enabled, false);
  let benched = false; const soft = { gpu: { requestAdapter: async () => ({ info: { description: 'llvmpipe' } }) } };
  o = await P.probe(soft, { getDevice: async () => { benched = true; return { dev: null }; } }); assert.strictEqual(o.decision.enabled, false); assert.strictEqual(benched, false);
  o = await P.probe({ gpu: { requestAdapter: async () => { throw new Error('boom'); } } }, {}); assert.strictEqual(o.decision.enabled, false); assert.ok(/boom/.test(o.info.error));
  console.log('device_pick_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
