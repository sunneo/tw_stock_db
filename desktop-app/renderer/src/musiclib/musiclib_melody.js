/* 音樂庫的旋律找歌核心（UMD，純函式，不碰 DOM、麥克風、網路；node 可直接跑單元測試）。
 *
 * 流程：
 *   1. 旋律：音符清單 → melodyNotes（同音高的連續重複音合併、同群起音取最高音，鼓軌不算）；
 *      MIDI 另外每軌各取一條旋律線 → songLines（索引版本 INDEX_VERSION＝2）
 *   2. 特徵：相對音程序列（與調高無關）＋粗輪廓級別（7 級）＋相鄰音長的 log2 比例（與速度無關）→ contourOf
 *   3. 比對：對音程序列做「子序列對齊」（query 全部要對上，target 任何位置開始、可跳過多餘的 target 音；
 *      query 多出的音有懲罰、query 漏音＝target 跳過，代價很小）；音高代價＝精確半音差與粗輪廓級差加權；
 *      每首的所有線（合併線＋各軌線）分別比對，取最高分，並回報命中的是哪一條線 → searchMelody
 *   4. 打擊：只比 onset 間隔比例（節奏）→ rhythmScore，獨立分數
 *   5. 索引：background 逐首建立，已建、檔案沒變、索引版本相同就跳過，可暫停、續跑、取消；失敗附階段與原因 → runMelodyIndex
 * 音訊轉音符（單音音高追蹤、Basic Pitch）不在這裡：呼叫端用 FaAudioToMidi.pitchTrack／framesToNotes 取得音符後交進來。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibMelody = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var CHORD_WIN = 0.05;        // 秒：起音差在這之內視為同一群（取最高音）
  var REPEAT_GAP = 0.05;       // 秒：同音高、前後兩音的空隔小於這個，視為同一個音（MIDI 常把一個音拆成連續短音）
  var OUTLIER_LEAP = 18;       // 半音：查詢最前／最後一個音與鄰音相差這麼多，當離群音丟掉（哼歌常在頭尾抓錯）
  var MIN_TRACK_NOTES = 8;     // 每軌（合併重複音後）至少要這麼多個音才建線
  var MAX_LINES = 12;          // 每首最多保留幾條線（合併線＋各軌線）
  var SIMILAR_TRACK = 0.9;     // 兩軌的音程序列相似度超過這個，只留一條
  var INDEX_VERSION = 2;       // 索引格式版本：2＝每軌旋律線＋重複音合併；沒有或較舊的版本，下次建立索引會自動重建
  var W_EXACT = 0.5, W_COARSE = 0.5;   // 音高代價＝W_EXACT×精確半音差＋W_COARSE×粗輪廓級差（權重見單元測試的實驗註解）
  var MIN_NOTES = 4;           // 查詢至少要幾個音，太短沒有辨識意義
  var INT_CAP = 2;             // 音程差距超過幾個半音就當成完全不同（單位：半音）；取小一點，無關旋律才分得開
  var RATIO_CAP = 1;           // 節奏比例差距（log2）超過 1 就當完全不同（= 兩倍）
  var GAP_QUERY = 1.0;         // query 多出一個音的代價（不能太便宜，否則無關旋律會靠「略過」湊分）
  var SKIP_TARGET = 0.3;       // 跳過 target 的音（查詢漏音）的代價：不能太小，否則任何旋律都能靠跳音湊對（0.15→0.3 校準：對照隨機曲子的分數中位數 0.45→0.35）
  var DEFAULT_MIN_SCORE = 0.4; // 校準見單元測試「合成資料校準」：0.4 時目標召回約 84%、隨機對照約 17% 的查詢會誤中一首（0.35 時誤中過半）

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round3(x) { return Math.round(x * 1000) / 1000; }

  // ───── 1. 旋律 ─────
  // notes: [{t(秒), d(秒), n(音高), v}]。先合併同音高、空隔小於 REPEAT_GAP 的連續音；再同群起音只留最高音（音高相同留較長的）
  function melodyNotes(notes) {
    var src = (notes || []).filter(function (x) { return x && isFinite(x.t) && isFinite(x.n) && (x.d || 0) > 0; })
      .map(function (x) { return { t: +x.t, d: +x.d, n: +x.n }; })
      .sort(function (a, b) { return a.t - b.t || b.n - a.n; });
    var rep = [];
    for (var r = 0; r < src.length; r++) {
      var y = src[r], p = rep[rep.length - 1];
      if (p && p.n === y.n && y.t - (p.t + p.d) < REPEAT_GAP) { p.d = Math.max(p.d, y.t + y.d - p.t); continue; }
      rep.push(y);
    }
    var out = [];
    for (var i = 0; i < rep.length; i++) {
      var x = rep[i], last = out[out.length - 1];
      if (last && x.t - last.t < CHORD_WIN) {
        if (x.n > last.n || (x.n === last.n && x.d > last.d)) out[out.length - 1] = x;
        continue;
      }
      out.push(x);
    }
    return out;
  }
  // 與 FaMidi.ticksToSec 相同的速度表換算（這裡不依賴 midi_core，好讓這個檔可以獨立載入）
  function ticksToSec(song, tick) {
    var tp = song.tempos && song.tempos.length ? song.tempos : [{ t: 0, bpm: 120 }], ppq = song.ppq || 480;
    var sec = 0, last = 0, bpm = tp[0].bpm;
    for (var i = 1; i < tp.length && tp[i].t < tick; i++) { sec += (tp[i].t - last) / ppq * 60 / bpm; last = tp[i].t; bpm = tp[i].bpm; }
    return sec + (tick - last) / ppq * 60 / bpm;
  }
  // song（FaMidi 曲子，音符時間是 tick）→ 主旋律（秒）：所有非鼓軌音符合併後取旋律
  function melodyFromSong(song) {
    var all = [];
    ((song && song.tracks) || []).forEach(function (tr) {
      if (tr.drum) return;
      (tr.notes || []).forEach(function (n) {
        var t0 = ticksToSec(song, n.t), t1 = ticksToSec(song, n.t + n.d);
        all.push({ t: t0, d: t1 - t0, n: n.n, v: n.v });
      });
    });
    return melodyNotes(all);
  }
  // 全序列的音程相似度（0..1）：編輯距離（音程差 0..2 半音的替換代價，插入刪除各 1），除以較長的長度
  function globalSim(a, b) {
    var m = a.length, n = b.length;
    if (!m || !n) return 0;
    var prev = new Float64Array(n + 1), cur = new Float64Array(n + 1), i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        var sub = prev[j - 1] + Math.min(Math.abs(a[i - 1] - b[j - 1]), 2) / 2;
        cur[j] = Math.min(sub, prev[j] + 1, cur[j - 1] + 1);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return clamp(1 - prev[n] / Math.max(m, n), 0, 1);
  }
  // ── 單軌的聲部線 ──
  // 哼歌的查詢永遠是「單一條旋律線」：人不可能同時哼出兩個旋律（除非 beatbox）。所以索引端要把每首曲子拆成「所有可能被人哼出來的單線」，
  // 而不是把整首壓成一條。拿音樂錄音當查詢時，查詢本身就是多聲部壓成的一條線，所以和合併線比對得上；哼歌不行。
  // 單軌內同一起音群（CHORD_WIN 內）有多個音（和弦、琶音）時，該軌另外產生：
  //   最高音線（hi）：每群取最高音；最低音線（lo）：每群取最低音（人也會哼低音）；
  //   中聲部線（mid）：群內 3 個音以上時取中間那個（旋律常在中間，上面被高音琶音蓋住、下面有低音）。
  // 沒有多音群的軌只有一條線（one）。
  function voicesOf(ns) {
    var sorted = ns.slice().sort(function (x, y) { return x.t - y.t || x.n - y.n; });
    var groups = [], multi = false;
    sorted.forEach(function (x) {
      var g = groups[groups.length - 1];
      if (g && x.t - g[0].t < CHORD_WIN) g.push(x); else groups.push([x]);
    });
    var hi = [], lo = [], mid = [];
    groups.forEach(function (g) {
      if (g.length > 1) multi = true;
      g.sort(function (x, y) { return x.n - y.n; });
      hi.push(g[g.length - 1]); lo.push(g[0]);
      if (g.length >= 3) mid.push(g[(g.length - 1) >> 1]);
    });
    return { multi: multi, hi: hi, lo: lo, mid: mid };
  }
  var REG_MID = 64;   // 音域中段的參考音高（MIDI 音號）：每首線數超過上限時，離這裡近的線優先保留
  var KIND_ORDER = { one: 0, hi: 1, mid: 2, lo: 3 };
  var KIND_LABEL = { one: '', hi: ' 最高音', mid: ' 中聲部', lo: ' 最低音' };
  // song → { mix: 合併旋律（同 melodyFromSong）, tracks: [{ track, channel, name, kind, label, notes:[[t,d,n]], contour }] }
  // 每個非鼓軌：單聲部一條；多聲部再加最高音、最低音、中聲部（各自合併重複音後至少 MIN_TRACK_NOTES 個音）。
  // 音程序列近乎相同（相似度 > SIMILAR_TRACK）只留一條；每首線數（含合併線）最多 MAX_LINES 條。
  // 超過上限時的優先順序：音數多 → 音域離中段近 → 軌號小、kind 固定順序；再依序略過與已留下的線重複的。
  function labelOf(channel, track, mode) {
    return (channel != null ? '頻道 ' + channel : '軌 ' + track) + KIND_LABEL[mode];
  }
  // 每首候選線（還沒去重、沒設上限）。索引（songLines）與播放時重建（lineOf）共用這一套規則，兩邊才會逐音一致
  function candidatesOf(song) {
    var cand = [];
    ((song && song.tracks) || []).forEach(function (tr, i) {
      if (tr.drum) return;
      var ns = (tr.notes || []).map(function (n) {
        var t0 = ticksToSec(song, n.t), t1 = ticksToSec(song, n.t + n.d);
        return { t: t0, d: t1 - t0, n: n.n, v: n.v };
      });
      var v = voicesOf(ns), chName = tr.channel == null ? null : +tr.channel, name = String(tr.name || '');
      var variants = [{ kind: v.multi ? 'hi' : 'one', list: v.hi }];
      if (v.multi) { variants.push({ kind: 'lo', list: v.lo }); variants.push({ kind: 'mid', list: v.mid }); }
      variants.forEach(function (vr) {
        var mel = melodyNotes(vr.list);
        if (mel.length < MIN_TRACK_NOTES) return;
        var reg = mel.reduce(function (s, x) { return s + x.n; }, 0) / mel.length;
        cand.push({ track: i, channel: chName, name: name, kind: vr.kind, mel: mel, reg: reg, contour: contourOf(mel) });
      });
    });
    return cand;
  }
  // 音符 → [起點秒, 長度秒, 音高]（秒取到毫秒，與索引存的格式相同）
  function tuplesOf(mel) { return mel.map(function (x) { return [round3(x.t), round3(x.d), x.n]; }); }
  // song → { mix: 合併旋律（同 melodyFromSong）, tracks: [{ track, channel, name, kind, label, notes:[[t,d,n]], contour }] }
  // 每個非鼓軌：單聲部一條；多聲部再加最高音、最低音、中聲部（各自合併重複音後至少 MIN_TRACK_NOTES 個音）。
  // 音程序列近乎相同（相似度 > SIMILAR_TRACK）只留一條；每首線數（含合併線）最多 MAX_LINES 條。
  // 超過上限時的優先順序：音數多 → 音域離中段近 → 軌號小、kind 固定順序；再依序略過與已留下的線重複的。
  function songLines(song) {
    var mix = melodyFromSong(song), cand = candidatesOf(song);
    cand.sort(function (x, y) {
      return (y.mel.length - x.mel.length) || (Math.abs(x.reg - REG_MID) - Math.abs(y.reg - REG_MID)) ||
        (x.track - y.track) || (KIND_ORDER[x.kind] - KIND_ORDER[y.kind]);
    });
    var kept = [];
    cand.forEach(function (c) {
      var dup = kept.some(function (k) { return globalSim(k.contour.intervals, c.contour.intervals) > SIMILAR_TRACK; });
      if (!dup && kept.length < MAX_LINES - 1) kept.push(c);
    });
    kept.sort(function (x, y) { return x.track - y.track || KIND_ORDER[x.kind] - KIND_ORDER[y.kind]; });
    return {
      mix: mix,
      tracks: kept.map(function (c) {
        return { track: c.track, channel: c.channel, name: c.name, kind: c.kind, label: labelOf(c.channel, c.track, c.kind),
          notes: tuplesOf(c.mel), contour: c.contour };
      })
    };
  }
  // 播放時重建「命中的那條線」：從同一份解析好的曲子取出（track＝軌索引、mode＝one／hi／lo／mid；合併線 track 傳 null 或 mode 'merged'）。
  // 回傳 { label, track, mode, notes: [[t,d,n]]（秒）, contour }；找不到（例如那軌太短）回傳 null
  function lineOf(song, track, mode) {
    if (track == null || mode === 'merged') {
      var mix = melodyFromSong(song);
      return { label: '合併（所有軌）', track: null, mode: 'merged', notes: tuplesOf(mix), contour: contourOf(mix) };
    }
    var c = candidatesOf(song).filter(function (x) { return x.track === track && x.kind === mode; })[0];
    if (!c) return null;
    return { label: labelOf(c.channel, c.track, c.kind), track: c.track, mode: c.kind, notes: tuplesOf(c.mel), contour: c.contour };
  }

  // ───── 2. 特徵 ─────
  // 粗輪廓級別：音程 → 7 級（0 持平；±1 小上／小下 1–2 半音；±2 中 3–5；±3 大 ≥6）
  function levelOf(d) {
    var a = Math.abs(d), s = d < 0 ? -1 : (d > 0 ? 1 : 0);
    if (a === 0) return 0;
    return s * (a <= 2 ? 1 : (a <= 5 ? 2 : 3));
  }
  // mel: melodyNotes 的輸出。回傳相對音程（半音，有號）、粗輪廓級別、相鄰音長的 log2 比例，以及每個音的起點與長度（用來換算命中時間）
  function contourOf(mel) {
    var n = mel.length, intervals = [], levels = [], ratios = [], times = [], durs = [];
    for (var i = 0; i < n; i++) { times.push(mel[i].t); durs.push(Math.max(0.02, mel[i].d)); }
    for (var k = 0; k + 1 < n; k++) {
      var iv = clamp(mel[k + 1].n - mel[k].n, -12, 12);
      intervals.push(iv); levels.push(levelOf(iv));
      ratios.push(clamp(Math.log2(durs[k + 1] / durs[k]), -2, 2));
    }
    return { n: n, intervals: intervals, levels: levels, ratios: ratios, times: times, durs: durs };
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
  // 音高代價用的元素：{ e: 音程（半音）, l: 粗輪廓級別 }
  function pitchItems(c) {
    var out = [];
    for (var i = 0; i < c.intervals.length; i++) out.push({ e: c.intervals[i], l: c.levels ? c.levels[i] : levelOf(c.intervals[i]) });
    return out;
  }
  function pitchOpts() {
    return {
      sub: function (a, b) { return W_EXACT * Math.min(Math.abs(a.e - b.e), INT_CAP) / INT_CAP + W_COARSE * Math.abs(a.l - b.l) / 6; },
      gapQuery: GAP_QUERY, skipTarget: SKIP_TARGET
    };
  }
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
  // 查詢音符的離群處理：最前或最後一個音與鄰音相差 ≥ OUTLIER_LEAP 半音，丟掉（只看頭尾各一次）
  function dropOutliers(mel) {
    var out = mel.slice();
    if (out.length >= 3 && Math.abs(out[0].n - out[1].n) >= OUTLIER_LEAP) out.shift();
    if (out.length >= 3 && Math.abs(out[out.length - 1].n - out[out.length - 2].n) >= OUTLIER_LEAP) out.pop();
    return out;
  }
  // 一條線的比對：回傳 { raw, pitch, rhythm, start, end }
  function scoreLine(qc, qItems, c, w, po, ro) {
    var p = align(qItems, pitchItems(c), po), pitch = toScore(p.norm);
    var rhythm = qc.ratios.length >= 2 ? toScore(align(qc.ratios, c.ratios, ro).norm) : 0;
    return { pitch: pitch, rhythm: rhythm, raw: w.pitch * pitch + w.rhythm * rhythm, start: p.start, end: p.end };
  }
  // query：音符（秒）；entries：[{ key, name, lines?: [{ label, contour }], contour? }]。沒有 lines 時，contour 當成唯一一條線。
  // 每首取所有線中最高分的那條，回報 hitLine（線的名稱，例如「頻道 1」）與命中的秒數範圍
  // opts: { minScore=0.35, limit=10, textHits（Set 或物件，key 命中就加分）, textWeight=0.1, weights={pitch:0.8, rhythm:0.2} }
  function searchMelody(query, entries, opts) {
    opts = opts || {};
    var mel = dropOutliers(melodyNotes(query));
    if (mel.length < MIN_NOTES) return { ok: false, reason: '哼得太短（至少要 ' + MIN_NOTES + ' 個音）', results: [] };
    var qc = contourOf(mel), qItems = pitchItems(qc), w = Object.assign({ pitch: 0.8, rhythm: 0.2 }, opts.weights || {});
    var minScore = opts.minScore == null ? DEFAULT_MIN_SCORE : opts.minScore, textWeight = opts.textWeight == null ? 0.1 : opts.textWeight;
    var po = pitchOpts(), ro = rhythmOpts(), results = [];
    (entries || []).forEach(function (e) {
      var lines = e.lines && e.lines.length ? e.lines : (e.contour ? [{ label: '', contour: e.contour }] : []);
      var best = null, bestLine = null;
      lines.forEach(function (ln) {
        var c = ln.contour; if (!c || c.n < 2) return;
        var s = scoreLine(qc, qItems, c, w, po, ro);
        if (!best || s.raw > best.raw) { best = s; bestLine = { label: ln.label || '', track: ln.track == null ? null : ln.track, mode: ln.mode || 'merged', c: c }; }
      });
      if (!best) return;
      var text = opts.textHits && (opts.textHits instanceof Set ? opts.textHits.has(e.key) : !!opts.textHits[e.key]) ? textWeight : 0;
      var score = contrast(best.raw + text);
      if (score < minScore) return;
      var c2 = bestLine.c, si = clamp(best.start, 0, c2.n - 1), ei = clamp(best.end, 0, c2.n - 1);
      results.push({
        key: e.key, name: e.name, score: Math.round(score * 1000) / 1000, pitchScore: Math.round(best.pitch * 1000) / 1000,
        rhythmScore: Math.round(best.rhythm * 1000) / 1000, textBonus: text, hitLine: bestLine.label,
        startSec: c2.times[si], endSec: c2.times[ei] + c2.durs[ei],
        hit: { track: bestLine.track, mode: bestLine.mode, label: bestLine.label, noteFrom: si, noteTo: ei }
      });
    });
    results.sort(function (a, b) { return b.score - a.score || a.name.localeCompare(b.name); });
    return { ok: true, results: results.slice(0, opts.limit || 10), queryNotes: mel.length };
  }

  // ───── 5. 索引（逐首，可暫停續跑、取消；已建、沒變、版本相同就跳過）─────
  // rec: { key, path, size, mtimeMs, melody? }；melody = { sig, version, method, contour, tracks, status:'ok'|'failed', reason? }
  // opts: { extract(rec, ctx) → Promise<{ notes, method, tracks? }>（失敗丟錯，錯誤訊息附階段）, save(rec)（寫回儲存層）,
  //         onEvent(ev), isCancelled(), waitIfPaused() → Promise（暫停時等）, retries=3, sleep(ms) }
  // 回傳 summary：done、skipped、failed、cancelled、rebuilt（舊索引格式版本，這次要重建的首數）
  function sigOf(rec) { return String(rec.size || 0) + ':' + String(rec.mtimeMs || 0); }
  var TRANSIENT_RE = /network|timeout|timed out|逾時|連線|fetch/i;
  function isStaleFormat(rec) { return !!(rec.melody && rec.melody.status === 'ok' && (rec.melody.version || 1) < INDEX_VERSION); }
  async function runMelodyIndex(recs, opts) {
    opts = opts || {};
    var emit = opts.onEvent || function () {}, cancelled = opts.isCancelled || function () { return false; };
    var wait = opts.waitIfPaused || function () { return Promise.resolve(); };
    var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var retries = opts.retries == null ? 3 : opts.retries;
    var summary = { done: 0, skipped: 0, failed: 0, cancelled: 0, rebuilt: 0 };
    for (var i = 0; i < recs.length; i++) {
      var rec = recs[i];
      if (cancelled()) { summary.cancelled++; continue; }
      await wait();
      if (rec.melody && rec.melody.sig === sigOf(rec) && rec.melody.status === 'ok' && !isStaleFormat(rec)) { summary.skipped++; emit({ key: rec.key, status: 'skipped' }); continue; }
      var stale = isStaleFormat(rec);
      emit({ key: rec.key, status: 'running' });
      var attempt = 0, done = false;
      for (;;) {
        attempt++;
        try {
          var got = await opts.extract(rec, { attempt: attempt });
          var mel = melodyNotes(got.notes);
          if (mel.length < MIN_NOTES) throw new Error('抽不出足夠的音符（只有 ' + mel.length + ' 個，階段：' + (got.method || '轉譜') + '）');
          rec.melody = { sig: sigOf(rec), version: INDEX_VERSION, status: 'ok', method: got.method, contour: contourOf(mel), tracks: got.tracks || [] };
          done = true; break;
        } catch (err) {
          var msg = String((err && err.message) || err);
          if (cancelled()) break;
          if (TRANSIENT_RE.test(msg) && attempt < retries) { emit({ key: rec.key, status: 'retry', attempt: attempt, reason: msg }); await sleep(1000 * attempt); continue; }
          rec.melody = { sig: sigOf(rec), version: INDEX_VERSION, status: 'failed', reason: msg };
          break;
        }
      }
      if (cancelled() && !done) { summary.cancelled++; emit({ key: rec.key, status: 'cancelled' }); continue; }
      if (stale) summary.rebuilt++;
      if (opts.save) await opts.save(rec);
      if (done) { summary.done++; emit({ key: rec.key, status: 'done', method: rec.melody.method }); }
      else { summary.failed++; emit({ key: rec.key, status: 'failed', reason: rec.melody.reason }); }
    }
    return summary;
  }

  // ───── 6. 對照聽 ─────
  // 哼歌的音符與命中線的音符（都是秒＋音高）→ 兩段：先哼歌，停 COMPARE_GAP 秒，再命中的那段。
  // 命中段整段一起以八度（12 的倍數）平移，使中位音高落在哼歌中位音高 ±COMPARE_RANGE 半音內；音程、音長與段內時間都不變。
  var COMPARE_GAP = 0.8, COMPARE_RANGE = 6;
  function median(a) {
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length;
    if (!m) return NaN;
    return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
  }
  // humNotes、hitNotes：[{t,d,n}]（秒）。回傳 { hum, hit（已平移、排在哼歌之後 COMPARE_GAP 秒）, shift（平移的半音數）, humMedian, hitMedian, hitStart }
  function compareNotes(humNotes, hitNotes) {
    var ok = function (x) { return !!x && isFinite(x.t) && isFinite(x.n) && (x.d || 0) > 0; };
    var copy = function (x) { return { t: +x.t, d: +x.d, n: +x.n }; };
    var byT = function (a, b) { return a.t - b.t || a.n - b.n; };
    var hum = (humNotes || []).filter(ok).map(copy).sort(byT), hit = (hitNotes || []).filter(ok).map(copy).sort(byT);
    if (!hum.length || !hit.length) throw new Error('沒有可對照的音符');
    var hm = median(hum.map(function (x) { return x.n; })), hmed = median(hit.map(function (x) { return x.n; }));
    var shift = 12 * Math.round((hm - hmed) / 12);
    var humEnd = Math.max.apply(null, hum.map(function (x) { return x.t + x.d; }));
    var start = humEnd + COMPARE_GAP, base = hit[0].t;
    return {
      hum: hum,
      hit: hit.map(function (x) { return { t: start + (x.t - base), d: x.d, n: x.n + shift }; }),
      shift: shift, humMedian: hm, hitMedian: hmed + shift, hitStart: start
    };
  }

  return {
    melodyNotes: melodyNotes, melodyFromSong: melodyFromSong, songLines: songLines, lineOf: lineOf, compareNotes: compareNotes, median: median,
    COMPARE_GAP: COMPARE_GAP, COMPARE_RANGE: COMPARE_RANGE, contourOf: contourOf, onsetRatios: onsetRatios,
    align: align, rhythmScore: rhythmScore, searchMelody: searchMelody, runMelodyIndex: runMelodyIndex, sigOf: sigOf,
    dropOutliers: dropOutliers, globalSim: globalSim, levelOf: levelOf,
    MIN_NOTES: MIN_NOTES, DEFAULT_MIN_SCORE: DEFAULT_MIN_SCORE, INDEX_VERSION: INDEX_VERSION
  };
}));
