/* q8mm_splitk.js — R5：q8mm（權重 q8、整數累加）的 split-K 版本，給解碼 M=1 等「輸出工作群組太少」的形狀。
 * 與 infer_ops 的 WGSL_Q8MM_DEC 同一套資料格式：權重 K×N 的位元組（列主序），以 u32 讀（每個字 4 個 n），N 必須是 4 的倍數。
 * 兩段：(1) 部分和核心：工作群組 (⌈N/64⌉, S, M)；每個群組處理 K 的第 s 片、64 個輸出欄，輸出 i32 部分和。
 *       (2) 歸約核心：每個 (n, m) 把 S 個 i32 部分和加總（整數，順序無關，所以與不切片的結果逐位相同），再乘 scale。
 * 因為整數累加與順序無關（|和| ≤ K·255·255 < 2^31），結果必須與 q8mmRef 逐位相同。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaQ8mmSplitK。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaQ8mmSplitK = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WGSL_Q8_SPLITK_PARTIAL = `
struct P { M: u32, K: u32, N: u32, nq: u32, wzp: i32, S: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> part: array<i32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> xs: array<i32, 256>;
var<workgroup> red: array<i32, 1024>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  let cq = t & 15u;
  let ks = t >> 4u;
  let m = wid.z;
  let s = wid.y;
  let quad = wid.x * 16u + cq;
  let qok = quad < p.nq;
  let c = (p.K + p.S - 1u) / p.S;
  let k0 = min(p.K, s * c);
  let k1 = min(p.K, k0 + c);
  var a0: i32 = 0;
  var a1: i32 = 0;
  var a2: i32 = 0;
  var a3: i32 = 0;
  for (var kt: u32 = k0; kt < k1; kt = kt + 256u) {
    let kk = kt + t;
    if (kk < k1) { xs[t] = x[m * p.K + kk]; } else { xs[t] = 0; }
    workgroupBarrier();
    for (var j: u32 = 0u; j < 16u; j = j + 1u) {
      let tl = j * 16u + ks;
      let k = kt + tl;
      if (qok && k < k1) {
        let word = w[k * p.nq + quad];
        let xv = xs[tl];
        a0 = a0 + xv * (i32(word & 255u) - p.wzp);
        a1 = a1 + xv * (i32((word >> 8u) & 255u) - p.wzp);
        a2 = a2 + xv * (i32((word >> 16u) & 255u) - p.wzp);
        a3 = a3 + xv * (i32((word >> 24u) & 255u) - p.wzp);
      }
    }
    workgroupBarrier();
  }
  let b = ks * 64u + cq * 4u;
  red[b] = a0;
  red[b + 1u] = a1;
  red[b + 2u] = a2;
  red[b + 3u] = a3;
  workgroupBarrier();
  if (t < 64u) {
    var sum: i32 = 0;
    for (var q: u32 = 0u; q < 16u; q = q + 1u) { sum = sum + red[q * 64u + t]; }
    let n = wid.x * 64u + t;
    if (n < p.N) { part[(s * p.M + m) * p.N + n] = sum; }
  }
}`;

  const WGSL_Q8_SPLITK_REDUCE = `
struct P { M: u32, K: u32, N: u32, nq: u32, wzp: i32, S: u32, scale: f32, p2: u32 }
@group(0) @binding(0) var<storage, read> part: array<i32>;
@group(0) @binding(1) var<storage, read_write> y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  let m = gid.y;
  if (n >= p.N || m >= p.M) { return; }
  var sum: i32 = 0;
  for (var s: u32 = 0u; s < p.S; s = s + 1u) { sum = sum + part[(s * p.M + m) * p.N + n]; }
  y[m * p.N + n] = f32(sum) * p.scale;
}`;

  function sliceRanges(K, S) {
    const c = Math.ceil(K / S), out = [];
    for (let i = 0; i < S; i++) out.push([Math.min(K, i * c), Math.min(K, (i + 1) * c)]);
    return out;
  }
  // 切片數：K ≥ 4096 切 16；1024 ≤ K < 4096 切 8；其餘不切（與 mm_splitk 的規則一致，待 Chrome 量測）
  function pickSplits(K) { return K >= 4096 ? 16 : (K >= 1024 ? 8 : 1); }
  function dispatchPartial(M, N, S) { return [Math.ceil(N / 64), S, M]; }
  function dispatchReduce(M, N) { return [Math.ceil(N / 64), M, 1]; }

  // CPU 模擬：與兩段核心同一個切片與歸約順序（i32 部分和，最後乘 scale）
  function simulate(xq, W, wzp, M, K, N, scale, S) {
    if (N % 4 !== 0) throw new Error('q8mm_splitk：N 必須是 4 的倍數（N=' + N + '）');
    const sc = Math.fround(scale), rs = sliceRanges(K, S);
    const part = new Int32Array(S * M * N), y = new Float32Array(M * N);
    for (let s = 0; s < S; s++) for (let m = 0; m < M; m++) for (let n = 0; n < N; n++) {
      let acc = 0; const [k0, k1] = rs[s];
      for (let k = k0; k < k1; k++) acc = (acc + xq[m * K + k] * (W[k * N + n] - wzp)) | 0;
      part[(s * M + m) * N + n] = acc;
    }
    for (let m = 0; m < M; m++) for (let n = 0; n < N; n++) {
      let sum = 0; for (let s = 0; s < S; s++) sum = (sum + part[(s * M + m) * N + n]) | 0;
      y[m * N + n] = Math.fround(Math.fround(sum) * sc);
    }
    return y;
  }

  return { WGSL_Q8_SPLITK_PARTIAL, WGSL_Q8_SPLITK_REDUCE, sliceRanges, pickSplits, dispatchPartial, dispatchReduce, simulate };
}));
