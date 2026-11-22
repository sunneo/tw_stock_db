/* APU 重放 NSF 單元測試：node renderer/src/musiclib/musiclib_apu_replay_test.js
 * 手組事件流（畫面結束＋聲音暫存器寫入）→ buildApuReplay 產生 NSF → 用 NSF 後端真的執行 PLAY，
 * 檢查：寫入的順序與位址、每畫面一次、資料結束後靜音。不需要真 ROM。 */
'use strict';
var assert = require('assert');
var NESX = require('./musiclib_extract_nes.js');
var NES = require('../../vendor/jsnes/jsnes.umd.cjs').NES;
var NSFB = require('./musiclib_chip_nsf.js');
var S = NSFB._internals;

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

// 三個畫面：畫面 0 寫 $4000=0x9F、$4002=0x10；畫面 1 沒有寫入（只有畫面結束）；畫面 2 寫 $4015=1
function sampleEvents() {
  return [
    { k: 'apu', addr: 0x4000, value: 0x9F }, { k: 'apu', addr: 0x4002, value: 0x10 }, { k: 'vblank', f: 0 },
    { k: 'vblank', f: 1 },
    { k: 'apu', addr: 0x4015, value: 0x01 }, { k: 'vblank', f: 2 }
  ];
}

// 用 NSF 後端執行 n 個畫面（每畫面一次 PLAY），回傳依序的 APU 寫入與每畫面的寫入數
function runReplay(nsf, frames) {
  var parsed = NSFB.createBackend(NES).parse(nsf);
  var M = S.makeMachine(NES, parsed.nsf, 1, 44100);
  var writes = [], perFrame = [], cur = 0;
  var orig = M.nes.papu.writeReg;
  M.nes.papu.writeReg = function (a, v) { writes.push([a, v & 0xFF]); cur++; return orig.call(this, a, v); };
  for (var f = 0; f < frames; f++) { cur = 0; S.stepFrame(M, true); perFrame.push(cur); }
  return { writes: writes, perFrame: perFrame, crashed: M.crashed };
}

t('重放表：畫面結束代號 0、寫入代號 = 位址 − $3FFF、資料以 $FF 結束', function () {
  var r = NESX.buildApuReplay(sampleEvents());
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.frames, 3, '三個畫面結束都要收進來');
  assert.equal(r.writes, 3, '三次聲音寫入');
  var data = r.nsf.subarray(0x80);                 // 資料從頭 0x80 之後；表在 $8100 = 資料偏移 0x100
  var tbl = data.subarray(0x100);
  // 畫面 0：[1,9F] [3,10] 結束 0；畫面 1：沒有寫入，只有結束 0；畫面 2：[0x16,01] 結束 0
  assert.deepEqual(Array.from(tbl.subarray(0, 9)), [1, 0x9F, 3, 0x10, 0, 0, 0x16, 1, 0], '記錄格式：代號 1＝$4000，3＝$4002，$4015 代號 0x16；每畫面以 0 結束');
  assert.equal(tbl[tbl.length - 1], 0xFF, '最後一個位元組是資料結束');
});

t('後端執行：PLAY 每畫面一次，寫入位址與順序與事件流完全一致', function () {
  var r = NESX.buildApuReplay(sampleEvents());
  var got = runReplay(r.nsf, 6);
  assert.equal(got.crashed, null, '不應崩潰：' + got.crashed);
  assert.deepEqual(got.writes.slice(0, 3), [[0x4000, 0x9F], [0x4002, 0x10], [0x4015, 0x01]], '寫入順序');
  assert.deepEqual(got.perFrame.slice(0, 3), [2, 0, 1], '每畫面的寫入數對應事件流');
  // 資料結束後每畫面只寫一次 $4015＝0（關閉所有聲道），之後靜音
  assert.deepEqual(got.perFrame.slice(3), [1, 1, 1], '資料結束後每畫面只關聲道');
  assert.deepEqual(got.writes.slice(3), [[0x4015, 0], [0x4015, 0], [0x4015, 0]], '結束後寫入的只有 $4015＝0');
});

t('沒有任何聲音寫入：明確回報，不產生 NSF', function () {
  var r = NESX.buildApuReplay([{ k: 'vblank', f: 0 }, { k: 'vblank', f: 1 }]);
  assert.equal(r.ok, false);
  assert.ok(/沒有任何有音/.test(r.reason), r.reason);
});

var pass = 0, fail = 0;
tests.forEach(function (x) {
  try { x.fn(); pass++; console.log('  通過  ' + x.name); }
  catch (e) { fail++; console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
});
console.log('apu 重放單元測試：通過 ' + pass + ' / ' + tests.length + ' 項' + (fail ? '（失敗 ' + fail + '）' : ''));
if (fail) process.exitCode = 1;
