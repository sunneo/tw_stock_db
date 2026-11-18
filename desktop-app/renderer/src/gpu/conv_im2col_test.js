'use strict';
// R5 卷積：im2col＋矩陣乘 對 直接卷積（conv_ops.conv2dRef）的假裝置測試（先寫）：
//  1. im2col 的列序與直接卷積的累加順序相同：k' = (c·KH + kh)·KW + kw，欄 = i·Wout + j；越界為 0。
//  2. convViaIm2col（CPU）對 conv2dRef 相對誤差 ≤ 1e-5；形狀：3×3 pad 1、1×1、stride 2、dilation 2。
//  3. groups > 1 不支援（丟錯，不悄悄算錯）。
// 用法：node renderer/src/gpu/conv_im2col_test.js
const assert = require('assert');
const I = require('./conv_im2col.js');
const C = require('./conv_ops.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok   ' + name); }
function rng(seed) { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; }; }

check('im2col：列數 = C·KH·KW、欄數 = Hout·Wout；越界位置為 0', () => {
  const x = Float32Array.from({ length: 2 * 4 * 4 }, (_, i) => i + 1);   // C=2, H=W=4
  const d = I.dims(2, 4, 4, 3, 3, { pads: [1, 1, 1, 1] });
  assert.strictEqual(d.Hout, 4); assert.strictEqual(d.Wout, 4);
  assert.strictEqual(d.K, 2 * 3 * 3); assert.strictEqual(d.P, 16);
  const col = I.im2colRef(x, 2, 4, 4, 3, 3, { pads: [1, 1, 1, 1] });
  // 第 0 欄（i=0,j=0）、第 0 列（c=0,kh=0,kw=0）對應 (ih=-1, iw=-1)：越界 → 0
  assert.strictEqual(col[0 * d.P + 0], 0);
  // 第 4 列（c=0, kh=1, kw=1）、第 0 欄 對應 (0,0)：x[0] = 1
  assert.strictEqual(col[4 * d.P + 0], x[0]);
});

const shapes = [
  { name: '3×3 pad1', C: 3, H: 6, W: 5, M: 4, KH: 3, KW: 3, p: { pads: [1, 1, 1, 1] } },
  { name: '1×1', C: 8, H: 4, W: 4, M: 6, KH: 1, KW: 1, p: {} },
  { name: '3×3 stride2', C: 2, H: 9, W: 9, M: 3, KH: 3, KW: 3, p: { pads: [1, 1, 1, 1], strides: [2, 2] } },
  { name: '3×3 dilation2', C: 2, H: 8, W: 8, M: 3, KH: 3, KW: 3, p: { pads: [2, 2, 2, 2], dilations: [2, 2] } },
];
for (const sh of shapes) {
  check('convViaIm2col 對 conv2dRef 相對誤差 ≤ 1e-5：' + sh.name, () => {
    const r = rng(7 + sh.C);
    const N = 1;
    const x = Float32Array.from({ length: N * sh.C * sh.H * sh.W }, r);
    const w = Float32Array.from({ length: sh.M * sh.C * sh.KH * sh.KW }, r);
    const ref = C.conv2dRef(x, N, sh.C, sh.H, sh.W, w, sh.M, sh.C, sh.KH, sh.KW, null, sh.p);
    const got = I.convViaIm2colRef(x, N, sh.C, sh.H, sh.W, w, sh.M, sh.KH, sh.KW, sh.p);
    assert.strictEqual(got.length, ref.length);
    let mx = 0, sc = 1e-9; for (let i = 0; i < ref.length; i++) { mx = Math.max(mx, Math.abs(got[i] - ref[i])); sc = Math.max(sc, Math.abs(ref[i])); }
    assert.ok(mx / sc <= 1e-5, '相對誤差 ' + (mx / sc));
  });
}
check('groups > 1 丟錯（不支援）', () => {
  assert.throws(() => I.convViaIm2colRef(new Float32Array(16), 1, 4, 2, 2, new Float32Array(16), 4, 1, 1, { groups: 2 }), /groups/);
});
check('核心文字：im2col 的 entry、越界為 0、k′ 與欄的索引', () => {
  assert.ok(/@compute @workgroup_size\(64\)/.test(I.WGSL_IM2COL) && /select|if \(/.test(I.WGSL_IM2COL));
});

console.log(passed + ' 項通過');
