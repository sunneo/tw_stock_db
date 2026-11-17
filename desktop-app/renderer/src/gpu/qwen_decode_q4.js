// qwen_decode_q4.js — Qwen3（q4f16 ONNX，transformers.js 預設的 GPU 格式）的權重載入（DESIGN.webgpu-cuda.md §7.31）。
// 圖的結構（用 onnx_lite 對 onnx-community/Qwen3-0.6B-ONNX 的 model_q4f16.onnx 逐節點確認）：嵌入 Gather（fp16 [V,D]）→ 每層
// SimplifiedLayerNormalization／SkipSimplifiedLayerNormalization（fp16）→ 7 個 MatMulNBits（bits 4、block 32、無 zero_points、零點固定 8、
// 權重 [N,nBlocks,16]、scales fp16）→ q／k 的逐頭 RMSNorm → RotaryEmbedding（rotate-half，cos_cache／sin_cache 是 fp16 常數）→ GroupQueryAttention → …
// lm_head 是未量化 fp16：x · embed_tokens^T（embed_tokens.weight 轉置只是圖裡的 Transpose 節點，權重與嵌入共用同一份 [V,D] fp16）。
// 輸出的 W 與 qwen_decode.loadWeights 同形，另有 fmt:'q4'、每個投影 { W（Q4 位元組）、S（fp16 scales 位元組）、K、N }、
// emb:{ W（fp16 位元組，V×D×2）}、embedRows（fp16→f32）、cosSin（取自檔內的 fp16 快取）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./onnx_lite.js'));
  else root.FaQwenDecodeQ4 = factory(root.FaOnnxLite);
})(typeof self !== 'undefined' ? self : this, function (lite) {
  'use strict';
  const HD = 128, EPS = 1e-6;
  const h2f = (() => {
    const t = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
      t[h] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
    }
    return t;
  })();
  function f16Of(m, name) {
    const b = lite.tensorBytes(m, name);
    if (b.length & 1) throw new Error('qwen_decode_q4：' + name + ' 的位元組數不是 2 的倍數');
    const o = new Float32Array(b.length >> 1);
    for (let i = 0; i < o.length; i++) o[i] = h2f[b[2 * i] | (b[2 * i + 1] << 8)];
    return o;
  }
  // 圖裡 MatMulNBits 節點的屬性（K、N、bits、block_size）：以節點名稱建索引
  function nbitsAttrs(m) {
    const o = {};
    for (const nd of m.nodes) if (nd.op === 'MatMulNBits') { const a = (k) => { const x = nd.attrs[k]; return x ? x.i : null; }; o[nd.inputs[1]] = { K: a('K'), N: a('N'), bits: a('bits'), block: a('block_size') }; }
    return o;
  }
  // maxPos：RoPE 快取取前幾列（引擎的序列上限）
  function loadWeights(onnxBytes, opts) {
    const m = lite.parseModel(onnxBytes), maxPos = (opts && opts.maxPos) || 4096, at = nbitsAttrs(m);
    const qp = (nm) => {
      const wn = nm + 'weight_Q4', sn = nm + 'weight_scales', t = m.inits[wn], a = at[wn];
      if (!t || !a) throw new Error('qwen_decode_q4：沒有 MatMulNBits 權重 ' + wn + '（不是 q4f16 格式）');
      if (a.bits !== 4 || a.block !== 32) throw new Error('qwen_decode_q4：只支援 bits 4、block 32（' + wn + ' 是 ' + a.bits + '／' + a.block + '）');
      const nb = a.K / 32; if (t.dims.length !== 3 || t.dims[0] !== a.N || t.dims[1] !== nb || t.dims[2] !== 16) throw new Error('qwen_decode_q4：' + wn + ' 的形狀 ' + JSON.stringify(t.dims) + ' 不符 [N,K/32,16]');
      const S = lite.tensorBytes(m, sn); if (S.length !== a.N * nb * 2) throw new Error('qwen_decode_q4：' + sn + ' 長度不符');
      return { W: lite.tensorBytes(m, wn), S, K: a.K, N: a.N };
    };
    const et = m.inits['model.embed_tokens.weight'];
    if (!et || et.dims.length !== 2) throw new Error('qwen_decode_q4：沒有 model.embed_tokens.weight');
    let L = 0; while (m.inits['model.layers.' + L + '.input_layernorm.weight']) L++;
    if (!L) throw new Error('qwen_decode_q4：找不到 model.layers.0.input_layernorm.weight');
    const layers = [];
    for (let l = 0; l < L; l++) {
      const p = 'model.layers.' + l + '.';
      layers.push({
        q: qp(p + 'attn.q_proj.MatMul.'), k: qp(p + 'attn.k_proj.MatMul.'), v: qp(p + 'attn.v_proj.MatMul.'), o: qp(p + 'attn.o_proj.MatMul.'),
        g: qp(p + 'mlp.gate_proj.MatMul.'), u: qp(p + 'mlp.up_proj.MatMul.'), d: qp(p + 'mlp.down_proj.MatMul.'),
        qNorm: f16Of(m, p + 'attn.q_norm.layernorm.weight'), kNorm: f16Of(m, p + 'attn.k_norm.layernorm.weight'),
        inNorm: f16Of(m, p + 'input_layernorm.weight'), postNorm: f16Of(m, p + 'post_attention_layernorm.weight'),
      });
    }
    const D = et.dims[1], V = et.dims[0], H = layers[0].q.N / HD, Hkv = layers[0].k.N / HD, half = HD / 2;
    const embB = lite.tensorBytes(m, 'model.embed_tokens.weight');
    if (embB.length !== V * D * 2) throw new Error('qwen_decode_q4：嵌入表大小不符');
    const cc = m.inits.cos_cache, sc = m.inits.sin_cache;
    if (!cc || !sc || cc.dims[1] !== half) throw new Error('qwen_decode_q4：找不到 cos_cache／sin_cache');
    const rows = Math.min(maxPos, cc.dims[0]), cosB = lite.tensorBytes(m, 'cos_cache'), sinB = lite.tensorBytes(m, 'sin_cache');
    const cos = new Float32Array(rows * half), sin = new Float32Array(rows * half);
    for (let i = 0; i < rows * half; i++) { cos[i] = h2f[cosB[2 * i] | (cosB[2 * i + 1] << 8)]; sin[i] = h2f[sinB[2 * i] | (sinB[2 * i + 1] << 8)]; }
    const W = {
      fmt: 'q4', L, H, Hkv, hd: HD, D, V, I: layers[0].g.N, eps: EPS, theta: 1e6, emb: { W: embB }, layers,
      finalNorm: f16Of(m, 'model.layers.' + L + '.final_norm_layernorm.weight'), cosSin: { rows, cos, sin },
    };
    W.embedRows = (ids) => {
      const o = new Float32Array(ids.length * D);
      for (let t = 0; t < ids.length; t++) {
        if (!(ids[t] >= 0 && ids[t] < V)) throw new Error('qwen_decode_q4：詞元編號 ' + ids[t] + ' 超出詞表（' + V + '）');
        const b = ids[t] * D * 2; for (let i = 0; i < D; i++) o[t * D + i] = h2f[embB[b + 2 * i] | (embB[b + 2 * i + 1] << 8)];
      }
      return o;
    };
    return W;
  }
  return { loadWeights, h2f };
});
