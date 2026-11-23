/* 真實 .spc 冒煙（node，不開視窗）：node renderer/src/musiclib/musiclib_spc_real_smoke.js <檔案1.spc> [檔案2.spc ...]
 * 每個檔案：(1) 晶片播放器的 spc 後端渲染 60 秒（mp3 按鈕的預設一分鐘），量左右聲道平均的均方根（RMS）、靜音比例（|值| < 1e-4）；
 * (2) SPC 專用 MIDI 擷取（collectNotes → buildSong）轉 60 秒，數音符、聲道、音高範圍、零長度音符，列出前 20 個音符；
 * (3) 用 FaMidi.write → FaMidi.parse 讀回，音符數必須一致。
 * 樣本檔不進 repo：路徑由命令列給。 */
'use strict';
var fs = require('fs');
var path = require('path');
var CP = require('./musiclib_chipplayer.js');
var CS = require('./musiclib_chip_spc.js');
var FM = require('../music/midi_core.js');
var BE = CS.createBackend();

function measure(pcm) {
  var sum = 0, quiet = 0, n = pcm.length, peak = 0;
  for (var i = 0; i < n; i++) { var v = pcm[i]; sum += v * v; if (Math.abs(v) < 1e-4) quiet++; var av = Math.abs(v); if (av > peak) peak = av; }
  return { rms: Math.sqrt(sum / Math.max(1, n)), silentRatio: quiet / Math.max(1, n), peak: peak };
}

try { CP.getBackend('spc'); } catch (_) { CP.registerBackend(BE); }
var files = process.argv.slice(2);
if (!files.length) { console.error('用法：node musiclib_spc_real_smoke.js <檔案.spc> ...'); process.exitCode = 2; }
files.forEach(function (f) {
  var name = path.basename(f);
  try {
    var bytes = new Uint8Array(fs.readFileSync(f));
    var t0 = Date.now();
    var player = CP.createPlayer('spc', bytes, { sampleRate: 44100 });
    var pcm = player.render(player.currentTrack(), 0, 60);
    var renderMs = Date.now() - t0;
    var m = measure(pcm);

    var t1 = Date.now();
    var loaded = BE.parse(bytes);
    var built = CS.buildSong(CS.collectNotes(loaded.spc, 60), loaded.title);
    var song = built.song, st = built.stats;
    var midiMs = Date.now() - t1;
    var total = 0, zero = 0, minN = 128, maxN = -1, inRange = 0;
    song.tracks.forEach(function (tr) {
      tr.notes.forEach(function (x) {
        total++; if (x.d < 1) zero++;
        if (x.n < minN) minN = x.n; if (x.n > maxN) maxN = x.n;
        if (x.n >= 36 && x.n <= 96) inRange++;
      });
    });
    var back = FM.parse(FM.write(FM.validate(song)));
    var backCount = FM.noteCount(back);

    console.log(JSON.stringify({
      file: name, bytes: bytes.length, seconds: +(pcm.length / 44100).toFixed(2),
      rms: +m.rms.toFixed(4), peak: +m.peak.toFixed(4), silentRatio: +m.silentRatio.toFixed(4), renderMs: renderMs,
      midiNotesPerMin: total, midiTracks: song.tracks.length, channels: song.tracks.map(function (tr) { return tr.channel; }),
      drumNotes: st.drumNotes, melodyNotes: st.melodyNotes, shortDropped: st.shortDropped, noPitch: st.noPitch,
      shiftSemitones: st.shiftSemitones, pitchMin: minN, pitchMax: maxN, inRangePct: total ? +(100 * inRange / total).toFixed(1) : null,
      zeroLenNotes: zero, fmReadBackNotes: backCount, fmRoundTripOk: backCount === total, midiMs: midiMs
    }));
    var first = [];
    var all = [];
    song.tracks.forEach(function (tr) { tr.notes.forEach(function (x) { all.push({ t: x.t, ch: tr.channel, n: x.n, d: x.d, v: x.v }); }); });
    all.sort(function (a, b) { return a.t - b.t || a.ch - b.ch; });
    for (var i = 0; i < Math.min(20, all.length); i++) first.push(all[i]);
    console.log('  前 20 個音符（t 以 tick 計，ppq 480）：' + JSON.stringify(first));
  } catch (e) {
    console.log(JSON.stringify({ file: name, error: String((e && e.stack) || e) }));
    process.exitCode = 1;
  }
});
