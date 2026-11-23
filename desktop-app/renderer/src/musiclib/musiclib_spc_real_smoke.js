/* 真實 .spc 冒煙（node，不開視窗）：node renderer/src/musiclib/musiclib_spc_real_smoke.js <檔案1.spc> [檔案2.spc ...]
 * 每個檔案：晶片播放器的 spc 後端渲染 60 秒（mp3 按鈕的預設一分鐘），量左右聲道平均的均方根（RMS）與靜音比例（|值| < 1e-4），
 * 再 toMidi 數音符。樣本檔不進 repo：路徑由命令列給。 */
'use strict';
var fs = require('fs');
var path = require('path');
var CP = require('./musiclib_chipplayer.js');
var BE = require('./musiclib_chip_spc.js').createBackend();

function measure(pcm) {
  var sum = 0, quiet = 0, n = pcm.length;
  for (var i = 0; i < n; i++) { var v = pcm[i]; sum += v * v; if (Math.abs(v) < 1e-4) quiet++; }
  var peak = 0; for (var j = 0; j < n; j++) { var av = Math.abs(pcm[j]); if (av > peak) peak = av; }
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
    var song = player.toMidi(player.currentTrack());
    var notes = [];
    song.tracks.forEach(function (tr) { tr.notes.forEach(function (x) { notes.push(x.n); }); });
    var minN = null, maxN = null;
    for (var k = 0; k < notes.length; k++) { if (minN === null || notes[k] < minN) minN = notes[k]; if (maxN === null || notes[k] > maxN) maxN = notes[k]; }
    console.log(JSON.stringify({
      file: name, bytes: bytes.length, title: player.title || '', seconds: +(pcm.length / 44100).toFixed(2),
      rms: +m.rms.toFixed(4), peak: +m.peak.toFixed(4), silentRatio: +m.silentRatio.toFixed(4),
      midiTracks: song.tracks.length, midiNotes: notes.length, midiNoteMin: minN, midiNoteMax: maxN, renderMs: renderMs
    }));
  } catch (e) {
    console.log(JSON.stringify({ file: name, error: String((e && e.message) || e) }));
    process.exitCode = 1;
  }
});
