/* SFC 擷取的靜音丟棄規則與傾印時機的單元測試（手組的靜音與有聲輸出，不讀真實 ROM）：
 *   node renderer/src/musiclib/musiclib_sfc_guard_test.js
 */
'use strict';
var assert = require('assert');
var SFC = require('./musiclib_extract_sfc.js');
var BUS = require('./musiclib_snes_bus.js');
var CPU = require('./musiclib_snes_cpu.js');
var core = require('./musiclib_spc_core.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

// 手組的輸出：sec 秒，振幅 amp 的正弦（左右相同）；amp=0 為靜音
function tone(sec, amp) {
  var sr = 32000, n = sr * sec, L = new Float32Array(n), R = new Float32Array(n), i;
  for (i = 0; i < n; i++) { L[i] = amp * Math.sin(i * 0.05); R[i] = L[i]; }
  return { L: L, R: R, sampleRate: sr, durationSec: sec };
}
function snap(frame, tag) {
  return { frame: frame, ramCopy: new Uint8Array(0x10000).fill(tag), dsp: new Uint8Array(128), spc: { pc: 0x200, a: 0, x: 0, y: 0, psw: 0, sp: 0xEF } };
}

t('measureOutput：靜音 → 均方根 0、靜音比例 1；振幅 0.1 的正弦 → 均方根約 0.0707', function () {
  var s = SFC.measureOutput(tone(5, 0), 5);
  assert.strictEqual(s.rms, 0); assert.strictEqual(s.silentRatio, 1);
  var v = SFC.measureOutput(tone(5, 0.1), 5);
  assert.ok(Math.abs(v.rms - 0.0707) < 0.005, '均方根 ' + v.rms);
  assert.ok(v.silentRatio < 0.9);
});

t('丟棄規則：靜音與極弱的傾印略過並記錄原因，有聲音的登記', function () {
  var runner = function () {
    return { uploaded: true, uploadFrame: 1, entry: 0x200, snapshots: [snap(100, 1), snap(200, 2), snap(300, 3)] };
  };
  var outs = [tone(5, 0), tone(5, 0.1), tone(5, 0.001)];
  var res = SFC.sfcExtract(new Uint8Array(0x8000), {
    runner: runner, renderSpc: function () { return outs.shift(); }
  });
  assert.strictEqual(res.ok, true, res.reason);
  assert.strictEqual(res.rendered.length, 1);
  assert.strictEqual(res.rendered[0].index, 1);
  assert.strictEqual(res.skipped.length, 2);
  assert.ok(/已略過/.test(res.skipped[0].note) && /第 1 個/.test(res.skipped[0].note));
  assert.ok(/第 3 個/.test(res.skipped[1].note));
});

t('全部靜音：回報失敗，並列出每個傾印的均方根', function () {
  var runner = function () {
    return { uploaded: true, uploadFrame: 1, entry: 0x200, snapshots: [snap(100, 1), snap(200, 2)] };
  };
  var res = SFC.sfcExtract(new Uint8Array(0x8000), {
    runner: runner, renderSpc: function () { return tone(5, 0); }
  });
  assert.strictEqual(res.ok, false);
  assert.ok(/全部 2 個傾印都是靜音/.test(res.reason), res.reason);
  assert.ok(/第 1 個 RMS 0\.0000/.test(res.reason) && /第 2 個 RMS 0\.0000/.test(res.reason), res.reason);
});

t('真實核心：未按鍵時 konCount=0、activity=0', function () {
  var c = core.createCore({});
  assert.strictEqual(c.konCount(), 0); assert.strictEqual(c.activity(), 0);
});

// 傾印時機：假的 apu，每個畫面都有新的按鍵與發聲
function fakeApu(opts) {
  var frame = 0, konN = 0;
  return {
    read: function () { return 0; }, write: function () {},
    run: function () { konN++; }, state: 'running', entry: 0x200, portWrites: 0,
    konCount: function () { return konN; },
    activity: function () { return opts.activity; },
    dumpSpc: function () {
      var ram = new Uint8Array(0x10000).fill(opts.sameRam ? 7 : (konN & 0xFF));
      return { ram: ram, dsp: new Uint8Array(128), spc: { pc: 0x200, a: 0, x: 0, y: 0, psw: 0, sp: 0xEF }, placeholder: false };
    }
  };
}
function romNop() {
  var rom = new Uint8Array(0x8000).fill(0xEA);
  rom[0x7FFC] = 0x00; rom[0x7FFD] = 0x80;
  return rom;
}
t('傾印時機：每次按鍵且有發聲才傾印；相同狀態只留一份；最多 maxDumps 份', function () {
  var r1 = BUS.runRom(romNop(), { Cpu: CPU, apu: fakeApu({ activity: 1, sameRam: false }), maxFrames: 2000, maxDumps: 4, minGapFrames: 10 });
  assert.strictEqual(r1.snapshots.length, 4);
  var r2 = BUS.runRom(romNop(), { Cpu: CPU, apu: fakeApu({ activity: 1, sameRam: true }), maxFrames: 2000, maxDumps: 4, minGapFrames: 10 });
  assert.strictEqual(r2.snapshots.length, 1, '相同狀態應只留一份，實得 ' + r2.snapshots.length);
});

t('傾印時機：沒有發聲（activity=0）就不傾印', function () {
  var r = BUS.runRom(romNop(), { Cpu: CPU, apu: fakeApu({ activity: 0, sameRam: false }), maxFrames: 300, maxDumps: 4, minGapFrames: 10 });
  assert.strictEqual(r.snapshots.length, 0);
});

var fail = 0;
tests.forEach(function (x) {
  try { x.fn(); console.log('通過：' + x.name); }
  catch (e) { fail++; console.log('失敗：' + x.name + '\n  ' + (e && e.message)); }
});
console.log(fail ? ('有 ' + fail + ' 項失敗') : ('全部 ' + tests.length + ' 項通過'));
if (fail) process.exitCode = 1;
