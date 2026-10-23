// A picture -> vector objects, made by the PROGRAM (pure functions on {width, height, data:RGBA}; node and the browser): colours are quantised (median cut + a few k-means steps), every colour's pixels are
// traced into closed outlines (pixel edges linked into loops, holes included), simplified (Douglas-Peucker) and written as one SVG path per colour. So the result is a real tracing of THIS picture, not
// something a model made up; the vision model and the language model only help around it (describing, naming, judging) and the numbers decide when it is close enough (compare()).
//   trace(img, { colors, maxSide, minArea, epsilon, smooth }) -> { w, h, scale, layers:[{ color, name, area, bbox, d, loops }] }      the biggest colour is the background (a plain rectangle: no gaps)
//   toObjects(result, { x, y, width, namePrefix }) -> [ add_object-ready { type:'svg', name, markup, x, y, w, h, scale } ]    one object per colour layer, bottom first
//   compare(a, b) -> { score 0..1, mae }       similarity of two pictures (any size; both are looked at in 48 × 48): the closer the better
//   colorName(hex), where(bbox, w, h)          short words for the layer names
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaSvgTrace = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function hex(r, g, b) { function h(n) { n = Math.max(0, Math.min(255, Math.round(n))); return (n < 16 ? '0' : '') + n.toString(16); } return '#' + h(r) + h(g) + h(b); }
  var NAMES = [['紅色', 229, 57, 53], ['橘色', 251, 140, 0], ['黃色', 253, 216, 53], ['綠色', 67, 160, 71], ['藍色', 30, 136, 229], ['天藍色', 79, 195, 247], ['紫色', 142, 36, 170], ['粉紅色', 236, 64, 122], ['黑色', 20, 20, 20], ['白色', 245, 245, 245], ['灰色', 150, 150, 150], ['棕色', 109, 76, 65], ['深綠色', 27, 94, 32], ['深藍色', 21, 40, 120], ['米色', 230, 215, 180]];
  function colorName(h) { var r = parseInt(h.substr(1, 2), 16), g = parseInt(h.substr(3, 2), 16), b = parseInt(h.substr(5, 2), 16), best = null, bd = 1e9; NAMES.forEach(function (n) { var d = (n[1] - r) * (n[1] - r) + (n[2] - g) * (n[2] - g) + (n[3] - b) * (n[3] - b); if (d < bd) { bd = d; best = n[0]; } }); return best; }
  function where(b, w, h) { var cx = (b.x + b.w / 2) / w, cy = (b.y + b.h / 2) / h, big = b.w * b.h > w * h * 0.25; var hz = cx < 0.34 ? '左' : cx > 0.66 ? '右' : '中', vt = cy < 0.34 ? '上' : cy > 0.66 ? '下' : '中'; var s = hz === '中' && vt === '中' ? '中間' : (vt === '中' ? '' : vt) + (hz === '中' ? '' : hz); return (big ? '大面積' : '') + s; }

  // shrink to at most maxSide with a box average (the tracing works on this small picture; the objects are scaled back up)
  function shrink(img, maxSide) {
    var s = Math.min(1, maxSide / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s)), out = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) { for (var x = 0; x < w; x++) {
      var x0 = Math.floor(x / s), x1 = Math.max(x0 + 1, Math.floor((x + 1) / s)), y0 = Math.floor(y / s), y1 = Math.max(y0 + 1, Math.floor((y + 1) / s)), r = 0, g = 0, b = 0, a = 0, n = 0;
      for (var yy = y0; yy < Math.min(y1, img.height); yy++) { for (var xx = x0; xx < Math.min(x1, img.width); xx++) { var i = (yy * img.width + xx) * 4, al = img.data[i + 3] / 255; r += img.data[i] * al + 255 * (1 - al); g += img.data[i + 1] * al + 255 * (1 - al); b += img.data[i + 2] * al + 255 * (1 - al); a += al; n++; } }
      n = n || 1; var o = (y * w + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    } }
    return { width: w, height: h, data: out, scale: s };
  }
  function medianCut(px, k) {
    var boxes = [px.slice()];
    while (boxes.length < k) {
      var bi = -1, br = -1; boxes.forEach(function (b, i) { if (b.length < 2) { return; } var mn = [255, 255, 255], mx = [0, 0, 0]; b.forEach(function (p) { for (var c = 0; c < 3; c++) { if (p[c] < mn[c]) { mn[c] = p[c]; } if (p[c] > mx[c]) { mx[c] = p[c]; } } }); var rg = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * Math.sqrt(b.length); if (rg > br) { br = rg; bi = i; } });
      if (bi < 0 || br <= 0) { break; }
      var b0 = boxes[bi], mn2 = [255, 255, 255], mx2 = [0, 0, 0]; b0.forEach(function (p) { for (var c = 0; c < 3; c++) { if (p[c] < mn2[c]) { mn2[c] = p[c]; } if (p[c] > mx2[c]) { mx2[c] = p[c]; } } });
      var ch = 0; if (mx2[1] - mn2[1] > mx2[ch] - mn2[ch]) { ch = 1; } if (mx2[2] - mn2[2] > mx2[ch] - mn2[ch]) { ch = 2; }
      b0.sort(function (p, q) { return p[ch] - q[ch]; });
      // split where the colour CHANGES, nearest to the middle: a cut inside a run of identical colours would waste a box (a big plain sky would be cut in two and a small yellow dot never get its own colour)
      var m = b0.length >> 1, lo = m, hi = m; while (lo > 0 && b0[lo][ch] === b0[lo - 1][ch]) { lo--; } while (hi < b0.length && hi > 0 && b0[hi][ch] === b0[hi - 1][ch]) { hi++; }
      m = lo > 0 && (hi >= b0.length || m - lo <= hi - m) ? lo : (hi < b0.length ? hi : lo); if (m <= 0 || m >= b0.length) { b0.splice(0); continue; }
      boxes.splice(bi, 1, b0.slice(0, m), b0.slice(m));
    }
    return boxes.filter(function (b) { return b.length; }).map(function (b) { var s = [0, 0, 0]; b.forEach(function (p) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }); return [s[0] / b.length, s[1] / b.length, s[2] / b.length]; });
  }
  function quantize(img, k) {
    var px = [], step = Math.max(1, Math.floor(img.width * img.height / 20000)); for (var i = 0; i < img.width * img.height; i += step) { px.push([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]); }
    var pal = medianCut(px, k);
    for (var it = 0; it < 3; it++) {   // a few k-means steps: the palette follows the colours that are really there
      var sum = pal.map(function () { return [0, 0, 0, 0]; });
      px.forEach(function (p) { var bi = 0, bd = 1e9; pal.forEach(function (c, j) { var d = (c[0] - p[0]) * (c[0] - p[0]) + (c[1] - p[1]) * (c[1] - p[1]) + (c[2] - p[2]) * (c[2] - p[2]); if (d < bd) { bd = d; bi = j; } }); sum[bi][0] += p[0]; sum[bi][1] += p[1]; sum[bi][2] += p[2]; sum[bi][3]++; });
      pal = pal.map(function (c, j) { return sum[j][3] ? [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]] : c; });
    }
    return pal;
  }
  function label(img, pal) {
    var n = img.width * img.height, lab = new Uint8Array(n);
    for (var i = 0; i < n; i++) { var r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2], bi = 0, bd = 1e9; for (var j = 0; j < pal.length; j++) { var c = pal[j], d = (c[0] - r) * (c[0] - r) + (c[1] - g) * (c[1] - g) + (c[2] - b) * (c[2] - b); if (d < bd) { bd = d; bi = j; } } lab[i] = bi; }
    // one pass of a 3 × 3 majority: single noisy pixels do not become tiny islands
    var out = new Uint8Array(n), W = img.width, H = img.height;
    for (var y = 0; y < H; y++) { for (var x = 0; x < W; x++) { var cnt = {}, best = lab[y * W + x], bc = 0; for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) { var xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) { continue; } var v = lab[yy * W + xx]; cnt[v] = (cnt[v] || 0) + 1; if (cnt[v] > bc) { bc = cnt[v]; best = v; } } } out[y * W + x] = bc >= 5 ? best : lab[y * W + x]; } }
    return out;
  }
  // the outlines of a binary mask: every pixel edge between a filled and an empty pixel is a directed segment (the filled pixel on the right); the segments are linked into closed loops
  function loopsOf(mask, W, H) {
    var V = W + 1, out = {}, edges = 0;
    function add(x0, y0, x1, y1) { var k = y0 * V + x0; (out[k] || (out[k] = [])).push([x1, y1]); edges++; }
    for (var y = 0; y < H; y++) { for (var x = 0; x < W; x++) { if (!mask[y * W + x]) { continue; }
      if (y === 0 || !mask[(y - 1) * W + x]) { add(x, y, x + 1, y); } if (x === W - 1 || !mask[y * W + x + 1]) { add(x + 1, y, x + 1, y + 1); }
      if (y === H - 1 || !mask[(y + 1) * W + x]) { add(x + 1, y + 1, x, y + 1); } if (x === 0 || !mask[y * W + x - 1]) { add(x, y + 1, x, y); } } }
    var loops = [];
    Object.keys(out).forEach(function (k0) {
      while (out[k0] && out[k0].length) {
        var kx = Number(k0) % V, ky = Math.floor(Number(k0) / V), loop = [[kx, ky]], cx = kx, cy = ky, px = null, py = null, guard = 0;
        for (;;) {
          var key = cy * V + cx, list = out[key]; if (!list || !list.length) { break; }
          var pick = 0; if (list.length > 1 && px !== null) {   // a point where two outlines touch: turn right (keeps the two apart)
            var dxp = cx - px, dyp = cy - py, bestTurn = -9; list.forEach(function (e, i) { var dx = e[0] - cx, dy = e[1] - cy, cross = dxp * dy - dyp * dx; if (cross > bestTurn) { bestTurn = cross; pick = i; } });
          }
          var e2 = list.splice(pick, 1)[0]; px = cx; py = cy; cx = e2[0]; cy = e2[1]; if (cx === kx && cy === ky) { break; } loop.push([cx, cy]); if (++guard > 4 * W * H + 10) { break; }
        }
        loops.push(loop);
      }
    });
    return loops;
  }
  function dropCollinear(loop) { var out = [], n = loop.length; for (var i = 0; i < n; i++) { var a = loop[(i + n - 1) % n], b = loop[i], c = loop[(i + 1) % n]; if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) { out.push(b); } } return out; }
  function dp(pts, eps) {
    if (pts.length < 3) { return pts; } var keep = new Array(pts.length), stack = [[0, pts.length - 1]]; keep[0] = keep[pts.length - 1] = true;
    while (stack.length) { var s = stack.pop(), a = pts[s[0]], b = pts[s[1]], md = -1, mi = -1, dx = b[0] - a[0], dy = b[1] - a[1], L = Math.sqrt(dx * dx + dy * dy) || 1;
      for (var i = s[0] + 1; i < s[1]; i++) { var d = Math.abs(dy * (pts[i][0] - a[0]) - dx * (pts[i][1] - a[1])) / L; if (d > md) { md = d; mi = i; } }
      if (md > eps && mi > 0) { keep[mi] = true; stack.push([s[0], mi], [mi, s[1]]); } }
    return pts.filter(function (p, i) { return keep[i]; });
  }
  function simplify(loop, eps) { var c = dropCollinear(loop); if (c.length < 4) { return c; } var half = c.length >> 1, a = dp(c.slice(0, half + 1), eps), b = dp(c.slice(half).concat([c[0]]), eps); var out = a.slice(0, -1).concat(b.slice(0, -1)); return out.length >= 3 ? out : c; }
  function r1(n) { return Math.round(n * 10) / 10; }
  function pathOf(loops, smooth) {
    return loops.map(function (l) {
      if (l.length < 3) { return ''; }
      if (!smooth || l.length < 6) { return 'M' + l.map(function (p) { return r1(p[0]) + ' ' + r1(p[1]); }).join('L') + 'Z'; }
      var n = l.length, mid = function (a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }, m0 = mid(l[n - 1], l[0]), d = 'M' + r1(m0[0]) + ' ' + r1(m0[1]);
      for (var i = 0; i < n; i++) { var m = mid(l[i], l[(i + 1) % n]); d += 'Q' + r1(l[i][0]) + ' ' + r1(l[i][1]) + ' ' + r1(m[0]) + ' ' + r1(m[1]); } return d + 'Z';
    }).join('');
  }
  function area(loop) { var a = 0; for (var i = 0; i < loop.length; i++) { var p = loop[i], q = loop[(i + 1) % loop.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }

  function trace(img, o) {
    o = o || {}; var k = Math.max(2, Math.min(40, o.colors || 12)), small = shrink(img, o.maxSide || 256), W = small.width, H = small.height, pal = quantize(small, k), lab = label(small, pal);
    var count = pal.map(function () { return 0; }); for (var i = 0; i < lab.length; i++) { count[lab[i]]++; }
    var order = pal.map(function (c, j) { return j; }).filter(function (j) { return count[j] > 0; }).sort(function (a, b) { return count[b] - count[a]; }), minArea = o.minArea != null ? o.minArea : Math.max(3, W * H * 0.0006), eps = o.epsilon != null ? o.epsilon : 0.8, layers = [];
    order.forEach(function (j, rank) {
      var c = pal[j], col = hex(c[0], c[1], c[2]);
      if (rank === 0) { layers.push({ color: col, name: colorName(col) + '背景', area: count[j], bbox: { x: 0, y: 0, w: W, h: H }, d: 'M0 0H' + W + 'V' + H + 'H0Z', loops: [], background: true }); return; }
      if (count[j] < minArea) { return; }
      var mask = new Uint8Array(W * H); for (var q = 0; q < mask.length; q++) { if (lab[q] === j) { mask[q] = 1; } }
      var loops = loopsOf(mask, W, H).map(function (l) { return simplify(l, eps); }).filter(function (l) { return l.length >= 3 && Math.abs(area(l)) >= Math.max(2, minArea / 3); });
      if (!loops.length) { return; }
      var x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; loops.forEach(function (l) { l.forEach(function (p) { if (p[0] < x0) { x0 = p[0]; } if (p[0] > x1) { x1 = p[0]; } if (p[1] < y0) { y0 = p[1]; } if (p[1] > y1) { y1 = p[1]; } }); });
      var bb = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      layers.push({ color: col, name: colorName(col) + where(bb, W, H), area: count[j], bbox: bb, d: pathOf(loops, o.smooth !== false), loops: loops });
    });
    return { w: W, h: H, scale: small.scale, layers: layers, colors: pal.length };
  }
  // the layers as objects (bottom first), placed so the picture's top-left corner is at (x, y) and it is `width` wide
  function toObjects(res, o) {
    o = o || {}; var x = o.x || 0, y = o.y || 0, sc = (o.width || res.w) / res.w, names = {};
    return res.layers.map(function (l, i) {
      var base = (o.namePrefix || '') + l.name, n = (names[base] = (names[base] || 0) + 1); var nm = n > 1 ? base + ' ' + n : base;
      var markup = '<path d="' + l.d + '" fill="' + l.color + '"' + (l.background ? '' : ' fill-rule="evenodd" stroke="' + l.color + '" stroke-width="0.6" stroke-linejoin="round"') + '/>';
      return { type: 'svg', name: nm, markup: markup, x: x, y: y, w: res.w, h: res.h, scale: Math.round(sc * 10000) / 10000 };
    });
  }
  // how alike two pictures are: both are looked at as 48 x 48 averages; mae = mean absolute colour difference (0..255), score = 1 - mae / 160 (a plain mismatch is about 0.3 or less)
  function grid(img, n) {
    var out = new Float32Array(n * n * 3);
    for (var y = 0; y < n; y++) { for (var x = 0; x < n; x++) { var x0 = Math.floor(x * img.width / n), x1 = Math.max(x0 + 1, Math.floor((x + 1) * img.width / n)), y0 = Math.floor(y * img.height / n), y1 = Math.max(y0 + 1, Math.floor((y + 1) * img.height / n)), r = 0, g = 0, b = 0, c = 0;
      for (var yy = y0; yy < y1 && yy < img.height; yy++) { for (var xx = x0; xx < x1 && xx < img.width; xx++) { var i = (yy * img.width + xx) * 4, al = img.data[i + 3] / 255; r += img.data[i] * al + 255 * (1 - al); g += img.data[i + 1] * al + 255 * (1 - al); b += img.data[i + 2] * al + 255 * (1 - al); c++; } }
      c = c || 1; var o = (y * n + x) * 3; out[o] = r / c; out[o + 1] = g / c; out[o + 2] = b / c; } }
    return out;
  }
  function compare(a, b) { var n = 48, ga = grid(a, n), gb = grid(b, n), s = 0; for (var i = 0; i < ga.length; i++) { s += Math.abs(ga[i] - gb[i]); } var mae = s / ga.length; return { mae: Math.round(mae * 100) / 100, score: Math.max(0, Math.min(1, Math.round((1 - mae / 160) * 1000) / 1000)) }; }
  return { trace: trace, toObjects: toObjects, compare: compare, colorName: colorName, where: where, shrink: shrink, quantize: quantize, loopsOf: loopsOf, simplify: simplify, area: area };
});
