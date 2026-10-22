/* 本機小模型生圖（UMD，純函式）：在使用者自己的電腦上用小型 Stable Diffusion 一步生圖，不連線上服務。
 * 模型：SDXS-512-DreamShaper（從 DreamShaper 8 蒸餾，一步取樣、不需要 guidance，512×512，OpenRAIL++-M 授權）。兩個版本，依這台機器選：
 *   - GPU 版（fp16，約 880 MB）：onnxruntime-web 的 WebGPU，需要顯示卡支援 shader-f16；
 *   - CPU 版（int8，約 1.1 GB）：onnxruntime-web 的 wasm（CPU），MatMul 權重 int8、Conv 保持 fp32——沒有 WebGPU／沒有 f16 的電腦用這個。
 * 取樣（兩版相同，一步）：sigma = 14.6146…；x = randn(1,4,64,64)×sigma；eps = unet(x/√(sigma²+1), t=999, text_encoder(tokens))；x0 = x − sigma×eps；
 *   影像 = vae_decoder(x0)／2 + 0.5。
 * 這個檔案只有「不碰網路、不碰模型」的部分：模型清單與檔案大小、選哪個版本、取樣的數學、亂數、張量轉圖片、錯誤白話說明。下載、載入、執行在 floating-assistant 裡。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaLocalSd = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SIGMA_MAX = 14.614646911621094, TIMESTEP = 999, SIZE = 512, LATENT = 64, MAXLEN = 77, PAD_ID = 49407, BOS_ID = 49406;
  var HF = 'https://huggingface.co/';
  // 檔案位元組數與版本（commit）是釘住的：下載完核對大小，不一樣就不用
  var MODELS = [
    { id: 'sdxs-512-webgpu', device: 'webgpu', ep: 'webgpu', label: 'SDXS-512（GPU 版，fp16）', repo: 'skillsafeai/sdxs-512-dreamshaper-onnx-webgpu', rev: 'b23bf8f4f809a0beb6d095bf52b5854e0b66caef', needsF16: true,
      files: [{ name: 'text_encoder.onnx', role: 'text', bytes: 246275486 }, { name: 'unet.onnx', role: 'unet', bytes: 631766742 }, { name: 'vae_decoder.onnx', role: 'vae', bytes: 2467568 }] },
    { id: 'sdxs-512-cpu-int8', device: 'cpu', ep: 'wasm', label: 'SDXS-512（CPU 版，int8）', repo: 'lequangky/tipsy-sdxs-512-int8', rev: '41203dc02882252d74bb683dedc9bfde08641b55', needsF16: false,
      files: [{ name: 'text_encoder.onnx', role: 'text', bytes: 237811651 }, { name: 'unet.onnx', role: 'unet', bytes: 873388448 }, { name: 'vae_decoder.onnx', role: 'vae', bytes: 4912820 }] }
  ];
  var TOKENIZER = { repo: 'Xenova/clip-vit-base-patch32', note: 'CLIP 分詞器（跟 Stable Diffusion 1.x 的文字編碼器同一套詞表）' };
  var LICENSE = { name: 'CreativeML Open RAIL++-M', url: 'https://huggingface.co/spaces/CompVis/stable-diffusion-license',
    note: '這個模型的授權（CreativeML Open RAIL++-M）有使用限制：不得用來產生傷害未成年人的內容、未經同意的真人影像、誹謗、騷擾或任何違法用途；這些限制也適用於你用它畫出來的圖。' };

  function byId(id) { for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === id) return MODELS[i]; return null; }
  function urlOf(model, file) { return HF + model.repo + '/resolve/' + model.rev + '/' + file; }
  function totalBytes(model) { return model.files.reduce(function (a, f) { return a + f.bytes; }, 0); }
  function fmtBytes(n) { n = Number(n) || 0; return n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : Math.round(n / 1e6) + ' MB'; }

  // 這台機器該用哪個版本。env: { hasGpu, f16 }（WebGPU 轉接器有沒有、支不支援 shader-f16）；pref: auto｜webgpu｜cpu
  function pickModel(env, pref) {
    env = env || {}; pref = pref === 'webgpu' || pref === 'cpu' ? pref : 'auto'; var notes = [], m;
    if (pref === 'cpu') { m = byId('sdxs-512-cpu-int8'); notes.push('設定指定用 CPU 版。'); }
    else if (pref === 'webgpu') {
      if (!env.hasGpu) return { ok: false, reason: '設定指定用 GPU 版，但這個環境沒有 WebGPU（瀏覽器或顯示卡不支援）。改成「自動」或「CPU」就能用 CPU 版。' };
      m = byId('sdxs-512-webgpu'); if (!env.f16) notes.push('這張顯示卡不支援 f16（shader-f16），GPU 版可能載入失敗；失敗時改用 CPU 版。');
    } else if (env.hasGpu && env.f16) m = byId('sdxs-512-webgpu');
    else { m = byId('sdxs-512-cpu-int8'); notes.push(env.hasGpu ? '顯示卡不支援 f16，改用 CPU 版。' : '沒有 WebGPU，改用 CPU 版。'); }
    if (m.device === 'cpu') notes.push('CPU 版比較慢（用 CPU 一步一步算，單執行緒時可能要好幾分鐘）；第一次要下載約 ' + fmtBytes(totalBytes(m)) + '。');
    return { ok: true, model: m, ep: m.ep, notes: notes };
  }

  // 請求整理：圖片大小、步數是這個模型固定的（512×512、一步），不照使用者給的；seed 沒給就隨機
  function plan(a) {
    a = a || {}; var prompt = String(a.prompt == null ? '' : a.prompt).trim(); if (!prompt) return { ok: false, error: '要畫什麼？請給 prompt（英文效果較好）。' };
    var notes = []; var w = Number(a.width), h = Number(a.height); if ((w && w !== SIZE) || (h && h !== SIZE)) notes.push('本機小模型固定畫 ' + SIZE + '×' + SIZE + '，沒有照你給的尺寸。');
    if (a.steps && Number(a.steps) !== 1) notes.push('本機小模型是一步取樣，沒有照你給的步數。');
    if (a.negative || a.negative_prompt) notes.push('這個模型不用 guidance，負面提示沒有作用。');
    var seed = a.seed != null && a.seed !== '' && isFinite(Number(a.seed)) ? (Math.floor(Number(a.seed)) >>> 0) : (Math.floor(Math.random() * 4294967296) >>> 0);
    return { ok: true, prompt: prompt.slice(0, 600), seed: seed, size: SIZE, steps: 1, notes: notes };
  }

  // 可重現的亂數（seed 一樣、圖就一樣）
  function rng(seed) { var s = (seed >>> 0) || 1; return function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function gaussian(seed, n) { var r = rng(seed), out = new Float32Array(n); for (var i = 0; i < n; i += 2) { var u = Math.max(r(), 1e-12), v = r(), m = Math.sqrt(-2 * Math.log(u)); out[i] = m * Math.cos(2 * Math.PI * v); if (i + 1 < n) out[i + 1] = m * Math.sin(2 * Math.PI * v); } return out; }
  function initialLatent(seed) { var x = gaussian(seed, 4 * LATENT * LATENT); for (var i = 0; i < x.length; i++) x[i] *= SIGMA_MAX; return x; }
  function scaleInput(x, sigma) { sigma = sigma == null ? SIGMA_MAX : sigma; var k = 1 / Math.sqrt(sigma * sigma + 1), out = new Float32Array(x.length); for (var i = 0; i < x.length; i++) out[i] = x[i] * k; return out; }
  function denoise(x, eps, sigma) { sigma = sigma == null ? SIGMA_MAX : sigma; var out = new Float32Array(x.length); for (var i = 0; i < x.length; i++) out[i] = x[i] - sigma * eps[i]; return out; }

  // 分詞結果補成固定長度（77）：太長截掉但保留結尾符號，太短用 PAD 補
  function padIds(ids, len) { len = len || MAXLEN; var a = Array.prototype.slice.call(ids || []).map(Number); if (!a.length) a = [BOS_ID, PAD_ID]; if (a.length > len) { a = a.slice(0, len); a[len - 1] = PAD_ID; } while (a.length < len) a.push(PAD_ID); return a; }

  // 解碼器的輸出（CHW、範圍 [-1,1]）→ RGBA 位元組
  function toRgba(chw, w, h) {
    w = w || SIZE; h = h || SIZE; var plane = w * h, out = new Uint8ClampedArray(plane * 4);
    for (var i = 0; i < plane; i++) { for (var c = 0; c < 3; c++) { var v = (chw[c * plane + i] / 2 + 0.5) * 255; out[i * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v); } out[i * 4 + 3] = 255; }
    return out;
  }
  function imageStats(rgba) { var n = rgba.length / 4, sum = 0, mn = 255, mx = 0; for (var i = 0; i < n; i++) { var g = (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3; sum += g; if (g < mn) mn = g; if (g > mx) mx = g; } return { mean: sum / n, min: mn, max: mx, flat: (mx - mn) < 3 }; }

  // 執行失敗的白話說明（不是丟一串 ORT 的錯誤碼）
  function explainError(err, model, env) {
    var msg = String((err && err.message) || err || ''); model = model || {}; env = env || {};
    if (/float16|fp16|f16|shader-f16/i.test(msg)) return 'GPU 版需要顯示卡支援 f16，這張不支援；到設定把裝置改成「CPU」就會用 CPU 版。（' + msg.slice(0, 100) + '）';
    if (/out of memory|oom|allocation|memory access|Array buffer allocation|RangeError/i.test(msg)) return '記憶體不夠（模型需要約 ' + fmtBytes(totalBytes(model)) + '，載入時還要再多一些）。關掉其他吃記憶體的程式，或改用比較小的版本再試。（' + msg.slice(0, 100) + '）';
    if (/webgpu|adapter|gpu device|createBuffer/i.test(msg)) return 'WebGPU 初始化失敗（' + msg.slice(0, 100) + '）。到設定把裝置改成「CPU」就會用 CPU 版。';
    if (/fetch|network|Failed to fetch|NetworkError|HTTP|download/i.test(msg)) return '下載模型失敗（' + msg.slice(0, 100) + '）。檢查網路能不能連到 huggingface.co 後再試，已下載的部分會保留。';
    return '本機生圖失敗：' + msg.slice(0, 200);
  }

  return { SIGMA_MAX: SIGMA_MAX, TIMESTEP: TIMESTEP, SIZE: SIZE, LATENT: LATENT, MAXLEN: MAXLEN, PAD_ID: PAD_ID, BOS_ID: BOS_ID, MODELS: MODELS, TOKENIZER: TOKENIZER, LICENSE: LICENSE, byId: byId, urlOf: urlOf, totalBytes: totalBytes, fmtBytes: fmtBytes, pickModel: pickModel, plan: plan, rng: rng, gaussian: gaussian, initialLatent: initialLatent, scaleInput: scaleInput, denoise: denoise, padIds: padIds, toRgba: toRgba, imageStats: imageStats, explainError: explainError };
});
