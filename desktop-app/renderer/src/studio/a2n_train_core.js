/* 音訊轉音符（audio_to_notes）訓練的純函式核心（UMD，node 可測）。
 * 訓練本體在 a2n_train.py（Basic Pitch nmp.onnx 轉成 torch 後全參數微調，CPU）。
 * 這裡負責：合成資料（已知音符的鋼琴式音色，確定性亂數）、幀級目標（與 basic_pitch.js 的幀格一致：22050 Hz、每幀 256 樣本、88 格從 MIDI 21 起）、
 * 幀級精確率／召回率／F1，以及資料產生的命令列入口。
 * 命令列：node a2n_train_core.js gen <輸出目錄> <筆數> <種子>   → clip_<i>.f32（音訊）、clip_<i>.onset.u8、clip_<i>.note.u8（172×88 目標）、clip_<i>.json（真值音符）、index.json
 *         node a2n_train_core.js metrics <預測目錄> <資料目錄> [閾值] → 讀 clip_<i>.onset.f32／clip_<i>.note.f32 算 F1
 * 測試：renderer/src/studio/a2n_train_core.test.js */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else (root.FaA2nTrain = factory()); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SR = 22050, WIN = 43844, FRAMES = 172, BINS = 88, HOP = 256, LOW = 21;

  // 確定性亂數（mulberry32）：同一種子永遠產生同一批資料
  function rngFrom(seed) {
    var s = seed >>> 0;
    return function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function midiFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // 合成一段 WIN 樣本（約 1.99 秒）的鋼琴式音色：泛音 1/h^1.2、指數衰減、起音 5 毫秒、放開 40 毫秒。
  // 回傳 { samples: Float32Array(WIN), notes: [{midi, on, off}]（秒）}。音符數 1～maxPoly，音高 40～84。
  function synthClip(seed, opts) {
    var o = opts || {}, maxPoly = o.maxPoly || 4, rnd = rngFrom(seed), dur = WIN / SR;
    var k = 1 + Math.floor(rnd() * maxPoly), notes = [], x = new Float32Array(WIN), i, n;
    for (n = 0; n < k; n++) {
      var midi = 40 + Math.floor(rnd() * 45), on = 0.05 + rnd() * 1.1, len = 0.2 + rnd() * 0.7, off = Math.min(dur - 0.1, on + len);
      var amp = 0.15 + rnd() * 0.35, phase = [], h;
      for (h = 1; h <= 6; h++) phase.push(rnd() * 2 * Math.PI);
      var tau = 0.5 + rnd() * 0.6, f0 = midiFreq(midi), i0 = Math.round(on * SR), i1 = Math.min(WIN, Math.round((off + 0.04) * SR));
      for (i = i0; i < i1; i++) {
        var t = (i - i0) / SR, env = Math.min(1, t / 0.005) * Math.exp(-t / tau);
        if (i / SR > off) env *= Math.max(0, 1 - ((i / SR) - off) / 0.04);
        var s = 0;
        for (h = 1; h <= 6; h++) { var fh = f0 * h; if (fh > SR / 2 - 200) break; s += Math.sin(2 * Math.PI * fh * (i / SR) + phase[h - 1]) / Math.pow(h, 1.2); }
        x[i] += amp * env * s;
      }
      notes.push({ midi: midi, on: round4(on), off: round4(off) });
    }
    var peak = 0; for (i = 0; i < WIN; i++) peak = Math.max(peak, Math.abs(x[i]));
    if (peak > 0) { var g = 0.8 / peak; for (i = 0; i < WIN; i++) x[i] *= g; }
    return { samples: x, notes: notes };
  }
  function round4(v) { return Math.round(v * 10000) / 10000; }

  // 幀級目標：note[f,b]=1 表示該幀該音高在持續（幀中心時間落在 [on, off)）；onset[f,b]=1 表示起音所在幀（四捨五入到最近幀）。
  function frameTargets(notes, frames) {
    var F = frames || FRAMES, note = new Uint8Array(F * BINS), onset = new Uint8Array(F * BINS), j;
    (notes || []).forEach(function (n) {
      var b = n.midi - LOW; if (b < 0 || b >= BINS) return;
      for (var f = 0; f < F; f++) { var t = f * HOP / SR; if (t >= n.on && t < n.off) note[f * BINS + b] = 1; }
      var of = Math.round(n.on * SR / HOP); if (of >= 0 && of < F) onset[of * BINS + b] = 1;
    });
    return { note: note, onset: onset };
  }

  // 幀級精確率／召回率／F1。pred 為機率（Float32Array，F×88），truth 為 0/1（Uint8Array）。tol 為容許的幀數（真值往兩側擴 tol 幀）。
  function prf(pred, truth, thr, tol) {
    var T = thr == null ? 0.5 : thr, D = tol || 0, F = truth.length / BINS, tp = 0, fp = 0, fn = 0, f, b, d;
    // 真值擴張（容許幀誤差）：對每個真值幀，把 [f-D, f+D] 內同音高視為命中
    var hit = new Uint8Array(truth.length); // 真值被命中
    var pr = new Uint8Array(pred.length);
    for (f = 0; f < F; f++) for (b = 0; b < BINS; b++) pr[f * BINS + b] = pred[f * BINS + b] >= T ? 1 : 0;
    for (f = 0; f < F; f++) for (b = 0; b < BINS; b++) {
      if (!truth[f * BINS + b]) continue;
      var near = false;
      for (d = -D; d <= D && !near; d++) { var g = f + d; if (g >= 0 && g < F && pr[g * BINS + b]) near = true; }
      if (near) { hit[f * BINS + b] = 1; tp++; } else fn++;
    }
    for (f = 0; f < F; f++) for (b = 0; b < BINS; b++) {
      if (!pr[f * BINS + b]) continue;
      var ok = false;
      for (d = -D; d <= D && !ok; d++) { var h = f + d; if (h >= 0 && h < F && truth[h * BINS + b]) ok = true; }
      if (!ok) fp++;
    }
    var p = tp + fp === 0 ? 0 : tp / (tp + fp), r = tp + fn === 0 ? 0 : tp / (tp + fn);
    return { tp: tp, fp: fp, fn: fn, precision: p, recall: r, f1: p + r === 0 ? 0 : 2 * p * r / (p + r) };
  }
  // 多段合計（先加總 TP／FP／FN 再算，不是逐段平均）
  function pooledF1(items) {
    var tp = 0, fp = 0, fn = 0;
    items.forEach(function (x) { tp += x.tp; fp += x.fp; fn += x.fn; });
    var p = tp + fp === 0 ? 0 : tp / (tp + fp), r = tp + fn === 0 ? 0 : tp / (tp + fn);
    return { tp: tp, fp: fp, fn: fn, precision: p, recall: r, f1: p + r === 0 ? 0 : 2 * p * r / (p + r), n: items.length };
  }

  return { SR: SR, WIN: WIN, FRAMES: FRAMES, BINS: BINS, HOP: HOP, LOW: LOW, rngFrom: rngFrom, synthClip: synthClip, frameTargets: frameTargets, prf: prf, pooledF1: pooledF1 };
});

// ---- 命令列 ----
if (typeof require === 'function' && typeof module === 'object' && require.main === module) {
  var fs = require('fs'), path = require('path');
  var A = module.exports;
  var cmd = process.argv[2];
  if (cmd === 'gen') {
    var outDir = process.argv[3], n = parseInt(process.argv[4], 10), seed0 = parseInt(process.argv[5] || '1', 10);
    fs.mkdirSync(outDir, { recursive: true });
    var index = [];
    for (var i = 0; i < n; i++) {
      var seed = seed0 * 100003 + i, c = A.synthClip(seed), tg = A.frameTargets(c.notes, A.FRAMES), base = path.join(outDir, 'clip_' + i);
      fs.writeFileSync(base + '.f32', Buffer.from(c.samples.buffer));
      fs.writeFileSync(base + '.onset.u8', Buffer.from(tg.onset.buffer));
      fs.writeFileSync(base + '.note.u8', Buffer.from(tg.note.buffer));
      fs.writeFileSync(base + '.json', JSON.stringify({ seed: seed, notes: c.notes }, null, 0));
      index.push({ i: i, seed: seed, notes: c.notes.length });
    }
    fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ format: 'fa-a2n-synth', version: 1, sr: A.SR, win: A.WIN, frames: A.FRAMES, bins: A.BINS, clips: index }, null, 1));
    console.log(JSON.stringify({ wrote: n, dir: outDir }));
  } else if (cmd === 'metrics') {
    var pDir = process.argv[3], dDir = process.argv[4], thr = parseFloat(process.argv[5] || '0.5');
    var idx = JSON.parse(fs.readFileSync(path.join(dDir, 'index.json'), 'utf8'));
    var items = { note: [], onset: [] };
    idx.clips.forEach(function (c) {
      var base = path.join(dDir, 'clip_' + c.i);
      var noteT = new Uint8Array(fs.readFileSync(base + '.note.u8')), onsetT = new Uint8Array(fs.readFileSync(base + '.onset.u8'));
      var noteP = new Float32Array(new Uint8Array(fs.readFileSync(path.join(pDir, 'clip_' + c.i + '.note.f32'))).buffer);
      var onsetP = new Float32Array(new Uint8Array(fs.readFileSync(path.join(pDir, 'clip_' + c.i + '.onset.f32'))).buffer);
      items.note.push(A.prf(noteP, noteT, thr, 0));
      items.onset.push(A.prf(onsetP, onsetT, thr, 1));
    });
    console.log(JSON.stringify({ threshold: thr, clips: idx.clips.length, note_frame: A.pooledF1(items.note), onset_tol1: A.pooledF1(items.onset) }));
  }
}
