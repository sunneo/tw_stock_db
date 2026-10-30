/* 本機圖生圖改圖（UMD，純函式；檔名沿用 sd_turbo，實際用 SDXS＋TAESD，不用 sd-turbo——它的社群授權要商業登記，不內建也不下載）：使用者給一張圖＋一句話，在本機把圖改掉，不連線上服務。
 * 這個檔案只有「不碰網路、不碰模型」的部分：模型清單與檔案大小、選版本、圖生圖取樣的數學、遮罩混合、尺寸對齊、錯誤白話說明。下載、載入、執行在 floating-assistant 裡。
 * 取樣（變分形式，sd-turbo 與 SDXS 共用）：ᾱ(t) 由 scaled_linear 的 beta（0.00085→0.012，1000 步）累乘；
 *   z0 = vae_encoder(影像)×0.18215；x_t = √ᾱ·z0 + √(1−ᾱ)·雜訊；每步：eps = unet(x_t, t, 文字)；x0 = (x_t − √(1−ᾱ)·eps)/√ᾱ；下一步 x = √ᾱ'·x0 + √(1−ᾱ')·新雜訊（最後一步直接用 x0）。
 *   strength 決定從哪個時間點開始：steps×strength 取整，至少一步；strength=1 就是整張重畫。
 * 授權：只用 SDXS（OpenRAIL++-M）與 TAESD（MIT），不碰 sd-turbo 的社群授權。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaSdTurbo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SIZE = 512, LATENT = 64, SCALE = 0.18215, TRAIN_STEPS = 1000, MAXLEN = 77;
  var HF = 'https://huggingface.co/';
  // 位元組數與版本（commit）是釘住的：下載完核對大小，不一樣就不用。sd-turbo 的 ONNX 匯出是 fp16 大小（unet 1.7 GB）。
  var MODELS = [];   // 不內建 sd-turbo（授權）；執行用 FaLocalSd 的 SDXS 模型加下面的 TAESD
  // 小型 VAE（TAESD，MIT 授權，各約 5 MB）：給 SDXS／降級路徑當編碼器與解碼器，wasm 與 WebGPU 都能跑（onnxruntime-web 1.20 wasm 實測編碼→解碼來回可還原）。
  // 輸入影像範圍 [0,1]（不是 [-1,1]）；編碼輸出已是縮放後的潛在值（不用再乘 0.18215）；解碼輸出也是 [0,1]。
  var TAESD = { id: 'taesd', label: 'TAESD（小型 VAE）', repo: 'julienkay/taesd', rev: 'c8a437fd0201c21c3bcd298fcf3181b063bcc1eb', license: 'MIT', range: '01', scale: 1,
    files: [{ name: 'vae_encoder/model.onnx', role: 'vaeEnc', bytes: 4910437 }, { name: 'vae_decoder/model.onnx', role: 'vae', bytes: 4912312 }] };
  var LICENSE = { name: 'OpenRAIL++-M（SDXS）＋ MIT（TAESD）', url: 'https://huggingface.co/spaces/CompVis/stable-diffusion-license', note: '本機改圖用 SDXS（CreativeML Open RAIL++-M：不得用於傷害未成年人、未經同意的真人影像、誹謗騷擾或違法用途）與 TAESD（MIT）。' };
  var FALLBACK = { family: 'sdxs', note: '改圖用 SDXS＋TAESD（WebGPU 或 wasm）。' };

  function byId(id) { for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === id) return MODELS[i]; return null; }
  function urlOf(model, file) { return HF + model.repo + '/resolve/' + model.rev + '/' + file; }
  function totalBytes(model) { return model.files.reduce(function (a, f) { return a + f.bytes; }, 0); }
  function fmtBytes(n) { n = Number(n) || 0; return n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : Math.round(n / 1e6) + ' MB'; }

  // 這台機器該用哪個後端（模型一律 SDXS＋TAESD，SDXS 的版本由 FaLocalSd.pickModel 選）。env: { hasGpu, f16 }；pref: auto｜webgpu｜cpu
  function pickModel(env, pref) {
    env = env || {}; pref = pref === 'webgpu' || pref === 'cpu' ? pref : 'auto';
    if (pref === 'webgpu' && !env.hasGpu) return { ok: false, reason: '設定指定用 GPU 版，但這個環境沒有 WebGPU（瀏覽器或顯示卡不支援）。' };
    return { ok: true, fallback: 'sdxs', ep: (pref === 'cpu' || !env.hasGpu || !env.f16) && pref !== 'webgpu' ? 'wasm' : 'webgpu', notes: [] };
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

  // ───── 口語說的區域（「把左上角的…改成…」「把天空改成…」）─────
  // 「把 X 改成 Y」拆成要改的地方 X 與改成什麼 Y；沒有這個句型就整句當 Y
  function splitInstruction(text) {
    text = String(text || '').trim(); var m = text.match(/把(.{1,40}?)(?:改成|換成|變成|弄成|做成)(.+)$/);
    if (m) return { target: m[1].replace(/^(這張圖|這張照片|圖片|照片|圖裡|圖中)(裡|中|上)?(的)?/, '').trim(), result: m[2].trim() };
    return { target: '', result: text };
  }
  // 位置字眼 → 圖上的比例框 {x0,y0,x1,y1}（0..1）；沒有位置字眼就回 null（交給視覺模型用格子找）
  var POS = [[/左上/, [0, 0, 0.5, 0.5]], [/右上/, [0.5, 0, 1, 0.5]], [/左下/, [0, 0.5, 0.5, 1]], [/右下/, [0.5, 0.5, 1, 1]], [/正中|中間|中央|中心/, [0.25, 0.25, 0.75, 0.75]], [/上半|上面|上方|頂部|上邊/, [0, 0, 1, 0.5]], [/下半|下面|下方|底部|下邊/, [0, 0.5, 1, 1]], [/左半|左邊|左側|左方/, [0, 0, 0.5, 1]], [/右半|右邊|右側|右方/, [0.5, 0, 1, 1]]];
  function regionFromWords(target) { target = String(target || ''); for (var i = 0; i < POS.length; i++) if (POS[i][0].test(target)) { var b = POS[i][1]; return { x0: b[0], y0: b[1], x1: b[2], y1: b[3], by: 'words' }; } return null; }
  // 視覺模型的格子回答（4×4，A～P 由左到右、由上到下）→ 涵蓋這些格子的比例框；讀不出來就 null
  function gridLetters(cols, rows) { var out = [], n = (cols || 4) * (rows || 4); for (var i = 0; i < n; i++) out.push(String.fromCharCode(65 + i)); return out; }
  function regionFromCells(answer, cols, rows) {
    cols = cols || 4; rows = rows || 4; var ok = gridLetters(cols, rows), found = String(answer || '').toUpperCase().match(/\b[A-Z]\b/g) || [], idx = [];
    found.forEach(function (ch) { var k = ok.indexOf(ch); if (k >= 0 && idx.indexOf(k) < 0) idx.push(k); }); if (!idx.length || idx.length > cols * rows - 1) return null;
    var c0 = cols, c1 = -1, r0 = rows, r1 = -1; idx.forEach(function (k) { var c = k % cols, r = Math.floor(k / cols); c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r); });
    return { x0: c0 / cols, y0: r0 / rows, x1: (c1 + 1) / cols, y1: (r1 + 1) / rows, by: 'cells', cells: idx.length };
  }
  // 比例框 → 世界座標框（bounds = 圖的外框）
  function boxInBounds(f, bounds) { return { x: Math.round((bounds.x + f.x0 * bounds.w) * 100) / 100, y: Math.round((bounds.y + f.y0 * bounds.h) * 100) / 100, w: Math.round((f.x1 - f.x0) * bounds.w * 100) / 100, h: Math.round((f.y1 - f.y0) * bounds.h * 100) / 100 }; }

  function explainError(err, model, env) {
    var msg = String((err && err.message) || err || ''); model = model || {}; env = env || {};
    if (/float16|fp16|f16|shader-f16/i.test(msg)) return '改圖的 GPU 版需要顯示卡支援 f16，這張不支援。（' + msg.slice(0, 100) + '）';
    if (/out of memory|oom|allocation|memory access|Array buffer allocation|RangeError/i.test(msg)) return '記憶體不夠（sd-turbo 需要約 ' + fmtBytes(model.files ? totalBytes(model) : 1.2e9 + 5e8) + '，載入時還要再多一些）。關掉其他吃記憶體的程式再試。（' + msg.slice(0, 100) + '）';
    if (/webgpu|adapter|gpu device|createBuffer/i.test(msg)) return 'WebGPU 初始化失敗（' + msg.slice(0, 100) + '）。';
    if (/fetch|network|Failed to fetch|NetworkError|HTTP|download/i.test(msg)) return '下載模型失敗（' + msg.slice(0, 100) + '）。檢查網路能不能連到 huggingface.co 後再試，已下載的部分會保留。';
    if (/not supported|unsupported|Unsupported|operator|opset/i.test(msg)) return '這個模型用到的運算子，目前的執行環境不支援（' + msg.slice(0, 120) + '）。';
    return '本機改圖失敗：' + msg.slice(0, 200);
  }

  return { SIZE: SIZE, LATENT: LATENT, SCALE: SCALE, TRAIN_STEPS: TRAIN_STEPS, MAXLEN: MAXLEN, MODELS: MODELS, TAESD: TAESD, LICENSE: LICENSE, FALLBACK: FALLBACK, byId: byId, urlOf: urlOf, totalBytes: totalBytes, fmtBytes: fmtBytes, pickModel: pickModel, alphasCumprod: alphasCumprod, timesteps: timesteps, rng: rng, gaussian: gaussian, latentFromEncoder: latentFromEncoder, toChw: toChw, addNoise: addNoise, predictX0: predictX0, step: step, fitBox: fitBox, feather: feather, blend: blend, plan: plan, padIds: padIds, splitInstruction: splitInstruction, regionFromWords: regionFromWords, regionFromCells: regionFromCells, gridLetters: gridLetters, boxInBounds: boxInBounds, explainError: explainError };
});
