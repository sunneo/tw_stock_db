// Florence-2 語言編碼器第 0 層的真權重對拍（CPU，fp32）。
// 圖（由 encoder_model.onnx 的節點讀出）：自注意力（q、k、v 投影＋偏置、12 個頭、head 維 64、縮放 1/√64、加遮罩、Softmax）→ out_proj＋偏置 → 殘差（加回層輸入）
//   → self_attn_layer_norm → fc1＋偏置 → GELU（精確版：x·0.5·(1+erf(x/√2))）→ fc2＋偏置 → 殘差（加回 LayerNorm 的輸出）→ final_layer_norm。
// 中間結果用 withExtraOutputs 取出（每個名稱單獨一個工作階段，見 florence2_patch_embed_check.js 的註解）。
// 用法：FLORENCE_DIR=<含 encoder_model.onnx 的目錄> [ORT_NODE_DIR=<onnxruntime-node 目錄>] node scripts/eval/florence2_encoder_layer_check.js
'use strict';
const path = require('path');
const dir = process.env.FLORENCE_DIR;
if (!dir) { console.log('請設定 FLORENCE_DIR'); process.exit(2); }
const ORT = require(process.env.ORT_NODE_DIR || 'onnxruntime-node');
const { withExtraOutputs } = require('./onnx_nodes.js');
const { initializers } = require('./smolvlm_onnx_initializers.js');

const file = path.join(dir, 'encoder_model.onnx');
const D = 768, H = 12, HD = 64, F = 3072, EPS = 1e-5;
const X0 = '/layernorm_embedding/Add_1_output_0';   // 層 0 的輸入
const ATT = '/layers.0/Add_output_0';                // 注意力殘差之後
const OUT = '/layers.0/final_layer_norm/Add_1_output_0'; // 層 0 的輸出
const MASK = '/Where_1_output_0';                    // 加到注意力分數上的遮罩

function f32map(f) {
  const m = new Map();
  for (const t of initializers(f)) if (t.dataType === 1 && t.raw) { const ab = new ArrayBuffer(t.raw.length); new Uint8Array(ab).set(t.raw); m.set(t.name, { dims: t.dims, data: new Float32Array(ab) }); }
  return m;
}
function cmp(a, b) {
  let mx = 0, ss = 0, sr = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > mx) mx = d; ss += d * d; sr += b[i] * b[i]; }
  return { maxAbs: mx, relRms: Math.sqrt(ss / (sr || 1)) };
}
// y[t][o] = Σ_i x[t][i]·W[i][o] + b[o]，W 為 ONNX MatMul 的 [in][out]
function linearOnnx(x, T, inD, outD, W, b) {
  const y = new Float32Array(T * outD);
  for (let t = 0; t < T; t++) for (let o = 0; o < outD; o++) {
    let s = b[o];
    for (let i = 0; i < inD; i++) s += x[t * inD + i] * W[i * outD + o];
    y[t * outD + o] = s;
  }
  return y;
}
function layerNorm(x, T, g, b, eps) {
  const y = new Float32Array(T * D);
  for (let t = 0; t < T; t++) {
    let m = 0; for (let i = 0; i < D; i++) m += x[t * D + i]; m /= D;
    let v = 0; for (let i = 0; i < D; i++) { const d = x[t * D + i] - m; v += d * d; } v /= D;
    const inv = 1 / Math.sqrt(v + eps);
    for (let i = 0; i < D; i++) y[t * D + i] = (x[t * D + i] - m) * inv * g[i] + b[i];
  }
  return y;
}
// erf：Abramowitz–Stegun 7.1.26（絕對誤差約 1.5e-7，足以對 fp32 的 relRms 1e-4 門檻）
function erf(x) {
  const s = x < 0 ? -1 : 1; const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

async function fetchOne(name, feeds) {
  const sess = await ORT.InferenceSession.create(withExtraOutputs(file, [name]), { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
  const o = await sess.run(feeds, [name]);
  const v = o[name] || o[Object.keys(o)[0]];
  await sess.release();
  return v;
}

(async () => {
  const W = f32map(file);
  const get = (n) => { const x = W.get(n); if (!x) throw new Error('缺少權重 ' + n); return x.data; };
  const Wq = get('onnx::MatMul_877'), Wk = get('onnx::MatMul_878'), Wv = get('onnx::MatMul_885'), Wo = get('onnx::MatMul_889');
  const W1 = get('onnx::MatMul_890'), W2 = get('onnx::MatMul_891');
  const bq = get('layers.0.self_attn.q_proj.bias'), bk = get('layers.0.self_attn.k_proj.bias'), bv = get('layers.0.self_attn.v_proj.bias');
  const bo = get('layers.0.self_attn.out_proj.bias'), b1 = get('layers.0.fc1.bias'), b2 = get('layers.0.fc2.bias');
  const lnAg = get('layers.0.self_attn_layer_norm.weight'), lnAb = get('layers.0.self_attn_layer_norm.bias');
  const lnFg = get('layers.0.final_layer_norm.weight'), lnFb = get('layers.0.final_layer_norm.bias');

  // 合成輸入：inputs_embeds 直接給（不經過 embed_tokens），attention_mask 全 1
  const T = 12;
  const emb = new Float32Array(T * D);
  for (let t = 0; t < T; t++) for (let i = 0; i < D; i++) emb[t * D + i] = Math.sin(0.03 * i + 0.4 * t) * 0.8 + Math.cos(0.01 * i * t) * 0.3;
  const feeds = {
    inputs_embeds: new ORT.Tensor('float32', emb, [1, T, D]),
    attention_mask: new ORT.Tensor('int64', BigInt64Array.from({ length: T }, () => 1n), [1, T]),
  };
  const ortX0 = (await fetchOne(X0, feeds)).data;
  const ortMask = await fetchOne(MASK, feeds);
  const ortAtt = (await fetchOne(ATT, feeds)).data;
  const ortOut = (await fetchOne(OUT, feeds)).data;
  let maskMax = 0; for (const v of ortMask.data) if (Math.abs(v) > maskMax) maskMax = Math.abs(v);
  console.log('ORT：遮罩形狀', JSON.stringify(ortMask.dims), '，遮罩最大絕對值', maskMax, '（全 1 時應為 0）');
  if (maskMax !== 0) console.log('注意：遮罩不是全零，參考實作假設全零遮罩，結果可能不符。');

  // 參考：自注意力
  const q = linearOnnx(ortX0, T, D, D, Wq, bq), k = linearOnnx(ortX0, T, D, D, Wk, bk), v = linearOnnx(ortX0, T, D, D, Wv, bv);
  const scale = 1 / Math.sqrt(HD);
  const attnOut = new Float32Array(T * D);
  for (let h = 0; h < H; h++) for (let i = 0; i < T; i++) {
    const sc = new Float32Array(T);
    for (let j = 0; j < T; j++) { let s = 0; for (let d = 0; d < HD; d++) s += q[i * D + h * HD + d] * k[j * D + h * HD + d]; sc[j] = s * scale; }
    let m = -Infinity; for (const s of sc) if (s > m) m = s;
    let z = 0; for (let j = 0; j < T; j++) { sc[j] = Math.exp(sc[j] - m); z += sc[j]; }
    for (let j = 0; j < T; j++) sc[j] /= z;
    for (let d = 0; d < HD; d++) { let s = 0; for (let j = 0; j < T; j++) s += sc[j] * v[j * D + h * HD + d]; attnOut[i * D + h * HD + d] = s; }
  }
  const proj = linearOnnx(attnOut, T, D, D, Wo, bo);
  const attRef = new Float32Array(T * D); for (let i = 0; i < T * D; i++) attRef[i] = ortX0[i] + proj[i];
  const rAtt = cmp(attRef, ortAtt);
  console.log('注意力殘差輸出 vs ORT：', JSON.stringify(rAtt));

  // 參考：FFN 與兩個殘差
  const ln1 = layerNorm(attRef, T, lnAg, lnAb, EPS);
  const f1 = linearOnnx(ln1, T, D, F, W1, b1);
  const gelu = new Float32Array(T * F);
  for (let i = 0; i < T * F; i++) gelu[i] = f1[i] * 0.5 * (1 + erf(f1[i] / Math.SQRT2));
  const f2 = linearOnnx(gelu, T, F, D, W2, b2);
  const y = new Float32Array(T * D); for (let i = 0; i < T * D; i++) y[i] = ln1[i] + f2[i];
  const outRef = layerNorm(y, T, lnFg, lnFb, EPS);
  const rOut = cmp(outRef, ortOut);
  console.log('層 0 輸出 vs ORT：', JSON.stringify(rOut));
  const pass = rAtt.relRms < 1e-4 && rOut.relRms < 1e-4;
  console.log(pass ? '通過：語言編碼器第 0 層（自注意力＋FFN，CPU）與 ORT 相符' : '不通過：見上面的數字');
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.log('ERR', e.stack || e.message); process.exit(1); });
