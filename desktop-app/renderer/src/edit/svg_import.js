// /edit-svg 的「📂 開啟 .svg」：把一個 SVG 檔整份變成「一個圖形物件」（object.type 'svg'，markup 就是檔案裡 <svg> 的內容）。
// 這樣畫面與匯出都跟原檔一樣（漸層、路徑、文字都保留），之後可以移動、縮放、旋轉、隱藏，也能用說的改。
// 不拆成一堆形狀：那樣會丟掉原檔的細節。安全檢查沿用 edit_svg_core 的 checkMarkup（腳本、外部連結、事件屬性都會被拒絕，並說明原因）。
// 純函式，node 與瀏覽器都能跑（測試：scripts/edit-tests/svg_import.test.js）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./edit_svg_core.js'));
  else root.FaSvgImport = factory(root.FaEditSvg || (typeof FaEditSvg !== 'undefined' ? FaEditSvg : undefined));
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var EXT = /\.svg$/i;

  // 讀 SVG 文字 → { ok, markup, w, h, problems }。markup 會把 viewBox 的左上角平移到 0,0，讓物件座標從 0 開始。
  function parseSvgText(text) {
    var s = String(text == null ? '' : text).replace(/^﻿/, '');
    s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?xml[\s\S]*?\?>/i, '').replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/i, '');
    var m = /<svg\b([^>]*)>/i.exec(s);
    if (!m) { return { ok: false, problems: ['這個檔案沒有 <svg> 根元素，不是 SVG 圖'] }; }
    var attrs = m[1], vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(attrs), w = 0, h = 0, vx = 0, vy = 0;
    if (vb) {
      var n = vb[1].trim().split(/[\s,]+/).map(Number);
      if (n.length === 4 && n.every(isFinite) && n[2] > 0 && n[3] > 0) { vx = n[0]; vy = n[1]; w = n[2]; h = n[3]; }
    }
    if (!w || !h) {
      var wa = /\swidth\s*=\s*["']\s*([\d.]+)/i.exec(attrs), ha = /\sheight\s*=\s*["']\s*([\d.]+)/i.exec(attrs);
      w = wa ? Number(wa[1]) : 0; h = ha ? Number(ha[1]) : 0;
    }
    if (!(w > 0) || !(h > 0)) { w = 400; h = 400; }
    var start = m.index + m[0].length, end = s.search(/<\/svg\s*>\s*$/i);
    var inner = end > start ? s.slice(start, end) : s.slice(start);
    if (vx || vy) { inner = '<g transform="translate(' + (-vx) + ' ' + (-vy) + ')">' + inner + '</g>'; }
    inner = inner.trim();
    var c = C.checkMarkup(inner);
    if (!c.ok) { return { ok: false, problems: c.problems }; }
    return { ok: true, markup: inner, w: w, h: h, problems: [] };
  }

  // 讀檔 → 新的編輯器文件（空白畫布，裡面一個 svg 物件）。不合格就丟錯，錯誤訊息是人看得懂的原因。
  function specFromText(text, name) {
    var p = parseSvgText(text);
    if (!p.ok) { throw new Error('讀不了這個 SVG：' + p.problems.join('；')); }
    var spec = C.starter('blank');
    spec.title = String(name || '').replace(/\.[^.]+$/, '').slice(0, 80) || spec.title;
    var r = C.applyEdits(spec, [{ op: 'add_object', object: { type: 'svg', name: '匯入的圖', markup: p.markup, x: 0, y: 0, w: p.w, h: p.h, scale: 1, rotate: 0, opacity: 1 } }]);
    if (r.rejected && r.rejected.length) { throw new Error('讀不了這個 SVG：' + r.rejected.map(function (x) { return x.error; }).join('；')); }
    return r.spec;
  }

  // 📂 按鈕用：bytes（Uint8Array 或 ArrayBuffer）→ 文件
  function fromBytes(bytes, name) {
    if (!EXT.test(String(name || ''))) { throw new Error('這不是 .svg 檔'); }
    var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return specFromText(new TextDecoder('utf-8').decode(u), name);
  }

  return { parseSvgText: parseSvgText, specFromText: specFromText, fromBytes: fromBytes, EXT: EXT };
});
