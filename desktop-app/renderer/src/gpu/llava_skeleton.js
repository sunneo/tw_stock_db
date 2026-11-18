/* llava_skeleton.js — LLaVA-Interleave Qwen 0.5B 的 CPU 參考骨架（O13a）。只有資料與運算，沒有權重、沒有 GPU、沒有接進 vlm_core。
 * 組成：影像（HWC，呼叫端已做前處理）→ 裁成 patch 的整數倍 → vit_skeleton（SigLIP 結構，26 層，取最後一層輸出，不做後 LayerNorm，全部 729 個 patch 都留）
 *      → 投影層（linear → 精確 GELU → linear；1152 → 1024 → 1024）→ 影像嵌入（每個 patch 一個 token）
 *      → 插入文字嵌入序列中的影像佔位詞元（151646）→ llm_skeleton（描述表 qwen2-0.5b：Qwen2 結構，q／k／v 有偏置）逐位置前進，回傳最後一個位置的 logits。
 * 數字來源：ai-temp/llava-config/llava-hf.config.json（2026-11-18 下載，sha 未核對；luisresende13 的 config 與之相同）。
 *
 * 尚未核對（沒有下載權重，見 docs/CHECKLIST.cudaweb-optimize.md 的 O13a）：
 *   1. rms_norm_eps：config 沒寫，這裡用 Qwen2 的預設 1e-6（要對 modeling 程式）。
 *   2. patch 嵌入的權重順序：patchW 的欄位是 (py, px, c) 展開；HF 的 conv 權重是 [out][c][py][px]，轉換權重時要重排。
 *   3. 影像前處理（SigLIP 的正規化、縮放）由呼叫端負責。
 *   4. 影像佔位詞元：ids 要先展開成每個影像 token 一個（與 HF processor 相同）。
 *   5. 384 不是 14 的倍數：SigLIP 的 stride-14 卷積會丟掉尾端不足一格的像素（27×27＝729 個 patch），這裡照做（cropToPatch）。
 * 數值：精確 GELU 的 erf 用 Abramowitz–Stegun 7.1.26 近似（最大誤差約 1.5e-7）。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaLlavaSkeleton。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./vit_skeleton.js'), require('./llm_skeleton.js'), require('./llm_arch.js')); }
  else { root.FaLlavaSkeleton = factory(root.FaVitSkeleton, root.FaLlmSkeleton, root.FaLlmArch); }
}(typeof self !== 'undefined' ? self : this, function (VIT, LLM, ARCH) {
  'use strict';

  // 模型表（config.json 的數字）。gpuNeedsF16 的期望值是 false：這個模型不需要 f16，無 f16 的卡走 f32 或 q8。
  // 實際的接線由 vlm_core.js 的模型表決定；本檔目前沒有接線。
  const LLAVA_INTERLEAVE_05B = {
    name: 'llava-interleave-qwen-0.5b',
    text: 'qwen2-0.5b',                       // llm_arch.js 的描述表名
    vision: { layers: 26, hidden: 1152, heads: 16, ffn: 4304, patch: 14, channels: 3, eps: 1e-6 },   // SigLIP，gelu_pytorch_tanh
    imageSize: 384,
    featureLayer: -1,                        // vision_feature_layer：hidden_states[-1]，即最後一層輸出（不過後 LayerNorm）
    featureSelect: 'full',                   // vision_feature_select_strategy：整個 patch 序列都留（SigLIP 沒有 CLS）
    projectorAct: 'gelu',                    // projector_hidden_act：精確 GELU（erf），不是 tanh 近似
    imageTokenId: 151646,                    // image_token_index
    gpuNeedsF16: false,
    verified: false
  };

  // erf：Abramowitz–Stegun 7.1.26，最大誤差約 1.5e-7
  function erf(x) {
    const s = x < 0 ? -1 : 1, ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return s * y;
  }
  // 精確 GELU：x·Φ(x) = 0.5·x·(1 + erf(x/√2))
  function geluExact(v) { return 0.5 * v * (1 + erf(v / Math.SQRT2)); }

  // 裁成 patch 的整數倍（左上角保留，與 stride-p 卷積相同）。回傳 { img, H, W }
  function cropToPatch(img, H, W, ch, p) {
    if (img.length !== H * W * ch) throw new Error('llava_skeleton：影像元素數 ' + img.length + ' 與 H×W×C=' + (H * W * ch) + ' 不符');
    const H2 = Math.floor(H / p) * p, W2 = Math.floor(W / p) * p;
    if (H2 === 0 || W2 === 0) throw new Error('llava_skeleton：影像比一個 patch（' + p + '）還小');
    if (H2 === H && W2 === W) return { img: img, H: H, W: W };
    const out = new Float32Array(H2 * W2 * ch);
    for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) for (let c = 0; c < ch; c++) out[(y * W2 + x) * ch + c] = img[(y * W + x) * ch + c];
    return { img: out, H: H2, W: W2 };
  }
  // 視覺特徵：featureLayer 為負數（-1＝最後一層，-2＝倒數第二層…）；只跑到該層，不做後 LayerNorm。回傳 [nPatch][visionHidden]
  function visionFeatures(vis, featureLayer, featureSelect, wVit, img, H, W) {
    if (featureSelect !== 'full') throw new Error('llava_skeleton：只支援 vision_feature_select_strategy 為 full（收到 ' + featureSelect + '）');
    if (!(featureLayer < 0 && featureLayer >= -vis.layers && featureLayer === Math.floor(featureLayer))) {
      throw new Error('llava_skeleton：featureLayer 必須是 -1 到 -' + vis.layers + ' 的整數');
    }
    const nL = vis.layers + featureLayer + 1;
    const c = cropToPatch(img, H, W, vis.channels, vis.patch);
    return VIT.encode(vis, wVit, c.img, c.H, c.W, { layers: nL, postNorm: false });
  }
  // 投影層：linear1（視覺 → 文字）→ 精確 GELU → linear2（文字 → 文字）。w = { p1W[text*vis], p1B[text], p2W[text*text], p2B[text] }
  function projector(textHidden, visHidden, w, feats) {
    const need = (name, got, want) => { if (!got || got.length !== want) throw new Error('llava_skeleton：投影權重 ' + name + ' 長度應為 ' + want + '，實際 ' + (got ? got.length : '缺少')); };
    need('p1W', w.p1W, textHidden * visHidden); need('p1B', w.p1B, textHidden);
    need('p2W', w.p2W, textHidden * textHidden); need('p2B', w.p2B, textHidden);
    return feats.map((x) => {
      if (x.length !== visHidden) throw new Error('llava_skeleton：視覺特徵維度應為 ' + visHidden + '，實際 ' + x.length);
      const h = VIT.linear(w.p1W, w.p1B, textHidden, visHidden, x);
      for (let i = 0; i < h.length; i++) h[i] = geluExact(h[i]);
      return VIT.linear(w.p2W, w.p2B, textHidden, textHidden, h);
    });
  }
  // 把文字詞元與影像嵌入合成一條輸入序列：影像佔位詞元依序換成影像嵌入；數量不符就丟錯（與 smolvlm_skeleton 相同語意）
  function assemble(textArch, ids, imageEmbeds, imageTokenId, embed) {
    const H = textArch.hidden, V = textArch.vocab;
    const need = ids.filter((t) => t === imageTokenId).length;
    if (need !== imageEmbeds.length) throw new Error('llava_skeleton：影像佔位詞元有 ' + need + ' 個，但影像嵌入有 ' + imageEmbeds.length + ' 個');
    let next = 0;
    return ids.map((t) => {
      if (t === imageTokenId) return imageEmbeds[next++];
      if (!(t >= 0 && t < V) || t !== Math.floor(t)) throw new Error('llava_skeleton：詞元超出詞表（' + t + '）');
      return embed.subarray(t * H, t * H + H);
    });
  }
  // 影像 token 數：floor(size/patch)²
  function numImageTokens(model) { const n = Math.floor(model.imageSize / model.vision.patch); return n * n; }
  // 整段前向。model.textArch 可省（省略時用 llm_arch 的 model.text）；測試用小描述時才直接給。回傳最後一個位置的 logits、argmax 與序列長度。
  function forward(model, w, img, H, W, ids) {
    const textArch = model.textArch || ARCH.archFor(model.text);
    if (!textArch) throw new Error('llava_skeleton：找不到語言模型描述表 ' + model.text);
    const feats = visionFeatures(model.vision, model.featureLayer, model.featureSelect, w.vit, img, H, W);
    const imgEmb = projector(textArch.hidden, model.vision.hidden, w.proj, feats);
    const seq = assemble(textArch, ids, imgEmb, model.imageTokenId, w.lm.embed);
    const st = LLM.createState(textArch, w.lm);
    let logits = null;
    for (const x of seq) logits = LLM.stepVec(st, x);
    let best = 0; for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
    return { logits: logits, argmax: best, length: seq.length, imageTokens: imgEmb.length };
  }

  return { LLAVA_INTERLEAVE_05B: LLAVA_INTERLEAVE_05B, erf: erf, geluExact: geluExact, cropToPatch: cropToPatch,
    visionFeatures: visionFeatures, projector: projector, assemble: assemble, numImageTokens: numImageTokens, forward: forward };
}));
