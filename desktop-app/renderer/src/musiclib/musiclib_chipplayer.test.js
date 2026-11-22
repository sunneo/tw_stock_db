/* 晶片音樂播放器單元測試：node renderer/src/musiclib/musiclib_chipplayer.test.js
 * OPL2 的頻率與包絡、RIX 合成樣本的 seek／render 一致性、goto 解析、MIDI 匯出。
 * 測試用的 RIX 位元組是程式手組的（不含任何遊戲檔）；最後一段讀真實 RIX 檔，唯讀，最多 3 個，檔案不存在就略過。 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var OPL2 = require('./musiclib_opl2.js');
var CP = require('./musiclib_chipplayer.js');
require('./musiclib_chip_rix.js');   // 註冊 rix 後端

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

// ───── OPL2 基本音（載波、無調變） ─────
function pureCarrier(chip, block, fnum) {
  chip.write(0x01, 0x20);
  chip.write(0x40, 0x3F);                           // 調變器總音量最小（靜音）
  chip.write(0x20, 0x01); chip.write(0x60, 0xF0); chip.write(0x80, 0x00);
  chip.write(0x23, 0x21); chip.write(0x43, 0x00); chip.write(0x63, 0xF0); chip.write(0x83, 0x00);
  chip.write(0xE0, 0); chip.write(0xE3, 0);
  chip.write(0xC0, 0x01);
  chip.write(0xA0, fnum & 0xFF); chip.write(0xB0, 0x20 | (block << 2) | ((fnum >> 8) & 3));
}
function crossings(buf) { var z = 0; for (var i = 1; i < buf.length; i++) if (buf[i - 1] < 0 && buf[i] >= 0) z++; return z; }

t('OPL2：A4（440 Hz）的主頻在 440 Hz 附近', function () {
  var c = OPL2.create(44100); pureCarrier(c, 4, 580);   // 440 ≈ 580 × 49716 ÷ 2^16
  var n = 44100, buf = new Float32Array(n); c.render(buf, 0, n);
  var z = crossings(buf);
  assert.ok(Math.abs(z - 440) <= 4, '正向過零次數 ' + z + '，應接近 440');
});

t('OPL2：包絡 — 按下有攻擊、放開後很快靜下來', function () {
  var c = OPL2.create(44100); pureCarrier(c, 4, 580);
  var n = 4410, buf = new Float32Array(n); c.render(buf, 0, n);     // 0.1 秒
  var peak = 0; for (var i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
  assert.ok(peak > 0.15, '按下後應有聲音，峰值 ' + peak);
  c.write(0xB0, (4 << 2) | ((580 >> 8) & 3));           // 放開（key-on 位元清掉）
  var tail = new Float32Array(44100); c.render(tail, 0, 44100);   // 1 秒後
  var tailPeak = 0; for (var j = 22050; j < 44100; j++) tailPeak = Math.max(tailPeak, Math.abs(tail[j]));
  assert.ok(tailPeak < 0.01, '放開後 0.5 秒以後應靜音，實際 ' + tailPeak);
});

t('OPL2：波形 1（半波）沒有負值', function () {
  var c = OPL2.create(44100);
  pureCarrier(c, 4, 580); c.write(0xE3, 1);
  var n = 8820, buf = new Float32Array(n); c.render(buf, 0, n);
  // 調變器 TL=63 仍有約 −47 dB 的漏音（真晶片也一樣），所以只檢查最小值不低於漏音量
  var min = 0; for (var i = 0; i < n; i++) min = Math.min(min, buf[i]);
  assert.ok(min > -0.01, '半波正弦的負值應只來自調變器的漏音，實際最小值 ' + min);
});

t('OPL2：回授改變調變器的波形（fb=0 與 fb=7 的輸出不同）', function () {
  function run(fb) {
    var c = OPL2.create(44100);
    c.write(0x01, 0x20); c.write(0x20, 0x01); c.write(0x40, 0x00); c.write(0x60, 0xF0); c.write(0x80, 0x00);
    c.write(0x23, 0x21); c.write(0x43, 0x00); c.write(0x63, 0xF0); c.write(0x83, 0x00); c.write(0xE0, 0); c.write(0xE3, 0);
    c.write(0xC0, (fb << 1) | 0); c.write(0xA0, 0x44); c.write(0xB0, 0x32);
    var n = 4410, buf = new Float32Array(n); c.render(buf, 0, n); return buf;
  }
  var a = run(0), b = run(7), diff = 0;
  for (var i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
  assert.ok(diff > 0.01, '回授應改變波形，最大差 ' + diff);
});

t('OPL2：快照與還原後的輸出完全相同', function () {
  var c = OPL2.create(44100); pureCarrier(c, 4, 580);
  var warm = new Float32Array(2000); c.render(warm, 0, 2000);
  var snap = c.snapshot();
  var a = new Float32Array(3000); c.render(a, 0, 3000);
  c.restore(snap);
  var b = new Float32Array(3000); c.render(b, 0, 3000);
  for (var i = 0; i < a.length; i++) assert.strictEqual(b[i], a[i], '第 ' + i + ' 個樣本不同');
});

// ───── 手組的 RIX 檔（一個頻道、一個音 A4、一秒，之後放開） ─────
function buildRix() {
  var musBlock = 0x60, words = [];
  var ins = new Array(28).fill(0);
  ins[0] = 0x01; ins[1] = 0x3F; ins[2] = 0xF0; ins[3] = 0x00;     // 調變器：靜音
  ins[13] = 0x21; ins[14] = 0x00; ins[15] = 0xF0; ins[16] = 0x0F; // 載波：持續、快速釋放
  var b = new Uint8Array(musBlock + 64);
  b[0] = 0xAA; b[1] = 0x55; b[2] = 0;                 // 0x55AA 以小端序寫入
  b[8] = 0x14; b[12] = musBlock & 0xFF; b[13] = musBlock >> 8;
  for (var i = 0; i < 28; i++) { b[0x14 + i * 2] = ins[i] & 0xFF; b[0x14 + i * 2 + 1] = 0; }
  // 樂譜字：[資料, 控制]
  function w(data, ctrl) { words.push([data, ctrl]); }
  w(0x00, 0x90);          // 頻道 0 選樂器 0
  w(0x7F, 0xB0);          // 頻道 0 音量最大
  w(69, 0xC0);            // A4 開始
  w(212, 0x03);           // 延遲 980 = 1 秒
  w(0x00, 0xC0);          // 關音
  w(0x00, 0x80);          // 結束
  var len = musBlock + words.length * 2 + 8;
  var out = new Uint8Array(len);
  out.set(b.subarray(0, musBlock));
  words.forEach(function (p, k) { out[musBlock + k * 2] = p[0]; out[musBlock + k * 2 + 1] = p[1]; });
  return out;
}

t('RIX：解析出 OPL2 暫存器寫入序列（有按鍵、放開，時長約 1 秒）', function () {
  var be = CP.getBackend('rix');
  var loaded = be.parse(buildRix());
  var keyOns = loaded.regs.filter(function (r) { return r.r >= 0xB0 && r.r <= 0xB8 && (r.v & 0x20); });
  var keyOffs = loaded.regs.filter(function (r) { return r.r >= 0xB0 && r.r <= 0xB8 && !(r.v & 0x20); });
  assert.ok(keyOns.length >= 1, '應有按鍵（key-on）寫入');
  assert.ok(keyOffs.length >= 1, '應有放開（key-off）寫入');
  assert.ok(Math.abs(loaded.lengthSec - 1) < 0.01, '時長應約 1 秒，實際 ' + loaded.lengthSec);
});

t('播放器：render 與 seek 後連續播放的結果一致', function () {
  var p = CP.createPlayer('rix', buildRix(), { sampleRate: 22050, checkpointSec: 0.25 });
  var full = p.render(0, 0, null);                       // 整首
  var sr = 22050;
  var ref = full.subarray(Math.round(0.6 * sr), Math.round(1.0 * sr));
  p.seek(0.6);
  var got = new Float32Array(ref.length);
  assert.strictEqual(p.read(got, got.length), got.length);
  for (var i = 0; i < ref.length; i++) assert.ok(Math.abs(got[i] - ref[i]) < 1e-6, 'seek 後第 ' + i + ' 個樣本與連續渲染不同');
  // 再從檢查點之後跳回前面（會從較前的檢查點還原）
  p.seek(0.3);
  var back = new Float32Array(sr * 0.2); p.read(back, back.length);
  var refBack = full.subarray(Math.round(0.3 * sr), Math.round(0.5 * sr));
  for (var j = 0; j < back.length; j++) assert.ok(Math.abs(back[j] - refBack[j]) < 1e-6, '回頭 seek 後第 ' + j + ' 個樣本不同');
});

t('播放器：render(曲目, 起點, 長度) 只給指定範圍，且不改變目前位置', function () {
  var p = CP.createPlayer('rix', buildRix(), { sampleRate: 22050, checkpointSec: 0.25 });
  p.seek(0.2);
  var before = p.positionSec();
  var seg = p.render(0, 0.5, 0.25);
  assert.strictEqual(seg.length, Math.round(0.25 * 22050));
  assert.strictEqual(p.positionSec(), before, 'render 不應改變目前播放位置');
});

t('播放器：曲目列表與 durationSec', function () {
  var p = CP.createPlayer('rix', buildRix(), { sampleRate: 22050 });
  assert.strictEqual(p.trackCount(), 1);
  assert.ok(p.durationSec(0) > 1, '時長包含釋放尾巴，應大於 1 秒');
  assert.strictEqual(p.tracks()[0].index, 0);
});

t('播放器：seek 超過曲長會停在曲尾，不會卡住', function () {
  var p = CP.createPlayer('rix', buildRix(), { sampleRate: 22050 });
  p.seek(999);
  assert.ok(p.atEnd(), '應到曲尾');
  var buf = new Float32Array(100);
  assert.strictEqual(p.read(buf, 100), 0);
});

t('goto：時間與曲目編號的解析', function () {
  assert.deepStrictEqual(CP.parseGoto('1:23'), { kind: 'time', sec: 83 });
  assert.deepStrictEqual(CP.parseGoto('1:02:03'), { kind: 'time', sec: 3723 });
  assert.deepStrictEqual(CP.parseGoto('83'), { kind: 'time', sec: 83 });
  assert.deepStrictEqual(CP.parseGoto('曲目 3'), { kind: 'track', index: 2 });
  assert.deepStrictEqual(CP.parseGoto('t1'), { kind: 'track', index: 0 });
  assert.strictEqual(CP.parseGoto('曲目 0'), null);
  assert.strictEqual(CP.parseGoto('隨便'), null);
});

t('匯出：MIDI 來自 RIX 擷取結果（有音符）；沒有 MIDI 的後端會明確丟錯', function () {
  var p = CP.createPlayer('rix', buildRix(), { sampleRate: 22050 });
  var song = p.toMidi(0);
  var notes = 0; song.tracks.forEach(function (tr) { notes += tr.notes.length; });
  assert.ok(notes >= 1, 'MIDI 應有音符');
  CP.registerBackend({ kind: 'nomidi', label: '測試', parse: function () { return { tracks: [{ durationSec: 1 }] }; }, openStream: function () { return { read: function () {}, snapshot: function () { return {}; }, restore: function () {} }; } });
  var q = CP.createPlayer('nomidi', new Uint8Array(1), {});
  assert.throws(function () { q.toMidi(0); }, /無法匯出 MIDI/);
});

t('登錄：rix 後端已註冊，未知格式會丟錯', function () {
  assert.ok(CP.listBackends().some(function (b) { return b.kind === 'rix'; }));
  assert.throws(function () { CP.createPlayer('zzz', new Uint8Array(1)); }, /沒有這個晶片格式/);
});

t('真實 RIX（唯讀，最多 3 個）：能解析並渲染前 3 秒，不靜音', function () {
  var dir = 'D:\\Downloads\\SOFTSTAR.tar\\SOFTSTAR\\SOFTSTAR\\PAL\\86RIX';
  if (!fs.existsSync(dir)) { console.log('        （略過：沒有真實 RIX 目錄）'); return; }
  var files = fs.readdirSync(dir).filter(function (f) { return /\.rix$/i.test(f); }).sort().slice(0, 3);
  assert.ok(files.length > 0);
  files.forEach(function (f) {
    var p = CP.createPlayer('rix', new Uint8Array(fs.readFileSync(path.join(dir, f))), { sampleRate: 22050 });
    var seg = p.render(0, 0, 3);
    var peak = 0; for (var i = 0; i < seg.length; i++) peak = Math.max(peak, Math.abs(seg[i]));
    assert.ok(peak > 0.001, f + ' 前 3 秒幾乎靜音（峰值 ' + peak + '）');
  });
});

// ───── 執行 ─────
(function () {
  var pass = 0, failed = [];
  tests.forEach(function (tc) {
    try { tc.fn(); pass++; console.log('  通過  ' + tc.name); }
    catch (e) { failed.push(tc.name); console.log('  失敗  ' + tc.name + '\n        ' + (e && e.message)); }
  });
  console.log('musiclib_chipplayer 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
