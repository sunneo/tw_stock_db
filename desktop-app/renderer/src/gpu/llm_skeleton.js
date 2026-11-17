/* llm_skeleton.js — 通用解碼骨架的 CPU 參考實作（O12b）。依 llm_arch.js 的描述表組出每層的運算序列，不寫死任何模型的維度。
 * 這是參考實作（給 GPU 版對拍用），不是最佳化路徑。
 * 目前不支援（遇到就丟錯，不悄悄算錯）：RoPE 的 llama3 縮放、偏置（bias=true）、GELU 啟動。
 * 權重格式（row-major，y = W·x，W 為 [out][in]）：
 *   { embed: Float32Array(vocab*hidden), finalNorm: Float32Array(hidden), lmHead?: Float32Array(vocab*hidden)（tiedEmbeddings 時可省）,
 *     layers: [{ attnNorm, wq(heads*hd*hidden), wk(kvHeads*hd*hidden), wv(kvHeads*hd*hidden), wo(hidden*heads*hd),
 *                qNorm?(hd), kNorm?(hd)（qkNorm 時必填）, ffnNorm, wGate(ffn*hidden), wUp(ffn*hidden), wDown(hidden*ffn) }] }
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaLlmSkeleton。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./llm_arch.js')); }
  else { root.FaLlmSkeleton = factory(root.FaLlmArch); }
}(typeof self !== 'undefined' ? self : this, function (ARCH) {
  'use strict';

  function rmsnorm(x, w, eps) {
    let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    const inv = 1 / Math.sqrt(s / x.length + eps);
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] * inv * w[i];
    return y;
  }
  // y = W·x，W 為 [rows][cols] 的 row-major
  function matvec(W, rows, cols, x) {
    const y = new Float32Array(rows);
    for (let r = 0; r < rows; r++) { let s = 0; const o = r * cols; for (let c = 0; c < cols; c++) s += W[o + c] * x[c]; y[r] = s; }
    return y;
  }
  function silu(v) { return v / (1 + Math.exp(-v)); }
  function softmax(xs) {
    let m = -Infinity; for (const v of xs) if (v > m) m = v;
    let s = 0; const e = xs.map((v) => { const q = Math.exp(v - m); s += q; return q; });
    return e.map((v) => v / s);
  }
  // half 風格的 RoPE：第 i 組是 (x[i], x[i+d/2])，角度 pos·base^(−2i/d)。pos=0 時是恆等。
  function rope(vec, nHeads, hd, pos, base) {
    const out = Float32Array.from(vec); const half = hd / 2;
    for (let h = 0; h < nHeads; h++) {
      const o = h * hd;
      for (let i = 0; i < half; i++) {
        const theta = pos * Math.pow(base, -2 * i / hd);
        const c = Math.cos(theta), s = Math.sin(theta);
        const a = out[o + i], b = out[o + i + half];
        out[o + i] = a * c - b * s;
        out[o + i + half] = a * s + b * c;
      }
    }
    return out;
  }
  // 每個 query head 對應的 kv head（GQA）：連續的 heads/kvHeads 個 query head 共用一個 kv head
  function kvHeadOf(qHead, heads, kvHeads) { return Math.floor(qHead / (heads / kvHeads)); }

  function assertSupported(arch) {
    const v = ARCH.validateArch(arch);
    if (!v.ok) throw new Error('llm_skeleton：描述表不合法：' + v.errors.join('；'));
    if (arch.status !== 'supported') throw new Error('llm_skeleton：' + arch.family + ' 還是 pending，不支援');
    if (arch.rope.scaling) throw new Error('llm_skeleton：RoPE 縮放（' + arch.rope.scaling.type + '）尚未實作');
    if (arch.bias) throw new Error('llm_skeleton：偏置（bias）尚未實作');
    if (arch.act !== 'silu_mul') throw new Error('llm_skeleton：啟動 ' + arch.act + ' 尚未實作');
  }

  // 權重長度必須與描述表一致；長度不對會讓運算悄悄變成 NaN，所以開頭就檢查
  function checkWeights(arch, w) {
    const H = arch.hidden, hd = ARCH.headDimOf(arch), nh = arch.heads, nkv = arch.kvHeads, F = arch.ffn, V = arch.vocab;
    const need = (name, got, want) => { if (!got || got.length !== want) throw new Error('llm_skeleton：權重 ' + name + ' 長度應為 ' + want + '，實際 ' + (got ? got.length : '缺少')); };
    need('embed', w.embed, V * H);
    need('finalNorm', w.finalNorm, H);
    if (!arch.tiedEmbeddings) need('lmHead', w.lmHead, V * H);
    if (!Array.isArray(w.layers) || w.layers.length !== arch.layers) throw new Error('llm_skeleton：layers 應有 ' + arch.layers + ' 層');
    w.layers.forEach((L, i) => {
      const p = 'layers[' + i + '].';
      need(p + 'attnNorm', L.attnNorm, H); need(p + 'wq', L.wq, nh * hd * H); need(p + 'wk', L.wk, nkv * hd * H);
      need(p + 'wv', L.wv, nkv * hd * H); need(p + 'wo', L.wo, H * nh * hd); need(p + 'ffnNorm', L.ffnNorm, H);
      need(p + 'wGate', L.wGate, F * H); need(p + 'wUp', L.wUp, F * H); need(p + 'wDown', L.wDown, H * F);
      if (arch.qkNorm) { need(p + 'qNorm', L.qNorm, hd); need(p + 'kNorm', L.kNorm, hd); }
    });
  }

  // 建立一個解碼狀態（每層的 KV 快取，依位置累加）
  function createState(arch, weights) {
    assertSupported(arch);
    checkWeights(arch, weights);
    const hd = ARCH.headDimOf(arch);
    return { arch: arch, w: weights, hd: hd, pos: 0, cacheK: arch.layers ? Array.from({ length: arch.layers }, () => []) : [], cacheV: Array.from({ length: arch.layers }, () => []) };
  }

  // 餵一個詞元，回傳這個位置的 logits（長度 vocab）。狀態會前進一格。
  function step(state, token) {
    const a = state.arch, w = state.w, hd = state.hd, H = a.hidden, nh = a.heads, nkv = a.kvHeads;
    if (!(token >= 0 && token < a.vocab) || token !== Math.floor(token)) throw new Error('llm_skeleton：詞元超出詞表（' + token + '）');
    const pos = state.pos;
    let x = Float32Array.from(w.embed.subarray(token * H, token * H + H));
    for (let li = 0; li < a.layers; li++) {
      const L = w.layers[li];
      const h = rmsnorm(x, L.attnNorm, a.eps);
      let q = matvec(L.wq, nh * hd, H, h);
      let k = matvec(L.wk, nkv * hd, H, h);
      const v = matvec(L.wv, nkv * hd, H, h);
      if (a.qkNorm) {
        // qk-norm：每個 head 各自做 RMSNorm（權重長度 hd）
        const perHead = (vec, n, wn) => { const o = new Float32Array(vec.length); for (let hh = 0; hh < n; hh++) o.set(rmsnorm(vec.subarray(hh * hd, hh * hd + hd), wn, a.eps), hh * hd); return o; };
        q = perHead(q, nh, L.qNorm); k = perHead(k, nkv, L.kNorm);
      }
      q = rope(q, nh, hd, pos, a.rope.base);
      k = rope(k, nkv, hd, pos, a.rope.base);
      state.cacheK[li].push(k); state.cacheV[li].push(v);
      const T = state.cacheK[li].length;
      const attnOut = new Float32Array(nh * hd);
      const scale = 1 / Math.sqrt(hd);
      for (let qh = 0; qh < nh; qh++) {
        const kh = kvHeadOf(qh, nh, nkv);
        const qv = q.subarray(qh * hd, qh * hd + hd);
        const scores = [];
        for (let t = 0; t < T; t++) {
          const kt = state.cacheK[li][t].subarray(kh * hd, kh * hd + hd);
          let s = 0; for (let i = 0; i < hd; i++) s += qv[i] * kt[i];
          scores.push(s * scale);
        }
        const p = softmax(scores);
        for (let t = 0; t < T; t++) {
          const vt = state.cacheV[li][t].subarray(kh * hd, kh * hd + hd);
          for (let i = 0; i < hd; i++) attnOut[qh * hd + i] += p[t] * vt[i];
        }
      }
      const o = matvec(L.wo, H, nh * hd, attnOut);
      for (let i = 0; i < H; i++) x[i] += o[i];
      const h2 = rmsnorm(x, L.ffnNorm, a.eps);
      const g = matvec(L.wGate, a.ffn, H, h2), u = matvec(L.wUp, a.ffn, H, h2);
      const act = new Float32Array(a.ffn);
      for (let i = 0; i < a.ffn; i++) act[i] = silu(g[i]) * u[i];
      const d = matvec(L.wDown, H, a.ffn, act);
      for (let i = 0; i < H; i++) x[i] += d[i];
    }
    const n = rmsnorm(x, w.finalNorm, a.eps);
    const head = a.tiedEmbeddings ? w.embed : w.lmHead;
    if (!head) throw new Error('llm_skeleton：沒有 lm_head（tiedEmbeddings 為假時必填）');
    const logits = matvec(head, a.vocab, H, n);
    state.pos = pos + 1;
    return logits;
  }

  // 整段 prefix 的 logits（依序 step），回傳最後一個位置的 logits 與 argmax（貪婪解碼用）
  function run(arch, weights, tokens) {
    const st = createState(arch, weights);
    let logits = null;
    for (const t of tokens) logits = step(st, t);
    let best = 0; for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
    return { logits: logits, argmax: best, state: st };
  }

  return { rmsnorm: rmsnorm, matvec: matvec, silu: silu, softmax: softmax, rope: rope, kvHeadOf: kvHeadOf, createState: createState, step: step, run: run };
}));
