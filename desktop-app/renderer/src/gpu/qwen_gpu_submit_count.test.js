// O6 計次（假裝置、不執行核心）：qwen_gpu 的一步解碼應該是「每層一次 submit」＋最後一段（lm_head／argmax）一次，共 L+1 次。
// 做法：記錄型假裝置（建立緩衝區、綁定、派發都只記錄，submit 只計數），用小型合成模型跑 createGpuEngine().step()。
// 這不是真模型驗證（真 Qwen3-0.6B 計次標為「未用真模型驗證」）；它證明的是程式的提交結構。
// 用法：node renderer/src/gpu/qwen_gpu_submit_count.test.js
'use strict';
const assert = require('assert');
const G = require('./qwen_gpu.js');

let passed = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log('ok   ' + name); }, (e) => { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; }); }

function recordingDevice() {
  const stats = { submits: 0, dispatches: 0, encoders: 0 };
  const dev = {
    limits: { maxStorageBufferBindingSize: 128 << 20, minStorageBufferOffsetAlignment: 256 },
    lost: new Promise(() => {}),
    createBuffer({ size, usage }) { return { size, usage, data: new ArrayBuffer(Math.max(4, size)), destroy() {}, unmap() {}, mapAsync: async () => {}, getMappedRange() { return this.data; } }; },
    createShaderModule({ code }) { return { code }; },
    createComputePipeline({ compute }) { const m = /@kernel\s+(\w+)/.exec(compute.module.code); return { kernel: m ? m[1] : 'unknown', getBindGroupLayout() { return {}; } }; },
    createBindGroup({ entries }) { return { entries }; },
    createCommandEncoder() {
      stats.encoders++;
      return {
        beginComputePass() { return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() { stats.dispatches++; }, end() {} }; },
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

// 合成模型：L 層，hd=16（偶數、≤128），D=32，H=2，Hkv=2，I=48，V=40
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

(async () => {
  for (const L of [1, 3]) {
    await check('一步解碼（L=' + L + '）：submit 次數＝L+1（每層一次，最後一段 lm_head／argmax 一次）', async () => {
      const { dev, stats } = recordingDevice();
      const eng = await G.createGpuEngine(dev, synthModel(L), { maxT: 32, maxM: 8 });
      stats.submits = 0; stats.dispatches = 0;
      await eng.step([1, 2, 3], {});
      assert.strictEqual(stats.submits, L + 1, 'submit 次數');
      assert.ok(stats.dispatches > 0, '有派發');
    });
  }
  await check('兩步解碼：submit 次數與步數成正比（每步 L+1）', async () => {
    const { dev, stats } = recordingDevice();
    const eng = await G.createGpuEngine(dev, synthModel(2), { maxT: 32, maxM: 8 });
    stats.submits = 0;
    await eng.step([1], {});
    await eng.step([2], {});
    assert.strictEqual(stats.submits, 2 * (2 + 1));
  });
  console.log(passed + ' 項通過');
})();
