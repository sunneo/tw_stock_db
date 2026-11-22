/* NSF 晶片後端單元測試：node renderer/src/musiclib/musiclib_chip_nsf_test.js
 * 用手組的 6502 機器碼做 NSF（不需要真 ROM）：驗證載入、脈衝頻率、PLAY 呼叫節奏、seek（快照還原）與連續渲染一致、
 * 多曲目（INIT 依曲號改音高）、曲長偵測（聲音停止後安靜）、有銀行的 NSF（$5FF8–$5FFF 切換）。 */
'use strict';
var assert = require('assert');
var NESX = require('./musiclib_extract_nes.js');
var NES = require('../../vendor/jsnes/jsnes.umd.cjs').NES;
var NSFB = require('./musiclib_chip_nsf.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }
var BE = NSFB.createBackend(NES);
var SR = 44100;

// 機器碼（載入位址 $8000，PLAY 在 $8040）
// INIT：A＝曲號−1；A×8＋$F0 寫入脈衝 1 周期低位元組，設長度、音量 15、$10 歸零，RTS
// 注意順序：先 $4015 啟用聲道，再寫 $4003（停用中的聲道不會載入長度計數器，寫了也不響）
var INIT_CODE = [0x0A, 0x0A, 0x0A, 0x18, 0x69, 0xF0, 0x8D, 0x02, 0x40, 0xA9, 0x0F, 0x8D, 0x15, 0x40,
  0xA9, 0x08, 0x8D, 0x03, 0x40, 0xA9, 0xBF, 0x8D, 0x00, 0x40, 0xA9, 0x00, 0x85, 0x10, 0x60];
// PLAY（$8040）：$10 加一；若 ≥ $80 就關掉所有聲道（之後靜音），否則 RTS
var PLAY_CODE = [0xE6, 0x10, 0xA5, 0x10, 0xC9, 0x80, 0xB0, 0x01, 0x60, 0xA9, 0x00, 0x8D, 0x15, 0x40, 0x60];

function prgWith(parts) {
  var prg = new Uint8Array(0x50); prg.fill(0);
  parts.forEach(function (p) { prg.set(p.bytes, p.at); });
  return prg;
}
function songNsf(songs) {
  var prg = prgWith([{ at: 0x00, bytes: INIT_CODE }, { at: 0x40, bytes: PLAY_CODE }]);
  return NESX.packNsf({ prg: prg, load: 0x8000, init: 0x8000, play: 0x8040, songs: songs || 1, start: 1, name: 'テスト' });
}
// 頻率：第一個與最後一個上升過零點之間的週期數 ÷ 時間（首尾之外的視窗邊緣不算，避免少算半個週期）
function freqOf(x, sr) {
  var mean = 0, i; for (i = 0; i < x.length; i++) mean += x[i]; mean /= x.length;
  var n = 0, first = -1, last = -1, prev = x[0] - mean;
  for (i = 1; i < x.length; i++) { var cur = x[i] - mean; if (prev <= 0 && cur > 0) { n++; if (first < 0) first = i; last = i; } prev = cur; }
  if (n < 2) return 0;
  return (n - 1) / ((last - first) / sr);
}
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' 期望 ' + b + '（±' + tol + '），實際 ' + a); }

t('載入：標頭欄位與曲目數正確', function () {
  var L = BE.parse(songNsf(2));
  assert.equal(L.tracks.length, 2);
  assert.equal(L.nsf.load, 0x8000); assert.equal(L.nsf.init, 0x8000); assert.equal(L.nsf.play, 0x8040);
  assert.equal(L.nsf.banked, false, '銀行初值全 0 → 不銀行');
  assert.equal(BE.canLoad(songNsf(1), 'x.nsf'), true);
  assert.equal(BE.canLoad(new Uint8Array([1, 2, 3]), 'x.nsf'), false);
  assert.throws(function () { BE.parse(new Uint8Array(16)); }, /NESM/);
});

t('頻率：脈衝 1 的周期 240 → 約 464 Hz（CPU 1789773 ÷ 16 ÷ 241）', function () {
  var L = BE.parse(songNsf(1)), st = BE.openStream(L, 0, SR);
  var out = new Float32Array(SR); st.read(out, 0, SR);
  var expect = 1789773 / (16 * 241);
  near(freqOf(out, SR), expect, expect * 0.02, '頻率（Hz）');
});

t('PLAY 節奏：一秒約呼叫 60 次（每畫面一次，與 NTSC 畫面率對齊）', function () {
  var L = BE.parse(songNsf(1)), st = BE.openStream(L, 0, SR);
  var out = new Float32Array(SR); st.read(out, 0, SR);
  var calls = st.peekMem(0x10);
  near(calls, 60, 2, 'PLAY 呼叫次數');
});

t('seek：快照還原後連續渲染與原本逐點完全相同', function () {
  var L = BE.parse(songNsf(1));
  var a = BE.openStream(L, 0, SR);
  var skip = new Float32Array(SR); a.read(skip, 0, SR);            // 先跑一秒
  var snap = a.snapshot();
  var first = new Float32Array(SR); a.read(first, 0, SR);           // 第二秒（原樣）
  a.restore(snap);
  var again = new Float32Array(SR); a.read(again, 0, SR);           // 還原後再讀第二秒
  for (var i = 0; i < SR; i++) if (first[i] !== again[i]) assert.fail('還原後第 ' + i + ' 個樣本不同：' + first[i] + ' vs ' + again[i]);
  // 另開一條串流一路讀到第二秒結束，應與分段讀取完全一致（確定性）
  var b = BE.openStream(L, 0, SR);
  var whole = new Float32Array(2 * SR); b.read(whole, 0, 2 * SR);
  for (var j = 0; j < SR; j++) if (whole[SR + j] !== first[j]) assert.fail('連續渲染第 ' + j + ' 個樣本與分段不同');
});

t('多曲目：曲號 2 的 INIT 讓音高不同（A×8 → 周期 248）', function () {
  var L = BE.parse(songNsf(2));
  var out = new Float32Array(SR);
  BE.openStream(L, 0, SR).read(out, 0, SR);
  var f1 = freqOf(out, SR);
  BE.openStream(L, 1, SR).read(out, 0, SR);
  var f2 = freqOf(out, SR);
  near(f1, 1789773 / (16 * 241), 1789773 / (16 * 241) * 0.02, '曲 1');
  near(f2, 1789773 / (16 * 249), 1789773 / (16 * 249) * 0.02, '曲 2');
  assert.ok(f2 < f1 - 5, '曲 2 應比曲 1 低');
});

t('曲長：PLAY 第 128 次後靜音 → 曲長約 2.1 秒（聲音停止後安靜夠久才結束）', function () {
  var L = BE.parse(songNsf(1));
  var sec = L.tracks[0].durationSec;
  near(sec, 127 / 60.0988, 0.1, '曲長（秒）');
  assert.ok(/安靜夠久/.test(L.tracks[0].durationNote), '說明應寫出結束原因：' + L.tracks[0].durationNote);
});

t('銀行：初值 page 0 與 page 1、$5FF9 切換後 $9000 內容改變（且快照還原後仍保留）', function () {
  // 兩頁資料：頁 0 的 $8000 是 INIT（切換 $9000 視窗到頁 1，讀 $9000 的第 0 位元組到 $10）；頁 1 的第 0 位元組是 $77
  var page0 = new Uint8Array(4096); page0.fill(0);
  var initB = [0xA9, 0x01, 0x8D, 0xF9, 0x5F, 0xAD, 0x00, 0x90, 0x85, 0x10, 0x60];
  page0.set(initB, 0);
  page0[0x40] = 0x60;                                  // PLAY：RTS
  var page1 = new Uint8Array(4096); page1[0] = 0x77;
  var data = new Uint8Array(8192); data.set(page0, 0); data.set(page1, 4096);
  var banks = [0, 0, 0, 0, 0, 0, 0, 1];                // 視窗 7（$F000）初值為頁 1，因此「有銀行」
  var bytes = NESX.packNsf({ prg: data, load: 0x8000, init: 0x8000, play: 0x8040, songs: 1, start: 1, banks: banks });
  var L = BE.parse(bytes);
  assert.equal(L.nsf.banked, true);
  var st = BE.openStream(L, 0, SR);
  assert.equal(st.peekMem(0x10), 0x77, 'INIT 切到頁 1 後 $9000 應為 $77');
  var snap = st.snapshot();
  var o = new Float32Array(SR); st.read(o, 0, SR);
  st.restore(snap);
  assert.equal(st.peekMem(0x9000), 0x77, '還原快照後 $9000 仍應為 $77');
});

var failed = 0;
tests.forEach(function (x) {
  try { x.fn(); console.log('ok   ' + x.name); }
  catch (e) { failed++; console.log('FAIL ' + x.name + '\n     ' + String((e && e.message) || e)); }
});
console.log(failed ? (failed + ' 項失敗') : ('全部 ' + tests.length + ' 項通過'));
process.exitCode = failed ? 1 : 0;
