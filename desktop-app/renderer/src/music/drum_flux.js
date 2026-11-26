// 音訊轉 MIDI 的鼓軌(階段二):不下載任何模型,用頻譜變化量找鼓的打擊。
// 三個頻段各算一條「頻譜通量」(頻譜增加量,對數壓縮後只計增加):大鼓 40–160 Hz、小鼓 180–1500 Hz、踩鑔 6000–10000 Hz。
//   挑峰:與歌曲自己的局部中位數比(自適應),再加整首 90 百分位的一小段底線;相鄰打擊至少 60 毫秒。
//   大鼓能量外溢到小鼓頻段的部分先扣掉(BLEED),避免大鼓被誤認成小鼓。
//   存在檢查(整首有沒有鼓):因為挑峰是跟歌曲自己比,獨奏鋼琴也會找到「擊打」,所以還要看三件事:
//     打擊夠多(MIN_HITS)、打擊間隔有規律(REG_MIN)、能量集中在打擊時刻附近(CONC_MIN)。三件都要過才輸出鼓軌。
// 輸入:單聲道取樣(Float32Array)與取樣率;非 22050 Hz 會先線性降取樣到 22050。輸出音符用 GM 鼓音高:大鼓 36、小鼓 38、踩鑔 42。
// 注意:這是規則做法,沒有模型辨識樂器;規律的鋼琴曲仍可能被誤判為有鼓,真實樣本的表現待驗證。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDrumFlux = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const WORK_SR = 22050, N = 1024, HOP = 256;
  const BANDS = { kick: [40, 160], snare: [180, 1500], hat: [6000, 10000] };
  const GM = { kick: 36, snare: 38, hat: 42 };
  const LOG_GAIN = 100;        // 對數壓縮的增益(幅度先除以 N)
  const LOCAL_SEC = 0.5;       // 自適應門檻的局部視窗(每側秒數)
  const MULT = 1.6;            // 峰值要超過局部中位數的倍數
  const FLOOR_FRAC = 0.02;     // 峰值至少要有本頻段最大峰值的這個比例(濾掉尾音裡的微小起伏;靜音多時百分位底線太小,不用它)
  const MIN_GAP_SEC = 0.06;    // 相鄰打擊的最小間隔(秒)
  const BLEED = 0.4;           // 大鼓流入小鼓頻段的扣除比例
  const MIN_HITS = 8;          // 大鼓加小鼓的打擊至少這麼多下才算有鼓
  const REG_TOL = 0.06;        // 間隔與規律週期倍數的相對容差
  const REG_MIN = 0.6;         // 規律間隔佔全部間隔的比例下限
  const CONC_MIN = 2.0;        // 能量集中倍率下限(打擊時刻附近的能量比例 ÷ 那段時間佔全曲的比例)
  const NEAR_BEFORE = 1, NEAR_AFTER = 8; // 「打擊時刻附近」:打擊前 1 格到後 8 格(約 93 毫秒)
  const STRONG_FRAC = 0.1;     // 峰值至少要有本頻段最大峰值的 10% 才算打擊(噪音造成的小起伏在 2%~8%,實測)
  const SAME_HIT_FRAMES = 3;   // 大鼓與小鼓的峰值距離在這之內視為同一個打擊,只留較強者(大鼓的低頻會洩漏到小鼓時刻)

  // 預先算好的 FFT 表(N 固定)
  const COS = new Float64Array(N / 2), SIN = new Float64Array(N / 2), REV = new Uint32Array(N), WIN = new Float64Array(N);
  for (let k = 0; k < N / 2; k++) { COS[k] = Math.cos(-2 * Math.PI * k / N); SIN[k] = Math.sin(-2 * Math.PI * k / N); }
  for (let i = 0, bits = Math.log2(N); i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); REV[i] = r; }
  for (let i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  function fft(re, im) {
    for (let i = 0; i < N; i++) { const j = REV[i]; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let start = 0; start < N; start += size) for (let k = 0; k < half; k++) {
        const wr = COS[k * step], wi = SIN[k * step], a = start + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
  function toWork(x, sr) {
    if (sr === WORK_SR) return x;
    const n = Math.floor(x.length * WORK_SR / sr), o = new Float32Array(n), k = sr / WORK_SR;
    for (let i = 0; i < n; i++) { const a = i * k, i0 = Math.floor(a), i1 = Math.min(x.length - 1, i0 + 1), f = a - i0; o[i] = x[Math.min(x.length - 1, i0)] * (1 - f) + x[i1] * f; }
    return o;
  }
  const binRange = (name) => { const [f0, f1] = BANDS[name], sr = WORK_SR; return [Math.max(1, Math.ceil(f0 * N / sr)), Math.min(N / 2 - 1, Math.floor(f1 * N / sr))]; };

  // 逐格算三個頻段的通量與能量。回傳 { flux: {kick,snare,hat}, energy: {kick,snare,hat}, frames }
  function analyze(x) {
    const F = x.length >= N ? Math.floor((x.length - N) / HOP) + 1 : 0;
    const names = Object.keys(BANDS), ranges = {}; names.forEach((b) => { ranges[b] = binRange(b); });
    const flux = {}, energy = {}; names.forEach((b) => { flux[b] = new Float64Array(F); energy[b] = new Float64Array(F); });
    const re = new Float64Array(N), im = new Float64Array(N), prev = new Float64Array(N / 2), mag = new Float64Array(N / 2);
    for (let f = 0; f < F; f++) {
      const off = f * HOP; for (let i = 0; i < N; i++) { re[i] = x[off + i] * WIN[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < N / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / N;
      for (const b of names) {
        const [k0, k1] = ranges[b]; let fl = 0, en = 0;
        for (let k = k0; k <= k1; k++) {
          const d = Math.log(1 + LOG_GAIN * mag[k]) - Math.log(1 + LOG_GAIN * prev[k]); if (d > 0) fl += d;
          en += mag[k] * mag[k];
        }
        flux[b][f] = fl; energy[b][f] = en;
      }
      for (let k = 0; k < N / 2; k++) prev[k] = mag[k];
    }
    return { flux, energy, frames: F };
  }

  // 自適應挑峰:局部中位數 × MULT ＋ 整首 90 百分位的底線;局部最大;相鄰打擊最小間隔(強者留下)。回傳 [{ f, v }] 依時間排序
  function pickPeaks(O, sr) {
    const F = O.length; if (F < 5) return [];
    const W = Math.max(2, Math.round(LOCAL_SEC * sr / HOP)), gap = Math.max(1, Math.round(MIN_GAP_SEC * sr / HOP));
    let maxO = 0; for (let f = 0; f < F; f++) if (O[f] > maxO) maxO = O[f];
    const floor = FLOOR_FRAC * maxO;
    const cand = [];
    for (let f = 2; f < F - 2; f++) {
      const v = O[f]; if (v <= 0) continue;
      if (!(v >= O[f - 1] && v >= O[f + 1] && v >= O[f - 2] && v >= O[f + 2])) continue;
      const win = Float64Array.from(O.subarray(Math.max(0, f - W), Math.min(F, f + W + 1))).sort();
      const med = win[win.length >> 1];
      if (v > MULT * med + floor) cand.push({ f, v });
    }
    cand.sort((a, b) => b.v - a.v); const taken = [];
    for (const c of cand) { if (!taken.some((t) => Math.abs(t.f - c.f) < gap)) taken.push(c); }
    return taken.sort((a, b) => a.f - b.f);
  }

  // 存在檢查:打擊夠多、間隔有規律、能量集中在打擊時刻附近。回傳 { ok, reason, stats }
  function presence(kickP, snareP, eK, eS, sr) {
    const F = eK.length, times = kickP.concat(snareP).map((p) => p.f).sort((a, b) => a - b);
    if (times.length < MIN_HITS) return { ok: false, reason: '大鼓加小鼓的打擊只有 ' + times.length + ' 下(需要 ' + MIN_HITS + ' 下以上)', stats: { hits: times.length } };
    const ioi = []; for (let i = 1; i < times.length; i++) { const s = (times[i] - times[i - 1]) * HOP / sr; if (s >= 0.1 && s <= 2.0) ioi.push(s); }
    if (ioi.length < MIN_HITS - 1) return { ok: false, reason: '打擊間隔太少無法判斷節奏', stats: { hits: times.length } };
    // 規律週期:間隔直方圖(10 毫秒一格),三格平滑後取最高者
    const bins = new Float64Array(200); for (const s of ioi) bins[Math.min(199, Math.floor(s / 0.01))] += 1;
    let best = 0, bi = 0; for (let i = 1; i < 199; i++) { const v = bins[i - 1] + bins[i] + bins[i + 1]; if (v > best) { best = v; bi = i; } }
    const P = (bi + 0.5) * 0.01;
    const regular = ioi.filter((s) => [0.5, 1, 2, 3, 4].some((k) => Math.abs(s - k * P) <= REG_TOL * k * P)).length / ioi.length;
    // 能量集中:打擊前後一小段(NEAR_BEFORE..NEAR_AFTER)佔全曲能量的比例 ÷ 這段佔全部格數的比例
    const near = new Uint8Array(F); let total = 0, nearE = 0, allE = 0;
    for (const f of times) for (let g = Math.max(0, f - NEAR_BEFORE); g <= Math.min(F - 1, f + NEAR_AFTER); g++) near[g] = 1;
    for (let f = 0; f < F; f++) { const e = eK[f] + eS[f]; allE += e; if (near[f]) { nearE += e; total++; } }
    const frac = total / Math.max(1, F), conc = allE > 0 && frac > 0 ? (nearE / allE) / frac : 0;
    const stats = { hits: times.length, periodSec: Math.round(P * 1000) / 1000, regular: Math.round(regular * 100) / 100, concentration: Math.round(conc * 100) / 100 };
    if (regular < REG_MIN) return { ok: false, reason: '打擊間隔沒有規律(' + Math.round(regular * 100) + '%),不像鼓', stats };
    if (conc < CONC_MIN) return { ok: false, reason: '能量沒有集中在打擊時刻(倍率 ' + stats.concentration + '),不像鼓', stats };
    return { ok: true, reason: '節奏規律、能量集中', stats };
  }

  // 同一時刻(SAME_HIT_FRAMES 內)的大鼓與小鼓峰值只留較強的一個(相對各自頻段的最大峰值比較)。回傳 { kick, snare }
  function resolveKickSnare(kick, snare) {
    const items = kick.map((p) => ({ p, kind: 'kick' })).concat(snare.map((p) => ({ p, kind: 'snare' }))).sort((a, b) => a.p.f - b.p.f);
    const dropped = new Set(); let last = null;
    for (const it of items) {
      if (last && it.p.f - last.p.f <= SAME_HIT_FRAMES && last.kind !== it.kind) {
        if (it.p.s > last.p.s) { dropped.add(last.p); last = it; } else dropped.add(it.p);
        continue;
      }
      last = it;
    }
    return { kick: kick.filter((p) => !dropped.has(p)), snare: snare.filter((p) => !dropped.has(p)) };
  }

  // 主入口。回傳 { present, reason, hits:[{t,note,vel}], stats }
  function detect(x, sr) {
    sr = sr || WORK_SR; const w = toWork(x || new Float32Array(0), sr);
    if (w.length < N * 4) return { present: false, reason: '取樣太短', hits: [], stats: {} };
    const A = analyze(w); const F = A.frames;
    // 大鼓外溢到小鼓頻段的部分先扣掉
    const snareF = new Float64Array(F); for (let f = 0; f < F; f++) snareF[f] = Math.max(0, A.flux.snare[f] - BLEED * A.flux.kick[f]);
    const rel = (ps) => { const mx = ps.reduce((m, p) => Math.max(m, p.v), 1e-12); return ps.map((p) => ({ f: p.f, v: p.v, s: p.v / mx })); };
    const kickAll = rel(pickPeaks(A.flux.kick, WORK_SR)), snareAll = rel(pickPeaks(snareF, WORK_SR)), hatAll = rel(pickPeaks(A.flux.hat, WORK_SR));
    const resolved = resolveKickSnare(kickAll, snareAll);
    const strong = (ps) => ps.filter((p) => p.s >= STRONG_FRAC);
    const kickP = strong(resolved.kick), snareP = strong(resolved.snare), hatP = strong(hatAll);
    const pres = presence(kickP, snareP, A.energy.kick, A.energy.snare, WORK_SR);
    if (!pres.ok) return { present: false, reason: pres.reason, hits: [], stats: pres.stats };
    const hits = [];
    const add = (ps, note) => { for (const p of ps) hits.push({ t: (p.f * HOP + N / 2) / WORK_SR, note, vel: Math.max(30, Math.min(127, Math.round(40 + 87 * p.s))) }); };
    add(kickP, GM.kick); add(snareP, GM.snare); add(hatP, GM.hat);
    hits.sort((a, b) => a.t - b.t || a.note - b.note);
    const stats = Object.assign({}, pres.stats, { kick: kickP.length, snare: snareP.length, hat: hatP.length });
    return { present: true, reason: '頻譜法偵測到鼓:大鼓 ' + kickP.length + '、小鼓 ' + snareP.length + '、踩鑔 ' + hatP.length + ' 下', hits, stats };
  }

  return { detect, analyze, pickPeaks, presence, GM, BANDS, MIN_HITS, REG_MIN, CONC_MIN, MULT, BLEED, WORK_SR };
});
