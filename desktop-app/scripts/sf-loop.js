// 音色庫瘦身的純函式:找樣本「內部」的 loop(像壓縮演算法找重複區段),不是找樣本之間的重複。
//   findPeriod(x, sr)            → { period, strength } 自相關找基頻週期(取樣點數);沒有明顯週期 strength 小
//   findLoop(x, sr, opts)        → { start, end, score, periods } | null  無縫 loop 起訖(對齊正向零交越、整數個週期、接縫兩側連續)
//   seamError(x, start, end)     → 0..1 接縫處的不連續度(loop 結尾接回開頭的波形差,0 = 完全連續)
//   isSustained(x, sr)           → 是持續音(弦、管、風琴、合唱)還是打擊／衰減音
//   resample(x, ratio)           → 降取樣(ratio < 1,視窗 sinc 低通)
//   slim(x, sr, hdr, opts)       → { data, hdr, action } 依規則處理一個樣本(hdr:{startLoop,endLoop} 相對樣本開頭,沒有 loop 就 startLoop===endLoop)
// 所有位置都是樣本點索引;x 是 Float32Array(-1..1)。
'use strict';

function rms(x, a, b) { let s = 0; a = Math.max(0, a); b = Math.min(x.length, b); for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); }

// 正規化自相關;視窗取樣本中段最穩的一小段,避免起音干擾
function findPeriod(x, sr, opts) {
  opts = opts || {}; const minHz = opts.minHz || 30, maxHz = opts.maxHz || 2500;
  const lagMin = Math.max(2, Math.floor(sr / maxHz)), lagMax = Math.min(Math.floor(sr / minHz), Math.floor(x.length / 3));
  if (lagMax <= lagMin + 2) return { period: 0, strength: 0 };
  const W = Math.min(x.length - lagMax - 1, Math.max(lagMax * 2, Math.floor(sr * 0.05))); if (W < lagMin * 3) return { period: 0, strength: 0 };
  const a0 = Math.max(0, Math.floor((x.length - W - lagMax) / 2)); // 取中段
  let e0 = 0; for (let i = 0; i < W; i++) e0 += x[a0 + i] * x[a0 + i]; if (e0 < 1e-9) return { period: 0, strength: 0 };
  const r = new Float64Array(lagMax + 2);
  for (let lag = lagMin; lag <= lagMax; lag++) { let c = 0, e1 = 0; for (let i = 0; i < W; i++) { const v = x[a0 + lag + i]; c += x[a0 + i] * v; e1 += v * v; } r[lag] = c / Math.sqrt(e0 * e1 + 1e-12); }
  // 第一個「夠高的局部峰」(避免取到倍數週期:先找全域最大,再往下找最小的、仍達 0.9 倍最大的局部峰)
  let best = lagMin; for (let lag = lagMin; lag <= lagMax; lag++) if (r[lag] > r[best]) best = lag;
  let pick = best; for (let lag = lagMin + 1; lag < best; lag++) if (r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] >= 0.9 * r[best]) { pick = lag; break; }
  // 拋物線內插求小數週期
  let p = pick; if (pick > lagMin && pick < lagMax) { const a = r[pick - 1], b = r[pick], c = r[pick + 1], d = a - 2 * b + c; if (Math.abs(d) > 1e-12) p = pick + 0.5 * (a - c) / d; }
  return { period: p, strength: r[pick] };
}

function seamError(x, start, end) { // 比較 loop 結尾往前一段與開頭往前一段(接回去的連續性),差越小越無縫
  const W = Math.min(64, start, end - start); if (W < 8) return 1; let d = 0, e = 0;
  for (let i = 1; i <= W; i++) { const a = x[end - i], b = x[start - i]; d += (a - b) * (a - b); e += a * a + b * b; }
  const slope = Math.abs((x[end] || 0) - (x[start] || 0)); // 接縫兩點的落差
  return Math.min(1, Math.sqrt(d / (e + 1e-9)) + slope * 2);
}

function nextUpCross(x, i, limit) { for (; i < limit; i++) if (x[i - 1] <= 0 && x[i] > 0) return i; return -1; }

// opts.lo／opts.hi:搜尋範圍(預設樣本的 55%~90%,給了就在範圍內找,且偏好最早的好 loop,因為 loop 結尾之後的資料都會被丟掉)
function findLoop(x, sr, opts) {
  opts = opts || {}; const minLoop = Math.floor(sr * (opts.minLoopSec || 0.12)), maxLoop = Math.floor(sr * (opts.maxLoopSec || 0.5));
  const per = findPeriod(x, sr, opts); if (per.strength < (opts.minStrength || 0.9) || per.period < 2) return null;
  const P = per.period, ranged = opts.lo != null; const lo = ranged ? opts.lo : Math.floor(x.length * 0.55), hi = Math.min(x.length - 1, ranged ? opts.hi : Math.floor(x.length * 0.9));
  const k0 = Math.max(1, Math.ceil(minLoop / P)); let best = null; const step = Math.max(1, Math.floor(P / 4));
  const win = ranged ? Math.max(P * 6, (hi - lo) * 0.35) : hi - lo;   // 有範圍時只看開頭附近的結尾候選(越早越省)
  for (let k = k0; k <= k0 + 3; k++) {
    const L = k * P; if (L > maxLoop && k > k0) break;
    for (let e = Math.floor(lo + L); e < Math.min(hi, lo + L + win); e += step) {
      const end = nextUpCross(x, e, hi); if (end < 0) continue; const startF = end - L;
      const start = nextUpCross(x, Math.max(1, Math.round(startF) - Math.ceil(P / 2)), Math.round(startF) + Math.ceil(P / 2)); if (start < Math.max(64, lo)) continue;
      const err = seamError(x, start, end) + (ranged ? 0.02 * (end - lo) / Math.max(1, hi - lo) : 0);   // 同樣好時偏好早的
      if (!best || err < best.err) best = { start, end, err, raw: seamError(x, start, end) };
    }
  }
  if (!best) return null; const score = 1 - best.raw; if (score < (opts.minScore || 0.8)) return null;
  return { start: best.start, end: best.end, score, periods: (best.end - best.start) / P, period: P };
}

// 持續音:後半段能量還有前半段(起音後)的 40% 以上;打擊／撥奏音後半段會明顯衰減
function isSustained(x, sr) {
  if (x.length < sr * 0.4) return false; const a = Math.floor(x.length * 0.15), m = Math.floor(x.length * 0.5);
  const e1 = rms(x, a, m), e2 = rms(x, m, Math.floor(x.length * 0.9)); return e1 > 1e-4 && e2 / e1 >= 0.4;
}

function resample(x, ratio, taps) {
  if (ratio >= 1) return x; taps = taps || 16; const n = Math.floor(x.length * ratio), out = new Float32Array(n), fc = 0.45 * ratio; // 截止(相對原取樣率)
  for (let i = 0; i < n; i++) {
    const c = i / ratio; let s = 0, w = 0; const a = Math.ceil(c - taps / ratio * 0.5), b = Math.floor(c + taps / ratio * 0.5);
    for (let j = a; j <= b; j++) { if (j < 0 || j >= x.length) continue; const t = j - c, sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t); const win = 0.5 + 0.5 * Math.cos(Math.PI * t * ratio / (taps * 0.5)); const k = sinc * win; s += x[j] * k; w += k; }
    out[i] = w ? s / w : 0;
  }
  return out;
}

// ── 波形門檻(每個被改動的樣本都要過):把原樣本與改過的樣本各「照 loop 播放」一段,比 11 kHz 以下的對數頻譜與頻譜重心 ──
function fftInPlace(re, im) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } } for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const xr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, xi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr; re[i + k + len / 2] = re[i + k] - xr; im[i + k + len / 2] = im[i + k] - xi; re[i + k] += xr; im[i + k] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } }
function playLooped(x, sl, el, n) { const out = new Float32Array(n), looped = el > sl + 8 && el <= x.length; for (let i = 0, p = 0; i < n; i++) { if (looped && p >= el) p = sl + ((p - sl) % (el - sl)); if (p >= x.length) break; out[i] = x[p++]; } return out; }
const FB = 20; // 60 Hz ~ 11 kHz 的對數頻帶
function bandSpec(y, rate, off) { const N = 4096, re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) re[i] = (y[off + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); fftInPlace(re, im); const b = new Float64Array(FB); let cs = 0, tot = 0; for (let k = 1; k < N / 2; k++) { const f = k * rate / N, p = re[k] * re[k] + im[k] * im[k]; if (f > 11000) continue; tot += p; cs += p * f; const bi = Math.floor(FB * Math.log(Math.max(f, 60) / 60) / Math.log(11000 / 60)); if (f >= 60 && bi >= 0 && bi < FB) b[bi] += p; } return { b: Array.from(b, (e) => 10 * Math.log10(e + 1e-12)), cen: cs / (tot + 1e-12) }; }
// 回 { ok, dist, cShift }:dist 是 11 kHz 以下平均頻帶差(dB,低於峰值 70 dB 的頻帶不計),cShift 是重心位移比例
function fidelity(a, aHdr, aRate, b, bHdr, bRate) {
  const secs = 2.0, aLoop = aHdr.endLoop > aHdr.startLoop + 8; const lenSec = a.length / aRate, win = aLoop ? secs : Math.min(secs, lenSec - 0.05); if (win < 0.25) return { ok: true, dist: 0, cShift: 0, skipped: true };
  const ya = playLooped(a, aHdr.startLoop, aHdr.endLoop, Math.ceil(secs * aRate)), yb = playLooped(b, bHdr.startLoop, bHdr.endLoop, Math.ceil(secs * bRate));
  let dist = 0, cs = 0, cnt = 0; const t0 = Math.min(0.25, win / 2);
  for (let t = t0; t + 4096 / Math.min(aRate, bRate) <= win; t += 0.2) { const sa = bandSpec(ya, aRate, Math.floor(t * aRate)), sb = bandSpec(yb, bRate, Math.floor(t * bRate)), pk = Math.max.apply(null, sa.b); let d = 0, n = 0; for (let k = 0; k < FB; k++) { const fl = pk - 70; d += Math.abs(Math.max(sa.b[k], fl) - Math.max(sb.b[k], fl)); n++; } dist = Math.max(dist, d / n); cs = Math.max(cs, Math.abs(sb.cen - sa.cen) / (sa.cen + 1e-9)); cnt++; }
  return { ok: cnt === 0 || (dist <= 3 && cs <= 0.08), dist, cShift: cs };
}
// 高頻內容:11 kHz 以上的功率占比(dB 相對全部);小於 -35 表示降到 22 kHz 取樣也沒什麼損失
function hfShare(x, sr) { if (sr <= 22050 || x.length < 4096) return -99; const N = 4096; let hf = 0, tot = 0; for (let off = 0; off + N <= x.length; off += N * 2) { const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) re[i] = x[off + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); fftInPlace(re, im); for (let k = 1; k < N / 2; k++) { const p = re[k] * re[k] + im[k] * im[k]; tot += p; if (k * sr / N > 11000) hf += p; } } return 10 * Math.log10((hf + 1e-12) / (tot + 1e-12)); }

const GUARD = 48; // loop 結尾後保留的點數(插值用)
// 規則:① 已有 loop → 截掉結尾後的資料;太長且有週期 → 只留整數個週期;② 沒有 loop 的持續音 → 試著找一個;③ 打擊音不動;④ 之後才降取樣
function slim(x, sr, hdr, opts) {
  opts = opts || {}; let data = x, sl = hdr.startLoop | 0, el = hdr.endLoop | 0, action = 'keep'; const hasLoop = el > sl + 8 && el <= x.length;
  if (hasLoop) {
    const len = el - sl, maxLoop = Math.floor(sr * (opts.maxLoopSec || 0.4));
    if (len > maxLoop * 1.2) { const lp = findLoop(x, sr, Object.assign({}, opts, { lo: sl + Math.floor(sr * 0.01), hi: el })); if (lp && lp.end < el - sr * 0.05) { sl = lp.start; el = lp.end; action = 'shorten-loop'; } }
    const cut = Math.min(x.length, el + GUARD); if (cut < x.length) { data = x.subarray(0, cut); action = action === 'keep' ? 'cut-tail' : action; }
  } else if (isSustained(x, sr)) {
    const lp = findLoop(x, sr, opts); if (lp) { sl = lp.start; el = lp.end; data = x.subarray(0, Math.min(x.length, el + GUARD)); action = 'add-loop'; }
  }
  if (action !== 'keep' && !opts.noGuard) { const g = fidelity(x, { startLoop: hasLoop ? (hdr.startLoop | 0) : 0, endLoop: hasLoop ? (hdr.endLoop | 0) : 0 }, sr, data, { startLoop: sl, endLoop: el }, sr); if (!g.ok) { data = x; sl = hdr.startLoop | 0; el = hdr.endLoop | 0; action = 'reverted(' + action + ')'; } }
  let rate = sr, keepHi = false;
  if (opts.maxRate && sr > opts.maxRate && opts.hiShareDb != null && hfShare(data, sr) > opts.hiShareDb) keepHi = true; // 分級取樣率:高頻內容多的(鈸、踩鑔、銅管)不降
  if (opts.maxRate && sr > opts.maxRate && !keepHi) { const ratio = opts.maxRate / sr; data = resample(data, ratio); sl = Math.round(sl * ratio); el = Math.round(el * ratio); rate = opts.maxRate; action += '+down'; }
  return { data, hdr: { startLoop: sl, endLoop: el, rate }, action };
}

module.exports = { fidelity, hfShare, findPeriod, findLoop, seamError, isSustained, resample, slim, GUARD };
