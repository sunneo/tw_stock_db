'use strict';
// 共用卷積核心（MOSS codec、Basic Pitch、Whisper 編碼器共用，不要各模型各寫一份）。
// 介面（全部 NCL / NCHW 佈局，列主序）：
//   conv1dRef(x, N, C, L, w, M, Cg, K, b, p) → Float32Array(N×M×Lout)
//   conv2dRef(x, N, C, H, W, w, M, Cg, KH, KW, b, p) → Float32Array(N×M×Hout×Wout)
//   conv1d(x, N, C, L, w, M, Cg, K, b, p, ops) → Promise<Float32Array>   （T1 WGSL → cpu-js 退路）
//   conv2d(x, N, C, H, W, w, M, Cg, KH, KW, b, p, ops) → Promise<Float32Array>   （同上，二維）
// p = { stride, pads:[左,右] (1D) 或 [上,左,下,右] (2D), dilation, groups }
// 權重 w 佈局 [M, Cg, K]（1D）或 [M, Cg, KH, KW]（2D）；Cg = C / groups。
// 轉置卷積：MOSS codec 圖中沒有 ConvTranspose（已確認算子清單），暫不實作。
// Basic Pitch（核 3×3 等 2D）與 Whisper 編碼器（Conv1d，核 3、stride 1／2）的參數都在這兩個函式涵蓋內。
const nn = require('./nn_ops.js');

function norm1(p) {
  const o = p || {};
  return { stride: o.stride || 1, pad0: o.pads ? o.pads[0] : 0, pad1: o.pads ? o.pads[1] : 0, dil: o.dilation || 1, groups: o.groups || 1 };
}
function norm2(p) {
  const o = p || {};
  const pd = o.pads || [0, 0, 0, 0];
  return { sh: (o.strides || [1, 1])[0], sw: (o.strides || [1, 1])[1], pt: pd[0], pl: pd[1], pb: pd[2], pr: pd[3], dh: (o.dilations || [1, 1])[0], dw: (o.dilations || [1, 1])[1], groups: o.groups || 1 };
}

// ---------- CPU 參考（逐元素，雙精度累加）----------
function conv1dRef(x, N, C, L, w, M, Cg, K, b, p) {
  const q = norm1(p), G = q.groups, Mg = M / G;
  const Lout = Math.floor((L + q.pad0 + q.pad1 - q.dil * (K - 1) - 1) / q.stride) + 1;
  if (Cg * G !== C) throw new Error('conv1d：C 與 Cg×groups 不符');
  const y = new Float32Array(N * M * Lout);
  for (let n = 0; n < N; n++) for (let m = 0; m < M; m++) {
    const g = Math.floor(m / Mg);
    for (let t = 0; t < Lout; t++) {
      let acc = b ? b[m] : 0;
      for (let c = 0; c < Cg; c++) {
        const ic = g * Cg + c;
        for (let k = 0; k < K; k++) {
          const pos = t * q.stride - q.pad0 + k * q.dil;
          if (pos < 0 || pos >= L) continue;
          acc += x[(n * C + ic) * L + pos] * w[(m * Cg + c) * K + k];
        }
      }
      y[(n * M + m) * Lout + t] = acc;
    }
  }
  return y;
}

function conv2dRef(x, N, C, H, W, w, M, Cg, KH, KW, b, p) {
  const q = norm2(p), G = q.groups, Mg = M / G;
  const Hout = Math.floor((H + q.pt + q.pb - q.dh * (KH - 1) - 1) / q.sh) + 1;
  const Wout = Math.floor((W + q.pl + q.pr - q.dw * (KW - 1) - 1) / q.sw) + 1;
  if (Cg * G !== C) throw new Error('conv2d：C 與 Cg×groups 不符');
  const y = new Float32Array(N * M * Hout * Wout);
  for (let n = 0; n < N; n++) for (let m = 0; m < M; m++) {
    const g = Math.floor(m / Mg);
    for (let i = 0; i < Hout; i++) for (let j = 0; j < Wout; j++) {
      let acc = b ? b[m] : 0;
      for (let c = 0; c < Cg; c++) {
        const ic = g * Cg + c;
        for (let kh = 0; kh < KH; kh++) {
          const ih = i * q.sh - q.pt + kh * q.dh;
          if (ih < 0 || ih >= H) continue;
          for (let kw = 0; kw < KW; kw++) {
            const iw = j * q.sw - q.pl + kw * q.dw;
            if (iw < 0 || iw >= W) continue;
            acc += x[((n * C + ic) * H + ih) * W + iw] * w[((m * Cg + c) * KH + kh) * KW + kw];
          }
        }
      }
      y[((n * M + m) * Hout + i) * Wout + j] = acc;
    }
  }
  return y;
}

// ---------- WGSL（T1）：一個 invocation 算一個輸出格；一維派發（扁平索引）----------
const WGSL_CONV1D = `
struct P { N: u32, C: u32, L: u32, M: u32, Cg: u32, K: u32, Lout: u32, stride: u32, pad0: u32, dil: u32, groups: u32, hasB: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let total = p.N * p.M * p.Lout;
  let idx = gid.x;
  if (idx >= total) { return; }
  let t = idx % p.Lout;
  let m = (idx / p.Lout) % p.M;
  let n = idx / (p.Lout * p.M);
  let Mg = p.M / p.groups;
  let g = m / Mg;
  var acc: f32 = 0.0;
  if (p.hasB == 1u) { acc = b[m]; }
  for (var c: u32 = 0u; c < p.Cg; c = c + 1u) {
    let ic = g * p.Cg + c;
    for (var k: u32 = 0u; k < p.K; k = k + 1u) {
      let pos = i32(t * p.stride) - i32(p.pad0) + i32(k * p.dil);
      if (pos >= 0 && u32(pos) < p.L) {
        acc = acc + x[(n * p.C + ic) * p.L + u32(pos)] * w[(m * p.Cg + c) * p.K + k];
      }
    }
  }
  y[idx] = acc;
}`;

// 二維版（Basic Pitch 等）：同樣一個 invocation 一個輸出格；扁平索引（N×M×Hout×Wout）
const WGSL_CONV2D = `
struct P { N: u32, C: u32, H: u32, W: u32, M: u32, Cg: u32, KH: u32, KW: u32, Hout: u32, Wout: u32, sh: u32, sw: u32, pt: u32, pl: u32, dh: u32, dw: u32, groups: u32, hasB: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let total = p.N * p.M * p.Hout * p.Wout;
  let idx = gid.x;
  if (idx >= total) { return; }
  let j = idx % p.Wout;
  let i = (idx / p.Wout) % p.Hout;
  let m = (idx / (p.Wout * p.Hout)) % p.M;
  let n = idx / (p.Wout * p.Hout * p.M);
  let g = m / (p.M / p.groups);
  var acc: f32 = 0.0;
  if (p.hasB == 1u) { acc = b[m]; }
  for (var c: u32 = 0u; c < p.Cg; c = c + 1u) {
    let ic = g * p.Cg + c;
    for (var kh: u32 = 0u; kh < p.KH; kh = kh + 1u) {
      let ih = i32(i * p.sh) - i32(p.pt) + i32(kh * p.dh);
      if (ih < 0 || u32(ih) >= p.H) { continue; }
      for (var kw: u32 = 0u; kw < p.KW; kw = kw + 1u) {
        let iw = i32(j * p.sw) - i32(p.pl) + i32(kw * p.dw);
        if (iw < 0 || u32(iw) >= p.W) { continue; }
        acc = acc + x[((n * p.C + ic) * p.H + u32(ih)) * p.W + u32(iw)] * w[((m * p.Cg + c) * p.KH + kh) * p.KW + kw];
      }
    }
  }
  y[idx] = acc;
}`;

// 純 JS 退路（cpu-js）與 T1 失敗時使用
async function conv1d(x, N, C, L, w, M, Cg, K, b, p, ops) {
  const o = ops || {};
  const q = norm1(p);
  const Lout = Math.floor((L + q.pad0 + q.pad1 - q.dil * (K - 1) - 1) / q.stride) + 1;
  if (o.gpu === false) return conv1dRef(x, N, C, L, w, M, Cg, K, b, p);
  return nn.tryLayers('conv1d', { navigator: o.navigator }, async (dev) => {
    const total = N * M * Lout;
    const u = new Uint32Array([N, C, L, M, Cg, K, Lout, q.stride, q.pad0, q.dil, q.groups, b ? 1 : 0]);
    const bArr = b ? Float32Array.from(b) : new Float32Array(1);
    const outs = await nn.runWgsl(dev, WGSL_CONV1D,
      [{ data: Float32Array.from(x) }, { data: Float32Array.from(w) }, { data: bArr }, { data: new Float32Array(total), out: true }],
      new Uint8Array(u.buffer), Math.ceil(total / 64));
    return outs[0];
  }, null, () => conv1dRef(x, N, C, L, w, M, Cg, K, b, p)).then((r) => { o.lastInfo = r.info; return r.result; });
}

// 二維卷積：T1 WGSL → cpu-js（conv2dRef）；ops.gpu === false 強制 CPU；ops.lastInfo 回報層級。派發數上限 65535×64 個輸出格（一維派發），超過直接退 CPU 並寫明原因。
async function conv2d(x, N, C, H, W, w, M, Cg, KH, KW, b, p, ops) {
  const o = ops || {};
  const q = norm2(p);
  const Hout = Math.floor((H + q.pt + q.pb - q.dh * (KH - 1) - 1) / q.sh) + 1, Wout = Math.floor((W + q.pl + q.pr - q.dw * (KW - 1) - 1) / q.sw) + 1;
  if (o.gpu === false) return conv2dRef(x, N, C, H, W, w, M, Cg, KH, KW, b, p);
  const total = N * M * Hout * Wout;
  return nn.tryLayers('conv2d', { navigator: o.navigator }, async (dev) => {
    if (Math.ceil(total / 64) > 65535) throw new Error('輸出格數 ' + total + ' 超過一維派發上限');
    const u = new Uint32Array([N, C, H, W, M, Cg, KH, KW, Hout, Wout, q.sh, q.sw, q.pt, q.pl, q.dh, q.dw, q.groups, b ? 1 : 0, 0, 0]);
    const outs = await nn.runWgsl(dev, WGSL_CONV2D,
      [{ data: Float32Array.from(x) }, { data: Float32Array.from(w) }, { data: b ? Float32Array.from(b) : new Float32Array(1) }, { data: new Float32Array(total), out: true }],
      new Uint8Array(u.buffer), Math.ceil(total / 64));
    return outs[0];
  }, null, () => conv2dRef(x, N, C, H, W, w, M, Cg, KH, KW, b, p)).then((r) => { o.lastInfo = r.info; return r.result; });
}

module.exports = { conv1dRef, conv2dRef, conv1d, conv2d, WGSL_CONV1D, WGSL_CONV2D, norm1, norm2 };
