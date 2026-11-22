/* PC Engine 搖桿單元測試：node renderer/src/musiclib/musiclib_pce_pad_test.js
 * 檢查：$1000 選取位元、低電位＝按下、方向與按鈕各自的位元、沒有按鍵時全部放開（0xFF 的低 4 位元為 1）。 */
'use strict';
var assert = require('assert');
var CPU = require('./musiclib_pce_cpu.js');

// 最小 ROM：8KB 全部填 0xEA（NOP）；只測匯流排的搖桿讀取，不執行程式
function machineWith(pressed) {
  var rom = new Uint8Array(8192); rom.fill(0xEA);
  return CPU.createMachine(rom, { pad: function () { return pressed; }, onPsg: function () {} });
}
// 搖桿位址：銀行 $FF 的偏移 $1000（CPU 位址 $1000 在預設 MPR 下是 I/O 銀行 0xFF 的偏移 $1000 的鏡像，直接用匯流排介面）
function readPad(m, sel) {
  m.bus.write(0x1000, sel);     // $1000 寫入選取位元
  return m.bus.read(0x1000);
}

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

t('沒有按鍵：讀到的低 4 位元全部是 1（放開）', function () {
  var m = machineWith(0);
  assert.equal(readPad(m, 0) & 0x0F, 0x0F);
  assert.equal(readPad(m, 1) & 0x0F, 0x0F);
});
t('方向（選取 0）：上 bit0、右 bit1、下 bit2、左 bit3，按下時對應位元為 0', function () {
  assert.equal(readPad(machineWith(0x01), 0) & 0x0F, 0x0E, '上');
  assert.equal(readPad(machineWith(0x02), 0) & 0x0F, 0x0D, '右');
  assert.equal(readPad(machineWith(0x04), 0) & 0x0F, 0x0B, '下');
  assert.equal(readPad(machineWith(0x08), 0) & 0x0F, 0x07, '左');
});
t('按鈕（選取 1）：I bit0、II bit1、SELECT bit2、RUN bit3（輸入的高 4 位元 0x10/0x20/0x40/0x80）', function () {
  assert.equal(readPad(machineWith(0x10), 1) & 0x0F, 0x0E, 'I');
  assert.equal(readPad(machineWith(0x20), 1) & 0x0F, 0x0D, 'II');
  assert.equal(readPad(machineWith(0x40), 1) & 0x0F, 0x0B, 'SELECT');
  assert.equal(readPad(machineWith(0x80), 1) & 0x0F, 0x07, 'RUN');
});
t('選取位元不同時，方向與按鈕互不影響（按 RUN 時選取 0 讀不到）', function () {
  var m = machineWith(0x80);
  assert.equal(readPad(m, 0) & 0x0F, 0x0F, '選取 0 只看方向');
  assert.equal(readPad(m, 1) & 0x0F, 0x07, '選取 1 看到 RUN');
});

var pass = 0, fail = 0;
tests.forEach(function (x) {
  try { x.fn(); pass++; console.log('  通過  ' + x.name); }
  catch (e) { fail++; console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
});
console.log('PC Engine 搖桿單元測試：通過 ' + pass + ' / ' + tests.length + ' 項' + (fail ? '（失敗 ' + fail + '）' : ''));
if (fail) process.exitCode = 1;
