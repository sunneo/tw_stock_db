/* NSF 後端「INIT／PLAY 永不返回」的硬上限單元測試：node renderer/src/musiclib/musiclib_chip_nsf_hang_test.js
 * 手組兩種壞掉的 NSF：INIT 永不返回（JMP 自己）、PLAY 永不返回（JMP 自己）。
 * 要求：不會卡住（每項都在幾秒內結束）、並丟出明確的錯誤訊息（說出是 INIT 或 PLAY、以及遊戲時間上限）。 */
'use strict';
var assert = require('assert');
var NESX = require('./musiclib_extract_nes.js');
var NES = require('../../vendor/jsnes/jsnes.umd.cjs').NES;
var NSFB = require('./musiclib_chip_nsf.js');

var BE = NSFB.createBackend(NES);
var SR = 44100;
var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

// INIT 在 $8000、PLAY 在 $8040；initCode／playCode 各自決定是否會返回
function nsfWith(initCode, playCode) {
  var prg = new Uint8Array(0x50);
  prg.set(initCode, 0x00); prg.set(playCode, 0x40);
  return NESX.packNsf({ prg: prg, load: 0x8000, init: 0x8000, play: 0x8040, songs: 1, start: 1, name: 'hang' });
}
var RTS = [0x60], JMP_SELF_INIT = [0x4C, 0x00, 0x80], JMP_SELF_PLAY = [0x4C, 0x40, 0x80];

t('INIT 永不返回：開啟曲目就丟錯（說明是 INIT、遊戲時間上限），不會卡住', function () {
  var start = Date.now();
  var L = BE.parse(nsfWith(JMP_SELF_INIT, RTS));
  assert.throws(function () { BE.openStream(L, 0, SR); }, /INIT.*沒有返回/);
  assert.ok(Date.now() - start < 20000, '應在 20 秒內結束，實際 ' + (Date.now() - start) + ' 毫秒');
});

t('PLAY 永不返回：渲染時在硬上限內丟錯（說明是 PLAY），不會卡住', function () {
  var start = Date.now();
  var L = BE.parse(nsfWith(RTS, JMP_SELF_PLAY));
  var st = BE.openStream(L, 0, SR);
  var out = new Float32Array(SR * 15);
  assert.throws(function () { st.read(out, 0, out.length); }, /PLAY.*沒有返回/);
  assert.ok(Date.now() - start < 60000, '應在 60 秒內結束，實際 ' + (Date.now() - start) + ' 毫秒');
});

var pass = 0, fail = 0;
tests.forEach(function (x) {
  try { x.fn(); pass++; console.log('  通過  ' + x.name); }
  catch (e) { fail++; console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
});
console.log('NSF 硬上限單元測試：通過 ' + pass + ' / ' + tests.length + ' 項' + (fail ? '（失敗 ' + fail + '）' : ''));
if (fail) process.exitCode = 1;
