/* variant_table.js — 設定頁「變體競賽」表的純函式（G5，docs/TARGET.cudaweb-cublas.md）。
 * 不碰 GPU、不碰 DOM：輸入是量測結果（中位數毫秒、取樣、驗證失敗清單）與來源，輸出是表格列。
 * 欄位：GFLOP/s（2·M·K·N ÷ 中位數時間）、占實測峰值百分比（只有「峰值已在這張卡量過」才算，否則 null）、
 *       編譯毫秒（目前競賽不記錄，一律 null，表上顯示「未記錄」）、正確性、來源、勝者。
 * 來源分三種，且不混用：本機實測（這個瀏覽器這次量到的）、預先剖析 measured（維護者在 GT 720 量過的）、
 *       heuristic（推估，不當成量測）、未量測。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaVariantTable。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaVariantTable = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 已量過峰值的能力簽名（R0 屋頂，GT 720，peakFlops ≈ 127.5 GFLOP/s）。其他卡沒有量過就顯示「—」，不套用這個數字。
  var PEAKS = {
    'wg16384-inv256-f160-sg0':{ gflops: 127.5, basis: 'R0 屋頂實測（NVIDIA GT 720，WebGPU 純 FMA）' }
  };

  function peakFor(sig) {
    return PEAKS[sig] ? PEAKS[sig] : null;
  }

  // "64x1024x1024" → { M, K, N }；格式不對回傳 null
  function parseShape(s) {
    var m = /^(\d{1,6})x(\d{1,6})x(\d{1,6})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var M = +m[1], K = +m[2], N = +m[3];
    if (!(M > 0 && K > 0 && N > 0)) return null;
    return { M: M, K: K, N: N };
  }

  function flopsOf(sh) { return 2 * sh.M * sh.K * sh.N; }

  // GFLOP/s：ms 是毫秒；無效（非正、非有限）回傳 null
  function gflopsOf(sh, ms) {
    if (!(typeof ms === 'number' && isFinite(ms) && ms > 0)) return null;
    return flopsOf(sh) / (ms * 1e6);
  }

  function median(xs) {
    var a = (xs || []).filter(function (x) { return typeof x === 'number' && isFinite(x); }).sort(function (p, q) { return p - q; });
    if (!a.length) return null;
    var h = a.length >> 1;
    return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
  }

  /* rowsFor(o)
   *   o.shape      "MxKxN" 字串
   *   o.variants   [{ id }]（這個形狀會跑的變體，順序即顯示順序）
   *   o.timings    { id: [ms, ...] }（本機競賽的取樣；沒有就是未量測）
   *   o.bad        [{ id, reason }]（驗證不過的變體）
   *   o.winnerId   勝者 id 或 null
   *   o.priorsRank [id, ...]（預先剖析的首選順序；只用來標示來源是 heuristic 或 measured，不當量測）
   *   o.priorsSource  'measured' | 'heuristic' | null
   *   o.peak       peakFor(sig) 的結果或 null
   *   o.compile    勝者的編譯 ms（winner 快取的 compile），沒有就 null
   * 回傳列陣列：{ shape, variant, samples, medianMs, gflops, pctPeak, compileMs, correct, source, winner }
   */
  function rowsFor(o) {
    var sh = parseShape(o.shape);
    var timings = o.timings || {};
    var bad = {};
    (o.bad || []).forEach(function (b) { bad[b.id] = b.reason || '驗證不過'; });
    // 依預估逾時而略過的候選（不是驗證失敗）：正確性欄留空，來源欄寫出略過原因
    var skip = {};
    (o.skipped || []).forEach(function (s) { skip[s.id] = s.reason || '略過'; });
    var rank = o.priorsRank || [];
    var rows = [];
    (o.variants || []).forEach(function (v) {
      var xs = timings[v.id] || [];
      var med = median(xs);
      var g = sh ? gflopsOf(sh, med) : null;
      var pct = (g !== null && o.peak && o.peak.gflops > 0) ? (g / o.peak.gflops) * 100 : null;
      var correct = bad[v.id] ? false : (xs.length ? true : null);
      var source;
      if (xs.length) source = '本機實測';
      else if (skip[v.id]) source = skip[v.id];
      else if (rank.indexOf(v.id) >= 0 && o.priorsSource) source = o.priorsSource === 'measured' ? '預先剖析（實測）' : '預先剖析（推估）';
      else source = '未量測';
      rows.push({
        shape: o.shape,
        variant: v.id,
        samples: xs.length,
        medianMs: med,
        gflops: g,
        pctPeak: pct,
        // 編譯 ms：只有勝者記錄（競賽時它的管線編譯過一次）；其餘列沒有就 null
        compileMs: (o.compile != null && !!o.winnerId && o.winnerId === v.id) ? o.compile : null,
        correct: correct,
        correctNote: bad[v.id] || (correct === true ? '驗證通過（相對誤差 ≤1e-5）' : (correct === false ? '' : '未驗證')),
        source: source,
        winner: !!o.winnerId && o.winnerId === v.id,
      });
    });
    return rows;
  }

  // 每個形狀的一句摘要：誰勝、勝多少（只用本機實測；沒有就說未量測）
  function summaryOf(rows) {
    var w = rows.filter(function (r) { return r.winner; })[0];
    if (!w) return '未量測（沒有勝者）';
    var others = rows.filter(function (r) { return !r.winner && r.medianMs !== null; });
    var base = others.length ? others.reduce(function (a, b) { return a.medianMs < b.medianMs ? a : b; }) : null;
    var txt = '勝者 ' + w.variant + '：' + (w.medianMs !== null ? w.medianMs.toFixed(2) + ' ms' : '—') + (w.gflops !== null ? '，' + w.gflops.toFixed(2) + ' GFLOP/s' : '');
    if (base && w.medianMs !== null && base.medianMs > 0) txt += '（比次快的 ' + base.variant + ' 快 ' + ((base.medianMs / w.medianMs - 1) * 100).toFixed(0) + '%）';
    return txt;
  }

  return { PEAKS: PEAKS, peakFor: peakFor, parseShape: parseShape, flopsOf: flopsOf, gflopsOf: gflopsOf, median: median, rowsFor: rowsFor, summaryOf: summaryOf };
}));
