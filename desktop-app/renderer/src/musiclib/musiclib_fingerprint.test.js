/* 音訊指紋（階段一）的單元測試：node renderer/src/musiclib/musiclib_fingerprint.test.js 直接跑。
 * 合成音訊全部用固定種子產生，結果可重現：找回正確的歌與偏移、加雜訊與改音量仍找得到、非命中不亂報、3 分鐘的歌 ≤ 3 秒。 */
'use strict';
var assert = require('assert');
var FP = require('./musiclib_fingerprint.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

function rng(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// 合成「歌」：音符隨機（音高 110–880 Hz、音長 0.15–0.5 秒）＋低音，每個音含二次諧波，像真的音樂有多音與節奏
function makeSong(seed, sec, sr) {
  sr = sr || 11025;
  var r = rng(seed), n = Math.floor(sec * sr), x = new Float32Array(n), t0 = 0;
  while (t0 < sec) {
    var d = 0.15 + r() * 0.35, f = 110 * Math.pow(2, Math.floor(r() * 36) / 12), amp = 0.25 + r() * 0.2;
    var s0 = Math.floor(t0 * sr), s1 = Math.min(n, Math.floor((t0 + d) * sr));
    for (var i = s0; i < s1; i++) {
      var tt = (i - s0) / sr, env = Math.min(1, (i - s0) / (0.01 * sr)) * Math.exp(-2.5 * tt / d);
      x[i] += amp * env * (Math.sin(2 * Math.PI * f * tt) + 0.4 * Math.sin(2 * Math.PI * 2 * f * tt));
    }
    // 低音（每隔一段換一次）
    var fb = 55 * Math.pow(2, Math.floor(r() * 12) / 12), bs = Math.floor(t0 * sr), be = Math.min(n, Math.floor((t0 + 2 * d) * sr));
    for (var j = bs; j < be; j++) x[j] += 0.15 * Math.sin(2 * Math.PI * fb * (j - bs) / sr);
    t0 += d;
  }
  var mx = 0; for (var k = 0; k < n; k++) if (Math.abs(x[k]) > mx) mx = Math.abs(x[k]);
  for (k = 0; k < n; k++) x[k] /= (mx || 1);
  return x;
}
// 查詢用變形：取一段、改音量、加白雜訊（SNR 約 20 dB）、加輕微殘響（一個延遲的衰減回聲）
function clipVariant(song, startSec, lenSec, o, sr) {
  sr = sr || 11025;
  var a = Math.floor(startSec * sr), len = Math.floor(lenSec * sr), q = new Float32Array(len), r = rng(o.seed || 7);
  for (var i = 0; i < len; i++) q[i] = song[a + i] * (o.gain || 1);
  if (o.noise) { for (i = 0; i < len; i++) q[i] += (r() * 2 - 1) * o.noise; }
  if (o.echo) {
    var d = Math.floor(0.07 * sr), e = new Float32Array(len);
    for (i = 0; i < len; i++) e[i] = q[i] + (i >= d ? 0.35 * e[i - d] : 0);
    q = e;
  }
  return q;
}
function sigPower(x) { var s = 0; for (var i = 0; i < x.length; i++) s += x[i] * x[i]; return s / x.length; }

// 建索引（與音樂庫的紀錄形式一樣：fingerprint → pack，再 buildIndex）
function makeEntries(songs) {
  return songs.map(function (s) { return { key: s.key, name: s.name, path: s.path, fp: FP.pack(FP.fingerprint(s.samples, 11025)) }; });
}

// ───── 測試 ─────
var SONGS = [
  { key: 'a', name: '甲.mp3', path: 'D:/m/甲.mp3', samples: makeSong(101, 40) },
  { key: 'b', name: '乙.mp3', path: 'D:/m/乙.mp3', samples: makeSong(202, 40) },
  { key: 'c', name: '丙.mp3', path: 'D:/m/丙.mp3', samples: makeSong(303, 40) }
];
var INDEX = null;
function index() { if (!INDEX) INDEX = FP.buildIndex(makeEntries(SONGS)); return INDEX; }

t('地標與色度有產出，格式版本與取樣率正確', function () {
  var fp = FP.fingerprint(SONGS[0].samples, 11025);
  assert.equal(fp.v, FP.FP_VERSION);
  assert.equal(fp.sr, 11025);
  assert.ok(fp.hashes.length > 500, '地標太少：' + fp.hashes.length);
  assert.ok(fp.chroma.length === fp.cells * 12, '色度長度要是格數 × 12');
  assert.ok(Math.abs(fp.dur - 40) < 0.01, '長度應約 40 秒，實際 ' + fp.dur);
});

t('存檔（pack）再讀回（unpack）內容完全相同', function () {
  var fp = FP.fingerprint(SONGS[1].samples, 11025), u = FP.unpack(JSON.parse(JSON.stringify(FP.pack(fp))));
  assert.equal(u.hashes.length, fp.hashes.length);
  for (var i = 0; i < fp.hashes.length; i++) { assert.equal(u.hashes[i], fp.hashes[i]); assert.equal(u.times[i], fp.times[i]); }
  assert.equal(u.chroma.length, fp.chroma.length);
  for (i = 0; i < fp.chroma.length; i++) assert.equal(u.chroma[i], fp.chroma[i]);
});

t('乾淨的片段：找回正確的歌與秒數（誤差 ≤ 0.1 秒）', function () {
  var q = FP.fingerprint(clipVariant(SONGS[1].samples, 15.3, 12, {}), 11025);
  var r = FP.search(q, index());
  assert.ok(r.ok, '應命中：' + r.reason);
  assert.equal(r.top.key, 'b');
  assert.ok(Math.abs(r.top.offsetSec - 15.3) <= 0.1, '偏移應約 15.3，實際 ' + r.top.offsetSec);
});

t('加雜訊、改音量、加殘響後仍找回正確的歌與秒數', function () {
  var base = clipVariant(SONGS[0].samples, 22.7, 12, {});
  var p = sigPower(base);
  var noise = Math.sqrt(p / Math.pow(10, 2.0)) * Math.sqrt(3);   // 白雜訊（均勻分布，變異數 = noise²/3）SNR 約 20 dB
  var variants = [
    { gain: 0.3, seed: 3 },
    { gain: 1.8, seed: 4 },
    { noise: noise, seed: 5 },
    { echo: true, seed: 6 },
    { gain: 0.5, noise: noise, echo: true, seed: 7 }
  ];
  variants.forEach(function (o, i) {
    var q = FP.fingerprint(clipVariant(SONGS[0].samples, 22.7, 12, o), 11025);
    var r = FP.search(q, index());
    assert.ok(r.ok, '變形 ' + i + ' 應命中：' + r.reason);
    assert.equal(r.top.key, 'a', '變形 ' + i + ' 認錯歌：' + r.top.name);
    assert.ok(Math.abs(r.top.offsetSec - 22.7) <= 0.15, '變形 ' + i + ' 偏移應約 22.7，實際 ' + r.top.offsetSec);
  });
});

t('取樣率 44100 的來源（降頻路徑）也找得到', function () {
  var hi = makeSong(101, 40, 44100);
  var q = FP.fingerprint(clipVariant(hi, 8.5, 12, { gain: 0.7, seed: 9 }, 44100), 44100);
  var r = FP.search(q, index());
  assert.ok(r.ok, '應命中：' + r.reason);
  assert.equal(r.top.key, 'a');
  assert.ok(Math.abs(r.top.offsetSec - 8.5) <= 0.15, '偏移 ' + r.top.offsetSec);
});

t('不在索引裡的歌：不亂報（沒有命中）', function () {
  var other = makeSong(999, 12);
  var r = FP.search(FP.fingerprint(other, 11025), index());
  assert.equal(r.ok, false, '非命中卻回報命中：' + (r.top && r.top.name) + ' 票 ' + (r.top && r.top.votes));
  assert.ok(r.reason, '沒找到要寫出原因');
});

t('白雜訊片段：不亂報', function () {
  var rn = rng(5), x = new Float32Array(12 * 11025);
  for (var i = 0; i < x.length; i++) x[i] = rn() * 2 - 1;
  var r = FP.search(FP.fingerprint(x, 11025), index());
  assert.equal(r.ok, false, '雜訊卻命中：' + (r.top && r.top.name));
});

t('沒有新特徵的舊紀錄：不進索引，列在 missing 裡', function () {
  var entries = makeEntries(SONGS).concat([{ key: 'old', name: '舊.mp3', path: 'D:/m/舊.mp3', fp: null }]);
  var idx = FP.buildIndex(entries);
  assert.equal(idx.songs.length, 3);
  assert.equal(idx.missing.length, 1);
  assert.equal(idx.missing[0].name, '舊.mp3');
});

t('3 分鐘的歌（11025 Hz）建立指紋 ≤ 3 秒', function () {
  var long = makeSong(777, 180);
  var t0 = Date.now(), fp = FP.fingerprint(long, 11025), ms = Date.now() - t0;
  assert.ok(ms <= 3000, '花了 ' + ms + ' 毫秒（上限 3000）');
  console.log('      3 分鐘（11025 Hz）：' + ms + ' 毫秒，地標 ' + fp.hashes.length + '，色度 ' + fp.cells + ' 格');
});

t('3 分鐘的歌（44100 Hz 來源）建立指紋 ≤ 3 秒', function () {
  var long = makeSong(778, 180, 44100);
  var t0 = Date.now(), fp = FP.fingerprint(long, 44100), ms = Date.now() - t0;
  assert.ok(ms <= 3000, '花了 ' + ms + ' 毫秒（上限 3000）');
  console.log('      3 分鐘（44100 Hz 來源）：' + ms + ' 毫秒，地標 ' + fp.hashes.length);
});

var failed = 0;
tests.forEach(function (x) {
  try { x.fn(); console.log('ok  ' + x.name); }
  catch (e) { failed++; console.log('FAIL ' + x.name + '\n      ' + (e && e.message)); }
});
console.log(failed ? (failed + ' 項失敗') : ('全部通過（' + tests.length + ' 項）'));
if (failed) process.exitCode = 1;
