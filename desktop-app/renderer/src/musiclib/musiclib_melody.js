/* 音樂庫的旋律找歌核心（UMD，純函式，不碰 DOM、麥克風、網路；node 可直接跑單元測試）。
 *
 * 流程：
 *   1. 旋律：從音符清單取主旋律（同時多音取最高音，鼓軌不算）→ melodyNotes / melodyFromSong
 *   2. 特徵：相對音程序列（與調高無關）＋相鄰音長的 log2 比例（與速度無關）→ contourOf
 *   3. 比對：對音程序列做「子序列對齊」（query 全部要對上，target 任何位置開始、可跳過多餘的 target 音；
 *      query 多出的音有懲罰、query 漏音＝target 跳過，代價很小）→ align；回傳分數與命中區段（曲中秒數）
 *   4. 打擊：只比 onset 間隔比例（節奏）→ rhythmScore，獨立分數
 *   5. 索引：background 逐首建立，已建且檔案大小／修改時間沒變就跳過，可暫停、續跑、取消；失敗附階段與原因 → runMelodyIndex
 * 音訊轉音符（單音音高追蹤、Basic Pitch）不在這裡：呼叫端用 FaAudioToMidi.pitchTrack／framesToNotes 取得音符後交進來。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibMelody = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var CHORD_WIN = 0.05;        // 秒：起音差在這之內視為同一群（取最高音）
  var MIN_NOTES = 4;           // 查詢至少要幾個音，太短沒有辨識意義
  var INT_CAP = 2;             // 音程差距超過幾個半音就當成完全不同（單位：半音）；取小一點，無關旋律才分得開
  var RATIO_CAP = 1;           // 節奏比例差距（log2）超過 1 就當完全不同（= 兩倍）
  var GAP_QUERY = 1.0;         // query 多出一個音的代價（不能太便宜，否則無關旋律會靠「略過」湊分）
  var SKIP_TARGET = 0.15;      // 跳過 target 的音（查詢漏音）的代價：不能太小，否則任何旋律都能靠跳音湊對
  var DEFAULT_MIN_SCORE = 0.35;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ───── 1. 旋律 ─────
  // notes: [{t(秒), d(秒), n(音高), v}]；同群起音只留最高音（音高相同留較長的）
  function melodyNotes(notes) {
    var src = (notes || []).filter(function (x) { return x && isFinite(x.t) && isFinite(x.n) && (x.d || 0) > 0; })
      .map(function (x) { return { t: +x.t, d: +x.d, n: +x.n }; })
      .sort(function (a, b) { return a.t - b.t || b.n - a.n; });
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var x = src[i], last = out[out.length - 1];
      if (last && x.t - last.t < CHORD_WIN) {
        if (x.n > last.n || (x.n === last.n && x.d > last.d)) out[out.length - 1] = x;
        continue;
      }
      out.push(x);
    }
    return out;
  }
  // song（FaMidi 曲子）→ 主旋律：所有非鼓軌音符合併後取旋律
  function melodyFromSong(song) {
    var all = [];
    ((song && song.tracks) || []).forEach(function (tr) { if (tr.drum) return; (tr.notes || []).forEach(function (n) { all.push(n); }); });
    return melodyNotes(all);
  }

  // ───── 2. 特徵 ─────
  // mel: melodyNotes 的輸出。回傳相對音程（半音，有號）與相鄰音長的 log2 比例，以及每個音的起點與長度（用來換算命中時間）
  function contourOf(mel) {
    var n = mel.length, intervals = [], ratios = [], times = [], durs = [];
    for (var i = 0; i < n; i++) { times.push(mel[i].t); durs.push(Math.max(0.02, mel[i].d)); }
    for (var k = 0; k + 1 < n; k++) {
      intervals.push(clamp(mel[k + 1].n - mel[k].n, -12, 12));
      ratios.push(clamp(Math.log2(durs[k + 1] / durs[k]), -2, 2));
    }
    return { n: n, intervals: intervals, ratios: ratios, times: times, durs: durs };
  }
  // 打擊的 onset 時間（秒）→ 相鄰間隔比例的 log2（只看節奏，與速度無關）
  function onsetRatios(times) {
    var t = (times || []).slice().sort(function (a, b) { return a - b; }), iois = [];
    for (var i = 0; i + 1 < t.length; i++) { var g = t[i + 1] - t[i]; if (g > 0.01) iois.push(g); }
    var out = [];
    for (var k = 0; k + 1 < iois.length; k++) out.push(clamp(Math.log2(iois[k + 1] / iois[k]), -2, 2));
    return out;
  }

  // ───── 3. 子序列對齊 ─────
  // q：查詢序列；t：目標序列（任何位置開始）；o.sub(a,b)：替換代價 0..1；o.gapQuery、o.skipTarget：多出／跳過的代價
  // 回傳 { norm（每個 query 元素的平均代價，0 最好）, start, end（target 的範圍 [start,end)） }
  function align(q, t, o) {
    var m = q.length, n = t.length;
    if (!m || !n) return { norm: 1, start: 0, end: 0 };
    var gq = o.gapQuery, gt = o.skipTarget, sub = o.sub;
    var pc = new Float64Array(n + 1), ps = new Int32Array(n + 1), cc = new Float64Array(n + 1), cs = new Int32Array(n + 1), j, i;
    for (j = 0; j <= n; j++) { pc[j] = 0; ps[j] = j; }
    for (i = 1; i <= m; i++) {
      cc[0] = pc[0] + gq; cs[0] = 0;
      for (j = 1; j <= n; j++) {
        var best = pc[j - 1] + sub(q[i - 1], t[j - 1]), bs = ps[j - 1];
        var a = pc[j] + gq; if (a < best) { best = a; bs = ps[j]; }
        var b = cc[j - 1] + gt; if (b < best) { best = b; bs = cs[j - 1]; }
        cc[j] = best; cs[j] = bs;
      }
      var tc = pc; pc = cc; cc = tc; var ts = ps; ps = cs; cs = ts;
    }
    var bj = 0; for (j = 1; j <= n; j++) if (pc[j] < pc[bj] - 1e-12) bj = j;
    return { norm: pc[bj] / m, start: ps[bj], end: bj };
  }
  function pitchOpts() { return { sub: function (a, b) { return Math.min(Math.abs(a - b), INT_CAP) / INT_CAP; }, gapQuery: GAP_QUERY, skipTarget: SKIP_TARGET }; }
  function rhythmOpts() { return { sub: function (a, b) { return Math.min(Math.abs(a - b), RATIO_CAP) / RATIO_CAP; }, gapQuery: GAP_QUERY, skipTarget: SKIP_TARGET }; }
  function toScore(norm) { return clamp(1 - norm, 0, 1); }
  // 對比拉伸：隨機旋律的分數大多落在 0.4～0.6，把 0.5 以下壓成 0，讓「找不到」與「命中」分得開（門檻在合成資料上調過，見單元測試）
  var CONTRAST_BASE = 0.5;
  function contrast(raw) { return clamp((raw - CONTRAST_BASE) / (1 - CONTRAST_BASE), 0, 1); }

  // 節奏分數（只比 onset 間隔比例，給打擊聲用）：qTimes、tTimes 是秒
  function rhythmScore(qTimes, tTimes) {
    var q = onsetRatios(qTimes), t = onsetRatios(tTimes);
    if (q.length < 3) return { score: 0, reason: '打擊太少（少於 4 個）' };
    var r = align(q, t, rhythmOpts());
    return { score: toScore(r.norm), start: r.start, end: r.end };
  }

  // ───── 4. 查詢 ─────
  // query：melodyNotes 的輸出（已取主旋律）；entries：[{ key, name, contour: contourOf(...) }]
  // opts: { minScore=0.35, limit=10, textHits（Set 或物件，key 命中就加分）, textWeight=0.1, weights={pitch:0.8, rhythm:0.2} }
  function searchMelody(query, entries, opts) {
    opts = opts || {};
    var mel = melodyNotes(query);
    if (mel.length < MIN_NOTES) return { ok: false, reason: '哼得太短（至少要 ' + MIN_NOTES + ' 個音）', results: [] };
    var qc = contourOf(mel), w = Object.assign({ pitch: 0.8, rhythm: 0.2 }, opts.weights || {});
    var minScore = opts.minScore == null ? DEFAULT_MIN_SCORE : opts.minScore, textWeight = opts.textWeight == null ? 0.1 : opts.textWeight;
    var po = pitchOpts(), ro = rhythmOpts(), results = [];
    (entries || []).forEach(function (e) {
      var c = e.contour; if (!c || c.n < 2) return;
      var p = align(qc.intervals, c.intervals, po), pitch = toScore(p.norm);
      var rhythm = qc.ratios.length >= 2 ? toScore(align(qc.ratios, c.ratios, ro).norm) : 0;
      var text = opts.textHits && (opts.textHits instanceof Set ? opts.textHits.has(e.key) : !!opts.textHits[e.key]) ? textWeight : 0;
      var raw = w.pitch * pitch + w.rhythm * rhythm + text;
      var score = contrast(raw);
      if (score < minScore) return;
      var si = clamp(p.start, 0, c.n - 1), ei = clamp(p.end, 0, c.n - 1);
      results.push({
        key: e.key, name: e.name, score: Math.round(score * 1000) / 1000, pitchScore: Math.round(pitch * 1000) / 1000,
        rhythmScore: Math.round(rhythm * 1000) / 1000, textBonus: text,
        startSec: c.times[si], endSec: c.times[ei] + c.durs[ei]
      });
    });
    results.sort(function (a, b) { return b.score - a.score || a.name.localeCompare(b.name); });
    return { ok: true, results: results.slice(0, opts.limit || 10), queryNotes: mel.length };
  }

  // ───── 5. 索引（逐首，可暫停續跑、取消；已建且沒變就跳過）─────
  // rec: { key, path, size, mtimeMs, melody? }；melody = { sig, method, contour, status:'ok'|'failed', reason? }
  // opts: { extract(rec, ctx) → Promise<{ notes, method }>（失敗丟錯，錯誤訊息附階段）, save(rec)（寫回儲存層）,
  //         onEvent(ev), isCancelled(), waitIfPaused() → Promise（暫停時等）, retries=3, sleep(ms) }
  function sigOf(rec) { return String(rec.size || 0) + ':' + String(rec.mtimeMs || 0); }
  var TRANSIENT_RE = /network|timeout|timed out|逾時|連線|fetch/i;
  async function runMelodyIndex(recs, opts) {
    opts = opts || {};
    var emit = opts.onEvent || function () {}, cancelled = opts.isCancelled || function () { return false; };
    var wait = opts.waitIfPaused || function () { return Promise.resolve(); };
    var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var retries = opts.retries == null ? 3 : opts.retries;
    var summary = { done: 0, skipped: 0, failed: 0, cancelled: 0 };
    for (var i = 0; i < recs.length; i++) {
      var rec = recs[i];
      if (cancelled()) { summary.cancelled++; continue; }
      await wait();
      if (rec.melody && rec.melody.sig === sigOf(rec) && rec.melody.status === 'ok') { summary.skipped++; emit({ key: rec.key, status: 'skipped' }); continue; }
      emit({ key: rec.key, status: 'running' });
      var attempt = 0, done = false;
      for (;;) {
        attempt++;
        try {
          var got = await opts.extract(rec, { attempt: attempt });
          var mel = melodyNotes(got.notes);
          if (mel.length < MIN_NOTES) throw new Error('抽不出足夠的音符（只有 ' + mel.length + ' 個，階段：' + (got.method || '轉譜') + '）');
          rec.melody = { sig: sigOf(rec), status: 'ok', method: got.method, contour: contourOf(mel) };
          done = true; break;
        } catch (err) {
          var msg = String((err && err.message) || err);
          if (cancelled()) break;
          if (TRANSIENT_RE.test(msg) && attempt < retries) { emit({ key: rec.key, status: 'retry', attempt: attempt, reason: msg }); await sleep(1000 * attempt); continue; }
          rec.melody = { sig: sigOf(rec), status: 'failed', reason: msg };
          break;
        }
      }
      if (cancelled() && !done) { summary.cancelled++; emit({ key: rec.key, status: 'cancelled' }); continue; }
      if (opts.save) await opts.save(rec);
      if (done) { summary.done++; emit({ key: rec.key, status: 'done', method: rec.melody.method }); }
      else { summary.failed++; emit({ key: rec.key, status: 'failed', reason: rec.melody.reason }); }
    }
    return summary;
  }

  return {
    melodyNotes: melodyNotes, melodyFromSong: melodyFromSong, contourOf: contourOf, onsetRatios: onsetRatios,
    align: align, rhythmScore: rhythmScore, searchMelody: searchMelody, runMelodyIndex: runMelodyIndex, sigOf: sigOf,
    MIN_NOTES: MIN_NOTES, DEFAULT_MIN_SCORE: DEFAULT_MIN_SCORE
  };
}));
