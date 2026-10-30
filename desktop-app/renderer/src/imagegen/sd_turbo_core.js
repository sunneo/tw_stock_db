/* sd-turbo 圖生圖改圖（UMD，純函式）：使用者給一張圖＋一句話，在本機把圖改掉，不連線上服務。
 * 這個檔案只有「不碰網路、不碰模型」的部分：模型清單與檔案大小、選版本、圖生圖取樣的數學、遮罩混合、尺寸對齊、錯誤白話說明。下載、載入、執行在 floating-assistant 裡。
 * 取樣（變分形式，sd-turbo 與 SDXS 共用）：ᾱ(t) 由 scaled_linear 的 beta（0.00085→0.012，1000 步）累乘；
 *   z0 = vae_encoder(影像)×0.18215；x_t = √ᾱ·z0 + √(1−ᾱ)·雜訊；每步：eps = unet(x_t, t, 文字)；x0 = (x_t − √(1−ᾱ)·eps)/√ᾱ；下一步 x = √ᾱ'·x0 + √(1−ᾱ')·新雜訊（最後一步直接用 x0）。
 *   strength 決定從哪個時間點開始：steps×strength 取整，至少一步；strength=1 就是整張重畫。
 * 授權：sd-turbo 是 Stability AI 社群授權（商業須登記、年營收超過 100 萬美元失效），所以不內建、不代下載——使用者按下載才取得。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaSdTurbo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SIZE = 512, LATENT = 64, SCALE = 0.18215, TRAIN_STEPS = 1000, MAXLEN = 77;
  var HF = 'https://huggingface.co/';
  // 位元組數與版本（commit）是釘住的：下載完核對大小，不一樣就不用。sd-turbo 的 ONNX 匯出是 fp16 大小（unet 1.7 GB）。
  var MODELS = [
    { id: 'sd-turbo-webgpu', family: 'sd-turbo', device: 'webgpu', ep: 'webgpu', label: 'sd-turbo（GPU 版，fp16）', repo: 'jdp8/sd-turbo-onnx', rev: '4ea5d203f7def52bcf83781990f97721c98a7f22', needsF16: true, userDownload: true,
      files: [{ name: 'text_encoder/model.onnx', role: 'text', bytes: 681552894 }, { name: 'unet/model.onnx', role: 'unet', bytes: 1737702391 }, { name: 'vae_decoder/model.onnx', role: 'vae', bytes: 99129787 }, { name: 'vae_encoder/model.onnx', role: 'vaeEnc', bytes: 136760235 }] }
  ];
  // 小型 VAE（TAESD，MIT 授權，各約 5 MB）：給 SDXS／降級路徑當編碼器與解碼器，wasm 與 WebGPU 都能跑（onnxruntime-web 1.20 wasm 實測編碼→解碼來回可還原）。
  // 輸入影像範圍 [0,1]（不是 [-1,1]）；編碼輸出已是縮放後的潛在值（不用再乘 0.18215）；解碼輸出也是 [0,1]。
  var TAESD = { id: 'taesd', label: 'TAESD（小型 VAE）', repo: 'julienkay/taesd', rev: 'c8a437fd0201c21c3bcd298fcf3181b063bcc1eb', license: 'MIT', range: '01', scale: 1,
    files: [{ name: 'vae_encoder/model.onnx', role: 'vaeEnc', bytes: 4910437 }, { name: 'vae_decoder/model.onnx', role: 'vae', bytes: 4912312 }] };
  var LICENSE = { name: 'Stability AI 社群授權', url: 'https://huggingface.co/stabilityai/sd-turbo/blob/main/LICENSE.md',
    note: 'sd-turbo 是 Stability AI 社群授權：研究與非商業免費；商業使用須向 Stability AI 登記（https://stability.ai/community-license），年營收超過 100 萬美元即失效。本程式不內建模型，按下載才從 Hugging Face 取得，使用即表示你同意該授權。' };
  // 沒有可用的 sd-turbo 版本（例如沒有 WebGPU）時的降級：用已內建下載的 SDXS（同樣是 4 通道的 SD 系列，同一套數學），它的圖生圖要另配 VAE 編碼器
  var FALLBACK = { family: 'sdxs', note: 'sd-turbo 目前沒有能在 CPU（wasm）跑的版本（fp16 的 unet 約 1.7 GB，fp32 超過 wasm 記憶體上限），沒有 WebGPU 時降級用 SDXS。' };

  function byId(id) { for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === id) return MODELS[i]; return null; }
  function urlOf(model, file) { return HF + model.repo + '/resolve/' + model.rev + '/' + file; }
  function totalBytes(model) { return model.files.reduce(function (a, f) { return a + f.bytes; }, 0); }
  function fmtBytes(n) { n = Number(n) || 0; return n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : Math.round(n / 1e6) + ' MB'; }

  // env: { hasGpu, f16 }；pref: auto｜webgpu｜cpu。回傳 sd-turbo 版本，或說明為什麼要降級
  function pickModel(env, pref) {
    env = env || {}; pref = pref === 'webgpu' || pref === 'cpu' ? pref : 'auto'; var notes = [];
    if (pref === 'cpu') return { ok: true, fallback: 'sdxs', ep: 'wasm', notes: ['設定指定用 CPU。' + FALLBACK.note] };
    if (!env.hasGpu) {
      if (pref === 'webgpu') return { ok: false, reason: '設定指定用 GPU 版，但這個環境沒有 WebGPU（瀏覽器或顯示卡不支援）。' };
      return { ok: true, fallback: 'sdxs', ep: 'wasm', notes: ['沒有 WebGPU。' + FALLBACK.note] };
    }
    if (!env.f16) {
      if (pref === 'webgpu') notes.push('這張顯示卡不支援 f16（shader-f16），GPU 版可能載入失敗。');
      else return { ok: true, fallback: 'sdxs', ep: 'wasm', notes: ['顯示卡不支援 f16。' + FALLBACK.note] };
    }
    var m = byId('sd-turbo-webgpu'); notes.push('第一次要下載約 ' + fmtBytes(totalBytes(m)) + '。');
    return { ok: true, model: m, ep: m.ep, notes: notes };
  }

  // ᾱ：scaled_linear 的 beta 累乘
  var _ac = null;
  function alphasCumprod() {
    if (_ac) return _ac; var out = new Float64Array(TRAIN_STEPS), a = 1, b0 = Math.sqrt(0.00085), b1 = Math.sqrt(0.012);
    for (var i = 0; i < TRAIN_STEPS; i++) { var b = b0 + (b1 - b0) * i / (TRAIN_STEPS - 1); a *= 1 - b * b; out[i] = a; }
    return (_ac = out);
  }
  // 這次要走哪些時間點。steps 1～4（trailing 間隔），strength 0～1 決定略過前面幾個
  function timesteps(steps, strength) {
    steps = Math.max(1, Math.min(4, Math.round(Number(steps) || 1))); var s = Number(strength); if (!isFinite(s)) s = 0.5; s = Math.max(0.05, Math.min(1, s));
    var all = []; for (var i = 0; i < steps; i++) all.push(Math.round(TRAIN_STEPS - 1 - i * (TRAIN_STEPS / steps)));
    var n = Math.max(1, Math.min(steps, Math.round(steps * s)));
    var ts = all.slice(steps - n);
    if (steps === 1 && s < 1) ts = [Math.max(1, Math.round((TRAIN_STEPS - 1) * s))]; // 一步時用 strength 直接決定起點
    return ts;
  }
  function sqrtAb(t) { return Math.sqrt(alphasCumprod()[t]); }
  function sqrtOneMinusAb(t) { return Math.sqrt(1 - alphasCumprod()[t]); }

  // 可重現的亂數
  function rng(seed) { var s = (seed >>> 0) || 1; return function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function gaussian(seed, n) { var r = rng(seed), out = new Float32Array(n); for (var i = 0; i < n; i += 2) { var u = Math.max(r(), 1e-12), v = r(), m = Math.sqrt(-2 * Math.log(u)); out[i] = m * Math.cos(2 * Math.PI * v); if (i + 1 < n) out[i + 1] = m * Math.sin(2 * Math.PI * v); } return out; }

  // VAE 編碼器的輸出：8 通道（平均＋對數變異）取前 4 個通道的平均；4 通道就直接用。再乘縮放
  function latentFromEncoder(out, n, scale) {
    n = n || 4 * LATENT * LATENT; var res = new Float32Array(n), k = scale == null ? SCALE : scale;
    if (!out || out.length < n) return null;
    for (var i = 0; i < n; i++) res[i] = out[i] * k; return res;
  }
  // 影像 RGBA（w×h）→ 編碼器輸入 CHW，範圍 [-1,1]（range 給 '01' 則 [0,1]，TAESD 用）
  function toChw(rgba, w, h, range) {
    var plane = w * h, out = new Float32Array(plane * 3), r01 = range === '01';
    for (var i = 0; i < plane; i++) for (var c = 0; c < 3; c++) out[c * plane + i] = r01 ? rgba[i * 4 + c] / 255 : rgba[i * 4 + c] / 127.5 - 1;
    return out;
  }
  // 加噪到時間點 t：x = √ᾱ·z0 + √(1−ᾱ)·noise
  function addNoise(z0, noise, t) {
    var a = sqrtAb(t), b = sqrtOneMinusAb(t), out = new Float32Array(z0.length);
    for (var i = 0; i < z0.length; i++) out[i] = a * z0[i] + b * noise[i]; return out;
  }
  // 由 eps 還原 x0
  function predictX0(x, eps, t) {
    var a = sqrtAb(t), b = sqrtOneMinusAb(t), out = new Float32Array(x.length);
    for (var i = 0; i < x.length; i++) out[i] = (x[i] - b * eps[i]) / a; return out;
  }
  // 一步取樣：給目前的 x、eps、這步的 t 與下一步的 tNext（沒有下一步就回 x0）
  function step(x, eps, t, tNext, noise) {
    var x0 = predictX0(x, eps, t); if (tNext == null) return x0;
    return addNoise(x0, noise, tNext);
  }

  // 尺寸：模型固定 512×512。長寬比不同時，等比縮放放進 512 的畫布，記下放哪裡，之後裁回原比例
  function fitBox(w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h)); var k = Math.min(SIZE / w, SIZE / h), dw = Math.max(8, Math.round(w * k / 8) * 8), dh = Math.max(8, Math.round(h * k / 8) * 8);
    dw = Math.min(SIZE, dw); dh = Math.min(SIZE, dh);
    return { w: w, h: h, dw: dw, dh: dh, dx: Math.floor((SIZE - dw) / 2), dy: Math.floor((SIZE - dh) / 2), size: SIZE };
  }

  // 遮罩混合：mask 是 0～1 的 Float32（w×h），越接近 1 越用新圖；先羽化（盒狀模糊 radius 像素）再混。只改遮罩內，其餘保留原圖
  function feather(mask, w, h, radius) {
    radius = Math.max(0, Math.round(radius)); if (!radius) return mask;
    var tmp = new Float32Array(mask.length), out = new Float32Array(mask.length), r = radius, x, y, k, s, c;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) { s = 0; c = 0; for (k = -r; k <= r; k++) { var xx = x + k; if (xx >= 0 && xx < w) { s += mask[y * w + xx]; c++; } } tmp[y * w + x] = s / c; }
    for (x = 0; x < w; x++) for (y = 0; y < h; y++) { s = 0; c = 0; for (k = -r; k <= r; k++) { var yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; c++; } } out[y * w + x] = s / c; }
    return out;
  }
  function blend(origRgba, newRgba, mask, w, h, featherPx) {
    var m = mask ? feather(mask, w, h, featherPx == null ? 4 : featherPx) : null, out = new Uint8ClampedArray(origRgba.length);
    for (var i = 0, n = w * h; i < n; i++) { var a = m ? m[i] : 1; for (var c = 0; c < 4; c++) out[i * 4 + c] = Math.round(origRgba[i * 4 + c] * (1 - a) + newRgba[i * 4 + c] * a); if (!m) out[i * 4 + 3] = origRgba[i * 4 + 3]; }
    return out;
  }

  // 分詞結果補成固定長度：sd-turbo（SD 2.x）用 "!"（編號 0）補，SDXS（SD 1.x）用結尾符號（49407）補
  function padIds(ids, padId, len) {
    len = len || MAXLEN; var a = Array.prototype.slice.call(ids || []).map(Number).filter(function (x) { return x !== 49407 || true; });
    if (!a.length) a = [49406, 49407];
    if (a.length > len) { a = a.slice(0, len); a[len - 1] = 49407; }
    var end = a.indexOf(49407); if (end < 0) { a[a.length - 1] = 49407; end = a.length - 1; }
    a = a.slice(0, end + 1); while (a.length < len) a.push(padId == null ? 49407 : padId); return a;
  }

  // 請求整理：prompt 必填；strength 0.05～1（「微調」0.35、「大改」0.8，預設 0.5）；steps 1～4
  var STRENGTH_WORDS = [[/微調|稍微|一點點|輕微|subtle|slight/i, 0.35], [/大改|大幅|徹底|完全|重畫|dramatic|completely/i, 0.8]];
  function plan(a) {
    a = a || {}; var prompt = String(a.prompt == null ? '' : a.prompt).trim(); if (!prompt) return { ok: false, error: '要把圖改成什麼？請給 prompt（英文效果較好）。' };
    var notes = [], strength = Number(a.strength);
    if (!isFinite(strength) || a.strength === '' || a.strength == null) { strength = 0.5; var text = String(a.request || ''); for (var i = 0; i < STRENGTH_WORDS.length; i++) if (STRENGTH_WORDS[i][0].test(text)) { strength = STRENGTH_WORDS[i][1]; break; } }
    if (strength < 0.05 || strength > 1) { notes.push('強度超出 0.05～1，已調整。'); strength = Math.max(0.05, Math.min(1, strength)); }
    var steps = Number(a.steps); if (!isFinite(steps) || !steps) steps = strength > 0.6 ? 2 : 1; steps = Math.max(1, Math.min(4, Math.round(steps)));
    var seed = a.seed != null && a.seed !== '' && isFinite(Number(a.seed)) ? (Math.floor(Number(a.seed)) >>> 0) : (Math.floor(Math.random() * 4294967296) >>> 0);
    return { ok: true, prompt: prompt.slice(0, 600), strength: strength, steps: steps, seed: seed, timesteps: timesteps(steps, strength), notes: notes };
  }

  function explainError(err, model, env) {
    var msg = String((err && err.message) || err || ''); model = model || {}; env = env || {};
    if (/float16|fp16|f16|shader-f16/i.test(msg)) return '改圖的 GPU 版需要顯示卡支援 f16，這張不支援。（' + msg.slice(0, 100) + '）';
    if (/out of memory|oom|allocation|memory access|Array buffer allocation|RangeError/i.test(msg)) return '記憶體不夠（sd-turbo 需要約 ' + fmtBytes(model.files ? totalBytes(model) : 1.2e9 + 5e8) + '，載入時還要再多一些）。關掉其他吃記憶體的程式再試。（' + msg.slice(0, 100) + '）';
    if (/webgpu|adapter|gpu device|createBuffer/i.test(msg)) return 'WebGPU 初始化失敗（' + msg.slice(0, 100) + '）。';
    if (/fetch|network|Failed to fetch|NetworkError|HTTP|download/i.test(msg)) return '下載模型失敗（' + msg.slice(0, 100) + '）。檢查網路能不能連到 huggingface.co 後再試，已下載的部分會保留。';
    if (/not supported|unsupported|Unsupported|operator|opset/i.test(msg)) return '這個模型用到的運算子，目前的執行環境不支援（' + msg.slice(0, 120) + '）。';
    return '本機改圖失敗：' + msg.slice(0, 200);
  }

  return { SIZE: SIZE, LATENT: LATENT, SCALE: SCALE, TRAIN_STEPS: TRAIN_STEPS, MAXLEN: MAXLEN, MODELS: MODELS, TAESD: TAESD, LICENSE: LICENSE, FALLBACK: FALLBACK, byId: byId, urlOf: urlOf, totalBytes: totalBytes, fmtBytes: fmtBytes, pickModel: pickModel, alphasCumprod: alphasCumprod, timesteps: timesteps, rng: rng, gaussian: gaussian, latentFromEncoder: latentFromEncoder, toChw: toChw, addNoise: addNoise, predictX0: predictX0, step: step, fitBox: fitBox, feather: feather, blend: blend, plan: plan, padIds: padIds, explainError: explainError };
});
