'use strict';
// R5 MatMulNBits：decode（M=1）的 split-K 假裝置測試（先寫）：
//  1. 切分：切片範圍以 256 為單位對齊（dec 核心每次前進 256 個 k），涵蓋 [0,K)，不重疊。
//  2. simulate（與部分核心＋歸約相同的切片與順序）對 matmulnbits_ref.matmulNBitsRef 相對誤差 ≤ 1e-5；S 取 1、2、4、8。
//  3. 核心文字：部分核心（workgroup 256、wid.z 為切片）與歸約核心。
//  4. 規則：只在 M=1 適用（其餘退回既有核心）。
// 用法：node renderer/src/gpu/matmulnbits_splitk_test.js
const assert = require('assert');
const SK = require('./matmulnbits_splitk.js');
const REF = require('./matmulnbits_ref.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok   ' + name); }
function rng(seed) { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; }; }

check('切分：切片以 256 對齊、涵蓋 [0,K)、不重疊', () => {
  for (const [K, S] of [[1024, 4], [4096, 8], [1000, 4], [256, 4]]) {
    const rs = SK.sliceRanges(K, S);
    assert.strictEqual(rs.length, S);
    let pos = 0;
    for (const [a, b] of rs) { assert.strictEqual(a, pos); assert.ok(a % 256 === 0 || a === K); pos = b; }
    assert.strictEqual(pos, K);
  }
});
check('規則：只在 M=1 適用', () => {
  assert.ok(SK.applies(1, 1024, 3072));
  assert.strictEqual(SK.applies(2, 1024, 3072), false);
});
for (const S of [1, 2, 4, 8]) {
  check('simulate（S=' + S + '）對 matmulNBitsRef 相對誤差 ≤ 1e-5（M=1，K=1024、N=40）', () => {
    const r = rng(11 + S);
    const M = 1, K = 1024, N = 40;
    const A = Float32Array.from({ length: M * K }, r);
    const nb = REF.nBlocksOf(K);
    const q = Uint8Array.from({ length: N * nb * 16 }, () => (r() * 1000 + 128) & 255);
    const scales = Float32Array.from({ length: N * nb }, () => 0.01 + Math.abs(r()) * 0.02);
    const ref = REF.matmulNBitsRef(A, M, K, q, scales, N);
    const got = SK.simulate(A, M, K, q, scales, N, S);
    let mx = 0, sc = 1e-9; for (let i = 0; i < ref.length; i++) { mx = Math.max(mx, Math.abs(got[i] - ref[i])); sc = Math.max(sc, Math.abs(ref[i])); }
    assert.ok(mx / sc <= 1e-5, '相對誤差 ' + (mx / sc));
  });
}
check('核心文字：部分核心（workgroup 256、wid.z 為切片）與歸約核心', () => {
  assert.ok(/@workgroup_size\(256\)/.test(SK.WGSL_NB_SPLITK_PARTIAL) && /wid\.z/.test(SK.WGSL_NB_SPLITK_PARTIAL));
  assert.ok(/@workgroup_size\(64\)/.test(SK.WGSL_NB_SPLITK_REDUCE));
});

console.log(passed + ' 項通過');
