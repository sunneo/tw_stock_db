/* mm_subgroup.js — 子群組矩陣乘（清單 O1m／matmul 子群組變體）。
 * 每個輸出元素由一個子群組（subgroup）負責：lane l 累加 k = base + l（base 每次跨一個子群組大小），最後用 subgroupAdd 加總。
 * 適合小 M（解碼 M=1..8）：輸出元素多、每個元素的 K 長，子群組內的歸約不用共用記憶體。
 * 需要 subgroups 功能（adapter 與 device 都要有）；沒有就不能用這個核心（kernel_select 的 needs.subgroups）。
 * Y[m,n] = Σ_k A[m,k]·B[k,n]，A 為 M×K（列主序），B 為 K×N（列主序），Y 為 M×N。
 * 網格跨步：每個工作群組的子群組數依裝置而定，所以用 num_workgroups 跨步，主機端只給一個固定的派發數。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaMmSubgroup。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaMmSubgroup = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // uniform P：與 mm_ops 的 8 個 u32 相同順序（B, M, K, N, Bb, azp, bzp, p0）；這裡只用 M、K、N。
  const WGSL_MM_SUBGROUP = `enable subgroups;
struct P { B: u32, M: u32, K: u32, N: u32, Bb: u32, azp: i32, bzp: i32, p0: u32 }
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(subgroup_invocation_id) sid: u32, @builtin(subgroup_size) ssz: u32,
        @builtin(subgroup_id) sgid: u32, @builtin(num_subgroups) nsg: u32,
        @builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let total = p.M * p.N;
  // 網格跨步：每個子群組一次負責一個輸出元素；wg 內的子群組數 nsg、網格的工作群組數 nwg.x
  var o: u32 = wid.x * nsg + sgid;
  let stride = nwg.x * nsg;
  loop {
    if (o >= total) { break; }
    let m = o / p.N;
    let n = o % p.N;
    var part: f32 = 0.0;
    // base 是均勻的（所有 lane 同步跨步），lane 的界限只放在 if 裡，subgroupAdd 才在均勻的控制流程中
    for (var base: u32 = 0u; base < p.K; base = base + ssz) {
      let k = base + sid;
      if (k < p.K) { part = part + a[m * p.K + k] * b[k * p.N + n]; }
    }
    let s = subgroupAdd(part);
    if (sid == 0u) { y[m * p.N + n] = s; }
    o = o + stride;
  }
}`;

  // 派發數：每個子群組一個元素；host 不知道子群組數，所以給一個上限（網格跨步處理剩下的）。
  function dispatchFor(M, N, maxGroups) { return Math.max(1, Math.min(Math.ceil(M * N / 8), maxGroups || 4096)); }

  // 參考（CPU，f32 順序與核心的 lane 歸約一致，供測試用；subgroup 的 ssz 由呼叫端給）
  function simulate(a, b, M, K, N, ssz) {
    const y = new Float32Array(M * N);
    for (let o = 0; o < M * N; o++) {
      const m = Math.floor(o / N), n = o % N;
      const lanes = new Float32Array(ssz);
      for (let base = 0; base < K; base += ssz) for (let l = 0; l < ssz; l++) { const k = base + l; if (k < K) lanes[l] = Math.fround(lanes[l] + Math.fround(a[m * K + k] * b[k * N + n])); }
      let s = 0; for (let l = 0; l < ssz; l++) s = Math.fround(s + lanes[l]);
      y[o] = s;
    }
    return y;
  }

  return { WGSL_MM_SUBGROUP, dispatchFor, simulate };
}));
