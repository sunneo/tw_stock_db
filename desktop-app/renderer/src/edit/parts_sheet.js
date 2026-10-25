// 零件表 → 工程圖（SVG 純文字，程式直接畫，不用模型）。純函式，node 與瀏覽器都能跑；測試 scripts/edit-tests/parts_sheet.test.js。
// 為什麼有這個：「幫我準備某某的工程圖，要有每個零件的長度、怎麼組裝」這種需求，零件表（名稱、長×寬×厚、數量）通常已經在對話裡了；
// 模型寫 SVG 常常失敗（線上節點斷線、離線小模型太慢），而這張圖其實是「照尺寸等比例畫矩形、標尺寸線、列出組裝步驟」，程式做得比模型穩。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPartsSheet = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var NUM = '(\\d+(?:\\.\\d+)?)', SEP = '\\s*[×xX＊*]\\s*', NOTE = '(?:\\s*[（(][^）)]*[）)])?';
  var DIM_RE = new RegExp(NUM + NOTE + SEP + NUM + NOTE + '(?:' + SEP + NUM + NOTE + ')?');
  // 只用來決定「要不要去對話裡找零件表」：放寬沒關係，因為真的找不到「名稱＋長×寬×厚」的表就什麼都不做。助理常把使用者的話改寫成英文或別的說法（graph、svg、parts、dimensions…），所以英文也算
  var ENGINEERING_RE = /工程|零件|元件|尺寸|長度|組裝|裝配|裁切|裁剪|樣板|三視圖|展開圖|施工圖|設計圖|blueprint|cad|dimension|component|part list|parts|assembl|technical drawing|engineering|schematic/i;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clean(s) { return String(s == null ? '' : s).replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim(); }
  function fmt(n) { return (Math.round(n * 10) / 10).toFixed(Math.abs(n % 1) < 0.05 ? 0 : 1).replace(/\.0$/, '') + ''; }

  // ───── 從文字裡讀零件表：markdown 表格（| 分隔）或用 Tab 分隔的列；每列要有「長×寬(×厚)」。欄位：代號、名稱、數量、尺寸、備註（順序不限，程式依內容判斷）
  function parseParts(text) {
    var parts = [], lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i]; if (!DIM_RE.test(ln) || /^\s*[-|:\s]+$/.test(ln)) { continue; }
      var cells = (ln.indexOf('|') >= 0 ? ln.split('|') : ln.split(/\t+/)).map(clean).filter(function (c) { return c !== ''; });
      if (cells.length < 2) { continue; }
      var dimIdx = -1, m = null; for (var k = 0; k < cells.length; k++) { m = DIM_RE.exec(cells[k]); if (m) { dimIdx = k; break; } }
      if (dimIdx < 0) { continue; }
      var a = Number(m[1]), b = Number(m[2]), c = m[3] != null ? Number(m[3]) : null; if (!(a > 0 && b > 0)) { continue; }
      var id = '', name = '', qty = 1, note = '', rest = cells.filter(function (_, j) { return j !== dimIdx; });
      rest.forEach(function (cell) {
        var q = /^(?:[x×＊*]\s*)?(\d{1,3})\s*(?:個|片|條|支|件|組|pcs)?$/i.exec(cell);
        if (!id && /^[A-Za-z]{1,2}\d{0,2}$/.test(cell)) { id = cell.toUpperCase(); }
        else if (q && Number(q[1]) <= 200) { qty = Number(q[1]); }
        else if (!name) { name = cell; }
        else if (!note) { note = cell; }
      });
      // 名稱裡帶「×2」之類：也當數量
      var qm = /[x×＊*]\s*(\d{1,3})\s*$/i.exec(name); if (qm) { qty = Number(qm[1]); name = name.replace(/\s*[x×＊*]\s*\d{1,3}\s*$/i, ''); }
      if (!name) { name = id || ('零件 ' + (parts.length + 1)); }
      if (/^(零件|名稱|代號|part|name|項目)$/i.test(name) && !id) { continue; }
      parts.push({ id: id || String.fromCharCode(65 + (parts.length % 26)), name: name, qty: qty, w: a, h: b, t: c, note: note, dimText: cells[dimIdx] });
    }
    return parts.slice(0, 40);
  }
  // 組裝步驟：「1. …」「1、…」「步驟 1：…」這種編號列
  function parseSteps(text) {
    var out = [], lines = String(text || '').split(/\r?\n/);
    lines.forEach(function (ln) { var m = /^\s*(?:步驟\s*)?(\d{1,2})\s*[.、:：)）]\s*(.{2,160})$/.exec(ln); if (m && !DIM_RE.test(m[2])) { out.push(clean(m[2])); } });
    return out.slice(0, 20);
  }
  function isEngineeringRequest(text) { return ENGINEERING_RE.test(String(text || '')); }

  // ───── 畫：每個零件按同一個比例畫成矩形（長在上、寬在右），標尺寸線與數字；底下列組裝步驟與材料說明
  function svg(parts, o) {
    o = o || {}; var title = clean(o.title || '零件工程圖'), steps = o.steps || [], unit = o.unit || 'cm';
    if (!parts || !parts.length) { return ''; }
    var W = 1100, M = 40, maxLen = Math.max.apply(null, parts.map(function (p) { return Math.max(p.w, p.h); })), scale = Math.max(2, Math.min(18, 330 / maxLen));
    var x = M, y = 120, rowH = 0, out = [], gap = 70;
    parts.forEach(function (p) {
      var pw = Math.max(14, p.w * scale), ph = Math.max(10, p.h * scale), cardW = pw + 110, cardH = ph + 130;
      if (x + cardW > W - M && x > M) { x = M; y += rowH + 30; rowH = 0; }
      var ox = x + 10, oy = y + 76;
      out.push('<g>');
      out.push('<text x="' + ox + '" y="' + (y + 18) + '" class="id">' + esc(p.id) + ' · ' + esc(p.name) + '</text>');
      out.push('<text x="' + ox + '" y="' + (y + 36) + '" class="sub">數量 ' + p.qty + (p.t != null ? '　厚 ' + fmt(p.t) + ' ' + unit : '') + (p.note ? '　' + esc(p.note.slice(0, 24)) : '') + '</text>');
      out.push('<rect x="' + ox + '" y="' + oy + '" width="' + pw.toFixed(1) + '" height="' + ph.toFixed(1) + '" class="part" rx="3"/>');
      // 上方：長度尺寸線
      var ly = oy - 8; out.push('<line x1="' + ox + '" y1="' + ly + '" x2="' + (ox + pw).toFixed(1) + '" y2="' + ly + '" class="dimline" marker-start="url(#ar0)" marker-end="url(#ar1)"/>');
      out.push('<text x="' + (ox + pw / 2).toFixed(1) + '" y="' + (ly - 4) + '" text-anchor="middle" class="dim">' + fmt(p.w) + ' ' + unit + '</text>');
      // 右方：寬度尺寸線
      var lx = ox + pw + 12; out.push('<line x1="' + lx.toFixed(1) + '" y1="' + oy + '" x2="' + lx.toFixed(1) + '" y2="' + (oy + ph).toFixed(1) + '" class="dimline" marker-start="url(#ar0)" marker-end="url(#ar1)"/>');
      out.push('<text x="' + (lx + 6).toFixed(1) + '" y="' + (oy + ph / 2 + 4).toFixed(1) + '" class="dim">' + fmt(p.h) + ' ' + unit + '</text>');
      out.push('</g>');
      x += cardW + gap / 2; rowH = Math.max(rowH, cardH);
    });
    var yEnd = y + rowH + 30, body = out.join('\n');
    var notes = [];
    if (steps.length) { notes.push('<text x="' + M + '" y="' + (yEnd + 24) + '" class="h2">組裝步驟</text>'); steps.forEach(function (s, i) { notes.push('<text x="' + (M + 8) + '" y="' + (yEnd + 50 + i * 24) + '" class="step">' + (i + 1) + '. ' + esc(s.slice(0, 80)) + '</text>'); }); yEnd += 50 + steps.length * 24; }
    notes.push('<text x="' + M + '" y="' + (yEnd + 30) + '" class="sub">尺寸單位：' + unit + '。所有零件按同一個比例縮放（1 ' + unit + ' ≈ ' + scale.toFixed(1) + ' px）；列印當裁剪樣板時，以標註的尺寸為準。</text>');
    var H = yEnd + 60;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">'
      + '<defs><style>.t{font:bold 24px sans-serif;fill:#1a1a2e}.id{font:bold 14px sans-serif;fill:#1a1a2e}.sub{font:12px sans-serif;fill:#555}.h2{font:bold 16px sans-serif;fill:#16213e}.step{font:14px sans-serif;fill:#1a1a2e}.dim{font:bold 12px sans-serif;fill:#c0392b}.part{fill:#f3e3c3;stroke:#7a5c2e;stroke-width:2}.dimline{stroke:#c0392b;stroke-width:1.2;fill:none}</style>'
      + '<marker id="ar0" markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto"><path d="M8 0 L0 4 L8 8 z" fill="#c0392b"/></marker><marker id="ar1" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#c0392b"/></marker></defs>'
      + '<rect width="100%" height="100%" fill="#fff"/><text x="' + M + '" y="46" class="t">' + esc(title) + '</text><text x="' + M + '" y="72" class="sub">零件尺寸圖（依零件表自動繪製）</text>\n' + body + '\n' + notes.join('\n') + '</svg>';
  }
  return { parseParts: parseParts, parseSteps: parseSteps, svg: svg, isEngineeringRequest: isEngineeringRequest, ENGINEERING_RE: ENGINEERING_RE };
});
