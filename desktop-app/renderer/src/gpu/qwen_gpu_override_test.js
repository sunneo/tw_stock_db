// O12c 覆寫集合（假裝置、只計派發，不執行核心）：
//  1. 覆寫登錄表 OVERRIDES 與 overrideOn：預設開；opts.fuseRmsQuant:false 或 opts.useOverrides:false 可關；未知名稱丟錯。
//  2. useOverrides:false 的派發數 = fuseRmsQuant:false 的派發數（總開關確實關掉覆寫），預設 = fuseRmsQuant 開啟（行為不變）。
//  3. 描述表 archMatches：權重尺寸與描述表不符時 createGpuEngine 在開頭就丟錯（不悄悄算錯）。
// 位元相同與速度不在這裡量（node 沒有 WGSL 執行環境）；速度見清單 O12c 的「未量」說明。
// 用法：node renderer/src/gpu/qwen_gpu_override_test.js
'use strict';
const assert = require('assert');
const G = require('./qwen_gpu.js');
const A = require('./llm_arch.js');

let passed = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log('ok   ' + name); }, (e) => { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; }); }

function recordingDevice() {
  const stats = { submits: 0, dispatches: 0 };
  const dev = {
    limits: { maxStorageBufferBindingSize: 128 << 20, minStorageBufferOffsetAlignment: 256 },
    lost: new Promise(() => {}),
    createBuffer({ size, usage }) { return { size, usage, data: new ArrayBuffer(Math.max(4, size)), destroy() {}, unmap() {}, mapAsync: async () => {}, getMappedRange() { return this.data; } }; },
    createShaderModule({ code }) { return { code }; },
    createComputePipeline({ compute }) { return { getBindGroupLayout() { return {}; } }; },
    createBindGroup({ entries }) { return { entries }; },
    createCommandEncoder() {
      return {
        beginComputePass() { return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() { stats.dispatches++; }, end() {} }; },
        copyBufferToBuffer() {}, finish() { return {}; },
      };
    },
    queue: { writeBuffer() {}, submit() { stats.submits++; }, onSubmittedWorkDone: async () => {} },
  };
  return { dev, stats };
}

// 合成模型（與 qwen_gpu_fuse_count.test.js 相同尺寸）
function synthModel(L) {
  const D = 32, H = 2, Hkv = 2, hd = 16, I = 48, V = 40;
  const u8 = (n) => new Uint8Array(n).fill(128);
  const f32 = (n) => new Float32Array(n).fill(1);
  const mat = (K, N) => ({ W: u8(K * N), zp: 128, scale: 0.01, K, N });
  const layers = [];
  for (let l = 0; l < L; l++) {
    layers.push({ inNorm: f32(D), postNorm: f32(D), qNorm: f32(hd), kNorm: f32(hd),
      q: mat(D, H * hd), k: mat(D, Hkv * hd), v: mat(D, Hkv * hd), o: mat(H * hd, D), g: mat(D, I), u: mat(D, I), d: mat(I, D) });
  }
  return { D, H, Hkv, hd, I, V, L, eps: 1e-6, finalNorm: f32(D), emb: { W: u8(V * D), zp: 128, scale: 0.01 },
    embedRows(ids) { return new Float32Array(ids.length * D).fill(0.1); }, layers };
}
async function decodeDispatches(L, opts) {
  const { dev, stats } = recordingDevice();
  const eng = await G.createGpuEngine(dev, synthModel(L), Object.assign({ maxT: 32, maxM: 8 }, opts || {}));
  stats.dispatches = 0;
  await eng.step([1], {});
  return stats.dispatches;
}

(async () => {
  await check('覆寫登錄表：rmsq1 存在、預設開；fuseRmsQuant:false 或 useOverrides:false 可關；未知名稱丟錯', () => {
    assert.ok(G.OVERRIDES && G.OVERRIDES.rmsq1, '應有 rmsq1');
    assert.strictEqual(G.overrideOn('rmsq1', {}), true);
    assert.strictEqual(G.overrideOn('rmsq1', null), true);
    assert.strictEqual(G.overrideOn('rmsq1', { fuseRmsQuant: false }), false);
    assert.strictEqual(G.overrideOn('rmsq1', { useOverrides: false }), false);
    assert.strictEqual(G.overrideOn('rmsq1', { useOverrides: false, fuseRmsQuant: true }), false, '總開關優先');
    assert.throws(() => G.overrideOn('nope', {}), /沒有這個覆寫/);
  });
  for (const L of [1, 3]) {
    await check('預設（不給覆寫選項）＝融合開啟：派發數與 fuseRmsQuant:true 相同（L=' + L + '）', async () => {
      const def = await decodeDispatches(L, {});
      const on = await decodeDispatches(L, { fuseRmsQuant: true });
      assert.strictEqual(def, on);
    });
    await check('useOverrides:false ＝ 覆寫全關：派發數與 fuseRmsQuant:false 相同，且比預設多 2L 次（L=' + L + '）', async () => {
      const off = await decodeDispatches(L, { useOverrides: false });
      const fuseOff = await decodeDispatches(L, { fuseRmsQuant: false });
      const def = await decodeDispatches(L, {});
      assert.strictEqual(off, fuseOff);
      assert.strictEqual(off - def, 2 * L);
    });
  }
  await check('描述表 archMatches：Qwen3 0.6B 的描述與同尺寸權重相符；尺寸不符列出是哪一項', () => {
    const d = A.FAMILIES['qwen3-0.6b'];
    const W = { D: 1024, H: 16, Hkv: 8, hd: 128, I: 3072, V: 151936, L: 28, eps: 1e-6 };
    assert.deepStrictEqual(G.archMatches(d, W), []);
    const bad = G.archMatches(d, Object.assign({}, W, { D: 32, L: 2 }));
    assert.strictEqual(bad.length, 2);
    assert.ok(bad.some((s) => /^D /.test(s)) && bad.some((s) => /^L /.test(s)), bad.join('；'));
  });
  await check('createGpuEngine：opts.arch 與權重不符時開頭就丟錯（不進入派發）', async () => {
    const { dev, stats } = recordingDevice();
    await assert.rejects(() => G.createGpuEngine(dev, synthModel(1), { maxT: 32, maxM: 8, arch: A.FAMILIES['qwen3-0.6b'] }), /描述表與權重不符/);
    assert.strictEqual(stats.submits, 0);
  });
  await check('createGpuEngine：opts.arch 與權重相符時照常建立（只計建立，不跑步）', async () => {
    const m = synthModel(1);
    const arch = { family: 'qwen3', status: 'supported', hidden: m.D, heads: m.H, kvHeads: m.Hkv, headDim: m.hd, ffn: m.I, vocab: m.V, layers: m.L, eps: m.eps };
    const { dev } = recordingDevice();
    const eng = await G.createGpuEngine(dev, m, { maxT: 32, maxM: 8, arch: arch });
    assert.ok(eng && typeof eng.step === 'function');
  });
  console.log(passed + ' 項通過');
})();
