'use strict';
// mm_splitk（R3 split-K，小 M、大 K）的假裝置測試（先寫）：
//  1. K 的切分：每個切片連續、不重疊、涵蓋 [0,K)，切片數 S 可以大於 K（多出來的切片是空的）。
//  2. 演算法（CPU 模擬兩段核心：部分和＋歸約）對 matmulRef 相對誤差 ≤ 1e-5；S 取 1、2、4、7 都要過。
//  3. 核心文字：部分和核心與歸約核心各有一個 entry、用 workgroup_id.y 選切片、歸約核心跨切片加總。
// 用法：node renderer/src/gpu/mm_splitk_test.js
const assert = require('assert');
const SK = require('./mm_splitk.js');
const MM = require('./mm_ops.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok   ' + name); }

check('切片數規則：K ≥ 1024 切 8 片；K 小於 1024 不切（與量測結果一致）', () => {
  assert.strictEqual(SK.pickSplits(1024), 8);
  assert.strictEqual(SK.pickSplits(8192), 8);
  assert.strictEqual(SK.pickSplits(300), 1);
});

check('切分：各切片連續、不重疊、涵蓋 [0,K)；S 大於 K 時多出來的切片為空', () => {
  for (const [K, S] of [[1024, 4], [1000, 4], [5, 7], [4096, 16], [1, 1]]) {
    const rs = SK.sliceRanges(K, S);
    assert.strictEqual(rs.length, S);
    let pos = 0;
    for (const [a, b] of rs) { assert.strictEqual(a, pos, '應連續'); assert.ok(b >= a); pos = b; }
    assert.strictEqual(pos, K, '應涵蓋 K');
  }
});

check('核心文字：部分和核心與歸約核心都有、用 workgroup_id.y 選切片、歸約跨切片加總', () => {
  const p = SK.WGSL_SPLITK_PARTIAL, r = SK.WGSL_SPLITK_REDUCE;
  assert.ok(/@compute @workgroup_size\(256\)/.test(p) && /workgroup_id/.test(p) && /\bs\b.*wid\.y|wid\.y/.test(p), '部分和核心應以 wid.y 選切片');
  assert.ok(/@compute @workgroup_size\(256\)/.test(r) && /for \(var s: u32 = 0u; s < p\.S/.test(r), '歸約核心應跨切片迴圈');
});

for (const S of [1, 2, 4, 7]) {
  check('演算法（S=' + S + '）：部分和＋歸約 對 matmulRef 相對誤差 ≤ 1e-5', () => {
    let seed = 7 * S + 3; const r = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 - 0.5; };
    for (const [M, K, N] of [[1, 4096, 300], [2, 1024, 70], [8, 1000, 33]]) {
      const A = Float32Array.from({ length: M * K }, r), B = Float32Array.from({ length: K * N }, r);
      const ref = MM.matmulRef(A, [M, K], B, [K, N]).y;
      const got = SK.simulate(A, B, M, K, N, S);
      let mx = 0, sc = 1e-9; for (let i = 0; i < got.length; i++) { mx = Math.max(mx, Math.abs(got[i] - ref[i])); sc = Math.max(sc, Math.abs(ref[i])); }
      assert.ok(mx / sc <= 1e-5, M + 'x' + K + 'x' + N + ' 相對誤差 ' + (mx / sc));
    }
  });
}

// R4：工作群組大小變體（128、192、256）
for (const WG of [128, 192, 256]) {
  check('R4 工作群組大小 ' + WG + '：核心的 workgroup_size 與 n 的計算都換成 ' + WG + '，派發為 ⌈N/' + WG + '⌉', () => {
    const p = SK.partialWgsl(WG), r = SK.reduceWgsl(WG);
    assert.ok(p.indexOf('@workgroup_size(' + WG + ')') >= 0 && p.indexOf('wid.x * ' + WG + 'u') >= 0, '部分和核心');
    assert.ok(r.indexOf('@workgroup_size(' + WG + ')') >= 0 && r.indexOf('wid.x * ' + WG + 'u') >= 0, '歸約核心');
    if (WG !== 256) assert.ok(p.indexOf('@workgroup_size(256)') < 0, '不應殘留 256');
    assert.deepStrictEqual(SK.dispatchPartialWG(1, 1000, 8, WG), [Math.ceil(1000 / WG), 8, 1]);
    assert.deepStrictEqual(SK.dispatchReduceWG(1, 1000, WG), [Math.ceil(1000 / WG), 1, 1]);
  });
}
check('R4：不合法的工作群組大小丟錯（0、300、非整數）', () => {
  assert.throws(() => SK.withWorkgroup(SK.WGSL_SPLITK_PARTIAL, 0), /工作群組大小/);
  assert.throws(() => SK.withWorkgroup(SK.WGSL_SPLITK_PARTIAL, 300), /工作群組大小/);
  assert.throws(() => SK.withWorkgroup(SK.WGSL_SPLITK_PARTIAL, 128.5), /工作群組大小/);
});

console.log(passed + ' 項通過');
