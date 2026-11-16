'use strict';
// MOSS 解碼一步的 GPU 運算（WGSL）：float32 矩陣乘（單一詞元的 y = x·W + b）與單一詞元的因果注意力。
// 退路：T1 WGSL 失敗或沒有 WebGPU → cpu-js（moss_decoder.js 的參考實作）。WebGL2 未做。
// 介面：makeGpuOps(opts) → { linear, attention, tiers }，可直接傳給 moss_decoder.decodeStep(model, ids, caches, ops)。
// 注意：pipeline 每次呼叫都重建（runWgsl），速度不是本版目標。
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

// 建立 GPU 運算組：每次呼叫都記錄層級（T1／cpu-js），方便驗證頁確認真的走了 GPU。
function makeGpuOps(opts) {
  const o = opts || {};
  const tiers = { linear: {}, attention: {} };
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
  };
}

module.exports = { WGSL_LINEAR, WGSL_ATTN, makeGpuOps, linearWgsl, attnWgsl };
