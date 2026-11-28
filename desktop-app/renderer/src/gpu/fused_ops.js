// fused_ops.js — O7 融合核心（node 可測部分）：WGSL、CPU 參考版、批次介面。
// 四組融合，每組都有「未融合的組合」對照（同一個批次內的既有核心）：
//   1. silu×up（gate×up 的 SwiGLU 乘法）：fused_silu_mul 一次派發；未融合 = silu＋逐元素乘法（2 次派發）。
//   2. RMSNorm＋動態量化（單列，T=1）：rmsq_fused 一次派發（既有 nn_ops 的 rmsQuantFused，這裡補上標記與參考版）；
//      未融合 = rmsnorm＋qdyn_stats＋qdyn（3 次派發）。
//   3. RoPE 併進 QKV 後處理：rope_qkv_fused 一次派發同時旋轉 q、k 並複製 v；未融合 = rope(q)＋rope(k)＋copy(v)（3 次）。
//   4. 線上 softmax：softmax_online 單趟求最大值與分母（每列一個執行緒），再一趟寫出；未融合 = 既有 softmax（參考版兩趟）。
// 注意：node 內的假裝置依 @kernel 標記，用本檔的 CPU 參考版算結果，所以測試驗證的是主機端綁定、派發數與演算法的參考版。
// WGSL 本身沒有在真 GPU 上驗證（這台是 Intel iGPU，沒有 CUDA，也沒有真 Chrome 跑過這些核心）。
'use strict';
const NN = require('./nn_ops.js');

// ---------- 共用：與 WGSL round()（ties-to-even）一致的取整 ----------
function roundHalfEven(v) {
  const r = Math.round(v);
  return (Math.abs(v % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// 動態量化的統計（與 nn_ops 的 WGSL_QDYN_STATS 同一規則）：先含 0 的 min／max；回傳 [mn, mx, scale, zp]（f32）
function quantStatsRef(x) {
  let mn = 0, mx = 0;
  for (let i = 0; i < x.length; i++) { if (x[i] < mn) mn = x[i]; if (x[i] > mx) mx = x[i]; }
  const scale = Math.fround((mx - mn) / 255);
  let sc = scale, zp = 0;
  if (scale === 0) sc = 1;
  else zp = clamp(roundHalfEven(Math.fround(-mn / scale)), 0, 255);
  return Float32Array.of(mn, mx, sc, zp);
}
// 量化（與 nn_ops 的 WGSL_QDYN 同一規則）：q = clamp(round(x/sc)+zp, 0, 255) − zp（int32）
function qdynRef(x, st) {
  const sc = st[2], zp = st[3];
  const q = new Int32Array(x.length);
  for (let i = 0; i < x.length; i++) q[i] = clamp(roundHalfEven(Math.fround(x[i] / sc)) + zp, 0, 255) - zp;
  return q;
}

// ---------- 1. silu×up ----------
// y[i] = silu(gate[i]) · up[i]，silu(g) = g / (1 + e^(−g))
function siluMulRef(gate, up) {
  if (gate.length !== up.length) throw new Error('silu×up：gate 與 up 長度不同（' + gate.length + ' 對 ' + up.length + '）');
  const y = new Float32Array(gate.length);
  for (let i = 0; i < gate.length; i++) { const g = gate[i]; y[i] = (g / (1 + Math.exp(-g))) * up[i]; }
  return y;
}

const WGSL_SILU_MUL = `
struct P { n: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> gate: array<f32>;
@group(0) @binding(1) var<storage, read> up: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
// @kernel fused_silu_mul
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  let g = gate[i];
  y[i] = (g / (1.0 + exp(-g))) * up[i];
}
`;
// 未融合的逐元素乘法（給對照用）：z = x · y
const WGSL_MUL_EW = `
struct P { n: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> y: array<f32>;
@group(0) @binding(2) var<storage, read_write> z: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
// @kernel mul
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  z[i] = x[i] * y[i];
}
`;

// ---------- 2. RMSNorm＋動態量化（單列）----------
// 參考版：單趟（平方和 → inv → 逐元素 v = x·inv·g（f32 捨入後存入 y）→ min／max → scale、zp → 量化）。
// 回傳 { y: Float32Array(d), q: Int32Array(d)（已扣 zp）, st: Float32Array [mn, mx, sc, zp] }
function rmsQuantFusedRef(x, g, d, eps) {
  if (x.length !== d) throw new Error('rmsq：x 的長度 ' + x.length + ' 與 d=' + d + ' 不符');
  if (g.length !== d) throw new Error('rmsq：g 的長度 ' + g.length + ' 與 d=' + d + ' 不符');
  let s = 0;
  for (let i = 0; i < d; i++) s += x[i] * x[i];
  const inv = 1 / Math.sqrt(s / d + eps);
  const y = new Float32Array(d);
  let mn = 0, mx = 0;
  for (let i = 0; i < d; i++) {
    const v = Math.fround(x[i] * inv * g[i]);
    y[i] = v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const scale = Math.fround((mx - mn) / 255);
  let sc = scale, zp = 0;
  if (scale === 0) sc = 1;
  else zp = clamp(roundHalfEven(Math.fround(-mn / scale)), 0, 255);
  const q = new Int32Array(d);
  for (let i = 0; i < d; i++) q[i] = clamp(roundHalfEven(Math.fround(y[i] / sc)) + zp, 0, 255) - zp;
  return { y: y, q: q, st: Float32Array.of(mn, mx, sc, zp) };
}

// 未融合的 WGSL 組合的 CPU 對照（僅供測試比較）：rmsnormRef → quantStatsRef → qdynRef
function rmsQuantUnfusedRef(x, g, d, eps) {
  const y = Float32Array.from(NN.rmsnormRef(x, g, 1, d, eps));
  const st = quantStatsRef(y);
  return { y: y, q: qdynRef(y, st), st: st };
}

// ---------- 3. RoPE 併進 QKV 後處理 ----------
// q：T×(H·hd)、k 與 v：T×(Hkv·hd)，列主序；位置 = 列號 t（與 nn_ops 的 ropeRef 相同，從 0 起算）。
// 旋轉：每個 head 內相鄰兩維一組，角度 θ = t · 10000^(−2i/hd)。v 只複製。
function ropeQkvRef(q, k, v, T, H, Hkv, hd) {
  if (hd % 2 !== 0) throw new Error('rope_qkv：hd 必須是偶數（收到 ' + hd + '）');
  if (q.length !== T * H * hd || k.length !== T * Hkv * hd || v.length !== T * Hkv * hd) throw new Error('rope_qkv：q／k／v 的長度與 T、H、Hkv、hd 不符');
  const qo = new Float32Array(q.length), ko = new Float32Array(k.length), vo = Float32Array.from(v);
  const hp = hd / 2;
  // rotate-half：第 i 維與第 i+hp 維成一對（與 nn_ops.ROPE_CONVENTION 相同）
  const rot = (src, dst, heads, t, h, i) => {
    const th = t * Math.pow(10000, -2 * i / hd), c = Math.cos(th), s = Math.sin(th);
    const o = t * heads * hd + h * hd + i;
    const a = src[o], b = src[o + hp];
    dst[o] = a * c - b * s;
    dst[o + hp] = b * c + a * s;
  };
  for (let t = 0; t < T; t++) {
    for (let h = 0; h < H; h++) for (let i = 0; i < hp; i++) rot(q, qo, H, t, h, i);
    for (let h = 0; h < Hkv; h++) for (let i = 0; i < hp; i++) rot(k, ko, Hkv, t, h, i);
  }
  return { q: qo, k: ko, v: vo };
}

const WGSL_ROPE_QKV = `
struct P { T: u32, H: u32, Hkv: u32, hd: u32 }
@group(0) @binding(0) var<storage, read> qin: array<f32>;
@group(0) @binding(1) var<storage, read> kin: array<f32>;
@group(0) @binding(2) var<storage, read> vin: array<f32>;
@group(0) @binding(3) var<storage, read_write> qout: array<f32>;
@group(0) @binding(4) var<storage, read_write> kout: array<f32>;
@group(0) @binding(5) var<storage, read_write> vout: array<f32>;
@group(0) @binding(6) var<uniform> p: P;
// @kernel rope_qkv_fused
// 一個執行緒負責：一個 q 的旋轉對、一個 k 的旋轉對、一個 v 元素（三段獨立，超出範圍的段直接略過）。
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  let hp = p.hd / 2u;
  let qRot = p.T * p.H * hp;
  let kRot = p.T * p.Hkv * hp;
  if (k < qRot) {
    let i = k % hp;
    let h = (k / hp) % p.H;
    let t = k / (hp * p.H);
    let th = f32(t) * pow(10000.0, -2.0 * f32(i) / f32(p.hd));
    let c = cos(th);
    let s = sin(th);
    // rotate-half：第 i 維與第 i+hp 維成一對（與 nn_ops.ROPE_CONVENTION 相同）
    let o = t * p.H * p.hd + h * p.hd + i;
    let a = qin[o];
    let b = qin[o + hp];
    qout[o] = a * c - b * s;
    qout[o + hp] = b * c + a * s;
  }
  if (k >= qRot && k < qRot + kRot) {
    let kk = k - qRot;
    let i = kk % hp;
    let h = (kk / hp) % p.Hkv;
    let t = kk / (hp * p.Hkv);
    let th = f32(t) * pow(10000.0, -2.0 * f32(i) / f32(p.hd));
    let c = cos(th);
    let s = sin(th);
    let o = t * p.Hkv * p.hd + h * p.hd + i;
    let a = kin[o];
    let b = kin[o + hp];
    kout[o] = a * c - b * s;
    kout[o + hp] = b * c + a * s;
  }
  if (k < p.T * p.Hkv * p.hd) { vout[k] = vin[k]; }
}
`;
// 未融合的複製（給 v 的對照用）：y = x
const WGSL_COPY = `
struct P { n: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
// @kernel copy
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  y[i] = x[i];
}
`;

// ---------- 4. 線上 softmax（單趟求最大值與分母）----------
// 每列：m = 目前最大值，d = Σ e^(x_j − m)；遇到更大的 x 時把 d 乘上 e^(m_old − m_new)。
// 最後一趟寫出 y_j = e^(x_j − m) / d。與兩趟的 softmaxRef 數學上相同。
function softmaxOnlineRef(x, rows, cols) {
  if (x.length !== rows * cols) throw new Error('softmax_online：x 的長度 ' + x.length + ' 與 rows×cols=' + (rows * cols) + ' 不符');
  const y = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    let m = -Infinity, d = 0;
    for (let c = 0; c < cols; c++) {
      const v = x[r * cols + c];
      const mn = Math.max(m, v);
      d = d * Math.exp(m - mn) + Math.exp(v - mn);
      m = mn;
    }
    for (let c = 0; c < cols; c++) y[r * cols + c] = Math.exp(x[r * cols + c] - m) / d;
  }
  return y;
}

const WGSL_SOFTMAX_ONLINE = `
struct P { rows: u32, cols: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
// @kernel softmax_online
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= p.rows) { return; }
  var m: f32 = -3.0e38;
  var d: f32 = 0.0;
  for (var c: u32 = 0u; c < p.cols; c = c + 1u) {
    let v = x[r * p.cols + c];
    let mn = max(m, v);
    d = d * exp(m - mn) + exp(v - mn);
    m = mn;
  }
  for (var c: u32 = 0u; c < p.cols; c = c + 1u) {
    y[r * p.cols + c] = exp(x[r * p.cols + c] - m) / d;
  }
}
`;

// ---------- 批次介面（建立在 nn_ops.createBatch 之上；只用 upload／alloc／dispatchRaw／既有核心）----------
function uniU32(vals) {
  const u = new ArrayBuffer(16);
  new Uint32Array(u, 0, vals.length).set(vals);
  return u;
}

function siluMulFused(b, gate, up) {
  const n = gate.n;
  const out = b.alloc(n);
  b.dispatchRaw(WGSL_SILU_MUL, [gate.buf, up.buf, out.buf], uniU32([n]), Math.ceil(n / 64));
  return out;
}
function siluMulUnfused(b, gate, up) {
  const n = gate.n;
  const s = b.silu(gate);
  const out = b.alloc(n);
  b.dispatchRaw(WGSL_MUL_EW, [s.buf, up.buf, out.buf], uniU32([n]), Math.ceil(n / 64));
  return out;
}

// 回傳 { y: handle(d), q: { buf, n, st: { buf, n: 4 } } }，與 nn_ops 的 rmsQuantFused 同一介面
function rmsQuantFusedBatch(b, x, g, d, eps) {
  return b.rmsQuantFused(x, g, d, eps);
}
function rmsQuantUnfusedBatch(b, x, g, d, eps) {
  const y = b.rmsnorm(x, g, 1, d, eps);
  const q = b.quantizeDyn(y);
  return { y: y, q: q };
}

function ropeQkvFused(b, q, k, v, T, H, Hkv, hd) {
  const qo = b.alloc(T * H * hd), ko = b.alloc(T * Hkv * hd), vo = b.alloc(T * Hkv * hd);
  const uni = new ArrayBuffer(16);
  new Uint32Array(uni, 0, 4).set([T, H, Hkv, hd]);
  const total = Math.max(T * H * (hd / 2) + T * Hkv * (hd / 2), T * Hkv * hd);
  b.dispatchRaw(WGSL_ROPE_QKV, [q.buf, k.buf, v.buf, qo.buf, ko.buf, vo.buf], uni, Math.ceil(total / 64));
  return { q: qo, k: ko, v: vo };
}
function ropeQkvUnfused(b, q, k, v, T, H, Hkv, hd) {
  const qr = b.rope(q, T, H, hd, 1);
  const kr = b.rope(k, T, Hkv, hd, 1);
  const n = T * Hkv * hd;
  const vo = b.alloc(n);
  b.dispatchRaw(WGSL_COPY, [v.buf, vo.buf], uniU32([n]), Math.ceil(n / 64));
  return { q: qr, k: kr, v: vo };
}

function softmaxOnlineBatch(b, x, rows, cols) {
  const y = b.alloc(rows * cols);
  const uni = uniU32([rows, cols]);
  b.dispatchRaw(WGSL_SOFTMAX_ONLINE, [x.buf, y.buf], uni, Math.ceil(rows / 64));
  return y;
}

module.exports = {
  roundHalfEven, quantStatsRef, qdynRef,
  siluMulRef, rmsQuantFusedRef, rmsQuantUnfusedRef, ropeQkvRef, softmaxOnlineRef,
  siluMulFused, siluMulUnfused, rmsQuantFusedBatch, rmsQuantUnfusedBatch, ropeQkvFused, ropeQkvUnfused, softmaxOnlineBatch,
  WGSL_SILU_MUL, WGSL_MUL_EW, WGSL_ROPE_QKV, WGSL_COPY, WGSL_SOFTMAX_ONLINE,
};
