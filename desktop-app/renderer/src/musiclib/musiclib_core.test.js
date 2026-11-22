/* 音樂庫核心的單元測試：node renderer/src/musiclib/musiclib_core.test.js 直接跑（不需要 GPU、不需要瀏覽器）。
 * 假檔案全部用 Uint8Array 手組：ID3、WAV 檔頭、MIDI、MP4 盒子、MP3 音框。 */
'use strict';
var assert = require('assert');
var M = require('./musiclib_core.js');

// ───── 手組位元組的小工具 ─────
function A(s) { return Array.from(Buffer.from(s, 'latin1')); }
function u16be(n) { return [(n >> 8) & 255, n & 255]; }
function u32be(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u16le(n) { return [n & 255, (n >> 8) & 255]; }
function u32le(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
function syncsafe(n) { return [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]; }
function cat(parts) {
  var flat = [];
  (function walk(p) {
    if (typeof p === 'string') A(p).forEach(function (x) { flat.push(x); });
    else if (Array.isArray(p) || p instanceof Uint8Array) Array.from(p).forEach(function (x) { if (typeof x === 'number') flat.push(x); else walk(x); });
    else if (p != null) flat.push(p);
  })(parts);
  return new Uint8Array(flat);
}
function id3Frame(id, text, enc) {
  var body = enc === 'utf16' ? [1, 0xFF, 0xFE].concat(Array.from(Buffer.from(text, 'utf16le'))) : [3].concat(Array.from(Buffer.from(text, 'utf8')));
  return cat([id, u32be(body.length), [0, 0], body]);
}
function id3Tag(frames) { var body = cat(frames); return cat(['ID3', [3, 0, 0], syncsafe(body.length), body]); }
function mp3Frame(opts) {
  // MPEG1 Layer III、128kbps、44100Hz、無填充：幀長 = 144*128000/44100 = 417；b3 = 0 為立體聲
  var frame = new Uint8Array(417);
  frame[0] = 0xFF; frame[1] = 0xFB; frame[2] = (9 << 4) | (0 << 2); frame[3] = opts && opts.mono ? 0xC0 : 0;
  if (opts && opts.xingFrames != null) {
    var xo = 4 + 32; // 立體聲 MPEG1 側資訊 32 位元組
    frame.set(A('Xing'), xo); frame.set(u32be(1), xo + 4); frame.set(u32be(opts.xingFrames), xo + 8);
  }
  return frame;
}
function midTrack(events) { var body = cat(events); return cat(['MTrk', u32be(body.length), body]); }
function box(type, payload) { return cat([u32be(8 + payload.length), type, payload]); }
function makeReader(map) {
  var reader = async function (p) { reader.calls.push(p); return map[p] || null; };
  reader.calls = [];
  return reader;
}

// ───── 測試清單 ─────
var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

t('辨識種類：副檔名與檔頭', function () {
  assert.equal(M.identifyKind('a.mp3', cat([0xFF, 0xFB, 0x90])).kind, 'mp3');
  assert.equal(M.identifyKind('a.mp3', cat(['ID3', [3, 0, 0]])).kind, 'mp3');
  // 檔頭與副檔名不同，以檔頭為準
  var fake = M.identifyKind('x.mp3', cat(['RIFF', u32le(0), 'WAVE']));
  assert.equal(fake.kind, 'wav'); assert.equal(fake.via, 'magic');
  assert.equal(M.identifyKind('tune.mid', cat(['MThd', u32be(6)])).kind, 'mid');
  assert.equal(M.identifyKind('tune.midi', null).kind, 'mid');
  assert.equal(M.identifyKind('clip.mp4', cat([u32be(20), 'ftyp', 'isom'])).kind, 'mp4');
  assert.equal(M.identifyKind('clip.mov', cat([u32be(20), 'ftyp', 'qt  '])).kind, 'mov');
  assert.equal(M.identifyKind('clip.webm', cat([0x1A, 0x45, 0xDF, 0xA3])).kind, 'webm');
  assert.equal(M.identifyKind('movie.webm', null).kind, 'webm');
  assert.equal(M.identifyKind('flash.swf', cat(['CWS', 9])).kind, 'swf');
});

t('遊戲音樂來源：只登記辨識成待擷取', function () {
  var nes = M.identifyKind('zelda.nes', cat(['NES\u001a', 1, 2]));
  assert.equal(nes.kind, 'nes'); assert.equal(nes.category, 'game'); assert.equal(nes.pending, true);
  assert.equal(nes.label, '遊戲音樂來源，待擷取');
  ['pce', 'sfc', 'rix', 'swf'].forEach(function (ext) {
    var r = M.identifyKind('x.' + ext, null);
    assert.equal(r.kind, ext); assert.equal(r.pending, true);
  });
});

t('無法辨識的檔案回傳 null', function () {
  assert.equal(M.identifyKind('notes.txt', A('hello')), null);
  assert.equal(M.identifyKind('noext', null), null);
  assert.equal(M.isSupportedName('a.txt'), false);
  assert.equal(M.isSupportedName('a.MP3'), true);
});

t('專輯從上一層資料夾推導', function () {
  assert.equal(M.albumFromPath('D:\\Music\\葉惠美\\晴天.mp3'), '葉惠美');
  assert.equal(M.albumFromPath('/home/u/Music/Jazz/Autumn Leaves.wav'), 'Jazz');
  assert.equal(M.albumFromPath('D:\\晴天.mp3'), '');
  assert.equal(M.albumFromPath('song.mp3'), '');
});

t('mp3：ID3v2 文字（UTF-8、UTF-16）', function () {
  var tag = id3Tag([id3Frame('TIT2', '晴天', 'utf8'), id3Frame('TPE1', 'Jay Chou', 'utf16'), id3Frame('TALB', '葉惠美', 'utf8')]);
  var bytes = cat([tag, mp3Frame()]);
  var m = M.parseMetadata('mp3', bytes, bytes.length);
  assert.equal(m.title, '晴天'); assert.equal(m.artist, 'Jay Chou'); assert.equal(m.album, '葉惠美');
});

t('mp3：ID3v1 尾端標籤與長度估計（CBR）', function () {
  var frames = []; for (var i = 0; i < 100; i++) frames.push(mp3Frame());
  var tail = cat(['TAG', 'Old Title'.padEnd(30, '\u0000'), 'Old Artist'.padEnd(30, '\u0000'), 'Old Album'.padEnd(30, '\u0000'), new Uint8Array(35)]); // 3+30+30+30+35 = 128
  var bytes = cat(frames.concat([tail]));
  var m = M.parseMetadata('mp3', bytes, bytes.length);
  assert.equal(m.title, 'Old Title'); assert.equal(m.album, 'Old Album');
  assert.equal(m.durationApprox, true);
  var expect = (bytes.length - 0) * 8 / 128000;
  assert.ok(Math.abs(m.durationSec - expect) < 0.01, 'duration ' + m.durationSec);
  assert.equal(m.format.bitrateKbps, 128); assert.equal(m.format.sampleRate, 44100);
});

t('mp3：Xing 標頭給精確長度（幀數 × 1152 ÷ 取樣率）', function () {
  var bytes = cat([mp3Frame({ xingFrames: 100 }), mp3Frame()]);
  var m = M.parseMetadata('mp3', bytes, bytes.length);
  assert.ok(Math.abs(m.durationSec - 100 * 1152 / 44100) < 1e-9);
  assert.equal(m.durationApprox, false);
});

t('mp3：解析不了不丟例外，欄位留空', function () {
  var m = M.parseMetadata('mp3', A('garbage'), 7);
  assert.equal(m.title, null); assert.equal(m.durationSec, null);
  assert.deepEqual(M.parseMetadata('mp3', null, 0).notes, []);
});

t('wav：fmt 與 data 區塊算長度，LIST/INFO 給標題與專輯', function () {
  var fmt = cat(['fmt ', u32le(16), u16le(1), u16le(2), u32le(44100), u32le(176400), u16le(4), u16le(16)]);
  var title = Array.from(Buffer.from('晴天\u0000', 'utf8')); // 奇數位元組要補一個零
  var info = cat(['INFO', 'INAM', u32le(title.length), title, title.length % 2 ? [0] : [], 'IPRD', u32le(6), 'Album\u0000']);
  var list = cat(['LIST', u32le(info.length), info]);
  var data = cat(['data', u32le(176400)]);
  var body = cat(['WAVE', fmt, list, data]);
  var bytes = cat(['RIFF', u32le(body.length), body]);
  var m = M.parseMetadata('wav', bytes, bytes.length + 176400);
  assert.equal(m.title, '晴天'); assert.equal(m.album, 'Album');
  assert.equal(m.format.channels, 2); assert.equal(m.format.sampleRate, 44100); assert.equal(m.format.bitsPerSample, 16);
  assert.ok(Math.abs(m.durationSec - 1.0) < 1e-9, 'wav 長度 ' + m.durationSec);
});

t('mid：標頭軌數、tempo 換算長度、第一軌名稱', function () {
  // 每拍 480 tick，500000 微秒（120 BPM）；960 tick＝2 拍＝1 秒
  var track = midTrack([
    [0x00, 0xFF, 0x03, 0x05, A('Piano'), 0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20],
    [0x00, 0x90, 60, 100],
    [0x87, 0x40, 0x80, 60, 0],          // delta 960 → 關音符（running status 用 0x80）
    [0x00, 0xFF, 0x2F, 0x00]
  ]);
  var bytes = cat(['MThd', u32be(6), u16be(1), u16be(1), u16be(480), track]);
  var m = M.parseMetadata('mid', bytes, bytes.length);
  assert.equal(m.tracks, 1); assert.equal(m.trackName, 'Piano');
  assert.ok(Math.abs(m.durationSec - 1.0) < 1e-9, 'mid 長度 ' + m.durationSec);
});

t('mid：速度變化（tempo）會改變長度', function () {
  // 前 480 tick 用 120 BPM（0.5 秒），之後 480 tick 改成 60 BPM（1 秒），合計 1.5 秒
  var track = midTrack([
    [0x00, 0x90, 60, 100],
    [0x83, 0x60, 0xFF, 0x51, 0x03, 0x0F, 0x42, 0x40],   // delta 480，tempo 1000000
    [0x00, 0x80, 60, 0],
    [0x83, 0x60, 0xFF, 0x2F, 0x00]                        // delta 480 → 軌道結束
  ]);
  var bytes = cat(['MThd', u32be(6), u16be(1), u16be(1), u16be(480), track]);
  var m = M.parseMetadata('mid', bytes, bytes.length);
  assert.ok(Math.abs(m.durationSec - 1.5) < 1e-9, 'tempo 長度 ' + m.durationSec);
});

t('mp4：moov／mvhd 時間尺度與總長', function () {
  var mvhd = box('mvhd', cat([[0, 0, 0, 0], u32be(0), u32be(0), u32be(1000), u32be(5000)]));
  var moov = box('moov', mvhd);
  var bytes = cat([box('ftyp', cat(['isom', u32be(0), 'isom'])), moov]);
  var m = M.parseMetadata('mp4', bytes, bytes.length);
  assert.equal(m.durationSec, 5);
  // moov 不在讀到的範圍內：留空，不丟例外
  var m2 = M.parseMetadata('mp4', cat([box('ftyp', cat(['isom', u32be(0), 'isom']))]), 9999);
  assert.equal(m2.durationSec, null);
});

t('格式化長度', function () {
  assert.equal(M.formatDuration(null), '—');
  assert.equal(M.formatDuration(65), '1:05');
  assert.equal(M.formatDuration(3725), '1:02:05');
});

// 建一個有五個檔案的測試來源：兩個 mp3（一個有標籤、一個沒有）、wav、nes、mp4，以及一個 txt（應被略過）
function fixtures() {
  var ttl = id3Tag([id3Frame('TIT2', '晴天', 'utf8'), id3Frame('TPE1', '周杰倫', 'utf8'), id3Frame('TALB', '葉惠美', 'utf8')]);
  var mp3a = cat([ttl, mp3Frame()]);
  var mp3b = cat([mp3Frame()]);
  var fmt = cat(['fmt ', u32le(16), u16le(1), u16le(2), u32le(44100), u32le(176400), u16le(4), u16le(16)]);
  var wavBody = cat(['WAVE', fmt, cat(['data', u32le(176400)])]);
  var wav = cat(['RIFF', u32le(wavBody.length), wavBody]);
  var nes = cat(['NES\u001a', [1, 2, 3, 4]]);
  var mp4 = cat([box('ftyp', cat(['isom', u32be(0), 'isom'])), box('moov', box('mvhd', cat([[0, 0, 0, 0], u32be(0), u32be(0), u32be(1000), u32be(5000)])))]);
  var txt = A('just notes');
  var files = {
    'D:/Music/周杰倫/晴天.mp3': mp3a,
    'D:/Music/Jazz/Autumn Leaves.mp3': mp3b,
    'D:/Music/Jazz/Autumn Leaves.wav': wav,
    'D:/Music/Game/zelda.nes': nes,
    'D:/Videos/clip.mp4': mp4,
    'D:/misc/readme.txt': txt
  };
  var stats = {};
  Object.keys(files).forEach(function (p) { stats[p] = { path: p, size: files[p].length, mtimeMs: 1000 }; });
  return { files: files, stats: stats };
}

t('增量掃描：新增、略過未變更、變更、消失（標 missing）', async function () {
  var fx = fixtures();
  var lib = M.createLibrary();
  await lib.load();
  var sid = lib.addSource('folder', 'Music');
  var entries = Object.keys(fx.stats).map(function (k) { return fx.stats[k]; });
  var reader = makeReader(fx.files);
  var r1 = await lib.scan(sid, entries, reader, { now: 1 });
  assert.equal(r1.added, 5); assert.equal(r1.skipped, 1); assert.deepEqual(r1.skippedPaths, ['D:/misc/readme.txt']);
  assert.equal(reader.calls.length, 6); // 每個候選檔都讀過一次檔頭
  var rec = lib.records.filter(function (r) { return r.path === 'D:/Music/周杰倫/晴天.mp3'; })[0];
  assert.equal(rec.title, '晴天'); assert.equal(rec.artist, '周杰倫'); assert.equal(rec.album, '葉惠美'); assert.equal(rec.albumSource, 'tag');
  var jazz = lib.records.filter(function (r) { return r.path === 'D:/Music/Jazz/Autumn Leaves.mp3'; })[0];
  assert.equal(jazz.album, 'Jazz'); assert.equal(jazz.albumSource, 'folder'); assert.equal(jazz.title, 'Autumn Leaves');
  var nes = lib.records.filter(function (r) { return r.kind === 'nes'; })[0];
  assert.equal(nes.pending, true); assert.equal(nes.category, 'game');

  // 第二次：完全相同 → 全部略過，不讀檔頭
  var reader2 = makeReader(fx.files);
  var r2 = await lib.scan(sid, entries, reader2, { now: 2 });
  assert.equal(r2.unchanged, 5); assert.equal(r2.added + r2.changed, 0); assert.equal(reader2.calls.length, 0);

  // 第三次：mp3 大小變了（變更）、mp4 不見了（消失）
  var changed = Object.assign({}, fx.stats['D:/Music/Jazz/Autumn Leaves.mp3'], { size: 999, mtimeMs: 2000 });
  var entries3 = entries.filter(function (e) { return e.path !== 'D:/Videos/clip.mp4'; }).map(function (e) { return e.path === changed.path ? changed : e; });
  var files3 = Object.assign({}, fx.files, { 'D:/Music/Jazz/Autumn Leaves.mp3': fx.files['D:/Music/Jazz/Autumn Leaves.mp3'] });
  var reader3 = makeReader(files3);
  var r3 = await lib.scan(sid, entries3, reader3, { now: 3 });
  // 未變更：mp3（有標籤）、wav、nes；txt 是略過的（大小時間沒變、不重讀）
  assert.equal(r3.changed, 1); assert.equal(r3.unchanged, 3); assert.equal(r3.skipped, 1); assert.equal(r3.missing, 1);
  assert.equal(reader3.calls.indexOf('D:/misc/readme.txt'), -1);
  var mp4rec = lib.records.filter(function (r) { return r.kind === 'mp4'; })[0];
  assert.equal(mp4rec.status, 'missing');
  assert.equal(lib.records.length, 5);
});

t('搜尋：檔名、專輯、標題、演出者；多關鍵字都要命中；大小寫與全形不影響', async function () {
  var fx = fixtures();
  var lib = M.createLibrary();
  var sid = lib.addSource('folder', 'Music');
  await lib.scan(sid, Object.keys(fx.stats).map(function (k) { return fx.stats[k]; }), makeReader(fx.files), { now: 1 });
  var names = function (res) { return res.map(function (x) { return x.record.name; }); };
  assert.equal(names(lib.search('晴天'))[0], '晴天.mp3');          // 中文（標題）
  assert.equal(names(lib.search('周杰倫 晴天')).length, 1);        // 多關鍵字，全部命中
  assert.equal(names(lib.search('周杰倫 autumn')).length, 0);      // 有一個不命中就排除
  assert.equal(names(lib.search('AUTUMN leaves'))[0], 'Autumn Leaves.mp3'); // 英文不分大小寫
  assert.equal(names(lib.search('ａｕｔｕｍｎ'))[0], 'Autumn Leaves.mp3');   // 全形字折成半形
  assert.equal(names(lib.search('jazz')).length, 2);               // 專輯（資料夾）命中：mp3 與 wav
  assert.equal(names(lib.search('葉惠美'))[0], '晴天.mp3');         // 專輯標籤
  assert.equal(names(lib.search('clip'))[0], 'clip.mp4');
  assert.equal(lib.search('').length, 5);                          // 空查詢＝全部
});

t('搜尋排序：檔名完全相同最前，權重高的欄位在前', async function () {
  var recs = [
    { path: 'x/a/Other.mp3', name: 'Other.mp3', title: 'Other', album: 'Star', artist: '', status: 'ok' },
    { path: 'x/b/Star.mp3', name: 'Star.mp3', title: 'Star', album: '', artist: '', status: 'ok' },
    { path: 'x/c/Starfish.mp3', name: 'Starfish.mp3', title: 'Starfish', album: '', artist: '', status: 'ok' }
  ];
  var res = M.searchRecords(recs, 'star');
  assert.deepEqual(res.map(function (x) { return x.record.name; }), ['Star.mp3', 'Starfish.mp3', 'Other.mp3']);
});

t('搜尋：消失的檔案預設不出現，可用 includeMissing 查到', async function () {
  var recs = [{ path: 'a/gone.mp3', name: 'gone.mp3', title: 'gone', album: '', artist: '', status: 'missing' }];
  assert.equal(M.searchRecords(recs, 'gone').length, 0);
  assert.equal(M.searchRecords(recs, 'gone', { includeMissing: true }).length, 1);
});

t('儲存後端：JSON 來回、版本保護、內容可重新載入', async function () {
  var fx = fixtures();
  var stored = null;
  var io = { read: async function () { return stored; }, write: async function (s) { stored = s; } };
  var lib = M.createLibrary(M.createJsonBackend(io));
  await lib.load();
  var sid = lib.addSource('file', '2 個檔案');
  await lib.scan(sid, [fx.stats['D:/Music/周杰倫/晴天.mp3']], makeReader(fx.files), { now: 5 });
  await lib.save();
  var lib2 = M.createLibrary(M.createJsonBackend(io));
  await lib2.load();
  assert.equal(lib2.records.length, 1); assert.equal(lib2.records[0].title, '晴天');
  assert.equal(lib2.sources.length, 1);
  stored = JSON.stringify({ version: 99, sources: [], records: [] });
  await assert.rejects(M.createLibrary(M.createJsonBackend(io)).load(), /比較新的版本/);
});

t('來源：同名同類型的來源不重複登記；移除來源會一併移除它的檔案', async function () {
  var lib = M.createLibrary();
  var a = lib.addSource('folder', 'Music'), b = lib.addSource('folder', 'Music');
  assert.equal(a, b);
  var c = lib.addSource('file', 'one.mp3');
  assert.notEqual(c, a);
  lib.records.push({ key: a + '|x', sourceId: a, path: 'x', name: 'x', title: 'x', album: '', artist: '', status: 'ok' });
  lib.removeSource(a);
  assert.equal(lib.records.length, 0); assert.equal(lib.sources.length, 1);
});

// ───── 執行 ─────
(async function () {
  var pass = 0, failed = [];
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); pass++; console.log('  通過  ' + tests[i].name); }
    catch (e) { failed.push(tests[i].name); console.log('  失敗  ' + tests[i].name + '\n        ' + (e && e.message)); }
  }
  console.log('musiclib_core 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
