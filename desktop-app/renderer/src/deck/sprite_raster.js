/* 小型軟體光柵（純函式，UMD，不碰 DOM／THREE）：把 char_model.js 的零件（盒子、球、圓柱、圓錐）畫成帶透明度的 RGBA 影像。
 *
 *   render(parts, camera, opts) → { width, height, data: Uint8ClampedArray }
 *     parts   [{shape: box|sphere|cylinder|cone, pos, rot (YXZ 順序), size | r | r+h, color}]
 *     camera  { fov (度，垂直), position, lookAt }
 *     opts    { width, height, light: [x,y,z]（光來的方向）, ambient: 0..1, rimLight?: 預設無 }
 *
 * 為什麼不用既有的 CPU 後備（_raster3DFrame）：它沒有 z-buffer，是「依三角形平均深度排序」的畫家演算法——盒子、球交疊（頭髮球蓋在頭上）時會出現雜訊；
 * 這裡每個像素都有深度緩衝，交疊正確；而且直接輸出透明度（背景是 alpha 0），不用雙背景去背；不需要 WebGL／three.js，所以沒有網路相依。
 * 明暗：每個像素依插值後的法向量算 Lambert（ambient + (1 - ambient) × max(0, n·L)），球與圓柱是平滑的、盒子是平的。
 * 結果是確定性的（同樣的輸入同樣的影像）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatDeckSpriteRaster = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function norm(v) { var l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function rgb(h) { var n = parseInt(String(h).replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

  // ---- 零件 → 三角形網格（區域座標；每個頂點有自己的法向量）----
  function meshOf(p) {
    var V = [], N = [], T = [];
    var quad = function (a, b, c, d, n) { var i = V.length; V.push(a, b, c, d); N.push(n, n, n, n); T.push([i, i + 1, i + 2], [i, i + 2, i + 3]); };
    if (p.shape === 'box') {
      var x = p.size[0] / 2, y = p.size[1] / 2, z = p.size[2] / 2;
      quad([-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], [0, 0, 1]); quad([x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z], [0, 0, -1]);
      quad([x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z], [1, 0, 0]); quad([-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z], [-1, 0, 0]);
      quad([-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z], [0, 1, 0]); quad([-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [0, -1, 0]);
    } else if (p.shape === 'sphere') {
      var seg = 14, rings = 10;
      for (var i = 0; i <= rings; i++) { var th = Math.PI * i / rings; for (var j = 0; j <= seg; j++) { var ph = 2 * Math.PI * j / seg, nx = Math.sin(th) * Math.sin(ph), ny = Math.cos(th), nz = Math.sin(th) * Math.cos(ph); V.push([nx * p.r, ny * p.r, nz * p.r]); N.push([nx, ny, nz]); } }
      for (var a = 0; a < rings; a++) { for (var b = 0; b < seg; b++) { var i0 = a * (seg + 1) + b, i1 = i0 + 1, i2 = i0 + seg + 1, i3 = i2 + 1; T.push([i0, i2, i1], [i1, i2, i3]); } }
    } else if (p.shape === 'cylinder' || p.shape === 'cone') {
      var sg = p.shape === 'cone' ? 12 : 14, h = p.h / 2, r0 = p.shape === 'cone' ? 0 : p.r, slope = p.shape === 'cone' ? p.r / p.h : 0;
      for (var k = 0; k <= sg; k++) { var an = 2 * Math.PI * k / sg, cx = Math.sin(an), cz = Math.cos(an), nn = norm([cx, slope, cz]); V.push([cx * r0, h, cz * r0], [cx * p.r, -h, cz * p.r]); N.push(nn, nn); }
      for (var m = 0; m < sg; m++) { var q = m * 2; T.push([q, q + 1, q + 2], [q + 2, q + 1, q + 3]); }
      var cap = V.length; V.push([0, -h, 0]); N.push([0, -1, 0]); for (var c2 = 0; c2 <= sg; c2++) { var a2 = 2 * Math.PI * c2 / sg; V.push([Math.sin(a2) * p.r, -h, Math.cos(a2) * p.r]); N.push([0, -1, 0]); } for (var e = 0; e < sg; e++) { T.push([cap, cap + 1 + e, cap + 2 + e]); }
      if (p.shape === 'cylinder') { var top = V.length; V.push([0, h, 0]); N.push([0, 1, 0]); for (var c3 = 0; c3 <= sg; c3++) { var a3 = 2 * Math.PI * c3 / sg; V.push([Math.sin(a3) * p.r, h, Math.cos(a3) * p.r]); N.push([0, 1, 0]); } for (var f = 0; f < sg; f++) { T.push([top, top + 2 + f, top + 1 + f]); } }
    } else { return null; }
    return { V: V, N: N, T: T };
  }
  // 旋轉順序 YXZ：R = Ry · Rx · Rz（先 Z、再 X、最後 Y）
  function rotator(rot) {
    var cx = Math.cos(rot[0]), sx = Math.sin(rot[0]), cy = Math.cos(rot[1]), sy = Math.sin(rot[1]), cz = Math.cos(rot[2]), sz = Math.sin(rot[2]);
    return function (v) {
      var x = v[0] * cz - v[1] * sz, y = v[0] * sz + v[1] * cz, z = v[2];                 // Rz
      var y2 = y * cx - z * sx, z2 = y * sx + z * cx;                                      // Rx
      return [x * cy + z2 * sy, y2, -x * sy + z2 * cy];                                    // Ry
    };
  }

  function render(parts, camera, opts) {
    opts = opts || {}; var W = opts.width | 0, H = opts.height | 0, light = norm(opts.light || [0.25, 0.7, 1]), amb = opts.ambient == null ? 0.45 : opts.ambient;
    var data = new Uint8ClampedArray(W * H * 4), zbuf = new Float32Array(W * H); // zbuf = 1/depth（越大越近）
    var P = camera.position, f = norm([camera.lookAt[0] - P[0], camera.lookAt[1] - P[1], camera.lookAt[2] - P[2]]), r = norm(cross(f, [0, 1, 0])), u = cross(r, f), th = Math.tan(camera.fov * Math.PI / 360), asp = W / H;
    var proj = function (w) { var d = [w[0] - P[0], w[1] - P[1], w[2] - P[2]], dz = dot(d, f); return { x: W / 2 + dot(d, r) / (dz * th * asp) * (W / 2), y: H / 2 - dot(d, u) / (dz * th) * (H / 2), iz: 1 / dz, ok: dz > 0.05 }; };
    parts.forEach(function (p) {
      var m = meshOf(p); if (!m) { return; } var R = rotator(p.rot || [0, 0, 0]), col = rgb(p.color), vs = m.V.map(function (v) { var q = R(v); var w = [q[0] + p.pos[0], q[1] + p.pos[1], q[2] + p.pos[2]]; var pr = proj(w); pr.w = w; return pr; }), ns = m.N.map(function (n) { return R(n); });
      m.T.forEach(function (t) {
        var a = vs[t[0]], b = vs[t[1]], c = vs[t[2]]; if (!a.ok || !b.ok || !c.ok) { return; }
        var area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y); if (Math.abs(area) < 1e-9) { return; }
        var x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x))), y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
        var na = ns[t[0]], nb = ns[t[1]], nc = ns[t[2]];
        for (var y = y0; y <= y1; y++) {
          for (var x = x0; x <= x1; x++) {
            var px = x + 0.5, py = y + 0.5, w0 = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) / area, w1 = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) / area, w2 = 1 - w0 - w1;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) { continue; }
            var iz = w0 * a.iz + w1 * b.iz + w2 * c.iz, zi = y * W + x; if (iz <= zbuf[zi]) { continue; } zbuf[zi] = iz;
            var n = norm([w0 * na[0] + w1 * nb[0] + w2 * nc[0], w0 * na[1] + w1 * nb[1] + w2 * nc[1], w0 * na[2] + w1 * nb[2] + w2 * nc[2]]), br = amb + (1 - amb) * Math.max(0, dot(n, light)), o = zi * 4;
            data[o] = col[0] * br; data[o + 1] = col[1] * br; data[o + 2] = col[2] * br; data[o + 3] = 255;
          }
        }
      });
    });
    return { width: W, height: H, data: data };
  }

  return { render: render, meshOf: meshOf };
});
