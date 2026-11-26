// 音訊轉 MIDI 流程:解碼後的取樣 → 音高校準／漂移修正 → 分段(20 秒一段、重疊 2 秒) → (可插拔)分軌器 → 逐軌轉譜 → 音符後處理 → 樂器標籤 → 組成多軌 MIDI。
// 分軌器、轉譜器、分類器都是可插拔函式,沒有就退回規則做法,並在 report 誠實列出哪些被跳過。
//   separator(chunk{left,right,sr}) → Promise<{ drums, bass, other, vocals, guitar, piano }>  每軌是與輸入同長的單聲道 Float32Array
//   transcriber(mono, sr, stemName) → Promise<[{ t, d, n, v }]>  (多音轉譜,例如 Basic Pitch;t 相對這段開頭;可帶 .methods 說明用了哪些處理)
//   classifier(mono, sr) → Promise<string>  樂器標籤(例如 YAMNet 的類別名),由 labelToProgram 對應 GM,對不上就用音域退路
//   store { get(key), set(key, value) }  可中斷續跑:每段每軌的結果存起來,同一首再跑就跳過
//   mode 'full'(預設)| 'melody'(只留旋律)| 'chords'(旋律加和弦):從已轉出的音符分類,不重跑模型
// 分段規則:每段 20 秒,相鄰兩段重疊 2 秒;每段只負責到重疊的中點(第 k 段負責 [起點+1, 下一段起點+1) 秒),所以段與段之間不會重複或漏掉音。
// report.methods 列出用了哪些處理(給結果訊息與方法欄用)。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./audio_to_midi.js'), require('./note_postprocess.js'), require('./drum_flux.js'), require('./audio_dsp.js')); else root.FaAudioPipeline = factory(root.FaAudioToMidi || (typeof FaAudioToMidi !== 'undefined' ? FaAudioToMidi : undefined), root.FaNotePost || (typeof FaNotePost !== 'undefined' ? FaNotePost : undefined), root.FaDrumFlux || (typeof FaDrumFlux !== 'undefined' ? FaDrumFlux : undefined), root.FaAudioDsp || (typeof FaAudioDsp !== 'undefined' ? FaAudioDsp : undefined)); })(typeof self !== 'undefined' ? self : this, function (A, NP, DF, DSP) {
  'use strict';
  const WORK_SR = 22050, CHUNK = 20, OVERLAP = 2;
  const MODES = ['full', 'melody', 'chords'];
  // 立體聲取捨交給 NP.stereoToMono(左右反相時不平均成靜音);沒有後處理模組時退回平均
  function toMono(l, r) { if (NP) return NP.stereoToMono(l, r); if (!r) return l; const o = new Float32Array(l.length); for (let i = 0; i < l.length; i++) o[i] = 0.5 * (l[i] + (r[i] || 0)); return o; }
  // 簡單的區塊平均降取樣(整數倍)加線性內插,夠給音高追蹤與鼓偵測用
  function resample(x, from, to) { if (from === to) return x; const n = Math.floor(x.length * to / from), o = new Float32Array(n), k = from / to; for (let i = 0; i < n; i++) { const a = i * k, i0 = Math.floor(a), i1 = Math.min(x.length - 1, i0 + 1), f = a - i0; let v = x[Math.min(x.length - 1, i0)] * (1 - f) + x[i1] * f; if (k > 1.5) { let s = 0, c = 0; const e = Math.min(x.length, Math.floor(a + k)); for (let j = Math.floor(a); j < e; j++) { s += x[j]; c++; } if (c) v = s / c; } o[i] = v; } return o; }
  function fingerprint(l, sr) { let h = 2166136261 >>> 0; const step = Math.max(1, Math.floor(l.length / 4096)); for (let i = 0; i < l.length; i += step) h = Math.imul(h ^ Math.round(l[i] * 32767), 16777619) >>> 0; return 'a2m:' + l.length + ':' + sr + ':' + h.toString(16); }
  function mergeNotes(ns) { ns = ns.slice().sort((a, b) => a.t - b.t || a.n - b.n); const out = []; for (const n of ns) { const p = out.length ? out.filter((o) => o.n === n.n).pop() : null; if (p && n.t - (p.t + p.d) < 0.02 && n.t - (p.t + p.d) > -0.01) p.d = n.t + n.d - p.t; else out.push({ t: n.t, d: n.d, n: n.n, v: n.v }); } return out; }
  // 取最響的一段(至多 maxSec 秒)給分類器看
  function loudest(x, sr, maxSec) { const w = Math.floor(maxSec * sr); if (x.length <= w) return x; let best = 0, bi = 0; const hop = Math.floor(sr / 2); for (let o = 0; o + w <= x.length; o += hop) { let e = 0; for (let i = o; i < o + w; i += 16) e += x[i] * x[i]; if (e > best) { best = e; bi = o; } } return x.subarray(bi, bi + w); }
  // 音符後處理(階段一):沒有模組就只做合併
  const pp = (ns, melody) => { const m = mergeNotes(ns); return NP ? NP.postprocess(m, { melody: !!melody }) : m; };
  // 把校準後時間換回原始時間(音符的起點與長度都換)
  const mapNote = (n, tm) => { if (tm === null) return n; const t = tm(n.t); if (n.d == null) return Object.assign({}, n, { t }); return Object.assign({}, n, { t, d: Math.max(0, tm(n.t + n.d) - t) }); };
  // 結果快取鍵的版本號:後處理、分段或校準規則改了就換版本,避免讀到舊規則的結果
  const CACHE_VER = 'pp2';

  async function run(input, opts) {
    opts = opts || {}; const sr = input.sampleRate, L0 = input.left || input.channel, R0 = input.right || null;
    if (!L0 || !L0.length || !sr) throw new Error('沒有可轉的音訊取樣');
    const mode = MODES.includes(opts.mode) ? opts.mode : 'full', pitchedMode = mode !== 'full';
    const origSec = L0.length / sr;
    const report = { used: [], skipped: [], stems: [], chunks: 0, resumed: 0, seconds: origSec, methods: [] };
    const onP = opts.onProgress || (() => {}), store = opts.store, id = opts.id || fingerprint(L0, sr);
    // (1) 音高校準:錄音偏離 A440 就先整段重新取樣;錄音逐漸變調就逐秒校準。之後所有處理都在校準後的時間軸上做,最後換回原始時間
    let L = L0, R = R0, tm = null;
    const plan = (DSP && opts.calibrate !== false) ? DSP.planWarp(toMono(L0, R0), sr) : null;
    if (plan && plan.mode !== 'none') {
      L = DSP.applyWarp(L0, sr, plan); R = R0 ? DSP.applyWarp(R0, sr, plan) : null; tm = DSP.makeTimeMap(plan, sr);
      if (plan.mode === 'global') report.methods.push('＋音高校準 ' + (-Math.round(plan.offset)) + ' 音分');
      else report.methods.push('＋音高漂移修正');
      report.used.push('音高:' + plan.reason);
    }
    const dur = L.length / sr;
    // (2) 分段:每段 chunk 秒,相鄰段重疊 OVERLAP 秒;每段負責 [起點 + OVERLAP/2, 下一段起點 + OVERLAP/2),中點切開
    const chunkSec = opts.chunkSec || CHUNK, step = Math.max(0.5, chunkSec - OVERLAP), starts = [];
    for (let s = 0; s < dur; s += step) starts.push(s); if (!starts.length) starts.push(0);
    const total = starts.length;
    const useSep = typeof opts.separator === 'function';
    const stemNames = useSep ? (opts.stems || ['drums', 'bass', 'other', 'vocals']) : ['mix'];
    if (!useSep) { report.skipped.push('沒有分軌模型:整個混音當成一軌處理,只用單音音高追蹤,不拆鼓、貝斯、人聲'); }
    else report.used.push('分軌:' + stemNames.join('、'));
    if (opts.transcriber && Array.isArray(opts.transcriber.methods)) report.methods.push(...opts.transcriber.methods);
    const acc = {}; stemNames.forEach((s) => { acc[s] = []; });
    for (let c = 0; c < total; c++) {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('已中斷'), { aborted: true, resumeId: id });
      const s0 = starts[c], e0 = Math.min(dur, s0 + chunkSec), own0 = c === 0 ? 0 : s0 + OVERLAP / 2, own1 = c === total - 1 ? dur : starts[c + 1] + OVERLAP / 2;
      const a = Math.max(0, Math.floor(s0 * sr)), b = Math.min(L.length, Math.floor(e0 * sr)), winStart = a / sr;
      onP({ chapter: '轉譜', done: c, total, message: '第 ' + (c + 1) + '/' + total + ' 段' });
      const key = id + ':' + c + ':' + (useSep ? 'sep' : 'mix') + (opts.transcriber ? '+tr' : '') + ':' + CACHE_VER + ':' + chunkSec + (plan && plan.mode !== 'none' ? ':' + plan.mode + Math.round(plan.offset) : '');
      let res = store ? await store.get(key) : null;
      if (res) report.resumed++;
      else {
        res = {}; let stems;
        if (useSep) stems = await opts.separator({ left: L.subarray(a, b), right: R ? R.subarray(a, b) : null, sr });
        else stems = { mix: toMono(L.subarray(a, b), R ? R.subarray(a, b) : null) };
        for (const s of stemNames) {
          const mono = stems[s]; if (!mono) { res[s] = { skipped: true }; continue; }
          const w = resample(mono, sr, WORK_SR); let ev;
          if (s === 'drums') ev = { drums: A.drumHits(w, WORK_SR).map((h) => ({ t: h.t + winStart, note: h.note, vel: h.vel })) };
          else if (opts.transcriber && s !== 'bass' && s !== 'vocals') ev = { notes: (await opts.transcriber(mono, sr, s)).map((n) => ({ t: n.t + winStart, d: n.d, n: n.n, v: n.v })) };
          else { const o = A.framesToNotes(A.pitchTrack(w, WORK_SR, s === 'bass' ? { fmin: 30, fmax: 400 } : undefined)); ev = { notes: o.map((n) => ({ t: n.t + winStart, d: n.d, n: n.n, v: n.v })) }; }
          res[s] = ev;
        }
        if (store) await store.set(key, res);
      }
      for (const s of stemNames) { const r = res[s]; if (!r || r.skipped) continue; const keep = (t) => t >= own0 && t < own1; if (r.drums) acc[s].push.apply(acc[s], r.drums.filter((h) => keep(h.t))); else acc[s].push.apply(acc[s], r.notes.filter((n) => keep(n.t))); }
      report.chunks++;
    }
    // (3) 換回原始時間
    if (tm) for (const s of Object.keys(acc)) acc[s] = acc[s].map((n) => mapNote(n, tm));
    const wholeMono = () => toMono(L, R);
    // (4) 音符後處理,再依模式決定哪些軌留下
    const parts = { other: [] };
    const others = []; // { s, notes }
    for (const s of stemNames) { if (['drums', 'bass', 'vocals'].includes(s) || !acc[s] || !acc[s].length) continue; others.push({ s, notes: pp(acc[s], s === 'mix' || s === 'other' || s === 'guitar' || s === 'piano') }); }
    if (pitchedMode) {
      if (!NP) report.skipped.push('沒有音符後處理模組,無法做「' + (mode === 'melody' ? '只留旋律' : '旋律加和弦') + '」,改用完整結果');
      else {
        const pool = [].concat(acc.vocals && acc.vocals.length ? pp(acc.vocals, false) : [], acc.bass && acc.bass.length ? pp(acc.bass, false) : [], ...others.map((o) => o.notes));
        report.methods.push(mode === 'melody' ? '＋只留旋律' : '＋旋律加和弦');
        report.used.push('模式:' + (mode === 'melody' ? '簡化(只留旋律)' : '和弦(旋律加和弦)'));
        others.length = 0; others.push({ s: 'mode', notes: NP.simplifyForMode(pool, mode) });
      }
    } else {
      // 鼓軌:有分軌出來的鼓(Demucs)就用它;沒有就用頻譜法在整個混音上找(不下載模型,有存在檢查)
      if (acc.drums && acc.drums.length) { parts.drums = acc.drums; report.methods.push('＋鼓軌（分軌）'); }
      else if (DF) {
        const fd = DF.detect(resample(wholeMono(), sr, WORK_SR), WORK_SR);
        if (fd.present) { parts.drums = fd.hits.map((h) => mapNote(h, tm)); report.methods.push('＋鼓軌（頻譜法）'); report.used.push('鼓軌:' + fd.reason); }
        else report.skipped.push('頻譜法沒有找到鼓(' + fd.reason + ')');
      }
      if (acc.bass && acc.bass.length) parts.bass = pp(acc.bass, false);
      if (acc.vocals && acc.vocals.length) parts.vocals = pp(acc.vocals, false);
    }
    // (5) 樂器標籤:只對「其他」「吉他」「鋼琴」「整個混音」這種不知道是什麼的軌問分類器
    for (const o of others) {
      const s = o.s, notes = o.notes; let label = null, program = s === 'guitar' ? 25 : s === 'piano' ? 0 : null;
      if (program == null && typeof opts.classifier === 'function') { try { label = await opts.classifier(resample(loudest(wholeMono(), sr, 8), sr, 16000), 16000); } catch (e) { report.skipped.push('樂器分類失敗(' + (e && e.message || e) + '),改用音域規則'); } if (label && A.labelToProgram(label) == null) { report.skipped.push('分類標籤「' + label + '」對不到 GM 音色,改用音域規則'); label = null; } }
      else if (program == null) report.skipped.push('沒有樂器分類器:「' + (s === 'mix' ? '整個混音' : '其他') + '」軌用音域規則挑音色(低→貝斯、中→鋼琴、高→合成主奏)');
      const name = s === 'mix' ? '混音(單音追蹤)' : s === 'guitar' ? '吉他' : s === 'piano' ? '鋼琴' : s === 'mode' ? (mode === 'melody' ? '旋律' : '旋律加和弦') : '其他';
      parts.other.push({ name, program: program != null ? program : undefined, label, notes });
      report.stems.push({ stem: s, notes: notes.length, label, program });
    }
    if (!parts.drums && useSep && stemNames.includes('drums') && !pitchedMode) report.skipped.push('沒有偵測到鼓的打擊');
    if (!useSep) report.skipped.push('沒有鼓軌、貝斯軌與人聲軌');
    report.skipped.push('拆樂器只到分軌模型給的幾軌;其他軌內的多種樂器不會被再分開。結果不保證準確,請在編輯器裡檢查');
    const built = A.buildSong(parts, { bpm: opts.bpm, title: opts.title });
    onP({ chapter: '完成', done: total, total, message: '完成' });
    return { song: built.song, tempo: built.tempo, report };
  }
  return { run, resample, toMono, fingerprint, mergeNotes, loudest, WORK_SR, CHUNK, OVERLAP, MODES };
});
