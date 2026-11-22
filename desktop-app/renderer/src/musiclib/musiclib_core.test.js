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

t('遊戲音樂來源：PCE／SFC 只登記待擷取；NES、RIX、Flash 是可擷取的種類', function () {
  var nes = M.identifyKind('zelda.nes', cat(['NES\u001a', 1, 2]));
  assert.equal(nes.kind, 'nes'); assert.equal(nes.category, 'extract'); assert.equal(nes.pending, false);
  assert.equal(nes.label, 'NES 遊戲音樂，可擷取');
  ['pce', 'sfc'].forEach(function (ext) {
    var r = M.identifyKind('x.' + ext, null);
    assert.equal(r.kind, ext); assert.equal(r.pending, true);
  });
  ['rix', 'swf', 'nes'].forEach(function (ext) {
    var r = M.identifyKind('x.' + ext, null);
    assert.equal(r.kind, ext); assert.equal(r.category, 'extract'); assert.equal(r.pending, false, ext + ' 可擷取，不算待擷取');
  });
  assert.equal(M.planExport('x.rix', 'mp3').ok, false);
  assert.ok(/擷取/.test(M.planExport('x.swf', 'mid').reason), '說明要先擷取');
});

t('子曲目記錄：從擷取的輸出建立普通的 mid／mp3 記錄，並記下來源與擷取方式；重新擷取會換掉舊的', function () {
  var parent = { key: 'src1|/games/MUSIC_01.RIX', sourceId: 'src1', sourceType: 'folder', sourceLabel: 'games', album: 'games' };
  var rec = M.buildDerivedRecord(parent, { index: 0, kind: 'mid', path: '/out/MUSIC_01.mid', sizeBytes: 120, method: 'RIX→MIDI' }, 5);
  assert.equal(rec.kind, 'mid'); assert.equal(rec.category, 'audio'); assert.equal(rec.pending, false);
  assert.equal(rec.derivedFrom, parent.key); assert.equal(rec.derivedMethod, 'RIX→MIDI');
  assert.equal(rec.name, 'MUSIC_01.mid'); assert.equal(rec.album, 'games');
  var lib = { records: [{ key: 'a', derivedFrom: parent.key }, { key: 'b' }] };
  M.replaceDerived(lib, parent.key, [rec, M.buildDerivedRecord(parent, { index: 1, kind: 'mp3', path: '/out/MUSIC_01.mp3', sizeBytes: 9, method: 'x' }, 5)]);
  assert.equal(lib.records.filter(function (r) { return r.derivedFrom === parent.key; }).length, 2, '舊的被換掉');
  assert.ok(lib.records.some(function (r) { return r.key === 'b'; }), '其他記錄保留');
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
  assert.equal(nes.pending, false); assert.equal(nes.category, 'extract');

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

// ───── 歌詞轉錄佇列與歌詞搜尋（假轉錄函式）─────
async function libWithFixtures() {
  const fx = fixtures();
  const lib = M.createLibrary();
  const sid = lib.addSource('folder', 'Music');
  await lib.scan(sid, Object.keys(fx.stats).map(function (k) { return fx.stats[k]; }), makeReader(fx.files), { now: 1 });
  return lib;
}
// map：檔名 → 段落陣列，或丟錯的 Error，或函式 (record, opts) => Promise
function fakeTranscriber(map) {
  const f = async function (rec, o) {
    f.calls.push(rec.name);
    const v = map[rec.name];
    if (typeof v === 'function') return v(rec, o);
    if (v instanceof Error) throw v;
    return { segments: v || [], language: 'zh', durationSeconds: 3 };
  };
  f.calls = [];
  return f;
}
const SEG_TIANQING = [
  { start: 0, end: 2.5, text: '故事的小黃花' },
  { start: 2.5, end: 6, text: '從出生那年就飄著' },
  { start: 6, end: 9, text: 'Love is in the air' },
];
const SEG_AUTUMN = [{ start: 1, end: 4, text: 'the falling leaves of autumn' }, { start: 4, end: 7, text: 'さくら咲く春' }];

t('歌詞佇列：完成、失敗附具體原因、續跑不重做已完成的', async function () {
  const lib = await libWithFixtures();
  const byName = (n) => lib.records.filter((r) => r.name === n)[0];
  // 第一輪：晴天成功、Autumn Leaves.mp3 失敗（附具體原因），其餘（wav、mp4）給空段落也算完成
  const tr = fakeTranscriber({ '晴天.mp3': SEG_TIANQING, 'Autumn Leaves.mp3': new Error('解碼失敗：檔頭不是可辨識的音訊') });
  const q = M.createLyricQueue(lib, tr);
  q.enqueue([]);
  await q.idle();
  assert.equal(byName('晴天.mp3').lyricStatus, 'done');
  assert.equal(byName('晴天.mp3').lyrics.segments.length, 3);
  assert.equal(byName('Autumn Leaves.mp3').lyricStatus, 'failed');
  // 不可重試的失敗：只嘗試一次，原因後面接上具體訊息
  assert.equal(byName('Autumn Leaves.mp3').lyricError, '第 1 次嘗試失敗：解碼失敗：檔頭不是可辨識的音訊');
  assert.equal(byName('zelda.nes').lyricStatus, 'none', '遊戲來源不排進佇列');
  assert.equal(q.state().counts.failed, 1);
  // 第二輪（續跑）：完成的不重做，失敗的會重試
  const trAgain = fakeTranscriber({ 'Autumn Leaves.mp3': SEG_AUTUMN });
  const q2 = M.createLyricQueue(lib, trAgain);
  q2.enqueue([]);
  await q2.idle();
  assert.deepEqual(trAgain.calls, ['Autumn Leaves.mp3'], '其他三首第一輪已完成，只重試失敗的那首');
  assert.equal(byName('Autumn Leaves.mp3').lyricStatus, 'done');
  assert.equal(byName('Autumn Leaves.mp3').lyricError, null);
  assert.equal(q2.state().counts.done, 4);
});

t('歌詞佇列：暫停後退回排隊、續跑從頭做；狀態計數正確', async function () {
  const lib = await libWithFixtures();
  let q;
  let first = true;
  const tr = fakeTranscriber({
    '晴天.mp3': async (rec, o) => {
      if (first) { first = false; q.pause(); if (o.shouldPause()) { const e = new Error('暫停'); e.paused = true; throw e; } }
      return { segments: SEG_TIANQING, language: 'zh', durationSeconds: 9 };
    },
  });
  q = M.createLyricQueue(lib, tr);
  q.enqueue([]);
  await q.idle();
  const s1 = q.state();
  assert.equal(s1.paused, true);
  assert.equal(s1.running, false);
  assert.equal(lib.records.filter((r) => r.name === '晴天.mp3')[0].lyricStatus, 'queued', '被暫停的那首退回排隊');
  assert.equal(s1.counts.done, 0);
  q.resume();
  await q.idle();
  const s2 = q.state();
  assert.equal(s2.paused, false);
  assert.equal(s2.counts.done, 4, '4 個音訊／影片都完成');
  assert.equal(s2.counts.none + s2.counts.queued + s2.counts.failed, 0);
  assert.equal(tr.calls.filter((n) => n === '晴天.mp3').length, 2, '暫停的那首從頭重做一次');
});

t('歌詞佇列：完成的歌詞會存進後端，重開後仍在；重開時在跑的狀態退回未轉錄', async function () {
  let stored = null;
  const io = { read: async () => stored, write: async (s) => { stored = s; } };
  const lib = await libWithFixtures();
  lib.backend = M.createJsonBackend(io);
  // 重新用 JSON 後端保存
  lib.save = async function () { await M.createJsonBackend(io).save({ sources: lib.sources, records: lib.records }); };
  const q = M.createLyricQueue(lib, fakeTranscriber({ '晴天.mp3': SEG_TIANQING }));
  q.enqueue([]);
  await q.idle();
  const lib2 = M.createLibrary(M.createJsonBackend(io));
  await lib2.load();
  const r = lib2.records.filter((x) => x.name === '晴天.mp3')[0];
  assert.equal(r.lyricStatus, 'done');
  assert.equal(r.lyrics.segments[0].text, '故事的小黃花');
  // 模擬關掉 app 時還在跑：狀態存成 running，重開後要退回 none
  r.lyricStatus = 'running';
  M.createLyricQueue(lib2, fakeTranscriber({}));
  assert.equal(r.lyricStatus, 'none');
});

t('歌詞佇列：檔案變更後歌詞清掉，再轉錄才會重做', async function () {
  const fx = fixtures();
  const lib = M.createLibrary();
  const sid = lib.addSource('folder', 'Music');
  const entries = Object.keys(fx.stats).map((k) => fx.stats[k]);
  await lib.scan(sid, entries, makeReader(fx.files), { now: 1 });
  const q = M.createLyricQueue(lib, fakeTranscriber({ '晴天.mp3': SEG_TIANQING }));
  q.enqueue([]); await q.idle();
  assert.equal(lib.records.filter((r) => r.name === '晴天.mp3')[0].lyricStatus, 'done');
  const changed = entries.map((e) => (e.path === 'D:/Music/周杰倫/晴天.mp3' ? Object.assign({}, e, { mtimeMs: 2000 }) : e));
  await lib.scan(sid, changed, makeReader(fx.files), { now: 2 });
  const r = lib.records.filter((x) => x.name === '晴天.mp3')[0];
  assert.equal(r.lyrics, null);
  assert.equal(r.lyricStatus, 'none');
  // 沒變的（wav）歌詞不受影響
  q.enqueue([]); await q.idle();
  assert.equal(r.lyricStatus, 'done');
});

t('歌詞搜尋：中日英都能查，回傳命中段落與時間點', async function () {
  const lib = await libWithFixtures();
  const tr = fakeTranscriber({ '晴天.mp3': SEG_TIANQING, 'Autumn Leaves.wav': [], 'Autumn Leaves.mp3': [] });
  const q = M.createLyricQueue(lib, fakeTranscriber({ '晴天.mp3': SEG_TIANQING, 'Autumn Leaves.mp3': SEG_AUTUMN, '夜曲.mp3': [] }));
  q.enqueue([]); await q.idle();
  const names = (res) => res.map((x) => x.record.name);
  assert.deepEqual(names(lib.search('小黃花')), ['晴天.mp3'], '中文歌詞');
  assert.deepEqual(names(lib.search('さくら')), ['Autumn Leaves.mp3'], '日文歌詞');
  assert.deepEqual(names(lib.search('falling')), ['Autumn Leaves.mp3'], '英文歌詞');
  assert.deepEqual(names(lib.search('LOVE')), ['晴天.mp3'], '英文不分大小寫');
  const hit = lib.search('小黃花')[0];
  assert.equal(hit.lyricHits.length, 1);
  assert.equal(hit.lyricHits[0].start, 0);
  assert.equal(hit.lyricHits[0].end, 2.5);
  assert.equal(hit.lyricHits[0].text, '故事的小黃花');
  // 多關鍵字：歌詞兩個詞都要命中（同一首）
  assert.deepEqual(names(lib.search('小黃花 出生')), ['晴天.mp3']);
  assert.deepEqual(names(lib.search('小黃花 falling')), []);
  void tr;
});

t('歌詞搜尋：檔名命中排在歌詞命中前面；範圍切換（不含歌詞／只歌詞）', async function () {
  const lib = await libWithFixtures();
  const q = M.createLyricQueue(lib, fakeTranscriber({
    'Autumn Leaves.mp3': [{ start: 0, end: 3, text: '晴天的雨' }],
    '晴天.mp3': [{ start: 0, end: 3, text: '沒有別的字' }],
  }));
  q.enqueue([]); await q.idle();
  // 「晴天」：晴天.mp3 檔名命中（分數高）；Autumn Leaves.mp3 只有歌詞命中
  assert.deepEqual(lib.search('晴天').map((x) => x.record.name), ['晴天.mp3', 'Autumn Leaves.mp3']);
  assert.deepEqual(lib.search('晴天', { scope: 'meta' }).map((x) => x.record.name), ['晴天.mp3']);
  assert.deepEqual(lib.search('晴天', { scope: 'lyrics' }).map((x) => x.record.name), ['Autumn Leaves.mp3']);
  assert.ok(M.LYRIC_WEIGHT < 3, '歌詞權重低於檔名');
});

t('歌詞佇列：不認的狀態與停止中的計數', async function () {
  const lib = await libWithFixtures();
  const q = M.createLyricQueue(lib, fakeTranscriber({}));
  const s = q.state();
  assert.equal(s.counts.none, 4, '4 個音訊與影片，遊戲來源不算');
  assert.equal(s.running, false);
  assert.throws(() => M.createLyricQueue(lib, null), /轉錄函式/);
});

// ───── 無進展偵測與自動重試（假轉錄函式模擬卡住、慢、暫時性失敗）─────
// 測試用的政策：先驗與保底都縮小，讓「卡住」在幾十毫秒內判定；正式值見 core 的常數
const FAST = { floorMs: 40, factor: 2, backoffMs: [5, 10, 20], prior: { decode: 1, load: 1, infer: 1 } };
const sleepT = (ms) => new Promise((r) => setTimeout(r, ms));

t('無進展：卡住的階段會被中止，附階段名、已耗時、最後進度，暫時性失敗會重試 3 次後才標失敗', async function () {
  const lib = await libWithFixtures();
  const calls = [];
  const tr = async (rec, o) => {
    calls.push(rec.name);
    if (rec.name !== '晴天.mp3') return { segments: [], language: 'zh', durationSeconds: 1 };
    o.report('load', { detail: '下載模型 1%' });
    return new Promise(() => { /* 永遠不回：模擬卡住 */ });
  };
  const q = M.createLyricQueue(lib, tr, { policy: FAST });
  q.enqueue([lib.records.filter((r) => r.name === '晴天.mp3')[0].key]);
  await q.idle();
  const r = lib.records.filter((x) => x.name === '晴天.mp3')[0];
  assert.equal(r.lyricStatus, 'failed');
  assert.equal(calls.length, 4, '第一次＋重試 3 次');
  assert.ok(/第 4 次嘗試失敗（已自動重試 3 次）/.test(r.lyricError), r.lyricError);
  assert.ok(/階段「載入模型」無進展/.test(r.lyricError), r.lyricError);
  assert.ok(/已耗時 \d+ 秒/.test(r.lyricError), r.lyricError);
  assert.ok(/最後進度：下載模型 1%/.test(r.lyricError), r.lyricError);
});

t('無進展：慢但持續有回報的不會被判卡住；佇列狀態顯示目前階段與中文名', async function () {
  const lib = await libWithFixtures();
  let seenStage = null, seenLabel = null;
  const tr = async (rec, o) => {
    if (rec.name !== '晴天.mp3') return { segments: [], language: 'zh', durationSeconds: 1 };
    o.report('decode', { detail: '解碼中', units: 1 });
    await sleepT(30);
    o.report('infer', { detail: '第 1 段', units: 30, window: 30 });
    seenStage = q.state().stage; seenLabel = q.state().stageLabel;
    for (let i = 0; i < 8; i++) { await sleepT(20); o.report('infer', { detail: '第 ' + (i + 2) + ' 段' }); }
    return { segments: SEG_TIANQING, language: 'zh', durationSeconds: 30 };
  };
  const q = M.createLyricQueue(lib, tr, { policy: FAST });
  q.enqueue([lib.records.filter((r) => r.name === '晴天.mp3')[0].key]);
  await q.idle();
  assert.equal(lib.records.filter((x) => x.name === '晴天.mp3')[0].lyricStatus, 'done');
  assert.equal(seenStage, 'infer');
  assert.equal(seenLabel, '推論');
});

t('暫時性失敗：第一次網路錯誤、重試後成功，原因清空', async function () {
  const lib = await libWithFixtures();
  let n = 0;
  const tr = async () => { n++; if (n === 1) throw new Error('network error: fetch failed'); return { segments: SEG_TIANQING, language: 'zh', durationSeconds: 3 }; };
  const q = M.createLyricQueue(lib, tr, { policy: FAST });
  q.enqueue([lib.records.filter((r) => r.name === '晴天.mp3')[0].key]);
  await q.idle();
  const r = lib.records.filter((x) => x.name === '晴天.mp3')[0];
  assert.equal(n, 2, '重試一次就成功');
  assert.equal(r.lyricStatus, 'done');
  assert.equal(r.lyricError, null);
});

t('不可重試的失敗（解碼不支援）只嘗試一次，立刻標失敗並附原因', async function () {
  const lib = await libWithFixtures();
  let n = 0;
  const tr = async () => { n++; throw new Error('解碼失敗：格式不支援'); };
  const q = M.createLyricQueue(lib, tr, { policy: FAST });
  q.enqueue([lib.records.filter((r) => r.name === '晴天.mp3')[0].key]);
  await q.idle();
  const r = lib.records.filter((x) => x.name === '晴天.mp3')[0];
  assert.equal(n, 1);
  assert.equal(r.lyricStatus, 'failed');
  assert.equal(r.lyricError, '第 1 次嘗試失敗：解碼失敗：格式不支援');
});

t('卡住的一首不影響其他曲目：其他首照常完成', async function () {
  const lib = await libWithFixtures();
  const tr = async (rec) => {
    if (rec.name === '晴天.mp3') return new Promise(() => { /* 卡住 */ });
    return { segments: SEG_AUTUMN, language: 'zh', durationSeconds: 3 };
  };
  const q = M.createLyricQueue(lib, tr, { policy: FAST });
  q.enqueue([]);
  await q.idle();
  const s = q.state();
  assert.equal(s.counts.failed, 1);
  assert.equal(s.counts.done, 3);
  assert.equal(lib.records.filter((x) => x.name === '晴天.mp3')[0].lyricStatus, 'failed');
});

t('重試等待中按暫停：那首退回排隊，不再重試', async function () {
  const lib = await libWithFixtures();
  let n = 0, q;
  const tr = async () => { n++; q.pause(); throw new Error('network error'); };
  q = M.createLyricQueue(lib, tr, { policy: Object.assign({}, FAST, { backoffMs: [200, 200, 200] }) });
  q.enqueue([lib.records.filter((r) => r.name === '晴天.mp3')[0].key]);
  await q.idle();
  assert.equal(n, 1);
  assert.equal(lib.records.filter((x) => x.name === '晴天.mp3')[0].lyricStatus, 'queued');
  assert.equal(q.state().retry, null);
});

t('暫停能打斷卡住的那一次嘗試（不必等無進展逾時）', async function () {
  const lib = await libWithFixtures();
  let n = 0;
  const tr = async (rec, o) => { n++; o.report('load', { detail: '下載中' }); return new Promise(() => { /* 卡住 */ }); };
  const q = M.createLyricQueue(lib, tr, { policy: { floorMs: 60000, factor: 3, prior: { decode: 1, load: 60000, infer: 1 } } });
  q.enqueue([lib.records.filter((r) => r.name === '晴天.mp3')[0].key]);
  await sleepT(30);
  const t0 = Date.now();
  q.pause();
  await q.idle();
  assert.ok(Date.now() - t0 < 1000, '暫停後很快結束，不是等 60 秒');
  assert.equal(n, 1);
  assert.equal(lib.records.filter((x) => x.name === '晴天.mp3')[0].lyricStatus, 'queued');
});

t('setPolicy 執行期調整：縮短卡住判定時間後，立刻生效', async function () {
  const lib = await libWithFixtures();
  let n = 0;
  const tr = async () => { n++; return new Promise(() => { /* 卡住 */ }); };
  const q = M.createLyricQueue(lib, tr, { policy: { backoffMs: [1, 1, 1], floorMs: 60000, factor: 3, prior: { decode: 1, load: 60000, infer: 1 } } });
  q.setPolicy({ floorMs: 30, factor: 1, prior: { load: 1, infer: 1, decode: 1 } });
  q.enqueue([lib.records.filter((r) => r.name === '晴天.mp3')[0].key]);
  await q.idle();
  assert.equal(n, 4, '卡住 → 3 次重試後標失敗');
  assert.equal(lib.records.filter((x) => x.name === '晴天.mp3')[0].lyricStatus, 'failed');
});

t('取消：清空排隊、中止卡住的那一首（不算失敗、不重試），曲目回到未轉錄', async function () {
  const lib = await libWithFixtures();
  let n = 0;
  const tr = async () => { n++; return new Promise(() => { /* 卡住 */ }); };
  const q = M.createLyricQueue(lib, tr, { policy: { floorMs: 60000, factor: 3, prior: { decode: 1, load: 60000, infer: 1 } } });
  q.enqueue([]);
  await sleepT(30);
  const t0 = Date.now();
  q.cancelAll();
  await q.idle();
  assert.ok(Date.now() - t0 < 1000, '取消後很快結束');
  assert.equal(n, 1, '取消不重試');
  const s = q.state();
  assert.equal(s.queued, 0);
  assert.equal(s.counts.failed, 0, '取消不算失敗');
  assert.equal(s.counts.queued, 0);
  assert.equal(s.counts.none, 4, '四首都回到未轉錄');
});

// ───── 批次輸出：路由、分鐘切片、檔名、重試、取消 ─────
t('路由：音訊轉 mp3、MIDI 轉 mp3／mid、影片走原生解碼（不需要 ffmpeg 同意）', function () {
  assert.equal(M.planExport('a.wav', 'mp3').route, 'audio>mp3');
  assert.equal(M.planExport('a.MP3', 'mp3').route, 'audio>mp3');
  assert.equal(M.planExport('song.mid', 'mp3').route, 'mid>mp3');
  assert.equal(M.planExport('song.mid', 'mid').route, 'mid>mid');
  var v = M.planExport('clip.mp4', 'mp3');
  assert.equal(v.route, 'video>mp3');
  assert.deepEqual(v.steps, ['decode', 'slice', 'encode-mp3'], '影片與音訊同一條解碼路線');
  assert.equal(v.consent, undefined, '影片路線不走 ffmpeg.wasm，沒有同意欄位');
  assert.equal(M.planExport('clip.mov', 'mp3').route, 'video>mp3');
  assert.equal(M.planExport('clip.webm', 'mp3').route, 'video>mp3');
});

t('路由：不支援的組合說明原因，不默默略過', function () {
  var a = M.planExport('a.wav', 'mid');
  assert.equal(a.route, 'audio>mid', '音訊轉 mid 走 audio_to_midi 單音追蹤');
  assert.deepEqual(a.steps, ['decode', 'slice', 'to-song', 'write-mid']);
  assert.equal(M.planExport('clip.mp4', 'mid').route, 'video>mid');
  var r = M.planExport('mario.nes', 'mp3');
  assert.equal(r.ok, false); assert.ok(/擷取/.test(r.reason), '說明要先擷取：' + r.reason);
  assert.equal(M.planExport('x.txt', 'mp3').ok, false);
  assert.equal(M.planExport('a.wav', 'flac').ok, false);
});

t('分鐘切片：整首不截、分鐘數截到較小者、標示是否截斷', function () {
  assert.equal(M.minutesToSec('whole'), null);
  assert.equal(M.minutesToSec('1'), 60);
  assert.equal(M.minutesToSec(2.5), 150);
  assert.throws(function () { M.minutesToSec(0); });
  assert.throws(function () { M.minutesToSec('abc'); });
  var w = M.sliceWindow(200, null);
  assert.deepEqual([w.startSec, w.endSec, w.truncated], [0, 200, false]);
  var c = M.sliceWindow(200, 60);
  assert.deepEqual([c.endSec, c.truncated], [60, true]);
  var s = M.sliceWindow(30, 60);
  assert.deepEqual([s.endSec, s.truncated], [30, false], '比整首短就不截');
});

t('檔名：去副檔名、加分鐘標記、去掉路徑分隔字元', function () {
  assert.equal(M.outputName('晴天.mp3', 'mp3', '1'), '晴天_1分.mp3');
  assert.equal(M.outputName('a/b:c.wav', 'mid', 'whole'), 'a_b_c_整首.mid');
});

t('批次：單檔失敗不影響其他檔案，失敗標示階段與原因', async function () {
  var items = [{ id: 1, name: 'a.wav', format: 'mp3' }, { id: 2, name: 'b.wav', format: 'mp3' }, { id: 3, name: 'c.txt', format: 'mp3' }];
  var out = await M.runExportBatch(items, {
    minutes: '1', sleep: function () { return Promise.resolve(); },
    runStep: async function (ctx) { if (ctx.item.id === 1) throw new Error('解碼失敗：壞檔'); ctx.onStage('encode-mp3'); return { path: 'x', sizeBytes: 9 }; }
  });
  assert.equal(out.results[0].status, 'failed');
  assert.equal(out.results[0].reason, '解碼失敗：壞檔');
  assert.equal(out.results[1].status, 'done');
  assert.equal(out.results[2].status, 'unsupported', '不支援的格式不進執行');
  assert.deepEqual(out.summary, { done: 1, failed: 1, unsupported: 1, cancelled: 0 });
});

t('批次：暫時性錯誤自動重來，成功後停止；重來次數用完才算失敗', async function () {
  var n = 0, sleeps = [];
  var out = await M.runExportBatch([{ id: 1, name: 'a.wav', format: 'mp3' }], {
    minutes: 'whole', sleep: function (ms) { sleeps.push(ms); return Promise.resolve(); },
    runStep: async function () { n++; if (n < 2) throw new Error('network error while fetching'); return { path: 'p', sizeBytes: 1 }; }
  });
  assert.equal(out.results[0].status, 'done');
  assert.equal(out.results[0].attempts, 2);
  assert.deepEqual(sleeps, [1000]);
  var m = 0;
  var out2 = await M.runExportBatch([{ id: 2, name: 'a.wav', format: 'mp3' }], {
    minutes: 'whole', sleep: function () { return Promise.resolve(); },
    runStep: async function () { m++; throw new Error('連線逾時'); }
  });
  assert.equal(out2.results[0].status, 'failed');
  assert.equal(m, M.EXPORT_MAX_ATTEMPTS);
});

t('批次：永久錯誤不重試；校驗未通過標示 verify 階段', async function () {
  var n = 0;
  var out = await M.runExportBatch([{ id: 1, name: 'a.wav', format: 'mp3' }], {
    minutes: 'whole', sleep: function () { return Promise.resolve(); },
    runStep: async function () { n++; throw new Error('解碼失敗：格式不明'); }
  });
  assert.equal(n, 1, '永久錯誤只試一次');
  assert.equal(out.results[0].status, 'failed');
  var out2 = await M.runExportBatch([{ id: 2, name: 'a.wav', format: 'mp3' }], {
    minutes: 'whole', runStep: async function () { return { path: 'p', sizeBytes: 0 }; },
    verify: async function () { return { ok: false, detail: '檔案大小為 0' }; }
  });
  assert.equal(out2.results[0].status, 'failed');
  assert.ok(/大小為 0/.test(out2.results[0].reason));
});

t('批次：取消後剩下的檔案標示 cancelled，且不再執行', async function () {
  var ran = [], cancelled = false;
  var out = await M.runExportBatch([{ id: 1, name: 'a.wav', format: 'mp3' }, { id: 2, name: 'b.wav', format: 'mp3' }], {
    minutes: 'whole', isCancelled: function () { return cancelled; },
    runStep: async function (ctx) { ran.push(ctx.item.id); cancelled = true; return { path: 'p', sizeBytes: 1 }; }
  });
  assert.deepEqual(ran, [1]);
  assert.equal(out.results[0].status, 'done');
  assert.equal(out.results[1].status, 'cancelled');
  assert.equal(out.summary.cancelled, 1);
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
