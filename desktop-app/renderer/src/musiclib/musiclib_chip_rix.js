/* RIX 晶片後端：把 RIX 解析器產出的 OPL2 暫存器寫入序列，餵給 OPL2 模擬，輸出 PCM。純邏輯（UMD）。
 *   註冊到 FaChipPlayer（kind = 'rix'）。曲尾多留 1.5 秒讓釋放段播完。
 *   MIDI 匯出沿用解析器的 song（GM 近似，與原曲音色無關）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./musiclib_extract_rix.js'), require('./musiclib_opl2.js'), require('./musiclib_chipplayer.js'));
  } else {
    factory(root.FaMusicLibRix, root.FaOpl2, root.FaChipPlayer);
  }
}(typeof self !== 'undefined' ? self : this, function (RIX, OPL2, CP) {
  'use strict';
  var TAIL_SEC = 1.5;

  // 解析後的曲子：只保留播放需要的東西
  function parse(bytes) {
    var px = RIX.parseRix(bytes);
    return { title: (px.song && px.song.title) || 'RIX', song: px.song, regs: px.regs, lengthSec: px.durationSec, stats: px.stats, tracks: [{ title: 'RIX 曲子', durationSec: px.durationSec + TAIL_SEC }] };
  }

  // 串流：依暫存器寫入的時間戳（1/980 秒）把寫入送進晶片，中間以晶片渲染
  function openStream(loaded, trackIndex, sr) {
    var chip = OPL2.create(sr), regs = loaded.regs, idx = 0, pos = 0;
    // 時基：暫存器的 t 單位是 1/980 秒
    function evSample(e) { return Math.round(e.t * sr / 980); }
    return {
      read: function (out, off, n) {
        var k = 0;
        while (k < n) {
          while (idx < regs.length && evSample(regs[idx]) <= pos) { chip.write(regs[idx].r, regs[idx].v); idx++; }
          var next = idx < regs.length ? evSample(regs[idx]) : Infinity;
          var span = Math.min(n - k, next - pos);
          if (!(span >= 1)) span = n - k;
          chip.render(out, off + k, span);
          k += span; pos += span;
        }
        return n;
      },
      snapshot: function () { return { chip: chip.snapshot(), idx: idx, pos: pos }; },
      restore: function (s) { chip.restore(s.chip); idx = s.idx; pos = s.pos; }
    };
  }

  function toMidi(loaded) { return loaded.song; }

  var backend = { kind: 'rix', label: 'RIX（OPL2 真模擬）', parse: parse, openStream: openStream, toMidi: toMidi };
  if (CP && typeof CP.registerBackend === 'function') CP.registerBackend(backend);
  return backend;
}));
