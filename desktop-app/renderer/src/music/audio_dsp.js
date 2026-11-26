// 音訊前處理(階段三):高通濾波(高低音分開跑用)、音高校準(錄音偏離 A440 多少音分)、錄音變調的漂移修正,以及時間對應回原始時間。
// 全部是純函式,在網頁版也能跑(只用 Float32Array / Float64Array,不碰桌面功能)。
//   highpass(x, sr, fc)            6 階巴特沃斯高通(三節二階,正向＋反向,零相位);沒有訊號時回傳零,不放大浮點殘值;有訊號時正規化到輸入的峰值
//   estimateTuning(x, sr, start, len)  取一段的頻譜強峰,離平均律的加權圓形平均(單位:音分,範圍 -50~50);conf 越接近 1 越一致
//   planWarp(mono, sr)             分析整首:整體偏離超過 TUNE_MIN 音分就整首校準;錄音逐漸變調(讀值一致、相鄰差距小、總範圍夠大)就逐秒校準;其他不動
//   applyWarp(x, sr, plan)         依計畫重新取樣(音高與時間一起變,轉完再用 toOriginalTime 映射回原始時間)
//   makeTimeMap(plan)              tY(校準後秒數) → tOrig(原始秒數)
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaAudioDsp = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const HP_FC = 200;                 // 高通截止頻率(Hz)
  const HP_Q = [1 / (2 * Math.sin(Math.PI / 12)), 1 / (2 * Math.sin(Math.PI * 3 / 12)), 1 / (2 * Math.sin(Math.PI * 5 / 12))]; // 6 階巴特沃斯三節的 Q:1.932、0.707、0.518
  const TUNE_N = 8192;               // 音高估計的 FFT 長度
  const TUNE_LO = 110, TUNE_HI = 1760; // 只看這個範圍的強峰(Hz)
  const TUNE_PEAK_FRAC = 0.02;       // 強峰:功率至少是範圍內最大峰的 2%(約 -17 分貝)
  const CONF_MIN = 0.5;              // 單一視窗的一致度低於這個就不採信
  const TUNE_MIN = 20;               // 整體偏離超過這個音分數才校準(音分)
  const DRIFT_WIN = 4;               // 漂移量測:每個視窗 4 秒
  const DRIFT_RANGE = 25;            // 漂移修正:讀值的總範圍至少這麼大(音分)
  const DRIFT_STEP = 8;              // 漂移修正:相鄰視窗的差距不能超過這麼多(音分),否則是獨奏人聲的顫音／滑音,不修
  const DRIFT_VALID = 0.8;           // 漂移修正:至少這個比例的視窗一致度夠高

  // 3 節二階高通(RBJ 公式)
  function biquadHP(fc, sr, Q) { const w0 = 2 * Math.PI * fc / sr, c = Math.cos(w0), al = Math.sin(w0) / (2 * Q); const a0 = 1 + al; return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 }; }
  function sectionPass(y, s) { const o = new Float64Array(y.length); let z1 = 0, z2 = 0; for (let i = 0; i < y.length; i++) { const x = y[i], out = s.b0 * x + z1; z1 = s.b1 * x - s.a1 * out + z2; z2 = s.b2 * x - s.a2 * out; o[i] = out; } return o; }
  function cascade(y, secs) { let v = y; for (const s of secs) v = sectionPass(v, s); return v; }
  function reverse(y) { const o = new Float64Array(y.length); for (let i = 0; i < y.length; i++) o[i] = y[y.length - 1 - i]; return o; }
  function peakOf(x) { let p = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; } return p; }

  // 兩端各做 EDGE_SEC 秒的餘弦漸入漸出再濾波,避免起點的突變在高通後變成假的暫態(不然會被正規化放大成假音)
  const EDGE_SEC = 0.1, NO_SIGNAL_FRAC = 1e-3; // 高通後峰值不到輸入峰值的千分之一,就當沒有訊號
  function highpass(x, sr, fc) {
    const n = x ? x.length : 0, out = new Float32Array(n); if (!n) return out;
    const pk = peakOf(x); if (pk < 1e-4) return out; // 沒有訊號:回傳零,不放大殘值
    const y = Float64Array.from(x), E = Math.min(Math.floor(EDGE_SEC * sr), Math.floor(n / 2));
    for (let i = 0; i < E; i++) { const w = 0.5 - 0.5 * Math.cos(Math.PI * i / E); y[i] *= w; y[n - 1 - i] *= w; }
    const secs = HP_Q.map((q) => biquadHP(fc || HP_FC, sr, q));
    let z = reverse(cascade(reverse(cascade(y, secs)), secs)); // 零相位:正向、反向、正向、反向
    const pk2 = peakOf(z); if (pk2 <= NO_SIGNAL_FRAC * pk) return out;
    const g = pk / pk2; for (let i = 0; i < n; i++) out[i] = z[i] * g; // 正規化到輸入峰值
    return out;
  }

  // 一段的音高偏離:多個 8192 點視窗的功率平均,取強峰做拋物線內插,離平均律的偏差以 100 音分為週期做加權圓形平均
  function estimateTuning(x, sr, start, len) {
    const N = TUNE_N, half = N / 2, s0 = Math.max(0, Math.floor(start)), total = Math.min(len, x.length - s0);
    if (total < N) return { cents: 0, conf: 0, peaks: 0 };
    const K = 3, P = new Float64Array(half), re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 0; k < K; k++) {
      const off = s0 + Math.floor((total - N) * k / Math.max(1, K - 1));
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
      fftInPlace(re, im);
      for (let i = 0; i < half; i++) P[i] += re[i] * re[i] + im[i] * im[i];
    }
    const lo = Math.max(2, Math.ceil(TUNE_LO * N / sr)), hi = Math.min(half - 2, Math.floor(TUNE_HI * N / sr));
    let mx = 0; for (let k = lo; k <= hi; k++) if (P[k] > mx) mx = P[k];
    if (mx <= 0) return { cents: 0, conf: 0, peaks: 0 };
    let sc = 0, ss = 0, sw = 0, cnt = 0;
    for (let k = lo; k <= hi; k++) {
      if (!(P[k] >= P[k - 1] && P[k] >= P[k + 1] && P[k] >= TUNE_PEAK_FRAC * mx)) continue;
      const a = Math.sqrt(P[k - 1]), b = Math.sqrt(P[k]), c = Math.sqrt(P[k + 1]), den = a - 2 * b + c;
      const d = Math.abs(den) > 1e-12 ? 0.5 * (a - c) / den : 0;
      const f = (k + d) * sr / N, midi = 69 + 12 * Math.log2(f / 440), dev = midi - Math.round(midi), cents = dev * 100;
      const ang = 2 * Math.PI * cents / 100, w = P[k];
      sc += w * Math.cos(ang); ss += w * Math.sin(ang); sw += w; cnt++;
    }
    if (!sw) return { cents: 0, conf: 0, peaks: 0 };
    return { cents: Math.atan2(ss, sc) * 100 / (2 * Math.PI), conf: Math.sqrt(sc * sc + ss * ss) / sw, peaks: cnt };
  }
  // 圓形偏差:把差值折到 (-50, 50] 音分
  const wrap = (c) => { let v = ((c + 50) % 100 + 100) % 100 - 50; return v === -50 ? 50 : v; };

  function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr0 = Math.cos(ang), wi0 = Math.sin(ang); for (let i = 0; i < n; i += len) { let wr = 1, wi = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const nwr = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = nwr; } } }
  }

  // 分析整首並決定校準計畫。回傳 { mode: 'none'|'global'|'drift', offset(音分), segments:[{ o0, o1, cents }], reason }
  // segments 是原始時間的區段(秒);cents 是該段要校正的偏離(音分),速率 = 2^(-cents/1200)
  function planWarp(mono, sr) {
    const dur = mono.length / sr, none = { mode: 'none', offset: 0, segments: [], reason: '' };
    if (!(dur >= 1)) return Object.assign(none, { reason: '太短' });
    const winLen = Math.min(mono.length, Math.round(DRIFT_WIN * sr)), secs = Math.floor(dur);
    const est = [];
    for (let i = 0; i < secs; i++) { const c = Math.round((i + 0.5) * sr), st = Math.max(0, Math.min(mono.length - winLen, c - Math.floor(winLen / 2))); est.push(estimateTuning(mono, sr, st, winLen)); }
    const good = est.filter((e) => e.conf >= CONF_MIN);
    if (!good.length) return Object.assign(none, { reason: '沒有夠清楚的音高可以量' });
    // 整體偏離:一致度為權重的圓形平均
    let sx = 0, sy = 0; for (const e of good) { sx += e.conf * Math.cos(2 * Math.PI * e.cents / 100); sy += e.conf * Math.sin(2 * Math.PI * e.cents / 100); }
    const offset = Math.atan2(sy, sx) * 100 / (2 * Math.PI);
    // 漂移判斷:讀值要一致(大多數視窗一致度夠高)、相鄰差距小、總範圍夠大
    const dev = est.map((e) => wrap(e.cents - offset));
    const validRatio = good.length / est.length;
    let minD = Infinity, maxD = -Infinity, maxStep = 0; for (let i = 0; i < est.length; i++) { if (est[i].conf < CONF_MIN) continue; minD = Math.min(minD, dev[i]); maxD = Math.max(maxD, dev[i]); if (i > 0 && est[i - 1].conf >= CONF_MIN) maxStep = Math.max(maxStep, Math.abs(dev[i] - dev[i - 1])); }
    const drift = validRatio >= DRIFT_VALID && est.length >= 3 && (maxD - minD) >= DRIFT_RANGE && maxStep <= DRIFT_STEP;
    if (drift) {
      const segs = []; for (let i = 0; i < secs; i++) segs.push({ o0: i, o1: Math.min(dur, i + 1), cents: est[i].conf >= CONF_MIN ? wrap(est[i].cents) : offset });
      return { mode: 'drift', offset, segments: segs, reason: '錄音逐漸變調(範圍 ' + Math.round(maxD - minD) + ' 音分),逐秒校準' };
    }
    if (Math.abs(offset) > TUNE_MIN) return { mode: 'global', offset, segments: [{ o0: 0, o1: dur, cents: offset }], reason: '整體偏離 A440 約 ' + Math.round(offset) + ' 音分' };
    return Object.assign(none, { offset, reason: '音高接近 A440(' + Math.round(offset) + ' 音分),不校準' });
  }

  // 線性內插的變速重新取樣:y(n) = x(n·s)。s < 1 讓音高升高、長度變長;s = 2^(-cents/1200)
  function resampleRate(x, s) {
    const m = Math.max(0, Math.floor(x.length / s)), y = new Float32Array(m);
    for (let n = 0; n < m; n++) { const p = n * s, i0 = Math.floor(p), f = p - i0; y[n] = x[Math.min(x.length - 1, i0)] * (1 - f) + x[Math.min(x.length - 1, i0 + 1)] * f; }
    return y;
  }
  // 依計畫把整段聲音重新取樣(各段接起來);回傳新的 Float32Array。沒有計畫(mode none)就原樣回傳
  function applyWarp(x, sr, plan) {
    if (!plan || plan.mode === 'none' || !plan.segments.length) return x;
    const parts = []; let total = 0;
    for (const sg of plan.segments) {
      const a = Math.max(0, Math.round(sg.o0 * sr)), b = Math.min(x.length, Math.round(sg.o1 * sr)); if (b <= a) continue;
      const s = Math.pow(2, -sg.cents / 1200), y = resampleRate(x.subarray(a, b), s); parts.push(y); total += y.length;
    }
    const out = new Float32Array(total); let o = 0; for (const y of parts) { out.set(y, o); o += y.length; }
    return out;
  }
  // 時間對應:校準後時間 → 原始時間。每段的起點用同一個速率換算
  function makeTimeMap(plan, sr) {
    if (!plan || plan.mode === 'none' || !plan.segments.length) return (t) => t;
    const rows = []; let outStart = 0;
    for (const sg of plan.segments) { const s = Math.pow(2, -sg.cents / 1200), inLen = Math.max(0, Math.round(sg.o1 * sr) - Math.round(sg.o0 * sr)), outLen = Math.floor(inLen / s) / sr; rows.push({ outStart, origStart: sg.o0, s, outLen }); outStart += outLen; }
    return function (tY) {
      if (!isFinite(tY)) return tY;
      let lo = 0, hi = rows.length - 1; if (tY <= 0) return rows[0].origStart + tY * rows[0].s;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rows[m].outStart <= tY) lo = m; else hi = m - 1; }
      const r = rows[lo]; return r.origStart + (tY - r.outStart) * r.s;
    };
  }

  return { HP_FC, HP_Q, TUNE_MIN, DRIFT_RANGE, DRIFT_STEP, highpass, estimateTuning, planWarp, applyWarp, makeTimeMap, resampleRate, wrap };
});
