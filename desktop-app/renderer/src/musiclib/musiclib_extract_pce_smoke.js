/* PC Engine 真實 ROM 冒煙（唯讀，不複製進 repo）：node renderer/src/musiclib/musiclib_extract_pce_smoke.js <rom 路徑> [更多路徑…]
 * 每個 ROM 只印事實：大小、有無檔頭、執行畫面數、停止原因、PSG 寫入數、音符數、wav 秒數、未實作操作碼數；不印 ROM 內容。
 * 一次最多 3 個（超過的不跑，避免全掃）。 */
'use strict';
var fs = require('fs');
var path = require('path');
var CPU = require('./musiclib_pce_cpu.js');
var PCE = require('./musiclib_extract_pce.js');

(async function () {
  var files = process.argv.slice(2, 5);
  if (!files.length) { console.log('用法：node musiclib_extract_pce_smoke.js <rom 路徑> [最多再兩個]'); return; }
  for (var i = 0; i < files.length; i++) {
    var p = files[i];
    var bytes = new Uint8Array(fs.readFileSync(p));
    var t0 = Date.now();
    var r = await PCE.extractPce(bytes, { name: path.basename(p), cpu: CPU, maxFrames: 1800 });
    var s = r.stats || {};
    console.log(JSON.stringify({
      file: path.basename(p), sizeKB: Math.round(bytes.length / 1024), header512: bytes.length % 8192 === 512,
      frames: s.frames, quit: s.quit, crashed: s.crashed || null, psgWrites: s.psgWrites, activeFrames: s.activeFrames,
      notes: s.notes || 0, keyOn: s.keyOn || 0, durationSec: s.durationSec || 0, unknownOps: s.unknownOps,
      midi: !!r.song, wav: !!r.wav, midiReason: r.midiReason || null, wavReason: r.wavReason || null, note: s.note || null,
      elapsedMs: Date.now() - t0
    }));
  }
})().catch(function (e) { console.log('冒煙失敗：' + String((e && e.stack) || e)); process.exitCode = 1; });
