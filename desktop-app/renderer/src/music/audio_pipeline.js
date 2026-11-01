// 音訊轉 MIDI 流程:解碼後的取樣 → 分段 → (可插拔)分軌器 → 逐軌轉譜 → 樂器標籤 → 組成多軌 MIDI。
// 分軌器、轉譜器、分類器都是可插拔函式,沒有就退回規則做法,並在 report 誠實列出哪些被跳過。
//   separator(chunk{left,right,sr}) → Promise<{ drums, bass, other, vocals, guitar, piano }>  每軌是與輸入同長的單聲道 Float32Array
//   transcriber(mono, sr, stemName) → Promise<[{ t, d, n, v }]>  (多音轉譜,例如 Basic Pitch;t 相對這段開頭)
//   classifier(mono, sr) → Promise<string>  樂器標籤(例如 YAMNet 的類別名),由 labelToProgram 對應 GM,對不上就用音域退路
//   store { get(key), set(key, value) }  可中斷續跑:每段每軌的結果存起來,同一首再跑就跳過
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./audio_to_midi.js')); else root.FaAudioPipeline = factory(root.FaAudioToMidi || (typeof FaAudioToMidi !== 'undefined' ? FaAudioToMidi : undefined)); })(typeof self !== 'undefined' ? self : this, function (A) {
  'use strict';
  const WORK_SR = 22050, CHUNK = 7.8, MARGIN = 0.5;
  function toMono(l, r) { if (!r) return l; const o = new Float32Array(l.length); for (let i = 0; i < l.length; i++) o[i] = 0.5 * (l[i] + (r[i] || 0)); return o; }
  // 簡單的區塊平均降取樣(整數倍)加線性內插,夠給音高追蹤與鼓偵測用
  function resample(x, from, to) { if (from === to) return x; const n = Math.floor(x.length * to / from), o = new Float32Array(n), k = from / to; for (let i = 0; i < n; i++) { const a = i * k, i0 = Math.floor(a), i1 = Math.min(x.length - 1, i0 + 1), f = a - i0; let v = x[Math.min(x.length - 1, i0)] * (1 - f) + x[i1] * f; if (k > 1.5) { let s = 0, c = 0; const e = Math.min(x.length, Math.floor(a + k)); for (let j = Math.floor(a); j < e; j++) { s += x[j]; c++; } if (c) v = s / c; } o[i] = v; } return o; }
  function fingerprint(l, sr) { let h = 2166136261 >>> 0; const step = Math.max(1, Math.floor(l.length / 4096)); for (let i = 0; i < l.length; i += step) h = Math.imul(h ^ Math.round(l[i] * 32767), 16777619) >>> 0; return 'a2m:' + l.length + ':' + sr + ':' + h.toString(16); }
  function mergeNotes(ns) { ns = ns.slice().sort((a, b) => a.t - b.t || a.n - b.n); const out = []; for (const n of ns) { const p = out.length ? out.filter((o) => o.n === n.n).pop() : null; if (p && n.t - (p.t + p.d) < 0.02 && n.t - (p.t + p.d) > -0.01) p.d = n.t + n.d - p.t; else out.push({ t: n.t, d: n.d, n: n.n, v: n.v }); } return out; }
  // 取最響的一段(至多 maxSec 秒)給分類器看
  function loudest(x, sr, maxSec) { const w = Math.floor(maxSec * sr); if (x.length <= w) return x; let best = 0, bi = 0; const hop = Math.floor(sr / 2); for (let o = 0; o + w <= x.length; o += hop) { let e = 0; for (let i = o; i < o + w; i += 16) e += x[i] * x[i]; if (e > best) { best = e; bi = o; } } return x.subarray(bi, bi + w); }

  async function run(input, opts) {
    opts = opts || {}; const sr = input.sampleRate, L = input.left || input.channel, R = input.right || null;
    if (!L || !L.length || !sr) throw new Error('沒有可轉的音訊取樣');
    const report = { used: [], skipped: [], stems: [], chunks: 0, resumed: 0, seconds: L.length / sr };
    const onP = opts.onProgress || (() => {}), store = opts.store, id = opts.id || fingerprint(L, sr);
    const useSep = typeof opts.separator === 'function', chunk = opts.chunkSec || (useSep && opts.separator.segmentSec ? opts.separator.segmentSec - 2 * MARGIN : CHUNK), total = Math.max(1, Math.ceil(L.length / sr / chunk));
    const stemNames = useSep ? (opts.stems || ['drums', 'bass', 'other', 'vocals']) : ['mix'];
    if (!useSep) { report.skipped.push('沒有分軌模型:整個混音當成一軌處理,只用單音音高追蹤,不拆鼓、貝斯、人聲'); }
    else report.used.push('分軌:' + stemNames.join('、'));
    const acc = {}; stemNames.forEach((s) => { acc[s] = []; });
    for (let c = 0; c < total; c++) {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('已中斷'), { aborted: true, resumeId: id });
      const t0 = c * chunk, t1 = Math.min(L.length / sr, t0 + chunk), a = Math.max(0, Math.floor((t0 - MARGIN) * sr)), b = Math.min(L.length, Math.floor((t1 + MARGIN) * sr)), winStart = a / sr;
      onP({ chapter: '轉譜', done: c, total, message: '第 ' + (c + 1) + '/' + total + ' 段' });
      const key = id + ':' + c + ':' + (useSep ? 'sep' : 'mix') + (opts.transcriber ? '+tr' : '');
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
      for (const s of stemNames) { const r = res[s]; if (!r || r.skipped) continue; if (r.drums) acc[s].push.apply(acc[s], r.drums.filter((h) => h.t >= t0 && h.t < t1)); else acc[s].push.apply(acc[s], r.notes.filter((n) => n.t >= t0 && n.t < t1)); }
      report.chunks++;
    }
    // 樂器標籤:只對「其他」「吉他」「鋼琴」「整個混音」這種不知道是什麼的軌問分類器
    const parts = { other: [] }; const wholeMono = () => toMono(L, R);
    if (acc.drums && acc.drums.length) parts.drums = acc.drums;
    if (acc.bass && acc.bass.length) parts.bass = mergeNotes(acc.bass);
    if (acc.vocals && acc.vocals.length) parts.vocals = mergeNotes(acc.vocals);
    for (const s of stemNames) {
      if (['drums', 'bass', 'vocals'].includes(s) || !acc[s] || !acc[s].length) continue;
      const notes = mergeNotes(acc[s]); let label = null, program = s === 'guitar' ? 25 : s === 'piano' ? 0 : null;
      if (program == null && typeof opts.classifier === 'function') { try { label = await opts.classifier(resample(loudest(wholeMono(), sr, 8), sr, 16000), 16000); } catch (e) { report.skipped.push('樂器分類失敗(' + (e && e.message || e) + '),改用音域規則'); } if (label && A.labelToProgram(label) == null) { report.skipped.push('分類標籤「' + label + '」對不到 GM 音色,改用音域規則'); label = null; } }
      else if (program == null) report.skipped.push('沒有樂器分類器:「' + (s === 'mix' ? '整個混音' : '其他') + '」軌用音域規則挑音色(低→貝斯、中→鋼琴、高→合成主奏)');
      parts.other.push({ name: s === 'mix' ? '混音(單音追蹤)' : s === 'guitar' ? '吉他' : s === 'piano' ? '鋼琴' : '其他', program: program != null ? program : undefined, label, notes });
      report.stems.push({ stem: s, notes: notes.length, label, program });
    }
    if (!parts.drums && useSep && stemNames.includes('drums')) report.skipped.push('沒有偵測到鼓的打擊');
    if (!useSep) report.skipped.push('沒有鼓軌、貝斯軌與人聲軌');
    report.skipped.push('拆樂器只到分軌模型給的幾軌;其他軌內的多種樂器不會被再分開。結果不保證準確,請在編輯器裡檢查');
    const built = A.buildSong(parts, { bpm: opts.bpm, title: opts.title });
    onP({ chapter: '完成', done: total, total, message: '完成' });
    return { song: built.song, tempo: built.tempo, report };
  }
  return { run, resample, toMono, fingerprint, mergeNotes, loudest, WORK_SR, CHUNK };
});
