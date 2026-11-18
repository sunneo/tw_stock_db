// O7 計次（假裝置、不執行核心）：qwen_gpu 的 RMSNorm＋動態量化融合（rmsq1，只在解碼 M=1）應該讓每層的派發數減少。
// 解碼（M=1）：每個 rmsQuant 位置由 rms＋quant（2 次）變成 rmsq1（1 次），每層 2 個位置 → 每步少 2L 次派發。
// 預填（M>1）：融合不適用，兩種設定的派發數相同。
// 這只證明派發結構；位元相同由真 Chrome 的合成模型驗證（見 O7 清單），node 沒有 WGSL 執行環境。
// 用法：node renderer/src/gpu/qwen_gpu_fuse_count.test.js
'use strict';
const assert = require('assert');
const G = require('./qwen_gpu.js');

let passed = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log('ok   ' + name); }, (e) => { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; }); }

function recordingDevice() {
  const stats = { submits: 0, dispatches: 0, kernels: {} };
  let curPipe = null;
  const dev = {
    limits: { maxStorageBufferBindingSize: 128 << 20, minStorageBufferOffsetAlignment: 256 },
    lost: new Promise(() => {}),
    createBuffer({ size, usage }) { return { size, usage, data: new ArrayBuffer(Math.max(4, size)), destroy() {}, unmap() {}, mapAsync: async () => {}, getMappedRange() { return this.data; } }; },
    createShaderModule({ code }) { return { code }; },
    createComputePipeline({ compute }) { const m = /@kernel\s+(\w+)/.exec(compute.module.code); return { kernel: m ? m[1] : 'unknown', getBindGroupLayout() { return {}; } }; },
    createBindGroup({ entries }) { return { entries }; },
    createCommandEncoder() {
      return {
        beginComputePass() { return { setPipeline(p) { curPipe = p; }, setBindGroup() {}, dispatchWorkgroups() { stats.dispatches++; }, end() {} }; },
        copyBufferToBuffer() {},
        finish() { return {}; },
      };
    },
    queue: {
      writeBuffer() {},
      submit() { stats.submits++; },
      onSubmittedWorkDone: async () => {},
    },
  };
  return { dev, stats };
}

// 合成模型（與 qwen_gpu_submit_count.test.js 相同尺寸）
function synthModel(L) {
  const D = 32, H = 2, Hkv = 2, hd = 16, I = 48, V = 40;
  const u8 = (n) => new Uint8Array(n).fill(128);
  const f32 = (n) => new Float32Array(n).fill(1);
  const mat = (K, N) => ({ W: u8(K * N), zp: 128, scale: 0.01, K, N });
  const layers = [];
  for (let l = 0; l < L; l++) {
    layers.push({
      inNorm: f32(D), postNorm: f32(D), qNorm: f32(hd), kNorm: f32(hd),
      q: mat(D, H * hd), k: mat(D, Hkv * hd), v: mat(D, Hkv * hd), o: mat(H * hd, D),
      g: mat(D, I), u: mat(D, I), d: mat(I, D),
    });
  }
  return {
    D, H, Hkv, hd, I, V, L, eps: 1e-6, finalNorm: f32(D),
    emb: { W: u8(V * D), zp: 128, scale: 0.01 },
    embedRows(ids) { return new Float32Array(ids.length * D).fill(0.1); },
    layers,
  };
}

// 建引擎後量一步的派發數（只計 stepOnce 那一步）
async function stepDispatches(L, fuse, ids) {
  const { dev, stats } = recordingDevice();
  const eng = await G.createGpuEngine(dev, synthModel(L), { maxT: 32, maxM: 8, fuseRmsQuant: fuse });
  stats.dispatches = 0;
  await eng.step(ids, {});
  return stats.dispatches;
}

(async () => {
  for (const L of [1, 3]) {
    await check('解碼（M=1，L=' + L + '）：融合開啟比關閉每步少 2L 次派發', async () => {
      const on = await stepDispatches(L, true, [1]);
      const off = await stepDispatches(L, false, [1]);
      assert.strictEqual(off - on, 2 * L, '關閉 ' + off + ' 次，開啟 ' + on + ' 次');
    });
  }
  await check('預填（M=3，L=2）：融合開啟與關閉派發數相同（融合只給解碼）', async () => {
    const on = await stepDispatches(2, true, [1, 2, 3]);
    const off = await stepDispatches(2, false, [1, 2, 3]);
    assert.strictEqual(on, off);
  });
  await check('預設（不傳選項）＝融合開啟，與明確傳 true 相同', async () => {
    const { dev, stats } = recordingDevice();
    const eng = await G.createGpuEngine(dev, synthModel(2), { maxT: 32, maxM: 8 });
    stats.dispatches = 0; await eng.step([1], {});
    const explicit = await stepDispatches(2, true, [1]);
    assert.strictEqual(stats.dispatches, explicit);
  });
  console.log(passed + ' 項通過');
})();
