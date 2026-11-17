/* smolvlm_skeleton.js — 視覺語言模型骨架（O13b，SmolVLM 256M 的結構）的 CPU 參考實作，只有資料與運算，沒有權重、沒有 GPU。
 * 組成：影像 → vit_skeleton（SigLIP 類編碼器）→ pixel shuffle（r×r 個相鄰 patch 併成一個 token）→ 線性連接器 → 影像嵌入
 *      → 插入文字嵌入序列中的影像佔位詞元 → llm_skeleton（SmolLM 類）逐位置前進，回傳最後一個位置的 logits。
 * 尚未核對（需要真實的 config.json 與 modeling 程式，目前這台沒有檔案，見 docs/CHECKLIST.cudaweb-optimize.md 的「待下載」）：
 *   1. pixel shuffle 的展開順序：本檔用「輸出 token 內，依 (dy, dx) 的列主序，每個子 patch 內依通道」。真實模型的順序要對 modeling 程式才能定案。
 *   2. 連接器的縮放因子 r、LM 與視覺的隱藏維度。這裡都由呼叫端給，不寫死。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaSmolvlmSkeleton。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./vit_skeleton.js'), require('./llm_skeleton.js')); }
  else { root.FaSmolvlmSkeleton = factory(root.FaVitSkeleton, root.FaLlmSkeleton); }
}(typeof self !== 'undefined' ? self : this, function (VIT, LLM) {
  'use strict';

  // feat：長度 gh×gw 的陣列（列主序），每格是長度 C 的向量；回傳 (gh/r)×(gw/r) 個 token，每個長度 C×r×r
  function pixelShuffle(feat, gh, gw, C, r) {
    if (!(r >= 1) || r !== Math.floor(r)) throw new Error('smolvlm_skeleton：r 必須是正整數');
    if (gh % r !== 0 || gw % r !== 0) throw new Error('smolvlm_skeleton：格子大小 ' + gh + '×' + gw + ' 要是 r（' + r + '）的整數倍');
    if (feat.length !== gh * gw) throw new Error('smolvlm_skeleton：格子數 ' + feat.length + ' 與 gh×gw=' + (gh * gw) + ' 不符');
    const out = [];
    for (let oy = 0; oy < gh / r; oy++) for (let ox = 0; ox < gw / r; ox++) {
      const t = new Float32Array(C * r * r); let k = 0;
      for (let dy = 0; dy < r; dy++) for (let dx = 0; dx < r; dx++) {
        const v = feat[(oy * r + dy) * gw + (ox * r + dx)];
        if (!v || v.length !== C) throw new Error('smolvlm_skeleton：第 ' + (oy * r + dy) + ',' + (ox * r + dx) + ' 格的向量長度應為 ' + C);
        for (let c = 0; c < C; c++) t[k++] = v[c];
      }
      out.push(t);
    }
    return out;
  }
  // 連接器：每個 token 做一次線性投影到 LM 的隱藏維度；W 為 [lmHidden][inDim]
  function connector(W, b, lmHidden, inDim, tokens) {
    if (!W || W.length !== lmHidden * inDim) throw new Error('smolvlm_skeleton：連接器權重長度應為 ' + (lmHidden * inDim) + '，實際 ' + (W ? W.length : '缺少'));
    if (!b || b.length !== lmHidden) throw new Error('smolvlm_skeleton：連接器偏置長度應為 ' + lmHidden);
    return tokens.map((t) => VIT.linear(W, b, lmHidden, inDim, t));
  }
  // 把文字詞元與影像嵌入合成一條輸入序列：影像佔位詞元依序換成影像嵌入；數量不符就丟錯
  function assemble(lm, ids, imageEmbeds, imageTokenId, embed) {
    const H = lm.hidden, V = lm.vocab;
    const need = ids.filter((t) => t === imageTokenId).length;
    if (need !== imageEmbeds.length) throw new Error('smolvlm_skeleton：影像佔位詞元有 ' + need + ' 個，但影像嵌入有 ' + imageEmbeds.length + ' 個');
    let next = 0;
    return ids.map((t) => {
      if (t === imageTokenId) return imageEmbeds[next++];
      if (!(t >= 0 && t < V) || t !== Math.floor(t)) throw new Error('smolvlm_skeleton：詞元超出詞表（' + t + '）');
      return embed.subarray(t * H, t * H + H);
    });
  }
  // 整段前向：回傳最後一個位置的 logits、argmax，以及合成後的序列長度（方便對拍）
  function forward(cfg, w, img, imgH, imgW, ids) {
    const vit = cfg.vit, lm = cfg.lm;
    const enc = VIT.encode(vit.arch, w.vit, img, imgH, imgW);            // [nPatch][vitHidden]
    const gh = imgH / vit.arch.patch, gw = imgW / vit.arch.patch;
    const shuffled = pixelShuffle(enc, gh, gw, vit.arch.hidden, cfg.r);   // [nTok][vitHidden*r*r]
    const imgEmb = connector(w.connW, w.connB, lm.hidden, vit.arch.hidden * cfg.r * cfg.r, shuffled);
    const seq = assemble(lm, ids, imgEmb, cfg.imageTokenId, w.lm.embed);
    const st = LLM.createState(lm, w.lm);
    let logits = null;
    for (const x of seq) logits = LLM.stepVec(st, x);
    let best = 0; for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
    return { logits: logits, argmax: best, length: seq.length, imageTokens: imgEmb.length };
  }

  return { pixelShuffle: pixelShuffle, connector: connector, assemble: assemble, forward: forward };
}));
