/* llm_skeleton_gpu.js — 通用解碼骨架的 GPU 版（O12b）。結構與 llm_skeleton.js 的 step 相同，只有投影（matvec，y = W·x）改成非同步、
 * 由呼叫端注入（真桌面版用既有的 gemv 核心；node 測試用 CPU 替身）。RMSNorm、RoPE、注意力留在 CPU（逐元素、很小），與參考實作共用同一份程式。
 * 驗證：node 測試以 CPU 替身的 matvec 對拍 llm_skeleton.run，必須逐位相同；真 GPU 的對拍在桌面版評估做。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaLlmSkeletonGpu。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./llm_skeleton.js')); }
  else { root.FaLlmSkeletonGpu = factory(root.FaLlmSkeleton); }
}(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  // mv(W, rows, cols, x) → Promise<Float32Array>（y = W·x，W 為 [rows][cols] row-major）
  async function stepGpu(state, token, mv) {
    const a = state.arch, w = state.w, hd = state.hd, H = a.hidden, nh = a.heads, nkv = a.kvHeads;
    if (!(token >= 0 && token < a.vocab) || token !== Math.floor(token)) throw new Error('llm_skeleton_gpu：詞元超出詞表（' + token + '）');
    const pos = state.pos;
    let x = Float32Array.from(w.embed.subarray(token * H, token * H + H));
    for (let li = 0; li < a.layers; li++) {
      const L = w.layers[li];
      const h = S.rmsnorm(x, L.attnNorm, a.eps);
      let q = await mv(L.wq, nh * hd, H, h);
      let k = await mv(L.wk, nkv * hd, H, h);
      const v = await mv(L.wv, nkv * hd, H, h);
      if (a.qkNorm) {
        const perHead = (vec, n, wn) => { const o = new Float32Array(vec.length); for (let hh = 0; hh < n; hh++) o.set(S.rmsnorm(vec.subarray(hh * hd, hh * hd + hd), wn, a.eps), hh * hd); return o; };
        q = perHead(q, nh, L.qNorm); k = perHead(k, nkv, L.kNorm);
      }
      q = S.rope(q, nh, hd, pos, a.rope.base);
      k = S.rope(k, nkv, hd, pos, a.rope.base);
      state.cacheK[li].push(k); state.cacheV[li].push(v);
      const T = state.cacheK[li].length;
      const attnOut = new Float32Array(nh * hd);
      const scale = 1 / Math.sqrt(hd);
      for (let qh = 0; qh < nh; qh++) {
        const kh = S.kvHeadOf(qh, nh, nkv);
        const qv = q.subarray(qh * hd, qh * hd + hd);
        const scores = [];
        for (let t = 0; t < T; t++) {
          const kt = state.cacheK[li][t].subarray(kh * hd, kh * hd + hd);
          let s = 0; for (let i = 0; i < hd; i++) s += qv[i] * kt[i];
          scores.push(s * scale);
        }
        const p = S.softmax(scores);
        for (let t = 0; t < T; t++) {
          const vt = state.cacheV[li][t].subarray(kh * hd, kh * hd + hd);
          for (let i = 0; i < hd; i++) attnOut[qh * hd + i] += p[t] * vt[i];
        }
      }
      const o = await mv(L.wo, H, nh * hd, attnOut);
      for (let i = 0; i < H; i++) x[i] += o[i];
      const h2 = S.rmsnorm(x, L.ffnNorm, a.eps);
      const g = await mv(L.wGate, a.ffn, H, h2), u = await mv(L.wUp, a.ffn, H, h2);
      const act = new Float32Array(a.ffn);
      for (let i = 0; i < a.ffn; i++) act[i] = S.silu(g[i]) * u[i];
      const d = await mv(L.wDown, H, a.ffn, act);
      for (let i = 0; i < H; i++) x[i] += d[i];
    }
    const n = S.rmsnorm(x, w.finalNorm, a.eps);
    const head = a.tiedEmbeddings ? w.embed : w.lmHead;
    if (!head) throw new Error('llm_skeleton_gpu：沒有 lm_head');
    const logits = await mv(head, a.vocab, H, n);
    state.pos = pos + 1;
    return logits;
  }

  // 整段 prefix；狀態與權重檢查沿用 llm_skeleton（createState 會驗證描述表與權重長度）。useOverrides:false：GPU 版不吃 CPU 的覆寫槽。
  async function runGpu(arch, weights, tokens, mv) {
    const st = S.createState(arch, weights, { useOverrides: false });
    let logits = null;
    for (const t of tokens) logits = await stepGpu(st, t, mv);
    let best = 0; for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
    return { logits: logits, argmax: best, state: st };
  }

  return { stepGpu: stepGpu, runGpu: runGpu };
}));
