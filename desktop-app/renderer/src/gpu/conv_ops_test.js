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
  // 轉置卷積：與「散佈／直接定義」交叉驗證（步幅 2、pads、output_padding、groups=2）；沒有 WebGPU 退 cpu-js 且一致
  {
    const [n, c, h, ww, mg, kh, kw, g] = [1, 4, 3, 4, 2, 3, 2, 2], xx = Float32Array.from({ length: n * c * h * ww }, rnd), wt = Float32Array.from({ length: c * mg * kh * kw }, rnd), bb = Float32Array.from({ length: mg * g }, rnd);
    const pt = { strides: [2, 2], pads: [1, 0, 0, 1], dilations: [1, 1], groups: g, outputPadding: [1, 0] }, oo = { navigator: undefined };
    const r = C.convT2dRef(xx, n, c, h, ww, wt, mg * g, kh, kw, bb, pt), d = C.convT2dDims(h, ww, kh, kw, pt);
    assert.strictEqual(r.length, n * mg * g * d.Hout * d.Wout);
    // 轉置卷積是卷積的伴隨：<convT(x), z> == <x, conv(z)>（無偏置，同參數；conv 的 w 佈局 [C, M/g...] 對應）
    const wz = Float32Array.from({ length: n * mg * g * d.Hout * d.Wout }, rnd), r0 = C.convT2dRef(xx, n, c, h, ww, wt, mg * g, kh, kw, null, pt);
    const cv = C.conv2dRef(wz, n, mg * g, d.Hout, d.Wout, wt, c, mg, kh, kw, null, { strides: [2, 2], pads: [1, 0, 0, 1], groups: g });
    let a1 = 0, a2 = 0; for (let i = 0; i < r0.length; i++) a1 += r0[i] * wz[i]; for (let i = 0; i < xx.length; i++) a2 += xx[i] * cv[i];
    assert.ok(Math.abs(a1 - a2) < 1e-4 * Math.max(1, Math.abs(a1)), '伴隨關係 ' + a1 + ' vs ' + a2);
    assert.deepStrictEqual(Array.from(await C.convT2d(xx, n, c, h, ww, wt, mg * g, kh, kw, bb, pt, oo)), Array.from(r));
    assert.ok(/cpu-js/.test(oo.lastInfo.layer), JSON.stringify(oo.lastInfo));
  }
  // 整數卷積：手算小例（x=[3,5,7]，零點 1；w=[2,4]，零點 2；pads [1,0]）
  {
    const y = C.convInt1dRef(Uint8Array.from([3, 5, 7]), 1, 1, 3, Uint8Array.from([2, 4]), 1, 1, 2, 1, 2, { pads: [1, 0] });
    // 位置 t：k=0 取 x[t-1]，k=1 取 x[t]；(x-1)*(w-2)：w-2 = [0,2]
    assert.deepStrictEqual(Array.from(y), [2 * (3 - 1), 2 * (5 - 1), 2 * (7 - 1)]);
    const oo = { navigator: undefined };
    assert.deepStrictEqual(Array.from(await C.convInt1d(Uint8Array.from([3, 5, 7]), 1, 1, 3, Uint8Array.from([2, 4]), 1, 1, 2, 1, 2, { pads: [1, 0] }, oo)), Array.from(y));
  }
  console.log('conv_ops_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
