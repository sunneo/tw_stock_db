/* NES 擷取的純邏輯單元測試（不執行 ROM）：node renderer/src/musiclib/musiclib_extract_nes_test.js
 * 手組的位元組與事件流都在程式裡；執行 ROM 的測試在 musiclib_extract_nes_run_test.js。最後一段是真實 ROM 資料夾的唯讀檢查（只在目錄存在時才跑，不複製進 repo）。 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var NES = require('./musiclib_extract_nes.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }
function ascii(s) { return Array.from(s).map(function (c) { return c.charCodeAt(0); }); }

// 手組 iNES：16 位元組檔頭（PRG 幾個 16KB、CHR 幾個 8KB、旗標 6、旗標 7）＋PRG＋CHR
function inesFile(prgBanks, chrBanks, f6, f7, extra) {
  var h = [0x4E, 0x45, 0x53, 0x1A, prgBanks, chrBanks, f6 || 0, f7 || 0, 0, 0, 0, 0, 0, 0, 0, 0];
  var prg = new Array(prgBanks * 16384).fill(0xEA);     // NOP 填滿
  var chr = new Array(chrBanks * 8192).fill(0);
  return Uint8Array.from(h.concat(extra || [], prg, chr));
}

t('iNES：手組的 NROM（mapper 0）檔頭解析正確', function () {
  var r = NES.parseInes(inesFile(1, 1, 0x01, 0));
  assert.equal(r.ok, true);
  assert.equal(r.mapper, 0); assert.equal(r.prgBanks, 1); assert.equal(r.chrBanks, 1);
  assert.equal(r.mirroring, 'vertical', '旗標 6 的位元 0 = 垂直鏡像');
  assert.equal(r.prg.length, 16384); assert.equal(r.chr.length, 8192);
});

t('iNES：mapper 高低位元合併、有 trainer 時跳過 512 位元組', function () {
  var r = NES.parseInes(inesFile(2, 0, 0x40 | 0x04, 0x10, new Array(512).fill(0x77)));
  assert.equal(r.ok, true);
  assert.equal(r.mapper, 0x14, '旗標 7 的高四位元 1、旗標 6 的高四位元 4 → mapper 0x14 = 20');
  assert.equal(r.trainer, true);
  assert.equal(r.prg.length, 2 * 16384);
  assert.equal(r.prg[0], 0xEA, 'trainer 後面才是 PRG');
});

t('iNES：錯誤檔頭、被截斷、NES 2.0、PRG 為 0 都明確回報原因', function () {
  var bad = inesFile(1, 0, 0, 0); bad[0] = 0x00;
  assert.equal(NES.parseInes(bad).ok, false); assert.ok(/不是 iNES/.test(NES.parseInes(bad).reason));
  var cut = inesFile(2, 0, 0, 0).subarray(0, 100);
  assert.ok(/截斷/.test(NES.parseInes(cut).reason));
  var nes2 = inesFile(1, 0, 0, 0x08); nes2[8] = 0x01;   // NES 2.0：mapper 高位元在位元組 8
  var p2 = NES.parseInes(nes2);
  assert.equal(p2.ok, true, p2.reason); assert.equal(p2.mapper, 256, 'NES 2.0 的 mapper 多四位元');
  var zero = inesFile(0, 0, 0, 0);
  assert.ok(/PRG 區段為 0/.test(NES.parseInes(zero).reason));
});

t('NSF：packNsf → parseNsf 往返，頭 0x80 位元組欄位與資料都正確', function () {
  var prg = Uint8Array.from([1, 2, 3, 4]);
  var nsf = NES.packNsf({ prg: prg, load: 0x8000, init: 0x8010, play: 0x8020, songs: 1, start: 1, name: 'Test Song', artist: 'Me', copyright: '2026', banks: [0, 0, 0, 0, 0, 0, 0, 0] });
  assert.equal(nsf.length, 0x80 + 4);
  assert.deepEqual(Array.from(nsf.subarray(0, 5)), [0x4E, 0x45, 0x53, 0x4D, 0x1A], 'NESM 簽章');
  var r = NES.parseNsf(nsf);
  assert.equal(r.ok, true);
  assert.equal(r.load, 0x8000); assert.equal(r.init, 0x8010); assert.equal(r.play, 0x8020);
  assert.equal(r.songs, 1); assert.equal(r.name, 'Test Song'); assert.equal(r.artist, 'Me');
  assert.deepEqual(Array.from(r.data), [1, 2, 3, 4]);
  assert.equal(NES.parseNsf(Uint8Array.from([0, 1, 2])).ok, false);
});

// 手組事件流：INIT（畫面前、最外層）寫聲音；NMI 處理器呼叫 PLAY（每畫面寫聲音）
function playTrace(frames, withInit) {
  var ev = [];
  if (withInit) { ev.push({ k: 'call', target: 0x9000 }); ev.push({ k: 'apu', addr: 0x4015, value: 1 }); ev.push({ k: 'ret' }); }
  for (var f = 0; f < frames; f++) {
    ev.push({ k: 'frame', handler: 0xC000 });
    ev.push({ k: 'call', target: 0x9100 });
    ev.push({ k: 'apu', addr: 0x4000, value: 0x3F });
    ev.push({ k: 'apu', addr: 0x4002, value: 0xFE });
    ev.push({ k: 'ret' });
  }
  return ev;
}

t('入口推導：每畫面寫聲音的副程式是 PLAY（0x9100），畫面前的最外層寫聲音呼叫是 INIT（0x9000）', function () {
  var r = NES.inferPlay(playTrace(6, true));
  assert.equal(r.ok, true);
  assert.equal(r.play, 0x9100);
  assert.equal(r.init, 0x9000);
  assert.equal(r.playFrames, 6);
});

t('入口推導：沒有 INIT 時 PLAY 仍可推，INIT 明寫「無法確定」', function () {
  var r = NES.inferPlay(playTrace(5, false));
  assert.equal(r.ok, true); assert.equal(r.play, 0x9100); assert.equal(r.init, null);
  assert.ok(/INIT 無法確定/.test(r.initReason));
});

t('入口推導失敗：沒有畫面中斷、或聲音寫入太少，回報「無法抽出播放入口」＋具體原因', function () {
  var noNmi = NES.inferPlay([{ k: 'call', target: 0x9000 }, { k: 'apu', addr: 0x4015, value: 1 }, { k: 'ret' }]);
  assert.equal(noNmi.ok, false); assert.ok(/沒有畫面中斷/.test(noNmi.reason));
  var few = NES.inferPlay(playTrace(2, true));
  assert.equal(few.ok, false);
  assert.ok(/無法抽出播放入口/.test(few.reason), few.reason);
  assert.ok(/最多 2 個畫面/.test(few.reason), '原因要說明實際的畫面數：' + few.reason);
});

t('APU → MIDI 退路：脈衝 A4（440 Hz 附近）→ 音符 69；三角波 A3 → 57；雜訊 → 鼓軌 42', function () {
  // 脈衝 1：週期 254 → 約 438.9 Hz → 69；從第 0 畫面開到第 30 畫面關
  var ev = [{ k: 'apu', addr: 0x4015, value: 0x01 }, { k: 'apu', addr: 0x4000, value: 0x3F }, { k: 'apu', addr: 0x4002, value: 254 }, { k: 'apu', addr: 0x4003, value: 0 }];
  for (var i = 0; i < 30; i++) ev.push({ k: 'frame' });
  ev.push({ k: 'apu', addr: 0x4015, value: 0x00 });
  // 三角波：週期 254 → 約 219.4 Hz → 57（A3）；第 30 到 60 畫面
  ev.push({ k: 'apu', addr: 0x4015, value: 0x04 }, { k: 'apu', addr: 0x400A, value: 254 }, { k: 'apu', addr: 0x400B, value: 0 });
  for (var j = 0; j < 30; j++) ev.push({ k: 'frame' });
  ev.push({ k: 'apu', addr: 0x4015, value: 0x00 });
  // 雜訊：短模式（$400E bit7 = 0）→ 踩鑔 42
  ev.push({ k: 'apu', addr: 0x4015, value: 0x08 }, { k: 'apu', addr: 0x400E, value: 0x00 }, { k: 'apu', addr: 0x400F, value: 0 });
  ev.push({ k: 'frame' }, { k: 'apu', addr: 0x4015, value: 0x00 });
  ev.push({ k: 'apu', addr: 0x4010, value: 0x0F });                      // DPCM：只計數
  var out = NES.apuTraceToSong(ev, {});
  var p1 = out.song.tracks.filter(function (x) { return x.name === '脈衝 1'; })[0];
  var tri = out.song.tracks.filter(function (x) { return x.name === '三角波'; })[0];
  var drum = out.song.tracks.filter(function (x) { return x.drum; })[0];
  assert.equal(p1.notes[0].n, 69, '脈衝 A4');
  assert.equal(tri.notes[0].n, 57, '三角波 A3');
  assert.equal(drum.notes[0].n, 42, '雜訊短模式 → 踩鑔');
  assert.equal(out.stats.dpcmWrites, 1, 'DPCM 只計數、不轉');
  // 脈衝音長：30 畫面 ÷ 60.0988 秒 × 960 tick/秒 ≈ 479
  assert.ok(Math.abs(p1.notes[0].d - Math.round(30 / NES.FRAME_NTSC * 960)) <= 1, '音長約 30 畫面：' + p1.notes[0].d);
});

t('APU → MIDI：週期小於 8 的脈衝被硬體靜音，不產生音符', function () {
  var ev = [{ k: 'apu', addr: 0x4015, value: 1 }, { k: 'apu', addr: 0x4002, value: 4 }, { k: 'apu', addr: 0x4003, value: 0 }, { k: 'frame' }, { k: 'apu', addr: 0x4015, value: 0 }];
  var out = NES.apuTraceToSong(ev, {});
  assert.equal(out.song.tracks.length, 0);
});

t('真實 ROM 資料夾（FC roms，若存在）：唯讀；檔頭解析與分類（執行與普查在 run_test／census）', function () {
  var dir = 'D:/emu/Roms/FC roms';
  if (!fs.existsSync(dir)) { console.log('    （略過：找不到 ' + dir + '）'); return; }
  var files = [];
  (function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) { var f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f); }); })(dir);
  var roms = 0, ok = 0, mappers = {};
  files.forEach(function (f) {
    var bytes = fs.readFileSync(f);
    if (NES.classifyFile(path.basename(f), bytes).cls !== 'rom') return;
    roms++;
    var r = NES.parseInes(bytes);
    if (r.ok) { ok++; mappers[r.mapper] = (mappers[r.mapper] || 0) + 1; }
    else console.log('    檔頭失敗：' + path.basename(f) + '：' + r.reason);
  });
  console.log('    iNES ROM ' + roms + ' 個，檔頭解析成功 ' + ok + '；mapper 分布：' + Object.keys(mappers).sort(function (a, b) { return a - b; }).map(function (k) { return 'mapper ' + k + ' × ' + mappers[k]; }).join('、'));
  assert.ok(files.length > 0, '資料夾裡應該有檔案');
});

// ───── 執行 ─────
(function () {
  var pass = 0, failed = [];
  tests.forEach(function (x) {
    try { x.fn(); pass++; console.log('  通過  ' + x.name); }
    catch (e) { failed.push(x.name); console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
  });
  console.log('musiclib_extract_nes 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
