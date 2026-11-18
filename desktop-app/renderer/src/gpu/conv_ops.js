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
// R5：im2col＋平鋪矩陣乘（conv2d 的 groups=1、N=1 路徑）；載入失敗就退回直接卷積（不會選到不存在的核心）
let IM2COL = null, MM_TILED_WGSL = null;
try { IM2COL = require('./conv_im2col.js'); } catch (_) { IM2COL = null; }
try { MM_TILED_WGSL = require('./gpu_core.js').mmTileWgsl({ marker: 'matmul_tiled', dtype: 'f32' }); } catch (_) { MM_TILED_WGSL = null; }

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
  let idx = gid.x + gid.y * 4194240u;
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
  let idx = gid.x + gid.y * 4194240u;
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

const MAX_BUF = 134217728; // WebGPU 預設 maxStorageBufferBindingSize
function checkFit() { for (const n of arguments) if (n * 4 > MAX_BUF) throw new Error('張量 ' + n + ' 個 float 超過單一儲存緩衝區上限（128 MB），退 CPU'); }

// 純 JS 退路（cpu-js）與 T1 失敗時使用
async function conv1d(x, N, C, L, w, M, Cg, K, b, p, ops) {
  const o = ops || {};
  const q = norm1(p);
  const Lout = Math.floor((L + q.pad0 + q.pad1 - q.dil * (K - 1) - 1) / q.stride) + 1;
  if (o.gpu === false) return conv1dRef(x, N, C, L, w, M, Cg, K, b, p);
  return nn.tryLayers('conv1d', { navigator: o.navigator }, async (dev) => {
    const total = N * M * Lout;
    checkFit(total, x.length, w.length);
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
    checkFit(total, x.length, w.length);
    // R5：groups = 1、單一批次時用 im2col＋平鋪矩陣乘（實測 1.9 → 0.37 ms，2.7–5.3 倍，兩者對參考相對誤差都 ≤1e-6）；ops.conv === 'direct' 強制舊的直接卷積
    if (o.conv !== 'direct' && q.groups === 1 && N === 1 && IM2COL && MM_TILED_WGSL) {
      const K = C * KH * KW, P = Hout * Wout;
      const bt = nn.createBatch(dev);
      const hx = bt.upload(Float32Array.from(x)), hw = bt.upload(Float32Array.from(w));
      const hcol = bt.alloc(K * P), hy = bt.alloc(M * P);
      const uI = new Uint32Array([C, H, W, KH, KW, Hout, Wout, q.sh, q.sw, q.pt, q.pl, q.dh, q.dw, K * P, 0, 0]);
      const uM = new Int32Array([1, M, K, P, 0, 0, 0, 0]);
      bt.dispatchRaw(IM2COL.WGSL_IM2COL, [hx.buf, hcol.buf], new Uint8Array(uI.buffer), [Math.ceil(K * P / 64), 1, 1]);
      bt.dispatchRaw(MM_TILED_WGSL, [hw.buf, hcol.buf, hy.buf], new Uint8Array(uM.buffer), [Math.ceil(P / 64), Math.ceil(M / 64), 1]);
      const got = (await bt.read([[hy, M * P]]))[0];
      if (b) for (let m = 0; m < M; m++) for (let j = 0; j < P; j++) got[m * P + j] = Math.fround(got[m * P + j] + b[m]);
      return got;
    }
    const u = new Uint32Array([N, C, H, W, M, Cg, KH, KW, Hout, Wout, q.sh, q.sw, q.pt, q.pl, q.dh, q.dw, q.groups, b ? 1 : 0, 0, 0]);
    const outs = await nn.runWgsl(dev, WGSL_CONV2D,
      [{ data: Float32Array.from(x) }, { data: Float32Array.from(w) }, { data: b ? Float32Array.from(b) : new Float32Array(1) }, { data: new Float32Array(total), out: true }],
      new Uint8Array(u.buffer), Math.ceil(total / 64));
    return outs[0];
  }, null, () => conv2dRef(x, N, C, H, W, w, M, Cg, KH, KW, b, p)).then((r) => { o.lastInfo = r.info; return r.result; });
}

// ---------- 轉置卷積（ONNX ConvTranspose；Demucs 解碼器、Kokoro 聲碼器）----------
// x [N,C,H,W]；w [C, M/groups, KH, KW]；p = { strides, pads:[上,左,下,右], dilations, groups, outputPadding:[h,w] }。一維請以 H=1、KH=1 傳入（pads 的上下為 0）。
// 輸出 [N, M, Hout, Wout]，Hout = (H-1)·sh − pt − pb + dh·(KH−1) + oph + 1。
function normT(p) {
  const o = p || {}, pd = o.pads || [0, 0, 0, 0], op = o.outputPadding || [0, 0];
  return { sh: (o.strides || [1, 1])[0], sw: (o.strides || [1, 1])[1], pt: pd[0], pl: pd[1], pb: pd[2], pr: pd[3], dh: (o.dilations || [1, 1])[0], dw: (o.dilations || [1, 1])[1], groups: o.groups || 1, oph: op[0], opw: op[1] };
}
function convT2dDims(H, W, KH, KW, p) {
  const q = normT(p);
  return { Hout: (H - 1) * q.sh - q.pt - q.pb + q.dh * (KH - 1) + q.oph + 1, Wout: (W - 1) * q.sw - q.pl - q.pr + q.dw * (KW - 1) + q.opw + 1 };
}
function convT2dRef(x, N, C, H, W, w, Mg_total, KH, KW, b, p) {
  const q = normT(p), G = q.groups, M = Mg_total, Mg = M / G, Cg = C / G;
  const { Hout, Wout } = convT2dDims(H, W, KH, KW, p);
  const y = new Float64Array(N * M * Hout * Wout);
  for (let n = 0; n < N; n++) for (let ic = 0; ic < C; ic++) {
    const g = Math.floor(ic / Cg);
    for (let mm = 0; mm < Mg; mm++) {
      const m = g * Mg + mm;
      for (let ih = 0; ih < H; ih++) for (let iw = 0; iw < W; iw++) {
        const xv = x[((n * C + ic) * H + ih) * W + iw];
        for (let kh = 0; kh < KH; kh++) {
          const oh = ih * q.sh - q.pt + kh * q.dh; if (oh < 0 || oh >= Hout) continue;
          for (let kw = 0; kw < KW; kw++) {
            const ow = iw * q.sw - q.pl + kw * q.dw; if (ow < 0 || ow >= Wout) continue;
            y[((n * M + m) * Hout + oh) * Wout + ow] += xv * w[((ic * Mg + mm) * KH + kh) * KW + kw];
          }
        }
      }
    }
  }
  const out = new Float32Array(y.length);
  for (let n = 0; n < N; n++) for (let m = 0; m < M; m++) for (let i = 0; i < Hout * Wout; i++) { const k = (n * M + m) * Hout * Wout + i; out[k] = y[k] + (b ? b[m] : 0); }
  return out;
}
// GPU 用「聚集」形式：一個 invocation 一個輸出格，枚舉 (kh,kw) 並檢查 (o+pad−k·dil) 能被步幅整除。
const WGSL_CONVT2D = `
struct P { N: u32, C: u32, H: u32, W: u32, M: u32, KH: u32, KW: u32, Hout: u32, Wout: u32, sh: u32, sw: u32, pt: u32, pl: u32, dh: u32, dw: u32, groups: u32, hasB: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let total = p.N * p.M * p.Hout * p.Wout;
  let idx = gid.x + gid.y * 4194240u;
  if (idx >= total) { return; }
  let ow = idx % p.Wout;
  let oh = (idx / p.Wout) % p.Hout;
  let m = (idx / (p.Wout * p.Hout)) % p.M;
  let n = idx / (p.Wout * p.Hout * p.M);
  let Mg = p.M / p.groups;
  let Cg = p.C / p.groups;
  let g = m / Mg;
  let mm = m % Mg;
  var acc: f32 = 0.0;
  if (p.hasB == 1u) { acc = b[m]; }
  for (var kh: u32 = 0u; kh < p.KH; kh = kh + 1u) {
    let th = i32(oh) + i32(p.pt) - i32(kh * p.dh);
    if (th < 0 || (u32(th) % p.sh) != 0u) { continue; }
    let ih = u32(th) / p.sh;
    if (ih >= p.H) { continue; }
    for (var kw: u32 = 0u; kw < p.KW; kw = kw + 1u) {
      let tw = i32(ow) + i32(p.pl) - i32(kw * p.dw);
      if (tw < 0 || (u32(tw) % p.sw) != 0u) { continue; }
      let iw = u32(tw) / p.sw;
      if (iw >= p.W) { continue; }
      for (var c: u32 = 0u; c < Cg; c = c + 1u) {
        let ic = g * Cg + c;
        acc = acc + x[((n * p.C + ic) * p.H + ih) * p.W + iw] * w[((ic * Mg + mm) * p.KH + kh) * p.KW + kw];
      }
    }
  }
  y[idx] = acc;
}`;
async function convT2d(x, N, C, H, W, w, M, KH, KW, b, p, ops) {
  const o = ops || {}, q = normT(p), { Hout, Wout } = convT2dDims(H, W, KH, KW, p);
  if (o.gpu === false) return convT2dRef(x, N, C, H, W, w, M, KH, KW, b, p);
  const total = N * M * Hout * Wout;
  return nn.tryLayers('convT2d', { navigator: o.navigator }, async (dev) => {
    checkFit(total, x.length, w.length);
    const u = new Uint32Array([N, C, H, W, M, KH, KW, Hout, Wout, q.sh, q.sw, q.pt, q.pl, q.dh, q.dw, q.groups, b ? 1 : 0, 0, 0, 0]);
    const outs = await nn.runWgsl(dev, WGSL_CONVT2D,
      [{ data: Float32Array.from(x) }, { data: Float32Array.from(w) }, { data: b ? Float32Array.from(b) : new Float32Array(1) }, { data: new Float32Array(total), out: true }],
      new Uint8Array(u.buffer), Math.ceil(total / 64));
    return outs[0];
  }, null, () => convT2dRef(x, N, C, H, W, w, M, KH, KW, b, p)).then((r) => { o.lastInfo = r.info; return r.result; });
}

// ---------- 整數一維卷積（ONNX ConvInteger；Kokoro q8 圖）----------
// x uint8／int8 [N,C,L]、w uint8／int8 [M,Cg,K]、零點為純量 → int32 [N,M,Lout]；補零位置不貢獻（等於補上 x 的零點）。精確整數，GPU 結果必須與參考逐位相同。
function convInt1dRef(x, N, C, L, w, M, Cg, K, xzp, wzp, p) {
  const q = norm1(p), G = q.groups, Mg = M / G, Lout = Math.floor((L + q.pad0 + q.pad1 - q.dil * (K - 1) - 1) / q.stride) + 1;
  const y = new Int32Array(N * M * Lout);
  for (let n = 0; n < N; n++) for (let m = 0; m < M; m++) { const g = Math.floor(m / Mg);
    for (let t = 0; t < Lout; t++) { let acc = 0;
      for (let c = 0; c < Cg; c++) { const ic = g * Cg + c;
        for (let k = 0; k < K; k++) { const pos = t * q.stride - q.pad0 + k * q.dil; if (pos < 0 || pos >= L) continue;
          acc += (x[(n * C + ic) * L + pos] - xzp) * (w[(m * Cg + c) * K + k] - wzp); } }
      y[(n * M + m) * Lout + t] = acc; } }
  return y;
}
const WGSL_CONVINT1D = `
struct P { N: u32, C: u32, L: u32, M: u32, Cg: u32, K: u32, Lout: u32, stride: u32, pad0: u32, dil: u32, groups: u32, xzp: i32, wzp: i32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<i32>;
@group(0) @binding(2) var<storage, read_write> y: array<i32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x + gid.y * 4194240u;
  if (idx >= p.N * p.M * p.Lout) { return; }
  let t = idx % p.Lout;
  let m = (idx / p.Lout) % p.M;
  let n = idx / (p.Lout * p.M);
  let g = m / (p.M / p.groups);
  var acc: i32 = 0;
  for (var c: u32 = 0u; c < p.Cg; c = c + 1u) {
    let ic = g * p.Cg + c;
    for (var k: u32 = 0u; k < p.K; k = k + 1u) {
      let pos = i32(t * p.stride) - i32(p.pad0) + i32(k * p.dil);
      if (pos >= 0 && u32(pos) < p.L) {
        acc = acc + (x[(n * p.C + ic) * p.L + u32(pos)] - p.xzp) * (w[(m * p.Cg + c) * p.K + k] - p.wzp);
      }
    }
  }
  y[idx] = acc;
}`;
async function convInt1d(x, N, C, L, w, M, Cg, K, xzp, wzp, p, ops) {
  const o = ops || {}, q = norm1(p), Lout = Math.floor((L + q.pad0 + q.pad1 - q.dil * (K - 1) - 1) / q.stride) + 1, total = N * M * Lout;
  if (o.gpu === false) return convInt1dRef(x, N, C, L, w, M, Cg, K, xzp, wzp, p);
  return nn.tryLayers('convInt1d', { navigator: o.navigator }, async (dev) => {
    checkFit(total, x.length, w.length);
    const u = new Int32Array([N, C, L, M, Cg, K, Lout, q.stride, q.pad0, q.dil, q.groups, xzp, wzp, 0, 0, 0]);
    const outs = await nn.runWgsl(dev, WGSL_CONVINT1D,
      [{ data: Int32Array.from(x) }, { data: Int32Array.from(w) }, { data: new Int32Array(total), out: true }],
      new Uint8Array(u.buffer), Math.ceil(total / 64));
    return outs[0];
  }, null, () => convInt1dRef(x, N, C, L, w, M, Cg, K, xzp, wzp, p)).then((r) => { o.lastInfo = r.info; return r.result; });
}

module.exports = { conv1dRef, conv2dRef, conv1d, conv2d, convT2dRef, convT2d, convT2dDims, convInt1dRef, convInt1d, WGSL_CONVINT1D, WGSL_CONV1D, WGSL_CONV2D, WGSL_CONVT2D, norm1, norm2, normT };
