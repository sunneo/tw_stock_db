/* 全語音 Live 的收音迴圈（UMD，純邏輯；不碰麥克風、不碰模型）。
 * 負責：把連續的音訊區塊切成「一句話」（簡單能量門檻的語音活動偵測 VAD）、
 * 重採樣到 16kHz、依序交給辨識函式、把辨識出的文字交給 onText。
 * 測試：scripts/voice-tests/live_loop.test.js。
 *
 * 注入的依賴：
 *   startCapture(onChunk) → Promise<{ stop(): Promise<void> }>
 *       onChunk(mono: Float32Array, rate: number) 每收到一個區塊就呼叫一次。
 *   transcribe(pcm16k: Float32Array) → Promise<string>
 *   onText(text: string)    辨識出一段非空文字時呼叫
 *   onError(err)            辨識失敗時呼叫（不會中斷收音）
 *
 * 限制（誠實標明）：能量門檻 VAD 只看音量，不分人聲與噪音；環境吵的時候會誤切。
 * 聲紋閘門（階段 D）會接在 onText 之前，不在這裡判斷。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaLiveLoop = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var WHISPER_RATE = 16000;

  function rms(x) {
    if (!x || !x.length) return 0;
    var s = 0;
    for (var i = 0; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s / x.length);
  }

  // 線性內插重採樣。fromRate／toRate 必須是正數。
  function resampleLinear(samples, fromRate, toRate) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new Error('取樣率必須是正數');
    if (fromRate === toRate) return Float32Array.from(samples);
    var outLen = Math.floor(samples.length * toRate / fromRate);
    var out = new Float32Array(outLen);
    var ratio = fromRate / toRate;
    for (var i = 0; i < outLen; i++) {
      var pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, samples.length - 1);
      var frac = pos - i0;
      out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
    }
    return out;
  }

  function concat(parts) {
    var n = 0;
    for (var i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Float32Array(n), o = 0;
    for (var j = 0; j < parts.length; j++) { out.set(parts[j], o); o += parts[j].length; }
    return out;
  }

  // 能量門檻的語音活動偵測。用取樣計數當時鐘（不用 Date.now），方便測試。
  // feed(mono, rate) 回傳 null 或 { samples, rate, durationMs }（一句話結束時）。
  function createVad(opts) {
    opts = opts || {};
    var threshold = opts.threshold != null ? opts.threshold : 0.01;
    var silenceMs = opts.silenceMs != null ? opts.silenceMs : 800;
    var maxMs = opts.maxMs != null ? opts.maxMs : 15000;
    var minMs = opts.minMs != null ? opts.minMs : 300;
    var clockSamples = 0;     // 已看過的取樣數（以目前的 rate 計）
    var rate = 0;
    var inSpeech = false, buf = [], segStartMs = 0, lastVoiceMs = 0, bufSamples = 0;

    function segment(endMs) {
      var samples = concat(buf);
      var durMs = (samples.length / rate) * 1000;
      var r = rate;
      inSpeech = false; buf = []; bufSamples = 0;
      if (durMs < minMs) return null;
      return { samples: samples, rate: r, durationMs: durMs, endMs: endMs };
    }

    function feed(mono, sampleRate) {
      if (!(sampleRate > 0)) throw new Error('取樣率必須是正數');
      rate = sampleRate;
      var tStart = (clockSamples / rate) * 1000;
      clockSamples += mono.length;
      var tEnd = (clockSamples / rate) * 1000;
      var voiced = rms(mono) > threshold;
      if (!inSpeech) {
        if (!voiced) return null;
        inSpeech = true; buf = [mono]; bufSamples = mono.length;
        segStartMs = tStart; lastVoiceMs = tEnd;
        return null;
      }
      buf.push(mono); bufSamples += mono.length;
      if (voiced) lastVoiceMs = tEnd;
      if (tEnd - lastVoiceMs >= silenceMs) return segment(tEnd);
      if (tEnd - segStartMs >= maxMs) return segment(tEnd);
      return null;
    }

    // 收音停止時把沒結束的那一句收掉（如果夠長）。
    function flush() {
      if (!inSpeech || !buf.length) { inSpeech = false; buf = []; return null; }
      return segment((clockSamples / rate) * 1000);
    }

    return { feed: feed, flush: flush, isSpeaking: function () { return inSpeech; } };
  }

  function createLiveLoop(opts) {
    opts = opts || {};
    if (typeof opts.startCapture !== 'function') throw new Error('需要 startCapture');
    if (typeof opts.transcribe !== 'function') throw new Error('需要 transcribe');
    var onText = typeof opts.onText === 'function' ? opts.onText : function () {};
    var onError = typeof opts.onError === 'function' ? opts.onError : function () {};
    var vad = createVad(opts.vad);
    var capture = null;
    var chain = Promise.resolve();   // 辨識一句一句依序做，不並行
    var pendingCount = 0;
    var stats = { segments: 0, texts: 0, errors: 0 };

    function runSegment(seg) {
      pendingCount++;
      stats.segments++;
      chain = chain.then(async function () {
        try {
          var pcm = resampleLinear(seg.samples, seg.rate, WHISPER_RATE);
          var text = String((await opts.transcribe(pcm)) || '').trim();
          if (text) { stats.texts++; onText(text); }
        } catch (e) {
          stats.errors++;
          onError(e);
        } finally {
          pendingCount--;
        }
      });
    }

    var diverter = null;   // 錄入聲紋時，音訊改送給這裡，不進語音切段

    function ingest(mono, rate) {
      if (diverter) { diverter(mono, rate); return; }
      var seg = vad.feed(mono, rate);
      if (seg) runSegment(seg);
    }

    // 把收音改道（例如錄入聲紋）。進入前先把正在說的一句收掉，避免混在一起。
    function setDiverter(fn) {
      if (typeof fn !== 'function') throw new Error('需要函式');
      var last = vad.flush();
      if (last) runSegment(last);
      diverter = fn;
    }
    function clearDiverter() { diverter = null; }

    async function start() {
      if (capture) return;
      capture = await opts.startCapture(ingest);
    }

    async function stop() {
      if (capture) {
        var c = capture; capture = null;
        await c.stop();
      }
      var last = vad.flush();
      if (last) runSegment(last);
      await chain;
    }

    return {
      start: start,
      stop: stop,
      ingest: ingest,           // 測試與無麥克風的情境（例如測試音檔）直接餵區塊
      setDiverter: setDiverter, // 錄入聲紋時把音訊改道
      clearDiverter: clearDiverter,
      idle: function () { return pendingCount === 0 && !vad.isSpeaking(); },
      stats: function () { return Object.assign({}, stats); }
    };
  }

  return { createLiveLoop: createLiveLoop, createVad: createVad, resampleLinear: resampleLinear, rms: rms, WHISPER_RATE: WHISPER_RATE };
});
