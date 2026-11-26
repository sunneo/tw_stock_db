// 音訊轉 MIDI 的音符後處理(階段一)。全部是純函式:輸入輸出都是音符清單 { t(秒), d(秒), n(MIDI 音高), v(力度 0~127) }。
// 規則一覽(門檻都是下方的具名常數):
//   joinSplitNotes     顫音、抖音、鼓聲造成的假起音不切斷長音;只有起音夠明顯才切開
//   alignChordOnsets   60 毫秒內起始的各音對齊到中間值(和弦各音同時發聲),持續時間跟著調整
//   enforceMinLength   最短音:至少 4 格;不到 8 格必須有明顯起音
//   melodyFlags        旋律線:每個音的中點看同時在響的音,最高的那個算頂線;連續 3 個以上才成立
//   emphasizeMelody    旋律音量拉高、背景小音降低
//   simplifyForMode    'melody' 只留旋律;'chords' 旋律加和弦(從已轉出的音符分類,不重跑模型)
//   stereoToMono       左右強烈反相時改取較有資訊的聲道,不平均成靜音
//   evidenceFromActivations  由 Basic Pitch 的起音矩陣與啟動矩陣,給每個音一份「起音證據」
//   postprocess        依序套用上面的規則(給 audio_pipeline 用)
// 「格」= Basic Pitch 的一幀,256 個樣本 ÷ 22050 Hz ≈ 11.6 毫秒。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaNotePost = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const FRAME_SEC = 256 / 22050;     // Basic Pitch 一格的秒數
  const ONSET_STRONG = 0.8;          // 起音強度到這裡以上一定切開(明顯的新音)
  const DIP_MIN = 0.35;              // 該音高的啟動值在起音前凹陷超過這個量,才算有新音(顫音的回落)
  const RISE_MIN = 0.3;              // 起音後啟動值急升超過這個量,才算有新音
  const MAX_JOIN_GAP = 0.12;         // 同音高兩段之間的空隙在這之內才考慮併回去(秒)
  const CHORD_WINDOW = 0.06;         // 起始時間相差在這之內視為同一個和弦(秒)
  const MIN_FRAMES = 4;              // 最短音:至少 4 格(約 46 毫秒)
  const SHORT_FRAMES = 8;            // 不到 8 格的音必須有明顯起音
  const SHORT_ONSET = 0.6;           // 「明顯起音」的門檻(只用在短音)
  const MELODY_MIN_RUN = 3;          // 旋律線至少連續這麼多個音才算數
  const MELODY_MAX_GAP = 0.5;        // 旋律線相鄰兩音的空隙超過這麼多秒就斷開(秒)
  const MELODY_BOOST = 1.2;          // 旋律音量倍率
  const BACKGROUND_CUT = 0.8;        // 背景音(力度不高於中位數)音量倍率
  const CHORD_MAX_VOICES = 4;        // 和弦模式每組最多幾個音
  const ANTI_CORR = -0.5;            // 左右相關係數不高於這個值視為強烈反相

  const sorted = (ns) => ns.slice().sort((a, b) => a.t - b.t || a.n - b.n);
  const median = (xs) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }

  // 起音證據夠明顯才切開長音:起音強度高、或起音前啟動值凹陷、或起音後急升。三者都不成立就是慢起音／顫音／鼓聲造成的假起音,不切。
  function shouldCutAtOnset(ev) { return !!ev && (ev.onset >= ONSET_STRONG || ev.dip >= DIP_MIN || ev.rise >= RISE_MIN); }

  // 同音高、空隙很小、而且新起音沒有明顯證據 → 併回前一個音。沒有證據函式就什麼都不併(保守)。
  function joinSplitNotes(notes, evidenceAt, opt) {
    if (typeof evidenceAt !== 'function') return sorted(notes);
    const maxGap = (opt && opt.maxGap) || MAX_JOIN_GAP; const out = [];
    for (const n of sorted(notes)) {
      const p = out.length ? out[out.length - 1] : null;
      if (p && p.n === n.n && n.t - (p.t + p.d) <= maxGap) {
        const ev = evidenceAt(n.t, n.n);
        if (ev && !shouldCutAtOnset(ev)) { p.d = Math.max(p.d, n.t + n.d - p.t); p.v = Math.max(p.v, n.v); continue; }
      }
      out.push(Object.assign({}, n));
    }
    return out;
  }

  // 起始時間在 CHORD_WINDOW 內的音,起點對齊到中間值(偶數個取兩個中間值的平均),結束時間保留,持續時間跟著縮短或拉長。
  function alignChordOnsets(notes) {
    const s = sorted(notes), out = []; let i = 0;
    while (i < s.length) {
      let j = i + 1; while (j < s.length && s[j].t - s[i].t <= CHORD_WINDOW) j++;
      const grp = s.slice(i, j); const mid = median(grp.map((n) => n.t));
      for (const n of grp) { const end = n.t + n.d; out.push(Object.assign({}, n, { t: mid, d: Math.max(FRAME_SEC, end - mid) })); }
      i = j;
    }
    return out;
  }

  // 最短音。沒有證據函式時只看 4 格;有證據時,4 到 7 格還要有明顯起音。
  function enforceMinLength(notes, evidenceAt) {
    const minSec = MIN_FRAMES * FRAME_SEC, shortSec = SHORT_FRAMES * FRAME_SEC;
    return notes.filter((n) => {
      if (n.d < minSec) return false;
      if (n.d >= shortSec || typeof evidenceAt !== 'function') return true;
      const ev = evidenceAt(n.t, n.n); return !!ev && ev.onset >= SHORT_ONSET;
    });
  }

  // 旋律線旗標:每個音取中點,看哪些音在那一刻同時在響;同時在響的音裡最高的那個算頂線。
  // 頂線要連續 MELODY_MIN_RUN 個以上(相鄰起點空隙不超過 MELODY_MAX_GAP)才算旋律。回傳與輸入同順序的布林陣列。
  function melodyFlags(notes) {
    const n = notes.length, flags = new Array(n).fill(false); if (!n) return flags;
    const order = notes.map((_, i) => i).sort((a, b) => notes[a].t - notes[b].t);
    const starts = order.map((i) => notes[i].t); const maxD = Math.max.apply(null, notes.map((x) => x.d));
    const top = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const mid = notes[i].t + notes[i].d / 2; let best = -Infinity;
      for (let q = lowerBound(starts, mid - maxD); q < order.length && starts[q] <= mid; q++) { const m = notes[order[q]]; if (m.t + m.d > mid) best = Math.max(best, m.n); }
      top[i] = notes[i].n >= best;
    }
    let run = []; const flush = () => { if (run.length >= MELODY_MIN_RUN) for (const k of run) flags[k] = true; run = []; };
    for (const i of order) {
      if (!top[i]) continue; // 背景音不切斷旋律線,只有頂線之間的空隙太大才斷開
      if (run.length && notes[i].t - notes[run[run.length - 1]].t > MELODY_MAX_GAP) flush();
      run.push(i);
    }
    flush();
    return flags;
  }

  // 旋律拉高、背景(力度不高於中位數的非旋律音)降低
  function emphasizeMelody(notes) {
    const flags = melodyFlags(notes), med = median(notes.map((x) => x.v));
    return notes.map((x, i) => {
      if (flags[i]) return Object.assign({}, x, { v: Math.min(127, Math.round(x.v * MELODY_BOOST)) });
      if (x.v <= med) return Object.assign({}, x, { v: Math.max(1, Math.round(x.v * BACKGROUND_CUT)) });
      return Object.assign({}, x);
    });
  }

  // 模式簡化。'full' 原樣;'melody' 只留旋律,並把相鄰旋律音的空隙切開(不重疊);
  // 'chords' 旋律加和弦:非旋律音依 CHORD_WINDOW 分組,每組取最低的 CHORD_MAX_VOICES 個不同音高,持續時間取該組最長者。
  function simplifyForMode(notes, mode) {
    if (mode !== 'melody' && mode !== 'chords') return sorted(notes);
    const flags = melodyFlags(notes); const mel = [], rest = [];
    notes.forEach((x, i) => (flags[i] ? mel : rest).push(x));
    const legato = sorted(mel);
    for (let i = 0; i + 1 < legato.length; i++) if (legato[i].t + legato[i].d > legato[i + 1].t) legato[i].d = Math.max(FRAME_SEC, legato[i + 1].t - legato[i].t);
    if (mode === 'melody') return legato;
    const groups = []; let grp = null;
    for (const x of sorted(rest)) { if (grp && x.t - grp[0].t <= CHORD_WINDOW) grp.push(x); else { grp = [x]; groups.push(grp); } }
    const chords = [];
    for (const g of groups) {
      const pitches = Array.from(new Set(g.map((x) => x.n))).sort((a, b) => a - b).slice(0, CHORD_MAX_VOICES);
      const t = Math.min.apply(null, g.map((x) => x.t)), d = Math.max.apply(null, g.map((x) => x.d)), v = Math.round(g.reduce((s, x) => s + x.v, 0) / g.length);
      for (const p of pitches) chords.push({ t, d, n: p, v });
    }
    return sorted(legato.concat(chords));
  }

  // 立體聲:相關係數夠負(左右反相)時,相加會互相抵消成靜音,改取能量較大的那一聲道;其餘情況平均。
  function stereoToMono(L, R) {
    if (!R || !R.length) return L;
    let sLR = 0, sLL = 0, sRR = 0; const n = Math.min(L.length, R.length);
    for (let i = 0; i < n; i++) { sLR += L[i] * R[i]; sLL += L[i] * L[i]; sRR += R[i] * R[i]; }
    const corr = sLR / Math.sqrt(sLL * sRR + 1e-20); const o = new Float32Array(n);
    if (corr <= ANTI_CORR) { const src = sLL >= sRR ? L : R; for (let i = 0; i < n; i++) o[i] = src[i]; return o; }
    for (let i = 0; i < n; i++) o[i] = 0.5 * (L[i] + R[i]);
    return o;
  }

  // 由 Basic Pitch 的 stitch 結果 st = { onset, note, frames } 做證據函式 (秒, MIDI) → { onset, dip, rise } 或 null
  function evidenceFromActivations(st, opt) {
    opt = opt || {}; const BINS = opt.bins || 88, LOW = opt.low || 21, F = st.frames;
    const at = (arr, f, b) => (f < 0 || f >= F) ? 0 : arr[f * BINS + b];
    return function (tSec, midi) {
      const b = Math.round(midi) - LOW; if (b < 0 || b >= BINS) return null;
      const f = Math.round(tSec / FRAME_SEC);
      let on = 0; for (let g = f - 1; g <= f + 1; g++) on = Math.max(on, at(st.onset, g, b));
      let before = 0; for (let g = f - 10; g <= f - 2; g++) before = Math.max(before, at(st.note, g, b));
      let low = 1; for (let g = f - 2; g <= f; g++) low = Math.min(low, at(st.note, g, b));
      const dip = Math.max(0, before - low);
      const rise = Math.max(0, Math.min(1, at(st.note, f + 3, b) - at(st.note, f, b)));
      return { onset: on, dip, rise };
    };
  }

  // 組合:併回假切 → 最短音 → 和弦對齊 →(選用)旋律強調
  function postprocess(notes, opt) {
    opt = opt || {};
    let out = joinSplitNotes(notes, opt.evidenceAt, opt);
    out = enforceMinLength(out, opt.evidenceAt);
    out = alignChordOnsets(out);
    if (opt.melody) out = emphasizeMelody(out);
    return sorted(out);
  }

  return { FRAME_SEC, ONSET_STRONG, DIP_MIN, RISE_MIN, MAX_JOIN_GAP, CHORD_WINDOW, MIN_FRAMES, SHORT_FRAMES, SHORT_ONSET, MELODY_MIN_RUN, MELODY_MAX_GAP, MELODY_BOOST, BACKGROUND_CUT, CHORD_MAX_VOICES, ANTI_CORR,
    shouldCutAtOnset, joinSplitNotes, alignChordOnsets, enforceMinLength, melodyFlags, emphasizeMelody, simplifyForMode, stereoToMono, evidenceFromActivations, postprocess };
});
