/* 錄音聲音樣本的核心（UMD，純函式，不碰 DOM、麥克風、網路）。
 *
 * 「聲音樣本」＝一段自己的聲音錄音：24kHz 單聲道 16-bit WAV ＋ 你念的文字稿 ＋ 名字與語言（中文／英文）。
 * ChatTTS（sample_audio_speaker）、XTTS、F5-TTS 這類吃「參考音檔」的引擎，都是拿這種樣本取得說話人；所以匯出的就是這個 WAV 與一份說明 JSON。
 * 這裡負責：念稿、品質檢查（音量、爆音、靜音比例、長度、底噪）、修剪頭尾靜音、音量正規化、重採樣成 24kHz 單聲道、WAV 編碼、匯出包。
 * 錄音本身（麥克風、AudioContext）與存放（IndexedDB）在 floating-assistant.js 裡。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaVoiceRecording = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var TARGET_RATE = 24000, FORMAT = 'fa-voice-recording';
  var MIN_SEC = 5, GOOD_SEC = 10, MAX_SEC = 120;

  // ---- 念稿：涵蓋各種母音／子音、有疑問句與停頓，念起來自然。每種語言三段，合起來約 20 到 30 秒
  var SCRIPTS = {
    zh: ['今天天氣真好，我想趁著早晨出門散步，順便買一杯熱咖啡。', '你知道嗎？人的聲音就像指紋一樣，每個人都不一樣，所以我要用自己的聲音，慢慢地、清楚地念完這幾句話。', '最後，請記得，無論明天遇到什麼困難，都要深呼吸，然後一步一步往前走。'],
    en: ['The weather is lovely this morning, so I decided to take a walk and pick up a hot cup of coffee.', 'Did you know that every voice is as unique as a fingerprint? I will read these sentences slowly and clearly, in my own natural voice.', 'Finally, remember this: whatever tomorrow brings, take a deep breath, and keep moving forward, one step at a time.']
  };
  function langOf(l) { return /^(zh|cn|中文|國語|chinese|mandarin)/i.test(String(l || '')) ? 'zh' : 'en'; }
  function script(lang) { return SCRIPTS[langOf(lang)].slice(); }

  // ---- 取樣處理
  function peakOf(a) { var p = 0; for (var i = 0; i < a.length; i++) { var x = Math.abs(a[i]); if (x > p) p = x; } return p; }
  function rms(a, s, e) { s = s || 0; e = e === undefined ? a.length : e; var n = Math.max(1, e - s), t = 0; for (var i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / n); }
  function db(x) { return 20 * Math.log10(Math.max(x, 1e-9)); }
  // 每 20ms 一個視窗的音量（RMS），回 Float32Array
  function frames(a, sr) { var w = Math.max(1, Math.round(sr * 0.02)), n = Math.floor(a.length / w), out = new Float32Array(n); for (var k = 0; k < n; k++) out[k] = rms(a, k * w, (k + 1) * w); return out; }
  // 合併多聲道成單聲道
  function toMono(chans) { if (!chans || !chans.length) return new Float32Array(0); if (chans.length === 1) return chans[0]; var n = chans[0].length, out = new Float32Array(n); for (var c = 0; c < chans.length; c++) for (var i = 0; i < n; i++) out[i] += chans[c][i] / chans.length; return out; }
  // 線性內插重採樣（瀏覽器端有 OfflineAudioContext 時用它，品質較好；這個給測試與沒有它的環境）
  function resample(a, from, to) {
    if (from === to) return a; var n = Math.max(1, Math.round(a.length * to / from)), out = new Float32Array(n), r = from / to;
    for (var i = 0; i < n; i++) { var p = i * r, i0 = Math.floor(p), f = p - i0, x0 = a[Math.min(i0, a.length - 1)], x1 = a[Math.min(i0 + 1, a.length - 1)]; out[i] = x0 + (x1 - x0) * f; }
    return out;
  }
  // 修剪頭尾靜音：門檻跟著這段錄音的音量走（最大視窗音量的 4%，至少 0.003），頭尾各留 0.15 秒
  function trim(a, sr) {
    var f = frames(a, sr); if (!f.length) return a; var mx = 0; for (var i = 0; i < f.length; i++) if (f[i] > mx) mx = f[i];
    if (!(mx > 0)) return a; var th = Math.max(0.003, mx * 0.04), s = 0, e = f.length;
    while (s < e && f[s] < th) s++; while (e > s && f[e - 1] < th) e--;
    var pad = Math.round(sr * 0.15), w = Math.round(sr * 0.02);
    return a.subarray(Math.max(0, s * w - pad), Math.min(a.length, e * w + pad));
  }
  // 音量正規化到目標峰值（預設 0.89，約 -1 dBFS）；太小聲的錄音被放大時底噪也會變大，所以上限 12 倍
  function normalize(a, target) {
    var p = peakOf(a); if (!(p > 0)) return a; var g = Math.min(12, (target || 0.89) / p), out = new Float32Array(a.length); for (var i = 0; i < a.length; i++) out[i] = a[i] * g; return out;
  }

  // ---- 品質檢查：回 { ok, durationSec, peak, rmsDb, clippedPct, silencePct, noiseDb, snrDb, issues:[{level:'bad'|'warn', text}], advice }
  // 規則（單聲道、原始取樣率的樣本）：
  //  - 長度：少於 5 秒不合格，少於 10 秒提醒；超過 120 秒提醒（引擎只會用前面一小段）
  //  - 爆音：絕對值 ≥ 0.99 的樣本超過 0.5% → 太大聲、聲音爆掉
  //  - 太小聲：講話時（音量最大的 20% 視窗）平均低於 -35 dBFS
  //  - 靜音比例：低於 4% 最大音量的視窗超過 60% → 講太少話
  //  - 底噪：最安靜的 10% 視窗的平均音量；訊噪比（講話視窗／底噪）低於 20 dB 提醒、低於 12 dB 不合格
  function analyze(a, sr) {
    var dur = a.length / sr, peak = peakOf(a), f = frames(a, sr), issues = [];
    var clipped = 0; for (var i = 0; i < a.length; i++) if (Math.abs(a[i]) >= 0.99) clipped++;
    var clippedPct = a.length ? clipped / a.length * 100 : 0;
    var sorted = Array.prototype.slice.call(f).sort(function (x, y) { return x - y; }), nq = Math.max(1, Math.floor(sorted.length * 0.1)), tq = Math.max(1, Math.floor(sorted.length * 0.2));
    var noise = 0, talk = 0, k; for (k = 0; k < nq; k++) noise += sorted[k]; noise /= nq; for (k = sorted.length - tq; k < sorted.length; k++) talk += sorted[k]; talk /= tq;
    var mx = sorted.length ? sorted[sorted.length - 1] : 0, quiet = 0; for (k = 0; k < f.length; k++) if (f[k] < Math.max(0.003, mx * 0.04)) quiet++;
    var silencePct = f.length ? quiet / f.length * 100 : 100, talkDb = db(talk), noiseDb = db(noise), snr = talkDb - noiseDb;
    if (dur < MIN_SEC) issues.push({ level: 'bad', text: '太短了：只有 ' + dur.toFixed(1) + ' 秒，至少要 ' + MIN_SEC + ' 秒（建議 ' + GOOD_SEC + ' 秒以上）' });
    else if (dur < GOOD_SEC) issues.push({ level: 'warn', text: '偏短（' + dur.toFixed(1) + ' 秒）：建議 ' + GOOD_SEC + ' 秒以上，聲音特徵比較完整' });
    if (dur > MAX_SEC) issues.push({ level: 'warn', text: '很長（' + Math.round(dur) + ' 秒）：多數引擎只會用前面一小段，剪到 ' + MAX_SEC + ' 秒內就夠了' });
    if (clippedPct > 0.5) issues.push({ level: 'bad', text: '聲音爆掉了（' + clippedPct.toFixed(1) + '% 的取樣到頂）：離麥克風遠一點、或把輸入音量調小再錄' });
    if (peak > 0 && talkDb < -35) issues.push({ level: 'warn', text: '講話音量偏小（約 ' + talkDb.toFixed(0) + ' dBFS）：靠近麥克風或調大輸入音量；匯出時會自動放大，但底噪也會跟著變大' });
    if (silencePct > 60) issues.push({ level: 'bad', text: '幾乎都是靜音（' + silencePct.toFixed(0) + '%）：確認有選對麥克風、而且有在念稿' });
    if (snr < 12) issues.push({ level: 'bad', text: '背景噪音太大（訊噪比只有 ' + snr.toFixed(0) + ' dB）：換個安靜的地方、關掉風扇或冷氣再錄' });
    else if (snr < 20) issues.push({ level: 'warn', text: '背景有點吵（訊噪比 ' + snr.toFixed(0) + ' dB）：能再安靜一點會更好' });
    var bad = issues.some(function (x) { return x.level === 'bad'; });
    return { ok: !bad, durationSec: Math.round(dur * 10) / 10, peak: Math.round(peak * 1000) / 1000, talkDb: Math.round(talkDb), noiseDb: Math.round(noiseDb), snrDb: Math.round(snr), clippedPct: Math.round(clippedPct * 100) / 100, silencePct: Math.round(silencePct), issues: issues,
      advice: bad ? '這段錄音有問題，建議重錄。' : (issues.length ? '可以用，但上面的提醒處理掉會更好。' : '品質很好。') };
  }

  // 錄音處理總流程：單聲道樣本 → 修剪 → 重採樣 24kHz → 正規化 → 回 { samples, rate, report }（品質檢查看「處理前（只修剪）」的樣本，才抓得到爆音與底噪）
  function prepare(mono, sr) {
    var trimmed = trim(mono, sr), report = analyze(trimmed, sr), out = normalize(resample(trimmed, sr, TARGET_RATE));
    return { samples: out, rate: TARGET_RATE, report: report };
  }

  // ---- WAV（16-bit PCM 單聲道）編碼與解碼（解碼只認自己編的這種與常見的 PCM16/float32 WAV）
  function wav(samples, rate) {
    var sr = rate || TARGET_RATE, n = samples.length, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    var w = function (o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) { var x = Math.max(-1, Math.min(1, samples[i])); dv.setInt16(44 + i * 2, Math.round(x < 0 ? x * 0x8000 : x * 0x7FFF), true); }
    return new Uint8Array(buf);
  }
  function parseWav(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var tag = function (o) { return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]); };
    if (u8.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return { ok: false, error: '這不是 WAV 檔' };
    var pos = 12, fmt = null, data = null;
    while (pos + 8 <= u8.length) { var id = tag(pos), len = dv.getUint32(pos + 4, true); if (id === 'fmt ') fmt = { code: dv.getUint16(pos + 8, true), ch: dv.getUint16(pos + 10, true), rate: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) }; else if (id === 'data') { data = { off: pos + 8, len: Math.min(len, u8.length - pos - 8) }; break; } pos += 8 + len + (len & 1); }
    if (!fmt || !data) return { ok: false, error: 'WAV 檔缺少 fmt 或 data 區塊' };
    var bytesPer = fmt.bits / 8, n = Math.floor(data.len / (bytesPer * fmt.ch)), chans = []; if (!(fmt.ch >= 1 && fmt.ch <= 8)) return { ok: false, error: '不支援的聲道數：' + fmt.ch };
    if (!((fmt.code === 1 && (fmt.bits === 16 || fmt.bits === 8)) || (fmt.code === 3 && fmt.bits === 32))) return { ok: false, error: '不支援的 WAV 格式（編碼 ' + fmt.code + '、' + fmt.bits + ' 位元）；請用 16 位元 PCM 的 WAV，或直接匯入 mp3／m4a' };
    for (var c = 0; c < fmt.ch; c++) chans.push(new Float32Array(n));
    for (var i = 0; i < n; i++) for (var c2 = 0; c2 < fmt.ch; c2++) { var o = data.off + (i * fmt.ch + c2) * bytesPer; chans[c2][i] = fmt.code === 3 ? dv.getFloat32(o, true) : fmt.bits === 16 ? dv.getInt16(o, true) / 32768 : (u8[o] - 128) / 128; }
    return { ok: true, rate: fmt.rate, channels: chans };
  }

  // ---- 匯出包的說明 JSON（跟 WAV 一起給別人）
  function meta(o) {
    return { format: FORMAT, version: 1, name: String(o.name || '').slice(0, 60), lang: langOf(o.lang), transcript: String(o.transcript || ''), sampleRate: TARGET_RATE, channels: 1, bits: 16, durationSec: o.durationSec || 0,
      createdAt: o.createdAt || new Date().toISOString(), file: o.file || undefined,
      usage: {
        ChatTTS: 'speaker = chat.sample_audio_speaker(wav_24k_mono)  # 或 torchaudio.load 後取單聲道 24kHz；再放進 InferCodeParams(spk_smp=speaker, txt_smp=transcript)',
        XTTS: 'tts.tts_to_file(text=..., speaker_wav="<這個 WAV>", language="zh-cn" 或 "en")',
        'F5-TTS': 'ref_audio=<這個 WAV>, ref_text=<transcript>',
        note: '這是一段「參考音檔」：音檔本身就是樣本，不是某個引擎專用的向量。transcript 是錄音時念的文字，ChatTTS 的 txt_smp 與 F5-TTS 的 ref_text 要用。'
      } };
  }
  function safeFilename(name) { return (String(name || 'voice').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)) || 'voice'; }

  return { TARGET_RATE: TARGET_RATE, FORMAT: FORMAT, MIN_SEC: MIN_SEC, GOOD_SEC: GOOD_SEC, MAX_SEC: MAX_SEC, SCRIPTS: SCRIPTS, langOf: langOf, script: script,
    peakOf: peakOf, rms: rms, frames: frames, toMono: toMono, resample: resample, trim: trim, normalize: normalize, analyze: analyze, prepare: prepare,
    wav: wav, parseWav: parseWav, meta: meta, safeFilename: safeFilename };
}));
