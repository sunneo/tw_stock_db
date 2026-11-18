/* mm_splitk.js — split-K 矩陣乘（清單 R3：解碼與 LoRA 的小 M、大 K 形狀）。
 * 兩段：(1) 部分和核心：工作群組 (⌈N/256⌉, S, M)，每個執行緒算一個 (m, n) 在第 s 個 K 切片上的部分和，寫到 part[(s·M+m)·N+n]；
 *       (2) 歸約核心：工作群組 (⌈N/256⌉, M, 1)，每個執行緒把 S 個部分和依序加總，寫到 y[m·N+n]。
 * 切片：c = ⌈K/S⌉，第 i 片是 [min(K, i·c), min(K, (i+1)·c))；S 大於 K 時多出來的片是空的（部分和為 0）。
 * A 為 M×K、B 為 K×N（列主序），Y 為 M×N。只支援單一批次、不轉置。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaMmSplitK。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaMmSplitK = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WGSL_SPLITK_PARTIAL = `
struct P { M: u32, K: u32, N: u32, S: u32 }
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> part: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let n = wid.x * 256u + lid.x;
  let s = wid.y;
  let m = wid.z;
  if (n >= p.N || s >= p.S || m >= p.M) { return; }
  let c = (p.K + p.S - 1u) / p.S;
  let k0 = min(p.K, s * c);
  let k1 = min(p.K, k0 + c);
  var acc: f32 = 0.0;
  for (var k: u32 = k0; k < k1; k = k + 1u) { acc = acc + a[m * p.K + k] * b[k * p.N + n]; }
  part[(s * p.M + m) * p.N + n] = acc;
}`;

  const WGSL_SPLITK_REDUCE = `
struct P { M: u32, K: u32, N: u32, S: u32 }
@group(0) @binding(0) var<storage, read_write> part: array<f32>;
@group(0) @binding(1) var<storage, read_write> y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let n = wid.x * 256u + lid.x;
  let m = wid.y;
  if (n >= p.N || m >= p.M) { return; }
  var t: f32 = 0.0;
  for (var s: u32 = 0u; s < p.S; s = s + 1u) { t = t + part[(s * p.M + m) * p.N + n]; }
  y[m * p.N + n] = t;
}`;

  // 切片範圍（與 WGSL 的 c、k0、k1 相同的定義）
  function sliceRanges(K, S) {
    const c = Math.ceil(K / S), out = [];
    for (let i = 0; i < S; i++) out.push([Math.min(K, i * c), Math.min(K, (i + 1) * c)]);
    return out;
  }
  // 派發數
  function dispatchPartial(M, N, S) { return [Math.ceil(N / 256), S, M]; }
  function dispatchReduce(M, N) { return [Math.ceil(N / 256), M, 1]; }
  // 切片數（同機 intel xe-lpg 量測）：K ≥ 4096 切 16 片；1024 ≤ K < 4096 切 8 片；K < 1024 不切（沒有量測）。
  //   K=4096 的小 N（LoRA）：S16 0.195 對 S8 0.215（8×4096×16）、S16 0.155 對 S8 0.27（1×4096×16）；K=1024 時 S8 與 S16 差在雜訊內。
  function pickSplits(K) { return K >= 4096 ? 16 : (K >= 1024 ? 8 : 1); }
  // 適用的形狀（量測結果）：M=1（解碼），或 N ≤ 64（LoRA 的秩）且 M ≤ 64。N 大而 M>1 時 split-K 輸給 vec4／tiled（例 64×1024×256、8×4096×1024）。
  function splitkApplies(M, K, N) { return K >= 1024 && (M === 1 || (N <= 64 && M <= 64)); }

  // CPU 模擬（與兩段核心的 f32 順序相同），供測試與參考
  function simulate(a, b, M, K, N, S) {
    const part = new Float32Array(S * M * N), y = new Float32Array(M * N);
    const rs = sliceRanges(K, S);
    for (let s = 0; s < S; s++) for (let m = 0; m < M; m++) for (let n = 0; n < N; n++) {
      let acc = 0; const [k0, k1] = rs[s];
      for (let k = k0; k < k1; k++) acc = Math.fround(acc + Math.fround(a[m * K + k] * b[k * N + n]));
      part[(s * M + m) * N + n] = acc;
    }
    for (let m = 0; m < M; m++) for (let n = 0; n < N; n++) {
      let t = 0; for (let s = 0; s < S; s++) t = Math.fround(t + part[(s * M + m) * N + n]);
      y[m * N + n] = t;
    }
    return y;
  }

  // R4：工作群組大小（WG）變體。把核心裡的 256 換成 WG（workgroup_size 與 n 的計算）；派發數用 ⌈N/WG⌉。WG 須為 1..256 的整數。
  function withWorkgroup(code, WG) {
    if (!(Number.isInteger(WG) && WG >= 1 && WG <= 256)) throw new Error('mm_splitk：工作群組大小必須是 1..256 的整數（收到 ' + WG + '）');
    return code.replace('@workgroup_size(256)', '@workgroup_size(' + WG + ')').replace('wid.x * 256u', 'wid.x * ' + WG + 'u');
  }
  function partialWgsl(WG) { return withWorkgroup(WGSL_SPLITK_PARTIAL, WG || 256); }
  function reduceWgsl(WG) { return withWorkgroup(WGSL_SPLITK_REDUCE, WG || 256); }
  function dispatchPartialWG(M, N, S, WG) { return [Math.ceil(N / (WG || 256)), S, M]; }
  function dispatchReduceWG(M, N, WG) { return [Math.ceil(N / (WG || 256)), M, 1]; }

  return { WGSL_SPLITK_PARTIAL, WGSL_SPLITK_REDUCE, sliceRanges, dispatchPartial, dispatchReduce, pickSplits, splitkApplies, simulate,
    withWorkgroup, partialWgsl, reduceWgsl, dispatchPartialWG, dispatchReduceWG };
}));
