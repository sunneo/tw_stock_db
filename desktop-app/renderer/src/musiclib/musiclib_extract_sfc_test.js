/* SFC 擷取的單元測試（不執行 ROM）：node renderer/src/musiclib/musiclib_extract_sfc_test.js
 * 手組的 ROM 標頭、.spc 位元組與 DSP 事件都在程式裡。最後一段是真實 SFC 樣本的唯讀檢查（只讀頭幾個 .sfc，不複製進 repo；目錄不存在就略過）。 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var SFC = require('./musiclib_extract_sfc.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

// 手組 LoROM：64KB，標題放在 $7FC0，校驗和（補數 XOR 校驗和 = 0xFFFF）放在 $7FDC–$7FDF
function loromImage(title, mapMode) {
  var b = new Uint8Array(0x10000).fill(0xEA);
  for (var i = 0; i < 21; i++) b[0x7FC0 + i] = (title.charCodeAt(i) || 0x20) & 0xFF;
  b[0x7FD5] = mapMode == null ? 0x20 : mapMode;
  var sum = 0x1234, comp = sum ^ 0xFFFF;
  b[0x7FDC] = comp & 0xFF; b[0x7FDD] = comp >> 8; b[0x7FDE] = sum & 0xFF; b[0x7FDF] = sum >> 8;
  return b;
}
function withCopier(img) { var out = new Uint8Array(512 + img.length); out.set(img, 512); return out; }

t('classifySfc 認 .sfc 與 .smc（含 copier 檔頭），非 .sfc 拒認', function () {
  var img = loromImage('SAMPLE GAME', 0x20);
  var a = SFC.classifySfc('game.sfc', img);
  assert.strictEqual(a.cls, 'rom'); assert.strictEqual(a.kind, 'sfc'); assert.ok(/LoROM/.test(a.label), a.label);
  var b = SFC.classifySfc('game.smc', withCopier(img));
  assert.strictEqual(b.cls, 'rom'); assert.ok(/copier/.test(b.label), b.label);
  assert.strictEqual(SFC.classifySfc('notes.txt', img).cls, 'nonrom');
  assert.strictEqual(SFC.classifySfc('tiny.sfc', new Uint8Array(100)).cls, 'nonrom');
});

t('parseSnesHeader 找到 LoROM 標題與校驗和；copier 檔頭會先去掉', function () {
  var h = SFC.parseSnesHeader(withCopier(loromImage('STAR FOX', 0x20)));
  assert.strictEqual(h.copier, true); assert.strictEqual(h.ok, true); assert.strictEqual(h.hirom, false);
  assert.strictEqual(h.title, 'STAR FOX');
});

t('parseSnesHeader：校驗和不符時 ok=false 並寫原因', function () {
  var img = loromImage('BAD', 0x20); img[0x7FDE] ^= 0xFF;
  var h = SFC.parseSnesHeader(img);
  assert.strictEqual(h.ok, false); assert.ok(/校驗和/.test(h.reason), h.reason);
});

t('packSpc 長度 0x10200、簽章、暫存器與 ID666 欄位可以讀回', function () {
  var ram = new Uint8Array(65536); ram[0x1234] = 0xAB; ram[0xFFFF] = 0x5A;
  var dsp = new Uint8Array(128); dsp[0x4C] = 0x01; dsp[0x7F] = 0x7F;
  var spc = SFC.packSpc({ ram: ram, dsp: dsp, pc: 0x0400, a: 1, x: 2, y: 3, psw: 0x02, sp: 0x01EF, title: 'Title', game: 'Game', artist: 'Artist', lengthSec: 95, fadeMs: 5000 });
  assert.strictEqual(spc.length, 0x10200);
  var p = SFC.parseSpc(spc);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.pc, 0x0400); assert.strictEqual(p.a, 1); assert.strictEqual(p.x, 2); assert.strictEqual(p.y, 3);
  assert.strictEqual(p.psw, 0x02); assert.strictEqual(p.sp, 0x01EF);
  assert.strictEqual(p.title, 'Title'); assert.strictEqual(p.game, 'Game'); assert.strictEqual(p.artist, 'Artist');
  assert.strictEqual(p.lengthSec, 95);
  assert.strictEqual(p.ram[0x1234], 0xAB); assert.strictEqual(p.ram[0xFFFF], 0x5A);
  assert.strictEqual(p.dsp[0x4C], 0x01); assert.strictEqual(p.dsp[0x7F], 0x7F);
  assert.strictEqual(SFC.parseSpc(new Uint8Array(100)).ok, false);
});

t('dspEventsToSong：音高 56 的 KON 到 KOFF（1 秒）→ A4（69）、時長 960 tick', function () {
  var ev = [
    { t: 0, reg: 0x02, value: 56 },     // V0 PITCHL：56 ≈ 440 Hz
    { t: 0, reg: 0x03, value: 0 },      // V0 PITCHH
    { t: 0, reg: 0x00, value: 0x7F },   // V0 VOLL（用來算力度）
    { t: 0, reg: 0x01, value: 0x7F },   // V0 VOLR
    { t: 0, reg: 0x4C, value: 0x01 },   // KON V0
    { t: 32000, reg: 0x5C, value: 0x01 } // KOFF V0（1 秒後）
  ];
  var r = SFC.dspEventsToSong(ev, { title: 'x' });
  assert.strictEqual(r.stats.kon, 1); assert.strictEqual(r.stats.koff, 1);
  assert.strictEqual(r.song.tracks.length, 1);
  var n = r.song.tracks[0].notes;
  assert.strictEqual(n.length, 1);
  assert.strictEqual(n[0].n, 69, '音高 ' + n[0].n);
  assert.strictEqual(n[0].t, 0); assert.strictEqual(n[0].d, 960);
});

t('dspEventsToSong：音高改變視為換音（兩個音符）；沒有 KON 的聲道不產生音軌', function () {
  var ev = [
    { t: 0, reg: 0x02, value: 56 }, { t: 0, reg: 0x03, value: 0 }, { t: 0, reg: 0x4C, value: 0x01 },
    { t: 16000, reg: 0x02, value: 112 },                    // 0.5 秒後音高升一個八度
    { t: 32000, reg: 0x5C, value: 0x01 }
  ];
  var r = SFC.dspEventsToSong(ev);
  var n = r.song.tracks[0].notes;
  assert.strictEqual(n.length, 2);
  assert.strictEqual(n[0].n, 69); assert.strictEqual(n[1].n, 81);
  assert.strictEqual(r.stats.pitchChanges, 1);
  assert.strictEqual(r.song.tracks.length, 1);
});

t('sfcExtract 沒有執行器時回報階段與原因（不假裝成功）', function () {
  var r = SFC.sfcExtract(loromImage('X', 0x20), {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stages[0].ok, true);
  assert.strictEqual(r.stages[1].ok, false);
  assert.ok(/主 CPU/.test(r.reason), r.reason);
});

// 真實樣本（唯讀，只讀頭 1MB 內的內部標頭與分類，不寫入、不複製）
t('真實 SFC 樣本（唯讀，最多 3 個）：分類與內部標頭', function () {
  var dir = 'D:\\emu\\Roms\\SFC roms';
  if (!fs.existsSync(dir)) { console.log('  （略過：找不到 ' + dir + '）'); return; }
  var picks = fs.readdirSync(dir).filter(function (f) { return /\.(sfc|smc)$/i.test(f); }).slice(0, 3);
  if (!picks.length) { console.log('  （略過：資料夾裡沒有 .sfc／.smc）'); return; }
  picks.forEach(function (f) {
    var bytes = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    var c = SFC.classifySfc(f, bytes), h = SFC.parseSnesHeader(bytes);
    console.log('  ' + f + '：' + c.label + '；標題「' + h.title + '」；校驗和' + (h.ok ? '吻合' : '不吻合'));
    assert.strictEqual(c.cls, 'rom');
  });
});

var failed = 0;
tests.forEach(function (x) {
  try { x.fn(); console.log('通過：' + x.name); }
  catch (e) { failed++; console.log('失敗：' + x.name + '\n  ' + (e && e.message)); }
});
console.log(failed ? failed + ' 項失敗' : '全部 ' + tests.length + ' 項通過');
process.exit(failed ? 1 : 0);
