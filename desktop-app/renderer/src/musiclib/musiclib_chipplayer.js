/* 晶片音樂播放器：共用介面與播放核心（純邏輯，UMD，不碰 DOM／網路／音訊裝置）。
 *   後端註冊：FaChipPlayer.registerBackend(backend)。後端介面（RIX、NSF、SPC、PCE 各接一個）：
 *     backend.kind          字串，例如 'rix'
 *     backend.label         顯示名稱
 *     backend.parse(bytes)  → loaded：{ title, tracks: [{ title, durationSec }], …後端自己要留的東西 }
 *     backend.openStream(loaded, trackIndex, sampleRate) → stream：{ read(out, off, n)、snapshot()、restore(s) }
 *         stream.read 每次產生 n 個單聲道樣本（Float32，約 −1..1）；snapshot／restore 保存完整晶片狀態（給 seek 用）。
 *     backend.toMidi(loaded, trackIndex) → 標準 MIDI 曲子（可選；沒有就不能匯出 MIDI，要說明原因）
 *   播放器（createPlayer）：load、曲目列表、render(曲目, 起點秒, 長度秒) → PCM、durationSec、seek(秒)。
 *   晶片不能任意跳轉：seek 從最近的「檢查點」還原狀態，再靜音快速模擬到目標時間（檢查點每 checkpointSec 秒記一次）。
 *   parseGoto(文字)：「1:23」「83」「1:02:03」→ 時間；「曲目 3」「t3」「#3」→ 曲目編號（從 1 起算）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaChipPlayer = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var backends = {};
  var DEFAULT_RATE = 44100, DEFAULT_CHECKPOINT_SEC = 5;

  function registerBackend(b) {
    if (!b || !b.kind || typeof b.parse !== 'function' || typeof b.openStream !== 'function') throw new Error('晶片後端缺少 kind／parse／openStream');
    backends[b.kind] = b;
    return b;
  }
  function getBackend(kind) { if (!backends[kind]) throw new Error('沒有這個晶片格式的播放後端：' + kind); return backends[kind]; }
  function listBackends() { return Object.keys(backends).map(function (k) { return { kind: k, label: backends[k].label || k }; }); }

  // 從 bytes 建立播放器（load）。opts: { sampleRate, checkpointSec }
  function createPlayer(kind, bytes, opts) {
    opts = opts || {};
    var be = getBackend(kind);
    var loaded = be.parse(bytes);
    if (!loaded || !loaded.tracks || !loaded.tracks.length) throw new Error('解析完成但沒有曲目');
    var sr = opts.sampleRate || DEFAULT_RATE;
    var cpSamples = Math.round((opts.checkpointSec || DEFAULT_CHECKPOINT_SEC) * sr);
    var cur = { track: 0, stream: null, pos: 0, cps: [] };   // cps：檢查點 { pos, snap }，依 pos 遞增

    function trackInfo(i) {
      var tr = loaded.tracks[i]; if (!tr) throw new Error('沒有第 ' + (i + 1) + ' 首曲目（共 ' + loaded.tracks.length + ' 首）');
      return tr;
    }
    function durationSec(i) { return trackInfo(i == null ? cur.track : i).durationSec; }
    function totalSamples(i) { return Math.round(durationSec(i) * sr); }

    // 切換曲目：重開串流、清檢查點
    function setTrack(i) {
      trackInfo(i);
      cur.track = i; cur.stream = be.openStream(loaded, i, sr); cur.pos = 0; cur.cps = [];
      cur.cps.push({ pos: 0, snap: cur.stream.snapshot() });
    }
    // 從目前位置讀 n 個樣本，途中記錄檢查點
    function readInto(out, off, n) {
      var k = 0;
      while (k < n) {
        var toCp = cpSamples - (cur.pos % cpSamples);
        var span = Math.min(n - k, toCp);
        cur.stream.read(out, off + k, span);
        k += span; cur.pos += span;
        if (cur.pos % cpSamples === 0 && cur.cps[cur.cps.length - 1].pos < cur.pos) cur.cps.push({ pos: cur.pos, snap: cur.stream.snapshot() });
      }
      return n;
    }
    // seek：回到最近的檢查點（pos ≤ 目標），再靜音快速模擬到目標
    function seekSamples(target) {
      var lo = 0, hi = cur.cps.length - 1;
      while (lo < hi) { var m = (lo + hi + 1) >> 1; if (cur.cps[m].pos <= target) lo = m; else hi = m - 1; }
      var cp = cur.cps[lo];
      cur.stream = be.openStream(loaded, cur.track, sr);
      cur.stream.restore(cp.snap); cur.pos = cp.pos;
      var scratch = new Float32Array(Math.min(8192, Math.max(1, target - cur.pos)));
      while (cur.pos < target) readInto(scratch, 0, Math.min(scratch.length, target - cur.pos));
    }
    setTrack(0);

    var api = {
      kind: kind, label: be.label || kind, title: loaded.title || '', loaded: loaded, sampleRate: sr,
      tracks: function () { return loaded.tracks.map(function (t, i) { return { index: i, title: t.title || ('曲目 ' + (i + 1)), durationSec: t.durationSec }; }); },
      trackCount: function () { return loaded.tracks.length; },
      currentTrack: function () { return cur.track; },
      durationSec: durationSec,
      // 切曲目（跳過的檢查點都清掉）
      selectTrack: function (i) { if (i !== cur.track) setTrack(i); return api; },
      // 目前播放位置（秒）
      positionSec: function () { return cur.pos / sr; },
      // seek(秒)：之後 read 會從那裡開始
      seek: function (sec) { var t = Math.max(0, Math.min(Math.round(sec * sr), totalSamples())); seekSamples(t); return cur.pos / sr; },
      // 從目前位置讀 n 個樣本（播放用）；超過曲長就只回傳到曲尾（回傳實際樣本數）
      read: function (out, n) { var left = totalSamples() - cur.pos; var m = Math.max(0, Math.min(n, left)); readInto(out, 0, m); return m; },
      atEnd: function () { return cur.pos >= totalSamples(); },
      // render(曲目, 起點秒, 長度秒) → 單聲道 Float32Array；不影響目前播放位置
      render: function (track, startSec, lenSec) {
        var ti = track == null ? cur.track : track;
        var saveTrack = cur.track, savePos = cur.pos;
        var out;
        try {
          if (ti !== cur.track) setTrack(ti);
          var total = totalSamples(ti), s0 = Math.max(0, Math.min(Math.round(startSec * sr), total));
          var want = lenSec == null ? total - s0 : Math.max(0, Math.round(lenSec * sr));
          want = Math.min(want, total - s0);
          seekSamples(s0);
          out = new Float32Array(want);
          var got = 0;
          while (got < want) { var c = Math.min(8192, want - got); readInto(out, got, c); got += c; }
        } finally {
          // 還原原本的曲目與位置
          if (saveTrack !== cur.track || cur.pos !== savePos) { setTrack(saveTrack); seekSamples(savePos); }
        }
        return out;
      },
      // 匯出 MIDI（後端沒有就丟錯，訊息說明原因）
      toMidi: function (track) {
        if (typeof be.toMidi !== 'function') throw new Error('這個晶片格式目前沒有 MIDI 擷取結果，無法匯出 MIDI');
        return be.toMidi(loaded, track == null ? cur.track : track);
      }
    };
    return api;
  }

  // 解析使用者輸入的 goto 文字。回傳 { kind:'time', sec } 或 { kind:'track', index }（index 從 0 起算）；無法解析回傳 null
  function parseGoto(text) {
    var s = String(text == null ? '' : text).trim();
    var m = /^(?:曲目\s*|t|#)\s*(\d+)$/i.exec(s);
    if (m) { var n = parseInt(m[1], 10); return n >= 1 ? { kind: 'track', index: n - 1 } : null; }
    if (/^\d+(:\d{1,2}){1,2}$/.test(s)) {
      var parts = s.split(':').map(Number), sec = 0;
      parts.forEach(function (p) { sec = sec * 60 + p; });
      return { kind: 'time', sec: sec };
    }
    if (/^\d+(\.\d+)?$/.test(s)) return { kind: 'time', sec: parseFloat(s) };
    return null;
  }

  return { registerBackend: registerBackend, getBackend: getBackend, listBackends: listBackends, createPlayer: createPlayer, parseGoto: parseGoto, DEFAULT_RATE: DEFAULT_RATE };
}));
