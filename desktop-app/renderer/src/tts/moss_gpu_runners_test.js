'use strict';
// moss_gpu_runners 的單元測試：沒有 WebGPU 時 load 丟明確的錯（呼叫端據此退回 wasm）；assertT1 對 cpu-js 層丟錯。
const assert = require('assert');
const R = require('./moss_gpu_runners.js');
(async () => {
  let p = await R.probe(undefined); assert.strictEqual(p.ok, false); assert.ok(/沒有 WebGPU/.test(p.reason));
  p = await R.probe({ gpu: { requestAdapter: async () => null } }); assert.strictEqual(p.ok, false); assert.ok(/adapter/.test(p.reason));
  p = await R.probe({ gpu: { requestAdapter: async () => { throw new Error('boom'); } } }); assert.strictEqual(p.ok, false); assert.ok(/boom/.test(p.reason));
  p = await R.probe({ gpu: { requestAdapter: async () => ({}) } }); assert.strictEqual(p.ok, true);
  await assert.rejects(() => R.load({ navigator: {}, fetchBytes: async () => { throw new Error('不該被呼叫'); }, tts: {} }), /沒有 WebGPU/);
  R.assertT1({ tiers: { linear: { T1: 5 }, rope: {} } }, 'x');
  assert.throws(() => R.assertT1({ tiers: { linear: { T1: 5, 'cpu-js': 1 } } }, 'decode'), /cpu-js/);
  console.log('moss_gpu_runners_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
