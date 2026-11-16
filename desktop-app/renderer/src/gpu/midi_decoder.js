'use strict';
// midigenai v5 解碼器（網頁 q4 版，ONNX）的手寫 CPU 參考版：依圖的實際運算（已逐節點確認）。
// 結構：12 層 pre-norm；每層 attn_norm → q/k/v（MatMulNBits）→ 交錯式 RoPE（偶奇配對，inv_freq 32 個）→ 寫入 KV 快取 → 注意力（scale 1/√64，因果遮罩）
//       → o_proj → 殘差；ffn_norm → gate、up（MatMulNBits）→ SiLU(gate)·up → down → 殘差。
// 最後：norm → Slice 取最後一個位置 → lm_head（MatMulNBits，K=768、N=598）→ logits。RMSNorm：x·w / sqrt(mean(x²)+1e-6)。
// 矩陣乘透過 mm(name, X, T) 注入：CPU 版用 matmulnbits_ref；之後 GPU 版換成 matmulnbits_gpu。
const lite = require('./onnx_lite.js');
const REF = require('./matmulnbits_ref.js');

const H = 12, HD = 64, D = H * HD, EPS = 1e-6, SCALE = 0.125, NL = 12;

function f32Copy(bytes) { const n = bytes.length / 4, o = new Float32Array(n); new Uint8Array(o.buffer).set(bytes); return o; }
function u8Copy(bytes) { return new Uint8Array(bytes); }

// 讀入模型：回傳 { layers:[{attnNorm, ffnNorm, q, k, v, o, gate, up, down}], norm, lmHead, embed, invFreq }
// 每個投影是 { name, B, S（scales f32）, K, N }。name 是圖中 MatMulNBits 節點的輸出名（mm 用它找 GPU 快取）。
function loadMidiDecoder(buf) {
  const m = lite.parseModel(buf);
  const mm = new Map();
  for (const n of m.nodes) if (n.op === 'MatMulNBits') {
    const q = m.inits[n.inputs[1]], s = m.inits[n.inputs[2]];
    mm.set(n.outputs[0], { name: n.outputs[0], K: n.attrs.K.i, N: n.attrs.N.i, B: u8Copy(lite.tensorBytes(m, n.inputs[1])), S: f32Copy(lite.tensorBytes(m, n.inputs[2])), qDims: q.dims, sDims: s.dims });
  }
  const proj = (base) => { const p = mm.get(base + '/MatMul_output_0'); if (!p) throw new Error('找不到投影 ' + base); return p; };
  const layers = [];
  for (let i = 0; i < NL; i++) {
    const sfx = i === 0 ? '' : '_' + i;
    layers.push({
      attnNorm: f32Copy(lite.tensorBytes(m, 'm.blocks.' + i + '.attn_norm.weight')),
      ffnNorm: f32Copy(lite.tensorBytes(m, 'm.blocks.' + i + '.ffn_norm.weight')),
      q: proj('/q_proj' + sfx), k: proj('/k_proj' + sfx), v: proj('/v_proj' + sfx), o: proj('/o_proj' + sfx),
      gate: proj('/ffn/gate' + sfx), up: proj('/ffn/up' + sfx), down: proj('/ffn/down' + sfx),
    });
  }
  return {
    layers,
    norm: f32Copy(lite.tensorBytes(m, 'm.norm.weight')),
    lmHead: proj('/lm_head'),
    embed: f32Copy(lite.tensorBytes(m, 'm.embed.weight')), // [598, 768]
    invFreq: f32Copy(lite.tensorBytes(m, 'inv_freq')),     // [32]
    VOCAB: 598,
    projs: mm,
  };
}

// 純 CPU 的矩陣乘（參考）：X 是 T×K（Float32Array），回傳 T×N
function cpuMatmul(p, X, T) { return REF.matmulNBitsRef(X, T, p.K, p.B, p.S, p.N); }

// RMSNorm，逐列：x·w / sqrt(mean(x²)+eps)
function rmsRows(X, w, T) {
  const out = new Float32Array(T * D);
  for (let t = 0; t < T; t++) {
    let s = 0; for (let i = 0; i < D; i++) s += X[t * D + i] * X[t * D + i];
    const r = 1 / Math.sqrt(s / D + EPS);
    for (let i = 0; i < D; i++) out[t * D + i] = X[t * D + i] * r * w[i];
  }
  return out;
}

// 交錯式 RoPE：x 是 T×H×HD（每列 768），位置 pos[t]；偶數索引 2i、奇數 2i+1 配對，角度 pos·inv_freq[i]
function rope(X, T, pos, invFreq) {
  const out = new Float32Array(T * D);
  for (let t = 0; t < T; t++) for (let h = 0; h < H; h++) {
    const base = t * D + h * HD;
    for (let i = 0; i < HD / 2; i++) {
      const a = Math.cos(pos[t] * invFreq[i]), b = Math.sin(pos[t] * invFreq[i]);
      const e = X[base + 2 * i], o = X[base + 2 * i + 1];
      out[base + 2 * i] = e * a - o * b;
      out[base + 2 * i + 1] = e * b + o * a;
    }
  }
  return out;
}

// 解一步（或多步預填）。ids：長度 T 的詞元；cache：每層 {K, V, L}（K/V 為 H×L×HD，列優先）；回傳 {logits, cache}
// mm(p, X, T) → Float32Array(T×N)；預設用 CPU 參考。
async function decode(model, ids, cache, mm) {
  const T = ids.length;
  const mmf = mm || (async (p, X, t) => cpuMatmul(p, X, t));
  const past = cache ? cache[0].L : 0;
  const pos = Array.from({ length: T }, (_, t) => past + t);
  let x = new Float32Array(T * D);
  for (let t = 0; t < T; t++) x.set(model.embed.subarray(ids[t] * D, (ids[t] + 1) * D), t * D);
  const nextCache = [];
  for (let li = 0; li < NL; li++) {
    const L = model.layers[li];
    const h = rmsRows(x, L.attnNorm, T);
    const q = rope(await mmf(L.q, h, T), T, pos, model.invFreq);
    const k = rope(await mmf(L.k, h, T), T, pos, model.invFreq);
    const v = await mmf(L.v, h, T);
    // 寫入快取：新 L = past+T；K/V 布局 H×L×HD
    const Ln = past + T;
    const Kc = new Float32Array(H * Ln * HD), Vc = new Float32Array(H * Ln * HD);
    for (let hh = 0; hh < H; hh++) {
      if (past > 0) {
        Kc.set(cache[li].K.subarray(hh * past * HD, (hh + 1) * past * HD), hh * Ln * HD);
        Vc.set(cache[li].V.subarray(hh * past * HD, (hh + 1) * past * HD), hh * Ln * HD);
      }
      for (let t = 0; t < T; t++) for (let d = 0; d < HD; d++) {
        Kc[(hh * Ln + past + t) * HD + d] = k[t * D + hh * HD + d];
        Vc[(hh * Ln + past + t) * HD + d] = v[t * D + hh * HD + d];
      }
    }
    nextCache.push({ K: Kc, V: Vc, L: Ln });
    // 注意力：查詢 t（絕對位置 past+t）只看 j ≤ past+t
    const ao = new Float32Array(T * D);
    const sc = new Float64Array(Ln);
    for (let t = 0; t < T; t++) for (let hh = 0; hh < H; hh++) {
      const qo = t * D + hh * HD, lim = past + t + 1;
      let mx = -Infinity;
      for (let j = 0; j < lim; j++) {
        let dot = 0; const ko = (hh * Ln + j) * HD;
        for (let d = 0; d < HD; d++) dot += q[qo + d] * Kc[ko + d];
        sc[j] = dot * SCALE; if (sc[j] > mx) mx = sc[j];
      }
      let sum = 0; for (let j = 0; j < lim; j++) { sc[j] = Math.exp(sc[j] - mx); sum += sc[j]; }
      for (let j = 0; j < lim; j++) {
        const p = sc[j] / sum, vo = (hh * Ln + j) * HD;
        for (let d = 0; d < HD; d++) ao[t * D + hh * HD + d] += p * Vc[vo + d];
      }
    }
    const o = await mmf(L.o, ao, T);
    const x2 = new Float32Array(T * D); for (let i = 0; i < T * D; i++) x2[i] = x[i] + o[i];
    // FFN
    const h2 = rmsRows(x2, L.ffnNorm, T);
    const g = await mmf(L.gate, h2, T);
    const u = await mmf(L.up, h2, T);
    const mid = new Float32Array(T * 3072);
    for (let i = 0; i < mid.length; i++) mid[i] = (g[i] / (1 + Math.exp(-g[i]))) * u[i];
    const dn = await mmf(L.down, mid, T);
    x = new Float32Array(T * D); for (let i = 0; i < T * D; i++) x[i] = x2[i] + dn[i];
  }
  // 最後：取最後一個位置 → norm → lm_head
  const last = x.subarray((T - 1) * D, T * D);
  const hf = rmsRows(Float32Array.from(last), model.norm, 1);
  const logits = await mmf(model.lmHead, hf, 1);
  return { logits: Float32Array.from(logits), cache: nextCache };
}

module.exports = { loadMidiDecoder, decode, cpuMatmul, H, HD, D, NL, EPS, SCALE };
