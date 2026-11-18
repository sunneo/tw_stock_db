/* attn_splitkv.js — R5 注意力：decode（S=1）的 split-KV（flash-decoding 式）。
 * 一般的 attn_flash 每個 (詞元, 頭) 一個工作群組，decode 時只有 H 個群組，GPU 大部分閒著。
 * split-KV：把 key 每 64 個切成一塊；部分核心的工作群組 (H, nChunks) 各算一塊的 最大值 m、和 l、加權和 acc；
 * 合併核心的工作群組 (H) 再用 e^(m_c − M) 把各塊合起來。與參考的差只在 f32 的加總順序（相對誤差 ~1e-7），不要求逐位相同。
 * 布局（與 attn_ops 的 KV 快取相同）：k[(t·Hkv + kv)·hd + d]，q[h·hd + d]（S=1），kv = h / (H/Hkv)。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaAttnSplitKV。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaAttnSplitKV = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHUNK = 64;
  function nChunks(past) { return Math.ceil((past + 1) / CHUNK); }
  // 只適用於 decode（S=1）；S>1 回傳 null（由呼叫端退回 attn_flash）
  function applies(S, hd, past) { return S === 1 && hd % 4 === 0 && past >= 0; }

  const WGSL_SPLITKV_PARTIAL = `
struct P { H: u32, Hkv: u32, hd: u32, past: u32, nC: u32, scale: f32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> q: array<f32>;
@group(0) @binding(1) var<storage, read> k: array<f32>;
@group(0) @binding(2) var<storage, read> v: array<f32>;
@group(0) @binding(3) var<storage, read_write> pm: array<f32>;
@group(0) @binding(4) var<storage, read_write> pl: array<f32>;
@group(0) @binding(5) var<storage, read_write> pa: array<f32>;
@group(0) @binding(6) var<uniform> p: P;
var<workgroup> red: array<f32, 64>;
var<workgroup> wt: array<f32, 64>;
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let lane = lid.x;
  let h = wid.x;
  let c = wid.y;
  let kv = h / (p.H / p.Hkv);
  let t = c * 64u + lane;
  let valid = t <= p.past;
  var s: f32 = -1.0e30;
  if (valid) {
    var dot: f32 = 0.0;
    for (var d: u32 = 0u; d < p.hd; d = d + 1u) { dot = dot + q[h * p.hd + d] * k[(t * p.Hkv + kv) * p.hd + d]; }
    s = dot * p.scale;
  }
  red[lane] = s;
  workgroupBarrier();
  var st: u32 = 32u;
  loop {
    if (st == 0u) { break; }
    if (lane < st) { red[lane] = max(red[lane], red[lane + st]); }
    workgroupBarrier();
    st = st >> 1u;
  }
  let m = red[0];
  workgroupBarrier();
  let w = select(0.0, exp(s - m), valid);
  wt[lane] = w;
  red[lane] = w;
  workgroupBarrier();
  st = 32u;
  loop {
    if (st == 0u) { break; }
    if (lane < st) { red[lane] = red[lane] + red[lane + st]; }
    workgroupBarrier();
    st = st >> 1u;
  }
  let l = red[0];
  workgroupBarrier();
  for (var d: u32 = lane; d < p.hd; d = d + 64u) {
    var a: f32 = 0.0;
    for (var j: u32 = 0u; j < 64u; j = j + 1u) {
      let tt = c * 64u + j;
      if (tt <= p.past) { a = a + wt[j] * v[(tt * p.Hkv + kv) * p.hd + d]; }
    }
    pa[(h * p.nC + c) * p.hd + d] = a;
  }
  if (lane == 0u) { pm[h * p.nC + c] = m; pl[h * p.nC + c] = l; }
}`;

  const WGSL_SPLITKV_COMBINE = `
struct P { H: u32, Hkv: u32, hd: u32, past: u32, nC: u32, scale: f32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> pm: array<f32>;
@group(0) @binding(1) var<storage, read> pl: array<f32>;
@group(0) @binding(2) var<storage, read> pa: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let h = wid.x;
  let lane = lid.x;
  var M: f32 = -1.0e30;
  for (var c: u32 = 0u; c < p.nC; c = c + 1u) { M = max(M, pm[h * p.nC + c]); }
  var L: f32 = 0.0;
  for (var c: u32 = 0u; c < p.nC; c = c + 1u) { L = L + pl[h * p.nC + c] * exp(pm[h * p.nC + c] - M); }
  for (var d: u32 = lane; d < p.hd; d = d + 64u) {
    var acc: f32 = 0.0;
    for (var c: u32 = 0u; c < p.nC; c = c + 1u) { acc = acc + pa[(h * p.nC + c) * p.hd + d] * exp(pm[h * p.nC + c] - M); }
    y[h * p.hd + d] = acc / L;
  }
}`;

  // CPU 模擬（與兩段核心相同的切塊與合併）：q 為 H×hd，cache 為 attn_ops 的快取，回傳 H×hd（Float64）
  function simulate(q, cache, past, H, scale) {
    const hd = cache.hd, Hkv = cache.Hkv, nC = nChunks(past);
    const out = new Float64Array(H * hd);
    for (let h = 0; h < H; h++) {
      const kv = Math.floor(h / (H / Hkv));
      const ms = [], ls = [], accs = [];
      for (let c = 0; c < nC; c++) {
        const ts = [];
        for (let j = 0; j < CHUNK; j++) { const t = c * CHUNK + j; if (t <= past) ts.push(t); }
        const sc = ts.map((t) => { let dot = 0; for (let d = 0; d < hd; d++) dot += q[h * hd + d] * cache.k[(t * Hkv + kv) * hd + d]; return dot * scale; });
        const m = Math.max(...sc);
        const w = sc.map((s) => Math.exp(s - m));
        const l = w.reduce((a, b) => a + b, 0);
        const acc = new Float64Array(hd);
        ts.forEach((t, i) => { for (let d = 0; d < hd; d++) acc[d] += w[i] * cache.v[(t * Hkv + kv) * hd + d]; });
        ms.push(m); ls.push(l); accs.push(acc);
      }
      const M = Math.max(...ms);
      let L = 0; for (let c = 0; c < nC; c++) L += ls[c] * Math.exp(ms[c] - M);
      for (let d = 0; d < hd; d++) {
        let a = 0; for (let c = 0; c < nC; c++) a += accs[c][d] * Math.exp(ms[c] - M);
        out[h * hd + d] = a / L;
      }
    }
    return out;
  }

  return { CHUNK, nChunks, applies, WGSL_SPLITKV_PARTIAL, WGSL_SPLITKV_COMBINE, simulate };
}));
