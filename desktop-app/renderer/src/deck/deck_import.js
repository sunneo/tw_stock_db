// /edit-media-presentation 的「📂 開啟簡報」：編輯器自己的簡報 YAML（.deck.yaml）→ 文件，取代目前內容（可復原）。
// 讀取器用 FaDeckEdit.fromYaml（跟「📥 另存」匯出的是同一種格式，所以往返不會丟東西）。
// 不支援 .pptx：目前沒有 .pptx 讀取器，會明講而不是假裝能讀。純函式，測試：scripts/edit-tests/deck_import.test.js。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./deck_edit_core.js'));
  else root.FaDeckImport = factory(root.FaDeckEdit || (typeof FaDeckEdit !== 'undefined' ? FaDeckEdit : undefined));
})(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';

  var DECK_EXT = /\.(deck\.)?ya?ml$/i, PPTX_EXT = /\.pptx$/i;
  var TYPES = [{ description: '簡報 YAML', accept: { 'text/yaml': ['.deck.yaml', '.yaml', '.yml'] } }];

  // bytes → 簡報文件（spec）。不能讀就丟出可讀的錯誤。
  function fromBytes(bytes, name) {
    var n = String(name || '');
    if (PPTX_EXT.test(n)) { throw new Error('目前還不能開 .pptx 投影片（只能開簡報的 .deck.yaml）'); }
    if (!DECK_EXT.test(n)) { throw new Error('這個編輯器只能開簡報的 .deck.yaml 檔'); }
    var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var r = D.fromYaml(new TextDecoder('utf-8').decode(u));
    if (!r.ok) { throw new Error(r.error || '讀不了這份簡報'); }
    return r.spec;
  }

  return { fromBytes: fromBytes, TYPES: TYPES };
});
