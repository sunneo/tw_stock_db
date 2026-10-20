// 教育文書（學習單／練習卷）核心：一份「學習單描述」(spec) → 排版 → 圖形清單 → HTML（SVG，可預覽、可列印）／PDF（pdfmake 的向量圖形）／PNG。
// 純函式，不碰 DOM／網路，node 與瀏覽器都能跑（UMD，嵌入成 FaWorksheet，見 scripts/embed-code-ui.js）。
//
// 設計（跟 CoLU 的形狀一致）：
//   - 程式先讀：parseRequest(文字) 用規則讀出「是哪一種學習單、幾排、什麼顏色、右邊要不要填答案」，每個決定都有程式的預設值；
//   - 弱的模型／離線模型只在「真的有歧義」時被問一個封閉題（字母選擇題，resolveQuestions）；
//   - 參考圖片：視覺模型只回一小段 JSON（refPrompt／refFromReply，程式檢查每個欄位），不讓它自由發揮；
//   - 人工調整：applyEdits 是一組封閉的編輯動作（改標題、改某串顏色、改排數、答案顯示…），不是「重新生成」；
//   - 所有輸出都經過 validate（上限、型別、顏色格式），壞的欄位退回預設並回報，不丟例外。
// 座標單位一律是毫米（頁面左上角為原點）；文字大小也是毫米（1pt ≈ 0.3528mm）。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaWorksheet = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var PT = 0.352778; // 1pt 等於幾毫米
  var PAGES = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4] };
  var LIMITS = { rows: 20, blocks: 12, beads: 30, equations: 40, text: 4000, title: 80 };

  // 串珠的顏色（跟蒙特梭利彩色串珠學習單一樣：1 紅、2 綠、3 粉、4 黃、5 藍、6 紫、7 白、8 桃紅、9 深藍；金色是「10」）
  var BEAD_COLORS = { 1: '#C8174F', 2: '#8CC63F', 3: '#F2D4CF', 4: '#F5E51E', 5: '#3F87D4', 6: '#5E2C79', 7: '#FFFFFF', 8: '#E0457B', 9: '#274B8F', 10: '#E9B22E' };
  var GOLD = '#E9B22E';
  var COLOR_WORDS = { red: '#C8174F', 紅: '#C8174F', 紅色: '#C8174F', green: '#8CC63F', 綠: '#8CC63F', 綠色: '#8CC63F', pink: '#F2D4CF', 粉: '#F2D4CF', 粉紅: '#F2D4CF', 粉紅色: '#F2D4CF', 淺粉: '#F2D4CF', yellow: '#F5E51E', 黃: '#F5E51E', 黃色: '#F5E51E', blue: '#3F87D4', 藍: '#3F87D4', 藍色: '#3F87D4', 淺藍: '#3F87D4', lightblue: '#3F87D4', purple: '#5E2C79', 紫: '#5E2C79', 紫色: '#5E2C79', white: '#FFFFFF', 白: '#FFFFFF', 白色: '#FFFFFF', magenta: '#E0457B', 桃紅: '#E0457B', 洋紅: '#E0457B', 玫紅: '#E0457B', darkblue: '#274B8F', 深藍: '#274B8F', 深藍色: '#274B8F', navy: '#274B8F', gold: '#E9B22E', 金: '#E9B22E', 金色: '#E9B22E', 黃金: '#E9B22E', orange: '#F28C28', 橘: '#F28C28', 橘色: '#F28C28', 橙色: '#F28C28', brown: '#8B5A2B', 棕: '#8B5A2B', 棕色: '#8B5A2B', 咖啡色: '#8B5A2B', black: '#222222', 黑: '#222222', 黑色: '#222222', gray: '#9AA0A6', grey: '#9AA0A6', 灰: '#9AA0A6', 灰色: '#9AA0A6' };

  function clamp(n, a, b) { n = Number(n); if (!isFinite(n)) return a; return Math.max(a, Math.min(b, n)); }
  function int(n, d) { n = Math.round(Number(n)); return isFinite(n) ? n : d; }
  function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max || 200); }
  function hex(c, fallback) {
    if (typeof c !== 'string') return fallback; var s = c.trim(), m = /^#?([0-9a-f]{6})$/i.exec(s); if (m) return '#' + m[1].toUpperCase();
    m = /^#?([0-9a-f]{3})$/i.exec(s); if (m) return '#' + m[1].split('').map(function (x) { return x + x; }).join('').toUpperCase();
    var w = COLOR_WORDS[s.toLowerCase().replace(/[\s_-]/g, '')] || COLOR_WORDS[s]; return w || fallback;
  }
  function mix(a, b, t) { var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16), o = '#'; [16, 8, 0].forEach(function (sh) { var x = (pa >> sh) & 255, y = (pb >> sh) & 255; var v = Math.round(x + (y - x) * t); o += (v < 16 ? '0' : '') + v.toString(16); }); return o.toUpperCase(); }
  function darker(c) { return mix(c, '#000000', 0.38); }
  function lighter(c) { return mix(c, '#FFFFFF', 0.62); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  // 文字寬度的估計（毫米）：中日韓字與全形標點＝1 個字高，英文與數字約 0.56，大寫與寬字母多一點；PDF 的置中、靠右用它（SVG 自己會量）
  function textWidth(s, size) { var w = 0; String(s).split('').forEach(function (ch) { var c = ch.charCodeAt(0); if (c > 0x2e80 || (c >= 0xff00 && c <= 0xffef) || (c >= 0x2000 && c <= 0x206f && c > 0x2015)) w += 1; else if (/[A-Z%@MW]/.test(ch)) w += 0.68; else if (/[ilI.,;:'|!]/.test(ch)) w += 0.3; else if (ch === ' ') w += 0.3; else w += 0.56; }); return w * size; }

  // ───────────────────────── 預設與驗證 ─────────────────────────
  function defaults() {
    return { title: '', subtitle: '', header: { name: true, date: true }, page: { size: 'A4', orient: 'portrait', margin: 14 }, blocks: [] };
  }
  function beadBlock(o) {
    o = o || {}; var counts = (o.counts && o.counts.length ? o.counts : [1, 2, 3, 4, 5, 6, 7, 8]).slice(0, LIMITS.rows);
    return { type: 'bead_rows', base: o.base || 10, counts: counts, colors: o.colors || {}, baseColor: o.baseColor || GOLD, answer: o.answer || { side: 'right', line: true, show: false }, size: o.size || 1 };
  }
  // 把任何來源的 spec 整理成合法、有上限的形狀；壞的欄位退回預設並放進 problems（不丟例外）
  function validate(input) {
    var problems = [], s = defaults(); var r = input && typeof input === 'object' ? input : {};
    if (!input || typeof input !== 'object') problems.push('描述不是物件，改用空白學習單');
    s.title = str(r.title, LIMITS.title); s.subtitle = str(r.subtitle, 160);
    var h = r.header || {}; s.header = { name: h.name !== false, date: h.date !== false, school: h.school ? str(h.school, 30) : undefined, score: h.score === true };
    var pg = r.page || {}; var size = PAGES[pg.size] ? pg.size : 'A4'; if (pg.size && !PAGES[pg.size]) problems.push('不認得紙張「' + pg.size + '」，改用 A4');
    s.page = { size: size, orient: pg.orient === 'landscape' ? 'landscape' : 'portrait', margin: clamp(pg.margin == null ? 14 : pg.margin, 6, 30) };
    var blocks = Array.isArray(r.blocks) ? r.blocks.slice(0, LIMITS.blocks) : []; if (Array.isArray(r.blocks) && r.blocks.length > LIMITS.blocks) problems.push('區塊太多，只留前 ' + LIMITS.blocks + ' 個');
    blocks.forEach(function (b, i) { var nb = validateBlock(b, problems, i + 1); if (nb) s.blocks.push(nb); });
    return { ok: true, spec: s, problems: problems };
  }
  function validateAnswer(a) { a = a && typeof a === 'object' ? a : {}; return { side: a.side === 'none' ? 'none' : (a.side === 'below' ? 'below' : 'right'), line: a.line !== false, show: a.show === true }; }
  function validateBlock(b, problems, n) {
    if (!b || typeof b !== 'object') { problems.push('第 ' + n + ' 個區塊不是物件，略過'); return null; } var t = String(b.type || '');
    if (t === 'bead_rows') {
      var base = clamp(int(b.base, 10), 2, 20); var counts = (Array.isArray(b.counts) ? b.counts : []).map(function (x) { return int(x, 0); }).filter(function (x) { return x >= 1 && x <= LIMITS.beads; }).slice(0, LIMITS.rows);
      if (!counts.length) { counts = [1, 2, 3, 4, 5, 6, 7, 8]; problems.push('串珠沒有有效的顆數，改用 1～8'); }
      var colors = {}; Object.keys(b.colors || {}).forEach(function (k) { var c = hex(b.colors[k]); if (c && /^\d+$/.test(k)) colors[k] = c; });
      return { type: 'bead_rows', base: base, counts: counts, colors: colors, baseColor: hex(b.baseColor, GOLD), answer: validateAnswer(b.answer), size: clamp(b.size == null ? 1 : b.size, 0.4, 1.4) };
    }
    if (t === 'count_rows') {
      var cs = (Array.isArray(b.counts) ? b.counts : []).map(function (x) { return int(x, 0); }).filter(function (x) { return x >= 1 && x <= LIMITS.beads; }).slice(0, LIMITS.rows); if (!cs.length) { cs = [3, 5, 2, 7, 4, 6]; problems.push('數一數沒有有效的數量，用預設'); }
      var shape = ['circle', 'square', 'star'].indexOf(b.shape) >= 0 ? b.shape : 'circle';
      return { type: 'count_rows', counts: cs, shape: shape, color: hex(b.color, '#E0457B'), colors: Array.isArray(b.colors) ? b.colors.map(function (c) { return hex(c); }).filter(Boolean).slice(0, 8) : [], answer: validateAnswer(b.answer), size: clamp(b.size == null ? 1 : b.size, 0.4, 1.4) };
    }
    if (t === 'equations') {
      var items = Array.isArray(b.items) ? b.items.map(function (x) { return str(x, 40); }).filter(Boolean).slice(0, LIMITS.equations) : [];
      if (!items.length) { items = makeEquations(b.kind === 'sub' ? 'sub' : 'add', clamp(int(b.max, 10), 2, 100), clamp(int(b.count, 10), 1, LIMITS.equations), int(b.seed, 7)); }
      return { type: 'equations', items: items, columns: clamp(int(b.columns, 2), 1, 4), size: clamp(b.size == null ? 1 : b.size, 0.6, 1.5) };
    }
    if (t === 'ten_frames') { var ns = (Array.isArray(b.counts) ? b.counts : []).map(function (x) { return int(x, -1); }).filter(function (x) { return x >= 0 && x <= 10; }).slice(0, 12); if (!ns.length) ns = [3, 5, 7, 8, 4, 6]; return { type: 'ten_frames', counts: ns, color: hex(b.color, '#3F87D4'), answer: validateAnswer(b.answer), columns: clamp(int(b.columns, 2), 1, 3) }; }
    if (t === 'number_line') { var from = int(b.from, 0), to = int(b.to, 20); if (to <= from || to - from > 40) { problems.push('數線範圍不合理，改用 0～20'); from = 0; to = 20; } return { type: 'number_line', from: from, to: to, blanks: (Array.isArray(b.blanks) ? b.blanks : []).map(function (x) { return int(x, from - 1); }).filter(function (x) { return x >= from && x <= to; }).slice(0, 20) }; }
    if (t === 'text') { return { type: 'text', lines: (Array.isArray(b.lines) ? b.lines : [str(b.text, LIMITS.text)]).map(function (x) { return str(x, 200); }).filter(Boolean).slice(0, 30), size: clamp(b.size == null ? 1 : b.size, 0.6, 2), align: b.align === 'center' ? 'center' : 'left', bold: b.bold === true }; }
    if (t === 'spacer') return { type: 'spacer', mm: clamp(b.mm == null ? 10 : b.mm, 1, 80) };
    problems.push('不認得的區塊種類「' + t + '」（第 ' + n + ' 個），略過'); return null;
  }
  function makeEquations(kind, max, count, seed) {
    var out = [], s = seed || 7; function rnd(n) { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; }
    var guard = 0; while (out.length < count && guard++ < 400) { var a = 1 + rnd(max - 1), b = 1 + rnd(max - 1); if (kind === 'sub') { if (a < b) { var t = a; a = b; b = t; } if (a === b) continue; var q = a + ' − ' + b + ' = ____'; } else { if (a + b > max) continue; q = a + ' + ' + b + ' = ____'; } if (out.indexOf(q) < 0) out.push(q); }
    return out;
  }

  // ───────────────────────── 排版：spec → 圖形清單 ─────────────────────────
  // 圖形：circle{cx,cy,r,fill,stroke,sw} rect{x,y,w,h,fill,stroke,sw,rx} line{x1,y1,x2,y2,stroke,sw,dash} poly{pts,fill,stroke,sw} text{x,y,s,size,bold,anchor,fill}
  function layout(spec) {
    var v = validate(spec); var sp = v.spec, dim = PAGES[sp.page.size], W = sp.page.orient === 'landscape' ? dim[1] : dim[0], H = sp.page.orient === 'landscape' ? dim[0] : dim[1], M = sp.page.margin;
    var prims = [], y = M, notes = v.problems.slice();
    function text(x, yy, s, size, o) { o = o || {}; prims.push({ t: 'text', x: x, y: yy, s: s, size: size, bold: !!o.bold, anchor: o.anchor || 'start', fill: o.fill || '#222222' }); }
    function line(x1, y1, x2, y2, o) { o = o || {}; prims.push({ t: 'line', x1: x1, y1: y1, x2: x2, y2: y2, stroke: o.stroke || '#222222', sw: o.sw || 0.3, dash: o.dash }); }
    // 抬頭
    if (sp.title) { var ts = 22 * PT; y += ts * 0.95; text(W / 2, y, sp.title, ts, { bold: true, anchor: 'middle' }); y += 4; }
    if (sp.subtitle) { var ss = 10.5 * PT; y += ss + 1.5; text(W / 2, y, sp.subtitle, ss, { anchor: 'middle', fill: '#444444' }); y += 2.5; }
    if (sp.header.name || sp.header.date || sp.header.school || sp.header.score) {
      var hs = 11 * PT; y += 7 + hs; var x = M + 2; var fields = []; if (sp.header.school) fields.push(['學校：', 52]); if (sp.header.name) fields.push(['姓名：', 54]); if (sp.header.date) fields.push(['日期：', 40]); if (sp.header.score) fields.push(['分數：', 28]);
      fields.forEach(function (f) { text(x, y, f[0], hs); var lw = textWidth(f[0], hs); line(x + lw + 1, y + 0.6, x + lw + 1 + f[1], y + 0.6, { sw: 0.25 }); x += lw + f[1] + 8; });
      y += 4;
    }
    var top = y + 4, bottom = H - M, area = bottom - top;
    var boxes = [{ kind: 'title', x: M, y: M, w: W - 2 * M, h: Math.max(8, top - M - (sp.header.name || sp.header.date ? 14 : 2)) }]; if (sp.header.name || sp.header.date || sp.header.school || sp.header.score) boxes.push({ kind: 'header', x: M, y: top - 18, w: W - 2 * M, h: 12 });
    var gen = { text: text, line: line, prims: prims, W: W, H: H, M: M, notes: notes, rowBoxes: [] };
    // 每個區塊按權重分配高度
    var weights = sp.blocks.map(function (b) { return blockWeight(b); }), totalW = weights.reduce(function (a, b) { return a + b; }, 0) || 1, cursor = top;
    sp.blocks.forEach(function (b, i) { var h = area * weights[i] / totalW; gen.bi = i; drawBlock(b, gen, M, cursor, W - 2 * M, h); boxes.push({ kind: 'block', b: i, x: M, y: cursor, w: W - 2 * M, h: h }); cursor += h; });
    return { w: W, h: H, prims: prims, notes: notes, spec: sp, boxes: boxes, rowBoxes: gen.rowBoxes };
  }
  function blockWeight(b) {
    if (b.type === 'spacer') return Math.max(0.05, b.mm / 200);
    if (b.type === 'text') return Math.max(0.12, b.lines.length * 0.05 * b.size);
    if (b.type === 'number_line') return 0.3;
    if (b.type === 'equations') return Math.max(0.4, Math.ceil(b.items.length / b.columns) * 0.09 * b.size);
    if (b.type === 'ten_frames') return Math.max(0.5, Math.ceil(b.counts.length / b.columns) * 0.28);
    if (b.type === 'count_rows') return Math.max(0.6, b.counts.length * 0.12 * b.size);
    return Math.max(0.8, b.counts.length * 0.125);
  }
  function bead(prims, cx, cy, r, fill, stroke) {
    prims.push({ t: 'circle', cx: cx, cy: cy, r: r, fill: fill, stroke: stroke || darker(fill), sw: Math.max(0.2, r * 0.1) });
    prims.push({ t: 'circle', cx: cx - r * 0.3, cy: cy - r * 0.34, r: r * 0.2, fill: mix(fill, '#FFFFFF', 0.62), stroke: 'none', sw: 0 });
  }
  function ring(prims, cx, cy, r) { prims.push({ t: 'circle', cx: cx, cy: cy, r: r, fill: '#FFFFFF', stroke: '#555555', sw: 0.22 }); }
  function answerSlot(g, b, x1, x2, cy, value) {
    var a = b.answer || {}; if (a.side === 'none' || a.line === false && !a.show) return;
    if (a.side === 'below') { g.line(x1, cy + 5, x2, cy + 5, { sw: 0.3 }); if (a.show) g.text((x1 + x2) / 2, cy + 3.6, String(value), 5, { anchor: 'middle', fill: '#C0392B', bold: true }); return; }
    if (a.line !== false) g.line(x1, cy + 3, x2, cy + 3, { sw: 0.35 });
    if (a.show) g.text((x1 + x2) / 2, cy + 1.8, String(value), 6, { anchor: 'middle', fill: '#C0392B', bold: true });
  }
  function drawBlock(b, g, x0, y0, w, h) {
    var P = g.prims;
    if (b.type === 'bead_rows') {
      var n = b.counts.length, maxC = Math.max.apply(null, b.counts), ansW = b.answer.side === 'right' ? 38 : 0, ringR = 0.17;
      var avail = w - ansW - 2; var d = Math.min(avail / (b.base + maxC + 1.7), (h / n) * 0.62, 11) * b.size, r = d / 2, step = h / n;
      b.counts.forEach(function (c, i) {
        var cy = y0 + step * i + step / 2, x = x0 + d * ringR; g.rowBoxes.push({ b: g.bi, r: i, count: c, x: x0, y: y0 + step * i, w: w, h: step }); ring(P, x, cy, d * ringR); x += d * ringR + r * 0.9; var gold = hex(b.baseColor, GOLD);
        for (var k = 0; k < b.base; k++) { bead(P, x, cy, r, gold, darker(gold)); x += d; }
        x += d * 0.18; var col = hex(b.colors[c], BEAD_COLORS[c] || '#999999');
        for (var j = 0; j < c; j++) { bead(P, x - r * 0.9 + r, cy, r, col, col.toUpperCase() === '#FFFFFF' ? '#555555' : darker(col)); x += d; }
        ring(P, x - r + d * ringR * 1.1, cy, d * ringR);
        if (b.answer.side === 'right') answerSlot(g, b, x0 + w - ansW + 6, x0 + w, cy, b.base + c); else answerSlot(g, b, x0 + w * 0.55, x0 + w * 0.9, cy + step * 0.18, b.base + c);
      });
      return;
    }
    if (b.type === 'count_rows') {
      var nr = b.counts.length, maxN = Math.max.apply(null, b.counts), aw = b.answer.side === 'right' ? 38 : 0, sz = Math.min((w - aw - 4) / (maxN + 0.5), (h / nr) * 0.7, 12) * b.size, st = h / nr;
      b.counts.forEach(function (c, i) { g.rowBoxes.push({ b: g.bi, r: i, count: c, x: x0, y: y0 + st * i, w: w, h: st }); var cy = y0 + st * i + st / 2, col = (b.colors && b.colors.length ? b.colors[i % b.colors.length] : b.color); for (var k = 0; k < c; k++) shape(P, b.shape, x0 + sz * (k + 0.6), cy, sz * 0.42, col); answerSlot(g, b, x0 + w - aw + 6, x0 + w, cy, c); });
      return;
    }
    if (b.type === 'equations') {
      var rowsN = Math.ceil(b.items.length / b.columns), rh = Math.min(h / rowsN, 18), fs = Math.min(rh * 0.5, 7.5) * b.size, cw = w / b.columns;
      b.items.forEach(function (q, i) { var rr = Math.floor(i / b.columns), cc = i % b.columns; g.text(x0 + cc * cw + 4, y0 + rh * rr + rh * 0.7, (i + 1) + '.  ' + q, fs); });
      return;
    }
    if (b.type === 'ten_frames') {
      var cols = b.columns, rowsF = Math.ceil(b.counts.length / cols), cw2 = w / cols, rh2 = h / rowsF, fw = Math.min(cw2 * 0.62, rh2 * 1.9, 80), fh = fw / 2.4, cell = fw / 5;
      b.counts.forEach(function (c, i) {
        var rr = Math.floor(i / cols), cc = i % cols, fx = x0 + cc * cw2 + 4, fy = y0 + rr * rh2 + (rh2 - fh) / 2 - 2;
        P.push({ t: 'rect', x: fx, y: fy, w: fw, h: fh, fill: '#FFFFFF', stroke: '#444444', sw: 0.4, rx: 0 }); g.line(fx, fy + fh / 2, fx + fw, fy + fh / 2, { sw: 0.3 }); for (var k = 1; k < 5; k++) g.line(fx + cell * k, fy, fx + cell * k, fy + fh, { sw: 0.3 });
        for (var j = 0; j < c; j++) { var col2 = j % 5, row2 = j < 5 ? 0 : 1; P.push({ t: 'circle', cx: fx + cell * (col2 + 0.5), cy: fy + fh * (row2 * 0.5 + 0.25), r: cell * 0.34, fill: b.color, stroke: darker(b.color), sw: 0.2 }); }
        answerSlot(g, b, fx + fw + 4, fx + fw + 30, fy + fh / 2 - 2, c);
      });
      return;
    }
    if (b.type === 'number_line') {
      var cy3 = y0 + h * 0.55, n3 = b.to - b.from, stp = (w - 12) / n3; g.line(x0 + 4, cy3, x0 + w - 4, cy3, { sw: 0.5 });
      for (var q = 0; q <= n3; q++) { var vx = x0 + 6 + q * stp, v = b.from + q; g.line(vx, cy3 - 2, vx, cy3 + 2, { sw: 0.35 }); if (b.blanks.indexOf(v) >= 0) { P.push({ t: 'rect', x: vx - stp * 0.4, y: cy3 + 4, w: stp * 0.8, h: 6, fill: '#FFFFFF', stroke: '#444444', sw: 0.3, rx: 0 }); } else g.text(vx, cy3 + 8, String(v), Math.min(5, stp * 0.6), { anchor: 'middle' }); }
      return;
    }
    if (b.type === 'text') {
      var fs2 = 4.2 * b.size, lh = fs2 * 1.6; b.lines.forEach(function (ln, i) { if (y0 + lh * (i + 1) <= y0 + h + 2) g.text(b.align === 'center' ? x0 + w / 2 : x0 + 2, y0 + lh * (i + 1), ln, fs2, { anchor: b.align === 'center' ? 'middle' : 'start', bold: b.bold }); });
    }
  }
  function shape(P, kind, cx, cy, r, col) {
    if (kind === 'square') P.push({ t: 'rect', x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: col, stroke: darker(col), sw: 0.25, rx: r * 0.15 });
    else if (kind === 'star') { var pts = []; for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r * 1.08; pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); } P.push({ t: 'poly', pts: pts, fill: col, stroke: darker(col), sw: 0.25 }); }
    else bead(P, cx, cy, r, col, darker(col));
  }

  // ───────────────────────── 輸出：SVG／HTML／pdfmake／畫布 ─────────────────────────
  function f(n) { return Math.round(n * 100) / 100; }
  function toSvg(L, opt) {
    opt = opt || {}; var o = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + f(L.w) + ' ' + f(L.h) + '" width="' + f(L.w) + 'mm" height="' + f(L.h) + 'mm" font-family="' + esc(opt.font || "'Noto Sans TC','Microsoft JhengHei','PingFang TC',sans-serif") + '">', '<rect width="' + f(L.w) + '" height="' + f(L.h) + '" fill="#FFFFFF"/>'];
    L.prims.forEach(function (p) {
      if (p.t === 'circle') o.push('<circle cx="' + f(p.cx) + '" cy="' + f(p.cy) + '" r="' + f(p.r) + '" fill="' + p.fill + '"' + (p.stroke && p.stroke !== 'none' ? ' stroke="' + p.stroke + '" stroke-width="' + f(p.sw) + '"' : '') + '/>');
      else if (p.t === 'rect') o.push('<rect x="' + f(p.x) + '" y="' + f(p.y) + '" width="' + f(p.w) + '" height="' + f(p.h) + '" fill="' + p.fill + '"' + (p.rx ? ' rx="' + f(p.rx) + '"' : '') + (p.stroke && p.stroke !== 'none' ? ' stroke="' + p.stroke + '" stroke-width="' + f(p.sw) + '"' : '') + '/>');
      else if (p.t === 'line') o.push('<line x1="' + f(p.x1) + '" y1="' + f(p.y1) + '" x2="' + f(p.x2) + '" y2="' + f(p.y2) + '" stroke="' + p.stroke + '" stroke-width="' + f(p.sw) + '"' + (p.dash ? ' stroke-dasharray="' + p.dash + '"' : '') + '/>');
      else if (p.t === 'poly') o.push('<polygon points="' + p.pts.map(function (q) { return f(q[0]) + ',' + f(q[1]); }).join(' ') + '" fill="' + p.fill + '" stroke="' + p.stroke + '" stroke-width="' + f(p.sw) + '"/>');
      else if (p.t === 'text') o.push('<text x="' + f(p.x) + '" y="' + f(p.y) + '" font-size="' + f(p.size) + '"' + (p.bold ? ' font-weight="700"' : '') + ' text-anchor="' + p.anchor + '" fill="' + p.fill + '">' + esc(p.s) + '</text>');
    });
    var sel = opt.selected;
    if (sel) {
      var bx = null; if (sel.kind === 'row') bx = (L.rowBoxes || []).filter(function (x) { return x.b === sel.b && x.r === sel.r; })[0]; else if (sel.kind === 'block') bx = (L.boxes || []).filter(function (x) { return x.kind === 'block' && x.b === sel.b; })[0]; else bx = (L.boxes || []).filter(function (x) { return x.kind === sel.kind; })[0];
      if (bx) o.push('<rect x="' + f(bx.x - 1) + '" y="' + f(bx.y) + '" width="' + f(bx.w + 2) + '" height="' + f(bx.h) + '" fill="#2F81F7" fill-opacity="0.07" stroke="#2F81F7" stroke-width="0.5" stroke-dasharray="2 1.2" rx="1.5" pointer-events="none"/>');
    }
    o.push('</svg>'); return o.join('\n');
  }
  // 點到版面上的什麼（座標是毫米）：{kind:'row',b,r}｜{kind:'block',b}｜{kind:'title'|'header'}｜null
  function hitTest(L, mx, my) {
    var inb = function (x) { return mx >= x.x && mx <= x.x + x.w && my >= x.y && my <= x.y + x.h; };
    var rb = (L.rowBoxes || []).filter(inb)[0]; if (rb) return { kind: 'row', b: rb.b, r: rb.r };
    var hb = (L.boxes || []).filter(inb), blk = hb.filter(function (x) { return x.kind === 'block'; })[0]; if (blk) return { kind: 'block', b: blk.b }; if (hb[0]) return { kind: hb[0].kind }; return null;
  }
  // 可以直接開啟、列印、再微調的 HTML（一頁一張 SVG；@page 設好紙張，瀏覽器「列印→另存 PDF」就是同一個樣子）
  function toHtml(L, opt) {
    opt = opt || {}; var title = esc((L.spec && L.spec.title) || '學習單');
    return '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>' + title + '</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>@page{size:' + f(L.w) + 'mm ' + f(L.h) + 'mm;margin:0}html,body{margin:0;background:#e8e8e8}.page{width:' + f(L.w) + 'mm;height:' + f(L.h) + 'mm;margin:8mm auto;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.3)}.page svg{display:block}@media print{html,body{background:#fff}.page{margin:0;box-shadow:none}}</style></head><body><div class="page">' + toSvg(L, opt) + '</div></body></html>';
  }
  // pdfmake：圖形用向量（canvas），文字用絕對位置。pt = mm / 0.352778
  function toPdfmake(L, opt) {
    opt = opt || {}; var k = 1 / PT, font = opt.font || 'NotoSansTC', cv = [], texts = [];
    function ell(p) { var e = { type: 'ellipse', x: p.cx * k, y: p.cy * k, r1: p.r * k, r2: p.r * k, color: p.fill }; if (p.stroke && p.stroke !== 'none') { e.lineColor = p.stroke; e.lineWidth = Math.max(0.3, p.sw * k); } else { e.lineColor = p.fill; e.lineWidth = 0; } return e; }
    L.prims.forEach(function (p) {
      if (p.t === 'circle') cv.push(ell(p));
      else if (p.t === 'rect') { var r = { type: 'rect', x: p.x * k, y: p.y * k, w: p.w * k, h: p.h * k, color: p.fill, lineColor: p.stroke && p.stroke !== 'none' ? p.stroke : p.fill, lineWidth: p.stroke && p.stroke !== 'none' ? Math.max(0.3, p.sw * k) : 0 }; if (p.rx) r.r = p.rx * k; cv.push(r); }
      else if (p.t === 'line') cv.push({ type: 'line', x1: p.x1 * k, y1: p.y1 * k, x2: p.x2 * k, y2: p.y2 * k, lineWidth: Math.max(0.3, p.sw * k), lineColor: p.stroke, dash: p.dash ? { length: 3 } : undefined });
      else if (p.t === 'poly') cv.push({ type: 'polyline', points: p.pts.map(function (q) { return { x: q[0] * k, y: q[1] * k }; }), closePath: true, color: p.fill, lineColor: p.stroke, lineWidth: Math.max(0.3, p.sw * k) });
      else if (p.t === 'text') { var fs = p.size * k, str2 = String(p.s).replace(/｜/g, ' | '), w = textWidth(str2, fs), x = p.anchor === 'middle' ? p.x * k - w / 2 : (p.anchor === 'end' ? p.x * k - w : p.x * k); texts.push({ text: str2, fontSize: fs, bold: !!p.bold, color: p.fill, font: font, absolutePosition: { x: x, y: p.y * k - fs * 0.84 }, noWrap: true }); }
    });
    return { pageSize: { width: L.w * k, height: L.h * k }, pageMargins: [0, 0, 0, 0], info: { title: (L.spec && L.spec.title) || '學習單', creator: 'Floating AI Assistant' }, defaultStyle: { font: font }, content: [{ canvas: cv, absolutePosition: { x: 0, y: 0 } }].concat(texts) };
  }
  // 畫在 2D 畫布上（轉 PNG 預覽／點陣輸出用）：scale＝每毫米幾個像素
  function drawCanvas(ctx, L, scale, fontFamily) {
    var s = scale || 6; ctx.save(); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, L.w * s, L.h * s);
    L.prims.forEach(function (p) {
      if (p.t === 'circle') { ctx.beginPath(); ctx.arc(p.cx * s, p.cy * s, p.r * s, 0, Math.PI * 2); ctx.fillStyle = p.fill; ctx.fill(); if (p.stroke && p.stroke !== 'none') { ctx.lineWidth = p.sw * s; ctx.strokeStyle = p.stroke; ctx.stroke(); } }
      else if (p.t === 'rect') { ctx.fillStyle = p.fill; ctx.fillRect(p.x * s, p.y * s, p.w * s, p.h * s); if (p.stroke && p.stroke !== 'none') { ctx.lineWidth = p.sw * s; ctx.strokeStyle = p.stroke; ctx.strokeRect(p.x * s, p.y * s, p.w * s, p.h * s); } }
      else if (p.t === 'line') { ctx.beginPath(); ctx.moveTo(p.x1 * s, p.y1 * s); ctx.lineTo(p.x2 * s, p.y2 * s); ctx.lineWidth = p.sw * s; ctx.strokeStyle = p.stroke; ctx.stroke(); }
      else if (p.t === 'poly') { ctx.beginPath(); p.pts.forEach(function (q, i) { if (i) ctx.lineTo(q[0] * s, q[1] * s); else ctx.moveTo(q[0] * s, q[1] * s); }); ctx.closePath(); ctx.fillStyle = p.fill; ctx.fill(); ctx.lineWidth = p.sw * s; ctx.strokeStyle = p.stroke; ctx.stroke(); }
      else if (p.t === 'text') { ctx.font = (p.bold ? '700 ' : '400 ') + (p.size * s) + 'px ' + (fontFamily || "'Noto Sans TC','Microsoft JhengHei',sans-serif"); ctx.textAlign = p.anchor === 'middle' ? 'center' : (p.anchor === 'end' ? 'right' : 'left'); ctx.fillStyle = p.fill; ctx.fillText(p.s, p.x * s, p.y * s); }
    });
    ctx.restore();
  }

  // ───────────────────────── 程式先讀：請求文字 → spec ─────────────────────────
  function cnNum(s) { var m = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }; if (/^\d+$/.test(s)) return parseInt(s, 10); if (s === '十') return 10; if (s.length === 1) return m[s]; if (s[0] === '十') return 10 + (m[s[1]] || 0); if (s[1] === '十') return (m[s[0]] || 0) * 10 + (m[s[2]] || 0); return NaN; }
  function detectTemplate(t) {
    if (/串珠|金色珠|彩色珠|\d+\s*又\s*\d*|又\s*幾|bead/i.test(t)) return 'bead_rows';
    if (/十格|ten[\s-]?frame/i.test(t)) return 'ten_frames';
    if (/數線|number[\s-]?line/i.test(t)) return 'number_line';
    if (/數一數|數數看|幾個|count(ing)?\b/i.test(t)) return 'count_rows';
    if (/加法|減法|算式|計算題|練習題|equation|addition|subtraction|\d+\s*[+＋\-－−]\s*\d+/i.test(t)) return 'equations';
    return null;
  }
  // 回傳 { ok, template, spec, notes, questions }；questions 是封閉題（有預設值），程式先照預設做
  function parseRequest(text, ctx) {
    ctx = ctx || {}; var t = String(text || '').replace(/\[附件：[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim(); var notes = [], questions = [];
    var tpl = ctx.template || detectTemplate(t); if (!tpl) return { ok: false, error: '看不出要做哪一種學習單（目前會做：串珠「10又幾」、數一數、十格框、數線、加減法算式）', notes: notes, questions: [] };
    var spec = defaults(); var wide = /橫式|橫向|landscape/i.test(t); if (wide) spec.page.orient = 'landscape'; var sz = /\bA5\b/i.test(t) ? 'A5' : (/letter/i.test(t) ? 'Letter' : 'A4'); spec.page.size = sz;
    var answer = { side: 'right', line: true, show: false };
    if (/(附|有|含|顯示|標出)[^，。,;]{0,6}(答案|解答)|教師版|answer\s*key/i.test(t)) { answer.show = true; notes.push('做成教師版：右邊的線上會寫出答案'); }
    if (/(下方|下面|題目下)[^，。]{0,4}(填|寫)/.test(t)) answer.side = 'below';
    if (/不要[^，。]{0,4}(填答|答案線|橫線)/.test(t)) answer.line = false;
    if (tpl === 'bead_rows') {
      var base = 10, bm = /(\d+|[一二兩三四五六七八九十]{1,3})\s*又/.exec(t); if (bm && cnNum(bm[1]) >= 2 && cnNum(bm[1]) <= 20) base = cnNum(bm[1]);
      var counts = [], pairs = []; var re = /(\d+|[一二兩三四五六七八九十]{1,3})\s*又\s*(\d+|[一二兩三四五六七八九十]{1,3})/g, m; while ((m = re.exec(t))) pairs.push(cnNum(m[2]));
      var rg = /(\d+|[一二三四五六七八九十]{1,3})\s*又\s*(\d+|[一二三四五六七八九十]{1,3})\s*(?:到|至|~|～|-|－|—|~)\s*(?:(?:\d+|[一二三四五六七八九十]{1,3})\s*又\s*)?(\d+|[一二三四五六七八九十]{1,3})/.exec(t);
      var rowsN = (/(?:共|做|畫|總共|要|需要|各)\s*(\d+|[一二三四五六七八九十]{1,3})\s*(?:串|排|列|行)/.exec(t) || [])[1]; // 「一串10又1」的「一串」是「一條串珠」，不是串數：要有「共／做／畫」這類字才算
      if (rg) { var a = cnNum(rg[2]), b2 = cnNum(rg[3]); if (a >= 1 && b2 >= a && b2 - a < LIMITS.rows) for (var i = a; i <= b2; i++) counts.push(i); }
      else if (pairs.length >= 3) counts = pairs.filter(function (x) { return x >= 1 && x <= LIMITS.beads; });
      else if (ctx.reference && ctx.reference.rows && ctx.reference.rows.length) { counts = ctx.reference.rows.map(function (r) { return r.count; }); notes.push('串數與每串的顆數，照參考圖片'); }
      else { var nrows = rowsN ? cnNum(rowsN) : 8; if (!(nrows >= 1 && nrows <= LIMITS.rows)) nrows = 8; var start = pairs.length ? Math.min.apply(null, pairs) : 1; for (var j = 0; j < nrows; j++) counts.push(start + j); if (!rowsN) { notes.push('沒有指定範圍：先用 ' + counts[0] + '～' + counts[counts.length - 1] + '（共 ' + counts.length + ' 串，跟範例一樣），可以改'); questions.push({ id: 'range', q: '要做幾串？', options: ['1～8（預設）', '1～9', '1～5', '1～3'], values: [[1, 8], [1, 9], [1, 5], [1, 3]], default: 0 }); } }
      var colors = {}; (ctx.reference && ctx.reference.rows || []).forEach(function (r) { if (r.color) colors[r.count] = r.color; }); if (ctx.reference && Object.keys(colors).length) notes.push('顏色照參考圖片（' + Object.keys(colors).length + ' 種）');
      else if (/(顏色|色)[^，。]{0,6}(跟|和|與|同)[^，。]{0,6}(一樣|相同)|同樣的顏色/.test(t)) notes.push('顏色用蒙特梭利彩色串珠的標準色（紅、綠、粉、黃、藍、紫、白、桃紅、深藍），跟範例一樣；有參考圖片時會改照圖片');
      var baseColor = (ctx.reference && ctx.reference.baseColor) || GOLD;
      spec.title = base === 10 ? '彩色串珠｜10又幾（一）' : '彩色串珠｜' + base + '又幾（一）';
      spec.subtitle = '每一串有一整串' + base + '顆金色珠，再加上幾顆彩色珠？在右側橫線上寫下對應的數字';
      spec.blocks.push({ type: 'bead_rows', base: base, counts: counts, colors: colors, baseColor: baseColor, answer: answer, size: 1 });
    } else if (tpl === 'count_rows') {
      var nums = (t.match(/\d+/g) || []).map(Number).filter(function (x) { return x >= 1 && x <= LIMITS.beads; }); var shp = /星/.test(t) ? 'star' : (/方/.test(t) ? 'square' : 'circle'); var cl = (Object.keys(COLOR_WORDS).filter(function (k) { return t.indexOf(k) >= 0 && k.length > 1; }).map(function (k) { return COLOR_WORDS[k]; })[0]) || '#E0457B';
      spec.title = '數一數'; spec.subtitle = '數數看有幾個，在右側橫線上寫下數字'; spec.blocks.push({ type: 'count_rows', counts: nums.length >= 2 ? nums.slice(0, LIMITS.rows) : [3, 5, 2, 7, 4, 6, 8, 1], shape: shp, color: cl, answer: answer });
      if (nums.length < 2) notes.push('沒有指定數量：用預設的 3、5、2、7、4、6、8、1');
    } else if (tpl === 'ten_frames') {
      var ns = (t.match(/\d+/g) || []).map(Number).filter(function (x) { return x >= 0 && x <= 10; }); spec.title = '十格框'; spec.subtitle = '看圖，寫下有幾個圓點'; spec.blocks.push({ type: 'ten_frames', counts: ns.length >= 2 ? ns.slice(0, 12) : [3, 5, 7, 8, 4, 6], answer: answer, columns: 2 }); if (ns.length < 2) notes.push('沒有指定數量：用預設的 3、5、7、8、4、6');
    } else if (tpl === 'number_line') {
      var rr = /(\d+)\s*(?:到|至|~|～|-|－)\s*(\d+)/.exec(t); var fr = rr ? parseInt(rr[1], 10) : 0, to = rr ? parseInt(rr[2], 10) : 20; if (!(to > fr && to - fr <= 40)) { fr = 0; to = 20; } var bl = []; for (var q = fr + 1; q < to; q += 3) bl.push(q); spec.title = '數線'; spec.subtitle = '把空格裡的數字填起來'; spec.blocks.push({ type: 'number_line', from: fr, to: to, blanks: bl });
    } else if (tpl === 'equations') {
      var kind = /減/.test(t) && !/加/.test(t) ? 'sub' : 'add'; var mx = (/(\d+)\s*以內/.exec(t) || [])[1]; var cn = (/(\d+)\s*(?:題|個)/.exec(t) || [])[1]; spec.title = kind === 'sub' ? '減法練習' : '加法練習'; spec.subtitle = '算算看，把答案寫在線上'; spec.blocks.push({ type: 'equations', kind: kind, max: mx ? parseInt(mx, 10) : 10, count: cn ? parseInt(cn, 10) : 10, columns: 2 }); if (!mx) notes.push('沒有指定範圍：10 以內'); if (!cn) notes.push('沒有指定題數：10 題');
    }
    var v = validate(spec); return { ok: true, template: tpl, spec: v.spec, notes: notes.concat(v.problems), questions: questions };
  }
  // 封閉題：pick(題目文字, 選項文字陣列) → 選了第幾個（0 起算）；選不出來或丟錯就用預設值。程式再把選擇套回 spec
  async function resolveQuestions(res, pick) {
    var asked = []; if (!res || !res.questions || !res.questions.length || typeof pick !== 'function') return res;
    for (var i = 0; i < res.questions.length; i++) {
      var q = res.questions[i], idx = q.default; try { var r = await pick(q.q, q.options.slice()); if (typeof r === 'number' && r >= 0 && r < q.options.length) idx = r; } catch (e) { idx = q.default; }
      if (q.id === 'range' && q.values && q.values[idx]) { var rg = q.values[idx], cs = []; for (var k = rg[0]; k <= rg[1]; k++) cs.push(k); var b = res.spec.blocks.filter(function (x) { return x.type === 'bead_rows'; })[0]; if (b) b.counts = cs; }
      asked.push({ id: q.id, chosen: q.options[idx], default: idx === q.default });
    }
    res.asked = asked; return res;
  }

  // ───────────────────────── 參考圖片：視覺模型只回一小段 JSON，程式檢查 ─────────────────────────
  function refPrompt() {
    return '這是一張學習單（或拍下學習單的照片）。只回一段 JSON，不要任何說明、不要 markdown 區塊：{"title":"標題","subtitle":"說明文字","rows":[{"count":1,"color":"#RRGGBB"}],"base_color":"#RRGGBB","base":10,"answer_lines":true}。' +
      'rows 是從上到下每一串「彩色珠」的顆數與顏色（金色／黃色那一長串是 base，不要算進 count）；顏色用最接近的 #RRGGBB。看不出來的欄位就省略，不要猜。';
  }
  function extractJson(text) { var s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b <= a) return null; try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; } }
  function refFromReply(text) {
    var j = extractJson(text); if (!j || typeof j !== 'object') return { ok: false, error: '視覺模型的回覆讀不成 JSON' };
    var rows = (Array.isArray(j.rows) ? j.rows : []).map(function (r) { return { count: int(r && r.count, 0), color: hex(r && r.color) }; }).filter(function (r) { return r.count >= 1 && r.count <= LIMITS.beads; }).slice(0, LIMITS.rows);
    var seen = {}; rows = rows.filter(function (r) { if (seen[r.count]) return false; seen[r.count] = 1; return true; });
    return { ok: true, title: j.title ? str(j.title, LIMITS.title) : '', subtitle: j.subtitle ? str(j.subtitle, 160) : '', rows: rows, baseColor: hex(j.base_color), base: j.base ? clamp(int(j.base, 10), 2, 20) : 0, answerLines: j.answer_lines !== false };
  }
  function mergeRef(spec, ref) {
    var v = validate(spec), s = v.spec, notes = []; if (!ref || !ref.ok) return { spec: s, notes: ['沒有可用的參考圖片資訊'] };
    var b = s.blocks.filter(function (x) { return x.type === 'bead_rows'; })[0];
    if (!b && ref.rows.length) { b = beadBlock({ counts: ref.rows.map(function (r) { return r.count; }).sort(function (x, y) { return x - y; }) }); s.blocks.push(b); if (!s.title) s.title = ref.title || '彩色串珠｜10又幾（一）'; if (!s.subtitle) s.subtitle = ref.subtitle || ''; notes.push('照參考圖片新增一組串珠'); }
    if (b) { if (ref.rows.length) { b.counts = ref.rows.map(function (r) { return r.count; }).sort(function (x, y) { return x - y; }); ref.rows.forEach(function (r) { if (r.color) b.colors[r.count] = r.color; }); notes.push('串數與顏色照參考圖片（' + ref.rows.length + ' 串）'); } if (ref.baseColor) b.baseColor = ref.baseColor; if (ref.base) b.base = ref.base; }
    return { spec: validate(s).spec, notes: notes };
  }

  // ───────────────────────── 人工調整：封閉的編輯動作 ─────────────────────────
  var OPS = ['set_title', 'set_subtitle', 'set_counts', 'set_color', 'set_base_color', 'set_answer', 'set_page', 'set_size', 'set_header', 'add_block', 'remove_block', 'set_rows', 'set_block', 'move_block'];
  function applyEdits(spec, edits) {
    var s = validate(spec).spec, applied = [], rejected = []; var list = Array.isArray(edits) ? edits : (edits ? [edits] : []);
    var bead = function () { return s.blocks.filter(function (x) { return x.type === 'bead_rows' || x.type === 'count_rows' || x.type === 'ten_frames'; })[0]; };
    list.slice(0, 40).forEach(function (e) {
      var op = e && e.op; try {
        if (op === 'set_title') s.title = str(e.text, LIMITS.title);
        else if (op === 'set_subtitle') s.subtitle = str(e.text, 160);
        else if (op === 'set_counts') { var b = bead(); if (!b) throw new Error('沒有可以改顆數的區塊'); var c = (Array.isArray(e.counts) ? e.counts : []).map(Number).filter(function (x) { return x >= (b.type === 'ten_frames' ? 0 : 1) && x <= LIMITS.beads; }); if (!c.length) throw new Error('counts 要是數字陣列'); b.counts = c.slice(0, LIMITS.rows); }
        else if (op === 'set_rows') { var b2 = bead(); if (!b2) throw new Error('沒有可以改串數的區塊'); var n = int(e.n, 0); if (n < 1 || n > LIMITS.rows) throw new Error('n 要在 1～' + LIMITS.rows); var st = b2.counts[0] || 1, cs = []; for (var i = 0; i < n; i++) cs.push(st + i); b2.counts = cs; }
        else if (op === 'set_color') { var b3 = s.blocks.filter(function (x) { return x.type === 'bead_rows'; })[0]; var col = hex(e.color); if (!b3 || !col) throw new Error('要有串珠區塊與合法的顏色'); var k = int(e.count, 0); if (k < 1) throw new Error('count 要是正整數'); b3.colors[k] = col; }
        else if (op === 'set_base_color') { var b4 = s.blocks.filter(function (x) { return x.type === 'bead_rows'; })[0]; var c4 = hex(e.color); if (!b4 || !c4) throw new Error('要有串珠區塊與合法的顏色'); b4.baseColor = c4; }
        else if (op === 'set_answer') { s.blocks.forEach(function (x) { if (x.answer) x.answer = validateAnswer(Object.assign({}, x.answer, { show: e.show === undefined ? x.answer.show : e.show === true, side: e.side || x.answer.side, line: e.line === undefined ? x.answer.line : e.line !== false })); }); }
        else if (op === 'set_page') { s.page = validate({ page: Object.assign({}, s.page, e.page || e) }).spec.page; }
        else if (op === 'set_size') { var f2 = clamp(e.scale, 0.4, 1.4); s.blocks.forEach(function (x) { if (x.size !== undefined) x.size = f2; }); }
        else if (op === 'set_header') { s.header = Object.assign({}, s.header, { name: e.name === undefined ? s.header.name : e.name !== false, date: e.date === undefined ? s.header.date : e.date !== false, school: e.school === true ? '' : s.header.school, score: e.score === undefined ? s.header.score : e.score === true }); }
        else if (op === 'add_block') { var nb = validateBlock(e.block, [], s.blocks.length + 1); if (!nb) throw new Error('區塊不合法'); if (s.blocks.length >= LIMITS.blocks) throw new Error('區塊太多'); s.blocks.splice(clamp(e.index == null ? s.blocks.length : e.index, 0, s.blocks.length), 0, nb); }
        else if (op === 'set_block') { var sbi = int(e.index, -1); if (sbi < 0 || sbi >= s.blocks.length) throw new Error('沒有第 ' + sbi + ' 個區塊（從 0 起算）'); if (!e.patch || typeof e.patch !== 'object') throw new Error('patch 要是物件'); var probs = []; var merged = validateBlock(Object.assign({}, s.blocks[sbi], e.patch, { type: s.blocks[sbi].type }), probs, sbi + 1); if (!merged) throw new Error('改完的區塊不合法'); s.blocks[sbi] = merged; }
        else if (op === 'move_block') { var mi = int(e.index, -1), mt = int(e.to, -1); if (mi < 0 || mi >= s.blocks.length || mt < 0 || mt >= s.blocks.length) throw new Error('index／to 要在 0～' + (s.blocks.length - 1)); var mb = s.blocks.splice(mi, 1)[0]; s.blocks.splice(mt, 0, mb); }
        else if (op === 'remove_block') { var ix = int(e.index, -1); if (ix < 0 || ix >= s.blocks.length) throw new Error('沒有第 ' + ix + ' 個區塊（從 0 起算）'); s.blocks.splice(ix, 1); }
        else throw new Error('不認得的動作「' + op + '」（可用：' + OPS.join('、') + '）');
        applied.push(op);
      } catch (err) { rejected.push({ op: op || '?', error: String(err && err.message || err) }); }
    });
    return { ok: true, spec: validate(s).spec, applied: applied, rejected: rejected };
  }
  function describe(spec) {
    var s = validate(spec).spec, out = [(s.title || '（沒有標題）') + '：' + s.page.size + (s.page.orient === 'landscape' ? ' 橫式' : ' 直式')];
    s.blocks.forEach(function (b, i) { var d = (i) + '. ' + b.type; if (b.counts) d += '（' + b.counts.length + ' 筆：' + b.counts.join('、') + '）'; if (b.items) d += '（' + b.items.length + ' 題）'; if (b.answer) d += b.answer.show ? '，附答案' : '，答案留白'; out.push(d); });
    return out;
  }

  // ───────────────────────── 編輯對話：程式先讀「改什麼」，讀不懂的才交給模型（封閉的動作集）─────────────────────────
  var COLOR_KEYS = Object.keys(COLOR_WORDS).sort(function (a, b) { return b.length - a.length; });
  function colorIn(t) { var m = /#[0-9a-f]{6}\b/i.exec(t); if (m) return m[0].toUpperCase(); var low = t.toLowerCase(); for (var i = 0; i < COLOR_KEYS.length; i++) if (low.indexOf(COLOR_KEYS[i]) >= 0) return COLOR_WORDS[COLOR_KEYS[i]]; return null; }
  function colorRe() { return '(#[0-9a-fA-F]{6}|' + COLOR_KEYS.map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')'; }
  // 一句話（或一段話）→ { edits:[…], matched:[原句…], unmatched:[原句…] }；每一小句各自判斷，沒對上的原樣留給呼叫端（交給模型或回報沒聽懂）
  function parseEditRequest(text, spec) {
    var out = { edits: [], matched: [], unmatched: [] }, cur = validate(spec).spec; var clauses = String(text || '').replace(/\[附件：[^\]]*\]/g, ' ').split(/[，,。；;\n]+|(?:然後|並且|而且|還有|接著|再來|另外)/).map(function (x) { return x.trim(); }).filter(Boolean);
    var CR = colorRe(), bead = cur.blocks.filter(function (b) { return b.type === 'bead_rows'; })[0];
    clauses.forEach(function (c) {
      var e = [], m;
      if ((m = /(?:標題|題目名稱)\s*(?:改成|換成|改為|設為|變成|是|叫做?|:|：)\s*[「"'『]?(.+?)[」"'』]?$/.exec(c))) e.push({ op: 'set_title', text: m[1] });
      else if ((m = /(?:說明|副標題|指示)(?:文字)?\s*(?:改成|換成|改為|設為|變成|是|:|：)\s*[「"'『]?(.+?)[」"'』]?$/.exec(c))) e.push({ op: 'set_subtitle', text: m[1] });
      else if ((m = /(?:改成|變成|做成|改做|做|只要|留|剩|減少到|增加到|共)\s*(\d+|[一二兩三四五六七八九十]{1,3})\s*(?:串|排|列|行)/.exec(c)) && !/顏色|色/.test(c.replace(/(\d+)\s*(串|排)/, ''))) { var n = cnNum(m[1]); if (n >= 1 && n <= LIMITS.rows) e.push({ op: 'set_rows', n: n }); }
      else if ((m = new RegExp('(?:第\\s*)?(\\d+|[一二兩三四五六七八九十]{1,3})\\s*(?:顆|串|排|列|行|號)?[^，。,;]{0,6}?(?:的)?(?:顏色|色|珠)?\\s*(?:都)?(?:改成|換成|改為|變成|設為|用)\\s*' + CR, 'i').exec(c)) && bead) { var k = cnNum(m[1]), col = colorIn(m[2]); if (k >= 1 && col) e.push({ op: 'set_color', count: k, color: col }); }
      else if ((m = new RegExp('(?:金色珠|金珠|金色|底部|前面那(?:一)?串|長串)[^，。,;]{0,6}(?:改成|換成|改為|變成|設為|用)\\s*' + CR, 'i').exec(c)) && bead) e.push({ op: 'set_base_color', color: colorIn(m[1]) });
      else if (/(?:不要|拿掉|取消|隱藏|關掉)[^，。]{0,4}(?:答案線|橫線)/.test(c)) e.push({ op: 'set_answer', line: false });
      else if (/(?:不要|拿掉|取消|隱藏|關掉|別)[^，。]{0,4}(?:答案|解答)|學生版|答案留白|留白/.test(c)) e.push({ op: 'set_answer', show: false });
      else if (/(?:附|加|顯示|寫出|標出|要有|填上|寫上)[^，。]{0,4}(?:答案|解答)|教師版|answer\s*key/i.test(c)) e.push({ op: 'set_answer', show: true });
      else if (/答案(?:線)?[^，。]{0,4}(?:下面|下方|題目下)|(?:下面|下方)[^，。]{0,4}(?:填|寫)/.test(c)) e.push({ op: 'set_answer', side: 'below' });
      else if (/答案(?:線)?[^，。]{0,4}(?:右邊|右側)|(?:右邊|右側)[^，。]{0,4}(?:填|寫|答案)/.test(c)) e.push({ op: 'set_answer', side: 'right' });
      else if (/橫式|橫向|landscape/i.test(c)) e.push({ op: 'set_page', orient: 'landscape' });
      else if (/直式|直向|portrait/i.test(c)) e.push({ op: 'set_page', orient: 'portrait' });
      else if (/\bA5\b/i.test(c)) e.push({ op: 'set_page', size: 'A5' }); else if (/\bA4\b/i.test(c)) e.push({ op: 'set_page', size: 'A4' }); else if (/letter/i.test(c)) e.push({ op: 'set_page', size: 'Letter' });
      else if (/(?:大一點|放大|大一些|珠子大)/.test(c)) { var sz = (bead && bead.size) || 1; e.push({ op: 'set_size', scale: Math.min(1.4, Math.round(sz * 1.15 * 100) / 100) }); }
      else if (/(?:小一點|縮小|小一些|珠子小)/.test(c)) { var sz2 = (bead && bead.size) || 1; e.push({ op: 'set_size', scale: Math.max(0.4, Math.round(sz2 * 0.87 * 100) / 100) }); }
      else if ((m = /(?:不要|拿掉|取消|隱藏)[^，。]{0,3}(姓名|名字|日期)/.exec(c))) e.push({ op: 'set_header', [/日期/.test(m[1]) ? 'date' : 'name']: false });
      else if ((m = /(?:加|要有|顯示)[^，。]{0,3}(姓名|名字|日期|分數)/.exec(c))) e.push({ op: 'set_header', [/日期/.test(m[1]) ? 'date' : (/分數/.test(m[1]) ? 'score' : 'name')]: true });
      else if ((m = /(?:加|新增|再加|多一個)[^，。]{0,3}(數線|十格框|加法|減法|算式|數一數|文字)/.exec(c))) { var nm = m[1], blk = nm === '數線' ? { type: 'number_line', from: 0, to: 20 } : (nm === '十格框' ? { type: 'ten_frames' } : (nm === '數一數' ? { type: 'count_rows' } : (nm === '文字' ? { type: 'text', lines: ['在這裡寫說明'] } : { type: 'equations', kind: nm === '減法' ? 'sub' : 'add' }))); e.push({ op: 'add_block', block: blk }); }
      else if ((m = /(?:刪掉|刪除|移除|拿掉)[^，。]{0,3}第\s*(\d+|[一二兩三四五六七八九十]{1,3})\s*個?\s*(?:區塊|塊)/.exec(c))) { var ix = cnNum(m[1]) - 1; if (ix >= 0) e.push({ op: 'remove_block', index: ix }); }
      if (e.length) { out.edits = out.edits.concat(e); out.matched.push(c); } else out.unmatched.push(c);
    });
    return out;
  }
  // 讀不懂的句子才交給模型：只准回 { say, edits:[…] }，edits 的 op 必須在封閉清單裡（再由 applyEdits 逐一驗證）
  function editPrompt(spec, unmatchedText) {
    var s = validate(spec).spec; var compact = JSON.stringify(s).slice(0, 3000);
    return { system: '你是學習單的編輯助手。使用者用一句話說想怎麼改這份學習單，你把它翻成「編輯動作」。只回一段 JSON，不要說明、不要 markdown：{"say":"一句話告訴使用者你改了什麼（做不到就說做不到）","edits":[…]}。\\n動作只能是下面這些（欄位照寫，不要發明新的動作）：\\n' + TOPICS.edits + '\\n顏色一律用 #RRGGBB。看不懂、或做不到的要求：edits 給空陣列，在 say 說明，不要亂猜。',
      user: '目前的學習單：\\n' + describe(s).join('\\n') + '\\n描述（JSON）：' + compact + '\\n\\n使用者說：' + String(unmatchedText || '') };
  }
  function parseEditsReply(text) {
    var j = extractJson(text); if (!j || typeof j !== 'object') return { ok: false, say: '', edits: [], error: '模型的回覆讀不成 JSON' };
    var edits = (Array.isArray(j.edits) ? j.edits : []).filter(function (e) { return e && OPS.indexOf(e.op) >= 0; }).slice(0, 20);
    return { ok: true, say: j.say ? str(j.say, 300) : '', edits: edits, dropped: (Array.isArray(j.edits) ? j.edits.length : 0) - edits.length };
  }
  // ───────────────────────── 把整個編輯過程摘要成一段 prompt（程式組，沒有模型也行）─────────────────────────
  // history：[{ text: 使用者說的話, kind: 'chat'|'panel'|'image'|'undo', summary: '改了什麼' }]；回傳可以直接貼給 worksheet_make 重做同一份的原話
  function specToPrompt(spec, history) {
    var s = validate(spec).spec, L = []; var pg = s.page.size + (s.page.orient === 'landscape' ? ' 橫式' : ' 直式');
    L.push('幫我做一份' + pg + '的學習單' + (s.title ? '，標題是「' + s.title + '」' : '') + (s.subtitle ? '，說明文字是「' + s.subtitle + '」' : '') + '，抬頭有' + [s.header.name ? '姓名' : '', s.header.date ? '日期' : '', s.header.school ? '學校' : '', s.header.score ? '分數' : ''].filter(Boolean).join('、') + '欄。');
    s.blocks.forEach(function (b, i) {
      var d = '第 ' + (i + 1) + ' 區：';
      if (b.type === 'bead_rows') { var names = {}; d += b.base + ' 又幾串珠，共 ' + b.counts.length + ' 串（' + b.base + '又' + b.counts.join('、' + b.base + '又') + '）；前面一整串 ' + b.base + ' 顆金珠（' + b.baseColor + '），後面的彩色珠顏色：' + b.counts.map(function (c) { return c + '顆' + (hex(b.colors[c], BEAD_COLORS[c] || '#999999')); }).join('、') + '；' + answerWords(b.answer) + (b.size !== 1 ? '；珠子大小 ' + Math.round(b.size * 100) + '%' : ''); }
      else if (b.type === 'count_rows') d += '數一數，' + b.counts.length + ' 排，數量 ' + b.counts.join('、') + '，用' + ({ circle: '圓', square: '方塊', star: '星星' }[b.shape]) + '（' + b.color + '）；' + answerWords(b.answer);
      else if (b.type === 'equations') d += (b.items.length) + ' 題算式，分 ' + b.columns + ' 欄：' + b.items.slice(0, 6).join('、') + (b.items.length > 6 ? '…' : '');
      else if (b.type === 'ten_frames') d += '十格框 ' + b.counts.length + ' 個，點數 ' + b.counts.join('、') + '（' + b.color + '）；' + answerWords(b.answer);
      else if (b.type === 'number_line') d += '數線 ' + b.from + '～' + b.to + '，空格在 ' + (b.blanks.join('、') || '（沒有）');
      else if (b.type === 'text') d += '文字：' + b.lines.join(' / ');
      else d += '空白 ' + b.mm + ' 毫米';
      L.push(d + '。');
    });
    var steps = (history || []).filter(function (h) { return h && h.kind !== 'undo' && h.kind !== 'start' && (h.summary || h.text); });
    if (steps.length) { L.push('', '（編輯過程，依序）：'); steps.forEach(function (h, i) { L.push((i + 1) + '. ' + (h.text ? '我說：「' + String(h.text).slice(0, 80) + '」→ ' : '') + (h.summary || '')); }); }
    return L.join('\n');
  }
  function answerWords(a) { a = a || {}; return a.side === 'none' ? '沒有答案線' : '答案線在' + (a.side === 'below' ? '下方' : '右側') + (a.show ? '，寫出答案（教師版）' : '，留白（學生版）'); }
  // 一組編輯動作 → 一行白話（編輯記錄用）
  function editWords(e) {
    var o = e && e.op; var t = { set_title: function () { return '標題改成「' + e.text + '」'; }, set_subtitle: function () { return '說明改成「' + e.text + '」'; }, set_counts: function () { return '顆數改成 ' + (e.counts || []).join('、'); }, set_rows: function () { return '串數改成 ' + e.n; }, set_color: function () { return '第 ' + e.count + ' 串的顏色改成 ' + e.color; }, set_base_color: function () { return '金珠顏色改成 ' + e.color; }, set_answer: function () { return (e.show === true ? '附上答案' : e.show === false ? '答案留白' : '') + (e.side ? '答案線放' + (e.side === 'below' ? '下方' : e.side === 'right' ? '右側' : '：無') : '') + (e.line === false ? '拿掉答案線' : ''); }, set_page: function () { return '紙張：' + [e.size, e.orient === 'landscape' ? '橫式' : (e.orient === 'portrait' ? '直式' : '')].filter(Boolean).join(' '); }, set_size: function () { return '珠子大小 ' + Math.round(e.scale * 100) + '%'; }, set_header: function () { return '抬頭欄位調整'; }, add_block: function () { return '新增一個「' + (e.block && e.block.type) + '」區塊'; }, remove_block: function () { return '刪掉第 ' + (e.index + 1) + ' 個區塊'; }, set_block: function () { return '調整第 ' + (e.index + 1) + ' 個區塊（' + Object.keys(e.patch || {}).join('、') + '）'; }, move_block: function () { return '把第 ' + (e.index + 1) + ' 個區塊移到第 ' + (e.to + 1) + ' 個'; } };
    return t[o] ? t[o]() : String(o || '');
  }
  var TOPICS = {
    format: '學習單描述（JSON）：{title, subtitle, header:{name,date,school,score}, page:{size:"A4|A5|Letter", orient:"portrait|landscape", margin:mm}, blocks:[區塊…]}。區塊 type：bead_rows｛base:10, counts:[1..8], colors:{顆數:"#RRGGBB"}, baseColor, answer:{side:"right|below|none", line, show}, size｝、count_rows｛counts, shape:"circle|square|star", color, answer｝、equations｛kind:"add|sub", max, count, columns 或 items:["3 + 4 = ____"]｝、ten_frames｛counts:[0..10], color, answer, columns｝、number_line｛from, to, blanks:[數字]｝、text｛lines:[…], size, align, bold｝、spacer｛mm｝。座標與文字大小程式自己排，不要寫座標。',
    edits: '調整用 worksheet_adjust 的 edits（一次可以多個）：{op:"set_title",text}、{op:"set_subtitle",text}、{op:"set_counts",counts:[…]}、{op:"set_rows",n}、{op:"set_color",count:3,color:"#F2D4CF"}、{op:"set_base_color",color}、{op:"set_answer",show:true|false,side:"right|below|none",line:true|false}、{op:"set_page",size,orient,margin}、{op:"set_size",scale:0.4~1.4}、{op:"set_header",name,date,score}、{op:"add_block",block:{…},index}、{op:"remove_block",index}、{op:"set_block",index,patch:{…該區塊的欄位，例如 base、counts、shape、kind、max、count、columns、from、to、blanks、lines}}、{op:"move_block",index,to}。',
    reference: '有參考圖片時：worksheet_make 帶 reference_file_id（上傳圖片的 file_id）。視覺模型只被問一小段 JSON（每串的顆數與顏色、標題、金色珠的顏色），程式檢查後合併進學習單；看不出來的欄位用預設，不會亂猜。顏色不對就用 set_color 一個一個改。',
    colors: '串珠標準色（蒙特梭利）：1 紅 #C8174F、2 綠 #8CC63F、3 粉 #F2D4CF、4 黃 #F5E51E、5 藍 #3F87D4、6 紫 #5E2C79、7 白 #FFFFFF、8 桃紅 #E0457B、9 深藍 #274B8F，金色（10）#E9B22E。'
  };
  return { PAGES: PAGES, LIMITS: LIMITS, BEAD_COLORS: BEAD_COLORS, GOLD: GOLD, OPS: OPS, TOPICS: TOPICS, defaults: defaults, beadBlock: beadBlock, validate: validate, layout: layout, toSvg: toSvg, toHtml: toHtml, toPdfmake: toPdfmake, drawCanvas: drawCanvas, textWidth: textWidth,
    detectTemplate: detectTemplate, parseRequest: parseRequest, resolveQuestions: resolveQuestions, refPrompt: refPrompt, refFromReply: refFromReply, mergeRef: mergeRef, applyEdits: applyEdits, describe: describe, hex: hex, makeEquations: makeEquations, hitTest: hitTest, parseEditRequest: parseEditRequest, editPrompt: editPrompt, parseEditsReply: parseEditsReply, specToPrompt: specToPrompt, editWords: editWords };
});
