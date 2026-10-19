/* 點陣圖物件設計工具（純函式，UMD）：模型不用寫程式，只描述「調色盤＋一列一列的字母」與少數幾個繪圖指令，程式驗證、畫出來、檢查、把結果用文字預覽回給模型。
 *
 * spec = {
 *   size:    [w, h]            畫布（每邊 4..64）；省略時由 rows 決定
 *   palette: { a: '#c0392b', b: '#2c3e50', … }   一個字元 → 顏色（#rrggbb）；'.' 與空白永遠是透明
 *   rows:    ['..aabb..', …]   一列一個字串，每個字元是調色盤的鍵（短的列右邊補透明）；可省略（只用 ops）
 *   mirror:  'x' | 'y' | 'xy'   rows 只畫一半（左半／上半），另一半自動鏡射（臉、劍、花、人形物件省一半的力氣）
 *   ops:     [ {op, …} ]       依序畫在 rows 後面（最多 40 個）：
 *              rect {x, y, w, h, c, fill?}       line {x1, y1, x2, y2, c}        circle {cx, cy, r, c, fill?}
 *              ellipse {cx, cy, rx, ry, c, fill?}  fill {x, y, c}（填色，限同色區域）  dot {x, y, c}    erase {x, y, w, h}
 *   shade:   true              自動上亮部（上、左邊緣）與暗部（下、右邊緣）：點陣畫的立體感
 *   outline: '#rrggbb' | true  外圍加 1 像素外框（true＝深紫黑）
 * }
 *   validate(spec)  → { ok, errors: [字串，指到哪個欄位], warnings }
 *   render(spec)    → { width, height, data（RGBA）, palette（用到的顏色）, ascii（逐列文字預覽）, empty }
 *   check(img)      → 問題清單（空白、太滿貼邊、顏色太多）
 *   TEMPLATES / template(name, recolor) → 內建的小範例（心、劍、藥水、金幣、鑰匙、花、蘑菇、寶石、箱子），可換色
 * 結果是確定性的。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatDeckPixelArt = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MIN = 4, MAX = 64, MAXOPS = 40, MAXCOLORS = 32, INK = '#20182b';
  var OPS = ['rect', 'line', 'circle', 'ellipse', 'fill', 'dot', 'erase'];

  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function isHex(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c); }
  function rgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function hex(c) { return '#' + c.map(function (v) { return ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2); }).join(''); }
  function lighten(h, k) { var c = rgb(h); return hex([c[0] + (255 - c[0]) * k, c[1] + (255 - c[1]) * k, c[2] + (255 - c[2]) * k]); }
  function darken(h, k) { var c = rgb(h); return hex([c[0] * (1 - k), c[1] * (1 - k), c[2] * (1 - k)]); }

  function dims(spec) {
    var rows = Array.isArray(spec.rows) ? spec.rows : [], w = 0, h = rows.length;
    rows.forEach(function (r) { if (typeof r === 'string') { w = Math.max(w, r.length); } });
    var mx = spec.mirror === 'x' || spec.mirror === 'xy', my = spec.mirror === 'y' || spec.mirror === 'xy';
    if (Array.isArray(spec.size)) { return { w: spec.size[0], h: spec.size[1], rw: w, rh: h, mx: mx, my: my }; }
    return { w: mx ? w * 2 : w, h: my ? h * 2 : h, rw: w, rh: h, mx: mx, my: my };
  }

  function validate(spec) {
    var errors = [], warnings = [];
    if (!isObj(spec)) { return { ok: false, errors: ['the picture is an object {size?, palette, rows?, ops?, mirror?, shade?, outline?}'], warnings: warnings }; }
    var pal = spec.palette;
    if (!isObj(pal) || !Object.keys(pal).length) { errors.push('palette: an object, one character -> one colour, e.g. {"a": "#c0392b", "b": "#2c3e50"}'); pal = {}; }
    else {
      var keys = Object.keys(pal); if (keys.length > MAXCOLORS) { errors.push('palette: at most ' + MAXCOLORS + ' colours'); }
      keys.forEach(function (k) { if (k.length !== 1 || k === '.' || k === ' ') { errors.push('palette["' + k + '"]: the key is ONE character that is not "." or a space (those are transparent)'); } else if (!isHex(pal[k])) { errors.push('palette["' + k + '"]: a colour like #c0392b'); } });
    }
    if (spec.mirror != null && ['x', 'y', 'xy'].indexOf(spec.mirror) < 0) { errors.push('mirror: x, y or xy (rows draw only the left / top half)'); }
    if (spec.rows != null) {
      if (!Array.isArray(spec.rows) || spec.rows.length < 1 || spec.rows.length > MAX) { errors.push('rows: a list of 1..' + MAX + ' strings, one per pixel row'); }
      else { spec.rows.forEach(function (r, y) { if (typeof r !== 'string') { errors.push('rows[' + y + ']: a string'); return; } if (r.length > MAX) { errors.push('rows[' + y + ']: at most ' + MAX + ' characters'); } r.split('').forEach(function (ch, x) { if (ch !== '.' && ch !== ' ' && !(pal && pal[ch])) { errors.push('rows[' + y + '] column ' + x + ': "' + ch + '" is not in the palette (. or space = transparent)'); } }); }); }
    }
    if (spec.size != null && !(Array.isArray(spec.size) && spec.size.length === 2 && spec.size.every(function (v) { return Number.isInteger(v) && v >= MIN && v <= MAX; }))) { errors.push('size: [width, height], each ' + MIN + '..' + MAX); }
    var d = dims(spec);
    if (!errors.length) {
      if (!(d.w >= MIN && d.h >= MIN)) { errors.push('the picture is ' + d.w + ' x ' + d.h + ': give size [w, h] or rows (each side at least ' + MIN + ')'); }
      else if (d.w > MAX || d.h > MAX) { errors.push('the picture is ' + d.w + ' x ' + d.h + ': at most ' + MAX + ' each side'); }
      else if (d.rw > d.w || d.rh > d.h) { warnings.push('rows are ' + d.rw + ' x ' + d.rh + ' but the canvas is ' + d.w + ' x ' + d.h + ': the part outside is cut'); }
    }
    if (spec.ops != null) {
      if (!Array.isArray(spec.ops) || spec.ops.length > MAXOPS) { errors.push('ops: a list of at most ' + MAXOPS + ' drawing steps'); }
      else {
        spec.ops.forEach(function (o, i) {
          var p = 'ops[' + i + ']'; if (!isObj(o) || OPS.indexOf(o.op) < 0) { errors.push(p + '.op: one of ' + OPS.join(', ')); return; }
          var need = { rect: ['x', 'y', 'w', 'h'], line: ['x1', 'y1', 'x2', 'y2'], circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'], fill: ['x', 'y'], dot: ['x', 'y'], erase: ['x', 'y', 'w', 'h'] }[o.op];
          need.forEach(function (f) { if (!Number.isInteger(o[f])) { errors.push(p + '.' + f + ': a whole number of pixels'); } });
          ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy'].forEach(function (f) { if (Number.isInteger(o[f]) && (o[f] < 0 || o[f] >= (f.indexOf('y') >= 0 ? d.h : d.w)) && d.w >= MIN) { errors.push(p + '.' + f + ': inside the picture (0..' + ((f.indexOf('y') >= 0 ? d.h : d.w) - 1) + ')'); } });
          if (o.op !== 'erase' && !(typeof o.c === 'string' && o.c.length === 1 && pal[o.c])) { errors.push(p + '.c: a palette character'); }
        });
      }
    }
    if (spec.outline != null && spec.outline !== true && !isHex(spec.outline)) { errors.push('outline: true or a colour like #20182b'); }
    if (spec.shade != null && typeof spec.shade !== 'boolean') { errors.push('shade: true or false'); }
    return { ok: errors.length === 0, errors: errors.slice(0, 12), warnings: warnings };
  }

  function render(spec) {
    var v = validate(spec); if (!v.ok) { return { error: v.errors.join('; '), errors: v.errors }; }
    var d = dims(spec), W = d.w, H = d.h, pal = spec.palette, grid = []; // a cell: a palette key or ''
    for (var y = 0; y < H; y++) { grid.push([]); for (var x = 0; x < W; x++) { grid[y].push(''); } }
    var rows = spec.rows || [], mx = d.mx, my = d.my;
    rows.forEach(function (r, y0) { for (var x0 = 0; x0 < r.length; x0++) { var ch = r[x0]; if (ch === '.' || ch === ' ') { continue; } put(x0, y0, ch); if (mx) { put(W - 1 - x0, y0, ch); } if (my) { put(x0, H - 1 - y0, ch); } if (mx && my) { put(W - 1 - x0, H - 1 - y0, ch); } } });
    function put(x, y, ch) { if (x >= 0 && y >= 0 && x < W && y < H) { grid[y][x] = ch; } }
    (spec.ops || []).forEach(function (o) {
      var c = o.c, fillIt = o.fill !== false;
      if (o.op === 'dot') { put(o.x, o.y, c); }
      else if (o.op === 'rect') { for (var yy = 0; yy < o.h; yy++) { for (var xx = 0; xx < o.w; xx++) { if (fillIt || yy === 0 || xx === 0 || yy === o.h - 1 || xx === o.w - 1) { put(o.x + xx, o.y + yy, c); } } } }
      else if (o.op === 'erase') { for (var ey = 0; ey < o.h; ey++) { for (var ex = 0; ex < o.w; ex++) { put(o.x + ex, o.y + ey, ''); } } }
      else if (o.op === 'line') { var dx = Math.abs(o.x2 - o.x1), dy = -Math.abs(o.y2 - o.y1), sx = o.x1 < o.x2 ? 1 : -1, sy = o.y1 < o.y2 ? 1 : -1, er = dx + dy, x = o.x1, y = o.y1; for (var n = 0; n < 400; n++) { put(x, y, c); if (x === o.x2 && y === o.y2) { break; } var e2 = 2 * er; if (e2 >= dy) { er += dy; x += sx; } if (e2 <= dx) { er += dx; y += sy; } } }
      else if (o.op === 'circle' || o.op === 'ellipse') { var rx = o.op === 'circle' ? o.r : o.rx, ry = o.op === 'circle' ? o.r : o.ry; for (var gy = -ry; gy <= ry; gy++) { for (var gx = -rx; gx <= rx; gx++) { var q = (gx * gx) / (rx * rx + 0.5) + (gy * gy) / (ry * ry + 0.5); if (fillIt ? q <= 1 : (q <= 1 && q > 0.55)) { put(o.cx + gx, o.cy + gy, c); } } } }
      else if (o.op === 'fill') { var from = (grid[o.y] && grid[o.y][o.x]) || ''; if (from !== c) { var st = [[o.x, o.y]], guard = 0; while (st.length && guard++ < 5000) { var p = st.pop(), px = p[0], py = p[1]; if (px < 0 || py < 0 || px >= W || py >= H || grid[py][px] !== from) { continue; } grid[py][px] = c; st.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]); } } }
    });
    var data = new Uint8ClampedArray(W * H * 4), used = {}, cellColor = function (x, y) { return grid[y][x] ? pal[grid[y][x]] : null; };
    for (var y2 = 0; y2 < H; y2++) {
      for (var x2 = 0; x2 < W; x2++) {
        var col = cellColor(x2, y2); if (!col) { continue; }
        if (spec.shade === true) { var up = y2 > 0 ? grid[y2 - 1][x2] : '', lf = x2 > 0 ? grid[y2][x2 - 1] : '', dn = y2 < H - 1 ? grid[y2 + 1][x2] : '', rt = x2 < W - 1 ? grid[y2][x2 + 1] : ''; if (up !== grid[y2][x2] && lf !== grid[y2][x2]) { col = lighten(col, 0.3); } else if (up !== grid[y2][x2] || lf !== grid[y2][x2]) { col = lighten(col, 0.16); } else if (dn !== grid[y2][x2] && rt !== grid[y2][x2]) { col = darken(col, 0.32); } else if (dn !== grid[y2][x2] || rt !== grid[y2][x2]) { col = darken(col, 0.18); } }
        var c3 = rgb(col), o = (y2 * W + x2) * 4; data[o] = c3[0]; data[o + 1] = c3[1]; data[o + 2] = c3[2]; data[o + 3] = 255;
      }
    }
    var img = { width: W, height: H, data: data };
    if (spec.outline) {
      var ink = rgb(spec.outline === true ? INK : spec.outline), src = new Uint8ClampedArray(data), at = function (x, y) { return x >= 0 && y >= 0 && x < W && y < H && src[(y * W + x) * 4 + 3] === 255; };
      for (var yy2 = 0; yy2 < H; yy2++) { for (var xx2 = 0; xx2 < W; xx2++) { if (src[(yy2 * W + xx2) * 4 + 3] === 255) { continue; } if (at(xx2 + 1, yy2) || at(xx2 - 1, yy2) || at(xx2, yy2 + 1) || at(xx2, yy2 - 1)) { var o2 = (yy2 * W + xx2) * 4; data[o2] = ink[0]; data[o2 + 1] = ink[1]; data[o2 + 2] = ink[2]; data[o2 + 3] = 255; } } }
    }
    var paletteUsed = {}, empty = true; for (var i = 0; i < W * H; i++) { if (data[i * 4 + 3] === 255) { empty = false; paletteUsed[hex([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]])] = 1; } }
    var keyOf = {}; Object.keys(pal).forEach(function (k) { keyOf[pal[k].toLowerCase()] = keyOf[pal[k].toLowerCase()] || k; });
    var ascii = []; for (var ay = 0; ay < H; ay++) { var line = ''; for (var ax = 0; ax < W; ax++) { line += data[(ay * W + ax) * 4 + 3] === 255 ? (grid[ay][ax] || '#') : '.'; } ascii.push(line); }
    img.palette = Object.keys(paletteUsed); img.ascii = ascii; img.empty = empty; img.warnings = v.warnings;
    return img;
  }

  function check(img) {
    var problems = []; if (!img || img.error) { return [img && img.error || 'no picture']; }
    if (img.empty) { problems.push('the picture is empty: nothing was drawn'); return problems; }
    if (img.palette.length > MAXCOLORS + 12) { problems.push('too many colours (' + img.palette.length + ')'); }
    var W = img.width, H = img.height, n = 0; for (var i = 0; i < W * H; i++) { if (img.data[i * 4 + 3] === 255) { n++; } }
    if (n < 6) { problems.push('only ' + n + ' pixels are drawn'); }
    return problems;
  }

  // ---- 內建的小範例（rows 是左半或完整；recolor 用調色盤字元換色）----
  var TEMPLATES = {
    heart: {'palette': {'r': '#e63946', 'h': '#ff8a93', 'd': '#a4161a'}, 'mirror': 'x', 'rows': ['..rrr...', '.rhrrr..', 'rhrrrrrr', 'rrrrrrrr', 'rrrrrrrr', '.rrrrrrr', '..rrrrrr', '...rrrrr', '....rrrr', '.....rrr', '......rr', '.......r'], 'shade': false, 'outline': true},
    sword: {'palette': {'b': '#cfd8dc', 'd': '#90a4ae', 'g': '#c9a227', 'w': '#6d4c41'}, 'mirror': 'x', 'rows': ['.......b', '.......b', '......bb', '......bb', '......bb', '......bb', '......bb', '......bb', '......bb', '......bb', '......bb', '......bb', '..gggggg', '..gggggg', '.......w', '.......w', '.......w', '......ww', '......gg'], 'shade': true, 'outline': true},
    potion: {'palette': {'g': '#b0bec5', 'l': '#e53935', 'd': '#8e0000', 'c': '#8d6e63'}, 'mirror': 'x', 'rows': ['....cccc', '....cccc', '.....ggg', '.....ggg', '....gggg', '...ggggg', '..ggllll', '.gllllll', '.gllllll', '.gdddddd', '..gddddd'], 'shade': true, 'outline': true},
    coin: {'palette': {'y': '#ffd54f', 'o': '#f9a825', 'd': '#b8860b'}, 'size': [12, 12], 'rows': ['....yyyy....', '..yyyyyyyy..', '.yyyyooyyyy.', '.yyyoyyoyyy.', 'yyyyoyyyyyyy', 'yyyyoyyyyyyy', 'yyyyoyyyyyyy', 'yyyyoyyyyyyy', '.yyyoyyoyyy.', '.yyyyooyyyy.', '..yyyyyyyy..', '....yyyy....'], 'shade': true, 'outline': true},
    key: {'palette': {'y': '#ffd54f', 'd': '#b8860b'}, 'size': [16, 8], 'rows': ['.yyyy...........', 'yy..yy..........', 'y....y..........', 'yy..yyyyyyyyyyyy', '.yyyy......yy.yy', '...........y..yy', '................', '................'], 'shade': true, 'outline': true},
    flower: {'palette': {'p': '#f48fb1', 'y': '#ffd54f', 's': '#43a047', 'l': '#66bb6a'}, 'mirror': 'x', 'rows': ['...pp...', '..pppp.p', '.ppppppp', '.pppyyyp', '..pyyyyy', '.ppyyyyy', '..ppppyy', '...pp.ys', '.......s', '..l....s', '.lll...s', '..ll...s'], 'shade': false, 'outline': true},
    mushroom: {'palette': {'r': '#e53935', 'w': '#fafafa', 's': '#efebe9', 'd': '#c9bfb8'}, 'mirror': 'x', 'rows': ['....rrrr', '..rrrrrr', '.rrwwrrr', '.rwwwrrr', 'rrrwwrrw', 'rrrrrrww', 'rrrrrrrr', '.....sss', '.....sss', '.....sss', '....ssss'], 'shade': true, 'outline': true},
    gem: {'palette': {'b': '#4fc3f7', 'l': '#b3e5fc', 'd': '#0277bd'}, 'mirror': 'x', 'rows': ['..bbbb', '.blllb', 'blllbb', 'bbbbbb', '.dbbbb', '..dbbb', '...dbb', '....db'], 'shade': false, 'outline': true},
    chest: {'palette': {'w': '#8d6e63', 'l': '#a1887f', 'd': '#5d4037', 'y': '#ffd54f'}, 'size': [16, 12], 'rows': ['..dddddddddddd..', '.dllllllllllllld', 'dlwwwwwwwwwwwwwd', 'dwwwwwwwwwwwwwwd', 'dddddddddddddddd', 'dwwwwwwyywwwwwwd', 'dwwwwwwyywwwwwwd', 'dwwwwwwwwwwwwwwd', 'dwwwwwwwwwwwwwwd', 'dwwwwwwwwwwwwwwd', 'dddddddddddddddd'], 'shade': false, 'outline': true}
  };
  var TEMPLATE_NAMES = Object.keys(TEMPLATES);
  function template(name, recolor) {
    var t = TEMPLATES[name]; if (!t) { return null; } var spec = JSON.parse(JSON.stringify(t));
    if (isObj(recolor)) { Object.keys(recolor).forEach(function (k) { if (spec.palette[k] && isHex(recolor[k])) { spec.palette[k] = recolor[k]; } }); }
    return spec;
  }

  return { MIN: MIN, MAX: MAX, MAXOPS: MAXOPS, OPS: OPS, TEMPLATES: TEMPLATES, TEMPLATE_NAMES: TEMPLATE_NAMES, validate: validate, render: render, check: check, template: template, dims: dims };
});
