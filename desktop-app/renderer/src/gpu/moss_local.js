'use strict';
// MOSS-TTS-Nano 本地解碼器（moss_tts_local_decoder.onnx，非快取版）的 CPU 參考版（已逐節點確認）。
// 序列共 17 個位置：0 = global_hidden（768）；1 = 文字詞元的嵌入（model.transformer.wte）；2..16 = 15 條音訊前綴的嵌入（model.audio_embeddings.c，pad=1024 歸零）。
// 單層 pre-norm 因果 Transformer（12 頭、頭維 64、RoPE 交錯式 θ=10000、縮放 0.125、LN eps 1e-5、GELU tanh 近似），最後 ln_f。
// 輸出：text_logits = W_text · out[0]；audio_logits[c] = W_audio_c · out[c+1]（c = 0..15）。
const lite = require('./onnx_lite.js');
const MS = require('./moss_decoder.js');

const D = 768, H = 12, HD = 64, FF = 3072, NCH_PREFIX = 15, NAUDIO = 16, PAD = 1024, SCALE = 0.125, THETA = 10000;

function loadMossLocal(onnxBuf, dataFiles) {
  const m = lite.parseModel(onnxBuf);
  m.aliases = {};
  for (const n of m.nodes) if (n.op === 'Identity' && n.inputs.length && n.outputs.length) m.aliases[n.outputs[0]] = n.inputs[0];
  const mm = (base) => {
    const n = m.nodes.find((x) => x.op === 'MatMul' && x.outputs[0] === base + '/MatMul_output_0');
    if (!n) throw new Error('moss_local：找不到 MatMul ' + base);
    return MS.readInit(m, n.inputs[1], dataFiles);
  };
  const p = 'model.local_transformer.h.0.';
  const layer = {
    ln1w: MS.readInit(m, p + 'ln_1.weight', dataFiles).data, ln1b: MS.readInit(m, p + 'ln_1.bias', dataFiles).data,
    ln2w: MS.readInit(m, p + 'ln_2.weight', dataFiles).data, ln2b: MS.readInit(m, p + 'ln_2.bias', dataFiles).data,
    cAttn: mm('/c_attn'), cAttnB: MS.readInit(m, p + 'attn.c_attn.bias', dataFiles).data,
    cProj: mm('/c_proj'), cProjB: MS.readInit(m, p + 'attn.c_proj.bias', dataFiles).data,
    fcIn: mm('/mlp/fc_in'), fcInB: MS.readInit(m, p + 'mlp.fc_in.bias', dataFiles).data,
    fcOut: mm('/mlp/fc_out'), fcOutB: MS.readInit(m, p + 'mlp.fc_out.bias', dataFiles).data,
  };
  const audioHeads = [];
  for (let c = 0; c < NAUDIO; c++) audioHeads.push(mm('/audio_lm_heads.' + c));
  return {
    wteText: MS.readInit(m, 'model.transformer.wte.weight', dataFiles),
    audioEmb: Array.from({ length: NCH_PREFIX }, (_, c) => MS.readInit(m, 'model.audio_embeddings.' + c + '.weight', dataFiles)),
    layer,
    lnFw: MS.readInit(m, 'model.local_transformer.h.0.ln_1.weight', dataFiles).data,
    lnFb: MS.readInit(m, 'model.local_transformer.ln_f.bias', dataFiles).data,
    textHead: mm('/text_lm_head'),
    audioHeads,
  };
}

// 17×768 的因果注意力（列優先 T×D）；q/k 已 RoPE，位置為列號
function ropeRows(X, T) {
  const o = new Float32Array(T * D);
  for (let t = 0; t < T; t++) {
    const r = MS.rope(X.subarray(t * D, (t + 1) * D), t);
    o.set(r, t * D);
  }
  return o;
}

// 單層前向（非快取）：x 為 T×D。回傳 T×D。
function layerForward(x, T, L) {
  const h = new Float32Array(T * D);
  for (let t = 0; t < T; t++) h.set(MS.layerNorm(x.subarray(t * D, (t + 1) * D), L.ln1w, L.ln1b), t * D);
  const qkv = new Float32Array(T * 3 * D);
  for (let t = 0; t < T; t++) qkv.set(MS.linearCpu(h.subarray(t * D, (t + 1) * D), L.cAttn.data, D, 3 * D, L.cAttnB), t * 3 * D);
  const q = new Float32Array(T * D), k = new Float32Array(T * D), v = new Float32Array(T * D);
  for (let t = 0; t < T; t++) { q.set(qkv.subarray(t * 3 * D, t * 3 * D + D), t * D); k.set(qkv.subarray(t * 3 * D + D, t * 3 * D + 2 * D), t * D); v.set(qkv.subarray(t * 3 * D + 2 * D, t * 3 * D + 3 * D), t * D); }
  const qr = ropeRows(q, T), kr = ropeRows(k, T);
  const ao = new Float32Array(T * D);
  for (let t = 0; t < T; t++) for (let hh = 0; hh < H; hh++) {
    const sc = new Float64Array(t + 1);
    let mx = -Infinity;
    for (let j = 0; j <= t; j++) {
      let dot = 0;
      for (let d = 0; d < HD; d++) dot += qr[t * D + hh * HD + d] * kr[j * D + hh * HD + d];
      sc[j] = dot * SCALE; if (sc[j] > mx) mx = sc[j];
    }
    let sum = 0; for (let j = 0; j <= t; j++) { sc[j] = Math.exp(sc[j] - mx); sum += sc[j]; }
    for (let j = 0; j <= t; j++) { const pj = sc[j] / sum; for (let d = 0; d < HD; d++) ao[t * D + hh * HD + d] += pj * v[j * D + hh * HD + d]; }
  }
  const out = new Float32Array(T * D);
  for (let t = 0; t < T; t++) {
    const pr = MS.linearCpu(ao.subarray(t * D, (t + 1) * D), L.cProj.data, D, D, L.cProjB);
    for (let i = 0; i < D; i++) out[t * D + i] = x[t * D + i] + pr[i];
  }
  const out2 = new Float32Array(T * D);
  for (let t = 0; t < T; t++) {
    const h2 = MS.layerNorm(out.subarray(t * D, (t + 1) * D), L.ln2w, L.ln2b);
    const f1 = MS.linearCpu(h2, L.fcIn.data, D, FF, L.fcInB);
    const g = MS.geluCpu(f1);
    const f2 = MS.linearCpu(g, L.fcOut.data, FF, D, L.fcOutB);
    for (let i = 0; i < D; i++) out2[t * D + i] = out[t * D + i] + f2[i];
  }
  return out2;
}

// 一次本地前向。globalHidden：768；textId：整數；audioPrefix：15 個整數（pad=1024）。
// 回傳 { textLogits: Float32Array, audioLogits: Float32Array[16] }
function localDecode(model, globalHidden, textId, audioPrefix) {
  const T = 2 + NCH_PREFIX;
  const x = new Float32Array(T * D);
  x.set(globalHidden, 0);
  x.set(model.wteText.data.subarray(textId * D, (textId + 1) * D), D);
  for (let c = 0; c < NCH_PREFIX; c++) {
    const id = audioPrefix[c];
    if (id === PAD) continue;
    x.set(model.audioEmb[c].data.subarray(id * D, (id + 1) * D), (2 + c) * D);
  }
  const out = layerForward(x, T, model.layer);
  const hf = new Float32Array(T * D);
  for (let t = 0; t < T; t++) hf.set(MS.layerNorm(out.subarray(t * D, (t + 1) * D), model.lnFw, model.lnFb), t * D);
  const textLogits = MS.linearCpu(hf.subarray(0, D), model.textHead.data, D, model.textHead.dims[1], null);
  const audioLogits = model.audioHeads.map((hd, c) => MS.linearCpu(hf.subarray((c + 1) * D, (c + 2) * D), hd.data, D, hd.dims[1], null));
  return { textLogits, audioLogits };
}

module.exports = { loadMossLocal, localDecode, layerForward, D, PAD };
