// /edit-picture 的「📂 開啟圖片」：一張 png／jpg／gif／webp 變成文件的第一個圖層（image 物件），畫布大小跟著圖走。
// 原圖的像素存在 FaEditStore（putImage 回傳的 ref），文件裡只記 ref，跟貼圖進來的做法一樣。
// 純函式：putImage 與量尺寸由呼叫端注入（瀏覽器用 FaEditStore 與 createImageBitmap；node 測試用假的）。測試：scripts/edit-tests/picture_import.test.js。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./edit_picture_core.js'));
  else root.FaPictureImport = factory(root.FaEditPicture || (typeof FaEditPicture !== 'undefined' ? FaEditPicture : undefined));
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

  function mimeOf(name) { var m = /\.([^./\\]+)$/.exec(String(name || '')); return m ? (MIME[m[1].toLowerCase()] || null) : null; }

  // deps: { putImage(blob) -> Promise<ref>, size?(blob) -> Promise<{w,h}|null> }
  async function specFromImage(bytes, name, deps) {
    var mime = mimeOf(name);
    if (!mime) { throw new Error('這個編輯器只能開 png、jpg、gif、webp 圖片'); }
    if (!deps || typeof deps.putImage !== 'function') { throw new Error('圖片存放區不能用'); }
    var blob = new Blob([bytes], { type: mime });
    var ref = await deps.putImage(blob);
    var sz = typeof deps.size === 'function' ? await deps.size(blob) : null;
    var w = sz && sz.w > 0 ? Math.round(sz.w) : 800, h = sz && sz.h > 0 ? Math.round(sz.h) : 600;
    var spec = C.starter('blank');
    spec.title = String(name || '').replace(/\.[^.]+$/, '').slice(0, 80) || spec.title;
    var r = C.applyEdits(spec, [
      { op: 'set_canvas', w: w, h: h },
      { op: 'add_object', object: { type: 'image', name: '匯入的圖', ref: ref, mime: mime, x: 0, y: 0, w: w, h: h, opacity: 1 } }
    ]);
    if (r.rejected && r.rejected.length) { throw new Error('讀不了這張圖：' + r.rejected.map(function (x) { return x.error; }).join('；')); }
    return r.spec;
  }

  // 瀏覽器端的預設依賴：FaEditStore.putImage、createImageBitmap 量尺寸（量不到就用 800×600）
  function browserDeps() {
    var store = typeof FaEditStore !== 'undefined' ? FaEditStore : null;
    return {
      putImage: function (blob) { if (!store) { throw new Error('圖片存放區不能用'); } return store.putImage(blob); },
      size: async function (blob) { try { var b = await createImageBitmap(blob), r = { w: b.width, h: b.height }; if (b.close) { b.close(); } return r; } catch (e) { return null; } }
    };
  }

  function fromBytes(bytes, name, deps) {
    var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return specFromImage(u, name, deps || browserDeps());
  }

  return { mimeOf: mimeOf, specFromImage: specFromImage, fromBytes: fromBytes, browserDeps: browserDeps };
});
