/* 圖像生成（SDXS-512）LoRA 的純函式核心（UMD，node 可測）：不碰檔案、不碰模型。
 * 負責：圖文配對的檢查、訓練設定的整理與上限、LoRA 檔的中繼資料檢查、套用時的縮放係數與合併數學。
 * 實際訓練在 lora-train/image_sdxs_lora.py（PyTorch，CPU）；這裡的合併規則必須跟它一致：W += (alpha/rank)·strength·(B·A)。
 * 格式（fa-sdxs-lora-v1）：safetensors，鍵為 U-Net 線性層的模組路徑加 ".lora_A"（形狀 rank×in）與 ".lora_B"（形狀 out×rank）。
 * 測試：renderer/src/studio/image_lora_core.test.js */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaImageLora = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var FORMAT = 'fa-sdxs-lora-v1';
  var RESOLUTION = 512;                       // SDXS-512 固定，不能改
  var IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
  // 實測（24 核心 CPU、fp32）：一步 U-Net 前向約 8 秒、前向加反向約 19 秒（512 解析度）。給預估時間用，不是保證。
  var SEC_PER_STEP_MEASURED = 19;
  var DEFAULTS = { rank: 8, alpha: null, steps: 40, lr: 5e-4, seed: 1234, resolution: RESOLUTION };
  var TARGETS = ['attn1.to_q', 'attn1.to_k', 'attn1.to_v', 'attn1.to_out.0', 'attn2.to_q', 'attn2.to_k', 'attn2.to_v', 'attn2.to_out.0'];

  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  // 圖文配對：rows 是 [{ image, caption }]；image 必須是相對路徑（不能 .. 出去、不能是絕對路徑）
  function validatePairs(rows) {
    var errors = [], warnings = [], pairs = [], seen = {};
    if (!Array.isArray(rows)) return { ok: false, pairs: [], errors: ['配對資料要是陣列（每行一筆 JSON）。'], warnings: [] };
    rows.forEach(function (r, i) {
      var tag = '第 ' + (i + 1) + ' 筆';
      if (!r || typeof r !== 'object') { errors.push(tag + '不是物件。'); return; }
      var img = typeof r.image === 'string' ? r.image.replace(/\\/g, '/') : '';
      var cap = typeof r.caption === 'string' ? r.caption.trim() : '';
      if (!img) { errors.push(tag + '缺 image（圖片相對路徑）。'); return; }
      if (img.charAt(0) === '/' || /^[a-zA-Z]:/.test(img) || img.split('/').indexOf('..') >= 0) { errors.push(tag + '的圖片路徑必須是資料夾內的相對路徑：' + img); return; }
      if (!IMAGE_EXT.test(img)) { errors.push(tag + '的圖片格式要是 png／jpg／webp：' + img); return; }
      if (!cap) { errors.push(tag + '缺 caption（英文描述較好）。'); return; }
      if (seen[img]) { errors.push(tag + '的圖片跟前面重複：' + img); return; }
      seen[img] = true;
      pairs.push({ image: img, caption: cap });
    });
    if (pairs.length < 2) errors.push('至少要 2 組可用的圖文配對（目前 ' + pairs.length + ' 組）。');
    if (pairs.length > 200) warnings.push('配對超過 200 組：CPU 上每步約 ' + SEC_PER_STEP_MEASURED + ' 秒，訓練會很久。');
    return { ok: errors.length === 0, pairs: pairs, errors: errors, warnings: warnings };
  }

  // 訓練設定：補預設值、檢查範圍。alpha 沒給就等於 rank（縮放係數 1）
  function planTrain(opts) {
    opts = opts || {};
    var errors = [], notes = [];
    var rank = opts.rank == null ? DEFAULTS.rank : opts.rank;
    var alpha = opts.alpha == null ? rank : opts.alpha;
    var steps = opts.steps == null ? DEFAULTS.steps : opts.steps;
    var lr = opts.lr == null ? DEFAULTS.lr : opts.lr;
    var seed = opts.seed == null ? DEFAULTS.seed : opts.seed;
    var resolution = opts.resolution == null ? RESOLUTION : opts.resolution;
    if (!isInt(rank) || rank < 1 || rank > 64) errors.push('rank 要是 1 到 64 的整數。');
    if (typeof alpha !== 'number' || !isFinite(alpha) || alpha <= 0) errors.push('alpha 要是正數。');
    if (!isInt(steps) || steps < 1 || steps > 2000) errors.push('步數要是 1 到 2000 的整數。');
    if (typeof lr !== 'number' || !(lr > 0 && lr <= 0.01)) errors.push('學習率要在 (0, 0.01] 之間。');
    if (!isInt(seed) || seed < 0 || seed > 4294967295) errors.push('seed 要是 0 到 4294967295 的整數。');
    if (resolution !== RESOLUTION) errors.push('解析度只能是 ' + RESOLUTION + '（SDXS-512 固定），不能用 ' + resolution + '。');
    if (errors.length) return { ok: false, errors: errors, notes: notes, config: null };
    notes.push('預估訓練時間約 ' + Math.round(steps * SEC_PER_STEP_MEASURED / 60) + ' 分鐘（CPU，' + steps + ' 步，依實測每步約 ' + SEC_PER_STEP_MEASURED + ' 秒）。');
    return { ok: true, errors: [], notes: notes, config: { rank: rank, alpha: alpha, steps: steps, lr: lr, seed: seed, resolution: resolution, targets: TARGETS.slice() } };
  }

  // 讀 LoRA 檔的中繼資料（safetensors 的 metadata 全是字串，這裡轉型並檢查）
  function parseMeta(meta) {
    meta = meta || {};
    var errors = [];
    if (meta.format !== FORMAT) errors.push('不是 ' + FORMAT + ' 格式（讀到：' + (meta.format || '沒有格式欄位') + '）。');
    var rank = Number(meta.rank), alpha = Number(meta.alpha);
    if (!isInt(rank) || rank < 1) errors.push('rank 不正確：' + meta.rank);
    if (!(alpha > 0) || !isFinite(alpha)) errors.push('alpha 不正確：' + meta.alpha);
    if (!/^[0-9a-f]{40}$/.test(String(meta.base_rev || ''))) errors.push('缺基底版本（base_rev，要是 40 位 commit）。');
    if (errors.length) return { ok: false, errors: errors, meta: null };
    return { ok: true, errors: [], meta: { rank: rank, alpha: alpha, baseRepo: meta.base_repo || '', baseRev: meta.base_rev, resolution: Number(meta.resolution) || RESOLUTION, steps: Number(meta.steps) || 0, seed: Number(meta.seed) || 0, lossBefore: Number(meta.loss_before), lossAfter: Number(meta.loss_after), targets: String(meta.targets || '').split(',').filter(Boolean) } };
  }

  // 套用強度：(alpha/rank)·strength。strength 夾在 [0, 2]，超過的要說明
  function mergeScale(meta, strength) {
    var s = strength == null ? 1 : Number(strength);
    if (!isFinite(s)) return { ok: false, error: '強度要是數字。' };
    var clamped = Math.min(2, Math.max(0, s));
    return { ok: true, scale: (meta.alpha / meta.rank) * clamped, strength: clamped, clamped: clamped !== s };
  }

  // 合併一個線性層：W（out×in，列優先的 Float32Array 或 Array）+= scale·(B·A)。A 是 rank×in，B 是 out×rank。回傳新陣列，不改原來的。
  function mergeLinear(W, A, B, out, inn, rank, scale) {
    if (W.length !== out * inn || A.length !== rank * inn || B.length !== out * rank) throw new Error('形狀不符');
    var R = new Float32Array(W.length);
    for (var o = 0; o < out; o++) for (var i = 0; i < inn; i++) {
      var acc = 0;
      for (var r = 0; r < rank; r++) acc += B[o * rank + r] * A[r * inn + i];
      R[o * inn + i] = W[o * inn + i] + scale * acc;
    }
    return R;
  }

  // 訓練目標的損失（MSE），給測試與紀錄用
  function mse(a, b) {
    if (a.length !== b.length || !a.length) throw new Error('長度不符或為空');
    var s = 0; for (var i = 0; i < a.length; i++) { var d = a[i] - b[i]; s += d * d; } return s / a.length;
  }

  // 工作室用的說明：這個核心產出什麼、缺什麼（給 model_types_core 的 gap 文字參考）
  function describe() {
    return { format: FORMAT, resolution: RESOLUTION, targets: TARGETS.slice(), secPerStepMeasured: SEC_PER_STEP_MEASURED };
  }

  return { FORMAT: FORMAT, RESOLUTION: RESOLUTION, TARGETS: TARGETS, validatePairs: validatePairs, planTrain: planTrain, parseMeta: parseMeta, mergeScale: mergeScale, mergeLinear: mergeLinear, mse: mse, describe: describe };
});
