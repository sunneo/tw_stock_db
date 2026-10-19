/* 點陣精靈（純函式，UMD，不碰 DOM／canvas）：把一張高解析度的渲染圖變成「像素風」的小圖，給簡報的素材用（樹、房子、桌子…；之後的人物精靈圖用同一套）。
 *
 *   matte(imgA, imgB, keyA, keyB)   同一個畫面渲染兩次（背景色不同）→ 差分去背：每個像素的透明度與顏色都是精確的（不會有一圈背景色的邊）
 *   pixelate(img, opts)             裁到內容 → 等比縮進畫格（預設 32×48）→ 透明度二值化 → 調色盤（中位切割，預設 16 色）→ 1 像素外框 → 腳底對齊畫格底部
 *   objectYaml(kind, opts)          內建物件樣板（tree pine house table chest rock well）→ render_3d_scene 的 YAML（封閉選項：顏色、大小）
 *
 * 影像物件：{ width, height, data: Uint8ClampedArray（RGBA） }。結果是確定性的：同樣的輸入永遠同樣的圖。
 * 為什麼自己寫、不用 imgproc 的 reduce_colors：要「只量化不透明的像素」、透明邊界要二值化、調色盤要回傳給呼叫端（整張精靈圖共用），imgproc 的減色不處理透明。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatDeckSpritePixel = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KINDS = ['tree', 'pine', 'house', 'table', 'chest', 'rock', 'well'];
  var COLORS = {
    leaf: { green: '#3c9447', dark: '#256a31', autumn: '#d9822b', pink: '#f29bb5' },
    wall: { cream: '#e3cfa3', white: '#efe9db', gray: '#b9b4a8', brick: '#b5694a' },
    roof: { red: '#a8452f', blue: '#3a63b5', brown: '#7a5230', green: '#3c7a4a' },
    wood: { wood: '#8a5a30', dark: '#4e3224', white: '#d9d2c0' },
    box: { brown: '#8a5a30', blue: '#3a63b5', red: '#a8382f' },
    stone: { gray: '#8c8c95', brown: '#8a7a68' }
  };
  var DEFAULT_FRAME = { tree: [32, 48], pine: [32, 48], house: [64, 48], table: [32, 32], chest: [32, 32], rock: [32, 32], well: [32, 40] };
  function pick(table, name, fallback) { return table[name] || table[fallback]; }

  // ---------------------------------------------------------------- 物件樣板（單位：1 ≈ 一個格子）
  function node(mesh, pos, extra, color) { return '  - { mesh: ' + mesh + ', position: [' + pos.join(', ') + ']' + (extra ? ', ' + extra : '') + ', material: { color: "' + color + '"' + (mesh === 'plane' ? ', side: double' : '') + ' } }'; }
  function sceneYaml(title, cam, nodes) {
    return ['title: ' + title, 'camera: { position: [' + cam.pos.join(', ') + '], look_at: [' + cam.look.join(', ') + '], fov: ' + (cam.fov || 30) + ' }',
      'lights:', '  - { type: ambient, intensity: 0.75 }', '  - { type: directional, position: [3, 6, 4], intensity: 1.0 }', 'nodes:'].concat(nodes).join('\n') + '\n';
  }
  function objectYaml(kind, o) {
    o = o || {}; var s = o.scale > 0 ? o.scale : 1, N = [], cam;
    var P = function (x, y, z) { return [+(x * s).toFixed(3), +(y * s).toFixed(3), +(z * s).toFixed(3)]; }, R = function (v) { return +(v * s).toFixed(3); };
    if (kind === 'tree') {
      var leaf = pick(COLORS.leaf, o.color, 'green'), leaf2 = o.color === 'pink' ? '#f7b6cb' : '#4aa957';
      N.push(node('cylinder', P(0, 0.5, 0), 'radius: ' + R(0.13) + ', height: ' + R(1.0), '#6b4423'));
      N.push(node('sphere', P(0, 1.45, 0), 'radius: ' + R(0.66), leaf)); N.push(node('sphere', P(-0.38, 1.15, 0.12), 'radius: ' + R(0.46), leaf2)); N.push(node('sphere', P(0.4, 1.22, -0.05), 'radius: ' + R(0.43), leaf)); N.push(node('sphere', P(0, 1.95, 0), 'radius: ' + R(0.46), leaf2));
      cam = { pos: [0, 3.2, 7.2], look: [0, 1.15 * s, 0], fov: 30 };
    } else if (kind === 'pine') {
      var pg = o.color === 'snow' ? '#e8f0f2' : pick(COLORS.leaf, o.color, 'dark');
      N.push(node('cylinder', P(0, 0.3, 0), 'radius: ' + R(0.1) + ', height: ' + R(0.6), '#5e3a1c'));
      N.push(node('cone', P(0, 0.95, 0), 'radius: ' + R(0.78) + ', height: ' + R(0.95), pg)); N.push(node('cone', P(0, 1.5, 0), 'radius: ' + R(0.62) + ', height: ' + R(0.85), pg)); N.push(node('cone', P(0, 1.98, 0), 'radius: ' + R(0.44) + ', height: ' + R(0.75), pg));
      cam = { pos: [0, 3.2, 7.2], look: [0, 1.15 * s, 0], fov: 30 };
    } else if (kind === 'house') {
      var wall = pick(COLORS.wall, o.wall || o.color, 'cream'), roof = pick(COLORS.roof, o.roof, 'red');
      N.push(node('box', P(0, 0.65, 0), 'size: [' + R(2.4) + ', ' + R(1.3) + ', ' + R(1.8) + ']', wall));
      N.push(node('cone', P(0, 1.8, 0), 'radius: ' + R(1.95) + ', height: ' + R(1.05), roof));
      N.push(node('box', P(0, 0.42, 0.93), 'size: [' + R(0.5) + ', ' + R(0.84) + ', ' + R(0.06) + ']', '#5a3a22'));
      N.push(node('box', P(-0.8, 0.78, 0.92), 'size: [' + R(0.4) + ', ' + R(0.4) + ', ' + R(0.05) + ']', '#9fd3ea')); N.push(node('box', P(0.8, 0.78, 0.92), 'size: [' + R(0.4) + ', ' + R(0.4) + ', ' + R(0.05) + ']', '#9fd3ea'));
      cam = { pos: [0, 3.6, 8.2], look: [0, 1.0 * s, 0], fov: 32 };
    } else if (kind === 'table') {
      var tw = pick(COLORS.wood, o.color, 'wood');
      N.push(node('box', P(0, 0.75, 0), 'size: [' + R(1.6) + ', ' + R(0.12) + ', ' + R(0.9) + ']', tw));
      [[-0.7, -0.35], [0.7, -0.35], [-0.7, 0.35], [0.7, 0.35]].forEach(function (c) { N.push(node('cylinder', P(c[0], 0.36, c[1]), 'radius: ' + R(0.06) + ', height: ' + R(0.72), '#5e3b1f')); });
      cam = { pos: [0, 2.6, 4.8], look: [0, 0.5 * s, 0], fov: 30 };
    } else if (kind === 'chest') {
      var cb = pick(COLORS.box, o.color, 'brown');
      N.push(node('box', P(0, 0.25, 0), 'size: [' + R(0.9) + ', ' + R(0.5) + ', ' + R(0.55) + ']', cb)); N.push(node('box', P(0, 0.61, 0), 'size: [' + R(0.9) + ', ' + R(0.22) + ', ' + R(0.55) + ']', '#a87344'));
      N.push(node('box', P(0, 0.42, 0.29), 'size: [' + R(0.14) + ', ' + R(0.16) + ', ' + R(0.04) + ']', '#e8c25a'));
      cam = { pos: [0, 2.0, 3.6], look: [0, 0.35 * s, 0], fov: 30 };
    } else if (kind === 'rock') {
      var rc = pick(COLORS.stone, o.color, 'gray');
      N.push(node('sphere', P(0, 0.4, 0), 'radius: ' + R(0.55), rc)); N.push(node('sphere', P(0.5, 0.25, 0.2), 'radius: ' + R(0.35), '#9a9aa3')); N.push(node('sphere', P(-0.45, 0.22, 0.25), 'radius: ' + R(0.3), '#7d7d86'));
      cam = { pos: [0, 2.2, 4.2], look: [0, 0.3 * s, 0], fov: 30 };
    } else if (kind === 'well') {
      N.push(node('cylinder', P(0, 0.3, 0), 'radius: ' + R(0.6) + ', height: ' + R(0.6), pick(COLORS.stone, o.color, 'gray'))); N.push(node('cylinder', P(0, 0.61, 0), 'radius: ' + R(0.45) + ', height: ' + R(0.02), '#2d5e8f'));
      N.push(node('cylinder', P(-0.55, 0.65, 0), 'radius: ' + R(0.05) + ', height: ' + R(1.1), '#6b4423')); N.push(node('cylinder', P(0.55, 0.65, 0), 'radius: ' + R(0.05) + ', height: ' + R(1.1), '#6b4423'));
      N.push(node('box', P(0, 1.22, 0), 'size: [' + R(1.4) + ', ' + R(0.08) + ', ' + R(0.7) + ']', pick(COLORS.roof, o.roof, 'red')));
      cam = { pos: [0, 2.8, 5.4], look: [0, 0.65 * s, 0], fov: 30 };
    } else { return null; }
    return sceneYaml(o.title || kind, cam, N);
  }
  // 同一份樣板轉成零件（給 sprite_raster.js 用，不需要 three.js）：解析 objectYaml 產生的每一行（格式固定，由本檔自己產生）
  function objectParts(kind, o) {
    var y = objectYaml(kind, o); if (!y) { return null; }
    var num = function (str) { return JSON.parse('[' + str + ']'); }, parts = [], cam = /camera: \{ position: \[([^\]]+)\], look_at: \[([^\]]+)\], fov: ([0-9.]+)/.exec(y);
    y.split('\n').forEach(function (ln) {
      var m = /\{ mesh: (\w+), position: \[([^\]]+)\](?:, size: \[([^\]]+)\])?(?:, radius: ([0-9.]+))?(?:, height: ([0-9.]+))?, material: \{ color: "(#[0-9a-fA-F]{6})"/.exec(ln); if (!m) { return; }
      var p = { shape: m[1], pos: num(m[2]), rot: [0, 0, 0], color: m[6] }; if (m[1] === 'box') { p.size = num(m[3]); } else if (m[1] === 'sphere') { p.r = +m[4]; } else { p.r = +m[4]; p.h = +m[5]; } parts.push(p);
    });
    return { parts: parts, camera: { fov: +cam[3], position: num(cam[1]), lookAt: num(cam[2]) }, light: [0.25, 0.7, 1], ambient: 0.45 };
  }
  function defaultFrame(kind) { return (DEFAULT_FRAME[kind] || [32, 48]).slice(); }

  // ---------------------------------------------------------------- 去背
  // 同一個畫面在背景 keyA、keyB（RGB 陣列，要差很多，例如洋紅與綠）上各渲染一次：1 - α = (A - B) / (keyA - keyB)；顏色 = (A - keyA × (1 - α)) / α
  function matte(imgA, imgB, keyA, keyB) {
    var w = imgA.width, h = imgA.height, out = new Uint8ClampedArray(w * h * 4), A = imgA.data, B = imgB.data;
    var d = [keyA[0] - keyB[0], keyA[1] - keyB[1], keyA[2] - keyB[2]];
    for (var i = 0; i < w * h; i++) {
      var o = i * 4, num = 0, den = 0;
      for (var c = 0; c < 3; c++) { num += (A[o + c] - B[o + c]) * d[c]; den += d[c] * d[c]; }
      var inv = den ? num / den : 0, al = Math.max(0, Math.min(1, 1 - inv)); // 1 - alpha
      if (al < 0.004) { out[o + 3] = 0; continue; }
      for (var k = 0; k < 3; k++) { var f = (A[o + k] - keyA[k] * (1 - al)) / al; out[o + k] = Math.max(0, Math.min(255, Math.round(f))); }
      out[o + 3] = Math.round(al * 255);
    }
    return { width: w, height: h, data: out };
  }

  // ---------------------------------------------------------------- 點陣化
  function bboxOf(img, thr) {
    var w = img.width, h = img.height, d = img.data, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) { for (var x = 0; x < w; x++) { if (d[(y * w + x) * 4 + 3] >= thr) { if (x < x0) { x0 = x; } if (x > x1) { x1 = x; } if (y < y0) { y0 = y; } if (y > y1) { y1 = y; } } } }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  // 預乘 alpha 的面積平均縮小：src 的 (bx,by,bw,bh) → tw×th
  function resample(img, bb, tw, th) {
    var w = img.width, d = img.data, out = new Float64Array(tw * th * 4), sx = bb.w / tw, sy = bb.h / th;
    for (var ty = 0; ty < th; ty++) {
      for (var tx = 0; tx < tw; tx++) {
        var x0 = bb.x + tx * sx, x1 = x0 + sx, y0 = bb.y + ty * sy, y1 = y0 + sy, r = 0, g = 0, b = 0, a = 0, wsum = 0;
        for (var y = Math.floor(y0); y < Math.ceil(y1); y++) {
          var wy = Math.min(y + 1, y1) - Math.max(y, y0); if (wy <= 0 || y < 0 || y >= img.height) { continue; }
          for (var x = Math.floor(x0); x < Math.ceil(x1); x++) {
            var wx = Math.min(x + 1, x1) - Math.max(x, x0); if (wx <= 0 || x < 0 || x >= w) { continue; }
            var wt = wx * wy, o = (y * w + x) * 4, al = d[o + 3] / 255; r += d[o] * al * wt; g += d[o + 1] * al * wt; b += d[o + 2] * al * wt; a += al * wt; wsum += wt;
          }
        }
        var q = (ty * tw + tx) * 4; if (wsum > 0 && a > 0) { out[q] = r / a; out[q + 1] = g / a; out[q + 2] = b / a; out[q + 3] = a / wsum; }
      }
    }
    return out;
  }
  // 中位切割（只吃不透明像素）：回傳 n 個顏色；確定性（同樣的輸入同樣的調色盤）
  function medianCut(px, n) {
    if (!px.length) { return []; }
    var boxes = [px.slice()];
    var range = function (bx) { var mn = [255, 255, 255], mx = [0, 0, 0]; bx.forEach(function (p) { for (var c = 0; c < 3; c++) { if (p[c] < mn[c]) { mn[c] = p[c]; } if (p[c] > mx[c]) { mx[c] = p[c]; } } }); return [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]; };
    while (boxes.length < n) {
      var bi = -1, best = 0; boxes.forEach(function (bx, i) { if (bx.length < 2) { return; } var rg = range(bx), m = Math.max(rg[0], rg[1], rg[2]) * Math.sqrt(bx.length); if (m > best) { best = m; bi = i; } });
      if (bi < 0 || best === 0) { break; }
      var bx = boxes[bi], rg = range(bx), ch = rg[0] >= rg[1] && rg[0] >= rg[2] ? 0 : (rg[1] >= rg[2] ? 1 : 2);
      bx.sort(function (a, b) { return a[ch] - b[ch] || a[(ch + 1) % 3] - b[(ch + 1) % 3] || a[(ch + 2) % 3] - b[(ch + 2) % 3]; });
      var mid = bx.length >> 1; boxes.splice(bi, 1, bx.slice(0, mid), bx.slice(mid));
    }
    return boxes.map(function (bx) { var s = [0, 0, 0]; bx.forEach(function (p) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }); return [Math.round(s[0] / bx.length), Math.round(s[1] / bx.length), Math.round(s[2] / bx.length)]; });
  }
  function hex(c) { return '#' + c.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join(''); }
  function nearest(pal, p) { var bi = 0, bd = 1e12; for (var i = 0; i < pal.length; i++) { var dr = pal[i][0] - p[0], dg = pal[i][1] - p[1], db = pal[i][2] - p[2], dd = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11; if (dd < bd) { bd = dd; bi = i; } } return bi; }

  // opts: frame [W,H] (default 32x48), palette (default 16), gamma (>1 brightens the dark side; the CPU raster's light is fixed, default 1), posterize (cel shading: the brightness in N bands, e.g. 3), outline 'dark' | 'shade' | 'none' (default dark), margin (default 1; the outline needs it), anchor 'bottom' | 'center'
  // pixelateMany: several frames of one thing (a walk cycle) share ONE crop, ONE scale and ONE palette -- otherwise the character jitters and changes colour from frame to frame
  function pixelateMany(imgs, opts) {
    opts = opts || {}; var F = opts.frame || [32, 48], W = F[0], H = F[1], n = Math.max(2, Math.min(64, opts.palette || 16)), ol = opts.outline || 'dark', mg = opts.margin == null ? (ol === 'none' ? 0 : 1) : opts.margin;
    var u = null; imgs.forEach(function (im) { var b = bboxOf(im, 8); if (!b) { return; } u = u ? { x0: Math.min(u.x0, b.x), y0: Math.min(u.y0, b.y), x1: Math.max(u.x1, b.x + b.w), y1: Math.max(u.y1, b.y + b.h) } : { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h }; });
    var empty = function () { return { width: W, height: H, data: new Uint8ClampedArray(W * H * 4), palette: [], bbox: null, scale: 0, empty: true }; };
    if (!u) { return imgs.map(empty); }
    var bb = { x: u.x0, y: u.y0, w: u.x1 - u.x0, h: u.y1 - u.y0 }, iw = W - 2 * mg, ih = H - 2 * mg, sc = Math.min(iw / bb.w, ih / bb.h), tw = Math.max(1, Math.round(bb.w * sc)), th = Math.max(1, Math.round(bb.h * sc));
    var gm = opts.gamma > 0 ? 1 / opts.gamma : 1, ps = opts.posterize >= 2 ? Math.min(8, opts.posterize | 0) : 0, ox = Math.floor((W - tw) / 2), oy = opts.anchor === 'center' ? Math.floor((H - th) / 2) : H - mg - th, opaque = [], per = [];
    imgs.forEach(function (im) {
      var rs = resample(im, bb, tw, th), idxs = [];
      if (gm !== 1) { for (var gi = 0; gi < rs.length; gi += 4) { for (var gc = 0; gc < 3; gc++) { rs[gi + gc] = 255 * Math.pow(rs[gi + gc] / 255, gm); } } }
      for (var y = 0; y < th; y++) { for (var x = 0; x < tw; x++) { var q = (y * tw + x) * 4; if (rs[q + 3] >= 0.5) {
        var c = [rs[q], rs[q + 1], rs[q + 2]];
        if (ps) { var l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; if (l > 1) { var ql = Math.max(46, Math.round(l / 255 * (ps - 1)) / (ps - 1) * 255), k = ql / l; c = [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)]; } }
        opaque.push(c); idxs.push({ x: ox + x, y: oy + y, i: opaque.length - 1 }); } } }
      per.push(idxs);
    });
    var pal = medianCut(opaque, n), inkColor = [32, 24, 43];
    return imgs.map(function (im, fi) {
      var data = new Uint8ClampedArray(W * H * 4);
      per[fi].forEach(function (p) { var c = pal[nearest(pal, opaque[p.i])], o = (p.y * W + p.x) * 4; data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255; });
      if (!per[fi].length) { return empty(); }
      if (ol !== 'none') {
        var src = new Uint8ClampedArray(data); var at = function (x, y) { return x >= 0 && y >= 0 && x < W && y < H && src[(y * W + x) * 4 + 3] === 255; };
        for (var yy = 0; yy < H; yy++) {
          for (var xx = 0; xx < W; xx++) {
            if (src[(yy * W + xx) * 4 + 3] === 255) { continue; }
            var nb = null; [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) { if (!nb && at(xx + d[0], yy + d[1])) { nb = (yy + d[1]) * W * 4 + (xx + d[0]) * 4; } });
            if (nb == null) { continue; } var o2 = (yy * W + xx) * 4;
            if (ol === 'shade') { data[o2] = Math.round(src[nb] * 0.4); data[o2 + 1] = Math.round(src[nb + 1] * 0.4); data[o2 + 2] = Math.round(src[nb + 2] * 0.4); } else { data[o2] = inkColor[0]; data[o2 + 1] = inkColor[1]; data[o2 + 2] = inkColor[2]; }
            data[o2 + 3] = 255;
          }
        }
      }
      var used = {}; for (var i2 = 0; i2 < W * H; i2++) { if (data[i2 * 4 + 3] === 255) { used[hex([data[i2 * 4], data[i2 * 4 + 1], data[i2 * 4 + 2]])] = 1; } }
      return { width: W, height: H, data: data, palette: Object.keys(used), bbox: bb, scale: sc, empty: false };
    });
  }
  function pixelate(img, opts) { return pixelateMany([img], opts)[0]; }

  // 把同樣大小的畫格排成精靈圖（逐列、由左到右）：cols 欄；回傳 {width, height, data}
  function packSheet(frames, cols) {
    var fw = frames[0].width, fh = frames[0].height, rows = Math.ceil(frames.length / cols), data = new Uint8ClampedArray(fw * cols * fh * rows * 4), W = fw * cols;
    frames.forEach(function (f, i) { var cx = (i % cols) * fw, cy = Math.floor(i / cols) * fh; for (var y = 0; y < fh; y++) { for (var x = 0; x < fw; x++) { var a = (y * fw + x) * 4, b = ((cy + y) * W + cx + x) * 4; data[b] = f.data[a]; data[b + 1] = f.data[a + 1]; data[b + 2] = f.data[a + 2]; data[b + 3] = f.data[a + 3]; } } });
    return { width: W, height: fh * rows, data: data, cols: cols, rows: rows, frameWidth: fw, frameHeight: fh };
  }

  // 程式檢查（sheet: true＝精靈圖裡的一格：走路時腳會抬起、不一定貼底，所以不查腳底）：不是空白、有輪廓（內容不貼邊）、顏色數在設定內、腳底貼著畫格底部（anchor bottom）
  function check(sprite, opts) {
    opts = opts || {}; var problems = [], n = opts.palette || 16;
    if (sprite.empty) { problems.push('渲染出來是空白（沒有任何內容）'); return problems; }
    var lim = opts.outline === 'shade' ? n * 2 : n + 1; // the shade outline adds a darker copy of each colour it borders
    if (sprite.palette.length > lim) { problems.push('顏色數 ' + sprite.palette.length + ' 超過 ' + lim + '（含外框）'); }
    var W = sprite.width, H = sprite.height, bb = bboxOf({ width: W, height: H, data: sprite.data }, 255);
    if (!bb || bb.w < 4 || bb.h < 4) { problems.push('內容太小（' + (bb ? bb.w + '×' + bb.h : '無') + '）'); }
    else if (opts.anchor !== 'center' && !opts.sheet && bb.y + bb.h < H - 1) { problems.push('腳底沒有貼著畫格底部'); }
    return problems;
  }

  return { KINDS: KINDS, COLORS: COLORS, defaultFrame: defaultFrame, objectYaml: objectYaml, objectParts: objectParts, matte: matte, pixelate: pixelate, pixelateMany: pixelateMany, packSheet: packSheet, check: check, medianCut: medianCut, bboxOf: bboxOf };
});
