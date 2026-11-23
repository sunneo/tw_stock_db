/* 音樂庫的 md5 指紋：重複檔、搬家後的批次對應、匯入時以 md5 配對（純函式，假資料，不碰檔案系統）。
 * 執行：node renderer/src/musiclib/musiclib_relocate_test.js */
'use strict';
var assert = require('assert');
var crypto = require('crypto');
var M = require('./musiclib_core.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }
function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }

// 一筆紀錄（舊或新）：sourceId＋路徑當 key，md5 整檔，sig 與 md5Sig 一致
function mkRec(o) {
  var r = Object.assign({ key: o.sourceId + '|' + o.path, sourceId: 'old', sourceType: 'folder', sourceLabel: 'old', path: '', name: '', ext: '', kind: 'mp3',
    category: 'audio', label: 'MP3', pending: false, status: 'ok', sizeBytes: 100, mtimeMs: 500, title: '', album: null, durationSec: 3,
    lyricStatus: 'none', lyrics: null, melody: null, derivedFrom: null, derivedIndex: 0, md5: null, hashKind: null, md5Sig: null }, o);
  if (!r.name) r.name = r.path.split('\\').pop();
  if (!r.md5) { r.md5 = md5(o.content || r.path); r.hashKind = 'md5-full'; r.md5Sig = r.sizeBytes + ':' + r.mtimeMs; }
  return r;
}
function libWith(records, sources) { var lib = M.createLibrary(M.createMemoryBackend()); lib.records = records; lib.sources = sources || [{ id: 'old', type: 'folder', label: 'old' }]; return lib; }

// 30 筆舊紀錄：2 個來源（rix 原始檔）＋ 5 個擷取子曲目 ＋ 3 組同內容重複檔（共 6 筆）＋ 17 筆一般檔案
function scenario() {
  var recs = [], i;
  var rixA = mkRec({ path: 'D:\\old\\games\\alpha.rix', kind: 'rix', category: 'extract', label: 'RIX', content: 'ROM-A' });
  var rixB = mkRec({ path: 'D:\\old\\games\\beta.rix', kind: 'rix', category: 'extract', label: 'RIX', content: 'ROM-B' });
  recs.push(rixA, rixB);
  for (i = 0; i < 5; i++) {
    var parent = i < 3 ? rixA : rixB;
    recs.push(mkRec({ path: 'D:\\old\\games\\音樂庫衍生檔\\' + (i < 3 ? 'alpha' : 'beta') + '\\' + i + '.mid', kind: 'mid', category: 'audio', label: 'MID',
      derivedFrom: parent.key, derivedIndex: i, derivedMethod: 'RIX→MIDI', content: 'kid' + i,
      melody: i < 2 ? { sig: '100:500', status: 'ok', method: 'mid', contour: [1, 2, 3] } : null }));
  }
  // 重複檔：同內容、不同資料夾（三組：各 2 或 3 份）
  ['dupA', 'dupB', 'dupC'].forEach(function (g, gi) {
    var copies = 2;
    for (var c = 0; c < copies; c++) recs.push(mkRec({ path: 'D:\\old\\' + g + '\\' + 'copy' + c + '\\same' + gi + '.mp3', content: 'DUP' + gi, name: 'same' + gi + '.mp3' }));
  });
  var lyricRec = null;
  for (i = 0; i < 17; i++) {
    var r = mkRec({ path: 'D:\\old\\music\\album' + (i % 4) + '\\track' + i + '.mp3', content: 'song' + i });
    if (i === 3) { r.lyrics = { segments: [{ start: 0, end: 1, text: '晴天' }] }; r.lyricStatus = 'done'; lyricRec = r; }
    recs.push(r);
  }
  assert.equal(recs.length, 30, '場景應該剛好 30 筆');
  // 舊資料夾已經不在了：舊紀錄都是「消失」狀態（搬家前已經算過整檔 md5）
  recs.forEach(function (r) { r.status = 'missing'; });
  return { recs: recs, lyricRec: lyricRec, rixA: rixA, rixB: rixB };
}
// 搬到全新的資料夾結構（改名、改層級），新掃到的紀錄也算好 md5；有一首故意不放（少一個檔案）
function relayout(s, opts) {
  opts = opts || {};
  var news = [], keys = {};
  s.recs.forEach(function (o, idx) {
    if (opts.skipIndex === idx) return;   // 少放一個
    var p = o.path.replace('D:\\old\\', 'E:\\新整理\\第一層\\').replace('音樂庫衍生檔', '擷取');
    if (o.kind === 'rix') { p = p.replace('games', '遊戲'); }
    if (o.name.indexOf('same') === 0) p = p; // 重複檔保留原檔名
    var n = mkRec({ sourceId: 'new', sourceType: 'folder', sourceLabel: 'new', path: p, content: o.content, sizeBytes: o.sizeBytes, mtimeMs: 900 + idx });
    news.push(n); keys[n.key] = true;
  });
  return { news: news, keys: keys };
}

t('md5 配對：30 筆重整（含 3 組重複檔、5 個衍生子曲目、2 個有旋律索引、1 個有歌詞），至少 28 筆正確對應', function () {
  var s = scenario();
  var lib = libWith(s.recs.slice());
  var r = relayout(s, { skipIndex: 29 });   // 最後一筆（一般檔案）沒放
  lib.records = lib.records.concat(r.news);
  lib.sources.push({ id: 'new', type: 'folder', label: 'new' });
  var plan = M.planRelocation(lib, { newKeys: r.keys });
  M.applyRelocation(lib, plan);
  assert.ok(plan.moves.length >= 28, '正確對應 ' + plan.moves.length + ' 個（需要 ≥ 28）');
  assert.equal(plan.moves.length, 29, '應該正好 29（少放的那一個另外算）');
  assert.equal(plan.notFound.length, 1, '少放的那一筆回報找不到');
  assert.equal(plan.ambiguous.length, 0, '這個情境不應該有歧義');
  // 套用後：29 筆舊紀錄都指向新路徑、狀態 ok；少放的那筆還是消失；新掃到的重複紀錄都被併掉
  var relocated = lib.records.filter(function (x) { return x.path.indexOf('新整理') >= 0 && x.status === 'ok'; });
  assert.equal(relocated.length, 29, '套用後指向新路徑的紀錄數');
  assert.equal(lib.records.filter(function (x) { return x.status === 'missing'; }).length, 1, '少放的那一筆仍是消失');
  assert.equal(lib.records.length, 30, '沒有多出重複紀錄（29 個配上的新紀錄被併掉、1 個新的沒有）');
});

t('md5 配對：索引、歌詞、衍生關係完整保留（子曲目改指向新的來源 key）', function () {
  var s = scenario();
  var lib = libWith(s.recs.slice());
  var r = relayout(s, { skipIndex: 29 });
  lib.records = lib.records.concat(r.news); lib.sources.push({ id: 'new', type: 'folder', label: 'new' });
  M.applyRelocation(lib, M.planRelocation(lib, { newKeys: r.keys }));
  var kids = lib.records.filter(function (x) { return x.derivedFrom; });
  assert.equal(kids.length, 5, '5 個衍生子曲目都還在');
  kids.forEach(function (k) { assert.ok(lib.records.some(function (p) { return p.key === k.derivedFrom; }), '子曲目的父紀錄找得到：' + k.path); });
  assert.equal(kids.filter(function (k) { return k.melody && k.melody.status === 'ok'; }).length, 2, '2 個旋律索引保留');
  var lyr = lib.records.filter(function (x) { return x.lyrics && x.lyrics.segments && x.lyrics.segments[0].text === '晴天'; });
  assert.equal(lyr.length, 1, '歌詞保留');
  assert.equal(lyr[0].status, 'ok');
  assert.ok(lyr[0].path.indexOf('新整理') >= 0, '歌詞那筆已經指向新路徑');
  assert.ok(lib.records.every(function (x) { return x.status === 'ok' || x.status === 'missing'; }));
});

t('md5 配對：重複檔沒有交叉錯配（每組的每一份都配到同一組、路徑結構相近的那份）', function () {
  var s = scenario();
  var lib = libWith(s.recs.slice());
  var r = relayout(s, { skipIndex: 29 });
  lib.records = lib.records.concat(r.news); lib.sources.push({ id: 'new', type: 'folder', label: 'new' });
  var plan = M.planRelocation(lib, { newKeys: r.keys });
  plan.moves.forEach(function (m) {
    assert.equal(m.old.md5, m.neu.md5, '配對的兩個檔案 md5 必須相同');
    // 重複檔：舊路徑的「資料夾\檔名」結構（dupA\copyN\same0.mp3）要對到新的同名同結構檔（…\dupA\copyN\same0.mp3）
    if (m.old.name.indexOf('same') === 0) {
      assert.equal(m.old.path.split('\\').slice(-3).join('\\'), m.neu.path.split('\\').slice(-3).join('\\'), '重複檔交叉錯配：' + m.old.path + ' ↔ ' + m.neu.path);
    }
  });
  var dupMoves = plan.moves.filter(function (m) { return m.old.name.indexOf('same') === 0; });
  assert.equal(dupMoves.length, 6, '6 份重複檔（3 組各 2 份）都配到');
});

t('不會把兩筆舊紀錄指向同一個新檔案；套用後沒有兩筆紀錄路徑相同', function () {
  var s = scenario();
  var lib = libWith(s.recs.slice());
  var r = relayout(s, { skipIndex: 29 });
  lib.records = lib.records.concat(r.news); lib.sources.push({ id: 'new', type: 'folder', label: 'new' });
  var plan = M.planRelocation(lib, { newKeys: r.keys });
  var seen = {};
  plan.moves.forEach(function (m) { assert.ok(!seen[m.neu.key], '新檔案被配了兩次：' + m.neu.path); seen[m.neu.key] = true; });
  M.applyRelocation(lib, plan);
  var paths = {};
  lib.records.forEach(function (x) { assert.ok(!paths[x.path], '路徑重複：' + x.path); paths[x.path] = true; });
});

t('同內容、同結構的兩份分不出來：列為歧義，不亂配', function () {
  var a = mkRec({ path: 'D:\\old\\x\\dup.mp3', content: 'SAME' });
  var b = mkRec({ path: 'D:\\old\\y\\dup.mp3', content: 'SAME' });
  var n1 = mkRec({ sourceId: 'new', sourceLabel: 'new', path: 'E:\\new\\p\\dup.mp3', content: 'SAME' });
  var n2 = mkRec({ sourceId: 'new', sourceLabel: 'new', path: 'E:\\new\\q\\dup.mp3', content: 'SAME' });
  // a、b 的最後兩層（x\dup.mp3、y\dup.mp3）都跟 n1、n2 對不上 → 相近度 +1 都一樣 → 歧義
  var lib = libWith([a, b, n1, n2]);
  lib.sources.push({ id: 'new', type: 'folder', label: 'new' });
  a.status = 'missing'; b.status = 'missing';
  var plan = M.planRelocation(lib, { newKeys: { [n1.key]: true, [n2.key]: true } });
  assert.equal(plan.moves.length, 0, '分不出來就不配');
  assert.equal(plan.ambiguous.length, 2, '兩筆都列為歧義');
  M.applyRelocation(lib, plan);
  assert.equal(lib.records.length, 4, '沒有任何紀錄被動到');
  assert.ok(a.status === 'missing' && b.status === 'missing');
});

t('少放一個檔案：那筆回報為找不到，不亂配給別的檔案', function () {
  var a = mkRec({ path: 'D:\\old\\m\\only.mp3', content: 'ONLY' });
  var other = mkRec({ sourceId: 'new', sourceLabel: 'new', path: 'E:\\new\\m\\other.mp3', content: 'OTHER' });
  a.status = 'missing';
  var lib = libWith([a, other]);
  var plan = M.planRelocation(lib, { newKeys: { [other.key]: true } });
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.notFound.length, 1);
  assert.equal(plan.notFound[0].name, 'only.mp3');
  assert.ok(/找不到：only\.mp3/.test(M.describeRelocation(plan)), M.describeRelocation(plan));
});

t('沒有整檔 md5 的舊紀錄（近似 md5 或沒算過）無法對應，摘要明講', function () {
  var head = mkRec({ path: 'D:\\old\\h\\big.mp4', content: 'BIG' });
  head.hashKind = 'md5-head4M+size';
  head.status = 'missing';
  var none = mkRec({ path: 'D:\\old\\h\\none.mp4', content: 'NONE' });
  none.md5 = null; none.hashKind = null; none.status = 'missing';
  var nn = mkRec({ sourceId: 'new', sourceLabel: 'new', path: 'E:\\new\\h\\big.mp4', content: 'BIG' });
  var lib = libWith([head, none, nn]);
  var plan = M.planRelocation(lib, { newKeys: { [nn.key]: true } });
  assert.equal(plan.moves.length, 0, '近似的 md5 不拿來配');
  assert.equal(plan.noMd5.length, 2, '兩筆都算不了');
  var msg = M.describeRelocation(plan);
  assert.ok(/2 個因為搬家前沒算過 md5/.test(msg), msg);
});

t('needsHash：沒有整檔 md5、sig 變了、近似 md5 都要重算；sig 沒變的不重算；消失的不算', function () {
  var ok = mkRec({ path: 'D:\\a.mp3' });
  assert.equal(M.needsHash(ok), false, '整檔 md5 且 sig 沒變：不重算');
  var changed = mkRec({ path: 'D:\\b.mp3' }); changed.mtimeMs = 777;
  assert.equal(M.needsHash(changed), true, 'sig 變了要重算');
  var approx = mkRec({ path: 'D:\\c.mp3' }); approx.hashKind = 'md5-head4M+size';
  assert.equal(M.needsHash(approx), true, '近似 md5 要在 app 更新後重算成整檔');
  var none = mkRec({ path: 'D:\\d.mp3' }); none.md5 = null; none.hashKind = null;
  assert.equal(M.needsHash(none), true);
  var gone = mkRec({ path: 'D:\\e.mp3' }); gone.md5 = null; gone.status = 'missing';
  assert.equal(M.needsHash(gone), false, '已經消失的不算');
  var rix = mkRec({ path: 'D:\\f.rix', pending: true, md5: null, hashKind: null });
  assert.equal(M.needsHash(rix), false, '待擷取的來源不算');
});

t('重複檔群組：同 md5 兩筆以上才列；消失的不算；近似 md5 不算', function () {
  var a = mkRec({ path: 'D:\\x\\1.mp3', content: 'D' }), b = mkRec({ path: 'D:\\y\\1.mp3', content: 'D' });
  var c = mkRec({ path: 'D:\\z\\2.mp3', content: 'E' });
  var gone = mkRec({ path: 'D:\\w\\1.mp3', content: 'D', status: 'missing' });
  var groups = M.duplicateGroups([a, b, c, gone]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].recs.length, 2);
  var keys = M.duplicateKeys([a, b, c, gone]);
  assert.ok(keys[a.key] && keys[b.key] && !keys[c.key] && !keys[gone.key], '只有兩份存在的那兩筆標記重複');
  var h1 = mkRec({ path: 'D:\\p\\h.mp3', content: 'H' }); h1.hashKind = 'md5-head4M+size';
  var h2 = mkRec({ path: 'D:\\q\\h.mp3', content: 'H' }); h2.hashKind = 'md5-head4M+size';
  assert.equal(M.duplicateGroups([h1, h2]).length, 0, '近似 md5 不算重複');
});

t('搬家後舊來源沒有紀錄就拿掉；新來源保留（不留空殼來源）', function () {
  var a = mkRec({ path: 'D:\\old\\s\\a.mp3', content: 'A' }); a.status = 'missing';
  var nn = mkRec({ sourceId: 'new', sourceLabel: 'new', path: 'E:\\new\\a.mp3', content: 'A' });
  var lib = libWith([a, nn], [{ id: 'old', type: 'folder', label: 'old' }, { id: 'new', type: 'folder', label: 'new' }]);
  M.applyRelocation(lib, M.planRelocation(lib, { newKeys: { [nn.key]: true } }));
  assert.deepEqual(lib.sources.map(function (s) { return s.id; }), ['new']);
  assert.equal(lib.records.length, 1);
  assert.equal(lib.records[0].path, 'E:\\new\\a.mp3');
  assert.equal(lib.records[0].sourceId, 'new');
});

t('匯入：路徑不同但 md5 相同 → 同一個檔案，沿用曲庫裡那筆的路徑，並補上索引與歌詞，不新增重複紀錄', function () {
  var local = mkRec({ path: 'F:\\現在的位置\\song.mp3', content: 'SONG', sourceId: 'L', sourceLabel: 'L' });
  var lib = libWith([local], [{ id: 'L', type: 'folder', label: 'L' }]);
  var imported = mkRec({ path: 'D:\\以前的位置\\song.mp3', content: 'SONG', sourceId: 'X', sourceLabel: 'X', melody: { sig: 's', status: 'ok', method: 'mid', contour: [5] }, lyrics: { segments: [{ start: 0, end: 1, text: '歌詞' }] }, lyricStatus: 'done' });
  var data = { format: M.DB_FORMAT, version: M.VERSION, sources: [{ id: 'X', type: 'folder', label: 'X' }], records: [imported] };
  var plan = M.planImport(lib, data, { mode: 'merge', statOf: function () { return null; } });
  assert.equal(plan.ok, true, plan.error);
  M.applyImport(lib, plan);
  assert.equal(lib.records.length, 1, '不新增重複紀錄');
  assert.equal(lib.records[0].path, 'F:\\現在的位置\\song.mp3', '路徑是曲庫裡實際的路徑');
  assert.ok(lib.records[0].melody && lib.records[0].melody.status === 'ok', '沿用匯入的旋律索引');
  assert.equal(lib.records[0].lyrics.segments[0].text, '歌詞', '沿用匯入的歌詞');
  assert.equal(plan.stats.matchedByMd5, 1);
});

t('匯入：同 md5 在曲庫有兩筆（分不出來）→ 不亂配，當成新紀錄', function () {
  var l1 = mkRec({ path: 'F:\\a\\song.mp3', content: 'SONG' }), l2 = mkRec({ path: 'F:\\b\\song.mp3', content: 'SONG' });
  var lib = libWith([l1, l2]);
  var imported = mkRec({ path: 'D:\\old\\song.mp3', content: 'SONG', sourceId: 'X', sourceLabel: 'X' });
  var data = { format: M.DB_FORMAT, version: M.VERSION, sources: [{ id: 'X', type: 'folder', label: 'X' }], records: [imported] };
  var plan = M.planImport(lib, data, { mode: 'merge', statOf: function () { return null; } });
  M.applyImport(lib, plan);
  assert.equal(lib.records.length, 3, '分不出來就新增，不擅自歸到其中一筆');
  assert.equal(plan.stats.matchedByMd5, 0);
});

(function run() {
  var pass = 0, failed = [];
  tests.forEach(function (x) {
    try { x.fn(); pass++; console.log('  通過  ' + x.name); }
    catch (e) { failed.push(x.name); console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
  });
  console.log('musiclib_relocate 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
