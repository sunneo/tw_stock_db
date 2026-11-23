/* 音樂庫的音訊→MIDI 純函式（UMD，不碰 DOM／網路；依賴由呼叫端注入，node 可用真的 audio_pipeline 跑測試）。
 *   songFromAudio(input, opts) → Promise<{ song, tempo, method, skipped }>
 *     input: { channels: [Float32Array…], sampleRate }
 *     opts:  { Pipeline（FaAudioPipeline，要有 run）, transcriber（Basic Pitch 轉譜函式，可省略）, title, modelNote }
 *   有 transcriber：先用 Basic Pitch；它丟錯就整段改用單音音高追蹤，method 寫明失敗原因。
 *   沒有 transcriber：單音音高追蹤（audio_pipeline 內建的退路），method 寫「簡易轉譜」。
 * 這個檔不決定要不要下載模型；模型是否可用由 host 檢查後才傳 transcriber。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibAudio = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var METHOD_PITCH = '簡易轉譜（單音音高追蹤）';
  var METHOD_BASIC = 'Basic Pitch';

  // 多聲道合成單聲道（平均）
  function monoOf(channels) {
    var nc = channels.length, n = nc ? channels[0].length : 0, out = new Float32Array(n);
    for (var c = 0; c < nc; c++) { var d = channels[c]; for (var i = 0; i < n; i++) out[i] += d[i] / nc; }
    return out;
  }
  // 取前 sec 秒（不超過整段）
  function sliceChannels(channels, sampleRate, sec) {
    var n = channels.length ? channels[0].length : 0;
    var keep = sec == null ? n : Math.min(n, Math.floor(sec * sampleRate));
    return channels.map(function (d) { return d.subarray(0, keep); });
  }

  async function runPipeline(P, input, transcriber, title) {
    var o = { title: title || '從音訊轉出' };
    if (transcriber) o.transcriber = transcriber;
    return P.run({ left: input.channels[0], right: input.channels[1] || null, sampleRate: input.sampleRate }, o);
  }

  async function songFromAudio(input, opts) {
    opts = opts || {};
    var P = opts.Pipeline;
    if (!P || typeof P.run !== 'function') throw new Error('缺少 FaAudioPipeline（音訊轉譜流程）');
    if (!input || !input.channels || !input.channels.length) throw new Error('沒有音訊樣本');
    var r, method = METHOD_PITCH, note = opts.modelNote || '';
    if (opts.transcriber) {
      try {
        r = await runPipeline(P, input, opts.transcriber, opts.title);
        method = METHOD_BASIC;
      } catch (e) {
        var why = String((e && e.message) || e);
        r = await runPipeline(P, input, null, opts.title);
        method = METHOD_PITCH + '，Basic Pitch 失敗已退回：' + why;
      }
    } else {
      r = await runPipeline(P, input, null, opts.title);
      method = METHOD_PITCH + (note ? '（' + note + '）' : '');
    }
    return { song: r.song, tempo: r.tempo, method: method, skipped: (r.report && r.report.skipped) || [] };
  }


  // 哼歌專用：人只會哼單音，不需要鼓／貝斯分離；重點是把「音量變小的尾巴、背景雜音」濾掉，
  // 不然衰減中的聲音會被音高追蹤抓成下一個（多半是錯的）音符。
  // 作法：降到約 11 kHz 後追蹤音高；以整段音量的高百分位為基準，低於基準的一定比例（約 -17 dB）就當沒聲音；
  // 音符內音量掉到該音起頭很小（衰減尾）的幀也截掉；轉成音符後再丟掉太短、太輕（遠低於整段中位）的音。
  function humNotes(input, opts) {
    opts = opts || {};
    var AM = opts.AudioToMidi; if (!AM || !AM.pitchTrack) throw new Error('缺少 FaAudioToMidi（音高追蹤）');
    var mono = monoOf(input.channels), sr = input.sampleRate, step = Math.max(1, Math.round(sr / 11025)), n = Math.floor(mono.length / step), w = new Float32Array(n);
    for (var i = 0; i < n; i++) { var a = 0; for (var k = 0; k < step; k++) a += mono[i * step + k]; w[i] = a / step; }
    var wsr = sr / step;
    var tr = AM.pitchTrack(w, wsr, { fmin: 70, fmax: 900, thr: 0.12 });
    var sorted = Array.prototype.slice.call(tr.rms).filter(function (x) { return x > 0; }).sort(function (x, y) { return x - y; });
    var ref = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    var gate = Math.max(0.01, ref * (opts.gateRatio || 0.14)), decay = opts.decayRatio || 0.3;
    var runPeak = 0, orig = Uint8Array.from(tr.voiced);
    for (var f = 0; f < tr.voiced.length; f++) {
      if (!orig[f]) { runPeak = 0; continue; }   // 原本就沒音高（靜音）才算新的一段
      if (tr.rms[f] < gate) { tr.voiced[f] = 0; runPeak = 0; continue; }
      if (tr.rms[f] > runPeak) runPeak = tr.rms[f];
      if (tr.rms[f] < runPeak * decay) tr.voiced[f] = 0;   // 衰減尾：不是新音；尾巴後面冒出的小聲音也一併濾掉
    }
    var notes = AM.framesToNotes(tr, { minDur: opts.minDur || 0.08 });
    if (notes.length) {
      var vs = notes.map(function (x) { return x.v; }).sort(function (x, y) { return x - y; }), med = vs[vs.length >> 1];
      notes = notes.filter(function (x) { return x.v >= med * 0.5; });
    }
    return { notes: notes, gate: gate, ref: ref };
  }

  return { humNotes: humNotes, monoOf: monoOf, sliceChannels: sliceChannels, songFromAudio: songFromAudio, METHOD_PITCH: METHOD_PITCH, METHOD_BASIC: METHOD_BASIC };
}));
