'use strict';
// conv_ops.conv2d：沒有 WebGPU 時退 cpu-js、結果與 conv2dRef 位元一致、層級原因寫明；ops.gpu===false 強制 CPU。
// 真 Basic Pitch 的 32 個 Conv 對真 ORT 與 Chrome 軟體 WebGPU：scripts/eval/cudaweb_bp_conv_dump.js、cudaweb_bp_conv_gpu_check.js。
const assert = require('assert');
const C = require('./conv_ops.js');
(async () => {
  let s = 5; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; };
  const [N, Ci, H, W, M, KH, KW] = [1, 2, 5, 6, 3, 3, 3], x = Float32Array.from({ length: N * Ci * H * W }, rnd), w = Float32Array.from({ length: M * Ci * KH * KW }, rnd), b = Float32Array.from({ length: M }, rnd);
  const p = { strides: [1, 2], pads: [1, 1, 1, 1] };
  const ref = C.conv2dRef(x, N, Ci, H, W, w, M, Ci, KH, KW, b, p), o = { navigator: undefined };
  assert.deepStrictEqual(Array.from(await C.conv2d(x, N, Ci, H, W, w, M, Ci, KH, KW, b, p, o)), Array.from(ref));
  assert.ok(/cpu-js/.test(o.lastInfo.layer) && /WebGPU/.test(o.lastInfo.reason), JSON.stringify(o.lastInfo));
  assert.deepStrictEqual(Array.from(await C.conv2d(x, N, Ci, H, W, w, M, Ci, KH, KW, b, p, { gpu: false })), Array.from(ref));
  console.log('conv_ops_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
