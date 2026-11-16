'use strict';
// midigenai 解碼器的非矩陣乘運算（WGSL）：RMSNorm、交錯式 RoPE、因果注意力（含多詞元預填）、SiLU(gate)·up。
// 介面：makeMidiOps(opts) → { rms, rope, attn, siluMul, tiers }，傳給 midi_decoder.decode 的第 5 個參數；
// 每個運算失敗或沒有 WebGPU 時由 nn.tryLayers 退 cpu-js（midi_decoder 的同一份參考實作），tiers 記每個運算的層級與原因。
// 布局與 midi_decoder 一致：x 為 T×768 列主序；K/V 為 H×Ln×64。每個 invocation 一個（列或頭），不做歸約（先求正確）。
const nn = require('./nn_ops.js');
const MD = require('./midi_decoder.js');
const H = 12, HD = 64, D = 768;

const WGSL_RMS = `
struct P { T: u32, D: u32, p0: u32, p1: u32, eps: f32, p2: u32, p3: u32, p4: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= p.T) { return; }
  var s: f32 = 0.0;
  for (var i: u32 = 0u; i < p.D; i = i + 1u) { let v = x[t * p.D + i]; s = s + v * v; }
  let r = 1.0 / sqrt(s / f32(p.D) + p.eps);
  for (var i: u32 = 0u; i < p.D; i = i + 1u) { y[t * p.D + i] = x[t * p.D + i] * r * w[i]; }
}
`;
const WGSL_ROPE = `
struct P { T: u32, H: u32, HD: u32, p0: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> pos: array<f32>;
@group(0) @binding(2) var<storage, read> invf: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let half = p.HD / 2u;
  let n = p.T * p.H * half;
  let q = gid.x;
  if (q >= n) { return; }
  let t = q / (p.H * half);
  let h = (q / half) % p.H;
  let i = q % half;
  let b = t * p.H * p.HD + h * p.HD + 2u * i;
  let f = pos[t] * invf[i];
  let c = cos(f);
  let s = sin(f);
  let e = x[b];
  let o = x[b + 1u];
  y[b] = e * c - o * s;
  y[b + 1u] = e * s + o * c;
}
`;
const WGSL_ATTN = `
struct P { T: u32, H: u32, HD: u32, Ln: u32, past: u32, p0: u32, p1: u32, p2: u32, scale: f32, p3: u32, p4: u32, p5: u32 }
@group(0) @binding(0) var<storage, read> q: array<f32>;
@group(0) @binding(1) var<storage, read> kc: array<f32>;
@group(0) @binding(2) var<storage, read> vc: array<f32>;
@group(0) @binding(3) var<storage, read_write> o: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let th = gid.x;
  if (th >= p.T * p.H) { return; }
  let t = th / p.H;
  let h = th % p.H;
  let D = p.H * p.HD;
  let qo = t * D + h * p.HD;
  let lim = p.past + t + 1u;
  var mx: f32 = -3.0e38;
  for (var j: u32 = 0u; j < lim; j = j + 1u) {
    var dot: f32 = 0.0;
    let ko = (h * p.Ln + j) * p.HD;
    for (var d: u32 = 0u; d < p.HD; d = d + 1u) { dot = dot + q[qo + d] * kc[ko + d]; }
    mx = max(mx, dot * p.scale);
  }
  var sum: f32 = 0.0;
  for (var d: u32 = 0u; d < p.HD; d = d + 1u) { o[qo + d] = 0.0; }
  for (var j: u32 = 0u; j < lim; j = j + 1u) {
    var dot: f32 = 0.0;
    let ko = (h * p.Ln + j) * p.HD;
    for (var d: u32 = 0u; d < p.HD; d = d + 1u) { dot = dot + q[qo + d] * kc[ko + d]; }
    let e = exp(dot * p.scale - mx);
    sum = sum + e;
    for (var d: u32 = 0u; d < p.HD; d = d + 1u) { o[qo + d] = o[qo + d] + e * vc[ko + d]; }
  }
  for (var d: u32 = 0u; d < p.HD; d = d + 1u) { o[qo + d] = o[qo + d] / sum; }
}
`;
const WGSL_SILUMUL = `
struct P { n: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> g: array<f32>;
@group(0) @binding(1) var<storage, read> u: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  y[i] = (g[i] / (1.0 + exp(-g[i]))) * u[i];
}
`;

const u32f = (a) => { const b = new ArrayBuffer(Math.ceil(a.length * 4 / 16) * 16), v = new DataView(b); a.forEach((x, i) => { if (x && x.f !== undefined) v.setFloat32(i * 4, x.f, true); else v.setUint32(i * 4, x, true); }); return new Uint8Array(b); };

function makeMidiOps(opts) {
  const o = opts || {};
  const tiers = {};
  const note = (name, info) => { tiers[name] = info.layer + (info.reason ? '（' + info.reason + '）' : ''); };
  const wrap = (name, gpuFn, refFn) => async (...args) => {
    const r = await nn.tryLayers(name, o, (dev) => gpuFn(dev, ...args), null, () => refFn(...args));
    note(name, r.info); return r.result;
  };
  const rms = wrap('midi_rms', async (dev, X, w, T, eps) => (await nn.runWgsl(dev, WGSL_RMS, [{ data: X }, { data: w }, { data: new Float32Array(T * D), out: true }], u32f([T, D, 0, 0, { f: eps }, 0, 0, 0]), Math.ceil(T / 1)))[0],
    (X, w, T, eps) => { const out = new Float32Array(T * D); for (let t = 0; t < T; t++) { let s = 0; for (let i = 0; i < D; i++) s += X[t * D + i] * X[t * D + i]; const r = 1 / Math.sqrt(s / D + eps); for (let i = 0; i < D; i++) out[t * D + i] = X[t * D + i] * r * w[i]; } return out; });
  const rope = wrap('midi_rope', async (dev, X, T, pos, invf) => (await nn.runWgsl(dev, WGSL_ROPE, [{ data: X }, { data: Float32Array.from(pos) }, { data: invf }, { data: new Float32Array(T * D), out: true }], u32f([T, H, HD, 0]), Math.ceil(T * H * HD / 2 / 64)))[0],
    (X, T, pos, invf) => { const out = new Float32Array(T * D); for (let t = 0; t < T; t++) for (let h = 0; h < H; h++) for (let i = 0; i < HD / 2; i++) { const b = t * D + h * HD + 2 * i, a = Math.cos(pos[t] * invf[i]), s = Math.sin(pos[t] * invf[i]); out[b] = X[b] * a - X[b + 1] * s; out[b + 1] = X[b] * s + X[b + 1] * a; } return out; });
  const attn = wrap('midi_attn', async (dev, q, Kc, Vc, T, past, Ln, scale) => (await nn.runWgsl(dev, WGSL_ATTN, [{ data: q }, { data: Kc }, { data: Vc }, { data: new Float32Array(T * D), out: true }], u32f([T, H, HD, Ln, past, 0, 0, 0, { f: scale }, 0, 0, 0]), T * H))[0],
    (q, Kc, Vc, T, past, Ln, scale) => MD.attnRef(q, Kc, Vc, T, past, Ln, scale));
  const siluMul = wrap('midi_silu_mul', async (dev, g, u) => (await nn.runWgsl(dev, WGSL_SILUMUL, [{ data: g }, { data: u }, { data: new Float32Array(g.length), out: true }], u32f([g.length, 0, 0, 0]), Math.ceil(g.length / 64)))[0],
    (g, u) => { const y = new Float32Array(g.length); for (let i = 0; i < y.length; i++) y[i] = (g[i] / (1 + Math.exp(-g[i]))) * u[i]; return y; });
  return { rms, rope, attn, siluMul, tiers };
}
module.exports = { makeMidiOps, WGSL_RMS, WGSL_ROPE, WGSL_ATTN, WGSL_SILUMUL };
