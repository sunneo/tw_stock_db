/* SPC（SNES 音效檔）晶片後端：用 musiclib_spc_core.js 的 SPC700＋S-DSP 核心渲染成 PCM。純邏輯（UMD，不碰 DOM、不用網路）。
 *   createBackend(CORE, SFC) → 後端物件（kind = 'spc'），交給 FaChipPlayer.registerBackend 註冊。
 *   後端介面：canLoad(bytes)、parse(bytes) → { title, artist, spc, tracks:[{ title, durationSec, durationNote }] }、
 *            openStream(loaded, trackIndex, sampleRate) → { read(out, off, n)、snapshot()、restore(s) }。
 *   沒有 toMidi：本後端還沒有 DSP 音符事件的 MIDI 擷取（musiclib_extract_sfc.js 的 dspEventsToSong 可接上，列為後續）。
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
      }
    };
  }

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

  return { createBackend: createBackend, makeStream: makeStream };
}));
