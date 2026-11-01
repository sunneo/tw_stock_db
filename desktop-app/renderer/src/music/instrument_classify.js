// 樂器分類(YAMNet,Apache-2.0)的後處理。YAMNet 模型 yamnet.onnx(16,093,355 位元組,SHA-256 d3835ffb…f908e)2026-11-01 用 onnxruntime 實測:
// 輸入 waveform 16 kHz 單聲道,輸出 scores [幀數,521](每 0.48 秒一幀,視窗 0.96 秒)。類別名稱出自 AudioSet 本體(CC BY 4.0,Google)。
// 這裡不讓模型自由輸出:只在「候選樂器」的封閉清單裡比分數,選出的結果再經程式核對(分數夠高、領先第二名夠多),不夠就回傳 null 讓呼叫端退回音域規則。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaInstrumentClassify = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // [YAMNet 類別編號, 給 labelToProgram 吃的標籤(對得到 GM 音色)]
  const CANDIDATES = [[24, 'Singing'], [135, 'Acoustic guitar'], [136, 'Electric guitar'], [137, 'Bass'], [138, 'Acoustic guitar'], [139, 'Steel guitar'], [142, 'Banjo'], [143, 'Sitar'], [144, 'Acoustic guitar'], [146, 'Acoustic guitar'], [147, 'Piano'], [148, 'Piano'], [149, 'Rhodes'], [150, 'Organ'], [151, 'Organ'], [152, 'Organ'], [153, 'Synthesizer'], [155, 'Piano'], [175, 'Marimba'], [176, 'Glockenspiel'], [177, 'Vibraphone'], [179, 'Orchestra'], [180, 'Brass'], [181, 'French horn'], [182, 'Trumpet'], [183, 'Trombone'], [185, 'String section'], [186, 'Violin'], [188, 'Cello'], [189, 'Bass'], [191, 'Flute'], [192, 'Saxophone'], [193, 'Clarinet'], [194, 'Harp'], [203, 'Harmonica'], [204, 'Accordion']];
  // scores: Float32Array(frames*521)。回傳 { label, score, margin, ranked } 或 null
  function pick(scores, frames, opt) {
    opt = opt || {}; const minScore = opt.minScore != null ? opt.minScore : 0.08, minMargin = opt.minMargin != null ? opt.minMargin : 0.02;
    if (!frames) return null; const sums = new Map();
    for (const [idx, label] of CANDIDATES) { let s = 0; for (let f = 0; f < frames; f++) s += scores[f * 521 + idx]; s /= frames; sums.set(label, Math.max(sums.get(label) || 0, s)); }
    const ranked = Array.from(sums, ([label, score]) => ({ label, score })).sort((a, b) => b.score - a.score);
    const top = ranked[0], second = ranked[1] || { score: 0 }; if (!top || top.score < minScore) return null;
    return { label: top.label, score: top.score, margin: top.score - second.score, ranked: ranked.slice(0, 3), confident: top.score - second.score >= minMargin };
  }
  return { CANDIDATES, pick };
});
