/* 通用播放模組（路由、計畫、/media-play 參數解析、擷取失敗原因）的單元測試：node renderer/src/musiclib/musiclib_play_test.js */
'use strict';
var assert = require('assert');
var P = require('./musiclib_play.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }
var CHIPS = ['rix', 'nsf'];
var chipKinds = function () { return CHIPS.slice(); };

// ───── 路由 ─────
t('路由：晶片後端（rix、nsf）走晶片播放器', function () {
  assert.equal(P.route({ kind: 'rix' }, { chipKinds: chipKinds }).route, 'chip');
  assert.equal(P.route({ kind: 'nsf' }, { chipKinds: chipKinds }).route, 'chip');
});
t('路由：之後註冊的新晶片後端自動可播（不寫死種類）', function () {
  var later = ['rix', 'nsf', 'spc'];
  assert.equal(P.route('spc', { chipKinds: function () { return later; } }).route, 'chip');
  assert.notEqual(P.route('spc', { chipKinds: chipKinds }).route, 'chip', '沒註冊時不是晶片');
});
t('路由：mid → MIDI；wav／mp3／ogg／flac → 音訊；mp4／mov／webm → 影片', function () {
  assert.equal(P.route('mid', { chipKinds: chipKinds }).route, 'midi');
  assert.equal(P.route('midi', { chipKinds: chipKinds }).route, 'midi', '別名 midi');
  ['wav', 'mp3', 'ogg', 'flac'].forEach(function (k) { assert.equal(P.route(k, { chipKinds: chipKinds }).route, 'audio', k); });
  ['mp4', 'mov', 'webm'].forEach(function (k) { assert.equal(P.route(k, { chipKinds: chipKinds }).route, 'video', k); });
});
t('路由：nes／pce／sfc／swf 是來源 ROM（要先擷取）；smc 當成 sfc', function () {
  ['nes', 'pce', 'sfc', 'swf'].forEach(function (k) { assert.equal(P.route(k, { chipKinds: function () { return []; } }).route, 'rom', k); });
  assert.equal(P.route('smc', { chipKinds: function () { return []; } }).route, 'rom');
});
t('路由：以檔名判斷（/media-play 的路徑）；沒有副檔名或不認得 → 說明', function () {
  assert.equal(P.route('D:\\x\\song.MP3', { chipKinds: chipKinds }).route, 'audio');
  var u = P.route('D:\\x\\README', { chipKinds: chipKinds });
  assert.equal(u.route, 'unknown');
  assert.ok(u.reason.length > 0);
  var z = P.route('a.zzz', { chipKinds: chipKinds });
  assert.equal(z.route, 'unknown');
  assert.ok(/zzz/.test(z.reason), '說明裡寫出種類');
});

// ───── 計畫 ─────
t('計畫：一般檔直接播', function () {
  var rec = { key: 'A', kind: 'mp3', name: 'a.mp3' };
  var plan = P.planPlay(rec, [rec], { chipKinds: chipKinds });
  assert.equal(plan.action, 'play');
  assert.equal(plan.route, 'audio');
});
t('計畫：來源 ROM 已有擷取產物 → 播第一個（依 derivedIndex），其他列出', function () {
  var src = { key: 'S', kind: 'nes', name: 'g.nes' };
  var c1 = { key: 'd1', kind: 'nsf', derivedFrom: 'S', derivedIndex: 1, status: 'ok', name: '1' };
  var c0 = { key: 'd0', kind: 'mid', derivedFrom: 'S', derivedIndex: 0, status: 'ok', name: '0' };
  var plan = P.planPlay(src, [src, c1, c0], { chipKinds: chipKinds });
  assert.equal(plan.action, 'play-child');
  assert.equal(plan.target.key, 'd0');
  assert.deepEqual(plan.others.map(function (x) { return x.key; }), ['d1']);
});
t('計畫：來源 ROM 沒有擷取產物 → extract', function () {
  var src = { key: 'S', kind: 'pce', name: 'g.pce' };
  assert.equal(P.planPlay(src, [src], { chipKinds: chipKinds }).action, 'extract');
});
t('計畫：擷取產物都不能播 → 說明（不會再擷取一次）', function () {
  var src = { key: 'S', kind: 'swf', name: 'g.swf' };
  var c = { key: 'd', kind: 'zzz', derivedFrom: 'S', status: 'ok' };
  var plan = P.planPlay(src, [src, c], { chipKinds: chipKinds });
  assert.equal(plan.action, 'message');
});
t('計畫：不認得的檔案 → 明確訊息', function () {
  var plan = P.planPlay({ name: 'x.qqq', kind: 'qqq' }, [], { chipKinds: chipKinds });
  assert.equal(plan.action, 'message');
  assert.ok(plan.text.length > 0);
});
t('計畫：沒有 key 的檔案（/media-play）不會誤撈其他紀錄當擷取產物', function () {
  var adhoc = { name: 'g.nes', kind: 'nes' };
  var orig = { key: 'O', kind: 'mid', derivedFrom: undefined, status: 'ok' };
  assert.equal(P.planPlay(adhoc, [orig], { chipKinds: chipKinds }).action, 'extract');
});

// ───── 擷取失敗原因（階段＋原因，不吞掉）─────
t('擷取失敗：寫出階段與原因', function () {
  var msg = P.extractFailure({ status: 'failed', stage: 'decode', reason: '解碼失敗：不是 WAV' });
  assert.ok(/解碼/.test(msg) && /不是 WAV/.test(msg), msg);
});
t('擷取失敗：沒有階段時也寫明', function () {
  var msg = P.extractFailure({ status: 'failed', stage: null, reason: '讀檔失敗' });
  assert.ok(/未進入任何階段/.test(msg) && /讀檔失敗/.test(msg), msg);
});
t('擷取：完成或沿用不算失敗', function () {
  assert.equal(P.extractFailure({ status: 'done' }), '');
  assert.equal(P.extractFailure({ status: 'skipped' }), '');
});

// ───── /media-play 參數解析 ─────
t('參數：空白分隔多個路徑', function () {
  assert.deepEqual(P.parseArgs('a.mid b.mp3'), ['a.mid', 'b.mp3']);
});
t('參數：引號內的空白保留（雙引號、單引號、中文引號）', function () {
  assert.deepEqual(P.parseArgs('"D:\\my music\\a b.mid" \'c d.mp3\' “e f.webm”'), ['D:\\my music\\a b.mid', 'c d.mp3', 'e f.webm']);
});
t('參數：反斜線照原樣（Windows 路徑）、多個空白與首尾空白忽略', function () {
  assert.deepEqual(P.parseArgs('   D:\\音樂\\x.rix    y.nsf  '), ['D:\\音樂\\x.rix', 'y.nsf']);
});
t('參數：空字串 → 空陣列（呼叫端就開檔案選擇器）', function () {
  assert.deepEqual(P.parseArgs(''), []);
  assert.deepEqual(P.parseArgs('   '), []);
  assert.deepEqual(P.parseArgs(undefined), []);
});
t('參數：空引號會得到空字串（呼叫端要過濾）', function () {
  assert.deepEqual(P.parseArgs('""'), ['']);
});

t('時間格式', function () {
  assert.equal(P.fmtTime(0), '0:00');
  assert.equal(P.fmtTime(65.4), '1:05');
  assert.equal(P.fmtTime(3725), '1:02:05');
});

(function run() {
  var pass = 0, failed = [];
  tests.forEach(function (x) {
    try { x.fn(); pass++; console.log('  通過  ' + x.name); }
    catch (e) { failed.push(x.name); console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
  });
  console.log('musiclib_play 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
