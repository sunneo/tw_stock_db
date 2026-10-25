/* MOSS-TTS-Nano 的推論核心（UMD，純函式，不碰 DOM、網路、onnxruntime；桌面版與網頁版共用，也嵌進 worker）。
 *
 * MOSS-TTS-Nano（OpenMOSS，Apache-2.0）是 0.1B 的多語言零樣本語音合成：給一段參考音檔（不需要逐字稿）與要念的文字，就用那個聲音念，支援中文與英文。
 * 模型是五個 ONNX 圖（prefill、decode_step、local_fixed_sampled_frame…）加一個 SentencePiece 切詞器，外加 MOSS-Audio-Tokenizer-Nano 的編碼器／解碼器（波形 ↔ 16 通道聲碼）。
 * 這個檔案是照模型儲存庫（Apache-2.0）附的說明檔（tts_browser_onnx_meta.json、browser_poc_manifest.json）自己寫的推論流程，沒有複製官方瀏覽器專案的程式碼。
 * 流程：
 *   1. 文字 → 切詞（BPE，位元組後備；中文要先轉簡體，模型沒看過繁體字）
 *   2. 提示：每一列 17 個整數＝[文字通道, 16 個聲碼通道]。排法：<|im_start|>、user 前綴、<|audio_start|>、參考音檔的聲碼列（文字通道填 audio_user_slot）、<|audio_end|>、
 *      後綴（到 "Text:" 為止）、目標文字、assistant 前綴、<|audio_start|>。
 *   3. prefill 一次吃整個提示，之後每一幀：local_fixed_sampled_frame 取樣出 16 個聲碼（附 should_continue），再把 [audio_assistant_slot, 16 聲碼] 當一列丟進 decode_step。
 *   4. 全部聲碼丟給解碼器得到 48kHz 立體聲。
 * 推論本身（onnxruntime）由呼叫端提供 runners，這裡只有流程與資料處理，所以可以用假的 runners 測試。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMossTts = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var NQ = 16, ROW = 17, CODEBOOK = 1024, HIDDEN = 768, LAYERS = 12, OUT_RATE = 48000, FRAME_RATE = 12.5;

  // ───────────────────────── SentencePiece（BPE）─────────────────────────
  // 只做這個模型需要的部分：讀 .model 的 pieces（字串、分數、類型），NFKC 正規化，BPE 合併，位元組後備。
  function readVarint(b, st) { var r = 0, sh = 0, x; do { x = b[st.p++]; r += (x & 0x7f) * Math.pow(2, sh); sh += 7; } while (x & 0x80); return r; }
  function parseModel(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), st = { p: 0 }, pieces = [], dec = new TextDecoder('utf-8');
    while (st.p < b.length) {
      var tag = readVarint(b, st), field = tag >> 3, wire = tag & 7;
      if (wire === 2) {
        var len = readVarint(b, st), end = st.p + len;
        if (field === 1) { // SentencePiece 子訊息
          var piece = '', score = 0, type = 1; var sub = { p: st.p };
          while (sub.p < end) { var t2 = readVarint(b, sub), f2 = t2 >> 3, w2 = t2 & 7; if (w2 === 2) { var l2 = readVarint(b, sub); if (f2 === 1) piece = dec.decode(b.subarray(sub.p, sub.p + l2)); sub.p += l2; } else if (w2 === 5) { if (f2 === 2) score = new DataView(b.buffer, b.byteOffset + sub.p, 4).getFloat32(0, true); sub.p += 4; } else if (w2 === 0) { var v = readVarint(b, sub); if (f2 === 3) type = v; } else if (w2 === 1) sub.p += 8; else throw new Error('切詞模型格式不認得'); }
          pieces.push({ piece: piece, score: score, type: type });
        }
        st.p = end;
      } else if (wire === 0) readVarint(b, st); else if (wire === 5) st.p += 4; else if (wire === 1) st.p += 8; else throw new Error('切詞模型格式不認得');
    }
    var map = new Map(), byteId = new Array(256).fill(-1), unk = 0;
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i]; if (p.type === 2) unk = i;
      if (p.type === 6) { var m = /^<0x([0-9A-Fa-f]{2})>$/.exec(p.piece); if (m) byteId[parseInt(m[1], 16)] = i; }
      else if (p.type === 1 || p.type === 4) map.set(p.piece, i);
    }
    return { pieces: pieces, map: map, byteId: byteId, unk: unk };
  }
  // nmt_nfkc 的近似：NFKC，控制字元拿掉、各種空白變一般空白、連續空白合併、頭尾空白拿掉
  // 正規化：NFKC 之後，照 python sentencepiece 逐字元量出來的對照表處理（不是猜的）：
  //   刪除：0001-0008、000b、000e-001f、007f、008f、009f；
  //   當空白：0009-000a、000c-000d、00a0、1680、2000-200c、200e-200f、2028-2029、202f、205f、2581（▁）、3000、feff、fffd；
  //   其他字元照舊。連續空白合併、頭尾空白拿掉。
  function normalize(text) {
    var s = String(text == null ? '' : text); try { s = s.normalize('NFKC'); } catch (_) { /* */ }
    var LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);  // 這兩個字元不能寫在正規式字面值裡（會被當成換行）
    s = s.replace(new RegExp('[\u0001-\u0008\u000b\u000e-\u001f\u007f\u008f\u009f]', 'g'), '');
    s = s.replace(new RegExp('[\t\n\f\r\u00a0\u1680\u2000-\u200c\u200e\u200f' + LS + PS + '\u202f\u205f\u2581\u3000\ufeff\ufffd]', 'g'), ' ');
    return s.replace(/ +/g, ' ').replace(/^ | $/g, '');
  }
  function utf8(ch) { return typeof Buffer !== 'undefined' ? Array.prototype.slice.call(Buffer.from(ch, 'utf8')) : Array.prototype.slice.call(new TextEncoder().encode(ch)); }
  function bpeWord(model, word, out) {
    var syms = Array.from(word).map(function (c) { return { s: c, alive: true }; });
    for (;;) { // 每輪找「相鄰兩個合起來還在字彙裡」之中分數最高的（同分取最左邊）
      var best = -1, bestScore = -Infinity, prev = -1;
      for (var i = 0; i < syms.length; i++) { if (!syms[i].alive) continue; if (prev >= 0) { var id = model.map.get(syms[prev].s + syms[i].s); if (id !== undefined) { var sc = model.pieces[id].score; if (sc > bestScore) { bestScore = sc; best = prev; } } } prev = i; }
      if (best < 0) break;
      var j = best + 1; while (!syms[j].alive) j++; syms[best].s += syms[j].s; syms[j].alive = false;
    }
    syms.forEach(function (x) {
      if (!x.alive) return; var id = model.map.get(x.s); if (id !== undefined) { out.push(id); return; }
      var bytes = utf8(x.s), ok = bytes.every(function (v) { return model.byteId[v] >= 0; });
      if (ok) bytes.forEach(function (v) { out.push(model.byteId[v]); }); else out.push(model.unk);
    });
  }
  function encode(model, text) {
    var norm = normalize(text); if (!norm) return [];
    var s = '▁' + norm.replace(/ /g, '▁'), words = s.split(/(?=▁)/), out = [];
    for (var i = 0; i < words.length; i++) if (words[i]) bpeWord(model, words[i], out);
    return out;
  }

  // ───────────────────────── 提示 ─────────────────────────
  // cfg：manifest.tts_config；tpl：manifest.prompt_templates；promptCodes：參考音檔的聲碼 [[16]…]（沒有就不放參考，用模型預設的聲音）；textIds：目標文字的切詞結果
  function buildPrompt(cfg, tpl, promptCodes, textIds) {
    var pad = cfg.audio_pad_token_id, rows = [];
    var t = function (id) { var r = new Array(ROW).fill(pad); r[0] = id; rows.push(r); };
    t(cfg.im_start_token_id); tpl.user_prompt_prefix_token_ids.forEach(t);
    if (promptCodes && promptCodes.length) {
      t(cfg.audio_start_token_id);
      promptCodes.forEach(function (c) { rows.push([cfg.audio_user_slot_token_id].concat(Array.prototype.slice.call(c, 0, NQ))); });
      t(cfg.audio_end_token_id);
    }
    tpl.user_prompt_after_reference_token_ids.forEach(t); textIds.forEach(t); tpl.assistant_prompt_prefix_token_ids.forEach(t); t(cfg.audio_start_token_id);
    var flat = new Int32Array(rows.length * ROW); for (var i = 0; i < rows.length; i++) for (var k = 0; k < ROW; k++) flat[i * ROW + k] = rows[i][k];
    return { ids: flat, rows: rows.length };
  }

  // ───────────────────────── 生成迴圈 ─────────────────────────
  // 可重現的亂數（同一個 seed 同一串）
  function rng(seed) { var a = (Number(seed) >>> 0) || 1; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  // runners：{ prefill(ids Int32Array, rows) → Promise<{hidden: Float32Array(768), past}>, decode(row Int32Array(17), pastLength, past) → Promise<{hidden, past}>,
  //            sample(hidden, seen Int32Array(16*1024), u1 Float32Array(1), u2 Float32Array(16)) → Promise<{cont:boolean, frame: Int32Array(16)}> }
  // opts：{ maxFrames=375, seed, onFrame(n), isCancelled() }。回 { frames: Int32Array[T*16], count, stopped:'end'|'max'|'cancel' }
  async function generate(runners, cfg, prompt, opts) {
    opts = opts || {}; var maxFrames = opts.maxFrames || 375, rnd = opts.seed === undefined || opts.seed === null ? Math.random : rng(opts.seed);
    var pre = await runners.prefill(prompt.ids, prompt.rows), hidden = pre.hidden, past = pre.past, length = prompt.rows;
    var seen = new Int32Array(NQ * CODEBOOK), frames = [], stopped = 'max';
    for (var step = 0; step < maxFrames; step++) {
      if (opts.isCancelled && opts.isCancelled()) { stopped = 'cancel'; break; }
      var u2 = new Float32Array(NQ); for (var q = 0; q < NQ; q++) u2[q] = rnd();
      var s = await runners.sample(hidden, seen, new Float32Array([rnd()]), u2);
      if (!s.cont) { stopped = 'end'; break; }
      var f = Int32Array.from(s.frame); frames.push(f); for (var k = 0; k < NQ; k++) seen[k * CODEBOOK + f[k]] = 1;
      if (opts.onFrame) opts.onFrame(frames.length);
      if (step === maxFrames - 1) break;
      var row = new Int32Array(ROW); row[0] = cfg.audio_assistant_slot_token_id; row.set(f, 1);
      var d = await runners.decode(row, length, past); hidden = d.hidden; past = d.past; length++;
    }
    var flat = new Int32Array(frames.length * NQ); for (var i = 0; i < frames.length; i++) flat.set(frames[i], i * NQ);
    return { frames: flat, count: frames.length, stopped: stopped };
  }

  // ───────────────────────── 文字切段 ─────────────────────────
  // 一次最多念約 30 秒（375 幀），長文字依句子切成幾段：中文一段約 70 字以內，英文一段約 220 字元以內；盡量在句尾標點斷開
  function splitText(text, maxLatin, maxCjk) {
    var t = String(text || '').replace(/\r\n/g, '\n').trim(); if (!t) return [];
    var sents = t.split(/(?<=[。！？!?；;…\n]|[.]\s)/).map(function (x) { return x.trim(); }).filter(Boolean), out = [], cur = '';
    var limit = function (s) { var cjk = (s.match(/[㐀-鿿぀-ヿ가-힯]/g) || []).length; return cjk > s.length * 0.3 ? (maxCjk || 70) : (maxLatin || 220); };
    sents.forEach(function (s) {
      while (s.length > limit(s)) { var cut = limit(s), k = s.lastIndexOf(' ', cut); if (k < cut * 0.5) k = s.search(/[，,、]/) > 0 ? s.slice(0, cut).search(/[，,、][^，,、]*$/) : -1; if (k < cut * 0.4) k = cut; if (cur) { out.push(cur); cur = ''; } out.push(s.slice(0, k + (s[k] === ' ' ? 0 : 1)).trim()); s = s.slice(k + (s[k] === ' ' ? 1 : 1)).trim(); if (!s) break; }
      if (!s) return; if (cur && (cur + s).length + 1 > limit(cur + s)) { out.push(cur); cur = s; } else cur = cur ? cur + (/[　-〿＀-￯㐀-鿿]$/.test(cur) ? '' : ' ') + s : s;
    });
    if (cur) out.push(cur); return out.filter(Boolean);
  }

  // ───────────────────────── 波形處理 ─────────────────────────
  // 加窗 sinc（Lanczos，a=8）重採樣：參考音檔 24kHz → 48kHz 與輸出 48kHz → 24kHz 都用這個，比線性內插乾淨（編碼器對高頻很敏感）
  function resample(a, from, to) {
    if (from === to) return a; var ratio = to / from, n = Math.max(1, Math.round(a.length * ratio)), out = new Float32Array(n), A = 8, scale = Math.min(1, ratio), len = a.length;
    for (var i = 0; i < n; i++) {
      var c = i / ratio, i0 = Math.floor(c), s = 0, ws = 0;
      for (var k = i0 - Math.ceil(A / scale) + 1; k <= i0 + Math.ceil(A / scale); k++) { var x = (c - k) * scale; if (x <= -A || x >= A) continue; var w = x === 0 ? 1 : (Math.sin(Math.PI * x) / (Math.PI * x)) * (Math.sin(Math.PI * x / A) / (Math.PI * x / A)); var v = k < 0 ? a[0] : k >= len ? a[len - 1] : a[k]; s += v * w; ws += w; }
      out[i] = ws ? s / ws : 0;
    }
    return out;
  }
  // 參考音檔 → 編碼器要的 [1,2,L]（48kHz 立體聲，單聲道複製成兩個聲道）
  function toCodecInput(mono, rate) { var m = resample(mono, rate, OUT_RATE), w = new Float32Array(2 * m.length); w.set(m, 0); w.set(m, m.length); return { data: w, length: m.length }; }
  // 解碼器輸出 [2,L] 48kHz → 單聲道，再轉成要的取樣率
  function fromCodecOutput(stereo, L, toRate) { var m = new Float32Array(L); for (var i = 0; i < L; i++) m[i] = (stereo[i] + stereo[L + i]) / 2; return toRate && toRate !== OUT_RATE ? resample(m, OUT_RATE, toRate) : m; }
  // 參考聲碼的長度上限：每幀 80 毫秒，提示越長越慢；超過 20 秒的樣本只取前面 20 秒（250 幀）
  function trimPromptCodes(codes, maxFrames) { var max = maxFrames || 250; return codes.length > max ? codes.slice(0, max) : codes; }

  return { NQ: NQ, ROW: ROW, CODEBOOK: CODEBOOK, HIDDEN: HIDDEN, LAYERS: LAYERS, OUT_RATE: OUT_RATE, FRAME_RATE: FRAME_RATE,
    parseModel: parseModel, normalize: normalize, encode: encode, buildPrompt: buildPrompt, rng: rng, generate: generate, splitText: splitText,
    resample: resample, toCodecInput: toCodecInput, fromCodecOutput: fromCodecOutput, trimPromptCodes: trimPromptCodes };
}));
