'use strict';
// Whisper 編碼器（whisper_enc.js）的 WebGPU 運算：一維卷積走共用 conv_ops.conv1d（T1），整數矩陣乘（MatMulInteger，i32 累加，精確）、全注意力（線上 softmax）、LayerNorm、GELU(erf) 為本檔 WGSL。
// 介面：makeWhisperOps(opts) → { conv, mm, attn, ln, gelu, tiers }，傳給 whisper_enc.encode 的第三個參數。每個運算失敗／沒有 WebGPU 時由 nn.tryLayers 退 cpu-js（whisper_enc 的同一份參考），tiers 記層級與原因。
// 資料皆經 nn.runWgsl（pipeline 以 WGSL 字串快取）；DynamicQuantizeLinear（O(n) 的最小／最大歸約）與殘差相加留在 CPU（whisper_enc.js）。
const nn = require('./nn_ops.js');
const CONV = require('./conv_ops.js');
const WE = require('./whisper_enc.js');
const f = Math.fround;

const WGSL_MM = `
struct P { T: u32, K: u32, N: u32, hasBias: u32, scale: f32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.T * p.N) { return; }
  let t = i / p.N;
  let n = i % p.N;
  var acc: i32 = 0;
  for (var k: u32 = 0u; k < p.K; k = k + 1u) { acc = acc + i32(x[t * p.K + k]) * i32(w[k * p.N + n]); }
  var r = f32(acc) * p.scale;
  if (p.hasBias != 0u) { r = r + b[n]; }
  y[i] = r;
}
`;
const WGSL_ATTN = `
struct P { T: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> q: array<f32>;
@group(0) @binding(1) var<storage, read> k: array<f32>;
@group(0) @binding(2) var<storage, read> v: array<f32>;
@group(0) @binding(3) var<storage, read_write> o: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ih = gid.x;
  if (ih >= p.T * 8u) { return; }
  let i = ih / 8u;
  let h = ih % 8u;
  var acc: array<f32, 64>;
  for (var e: u32 = 0u; e < 64u; e = e + 1u) { acc[e] = 0.0; }
  var m: f32 = -3.0e38;
  var l: f32 = 0.0;
  let qo = i * 512u + h * 64u;
  for (var j: u32 = 0u; j < p.T; j = j + 1u) {
    let ko = j * 512u + h * 64u;
    var d: f32 = 0.0;
    for (var e: u32 = 0u; e < 64u; e = e + 1u) { d = d + q[qo + e] * k[ko + e]; }
    let mn = max(m, d);
    let c = exp(m - mn);
    let pj = exp(d - mn);
    l = l * c + pj;
    for (var e: u32 = 0u; e < 64u; e = e + 1u) { acc[e] = acc[e] * c + pj * v[ko + e]; }
    m = mn;
  }
  for (var e: u32 = 0u; e < 64u; e = e + 1u) { o[qo + e] = acc[e] / l; }
}
`;
const WGSL_LN = `
struct P { T: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= p.T) { return; }
  var mean: f32 = 0.0;
  for (var i: u32 = 0u; i < 512u; i = i + 1u) { mean = mean + x[t * 512u + i]; }
  mean = mean / 512.0;
  var v: f32 = 0.0;
  for (var i: u32 = 0u; i < 512u; i = i + 1u) { let d = x[t * 512u + i] - mean; v = v + d * d; }
  v = v / 512.0;
  let r = 1.0 / sqrt(v + 0.00001);
  for (var i: u32 = 0u; i < 512u; i = i + 1u) { y[t * 512u + i] = (x[t * 512u + i] - mean) * r * w[i] + b[i]; }
}
`;
const WGSL_GELU = `
struct P { n: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
fn erf_(a: f32) -> f32 {
  let z = abs(a);
  let t = 1.0 / (1.0 + 0.5 * z);
  let r = t * exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  if (a >= 0.0) { return 1.0 - r; }
  return r - 1.0;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  y[i] = x[i] * (erf_(x[i] * 0.70710678118) + 1.0) * 0.5;
}
`;
const U = (a) => { const b = new ArrayBuffer(Math.max(16, Math.ceil(a.length * 4 / 16) * 16)), v = new DataView(b); a.forEach((x, i) => { if (x && x.f !== undefined) v.setFloat32(i * 4, x.f, true); else v.setUint32(i * 4, x, true); }); return new Uint8Array(b); };

function makeWhisperOps(opts) {
  const o = opts || {}, tiers = {};
  const wrap = (name, gpuFn, refFn) => async (...a) => {
    const r = await nn.tryLayers(name, o, (dev) => gpuFn(dev, ...a), null, () => refFn(...a));
    tiers[name] = r.info.layer + (r.info.reason ? '（' + r.info.reason + '）' : ''); return r.result;
  };
  const run = async (dev, code, ins, n, uni, groups) => (await nn.runWgsl(dev, code, ins.map((d) => ({ data: d })).concat([{ data: new Float32Array(n), out: true }]), U(uni), groups))[0];
  const mm = wrap('whisper_mm', (dev, xs, T, K, ws, N, scale, bias) => run(dev, WGSL_MM, [xs, ws, bias || new Float32Array(1)], T * N, [T, K, N, bias ? 1 : 0, { f: scale }, 0, 0, 0], Math.ceil(T * N / 64)),
    (xs, T, K, ws, N, scale, bias) => WE.mmRef(xs, T, K, ws, N, scale, bias));
  const attn = wrap('whisper_attn', (dev, q, k, v, T) => run(dev, WGSL_ATTN, [q, k, v], T * 512, [T, 0, 0, 0], Math.ceil(T * 8 / 64)), (q, k, v, T) => WE.attnRef(q, k, v, T));
  const ln = wrap('whisper_ln', (dev, x, T, w, b) => run(dev, WGSL_LN, [x, w, b], T * 512, [T, 0, 0, 0], Math.ceil(T / 64)), (x, T, w, b) => WE.lnRef(x, T, w, b));
  const gelu = wrap('whisper_gelu', (dev, x) => run(dev, WGSL_GELU, [x], x.length, [x.length, 0, 0, 0], Math.ceil(x.length / 64)), (x) => WE.geluRef(x));
  // 卷積：conv_ops.conv1d（T1 WGSL → cpu-js），整數值以 float32 累加（|累加| 通常遠小於 2^24；超過時的捨入誤差見 DESIGN），之後 ×scale＋bias
  const conv = async (xs, C, L, ws, M, K, stride, pad, scale, bias) => {
    const co = { navigator: o.navigator }, y = await CONV.conv1d(xs, 1, C, L, ws, M, C, K, null, { stride, pads: [pad, pad] }, co);
    tiers['whisper_conv' + C] = co.lastInfo ? co.lastInfo.layer + (co.lastInfo.reason ? '（' + co.lastInfo.reason + '）' : '') : '?';
    const Lo = y.length / M; for (let m = 0; m < M; m++) for (let l = 0; l < Lo; l++) y[m * Lo + l] = f(f(y[m * Lo + l]) * scale) + bias[m];
    return y;
  };
  return { conv, mm, attn, ln, gelu, tiers };
}
module.exports = { makeWhisperOps };
