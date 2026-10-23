// What /edit-picture adds to imgproc (the 28 operations of /image: brightness, blur, grade, vignette ...): GIMP-like STYLE filters and REPAIR, all pure JS on {width, height, data: RGBA} so they run in the
// browser, in a worker, and in node tests (the same result everywhere). No model is needed for any of them; the vision model only helps to choose and to judge.
//   style filters   oil (oil paint) · sketch (pencil) · cartoon · watercolor · emboss · halftone · neon (glowing edges)
//   repair          denoise · despeckle (dust and scratches) · inpaint(mask) (fill a marked spot from what is around it)
//   FaPicFx.run(img, ops, { imgproc }) -> { img, applied }     ops as {op:'oil', radius:3}; any op that is not one of these goes to FaImgProc (brightness, blur, grade, ...)
//   FaPicFx.STYLES  { oil:{ label, words:[...], ops:[...] }, ... }   named looks (what "make it watercolor" means); FaPicFx.styleFor(text) -> id | null
//   FaPicFx.inpaint(img, mask) / marksToMask(marks, region, W, H)
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPicFx = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function num(v, lo, hi, d) { var n = Number(v); return isFinite(n) ? clamp(n, lo, hi) : d; }
  function make(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  function clone(img) { return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }; }
  function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }
  function gray(img) { var n = img.width * img.height, g = new Float32Array(n); for (var i = 0; i < n; i++) { g[i] = lum(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]); } return g; }
  // a box blur on one float plane (repeated 3 times it is close to a gaussian); r in pixels
  function boxBlur(plane, w, h, r) {
    r = Math.max(1, Math.round(r)); var tmp = new Float32Array(plane.length), out = new Float32Array(plane.length), k = 2 * r + 1;
    for (var y = 0; y < h; y++) { var acc = 0, row = y * w; for (var x = -r; x <= r; x++) { acc += plane[row + clamp(x, 0, w - 1)]; } for (x = 0; x < w; x++) { tmp[row + x] = acc / k; acc += plane[row + clamp(x + r + 1, 0, w - 1)] - plane[row + clamp(x - r, 0, w - 1)]; } }
    for (var x2 = 0; x2 < w; x2++) { var acc2 = 0; for (var yy = -r; yy <= r; yy++) { acc2 += tmp[clamp(yy, 0, h - 1) * w + x2]; } for (y = 0; y < h; y++) { out[y * w + x2] = acc2 / k; acc2 += tmp[clamp(y + r + 1, 0, h - 1) * w + x2] - tmp[clamp(y - r, 0, h - 1) * w + x2]; } }
    return out;
  }
  function blur3(plane, w, h, r) { return boxBlur(boxBlur(boxBlur(plane, w, h, r), w, h, r), w, h, r); }
  function sobel(g, w, h) {
    var mag = new Float32Array(w * h), ang = new Float32Array(w * h);
    for (var y = 1; y < h - 1; y++) { for (var x = 1; x < w - 1; x++) { var i = y * w + x, gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1], gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]; mag[i] = Math.sqrt(gx * gx + gy * gy); ang[i] = Math.atan2(gy, gx); } }
    return { mag: mag, ang: ang };
  }
  function hash(x, y) { var n = (x * 374761393 + y * 668265263) | 0; n = (n ^ (n >>> 13)) * 1274126177; return ((n ^ (n >>> 16)) >>> 0) / 4294967296; }

  // ───────────── style filters ─────────────
  function oil(img, o) {   // the classic oil-paint filter: in a window, the most common brightness bin decides the colour
    o = o || {}; var R = Math.round(num(o.radius, 1, 8, 3)), L = Math.round(num(o.levels, 4, 64, 20)), w = img.width, h = img.height, out = make(w, h), d = img.data, bins = new Int32Array(L), sr = new Int32Array(L), sg = new Int32Array(L), sb = new Int32Array(L);
    for (var y = 0; y < h; y++) { for (var x = 0; x < w; x++) {
      bins.fill(0); sr.fill(0); sg.fill(0); sb.fill(0);
      for (var yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) { for (var xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) { var j = (yy * w + xx) * 4, b = Math.min(L - 1, (lum(d[j], d[j + 1], d[j + 2]) * L / 256) | 0); bins[b]++; sr[b] += d[j]; sg[b] += d[j + 1]; sb[b] += d[j + 2]; } }
      var best = 0; for (var k = 1; k < L; k++) { if (bins[k] > bins[best]) { best = k; } }
      var p = (y * w + x) * 4, c = bins[best] || 1; out.data[p] = sr[best] / c; out.data[p + 1] = sg[best] / c; out.data[p + 2] = sb[best] / c; out.data[p + 3] = d[p + 3];
    } }
    return out;
  }
  function sketch(img, o) {   // pencil: grey, inverted, blurred, colour-dodged (the lines are where the picture changes)
    o = o || {}; var w = img.width, h = img.height, g = gray(img), inv = new Float32Array(g.length); for (var i = 0; i < g.length; i++) { inv[i] = 255 - g[i]; }
    var bl = blur3(inv, w, h, Math.max(2, Math.round(num(o.radius, 1, 30, 6) * Math.max(1, Math.min(w, h) / 600)))), out = make(w, h), k = num(o.strength, 0.3, 3, 1);
    for (i = 0; i < g.length; i++) { var v = clamp(g[i] * 255 / Math.max(1, 255 - bl[i]), 0, 255); v = clamp(255 - (255 - v) * k, 0, 255); out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = img.data[i * 4 + 3]; }
    return out;
  }
  function smoothColor(img, r, times) {   // edge-keeping-ish smoothing: blur each channel, but keep the original where the local change is big
    var w = img.width, h = img.height, n = w * h, ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], g = gray(img);
    for (var i = 0; i < n; i++) { ch[0][i] = img.data[i * 4]; ch[1][i] = img.data[i * 4 + 1]; ch[2][i] = img.data[i * 4 + 2]; }
    for (var t = 0; t < times; t++) { var bl = ch.map(function (p) { return boxBlur(p, w, h, r); }); for (i = 0; i < n; i++) { var dv = Math.abs(ch[0][i] - bl[0][i]) + Math.abs(ch[1][i] - bl[1][i]) + Math.abs(ch[2][i] - bl[2][i]), keep = clamp((dv - 30) / 60, 0, 1); for (var c = 0; c < 3; c++) { ch[c][i] = ch[c][i] * keep + bl[c][i] * (1 - keep); } } }
    var out = make(w, h); for (i = 0; i < n; i++) { out.data[i * 4] = ch[0][i]; out.data[i * 4 + 1] = ch[1][i]; out.data[i * 4 + 2] = ch[2][i]; out.data[i * 4 + 3] = img.data[i * 4 + 3]; } return out;
  }
  function cartoon(img, o) {
    o = o || {}; var w = img.width, h = img.height, lv = Math.round(num(o.levels, 3, 12, 6)), sm = smoothColor(img, Math.max(1, Math.round(Math.min(w, h) / 300)), 3), g = gray(sm), e = sobel(blur3(g, w, h, 1), w, h), out = make(w, h), step = 255 / (lv - 1), th = num(o.edge, 20, 400, 90);
    for (var i = 0; i < w * h; i++) { var dark = e.mag[i] > th, p = i * 4; for (var c = 0; c < 3; c++) { var v = Math.round(sm.data[p + c] / step) * step; out.data[p + c] = dark ? 20 : clamp(v, 0, 255); } out.data[p + 3] = img.data[p + 3]; }
    return out;
  }
  function watercolor(img, o) {
    o = o || {}; var w = img.width, h = img.height, sm = smoothColor(img, Math.max(2, Math.round(Math.min(w, h) / 160)), 4), g = gray(sm), e = sobel(boxBlur(g, w, h, 1), w, h), out = make(w, h), paper = num(o.paper, 0, 1, 0.5);
    for (var y = 0; y < h; y++) { for (var x = 0; x < w; x++) { var i = y * w + x, p = i * 4, edge = clamp(e.mag[i] / 400, 0, 0.35), tex = (hash(x >> 1, y >> 1) - 0.5) * 22 * paper, wash = 0.9; var m = (sm.data[p] + sm.data[p + 1] + sm.data[p + 2]) / 3;
      for (var c = 0; c < 3; c++) { var v = m + (sm.data[p + c] - m) * 0.85; v = 255 - (255 - v) * wash; v = v * (1 - edge) + tex; out.data[p + c] = clamp(v, 0, 255); } out.data[p + 3] = img.data[p + 3]; } }
    return out;
  }
  function emboss(img, o) {
    o = o || {}; var w = img.width, h = img.height, g = gray(img), out = make(w, h), k = num(o.strength, 0.3, 4, 1);
    for (var q = 0; q < w * h; q++) { out.data[q * 4] = out.data[q * 4 + 1] = out.data[q * 4 + 2] = 128; out.data[q * 4 + 3] = img.data[q * 4 + 3]; }   // the border pixels are plain grey
    for (var y = 1; y < h - 1; y++) { for (var x = 1; x < w - 1; x++) { var i = y * w + x, v = clamp(128 + k * (g[i - w - 1] * -2 - g[i - w] - g[i - 1] + g[i + 1] + g[i + w] + g[i + w + 1] * 2) / 2, 0, 255), p = i * 4; out.data[p] = out.data[p + 1] = out.data[p + 2] = v; out.data[p + 3] = img.data[p + 3]; } }
    return out;
  }
  function halftone(img, o) {
    o = o || {}; var w = img.width, h = img.height, cell = Math.round(num(o.size, 3, 40, Math.max(4, Math.round(Math.min(w, h) / 90)))), out = make(w, h);
    for (var i = 0; i < w * h; i++) { out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = 250; out.data[i * 4 + 3] = 255; }
    for (var cy = 0; cy < h; cy += cell) { for (var cx = 0; cx < w; cx += cell) {
      var r = 0, g = 0, b = 0, n = 0; for (var y = cy; y < Math.min(h, cy + cell); y++) { for (var x = cx; x < Math.min(w, cx + cell); x++) { var j = (y * w + x) * 4; r += img.data[j]; g += img.data[j + 1]; b += img.data[j + 2]; n++; } }
      r /= n; g /= n; b /= n; var dark = 1 - lum(r, g, b) / 255, rad = Math.sqrt(dark) * cell * 0.75, mx = cx + cell / 2, my = cy + cell / 2;
      for (y = Math.max(0, Math.floor(my - rad)); y <= Math.min(h - 1, Math.ceil(my + rad)); y++) { for (x = Math.max(0, Math.floor(mx - rad)); x <= Math.min(w - 1, Math.ceil(mx + rad)); x++) { if ((x - mx) * (x - mx) + (y - my) * (y - my) <= rad * rad) { var q = (y * w + x) * 4; out.data[q] = r * 0.85; out.data[q + 1] = g * 0.85; out.data[q + 2] = b * 0.85; } } }
    } }
    return out;
  }
  function neon(img) {
    var w = img.width, h = img.height, g = gray(img), e = sobel(boxBlur(g, w, h, 1), w, h), out = make(w, h);
    for (var i = 0; i < w * h; i++) { var m = clamp(e.mag[i] / 160, 0, 1), a = e.ang[i], p = i * 4; out.data[p] = 10 + 245 * m * (0.5 + 0.5 * Math.cos(a)); out.data[p + 1] = 8 + 230 * m * (0.5 + 0.5 * Math.cos(a + 2.1)); out.data[p + 2] = 20 + 235 * m * (0.5 + 0.5 * Math.cos(a + 4.2)); out.data[p + 3] = img.data[p + 3]; }
    return out;
  }

  // ───────────── repair ─────────────
  function median3(img, thresholdOnly, th) {
    var w = img.width, h = img.height, out = clone(img), d = img.data, buf = new Array(9);
    for (var y = 1; y < h - 1; y++) { for (var x = 1; x < w - 1; x++) { var p = (y * w + x) * 4;
      for (var c = 0; c < 3; c++) { var k = 0; for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) { buf[k++] = d[((y + dy) * w + x + dx) * 4 + c]; } } buf.sort(function (a, b) { return a - b; }); var med = buf[4]; if (!thresholdOnly || Math.abs(d[p + c] - med) > th) { out.data[p + c] = med; } } } }
    return out;
  }
  function denoise(img, o) { o = o || {}; var s = num(o.strength, 0.1, 1, 0.6), m = median3(img, false, 0), sm = smoothColor(m, 1, 1), out = clone(img); for (var i = 0; i < out.data.length; i += 4) { for (var c = 0; c < 3; c++) { out.data[i + c] = img.data[i + c] * (1 - s) + sm.data[i + c] * s; } } return out; }
  function despeckle(img, o) { o = o || {}; return median3(img, true, num(o.threshold, 8, 120, 40)); }
  // fill the marked pixels from what is around them: from the edge of the mark inwards, each pixel takes the (distance weighted) average of the known pixels near it, then a little smoothing inside the mark
  function inpaint(img, mask, o) {
    o = o || {}; var w = img.width, h = img.height, out = clone(img), d = out.data, todo = new Uint8Array(mask), left = 0, R = Math.round(num(o.radius, 1, 12, 3));
    for (var i = 0; i < todo.length; i++) { if (todo[i]) { left++; } }
    if (!left) { return out; } if (left === w * h) { return out; }
    var rounds = 0;
    while (left > 0 && rounds++ < 400) {
      var fill = [];
      for (var y = 0; y < h; y++) { for (var x = 0; x < w; x++) { var q = y * w + x; if (!todo[q]) { continue; } var sr = 0, sg = 0, sb = 0, sw = 0;
        for (var dy = -R; dy <= R; dy++) { var yy = y + dy; if (yy < 0 || yy >= h) { continue; } for (var dx = -R; dx <= R; dx++) { var xx = x + dx; if (xx < 0 || xx >= w) { continue; } var q2 = yy * w + xx; if (todo[q2]) { continue; } var wt = 1 / (dx * dx + dy * dy + 0.5); sr += d[q2 * 4] * wt; sg += d[q2 * 4 + 1] * wt; sb += d[q2 * 4 + 2] * wt; sw += wt; } }
        if (sw > 0) { fill.push([q, sr / sw, sg / sw, sb / sw]); } } }
      if (!fill.length) { break; }
      fill.forEach(function (f) { d[f[0] * 4] = f[1]; d[f[0] * 4 + 1] = f[2]; d[f[0] * 4 + 2] = f[3]; todo[f[0]] = 0; left--; });
    }
    // smooth inside the marked area so the fill does not show bands
    for (var pass = 0; pass < 2; pass++) { var src = new Uint8ClampedArray(d); for (y = 1; y < h - 1; y++) { for (x = 1; x < w - 1; x++) { var m = y * w + x; if (!mask[m]) { continue; } for (var c = 0; c < 3; c++) { var s2 = 0; for (dy = -1; dy <= 1; dy++) { for (dx = -1; dx <= 1; dx++) { s2 += src[((y + dy) * w + x + dx) * 4 + c]; } } d[m * 4 + c] = s2 / 9; } } } }
    return out;
  }
  // the marks (world units) -> a mask on a region of the picture; marks: {x,y,r} a round spot, {x,y,w,h} a box, {points:[[x,y],...], r} a brush stroke
  function marksToMask(marks, region, W, H) {
    var mask = new Uint8Array(W * H), sx = W / region.w, sy = H / region.h;
    function disc(cx, cy, r) { var x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r); for (var y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) { for (var x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) { if ((x + 0.5 - cx) * (x + 0.5 - cx) + (y + 0.5 - cy) * (y + 0.5 - cy) <= r * r) { mask[y * W + x] = 1; } } } }
    (marks || []).forEach(function (m) {
      if (m.points) { var r = Math.max(1, (m.r || 8) * sx), pts = m.points; for (var i = 0; i < pts.length; i++) { var a = pts[i], b = pts[i + 1] || pts[i], n = Math.max(1, Math.ceil(Math.hypot((b[0] - a[0]) * sx, (b[1] - a[1]) * sy) / Math.max(1, r / 2))); for (var k = 0; k <= n; k++) { disc((a[0] + (b[0] - a[0]) * k / n - region.x) * sx, (a[1] + (b[1] - a[1]) * k / n - region.y) * sy, r); } } }
      else if (m.w != null && m.h != null) { var x0 = Math.round((m.x - region.x) * sx), y0 = Math.round((m.y - region.y) * sy), x1 = Math.round((m.x + m.w - region.x) * sx), y1 = Math.round((m.y + m.h - region.y) * sy); for (var y = Math.max(0, y0); y < Math.min(H, y1); y++) { for (var x = Math.max(0, x0); x < Math.min(W, x1); x++) { mask[y * W + x] = 1; } } }
      else { disc((m.x - region.x) * sx, (m.y - region.y) * sy, Math.max(1, (m.r || 10) * sx)); }
    });
    return mask;
  }

  var FX = { oil: oil, sketch: sketch, cartoon: cartoon, watercolor: watercolor, emboss: emboss, halftone: halftone, neon: neon, denoise: denoise, despeckle: despeckle };
  var FX_NAMES = Object.keys(FX);
  var FX_WORDS = { oil: ['oil', '油畫'], sketch: ['sketch', 'pencil', '素描', '鉛筆'], cartoon: ['cartoon', 'comic', '卡通', '漫畫'], watercolor: ['watercolor', 'watercolour', '水彩'], emboss: ['emboss', '浮雕'], halftone: ['halftone', '網點', '半色調'], neon: ['neon', '霓虹'], denoise: ['denoise', 'noise_reduction', '降噪', '去噪', '去雜訊'], despeckle: ['despeckle', 'dust', 'scratches', '去雜點', '去污點', '去刮痕'] };
  var NAME_OF = {}; Object.keys(FX_WORDS).forEach(function (k) { FX_WORDS[k].forEach(function (a) { NAME_OF[a.toLowerCase()] = k; }); });
  function fxName(op) { return NAME_OF[String(op || '').trim().toLowerCase()] || null; }
  // ops: [{op:'oil', ...}, {op:'brightness', amount:10}, ...]; the ones that are not here go to imgproc
  function run(img, ops, hooks) {
    hooks = hooks || {}; var cur = img, applied = [], list = Array.isArray(ops) ? ops : [], batch = [];
    function flush() { if (batch.length && hooks.imgproc) { var n = hooks.imgproc.normalizeOps(batch); if (n.ok && n.ops.length) { var r = hooks.imgproc.run(cur, n.ops); cur = r.img; r.applied.forEach(function (a) { applied.push(a); }); } } batch = []; }
    list.forEach(function (o) { var f = fxName(o && o.op); if (f) { flush(); var t0 = Date.now(); cur = FX[f](cur, o); applied.push({ op: f, ms: Date.now() - t0 }); } else { batch.push(o); } });
    flush(); return { img: cur, applied: applied };
  }
  // named looks: what "make it watercolor" means as operations; words are what the user may say
  var STYLES = {
    oil: { en: 'an oil painting', label: '油畫', words: ['油畫', 'oil'], ops: [{ op: 'oil', radius: 3 }, { op: 'saturation', amount: 15 }, { op: 'contrast', amount: 8 }] },
    watercolor: { en: 'a watercolor painting', label: '水彩', words: ['水彩', 'watercolor', 'watercolour'], ops: [{ op: 'watercolor' }, { op: 'saturation', amount: -8 }, { op: 'brightness', amount: 6 }] },
    sketch: { en: 'a pencil sketch', label: '鉛筆素描', words: ['素描', '鉛筆', 'sketch', 'pencil'], ops: [{ op: 'sketch' }] },
    ink: { en: 'an ink wash drawing', label: '水墨', words: ['水墨', '墨', 'ink'], ops: [{ op: 'grayscale' }, { op: 'contrast', amount: 35 }, { op: 'sketch', strength: 0.8 }, { op: 'blur', radius: 1 }] },
    cartoon: { en: 'a cartoon drawing', label: '卡通', words: ['卡通', '漫畫', 'cartoon', 'comic', 'anime'], ops: [{ op: 'cartoon' }, { op: 'saturation', amount: 25 }] },
    pixel: { en: 'pixel art', label: '像素', words: ['像素', 'pixel', '馬賽克', 'mosaic'], ops: [{ op: 'mosaic', block: 8 }, { op: 'reduce_colors', colors: 24 }] },
    poster: { en: 'a poster print with flat colours', label: '海報／版畫', words: ['海報', '版畫', 'poster', 'posterize'], ops: [{ op: 'posterize', levels: 4 }, { op: 'saturation', amount: 25 }, { op: 'contrast', amount: 15 }] },
    vintage: { en: 'an old vintage photograph', label: '復古', words: ['復古', '懷舊', '老照片', 'vintage', 'retro'], ops: [{ op: 'grade', preset: 'sepia' }, { op: 'vignette', strength: 0.5 }, { op: 'contrast', amount: -8 }] },
    neon: { en: 'a picture made of glowing neon lines', label: '霓虹', words: ['霓虹', 'neon', '賽博', 'cyberpunk'], ops: [{ op: 'neon' }] },
    emboss: { en: 'an embossed relief', label: '浮雕', words: ['浮雕', 'emboss'], ops: [{ op: 'emboss' }] },
    halftone: { en: 'a halftone dot print', label: '網點', words: ['網點', '半色調', 'halftone'], ops: [{ op: 'halftone' }] },
    dreamy: { en: 'a soft dreamy glowing picture', label: '夢幻', words: ['夢幻', '柔焦', 'dreamy', 'soft'], ops: [{ op: 'glow', amount: 0.6 }, { op: 'saturation', amount: 12 }, { op: 'brightness', amount: 8 }] },
    mono: { en: 'a black and white picture', label: '黑白', words: ['黑白', '灰階', 'grayscale', 'black and white', 'monochrome'], ops: [{ op: 'grayscale' }, { op: 'contrast', amount: 10 }] },
    warm: { en: 'a picture with warm colours', label: '暖色', words: ['暖色', '暖', 'warm'], ops: [{ op: 'grade', preset: 'warm' }] },
    cool: { en: 'a picture with cool blue colours', label: '冷色', words: ['冷色', '冷', 'cool'], ops: [{ op: 'grade', preset: 'cool' }] },
    night: { en: 'a dark night scene', label: '夜晚', words: ['夜晚', '夜景', 'night'], ops: [{ op: 'grade', preset: 'night' }, { op: 'vignette', strength: 0.5 }] }
  };
  function styleFor(text) {
    var t = String(text || '').toLowerCase(), best = null, bl = 0;
    Object.keys(STYLES).forEach(function (id) { STYLES[id].words.forEach(function (w) { if (t.indexOf(w.toLowerCase()) >= 0 && w.length > bl) { best = id; bl = w.length; } }); });
    return best;
  }
  return { run: run, oil: oil, sketch: sketch, cartoon: cartoon, watercolor: watercolor, emboss: emboss, halftone: halftone, neon: neon, denoise: denoise, despeckle: despeckle, inpaint: inpaint, marksToMask: marksToMask, FX_NAMES: FX_NAMES, fxName: fxName, STYLES: STYLES, styleFor: styleFor, boxBlur: boxBlur };
});
