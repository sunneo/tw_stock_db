// LLaVA-Interleave 0.5B 的 SigLIP 視覺編碼器逐層對拍（CPU，fp32，真權重）＋ 投影層。
// 每一層都用 ORT 給的「該層輸入」算一次，再與 ORT 的「該層輸出」比，所以誤差不會從前面的層累積過來。
// 層：LN1 → 多頭注意力（16 頭、head 維 72、縮放 1/√72、無遮罩、有偏置）→ 殘差 → LN2 → fc1 → GELU（tanh 近似）→ fc2 → 殘差。
// 投影層：linear_1（1152→1024，有偏置）→ 精確 GELU（erf）→ linear_2（1024→1024，有偏置）。
// 注意：每個中間結果都要重新跑一次 ORT 的整張圖（1.6GB），所以每個名稱各開一個工作階段，時間會較長。
// 用法：LLAVA_DIR=<含 vision_encoder.onnx 的目錄> [ORT_NODE_DIR=<onnxruntime-node 目錄>] node scripts/eval/llava_siglip_check.js
'use strict';
const path = require('path');
const dir = process.env.LLAVA_DIR;
if (!dir) { console.log('請設定 LLAVA_DIR'); process.exit(2); }
const ORT = require(process.env.ORT_NODE_DIR || 'onnxruntime-node');
const VIT = require(path.join(__dirname, '../../renderer/src/gpu/vit_skeleton.js'));
const { readNodes, withExtraOutputs } = require('./onnx_nodes.js');
const { initializers } = require('./smolvlm_onnx_initializers.js');

const vfile = path.join(dir, 'vision_encoder.onnx');
const S = 384, P = 14, C = 3, D = 1152, HEADS = 16, HD = 72, F = 4304, EPS = 1e-6, SCALE = 0.1178511306643486;
const EMB = '/vision_tower/vision_model/embeddings/Add_output_0';
const LAYERS = [0, 13, 25];
const outOf = (n) => '/vision_tower/vision_model/encoder/layers.' + n + '/Add_1_output_0';
const PROJ_IN = outOf(25);
const IMG = 'image_features';

function cmp(a, b) {
  let mx = 0, ss = 0, sr = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > mx) mx = d; ss += d * d; sr += b[i] * b[i]; }
  return { maxAbs: mx, relRms: Math.sqrt(ss / (sr || 1)) };
}
async function fetchOne(name, feeds) {
  const sess = await ORT.InferenceSession.create(withExtraOutputs(vfile, [name]), { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
  const o = await sess.run(feeds, [name]);
  const v = o[name] || o[Object.keys(o)[0]];
  await sess.release();
  return v;
}
// 逐 token 套用 Linear（W 為 [out][in]）
function linTokens(x, T, inD, outD, W, b) {
  const y = new Float32Array(T * outD);
  for (let t = 0; t < T; t++) { const r = VIT.linear(W, b, outD, inD, x.subarray(t * inD, t * inD + inD)); y.set(r, t * outD); }
  return y;
}
function lnTokens(x, T, g, b) {
  const y = new Float32Array(T * D);
  for (let t = 0; t < T; t++) y.set(VIT.layernorm(x.subarray(t * D, t * D + D), g, b, EPS), t * D);
  return y;
}
function attention(h, T, L) {
  const q = linTokens(h, T, D, D, L.wq, L.bq), k = linTokens(h, T, D, D, L.wk, L.bk), v = linTokens(h, T, D, D, L.wv, L.bv);
  const out = new Float32Array(T * D);
  for (let hh = 0; hh < HEADS; hh++) for (let i = 0; i < T; i++) {
    const sc = new Float32Array(T);
    for (let j = 0; j < T; j++) { let s = 0; for (let d = 0; d < HD; d++) s += q[i * D + hh * HD + d] * k[j * D + hh * HD + d]; sc[j] = s * SCALE; }
    let m = -Infinity; for (const s of sc) if (s > m) m = s;
    let z = 0; for (let j = 0; j < T; j++) { sc[j] = Math.exp(sc[j] - m); z += sc[j]; }
    for (let j = 0; j < T; j++) sc[j] /= z;
    for (let d = 0; d < HD; d++) { let s = 0; for (let j = 0; j < T; j++) s += sc[j] * v[j * D + hh * HD + d]; out[i * D + hh * HD + d] = s; }
  }
  return linTokens(out, T, D, D, L.wo, L.bo);
}
function layerRef(x, T, L) {
  const h = lnTokens(x, T, L.ln1g, L.ln1b);
  const a = attention(h, T, L);
  const x1 = new Float32Array(T * D); for (let i = 0; i < T * D; i++) x1[i] = x[i] + a[i];
  const h2 = lnTokens(x1, T, L.ln2g, L.ln2b);
  const m = linTokens(h2, T, D, F, L.w1, L.b1);
  for (let i = 0; i < m.length; i++) m[i] = VIT.geluTanh(m[i]);
  const d = linTokens(m, T, F, D, L.w2, L.b2);
  const y = new Float32Array(T * D); for (let i = 0; i < T * D; i++) y[i] = x1[i] + d[i];
  return y;
}
function gelu(v) { return 0.5 * v * (1 + erf(v / Math.SQRT2)); }
function erf(x) {
  const s = x < 0 ? -1 : 1; const ax = Math.abs(x); const t = 1 / (1 + 0.3275911 * ax);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax));
}

(async () => {
  // 權重：只抽需要的層。MatMul 的權重用「後面接的 Add 偏置名稱」來對應（與 smolvlm、florence 相同的追法）
  const nodes = readNodes(vfile);
  const wantLayer = (name) => LAYERS.some((n) => name.indexOf('vision_tower.vision_model.encoder.layers.' + n + '.') === 0);
  const raw = new Map();
  for (const t of initializers(vfile)) if (t.dataType === 1 && t.raw && (wantLayer(t.name) || /^multi_modal_projector\.linear_[12]\.bias$/.test(t.name) || /^multi_modal_projector\.linear_[12]\.bias$/.test(t.name))) {
    const ab = new ArrayBuffer(t.raw.length); new Uint8Array(ab).set(t.raw); raw.set(t.name, { dims: t.dims, data: new Float32Array(ab) });
  }
  const get = (n) => { const x = raw.get(n); if (!x) throw new Error('缺少權重 ' + n); return x.data; };
  // MatMul 權重：onnx::MatMul_* 的第二輸入，後面 Add 的偏置名稱決定它屬於哪一層、哪個投影
  const mmW = new Map();
  for (const n of nodes) if (n.op === 'MatMul' && n.inputs.length === 2 && /^onnx::MatMul/.test(n.inputs[1])) {
    const add = nodes.find((m) => m.op === 'Add' && m.inputs.indexOf(n.outputs[0]) >= 0 && m.inputs.some((s) => /\.bias$/.test(s)));
    if (!add) continue;
    const bias = add.inputs.find((s) => /\.bias$/.test(s));
    const key = bias.replace(/\.bias$/, '');
    mmW.set(key, n.inputs[1]);
  }
  const wRaw = new Map();
  for (const t of initializers(vfile)) if (t.dataType === 1 && t.raw && /^onnx::MatMul/.test(t.name) && (
      [...mmW.entries()].some(([k, w]) => w === t.name && (wantLayer(k) || /^multi_modal_projector/.test(k))))) {
    const ab = new ArrayBuffer(t.raw.length); new Uint8Array(ab).set(t.raw); wRaw.set(t.name, { dims: t.dims, data: new Float32Array(ab) });
  }
  // ONNX MatMul 權重是 [in][out]，骨架要 [out][in]
  const tr = (name) => { const w = wRaw.get(name); if (!w) throw new Error('缺少 MatMul 權重 ' + name); const inD = w.dims[0], outD = w.dims[1]; const o = new Float32Array(inD * outD); for (let r = 0; r < inD; r++) for (let c = 0; c < outD; c++) o[c * inD + r] = w.data[r * outD + c]; return o; };
  const layers = {};
  for (const n of LAYERS) {
    const p = 'vision_tower.vision_model.encoder.layers.' + n + '.';
    const wq = mmW.get(p + 'self_attn.q_proj'), wk = mmW.get(p + 'self_attn.k_proj'), wv = mmW.get(p + 'self_attn.v_proj');
    const wo = mmW.get(p + 'self_attn.out_proj'), w1 = mmW.get(p + 'mlp.fc1'), w2 = mmW.get(p + 'mlp.fc2');
    if (!wq || !wk || !wv || !wo || !w1 || !w2) throw new Error('層 ' + n + ' 的 MatMul 追不到');
    layers[n] = {
      ln1g: get(p + 'layer_norm1.weight'), ln1b: get(p + 'layer_norm1.bias'), ln2g: get(p + 'layer_norm2.weight'), ln2b: get(p + 'layer_norm2.bias'),
      wq: tr(wq), wk: tr(wk), wv: tr(wv), wo: tr(wo), w1: tr(w1), w2: tr(w2),
      bq: get(p + 'self_attn.q_proj.bias'), bk: get(p + 'self_attn.k_proj.bias'), bv: get(p + 'self_attn.v_proj.bias'), bo: get(p + 'self_attn.out_proj.bias'),
      b1: get(p + 'mlp.fc1.bias'), b2: get(p + 'mlp.fc2.bias'),
    };
  }
  const pw1 = mmW.get('multi_modal_projector.linear_1'), pw2 = mmW.get('multi_modal_projector.linear_2');
  if (!pw1 || !pw2) throw new Error('投影層的 MatMul 追不到');
  const proj = { w1: tr(pw1), b1: get('multi_modal_projector.linear_1.bias'), w2: tr(pw2), b2: get('multi_modal_projector.linear_2.bias') };
  console.log('權重就緒：層', LAYERS.join('、'), '，投影層 linear_1 權重', pw1, '、linear_2 權重', pw2);

  // 輸入：同一張合成影像（CHW 給 ORT）；裁成 378 給骨架時的 patch 嵌入不在這裡比，這裡從 ORT 的 EMB 開始
  const chw = new Float32Array(C * S * S);
  for (let c = 0; c < C; c++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) chw[(c * S + y) * S + x] = Math.sin(0.011 * x + 0.017 * y + 0.7 * c) * 0.9 + Math.cos(0.005 * x * y / S + c);
  const feeds = { pixel_values: new ORT.Tensor('float32', chw, [1, C, S, S]) };
  const T = 27 * 27;
  const ortEmb = (await fetchOne(EMB, feeds)).data;
  const results = {};
  for (const n of LAYERS) {
    const inName = n === 0 ? EMB : outOf(n - 1);
    const xin = n === 0 ? ortEmb : (await fetchOne(inName, feeds)).data;
    const ortOut = (await fetchOne(outOf(n), feeds)).data;
    const ref = layerRef(xin, T, layers[n]);
    results[n] = cmp(ref, ortOut);
    console.log('SigLIP 第 ' + n + ' 層（輸入來自 ORT 的 ' + inName + '）：', JSON.stringify(results[n]));
  }
  // 投影層：輸入是 ORT 的最後一層輸出
  const xl = (await fetchOne(PROJ_IN, feeds)).data;
  const ortImg = (await fetchOne(IMG, feeds)).data;
  const h1 = linTokens(xl, T, D, 1024, proj.w1, proj.b1);
  for (let i = 0; i < h1.length; i++) h1[i] = gelu(h1[i]);
  const img = linTokens(h1, T, 1024, 1024, proj.w2, proj.b2);
  const rImg = cmp(img, ortImg);
  console.log('投影層（linear_1→精確 GELU→linear_2）vs ORT image_features：', JSON.stringify(rImg));
  const pass = Object.values(results).every((r) => r.relRms < 1e-4) && rImg.relRms < 1e-4;
  console.log(pass ? '通過：SigLIP 第 0、13、25 層與投影層與 ORT 相符（各層以 ORT 輸入獨立計算）' : '不通過：見上面的數字');
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.log('ERR', e.stack || e.message); process.exit(1); });
