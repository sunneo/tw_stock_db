// MIDI 編輯器的「📂 開啟 .mid」：一個 .mid 檔 → 一首曲子（FaMidi 的 song），給 host 開成新的編輯器卡片。
// 純函式（依賴 midi_core.js 的 FaMidi），node 與瀏覽器都能跑。測試：scripts/edit-tests/midi_open.test.js。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./midi_core.js'));
  else root.FaMidiOpen = factory(root.FaMidi || (typeof FaMidi !== 'undefined' ? FaMidi : undefined));
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  var MIDI_EXT = /\.midi?$/i, MAX_BYTES = 2000000;
  var TYPES = [{ description: 'MIDI 檔', accept: { 'audio/midi': ['.mid', '.midi'] } }];

  // bytes（Uint8Array 或 ArrayBuffer）＋檔名 → { song, title }。不是 MIDI 或太大就丟錯。
  function fromFile(bytes, name) {
    if (!MIDI_EXT.test(String(name || ''))) { throw new Error('這不是 .mid 檔'); }
    var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u.length > MAX_BYTES) { throw new Error('MIDI 檔太大（超過 ' + Math.round(MAX_BYTES / 1000) + ' KB）'); }
    var song;
    try { song = M.parse(u); } catch (e) { throw new Error('讀不了這個 MIDI 檔：' + String((e && e.message) || e)); }
    var title = String(name || '').replace(/\.[^.]+$/, '').slice(0, 80) || song.title || 'MIDI';
    return { song: song, title: title };
  }

  return { fromFile: fromFile, TYPES: TYPES, MAX_BYTES: MAX_BYTES, MIDI_EXT: MIDI_EXT };
});
