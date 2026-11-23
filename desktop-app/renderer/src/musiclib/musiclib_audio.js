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
    var tr = AM.pitchTrack(w, wsr, { fmin: 70, fmax: 900, thr: opts.thr || 0.2 });
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
    var notes = AM.framesToNotes(tr, { minDur: opts.minDur || 0.05 });
    if (notes.length) {
      var vs = notes.map(function (x) { return x.v; }).sort(function (x, y) { return x - y; }), med = vs[vs.length >> 1];
      notes = notes.filter(function (x) { return x.v >= med * 0.5; });
    }
    // 後處理：人哼的旋律不會跨很大的音域。以中位音高為準：離中位 13 半音以上多半是低頻底噪／誤判，丟掉；
    // 9～12 半音多半是掉了／多了一個八度，折回來；孤立（兩側音高都差 3 半音以上）又很短（< 0.15 秒）的碎音丟掉。
    var dropped = { far: 0, folded: 0, blip: 0 };
    if (notes.length >= 4) {
      var ps0 = notes.map(function (x) { return x.n; }).sort(function (x, y) { return x - y; }), md = ps0[ps0.length >> 1];
      notes = notes.filter(function (x) { return Math.abs(x.n - md) < 13 || (dropped.far++, false); }).map(function (x) {
        var df = x.n - md; if (Math.abs(df) >= 9) { dropped.folded++; return Object.assign({}, x, { n: x.n - 12 * Math.sign(df) }); } return x;
      });
      notes = notes.filter(function (x, i) {
        var pv = notes[i - 1], nx = notes[i + 1];
        var blip = x.d < 0.15 && (!pv || Math.abs(x.n - pv.n) >= 3) && (!nx || Math.abs(x.n - nx.n) >= 3);
        if (blip) dropped.blip++; return !blip;
      });
    }
    // 滑音：兩個音中間很短（< glideMax 秒）、音高介於前後音之間（含 1 半音內）的過渡音，是從一個音滑到下一個音的痕跡，不是新音
    var gmax = opts.glideMax == null ? 0.12 : opts.glideMax; dropped.glide = 0;
    if (gmax > 0) {
      notes = notes.filter(function (x, i) {
        var pv = notes[i - 1], nx = notes[i + 1];
        if (!pv || !nx || x.d >= gmax) return true;
        var lo = Math.min(pv.n, nx.n) - 1, hi = Math.max(pv.n, nx.n) + 1;
        var g = x.n >= lo && x.n <= hi && Math.abs(pv.n - nx.n) >= 1;
        if (g) dropped.glide++; return !g;
      });
    }
    var tot = orig.length, vOrig = 0, vKept = 0; for (var q = 0; q < tot; q++) { if (orig[q]) vOrig++; if (tr.voiced[q]) vKept++; }
    var ps = notes.map(function (x) { return x.n; });
    return { notes: notes, gate: gate, ref: ref, frames: tot, voicedRaw: vOrig, voicedKept: vKept, lo: ps.length ? Math.min.apply(null, ps) : null, hi: ps.length ? Math.max.apply(null, ps) : null, dropped: dropped };
  }

  return { humNotes: humNotes, monoOf: monoOf, sliceChannels: sliceChannels, songFromAudio: songFromAudio, METHOD_PITCH: METHOD_PITCH, METHOD_BASIC: METHOD_BASIC };
}));
