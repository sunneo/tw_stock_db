/* llm_q8_onnx.js — 讀 Llama 系列的 ONNX（q8 動態量化格式，O12e／O12f）的權重，並提供 CPU 參考的逐詞元解碼。
 * ONNX 的計算（已從圖盤點，見 docs/CHECKLIST.cudaweb-optimize.md O12f）：
 *   每個投影：DynamicQuantizeLinear（整個輸入張量一組 scale／zero point，uint8）→ MatMulInteger（int8 權重 [K][N]，權重 zero point＝0，
 *   per-tensor scale）→ Cast 成 f32 → Mul（輸入 scale × 權重 scale）。
 *   嵌入與 lm_head：同一個 uint8 矩陣 [V][D]（zero point 128，per-tensor scale），lm_head 用 f32 激活（不量化）。
 *   RMSNorm：Pow(2)→ReduceMean→+eps→Sqrt→Div→Mul×權重；eps＝1e-5（圖中常數）。RoPE：half 風格，inv_freq 與 llm_skeleton 的 invFreq（llama3）逐點相同（相對誤差 ~2e-7）。
 *   注意力：GQA、因果遮罩、Softmax；SiLU×up；殘差。
 * 這個檔案不解釋 ONNX 圖（那是 ORT 的工作）；它用數學上等價的步驟實作，逐步對拍 ORT 的 logits 來驗證等價。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaLlmQ8Onnx。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./onnx_lite.js'), require('./llm_skeleton.js'));
  else root.FaLlmQ8Onnx = factory(root.FaOnnxLite, root.FaLlmSkeleton);
}(typeof self !== 'undefined' ? self : this, function (OL, S) {
  'use strict';

  // 找出 MatMulInteger 節點的路徑（例：/model/layers.3/mlp/up_proj/MatMul_quant）
  const PROJ = [['q', 'self_attn/q_proj'], ['k', 'self_attn/k_proj'], ['v', 'self_attn/v_proj'], ['o', 'self_attn/o_proj'],
    ['g', 'mlp/gate_proj'], ['u', 'mlp/up_proj'], ['d', 'mlp/down_proj']];

  function roundHalfEven(v) {
    const f = Math.floor(v), d = v - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }
  // ONNX DynamicQuantizeLinear：x_min＝min(0,min x)，x_max＝max(0,max x)，scale＝(x_max−x_min)/255，zp＝sat(round(−x_min/scale))，q＝sat(round(x/scale)+zp)。
  // 回傳 { xq: Int32Array（q−zp，與 MatMulInteger 的減法合併）, scale }。
  function dynQuant(x) {
    let mn = 0, mx = 0;
    for (let i = 0; i < x.length; i++) { const v = x[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    let scale = (mx - mn) / 255;
    if (!(scale > 0)) scale = 1;   // 全為 0：任何 scale 都可以（q 都是 zp）
    const zp = Math.min(255, Math.max(0, roundHalfEven(-mn / scale)));
    const xq = new Int32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const q = Math.min(255, Math.max(0, roundHalfEven(x[i] / scale) + zp));
      xq[i] = q - zp;
    }
    return { xq: xq, scale: scale };
  }
  // y[n] = (Σ_k xq[k]·W[k·N+n]) · (x_scale · w_scale)；W 為 int8 [K][N]，權重 zero point 0。
  function q8matvec(dq, W, N) {
    const K = dq.xq.length, y = new Float32Array(N), w = W.q, sc = dq.scale * W.scale;
    const acc = new Float64Array(N);
    for (let k = 0; k < K; k++) {
      const xv = dq.xq[k]; if (xv === 0) continue;
      const o = k * N;
      for (let n = 0; n < N; n++) acc[n] += xv * w[o + n];
    }
    for (let n = 0; n < N; n++) y[n] = acc[n] * sc;
    return y;
  }

  // 讀 ONNX，依描述表檢查形狀，回傳 q8 權重物件：{ emb:{W:Uint8Array[V][D], zp, scale}, finalNorm, eps, layers:[{inNorm, postNorm, q,k,v,o,g,u,d}] }
  // 每個投影：{ q: Int8Array[K][N], scale（f32）, K, N }。讀不到或形狀不符就丟錯，不悄悄算錯。
  function loadQ8(u8, arch) {
    const model = OL.parseModel(u8), g = model.graph, I = g.inits;
    const hd = arch.headDim || arch.hidden / arch.heads, H = arch.hidden, Nq = arch.heads * hd, Nk = arch.kvHeads * hd, F = arch.ffn, V = arch.vocab;
    const scalarF = (name) => { const t = I.get(name); if (!t) throw new Error('llm_q8_onnx：找不到 ' + name); return OL.tensorArray(u8, t)[0]; };
    const arr = (name, dtype, dims) => {
      const t = I.get(name); if (!t) throw new Error('llm_q8_onnx：找不到 ' + name);
      if (t.dtype !== dtype) throw new Error('llm_q8_onnx：' + name + ' 的 dtype 是 ' + t.dtype + '，應為 ' + dtype);
      if (dims && t.dims.join('x') !== dims.join('x')) throw new Error('llm_q8_onnx：' + name + ' 的形狀 ' + t.dims.join('x') + ' 與預期 ' + dims.join('x') + ' 不符');
      return OL.tensorArray(u8, t);
    };
    const byName = new Map(); for (const n of g.nodes) byName.set(n.name, n);
    // 嵌入（Gather 的資料輸入）
    const gather = byName.get('/model/embed_tokens/Gather');
    if (!gather) throw new Error('llm_q8_onnx：找不到 /model/embed_tokens/Gather');
    const embName = gather.inputs[0];
    const emb = { W: arr(embName, 'uint8', [V, H]), zp: scalarF('model.embed_tokens.weight_zero_point'), scale: scalarF('model.embed_tokens.weight_scale') };
    if (emb.zp !== 128) throw new Error('llm_q8_onnx：嵌入 zero point 是 ' + emb.zp + '，預期 128（未支援）');
    const finalNorm = arr('model.norm.weight', 'float32', [H]);
    const layers = [];
    for (let l = 0; l < arch.layers; l++) {
      const L = { inNorm: arr('model.layers.' + l + '.input_layernorm.weight', 'float32', [H]), postNorm: arr('model.layers.' + l + '.post_attention_layernorm.weight', 'float32', [H]) };
      for (const [key, path] of PROJ) {
        const node = byName.get('/model/layers.' + l + '/' + path + '/MatMul_quant');
        if (!node || node.op !== 'MatMulInteger') throw new Error('llm_q8_onnx：第 ' + l + ' 層找不到 MatMulInteger（' + path + '）');
        const wName = node.inputs[1], base = wName.replace(/_quantized$/, '');
        const expK = (key === 'o') ? Nq : (key === 'd') ? F : H;   // 輸入維度
        const expN = (key === 'q') ? Nq : (key === 'k' || key === 'v') ? Nk : (key === 'o' || key === 'd') ? H : F;
        const wzp = scalarF(base + '_zero_point');
        if (wzp !== 0) throw new Error('llm_q8_onnx：' + path + ' 的權重 zero point 是 ' + wzp + '，預期 0（未支援）');
        L[key] = { q: arr(wName, 'int8', [expK, expN]), scale: scalarF(base + '_scale'), K: expK, N: expN };
      }
      layers.push(L);
    }
    return { emb: emb, finalNorm: finalNorm, layers: layers, eps: 1e-5, opCounts: opCounts(g), node: { nodes: g.nodes.length, inits: I.size } };
  }
  function opCounts(g) { const c = {}; for (const n of g.nodes) c[n.op] = (c[n.op] || 0) + 1; return c; }

  // 建立解碼狀態（與 llm_skeleton.createState 相同的欄位，但權重是 q8 格式）
  function createQ8State(arch, w) {
    const hd = arch.headDim || arch.hidden / arch.heads;
    return { arch: arch, w: w, hd: hd, pos: 0, cacheK: Array.from({ length: arch.layers }, () => []), cacheV: Array.from({ length: arch.layers }, () => []) };
  }
  // 一個詞元的 CPU 參考解碼：回傳 logits（Float32Array，長度 vocab）。
  function stepQ8(st, token) {
    const a = st.arch, w = st.w, H = a.hidden, hd = st.hd, nh = a.heads, nkv = a.kvHeads, F = a.ffn, V = a.vocab, pos = st.pos;
    if (!(token >= 0 && token < V) || token !== Math.floor(token)) throw new Error('llm_q8_onnx：詞元超出詞表（' + token + '）');
    let x = new Float32Array(H);
    for (let j = 0; j < H; j++) x[j] = (w.emb.W[token * H + j] - w.emb.zp) * w.emb.scale;   // 嵌入：Gather＋DequantizeLinear
    for (let li = 0; li < a.layers; li++) {
      const L = w.layers[li];
      const h = S.rmsnorm(x, L.inNorm, w.eps);
      const dq = dynQuant(h);
      let q = q8matvec(dq, L.q, nh * hd), k = q8matvec(dq, L.k, nkv * hd), v = q8matvec(dq, L.v, nkv * hd);
      q = S.rope(q, nh, hd, pos, a.rope.base, a.rope.scaling);
      k = S.rope(k, nkv, hd, pos, a.rope.base, a.rope.scaling);
      st.cacheK[li].push(k); st.cacheV[li].push(v);
      const T = st.cacheK[li].length, attn = new Float32Array(nh * hd), scale = 1 / Math.sqrt(hd);
      for (let qh = 0; qh < nh; qh++) {
        const kh = S.kvHeadOf(qh, nh, nkv), qv = q.subarray(qh * hd, qh * hd + hd), sc = new Array(T);
        for (let t = 0; t < T; t++) { const kt = st.cacheK[li][t].subarray(kh * hd, kh * hd + hd); let s = 0; for (let i = 0; i < hd; i++) s += qv[i] * kt[i]; sc[t] = s * scale; }
        const p = S.softmax(sc);
        for (let t = 0; t < T; t++) { const vt = st.cacheV[li][t].subarray(kh * hd, kh * hd + hd); for (let i = 0; i < hd; i++) attn[qh * hd + i] += p[t] * vt[i]; }
      }
      const dqo = dynQuant(attn), o = q8matvec(dqo, L.o, H);
      for (let i = 0; i < H; i++) x[i] += o[i];
      const h2 = S.rmsnorm(x, L.postNorm, w.eps);
      const dq2 = dynQuant(h2);
      const gv = q8matvec(dq2, L.g, F), uv = q8matvec(dq2, L.u, F);
      const act = new Float32Array(F);
      for (let i = 0; i < F; i++) act[i] = S.silu(gv[i]) * uv[i];
      const dqa = dynQuant(act), dv = q8matvec(dqa, L.d, H);
      for (let i = 0; i < H; i++) x[i] += dv[i];
    }
    const n = S.rmsnorm(x, w.finalNorm, w.eps);
    // lm_head（與嵌入共用，tied）：f32 激活 × (uint8 − 128)·scale，不量化激活
    const logits = new Float32Array(V);
    const sc = w.emb.scale, zp = w.emb.zp, E = w.emb.W;
    for (let vi = 0; vi < V; vi++) {
      let s = 0; const o = vi * H;
      for (let d = 0; d < H; d++) s += n[d] * (E[o + d] - zp);
      logits[vi] = s * sc;
    }
    st.pos = pos + 1;
    return logits;
  }

  return { loadQ8: loadQ8, createQ8State: createQ8State, stepQ8: stepQ8, dynQuant: dynQuant, q8matvec: q8matvec, roundHalfEven: roundHalfEven };
}));
