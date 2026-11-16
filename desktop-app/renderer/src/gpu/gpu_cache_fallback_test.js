'use strict';
// 清單 E：pipeline 快取（同一份 WGSL 第二次呼叫不再 createComputePipeline）與退路（沒有 WebGPU／GPU 執行丟錯 → cpu-js，結果與 CPU 參考一致，原因寫明）。
// 用假的 WebGPU 裝置計數；涵蓋 matmulnbits_gpu、moss_gpu（linear／layerNorm／gelu）。
const assert = require('assert');
const nn = require('./nn_ops.js'), MG = require('./matmulnbits_gpu.js'), MR = require('./matmulnbits_ref.js'), MS = require('./moss_gpu.js'), MD = require('./moss_decoder.js');
function fakeNav(counts, failRun) {
  const dev = {
    createBuffer: (d) => { const sz = d.size; return { sz, mapAsync: async () => {}, getMappedRange: () => new ArrayBuffer(sz), unmap() {} }; },
    createShaderModule: () => { counts.modules++; return {}; },
    createComputePipeline: () => { counts.pipelines++; return { getBindGroupLayout: () => ({}) }; },
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({ beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() { counts.dispatch++; if (failRun) throw new Error('device lost'); }, end() {} }), copyBufferToBuffer() {}, finish: () => ({}) }),
    queue: { writeBuffer() {}, submit() {} },
  };
  const adapter = { requestDevice: async () => dev, features: new Set(), limits: {}, info: {}, requestAdapterInfo: async () => ({}) };
  return { gpu: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'rgba8unorm' } };
}
const rnd = (n, s) => { const a = new Float32Array(n); let x = s; for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; a[i] = (x / 4294967296) - 0.5; } return a; };
const near = (a, b, tol) => { assert.strictEqual(a.length, b.length); for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol * (1 + Math.abs(b[i])), 'idx ' + i + ': ' + a[i] + ' vs ' + b[i]); };
(async () => {
  // --- pipeline 快取 ---
  const counts = { modules: 0, pipelines: 0, dispatch: 0 }, nav = fakeNav(counts, false);
  const K = 32, N = 8, nb = MR.nBlocksOf(K), B = new Uint8Array(N * nb * 16), S = rnd(N * nb, 3).map((v) => Math.abs(v) + 0.1), A = rnd(2 * K, 5);
  const r1 = await MG.matmulNBits(A, 2, K, B, S, N, { navigator: nav });
  assert.strictEqual(r1.info.layer, 'T1', 'fake device 應走 T1：' + r1.info.reason);
  const p1 = counts.pipelines; assert.ok(p1 >= 1);
  await MG.matmulNBits(A, 2, K, B, S, N, { navigator: nav });
  assert.strictEqual(counts.pipelines, p1, 'matmulNBits 第二次呼叫不該重建 pipeline'); assert.strictEqual(counts.dispatch, 2);
  const ops = MS.makeGpuOps({ navigator: nav });
  await ops.linear(rnd(8, 1), rnd(8 * 4, 2), 8, 4, rnd(4, 3)); const p2 = counts.pipelines;
  await ops.linear(rnd(8, 4), rnd(8 * 4, 5), 8, 4, rnd(4, 6));
  await ops.layerNorm(rnd(16, 1), rnd(16, 2), rnd(16, 3)); const p3 = counts.pipelines;
  await ops.layerNorm(rnd(16, 4), rnd(16, 5), rnd(16, 6));
  assert.strictEqual(counts.pipelines, p3, 'moss 運算第二次呼叫不該重建 pipeline'); assert.ok(p3 > p2 && p2 > p1);
  assert.ok(ops.tiers.linear.T1 === 2 && ops.tiers.layerNorm.T1 === 2);
  // --- 退路：沒有 WebGPU → cpu-js，結果與參考一致 ---
  const rc = await MG.matmulNBits(A, 2, K, B, S, N, { navigator: undefined });
  assert.strictEqual(rc.info.layer, 'cpu-js'); near(rc.result, MR.matmulNBitsRef(A, 2, K, B, S, N), 1e-6);
  const cops = MS.makeGpuOps({ navigator: {} }), x = rnd(8, 7), W = rnd(8 * 4, 8), b = rnd(4, 9);
  near(await cops.linear(x, W, 8, 4, b), MD.linearCpu(x, W, 8, 4, b), 1e-6); assert.strictEqual(cops.tiers.linear['cpu-js'], 1);
  const w = rnd(768, 2), bb = rnd(768, 3), y = rnd(768, 4); near(await cops.layerNorm(y, w, bb), MD.layerNorm(y, w, bb), 1e-6);
  near(await cops.gelu(y), MD.geluCpu(y), 1e-6);
  // --- 退路：GPU 執行丟錯（裝置遺失）→ cpu-js，原因寫明「WGSL 執行失敗」 ---
  const bad = fakeNav({ modules: 0, pipelines: 0, dispatch: 0 }, true), rb = await MG.matmulNBits(A, 2, K, B, S, N, { navigator: bad });
  assert.strictEqual(rb.info.layer, 'cpu-js'); assert.ok(/WGSL 執行失敗.*device lost/.test(rb.info.reason)); near(rb.result, MR.matmulNBitsRef(A, 2, K, B, S, N), 1e-6);
  // attn_gpu 走同一個 nn.runWgsl（快取）與 tryLayers（退路）；它的 cpu-js 退路在 attn_gpu_test.js 涵蓋
  console.log('gpu_cache_fallback_test: 全部通過（pipeline 快取＋退路）');
})().catch((e) => { console.error(e); process.exit(1); });
