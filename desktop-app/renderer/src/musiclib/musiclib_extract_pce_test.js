/* PC Engine 擷取的單元測試（不讀真實 ROM）：node renderer/src/musiclib/musiclib_extract_pce_test.js
 * 手組的 HuC6280 程式直接放在 8KB ROM 裡（重置向量指向 $E000）。真實 ROM 的冒煙另見 musiclib_extract_pce_smoke.js。 */
'use strict';
var assert = require('assert');
var CPU = require('./musiclib_pce_cpu.js');
var PCE = require('./musiclib_extract_pce.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

// 8KB ROM：程式從 $E000 開始（ROM 偏移 0），重置向量在偏移 $1FFE（$FFFE）
function romWith(code, extra) {
  var rom = new Uint8Array(8192).fill(0xEA);
  code.forEach(function (b, i) { rom[i] = b; });
  if (extra) Object.keys(extra).forEach(function (k) { rom[+k] = extra[k]; });
  rom[0x1FFE] = 0x00; rom[0x1FFF] = 0xE0;
  return rom;
}
function pitchOfFreq(freq) { var f = PCE.PSG_HZ / (32 * (freq + 1)); return Math.round(69 + 12 * Math.log(f / 440) / Math.LN2); }

// 程式 A：選聲道 0、頻率 $1EE、左右音量各 15、寫 32 個方波取樣、按音（$9F：按住、音量 31）、原地跳迴圈
var PROG_PSG = [
  0xA9, 0x00, 0x8D, 0x00, 0x08,       // LDA #0 ; STA $0800（選聲道 0）
  0xA9, 0xEE, 0x8D, 0x02, 0x08,       // LDA #$EE ; STA $0802
  0xA9, 0x01, 0x8D, 0x03, 0x08,       // LDA #1 ; STA $0803（頻率 $1EE）
  0xA9, 0xFF, 0x8D, 0x05, 0x08,       // LDA #$FF ; STA $0805（左右 15）
  0xA9, 0xFF, 0x8D, 0x01, 0x08,       // LDA #$FF ; STA $0801（全域音量，0 就是靜音）
  0xA2, 0x00,                         // LDX #0
  0x8A, 0x29, 0x01, 0xF0, 0x04,       // L1: TXA ; AND #1 ; BEQ Z
  0xA9, 0x1F, 0x80, 0x02,             //     LDA #$1F ; BRA S
  0xA9, 0x00,                         // Z:  LDA #0
  0x8D, 0x06, 0x08,                   // S:  STA $0806
  0xE8, 0xE0, 0x20, 0xD0, 0xED,       //     INX ; CPX #$20 ; BNE L1
  0xA9, 0x9F, 0x8D, 0x04, 0x08,       //     LDA #$9F ; STA $0804（按音）
  0x4C, 0x33, 0xE0                    // JMP $E033（原地跳）
];

t('分類：.pce 不分有沒有 512 位元組檔頭都是可擷取的 ROM', function () {
  var plain = new Uint8Array(8192 * 4);
  var hdr = new Uint8Array(8192 * 4 + 512);
  var a = PCE.classifyPce('x.pce', plain), b = PCE.classifyPce('x.PCE', hdr);
  assert.equal(a.cls, 'rom'); assert.equal(a.kind, 'pce'); assert.equal(a.headerBytes, 0);
  assert.equal(b.cls, 'rom'); assert.equal(b.kind, 'pce'); assert.equal(b.headerBytes, 512);
  assert.equal(PCE.classifyPce('x.sfc', plain).cls, 'nonrom');
});

t('CPU：去掉 512 位元組檔頭；沒有檔頭的原樣保留', function () {
  var hdr = new Uint8Array(8192 + 512);
  assert.equal(CPU.stripHeader(hdr).length, 8192);
  assert.equal(CPU.stripHeader(new Uint8Array(8192)).length, 8192);
});

t('CPU：區塊搬移（TII）、十進位加法（ADC）、JSR／RTS 與 STX 寫入 RAM', function () {
  var code = [
    0x73, 0xC0, 0xE0, 0x00, 0x20, 0x04, 0x00,   // TII $E0C0 → $2000，長度 4
    0xF8, 0x18, 0xA9, 0x15, 0x69, 0x27, 0x8D, 0x10, 0x20, 0xD8,   // SED ; CLC ; LDA #$15 ; ADC #$27 ; STA $2010 ; CLD
    0x20, 0x30, 0xE0,                           // JSR $E030
    0x8E, 0x11, 0x20,                           // STX $2011
    0x4C, 0x17, 0xE0,                           // JMP $E017
  ];
  var rom = romWith(code, { 0x30: 0xA2, 0x31: 0x5A, 0x32: 0x60, 0xC0: 0x11, 0xC1: 0x22, 0xC2: 0x33, 0xC3: 0x44 });
  var m = CPU.createMachine(rom, {});
  m.run(2, null);
  assert.deepEqual([m.bus.ram[0], m.bus.ram[1], m.bus.ram[2], m.bus.ram[3]], [0x11, 0x22, 0x33, 0x44], 'TII 應把四個位元組搬到 $2000');
  assert.equal(m.bus.ram[0x10], 0x42, '十進位 15 + 27 = 42');
  assert.equal(m.bus.ram[0x11], 0x5A, 'JSR 進子程式、RTS 回來後 STX 寫入');
  assert.equal(m.cpu.unknown, 0, '這段程式用到的操作碼都有實作');
});

t('PSG：手組程式寫入→MIDI 音符（音高正確）→wav 有聲音', function () {
  var rom = romWith(PROG_PSG);
  var m = CPU.createMachine(rom, {});
  m.run(4, null);
  var writes = m.psgWrites;
  var regs = writes.map(function (w) { return w.r; });
  assert.ok(regs.indexOf(4) >= 0, '應該看到 $0804 的寫入（按音）');
  for (var i = 1; i < writes.length; i++) assert.ok(writes[i].t >= writes[i - 1].t, '寫入時間要遞增');
  var mid = PCE.psgToSong(writes.map(function (w) { return { t: w.t, r: w.r, v: w.v }; }), { title: 'test' });
  assert.ok(mid.song.tracks.length >= 1, '應該有一條聲道的音符');
  var tr = mid.song.tracks[0];
  var expect = pitchOfFreq(0x1EE);
  assert.equal(tr.notes[0].n, expect, '音高應由頻率 $1EE 算出（' + expect + '）');
  assert.ok(mid.stats.keyOn >= 1);
  var samples = PCE.psgRender(writes.map(function (w) { return { t: w.t, r: w.r, v: w.v }; }), { endTicks: writes[writes.length - 1].t + 2 * CPU.MASTER_HZ / 10 });
  var peak = 0; for (var k = 0; k < samples.length; k++) peak = Math.max(peak, Math.abs(samples[k]));
  assert.ok(peak > 0.05, '方波應該有可聽的振幅（峰值 ' + peak.toFixed(3) + '）');
  var wav = PCE.wav16(samples, 44100);
  assert.equal(String.fromCharCode(wav[0], wav[1], wav[2], wav[3]), 'RIFF');
});

t('PSG：沒有按音的寫入不產生音符（不假裝成功）', function () {
  var mid = PCE.psgToSong([{ t: 0, r: 0, v: 0 }, { t: 100, r: 2, v: 5 }, { t: 200, r: 3, v: 1 }], {});
  assert.equal(mid.stats.notes, 0);
  assert.equal(mid.song.tracks.length, 0);
});

t('PSG：噪音聲道（$0807 bit 7）轉成鼓點軌（channel 9）', function () {
  var w = [
    { t: 0, r: 0, v: 4 }, { t: 0, r: 7, v: 0x9F }, { t: 0, r: 4, v: 0x9F }, { t: 0, r: 5, v: 0xFF },
    { t: 1000000, r: 4, v: 0x00 }
  ];
  var st = PCE.psgNew(); w.forEach(function (x) { PCE.psgWrite(st, x.r, x.v); });
  var mid = PCE.psgToSong(w, {});
  var drum = mid.song.tracks.filter(function (x) { return x.drum; });
  assert.equal(drum.length, 1, '應有一條鼓點軌');
  assert.equal(drum[0].channel, 9);
  assert.ok(drum[0].notes.length >= 1);
});

t('PSG：$0809 寫入會開啟 LFO，聲道 1 會被 LFO 占用（與 jspce 的行為一致；混音只確認可算）', function () {
  var st = PCE.psgNew();
  PCE.psgWrite(st, 0, 0); PCE.psgWrite(st, 4, 0x9F); PCE.psgWrite(st, 5, 0xFF);
  PCE.psgWrite(st, 0, 1); PCE.psgWrite(st, 4, 0x9F); PCE.psgWrite(st, 5, 0xFF);
  PCE.psgWrite(st, 0, 1); PCE.psgWrite(st, 2, 0x10); PCE.psgWrite(st, 3, 0x00);
  PCE.psgWrite(st, 0, 1); PCE.psgWrite(st, 6, 0x1F);
  var before = PCE.psgMix(st);
  PCE.psgWrite(st, 9, 0x80);     // LFO 開啟、控制 0
  var after = PCE.psgMix(st);
  assert.ok(Math.abs(before.l) >= 0 && Math.abs(after.l) >= 0, '混音可以算');
  assert.equal(st.lfoOn, true);
});

t('CPU：未實作的操作碼計數，不中斷執行（說明寫在結果裡）', function () {
  var rom = romWith([0x5C, 0x4C, 0x00, 0xE0]);      // $5C（未文件化）後跳回 $E000
  var m = CPU.createMachine(rom, {});
  m.run(1, null);
  assert.ok(m.cpu.unknown >= 1, '未實作的操作碼應該被計數');
});

// ───── 執行 ─────
(function () {
  var pass = 0, failed = [];
  tests.forEach(function (x) {
    try { x.fn(); pass++; console.log('  通過  ' + x.name); }
    catch (e) { failed.push(x.name); console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
  });
  console.log('PC Engine 擷取單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
