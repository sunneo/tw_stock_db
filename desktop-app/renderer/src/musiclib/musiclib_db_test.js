/* 音樂庫資料庫的匯出／匯入（純函式）與旋律索引白話訊息的單元測試：node renderer/src/musiclib/musiclib_db_test.js（不需要瀏覽器）。 */
'use strict';
var assert = require('assert');
var M = require('./musiclib_core.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

function rec(o) {
  return Object.assign({ key: 'src1|D:\\m\\a.mp3', sourceId: 'src1', path: 'D:\\m\\a.mp3', name: 'a.mp3', kind: 'mp3', category: 'audio', label: 'MP3',
    pending: false, status: 'ok', sizeBytes: 100, mtimeMs: 500, title: 'a', album: null, durationSec: 5, lyricStatus: 'none', lyrics: null,
    melody: null, derivedFrom: null, derivedIndex: 0 }, o);
}
function sample() {
  var a = rec({ melody: { sig: '100:500', status: 'ok', method: 'mid', contour: [1, 2, 3] }, lyricStatus: 'done', lyrics: { segments: [{ start: 0, end: 1, text: '晴天' }] } });
  var b = rec({ key: 'src1|D:\\m\\b.mp3', path: 'D:\\m\\b.mp3', name: 'b.mp3', sizeBytes: 200, mtimeMs: 600 });
  var parent = rec({ key: 'src1|D:\\g\\s.rix', path: 'D:\\g\\s.rix', name: 's.rix', kind: 'rix', category: 'extract', label: 'RIX', sizeBytes: 10, mtimeMs: 1 });
  var kid = rec({ key: 'derived|src1|D:\\g\\s.rix|0', path: 'D:\\g\\音樂庫衍生檔\\s\\0.mid', name: '0.mid', kind: 'mid', derivedFrom: 'src1|D:\\g\\s.rix', derivedIndex: 0, sizeBytes: 30, mtimeMs: 7,
    melody: { sig: '30:7', status: 'ok', method: 'mid', contour: [4, 5] } });
  return { sources: [{ id: 'src1', type: 'folder', label: 'music', addedAt: 1, lastScanAt: 2 }], records: [a, b, parent, kid] };
}
// 假的檔案系統：path → { size, mtimeMs }；沒有的路徑回傳 null（檔案不存在）
function fsOf(map) { return function (p) { return map[p] || null; }; }
function allSame(recs) {
  var m = {};
  recs.forEach(function (r) { m[r.path] = { size: r.sizeBytes, mtimeMs: r.mtimeMs }; });
  return fsOf(m);
}
function libOf(data) { var lib = M.createLibrary(M.createMemoryBackend()); lib.sources = data.sources; lib.records = data.records; return lib; }

t('往返一致：匯出成 JSON 字串、讀回、取代匯入後，來源、紀錄、旋律索引、歌詞、衍生關係都一樣', function () {
  var s = sample();
  var json = JSON.stringify(M.exportDb(libOf(s), { now: '2026-11-25T00:00:00.000Z' }));
  var data = JSON.parse(json);
  assert.equal(data.format, M.DB_FORMAT);
  assert.equal(data.version, 1);
  var empty = libOf({ sources: [], records: [] });
  var plan = M.planImport(empty, data, { mode: 'replace', statOf: allSame(s.records) });
  assert.equal(plan.ok, true, plan.error);
  M.applyImport(empty, plan);
  assert.deepEqual(empty.sources, s.sources);
  assert.deepEqual(empty.records, s.records);
  var kid = empty.records.filter(function (r) { return r.derivedFrom; })[0];
  assert.equal(kid.derivedFrom, 'src1|D:\\g\\s.rix', '衍生關係保留');
  assert.ok(kid.melody && kid.melody.status === 'ok', '子曲目的旋律索引保留');
});

t('合併：路徑相同的不重複，只補上新的；來源依 type＋label 對到現有來源', function () {
  var s = sample();
  var cur = libOf({ sources: [{ id: 'X1', type: 'folder', label: 'music', addedAt: 9, lastScanAt: 9 }], records: [rec({ key: 'X1|D:\\m\\a.mp3', sourceId: 'X1', path: 'D:\\m\\a.mp3', sizeBytes: 100, mtimeMs: 500 })] });
  var plan = M.planImport(cur, JSON.parse(JSON.stringify(M.exportDb(libOf(s)))), { mode: 'merge', statOf: allSame(s.records) });
  assert.equal(plan.ok, true, plan.error);
  M.applyImport(cur, plan);
  assert.equal(cur.sources.length, 1, '同 type＋label 的來源不重複登記');
  var paths = cur.records.map(function (r) { return r.path; });
  assert.equal(paths.filter(function (p) { return p === 'D:\\m\\a.mp3'; }).length, 1, 'a.mp3 只有一筆');
  assert.equal(plan.stats.matched, 1);
  assert.equal(cur.records.length, 4, '原 1 筆 + 匯入新增 3 筆');
  var a = cur.records.filter(function (r) { return r.path === 'D:\\m\\a.mp3'; })[0];
  assert.ok(a.melody && a.melody.status === 'ok', '現有紀錄沒有索引、匯入的 sig 相同，所以補上索引');
  var kid = cur.records.filter(function (r) { return r.derivedFrom; })[0];
  assert.equal(kid.derivedFrom, 'X1|D:\\g\\s.rix', '衍生關係改指向對應到的新 key');
});

t('合併：同一批匯入兩次結果一樣（冪等）', function () {
  var s = sample(), cur = libOf({ sources: [], records: [] });
  var data = JSON.parse(JSON.stringify(M.exportDb(libOf(s))));
  M.applyImport(cur, M.planImport(cur, data, { mode: 'merge', statOf: allSame(s.records) }));
  var n1 = cur.records.length;
  M.applyImport(cur, M.planImport(cur, data, { mode: 'merge', statOf: allSame(s.records) }));
  assert.equal(cur.records.length, n1, '再匯入一次不新增');
});

t('sig 不同：紀錄保留、標為索引過期，索引與歌詞不沿用', function () {
  var s = sample();
  var data = JSON.parse(JSON.stringify(M.exportDb(libOf(s))));
  var fs = allSame(s.records);
  var changed = function (p) { var st = fs(p); return p === 'D:\\m\\a.mp3' ? { size: 999, mtimeMs: 500 } : st; };
  var empty = libOf({ sources: [], records: [] });
  var plan = M.planImport(empty, data, { mode: 'replace', statOf: changed });
  M.applyImport(empty, plan);
  var a = empty.records.filter(function (r) { return r.path === 'D:\\m\\a.mp3'; })[0];
  assert.equal(a.indexStale, true, '標為索引過期');
  assert.equal(a.status, 'ok');
  assert.equal(a.melody, null, '過期的旋律索引不沿用');
  assert.equal(a.lyrics, null, '過期的歌詞不沿用');
  assert.equal(plan.stats.indexStale, 1);
  var b = empty.records.filter(function (r) { return r.path === 'D:\\m\\b.mp3'; })[0];
  assert.ok(!b.indexStale, '其他檔案不受影響');
});

t('路徑不存在：匯入後狀態為 missing，資料保留', function () {
  var s = sample();
  var data = JSON.parse(JSON.stringify(M.exportDb(libOf(s))));
  var empty = libOf({ sources: [], records: [] });
  var plan = M.planImport(empty, data, { mode: 'replace', statOf: function () { return null; } });
  M.applyImport(empty, plan);
  assert.equal(plan.stats.missing, 4);
  assert.ok(empty.records.every(function (r) { return r.status === 'missing'; }));
  var a = empty.records.filter(function (r) { return r.path === 'D:\\m\\a.mp3'; })[0];
  assert.equal(a.lyrics.segments[0].text, '晴天', '歌詞保留');
  assert.equal(a.melody.status, 'ok', '旋律索引保留');
});

t('壞檔不動資料：格式錯、版本不認得、JSON 結構壞掉都回傳錯誤，現有資料完全不變', function () {
  var s = sample(), cur = libOf(s);
  var before = JSON.stringify({ s: cur.sources, r: cur.records });
  var bad = [
    null, 'x', [],
    { format: 'other', version: 1, sources: [], records: [] },
    { format: M.DB_FORMAT, sources: [], records: [] },
    { format: M.DB_FORMAT, version: 1, sources: 'x', records: [] },
    { format: M.DB_FORMAT, version: 1, sources: [], records: [{ key: 'k', path: 3, sourceId: 's' }] }
  ];
  bad.forEach(function (d) {
    var plan = M.planImport(cur, d, { mode: 'merge', statOf: allSame(s.records) });
    assert.equal(plan.ok, false, '應該拒絕：' + JSON.stringify(d));
    assert.ok(plan.error && plan.error.length > 0);
  });
  assert.equal(JSON.stringify({ s: cur.sources, r: cur.records }), before, '現有資料沒有被改');
});

t('版本不符：比這個 app 新的版本明確報錯', function () {
  var plan = M.planImport(libOf({ sources: [], records: [] }), { format: M.DB_FORMAT, version: M.VERSION + 5, sources: [], records: [] }, {});
  assert.equal(plan.ok, false);
  assert.ok(/版本/.test(plan.error) && /更新/.test(plan.error), plan.error);
});

t('取代全部：現有資料被換掉（匯入的就是全部）', function () {
  var cur = libOf(sample());
  var data = { format: M.DB_FORMAT, version: 1, sources: [{ id: 'Z', type: 'file', label: 'one' }], records: [rec({ key: 'Z|D:\\x\\one.mp3', sourceId: 'Z', path: 'D:\\x\\one.mp3', name: 'one.mp3' })] };
  var plan = M.planImport(cur, data, { mode: 'replace', statOf: function () { return { size: 100, mtimeMs: 500 }; } });
  M.applyImport(cur, plan);
  assert.equal(cur.records.length, 1);
  assert.equal(cur.records[0].path, 'D:\\x\\one.mp3');
  assert.equal(cur.sources.length, 1);
});

t('白話訊息：數字動態，沒有的類別不顯示', function () {
  var msg = M.describeMelodySummary({ done: 3, skipped: 86, failed: 0, cancelled: 0 }, { source: 86, mp3: 86, wav: 86, other: 0 });
  assert.ok(/新建 3 首、已建過沿用 86 首、失敗 0 首/.test(msg), msg);
  assert.ok(/另有 258 筆不需要建/.test(msg), msg);
  assert.ok(/遊戲原始檔 86 個（請看它擷取出來的 MIDI）/.test(msg), msg);
  assert.ok(/mp3 86 個 與 wav 86 個|mp3 86 個與 wav 86 個/.test(msg) || /mp3 86 個 與 wav 86 個/.test(msg) || /mp3 86 個.*wav 86 個/.test(msg), msg);
  assert.ok(!/其他/.test(msg), '沒有其他類別就不顯示');
  assert.ok(!/失敗的有/.test(msg), '沒有失敗就不列');
  assert.ok(!/內部詞|不建索引（/.test(msg));
  var only = M.describeMelodySummary({ done: 0, skipped: 0, failed: 0, cancelled: 0 }, { mp3: 2 });
  assert.ok(/擷取出的 mp3 2 個（跟同一首/.test(only), only);
  assert.ok(!/wav/.test(only), '沒有 wav 就不提 wav');
});

t('白話訊息：失敗列出前幾筆檔名與原因，超過的寫「另 N 筆」', function () {
  var fails = [];
  for (var i = 1; i <= 7; i++) fails.push({ name: 'f' + i + '.mid', reason: '解析失敗' + i });
  var msg = M.describeMelodySummary({ done: 0, skipped: 0, failed: 7, cancelled: 0, failures: fails }, {});
  assert.ok(/失敗的有：f1\.mid（解析失敗1）/.test(msg), msg);
  assert.ok(/f5\.mid（解析失敗5）/.test(msg) && !/f6\.mid/.test(msg), '只列前 5 筆');
  assert.ok(/另 2 筆/.test(msg), msg);
});

t('melodyGroup 分類：來源檔、擷取出的 mp3、wav、其他', function () {
  assert.equal(M.melodyGroup(rec({ kind: 'rix', category: 'extract', pending: false })), 'source');
  assert.equal(M.melodyGroup(rec({ kind: 'mp3', category: 'audio', derivedFrom: 'S' })), 'mp3');
  assert.equal(M.melodyGroup(rec({ kind: 'wav', category: 'audio', derivedFrom: 'S' })), 'wav');
  assert.equal(M.melodyGroup(rec({ kind: 'mid', derivedFrom: 'S' })), 'other');
});

(function run() {
  var pass = 0, failed = [];
  tests.forEach(function (x) {
    try { x.fn(); pass++; console.log('  通過  ' + x.name); }
    catch (e) { failed.push(x.name); console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
  });
  console.log('musiclib_db 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
