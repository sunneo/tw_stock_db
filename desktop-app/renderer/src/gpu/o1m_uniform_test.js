'use strict';
// O1m (c) rope 表與偏置放 uniform 的假裝置測試（先寫）：
//  1. packVec4：偏置向量打包成 vec4 陣列（uniform 的陣列元素要 16 位元組對齊）；長度不是 4 的倍數時補 0；超過 uniform 上限（64 KiB）丟錯。
//  2. ropeTable(T, hd, base)：第 t 列第 i 組的 cos、sin 與公式 cos(t·base^(−2i/hd))、sin(...) 相同；超過 uniform 上限丟錯。
//  3. 規格：uniform 上限 64 KiB（WebGPU 預設 maxUniformBufferBindingSize）。
// 用法：node renderer/src/gpu/o1m_uniform_test.js
const assert = require('assert');
const U = require('./o1m_uniform.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok   ' + name); }

check('packVec4：4 的倍數原樣打包；非 4 的倍數補 0；長度與 vec4 數一致', () => {
  const p = U.packVec4(Float32Array.from([1, 2, 3, 4, 5]));
  assert.strictEqual(p.length, 8, '5 個元素要補到 8（2 個 vec4）');
  assert.deepStrictEqual(Array.from(p), [1, 2, 3, 4, 5, 0, 0, 0]);
});
check('packVec4：超過 uniform 上限（64 KiB）丟錯，不悄悄截斷', () => {
  assert.throws(() => U.packVec4(new Float32Array(16384 + 4)), /uniform 上限/);
  assert.doesNotThrow(() => U.packVec4(new Float32Array(16384)));
});
check('ropeTable：與公式 cos(t·base^(−2i/hd))、sin(...) 相同（半個維度的組數 = hd/2）', () => {
  const T = 5, hd = 8, base = 10000;
  const tab = U.ropeTable(T, hd, base);
  assert.strictEqual(tab.cos.length, T * (hd / 2));
  for (let t = 0; t < T; t++) for (let i = 0; i < hd / 2; i++) {
    const th = t * Math.pow(base, -2 * i / hd);
    assert.ok(Math.abs(tab.cos[t * (hd / 2) + i] - Math.cos(th)) < 1e-6, 'cos t=' + t + ' i=' + i);
    assert.ok(Math.abs(tab.sin[t * (hd / 2) + i] - Math.sin(th)) < 1e-6, 'sin t=' + t + ' i=' + i);
  }
});
check('ropeTable：t=0 時 cos=1、sin=0（恆等）', () => {
  const tab = U.ropeTable(3, 4, 10000);
  for (let i = 0; i < 2; i++) { assert.strictEqual(tab.cos[i], 1); assert.strictEqual(tab.sin[i], 0); }
});
check('ropeTable：uniform 上限：cos 與 sin 各自超過 64 KiB 就丟錯（T·hd/2·4 位元組）', () => {
  assert.throws(() => U.ropeTable(1024, 128, 10000), /uniform 上限/);   // 1024·64·4 = 256 KiB
  assert.doesNotThrow(() => U.ropeTable(64, 64, 10000));                 // 64·32·4 = 8 KiB
});

console.log(passed + ' 項通過');
