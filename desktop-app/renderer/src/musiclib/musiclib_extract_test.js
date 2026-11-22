/* RIX 與 SWF 擷取器的單元測試：node renderer/src/musiclib/musiclib_extract_test.js
 * 測試用的位元組全部是程式手組的（不含任何遊戲檔）。最後一段是真實 RIX 檔的唯讀檢查，只在檔案存在時才跑，不複製進 repo。 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var RIX = require('./musiclib_extract_rix.js');
var SWF = require('./musiclib_extract_swf.js');
var LZ = require('../algo/matrix_lzma_core.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }
function le16(v) { return [v & 255, (v >> 8) & 255]; }
function le32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
function be32(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }
function ascii(s) { return Array.from(Buffer.from(s, 'latin1')); }

// ───── RIX 手組 ─────
// 檔頭 20 位元組＋樂器表（insOffset=0x14，一個全零樂器 0x40 位元組）＋樂譜
function rixFile(words, opts) {
  opts = opts || {};
  var ins = opts.ins || new Array(0x40).fill(0);
  var head = [0xAA, 0x55, opts.mode || 0, 0, 0, 0, 0, 0].concat(le16(0x14), [0, 0], le16(0), [0, 0, 0, 0, 0, 0]);
  var musBlock = 0x14 + ins.length;
  head[0x0C] = musBlock & 255; head[0x0D] = (musBlock >> 8) & 255;
  var body = [].concat(words);
  return new Uint8Array(head.concat(ins, body));
}
// 一個字：資料位元組在前、控制位元組在後
function word(data, ctrl) { return [data & 255, ctrl & 255]; }
function delayW(v) { return word(v & 255, (v >> 8) & 255); }
var STOP = word(0, 0x80);

t('RIX：手組一個音（ch0 選樂器 0，C4 開始、一秒後關）→ 一軌一音，時間與長度正確', function () {
  var file = rixFile([].concat(word(0, 0x90), delayW(980), word(60, 0xC0), delayW(980), word(0, 0xC0), STOP));
  var r = RIX.parseRix(file);
  assert.equal(r.ok, true);
  assert.equal(r.stats.stopped, true, '有結束字');
  assert.equal(r.song.tracks.length, 1);
  var n = r.song.tracks[0].notes;
  assert.equal(n.length, 1);
  assert.equal(n[0].n, 60, 'C4');
  assert.equal(n[0].t, Math.round(980 * RIX.TICKS_PER_BAND), '音符前有一個延遲單位（980），起點換算成 tick');
  assert.equal(n[0].d, Math.round(980 * RIX.TICKS_PER_BAND), '音長也是一個延遲單位');
  assert.equal(r.stats.seconds, 2, '曲長 = 兩個延遲單位（各 1 秒）');
});

t('RIX：同頻道連續兩個音，第二個音會先關掉第一個音（音符不重疊）', function () {
  var file = rixFile([].concat(word(0, 0x90), word(60, 0xC0), delayW(490), word(64, 0xC0), delayW(490), word(0, 0xC0), STOP));
  var n = RIX.parseRix(file).song.tracks[0].notes;
  assert.deepEqual(n.map(function (x) { return x.n; }), [60, 64]);
  assert.ok(n[0].t + n[0].d <= n[1].t, '第一個音在第二個音開始前結束');
});

t('RIX：關音（資料為 0）與曲尾未關的音都會結束，不會留下懸空音', function () {
  var file = rixFile([].concat(word(0, 0x90), word(69, 0xC0), delayW(980), STOP));
  var n = RIX.parseRix(file).song.tracks[0].notes;
  assert.equal(n.length, 1, '曲尾未關的音在結束時補關');
  assert.ok(n[0].d > 0);
});

t('RIX：打擊模式（soundMode=1）的 6..8 頻道併成一條打擊軌（GM 鼓音）', function () {
  var file = rixFile([].concat(word(0, 0x90 | 6), word(40, 0xC0 | 6), delayW(490), word(0, 0xC0 | 6), STOP), { mode: 1 });
  var r = RIX.parseRix(file);
  var drum = r.song.tracks.filter(function (tk) { return tk.drum; });
  assert.equal(drum.length, 1);
  assert.equal(drum[0].notes[0].n, 36, '頻道 6 是底鼓 36');
});

t('RIX：檔案太短、簽章錯、樂譜位置超出、沒有音符都明確丟錯（附階段）', function () {
  assert.throws(function () { RIX.parseRix(new Uint8Array([0x55, 0xAA])); }, /解析失敗（檔頭）：檔案只有 2/);
  var bad = rixFile([STOP]); bad[0] = 0; assert.throws(function () { RIX.parseRix(bad); }, /0x55AA/);
  var far = rixFile([STOP]); far[0x0C] = 0xFF; far[0x0D] = 0xFF; assert.throws(function () { RIX.parseRix(far); }, /超出檔案長度/);
  assert.throws(function () { RIX.parseRix(rixFile([].concat(word(0, 0x90), STOP))); }, /沒有任何音符/);
});

// ───── SWF 手組 ─────
function swfFile(tagBytes, opts) {
  opts = opts || {};
  var sig = opts.sig || 'FWS';
  var rect = [0x00];                         // RECT：位元數 0（1 位元組）
  var rest = rect.concat(le16(0x0C00), le16(1), tagBytes);
  var total = 8 + rest.length;
  return Uint8Array.from(ascii(sig).concat([10], le32(total), rest));
}
function tag(code, data) {
  if (data.length < 63) return le16((code << 6) | data.length).concat(data);
  return le16((code << 6) | 63).concat(le32(data.length), data);
}
function defineSoundPCM16(id, samples, rateBits, stereo) {
  var fl = (3 << 4) | (rateBits << 2) | (1 << 1) | (stereo ? 1 : 0);
  var data = le16(id).concat([fl], le32(samples.length), Array.from(new Uint8Array(new Int16Array(samples).buffer)));
  return tag(14, data);
}

t('SWF：DefineSound 16 位元 PCM 單聲道 44.1 kHz → wav，取樣數與長度正確', async function () {
  var s = [0, 1000, -1000, 32767];
  var file = swfFile(defineSound16(s));
  function defineSound16(x) { return defineSoundPCM16(7, x, 3, false); }
  var r = await SWF.parseSwf(file, {});
  assert.equal(r.sounds.length, 1);
  var snd = r.sounds[0];
  assert.equal(snd.kind, 'wav');
  assert.equal(snd.sampleRate, 44100);
  assert.equal(snd.channels, 1);
  assert.equal(snd.sampleCount, 4);
  assert.ok(Math.abs(snd.durationSec - 4 / 44100) < 1e-12);
  assert.equal(String.fromCharCode(snd.bytes[0], snd.bytes[1], snd.bytes[2], snd.bytes[3]), 'RIFF');
  var dv = new DataView(snd.bytes.buffer, snd.bytes.byteOffset);
  assert.equal(dv.getInt16(44 + 2, true), 1000, '第二個取樣值');
  assert.equal(dv.getInt16(44 + 6, true), 32767, '最後一個取樣值');
});

t('SWF：DefineSound MP3 → 原樣的 MP3 幀（去掉 SeekSamples）', async function () {
  var frames = [0xFF, 0xFB, 0x90, 0x00, 1, 2, 3];
  var data = le16(5).concat([0, 0], frames);          // SeekSamples 2 位元組
  var fl = (2 << 4) | (3 << 2) | (1 << 1) | 0;
  var file = swfFile(tag(14, le16(5).concat([fl], le32(1152), data.slice(2))));
  var r = await SWF.parseSwf(file, {});
  assert.equal(r.sounds[0].kind, 'mp3');
  assert.deepEqual(Array.from(r.sounds[0].bytes), frames, 'MP3 幀原樣保留');
});

t('SWF：SoundStreamHead2（MP3）＋多個 SoundStreamBlock → 串接成一個 MP3 來源', async function () {
  var head = tag(45, [(0) | (3 << 2) | (1 << 1), (2 << 4) | (3 << 2) | (1 << 1), 0, 0]);
  var b1 = [0xFF, 0xFB, 1], b2 = [0xFF, 0xFB, 2, 3];
  var blk = function (fr) { return tag(19, le16(1152).concat([0, 0], fr)); };
  var file = swfFile([].concat(head, blk(b1), blk(b2)));
  var r = await SWF.parseSwf(file, {});
  assert.equal(r.sounds.length, 1);
  assert.equal(r.sounds[0].source, 'stream');
  assert.deepEqual(Array.from(r.sounds[0].bytes), b1.concat(b2));
});

t('SWF：ADPCM（SWF 變體）手算驗證：2 位元、預測值從 0、步進索引 0，連續 8 個 0 碼 → 3,6,9,…', function () {
  // 位元：nb 標頭 "00"（2 位元）、預測值 16 位元 0、步進索引 6 位元 0、然後 8 個 2 位元的 0 碼
  var bits = '00' + '0000000000000000' + '000000' + '00'.repeat(8);
  var bytes = [];
  for (var i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8).padEnd(8, '0'), 2));
  var pcm = SWF.decodeAdpcmSwf(Uint8Array.from(bytes), 1);
  assert.deepEqual(Array.from(pcm), [0, 3, 6, 9, 12, 15, 18, 21, 24]);
});

t('SWF：DefineBinaryData 內嵌 MIDI（MThd）→ 抽出 MIDI', async function () {
  var mid = ascii('MThd').concat([0, 0, 0, 6, 0, 0, 0, 1, 0, 96]);
  var file = swfFile(tag(87, le16(9).concat([0, 0, 0, 0], mid)));
  var r = await SWF.parseSwf(file, {});
  assert.equal(r.sounds.length, 1);
  assert.equal(r.sounds[0].kind, 'mid');
  assert.deepEqual(Array.from(r.sounds[0].bytes.subarray(0, 4)), ascii('MThd'));
});

t('SWF：不支援的格式（Nellymoser）記到 skipped 並附原因，不會整個失敗', async function () {
  var fl = (6 << 4) | (3 << 2) | (1 << 1);
  var file = swfFile(tag(14, le16(3).concat([fl], le32(10), [1, 2, 3])));
  var r = await SWF.parseSwf(file, {});
  assert.equal(r.sounds.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.ok(/不支援的音訊格式 6/.test(r.skipped[0].reason));
});

t('SWF：CWS（zlib 壓縮）與 ZWS（LZMA 壓縮）解壓後結果相同', async function () {
  var file = swfFile(defineSoundPCM16(4, [5, -5, 100], 3, false));
  var inflate = async function (u8) { return new Uint8Array(zlib.inflateSync(Buffer.from(u8))); };
  // CWS：簽章 CWS、頭 8 位元組不壓縮，之後是 zlib
  var body = Buffer.from(file.subarray(8));
  var cws = Uint8Array.from(ascii('CWS').concat([10], le32(file.length), Array.from(zlib.deflateSync(body))));
  var r1 = await SWF.parseSwf(cws, { inflate: inflate });
  assert.equal(r1.sounds[0].sampleCount, 3);
  // ZWS：LZMA（props 93）；頭 8 位元組不壓縮，接著 4 位元組壓縮長度、5 位元組 props、LZMA 資料
  var enc = LZ.lzmaEncode(body);
  var props = enc.subarray(0, 5), data = enc.subarray(13);
  var zws = Uint8Array.from(ascii('ZWS').concat([10], le32(file.length), le32(data.length), Array.from(props), Array.from(data)));
  var r2 = await SWF.parseSwf(zws, { lzmaDecode: function (u8) { return LZ.lzmaDecode(u8); } });
  assert.equal(r2.sounds[0].sampleCount, 3);
  assert.deepEqual(Array.from(r2.sounds[0].bytes), Array.from(r1.sounds[0].bytes), 'CWS 與 ZWS 解出來的 wav 相同');
});

t('SWF：簽章錯誤要明確丟錯', async function () {
  await assert.rejects(SWF.parseSwf(Uint8Array.from(ascii('XYZ' + '\u0000'.repeat(20))), {}), /不是 SWF 檔/);
});

// ───── 真實 RIX 檔（唯讀、只在檔案存在時才跑；不複製進 repo）─────
t('真實 RIX 檔（SOFTSTAR 86RIX，若存在）：唯讀解析，報出成功與失敗的檔數', function () {
  var dir = 'D:/Downloads/SOFTSTAR.tar/SOFTSTAR/SOFTSTAR/PAL/86RIX';
  if (!fs.existsSync(dir)) { console.log('    （略過：找不到 ' + dir + '）'); return; }
  var files = fs.readdirSync(dir).filter(function (f) { return /\.RIX$/i.test(f); });
  var ok = 0, stopped = 0, fails = [], secs = [], notes = 0;
  files.forEach(function (f) {
    try {
      var r = RIX.parseRix(fs.readFileSync(path.join(dir, f)));
      ok++; notes += r.stats.notes; secs.push(r.stats.seconds); if (r.stats.stopped) stopped++;
    } catch (e) { fails.push(f + '：' + e.message); }
  });
  console.log('    真實 RIX：共 ' + files.length + ' 檔，解析成功 ' + ok + '，有結束字 ' + stopped + '，失敗 ' + fails.length + '，音符 ' + notes + '，長度 ' + Math.min.apply(null, secs) + '–' + Math.max.apply(null, secs) + ' 秒');
  fails.forEach(function (x) { console.log('    失敗：' + x); });
  assert.equal(fails.length, 0, '真實檔全部應能解析');
  assert.equal(stopped, ok, '每個解析成功的檔都要找到結束字');
});

// ───── 執行 ─────
(async function () {
  var pass = 0, failed = [];
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); pass++; console.log('  通過  ' + tests[i].name); }
    catch (e) { failed.push(tests[i].name); console.log('  失敗  ' + tests[i].name + '\n        ' + (e && e.message)); }
  }
  console.log('musiclib_extract 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
