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
  dsp[0x02] = 0x00; dsp[0x03] = 0x10; dsp[0x07] = 0x7F; dsp[0x6C] = 0x00;
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
