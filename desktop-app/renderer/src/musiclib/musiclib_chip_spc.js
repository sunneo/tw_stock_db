/* SPC（SNES 音效檔）晶片後端：用 musiclib_spc_core.js 的 SPC700＋S-DSP 核心渲染成 PCM。純邏輯（UMD，不碰 DOM、不用網路）。
 *   createBackend(CORE, SFC) → 後端物件（kind = 'spc'），交給 FaChipPlayer.registerBackend 註冊。
 *   後端介面：canLoad(bytes)、parse(bytes) → { title, artist, spc, tracks:[{ title, durationSec, durationNote }] }、
 *            openStream(loaded, trackIndex, sampleRate) → { read(out, off, n)、snapshot()、restore(s) }。
 *   toMidi(loaded, trackIndex) → 標準 MIDI 曲子：另開一個核心跑完整首，依 KON／KOFF／ENVX 決定音符起訖，
 *            音高取音符期間的中位數，相對換算並整首平移到 36–96（規則見 collectNotes／buildSong 上方的註解）。
 *
 * 做法：
 *   1. SPC 檔由 FaMusicLibSfc.parseSpc 解析（RAM、DSP 暫存器、SPC700 暫存器、ID666 長度）。
 *   2. 核心以 32000 Hz 產生立體聲，這裡取左右平均成單聲道，再用線性內插重取樣到播放器要的取樣率（預設 44100）。
 *   3. 曲長：ID666 的長度欄位（文字格式）；沒有寫或為 0 時用 180 秒預設（durationNote 會寫明）。
 *   4. seek：快照是核心狀態的完整複本加上重取樣佇列，由播放核心決定檢查點。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./musiclib_spc_core.js'), require('./musiclib_extract_sfc.js'));
  else root.FaChipSpc = factory(typeof FaMusicLibSpcCore !== 'undefined' ? FaMusicLibSpcCore : root.FaMusicLibSpcCore, typeof FaMusicLibSfc !== 'undefined' ? FaMusicLibSfc : root.FaMusicLibSfc);
}(typeof self !== 'undefined' ? self : this, function (CORE, SFC) {
  'use strict';
  var CORE_RATE = 32000, DEFAULT_SEC = 180, CHUNK = 4096, QUEUE_KEEP = 1 << 16;

  function createBackend() {
    if (!CORE || typeof CORE.fromSpc !== 'function') throw new Error('缺少 SPC 核心（FaMusicLibSpcCore）');
    if (!SFC || typeof SFC.parseSpc !== 'function') throw new Error('缺少 SPC 檔解析（FaMusicLibSfc）');
    return {
      kind: 'spc', label: 'SPC（SNES SPC700＋S-DSP，自寫核心）',
      canLoad: function (bytes) {
        var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        return b.length >= 0x10200 && String.fromCharCode.apply(null, b.subarray(0, 33)) === 'SNES-SPC700 Sound File Data v0.30';
      },
      parse: function (bytes) {
        var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        var spc = SFC.parseSpc(b);
        if (!spc.ok) throw new Error(spc.reason);
        var secs = spc.lengthSec > 0 ? spc.lengthSec : DEFAULT_SEC;
        var note = spc.lengthSec > 0 ? 'ID666 長度' : '檔案沒有長度標籤，用 ' + DEFAULT_SEC + ' 秒預設';
        return {
          title: spc.title || spc.game || 'SPC', artist: spc.artist || '', spc: spc,
          tracks: [{ title: spc.title || 'SPC', durationSec: secs, durationNote: note }]
        };
      },
      openStream: function (loaded, trackIndex, sampleRate) {
        if (trackIndex !== 0 || !loaded.tracks[0]) throw new Error('SPC 只有一首曲目');
        return makeStream(loaded.spc, sampleRate || 44100);
      },
      toMidi: function (loaded, trackIndex) {
        if (trackIndex !== 0 || !loaded.tracks[0]) throw new Error('SPC 只有一首曲目');
        return makeMidi(loaded.spc, loaded.title, loaded.tracks[0].durationSec);
      }
    };
  }

  // ───── SPC 專用 MIDI 擷取（不用 dspEventsToSong；那個維持原樣、有自己的測試）─────
  // 規則：
  //  · 起訖：KON 寫入開始；KOFF 寫入結束（進入釋放）；聲道變成 OFF 或包絡 ENVX 歸零也結束。
  //  · 音高：音符期間每 POLL 個取樣讀一次 pitch 暫存器取中位數；顫音、滑音不切新音符。
  //  · 音高暫存器 × 32000 ÷ 4096 是取樣播放速率，不是音高。沒有樣本基準頻率，所以每個聲道以它最常出現的音高為中心（MIDI 60），
  //    用 12·log2(音高 ÷ 中心) 相對換算；整首再以八度為單位平移，讓最多的音落在 36–96。
  //  · 每個 SRCN 對應一個 MIDI 聲道（跳過聲道 10）；短（< 0.25 秒）且音高不穩（跨度 ≥ 1 半音）的音符放聲道 10（鼓）。
  //  · 不足 5 毫秒的音符丟棄，不產生 0 長度音符。
  var POLL = 64, MIN_SEC = 0.005, DRUM_SEC = 0.25, LO = 36, HI = 96, DRUM_CH = 9, TPS = 960;   // TPS：ppq 480、120 BPM
  var MELODY_CH = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];

  // 第一步：收集原始音符（起訖取樣序號、SRCN、音高樣本、ENVX 最大值）
  function collectNotes(spc, seconds) {
    var total = Math.round(seconds * CORE_RATE), events = [], notes = [], open = [], q, t;
    var core = CORE.fromSpc(spc, { onDspWrite: function (r, v, tick) { if (r === 0x4C || r === 0x5C) events.push({ t: tick, reg: r, value: v }); } });
    function pitchOf(v) { return core.dspRead(v * 16 + 2) | ((core.dspRead(v * 16 + 3) & 0x3F) << 8); }
    function openNote(v, at) { open[v] = { v: v, start: at, end: at, srcn: core.dspRead(v * 16 + 4), pitches: [], env: 0, polls: 0, released: false }; }
    function closeNote(v, at) { var n = open[v]; if (!n) return; n.end = at; notes.push(n); open[v] = null; }
    for (q = 0; q < 8; q++) if (core.voiceMode(q) !== 0) openNote(q, 0);      // 載入時就在發聲的聲道
    for (t = 0; t < total; t += POLL) {
      var tEnd = Math.min(total, t + POLL);
      core.runSamples(tEnd - t);
      for (var ei = 0; ei < events.length; ei++) {
        var e = events[ei];
        for (var b = 0; b < 8; b++) {
          var bit = 1 << b;
          if (e.reg === 0x4C && (e.value & bit)) { if (open[b]) closeNote(b, e.t); openNote(b, e.t); }
          else if (e.reg === 0x5C && (e.value & bit) && open[b] && !open[b].released) { open[b].released = true; closeNote(b, e.t); }
        }
      }
      events.length = 0;
      for (q = 0; q < 8; q++) {
        var n = open[q];
        if (!n) continue;
        var env = core.dspRead(q * 16 + 8);
        if (core.voiceMode(q) === 0 || (env === 0 && n.polls > 1)) { closeNote(q, tEnd); continue; }
        n.polls++;
        if (env > n.env) n.env = env;
        var p = pitchOf(q);
        if (p > 0) n.pitches.push(p);
      }
    }
    for (q = 0; q < 8; q++) closeNote(q, total);
    return notes;
  }

  // 第二步：換成 MIDI 曲子（與 FaMidi 同形）。回傳 { song, stats }
  function buildSong(raw, title) {
    var stats = { raw: raw.length, shortDropped: 0, noPitch: 0, drumNotes: 0, melodyNotes: 0, shiftSemitones: 0, clamped: 0, channels: 0 };
    var kept = [];
    raw.forEach(function (n) {
      var dur = n.end - n.start;
      if (dur < MIN_SEC * CORE_RATE) { stats.shortDropped++; return; }
      if (!n.pitches.length) { stats.noPitch++; return; }
      var ps = n.pitches.slice().sort(function (a, b) { return a - b; });
      kept.push({ srcn: n.srcn, start: n.start, dur: dur, med: ps[ps.length >> 1], spread: 12 * Math.log2(ps[ps.length - 1] / ps[0]), env: n.env,
        drum: dur < DRUM_SEC * CORE_RATE && 12 * Math.log2(ps[ps.length - 1] / ps[0]) >= 1, ch: 0, base: 0 });
    });
    // 聲道：每個 SRCN 一個聲道（依第一次出現的順序），鼓放聲道 10
    var chOfSrcn = {}, srcnOfCh = {}, nextCh = 0;
    kept.forEach(function (n) {
      if (n.drum) { n.ch = DRUM_CH; return; }
      if (!(n.srcn in chOfSrcn)) { var c = MELODY_CH[nextCh % MELODY_CH.length]; nextCh++; chOfSrcn[n.srcn] = c; srcnOfCh[c] = n.srcn; }
      n.ch = chOfSrcn[n.srcn];
    });
    // 每個聲道的中心音：最常出現的音符中位數音高（同次數取先出現者）
    var chans = {};
    kept.forEach(function (n) { (chans[n.ch] = chans[n.ch] || []).push(n); });
    Object.keys(chans).forEach(function (key) {
      var cnt = {}, best = null, bc = -1;
      chans[key].forEach(function (n) { cnt[n.med] = (cnt[n.med] || 0) + 1; if (cnt[n.med] > bc) { bc = cnt[n.med]; best = n.med; } });
      chans[key].forEach(function (n) { n.base = Math.round(60 + 12 * Math.log2(n.med / best)); });
    });
    // 整首平移（八度）：讓落在 36–96 的旋律音最多；同樣多取離 60 最近的
    var mel = kept.filter(function (n) { return !n.drum; });
    var bestK = 0, bestCount = -1;
    for (var k = -6; k <= 6; k++) {
      var inRange = 0;
      mel.forEach(function (n) { var v = n.base + 12 * k; if (v >= LO && v <= HI) inRange++; });
      if (inRange > bestCount || (inRange === bestCount && Math.abs(k) < Math.abs(bestK))) { bestCount = inRange; bestK = k; }
    }
    stats.shiftSemitones = bestK * 12;
    mel.forEach(function (n) { n.base += bestK * 12; });
    // 輸出：限制在 36–96（超出的數量記入 clamped）
    var byCh = {};
    kept.forEach(function (n) {
      var v = n.base;
      if (v < LO || v > HI) { stats.clamped++; v = Math.max(LO, Math.min(HI, v)); }
      if (n.drum) stats.drumNotes++; else stats.melodyNotes++;
      (byCh[n.ch] = byCh[n.ch] || []).push({ t: Math.round(n.start / CORE_RATE * TPS), d: Math.max(1, Math.round(n.dur / CORE_RATE * TPS)), n: v, v: Math.max(1, Math.min(127, n.env)) });
    });
    var tracks = [];
    Object.keys(byCh).map(Number).sort(function (a, b) { return a - b; }).forEach(function (c) {
      var drum = c === DRUM_CH;
      tracks.push({ name: drum ? '鼓（聲道 10）' : 'SRCN ' + srcnOfCh[c], channel: c, program: drum ? 0 : 80, drum: drum, volume: 100, pan: 64,
        notes: byCh[c].sort(function (a, b) { return a.t - b.t; }) });
    });
    stats.channels = tracks.length;
    return { song: { ppq: 480, tempos: [{ t: 0, bpm: 120 }], timesig: { n: 4, d: 4 }, title: title || '', tracks: tracks }, stats: stats };
  }

  function makeMidi(spc, title, seconds) { return buildSong(collectNotes(spc, seconds), title).song; }

  // 串流：核心以 32 kHz 產生，依播放取樣率線性內插讀出
  function makeStream(spc, sr) {
    var core = CORE.fromSpc(spc), ratio = CORE_RATE / sr;
    var q = new Float32Array(CHUNK * 4), qStart = 0, qLen = 0, outCount = 0;
    function produce() {
      var L = new Float32Array(CHUNK), R = new Float32Array(CHUNK);
      core.renderStereo(L, R, 0, CHUNK);
      if (qLen + CHUNK > q.length) {
        // 放不下：先丟掉已用過的前段，還不夠就擴充
        var keepFrom = Math.max(0, (outCount * ratio | 0) - 4 - qStart);
        var nq = new Float32Array(Math.max(q.length, (qLen - keepFrom + CHUNK) * 2));
        nq.set(q.subarray(keepFrom, qLen)); qStart += keepFrom; qLen -= keepFrom; q = nq;
      }
      for (var i = 0; i < CHUNK; i++) q[qLen + i] = (L[i] + R[i]) * 0.5;
      qLen += CHUNK;
    }
    function get(i) {
      while (qStart + qLen <= i + 1) produce();
      return q[i - qStart];
    }
    return {
      read: function (out, off, n) {
        for (var k = 0; k < n; k++) {
          var p = (outCount + k) * ratio, i = Math.floor(p), f = p - i;
          var a = get(i), b = get(i + 1);
          out[off + k] = a + (b - a) * f;
        }
        outCount += n;
        return n;
      },
      snapshot: function () {
        return { core: core.snapshot(), q: q.slice(0, qLen), qStart: qStart, qLen: qLen, outCount: outCount };
      },
      restore: function (s) {
        core.restore(s.core);
        q = new Float32Array(Math.max(CHUNK * 4, s.q.length * 2)); q.set(s.q);
        qStart = s.qStart; qLen = s.qLen; outCount = s.outCount;
      }
    };
  }

  return { createBackend: createBackend, makeStream: makeStream, makeMidi: makeMidi, collectNotes: collectNotes, buildSong: buildSong };
}));
