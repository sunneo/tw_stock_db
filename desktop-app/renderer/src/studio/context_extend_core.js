/* 上下文擴展（加長上下文）純函式（UMD，node 可測）。DESIGN.offline-training-studio.md §16。
 * 基底 Qwen3-0.6B：原長度（max_position_embeddings，也是 app 的 q8 圖 cos_cache 的列數）= 40960。
 * 只允許 2 倍與 4 倍（YaRN 因子）。估算的記憶體與 KV 快取是算術推算，不是實測峰值；實測數字寫在 DESIGN 章節。
 * 測試：renderer/src/studio/context_extend_core.test.js。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else (root.FaContextExtend = factory()); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var ORIG_MAX = 40960;          // 基底 config.json 的 max_position_embeddings
  var ROPE_THETA = 1000000;      // 基底 config.json 的 rope_theta
  var MODEL = { layers: 28, kvHeads: 8, headDim: 128, weightsQ8Bytes: 617687575 }; // q8 圖檔大小（實測）
  var FACTORS = [2, 4];
  var KV_BYTES = { fp32: 4, fp16: 2 };

  function targetLength(factor) { return ORIG_MAX * factor; }

  function validateFactor(factor) {
    if (FACTORS.indexOf(Number(factor)) < 0) return { ok: false, message: '只支援 2 倍或 4 倍（目前 ' + factor + '）。' };
    return { ok: true, message: '' };
  }

  // transformers 5.x 的 rope_parameters 格式；factor 1 等於不擴展
  function ropeParameters(factor) {
    if (Number(factor) === 1) return { rope_type: 'default', rope_theta: ROPE_THETA };
    return { rope_type: 'yarn', factor: Number(factor), original_max_position_embeddings: ORIG_MAX, rope_theta: ROPE_THETA };
  }

  // YaRN 的注意力縮放（與 HF 相同的公式）：0.1·ln(f)+1
  function yarnAttentionScale(factor) { return Number(factor) === 1 ? 1 : 0.1 * Math.log(Number(factor)) + 1; }

  // KV 快取大小（位元組）：層數 × 2（K、V） × KV 頭數 × 頭維度 × 每元素位元組 × 權杖數
  function kvCacheBytes(tokens, dtype) {
    var b = KV_BYTES[dtype || 'fp32'];
    if (!b) throw new Error('未知的 KV 精度：' + dtype);
    return MODEL.layers * 2 * MODEL.kvHeads * MODEL.headDim * b * tokens;
  }

  // 記憶體粗估（推算）：q8 權重檔大小 + KV 快取。不含 ORT 自身與激活（實測會更高，見 DESIGN）
  function memoryEstimate(tokens, dtype) {
    var kv = kvCacheBytes(tokens, dtype);
    return { tokens: tokens, dtype: dtype || 'fp32', kvBytes: kv, weightBytes: MODEL.weightsQ8Bytes, totalBytes: kv + MODEL.weightsQ8Bytes, kvGiB: round2(kv / 1073741824), totalGiB: round2((kv + MODEL.weightsQ8Bytes) / 1073741824) };
  }

  // 把位元組換成 GiB（兩位小數），給介面用
  function round2(x) { return Math.round(x * 100) / 100; }

  // 訓練時間粗估（推算，依 2 個實測點的比例；介面要標「估計」）：
  // 實測（本機 24 核 CPU）：8192 權杖的前向約 18 秒；訓練一步（1 段 8192 ＋ 2 段 1024，含反向與重算）實測見 DESIGN。
  function estimateSeconds(stepSecs, steps) { return Math.round(stepSecs * steps); }

  // 介面上的摘要（純文字）
  function plan(factor, opts) {
    opts = opts || {};
    var v = validateFactor(factor);
    if (!v.ok) return { ok: false, message: v.message };
    var L = targetLength(factor);
    var m32 = memoryEstimate(L, 'fp32');
    var m16 = memoryEstimate(L, 'fp16');
    return {
      ok: true, factor: Number(factor), targetLength: L, originalLength: ORIG_MAX,
      rope: ropeParameters(factor), attentionScale: round2(yarnAttentionScale(factor)),
      memory: { fp32: m32, fp16: m16 },
      stepSecondsEstimate: opts.stepSeconds ? estimateSeconds(opts.stepSeconds, opts.steps || 1) : null,
      lines: [
        '目標長度：' + L + ' 權杖（原 ' + ORIG_MAX + ' 的 ' + factor + ' 倍）',
        'RoPE：YaRN，因子 ' + factor + '，注意力縮放 ' + round2(yarnAttentionScale(factor)),
        'KV 快取（fp32，推算）：' + m32.kvGiB + ' GiB；加上 q8 權重檔 ' + round2(MODEL.weightsQ8Bytes / 1073741824) + ' GiB，合計約 ' + m32.totalGiB + ' GiB',
        'KV 快取（fp16，推算）：' + m16.kvGiB + ' GiB；合計約 ' + m16.totalGiB + ' GiB',
        '網頁版（WebAssembly 4 GiB 上限）：目標長度的 fp32 KV 快取超過 4 GiB 時不能在網頁版使用。',
        '這是算術推算，不是實測峰值。實測的長度與時間見 DESIGN.offline-training-studio.md §16.5。'
      ]
    };
  }

  return { ORIG_MAX: ORIG_MAX, ROPE_THETA: ROPE_THETA, MODEL: MODEL, FACTORS: FACTORS, targetLength: targetLength,
    validateFactor: validateFactor, ropeParameters: ropeParameters, yarnAttentionScale: yarnAttentionScale,
    kvCacheBytes: kvCacheBytes, memoryEstimate: memoryEstimate, estimateSeconds: estimateSeconds, plan: plan };
});
