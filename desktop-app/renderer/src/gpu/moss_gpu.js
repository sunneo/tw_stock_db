'use strict';
// MOSS 解碼一步的 GPU 運算（WGSL）：float32 矩陣乘（單一詞元的 y = x·W + b）與單一詞元的因果注意力。
// 退路：T1 WGSL 失敗或沒有 WebGPU → cpu-js（moss_decoder.js 的參考實作）。WebGL2 未做。
// 介面：makeGpuOps(opts) → { linear, attention, tiers }，可直接傳給 moss_decoder.decodeStep(model, ids, caches, ops)。
// pipeline 由 nn.runWgsl 以 WGSL 字串為鍵快取（第二次呼叫不重建，見 gpu_cache_fallback_test.js）。
const nn = require('./nn_ops.js');
const M = require('./moss_decoder.js');

const WGSL_LINEAR = `
struct P { K: u32, N: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
// @kernel moss_linear
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  if (n >= p.N) { return; }
  var acc: f32 = b[n];
  for (var k: u32 = 0u; k < p.K; k = k + 1u) { acc = acc + x[k] * w[k * p.N + n]; }
  y[n] = acc;
}
`;

// 一個 invocation 算一個頭：兩段式（先求最大值，再算 softmax 加權和）。快取為 L×(H·HD)，時間優先。
const WGSL_ATTN = `
struct A { L: u32, H: u32, HD: u32, p0: u32, scale: f32, p1: u32, p2: u32, p3: u32 }
@group(0) @binding(0) var<storage, read> q: array<f32>;
@group(0) @binding(1) var<storage, read> kc: array<f32>;
@group(0) @binding(2) var<storage, read> vc: array<f32>;
@group(0) @binding(3) var<storage, read_write> o: array<f32>;
@group(0) @binding(4) var<uniform> a: A;
// @kernel moss_attn
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let h = gid.x;
  if (h >= a.H) { return; }
  let D = a.H * a.HD;
  var mx: f32 = -3.0e38;
  for (var j: u32 = 0u; j < a.L; j = j + 1u) {
    var dot: f32 = 0.0;
    for (var d: u32 = 0u; d < a.HD; d = d + 1u) { dot = dot + q[h * a.HD + d] * kc[j * D + h * a.HD + d]; }
    let s = dot * a.scale;
    if (s > mx) { mx = s; }
  }
  var sum: f32 = 0.0;
  for (var d: u32 = 0u; d < a.HD; d = d + 1u) { o[h * a.HD + d] = 0.0; }
  for (var j: u32 = 0u; j < a.L; j = j + 1u) {
    var dot: f32 = 0.0;
    for (var d: u32 = 0u; d < a.HD; d = d + 1u) { dot = dot + q[h * a.HD + d] * kc[j * D + h * a.HD + d]; }
    let e = exp(dot * a.scale - mx);
    sum = sum + e;
    for (var d: u32 = 0u; d < a.HD; d = d + 1u) { o[h * a.HD + d] = o[h * a.HD + d] + e * vc[j * D + h * a.HD + d]; }
  }
  for (var d: u32 = 0u; d < a.HD; d = d + 1u) { o[h * a.HD + d] = o[h * a.HD + d] / sum; }
}
`;

// LayerNorm（單一詞元，D 維）：一個 invocation 逐元素計算均值與變異數（D 小，不做歸約）
const WGSL_LN = `
struct P { D: u32, p0: u32, p1: u32, p2: u32, eps: f32, p3: u32, p4: u32, p5: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
// @kernel moss_ln
@compute @workgroup_size(1)
fn main() {
  var mu: f32 = 0.0;
  for (var i: u32 = 0u; i < p.D; i = i + 1u) { mu = mu + x[i]; }
  mu = mu / f32(p.D);
  var v: f32 = 0.0;
  for (var i: u32 = 0u; i < p.D; i = i + 1u) { v = v + (x[i] - mu) * (x[i] - mu); }
  v = v / f32(p.D);
  let r = 1.0 / sqrt(v + p.eps);
  for (var i: u32 = 0u; i < p.D; i = i + 1u) { y[i] = (x[i] - mu) * r * w[i] + b[i]; }
}
`;
// 交錯式 RoPE：一個 invocation 處理一對 (2i, 2i+1)；共 H·32 對（D/2 = 384）
const WGSL_ROPE = `
struct P { pos: f32, theta: f32, HD: u32, npairs: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
// @kernel moss_rope
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= p.npairs) { return; }
  let half = p.HD / 2u;
  let h = q / half;
  let i = q % half;
  let b = h * p.HD + 2u * i;
  let f = p.pos * pow(p.theta, -f32(2u * i) / f32(p.HD));
  let c = cos(f);
  let s = sin(f);
  let e = x[b];
  let od = x[b + 1u];
  y[b] = e * c - od * s;
  y[b + 1u] = od * c + e * s;
}
`;
// GELU（tanh 近似），逐元素
const WGSL_GELU = `
struct P { n: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
// @kernel moss_gelu
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  let g = x[i];
  y[i] = 0.5 * g * (1.0 + tanh(0.7978846 * (g + 0.044715 * g * g * g)));
}
`;

function u32Bytes(vals) { const ab = new ArrayBuffer(Math.ceil(vals.length * 4 / 16) * 16); const dv = new DataView(ab); vals.forEach((v, i) => { if (v.f !== undefined) dv.setFloat32(i * 4, v.f, true); else dv.setUint32(i * 4, v, true); }); return new Uint8Array(ab); }

// 一次矩陣乘（T1）：x 長度 K、W 為 K×N（列優先）、b 長度 N；回傳 {result, info}
function linearWgsl(dev, x, W, K, N, b) {
  return nn.runWgsl(dev, WGSL_LINEAR,
    [{ data: Float32Array.from(x) }, { data: W }, { data: Float32Array.from(b) }, { data: new Float32Array(N), out: true }],
    u32Bytes([K, N, 0, 0]), Math.ceil(N / 64)).then((outs) => outs[0]);
}
function attnWgsl(dev, q, Kc, Vc, Ln) {
  return nn.runWgsl(dev, WGSL_ATTN,
    [{ data: Float32Array.from(q) }, { data: Kc }, { data: Vc }, { data: new Float32Array(M.D), out: true }],
    u32Bytes([Ln, M.H, M.HD, 0, { f: M.SCALE }, 0, 0, 0]), M.H).then((outs) => outs[0]);
}

function lnWgsl(dev, x, w, b) {
  return nn.runWgsl(dev, WGSL_LN,
    [{ data: Float32Array.from(x) }, { data: Float32Array.from(w) }, { data: Float32Array.from(b) }, { data: new Float32Array(M.D), out: true }],
    u32Bytes([M.D, 0, 0, 0, { f: M.EPS }, 0, 0, 0]), 1).then((outs) => outs[0]);
}
function ropeWgsl(dev, x, pos) {
  const npairs = M.D / 2;
  return nn.runWgsl(dev, WGSL_ROPE,
    [{ data: Float32Array.from(x) }, { data: new Float32Array(M.D), out: true }],
    u32Bytes([{ f: pos }, { f: M.THETA }, M.HD, npairs]), Math.ceil(npairs / 64)).then((outs) => outs[0]);
}
function geluWgsl(dev, f) {
  const n = f.length;
  return nn.runWgsl(dev, WGSL_GELU,
    [{ data: Float32Array.from(f) }, { data: new Float32Array(n), out: true }],
    u32Bytes([n, 0, 0, 0]), Math.ceil(n / 64)).then((outs) => outs[0]);
}

// 建立 GPU 運算組：每次呼叫都記錄層級（T1／cpu-js），方便驗證頁確認真的走了 GPU。
function makeGpuOps(opts) {
  const o = opts || {};
  const tiers = { linear: {}, attention: {}, layerNorm: {}, rope: {}, gelu: {} };
  const tally = (k, tier) => { tiers[k][tier] = (tiers[k][tier] || 0) + 1; };
  return {
    tiers,
    linear: async (x, W, K, N, b) => {
      const r = await nn.tryLayers('moss_linear', { navigator: o.navigator },
        async (dev) => linearWgsl(dev, x, W, K, N, b), null,
        () => M.linearCpu(x, W, K, N, b));
      tally('linear', r.info.layer);
      return r.result;
    },
    attention: async (q, Kc, Vc, Ln) => {
      const r = await nn.tryLayers('moss_attn', { navigator: o.navigator },
        async (dev) => attnWgsl(dev, q, Kc, Vc, Ln), null,
        () => M.attentionCpu(q, Kc, Vc, Ln));
      tally('attention', r.info.layer);
      return r.result;
    },
    layerNorm: async (x, w, b) => {
      const r = await nn.tryLayers('moss_ln', { navigator: o.navigator },
        async (dev) => lnWgsl(dev, x, w, b), null,
        () => M.layerNorm(x, w, b));
      tally('layerNorm', r.info.layer);
      return r.result;
    },
    rope: async (x, pos) => {
      const r = await nn.tryLayers('moss_rope', { navigator: o.navigator },
        async (dev) => ropeWgsl(dev, x, pos), null,
        () => M.rope(x, pos));
      tally('rope', r.info.layer);
      return r.result;
    },
    gelu: async (f) => {
      const r = await nn.tryLayers('moss_gelu', { navigator: o.navigator },
        async (dev) => geluWgsl(dev, f), null,
        () => M.geluCpu(f));
      tally('gelu', r.info.layer);
      return r.result;
    },
  };
}

module.exports = { WGSL_LINEAR, WGSL_ATTN, WGSL_LN, WGSL_ROPE, WGSL_GELU, makeGpuOps, linearWgsl, attnWgsl, lnWgsl, ropeWgsl, geluWgsl };
