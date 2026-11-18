/* matmulnbits_splitk.js — R5 MatMulNBits：decode（M=1）的 split-K。
 * dec 核心的每個工作群組負責 16 欄、沿 K 逐段累加；split-K 把 K 切成 S 段（每段以 256 對齊），每段一個工作群組層（wid.z），
 * 部分核心寫 part[(s·M+m)·N+n]，歸約核心把 S 個部分和加起來。兩段在同一個批次送出（createBatch）。
 * 權重佈局與 WGSL_MATMULNBITS_DEC 相同：B 為 N×nb×16 位元組（以 u32 讀），scales 為 N×nb（f32）。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaMatmulNBitsSplitK。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./matmulnbits_ref.js')); }
  else { root.FaMatmulNBitsSplitK = factory(root.FaMatmulNBitsRef); }
}(typeof self !== 'undefined' ? self : this, function (REF) {
  'use strict';

  // 切片：每段長 Ks = ⌈⌈K/S⌉/256⌉·256，第 s 段 = [min(K, s·Ks), min(K, (s+1)·Ks))
  function sliceRanges(K, S) {
    const Ks = Math.ceil(Math.ceil(K / S) / 256) * 256, out = [];
    for (let s = 0; s < S; s++) out.push([Math.min(K, s * Ks), Math.min(K, (s + 1) * Ks)]);
    return out;
  }
  function sliceLen(K, S) { return Math.ceil(Math.ceil(K / S) / 256) * 256; }
  // 切片數（待 Chrome 量測；先給 4）
  function pickSplits(K) { return K >= 1024 ? 4 : 1; }
  function applies(M, K, N) { return M === 1 && K >= 512 && N >= 16; }

  const WGSL_NB_SPLITK_PARTIAL = `
struct P { M: u32, K: u32, N: u32, nb: u32, S: u32, Ks: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> bq: array<u32>;
@group(0) @binding(2) var<storage, read> sc: array<f32>;
@group(0) @binding(3) var<storage, read_write> part: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
var<workgroup> xs: array<f32, 256>;
var<workgroup> red: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  let m = wid.y;
  let s = wid.z;
  let col = wid.x * 16u + t / 16u;
  let lane = t % 16u;
  let nw = p.nb * 4u;
  let k0 = s * p.Ks;
  let k1 = min(p.K, k0 + p.Ks);
  var acc: f32 = 0.0;
  for (var kt: u32 = k0; kt < k1; kt = kt + 256u) {
    let kk = kt + t;
    if (kk < k1) { xs[t] = a[m * p.K + kk]; } else { xs[t] = 0.0; }
    workgroupBarrier();
    for (var j: u32 = 0u; j < 2u; j = j + 1u) {
      let wl = lane + j * 16u;
      let gw = kt / 8u + wl;
      if (col < p.N && gw < nw && kt + wl * 8u < k1) {
        let word = bq[col * nw + gw];
        let sv = sc[col * p.nb + gw / 4u];
        for (var i: u32 = 0u; i < 8u; i = i + 1u) {
          let byte = (word >> ((i / 2u) * 8u)) & 255u;
          let nib = (byte >> ((i & 1u) * 4u)) & 15u;
          acc = acc + xs[wl * 8u + i] * ((f32(nib) - 8.0) * sv);
        }
      }
    }
    workgroupBarrier();
  }
  red[t] = acc;
  workgroupBarrier();
  if (lane == 0u && col < p.N) {
    var sum: f32 = 0.0;
    for (var l: u32 = 0u; l < 16u; l = l + 1u) { sum = sum + red[t + l]; }
    part[(s * p.M + m) * p.N + col] = sum;
  }
}`;

  const WGSL_NB_SPLITK_REDUCE = `
struct P { M: u32, K: u32, N: u32, nb: u32, S: u32, Ks: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> part: array<f32>;
@group(0) @binding(1) var<storage, read_write> y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  let m = gid.y;
  if (n >= p.N || m >= p.M) { return; }
  var sum: f32 = 0.0;
  for (var s: u32 = 0u; s < p.S; s = s + 1u) { sum = sum + part[(s * p.M + m) * p.N + n]; }
  y[m * p.N + n] = sum;
}`;

  // CPU 模擬：與兩段核心相同的切片與加總順序（每段內依 k 由小到大，段與段之間依 s 由小到大）
  function simulate(A, M, K, B, scales, N, S) {
    const nb = REF.nBlocksOf(K), rs = sliceRanges(K, S);
    const part = new Float32Array(S * M * N), y = new Float32Array(M * N);
    const Q = REF.unpackQ4(B, N, K);   // N×K 的 4 位元值（已扣除 zp 之前）
    for (let s = 0; s < S; s++) for (let m = 0; m < M; m++) for (let n = 0; n < N; n++) {
      let acc = 0; const [k0, k1] = rs[s];
      for (let k = k0; k < k1; k++) acc = Math.fround(acc + Math.fround(A[m * K + k] * Math.fround((Q[n * K + k] - 8) * scales[n * nb + Math.floor(k / 32)])));
      part[(s * M + m) * N + n] = acc;
    }
    for (let m = 0; m < M; m++) for (let n = 0; n < N; n++) {
      let sum = 0; for (let s = 0; s < S; s++) sum = Math.fround(sum + part[(s * M + m) * N + n]);
      y[m * N + n] = sum;
    }
    return y;
  }

  return { sliceRanges, sliceLen, pickSplits, applies, WGSL_NB_SPLITK_PARTIAL, WGSL_NB_SPLITK_REDUCE, simulate };
}));
