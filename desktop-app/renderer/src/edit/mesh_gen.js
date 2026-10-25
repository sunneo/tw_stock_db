// 程式產生的 3D 模型（三角網格：vertices＋faces，純函式，node 與瀏覽器都能跑）。測試 scripts/edit-tests/mesh_gen.test.js；設計見 DESIGN.edit-3d.md「沒有內建形狀的東西」。
// 為什麼：/edit-3d-model 的基本形狀只有方塊、球、圓柱、圓錐、平面、圓環。使用者要「茶壺」「花瓶」「馬克杯」時不該被拒絕，而是自己產生——場景格式本來就有「自訂形狀」（mesh:'polygon'，extra:{vertices,faces}），跟匯入 OBJ 是同一種東西。
// 做法：兩個通用零件——旋轉體（把一條側面輪廓繞垂直軸轉一圈：杯、碗、瓶、花瓶、酒杯、茶壺的身體與蓋子）與掃掠管（讓一個圓沿一條曲線走：把手、壺嘴）——再組成各種東西。
// 座標：y 向上、底面在 y=0、身體中心軸在 x=0,z=0；單位是公尺，build 時用 height 縮放。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMeshGen = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var PI = Math.PI, TAU = PI * 2;
  function r3(n) { return Math.round(n * 1000) / 1000; }

  // Catmull-Rom 平滑：點串 → 更多點（open 曲線，端點保持）
  function spline(pts, per) {
    per = per || 6; if (pts.length < 3) { return pts.slice(); }
    var out = [], n = pts.length;
    for (var i = 0; i < n - 1; i++) {
      var p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
      for (var k = 0; k < per; k++) {
        var t = k / per, t2 = t * t, t3 = t2 * t, q = [];
        for (var d = 0; d < p1.length; d++) { q.push(0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)); }
        out.push(q);
      }
    }
    out.push(pts[n - 1].slice()); return out;
  }
  function merge(parts) {
    var v = [], f = [], uv = [];
    parts.forEach(function (p) { var base = v.length; p.v.forEach(function (x, i) { v.push(x); uv.push(p.uv ? p.uv[i] : [0, 0]); }); p.f.forEach(function (t) { f.push([t[0] + base, t[1] + base, t[2] + base]); }); });
    return { v: v, f: f, uv: uv };
  }
  // 旋轉體：profile 是 [[半徑, 高度], …]（由下往上）；半徑 0 的端點會收成一個點（封底／封頂）
  function lathe(profile, seg) {
    seg = seg || 36; var v = [], f = [], uv = [], rows = profile.length, cols = seg + 1, arc = [0];
    for (var q = 1; q < rows; q++) { arc.push(arc[q - 1] + Math.sqrt(Math.pow(profile[q][0] - profile[q - 1][0], 2) + Math.pow(profile[q][1] - profile[q - 1][1], 2))); } var total = arc[rows - 1] || 1;
    for (var i = 0; i < rows; i++) { var r = profile[i][0], y = profile[i][1]; for (var j = 0; j < cols; j++) { var a = j / seg * TAU; v.push([r * Math.cos(a), y, r * Math.sin(a)]); uv.push([r3(j / seg), r3(1 - arc[i] / total)]); } }
    for (var i2 = 0; i2 < rows - 1; i2++) {
      for (var j2 = 0; j2 < seg; j2++) {
        var a0 = i2 * cols + j2, a1 = a0 + 1, b0 = (i2 + 1) * cols + j2, b1 = b0 + 1;
        f.push([a0, b0, a1]); f.push([a1, b0, b1]);
      }
    }
    return { v: v, f: f, uv: uv };
  }
  // 掃掠管：圓形截面沿 path（[[x,y,z],…]）走，radii 是每個路徑點的半徑；兩端開口（呼叫端把端點藏進別的零件裡）
  function tube(path, radii, seg) {
    seg = seg || 14; var v = [], f = [], uv = [], n = path.length, prevN = null, cols = seg + 1;
    function norm(a) { var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
    function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
    for (var i = 0; i < n; i++) {
      var a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)], T = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      var N = prevN ? norm(cross(cross(T, prevN), T)) : (Math.abs(T[1]) < 0.9 ? norm(cross(T, [0, 1, 0])) : norm(cross(T, [1, 0, 0]))); prevN = N; var B = cross(T, N);
      for (var j = 0; j < cols; j++) { var ang = j / seg * TAU, c = Math.cos(ang) * radii[i], s = Math.sin(ang) * radii[i]; v.push([path[i][0] + N[0] * c + B[0] * s, path[i][1] + N[1] * c + B[1] * s, path[i][2] + N[2] * c + B[2] * s]); uv.push([r3(i / Math.max(1, n - 1)), r3(j / seg)]); }
    }
    for (var i2 = 0; i2 < n - 1; i2++) { for (var j2 = 0; j2 < seg; j2++) { var a0 = i2 * cols + j2, a1 = a0 + 1, b0 = (i2 + 1) * cols + j2, b1 = b0 + 1; f.push([a0, b0, a1]); f.push([a1, b0, b1]); } }
    return { v: v, f: f, uv: uv };
  }
  function interp(pts, n, rad0, rad1) { var out = [], r = []; for (var i = 0; i < n; i++) { var t = i / (n - 1), k = t * (pts.length - 1), a = Math.floor(k), b = Math.min(pts.length - 1, a + 1), u = k - a; out.push([pts[a][0] + (pts[b][0] - pts[a][0]) * u, pts[a][1] + (pts[b][1] - pts[a][1]) * u, pts[a][2] + (pts[b][2] - pts[a][2]) * u]); r.push(rad0 + (rad1 - rad0) * t); } return { path: out, radii: r }; }
  function smoothPath(pts, per) { return spline(pts, per || 8); }

  // ───── 模型：每個回傳 { v, f }（未縮放，底面在 y=0）─────
  var BUILDERS = {
    teapot: function () {
      var body = lathe(spline([[0, 0], [0.45, 0], [0.62, 0.05], [0.88, 0.28], [1.0, 0.55], [0.95, 0.8], [0.76, 0.97], [0.64, 1.02]], 6), 40);
      var lid = lathe(spline([[0.66, 1.0], [0.62, 1.06], [0.46, 1.15], [0.22, 1.22], [0.06, 1.25]], 6).concat([[0.07, 1.27], [0.1, 1.31], [0.1, 1.36], [0.05, 1.39], [0, 1.4]]), 40);
      var sp = smoothPath([[0.78, 0.22, 0], [1.12, 0.4, 0], [1.42, 0.72, 0], [1.66, 1.1, 0]], 8), spout = tube(sp, sp.map(function (_, i) { return 0.2 - 0.13 * i / (sp.length - 1); }), 16);
      var hp = smoothPath([[-0.82, 0.92, 0], [-1.28, 1.04, 0], [-1.6, 0.7, 0], [-1.3, 0.3, 0], [-0.88, 0.22, 0]], 8), handle = tube(hp, hp.map(function () { return 0.085; }), 12);
      var m = merge([body, lid, spout, handle]); m.v.forEach(function (p) { p[1] *= 1.25; }); return m; // 身體高一點才像茶壺
    },
    vase: function () { return lathe(spline([[0, 0], [0.5, 0], [0.55, 0.05], [0.8, 0.35], [0.9, 0.62], [0.62, 0.95], [0.32, 1.2], [0.3, 1.42], [0.42, 1.62], [0.5, 1.72]], 6).concat([[0.44, 1.72], [0.28, 1.7]]), 40); },
    cup: function () { return cupShape(0.42, 0.62, 0.34, 0.5, false); },
    mug: function () { return cupShape(0.45, 0.95, 0.4, 0.62, true); },
    bowl: function () { var out = spline([[0, 0], [0.35, 0], [0.45, 0.04], [0.95, 0.35], [1.15, 0.6]], 6), inner = spline([[1.08, 0.6], [0.88, 0.36], [0.42, 0.1], [0, 0.08]], 6); return lathe(out.concat([[1.15, 0.62], [1.1, 0.62]]).concat(inner), 44); },
    bottle: function () { return lathe(spline([[0, 0], [0.42, 0], [0.48, 0.05], [0.5, 0.2], [0.5, 0.9], [0.36, 1.2], [0.2, 1.4], [0.18, 1.62], [0.2, 1.7], [0.24, 1.74]], 6).concat([[0.2, 1.74], [0.14, 1.72], [0.13, 1.6]]), 36); },
    wineglass: function () { return lathe(spline([[0, 0], [0.5, 0], [0.5, 0.04], [0.3, 0.08], [0.07, 0.14], [0.05, 0.8], [0.12, 0.92], [0.5, 1.12], [0.62, 1.55], [0.6, 1.95]], 6).concat([[0.57, 1.95], [0.55, 1.55], [0.4, 1.15], [0.1, 0.98]]), 40); },
    pawn: function () { return lathe(spline([[0, 0], [0.5, 0], [0.52, 0.08], [0.4, 0.16], [0.2, 0.3], [0.17, 0.62], [0.3, 0.7], [0.3, 0.76], [0.17, 0.82], [0.26, 1.0], [0.28, 1.15], [0.2, 1.3], [0.08, 1.34], [0, 1.35]], 5), 36); }
  };
  // 杯子／馬克杯：外壁＋杯口＋內壁＋杯底，右邊一個把手
  function cupShape(rTop, h, rBot, hOut, handle) {
    var wall = 0.045, out = spline([[0, 0], [rBot * 0.9, 0], [rBot, 0.03], [rTop, h]], 6), inn = spline([[rTop - wall, h], [rBot - wall, 0.09], [0, 0.07]], 4);
    var body = lathe(out.concat([[rTop, h + 0.012], [rTop - wall, h + 0.012]]).concat(inn), 40), parts = [body];
    var hp = smoothPath([[rTop - 0.01, h * 0.82, 0], [rTop + 0.34, h * 0.78, 0], [rTop + 0.4, h * 0.45, 0], [rBot + 0.2, h * 0.2, 0]], 8); parts.push(tube(hp, hp.map(function () { return handle ? 0.06 : 0.045; }), 12));
    return merge(parts);
  }
  var CATALOG = [
    { id: 'teapot', label: '茶壺', words: ['茶壺', '茶壼', 'teapot', '壺'], height: 0.6, color: '#d9c7a6', roughness: 0.35, metalness: 0.1 },
    { id: 'vase', label: '花瓶', words: ['花瓶', 'vase', '瓶花'], height: 0.7, color: '#4f8ef7', roughness: 0.3, metalness: 0.1 },
    { id: 'mug', label: '馬克杯', words: ['馬克杯', 'mug', '咖啡杯'], height: 0.2, color: '#f5f5f5', roughness: 0.4, metalness: 0.05 },
    { id: 'cup', label: '杯子', words: ['杯子', '茶杯', 'cup', '杯'], height: 0.14, color: '#f5f5f5', roughness: 0.4, metalness: 0.05 },
    { id: 'bowl', label: '碗', words: ['碗', 'bowl', '盆'], height: 0.2, color: '#e8e0d0', roughness: 0.4, metalness: 0.05 },
    { id: 'bottle', label: '瓶子', words: ['瓶子', '酒瓶', '玻璃瓶', 'bottle', '瓶'], height: 0.3, color: '#3f8f5a', roughness: 0.2, metalness: 0.1 },
    { id: 'wineglass', label: '酒杯', words: ['酒杯', '高腳杯', '紅酒杯', 'wine glass', 'wineglass', 'goblet'], height: 0.2, color: '#dbe9f4', roughness: 0.1, metalness: 0.0 },
    { id: 'pawn', label: '棋子', words: ['棋子', '兵', '西洋棋', 'chess pawn', 'pawn', 'chess'], height: 0.12, color: '#222222', roughness: 0.4, metalness: 0.2 }
  ];
  // 更長的詞先比，所以「馬克杯」不會被「杯」搶走、「酒杯」不會被「杯子」搶走
  var WORDS = []; CATALOG.forEach(function (c) { c.words.forEach(function (w) { WORDS.push({ w: w.toLowerCase(), id: c.id }); }); }); WORDS.sort(function (a, b) { return b.w.length - a.w.length; });
  function find(text) { var t = String(text || '').toLowerCase(); for (var i = 0; i < WORDS.length; i++) { if (t.indexOf(WORDS[i].w) >= 0) { return CATALOG.filter(function (c) { return c.id === WORDS[i].id; })[0]; } } return null; }
  function info(id) { return CATALOG.filter(function (c) { return c.id === id; })[0] || null; }

  // 產生一個模型：回傳 { id, label, vertices, faces, height, size:[寬,高,深], color, roughness, metalness }；opt.height 是要的高度（公尺）
  function build(id, opt) {
    opt = opt || {}; var c = info(id), fn = BUILDERS[id]; if (!c || !fn) { return null; }
    var m = fn(), minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    m.v.forEach(function (p) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]); });
    var want = Number(opt.height) > 0 ? Number(opt.height) : c.height, k = want / (maxY - minY);
    var vertices = m.v.map(function (p) { return [r3(p[0] * k), r3((p[1] - minY) * k), r3(p[2] * k)]; });
    return { id: c.id, label: c.label, vertices: vertices, faces: m.f, uvs: m.uv, height: r3(want), size: [r3((maxX - minX) * k), r3(want), r3((maxZ - minZ) * k)], color: c.color, roughness: c.roughness, metalness: c.metalness };
  }
  return { build: build, find: find, info: info, CATALOG: CATALOG, lathe: lathe, tube: tube, spline: spline, merge: merge };
});
