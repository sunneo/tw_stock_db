/* 真實 ROM 的 NSF 冒煙（唯讀，不複製進 repo）：node renderer/src/musiclib/musiclib_nsf_realrom_smoke.js <rom 路徑> [更多路徑…]
 * 每個 ROM：現場擷取成 NSF（不讀舊檔），再用 NSF 後端載入、渲染前 5 秒，印事實：
 *   擷取秒數、載入毫秒、渲染毫秒、5 秒均方根、靜音比例（50 毫秒為一段，峰值 ≤ 0.001 的段數比例）。
 * 通過條件由呼叫端判斷：載入 ≤ 5 秒、均方根 > 0.005、靜音比例 < 70%。一次最多 3 個。 */
'use strict';
var fs = require('fs');
var path = require('path');
var NESX = require('./musiclib_extract_nes.js');
var NES = require('../../vendor/jsnes/jsnes.umd.cjs').NES;
require('./musiclib_nes_mappers.js').install(NES);
var PLAYER = require('./musiclib_chipplayer.js');
var NSFB = require('./musiclib_chip_nsf.js');

PLAYER.registerBackend(NSFB.createBackend(NES));

function measure(samples, rate) {
  var s = 0, win = Math.round(rate * 0.05), silent = 0, segs = 0;
  for (var i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  for (var a = 0; a + win <= samples.length; a += win) {
    var pk = 0; for (var j = a; j < a + win; j++) { var v = Math.abs(samples[j]); if (v > pk) pk = v; }
    segs++; if (pk <= 0.001) silent++;
  }
  return { rms: Math.sqrt(s / samples.length), silentRatio: segs ? silent / segs : 1 };
}

(async function () {
  var files = process.argv.slice(2, 5);
  if (!files.length) { console.log('用法：node musiclib_nsf_realrom_smoke.js <rom 路徑> [最多再兩個]'); return; }
  for (var i = 0; i < files.length; i++) {
    var p = files[i], name = path.basename(p);
    var rom = new Uint8Array(fs.readFileSync(p));
    var t0 = Date.now();
    var ext = await NESX.extractNsf(rom, NES, { name: name });
    var extMs = Date.now() - t0;
    if (!ext.nsf) { console.log(JSON.stringify({ file: name, extracted: false, reason: ext.reason || ext.nsfReason })); continue; }
    var t1 = Date.now();
    var player = PLAYER.createPlayer('nsf', ext.nsf, { sampleRate: 44100 });
    var loadMs = Date.now() - t1;
    var t2 = Date.now();
    var x = player.render(0, 0, 5);
    var renderMs = Date.now() - t2;
    var m = measure(x, 44100);
    console.log(JSON.stringify({
      file: name, extracted: true, extractMs: extMs, mode: ext.nsfMode || 'code', loadMs: loadMs, renderMs: renderMs,
      rms5s: Math.round(m.rms * 10000) / 10000, silentRatio5s: Math.round(m.silentRatio * 1000) / 1000,
      pass: loadMs <= 5000 && m.rms > 0.005 && m.silentRatio < 0.7
    }));
  }
})().catch(function (e) { console.log('冒煙失敗：' + String((e && e.stack) || e)); process.exitCode = 1; });
