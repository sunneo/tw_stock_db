/* 超任擷取的真實 ROM 冒煙（唯讀，不複製進 repo）。最多 3 個，不做普查。
 *   node renderer/src/musiclib/musiclib_snes_smoke.js <spc核心.js 路徑> <rom1> [rom2] [rom3]
 * 需要 SPC700＋S-DSP 核心（musiclib_spc_core.js，ml-spcdsp 分支）；沒有就只能驗證分類與標頭。
 * 報告：上傳是否完成、入口位址、跑了幾個畫面、主 CPU 停在哪裡、快照的 RAM／DSP 摘要、兩秒渲染的音量（RMS）。 */
'use strict';
var fs = require('fs');
var path = require('path');
var SFC = require('./musiclib_extract_sfc.js');
var CPU = require('./musiclib_snes_cpu.js');
var BUS = require('./musiclib_snes_bus.js');

var args = process.argv.slice(2);
if (args.length < 2) { console.log('用法：node musiclib_snes_smoke.js <spc核心.js> <rom...>（最多 3 個）'); process.exit(2); }
var core = require(path.resolve(args[0]));
var roms = args.slice(1, 4);

roms.forEach(function (file) {
  var name = path.basename(file);
  var bytes = new Uint8Array(fs.readFileSync(file));    // 只讀入記憶體
  var cls = SFC.classifySfc(name, bytes);
  var t0 = Date.now();
  var res = BUS.runRom(bytes, {
    Cpu: CPU, parseHeader: SFC.parseSnesHeader,
    apu: BUS.createSpcApu(core.createCore({})),
    maxFrames: 1200,
    snapshotFrames: [60, 300]
  });
  var sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('── ' + name);
  console.log('   分類：' + cls.label + '；硬體映射 ' + (res.boot.hirom ? 'HiROM' : 'LoROM') + '；SRAM ' + res.boot.sramBytes + ' 位元組；耗時 ' + sec + ' 秒');
  console.log('   上傳完成：' + res.uploaded + (res.uploaded ? '（第 ' + res.uploadFrame + ' 個畫面，入口 $' + res.entry.toString(16) + '）' : ''));
  console.log('   主 CPU：PC=$' + res.cpu.pbr.toString(16) + ':' + res.cpu.pc.toString(16) + '，halted=' + res.cpu.halted + '，stopped=' + res.cpu.stopped + '，指令數 ' + res.cpu.instructions);
  if (!res.uploaded) { console.log('   原因：' + res.reason); return; }
  res.snapshots.forEach(function (s, i) {
    var nz = 0; for (var k = 0; k < 0x10000; k++) if (s.ramCopy[k]) nz++;
    var keyOn = s.dsp[0x4C];
    console.log('   快照 ' + i + '（第 ' + s.frame + ' 個畫面）：RAM 非零 ' + nz + ' 位元組，KON=$' + keyOn.toString(16) + '，SPC PC=$' + s.spc.pc.toString(16));
  });
  // 兩秒渲染：第一個快照
  var r0 = res.snapshots[0];
  var c2 = core.createCore({ ram: r0.ramCopy, dsp: r0.dsp, pc: r0.spc.pc, a: 0, x: 0, y: 0, psw: 0, sp: 0xEF });
  var n = 32000 * 2, L = new Float32Array(n), R = new Float32Array(n);
  c2.renderStereo(L, R, 0, n);
  var sum = 0, peak = 0; for (var q = 0; q < n; q++) { sum += L[q] * L[q]; peak = Math.max(peak, Math.abs(L[q])); }
  console.log('   渲染 2 秒：RMS ' + Math.sqrt(sum / n).toFixed(4) + '，峰值 ' + peak.toFixed(4) + (peak < 1e-4 ? '（幾乎靜音）' : ''));
});
