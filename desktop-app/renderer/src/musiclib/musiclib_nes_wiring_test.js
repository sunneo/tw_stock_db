/* NES 擷取接進曲庫的單元測試（種類、子曲目登記、不能掃成 NSF）：node renderer/src/musiclib/musiclib_nes_wiring_test.js */
'use strict';
var assert = require('assert');
var M = require('./musiclib_core.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }
function cat(parts) {
  var out = [];
  parts.forEach(function (p) {
    if (typeof p === 'string') for (var i = 0; i < p.length; i++) out.push(p.charCodeAt(i));
    else out.push(p);
  });
  return Uint8Array.from(out);
}

t('種類：.nes（iNES 檔頭）是可擷取的來源，不再是待擷取', function () {
  var r = M.identifyKind('zelda.nes', cat(['NES\u001a', 1, 2]));
  assert.equal(r.kind, 'nes'); assert.equal(r.category, 'extract'); assert.equal(r.pending, false);
  assert.equal(r.label, 'NES 遊戲音樂，可擷取');
});

t('種類：NSF 只能由擷取產生，不會被掃描成來源（副檔名 .nsf 不認得）', function () {
  assert.equal(M.isSupportedName('song.nsf'), false);
  assert.equal(M.identifyKind('song.nsf', null), null);
  assert.equal(M.KINDS.nsf.category, 'game', 'nsf 的種類表項目只給子曲目用');
});

t('路由：NES 來源要先擷取；PCE／SFC 仍是待擷取（沒有擷取器）', function () {
  var nes = M.planExport('mario.nes', 'mid');
  assert.equal(nes.ok, false); assert.ok(/擷取/.test(nes.reason), nes.reason);
  var pce = M.planExport('x.pce', 'mid');
  assert.equal(pce.ok, false); assert.ok(/擷取/.test(pce.reason), pce.reason);
  var sfc = M.planExport('x.sfc', 'mid');
  assert.equal(sfc.ok, false); assert.ok(/尚未支援/.test(sfc.reason), sfc.reason);
});

t('子曲目登記：NSF／MIDI／wav／mp3 都是普通記錄（kind 與類別對得上），記著來源與擷取方式', function () {
  var parent = { key: 'src|1', sourceId: 's1', sourceType: 'folder', sourceLabel: 'Game', path: 'D:/Roms/game.nes', name: 'game.nes', album: 'Game' };
  var kinds = ['nsf', 'mid', 'wav', 'mp3'];
  var recs = kinds.map(function (k, i) {
    return M.buildDerivedRecord(parent, { index: i, kind: k, path: 'D:/out/game.' + k, sizeBytes: 10, method: 'NES（jsnes）', durationSec: 3, title: 'game' }, 5);
  });
  recs.forEach(function (r, i) {
    assert.equal(r.kind, kinds[i]); assert.equal(r.pending, false); assert.equal(r.derivedFrom, 'src|1'); assert.equal(r.derivedIndex, i);
    assert.equal(r.derivedMethod, 'NES（jsnes）'); assert.equal(r.via, 'extract'); assert.equal(r.status, 'ok');
  });
  assert.equal(recs[0].category, 'game', 'NSF 不是音訊，不混進歌詞佇列');
  assert.equal(recs[1].category, 'audio'); assert.equal(recs[3].category, 'audio');
});

t('子曲目登記：重新擷取時先換掉舊子曲目，不重複；其他來源的子曲目不受影響', function () {
  var lib = { records: [
    { key: 'a', derivedFrom: null }, { key: 'a1', derivedFrom: 'a' }, { key: 'a2', derivedFrom: 'a' },
    { key: 'b1', derivedFrom: 'b' }
  ] };
  var n = M.replaceDerived(lib, 'a', [{ key: 'a3', derivedFrom: 'a' }]);
  assert.equal(n, 3);
  assert.deepEqual(lib.records.map(function (r) { return r.key; }).sort(), ['a', 'a3', 'b1']);
});

t('歌詞佇列：擷取來源（NES）與待擷取來源都不進佇列；子曲目 mid／mp3 會進', function () {
  var nes = { status: 'ok', pending: false, category: 'extract', kind: 'nes' };
  var pce = { status: 'ok', pending: false, category: 'extract', kind: 'pce' };
  var mp3 = { status: 'ok', pending: false, category: 'audio', kind: 'mp3' };
  assert.equal(M.isSourceOnly(nes), true);
  assert.equal(M.isSourceOnly(pce), true);
  assert.equal(M.isSourceOnly(mp3), false);
});

// ───── 執行 ─────
(function () {
  var pass = 0, failed = [];
  tests.forEach(function (x) {
    try { x.fn(); pass++; console.log('  通過  ' + x.name); }
    catch (e) { failed.push(x.name); console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
  });
  console.log('musiclib NES 曲庫接線測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
