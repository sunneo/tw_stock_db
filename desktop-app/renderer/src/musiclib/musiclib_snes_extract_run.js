/* 超任擷取的可重跑腳本（真實 ROM，唯讀，不寫入 repo）：
 *   node renderer/src/musiclib/musiclib_snes_extract_run.js <spc核心.js 路徑> <rom...>
 * 走與應用程式相同的路徑：主 CPU 跑 ROM → 聲音埠接 SPC 核心 → KON＋發聲時機傾印 → 靜音丟棄 → 每首前 5 秒的均方根。
 * 輸出每個 ROM 的上傳狀態、登記的首數、略過的傾印（與原因），以及每首的均方根與 RAM 非零位元組數。 */
'use strict';
var fs = require('fs');
var path = require('path');
var SFC = require('./musiclib_extract_sfc.js');
var CPU = require('./musiclib_snes_cpu.js');
var BUS = require('./musiclib_snes_bus.js');

var args = process.argv.slice(2);
if (args.length < 2) { console.log('用法：node musiclib_snes_extract_run.js <spc核心.js> <rom...>'); process.exit(2); }
var core = require(path.resolve(args[0]));

args.slice(1).forEach(function (file) {
  var bytes = new Uint8Array(fs.readFileSync(file));
  var t0 = Date.now();
  var res = SFC.sfcExtract(bytes, {
    title: path.basename(file), game: path.basename(file),
    runner: function (rom) {
      return BUS.runRom(rom, { Cpu: CPU, apu: BUS.createSpcApu(core.createCore({})), maxFrames: 3600, maxDumps: 4, minGapFrames: 60 });
    },
    renderSpc: function (spcBytes) {
      var c = core.fromSpc(SFC.parseSpc(spcBytes));
      var n = 32000 * 5, L = new Float32Array(n), R = new Float32Array(n);
      c.renderStereo(L, R, 0, n);
      return { L: L, R: R, sampleRate: 32000, durationSec: 5 };
    }
  });
  console.log('── ' + path.basename(file) + '（耗時 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）');
  console.log('   上傳與擷取：' + (res.stages.map(function (s) { return (s.ok ? '✓ ' : '✗ ') + s.stage + (s.note ? '（' + s.note + '）' : (s.reason ? '（' + s.reason + '）' : '')); }).join('；')));
  (res.rendered || []).forEach(function (r) {
    var nz = 0; for (var k = 0; k < 0x10000; k++) if (r.bytes[0x100 + k]) nz++;
    console.log('   有聲音：第 ' + (r.index + 1) + ' 個（畫面 ' + r.frame + '）均方根 ' + r.rms.toFixed(4) + '，RAM 非零 ' + nz + ' 位元組');
  });
  if (!res.ok) console.log('   結果：失敗 — ' + res.reason);
  else console.log('   結果：登記 ' + res.rendered.length + ' 首（略過 ' + (res.skipped || []).length + ' 個靜音傾印）');
});
