/* NVIDIA 線上圖像生成（ai.api.nvidia.com/v1/genai/…）的請求與回應整理（純函式，UMD）。
 * 各模型的參數範圍不同（steps、尺寸、有沒有 cfg_scale／negative_prompt），這裡用一張表描述，建請求時把使用者的值夾進合法範圍並記下調整了什麼，
 * 不會把不合法的值送出去才吃 422。回應格式也不只一種（artifacts[].base64、image、data[].b64_json…），解析時都認。
 * 沒在表裡的模型（使用者自己填的路徑，例如 black-forest-labs/flux.2-klein-4b 之後的新版本）照 FLUX 的格式送，回應照通用格式解析。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaNvidiaImage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var BASE = 'https://ai.api.nvidia.com/v1/genai/';

  // kind: flux（prompt、width、height、seed、steps，可選 cfg_scale／mode）｜sd3（prompt、aspect_ratio、cfg_scale、seed、steps、negative_prompt）
  var MODELS = [
    { id: 'black-forest-labs/flux.1-schnell', label: 'FLUX.1 schnell（最快，4 步）', kind: 'flux', steps: { min: 1, max: 4, def: 4 }, size: { min: 256, max: 2048, step: 64, def: 1024 } },
    { id: 'black-forest-labs/flux.2-klein-4b', label: 'FLUX.2 klein 4B（小、快，4 步）', kind: 'flux', steps: { min: 1, max: 8, def: 4 }, size: { min: 256, max: 2048, step: 64, def: 1024 } },
    { id: 'black-forest-labs/flux-3-image-klein', label: 'FLUX klein（較多步數，細緻）', kind: 'flux', steps: { min: 1, max: 100, def: 50 }, size: { min: 256, max: 2048, step: 64, def: 1024 } },
    { id: 'black-forest-labs/flux.1-dev', label: 'FLUX.1 dev（品質高，步數多）', kind: 'flux', steps: { min: 5, max: 100, def: 50 }, size: { min: 256, max: 2048, step: 64, def: 1024 }, cfg: { min: 1, max: 9, def: 3.5 }, extra: { mode: 'base' } },
    { id: 'stabilityai/stable-diffusion-3-medium', label: 'Stable Diffusion 3 Medium', kind: 'sd3', steps: { min: 5, max: 100, def: 50 }, cfg: { min: 1, max: 9, def: 5 }, ratios: ['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '9:16', '9:21'] },
  ];
  var DEFAULT_MODEL = MODELS[0].id;

  function info(id) { id = String(id || '').trim(); for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === id) return MODELS[i]; return null; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function snap(v, step, lo, hi) { return clamp(Math.round(v / step) * step, lo, hi); }
  function ratioOf(w, h) { var best = '1:1', bd = 1e9; (MODELS[4].ratios).forEach(function (r) { var p = r.split(':'), d = Math.abs(Math.log((w / h) / (p[0] / p[1]))); if (d < bd) { bd = d; best = r; } }); return best; }

  // 模型路徑只允許「廠商/模型名」這種寫法（用在網址裡，不能夾帶別的）
  function validModelPath(id) { return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(String(id || '').trim()); }

  // opts：{ model, prompt, width, height, seed, steps, cfg_scale, negative_prompt }
  // → { ok, url, body, notes:[被調整的項目], model } 或 { ok:false, error }
  function buildRequest(opts) {
    opts = opts || {};
    var id = String(opts.model || DEFAULT_MODEL).trim();
    if (!validModelPath(id)) return { ok: false, error: '模型路徑要是「廠商/模型名」，例如 black-forest-labs/flux.1-schnell：' + id.slice(0, 80) };
    var prompt = String(opts.prompt == null ? '' : opts.prompt).trim();
    if (!prompt) return { ok: false, error: '缺少 prompt（要畫什麼）' };
    if (prompt.length > 4000) return { ok: false, error: 'prompt 太長（' + prompt.length + ' 字，上限 4000）' };
    var m = info(id) || { id: id, kind: 'flux', steps: { min: 1, max: 100, def: 4 }, size: { min: 256, max: 2048, step: 64, def: 1024 }, custom: true };
    var notes = [], body = { prompt: prompt };
    var num = function (v) { var n = Number(v); return isFinite(n) ? n : null; };
    var seed = num(opts.seed); body.seed = seed != null && seed >= 0 ? Math.floor(seed) : 0;
    var steps = num(opts.steps), sdef = m.steps.def;
    if (steps == null) steps = sdef; var s2 = clamp(Math.round(steps), m.steps.min, m.steps.max); if (s2 !== steps && opts.steps != null) notes.push('steps ' + opts.steps + ' → ' + s2 + '（這個模型的範圍是 ' + m.steps.min + '–' + m.steps.max + '）'); body.steps = s2;
    if (m.kind === 'sd3') {
      var w0 = num(opts.width) || 1024, h0 = num(opts.height) || 1024; body.aspect_ratio = ratioOf(w0, h0);
      if (opts.width && opts.height && ratioOf(w0, h0) && body.aspect_ratio !== (w0 + ':' + h0)) notes.push('Stable Diffusion 3 只收固定比例，' + w0 + '×' + h0 + ' → ' + body.aspect_ratio);
      var c0 = num(opts.cfg_scale); body.cfg_scale = clamp(c0 == null ? m.cfg.def : c0, m.cfg.min, m.cfg.max);
      if (opts.negative_prompt) body.negative_prompt = String(opts.negative_prompt).slice(0, 1000);
    } else {
      var sz = m.size, w = num(opts.width) || sz.def, h = num(opts.height) || sz.def;
      var w2 = snap(w, sz.step, sz.min, sz.max), h2 = snap(h, sz.step, sz.min, sz.max);
      if (opts.width && w2 !== Number(opts.width)) notes.push('width ' + opts.width + ' → ' + w2 + '（要是 ' + sz.step + ' 的倍數，範圍 ' + sz.min + '–' + sz.max + '）');
      if (opts.height && h2 !== Number(opts.height)) notes.push('height ' + opts.height + ' → ' + h2 + '（要是 ' + sz.step + ' 的倍數，範圍 ' + sz.min + '–' + sz.max + '）');
      body.width = w2; body.height = h2;
      if (m.cfg) { var c1 = num(opts.cfg_scale); body.cfg_scale = clamp(c1 == null ? m.cfg.def : c1, m.cfg.min, m.cfg.max); }
      if (m.extra) Object.keys(m.extra).forEach(function (k) { body[k] = m.extra[k]; });
    }
    return { ok: true, url: BASE + id, body: body, notes: notes, model: m.id, kind: m.kind, known: !m.custom };
  }

  function sniffMime(b64) {
    var h = String(b64 || '').slice(0, 16);
    if (h.indexOf('/9j/') === 0) return 'image/jpeg';
    if (h.indexOf('iVBOR') === 0) return 'image/png';
    if (h.indexOf('UklGR') === 0) return 'image/webp';
    if (h.indexOf('R0lGOD') === 0) return 'image/gif';
    return 'image/png';
  }
  function stripDataUrl(s) { var m = /^data:([^;,]+)[^,]*,(.*)$/s.exec(String(s)); return m ? { mime: m[1], b64: m[2] } : { mime: null, b64: String(s) }; }

  // 回應 → { ok, images:[{ b64, mime, seed, finish }] } 或 { ok:false, error, filtered }
  function parseResponse(j) {
    if (!j || typeof j !== 'object') return { ok: false, error: '回應不是 JSON 物件' };
    var found = [], push = function (raw, extra) { if (typeof raw !== 'string' || raw.length < 100) return; var d = stripDataUrl(raw.replace(/\s+/g, '')); found.push({ b64: d.b64, mime: d.mime || sniffMime(d.b64), seed: extra && extra.seed != null ? extra.seed : null, finish: (extra && (extra.finishReason || extra.finish_reason)) || null }); };
    if (Array.isArray(j.artifacts)) j.artifacts.forEach(function (a) { push(a && (a.base64 || a.b64_json || a.image), a); });
    if (Array.isArray(j.data)) j.data.forEach(function (a) { push(a && (a.b64_json || a.base64 || a.image), a); });
    if (Array.isArray(j.images)) j.images.forEach(function (a) { push(typeof a === 'string' ? a : a && (a.base64 || a.b64_json || a.image), typeof a === 'object' ? a : null); });
    if (!found.length) push(j.image || j.base64 || j.b64_json, j);
    // 安全過濾：沒有圖，回報原因
    var reasons = [].concat(j.artifacts || [], [j]).map(function (a) { return a && (a.finishReason || a.finish_reason); }).filter(function (x) { return x && !/^(SUCCESS|success|stop)$/.test(x); });
    if (!found.length) return { ok: false, filtered: reasons.some(function (r) { return /FILTER|CONTENT|BLOCK|NSFW/i.test(r); }), error: reasons.length ? '沒有產生圖片（' + reasons[0] + '）' : '回應裡找不到圖片資料（欄位：' + Object.keys(j).slice(0, 8).join('、') + '）' };
    var bad = found.filter(function (f) { return f.finish && !/^(SUCCESS|success|stop)$/.test(f.finish); });
    if (bad.length === found.length) return { ok: false, filtered: /FILTER|CONTENT|BLOCK|NSFW/i.test(bad[0].finish), error: '沒有產生圖片（' + bad[0].finish + '）' };
    return { ok: true, images: found.filter(function (f) { return !f.finish || /^(SUCCESS|success|stop)$/.test(f.finish); }) };
  }

  // HTTP 錯誤 → 白話原因
  function explainHttpError(status, bodyText) {
    var t = String(bodyText || '').slice(0, 300);
    if (status === 401 || status === 403) return 'NVIDIA 拒絕這把金鑰（HTTP ' + status + '）：金鑰錯誤、過期，或沒有這個模型的使用權限。' + (t ? ' 回應：' + t : '');
    if (status === 404) return '找不到這個模型（HTTP 404）：路徑可能打錯，或這個模型不是用 /v1/genai/ 開放的。' + (t ? ' 回應：' + t : '');
    if (status === 422) return '參數不被接受（HTTP 422）：' + (t || '沒有說明');
    if (status === 429) return '請求太頻繁或額度用完（HTTP 429），稍後再試。';
    if (status >= 500) return 'NVIDIA 服務暫時有問題（HTTP ' + status + '），稍後再試。' + (t ? ' 回應：' + t : '');
    return 'HTTP ' + status + (t ? '：' + t : '');
  }

  return { BASE: BASE, MODELS: MODELS, DEFAULT_MODEL: DEFAULT_MODEL, info: info, validModelPath: validModelPath, buildRequest: buildRequest, parseResponse: parseResponse, sniffMime: sniffMime, explainHttpError: explainHttpError };
});
