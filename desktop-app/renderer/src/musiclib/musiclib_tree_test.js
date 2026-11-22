/* 音樂庫的樹狀列、移除規則、旋律索引收錄規則的單元測試：node renderer/src/musiclib/musiclib_tree_test.js（不需要瀏覽器）。 */
'use strict';
var assert = require('assert');
var M = require('./musiclib_core.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

function rec(o) {
  return Object.assign({ key: 'k', sourceId: 'src1', path: 'C:\\m\\a.mid', name: 'a.mid', kind: 'mid', status: 'ok', pending: false, derivedFrom: null, derivedIndex: 0 }, o);
}
// 來源（rix 原始檔）＋它擷取出來的兩首 MIDI
function fixtureLib() {
  var src = rec({ key: 'S', sourceId: 'src1', path: 'D:\\game\\song.rix', name: 'song.rix', kind: 'rix', category: 'extract', pending: false });
  var c1 = rec({ key: 'derived|S|1', sourceId: 'src1', path: 'D:\\game\\音樂庫衍生檔\\song\\1.mid', name: '1.mid', kind: 'mid', derivedFrom: 'S', derivedIndex: 1 });
  var c0 = rec({ key: 'derived|S|0', sourceId: 'src1', path: 'D:\\game\\音樂庫衍生檔\\song\\0.mid', name: '0.mid', kind: 'mid', derivedFrom: 'S', derivedIndex: 0 });
  var other = rec({ key: 'O', sourceId: 'src2', path: 'D:\\music\\x.mp3', name: 'x.mp3', kind: 'mp3', category: 'audio' });
  return { sources: [{ id: 'src1', label: 'game', type: 'folder' }, { id: 'src2', label: 'music', type: 'folder' }], records: [src, c1, c0, other] };
}
function isDerivedDir(p) { return /音樂庫衍生檔[\\\/]/.test(p); }

// ───── 旋律索引收錄規則：來源 ROM 不收（舊版把 rix／nes 全拿去解碼，全部失敗）─────
t('旋律：來源 ROM（rix／nes／pce／sfc／swf）與 nsf 不收，且寫明原因', function () {
  ['rix', 'nes', 'pce', 'sfc', 'swf'].forEach(function (kind) {
    var r = M.melodyEligible(rec({ kind: kind, category: 'extract' }));
    assert.equal(r.ok, false, kind + ' 不應收錄');
    assert.ok(r.reason && r.reason.length > 0);
  });
  var nsf = M.melodyEligible(rec({ kind: 'nsf', category: 'game', derivedFrom: 'S' }));
  assert.equal(nsf.ok, false);
});
t('旋律：一般音樂檔收錄；擷取產物只收 MIDI', function () {
  assert.equal(M.melodyEligible(rec({ kind: 'mid' })).ok, true);
  assert.equal(M.melodyEligible(rec({ kind: 'mp3', category: 'audio' })).ok, true);
  assert.equal(M.melodyEligible(rec({ kind: 'mp4', category: 'video' })).ok, true);
  assert.equal(M.melodyEligible(rec({ kind: 'mid', derivedFrom: 'S' })).ok, true, '擷取出來的 MIDI 收錄');
  assert.equal(M.melodyEligible(rec({ kind: 'wav', category: 'audio', derivedFrom: 'S' })).ok, false, '擷取的 wav 不在這次的收錄範圍');
});
t('旋律：待擷取、已消失不收', function () {
  assert.equal(M.melodyEligible(rec({ pending: true })).ok, false);
  assert.equal(M.melodyEligible(rec({ status: 'missing' })).ok, false);
});

// ───── 樹狀列 ─────
t('樹：子曲目接在來源下面，依 derivedIndex 排序，縮排 depth 1', function () {
  var lib = fixtureLib();
  var rows = M.buildTreeRows(lib.records, { expanded: { S: true } });
  var keys = rows.map(function (x) { return x.rec.key + '@' + x.depth; });
  assert.deepEqual(keys, ['S@0', 'derived|S|0@1', 'derived|S|1@1', 'O@0']);
  assert.equal(rows[0].kidCount, 2);
  assert.equal(rows[0].expanded, true);
});
t('樹：沒展開時子曲目不出現', function () {
  var rows = M.buildTreeRows(fixtureLib().records, { expanded: {} });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].expanded, false);
});
t('樹：搜尋（forceExpand）自動展開來源', function () {
  var rows = M.buildTreeRows(fixtureLib().records, { forceExpand: true });
  assert.equal(rows.filter(function (x) { return x.depth === 1; }).length, 2);
});
t('樹：父已不在清單裡的擷取產物當頂層列並標 orphan', function () {
  var lib = fixtureLib();
  var rows = M.buildTreeRows(lib.records.filter(function (r) { return r.key !== 'S'; }), {});
  var orph = rows.filter(function (x) { return x.orphan; });
  assert.equal(orph.length, 2);
  assert.equal(orph[0].depth, 0);
});

// ───── 移除規則 ─────
t('移除：原始檔只從曲庫移除，絕不刪磁碟上的原始檔（plan 裡沒有原始檔路徑）', function () {
  var lib = fixtureLib();
  var plan = M.planRemove(lib, ['O'], { isDerivedPath: isDerivedDir });
  assert.deepEqual(plan.removeKeys, ['O']);
  assert.equal(plan.deleteFiles.length, 0, '原始檔不進刪檔清單');
  assert.equal(plan.originals, 1);
});
t('移除：來源預設連同擷取產物（子曲目記錄＋衍生檔都在計畫裡）', function () {
  var lib = fixtureLib();
  var plan = M.planRemove(lib, ['S'], { isDerivedPath: isDerivedDir });
  assert.deepEqual(plan.removeKeys.sort(), ['S', 'derived|S|0', 'derived|S|1'].sort());
  assert.equal(plan.deleteFiles.length, 2);
  plan.deleteFiles.forEach(function (d) { assert.ok(isDerivedDir(d.path)); });
  assert.ok(plan.deleteFiles.every(function (d) { return d.path !== 'D:\\game\\song.rix'; }), '原始 rix 不在刪檔清單');
});
t('移除：includeDerived=false 只拿掉來源，擷取產物留著成孤兒', function () {
  var lib = fixtureLib();
  var plan = M.planRemove(lib, ['S'], { includeDerived: false, isDerivedPath: isDerivedDir });
  assert.deepEqual(plan.removeKeys, ['S']);
  assert.equal(plan.orphanedDerived, 2);
  assert.equal(plan.deleteFiles.length, 0);
});
t('移除：衍生檔路徑不被認可時不刪檔（只移除記錄，寫明原因）', function () {
  var lib = fixtureLib();
  var plan = M.planRemove(lib, ['derived|S|1'], { isDerivedPath: function () { return false; } });
  assert.equal(plan.deleteFiles.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.ok(/不刪檔/.test(plan.skipped[0].reason));
  assert.deepEqual(plan.removeKeys, ['derived|S|1']);
});
t('移除：沒給 isDerivedPath 時一律不刪衍生檔（保守）', function () {
  var plan = M.planRemove(fixtureLib(), ['derived|S|1'], {});
  assert.equal(plan.deleteFiles.length, 0);
});
t('移除：衍生記錄的路徑若同時是原始檔路徑，絕不刪', function () {
  var lib = fixtureLib();
  lib.records.push(rec({ key: 'X', path: 'D:\\game\\音樂庫衍生檔\\song\\1.mid', name: '1.mid', kind: 'mid', sourceId: 'src2' }));
  var plan = M.planRemove(lib, ['derived|S|1'], { isDerivedPath: isDerivedDir });
  assert.equal(plan.deleteFiles.length, 0);
});
t('來源整個移除：planSourceRemove 收齊該來源的原始檔與擷取產物', function () {
  var lib = fixtureLib();
  var plan = M.planSourceRemove(lib, 'src1', { isDerivedPath: isDerivedDir });
  assert.equal(plan.sourceLabel, 'game');
  assert.deepEqual(plan.removeKeys.sort(), ['S', 'derived|S|0', 'derived|S|1'].sort());
});
t('套用移除：記錄與來源登記都拿掉；dropSource=false 時來源登記保留', function () {
  var lib = fixtureLib();
  var plan = M.planSourceRemove(lib, 'src1', { isDerivedPath: isDerivedDir });
  var r = M.applyRemove(lib, plan);
  assert.equal(r.removed, 3);
  assert.deepEqual(lib.records.map(function (x) { return x.key; }), ['O']);
  assert.deepEqual(lib.sources.map(function (s) { return s.id; }), ['src2']);
  var lib2 = fixtureLib();
  M.applyRemove(lib2, M.planSourceRemove(lib2, 'src1', { isDerivedPath: isDerivedDir }), { dropSource: false });
  assert.deepEqual(lib2.sources.map(function (s) { return s.id; }), ['src1', 'src2'], '來源登記還在');
});
t('套用移除：呼叫端指定 keys（衍生檔刪不掉的留著）', function () {
  var lib = fixtureLib();
  var plan = M.planRemove(lib, ['S'], { isDerivedPath: isDerivedDir });
  M.applyRemove(lib, plan, { keys: ['S', 'derived|S|0'], dropSource: false });
  assert.deepEqual(lib.records.map(function (x) { return x.key; }).sort(), ['O', 'derived|S|1'].sort());
  assert.equal(lib.sources.length, 2, '有留下東西就不拿掉來源登記');
});
t('lib 物件上的移除函式可用', function () {
  var lib = M.createLibrary(M.createMemoryBackend());
  lib.sources = fixtureLib().sources; lib.records = fixtureLib().records;
  var plan = lib.planRemove(['O'], {});
  assert.equal(plan.removeKeys[0], 'O');
  lib.applyRemove(plan);
  assert.equal(lib.records.length, 3);
});

(function run() {
  var pass = 0, failed = [];
  tests.forEach(function (x) {
    try { x.fn(); pass++; console.log('  通過  ' + x.name); }
    catch (e) { failed.push(x.name); console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
  });
  console.log('musiclib_tree 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
