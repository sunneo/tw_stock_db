/* SPC 晶片後端單元測試：node renderer/src/musiclib/musiclib_chip_spc_test.js
 * 用手組的 .spc（SPC700 程式＋BRR 正弦）驗證：辨識、ID666 長度與預設、串流頻率（44.1 kHz 重取樣後仍約 2000 Hz）、
 * 快照還原的逐位元一致、透過 FaChipPlayer 的 seek 與 render。 */
'use strict';
var assert = require('assert');
var CORE = require('./musiclib_spc_core.js');
var SFC = require('./musiclib_extract_sfc.js');
var CP = require('./musiclib_chipplayer.js');
var BE = require('./musiclib_chip_spc.js').createBackend();

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }
var SINE16 = [0, 3, 5, 7, 7, 7, 5, 3, 0, -3, -5, -7, -7, -7, -5, -3];

// 一個會發聲的 .spc：聲道 0 播放 $0300 的循環 BRR 正弦，pitch $1000（2000 Hz），程式停在 BRA 迴圈
function makeSpc(opts) {
  opts = opts || {};
  var ram = new Uint8Array(65536), dsp = new Uint8Array(128);
  ram.set([0x2F, 0xFE], 0x0400);                           // BRA $0400（停在這裡）
  ram.set([0x00, 0x03, 0x00, 0x03], 0x0200);               // 來源目錄
  var blk = [(12 << 4) | 3];
  for (var i = 0; i < 8; i++) blk.push(((SINE16[2 * i] & 15) << 4) | (SINE16[2 * i + 1] & 15));
  ram.set(blk, 0x0300);
  dsp[0x5D] = 0x02; dsp[0x0C] = 0x7F; dsp[0x1C] = 0x7F; dsp[0x00] = 0x7F; dsp[0x01] = 0x7F;
  var pitch = opts.pitch == null ? 0x1000 : opts.pitch;
  dsp[0x02] = pitch & 0xFF; dsp[0x03] = (pitch >> 8) & 0xFF; dsp[0x07] = 0x7F; dsp[0x6C] = 0x00;
  dsp[0x4C] = opts.kon == null ? 0x01 : opts.kon;
  return SFC.packSpc({ ram: ram, dsp: dsp, pc: 0x0400, title: opts.title || 'テスト', game: 'G', artist: 'A', lengthSec: opts.lengthSec == null ? 42 : opts.lengthSec });
}

t('辨識：有效的 .spc 可載入，其他位元組不算', function () {
  var b = makeSpc();
  assert.strictEqual(BE.canLoad(b), true);
  assert.strictEqual(BE.canLoad(new Uint8Array(0x10200)), false);
  assert.strictEqual(BE.canLoad(new Uint8Array(10)), false);
});
t('解析：ID666 長度生效；沒有長度時用 180 秒預設並說明原因', function () {
  var a = BE.parse(makeSpc({ lengthSec: 42 }));
  assert.strictEqual(a.tracks.length, 1);
  assert.strictEqual(a.tracks[0].durationSec, 42);
  var b = BE.parse(makeSpc({ lengthSec: 0 }));
  assert.strictEqual(b.tracks[0].durationSec, 180);
  assert.ok(/預設/.test(b.tracks[0].durationNote));
});
t('串流：44100 Hz 讀 1 秒，約 2000 Hz 正弦（過零數）', function () {
  var loaded = BE.parse(makeSpc());
  var s = BE.openStream(loaded, 0, 44100);
  var buf = new Float32Array(44100);
  s.read(buf, 0, buf.length);
  var cx = 0; for (var i = 1; i < buf.length; i++) if (buf[i - 1] <= 0 && buf[i] > 0) cx++;
  assert.ok(Math.abs(cx - 2000) <= 25, '過零數 ' + cx);
  var finite = true; for (i = 0; i < buf.length; i++) if (!isFinite(buf[i])) { finite = false; break; }
  assert.ok(finite);
});
t('快照還原：從中途還原後再讀的結果與原本逐位元相同', function () {
  var loaded = BE.parse(makeSpc());
  var s = BE.openStream(loaded, 0, 44100);
  s.read(new Float32Array(20000), 0, 20000);
  var snap = s.snapshot();
  var a = new Float32Array(5000); s.read(a, 0, 5000);
  s.restore(snap);
  var b = new Float32Array(5000); s.read(b, 0, 5000);
  for (var i = 0; i < a.length; i++) assert.strictEqual(a[i], b[i], '第 ' + i + ' 個樣本不同');
});
t('播放器：FaChipPlayer 的 spc 後端可 seek、render，且 seek 後與順序播放一致', function () {
  if (!CP.getBackend) throw new Error('chipplayer 缺少 getBackend');
  try { CP.getBackend('spc'); } catch (e) { CP.registerBackend(BE); }
  var p = CP.createPlayer('spc', makeSpc(), { sampleRate: 44100, checkpointSec: 0.5 });
  assert.strictEqual(p.kind, 'spc');
  assert.strictEqual(p.durationSec(0), 42);
  var seq = new Float32Array(44100 * 2);
  p.read(seq, 44100 * 2);                                  // 順序讀 2 秒（不 seek）
  var q = CP.createPlayer('spc', makeSpc(), { sampleRate: 44100, checkpointSec: 0.5 });
  q.seek(1.0);
  var tail = new Float32Array(44100);
  q.read(tail, 44100);
  for (var i = 0; i < 44100; i += 97) assert.ok(Math.abs(seq[44100 + i] - tail[i]) < 1e-6, 'seek 後第 ' + i + ' 個樣本不同');
  var r = q.render(0, 0, 0.25);
  assert.strictEqual(r.length, Math.round(0.25 * 44100));
});

t('MIDI：toMidi 回傳與 FaMidi 同形；單一 SRCN 的中心音落在 MIDI 60，軌名為 SRCN 0', function () {
  var loaded = BE.parse(makeSpc({ pitch: 56, lengthSec: 2 }));
  var song = BE.toMidi(loaded, 0);
  assert.strictEqual(typeof song.ppq, 'number');
  assert.ok(Array.isArray(song.tracks) && song.tracks.length >= 1, '沒有音軌');
  var tr = song.tracks[0];
  assert.strictEqual(tr.name, 'SRCN 0');
  assert.strictEqual(tr.channel, 0);
  assert.strictEqual(tr.notes[0].n, 60, '音符 ' + tr.notes[0].n);
});
t('MIDI：整首讀回 FaMidi（write→parse）音符數與軌數一致，音高都在 36–96', function () {
  var FM = require('../music/midi_core.js');
  var song = BE.toMidi(BE.parse(makeSpc({ pitch: 0x1000, lengthSec: 3 })), 0);
  var bytes = FM.write(FM.validate(song));
  var back = FM.parse(bytes);
  assert.strictEqual(FM.noteCount(back), FM.noteCount(song));
  song.tracks.forEach(function (tr) { tr.notes.forEach(function (x) { assert.ok(x.n >= 36 && x.n <= 96 && x.d >= 1); }); });
});
t('MIDI：音符時長延續到曲長（2 秒 ≈ 1920 tick，ppq 480、120 BPM）', function () {
  var loaded = BE.parse(makeSpc({ pitch: 56, lengthSec: 2 }));
  var song = BE.toMidi(loaded, 0);
  var d = song.tracks[0].notes[0].d;
  assert.ok(Math.abs(d - 1920) <= 2, '時長 ' + d + ' tick');
});
t('MIDI：沒有發聲的 .spc（KON 為 0）不產生音軌', function () {
  var loaded = BE.parse(makeSpc({ kon: 0, lengthSec: 1 }));
  var song = BE.toMidi(loaded, 0);
  assert.strictEqual(song.tracks.length, 0);
});
t('MIDI：只有一首曲目，其他編號要說明', function () {
  var loaded = BE.parse(makeSpc({ lengthSec: 1 }));
  assert.throws(function () { BE.toMidi(loaded, 1); }, /只有一首/);
});

// 以下直接測 buildSong 的規則（音符資料是手組的，不經過核心）
function rawNote(srcn, startSec, durSec, pitches, env) {
  return { srcn: srcn, start: Math.round(startSec * 32000), end: Math.round((startSec + durSec) * 32000), pitches: pitches, env: env || 100 };
}
t('MIDI 規則：顫音（音高在音符期間變動）不切新音符', function () {
  var build = require('./musiclib_chip_spc.js').buildSong;
  var p = []; for (var i = 0; i < 200; i++) p.push(4096 + (i % 2 ? 40 : -40));
  var r = build([rawNote(0, 0, 2, p)], 'x');
  assert.strictEqual(r.song.tracks[0].notes.length, 1);
  assert.strictEqual(r.song.tracks[0].notes[0].d, 1920);
});
t('MIDI 規則：短（< 0.25 秒）且音高不穩的音符放聲道 10（鼓）；短而穩定的不是鼓', function () {
  var build = require('./musiclib_chip_spc.js').buildSong;
  var r = build([rawNote(3, 0, 0.1, [1000, 1500, 2200]), rawNote(4, 1, 0.1, [2000, 2000, 2001])], 'x');
  var drum = r.song.tracks.filter(function (tr) { return tr.drum; });
  assert.strictEqual(drum.length, 1);
  assert.strictEqual(drum[0].channel, 9);
  assert.strictEqual(r.song.tracks.filter(function (tr) { return !tr.drum; }).length, 1);
});
t('MIDI 規則：每個 SRCN 一個聲道；不足 5 毫秒的音符丟棄且不產生 0 長度音符', function () {
  var build = require('./musiclib_chip_spc.js').buildSong;
  var r = build([rawNote(7, 0, 1, [4096]), rawNote(9, 0, 1, [8192]), rawNote(7, 2, 0.001, [4096])], 'x');
  assert.strictEqual(r.song.tracks.length, 2);
  assert.notStrictEqual(r.song.tracks[0].channel, r.song.tracks[1].channel);
  assert.strictEqual(r.stats.shortDropped, 1);
  r.song.tracks.forEach(function (tr) { tr.notes.forEach(function (x) { assert.ok(x.d >= 1); }); });
});
t('MIDI 規則：整首平移到 36–96（兩個八度差的聲道都落進範圍）', function () {
  var build = require('./musiclib_chip_spc.js').buildSong;
  var r = build([rawNote(0, 0, 1, [4096]), rawNote(1, 0, 1, [4096 * 2]), rawNote(2, 1, 1, [4096 / 2])], 'x');
  r.song.tracks.forEach(function (tr) { tr.notes.forEach(function (x) { assert.ok(x.n >= 36 && x.n <= 96, '音高 ' + x.n); }); });
  assert.strictEqual(r.stats.clamped, 0);
});

function runAll() {
  var fail = 0;
  tests.forEach(function (x) {
    try { x.fn(); console.log('ok   - ' + x.name); }
    catch (e) { fail++; console.log('FAIL - ' + x.name + '\n       ' + (e && e.message || e)); }
  });
  console.log(tests.length - fail + ' / ' + tests.length + ' 通過');
  if (fail) process.exitCode = 1;
}
runAll();
