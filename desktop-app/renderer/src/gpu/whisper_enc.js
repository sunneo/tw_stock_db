'use strict';
// Whisper 編碼器（onnx-community/whisper-base 的 q8 動態量化版，encoder_model_quantized.onnx）的手寫參考實作。
// 圖的結構（已逐節點確認）：DynamicQuantizeLinear → ConvInteger(k3,s1,p1) → +bias → GELU(erf) → DynamicQuantizeLinear → ConvInteger(k3,s2,p1) → +bias → GELU
//   → 轉置 [1500,512] + embed_positions → 6 層（LN → q/k/v MatMulInteger（k 無 bias）→ q·0.125 → 8 頭全注意力（fp32 MatMul/Softmax）→ DQL → out_proj → 殘差
//   → LN → DQL → fc1 → GELU → DQL → fc2 → 殘差）→ 最後 LN。LN：(x-mean)/sqrt(mean((x-mean)²)+1e-5)·w+b。
// 整數運算：uint8 權重與（DQL 後 uint8）激活各自減零點後做整數乘加（與 ConvInteger／MatMulInteger 同），再 ×(sx·sw)＋bias。
// ops（可選，GPU 版由 whisper_gpu.js 給）：conv(xs,C,L,ws,M,K,stride,pad,scale,bias)、mm(xs,T,K,ws,N,scale,bias)、attn(q,k,v,T)、ln(x,T,w,b)、gelu(x)；缺的用 CPU 參考。
const lite = require('./onnx_lite.js');
const CONV = require('./conv_ops.js');
const D = 512, NH = 8, HD = 64, T = 1500, NL = 6, EPS = 1e-5;
const f = Math.fround;
const f32 = (b) => { const o = new Float32Array(b.length / 4); new Uint8Array(o.buffer).set(b); return o; };

// 讀圖：所有權重（uint8 權重轉成「減零點後」的 Float32，整數值精確）
function loadEncoder(buf) {
  const m = lite.parseModel(buf);
  const byOut = {}; m.nodes.forEach((n) => n.outputs.forEach((o) => { byOut[o] = n; }));
  const initF = (n) => f32(lite.tensorBytes(m, n));
  const scalarF = (n) => lite.scalar(m, n);
  const q = (wName, zpName) => {
    const raw = lite.tensorBytes(m, wName), zp = lite.scalar(m, zpName), out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw[i] - zp;
    return out;
  };
  const lin = (nodeOut, biasName) => { // MatMulInteger 節點：inputs = [x_q, w_q, x_zp, w_zp]
    const n = byOut[nodeOut]; if (!n || n.op !== 'MatMulInteger') throw new Error('找不到 MatMulInteger ' + nodeOut);
    const w = n.inputs[1], dims = m.inits[w].dims;
    return { K: dims[0], N: dims[1], W: q(w, n.inputs[3]), sw: scalarF(w.replace(/_quantized$/, '_scale')), bias: biasName ? initF(biasName) : null };
  };
  const conv = (nm) => ({ W: q(nm + '.weight_quantized', nm + '.weight_zero_point'), sw: scalarF(nm + '.weight_scale'), bias: initF(nm + '.bias'), dims: m.inits[nm + '.weight_quantized'].dims });
  const layers = [];
  for (let i = 0; i < NL; i++) {
    const p = '/layers.' + i + '/', w = 'layers.' + i + '.';
    layers.push({
      ln1: { w: initF(w + 'self_attn_layer_norm.weight'), b: initF(w + 'self_attn_layer_norm.bias') },
      ln2: { w: initF(w + 'final_layer_norm.weight'), b: initF(w + 'final_layer_norm.bias') },
      q: lin(p + 'self_attn/q_proj/MatMul_output_0_output_quantized', w + 'self_attn.q_proj.bias'),
      k: lin(p + 'self_attn/k_proj/MatMul_output_0_output_quantized', null),
      v: lin(p + 'self_attn/v_proj/MatMul_output_0_output_quantized', w + 'self_attn.v_proj.bias'),
      o: lin(p + 'self_attn/out_proj/MatMul_output_0_output_quantized', w + 'self_attn.out_proj.bias'),
      fc1: lin(p + 'fc1/MatMul_output_0_output_quantized', w + 'fc1.bias'),
      fc2: lin(p + 'fc2/MatMul_output_0_output_quantized', w + 'fc2.bias'),
    });
  }
  return { conv1: conv('conv1'), conv2: conv('conv2'), pos: initF('embed_positions.weight'), layers, lnF: { w: initF('layer_norm.weight'), b: initF('layer_norm.bias') } };
}

// DynamicQuantizeLinear（ONNX 規格）：回傳 { xs: (q−zp)，Float32 整數值, scale }
function dql(x) {
  let mn = 0, mx = 0; for (let i = 0; i < x.length; i++) { if (x[i] < mn) mn = x[i]; if (x[i] > mx) mx = x[i]; }
  const scale = f(f(mx - mn) / 255);
  const rint = (v) => { const r = Math.round(v); return (Math.abs(v % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; };
  const zp = scale === 0 ? 0 : Math.min(255, Math.max(0, rint(f(-mn / scale))));
  const xs = new Float32Array(x.length);
  if (scale === 0) return { xs, scale };
  for (let i = 0; i < x.length; i++) xs[i] = Math.min(255, Math.max(0, rint(f(x[i] / scale)) + zp)) - zp;
  return { xs, scale };
}

// --- CPU 參考運算 ---
function mmRef(xs, Tn, K, ws, N, scale, bias) {
  const y = new Float32Array(Tn * N), acc = new Float64Array(N);
  for (let t = 0; t < Tn; t++) {
    acc.fill(0);
    for (let k = 0; k < K; k++) { const a = xs[t * K + k]; if (a === 0) continue; const wo = k * N; for (let n = 0; n < N; n++) acc[n] += a * ws[wo + n]; }
    for (let n = 0; n < N; n++) y[t * N + n] = f(f(acc[n]) * scale) + (bias ? bias[n] : 0);
  }
  return y;
}
function lnRef(x, Tn, w, b) {
  const y = new Float32Array(Tn * D);
  for (let t = 0; t < Tn; t++) {
    let mean = 0; for (let i = 0; i < D; i++) mean += x[t * D + i]; mean /= D;
    let v = 0; for (let i = 0; i < D; i++) { const d = x[t * D + i] - mean; v += d * d; } v /= D;
    const r = 1 / Math.sqrt(v + EPS);
    for (let i = 0; i < D; i++) y[t * D + i] = (x[t * D + i] - mean) * r * w[i] + b[i];
  }
  return y;
}
function erf(x) { // 高精度 erf（Numerical Recipes erfc 的 Chebyshev 擬合，相對誤差 < 1.2e-7）
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - r : r - 1;
}
function geluRef(x) { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * (erf(x[i] / Math.SQRT2) + 1) * 0.5; return y; }
function attnRef(q, k, v, Tn) { // q 已乘 0.125；[T,512]，頭 h 為列 h·64..h·64+63；全注意力
  const o = new Float32Array(Tn * D), sc = new Float64Array(Tn);
  for (let h = 0; h < NH; h++) for (let i = 0; i < Tn; i++) {
    let mx = -Infinity;
    for (let j = 0; j < Tn; j++) { let d = 0; for (let e = 0; e < HD; e++) d += q[i * D + h * HD + e] * k[j * D + h * HD + e]; sc[j] = d; if (d > mx) mx = d; }
    let s = 0; for (let j = 0; j < Tn; j++) { sc[j] = Math.exp(sc[j] - mx); s += sc[j]; }
    for (let j = 0; j < Tn; j++) { const p = sc[j] / s; for (let e = 0; e < HD; e++) o[i * D + h * HD + e] += p * v[j * D + h * HD + e]; }
  }
  return o;
}

// 單一層：x [1500,512] → 下一層輸入（逐層教師強迫對拍用：每層餵 ORT 的上一層輸出，隔離動態量化的混沌放大）
async function runLayer(W, li, x, ops) {
  const o = ops || {};
  const mmF = o.mm || (async (...a) => mmRef(...a)), lnF = o.ln || (async (...a) => lnRef(...a)), geluF = o.gelu || (async (xx) => geluRef(xx)), attnF = o.attn || (async (...a) => attnRef(...a));
  const lin = async (xx, P, Tn) => { const { xs, scale } = dql(xx); return mmF(xs, Tn, P.K, P.W, P.N, f(scale * P.sw), P.bias); };
  const L = W.layers[li];
  const h = await lnF(x, T, L.ln1.w, L.ln1.b);
  const q = await lin(h, L.q, T), k = await lin(h, L.k, T), v = await lin(h, L.v, T);
  for (let i = 0; i < q.length; i++) q[i] = f(q[i] * 0.125);
  const a = await attnF(q, k, v, T);
  const ao = await lin(a, L.o, T);
  const x2 = new Float32Array(T * D); for (let i = 0; i < x2.length; i++) x2[i] = x[i] + ao[i];
  const h2 = await lnF(x2, T, L.ln2.w, L.ln2.b);
  const mid = await geluF(await lin(h2, L.fc1, T));
  const dn = await lin(mid, L.fc2, T);
  const out = new Float32Array(T * D); for (let i = 0; i < out.length; i++) out[i] = x2[i] + dn[i];
  return out;
}

// x：input_features [80,3000]（列主序）→ last_hidden_state [1500,512]。progress(label, tensor) 可選（conv1、conv2、pos、layer0…5 各階段的中間張量，除錯對拍用）。
async function encode(W, feats, ops, progress) {
  const o = ops || {}, say = progress || (() => {});
  const convF = o.conv || (async (xs, C, L, ws, M, K, stride, pad, scale, bias) => {
    const y = CONV.conv1dRef(xs, 1, C, L, ws, M, C, K, null, { stride, pads: [pad, pad] });
    const Lo = y.length / M; for (let m = 0; m < M; m++) for (let l = 0; l < Lo; l++) y[m * Lo + l] = f(f(y[m * Lo + l]) * scale) + bias[m];
    return y;
  });
  const mmF = o.mm || (async (...a) => mmRef(...a)), lnF = o.ln || (async (...a) => lnRef(...a)), geluF = o.gelu || (async (x) => geluRef(x)), attnF = o.attn || (async (...a) => attnRef(...a));
  const lin = async (x, P, Tn) => { const { xs, scale } = dql(x); return mmF(xs, Tn, P.K, P.W, P.N, f(scale * P.sw), P.bias); };
  // 卷積：卷積核心用 conv_ops（[C,L] 佈局），ConvInteger 的整數累加對 float32 精確度見 DESIGN
  let d = dql(feats);
  let y = await geluF(await convF(d.xs, 80, 3000, W.conv1.W, 512, 3, 1, 1, f(d.scale * W.conv1.sw), W.conv1.bias));
  say('conv1', y);
  d = dql(y);
  y = await geluF(await convF(d.xs, 512, 3000, W.conv2.W, 512, 3, 2, 1, f(d.scale * W.conv2.sw), W.conv2.bias)); // [512,1500]
  say('conv2', y);
  let x = new Float32Array(T * D);
  for (let c = 0; c < D; c++) for (let t = 0; t < T; t++) x[t * D + c] = y[c * T + t] + W.pos[t * D + c];
  say('pos', x);
  for (let li = 0; li < NL; li++) { x = await runLayer(W, li, x, o); say('layer' + li, x); }
  return lnF(x, T, W.lnF.w, W.lnF.b);
}
module.exports = { loadEncoder, encode, runLayer, dql, mmRef, lnRef, geluRef, attnRef, erf, D, NH, HD, T, NL, EPS };
