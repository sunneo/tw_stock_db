// /edit-picture 的「擴散細化層」(detail) 用的純函式(UMD,node 與瀏覽器都能跑,不碰 DOM／模型／網路;設計見 DESIGN.edit-picture-diffusion.md)。
// 做法:只針對圖上一小塊(region)——裁出它加上四周多裁的一圈脈絡(context)、放大到模型熟悉的尺寸、請生圖模型重畫(或只借它的細節)、再縮回原尺寸,
// 用羽化遮罩蓋回去,蓋回去前先把色調對齊。這裡全是「蓋回去」的數學;生圖本身在宿主(edit_host.js)。
//   plan(region, bounds, opts)          → { crop, inner, out:{w,h,scale}, feather }   裁哪裡、放大到多大、區域在裁片的哪裡、羽化多寬(裁片的像素)
//   rectMask(w, h, inner, feather)      → Float32Array(w*h)   矩形區域的遮罩:區域內 1、靠邊緣 feather 像素內平滑降到 0(區域外 0)
//   softMask(binary, w, h, feather)     → Float32Array        任意形狀(塗抹出來的)的二值遮罩 → 邊緣羽化
//   toneMatch(gen, ref, mask, strength) → image                把生出來的圖的每個色版平均與標準差對到原圖(只看遮罩內),避免蓋回去出現色塊邊界
//   composite(base, gen, mask, opacity) → image                base × (1 − a) + gen × a,a = mask × opacity
//   detailTransfer(base, gen, amount, r)→ image                本機模型不能 img2img 時用:只借「生出來的圖的高頻細節」加到原圖上(原圖的結構與顏色不變)
//   scale(img, w, h)                    → image                雙線性縮放(縮小時先用面積平均,不會出現鋸齒)
//   regionOfMarks(marks, pad)           → {x,y,w,h}            塗抹／框選的標記合成一個框
// image = { width, height, data: Uint8ClampedArray(RGBA) }。全部是確定性的(同樣的輸入同樣的結果)。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPicDetail = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function r2(n) { return Math.round(n * 100) / 100; }

  // 標記(點／框／筆畫)的外框
  function markBox(m) {
    if (m.points && m.points.length) { var xs = m.points.map(function (p) { return p[0]; }), ys = m.points.map(function (p) { return p[1]; }), r = m.r || 8; return { x: Math.min.apply(null, xs) - r, y: Math.min.apply(null, ys) - r, w: Math.max.apply(null, xs) - Math.min.apply(null, xs) + 2 * r, h: Math.max.apply(null, ys) - Math.min.apply(null, ys) + 2 * r }; }
    if (m.w != null) return { x: m.x, y: m.y, w: m.w, h: m.h };
    var rr = m.r || 10; return { x: m.x - rr, y: m.y - rr, w: 2 * rr, h: 2 * rr };
  }
  function regionOfMarks(marks, pad) {
    if (!marks || !marks.length) return null; var x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18; pad = pad || 0;
    marks.forEach(function (m) { var b = markBox(m); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
    return { x: r2(x0 - pad), y: r2(y0 - pad), w: r2(x1 - x0 + 2 * pad), h: r2(y1 - y0 + 2 * pad) };
  }

  // 要裁哪裡。region:要細化的區域(世界座標);bounds:圖的範圍(世界座標);opts:{ context(多裁一圈,區域邊長的比例,預設 0.5), target(模型的邊長,預設 512), feather(羽化寬度,區域邊長的比例,預設 0.08), minSide(區域最小邊長,預設 8) }
  // → { ok, crop:{x,y,w,h}(世界座標,收進 bounds), inner:{x,y,w,h}(區域在裁片裡的位置,0..out 的像素), out:{w,h,scale}(放大後的像素大小:長邊 = target,取 8 的倍數), feather(輸出像素), region(收進 bounds 後的區域) }
  function plan(region, bounds, opts) {
    opts = opts || {}; if (!region || !bounds) return { ok: false, error: 'no region or no picture' };
    var x0 = Math.max(region.x, bounds.x), y0 = Math.max(region.y, bounds.y), x1 = Math.min(region.x + region.w, bounds.x + bounds.w), y1 = Math.min(region.y + region.h, bounds.y + bounds.h), minSide = opts.minSide || 8;
    if (x1 - x0 < minSide || y1 - y0 < minSide) return { ok: false, error: 'the region is outside the picture or smaller than ' + minSide + ' px' };
    var reg = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, ctx = clamp(opts.context == null ? 0.5 : Number(opts.context), 0, 2), padX = reg.w * ctx, padY = reg.h * ctx;
    var cx0 = Math.max(bounds.x, reg.x - padX), cy0 = Math.max(bounds.y, reg.y - padY), cx1 = Math.min(bounds.x + bounds.w, reg.x + reg.w + padX), cy1 = Math.min(bounds.y + bounds.h, reg.y + reg.h + padY);
    var crop = { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 }, target = opts.target || 512, k = target / Math.max(crop.w, crop.h);
    var ow = Math.max(64, Math.round(crop.w * k / 8) * 8), oh = Math.max(64, Math.round(crop.h * k / 8) * 8), sx = ow / crop.w, sy = oh / crop.h;
    var inner = { x: (reg.x - crop.x) * sx, y: (reg.y - crop.y) * sy, w: reg.w * sx, h: reg.h * sy };
    var feather = Math.max(2, Math.round(Math.min(inner.w, inner.h) * clamp(opts.feather == null ? 0.08 : Number(opts.feather), 0, 0.5)));
    return { ok: true, region: reg, crop: crop, inner: inner, out: { w: ow, h: oh, scale: k }, feather: feather };
  }

  // 矩形區域的遮罩(輸出像素座標):區域內 1;靠區域邊緣 feather 像素內平滑降到 0;區域貼著裁片邊(沒有再往外的脈絡)的那一邊不羽化——那裡本來就是圖的邊
  function rectMask(w, h, inner, feather, edges) {
    var m = new Float32Array(w * h), f = Math.max(0.5, feather || 1), e = edges || { l: true, t: true, r: true, b: true };
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var px = x + 0.5, py = y + 0.5; if (px < inner.x || px > inner.x + inner.w || py < inner.y || py > inner.y + inner.h) continue;
        var d = 1e9; if (e.l) d = Math.min(d, px - inner.x); if (e.t) d = Math.min(d, py - inner.y); if (e.r) d = Math.min(d, inner.x + inner.w - px); if (e.b) d = Math.min(d, inner.y + inner.h - py);
        m[y * w + x] = d >= 1e9 ? 1 : smooth(d / f);
      }
    }
    return m;
  }
  // 哪幾邊「有」往外的脈絡(那幾邊要羽化);貼著圖邊的那一邊不用
  function featherEdges(p) { var r = p.region, c = p.crop, eps = 1e-6; return { l: r.x - c.x > eps, t: r.y - c.y > eps, r: c.x + c.w - (r.x + r.w) > eps, b: c.y + c.h - (r.y + r.h) > eps }; }

  // 方框模糊(可分離;重複三次接近高斯)
  function boxBlur(src, w, h, r, passes) {
    r = Math.max(0, Math.round(r)); if (!r) return Float32Array.from(src); var a = Float32Array.from(src), b = new Float32Array(w * h); passes = passes || 3;
    for (var p = 0; p < passes; p++) {
      for (var y = 0; y < h; y++) { var acc = 0, cnt = 0, row = y * w; for (var x = -r; x <= r; x++) { if (x >= 0 && x < w) { acc += a[row + x]; cnt++; } } for (var x2 = 0; x2 < w; x2++) { b[row + x2] = acc / cnt; var add = x2 + r + 1, sub = x2 - r; if (add < w) { acc += a[row + add]; cnt++; } if (sub >= 0) { acc -= a[row + sub]; cnt--; } } }
      for (var x3 = 0; x3 < w; x3++) { var acc2 = 0, cnt2 = 0; for (var y2 = -r; y2 <= r; y2++) { if (y2 >= 0 && y2 < h) { acc2 += b[y2 * w + x3]; cnt2++; } } for (var y3 = 0; y3 < h; y3++) { a[y3 * w + x3] = acc2 / cnt2; var add2 = y3 + r + 1, sub2 = y3 - r; if (add2 < h) { acc2 += b[add2 * w + x3]; cnt2++; } if (sub2 >= 0) { acc2 -= b[sub2 * w + x3]; cnt2--; } } }
    }
    return a;
  }
  // 任意形狀:模糊後把 0.5(原邊緣)以內拉成 1,往外平滑到 0——區域內部完整保留、只有邊緣往外羽化一點
  function softMask(binary, w, h, feather) {
    var f = Float32Array.from(binary, function (v) { return v ? 1 : 0; }), b = boxBlur(f, w, h, Math.max(1, (feather || 4) / 2), 3), out = new Float32Array(w * h);
    for (var i = 0; i < out.length; i++) out[i] = smooth(b[i] * 2); // b 在邊緣 = 0.5 → 1;外面小於 0.5 → 漸漸到 0
    return out;
  }

  function stats(img, mask) { var s = [0, 0, 0], q = [0, 0, 0], n = 0, d = img.data; for (var i = 0, p = 0; i < d.length; i += 4, p++) { if (mask && mask[p] < 0.5) continue; for (var c = 0; c < 3; c++) { var v = d[i + c]; s[c] += v; q[c] += v * v; } n++; } if (!n) return null; return { mean: s.map(function (x) { return x / n; }), std: q.map(function (x, c) { return Math.sqrt(Math.max(1, x / n - (s[c] / n) * (s[c] / n))); }), n: n }; }
  // 把 gen 的每個色版平均與標準差對到 ref(只看遮罩 ≥ 0.5 的地方);strength 0..1(1=完全對齊);標準差的倍率夾在 0.6～1.7,不讓它對過頭
  function toneMatch(gen, ref, mask, strength) {
    var k = strength == null ? 1 : clamp(strength, 0, 1), a = stats(gen, mask), b = stats(ref, mask), out = { width: gen.width, height: gen.height, data: new Uint8ClampedArray(gen.data) };
    if (!a || !b || !k) return out; var d = out.data;
    for (var i = 0; i < d.length; i += 4) for (var c = 0; c < 3; c++) { var ratio = clamp(b.std[c] / a.std[c], 0.6, 1.7), v = (gen.data[i + c] - a.mean[c]) * ratio + b.mean[c]; d[i + c] = gen.data[i + c] * (1 - k) + v * k; }
    return out;
  }
  // base × (1 − a) + gen × a;base 與 gen 要一樣大。alpha 沿用 base 的
  function composite(base, gen, mask, opacity) {
    var op = opacity == null ? 1 : clamp(opacity, 0, 1), out = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data) }, d = out.data;
    for (var i = 0, p = 0; i < d.length; i += 4, p++) { var a = mask[p] * op; if (a <= 0) continue; for (var c = 0; c < 3; c++) d[i + c] = base.data[i + c] * (1 - a) + gen.data[i + c] * a; }
    return out;
  }
  // 只借高頻細節:out = base + amount × (gen − 模糊(gen))。base 與 gen 要一樣大
  function detailTransfer(base, gen, amount, radius) {
    var w = base.width, h = base.height, amt = amount == null ? 0.8 : clamp(amount, 0, 3), r = radius || 3, out = { width: w, height: h, data: new Uint8ClampedArray(base.data) }, n = w * h;
    for (var c = 0; c < 3; c++) {
      var ch = new Float32Array(n); for (var p = 0; p < n; p++) ch[p] = gen.data[p * 4 + c]; var lo = boxBlur(ch, w, h, r, 3);
      for (var q = 0; q < n; q++) out.data[q * 4 + c] = clamp(base.data[q * 4 + c] + amt * (ch[q] - lo[q]), 0, 255);
    }
    return out;
  }
  // 縮放:放大用雙線性,縮小用面積平均
  function scale(img, w, h) {
    var sw = img.width, sh = img.height, out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    if (w === sw && h === sh) { out.data.set(img.data); return out; }
    var fx = sw / w, fy = sh / h;
    if (fx > 1 || fy > 1) { for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) { var xa = x * fx, xb = (x + 1) * fx, ya = y * fy, yb = (y + 1) * fy, acc = [0, 0, 0, 0], wt = 0; for (var yy = Math.floor(ya); yy < Math.min(sh, Math.ceil(yb)); yy++) { var wy = Math.min(yy + 1, yb) - Math.max(yy, ya); for (var xx = Math.floor(xa); xx < Math.min(sw, Math.ceil(xb)); xx++) { var wx = Math.min(xx + 1, xb) - Math.max(xx, xa), ww = wx * wy, o = (yy * sw + xx) * 4; acc[0] += img.data[o] * ww; acc[1] += img.data[o + 1] * ww; acc[2] += img.data[o + 2] * ww; acc[3] += img.data[o + 3] * ww; wt += ww; } } var q = (y * w + x) * 4; if (wt > 0) { out.data[q] = acc[0] / wt; out.data[q + 1] = acc[1] / wt; out.data[q + 2] = acc[2] / wt; out.data[q + 3] = acc[3] / wt; } } return out; }
    for (var y2 = 0; y2 < h; y2++) { var sy = clamp((y2 + 0.5) * fy - 0.5, 0, sh - 1), y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0; for (var x2 = 0; x2 < w; x2++) { var sx = clamp((x2 + 0.5) * fx - 0.5, 0, sw - 1), x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0; for (var c = 0; c < 4; c++) { var v = (img.data[(y0 * sw + x0) * 4 + c] * (1 - tx) + img.data[(y0 * sw + x1) * 4 + c] * tx) * (1 - ty) + (img.data[(y1 * sw + x0) * 4 + c] * (1 - tx) + img.data[(y1 * sw + x1) * 4 + c] * tx) * ty; out.data[(y2 * w + x2) * 4 + c] = v; } } }
    return out;
  }
  // 兩張圖的差(平均絕對差,0..255;只看 mask ≥ thr 的地方)——測試與「蓋回去有沒有接縫」的檢查用
  function meanAbsDiff(a, b, mask, thr) { var s = 0, n = 0; for (var i = 0, p = 0; i < a.data.length; i += 4, p++) { if (mask && mask[p] < (thr == null ? 0.5 : thr)) continue; s += (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3; n++; } return n ? s / n : 0; }

  return { plan: plan, rectMask: rectMask, featherEdges: featherEdges, softMask: softMask, boxBlur: boxBlur, toneMatch: toneMatch, composite: composite, detailTransfer: detailTransfer, scale: scale, regionOfMarks: regionOfMarks, markBox: markBox, meanAbsDiff: meanAbsDiff, stats: stats };
});
