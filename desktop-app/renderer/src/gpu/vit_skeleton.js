/* vit_skeleton.js — 視覺編碼器骨架（O13a）的 CPU 參考實作：SigLIP 類的 ViT（patch 嵌入、LayerNorm、多頭注意力、MLP、後 LayerNorm）。
 * 只有資料與運算，沒有模型權重、沒有 GPU。GPU 版要改投影為既有的 gemv／矩陣乘核心（與 llm_skeleton_gpu 同一個做法）。
 * 權重格式（row-major，y = W·x，W 為 [out][in]，全部有偏置）：
 *   { patchW(hidden*patch*patch*ch), patchB(hidden), pos(nPatch*hidden),
 *     layers: [{ ln1g, ln1b, wq, bq, wk, bk, wv, bv, wo, bo, ln2g, ln2b, w1(ffn*hidden), b1, w2(hidden*ffn), b2 }],
 *     postG, postB }
 * 影像：HWC 的 Float32Array（高、寬、通道），高與寬要是 patch 的整數倍。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaVitSkeleton。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaVitSkeleton = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function layernorm(x, g, b, eps) {
    const n = x.length; let m = 0; for (let i = 0; i < n; i++) m += x[i]; m /= n;
    let v = 0; for (let i = 0; i < n; i++) v += (x[i] - m) * (x[i] - m); v /= n;
    const inv = 1 / Math.sqrt(v + eps);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = (x[i] - m) * inv * g[i] + b[i];
    return y;
  }
  // SigLIP 用的 GELU（tanh 近似）
  function geluTanh(v) { return 0.5 * v * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (v + 0.044715 * v * v * v))); }
  // y = W·x + b，W 為 [rows][cols]
  function linear(W, b, rows, cols, x) {
    const y = new Float32Array(rows);
    for (let r = 0; r < rows; r++) { let s = b[r]; const o = r * cols; for (let c = 0; c < cols; c++) s += W[o + c] * x[c]; y[r] = s; }
    return y;
  }
  // 影像切成 patch：每個 patch 依 (py, px, c) 的順序展開成一個向量；回傳 [nPatch][p*p*ch]
  function patchify(img, H, W, ch, p) {
    if (H % p !== 0 || W % p !== 0) throw new Error('vit_skeleton：影像的高與寬要是 patch（' + p + '）的整數倍');
    if (img.length !== H * W * ch) throw new Error('vit_skeleton：影像元素數 ' + img.length + ' 與 H×W×C=' + (H * W * ch) + ' 不符');
    const out = [];
    for (let gy = 0; gy < H / p; gy++) for (let gx = 0; gx < W / p; gx++) {
      const v = new Float32Array(p * p * ch); let k = 0;
      for (let py = 0; py < p; py++) for (let px = 0; px < p; px++) for (let c = 0; c < ch; c++) {
        v[k++] = img[(((gy * p + py) * W) + (gx * p + px)) * ch + c];
      }
      out.push(v);
    }
    return out;
  }
  function assertArch(a) {
    const need = ['layers', 'hidden', 'heads', 'ffn', 'patch', 'channels', 'eps'];
    need.forEach((k) => { if (a[k] === undefined) throw new Error('vit_skeleton：缺少 ' + k); });
    if (a.hidden % a.heads !== 0) throw new Error('vit_skeleton：hidden 必須能被 heads 整除');
    if (!(a.eps > 0 && a.eps < 1)) throw new Error('vit_skeleton：eps 必須在 (0,1)');
  }
  function checkWeights(a, w, nPatch) {
    const H = a.hidden, p2 = a.patch * a.patch * a.channels, F = a.ffn;
    const need = (name, got, want) => { if (!got || got.length !== want) throw new Error('vit_skeleton：權重 ' + name + ' 長度應為 ' + want + '，實際 ' + (got ? got.length : '缺少')); };
    need('patchW', w.patchW, H * p2); need('patchB', w.patchB, H); need('pos', w.pos, nPatch * H);
    need('postG', w.postG, H); need('postB', w.postB, H);
    if (!Array.isArray(w.layers) || w.layers.length !== a.layers) throw new Error('vit_skeleton：layers 應有 ' + a.layers + ' 層');
    w.layers.forEach((L, i) => {
      const q = 'layers[' + i + '].';
      need(q + 'ln1g', L.ln1g, H); need(q + 'ln1b', L.ln1b, H);
      ['wq', 'wk', 'wv', 'wo'].forEach((k) => need(q + k, L[k], H * H));
      ['bq', 'bk', 'bv', 'bo'].forEach((k) => need(q + k, L[k], H));
      need(q + 'ln2g', L.ln2g, H); need(q + 'ln2b', L.ln2b, H);
      need(q + 'w1', L.w1, F * H); need(q + 'b1', L.b1, F); need(q + 'w2', L.w2, H * F); need(q + 'b2', L.b2, H);
    });
  }
  // 多頭注意力（全連接，沒有遮罩）：每個 head 的維度 hd = hidden/heads
  function attention(L, a, xs) {
    const H = a.hidden, nh = a.heads, hd = H / nh, T = xs.length, scale = 1 / Math.sqrt(hd);
    const Q = xs.map((x) => linear(L.wq, L.bq, H, H, x));
    const K = xs.map((x) => linear(L.wk, L.bk, H, H, x));
    const V = xs.map((x) => linear(L.wv, L.bv, H, H, x));
    const outs = xs.map(() => new Float32Array(H));
    for (let h = 0; h < nh; h++) {
      for (let i = 0; i < T; i++) {
        const sc = []; for (let j = 0; j < T; j++) { let s = 0; for (let d = 0; d < hd; d++) s += Q[i][h * hd + d] * K[j][h * hd + d]; sc.push(s * scale); }
        let m = -Infinity; for (const v of sc) if (v > m) m = v;
        let z = 0; const e = sc.map((v) => { const q = Math.exp(v - m); z += q; return q; });
        for (let j = 0; j < T; j++) { const pj = e[j] / z; for (let d = 0; d < hd; d++) outs[i][h * hd + d] += pj * V[j][h * hd + d]; }
      }
    }
    return outs.map((o) => linear(L.wo, L.bo, H, H, o));
  }
  // 編碼一張影像：回傳 [nPatch][hidden]（後 LayerNorm 之後）
  function encode(a, w, img, H0, W0) {
    assertArch(a);
    const patches = patchify(img, H0, W0, a.channels, a.patch);
    const nPatch = patches.length;
    checkWeights(a, w, nPatch);
    let xs = patches.map((v, i) => {
      const e = linear(w.patchW, w.patchB, a.hidden, v.length, v);
      for (let d = 0; d < a.hidden; d++) e[d] += w.pos[i * a.hidden + d];
      return e;
    });
    for (const L of w.layers) {
      const hn = xs.map((x) => layernorm(x, L.ln1g, L.ln1b, a.eps));
      const att = attention(L, a, hn);
      xs = xs.map((x, i) => x.map((v, d) => v + att[i][d]));
      xs = xs.map((x) => {
        const hn2 = layernorm(x, L.ln2g, L.ln2b, a.eps);
        const mid = linear(L.w1, L.b1, a.ffn, a.hidden, hn2).map(geluTanh);
        const dn = linear(L.w2, L.b2, a.hidden, a.ffn, mid);
        return x.map((v, d) => v + dn[d]);
      });
    }
    return xs.map((x) => layernorm(x, w.postG, w.postB, a.eps));
  }

  return { layernorm: layernorm, geluTanh: geluTanh, linear: linear, patchify: patchify, encode: encode };
}));
