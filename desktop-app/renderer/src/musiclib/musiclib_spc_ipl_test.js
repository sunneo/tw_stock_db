/* SPC700 IPL 上傳的單元測試（用真實核心執行 IPL，搭配腳本主機）：node renderer/src/musiclib/musiclib_spc_ipl_test.js
 * 協定：等 $AA/$BB → 寫目的位址（埠2/3）、命令（埠1）非零、$CC（埠0）開始 → 每個位元組：寫資料到埠1、寫索引到埠0、等 SPC 回寫同索引 →
 *       結束：寫執行位址（埠2/3）、埠1=0、埠0＝索引+2 → SPC 跳到位址執行。 */
'use strict';
var assert = require('assert');
var core = require('./musiclib_spc_core.js');

var BASE = 0x0200, N = 64;
var data = [];
for (var i = 0; i < N - 2; i++) data.push(0x00);     // NOP
data.push(0x2F, 0xFE);                               // BRA -2：停在自己身上，PC 留在 $0200 範圍

function runCyc(c, n) { for (var k = 0; k < n; k++) c.runCycles(1); }
function waitFor(c, fn, max) { var n = 0; while (!fn() && n < max) { c.runCycles(1); n++; } return fn(); }

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

t('IPL 上傳 64 個位元組到 $0200，RAM 逐位元組一致，之後 PC 進入 $0200 範圍', function () {
  var c = core.createCore({});
  runCyc(c, 20000);
  assert.strictEqual(c.portOut(0), 0xAA); assert.strictEqual(c.portOut(1), 0xBB);
  c.setPortIn(2, BASE & 0xFF); c.setPortIn(3, BASE >> 8); c.setPortIn(1, 0x01); c.setPortIn(0, 0xCC);
  assert.ok(waitFor(c, function () { return c.portOut(0) === 0xCC; }, 200000), '沒有回應 $CC');
  for (var i = 0; i < N; i++) {
    c.setPortIn(1, data[i]);
    c.setPortIn(0, i);
    assert.ok(waitFor(c, function () { return c.portOut(0) === (i & 0xFF); }, 200000), '位元組 ' + i + ' 沒有回寫索引');
  }
  c.setPortIn(2, BASE & 0xFF); c.setPortIn(3, BASE >> 8); c.setPortIn(1, 0x00); c.setPortIn(0, (N + 2) & 0xFF);
  var inRange = false;
  for (var k = 0; k < 4000 && !inRange; k++) {
    c.runCycles(1);
    var pc = c.cpu().pc; if (pc >= BASE && pc < BASE + N) inRange = true;
  }
  for (i = 0; i < N; i++) assert.strictEqual(c.peek(BASE + i), data[i], '位址 $' + (BASE + i).toString(16) + ' 的位元組不一致');
  assert.ok(inRange, '沒有跳到 $0200 範圍（PC=$' + c.cpu().pc.toString(16) + '）');
});

var fail = 0;
tests.forEach(function (x) {
  try { x.fn(); console.log('通過：' + x.name); }
  catch (e) { fail++; console.log('失敗：' + x.name + '\n  ' + (e && e.message)); }
});
console.log(fail ? ('有 ' + fail + ' 項失敗') : ('全部 ' + tests.length + ' 項通過'));
if (fail) process.exitCode = 1;
