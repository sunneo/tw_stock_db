// CAD 風格的工程圖（SVG 純文字，程式畫，不用模型寫座標）。純函式，node 與瀏覽器都能跑；測試 scripts/edit-tests/cad_sheet.test.js；設計見 DESIGN.cad-sheet.md。
// 為什麼不讓模型寫 SVG：精準的尺寸圖要「數字對、比例對、線不重疊」，這是程式的強項，模型只適合決定「有哪些零件、各自多大、什麼形狀」。
// 所以分工是：模型（或對話裡已經列好的零件表）給一份很小的規格（零件清單：名稱、數量、外形種類與尺寸、厚度、孔與槽、組裝步驟），程式負責畫：
//   圖框與標題欄、每個零件按同一個比例畫外形、外形尺寸線（延伸線＋箭頭＋數字）、孔徑與孔位、中心線、厚度側視圖（剖面線）、零件編號圈、明細表、層疊爆炸示意、組裝步驟。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./parts_sheet.js')); else root.FaCadSheet = factory(root.FaPartsSheet || (typeof FaPartsSheet !== 'undefined' ? FaPartsSheet : null)); })(typeof self !== 'undefined' ? self : this, function (PS) {
  'use strict';
  var LIM = { parts: 40, steps: 24, notes: 12, features: 12, points: 60, dim: 100000 };
  var KINDS = ['rect', 'rrect', 'ellipse', 'polygon', 'violin'];
  var PX_MM = 25.4 / 96; // 1 px = 0.2646 mm（SVG 的標準換算：列印 100% 時畫面的尺寸才是真實比例）

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v, lo, hi, d) { v = Number(v); if (!isFinite(v)) { return d; } return Math.max(lo, Math.min(hi, v)); }
  function str(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n || 60); }
  function fmt(n) { var r = Math.round(n * 100) / 100; return String(r); }
  function r1(n) { return Math.round(n * 10) / 10; }

  // ───── 規格的檢查與預設（模型給的、或程式從零件表讀的，都先過這裡；不合格的欄位用預設，不會畫出壞圖）
  function outlineOf(o) {
    o = o || {}; var k = KINDS.indexOf(o.kind) >= 0 ? o.kind : 'rect';
    if (k === 'polygon') {
      var pts = (Array.isArray(o.points) ? o.points : []).slice(0, LIM.points).map(function (p) { return Array.isArray(p) ? [num(p[0], -LIM.dim, LIM.dim, 0), num(p[1], -LIM.dim, LIM.dim, 0)] : null; }).filter(Boolean);
      if (pts.length < 3) { k = 'rect'; } else { var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; }), x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys); pts = pts.map(function (p) { return [r1(p[0] - x0), r1(p[1] - y0)]; }); return { kind: 'polygon', points: pts, w: r1(Math.max.apply(null, xs) - x0), h: r1(Math.max.apply(null, ys) - y0) }; }
    }
    if (k === 'violin') {
      var L = num(o.length != null ? o.length : o.h, 1, LIM.dim, 35), Bl = num(o.lower != null ? o.lower : o.w, 1, LIM.dim, L * 0.57), Bu = num(o.upper, 1, LIM.dim, Bl * 0.8), Bw = num(o.waist, 1, LIM.dim, Bl * 0.55);
      return { kind: 'violin', length: L, upper: Bu, waist: Bw, lower: Bl, w: Math.max(Bu, Bw, Bl), h: L };
    }
    var w = num(o.w, 0.01, LIM.dim, 10), h = num(o.h, 0.01, LIM.dim, 10);
    if (k === 'rrect') { return { kind: 'rrect', w: w, h: h, r: num(o.r, 0, Math.min(w, h) / 2, Math.min(w, h) / 8) }; }
    return { kind: k, w: w, h: h };
  }
  function normalize(spec) {
    spec = spec || {}; var unit = spec.unit === 'mm' ? 'mm' : 'cm', parts = [], seen = {};
    (Array.isArray(spec.parts) ? spec.parts : []).slice(0, LIM.parts).forEach(function (p, i) {
      if (!p || typeof p !== 'object') { return; } var id = str(p.id, 6) || String.fromCharCode(65 + (i % 26)); if (seen[id]) { id = id + (i + 1); } seen[id] = 1;
      var feats = (Array.isArray(p.features) ? p.features : []).slice(0, LIM.features).map(function (f) {
        if (!f || typeof f !== 'object') { return null; } if (f.kind === 'hole') { return { kind: 'hole', x: num(f.x, 0, LIM.dim, 0), y: num(f.y, 0, LIM.dim, 0), d: num(f.d, 0.01, LIM.dim, 1) }; }
        if (f.kind === 'slot') { return { kind: 'slot', x: num(f.x, 0, LIM.dim, 0), y: num(f.y, 0, LIM.dim, 0), w: num(f.w, 0.01, LIM.dim, 2), h: num(f.h, 0.01, LIM.dim, 0.5) }; } return null;
      }).filter(Boolean);
      parts.push({ id: id, name: str(p.name, 40) || ('零件 ' + (i + 1)), qty: Math.round(num(p.qty, 1, 999, 1)), outline: outlineOf(p.outline || { kind: 'rect', w: p.w, h: p.h }), thickness: p.thickness == null || p.thickness === '' ? null : num(p.thickness, 0.001, LIM.dim, null), material: str(p.material, 30), note: str(p.note, 60), features: feats, mirror: p.mirror === true });
    });
    var ids = parts.map(function (p) { return p.id; });
    return {
      title: str(spec.title, 60) || '零件工程圖', drawingNo: str(spec.drawingNo, 20) || 'DWG-001', unit: unit, material: str(spec.material, 40), author: str(spec.author, 30), date: str(spec.date, 20),
      parts: parts, steps: (Array.isArray(spec.steps) ? spec.steps : []).slice(0, LIM.steps).map(function (s) { return str(s, 120); }).filter(Boolean), notes: (Array.isArray(spec.notes) ? spec.notes : []).slice(0, LIM.notes).map(function (s) { return str(s, 120); }).filter(Boolean),
      stack: (Array.isArray(spec.stack) ? spec.stack : []).map(function (s) { return str(s, 6); }).filter(function (s) { return ids.indexOf(s) >= 0; }).slice(0, 12)
    };
  }

  // ───── 小提琴外形：用一圈平滑曲線（Catmull-Rom → 三次貝茲）穿過上圓、腰、下圓的寬度點；左右對稱
  function violinPoints(o) {
    var L = o.length, Bu = o.upper, Bw = o.waist, Bl = o.lower, cx = o.w / 2;
    var half = [[0, 0], [Bu * 0.28, L * 0.02], [Bu / 2, L * 0.19], [Bu * 0.43, L * 0.33], [Bw / 2, L * 0.47], [Bl * 0.43, L * 0.6], [Bl / 2, L * 0.76], [Bl * 0.3, L * 0.95], [0, L]];
    var right = half.map(function (p) { return [cx + p[0], p[1]]; }), left = half.slice(1, -1).reverse().map(function (p) { return [cx - p[0], p[1]]; });
    return right.concat(left);
  }
  function closedSpline(pts) {
    var n = pts.length, d = 'M' + r1(pts[0][0]) + ' ' + r1(pts[0][1]);
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      d += ' C' + r1(p1[0] + (p2[0] - p0[0]) / 6) + ' ' + r1(p1[1] + (p2[1] - p0[1]) / 6) + ' ' + r1(p2[0] - (p3[0] - p1[0]) / 6) + ' ' + r1(p2[1] - (p3[1] - p1[1]) / 6) + ' ' + r1(p2[0]) + ' ' + r1(p2[1]);
    }
    return d + ' Z';
  }
  // 外形的 SVG 元素（座標是「單位」，由呼叫端用 transform 放大）
  function outlineShape(o, cls) {
    if (o.kind === 'ellipse') { return '<ellipse cx="' + o.w / 2 + '" cy="' + o.h / 2 + '" rx="' + o.w / 2 + '" ry="' + o.h / 2 + '" class="' + cls + '"/>'; }
    if (o.kind === 'rrect') { return '<rect x="0" y="0" width="' + o.w + '" height="' + o.h + '" rx="' + o.r + '" class="' + cls + '"/>'; }
    if (o.kind === 'polygon') { return '<polygon points="' + o.points.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '" class="' + cls + '"/>'; }
    if (o.kind === 'violin') { return '<path d="' + closedSpline(violinPoints(o)) + '" class="' + cls + '"/>'; }
    return '<rect x="0" y="0" width="' + o.w + '" height="' + o.h + '" class="' + cls + '"/>';
  }

  // ───── 尺寸線：延伸線＋雙箭頭＋數字（數字有白底，不會被線壓住）
  function txt(x, y, s, cls, anchor) { return '<text x="' + r1(x) + '" y="' + r1(y) + '" class="' + cls + '"' + (anchor ? ' text-anchor="' + anchor + '"' : '') + '>' + esc(s) + '</text>'; }
  function dimH(x1, x2, yLine, yFrom, label) { // 水平尺寸：兩條向下（或向上）的延伸線，中間一條帶箭頭的線
    var s = yLine > yFrom ? 1 : -1, g = 3, o = 5;
    return '<line x1="' + r1(x1) + '" y1="' + r1(yFrom + s * g) + '" x2="' + r1(x1) + '" y2="' + r1(yLine + s * o) + '" class="ext"/><line x1="' + r1(x2) + '" y1="' + r1(yFrom + s * g) + '" x2="' + r1(x2) + '" y2="' + r1(yLine + s * o) + '" class="ext"/>'
      + '<line x1="' + r1(x1) + '" y1="' + r1(yLine) + '" x2="' + r1(x2) + '" y2="' + r1(yLine) + '" class="dim" marker-start="url(#ar0)" marker-end="url(#ar1)"/>' + txt((x1 + x2) / 2, yLine + (s > 0 ? 14 : -5), label, 'dt', 'middle');
  }
  function dimV(y1, y2, xLine, xFrom, label) {
    var s = xLine > xFrom ? 1 : -1, g = 3, o = 5;
    return '<line x1="' + r1(xFrom + s * g) + '" y1="' + r1(y1) + '" x2="' + r1(xLine + s * o) + '" y2="' + r1(y1) + '" class="ext"/><line x1="' + r1(xFrom + s * g) + '" y1="' + r1(y2) + '" x2="' + r1(xLine + s * o) + '" y2="' + r1(y2) + '" class="ext"/>'
      + '<line x1="' + r1(xLine) + '" y1="' + r1(y1) + '" x2="' + r1(xLine) + '" y2="' + r1(y2) + '" class="dim" marker-start="url(#ar0)" marker-end="url(#ar1)"/>'
      + '<text transform="translate(' + r1(xLine + (s > 0 ? 14 : -6)) + ' ' + r1((y1 + y2) / 2) + ') rotate(-90)" class="dt" text-anchor="middle">' + esc(label) + '</text>';
  }

  // ───── 一個零件的「卡片」：外形（按比例）＋外形尺寸＋孔槽＋中心線＋厚度側視＋編號圈＋名稱數量
  function partCard(p, s, unit, x0, y0) {
    var o = p.outline, W = o.w * s, H = o.h * s, padL = 56, padT = 64, out = [], thk = p.thickness;
    var ox = x0 + padL, oy = y0 + padT, sideH = thk != null ? Math.max(8, thk * s) : 0, sideY = oy + H + 74;
    out.push('<g class="part-card">');
    out.push('<circle cx="' + r1(x0 + 14) + '" cy="' + r1(y0 + 14) + '" r="12" class="bal"/>' + txt(x0 + 14, y0 + 18, p.id, 'bt', 'middle'));
    out.push(txt(x0 + 32, y0 + 18, p.name + (p.qty > 1 ? '　× ' + p.qty : ''), 'pn'));
    if (p.note) { out.push(txt(x0 + 32, y0 + 34, p.note, 'sub')); }
    out.push('<g transform="translate(' + r1(ox) + ' ' + r1(oy) + ') scale(' + s + ')" class="outline">' + outlineShape(o, 'part') + '</g>');
    // 中心線（對稱的外形：圓、橢圓、小提琴、矩形）
    if (o.kind !== 'polygon') { out.push('<line x1="' + r1(ox + W / 2) + '" y1="' + r1(oy - 8) + '" x2="' + r1(ox + W / 2) + '" y2="' + r1(oy + H + 8) + '" class="cl"/><line x1="' + r1(ox - 8) + '" y1="' + r1(oy + H / 2) + '" x2="' + r1(ox + W + 8) + '" y2="' + r1(oy + H / 2) + '" class="cl"/>'); }
    // 孔與槽
    p.features.forEach(function (f) {
      if (f.kind === 'hole') { var cx = ox + f.x * s, cy = oy + f.y * s, rr = f.d * s / 2; out.push('<circle cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="' + r1(rr) + '" class="hole"/><line x1="' + r1(cx - rr - 4) + '" y1="' + r1(cy) + '" x2="' + r1(cx + rr + 4) + '" y2="' + r1(cy) + '" class="cl"/><line x1="' + r1(cx) + '" y1="' + r1(cy - rr - 4) + '" x2="' + r1(cx) + '" y2="' + r1(cy + rr + 4) + '" class="cl"/>' + txt(cx + rr + 6, cy - rr - 2, 'Ø' + fmt(f.d), 'dt')); }
      else { out.push('<rect x="' + r1(ox + f.x * s) + '" y="' + r1(oy + f.y * s) + '" width="' + r1(f.w * s) + '" height="' + r1(f.h * s) + '" rx="' + r1(Math.min(f.w, f.h) * s / 2) + '" class="hole"/>' + txt(ox + f.x * s, oy + f.y * s - 4, fmt(f.w) + '×' + fmt(f.h), 'dt')); }
    });
    // 外形尺寸：下方總寬、右方總高；小提琴另標上圓／腰／下圓寬度
    out.push(dimH(ox, ox + W, oy + H + 26, oy + H, fmt(o.w) + ' ' + unit));
    out.push(dimV(oy, oy + H, ox + W + 30, ox + W, fmt(o.h) + ' ' + unit));
    if (o.kind === 'violin') {
      [[o.upper, 0.19, '上圓'], [o.waist, 0.47, '腰'], [o.lower, 0.76, '下圓']].forEach(function (w) { var y = oy + H * w[1], half = w[0] * s / 2, cx = ox + W / 2; out.push('<line x1="' + r1(cx - half) + '" y1="' + r1(y) + '" x2="' + r1(cx + half) + '" y2="' + r1(y) + '" class="dim" marker-start="url(#ar0)" marker-end="url(#ar1)"/>' + txt(cx, y - 4, w[2] + ' ' + fmt(w[0]), 'dt', 'middle')); });
    }
    // 厚度側視（剖面線）
    var cardH = padT + H + 64;
    if (thk != null) {
      out.push(txt(ox, sideY - 10, '側視（厚度）', 'sub'));
      out.push('<rect x="' + r1(ox) + '" y="' + r1(sideY) + '" width="' + r1(W) + '" height="' + r1(sideH) + '" class="cut"/>');
      out.push(dimV(sideY, sideY + sideH, ox + W + 30, ox + W, 't=' + fmt(thk)));
      cardH = (sideY - y0) + sideH + 24;
    }
    out.push('</g>');
    var nameW = 40 + (p.name + (p.qty > 1 ? '　× ' + p.qty : '')).split('').reduce(function (a, ch) { return a + (ch.charCodeAt(0) > 255 ? 15 : 8); }, 0);
    return { svg: out.join(''), w: Math.max(padL + W + 76, nameW), h: cardH };
  }

  // ───── 層疊爆炸示意（側視）：零件由下往上依 stack 順序疊，中間留空隙、虛線表示組裝方向；寬度按比例、厚度加粗到看得見
  function stackView(spec, s, x0, y0) {
    var items = spec.stack.map(function (id) { return spec.parts.filter(function (p) { return p.id === id; })[0]; }).filter(Boolean); if (items.length < 2) { return null; }
    var out = [], gap = 30, thick = function (p) { return Math.max(10, (p.thickness != null ? p.thickness : 0.5) * s * 1.5); }, maxW = Math.max.apply(null, items.map(function (p) { return p.outline.w * s; })), cx = x0 + maxW / 2 + 40, y = y0 + 30;
    out.push(txt(x0, y0 + 14, '層疊爆炸示意（側視，厚度放大示意）', 'h2'));
    var tops = []; items.slice().reverse().forEach(function (p) { var w = p.outline.w * s, h = thick(p); tops.push({ p: p, x: cx - w / 2, y: y, w: w, h: h }); y += h + gap; });
    tops.forEach(function (t, i) {
      out.push('<rect x="' + r1(t.x) + '" y="' + r1(t.y) + '" width="' + r1(t.w) + '" height="' + r1(t.h) + '" class="cut"/>' + '<circle cx="' + r1(t.x - 22) + '" cy="' + r1(t.y + t.h / 2) + '" r="11" class="bal"/>' + txt(t.x - 22, t.y + t.h / 2 + 4, t.p.id, 'bt', 'middle') + txt(t.x + t.w + 10, t.y + t.h / 2 + 4, t.p.name, 'sub'));
      if (i < tops.length - 1) { var n = tops[i + 1]; out.push('<line x1="' + r1(cx) + '" y1="' + r1(t.y + t.h + 3) + '" x2="' + r1(cx) + '" y2="' + r1(n.y - 3) + '" class="asm" marker-end="url(#ar1)"/>'); }
    });
    return { svg: out.join(''), w: maxW + 280, h: y - y0 };
  }

  function tableRow(cells, xs, y, h, cls) { return cells.map(function (c, i) { return '<rect x="' + xs[i] + '" y="' + y + '" width="' + (xs[i + 1] - xs[i]) + '" height="' + h + '" class="' + cls + '"/>' + txt(xs[i] + 6, y + h - 8, c, cls === 'th' ? 'tht' : 'td'); }).join(''); }

  // ───── 整張圖紙
  function render(spec0, opt) {
    var spec = normalize(spec0), unit = spec.unit; opt = opt || {};
    if (!spec.parts.length) { return ''; }
    var unitMm = unit === 'mm' ? 1 : 10, W = 1400, M = 24, inner = W - 2 * M - 40;
    // 比例：最大的零件放進約 520px；取「好看的」1:N（N 是 1、2、2.5、5、10、20、50…）再反推 px/單位，列印 100% 就是這個比例
    var maxDim = Math.max.apply(null, spec.parts.map(function (p) { return Math.max(p.outline.w, p.outline.h); })), wantPx = 520, rawN = (unitMm / PX_MM) / (wantPx / maxDim);
    var NICE = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200], N = NICE.filter(function (n) { return n >= rawN; })[0] || NICE[NICE.length - 1], s = unitMm / PX_MM / N;
    if (s * maxDim > 760) { s = 760 / maxDim; N = Math.round(unitMm / PX_MM / s); }
    var scaleText = N < 1 ? (1 / N) + ':1' : '1:' + N;
    var body = [], y = 130, x = M + 20, rowH = 0, cards = [];
    spec.parts.forEach(function (p) { cards.push(partCard(p, s, unit, 0, 0)); });
    spec.parts.forEach(function (p, i) {
      var c = partCard(p, s, unit, x, y); if (x + c.w > M + 20 + inner && x > M + 20) { x = M + 20; y += rowH + 24; rowH = 0; c = partCard(p, s, unit, x, y); }
      body.push(c.svg); x += c.w + 24; rowH = Math.max(rowH, c.h);
    });
    y += rowH + 30;
    var st = stackView(spec, s, M + 20, y); if (st) { body.push(st.svg); y += st.h + 30; }
    // 明細表
    var xs = [M + 20, M + 70, M + 130, M + 520, M + 590, M + 960, M + 20 + inner]; body.push(txt(M + 20, y + 14, '明細表（BOM）', 'h2')); y += 22;
    body.push(tableRow(['項次', '代號', '名稱', '數量', '尺寸（長 × 寬 × 厚 ' + unit + '）', '材料／備註'], xs, y, 26, 'th')); y += 26;
    spec.parts.forEach(function (p, i) { var o = p.outline, size = o.kind === 'violin' ? fmt(o.length) + ' × ' + fmt(o.w) + (p.thickness != null ? ' × ' + fmt(p.thickness) : '') : fmt(o.w) + ' × ' + fmt(o.h) + (p.thickness != null ? ' × ' + fmt(p.thickness) : ''); body.push(tableRow([String(i + 1), p.id, p.name, String(p.qty), size, (p.material || spec.material || '') + (p.note ? (p.material || spec.material ? '；' : '') + p.note : '')], xs, y, 26, 'tr')); y += 26; });
    y += 28;
    if (spec.steps.length) { body.push(txt(M + 20, y, '組裝步驟', 'h2')); y += 10; spec.steps.forEach(function (t, i) { y += 26; body.push('<circle cx="' + (M + 32) + '" cy="' + (y - 5) + '" r="10" class="bal"/>' + txt(M + 32, y - 1, String(i + 1), 'bt', 'middle') + txt(M + 52, y, t, 'step')); }); y += 22; }
    if (spec.notes.length) { body.push(txt(M + 20, y + 10, '備註', 'h2')); y += 10; spec.notes.forEach(function (t) { y += 22; body.push(txt(M + 32, y, '• ' + t, 'step')); }); y += 16; }
    // 標題欄（右下）
    var tbW = 560, tbH = 96, tbX = W - M - 20 - tbW, tbY = y + 20, cell = function (cx, cy, cw, ch, label, val, big) { return '<rect x="' + cx + '" y="' + cy + '" width="' + cw + '" height="' + ch + '" class="tb"/>' + txt(cx + 5, cy + 12, label, 'tl') + txt(cx + 8, cy + ch - 8, val, big ? 'tv big' : 'tv'); };
    var title = [cell(tbX, tbY, tbW, 50, '圖名', spec.title, true), cell(tbX, tbY + 50, 160, 46, '圖號', spec.drawingNo), cell(tbX + 160, tbY + 50, 90, 46, '比例', scaleText), cell(tbX + 250, tbY + 50, 90, 46, '單位', unit), cell(tbX + 340, tbY + 50, 220, 46, '材料', spec.material || (spec.parts[0].material || '—'))];
    if (spec.date || spec.author) { title.push(txt(tbX, tbY + tbH + 18, (spec.author ? '繪製：' + spec.author + '　' : '') + (spec.date ? '日期：' + spec.date : ''), 'sub')); }
    var H = tbY + tbH + 70, pxW = W, widthMm = r1(pxW * PX_MM), heightMm = r1(H * PX_MM);
    var head = '<text x="' + (M + 20) + '" y="64" class="t">' + esc(spec.title) + '</text>' + txt(M + 20, 90, '尺寸單位：' + unit + '　比例 ' + scaleText + '　（列印 100% 即為此比例；所有零件同一比例）', 'sub');
    var css = '.t{font:bold 26px sans-serif;fill:#111}.h2{font:bold 16px sans-serif;fill:#16213e}.pn{font:bold 14px sans-serif;fill:#111}.sub{font:12px sans-serif;fill:#555}.step{font:14px sans-serif;fill:#111}.dt{font:bold 12px sans-serif;fill:#b3261e;paint-order:stroke;stroke:#fff;stroke-width:3px}'
      + '.part{fill:#fbf3e0;stroke:#222;stroke-width:1.6;vector-effect:non-scaling-stroke}.hole{fill:#fff;stroke:#222;stroke-width:1.3}.cut{fill:url(#hatch);stroke:#222;stroke-width:1.4}.dim{stroke:#b3261e;stroke-width:1;fill:none}.ext{stroke:#b3261e;stroke-width:.8}.cl{stroke:#2a6fb0;stroke-width:.8;stroke-dasharray:10 3 2 3;fill:none}.asm{stroke:#444;stroke-width:1.2;stroke-dasharray:5 4}'
      + '.bal{fill:#fff;stroke:#111;stroke-width:1.4}.bt{font:bold 12px sans-serif;fill:#111}.th{fill:#e8edf5;stroke:#222;stroke-width:1}.tr{fill:#fff;stroke:#222;stroke-width:1}.tht{font:bold 13px sans-serif;fill:#111}.td{font:13px sans-serif;fill:#111}.tb{fill:none;stroke:#111;stroke-width:1.6}.tl{font:10px sans-serif;fill:#666}.tv{font:15px sans-serif;fill:#111}.tv.big{font:bold 20px sans-serif}';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + pxW + ' ' + H + '" width="' + widthMm + 'mm" height="' + heightMm + 'mm">'
      + '<defs><style>' + css + '</style><pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fff"/><line x1="0" y1="0" x2="0" y2="6" stroke="#555" stroke-width="1"/></pattern>'
      + '<marker id="ar0" markerWidth="8" markerHeight="6" refX="1" refY="3" orient="auto"><path d="M8 0 L0 3 L8 6 z" fill="#b3261e"/></marker><marker id="ar1" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0 0 L8 3 L0 6 z" fill="#b3261e"/></marker></defs>'
      + '<rect width="100%" height="100%" fill="#fff"/><rect x="' + M + '" y="' + M + '" width="' + (pxW - 2 * M) + '" height="' + (H - 2 * M) + '" class="tb"/><rect x="' + (M + 8) + '" y="' + (M + 8) + '" width="' + (pxW - 2 * M - 16) + '" height="' + (H - 2 * M - 16) + '" fill="none" stroke="#111" stroke-width=".8"/>'
      + head + body.join('\n') + title.join('') + '</svg>';
  }

  // ───── 從對話裡的零件表讀出規格（不用模型）：每個零件先當矩形；名稱像「上板／下板／Top／Back Plate」且對話裡提到小提琴 → 外形用小提琴曲線（上圓／腰／下圓寬度從文字裡讀，讀不到用比例）
  function numNear(text, re) { var m = re.exec(text); return m ? Number(m[1]) : null; }
  function specFromTable(text, o) {
    o = o || {}; var parts = PS ? PS.parseParts(text) : []; if (!parts.length) { return null; }
    var violin = /小提琴|violin/i.test(text), Bu = numNear(text, /上圓[^0-9\n]{0,6}?(\d+(?:\.\d+)?)/), Bl = numNear(text, /下圓[^0-9\n]{0,6}?(\d+(?:\.\d+)?)/), Bw = numNear(text, /腰[部]?[^0-9\n]{0,10}?(\d+(?:\.\d+)?)/);
    var spec = { title: o.title || (violin ? '小提琴 工程圖' : '零件工程圖'), unit: /\bmm\b|毫米/.test(text) && !/\bcm\b|公分/.test(text) ? 'mm' : 'cm', material: o.material || (/瓦楞/.test(text) ? '瓦楞紙' : ''), parts: [], steps: PS.parseSteps(text), notes: [] };
    parts.forEach(function (p) {
      var isPlate = /上板|下板|top\s*plate|back\s*plate|琴身|face|body/i.test(p.name), len = Math.max(p.w, p.h), wid = Math.min(p.w, p.h);
      var outline = violin && isPlate && len >= wid * 1.2 ? { kind: 'violin', length: len, lower: Bl || wid, upper: Bu || (Bl || wid) * 0.8, waist: Bw || (Bl || wid) * 0.55 } : { kind: 'rect', w: p.w, h: p.h };
      spec.parts.push({ id: p.id, name: p.name, qty: p.qty, outline: outline, thickness: p.t, note: p.note });
    });
    var back = spec.parts.filter(function (p) { return /下板|back/i.test(p.name); })[0], top = spec.parts.filter(function (p) { return /上板|top\s*plate/i.test(p.name); })[0], ribs = spec.parts.filter(function (p) { return /側板|rib/i.test(p.name); });
    if (back && top && back.id !== top.id) { spec.stack = [back.id].concat(ribs.slice(0, 1).map(function (r) { return r.id; })).concat([top.id]); }
    return spec;
  }

  // ───── 給模型的規格說明（請它只輸出一個 JSON，欄位用封閉清單；模型只決定「有什麼零件、多大、什麼形狀」，不寫任何座標或 SVG）
  function specPrompt(request, context) {
    var system = '你是工程製圖的助手。使用者要一張零件工程圖：你只負責列出「零件清單」，程式會照尺寸畫成 CAD 風格的圖（尺寸線、明細表、組裝步驟）。只輸出一個 JSON，不要其他文字，不要寫 SVG。\n'
      + 'JSON 格式：{"title":"圖名","unit":"cm"或"mm","material":"材料","parts":[{"id":"A","name":"零件名","qty":1,"outline":{...},"thickness":0.5,"note":"備註","features":[{"kind":"hole","x":5,"y":5,"d":1},{"kind":"slot","x":3,"y":2,"w":4,"h":0.5}]}],"stack":["B","C","A"],"steps":["第一步…"],"notes":["…"]}\n'
      + 'outline 只能是這幾種：{"kind":"rect","w":寬,"h":高}、{"kind":"rrect","w":,"h":,"r":圓角半徑}、{"kind":"ellipse","w":,"h":}、{"kind":"polygon","points":[[x,y],…]}（座標單位同 unit，最多 60 點）、{"kind":"violin","length":總長,"upper":上圓寬,"waist":腰寬,"lower":下圓寬}（小提琴琴身，左右對稱）。\n'
      + '規則：1) 每個零件都要有真實可做的尺寸（數字，單位用 unit）；2) id 用 A、B、C…或 C1、C2；3) stack 是由下往上的疊放順序（零件 id，選填，疊起來組裝的零件才寫）；4) steps 最多 12 步、每步一句；5) 零件最多 30 個。';
    return { system: system, user: '需求：' + String(request || '').slice(0, 1500) + (context ? '\n\n對話裡已有的資料（可以參考，但以需求為準）：\n' + String(context).slice(0, 3500) : '') + '\n\n請輸出 JSON。' };
  }
  function parseSpecReply(reply) {
    var t = String(reply == null ? '' : reply).replace(/<think>[\s\S]*?<\/think>/gi, ''), a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b <= a) { return { ok: false, error: '回覆裡沒有 JSON' }; }
    var j; try { j = JSON.parse(t.slice(a, b + 1)); } catch (e) { return { ok: false, error: 'JSON 格式錯誤：' + String(e.message).slice(0, 80) }; }
    var spec = normalize(j); if (!spec.parts.length) { return { ok: false, error: 'JSON 裡沒有可用的零件（parts）' }; }
    var bad = spec.parts.filter(function (p) { var o = p.outline; return !(o.w > 0 && o.h > 0); }); if (bad.length) { return { ok: false, error: '零件尺寸不合格：' + bad.map(function (p) { return p.id; }).join('、') }; }
    return { ok: true, spec: spec };
  }

  // 這句話是不是在要「工程圖／CAD 風格的尺寸圖」（中英文都算；助理常把使用者的話改寫成英文）
  var CAD_RE = /工程圖|零件圖|尺寸圖|裁切圖|裁剪圖|組裝圖|三視圖|展開圖|施工圖|樣板|CAD|engineering\s+drawing|technical\s+drawing|blueprint|dimension(?:ed|s)?|exploded\s+view|assembly\s+drawing|parts?\s+list|bill\s+of\s+materials|每個\s*(?:零件|Component|元件)/i;
  function isCadRequest(text) { return CAD_RE.test(String(text || '')); }
  return { isCadRequest: isCadRequest, normalize: normalize, render: render, specFromTable: specFromTable, specPrompt: specPrompt, parseSpecReply: parseSpecReply, violinPoints: violinPoints, closedSpline: closedSpline, LIM: LIM, KINDS: KINDS };
});
