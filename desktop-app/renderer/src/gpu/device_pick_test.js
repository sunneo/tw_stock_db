'use strict';
const assert = require('assert'), P = require('./device_pick.js');
const real = { vendor: 'nvidia', architecture: 'ada', device: 'rtx', description: 'NVIDIA GeForce RTX 4070' };
let r = P.decide({ hasWebGpu: false }); assert.strictEqual(r.enabled, false); assert.ok(/沒有 WebGPU/.test(r.reason)); assert.strictEqual(r.features.mossGpu.on, false);
r = P.decide({ hasWebGpu: true, adapter: null }); assert.ok(/adapter/.test(r.reason));
r = P.decide({ hasWebGpu: true, adapter: { isFallbackAdapter: true } }); assert.strictEqual(r.enabled, false); assert.ok(/軟體/.test(r.reason));
r = P.decide({ hasWebGpu: true, adapter: { description: 'SwiftShader Vulkan' }, gpuGflops: 999, cpuGflops: 1 }); assert.strictEqual(r.enabled, false, '軟體 adapter 即使基準高也關');
r = P.decide({ hasWebGpu: true, adapter: real, gpuGflops: 0 }); assert.ok(/沒有量到/.test(r.reason));
r = P.decide({ hasWebGpu: true, adapter: real, gpuGflops: 5, cpuGflops: 1 }); assert.ok(/太低/.test(r.reason));
r = P.decide({ hasWebGpu: true, adapter: real, gpuGflops: 30, cpuGflops: 15 }); assert.ok(/快 3 倍/.test(r.reason));
r = P.decide({ hasWebGpu: true, adapter: real, gpuGflops: 400, cpuGflops: 8 }); assert.strictEqual(r.enabled, true); for (const f of P.FEATURES) assert.strictEqual(r.features[f].on, true);
assert.ok(P.cpuBench(32) > 0);
(async () => { // probe：沒有 WebGPU 不丟錯；軟體 adapter 不量基準直接關
  let o = await P.probe(undefined, {}); assert.strictEqual(o.decision.enabled, false);
  let benched = false; const soft = { gpu: { requestAdapter: async () => ({ info: { description: 'llvmpipe' } }) } };
  o = await P.probe(soft, { getDevice: async () => { benched = true; return { dev: null }; } }); assert.strictEqual(o.decision.enabled, false); assert.strictEqual(benched, false);
  o = await P.probe({ gpu: { requestAdapter: async () => { throw new Error('boom'); } } }, {}); assert.strictEqual(o.decision.enabled, false); assert.ok(/boom/.test(o.info.error));
  console.log('device_pick_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
