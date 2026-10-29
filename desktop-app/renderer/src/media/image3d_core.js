// image-to-3d core (pure functions, no DOM, no network): object mask + relative depth map -> a CLOSED solid per object (never a relief).
// Exposes `FaImage3d` (browser) and module.exports (node tests).
//   buildObject(mask, depth, opts) -> { mesh:{vertices,faces}, shape, fallback, notes:[...] } | null
//   buildScene({labels, depth}, opts) -> { objects:[{id, mesh, shape, fallback, notes}], background:{...}, closeMode }
//   fillBackground(depth, unknown) -> depth with the unknown cells interpolated from their surroundings
//   isClosed(mesh) -> boolean   (every edge shared by exactly two faces, opposite directions, no degenerate face, positive volume)
// Inputs are arrays of rows, row 0 = top of the image. Depth: larger = nearer (Depth Anything convention). Output: x right, y up, z toward the viewer.
// Two coarse shells, each refined level by level (every level is closed, so refinement can stop any time):
//   cylinder = the mask outline extruded along the depth axis, the front cap follows the depth, the back is flat (guessed from the outline width)
//   blocks   = Lego-like: only the grid cells the object covers, each cell a column; the grid halves each level
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaImage3d = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;

  // ---------- mesh helpers ----------
  function Builder() { this.v = []; this.f = []; this.map = {}; }
  Builder.prototype.vert = function (x, y, z) {
    var key = Math.round(x * 1e6) + ',' + Math.round(y * 1e6) + ',' + Math.round(z * 1e6);
    var i = this.map[key];
    if (i === undefined) { i = this.v.length; this.v.push([x, y, z]); this.map[key] = i; }
    return i;
  };
  Builder.prototype.tri = function (a, b, c) { this.f.push([a, b, c]); };
  Builder.prototype.quad = function (a, b, c, d) { this.f.push([a, b, c]); this.f.push([a, c, d]); };
  Builder.prototype.mesh = function () { return { vertices: this.v, faces: this.f }; };

  function isClosed(mesh) {
    if (!mesh || !mesh.faces || !mesh.vertices || mesh.faces.length < 4) { return false; }
    var V = mesh.vertices, dir = {}, vol = 0, i, k;
    for (i = 0; i < mesh.faces.length; i++) {
      var f = mesh.faces[i], a = f[0], b = f[1], c = f[2];
      if (a === b || b === c || a === c) { return false; }
      var pa = V[a], pb = V[b], pc = V[c];
      if (!pa || !pb || !pc) { return false; }
      var ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2], vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * nx + ny * ny + nz * nz < 1e-18) { return false; }
      vol += (pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) - pa[1] * (pb[0] * pc[2] - pb[2] * pc[0]) + pa[2] * (pb[0] * pc[1] - pb[1] * pc[0])) / 6;
      var es = [[a, b], [b, c], [c, a]];
      for (k = 0; k < 3; k++) { var key = es[k][0] + '>' + es[k][1]; if (dir[key]) { return false; } dir[key] = 1; }
    }
    for (var e in dir) { var p = e.split('>'); if (!dir[p[1] + '>' + p[0]]) { return false; } }
    return vol > EPS;
  }

  function boxMesh(x0, y0, x1, y1, z0, z1) {
    var b = new Builder();
    var p = function (x, y, z) { return b.vert(x, y, z); };
    var a = p(x0, y0, z0), bb = p(x1, y0, z0), c = p(x1, y1, z0), d = p(x0, y1, z0), e = p(x0, y0, z1), f = p(x1, y0, z1), g = p(x1, y1, z1), h = p(x0, y1, z1);
    b.quad(a, d, c, bb); b.quad(e, f, g, h); b.quad(a, bb, f, e); b.quad(bb, c, g, f); b.quad(c, d, h, g); b.quad(d, a, e, h);
    return b.mesh();
  }

  // ---------- grids ----------
  function dims(a) { return { h: a.length, w: a.length ? a[0].length : 0 }; }
  function flipY(a) { return a.slice().reverse(); }

  // onion-peeling fill: unknown cells take the average of their known 4-neighbours, ring by ring (the background behind a cut-out object)
  function fillBackground(depth, unknown) {
    var d = dims(depth), H = d.h, W = d.w, out = [], known = [], j, i;
    for (j = 0; j < H; j++) { out.push(depth[j].slice()); known.push([]); for (i = 0; i < W; i++) { known[j].push(!unknown[j][i]); } }
    var any = false; for (j = 0; j < H && !any; j++) { for (i = 0; i < W; i++) { if (known[j][i]) { any = true; break; } } }
    if (!any) { for (j = 0; j < H; j++) { for (i = 0; i < W; i++) { out[j][i] = 0; } } return out; }
    var left = true, guard = H + W + 4;
    while (left && guard-- > 0) {
      left = false; var upd = [];
      for (j = 0; j < H; j++) {
        for (i = 0; i < W; i++) {
          if (known[j][i]) { continue; }
          var s = 0, n = 0;
          if (j > 0 && known[j - 1][i]) { s += out[j - 1][i]; n++; }
          if (j < H - 1 && known[j + 1][i]) { s += out[j + 1][i]; n++; }
          if (i > 0 && known[j][i - 1]) { s += out[j][i - 1]; n++; }
          if (i < W - 1 && known[j][i + 1]) { s += out[j][i + 1]; n++; }
          if (n) { upd.push([j, i, s / n]); } else { left = true; }
        }
      }
      for (var u = 0; u < upd.length; u++) { out[upd[u][0]][upd[u][1]] = upd[u][2]; known[upd[u][0]][upd[u][1]] = true; }
    }
    return out;
  }

  // ---------- blocks (Lego) shell ----------
  // m, dn are y-up grids. Returns a closed mesh or null.
  function blocksMesh(m, dn, bb, n, zp) {
    var bw = bb.x1 - bb.x0, bh = bb.y1 - bb.y0, s = Math.max(bw, bh) / n;
    var cols = Math.max(1, Math.ceil(bw / s - 1e-9)), rows = Math.max(1, Math.ceil(bh / s - 1e-9)), i, j, x, y;
    var occ = [], hgt = [], best = null, bestCnt = -1;
    for (j = 0; j < rows; j++) {
      occ.push([]); hgt.push([]);
      for (i = 0; i < cols; i++) {
        var px0 = Math.floor(bb.x0 + i * s + 1e-9), px1 = Math.max(px0 + 1, Math.min(bb.x1, Math.ceil(bb.x0 + (i + 1) * s - 1e-9)));
        var py0 = Math.floor(bb.y0 + j * s + 1e-9), py1 = Math.max(py0 + 1, Math.min(bb.y1, Math.ceil(bb.y0 + (j + 1) * s - 1e-9)));
        var cnt = 0, tot = 0, sum = 0;
        for (y = py0; y < py1 && y < bb.y1; y++) { for (x = px0; x < px1 && x < bb.x1; x++) { tot++; if (m[y][x]) { cnt++; sum += dn[y][x]; } } }
        var o = tot > 0 && cnt > 0 && cnt / tot >= 0.5;
        occ[j].push(o); hgt[j].push(cnt ? sum / cnt : 0);
        if (cnt > bestCnt) { bestCnt = cnt; best = [j, i]; }
      }
    }
    var any = false; for (j = 0; j < rows; j++) { for (i = 0; i < cols; i++) { if (occ[j][i]) { any = true; } } }
    if (!any) { if (!best) { return null; } occ[best[0]][best[1]] = true; }
    // two columns touching only along a corner (at any height) would make an edge shared by four faces: raise the higher of the other two cells up to the lower of the pair
    var lvl = function (jj, ii) { return jj >= 0 && jj < rows && ii >= 0 && ii < cols && occ[jj][ii] ? hgt[jj][ii] : -Infinity; };
    var changed = true, pass = 0;
    while (changed && pass++ < 64) {
      changed = false;
      for (j = 0; j < rows - 1; j++) {
        for (i = 0; i < cols - 1; i++) {
          var q = [[j, i], [j, i + 1], [j + 1, i + 1], [j + 1, i]];
          for (var r = 0; r < 2; r++) {
            var A = q[r], C = q[r + 2], B = q[(r + 1) % 4], D = q[(r + 3) % 4];
            var lo = Math.min(lvl(A[0], A[1]), lvl(C[0], C[1])), hb = lvl(B[0], B[1]), hd = lvl(D[0], D[1]);
            if (lo > Math.max(hb, hd)) {
              var T = hb >= hd ? B : D;
              if (T[0] >= 0 && T[0] < rows && T[1] >= 0 && T[1] < cols) { occ[T[0]][T[1]] = true; hgt[T[0]][T[1]] = lo; changed = true; }
            }
          }
        }
      }
    }
    var H = [];
    for (j = 0; j < rows; j++) { H.push([]); for (i = 0; i < cols; i++) { H[j].push(occ[j][i] ? Math.round((zp.zMin + zp.zRange * hgt[j][i]) * 1e6) / 1e6 : null); } }
    var zb = Math.round(zp.zBack * 1e6) / 1e6, B = new Builder();
    var X = function (gi) { return bb.x0 + gi * s; }, Y = function (gj) { return bb.y0 + gj * s; };
    var has = function (jj, ii) { return jj >= 0 && jj < rows && ii >= 0 && ii < cols && H[jj][ii] !== null; };
    // heights seen at each grid corner: a vertical wall edge there is split at all of them, so neighbouring walls of different heights meet edge to edge
    var corner = {};
    var addC = function (gi, gj, z) { var k = gi + ',' + gj; (corner[k] = corner[k] || {})[z] = 1; };
    for (j = 0; j < rows; j++) { for (i = 0; i < cols; i++) { if (H[j][i] !== null) { for (var dj = 0; dj < 2; dj++) { for (var di = 0; di < 2; di++) { addC(i + di, j + dj, H[j][i]); } } } } }
    var edgeZ = function (gi, gj, lo, hi) {
      var zs = [lo], c = corner[gi + ',' + gj] || {}, arr = [];
      for (var z in c) { var zv = +z; if (zv > lo + 1e-9 && zv < hi - 1e-9) { arr.push(zv); } }
      arr.sort(function (a, b) { return a - b; }); zs = zs.concat(arr); zs.push(hi); return zs;
    };
    var wall = function (g0, g1, g2, g3, lo, hi) {
      var pz = edgeZ(g0, g1, lo, hi), qz = edgeZ(g2, g3, lo, hi), pi = 0, qi = 0;
      var P = function (n) { return B.vert(X(g0), Y(g1), pz[n]); }, Q = function (n) { return B.vert(X(g2), Y(g3), qz[n]); };
      while (pi < pz.length - 1 || qi < qz.length - 1) {
        var advQ = pi >= pz.length - 1 ? true : (qi >= qz.length - 1 ? false : qz[qi + 1] <= pz[pi + 1]);
        if (advQ) { B.tri(P(pi), Q(qi), Q(qi + 1)); qi++; } else { B.tri(P(pi), Q(qi), P(pi + 1)); pi++; }
      }
    };
    for (j = 0; j < rows; j++) {
      for (i = 0; i < cols; i++) {
        var h = H[j][i]; if (h === null) { continue; }
        var v = function (gi, gj, z) { return B.vert(X(gi), Y(gj), z); };
        B.quad(v(i, j, h), v(i + 1, j, h), v(i + 1, j + 1, h), v(i, j + 1, h));
        B.quad(v(i, j, zb), v(i, j + 1, zb), v(i + 1, j + 1, zb), v(i + 1, j, zb));
        // edges counter-clockwise around the cell (interior on the left): P -> Q, neighbour on the outside
        var sides = [[i, j, i + 1, j, j - 1, i], [i + 1, j, i + 1, j + 1, j, i + 1], [i + 1, j + 1, i, j + 1, j + 1, i], [i, j + 1, i, j, j, i - 1]];
        for (var k = 0; k < 4; k++) {
          var sd = sides[k], lo = has(sd[4], sd[5]) ? H[sd[4]][sd[5]] : zb;
          if (h - lo > 1e-9) { wall(sd[0], sd[1], sd[2], sd[3], lo, h); }
        }
      }
    }
    return B.mesh();
  }

  // ---------- cylinder (outline extrusion) shell ----------
  function traceLoops(m, bb) {
    var edges = [], byStart = {}, i, j;
    var occ = function (x, y) { return x >= bb.x0 && x < bb.x1 && y >= bb.y0 && y < bb.y1 && !!m[y][x]; };
    var add = function (ax, ay, bx, by) { edges.push([ax, ay, bx, by]); var k = ax + ',' + ay; (byStart[k] = byStart[k] || []).push(edges.length - 1); };
    for (j = bb.y0; j < bb.y1; j++) {
      for (i = bb.x0; i < bb.x1; i++) {
        if (!m[j][i]) { continue; }
        if (!occ(i, j - 1)) { add(i, j, i + 1, j); }
        if (!occ(i + 1, j)) { add(i + 1, j, i + 1, j + 1); }
        if (!occ(i, j + 1)) { add(i + 1, j + 1, i, j + 1); }
        if (!occ(i - 1, j)) { add(i, j + 1, i, j); }
      }
    }
    var used = [], loops = [];
    for (var e0 = 0; e0 < edges.length; e0++) {
      if (used[e0]) { continue; }
      var loop = [], cur = e0, guard = edges.length + 2;
      while (cur !== undefined && !used[cur] && guard-- > 0) {
        used[cur] = true; var ed = edges[cur]; loop.push([ed[0], ed[1]]);
        var cands = (byStart[ed[2] + ',' + ed[3]] || []).filter(function (c) { return !used[c]; });
        if (!cands.length) { cur = undefined; break; }
        var dx = ed[2] - ed[0], dy = ed[3] - ed[1], pick = cands[0], bestCross = Infinity;
        for (var c = 0; c < cands.length; c++) {
          var ce = edges[cands[c]], cr = dx * (ce[3] - ce[1]) - dy * (ce[2] - ce[0]);
          if (cr < bestCross) { bestCross = cr; pick = cands[c]; }
        }
        cur = pick;
      }
      if (loop.length >= 4) { loops.push(loop); }
    }
    return loops;
  }
  function area2(p) { var a = 0; for (var i = 0; i < p.length; i++) { var q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a; }
  function dropCollinear(p) {
    var out = p.slice(), ch = true;
    while (ch && out.length > 3) {
      ch = false;
      for (var i = 0; i < out.length; i++) {
        var a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
        if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < EPS) { out.splice(i, 1); ch = true; break; }
      }
    }
    return out;
  }
  function distSeg(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    if (l < EPS) { return Math.hypot(p[0] - a[0], p[1] - a[1]); }
    var t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  function dpChain(pts, tol) {
    var keep = []; keep[0] = true; keep[pts.length - 1] = true;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var r = stack.pop(), a = r[0], b = r[1], md = 0, mi = -1;
      for (var i = a + 1; i < b; i++) { var d = distSeg(pts[i], pts[a], pts[b]); if (d > md) { md = d; mi = i; } }
      if (mi >= 0 && md > tol) { keep[mi] = true; stack.push([a, mi]); stack.push([mi, b]); }
    }
    var out = []; for (var k = 0; k < pts.length; k++) { if (keep[k]) { out.push(pts[k]); } }
    return out;
  }
  function simplifyClosed(p, tol) {
    if (p.length <= 4) { return p; }
    var far = 0, fd = -1, i;
    for (i = 1; i < p.length; i++) { var d = Math.hypot(p[i][0] - p[0][0], p[i][1] - p[0][1]); if (d > fd) { fd = d; far = i; } }
    var c1 = dpChain(p.slice(0, far + 1), tol), c2 = dpChain(p.slice(far).concat([p[0]]), tol);
    return c1.slice(0, -1).concat(c2.slice(0, -1));
  }
  function segCross(a, b, c, d) {
    var o = function (p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); };
    var o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    return ((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) && ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS));
  }
  function isSimple(p) {
    var n = p.length;
    for (var i = 0; i < n; i++) {
      for (var j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) { continue; }
        if (segCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) { return false; }
      }
    }
    return true;
  }
  function earClip(p) {
    var idx = [], i; for (i = 0; i < p.length; i++) { idx.push(i); }
    var tris = [], guard = p.length * p.length + 10;
    var cross = function (a, b, c) { return (p[b][0] - p[a][0]) * (p[c][1] - p[a][1]) - (p[b][1] - p[a][1]) * (p[c][0] - p[a][0]); };
    while (idx.length > 3 && guard-- > 0) {
      var found = false, m = idx.length;
      for (var k = 0; k < m; k++) {
        var a = idx[(k - 1 + m) % m], b = idx[k], c = idx[(k + 1) % m];
        if (cross(a, b, c) <= EPS) { continue; }
        var ok = true;
        for (var t = 0; t < m && ok; t++) {
          var q = idx[t]; if (q === a || q === b || q === c) { continue; }
          var pq = p[q];
          if ((pq[0] === p[a][0] && pq[1] === p[a][1]) || (pq[0] === p[b][0] && pq[1] === p[b][1]) || (pq[0] === p[c][0] && pq[1] === p[c][1])) { continue; }
          if (cross(a, b, q) >= -EPS && cross(b, c, q) >= -EPS && cross(c, a, q) >= -EPS) { ok = false; }
        }
        if (ok) { tris.push([a, b, c]); idx.splice(k, 1); found = true; break; }
      }
      if (!found) { return null; }
    }
    if (idx.length === 3) { if (cross(idx[0], idx[1], idx[2]) <= EPS) { return null; } tris.push([idx[0], idx[1], idx[2]]); }
    return tris;
  }
  function subdivide(P, T) {
    var cache = {}, out = [];
    var mid = function (a, b) {
      var key = a < b ? a + '_' + b : b + '_' + a;
      if (cache[key] === undefined) { cache[key] = P.length; P.push([(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2]); }
      return cache[key];
    };
    T.forEach(function (t) { var ab = mid(t[0], t[1]), bc = mid(t[1], t[2]), ca = mid(t[2], t[0]); out.push([t[0], ab, ca], [ab, t[1], bc], [ca, bc, t[2]], [ab, bc, ca]); });
    return out;
  }
  // m, dn: y-up grids; dnExt: dn extended outside the mask. Returns a closed mesh (several prisms if the mask has several blobs) or null.
  function cylinderMesh(m, dn, dnExt, bb, tolFrac, sub, zp, W, H) {
    var loops = traceLoops(m, bb).filter(function (l) { return area2(l) > 0; });
    if (!loops.length) { return null; }
    var maxdim = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0), tol = Math.max(0.5, maxdim * tolFrac);
    var B = new Builder();
    var sample = function (x, y) {
      var s = 0, n = 0, xs = [Math.floor(x) - 1, Math.floor(x)], ys = [Math.floor(y) - 1, Math.floor(y)];
      for (var a = 0; a < 2; a++) { for (var b = 0; b < 2; b++) { var px = xs[a], py = ys[b]; if (px >= 0 && px < W && py >= 0 && py < H && m[py][px]) { s += dn[py][px]; n++; } } }
      if (n) { return s / n; }
      return dnExt[Math.max(0, Math.min(H - 1, Math.floor(y)))][Math.max(0, Math.min(W - 1, Math.floor(x)))];
    };
    var zb = Math.round(zp.zBack * 1e6) / 1e6;
    for (var li = 0; li < loops.length; li++) {
      var poly = dropCollinear(simplifyClosed(dropCollinear(loops[li]), tol));
      if (poly.length < 3 || area2(poly) <= EPS || !isSimple(poly)) { return null; }
      var P = poly.map(function (q) { return [q[0], q[1]]; }), T = earClip(P);
      if (!T) { return null; }
      for (var s = 0; s < sub; s++) { T = subdivide(P, T); }
      var fr = P.map(function (q) { return B.vert(q[0], q[1], Math.round((zp.zMin + zp.zRange * sample(q[0], q[1])) * 1e6) / 1e6); });
      var bk = P.map(function (q) { return B.vert(q[0], q[1], zb); });
      var cnt = {};
      T.forEach(function (t) { B.tri(fr[t[0]], fr[t[1]], fr[t[2]]); B.tri(bk[t[0]], bk[t[2]], bk[t[1]]); for (var e = 0; e < 3; e++) { cnt[t[e] + '>' + t[(e + 1) % 3]] = 1; } });
      for (var key in cnt) {
        var ab = key.split('>'), a = +ab[0], b = +ab[1];
        if (!cnt[b + '>' + a]) { B.quad(bk[a], bk[b], fr[b], fr[a]); }
      }
    }
    return B.mesh();
  }

  // ---------- one object ----------
  var CYL_LEVELS = [[0.05, 0], [0.025, 1], [0.012, 1], [0.012, 2], [0.006, 2]];
  var BLOCK_LEVELS = [2, 4, 8, 16, 32, 64];

  function buildObject(mask, depth, opts) {
    opts = opts || {};
    var d = dims(mask), H = d.h, W = d.w;
    if (!H || !W || depth.length !== H || depth[0].length !== W) { return null; }
    var m = flipY(mask), dep = flipY(depth), x, y;
    var bb = { x0: W, y0: H, x1: 0, y1: 0 }, dmin = Infinity, dmax = -Infinity, area = 0, comps = 0;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        if (!m[y][x]) { continue; }
        area++; if (x < bb.x0) { bb.x0 = x; } if (x + 1 > bb.x1) { bb.x1 = x + 1; } if (y < bb.y0) { bb.y0 = y; } if (y + 1 > bb.y1) { bb.y1 = y + 1; }
        var dv = opts.invert ? -dep[y][x] : dep[y][x]; if (dv < dmin) { dmin = dv; } if (dv > dmax) { dmax = dv; }
      }
    }
    if (!area) { return null; }
    var range = dmax - dmin, dn = [];
    for (y = 0; y < H; y++) {
      dn.push([]);
      for (x = 0; x < W; x++) {
        var raw = opts.invert ? -dep[y][x] : dep[y][x];
        dn[y].push(opts.normalize === false ? raw : (range > EPS ? (raw - dmin) / range : 0.5));
      }
    }
    var bw = bb.x1 - bb.x0, bh = bb.y1 - bb.y0, scale = opts.scale || 1, maxFaces = opts.maxFaces || 12000, notes = [];
    var thick = opts.thickness > 0 ? opts.thickness : Math.max(1, 0.5 * Math.min(bw, bh));
    var zp;
    if (opts.zFront) {
      var mn = Infinity; for (y = 0; y < H; y++) { for (x = 0; x < W; x++) { if (m[y][x] && dn[y][x] < mn) { mn = dn[y][x]; } } }
      zp = { zMin: opts.zFront.base, zRange: opts.zFront.range, zBack: opts.zFront.base + opts.zFront.range * mn - thick };
    } else {
      zp = { zBack: 0, zMin: 0.4 * thick, zRange: 0.6 * thick };
    }
    notes.push('背面是依輪廓寬度推測的（厚度約 ' + (Math.round(thick * 10) / 10) + '），單張圖看不到背面');
    var unknown = m.map(function (r) { return r.map(function (v) { return !v; }); });
    var dnExt = fillBackground(dn, unknown);
    // components / holes decide "auto": a single solid blob -> cylinder, fragmented or holed -> blocks
    var loops = traceLoops(m, bb), outers = loops.filter(function (l) { return area2(l) > 0; }).length;
    comps = outers; var holes = loops.length - outers;
    var shape = opts.shape === 'cylinder' || opts.shape === 'blocks' ? opts.shape : (comps === 1 && holes === 0 ? 'cylinder' : 'blocks');
    var order = shape === 'cylinder' ? ['cylinder', 'blocks'] : ['blocks', 'cylinder'];

    var result = null;
    for (var oi = 0; oi < order.length && !result; oi++) {
      var kind = order[oi], best = null, level;
      if (kind === 'cylinder') {
        for (level = 0; level < CYL_LEVELS.length; level++) {
          var cm = null; try { cm = cylinderMesh(m, dn, dnExt, bb, CYL_LEVELS[level][0], CYL_LEVELS[level][1], zp, W, H); } catch (e) { cm = null; }
          if (!cm || cm.faces.length > maxFaces || !isClosed(cm)) { if (best) { break; } else { continue; } }
          best = { mesh: cm, level: level };
        }
      } else {
        for (level = 0; level < BLOCK_LEVELS.length; level++) {
          var bm = null; try { bm = blocksMesh(m, dn, bb, BLOCK_LEVELS[level], zp); } catch (e2) { bm = null; }
          if (!bm || bm.faces.length > maxFaces || !isClosed(bm)) { if (best) { break; } else { continue; } }
          best = { mesh: bm, level: level };
        }
      }
      if (best) { result = { mesh: best.mesh, shape: kind, level: best.level, fallback: oi > 0 }; }
    }
    if (!result) {
      result = { mesh: boxMesh(bb.x0, bb.y0, bb.x1, bb.y1, zp.zBack, zp.zMin + zp.zRange * (opts.normalize === false ? 1 : 1)), shape: 'box', level: 0, fallback: true };
      notes.push('輪廓太複雜，退回外框方塊');
    } else if (result.fallback) { notes.push('原本選的外殼不合格，改用 ' + result.shape); }
    if (scale !== 1) { result.mesh.vertices = result.mesh.vertices.map(function (p) { return [p[0] * scale, p[1] * scale, p[2] * scale]; }); }
    result.notes = notes; result.area = area;
    return result;
  }

  // ---------- scene: labels (0 = background) + depth -> one closed solid per object + a background slab ----------
  function buildScene(input, opts) {
    opts = opts || {};
    var labels = input.labels, depth = input.depth, d = dims(labels), H = d.h, W = d.w, x, y;
    var maxdim = Math.max(W, H), R = 0.4 * maxdim, total = opts.maxFaces || 12000, scale = 1 / maxdim;
    var mn = Infinity, mx = -Infinity, ids = {}, areas = {};
    for (y = 0; y < H; y++) { for (x = 0; x < W; x++) { var v = depth[y][x]; if (v < mn) { mn = v; } if (v > mx) { mx = v; } var l = labels[y][x]; if (l > 0) { ids[l] = true; areas[l] = (areas[l] || 0) + 1; } } }
    var rg = mx - mn, nd = depth.map(function (r) { return r.map(function (v) { return rg > EPS ? (opts.invert ? (mx - v) : (v - mn)) / rg : 0.5; }); });
    var idList = Object.keys(ids).map(Number).sort(function (a, b) { return a - b; });
    var sumA = 0; idList.forEach(function (i) { sumA += areas[i]; });
    var bgBudget = Math.max(24, Math.floor(total * 0.2)), objBudget = total - bgBudget;
    var objects = [];
    idList.forEach(function (id) {
      var mask = labels.map(function (r) { return r.map(function (v) { return v === id ? 1 : 0; }); });
      var res = buildObject(mask, nd, { shape: opts.shape, normalize: false, scale: scale, maxFaces: Math.max(24, Math.floor(objBudget * areas[id] / sumA)), zFront: { base: 0.05 * R, range: R }, thickness: opts.thickness });
      if (res) { res.id = id; objects.push(res); }
    });
    var unknown = labels.map(function (r) { return r.map(function (v) { return v > 0; }); });
    var bgDepth = fillBackground(nd, unknown), all = labels.map(function (r) { return r.map(function () { return 1; }); });
    var bg = buildObject(all, bgDepth, { shape: 'blocks', normalize: false, scale: scale, maxFaces: bgBudget, zFront: { base: 0.05 * R, range: R }, thickness: 0.1 * maxdim });
    return { objects: objects, background: bg, closeMode: opts.closeMode === 'all' ? 'all' : 'objects' };
  }

  return { buildObject: buildObject, buildScene: buildScene, fillBackground: fillBackground, isClosed: isClosed, blocksMesh: blocksMesh, cylinderMesh: cylinderMesh, earClip: earClip, boxMesh: boxMesh };
});
