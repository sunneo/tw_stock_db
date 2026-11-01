// 音樂領域階段 5:mp3 → MIDI 的「不依賴大模型」部分(純函式,全部可用合成音訊測試)。
//   drumHits(x, sr)                 → [{ t, note, vel }]  鼓軌規則拆解:偵測打擊起點,依頻帶能量分底鼓／小鼓／踩鑔(閉／開)／通鼓／鈸,對應 GM 鼓組音符
//   pitchTrack(x, sr)               → { f0:Float32Array, hop, voiced:Uint8Array, rms:Float32Array }  單音音高追蹤(YIN 類),給貝斯與人聲
//   framesToNotes(track, opts)      → [{ t, d, n, v }](秒、秒、MIDI 音高、力度)  音高幀 → 音符(中值平滑、切音、去掉太短的)
//   estimateTempo(times)            → { bpm, offset }  由打擊起點的間隔統計速度(折到 70~180)
//   quantize(notes, bpm, grid)      → 音符時間換成拍(以 ppq 為單位的 tick),並量化
//   labelToProgram(label)           → GM 音色編號 | null  樂器分類標籤(YAMNet 之類)對應 GM 音色;對不上回 null,呼叫端改用 rangeProgram
//   rangeProgram(notes)             → GM 音色編號  分類不準時的最後退路:依音域
//   buildSong(parts, opts)          → FaMidi 曲子  把各分軌的音符組成多軌 MIDI
// 模型端(Demucs 分軌、Basic Pitch 多音轉譜、YAMNet 分類)是可插拔的:這裡只規定它們交出來的資料形狀(音符清單、標籤),不含模型本身。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./midi_core.js')); else root.FaAudioToMidi = factory(root.FaMidi || (typeof FaMidi !== 'undefined' ? FaMidi : undefined)); })(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';
  function fft(re, im) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } } for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const c = Math.cos(a * k), s = Math.sin(a * k), xr = re[i + k + len / 2] * c - im[i + k + len / 2] * s, xi = re[i + k + len / 2] * s + im[i + k + len / 2] * c; re[i + k + len / 2] = re[i + k] - xr; im[i + k + len / 2] = im[i + k] - xi; re[i + k] += xr; im[i + k] += xi; } } }
  function spectrum(x, off, N) { const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) re[i] = (x[off + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); fft(re, im); const mag = new Float64Array(N / 2); for (let k = 0; k < N / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]); return mag; }
  const bandE = (mag, sr, N, f0, f1) => { let e = 0; for (let k = Math.max(1, Math.floor(f0 * N / sr)); k < Math.min(mag.length, Math.ceil(f1 * N / sr)); k++) e += mag[k] * mag[k]; return e; };

  // 打擊起點:頻譜通量(只算增加的能量)的局部峰;回傳秒
  function onsets(x, sr, opt) {
    opt = opt || {}; const N = 1024, hop = 256, minGap = opt.minGap || 0.05; const frames = Math.max(0, Math.floor((x.length - N) / hop)); const flux = new Float64Array(frames); let prev = null;
    for (let f = 0; f < frames; f++) { const m = spectrum(x, f * hop, N); if (prev) { let s = 0; for (let k = 1; k < m.length; k++) { const d = Math.log(1 + 20 * m[k]) - Math.log(1 + 20 * prev[k]); if (d > 0) s += d; } flux[f] = s; } prev = m; }
    let mean = 0; for (let f = 0; f < frames; f++) mean += flux[f]; mean /= Math.max(1, frames); const th = mean * (opt.k || 2.2) + 1e-6, out = []; let last = -1;
    for (let f = 2; f < frames - 2; f++) if (flux[f] > th && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1] && flux[f] >= flux[f - 2] && flux[f] >= flux[f + 2]) { const t = (f * hop + N / 2) / sr; if (t - last >= minGap) { out.push({ t, s: flux[f] }); last = t; } }
    return out;
  }

  function drumHits(x, sr) {
    const N = 2048, hits = []; const ons = onsets(x, sr, { minGap: 0.04 }); const maxS = Math.max.apply(null, ons.map((o) => o.s).concat([1e-6]));
    ons.forEach((o, oi) => {
      const off = Math.max(0, Math.floor(o.t * sr) - 128); const m = spectrum(x, off, N);
      const lo = bandE(m, sr, N, 30, 150), mid = bandE(m, sr, N, 150, 2000), hi = bandE(m, sr, N, 5000, 16000), tot = lo + mid + hi + 1e-12;
      // 衰減:起點後 250 ms 的能量相對起點後 40 ms 的能量(長 → 開踩鑔／鈸)
      const e = (a, b) => { let s = 0; const i0 = Math.floor((o.t + a) * sr), i1 = Math.floor((o.t + b) * sr); for (let i = i0; i < Math.min(i1, x.length); i++) s += x[i] * x[i]; return s / Math.max(1, i1 - i0); };
      const gap = Math.min(0.3, (oi + 1 < ons.length ? ons[oi + 1].t - o.t : 0.3) - 0.01); const decay = gap < 0.08 ? 0 : e(gap * 0.6, gap) / (e(0, 0.04) + 1e-12); // 只看到下一個打擊之前
      let flat = 0, cnt = 0, lg = 0, am = 0; for (let k = Math.floor(300 * N / sr); k < Math.floor(8000 * N / sr); k++) { lg += Math.log(m[k] + 1e-9); am += m[k]; cnt++; } flat = Math.exp(lg / cnt) / (am / cnt + 1e-9); // 越接近 1 越像雜訊
      const rl = lo / tot, rm = mid / tot, rh = hi / tot; let note;
      if (rl > 0.6) note = 36;                                   // 底鼓:低頻佔大宗
      else if (rh > 0.7 && decay > 0.08) note = decay > 0.25 ? 49 : 46; // 高頻長衰減:開踩鑔／鈸
      else if (rh > 0.7) note = 42;                             // 高頻短:閉踩鑔
      else if (flat > 0.2 && rm > 0.2) note = 38;               // 中頻寬頻雜訊:小鼓
      else if (rl > 0.25 && flat <= 0.25) note = 45;             // 有音高的中低頻:通鼓
      else note = 38;
      hits.push({ t: o.t, note, vel: Math.max(30, Math.min(127, Math.round(40 + 87 * o.s / maxS))) });
    });
    return hits;
  }

  // YIN:差值函式＋累積平均正規化,取第一個低於門檻的谷
  function pitchTrack(x, sr, opt) {
    opt = opt || {}; const fmin = opt.fmin || 40, fmax = opt.fmax || 1100, hopS = opt.hop || 0.01, W = Math.floor(sr * 0.04), hop = Math.floor(sr * hopS), thr = opt.thr || 0.15;
    const tauMin = Math.floor(sr / fmax), tauMax = Math.min(Math.floor(sr / fmin), W); const n = Math.max(0, Math.floor((x.length - W - tauMax) / hop)); const f0 = new Float32Array(n), voiced = new Uint8Array(n), rms = new Float32Array(n); const d = new Float64Array(tauMax + 1), cm = new Float64Array(tauMax + 1);
    for (let f = 0; f < n; f++) {
      const o = f * hop; let e = 0; for (let i = 0; i < W; i++) e += x[o + i] * x[o + i]; rms[f] = Math.sqrt(e / W); if (rms[f] < 0.005) continue;
      for (let tau = 1; tau <= tauMax; tau++) { let s = 0; for (let i = 0; i < W; i++) { const df = x[o + i] - x[o + i + tau]; s += df * df; } d[tau] = s; }
      let run = 0; cm[0] = 1; for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; cm[tau] = run ? d[tau] * tau / run : 1; }
      let best = -1; for (let tau = tauMin; tau < tauMax; tau++) if (cm[tau] < thr) { while (tau + 1 < tauMax && cm[tau + 1] < cm[tau]) tau++; best = tau; break; }
      if (best < 0) continue; const a = cm[best - 1], b = cm[best], c = cm[best + 1], den = a - 2 * b + c, p = Math.abs(den) > 1e-12 ? best + 0.5 * (a - c) / den : best; f0[f] = sr / p; voiced[f] = 1;
    }
    return { f0, voiced, rms, hop: hopS, delay: W / sr / 2 };
  }
  const hz2midi = (f) => 69 + 12 * Math.log2(f / 440);

  function framesToNotes(tr, opt) {
    opt = opt || {}; const minDur = opt.minDur || 0.06, jump = opt.jump || 0.8; const m = new Float32Array(tr.f0.length); for (let i = 0; i < m.length; i++) m[i] = tr.voiced[i] ? hz2midi(tr.f0[i]) : NaN;
    const sm = new Float32Array(m.length); for (let i = 0; i < m.length; i++) { const w = []; for (let j = Math.max(0, i - 2); j <= Math.min(m.length - 1, i + 2); j++) if (!isNaN(m[j])) w.push(m[j]); w.sort((a, b) => a - b); sm[i] = w.length >= 3 ? w[w.length >> 1] : NaN; }
    const notes = []; let cur = null; const close = (end) => { if (cur && (end - cur.s) * tr.hop >= minDur) { const ps = cur.ps.slice().sort((a, b) => a - b), med = ps[ps.length >> 1]; const rm = cur.rm / cur.ps.length; notes.push({ t: cur.s * tr.hop + (tr.delay || 0), d: (end - cur.s) * tr.hop, n: Math.round(med), v: Math.max(30, Math.min(120, Math.round(35 + 400 * rm))) }); } cur = null; };
    for (let i = 0; i < sm.length; i++) {
      const p = sm[i]; if (isNaN(p)) { close(i); continue; }
      if (cur && Math.abs(p - cur.ps[cur.ps.length >> 1]) > jump && Math.abs(Math.round(p) - Math.round(cur.ps[cur.ps.length >> 1])) >= 1) { // 音高換了:要連續兩幀都在新的音高才切
        if (i + 1 < sm.length && Math.abs(sm[i + 1] - p) < jump) close(i); }
      if (!cur) cur = { s: i, ps: [], rm: 0 }; cur.ps.push(p); cur.rm += tr.rms[i];
    }
    close(sm.length); return notes;
  }

  function estimateTempo(times) {
    if (times.length < 4) return { bpm: 120, offset: 0, confident: false }; const hist = new Float64Array(200); // 以 bpm 為索引,0.5 bpm 解析度太細就用整數
    for (let i = 0; i < times.length; i++) for (let j = i + 1; j < Math.min(times.length, i + 6); j++) { let ioi = times[j] - times[i]; if (ioi < 0.2) continue; let bpm = 60 / ioi; while (bpm < 70) bpm *= 2; while (bpm > 180) bpm /= 2; const k = Math.round(bpm); for (let d = -1; d <= 1; d++) if (hist[k + d] !== undefined && k + d >= 0) hist[k + d] += d === 0 ? 1 : 0.5; }
    let best = 70; for (let k = 70; k <= 180; k++) if (hist[k] > hist[best]) best = k; const tot = hist.reduce((s, v) => s + v, 0) || 1;
    const beat = 60 / best; let offset = times[0] % beat; return { bpm: best, offset, confident: hist[best] / tot > 0.08 };
  }

  function quantize(notes, bpm, ppq, gridBeats, offset) {
    ppq = ppq || 480; const g = Math.max(1, Math.round(ppq * (gridBeats || 0.25))), secPerBeat = 60 / bpm; offset = offset || 0;
    return notes.map((n) => { const tb = (n.t - offset) / secPerBeat; const t = Math.max(0, Math.round(tb * ppq / g) * g); const d = Math.max(g, Math.round(n.d / secPerBeat * ppq / g) * g); return Object.assign({}, n, { tick: t, dtick: d }); });
  }

  const LABELS = [[/piano/i, 0], [/electric piano|rhodes|keyboard/i, 4], [/organ/i, 19], [/accordion/i, 21], [/harmonica/i, 22], [/electric guitar/i, 27], [/acoustic guitar|steel guitar|guitar/i, 25], [/distortion|heavy/i, 30], [/bass/i, 33], [/violin|fiddle/i, 40], [/viola/i, 41], [/cello/i, 42], [/string|orchestra/i, 48], [/harp/i, 46], [/choir|chorus|vocal|voice|singing/i, 52], [/trumpet/i, 56], [/trombone/i, 57], [/tuba/i, 58], [/french horn|horn/i, 60], [/brass/i, 61], [/saxophone|sax/i, 65], [/oboe/i, 68], [/clarinet/i, 71], [/flute/i, 73], [/pan flute|recorder|whistl/i, 75], [/synthesizer|synth/i, 80], [/marimba|xylophone|vibraphone|glockenspiel|bell/i, 12], [/banjo/i, 105], [/sitar/i, 104]];
  function labelToProgram(label) { label = String(label || ''); for (const [re, p] of LABELS) if (re.test(label)) return p; return null; }
  function rangeProgram(notes) { if (!notes.length) return 0; const ps = notes.map((n) => n.n).sort((a, b) => a - b), med = ps[ps.length >> 1]; return med < 45 ? 33 : med < 60 ? 0 : med < 84 ? 80 : 73; }

  // parts: { drums:[{t,note,vel}], bass:[notes], vocals:[notes], other:[{ name, program?, label?, notes }] };notes 都是 { t(秒), d(秒), n, v }
  function buildSong(parts, opts) {
    opts = opts || {}; const all = [].concat(parts.drums ? parts.drums.map((h) => h.t) : [], (parts.bass || []).map((n) => n.t), (parts.vocals || []).map((n) => n.t)); const tempo = opts.bpm ? { bpm: opts.bpm, offset: opts.offset || 0 } : estimateTempo(all);
    let s = M.emptySong(); s.tempos = [{ t: 0, bpm: tempo.bpm }]; s.title = opts.title || '從音訊轉出'; const ppq = s.ppq, grid = opts.grid || 0.25;
    const add = (name, program, drum, notes) => { if (!notes.length) return; s = M.addTrack(s, name, program, drum); const ti = s.tracks.length - 1; quantize(notes, tempo.bpm, ppq, grid, tempo.offset).forEach((q) => { s = M.addNote(s, ti, { t: q.tick, d: q.dtick, n: q.n, v: q.v || 90 }); }); };
    if (parts.vocals) add('人聲(旋律)', 52, false, parts.vocals.filter((n) => n.n >= 36 && n.n <= 96));
    (parts.other || []).forEach((o, i) => add(o.name || '其他 ' + (i + 1), o.program != null ? o.program : (labelToProgram(o.label) != null ? labelToProgram(o.label) : rangeProgram(o.notes)), false, o.notes));
    if (parts.bass) add('貝斯', 33, false, parts.bass.filter((n) => n.n >= 24 && n.n <= 60));
    if (parts.drums && parts.drums.length) add('鼓', 0, true, parts.drums.map((h) => ({ t: h.t, d: 0.1, n: h.note, v: h.vel })));
    return { song: M.validate(s), tempo };
  }
  return { onsets, drumHits, pitchTrack, framesToNotes, estimateTempo, quantize, labelToProgram, rangeProgram, buildSong, hz2midi };
});
