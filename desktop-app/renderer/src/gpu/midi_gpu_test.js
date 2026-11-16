'use strict';
// midi_gpu.js：沒有 WebGPU 時每個運算退 cpu-js、結果與 midi_decoder 的參考完全一致，tiers 寫明原因；通過的 GPU 數值驗證見 scripts/eval/cudaweb_midi_full_gpu_check.js（真 Chrome）。
const assert = require('assert');
const MD = require('./midi_decoder.js'), G = require('./midi_gpu.js');
(async () => {
  const ops = G.makeMidiOps({ navigator: undefined });
  let s = 7; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; };
  const T = 3, X = Float32Array.from({ length: T * MD.D }, rnd), w = Float32Array.from({ length: MD.D }, () => 1 + rnd());
  assert.deepStrictEqual(Array.from(await ops.rms(X, w, T, MD.EPS)), Array.from(MD.rmsRows(X, w, T)));
  const inv = Float32Array.from({ length: 32 }, (_, i) => Math.pow(10000, -i / 32)), pos = [4, 5, 6];
  assert.deepStrictEqual(Array.from(await ops.rope(X, T, pos, inv)), Array.from(MD.rope(X, T, pos, inv)));
  const past = 4, Ln = past + T, Kc = Float32Array.from({ length: MD.H * Ln * MD.HD }, rnd), Vc = Float32Array.from({ length: MD.H * Ln * MD.HD }, rnd);
  assert.deepStrictEqual(Array.from(await ops.attn(X, Kc, Vc, T, past, Ln, MD.SCALE)), Array.from(MD.attnRef(X, Kc, Vc, T, past, Ln, MD.SCALE)));
  const g = Float32Array.from({ length: 64 }, rnd), u = Float32Array.from({ length: 64 }, rnd);
  assert.deepStrictEqual(Array.from(await ops.siluMul(g, u)), Array.from(MD.siluMulRef(g, u)));
  for (const k of ['midi_rms', 'midi_rope', 'midi_attn', 'midi_silu_mul']) assert.ok(/^cpu-js/.test(ops.tiers[k]) && /WebGPU/.test(ops.tiers[k]), k + ' ' + ops.tiers[k]);
  console.log('midi_gpu_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
