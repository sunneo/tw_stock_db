// cudnn_subset.js — 第三階段：cuDNN 子集與 ATen 對應表（DESIGN.webgpu-cuda.md §12.3）。
// 這一版只有 CPU 參考實作（Float64 內部計算，輸出為普通陣列）。WebGPU／WebGL2 版尚未實作，
// 所以每個函式的 info.layer 都是 'cpu-js'，並寫明原因，不假裝是 GPU 結果。
// 布局：NCHW（與 cuDNN 預設一致）；矩陣為列主序。
'use strict';

const NOTE_NO_GPU = '第三階段 GPU 版尚未實作，目前為 CPU 參考版';
function info(op, extra) {
  return Object.assign({ lib: 'cudnn-subset', op: op, layer: 'cpu-js', reason: NOTE_NO_GPU, accumulate: 'f64' }, extra || {});
}

function convOutSize(H, K, s, p) {
  if (s < 1 || K < 1) throw new Error('卷積：步幅與核心大小都必須 ≥ 1');
  const o = Math.floor((H + 2 * p - K) / s) + 1;
  if (o < 1) throw new Error('卷積：輸入太小，輸出尺寸為 ' + o);
  return o;
}

// x: [N,C,H,W]，w: [O,C,KH,KW]，b: [O] 或 null → y: [N,O,HO,WO]
function conv2dForward(x, w, b, dims, stride, pad) {
  const { N, C, H, W, O, KH, KW } = dims;
  const HO = convOutSize(H, KH, stride, pad), WO = convOutSize(W, KW, stride, pad);
  const y = new Float64Array(N * O * HO * WO);
  for (let n = 0; n < N; n++) for (let o = 0; o < O; o++) for (let i = 0; i < HO; i++) for (let j = 0; j < WO; j++) {
    let acc = b ? b[o] : 0;
    for (let c = 0; c < C; c++) for (let kh = 0; kh < KH; kh++) for (let kw = 0; kw < KW; kw++) {
      const hi = i * stride + kh - pad, wi = j * stride + kw - pad;
      if (hi < 0 || hi >= H || wi < 0 || wi >= W) continue;
      acc += x[((n * C + c) * H + hi) * W + wi] * w[((o * C + c) * KH + kh) * KW + kw];
    }
    y[((n * O + o) * HO + i) * WO + j] = acc;
  }
  return { y, info: info('conv2d_forward', { dims, stride, pad }) };
}

// 反向：給 dy，回傳 dx、dw、db（與前向同一組索引規則）
function conv2dBackward(x, w, dy, dims, stride, pad, hasBias) {
  const { N, C, H, W, O, KH, KW } = dims;
  const HO = convOutSize(H, KH, stride, pad), WO = convOutSize(W, KW, stride, pad);
  const dx = new Float64Array(x.length), dw = new Float64Array(w.length), db = hasBias ? new Float64Array(O) : null;
  for (let n = 0; n < N; n++) for (let o = 0; o < O; o++) for (let i = 0; i < HO; i++) for (let j = 0; j < WO; j++) {
    const g = dy[((n * O + o) * HO + i) * WO + j];
    if (db) db[o] += g;
    for (let c = 0; c < C; c++) for (let kh = 0; kh < KH; kh++) for (let kw = 0; kw < KW; kw++) {
      const hi = i * stride + kh - pad, wi = j * stride + kw - pad;
      if (hi < 0 || hi >= H || wi < 0 || wi >= W) continue;
      const xi = ((n * C + c) * H + hi) * W + wi, wj = ((o * C + c) * KH + kh) * KW + kw;
      dw[wj] += g * x[xi];
      dx[xi] += g * w[wj];
    }
  }
  return { dx, dw, db, info: info('conv2d_backward', { dims, stride, pad }) };
}

// 最大池化（無填補）：回傳 y 與 argmax（反向用，指向 x 的扁平索引；同值取第一個）
function maxPool2dForward(x, dims, K, S) {
  const { N, C, H, W } = dims;
  const HO = convOutSize(H, K, S, 0), WO = convOutSize(W, K, S, 0);
  const y = new Float64Array(N * C * HO * WO), arg = new Int32Array(N * C * HO * WO);
  for (let nc = 0; nc < N * C; nc++) for (let i = 0; i < HO; i++) for (let j = 0; j < WO; j++) {
    let best = -Infinity, bi = -1;
    for (let kh = 0; kh < K; kh++) for (let kw = 0; kw < K; kw++) {
      const xi = (nc * H + i * S + kh) * W + (j * S + kw);
      if (x[xi] > best) { best = x[xi]; bi = xi; }
    }
    const o = (nc * HO + i) * WO + j;
    y[o] = best; arg[o] = bi;
  }
  return { y, arg, info: info('max_pool2d_forward', { dims, K, S }) };
}

function maxPool2dBackward(dy, arg, xLen) {
  const dx = new Float64Array(xLen);
  for (let o = 0; o < dy.length; o++) dx[arg[o]] += dy[o];
  return { dx, info: info('max_pool2d_backward') };
}

// softmax：沿最後一維，數值穩定（減最大值）。x 長度 rows×cols
function softmaxRows(x, rows, cols) {
  const y = new Float64Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    let mx = -Infinity;
    for (let c = 0; c < cols; c++) if (x[r * cols + c] > mx) mx = x[r * cols + c];
    let s = 0;
    for (let c = 0; c < cols; c++) { const e = Math.exp(x[r * cols + c] - mx); y[r * cols + c] = e; s += e; }
    for (let c = 0; c < cols; c++) y[r * cols + c] /= s;
  }
  return { y, info: info('softmax', { rows, cols }) };
}

// 訓練模式 batchnorm：逐通道在 (N,H,W) 上統計。x: [N,C,H,W]（H*W 可為 1）
function batchNormForward(x, gamma, beta, dims, eps) {
  const { N, C, H, W } = dims, M = N * H * W;
  const xhat = new Float64Array(x.length), y = new Float64Array(x.length), inv = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    let mu = 0; for (let n = 0; n < N; n++) for (let p = 0; p < H * W; p++) mu += x[(n * C + c) * H * W + p];
    mu /= M;
    let v = 0; for (let n = 0; n < N; n++) for (let p = 0; p < H * W; p++) { const d = x[(n * C + c) * H * W + p] - mu; v += d * d; }
    v /= M;
    const iv = 1 / Math.sqrt(v + eps); inv[c] = iv;
    for (let n = 0; n < N; n++) for (let p = 0; p < H * W; p++) {
      const idx = (n * C + c) * H * W + p;
      xhat[idx] = (x[idx] - mu) * iv;
      y[idx] = gamma[c] * xhat[idx] + beta[c];
    }
  }
  return { y, xhat, inv, info: info('batchnorm_forward', { dims, eps }) };
}

function batchNormBackward(dy, xhat, inv, gamma, dims) {
  const { N, C, H, W } = dims, M = N * H * W;
  const dx = new Float64Array(dy.length), dgamma = new Float64Array(C), dbeta = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    let s1 = 0, s2 = 0;
    for (let n = 0; n < N; n++) for (let p = 0; p < H * W; p++) {
      const idx = (n * C + c) * H * W + p;
      s1 += dy[idx]; s2 += dy[idx] * xhat[idx];
    }
    dbeta[c] = s1; dgamma[c] = s2;
    for (let n = 0; n < N; n++) for (let p = 0; p < H * W; p++) {
      const idx = (n * C + c) * H * W + p;
      dx[idx] = gamma[c] * inv[c] / M * (M * dy[idx] - s1 - xhat[idx] * s2);
    }
  }
  return { dx, dgamma, dbeta, info: info('batchnorm_backward', { dims }) };
}

function reluForward(x) {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] > 0 ? x[i] : 0;
  return { y, info: info('activation_relu') };
}

// GELU（tanh 近似，與常見框架的 approximate='tanh' 相同公式）
function geluTanhForward(x) {
  const k = Math.sqrt(2 / Math.PI), y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) { const v = x[i]; y[i] = 0.5 * v * (1 + Math.tanh(k * (v + 0.044715 * v * v * v))); }
  return { y, info: info('activation_gelu_tanh') };
}

// 單頭縮放點積注意力：Q [T,D]、K [S,D]、V [S,E] → O [T,E]；causal 時遮掉 j > i
function attentionForward(Q, K, V, T, S, D, E, causal) {
  const sc = 1 / Math.sqrt(D);
  const scores = new Float64Array(T * S);
  for (let i = 0; i < T; i++) for (let j = 0; j < S; j++) {
    if (causal && j > i) { scores[i * S + j] = -Infinity; continue; }
    let z = 0; for (let u = 0; u < D; u++) z += Q[i * D + u] * K[j * D + u];
    scores[i * S + j] = z * sc;
  }
  const P = softmaxRows(scores, T, S).y;
  const O = new Float64Array(T * E);
  for (let i = 0; i < T; i++) for (let e = 0; e < E; e++) {
    let a = 0; for (let j = 0; j < S; j++) a += P[i * S + j] * V[j * E + e];
    O[i * E + e] = a;
  }
  return { O, P, info: info('attention_forward', { T, S, D, E, causal: !!causal }) };
}

// ATen 對應表（子集）：ATen 運算名 → 我們的實作與狀態。
// status: 'cpu' 已有 CPU 參考版；'gpu-t1' 已有 WebGPU 核心；'planned' 尚未實作。
// 注意：'gpu-t1' 目前只在 gpu_core.js 的核心上，且只有 WebGPU 第一階段的操作。
const ATEN_MAP = {
  'aten::mm': { ours: 'cudaweb.matmul / cuBLAS sgemm', status: 'gpu-t1', note: '只支援 f32，列主序' },
  'aten::addmm': { ours: 'matmul + 逐元素加', status: 'cpu', note: '偏置加法尚無獨立核心' },
  'aten::add': { ours: 'vector_add', status: 'gpu-t1', note: '' },
  'aten::mul': { ours: 'mulRef（CPU 參考版；WGSL mul 核心未開放給執行期）', status: 'cpu', note: '' },
  'aten::sum': { ours: 'sum（樹狀）與 sum_dd（雙 f32）', status: 'gpu-t1', note: '累加順序與 PyTorch 不同，結果需在容差內比對' },
  'aten::softmax': { ours: 'softmaxRows', status: 'cpu', note: '' },
  'aten::relu': { ours: 'reluForward', status: 'cpu', note: '' },
  'aten::gelu': { ours: 'geluTanhForward（tanh 近似）', status: 'cpu', note: '只實作 tanh 近似' },
  'aten::conv2d': { ours: 'conv2dForward（im2col 尚未做，直接迴圈）', status: 'cpu', note: '' },
  'aten::max_pool2d': { ours: 'maxPool2dForward', status: 'cpu', note: '無填補、無膨脹' },
  'aten::batch_norm': { ours: 'batchNormForward（訓練模式）', status: 'cpu', note: '不含執行中的平均與變異數緩衝' },
  'aten::scaled_dot_product_attention': { ours: 'attentionForward（單頭）', status: 'cpu', note: '不含多頭與 dropout' },
  'aten::index_add': { ours: 'scatter_add（CAS 原子加）', status: 'gpu-t1', note: '檔 A 無原子，退 CPU' },
};

function atenStatus(name) {
  return ATEN_MAP[name] || { ours: null, status: 'unsupported', note: '不在子集內，呼叫端應改走原本路徑或報錯' };
}

module.exports = {
  NOTE_NO_GPU, convOutSize,
  conv2dForward, conv2dBackward,
  maxPool2dForward, maxPool2dBackward,
  softmaxRows, batchNormForward, batchNormBackward,
  reluForward, geluTanhForward, attentionForward,
  ATEN_MAP, atenStatus,
};
