/* NES 執行器測試（jsnes 真的執行手組的 ROM）：node renderer/src/musiclib/musiclib_extract_nes_run_test.js
 * 手組 ROM 的位址：程式在 $C000 起（PRG 最後一個銀行），畫面中斷向量 $C100，INIT $C080，PLAY $C120。
 * 真實 FC 資料夾的整批普查請用 musiclib_extract_nes_census.js（會跑很久，不放在單元測試裡）。 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var NESX = require('./musiclib_extract_nes.js');
var NES = require('../../vendor/jsnes/jsnes.umd.cjs').NES;
require('./musiclib_nes_mappers.js').install(NES);

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

// 組 iNES：prgBanks（16KB）、mapper、要放在 PRG 內的程式（相對於 PRG 起點的偏移）、填充值（每個銀行）
function makeRom(o) {
  var prgSize = o.prgBanks * 16384, prg = new Uint8Array(prgSize);
  for (var b = 0; b < o.prgBanks; b++) prg.fill(o.fill && b < o.prgBanks - 1 ? o.fill(b) : 0xEA, b * 16384, (b + 1) * 16384);
  (o.code || []).forEach(function (c) { prg.set(c.bytes, c.off); });
  // 向量在最後一個銀行的結尾（CPU $FFFA–$FFFF）
  var vec = prgSize - 6;
  prg.set([0x00, 0xC1, 0x00, 0xC0, 0x00, 0xC0], vec);
  var f6 = ((o.mapper || 0) & 0x0F) << 4, f7 = (o.mapper || 0) & 0xF0;
  var header = [0x4E, 0x45, 0x53, 0x1A, o.prgBanks, 1, f6, f7, 0, 0, 0, 0, 0, 0, 0, 0];
  var chr = new Uint8Array(8192);
  var out = new Uint8Array(16 + prgSize + 8192);
  out.set(header, 0); out.set(prg, 16); out.set(chr, 16 + prgSize);
  return out;
}
// 手組 NROM（2 個銀行，32KB）：重置→INIT→開畫面中斷→無限迴圈；NMI→PLAY；INIT 與 PLAY 寫脈衝 1
var INIT_CODE = [0xA9, 0x01, 0x8D, 0x15, 0x40, 0x60];
var PLAY_CODE = [0xA9, 0x3F, 0x8D, 0x00, 0x40, 0xA9, 0xFE, 0x8D, 0x02, 0x40, 0xA9, 0x00, 0x8D, 0x03, 0x40, 0x60];
function nromPlayer() {
  return makeRom({ prgBanks: 1, code: [
    { off: 0x000, bytes: [0xA9, 0x80, 0x8D, 0x00, 0x20, 0x20, 0x80, 0xC0, 0x4C, 0x08, 0xC0] },
    { off: 0x080, bytes: INIT_CODE },
    { off: 0x100, bytes: [0x20, 0x20, 0xC1, 0x40] },
    { off: 0x120, bytes: PLAY_CODE }
  ] });
}

function loadNes() { return NES; }

t('執行：jsnes 真的跑手組 ROM，抓到畫面中斷、INIT 與 PLAY 的呼叫與 APU 寫入', async function () {
  var tr = await NESX.traceRom(nromPlayer(), loadNes(), { maxFrames: 60 });
  assert.equal(tr.crashed, null, '不應崩潰：' + tr.crashed);
  assert.equal(tr.frames, 60);
  assert.equal(tr.nmiVector, 0xC100);
  assert.ok(tr.events.some(function (e) { return e.k === 'frame' && e.handler === 0xC100; }), '要有畫面中斷');
  assert.ok(tr.events.some(function (e) { return e.k === 'call' && e.target === 0xC080; }), '要有 INIT 呼叫');
  assert.ok(tr.events.some(function (e) { return e.k === 'call' && e.target === 0xC120; }), '要有 PLAY 呼叫');
  assert.ok(tr.events.some(function (e) { return e.k === 'apu' && e.addr === 0x4015 && e.value === 1; }), '要有 INIT 的 $4015 寫入');
  assert.equal(tr.events.filter(function (e) { return e.k === 'vblank'; }).length, 60, '每個畫面都有結束紀錄');
  assert.ok(tr.audio.length > 0, '要錄到音訊');
});

t('推導入口：PLAY=$C120（畫面中斷呼叫的副程式）、INIT=$C080', async function () {
  var tr = await NESX.traceRom(nromPlayer(), loadNes(), { maxFrames: 60 });
  var inf = NESX.inferPlay(tr.events, {});
  assert.equal(inf.ok, true, inf.reason);
  assert.equal(inf.play, 0xC120);
  assert.equal(inf.init, 0xC080);
});

t('抽出：NSF 標準格式（位址、資料、NESM）與退路 MIDI（脈衝 1 音符 69）、wav 都有', async function () {
  var rom = nromPlayer();
  var r = await NESX.extractNsf(rom, loadNes(), { maxFrames: 60, name: 'Test' });
  assert.equal(r.ok, true, r.nsfReason || r.reason);
  assert.equal(r.mode, 'nsf+midi');
  assert.equal(r.play, 0xC120); assert.equal(r.init, 0xC080);
  var p = NESX.parseNsf(r.nsf);
  assert.equal(p.ok, true); assert.equal(p.load, 0xC000); assert.equal(p.init, 0xC080); assert.equal(p.play, 0xC120);
  assert.deepEqual(Array.from(p.data.subarray(0, 16)), Array.from(rom.subarray(16, 32)), 'NSF 資料等於 PRG 前 16 位元組');
  var p1 = r.song.tracks.filter(function (x) { return x.name === '脈衝 1'; })[0];
  assert.ok(p1, '要有脈衝 1 軌'); assert.equal(p1.notes[0].n, 69);
  assert.equal(Buffer.from(r.wav.subarray(0, 4)).toString('ascii'), 'RIFF');
  assert.equal(r.samples.length > 0, true);
});

t('主迴圈版：沒有畫面中斷、副程式直接在主迴圈呼叫，仍能推到入口並產生 NSF', async function () {
  // 重置：JSR INIT；迴圈：JSR PLAY；JMP 迴圈。沒有開畫面中斷，所以畫面只靠 PPU 結束判斷
  var rom = makeRom({ prgBanks: 1, code: [
    { off: 0x000, bytes: [0x20, 0x80, 0xC0, 0x20, 0x20, 0xC1, 0x4C, 0x03, 0xC0] },
    { off: 0x080, bytes: INIT_CODE },
    { off: 0x120, bytes: PLAY_CODE }
  ] });
  var r = await NESX.extractNsf(rom, loadNes(), { maxFrames: 60 });
  assert.equal(r.play, 0xC120, r.nsfReason);
  assert.equal(r.init, 0xC080, r.nsfReason);
  assert.equal(r.ok, true, r.nsfReason);
});

t('內聯版：聲音暫存器寫在主迴圈裡（沒有副程式）→ NSF 沒有入口，但退路 MIDI 照樣產生', async function () {
  var rom = makeRom({ prgBanks: 1, code: [
    { off: 0x000, bytes: [0xA9, 0x01, 0x8D, 0x15, 0x40, 0xA9, 0xFE, 0x8D, 0x02, 0x40, 0xA9, 0x00, 0x8D, 0x03, 0x40, 0x4C, 0x05, 0xC0] }
  ] });
  var r = await NESX.extractNsf(rom, loadNes(), { maxFrames: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.nsfStage, '入口');
  assert.ok(/無法抽出播放入口/.test(r.nsfReason), r.nsfReason);
  assert.equal(r.mode, 'midi', '沒有 NSF 也要有退路 MIDI');
  assert.ok(r.song && r.song.tracks.length > 0);
});

t('沒有任何聲音寫入：三種輸出都說明原因（不是只回「失敗」）', async function () {
  var rom = makeRom({ prgBanks: 1, code: [{ off: 0x000, bytes: [0x4C, 0x00, 0xC0] }] });
  var r = await NESX.extractNsf(rom, loadNes(), { maxFrames: 30 });
  assert.equal(r.mode, 'none');
  assert.equal(r.ok, false);
  assert.ok(r.midiReason && /完全沒有聲音/.test(r.midiReason), r.midiReason);
  assert.ok(r.nsfReason, '要有 NSF 失敗原因');
});

t('mapper 1（MMC1）：INIT 切換 $8000 銀行後，NSF 銀行初值指到切換後的頁，資料逐頁正確', async function () {
  // 4 個 16KB 銀行，銀行 b 填 0x10+b；重置時 $C000 固定在最後一個銀行（銀行 3）
  var code3 = [
    { off: 0x000, bytes: [0xA9, 0x01, 0x8D, 0x00, 0xE0, 0x4A, 0x8D, 0x00, 0xE0, 0x4A, 0x8D, 0x00, 0xE0, 0x4A, 0x8D, 0x00, 0xE0, 0x4A, 0x8D, 0x00, 0xE0] },
    { off: 0x016, bytes: [0xA9, 0x80, 0x8D, 0x00, 0x20, 0x20, 0x80, 0xC0, 0x4C, 0x1E, 0xC0] },
    { off: 0x080, bytes: INIT_CODE },
    { off: 0x100, bytes: [0x20, 0x20, 0xC1, 0x40] },
    { off: 0x120, bytes: PLAY_CODE }
  ];
  var rom = makeRom({ prgBanks: 4, mapper: 1, fill: function (b) { return 0x10 + b; }, code: code3.map(function (c) { return { off: 3 * 16384 + c.off, bytes: c.bytes }; }) });
  var r = await NESX.extractNsf(rom, loadNes(), { maxFrames: 90 });
  assert.equal(r.mapper, 1);
  assert.equal(r.ok, true, r.nsfStage + '：' + r.nsfReason);
  assert.ok(r.bankInit, '要有銀行初值');
  var p = NESX.parseNsf(r.nsf);
  assert.deepEqual(p.banks, r.bankInit, 'NSF 的 8 個銀行位元組等於初值');
  assert.equal(r.nsf.length - 0x80 > 0 && (r.nsf.length - 0x80) % 4096, 0, '資料是 4KB 的整數倍');
  for (var s = 0; s < 4; s++) {
    var page = p.data.subarray(r.bankInit[s] * 4096, r.bankInit[s] * 4096 + 4096);
    assert.ok(page.every(function (x) { return x === 0x11; }), '銀行 ' + s + '（$8000 那一段）應為切換後的銀行 1（0x11）');
  }
  var bank3Page0 = rom.subarray(16 + 3 * 16384, 16 + 3 * 16384 + 4096);
  var fixedPage = p.data.subarray(r.bankInit[4] * 4096, r.bankInit[4] * 4096 + 4096);
  assert.deepEqual(Array.from(fixedPage), Array.from(bank3Page0), '$C000 那一段是固定的最後銀行');
  assert.equal(r.play, 0xC120); assert.equal(r.init, 0xC080);
});

t('銀行布局：找不到的頁若也沒擷取到，明確回報是哪一個銀行', function () {
  var rom = { prg: new Uint8Array(8192).fill(1) };
  var fake = { slotHashes: [new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8])], pages: new Map() };
  var lay = NESX.bankLayout(rom, fake, 0);
  assert.equal(lay.ok, false);
  assert.ok(/銀行 0/.test(lay.reason), lay.reason);
});

t('NSF 重播：把抽出的 NSF（16KB、$C000）放進 NROM 包裝，驅動程式照 NSF 慣例呼叫 INIT 與 PLAY，真的寫出同樣的音高', async function () {
  var r = await NESX.extractNsf(nromPlayer(), loadNes(), { maxFrames: 60 });
  assert.equal(r.nsf && r.nsf.length > 0, true, r.nsfReason);
  var p = NESX.parseNsf(r.nsf);
  // 包裝：16KB 驅動程式（$8000）＋16KB NSF 資料（$C000）。驅動程式：LDA #0、LDX #0、JSR INIT、開畫面中斷；中斷裡 JSR PLAY
  var init = p.init, play = p.play;
  var drv = [0xA9, 0x00, 0xA2, 0x00, 0x20, init & 0xFF, init >> 8, 0xA9, 0x80, 0x8D, 0x00, 0x20, 0x4C, 0x0E, 0x80];
  var nmi = [0x20, play & 0xFF, play >> 8, 0x40];
  var prg = new Uint8Array(32768);
  prg.set(drv, 0); prg.set(nmi, 0x100);
  prg.set(p.data.subarray(0, 16384), 16384);
  prg.set([0x00, 0x81, 0x00, 0x80, 0x00, 0x80], 32768 - 6);
  var rom = new Uint8Array(16 + 32768 + 8192);
  rom.set([0x4E, 0x45, 0x53, 0x1A, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0); rom.set(prg, 16);
  var tr = await NESX.traceRom(rom, loadNes(), { maxFrames: 60 });
  assert.equal(tr.crashed, null, tr.crashed);
  var mid = NESX.apuTraceToSong(NESX.trimToSound(tr.events), {});
  var p1 = mid.song.tracks.filter(function (x) { return x.name === '脈衝 1'; })[0];
  assert.ok(p1 && p1.notes.length > 0, 'NSF 重播要有脈衝 1 的音符');
  assert.equal(p1.notes[0].n, 69, '重播的音高與原 ROM 相同');
});

t('頂層 INIT 存根：音效初始化直接寫在重置程式碼裡（沒有副程式）→ 產生重放存根；重播後寫出同樣的聲音暫存器', async function () {
  // 16KB NROM，填 $FF（存根的填充空間）。重置：頂層寫 $4015=1（沒有 JSR）；迴圈；NMI 呼叫 PLAY。
  var prg = new Uint8Array(16384).fill(0xFF);
  prg.set([0xA9, 0x01, 0x8D, 0x15, 0x40, 0xA9, 0x80, 0x8D, 0x00, 0x20, 0x4C, 0x0A, 0xC0], 0);   // $C000：LDA #1 / STA $4015 / 開畫面中斷 / JMP 迴圈
  prg.set([0x20, 0x20, 0xC1, 0x40], 0x100);                              // NMI：JSR PLAY / RTI
  prg.set(PLAY_CODE, 0x120);                                             // PLAY 在 $C120
  prg.set([0x00, 0xC1, 0x00, 0xC0, 0x00, 0xC0], 16384 - 6);
  var rom = new Uint8Array(16 + 16384 + 8192);
  rom.set([0x4E, 0x45, 0x53, 0x1A, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0); rom.set(prg, 16);
  var r = await NESX.extractNsf(rom, loadNes(), { maxFrames: 60, name: 'topinit' });
  assert.equal(r.ok, true, r.nsfReason);
  assert.equal(r.initMode, 'APU 重放存根');
  var p = NESX.parseNsf(r.nsf);
  var at = p.init - 0xC000;
  assert.deepEqual(Array.from(p.data.subarray(at, at + 6)), [0xA9, 0x01, 0x8D, 0x15, 0x40, 0x60], '存根內容：LDA #1 / STA $4015 / RTS');
  // 重播：驅動程式以 NSF 慣例 JSR INIT（存根），再由中斷呼叫 PLAY
  var drv = new Uint8Array(32768);
  drv.set([0xA2, 0x00, 0x20, p.init & 0xFF, p.init >> 8, 0xA9, 0x80, 0x8D, 0x00, 0x20, 0x4C, 0x0A, 0x80], 0);
  drv.set([0x20, p.play & 0xFF, p.play >> 8, 0x40], 0x100);
  drv.set(p.data.subarray(0, 16384), 16384);
  drv.set([0x00, 0x81, 0x00, 0x80, 0x00, 0x80], 32768 - 6);
  var wrap = new Uint8Array(16 + 32768 + 8192);
  wrap.set([0x4E, 0x45, 0x53, 0x1A, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0); wrap.set(drv, 16);
  var tr = await NESX.traceRom(wrap, loadNes(), { maxFrames: 60 });
  assert.equal(tr.crashed, null, tr.crashed);
  assert.ok(tr.events.some(function (e) { return e.k === 'apu' && e.addr === 0x4015 && e.value === 1; }), '重播要寫出 $4015=1');
  var mid = NESX.apuTraceToSong(NESX.trimToSound(tr.events), {});
  var p1 = mid.song.tracks.filter(function (x) { return x.name === '脈衝 1'; })[0];
  assert.ok(p1 && p1.notes.length > 0, '重播要有脈衝 1 的音符（PLAY 在存根之後運作）');
});

t('wav：16 位元單聲道、長度與夾限（超出 ±1 的值夾到邊界）', function () {
  var w = NESX.wav16(Float32Array.from([0, 1, -1, 2]), 44100);
  assert.equal(Buffer.from(w.subarray(0, 4)).toString('ascii'), 'RIFF');
  assert.equal(Buffer.from(w.subarray(8, 12)).toString('ascii'), 'WAVE');
  assert.equal(w.length, 44 + 8);
  var dv = new DataView(w.buffer, w.byteOffset);
  assert.equal(dv.getInt16(44, true), 0);
  assert.equal(dv.getInt16(46, true), 32767);
  assert.equal(dv.getInt16(48, true), -32768);
  assert.equal(dv.getInt16(50, true), 32767, '超過 1 的夾到 32767');
  assert.equal(dv.getUint32(24, true), 44100);
});

t('分類：iNES／NSF／FDS／UNIF／zip／7z／rar／存檔（sta、sav、srm）／其他', function () {
  var cases = [
    ['a.nes', [0x4E, 0x45, 0x53, 0x1A, 1], 'rom'],
    ['song.nsf', [0x4E, 0x45, 0x53, 0x4D, 0x1A, 1], 'nsf'],
    ['disk.fds', [0x46, 0x44, 0x53, 0x1A, 0], 'fds'],
    ['disk2.fds', [1, 0x2A, 0x4E, 0x49, 0x4E, 0x54, 0x45, 0x4E, 0x44, 0x4F, 0x2D, 0x48, 0x56, 0x43, 0x2A], 'fds'],
    ['x.unf', [0x55, 0x4E, 0x49, 0x46, 0, 0], 'unif'],
    ['game.zip', [0x50, 0x4B, 0x03, 0x04, 0, 0], 'zip'],
    ['game.7z', [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C], '7z'],
    ['game.rar', [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07], 'rar'],
    ['zelda.sta', [1, 2, 3, 4], 'save'],
    ['zelda.sav', [], 'save'],
    ['zelda.srm', [], 'save'],
    ['weird.nes', [1, 2, 3, 4], 'other']
  ];
  cases.forEach(function (c) {
    var r = NESX.classifyFile(c[0], Uint8Array.from(c[1]));
    assert.ok(r.kind === c[2] || (c[2] === 'rom' && r.cls === 'rom'), c[0] + ' 應分類為 ' + c[2] + '，實際 ' + r.kind);
    if (c[2] === 'rom') assert.equal(r.cls, 'rom');
    else { assert.equal(r.cls, 'nonrom'); assert.ok(/非 ROM|不是卡帶|不需擷取|核心不支援/.test(r.label), r.label); }
  });
});

t('真實 FC 資料夾（若存在）：只分類與讀檔頭，不執行（整批執行請跑 census）', function () {
  var dir = 'D:/emu/Roms/FC roms';
  if (!fs.existsSync(dir)) { console.log('    （略過：找不到 ' + dir + '）'); return; }
  var files = [];
  (function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) { var f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f); }); })(dir);
  var kinds = {};
  files.forEach(function (f) {
    var head = fs.readFileSync(f).subarray(0, 16);
    var c = NESX.classifyFile(path.basename(f), head);
    kinds[c.kind] = (kinds[c.kind] || 0) + 1;
  });
  console.log('    樣本：共 ' + files.length + ' 個檔案；' + Object.keys(kinds).sort().map(function (k) { return k + ' ' + kinds[k]; }).join('、'));
  assert.ok(files.length > 0);
});

// ───── 執行（依序 await）─────
(async function () {
  var pass = 0, failed = [];
  for (var i = 0; i < tests.length; i++) {
    var x = tests[i];
    try { await x.fn(); pass++; console.log('  通過  ' + x.name); }
    catch (e) { failed.push(x.name); console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
  }
  console.log('musiclib_extract_nes 執行器測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
