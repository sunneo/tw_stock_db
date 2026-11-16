'use strict';
// MOSS-TTS-Nano 全域解碼一步（moss_tts_decode_step.onnx）的手寫 CPU 參考版（已逐節點確認運算）。
// 結構（GPT-2 式，12 層，隱藏 768，12 頭，頭維 64）：
//   輸入 ids 是一列 17 個欄位：第 0 欄是文字詞元（wte），第 1..16 欄是 16 條音訊碼本（audio_embeddings.0..15，pad=1024 時該列歸零）；各列相加。
//   每層：LN(ln_1) → c_attn（768→2304，切成 q/k/v）→ q、k 做交錯式 RoPE（位置 = 過去有效長度，inv_freq = 10000^(−2i/64)）
//         → 寫入 KV 快取（時間優先佈局 [L][H][D]）→ 因果注意力（縮放 0.125；單一詞元時 j ≤ 過去長度，全部可見）→ c_proj → 殘差
//         → LN(ln_2) → fc_in → GELU（tanh 近似）→ fc_out → 殘差。
//   最後 ln_f → global_hidden（768）。ln_f 的權重在圖中是 h.0.ln_1.weight 的 Identity 別名，這裡照圖使用。
// 權重：float32；大檔在 *.data（外部資料），這裡依 ext.location／offset／length 從傳入的檔案切出。
const lite = require('./onnx_lite.js');

const D = 768, H = 12, HD = 64, FF = 3072, NL = 12, NCH = 16, PAD = 1024, EPS = 1e-5, SCALE = 0.125, THETA = 10000;

function readInit(m, name, dataFiles) {
  // 圖中有些權重名是 Identity 節點的輸出（別名），照圖解析到來源初始值
  const nm = (!m.inits[name] && m.aliases && m.aliases[name]) ? m.aliases[name] : name;
  const t = m.inits[nm];
  if (!t) throw new Error('moss_decoder：沒有權重 ' + name);
  let bytes;
  if (t.raw) bytes = m.buf.subarray(t.raw[0], t.raw[1]);
  else if (t.ext && t.ext.location) {
    const f = dataFiles[t.ext.location];
    if (!f) throw new Error('moss_decoder：缺少外部資料檔 ' + t.ext.location);
    const off = Number(t.ext.offset || 0), len = Number(t.ext.length);
    bytes = f.subarray(off, off + len);
  } else throw new Error('moss_decoder：權重 ' + name + ' 沒有資料');
  const o = new Float32Array(bytes.length / 4);
  new Uint8Array(o.buffer).set(bytes);
  return { data: o, dims: t.dims };
}

// dataFiles：{ "檔名.data": Uint8Array }。回傳模型物件（權重皆為 Float32Array）。
function loadMossDecodeStep(onnxBuf, dataFiles) {
  const m = lite.parseModel(onnxBuf);
  m.aliases = {};
  for (const n of m.nodes) if (n.op === 'Identity' && n.inputs.length && n.outputs.length) m.aliases[n.outputs[0]] = n.inputs[0];
  // 找出每個 MatMul 的權重名（節點名含層號後綴）
  const mmWeight = (base) => {
    const n = m.nodes.find((x) => x.op === 'MatMul' && x.outputs[0] === base + '/MatMul_output_0');
    if (!n) throw new Error('moss_decoder：找不到 MatMul ' + base);
    return readInit(m, n.inputs[1], dataFiles);
  };
  const layers = [];
  for (let i = 0; i < NL; i++) {
    const sfx = i === 0 ? '' : '_' + i;
    const p = 'core.model.transformer.h.' + i + '.';
    layers.push({
      ln1w: readInit(m, p + 'ln_1.weight', dataFiles).data, ln1b: readInit(m, p + 'ln_1.bias', dataFiles).data,
      ln2w: readInit(m, p + 'ln_2.weight', dataFiles).data, ln2b: readInit(m, p + 'ln_2.bias', dataFiles).data,
      cAttnW: mmWeight('/c_attn' + sfx), cAttnB: readInit(m, p + 'attn.c_attn.bias', dataFiles).data,
      cProjW: mmWeight('/c_proj' + sfx), cProjB: readInit(m, p + 'attn.c_proj.bias', dataFiles).data,
      fcInW: mmWeight('/mlp/fc_in' + sfx), fcInB: readInit(m, p + 'mlp.fc_in.bias', dataFiles).data,
      fcOutW: mmWeight('/mlp/fc_out' + sfx), fcOutB: readInit(m, p + 'mlp.fc_out.bias', dataFiles).data,
    });
  }
  const audio = [];
  for (let c = 0; c < NCH; c++) audio.push(readInit(m, 'core.model.audio_embeddings.' + c + '.weight', dataFiles));
  return {
    wte: readInit(m, 'core.model.transformer.wte.weight', dataFiles),
    audio,
    layers,
    // ln_f 權重是 h.0.ln_1.weight 的別名（見檔頭）
    lnFw: readInit(m, 'core.model.transformer.h.0.ln_1.weight', dataFiles).data,
    lnFb: readInit(m, 'core.model.transformer.ln_f.bias', dataFiles).data,
  };
}

// 逐列 LayerNorm（x 長度 D）
function layerNorm(x, w, b) {
  let mu = 0; for (let i = 0; i < D; i++) mu += x[i]; mu /= D;
  let v = 0; for (let i = 0; i < D; i++) v += (x[i] - mu) * (x[i] - mu); v /= D;
  const r = 1 / Math.sqrt(v + EPS);
  const o = new Float32Array(D);
  for (let i = 0; i < D; i++) o[i] = (x[i] - mu) * r * w[i] + b[i];
  return o;
}

// y = x · W + b，W 形狀 [K, N]（列優先）
function linear(x, W, K, N, b) {
  const y = new Float32Array(N);
  for (let n = 0; n < N; n++) y[n] = b ? b[n] : 0;
  for (let k = 0; k < K; k++) {
    const xv = x[k], wo = k * N;
    for (let n = 0; n < N; n++) y[n] += xv * W[wo + n];
  }
  return y;
}

// 交錯式 RoPE（單一詞元，位置 pos）：配對 (2i, 2i+1)，角度 pos·θ^(−2i/64)
function rope(x, pos) {
  const o = new Float32Array(D);
  for (let h = 0; h < H; h++) for (let i = 0; i < HD / 2; i++) {
    const f = pos * Math.pow(THETA, -2 * i / HD), c = Math.cos(f), s = Math.sin(f);
    const b = h * HD + 2 * i, e = x[b], od = x[b + 1];
    o[b] = e * c - od * s;
    o[b + 1] = od * c + e * s;
  }
  return o;
}

// 一步解碼。ids：17 個整數（第 0 欄文字，1..16 音訊碼）；caches：每層 {K, V, L}（K/V 為 L×H×HD，時間優先）。
// 回傳 { hidden: Float32Array(768), caches }（新快取長度 L+1）。
function decodeStep(model, ids, caches) {
  const past = caches ? caches[0].L : 0;
  // 嵌入：文字 + 音訊（pad 歸零）
  let x = new Float32Array(D);
  const tw = model.wte.data, to = ids[0] * D;
  for (let i = 0; i < D; i++) x[i] = tw[to + i];
  for (let c = 0; c < NCH; c++) {
    const id = ids[c + 1];
    if (id === PAD) continue;
    const tab = model.audio[c].data, o = id * D;
    for (let i = 0; i < D; i++) x[i] += tab[o + i];
  }
  const next = [];
  for (let li = 0; li < NL; li++) {
    const L = model.layers[li];
    const h = layerNorm(x, L.ln1w, L.ln1b);
    const qkv = linear(h, L.cAttnW.data || L.cAttnW, D, 3 * D, L.cAttnB);
    const q = rope(qkv.subarray(0, D), past);
    const k = rope(qkv.subarray(D, 2 * D), past);
    const v = qkv.subarray(2 * D, 3 * D);
    const Ln = past + 1;
    const Kc = new Float32Array(Ln * D), Vc = new Float32Array(Ln * D);
    if (past > 0) { Kc.set(caches[li].K.subarray(0, past * D)); Vc.set(caches[li].V.subarray(0, past * D)); }
    Kc.set(k, past * D); Vc.set(v, past * D);
    next.push({ K: Kc, V: Vc, L: Ln });
    // 注意力：每個頭對所有 j ≤ past 計分（單一詞元，遮罩全部可見）
    const ao = new Float32Array(D);
    for (let hh = 0; hh < H; hh++) {
      const qo = hh * HD;
      const sc = new Float64Array(Ln);
      let mx = -Infinity;
      for (let j = 0; j < Ln; j++) {
        let dot = 0; const ko = j * D + hh * HD;
        for (let d = 0; d < HD; d++) dot += q[qo + d] * Kc[ko + d];
        sc[j] = dot * SCALE; if (sc[j] > mx) mx = sc[j];
      }
      let sum = 0; for (let j = 0; j < Ln; j++) { sc[j] = Math.exp(sc[j] - mx); sum += sc[j]; }
      for (let j = 0; j < Ln; j++) {
        const p = sc[j] / sum, vo = j * D + hh * HD;
        for (let d = 0; d < HD; d++) ao[hh * HD + d] += p * Vc[vo + d];
      }
    }
    const pr = linear(ao, L.cProjW.data || L.cProjW, D, D, L.cProjB);
    for (let i = 0; i < D; i++) x[i] += pr[i];
    const h2 = layerNorm(x, L.ln2w, L.ln2b);
    const f1 = linear(h2, L.fcInW.data || L.fcInW, D, FF, L.fcInB);
    for (let i = 0; i < FF; i++) { const g = f1[i]; f1[i] = 0.5 * g * (1 + Math.tanh(0.7978846 * (g + 0.044715 * g * g * g))); }
    const f2 = linear(f1, L.fcOutW.data || L.fcOutW, FF, D, L.fcOutB);
    for (let i = 0; i < D; i++) x[i] += f2[i];
  }
  const hidden = layerNorm(x, model.lnFw, model.lnFb);
  return { hidden, caches: next };
}

module.exports = { loadMossDecodeStep, decodeStep, readInit, layerNorm, linear, rope, D, H, HD, NL, NCH, PAD };
