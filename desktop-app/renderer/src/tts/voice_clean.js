/* 參考錄音的清理（UMD，純函式，不碰 DOM、網路、模型；桌面版與網頁版共用）。測試 scripts/tts-tests/voice_clean.test.js；設計見 DESIGN.voice-sample.md「樣本再爛也要能合成」。
 * 目標：使用者給的錄音再爛（背景吵、音量小、爆音、有直流偏移、很長）也要能拿來複製聲音，所以送進編碼器之前一律先清理：
 *   1. 去直流偏移、70Hz 高通（風扇、桌面震動的低頻隆隆聲）
 *   2. 降噪（頻譜閘控）：用錄音裡最安靜的幾個視窗當「噪音樣子」，每個頻率分別扣掉，時間與頻率方向都平滑（避免「水聲」般的殘留）；噪音越大扣得越重，很吵的錄音做兩輪
 *   3. 爆音修補：被削平的取樣用軟性壓縮拉回來，不讓編碼器看到方波般的尖銳邊緣
 *   4. 挑最好的一段：整段太長、或前面都是雜音時，挑「有人聲、而且最乾淨」的那一段（預設最長 12 秒）
 *   5. 音量正規化
 * 不做的事：不改變音高與音色（沒有變聲、沒有等化），降噪只扣噪音，所以乾淨的錄音幾乎不受影響（噪音估計低於 -60dB 就整個略過）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaVoiceClean = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var N = 1024, HOP = 256, BINS = N / 2 + 1;
  var HANN = (function () { var w = new Float32Array(N); for (var i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); return w; })();

  // ---- 基本 FFT（複數，原地，長度 2 的次方）
  var TW = (function () { var c = new Float32Array(N / 2), s = new Float32Array(N / 2); for (var i = 0; i < N / 2; i++) { c[i] = Math.cos(2 * Math.PI * i / N); s[i] = -Math.sin(2 * Math.PI * i / N); } return { c: c, s: s }; })();
  var REV = (function () { var r = new Uint16Array(N), bits = Math.log2(N); for (var i = 0; i < N; i++) { var x = i, y = 0; for (var b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; } r[i] = y; } return r; })();
  function fft(re, im, inverse) {
    for (var i = 0; i < N; i++) { var j = REV[i]; if (j > i) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (var size = 2; size <= N; size <<= 1) {
      var half = size >> 1, step = N / size;
      for (var start = 0; start < N; start += size) for (var k = 0; k < half; k++) {
        var wr = TW.c[k * step], wi = inverse ? -TW.s[k * step] : TW.s[k * step], a = start + k, b2 = a + half;
        var xr = re[b2] * wr - im[b2] * wi, xi = re[b2] * wi + im[b2] * wr;
        re[b2] = re[a] - xr; im[b2] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }

  function db(x) { return 20 * Math.log10(Math.max(x, 1e-9)); }
  function rmsOf(a, s, e) { var t = 0, n = Math.max(1, e - s); for (var i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / n); }
  // 每 20 毫秒一個視窗的音量
  function levels(a, rate) { var w = Math.max(1, Math.round(rate * 0.02)), n = Math.floor(a.length / w), out = new Float32Array(n); for (var k = 0; k < n; k++) out[k] = rmsOf(a, k * w, (k + 1) * w); return out; }
  // 噪音底與講話音量（dBFS）與訊噪比：最安靜的 10% 視窗 vs 最大聲的 20% 視窗
  function snrOf(a, rate) {
    var f = levels(a, rate); if (!f.length) return { noiseDb: -120, talkDb: -120, snrDb: 0 };
    var s = Array.prototype.slice.call(f).sort(function (x, y) { return x - y; }), nq = Math.max(1, Math.floor(s.length * 0.1)), tq = Math.max(1, Math.floor(s.length * 0.2)), noise = 0, talk = 0, k;
    for (k = 0; k < nq; k++) noise += s[k]; noise /= nq; for (k = s.length - tq; k < s.length; k++) talk += s[k]; talk /= tq;
    return { noiseDb: db(noise), talkDb: db(talk), snrDb: db(talk) - db(noise) };
  }

  // ---- 去直流 ＋ 70Hz 高通（一階 IIR，夠用）
  function highpass(a, rate) {
    var out = new Float32Array(a.length), mean = 0, i; for (i = 0; i < a.length; i++) mean += a[i]; mean = a.length ? mean / a.length : 0;
    var rc = 1 / (2 * Math.PI * 70), dt = 1 / rate, al = rc / (rc + dt), py = 0, px = a.length ? a[0] - mean : 0;
    for (i = 0; i < a.length; i++) { var x = a[i] - mean; py = al * (py + x - px); px = x; out[i] = py; }
    return out;
  }
  // ---- 爆音修補：接近滿格的取樣用軟性壓縮拉回（tanh 形），不讓削平的方波邊緣進編碼器
  function declip(a) {
    var p = 0, i; for (i = 0; i < a.length; i++) { var x = Math.abs(a[i]); if (x > p) p = x; } if (!(p > 0.9)) return a;
    var out = new Float32Array(a.length), knee = 0.6, span = 1 - knee; for (i = 0; i < a.length; i++) { var v = a[i], m = Math.abs(v); out[i] = m <= knee ? v : (v < 0 ? -1 : 1) * (knee + span * Math.tanh((m - knee) / span)); }
    return out;
  }

  // ---- 降噪（頻譜閘控）。strength：1＝一般；越大扣得越重
  function gate(a, rate, strength) {
    var len = a.length; if (len < N * 2) return a;
    var pad = N, total = len + 2 * pad, x = new Float32Array(total); x.set(a, pad);
    var frames = Math.floor((total - N) / HOP) + 1, mag = new Array(frames), phRe = new Array(frames), phIm = new Array(frames), re = new Float32Array(N), im = new Float32Array(N), f, k, i;
    var energy = new Float32Array(frames);
    for (f = 0; f < frames; f++) {
      var o = f * HOP; for (i = 0; i < N; i++) { re[i] = x[o + i] * HANN[i]; im[i] = 0; } fft(re, im, false);
      var m = new Float32Array(BINS), pr = new Float32Array(BINS), pi = new Float32Array(BINS), e = 0;
      for (k = 0; k < BINS; k++) { var mm = Math.sqrt(re[k] * re[k] + im[k] * im[k]); m[k] = mm; e += mm * mm; if (mm > 1e-12) { pr[k] = re[k] / mm; pi[k] = im[k] / mm; } else { pr[k] = 1; pi[k] = 0; } }
      mag[f] = m; phRe[f] = pr; phIm[f] = pi; energy[f] = e;
    }
    // 噪音樣子：能量最低的 15% 視窗的平均功率（逐頻率）；再往大的方向抓一點餘裕（噪音本來就會起伏）
    var order = Array.prototype.slice.call(energy).map(function (v, ix) { return ix; }).sort(function (p, q) { return energy[p] - energy[q]; }), take = Math.max(4, Math.floor(frames * 0.15)), noise = new Float32Array(BINS);
    for (var t = 0; t < take && t < order.length; t++) { var mg = mag[order[t]]; for (k = 0; k < BINS; k++) noise[k] += mg[k] * mg[k]; } for (k = 0; k < BINS; k++) noise[k] /= Math.min(take, order.length);
    // 頻率方向平滑噪音樣子（5 點），避免某個頻率剛好很低就沒扣到
    var sm = new Float32Array(BINS); for (k = 0; k < BINS; k++) { var s = 0, c = 0; for (var d = -2; d <= 2; d++) { var q = k + d; if (q >= 0 && q < BINS) { s += noise[q]; c++; } } sm[k] = s / c; }
    var alpha = 1.6 * strength, floor = Math.max(0.03, 0.14 / Math.sqrt(strength)), prevG = new Float32Array(BINS).fill(1);
    var out = new Float32Array(total), norm = new Float32Array(total);
    for (f = 0; f < frames; f++) {
      var mg2 = mag[f], g = new Float32Array(BINS);
      for (k = 0; k < BINS; k++) { var px = mg2[k] * mg2[k], gg = px > 1e-18 ? 1 - alpha * sm[k] / px : 0; g[k] = gg < floor ? floor : gg > 1 ? 1 : gg; }
      // 頻率方向再平滑（3 點）＋ 時間方向：上升快（講話開頭不被吃掉）、下降慢（尾音不被切）
      var g2 = new Float32Array(BINS); for (k = 0; k < BINS; k++) { var a0 = g[Math.max(0, k - 1)], a1 = g[k], a2 = g[Math.min(BINS - 1, k + 1)]; g2[k] = (a0 + 2 * a1 + a2) / 4; }
      for (k = 0; k < BINS; k++) { var p0 = prevG[k], v = g2[k]; v = v > p0 ? v : p0 * 0.6 + v * 0.4; g2[k] = v; prevG[k] = v; }
      for (k = 0; k < BINS; k++) { var mo = mg2[k] * g2[k]; re[k] = mo * phRe[f][k]; im[k] = mo * phIm[f][k]; }
      for (k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; } im[0] = 0; im[N / 2] = 0;
      fft(re, im, true); var o2 = f * HOP; for (i = 0; i < N; i++) { var w = HANN[i]; out[o2 + i] += re[i] / N * w; norm[o2 + i] += w * w; }
    }
    var res = new Float32Array(len); for (i = 0; i < len; i++) { var nn = norm[i + pad]; res[i] = nn > 1e-6 ? out[i + pad] / nn : 0; }
    return res;
  }

  // ---- 挑最好的一段：maxSec 秒內，人聲比例高、而且比較乾淨的那一段（短於 maxSec 就整段）
  function bestWindow(a, rate, maxSec) {
    var win = Math.round((maxSec || 12) * rate); if (a.length <= win) return { start: 0, end: a.length };
    var w20 = Math.max(1, Math.round(rate * 0.02)), f = levels(a, rate), s = Array.prototype.slice.call(f).sort(function (x, y) { return x - y; }), noise = s[Math.max(0, Math.floor(s.length * 0.1))] || 1e-4, th = Math.max(noise * 3, 0.004);
    var per = Math.round(win / w20), step = Math.max(1, Math.round(1 / 0.02)), best = -1, bestAt = 0;
    for (var st = 0; st + per <= f.length; st += step) {
      var voiced = 0, loud = 0, quietSum = 0, quietN = 0; for (var i = st; i < st + per; i++) { if (f[i] > th) { voiced++; loud += f[i]; } else { quietSum += f[i]; quietN++; } }
      var frac = voiced / per, snr = voiced ? (loud / voiced) / Math.max(1e-5, quietN ? quietSum / quietN : noise) : 0, score = frac * (1 + Math.min(snr, 40) / 40);
      if (score > best) { best = score; bestAt = st; }
    }
    return { start: bestAt * w20, end: Math.min(a.length, bestAt * w20 + win) };
  }

  function peakOf(a) { var p = 0; for (var i = 0; i < a.length; i++) { var x = Math.abs(a[i]); if (x > p) p = x; } return p; }
  function scaleTo(a, target) { var p = peakOf(a); if (!(p > 1e-6)) return a; var g = Math.min(40, target / p), out = new Float32Array(a.length); for (var i = 0; i < a.length; i++) out[i] = a[i] * g; return out; }

  // 總流程：單聲道樣本 → { samples, report }。opts：{ maxSec=12, denoise=true, strength }
  function clean(mono, rate, opts) {
    opts = opts || {}; var before = snrOf(mono, rate), x = highpass(mono, rate), steps = ['去直流與低頻隆隆聲'];
    var clipped = 0, i; for (i = 0; i < x.length; i++) if (Math.abs(x[i]) >= 0.98) clipped++; if (x.length && clipped / x.length > 0.001) { x = declip(x); steps.push('修補爆音'); }
    var w = bestWindow(x, rate, opts.maxSec || 12); if (w.start > 0 || w.end < x.length) { x = x.subarray(w.start, w.end); steps.push('挑出最清楚的一段（' + (w.start / rate).toFixed(1) + '～' + (w.end / rate).toFixed(1) + ' 秒）'); }
    var mid = snrOf(x, rate), denoised = false;
    if (opts.denoise !== false && mid.noiseDb > -62) {
      var strength = opts.strength || (mid.snrDb < 6 ? 2.2 : mid.snrDb < 14 ? 1.6 : 1); x = gate(x, rate, strength); denoised = true;
      var again = snrOf(x, rate); if (mid.snrDb < 10 && again.snrDb < 22) { x = gate(x, rate, strength * 0.8); steps.push('降噪（兩輪）'); } else steps.push('降噪');
    }
    x = scaleTo(x, 0.89); var after = snrOf(x, rate); steps.push('音量正規化');
    return { samples: x, report: { snrBefore: Math.round(before.snrDb), snrAfter: Math.round(after.snrDb), noiseDbBefore: Math.round(before.noiseDb), denoised: denoised, seconds: Math.round(x.length / rate * 10) / 10, steps: steps } };
  }

  // 引擎丟出來的錯誤常常只是一個數字（WebAssembly 內部例外的位址）：翻成看得懂的話，並判斷「換個做法重試」有沒有意義
  function explainEngineError(err) {
    var s = String((err && err.message) || err || '').trim();
    if (/^\d{4,}$/.test(s)) return { text: '聲音引擎內部發生錯誤（代碼 ' + s + '，多半是記憶體不夠或這次的參考片段讓模型算不下去）', retry: true };
    if (/out of memory|memory access|allocation|Aborted|RuntimeError|unreachable|bad_alloc|std::/i.test(s)) return { text: '聲音引擎發生內部錯誤（' + s.slice(0, 80) + '，多半是記憶體不夠）', retry: true };
    if (/worker|引擎已關閉|引擎載入失敗/.test(s)) return { text: s, retry: true };
    return { text: s || '不明的錯誤', retry: false };
  }
  // 重試的做法（由輕到重）：每一階換新引擎、參考片段越來越短、最後一階用最乾淨的 4 秒
  var LADDER = [{ frames: 250, fresh: false, label: '照原本的做法' }, { frames: 250, fresh: true, label: '換一個新的引擎重試' }, { frames: 120, fresh: true, label: '用較短的參考片段（約 10 秒）重試' }, { frames: 50, fresh: true, label: '用最短的參考片段（約 4 秒）重試' }];

  return { clean: clean, gate: gate, highpass: highpass, declip: declip, bestWindow: bestWindow, snrOf: snrOf, levels: levels, explainEngineError: explainEngineError, LADDER: LADDER, fft: fft, N: N };
});
