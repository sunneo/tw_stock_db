// qwen_decode.js — Qwen3-0.6B（q8 ONNX）整段解碼的權重載入與 CPU 參考引擎（DESIGN.webgpu-cuda.md §7.13）。
// 純 UMD，node 與瀏覽器都能用（只用 Uint8Array）。GPU 版在 qwen_gpu.js，與這裡的 CPU 參考版逐步對拍。
// 數學與 scripts/eval/cudaweb_model_step.js 相同（已對真 ORT 通過）：
//   RMSNorm（f32 逐步累加）→ 動態量化（整個 M×K 張量一組步長，與 ORT 的 DynamicQuantizeLinear 相同）→ q8 投影
//   → qk-norm → RoPE（rotate-half，theta 1e6）→ KV 快取 → GQA 注意力 → o_proj → 殘差 → RMSNorm → gate／up → SiLU×up → down → 殘差。
//   最後 RMSNorm → lm_head（與嵌入共用的 q8，tied）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./onnx_lite.js'), require('./infer_ops.js'), require('./attn_ops.js'));
  else root.FaQwenDecode = factory(root.FaOnnxLite, root.FaInferOps, root.FaAttnOps);
})(typeof self !== 'undefined' ? self : this, function (lite, ops, A) {
  'use strict';
  const EPS = 1e-6, THETA = 1e6, HD = 128;

  function f32Of(m, name) {
    const b = lite.tensorBytes(m, name);
    if (b.length % 4 !== 0) throw new Error('qwen_decode：' + name + ' 的位元組數不是 4 的倍數');
    const o = new Float32Array(b.length / 4), dv = new DataView(b.buffer, b.byteOffset, b.length);
    for (let i = 0; i < o.length; i++) o[i] = dv.getFloat32(i * 4, true);
    return o;
  }
  // 從 q8 ONNX 位元組取出全部權重（不複製，W 是原緩衝區的 subarray）。找不到預期的名稱就丟錯（不是這個模型格式）。
  function loadWeights(onnxBytes) {
    const m = lite.parseModel(onnxBytes);
    const u8 = (n) => lite.tensorBytes(m, n);
    const qp = (nm) => {
      const t = m.inits[nm + 'quantized'];
      if (!t || t.dims.length !== 2) throw new Error('qwen_decode：沒有 q8 權重 ' + nm + 'quantized（不是預期的 q8 格式）');
      return { W: u8(nm + 'quantized'), K: t.dims[0], N: t.dims[1], zp: lite.scalar(m, nm + 'zero_point'), scale: lite.scalar(m, nm + 'scale') };
    };
    const embName = 'model.embed_tokens.weight_';
    const et = m.inits[embName + 'quantized'];
    if (!et) throw new Error('qwen_decode：沒有 ' + embName + 'quantized');
    let L = 0; while (m.inits['model.layers.' + L + '.input_layernorm.weight']) L++;
    if (!L) throw new Error('qwen_decode：找不到 model.layers.0.input_layernorm.weight');
    const layers = [];
    for (let l = 0; l < L; l++) {
      const p = 'model.layers.' + l + '.';
      layers.push({
        q: qp(p + 'attn.q_proj.MatMul.weight_'), k: qp(p + 'attn.k_proj.MatMul.weight_'), v: qp(p + 'attn.v_proj.MatMul.weight_'), o: qp(p + 'attn.o_proj.MatMul.weight_'),
        g: qp(p + 'mlp.gate_proj.MatMul.weight_'), u: qp(p + 'mlp.up_proj.MatMul.weight_'), d: qp(p + 'mlp.down_proj.MatMul.weight_'),
        qNorm: f32Of(m, p + 'attn.q_norm.layernorm.weight'), kNorm: f32Of(m, p + 'attn.k_norm.layernorm.weight'),
        inNorm: f32Of(m, p + 'input_layernorm.weight'), postNorm: f32Of(m, p + 'post_attention_layernorm.weight'),
      });
    }
    const H = layers[0].q.N / HD, Hkv = layers[0].k.N / HD;
    return {
      L, H, Hkv, hd: HD, D: et.dims[1], V: et.dims[0], I: layers[0].g.N, eps: EPS, theta: THETA,
      emb: { W: u8(embName + 'quantized'), zp: lite.scalar(m, embName + 'zero_point'), scale: lite.scalar(m, embName + 'scale') },
      finalNorm: f32Of(m, 'model.layers.' + L + '.final_norm_layernorm.weight'),
      layers,
    };
  }

  // 嵌入列（反量化成 f32）
  function embedRows(W, ids) {
    const D = W.D, o = new Float32Array(ids.length * D), e = W.emb;
    for (let t = 0; t < ids.length; t++) {
      const base = ids[t] * D;
      if (!(ids[t] >= 0 && ids[t] < W.V)) throw new Error('qwen_decode：詞元編號 ' + ids[t] + ' 超出詞表（' + W.V + '）');
      for (let i = 0; i < D; i++) o[t * D + i] = (e.W[base + i] - e.zp) * e.scale;
    }
    return o;
  }

  const rmsF32 = (x, g, eps) => {
    let ss = 0;
    for (let i = 0; i < x.length; i++) ss = Math.fround(ss + Math.fround(x[i] * x[i]));
    const inv = Math.fround(1 / Math.sqrt(Math.fround(Math.fround(ss / x.length) + eps)));
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = Math.fround(Math.fround(x[i] * inv) * g[i]);
    return y;
  };
  const rowNorm = (src, g, rows, D, eps) => { const o = new Float32Array(src.length); for (let t = 0; t < rows; t++) o.set(rmsF32(src.subarray(t * D, (t + 1) * D), g, eps), t * D); return o; };
  const dynQ = (x) => { const r = ops.quantizeDynamicRef(x); const xi = new Int32Array(x.length); for (let i = 0; i < xi.length; i++) xi[i] = r.q[i] - r.zp; return { xi, scale: r.scale }; };
  const mm = (qz, w, M) => Float32Array.from(ops.q8mmRef(qz.xi, w.W, w.zp, M, w.K, w.N, Math.fround(qz.scale * w.scale)));

  // CPU 參考引擎。step(ids) 把 ids（一個或多個詞元）接在目前序列後面，回傳最後一列的 logits（Float32Array(V)）。
  // 預填（ids 多個）時整段一組量化步長；解碼（一個詞元）時單獨量化，與 ORT 的行為相同。
  function createCpuEngine(W, opts) {
    const o = opts || {}, maxT = o.maxT || 256;
    const caches = W.layers.map(() => A.createKvCache(W.Hkv, W.hd, maxT));
    const eng = {
      get len() { return caches[0].len; }, maxT,
      reset() { for (const c of caches) c.len = 0; },
      step(ids) {
        const S = ids.length, D = W.D;
        if (o.trace) eng.lastTrace = [];
        if (caches[0].len + S > maxT) throw new Error('qwen_decode：序列超過上限 ' + maxT);
        let h = embedRows(W, ids);
        for (let l = 0; l < W.L; l++) {
          const Ly = W.layers[l];
          const xn = rowNorm(h, Ly.inNorm, S, D, W.eps), qz = dynQ(xn);
          const attn = A.attentionBlock({ q: mm(qz, Ly.q, S), k: mm(qz, Ly.k, S), v: mm(qz, Ly.v, S), S, H: W.H, Hkv: W.Hkv, hd: W.hd, theta: W.theta, eps: W.eps, qNorm: Ly.qNorm, kNorm: Ly.kNorm, cache: caches[l] });
          const op = mm(dynQ(attn), Ly.o, S);
          const mid = new Float32Array(h.length); for (let i = 0; i < mid.length; i++) mid[i] = h[i] + op[i];
          const nz = dynQ(rowNorm(mid, Ly.postNorm, S, D, W.eps));
          const gate = mm(nz, Ly.g, S), up = mm(nz, Ly.u, S);
          const act = new Float32Array(gate.length); for (let i = 0; i < act.length; i++) act[i] = (gate[i] / (1 + Math.exp(-gate[i]))) * up[i];
          const down = mm(dynQ(act), Ly.d, S);
          const next = new Float32Array(h.length); for (let i = 0; i < next.length; i++) next[i] = mid[i] + down[i];
          h = next;
          if (o.trace) (eng.lastTrace || (eng.lastTrace = [])).push(Float32Array.from(h));
        }
        const hn = rmsF32(h.subarray((S - 1) * D, S * D), W.finalNorm, W.eps);
        return Float32Array.from(ops.q8lmRef(hn, W.emb.W, W.emb.zp, W.V, D, Math.fround(W.emb.scale)));
      },
    };
    return eng;
  }

  const argmax = (a) => { let b = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[b]) b = i; return b; };
  // 貪婪生成：engine.step(promptIds) 預填，再逐詞元 step([token])。回傳新詞元陣列（遇到 stopIds 即停，不含停止詞元）。
  async function greedy(engine, promptIds, n, stopIds) {
    const stop = new Set(stopIds || []), out = [];
    let r = await engine.step(promptIds);
    for (let i = 0; i < n; i++) {
      const tok = typeof r === 'object' && r !== null && 'token' in r ? r.token : argmax(r);
      if (stop.has(tok)) break;
      out.push(tok);
      if (i + 1 < n) r = await engine.step([tok]);
    }
    return out;
  }

  return { loadWeights, embedRows, createCpuEngine, greedy, argmax, rmsF32, EPS, THETA, HD };
});
