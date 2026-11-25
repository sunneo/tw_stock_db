// 編輯器共用的「📂 開啟檔案」：選檔（或把檔案拖進編輯區）→ 讀成位元組 → 交給編輯器自己的 importBytes（讀進來、取代目前內容、可復原）。
// 由 edit_shell.js 的標題列使用：編輯器的 file 選項有 importBytes 就出現這顆按鈕（文件、Markdown、純文字、試算表）。
// 格式清單沿用編輯器本來的寫法 types:[{ description, accept:{ mime:[ '.ext', … ] } }]，不另外維護一份。
// 選檔一律用隱藏的 <input type=file>（跟原本各編輯器的 📂 一樣）；必須在點擊的同一個手勢裡呼叫 pick()，不能先 await 再叫。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditImport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function extOf(name) { var m = /\.([^./\\]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }

  // 所有可開的副檔名（小寫、不含點），依 types 的順序、不重複
  function exts(types) {
    var out = [];
    (types || []).forEach(function (t) {
      var acc = (t && t.accept) || {};
      Object.keys(acc).forEach(function (mime) {
        (acc[mime] || []).forEach(function (e) { var x = String(e).replace(/^\./, '').toLowerCase(); if (x && out.indexOf(x) < 0) { out.push(x); } });
      });
    });
    return out;
  }

  // <input accept="…"> 用的字串
  function acceptAttr(types) { return exts(types).map(function (x) { return '.' + x; }).join(','); }

  function accepts(name, types) { var e = extOf(name); return !!e && exts(types).indexOf(e) >= 0; }

  // 給使用者看的說明，例如「可以開：.docx」
  function hint(types) { return '可以開：' + exts(types).map(function (x) { return '.' + x; }).join('、'); }

  function mb(n) { return Math.round(n / 1000000) + ' MB'; }

  // 選檔：resolve { name, bytes:Uint8Array }；取消 resolve null；太大或讀不了 reject。
  // opt.maxBytes：超過就拒絕（各編輯器上限不同：文字 4 MB、試算表 20 MB、文件 30 MB）
  function pick(types, opt) {
    var maxBytes = opt && opt.maxBytes;
    return new Promise(function (resolve, reject) {
      if (typeof document === 'undefined') { resolve(null); return; }
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = acceptAttr(types); inp.style.display = 'none';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (inp.parentNode) { inp.parentNode.removeChild(inp); }
        if (!f) { resolve(null); return; }
        if (maxBytes && f.size > maxBytes) { reject(new Error('檔案太大（超過 ' + mb(maxBytes) + '）')); return; }
        f.arrayBuffer().then(function (buf) { resolve({ name: f.name, bytes: new Uint8Array(buf) }); }, function () { reject(new Error('讀不了這個檔案')); });
      };
      (document.body || document.documentElement).appendChild(inp);
      inp.click();
    });
  }

  // 把檔案拖進編輯區開啟。
  //  - 圖片不歸這裡管（右邊的 AI 對話框收圖片），直接略過，不說話
  //  - 這個編輯器認得的格式 → onFile({ name, bytes })
  //  - 不認得的 → onReject(說明)
  // 只在拖進來的是檔案時 preventDefault（否則瀏覽器會直接打開那個檔案，整個頁面被換掉）
  function dropOpen(el, types, onFile, onReject, maxBytes) {
    if (!el || typeof el.addEventListener !== 'function') { return; }
    el.addEventListener('dragover', function (ev) {
      var dt = ev.dataTransfer; if (dt && dt.types && Array.prototype.indexOf.call(dt.types, 'Files') >= 0) { ev.preventDefault(); }
    });
    el.addEventListener('drop', function (ev) {
      var fl = ev.dataTransfer && ev.dataTransfer.files;
      if (!fl || !fl.length) { return; }
      ev.preventDefault();
      var f = fl[0];
      if (/^image\//.test(f.type || '')) { return; }
      if (!accepts(f.name, types)) { if (onReject) { onReject('這個編輯器開不了「' + f.name + '」。' + hint(types)); } return; }
      if (maxBytes && f.size > maxBytes) { if (onReject) { onReject('檔案太大（超過 ' + mb(maxBytes) + '）'); } return; }
      f.arrayBuffer().then(function (buf) { onFile({ name: f.name, bytes: new Uint8Array(buf) }); }, function () { if (onReject) { onReject('讀不了「' + f.name + '」'); } });
    });
  }

  return { exts: exts, acceptAttr: acceptAttr, accepts: accepts, hint: hint, pick: pick, dropOpen: dropOpen };
});
