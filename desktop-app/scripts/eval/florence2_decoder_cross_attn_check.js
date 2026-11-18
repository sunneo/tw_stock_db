// Florence-2 解碼器第 0 層「交叉注意力」的真權重對拍（CPU，fp32，無 KV 快取的第一步）。
// 來源：decoder_model.onnx（無 If 分支，中間結果都在頂層圖，可以取出）。
// 圖：q 來自 self_attn_layer_norm 的輸出 X；k、v 來自 encoder_hidden_states E（各自有偏置）；12 頭、head 維 64、縮放 1/√64、加交叉遮罩、Softmax、
//     out_proj＋偏置、殘差（加回 X）→ encoder_attn_layer_norm。
// 權重不靠名稱猜，而是從節點追出：MatMul 的第二個輸入是權重，後面接的 Add 的另一個輸入是偏置。
// 用法：FLORENCE_DIR=<含 decoder_model.onnx 的目錄> [ORT_NODE_DIR=<onnxruntime-node 目錄>] node scripts/eval/florence2_decoder_cross_attn_check.js
'use strict';
const path = require('path');
const dir = process.env.FLORENCE_DIR;
if (!dir) { console.log('請設定 FLORENCE_DIR'); process.exit(2); }
const ORT = require(process.env.ORT_NODE_DIR || 'onnxruntime-node');
const { readNodes, withExtraOutputs } = require('./onnx_nodes.js');
const { initializers } = require('./smolvlm_onnx_initializers.js');

const file = path.join(dir, 'decoder_model.onnx');
const D = 768, HEADS = 12, HD = 64, EPS_DEFAULT = 1e-5;

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
async function fetchOne(name, feeds) {
  const sess = await ORT.InferenceSession.create(withExtraOutputs(file, [name]), { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
  const o = await sess.run(feeds, [name]);
  const v = o[name] || o[Object.keys(o)[0]];
  await sess.release();
  return v;
}

(async () => {
  const nodes = readNodes(file);
  const byName = (suffix) => { const n = nodes.find((x) => x.name.endsWith(suffix)); if (!n) throw new Error('找不到節點 ' + suffix); return n; };
  const addAfter = (outName) => nodes.find((x) => x.op === 'Add' && x.inputs.indexOf(outName) >= 0 && x.inputs.some((s) => /bias/.test(s)) );
  const proj = (p) => {
    const mm = byName('layers.0/encoder_attn/' + p + '/MatMul');
    const add = addAfter(mm.outputs[0]);
    if (!add) throw new Error('找不到 ' + p + ' 的偏置 Add');
    const bias = add.inputs.find((s) => s !== mm.outputs[0]);
    return { w: mm.inputs[1], b: bias };
  };
  const pq = proj('q_proj'), pk = proj('k_proj'), pv = proj('v_proj'), po = proj('out_proj');
  const lnMul = byName('layers.0/encoder_attn_layer_norm/Mul'), lnAdd = byName('layers.0/encoder_attn_layer_norm/Add_1');
  const W = f32map(file);
  const get = (n) => { const x = W.get(n); if (!x) throw new Error('缺少權重 ' + n); return x.data; };
  const Wq = get(pq.w), Wk = get(pk.w), Wv = get(pv.w), Wo = get(po.w);
  const bq = get(pq.b), bk = get(pk.b), bv = get(pv.b), bo = get(po.b);
  const lg = get(lnMul.inputs[1]), lb = get(lnAdd.inputs[1]);
  // 常數：layer 的 encoder_attn_layer_norm/Constant_1 是 eps（與 encoder 相同的圖樣式）
  const epsName = [...W.keys()].find((k) => /layers\.0\/encoder_attn_layer_norm\/Constant_1_output_0$/.test(k));
  const EPS = epsName ? W.get(epsName).data[0] : EPS_DEFAULT;
  console.log('權重追出：q', pq.w, '，k', pk.w, '，v', pv.w, '，out', po.w, '；eps', EPS, epsName ? '（讀自 initializer）' : '（找不到，用預設）');

  const Tq = 6, Te = 7;
  const enc = new Float32Array(Te * D);
  for (let t = 0; t < Te; t++) for (let i = 0; i < D; i++) enc[t * D + i] = Math.sin(0.02 * i + 0.5 * t) * 0.7 + Math.cos(0.013 * i * (t + 1)) * 0.4;
  const emb = new Float32Array(Tq * D);
  for (let t = 0; t < Tq; t++) for (let i = 0; i < D; i++) emb[t * D + i] = Math.sin(0.03 * i + 0.4 * t) * 0.8;
  const feeds = {
    inputs_embeds: new (ORT.Tensor)('float32', emb, [1, Tq, D]),
    encoder_hidden_states: new (ORT.Tensor)('float32', enc, [1, Te, D]),
    encoder_attention_mask: new (ORT.Tensor)('int64', BigInt64Array.from({ length: Te }, () => 1n), [1, Te]),
  };
  const qIn = byName('layers.0/encoder_attn/q_proj/MatMul').inputs[0];   // 交叉注意力的查詢輸入（self_attn_layer_norm 的輸出）
  const X = (await fetchOne(qIn, feeds)).data;
  const mask = await fetchOne(byName('layers.0/encoder_attn/Add').inputs[1], feeds);
  const ortRes = (await fetchOne(byName('layers.0/Add_1').outputs[0], feeds)).data;
  const ortLn = (await fetchOne(lnAdd.outputs[0], feeds)).data;
  let mmax = 0; for (const v of mask.data) if (Math.abs(v) > mmax) mmax = Math.abs(v);
  console.log('ORT 交叉遮罩形狀', JSON.stringify(mask.dims), '，最大絕對值', mmax);
  if (mmax !== 0) console.log('注意：遮罩不是全零；參考實作假設全零，結果可能不符。');

  // 參考
  const q = linearOnnx(X, Tq, D, D, Wq, bq), k = linearOnnx(enc, Te, D, D, Wk, bk), v = linearOnnx(enc, Te, D, D, Wv, bv);
  const scale = 1 / Math.sqrt(HD);
  const attnOut = new Float32Array(Tq * D);
  for (let h = 0; h < HEADS; h++) for (let i = 0; i < Tq; i++) {
    const sc = new Float32Array(Te);
    for (let j = 0; j < Te; j++) { let s = 0; for (let d = 0; d < HD; d++) s += q[i * D + h * HD + d] * k[j * D + h * HD + d]; sc[j] = s * scale; }
    let m = -Infinity; for (const s of sc) if (s > m) m = s;
    let z = 0; for (let j = 0; j < Te; j++) { sc[j] = Math.exp(sc[j] - m); z += sc[j]; }
    for (let j = 0; j < Te; j++) sc[j] /= z;
    for (let d = 0; d < HD; d++) { let s = 0; for (let j = 0; j < Te; j++) s += sc[j] * v[j * D + h * HD + d]; attnOut[i * D + h * HD + d] = s; }
  }
  const proj2 = linearOnnx(attnOut, Tq, D, D, Wo, bo);
  const res = new Float32Array(Tq * D); for (let i = 0; i < Tq * D; i++) res[i] = X[i] + proj2[i];
  const rRes = cmp(res, ortRes);
  console.log('交叉注意力殘差輸出 vs ORT：', JSON.stringify(rRes));
  const lnOut = layerNorm(res, Tq, lg, lb, EPS);
  const rLn = cmp(lnOut, ortLn);
  console.log('encoder_attn_layer_norm 輸出 vs ORT：', JSON.stringify(rLn));
  const pass = rRes.relRms < 1e-4 && rLn.relRms < 1e-4;
  console.log(pass ? '通過：解碼器第 0 層交叉注意力（CPU）與 ORT 相符' : '不通過：見上面的數字');
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.log('ERR', e.stack || e.message); process.exit(1); });
