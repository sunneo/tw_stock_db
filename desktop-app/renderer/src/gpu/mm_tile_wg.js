/* mm_tile_wg.js — R4：平鋪矩陣乘的工作群組大小變體（同一個 TM×TN 輸出塊，WG 個執行緒，每個執行緒 RB = TM·TN/WG 個累加器）。
 * 分塊：A 的 TM×KB 與 B 的 KB×TN 搬進共用記憶體，執行緒以 t、t+WG、… 的順序搬運；每個執行緒的輸出是 idx = t + j·WG（j < RB），
 * 位置 (r, c) = (idx / TN, idx % TN)。K 依 KB 分段，依序累加（與參考的 k 順序相同）。
 * 這是測試用的生成器，只用來比較工作群組大小；production 的平鋪核心仍是 gpu_core.js 的 mmTileWgsl。
 * 派發：(⌈N/TN⌉, ⌈M/TM⌉, 1)。只支援單一批次、不轉置。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaMmTileWg。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaMmTileWg = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function geometry(TM, TN, WG) {
    if (!(Number.isInteger(WG) && WG >= 1 && WG <= 256)) throw new Error('mm_tile_wg：工作群組大小必須是 1..256 的整數（收到 ' + WG + '）');
    if ((TM * TN) % WG !== 0) throw new Error('mm_tile_wg：TM·TN（' + (TM * TN) + '）必須能被 WG（' + WG + '）整除');
    return { RB: (TM * TN) / WG };
  }

  function dispatch(M, N, TM, TN) { return [Math.ceil(N / TN), Math.ceil(M / TM), 1]; }

  function wgsl(TM, TN, KB, WG) {
    const RB = geometry(TM, TN, WG).RB;
    // 每個執行緒的輸出位置（與 k 無關，先算好）
    const pos = [];
    for (let j = 0; j < RB; j++) pos.push('  let idx' + j + ': u32 = t + ' + (j * WG) + 'u; let r' + j + ': u32 = idx' + j + ' / ' + TN + 'u; let c' + j + ': u32 = idx' + j + ' % ' + TN + 'u;');
    const fma = [];
    for (let j = 0; j < RB; j++) fma.push('      acc[' + j + '] = acc[' + j + '] + As[r' + j + ' * ' + KB + 'u + kk] * Bs[kk * ' + TN + 'u + c' + j + '];');
    const wr = [];
    for (let j = 0; j < RB; j++) wr.push('  if (row0 + r' + j + ' < p.M && col0 + c' + j + ' < p.N) { y[(row0 + r' + j + ') * p.N + col0 + c' + j + '] = acc[' + j + ']; }');
    return `struct P { B: u32, M: u32, K: u32, N: u32, Bb: u32, azp: i32, bzp: i32, p0: u32 }
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> As: array<f32, ${TM * KB}>;
var<workgroup> Bs: array<f32, ${KB * TN}>;
@compute @workgroup_size(${WG})
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  let row0 = wid.y * ${TM}u;
  let col0 = wid.x * ${TN}u;
  var acc: array<f32, ${RB}>;
${pos.join('\n')}
  for (var k0: u32 = 0u; k0 < p.K; k0 = k0 + ${KB}u) {
    for (var e: u32 = t; e < ${TM * KB}u; e = e + ${WG}u) {
      let rr = e / ${KB}u; let kk0 = e % ${KB}u; let gr = row0 + rr; let gk = k0 + kk0;
      var v: f32 = 0.0;
      if (gr < p.M && gk < p.K) { v = a[gr * p.K + gk]; }
      As[e] = v;
    }
    for (var e: u32 = t; e < ${KB * TN}u; e = e + ${WG}u) {
      let kk1 = e / ${TN}u; let cc = e % ${TN}u; let gk = k0 + kk1; let gc = col0 + cc;
      var v: f32 = 0.0;
      if (gk < p.K && gc < p.N) { v = b[gk * p.N + gc]; }
      Bs[e] = v;
    }
    workgroupBarrier();
    for (var kk: u32 = 0u; kk < ${KB}u; kk = kk + 1u) {
${fma.join('\n')}
    }
    workgroupBarrier();
  }
${wr.join('\n')}
}`;
  }

  // CPU 模擬：同一個分塊順序（k 依序累加；邊界外為 0），供測試與對照
  function simulate(a, b, M, K, N, TM, TN, KB, WG) {
    geometry(TM, TN, WG);
    const y = new Float32Array(M * N);
    for (let r = 0; r < M; r++) for (let c = 0; c < N; c++) {
      let acc = 0;
      for (let k = 0; k < K; k++) acc = Math.fround(acc + Math.fround(a[r * K + k] * b[k * N + c]));
      y[r * N + c] = acc;
    }
    return y;
  }

  return { geometry, dispatch, wgsl, simulate };
}));
