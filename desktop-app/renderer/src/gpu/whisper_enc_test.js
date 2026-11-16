'use strict';
// whisper_enc／whisper_gpu：DynamicQuantizeLinear 的規格值、整數矩陣乘與 LN／GELU／注意力的參考，以及沒有 WebGPU 時 GPU 版運算退 cpu-js 且與參考一致。
// 真模型與真 ORT、真 Chrome 的對拍見 scripts/eval/cudaweb_whisper_check.js／cudaweb_whisper_trace.js／cudaweb_whisper_gpu_check.js。
const assert = require('assert');
const WE = require('./whisper_enc.js'), G = require('./whisper_gpu.js');
(async () => {
  // DQL：x ∈ [-1, 2] → scale = 3/255、zp = 85；回傳 q−zp
  const d = WE.dql(Float32Array.from([-1, 0, 2, 0.5]));
  assert.ok(Math.abs(d.scale - 3 / 255) < 1e-7);
  assert.deepStrictEqual(Array.from(d.xs), [-85, 0, 170, 42]);
  assert.strictEqual(WE.dql(new Float32Array(4)).scale, 0); // 全零不丟錯
  // 整數矩陣乘：[[1,2],[3,4]]·[[1,0],[0,-1]]·0.5 + bias
  const y = WE.mmRef(Float32Array.from([1, 2, 3, 4]), 2, 2, Float32Array.from([1, 0, 0, -1]), 2, 0.5, Float32Array.from([10, 20]));
  assert.deepStrictEqual(Array.from(y), [10.5, 19, 11.5, 18]);
  // erf／GELU：gelu(0)=0、gelu(1)≈0.8413447、gelu(-1)≈-0.1586553
  const g = WE.geluRef(Float32Array.from([0, 1, -1]));
  assert.ok(Math.abs(g[0]) < 1e-9 && Math.abs(g[1] - 0.8413447) < 1e-6 && Math.abs(g[2] + 0.1586553) < 1e-6);
  // 沒有 WebGPU：每個運算退 cpu-js，結果與參考一致
  const ops = G.makeWhisperOps({ navigator: undefined });
  const X = Float32Array.from({ length: 2 * 512 }, (_, i) => Math.sin(i)), w = new Float32Array(512).fill(1), b = new Float32Array(512);
  assert.deepStrictEqual(Array.from(await ops.ln(X, 2, w, b)), Array.from(WE.lnRef(X, 2, w, b)));
  assert.deepStrictEqual(Array.from(await ops.gelu(X)), Array.from(WE.geluRef(X)));
  assert.deepStrictEqual(Array.from(await ops.mm(Float32Array.from([1, 2]), 1, 2, Float32Array.from([3, 4]), 1, 1, null)), [11]);
  const q = Float32Array.from({ length: 4 * 512 }, (_, i) => Math.cos(i) * 0.1);
  assert.deepStrictEqual(Array.from(await ops.attn(q, q, q, 4)), Array.from(WE.attnRef(q, q, q, 4)));
  for (const k of ['whisper_ln', 'whisper_gelu', 'whisper_mm', 'whisper_attn']) assert.ok(/^cpu-js/.test(ops.tiers[k]) && /WebGPU/.test(ops.tiers[k]), k + ' ' + ops.tiers[k]);
  console.log('whisper_enc_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
