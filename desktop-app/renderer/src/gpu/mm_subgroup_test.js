'use strict';
// mm_subgroup（子群組矩陣乘，小 M 用）的假裝置測試（先寫）：
//  1. 核心文字：必須宣告 enable subgroups、用 subgroupAdd、用 subgroup_invocation_id／subgroup_size；不得在非均勻控制流程裡呼叫子群組運算。
//  2. 演算法：用 CPU 模擬「子群組大小 S」的 lane 歸約（與 WGSL 同一順序），對 matmulRef 的相對誤差 ≤ 1e-5；S 取 8、16、32 都要過。
//  3. 能力規則：kernel_select 只在 subgroups=true 時選它；沒有子群組時退回既有變體。
// 用法：node renderer/src/gpu/mm_subgroup_test.js
const assert = require('assert');
const SG = require('./mm_subgroup.js');
const KS = require('./kernel_select.js');
const MM = require('./mm_ops.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok   ' + name); }

check('核心文字：enable subgroups、subgroupAdd、subgroup_invocation_id、subgroup_size、num_workgroups', () => {
  const code = SG.WGSL_MM_SUBGROUP;
  assert.ok(/enable subgroups;/.test(code), '缺 enable subgroups');
  assert.ok(/subgroupAdd\(/.test(code), '缺 subgroupAdd');
  assert.ok(/subgroup_invocation_id/.test(code) && /subgroup_size/.test(code), '缺 subgroup 內建值');
  assert.ok(/num_workgroups/.test(code), '缺 num_workgroups（網格跨步）');
});

check('核心文字：子群組運算只在均勻的控制流程裡（外層迴圈的變數是 workgroup／subgroup 均勻的）', () => {
  // 結構檢查：k 的迴圈以均勻的 base 為變數，lane 差異只放在 if 裡
  assert.ok(/for \(var base: u32 = 0u; base < p\.K; base = base \+ ssz\)/.test(SG.WGSL_MM_SUBGROUP), 'k 迴圈應以均勻的 base 跨步');
  assert.ok(/if \(k < p\.K\)/.test(SG.WGSL_MM_SUBGROUP), 'lane 的界限應放在 if 裡');
});

// CPU 模擬：S 個 lane 的子群組，每個輸出元素一個子群組；lane l 累加 k = base + l（base 每次跨 S），再做 S 路的 subgroupAdd（依 lane 順序加總）。
function simulate(A, B, M, K, N, S) {
  const Y = new Float32Array(M * N);
  for (let o = 0; o < M * N; o++) {
    const m = Math.floor(o / N), n = o % N;
    const lanes = new Float32Array(S);
    for (let base = 0; base < K; base += S) {
      for (let l = 0; l < S; l++) { const k = base + l; if (k < K) lanes[l] = Math.fround(lanes[l] + Math.fround(A[m * K + k] * B[k * N + n])); }
    }
    let s = 0; for (let l = 0; l < S; l++) s = Math.fround(s + lanes[l]);
    Y[o] = s;
  }
  return Y;
}
function rnd(seed) { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; }; }
for (const S of [8, 16, 32]) {
  check('演算法（模擬子群組大小 ' + S + '）：對 matmulRef 相對誤差 ≤ 1e-5', () => {
    const r = rnd(S * 3 + 1);
    for (const [M, K, N] of [[1, 1024, 1024], [1, 300, 132], [4, 257, 68], [8, 1024, 96]]) {
      const A = Float32Array.from({ length: M * K }, r), B = Float32Array.from({ length: K * N }, r);
      const ref = MM.matmulRef(A, [M, K], B, [K, N]).y;
      const got = simulate(A, B, M, K, N, S);
      let mx = 0, sc = 1e-9; for (let i = 0; i < got.length; i++) { mx = Math.max(mx, Math.abs(got[i] - ref[i])); sc = Math.max(sc, Math.abs(ref[i])); }
      assert.ok(mx / sc <= 1e-5, M + 'x' + K + 'x' + N + ' 相對誤差 ' + (mx / sc));
    }
  });
}

check('能力規則：M=1 且 K<1024、有 subgroups → mm_subgroup_f32；沒有 subgroups → 不選（退回 simple）', () => {
  const caps = Object.assign({}, KS.DEFAULT_CAPS, { probed: true, maxWorkgroupStorage: 32 * 1024, maxInvocations: 1024, maxWorkgroupSizeX: 1024, hasF16: true, hasSubgroups: true });
  const withSg = KS.pickVariant('matmul', { M: 1, K: 300, N: 132 }, caps, null);
  const noSg = KS.pickVariant('matmul', { M: 1, K: 300, N: 132 }, Object.assign({}, caps, { hasSubgroups: false }), null);
  assert.strictEqual(withSg.id, 'mm_subgroup_f32');
  assert.notStrictEqual(noSg.id, 'mm_subgroup_f32', '沒有子群組不可選');
  assert.strictEqual(noSg.id, 'mm_simple_f32');
});
check('能力規則：M=1 且 K≥1024 → mm_splitk_f32（不需要子群組）；M=8 不選 split-K', () => {
  const caps = Object.assign({}, KS.DEFAULT_CAPS, { probed: true, maxWorkgroupStorage: 32 * 1024, maxInvocations: 1024, maxWorkgroupSizeX: 1024, hasF16: true, hasSubgroups: true });
  assert.strictEqual(KS.pickVariant('matmul', { M: 1, K: 1024, N: 1024 }, caps, null).id, 'mm_splitk_f32');
  assert.strictEqual(KS.pickVariant('matmul', { M: 1, K: 1024, N: 1024 }, KS.DEFAULT_CAPS, null).id, 'mm_splitk_f32');
  assert.notStrictEqual(KS.pickVariant('matmul', { M: 8, K: 1024, N: 1024 }, caps, null).id, 'mm_splitk_f32');
});

console.log(passed + ' 項通過');
