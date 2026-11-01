// Basic Pitch(nmp.onnx,Apache-2.0)的前後處理。2026-11-01 用 onnxruntime 實測:輸入 [批次, 43844, 1](22050 Hz 單聲道,約 2 秒),
// 輸出依序是 onset [批次,172,88]、note [批次,172,88]、contour [批次,172,264];88 格從 MIDI 21(A0)起,每格一個半音,幀長 256 樣本。
// 模型檔 230,444 位元組,SHA-256 2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaBasicPitch = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SR = 22050, WIN = 43844, FRAMES = 172, BINS = 88, HOP_S = 256, LOW = 21, OVERLAP = 7680, TRIM = OVERLAP / HOP_S / 2; // 每個視窗頭尾各丟 15 幀
  const STEP = WIN - OVERLAP;
  // 把整段單聲道(22050 Hz)切成互相重疊的視窗;開頭補半個重疊長度的零
  function windows(x) { const pad = OVERLAP / 2, n = x.length + pad; const count = Math.max(1, Math.ceil(n / STEP)); const out = []; for (let w = 0; w < count; w++) { const buf = new Float32Array(WIN); for (let i = 0; i < WIN; i++) { const src = w * STEP + i - pad; if (src >= 0 && src < x.length) buf[i] = x[src]; } out.push(buf); } return out; }
  // results[w] = { onset: Float32Array(172*88), note: Float32Array(172*88) };回傳串接後的 { onset, note, frames }(已丟掉每個視窗頭尾的重疊幀,並截到原長)
  function stitch(results, samples) { const keep = FRAMES - 2 * TRIM, total = Math.min(results.length * keep, Math.ceil(samples / HOP_S)); const onset = new Float32Array(total * BINS), note = new Float32Array(total * BINS); for (let w = 0; w < results.length; w++) for (let f = 0; f < keep; f++) { const g = w * keep + f; if (g >= total) break; const src = (f + TRIM) * BINS; onset.set(results[w].onset.subarray(src, src + BINS), g * BINS); note.set(results[w].note.subarray(src, src + BINS), g * BINS); } return { onset, note, frames: total }; }
  // 起音峰值＋note 機率持續 → 音符。沒有起音的持續音不收(避免把殘響當新音)
  function decode(p, opt) {
    opt = opt || {}; const onT = opt.onsetThr || 0.5, frT = opt.frameThr || 0.3, minLen = opt.minFrames || 5, gap = opt.gapFrames || 3, F = p.frames; const sec = HOP_S / SR; const notes = [];
    for (let b = 0; b < BINS; b++) {
      for (let f = 0; f < F; f++) {
        const o = p.onset[f * BINS + b], pv = f > 0 ? p.onset[(f - 1) * BINS + b] : 0, nx = f < F - 1 ? p.onset[(f + 1) * BINS + b] : 0; if (o < onT || o < pv || o < nx) continue;
        if (pv === o) continue; // 平台只取第一幀
        let e = f, low = 0; for (let g = f; g < F; g++) { if (p.note[g * BINS + b] >= frT) { e = g; low = 0; } else if (++low > gap) break; if (g > f && p.onset[g * BINS + b] >= onT && p.onset[g * BINS + b] > p.onset[(g - 1) * BINS + b] && p.onset[g * BINS + b] >= p.onset[Math.min(F - 1, g + 1) * BINS + b]) break; } // 下一個起音就在此結束
        if (e - f + 1 >= minLen) notes.push({ t: f * sec, d: (e - f + 1) * sec, n: LOW + b, v: Math.max(30, Math.min(120, Math.round(40 + 80 * o))) });
      }
    }
    // 同一音高相鄰、時間重疊的合併(起音峰值可能連著兩個)
    notes.sort((a, b) => a.n - b.n || a.t - b.t); const out = []; for (const n of notes) { const q = out[out.length - 1]; if (q && q.n === n.n && n.t < q.t + q.d - 0.02 && n.t - q.t < 0.06) { q.d = Math.max(q.d, n.t + n.d - q.t); } else out.push(n); }
    return out.sort((a, b) => a.t - b.t || a.n - b.n);
  }
  return { windows, stitch, decode, SR, WIN, FRAMES, BINS, LOW, STEP };
});
