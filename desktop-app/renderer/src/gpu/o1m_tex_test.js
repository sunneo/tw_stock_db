'use strict';
// O1m (b)：B 放 rgba32float 貼圖的打包與檢查（先寫）：
//  1. packRgba(B, K, N)：K×N（列主序）→ 寬 N/4、高 K 的貼圖資料（每個 texel 四個 f32，x＝n÷4、y＝k、分量＝n%4）。N 不是 4 的倍數丟錯。
//  2. unpack 還原後與原矩陣逐位相同。
//  3. 維度上限：寬 N/4、高 K 都要 ≤ 8192（WebGPU 預設 maxTextureDimension2D）；超過丟錯。
// 用法：node renderer/src/gpu/o1m_tex_test.js
const assert = require('assert');
const T = require('./o1m_tex.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok   ' + name); }

check('packRgba：texel (x=n÷4, y=k) 的分量 n%4 等於 B[k][n]', () => {
  const K = 3, N = 8;
  const B = Float32Array.from({ length: K * N }, (_, i) => i + 0.5);
  const p = T.packRgba(B, K, N);
  assert.strictEqual(p.width, N / 4); assert.strictEqual(p.height, K);
  assert.strictEqual(p.data.length, (N / 4) * K * 4);
  for (let k = 0; k < K; k++) for (let n = 0; n < N; n++) {
    const x = Math.floor(n / 4), c = n % 4;
    assert.strictEqual(p.data[((k * (N / 4)) + x) * 4 + c], B[k * N + n], 'k=' + k + ' n=' + n);
  }
});
check('unpackRgba 還原後與原矩陣逐位相同', () => {
  const K = 5, N = 12;
  const B = Float32Array.from({ length: K * N }, (_, i) => Math.sin(i) * 3);
  const back = T.unpackRgba(T.packRgba(B, K, N));
  assert.strictEqual(back.length, B.length);
  for (let i = 0; i < B.length; i++) assert.ok(Object.is(back[i], B[i]), 'i=' + i);
});
check('N 不是 4 的倍數：丟錯（不悄悄補一半的 texel）', () => {
  assert.throws(() => T.packRgba(new Float32Array(3 * 6), 3, 6), /4 的倍數/);
});
check('維度上限：寬 N/4 或高 K 超過 8192 丟錯', () => {
  assert.throws(() => T.checkDims(2, 8192 * 4 + 4), /8192/);   // 寬 8193
  assert.throws(() => T.checkDims(8193, 4), /8192/);           // 高 8193
  assert.doesNotThrow(() => T.checkDims(8192, 4 * 8192));
});

console.log(passed + ' 項通過');
