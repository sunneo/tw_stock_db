'use strict';
// R4：平鋪矩陣乘的工作群組大小變體（先寫的假裝置測試）：
//  1. 幾何：TM×TN 的輸出塊、WG 個執行緒；每個執行緒的暫存器區塊 RB = TM·TN/WG 必須是整數（不整除就丟錯）。
//  2. 核心文字：workgroup_size(WG)、共用記憶體大小 TM·KB 與 KB·TN、RB 個累加器、邊界檢查。
//  3. 演算法（CPU 模擬同一個分塊順序）對 matmulRef 相對誤差 ≤ 1e-5，WG 取 128、192、256 都要過（同一個 48×64 塊）。
// 用法：node renderer/src/gpu/mm_tile_wg_test.js
const assert = require('assert');
const TW = require('./mm_tile_wg.js');
const MM = require('./mm_ops.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok   ' + name); }

check('幾何：RB = TM·TN/WG；不整除丟錯（例：48×64 與 WG=100）', () => {
  assert.strictEqual(TW.geometry(48, 64, 128).RB, 24);
  assert.strictEqual(TW.geometry(48, 64, 192).RB, 16);
  assert.strictEqual(TW.geometry(48, 64, 256).RB, 12);
  assert.throws(() => TW.geometry(48, 64, 100), /整除|RB/);
  assert.throws(() => TW.geometry(48, 64, 0), /工作群組/);
});
check('核心文字：workgroup_size(WG)、共用記憶體大小、RB 個累加器、邊界檢查', () => {
  const code = TW.wgsl(48, 64, 16, 192);
  assert.ok(code.indexOf('@workgroup_size(192)') >= 0);
  assert.ok(code.indexOf('array<f32, 768>') >= 0, 'As 應為 TM·KB = 48·16 = 768');
  assert.ok(code.indexOf('array<f32, 1024>') >= 0, 'Bs 應為 KB·TN = 16·64 = 1024');
  assert.ok(code.indexOf('var acc: array<f32, 16>') >= 0, 'RB = 16 個累加器');
  assert.ok(/gr < p\.M/.test(code) && /gc < p\.N/.test(code), '邊界檢查');
});
check('演算法（CPU 模擬同一個分塊順序）對 matmulRef 相對誤差 ≤ 1e-5（WG = 128、192、256）', () => {
  let seed = 9; const r = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 - 0.5; };
  for (const WG of [128, 192, 256]) for (const [M, K, N] of [[64, 100, 70], [50, 1024, 130]]) {
    const A = Float32Array.from({ length: M * K }, r), B = Float32Array.from({ length: K * N }, r);
    const ref = MM.matmulRef(A, [M, K], B, [K, N]).y;
    const got = TW.simulate(A, B, M, K, N, 48, 64, 16, WG);
    let mx = 0, sc = 1e-9; for (let i = 0; i < got.length; i++) { mx = Math.max(mx, Math.abs(got[i] - ref[i])); sc = Math.max(sc, Math.abs(ref[i])); }
    assert.ok(mx / sc <= 1e-5, 'WG=' + WG + ' ' + M + 'x' + K + 'x' + N + ' 相對誤差 ' + (mx / sc));
  }
});

// R2：軟體預取（雙緩衝）變體
check('R2 預取：共用記憶體兩份（2·TM·KB、2·KB·TN）、暫存器搬運（ra、rb）、以 kidx 的奇偶選緩衝區、每個 K 塊只一次屏障', () => {
  const c = TW.wgslPrefetch(48, 64, 16, 256);
  assert.ok(c.indexOf('array<f32, 1536>') >= 0, 'As 應為 2·48·16 = 1536');
  assert.ok(c.indexOf('array<f32, 2048>') >= 0, 'Bs 應為 2·16·64 = 2048');
  assert.ok(c.indexOf('var ra: array<f32, 3>') >= 0 && c.indexOf('var rb: array<f32, 4>') >= 0, 'NA=3、NB=4（WG 256）');
  assert.ok(/kidx & 1u/.test(c), '奇偶緩衝區');
  assert.strictEqual((c.match(/workgroupBarrier\(\)/g) || []).length, 1, '每個 K 塊只一個屏障（雙緩衝）');
});
// 注意：預取與不預取的位元相同性要在真 GPU 上比（mm_prefetch_check.html），node 沒有 WGSL 執行環境。

console.log(passed + ' 項通過');
