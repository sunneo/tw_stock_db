/* 聲紋模型的輸入特徵：16kHz 單聲道 → 80 維 log-mel 能量（UMD，純函式，不碰模型與 DOM）。
 * 測試：scripts/voice-tests/fbank.test.js。
 *
 * 參數（與常見的 SpeechBrain 前處理相同的慣例，但**尚未與來源模型的前處理逐位元比對**）：
 *   取樣率 16000、視窗 25ms（400 點）、位移 10ms（160 點）、FFT 512 點、Hann 視窗、80 個 mel 濾波器（0–8000Hz，HTK mel）、log 取 1e-10 下限。
 * 誠實限制：Hann 視窗與來源模型訓練時的前處理是否一致未確認；不一致會降低比對準確度，要在真模型上量測確認。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaFbank = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RATE = 16000, WIN = 400, HOP = 160, NFFT = 512, NMELS = 80, FMIN = 0, FMAX = 8000;

  function hz2mel(f) { return 2595 * Math.log10(1 + f / 700); }
  function mel2hz(m) { return 700 * (Math.pow(10, m / 2595) - 1); }

  // 迭代式 radix-2 FFT（in-place，長度須為 2 的冪）。
  function fftInPlace(re, im) {
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { var tr = re[i]; re[i] = re[j]; re[j] = tr; var ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (var k = 0; k < n; k += len) {
        var cr = 1, ci = 0;
        for (var m = 0; m < len / 2; m++) {
          var a = k + m, b = a + len / 2;
          var xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          var ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  var HANN = (function () { var w = new Float64Array(WIN); for (var i = 0; i < WIN; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WIN - 1)); return w; })();

  // 三角濾波器組：NMELS × (NFFT/2+1)
  var FILTERS = (function () {
    var nb = NFFT / 2 + 1, mlo = hz2mel(FMIN), mhi = hz2mel(FMAX);
    var pts = []; for (var i = 0; i < NMELS + 2; i++) pts.push(mel2hz(mlo + (mhi - mlo) * i / (NMELS + 1)));
    var bins = pts.map(function (f) { return f * NFFT / RATE; });
    var F = [];
    for (var m = 0; m < NMELS; m++) {
      var row = new Float64Array(nb), l = bins[m], c = bins[m + 1], r = bins[m + 2];
      for (var k = 0; k < nb; k++) {
        if (k > l && k <= c) row[k] = (k - l) / (c - l);
        else if (k > c && k < r) row[k] = (r - k) / (r - c);
      }
      F.push(row);
    }
    return F;
  })();

  // 回傳 { frames, data }：data 是 frames×80 的 Float32Array（列為時間，行為 mel）。
  function fbank(samples, rate) {
    if (rate !== RATE) throw new Error('只支援 16000Hz，收到 ' + rate);
    var x = samples;
    var frames = x.length < WIN ? 0 : Math.floor((x.length - WIN) / HOP) + 1;
    var out = new Float32Array(frames * NMELS);
    var re = new Float64Array(NFFT), im = new Float64Array(NFFT);
    for (var t = 0; t < frames; t++) {
      re.fill(0); im.fill(0);
      var off = t * HOP;
      for (var i = 0; i < WIN; i++) re[i] = x[off + i] * HANN[i];
      fftInPlace(re, im);
      var power = new Float64Array(NFFT / 2 + 1);
      for (var k = 0; k <= NFFT / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
      for (var mi = 0; mi < NMELS; mi++) {
        var row = FILTERS[mi], e = 0;
        for (var kk = 0; kk <= NFFT / 2; kk++) e += row[kk] * power[kk];
        out[t * NMELS + mi] = Math.log(Math.max(e, 1e-10));
      }
    }
    return { frames: frames, data: out, nMels: NMELS };
  }

  return { fbank: fbank, RATE: RATE, WIN: WIN, HOP: HOP, NMELS: NMELS, NFFT: NFFT, hz2mel: hz2mel, mel2hz: mel2hz, fftInPlace: fftInPlace };
});
