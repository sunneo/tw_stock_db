/* 聲音樣本（Kokoro 語音向量）的核心（UMD，純函式，不碰 DOM、網路、模型，桌面版與網頁版共用）。
 *
 * 「聲音樣本」＝一個 Kokoro 語音包（voices/<id>.bin）：510 × 1 × 256 個 float32（522,240 bytes）。模型每念一小段，依這段的 token 數
 * 從裡面取一列 256 維的「風格向量」。所以：
 *   - 建立：把現有的聲音依比例混合（加權平均），或用隨機種子挑幾個聲音、隨機配比（同一個種子永遠得到同一個聲音）；
 *   - 匯入：讀一個 .bin（大小必須剛好 522,240 bytes）或本程式匯出的 .voice.json（含向量與配方）；
 *   - 匯出：.bin（Kokoro 系的工具都能讀，例如 kokoro-js、Kokoro-FastAPI）與 .voice.json（含配方、可以再匯入）。
 * ChatTTS 的說話人向量是另一個空間（768 維），這裡的向量不能直接給 ChatTTS 用。
 *
 * 語音代號規則：英文以 a（美式）開頭、中文以 z 開頭，第二個字母 f／m 是性別，之後是底線與只含小寫英文字母的名字（Kokoro 的快取清單只認
 * [a-z]+_[a-z]+）。自訂聲音一律是「我的」＝名字以 my 開頭，例如 af_myvoice、zf_mylaoshi，跟內建聲音分得開。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaVoiceSample = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var DIM = 256, ROWS = 510, FLOATS = DIM * ROWS, BYTES = FLOATS * 4;
  var SAMPLE_RATE = 24000;
  var FORMAT = 'fa-voice-sample', BASE_MODEL = 'kokoro-82m-v1.0';

  // ---- 位元組 ↔ 向量（一律小端）
  function toBytes(vec) { var b = new Uint8Array(vec.length * 4), dv = new DataView(b.buffer); for (var i = 0; i < vec.length; i++) dv.setFloat32(i * 4, vec[i], true); return b; }
  function fromBytes(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8.length !== BYTES) return { ok: false, error: '這不是 Kokoro 語音包：大小應該剛好 ' + BYTES + ' bytes（510 列 × 256 維 × 4 bytes），這個檔案是 ' + u8.length + ' bytes' };
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), v = new Float32Array(FLOATS);
    for (var i = 0; i < FLOATS; i++) { var x = dv.getFloat32(i * 4, true); if (!isFinite(x) || Math.abs(x) > 1000) return { ok: false, error: '語音包裡有不合理的數值（第 ' + i + ' 個）：不是 Kokoro 語音向量' }; v[i] = x; }
    return { ok: true, vec: v };
  }
  function b64Encode(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    var s = ''; for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s);
  }
  function b64Decode(str) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(String(str), 'base64'));
    var s = atob(String(str)), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b;
  }

  // ---- 混合：items = [{ vec, weight }]；權重只取正的並正規化；spread＝離平均聲音多遠（1＝照配比，>1 往外推更有個性，<1 往中間收）
  function mix(items, spread) {
    var use = (items || []).filter(function (it) { return it && it.vec && it.vec.length === FLOATS && it.weight > 0; });
    if (!use.length) return { ok: false, error: '沒有可以混合的聲音（至少要有一個權重大於 0 的聲音）' };
    var total = 0; use.forEach(function (it) { total += it.weight; });
    var sp = spread === undefined || spread === null || spread === '' ? 1 : Number(spread); if (!isFinite(sp) || sp <= 0 || sp > 3) return { ok: false, error: 'spread 要在 0 到 3 之間（1＝照配比混合）' };
    var out = new Float32Array(FLOATS), avg = new Float32Array(FLOATS), n = use.length;
    for (var k = 0; k < n; k++) { var w = use[k].weight / total, v = use[k].vec; for (var i = 0; i < FLOATS; i++) { out[i] += v[i] * w; avg[i] += v[i] / n; } }
    if (sp !== 1) for (var j = 0; j < FLOATS; j++) out[j] = avg[j] + sp * (out[j] - avg[j]);
    return { ok: true, vec: out, parts: use.map(function (it) { return { id: it.id, weight: Math.round(it.weight / total * 1000) / 1000 }; }), spread: sp };
  }

  // ---- 可重現的亂數（同一個種子永遠同一串）
  function rng(seed) { var a = (Number(seed) >>> 0) || 1; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  // 用種子挑 count 個聲音、隨機配比：回 { seed, parts:[{id,weight}] }（weight 已正規化、至少 0.1，不會有「其實沒混進去」的聲音）
  function randomRecipe(seed, candidateIds, count) {
    var ids = (candidateIds || []).slice(), n = Math.max(1, Math.min(ids.length, count || 3)); if (!ids.length) return { ok: false, error: '沒有候選聲音可以挑' };
    var r = rng(seed); for (var i = ids.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
    var picks = ids.slice(0, n), raw = picks.map(function () { return 0.25 + r(); }), sum = raw.reduce(function (a, b) { return a + b; }, 0);
    return { ok: true, seed: Number(seed) >>> 0, parts: picks.map(function (id, k) { return { id: id, weight: Math.round(raw[k] / sum * 1000) / 1000 }; }) };
  }

  // ---- 語音代號
  function langOf(lang) { return /^(zh|cn|中文|國語|chinese|mandarin)/i.test(String(lang || '')) ? 'zh' : 'en'; }
  function genderOf(g) { return /^(m|male|男)/i.test(String(g || '')) ? 'm' : 'f'; }
  function lettersOnly(name) { return String(name || '').toLowerCase().replace(/[^a-z]/g, ''); }
  // 用名字做代號：中文名字（沒有英文字母）用 voice＋序號字母，保證唯一；existing 是目前已有的所有代號
  function makeId(lang, gender, name, existing) {
    var used = {}; (existing || []).forEach(function (x) { used[x] = true; });
    var head = (langOf(lang) === 'zh' ? 'z' : 'a') + genderOf(gender) + '_', base = 'my' + (lettersOnly(name).slice(0, 14) || 'voice'), id = head + base;
    for (var n = 0; used[id]; n++) id = head + base + String.fromCharCode(97 + (n % 26)) + (n >= 26 ? String.fromCharCode(97 + Math.floor(n / 26) % 26) : '');
    return id;
  }
  function isCustomId(id) { return /^[az][fm]_my[a-z]*$/.test(String(id || '')); }
  function idOk(id) { return /^[az][fm]_[a-z]+$/.test(String(id || '')); }

  // ---- 匯出入的 JSON 包（.voice.json）
  function makePackage(o) {
    return { format: FORMAT, version: 1, model: BASE_MODEL, name: String(o.name || '').slice(0, 60), lang: langOf(o.lang), gender: genderOf(o.gender), id: o.id || undefined,
      recipe: o.recipe || null, createdAt: o.createdAt || new Date().toISOString(), bytes: BYTES, vector_b64: b64Encode(toBytes(o.vec)),
      note: 'Kokoro-82M v1.0 的語音包（510×256 float32，小端）。vector_b64 解開就是 voices/<id>.bin；不是 ChatTTS 的說話人向量。' };
  }
  function readPackage(obj) {
    if (!obj || typeof obj !== 'object' || obj.format !== FORMAT) return { ok: false, error: '這不是聲音樣本檔（沒有 format: ' + FORMAT + '）' };
    if (obj.model && obj.model !== BASE_MODEL) return { ok: false, error: '這個聲音樣本是給 ' + obj.model + ' 的，這裡只支援 ' + BASE_MODEL };
    var raw; try { raw = b64Decode(obj.vector_b64); } catch (e) { return { ok: false, error: '聲音樣本檔的向量資料解不開' }; }
    var p = fromBytes(raw); if (!p.ok) return p;
    return { ok: true, vec: p.vec, name: String(obj.name || '').slice(0, 60), lang: langOf(obj.lang), gender: genderOf(obj.gender), recipe: obj.recipe || null, createdAt: obj.createdAt || null };
  }

  // ---- 試聽用的句子與 WAV 輸出
  function sampleText(lang) { return langOf(lang) === 'zh' ? '你好，這是我的新聲音。今天天氣很好，我們一起去散步吧。' : 'Hello, this is my new voice. The weather is lovely today, shall we go for a walk?'; }
  function wav(samples, sampleRate) {
    var sr = sampleRate || SAMPLE_RATE, n = samples.length, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    var w = function (o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) { var x = Math.max(-1, Math.min(1, samples[i])); dv.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7FFF, true); }
    return new Uint8Array(buf);
  }

  // ---- 斜線指令的參數：/voice-create 名字 lang=zh gender=f mix=zf_xiaoxiao:0.7,zf_xiaoyi:0.3 seed=42 spread=1.2 ／ /voice-create 名字 random lang=en
  function tokens(text) { var out = [], re = /"([^"]*)"|'([^']*)'|(\S+)/g, m; while ((m = re.exec(String(text || '')))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]); return out; }
  function parseCreateArgs(text) {
    var r = { name: '', lang: '', gender: '', mix: [], seed: null, spread: null, random: false, count: null, play: true, errors: [] }, rest = [];
    tokens(text).forEach(function (t) {
      var m = /^(\w+)=(.*)$/.exec(t);
      if (!m) { if (/^(random|隨機)$/i.test(t)) r.random = true; else rest.push(t); return; }
      var k = m[1].toLowerCase(), v = m[2];
      if (k === 'name' || k === '名字') r.name = v; else if (k === 'lang' || k === '語言') r.lang = langOf(v); else if (k === 'gender' || k === '性別') r.gender = genderOf(v);
      else if (k === 'seed' || k === '種子') { var s = Number(v); if (isFinite(s)) r.seed = s >>> 0; else r.errors.push('seed 要是數字'); }
      else if (k === 'spread' || k === '個性') { var sp = Number(v); if (isFinite(sp)) r.spread = sp; else r.errors.push('spread 要是數字'); }
      else if (k === 'count' || k === '數量') { var c = Math.round(Number(v)); if (c >= 1 && c <= 6) r.count = c; else r.errors.push('count 要是 1 到 6'); }
      else if (k === 'mix' || k === '混合') v.split(',').forEach(function (p) { var q = /^([a-z]+_[a-z]+)(?::([\d.]+))?$/.exec(p.trim()); if (!q) { if (p.trim()) r.errors.push('mix 的格式是 代號:比例，例如 af_heart:0.6,af_sky:0.4（看到「' + p.trim() + '」）'); return; } r.mix.push({ id: q[1], weight: q[2] === undefined ? 1 : Number(q[2]) }); });
      else if (k === 'play' || k === '試聽') r.play = !/^(0|false|no|否|不)$/i.test(v);
      else r.errors.push('不認得的參數「' + k + '」');
    });
    if (!r.name) r.name = rest.join(' ');
    return r;
  }

  return { DIM: DIM, ROWS: ROWS, FLOATS: FLOATS, BYTES: BYTES, SAMPLE_RATE: SAMPLE_RATE, FORMAT: FORMAT, BASE_MODEL: BASE_MODEL,
    toBytes: toBytes, fromBytes: fromBytes, b64Encode: b64Encode, b64Decode: b64Decode, mix: mix, rng: rng, randomRecipe: randomRecipe,
    langOf: langOf, genderOf: genderOf, makeId: makeId, isCustomId: isCustomId, idOk: idOk, makePackage: makePackage, readPackage: readPackage,
    sampleText: sampleText, wav: wav, parseCreateArgs: parseCreateArgs };
}));
