// attn_ops.js — 注意力＋KV 快取的 CPU 參考版（DESIGN.webgpu-cuda.md §7.7）。純 UMD，node 可 require。
// 對應 Qwen3 的注意力：
//   q_norm／k_norm：每個頭各做一次 RMSNorm（權重長度 = hd）；
//   RoPE：rotate-half（第 i 維與第 i+hd/2 維配對），theta 由呼叫端給（Qwen3 用 1e6），位置 = 絕對位置（past + t）；
//   GQA：查詢頭 h 用第 floor(h / (H/Hkv)) 個 KV 頭；
//   因果遮罩：查詢位置 p 只看 0..p 的鍵值。
// 這裡只做注意力數學（Float64 累加）；q／k／v／o 的矩陣投影由呼叫端做。
// 注意：這不是 GPU 核心；WGSL 版要用同一組測試對拍（見 attn_ops_test.js）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaAttnOps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 每個頭各自 RMSNorm：x 是 rows×d（rows = 詞元數×頭數），g 長度 d
  function rmsRows(x, g, rows, d, eps) {
    if (x.length !== rows * d) throw new Error('rmsRows：x 的長度 ' + x.length + ' 與 rows×d=' + (rows * d) + ' 不符');
    if (g.length !== d) throw new Error('rmsRows：g 的長度 ' + g.length + ' 與 d=' + d + ' 不符');
    const y = new Float64Array(rows * d);
    for (let r = 0; r < rows; r++) {
      let s = 0;
      for (let i = 0; i < d; i++) s += x[r * d + i] * x[r * d + i];
      const inv = 1 / Math.sqrt(s / d + eps);
      for (let i = 0; i < d; i++) y[r * d + i] = x[r * d + i] * inv * g[i];
    }
    return y;
  }

  // rotate-half RoPE：x 是 S×H×hd，第 t 個詞元的位置 = startPos + t
  function ropeHalf(x, S, H, hd, startPos, theta) {
    if (x.length !== S * H * hd) throw new Error('ropeHalf：x 的長度 ' + x.length + ' 與 S×H×hd=' + (S * H * hd) + ' 不符');
    if (hd % 2 !== 0) throw new Error('ropeHalf：hd 必須是偶數（收到 ' + hd + '）');
    const half = hd / 2, y = new Float64Array(x.length);
    const inv = new Float64Array(half);
    for (let i = 0; i < half; i++) inv[i] = Math.pow(theta, -2 * i / hd);
    for (let t = 0; t < S; t++) {
      const pos = startPos + t;
      for (let h = 0; h < H; h++) {
        const o = (t * H + h) * hd;
        for (let i = 0; i < half; i++) {
          const ang = pos * inv[i], c = Math.cos(ang), s = Math.sin(ang);
          const a = x[o + i], b = x[o + i + half];
          y[o + i] = a * c - b * s;
          y[o + i + half] = b * c + a * s;
        }
      }
    }
    return y;
  }

  // KV 快取：k、v 各存 maxT×Hkv×hd（Float32，與 ORT 的 KV 相同精度）
  function createKvCache(Hkv, hd, maxT) {
    if (!(Hkv > 0 && hd > 0 && maxT > 0)) throw new Error('createKvCache：參數必須為正數');
    return { Hkv, hd, maxT, len: 0, k: new Float32Array(maxT * Hkv * hd), v: new Float32Array(maxT * Hkv * hd) };
  }
  // 把 S 個詞元的 k、v（S×Hkv×hd）接到快取尾端
  function kvAppend(cache, k, v, S) {
    const per = cache.Hkv * cache.hd, n = S * per;
    if (k.length !== n || v.length !== n) throw new Error('kvAppend：k／v 的長度應為 ' + n + '，收到 ' + k.length + '／' + v.length);
    if (cache.len + S > cache.maxT) throw new Error('KV 快取裝不下：已有 ' + cache.len + '、再加 ' + S + '，上限 ' + cache.maxT);
    const off = cache.len * per;
    for (let i = 0; i < n; i++) { cache.k[off + i] = k[i]; cache.v[off + i] = v[i]; }
    cache.len += S;
  }

  // 注意力核心：q 是 S×H×hd（已做 norm 與 RoPE），詞元 i 的絕對位置 = past + i，只看快取裡 0..past+i。
  // 呼叫前快取必須已經有 past+S 個詞元。回傳 S×H×hd（Float64）。
  function attnCore(q, S, past, cache, H, scale) {
    const hd = cache.hd, Hkv = cache.Hkv;
    if (H % Hkv !== 0) throw new Error('attnCore：H=' + H + ' 必須是 Hkv=' + Hkv + ' 的整數倍');
    if (q.length !== S * H * hd) throw new Error('attnCore：q 的長度 ' + q.length + ' 與 S×H×hd=' + (S * H * hd) + ' 不符');
    if (cache.len < past + S) throw new Error('attnCore：快取只有 ' + cache.len + ' 個詞元，不足 past+S=' + (past + S));
    const rep = H / Hkv, out = new Float64Array(S * H * hd), w = new Float64Array(past + S);
    for (let i = 0; i < S; i++) {
      const nKeys = past + i + 1;
      for (let h = 0; h < H; h++) {
        const kvh = Math.floor(h / rep), qo = (i * H + h) * hd;
        let mx = -Infinity;
        for (let j = 0; j < nKeys; j++) {
          const ko = (j * Hkv + kvh) * hd;
          let dot = 0;
          for (let d = 0; d < hd; d++) dot += q[qo + d] * cache.k[ko + d];
          w[j] = dot * scale;
          if (w[j] > mx) mx = w[j];
        }
        let sum = 0;
        for (let j = 0; j < nKeys; j++) { w[j] = Math.exp(w[j] - mx); sum += w[j]; }
        for (let j = 0; j < nKeys; j++) {
          const p = w[j] / sum, vo = (j * Hkv + kvh) * hd;
          for (let d = 0; d < hd; d++) out[qo + d] += p * cache.v[vo + d];
        }
      }
    }
    return out;
  }

  // 一整段注意力區塊（投影之後、o_proj 之前）：qk-norm → RoPE → 寫入 KV 快取 → 注意力。
  // 參數：q（S×H×hd）、k／v（S×Hkv×hd）、qNorm／kNorm（長度 hd）、cache（會被就地更新）、theta、eps。
  // 回傳 S×H×hd；快取的 len 會增加 S。
  function attentionBlock(o) {
    const { q, k, v, S, H, Hkv, hd, theta, eps, qNorm, kNorm, cache } = o;
    if (cache.Hkv !== Hkv || cache.hd !== hd) throw new Error('attentionBlock：快取的 Hkv／hd 與參數不符');
    const past = cache.len;
    const qn = rmsRows(q, qNorm, S * H, hd, eps), kn = rmsRows(k, kNorm, S * Hkv, hd, eps);
    const qr = ropeHalf(qn, S, H, hd, past, theta), kr = ropeHalf(kn, S, Hkv, hd, past, theta);
    kvAppend(cache, kr, v, S);
    return attnCore(qr, S, past, cache, H, 1 / Math.sqrt(hd));
  }

  return { rmsRows, ropeHalf, createKvCache, kvAppend, attnCore, attentionBlock };
});
