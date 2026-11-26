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

  async function runPipeline(P, input, transcriber, title, separator, stems) {
    var o = { title: title || '從音訊轉出' };
    if (transcriber) o.transcriber = transcriber;
    if (separator) { o.separator = separator; if (stems) o.stems = stems; }
    return P.run({ left: input.channels[0], right: input.channels[1] || null, sampleRate: input.sampleRate }, o);
  }

  // opts.separator（選用）：分軌函式（Demucs）。有就先拆成鼓／貝斯／人聲／吉他／鋼琴／其他各自轉譜，song 的每條音軌是一個聲部；
  // 分軌那一步丟錯就退回不分軌（method 寫明原因），不整個失敗。
  async function songFromAudio(input, opts) {
    opts = opts || {};
    var P = opts.Pipeline;
    if (!P || typeof P.run !== 'function') throw new Error('缺少 FaAudioPipeline（音訊轉譜流程）');
    if (!input || !input.channels || !input.channels.length) throw new Error('沒有音訊樣本');
    var r, method = METHOD_PITCH, note = opts.modelNote || '', sep = opts.separator || null, split = false, sepWhy = '';
    async function go(tr) {
      if (sep) {
        try { var x = await runPipeline(P, input, tr, opts.title, sep, opts.stems); split = true; return x; }
        catch (e) { sepWhy = String((e && e.message) || e); sep = null; }
      }
      return runPipeline(P, input, tr, opts.title);
    }
    if (opts.transcriber) {
      try {
        r = await go(opts.transcriber);
        method = METHOD_BASIC;
      } catch (e) {
        var why = String((e && e.message) || e);
        r = await go(null);
        method = METHOD_PITCH + '，Basic Pitch 失敗已退回：' + why;
      }
    } else {
      r = await go(null);
      method = METHOD_PITCH + (note ? '（' + note + '）' : '');
    }
    if (split) method += '＋Demucs 拆軌';
    else if (opts.separator) method += '（拆軌沒成功，已退回不分軌' + (sepWhy ? '：' + sepWhy : '') + '）';
    return { song: r.song, tempo: r.tempo, method: method, skipped: (r.report && r.report.skipped) || [] };
  }


  // 哼歌專用：人只會哼單音，不需要鼓／貝斯分離；重點是把「音量變小的尾巴、背景雜音」濾掉，
  // 不然衰減中的聲音會被音高追蹤抓成下一個（多半是錯的）音符。
  // 作法：降到約 11 kHz 後追蹤音高；以整段音量的高百分位為基準，低於基準的一定比例（約 -17 dB）就當沒聲音；
  // 音符內音量掉到該音起頭很小（衰減尾）的幀也截掉；轉成音符後再丟掉太短、太輕（遠低於整段中位）的音。
  // ───── 主旋律（階段四）：每幀的音高能量（諧波和）＋ Viterbi 連續性 ─────
  // 1) 每幀（10 ms）做一次 1024 點 FFT（11025 Hz 時視窗約 93 ms），對每個半音格算諧波和：Σ 諧波 h=1..5 的權重 × 該諧波頻率的振幅。
  //    不取單一音高（pitchTrack 只給一個），所以伴奏低音與和弦都會出現在候選裡，再由連續性與音域代價挑出主旋律。
  // 2) Viterbi 在「半音格＋沒有旋律」之間選路徑：代價＝(1−能量正規化)·W_SAL ＋ 音域外懲罰（偏好人聲 55–84）
  //    ＋ 跳動代價（格差越大越貴）＋ 換音固定費 ＋ 有音↔無音切換費。能量很低的幀沒有旋律的代價為 0。
  // 權重是依合成真值評測（scratchpad\melody_truth_eval.js）校準的常數，數字見 commit 訊息。
  var VIT = { LO: 40, HI: 84, VLO: 55, VHI: 84, W_SAL: 1.0, W_RANGE: 0.25, W_JUMP: 0.15, W_CHANGE: 0.8, W_ONOFF: 1.5, W_SIL: 0.5, JUMP_CAP: 12, HARM: [1, 0.5, 0.3, 0.2, 0.1], SILENT_REL: 0.03, MIN_FRAMES: 5 };
  var fftTab = {};
  function fftPlan(N) {
    if (fftTab[N]) return fftTab[N];
    var rev = new Uint32Array(N), bits = Math.log2(N), i, c = new Float64Array(N / 2), s = new Float64Array(N / 2);
    for (i = 0; i < N; i++) { var r = 0; for (var b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
    for (i = 0; i < N / 2; i++) { c[i] = Math.cos(-2 * Math.PI * i / N); s[i] = Math.sin(-2 * Math.PI * i / N); }
    var win = new Float64Array(N); for (i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    return (fftTab[N] = { rev: rev, c: c, s: s, win: win });
  }
  function fftInPlace(re, im, plan) {
    var N = re.length, i, j, k, len, half, step, tr, ti, a, b;
    for (i = 0; i < N; i++) { j = plan.rev[i]; if (j > i) { tr = re[i]; re[i] = re[j]; re[j] = tr; ti = im[i]; im[i] = im[j]; im[j] = ti; } }
    for (len = 2; len <= N; len <<= 1) {
      half = len >> 1; step = N / len;
      for (i = 0; i < N; i += len) for (k = 0; k < half; k++) {
        a = i + k; b = a + half; var wr = plan.c[k * step], wi = plan.s[k * step];
        tr = re[b] * wr - im[b] * wi; ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  // 每幀每個半音格的諧波和（T 幀、格 lo..hi），幀的起點與 pitchTrack 相同（每 floor(wsr*0.01) 個取樣一幀）
  function salienceFrames(w, wsr, T, lo, hi) {
    var N = 1024, hop = Math.floor(wsr * 0.01), K = hi - lo + 1, plan = fftPlan(N), sal = new Float32Array(T * K);
    var re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(N / 2), f, i, k, s, h;
    var F = []; for (s = 0; s < K; s++) F.push(440 * Math.pow(2, (lo + s - 69) / 12));
    for (f = 0; f < T; f++) {
      var o = f * hop;
      for (i = 0; i < N; i++) { re[i] = (o + i < w.length ? w[o + i] : 0) * plan.win[i]; im[i] = 0; }
      fftInPlace(re, im, plan);
      for (k = 0; k < N / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      for (s = 0; s < K; s++) {
        var acc = 0;
        for (h = 0; h < VIT.HARM.length; h++) {
          var bin = F[s] * (h + 1) * N / wsr; if (bin >= N / 2 - 1) break;
          var b0 = Math.floor(bin), fr = bin - b0; acc += VIT.HARM[h] * ((1 - fr) * mag[b0] + fr * mag[b0 + 1]);
        }
        sal[f * K + s] = acc;
      }
    }
    return sal;
  }
  // Viterbi：sal（salienceFrames）、rel（每幀相對能量 0..1）→ 音符 [{t, d, n, v}]；t 與 framesToNotes 相同（加 delay）
  function melodyViterbi(sal, T, lo, hi, rel, opts) {
    opts = opts || {};
    var K = hi - lo + 1, S = K + 1, SIL = K, hop = opts.hopSec || 0.01, delay = opts.delay || 0, minF = opts.minFrames || VIT.MIN_FRAMES;
    var sorted = Array.prototype.slice.call(sal).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
    var ref = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 1;
    var emit = new Float64Array(T * S), f, s, p, sn, silCost;
    for (f = 0; f < T; f++) {
      silCost = rel[f] < VIT.SILENT_REL ? 0 : VIT.W_SIL;
      for (s = 0; s < K; s++) {
        p = lo + s; sn = Math.min(1, sal[f * K + s] / ref);
        emit[f * S + s] = VIT.W_SAL * (1 - sn) + VIT.W_RANGE * (Math.max(0, VIT.VLO - p) + Math.max(0, p - VIT.VHI));
      }
      emit[f * S + SIL] = silCost;
    }
    var acc = new Float64Array(S), nxt = new Float64Array(S), back = new Int16Array(T * S), q, c, best, arg, dj;
    for (s = 0; s < S; s++) acc[s] = emit[s];
    for (f = 1; f < T; f++) {
      for (s = 0; s < S; s++) {
        best = Infinity; arg = 0;
        for (q = 0; q < S; q++) {
          c = acc[q];
          if (s === SIL || q === SIL) { if (s !== q) c += VIT.W_ONOFF; }
          else if (s !== q) { dj = Math.min(Math.abs(s - q), VIT.JUMP_CAP); c += VIT.W_JUMP * dj + VIT.W_CHANGE; }
          if (c < best) { best = c; arg = q; }
        }
        nxt[s] = best + emit[f * S + s]; back[f * S + s] = arg;
      }
      var tmp = acc; acc = nxt; nxt = tmp;
    }
    var st = 0; for (s = 1; s < S; s++) if (acc[s] < acc[st]) st = s;
    var path = new Int16Array(T); for (f = T - 1; f >= 0; f--) { path[f] = st; st = back[f * S + st]; }
    var notes = [], run = -1, rs = 0, rmSum = 0;
    var close = function (end) {
      if (run >= 0 && end - rs >= minF) notes.push({ t: rs * hop + delay, d: (end - rs) * hop, n: lo + run, v: Math.max(30, Math.min(120, Math.round(35 + 400 * (rmSum / (end - rs))))) });
    };
    for (f = 0; f < T; f++) {
      var cur = path[f] === SIL ? -1 : path[f];
      if (cur !== run) { close(f); run = cur; rs = f; rmSum = 0; }
      rmSum += rel[f];
    }
    close(T);
    return notes;
  }
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
    var notes;
    if (opts.viterbi === false) notes = AM.framesToNotes(tr, { minDur: opts.minDur || 0.05 });
    else { var Tn = tr.f0.length, relF = new Float32Array(Tn); for (var rf = 0; rf < Tn; rf++) relF[rf] = Math.min(1, (tr.rms[rf] || 0) / ref); var sal = salienceFrames(w, wsr, Tn, VIT.LO, VIT.HI); notes = melodyViterbi(sal, Tn, VIT.LO, VIT.HI, relF, { hopSec: Math.floor(wsr * 0.01) / wsr, delay: tr.delay || 0, minFrames: VIT.MIN_FRAMES }); }
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

  return { humNotes: humNotes, melodyViterbi: melodyViterbi, salienceFrames: salienceFrames, monoOf: monoOf, sliceChannels: sliceChannels, songFromAudio: songFromAudio, METHOD_PITCH: METHOD_PITCH, METHOD_BASIC: METHOD_BASIC };
}));
