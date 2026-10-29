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
  function blocksMesh(m, dn, bb, n, zp, smooth) {
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
    if (smooth) { return smoothTops(occ, hgt, rows, cols, bb, s, zp); }
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

  // smooth shell: same occupied cells as blocksMesh, but the top corners are shared (height = mean of the occupied cells around the corner), two triangles per cell, flat back, walls only on the outline and hole edges
  function smoothTops(occ, hgt, rows, cols, bb, s, zp) {
    var B = new Builder(), i, j, zb = Math.round(zp.zBack * 1e6) / 1e6;
    var X = function (gi) { return bb.x0 + gi * s; }, Y = function (gj) { return bb.y0 + gj * s; };
    var has = function (jj, ii) { return jj >= 0 && jj < rows && ii >= 0 && ii < cols && occ[jj][ii]; };
    var cz = function (gi, gj) {
      var sum = 0, n = 0;
      for (var dj = -1; dj < 1; dj++) { for (var di = -1; di < 1; di++) { if (has(gj + dj, gi + di)) { sum += hgt[gj + dj][gi + di]; n++; } } }
      return Math.round((zp.zMin + zp.zRange * (n ? sum / n : 0)) * 1e6) / 1e6;
    };
    var top = function (gi, gj) { return B.vert(X(gi), Y(gj), cz(gi, gj)); }, bot = function (gi, gj) { return B.vert(X(gi), Y(gj), zb); };
    for (j = 0; j < rows; j++) {
      for (i = 0; i < cols; i++) {
        if (!occ[j][i]) { continue; }
        B.quad(top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j + 1));
        B.quad(bot(i, j), bot(i, j + 1), bot(i + 1, j + 1), bot(i + 1, j));
        var sides = [[i, j, i + 1, j, j - 1, i], [i + 1, j, i + 1, j + 1, j, i + 1], [i + 1, j + 1, i, j + 1, j + 1, i], [i, j + 1, i, j, j, i - 1]];
        for (var k = 0; k < 4; k++) {
          var sd = sides[k]; if (has(sd[4], sd[5])) { continue; }
          var Pl = bot(sd[0], sd[1]), Ql = bot(sd[2], sd[3]), Ph = top(sd[0], sd[1]), Qh = top(sd[2], sd[3]);
          B.tri(Pl, Ql, Qh); B.tri(Pl, Qh, Ph);
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
  var SMOOTH_LEVELS = [4, 8, 16, 24, 32, 48, 64, 96];

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
    var shape = opts.shape === 'cylinder' || opts.shape === 'blocks' || opts.shape === 'smooth' ? opts.shape : 'smooth';
    var order = shape === 'cylinder' ? ['cylinder', 'smooth', 'blocks'] : (shape === 'blocks' ? ['blocks', 'smooth', 'cylinder'] : ['smooth', 'blocks', 'cylinder']);

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
        for (level = 0; level < (kind === 'smooth' ? SMOOTH_LEVELS : BLOCK_LEVELS).length; level++) {
          var bm = null; try { bm = blocksMesh(m, dn, bb, (kind === 'smooth' ? SMOOTH_LEVELS : BLOCK_LEVELS)[level], zp, kind === 'smooth'); } catch (e2) { bm = null; }
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
    var bg = buildObject(all, bgDepth, { shape: 'blocks', normalize: false, scale: scale, maxFaces: bgBudget, zFront: { base: 0.05 * R, range: R }, thickness: (opts.closeMode === 'all' ? 0.25 : 0.06) * maxdim });
    return { objects: objects, background: bg, closeMode: opts.closeMode === 'all' ? 'all' : 'objects', width: W, height: H };
  }

  // ---------- input preparation: model-sized depth + foreground mask -> small grids + object labels ----------
  // bilinear resample of a flat array (sw x sh) to rows [h][w]
  function resampleGrid(data, sw, sh, w, h) {
    var out = [], x, y;
    for (y = 0; y < h; y++) {
      var fy = h > 1 ? y * (sh - 1) / (h - 1) : 0, y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0, row = [];
      for (x = 0; x < w; x++) {
        var fx = w > 1 ? x * (sw - 1) / (w - 1) : 0, x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        var top = data[y0 * sw + x0] * (1 - tx) + data[y0 * sw + x1] * tx, bot = data[y1 * sw + x0] * (1 - tx) + data[y1 * sw + x1] * tx;
        row.push(top * (1 - ty) + bot * ty);
      }
      out.push(row);
    }
    return out;
  }
  // nearest-neighbour resample of a flat 0/1 array; a target cell is 1 when the source cell it maps to is 1
  function resampleMask(flat, sw, sh, w, h) {
    var out = [], x, y;
    for (y = 0; y < h; y++) { var row = [], sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / h)); for (x = 0; x < w; x++) { row.push(flat[sy * sw + Math.min(sw - 1, Math.floor((x + 0.5) * sw / w))] ? 1 : 0); } out.push(row); }
    return out;
  }
  // 4-connected blobs of a 0/1 grid -> labels (1 = largest blob); blobs under minAreaFrac of the grid, or beyond maxObjects, are dropped (label 0)
  function labelComponents(mask, opts) {
    opts = opts || {};
    var d = dims(mask), H = d.h, W = d.w, lab = [], x, y, comps = [];
    for (y = 0; y < H; y++) { lab.push(new Array(W).fill(0)); }
    var seen = [];
    for (y = 0; y < H; y++) { seen.push(new Array(W).fill(false)); }
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        if (!mask[y][x] || seen[y][x]) { continue; }
        var stack = [[y, x]], cells = []; seen[y][x] = true;
        while (stack.length) {
          var c = stack.pop(); cells.push(c);
          var nb = [[c[0] - 1, c[1]], [c[0] + 1, c[1]], [c[0], c[1] - 1], [c[0], c[1] + 1]];
          for (var k = 0; k < 4; k++) { var ny = nb[k][0], nx = nb[k][1]; if (ny >= 0 && ny < H && nx >= 0 && nx < W && mask[ny][nx] && !seen[ny][nx]) { seen[ny][nx] = true; stack.push([ny, nx]); } }
        }
        comps.push(cells);
      }
    }
    comps.sort(function (a, b) { return b.length - a.length; });
    var minArea = Math.max(1, Math.floor((opts.minAreaFrac == null ? 0.003 : opts.minAreaFrac) * W * H)), maxObjects = opts.maxObjects || 12, n = 0, dropped = 0;
    comps.forEach(function (cells) {
      if (cells.length < minArea || n >= maxObjects) { dropped++; return; }
      n++; cells.forEach(function (c) { lab[c[0]][c[1]] = n; });
    });
    return { labels: lab, count: n, dropped: dropped };
  }
  // masks from a segmentation model ([{w,h,data,score}], 1 = inside) -> labels grid (w x h). Near-duplicates (IoU over 0.7) and masks that are tiny or cover almost the whole picture are dropped;
  // bigger masks are painted first so a smaller mask inside one stays its own object; labels are numbered by area, biggest = 1.
  function labelsFromMasks(masks, w, h, opts) {
    opts = opts || {};
    var minArea = Math.max(1, Math.floor((opts.minAreaFrac == null ? 0.004 : opts.minAreaFrac) * w * h)), maxArea = (opts.maxAreaFrac || 0.5) * w * h, maxObjects = opts.maxObjects || 12;
    var rs = (masks || []).map(function (m) { var g = resampleMask(m.data, m.w, m.h, w, h), n = 0; g.forEach(function (r) { r.forEach(function (v) { n += v; }); }); return { g: g, n: n, score: m.score || 0 }; })
      .filter(function (m) { return m.n >= minArea && m.n <= maxArea; });
    rs.sort(function (a, b) { return b.score - a.score; });
    var kept = [];
    rs.forEach(function (m) {
      for (var i = 0; i < kept.length; i++) {
        var inter = 0, y, x; for (y = 0; y < h; y++) { for (x = 0; x < w; x++) { if (m.g[y][x] && kept[i].g[y][x]) { inter++; } } }
        if (inter / (m.n + kept[i].n - inter) > 0.7) { return; }
      }
      kept.push(m);
    });
    kept = kept.slice(0, maxObjects).sort(function (a, b) { return b.n - a.n; });
    var lab = [], y2, x2; for (y2 = 0; y2 < h; y2++) { lab.push(new Array(w).fill(0)); }
    kept.forEach(function (m, i) { for (y2 = 0; y2 < h; y2++) { for (x2 = 0; x2 < w; x2++) { if (m.g[y2][x2]) { lab[y2][x2] = i + 1; } } } });
    // painting small-on-big can erase a big mask's label entirely or split it; count what is left
    var left = {}; lab.forEach(function (r) { r.forEach(function (v) { if (v) { left[v] = (left[v] || 0) + 1; } }); });
    var ids = Object.keys(left).map(Number).sort(function (a, b) { return left[b] - left[a]; }), map = {}; ids.forEach(function (id, i) { map[id] = i + 1; });
    lab = lab.map(function (r) { return r.map(function (v) { return v ? map[v] : 0; }); });
    return { labels: lab, count: ids.length, dropped: (masks || []).length - ids.length };
  }
  // one call from the host: depth {w,h,data} (model-sized, larger = nearer) + optional foreground mask {w,h,data} (1 = object) -> { labels, depth, width, height, count }
  // mode: 'whole' = the whole picture is one object; 'components' (default) = every separate foreground blob is an object (needs a mask, else falls back to 'whole')
  function prepareInput(depth, mask, opts) {
    opts = opts || {};
    var longest = Math.max(depth.w, depth.h), k = Math.min(1, (opts.workMax || 96) / longest), w = Math.max(2, Math.round(depth.w * k)), h = Math.max(2, Math.round(depth.h * k));
    var dep = resampleGrid(depth.data, depth.w, depth.h, w, h), res;
    if (opts.segments && opts.segments.length && opts.mode !== 'whole') {
      res = labelsFromMasks(opts.segments, w, h, opts);
      if (!res.count) { res = { labels: dep.map(function (r) { return r.map(function () { return 1; }); }), count: 1, dropped: res.dropped, empty: true }; }
    } else if (opts.mode === 'whole' || !mask) {
      res = { labels: dep.map(function (r) { return r.map(function () { return 1; }); }), count: 1, dropped: 0 };
    } else {
      res = labelComponents(resampleMask(mask.data, mask.w, mask.h, w, h), opts);
      if (!res.count) { res = { labels: dep.map(function (r) { return r.map(function () { return 1; }); }), count: 1, dropped: res.dropped, empty: true }; }
    }
    return { labels: res.labels, depth: dep, width: w, height: h, count: res.count, dropped: res.dropped, empty: !!res.empty };
  }

  // ---------- background subtraction: the picture with the subject vs a picture of the empty background (same camera) ----------
  // a, bg: { width, height, data: RGBA } of the same size. A pixel is foreground when its colour is further than `tol` (default 40, RGB distance) from the background pixel,
  // then a 3x3 majority filter (passes, default 2) removes speckles and fills pin-holes. Returns { mask: Uint8Array (1 = foreground), fg: share of the picture, tol }.
  function diffMask(a, bg, opts) {
    opts = opts || {};
    if (!a || !bg || a.width !== bg.width || a.height !== bg.height) { return null; }
    var w = a.width, h = a.height, tol = opts.tol || 40, n = w * h, m = new Uint8Array(n), i, x, y;
    for (i = 0; i < n; i++) {
      var o = i * 4, dr = a.data[o] - bg.data[o], dg = a.data[o + 1] - bg.data[o + 1], db = a.data[o + 2] - bg.data[o + 2];
      m[i] = Math.sqrt(dr * dr + dg * dg + db * db) > tol ? 1 : 0;
    }
    for (var pass = 0; pass < (opts.passes == null ? 2 : opts.passes); pass++) {
      var nx = new Uint8Array(n);
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var c = 0, t = 0;
          for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) { var yy = y + dy, xx = x + dx; if (yy >= 0 && yy < h && xx >= 0 && xx < w) { t++; c += m[yy * w + xx]; } } }
          nx[y * w + x] = c * 2 > t ? 1 : 0;
        }
      }
      m = nx;
    }
    var fg = 0; for (i = 0; i < n; i++) { fg += m[i]; }
    return { mask: m, fg: fg / n, tol: tol };
  }

  // ---------- panorama / orbit photos -> near-and-far layered model for VR ----------
  // A panorama is seen from the inside, so its depth bands (far / middle / near) are bent onto a cylinder around the viewer: each band is still a closed solid
  // (bending moves vertices only, the faces stay the same), far bands sit at a bigger radius, near bands closer. Output goes through toSpec like any other scene.
  function signedVolume(mesh) {
    var V = mesh.vertices, vol = 0;
    mesh.faces.forEach(function (f) { var a = V[f[0]], b = V[f[1]], c = V[f[2]]; vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; });
    return vol;
  }
  // scene coordinates (x 0..xSpan, y 0..ySpan, z toward the viewer) -> a cylinder of radius R around the origin; fovRad = the horizontal angle the picture covers (2*PI for a full panorama)
  function bendCylinder(mesh, o) {
    var fov = o.fovRad || 2 * Math.PI, R = o.radius || 5, xs = o.xSpan || 1, ys = o.ySpan || 0.5, eye = o.eye == null ? 1.6 : o.eye, zk = o.zK || 1.33, rminF = 0.2;
    var out = { vertices: mesh.vertices.map(function (v) {
      var th = (v[0] / xs - 0.5) * fov, r = Math.max(R * rminF, R * (1 - zk * v[2])), yy = (v[1] - ys / 2) * R * fov / xs * (xs / xs) + eye;
      return [Math.round(r * Math.sin(th) * 1e4) / 1e4, Math.round(yy * 1e4) / 1e4, Math.round(-r * Math.cos(th) * 1e4) / 1e4];
    }), faces: mesh.faces.map(function (f) { return f.slice(); }) };
    if (signedVolume(out) < 0) { out.faces = out.faces.map(function (f) { return [f[0], f[2], f[1]]; }); }
    return out;
  }
  // several photos' depth maps [{w,h,data}] (already in left-to-right order) -> one strip {w,h,data}: each map is scaled to 0..1 on its own (depth models give relative depth, so this is only approximate), resampled to a common height, laid side by side
  function stitchDepths(list, opts) {
    opts = opts || {};
    var H = opts.height || Math.min.apply(null, list.map(function (d) { return d.h; })), cols = [], W = 0;
    list.forEach(function (d) {
      var mn = Infinity, mx = -Infinity, i; for (i = 0; i < d.data.length; i++) { if (d.data[i] < mn) { mn = d.data[i]; } if (d.data[i] > mx) { mx = d.data[i]; } }
      var rg = mx - mn, w = Math.max(2, Math.round(d.w * H / d.h)), g = resampleGrid(d.data, d.w, d.h, w, H);
      cols.push({ w: w, g: g.map(function (r) { return r.map(function (v) { return rg > EPS ? (v - mn) / rg : 0.5; }); }) }); W += w;
    });
    var data = new Float32Array(W * H), x0 = 0;
    cols.forEach(function (c) { for (var y = 0; y < H; y++) { for (var x = 0; x < c.w; x++) { data[y * W + x0 + x] = c.g[y][x]; } } x0 += c.w; });
    return { w: W, h: H, data: data };
  }
  // how wide a field of view a strip covers: a ~2:1 picture is taken as a full 360 degree equirectangular panorama, otherwise about 45 degrees per unit of aspect ratio
  function panoFov(aspect) { return Math.abs(aspect - 2) < 0.2 ? 360 : Math.min(360, Math.max(60, Math.round(aspect * 45))); }
  // depth rows -> band labels 1..n (1 = farthest) by quantile of the depth values
  function depthBands(depth, n) {
    var vals = [], y, x; for (y = 0; y < depth.length; y++) { for (x = 0; x < depth[y].length; x++) { vals.push(depth[y][x]); } }
    vals.sort(function (a, b) { return a - b; });
    var cuts = []; for (var i = 1; i < n; i++) { cuts.push(vals[Math.min(vals.length - 1, Math.floor(vals.length * i / n))]); }
    return depth.map(function (r) { return r.map(function (v) { var b = 1; for (var k = 0; k < cuts.length; k++) { if (v >= cuts[k]) { b = k + 2; } } return b; }); });
  }
  // depth {w,h,data} (the whole panorama strip) -> { objects:[{id, mesh, shape, ...}], background:null, panorama:true }
  function buildPanorama(depth, opts) {
    opts = opts || {};
    var longest = Math.max(depth.w, depth.h), k = Math.min(1, (opts.workMax || 160) / longest), w = Math.max(4, Math.round(depth.w * k)), h = Math.max(2, Math.round(depth.h * k));
    var dep = resampleGrid(depth.data, depth.w, depth.h, w, h), labels = depthBands(dep, opts.bands || 3);
    var sc = buildScene({ labels: labels, depth: dep }, { shape: 'blocks', closeMode: 'objects', maxFaces: opts.maxFaces || 12000 });
    var maxdim = Math.max(w, h), bend = { fovRad: (opts.fovDeg || 360) * Math.PI / 180, radius: opts.radius || 5, xSpan: w / maxdim, ySpan: h / maxdim, eye: opts.eye == null ? 1.6 : opts.eye };
    sc.objects.forEach(function (o) { o.mesh = bendCylinder(o.mesh, bend); o.name = ['遠景', '中景', '近景', '最近景', '最近景2', '最近景3'][o.id - 1] || ('層' + o.id); });
    sc.background = null; sc.panorama = true; sc.pano = bend; return sc;
  }

  // ---------- EXIF (JPEG APP1): GPS position, heading, camera model; just enough to tell whether photos turn around a spot ----------
  // buf: ArrayBuffer/Uint8Array of a JPEG -> { lat, lon, heading, make } (fields missing when absent) | null
  function readExif(buf) {
    var u = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u.buffer, u.byteOffset, u.byteLength), p = 2;
    if (u.length < 12 || dv.getUint16(0) !== 0xFFD8) { return null; }
    while (p + 4 < u.length) {
      var mk = dv.getUint16(p), len = dv.getUint16(p + 2);
      if (mk === 0xFFE1 && String.fromCharCode(u[p + 4], u[p + 5], u[p + 6], u[p + 7]) === 'Exif') { return parseTiff(dv, p + 10); }
      if (mk === 0xFFDA || (mk & 0xFF00) !== 0xFF00) { break; }
      p += 2 + len;
    }
    return null;
  }
  function parseTiff(dv, t) {
    var le = dv.getUint16(t) === 0x4949, g16 = function (o) { return dv.getUint16(o, le); }, g32 = function (o) { return dv.getUint32(o, le); };
    var TS = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    function entries(off) { var n = g16(t + off), out = {}; for (var i = 0; i < n; i++) { var e = t + off + 2 + i * 12; out[g16(e)] = { type: g16(e + 2), count: g32(e + 4), at: e + 8 }; } return out; }
    function valAt(e) { var sz = (TS[e.type] || 1) * e.count; return sz <= 4 ? e.at : t + g32(e.at); }
    function str(e) { var o = valAt(e), s = ''; for (var i = 0; i < e.count - 1; i++) { s += String.fromCharCode(dv.getUint8(o + i)); } return s; }
    function rats(e) { var o = valAt(e), r = []; for (var i = 0; i < e.count; i++) { var d = g32(o + i * 8 + 4); r.push(d ? g32(o + i * 8) / d : 0); } return r; }
    try {
      var ifd0 = entries(g32(t + 4)), out = {};
      if (ifd0[0x010F]) { out.make = str(ifd0[0x010F]); }
      if (ifd0[0x8825]) {
        var gps = entries(g32(ifd0[0x8825].at)), lat = gps[2] && rats(gps[2]), lon = gps[4] && rats(gps[4]);
        if (lat && lon && gps[1] && gps[3]) {
          out.lat = (lat[0] + lat[1] / 60 + lat[2] / 3600) * (str(gps[1]) === 'S' ? -1 : 1); out.lon = (lon[0] + lon[1] / 60 + lon[2] / 3600) * (str(gps[3]) === 'W' ? -1 : 1);
        }
        if (gps[17]) { out.heading = rats(gps[17])[0]; }
      }
      return out;
    } catch (e) { return null; }
  }
  // shots: [{lat, lon, heading}] (one per photo, in the order given). 'outward' = the photos are taken from about one spot while turning (headings spread over >= 240 degrees, positions within `spotM` metres):
  // they can be laid side by side as one panorama, ordered by heading. 'inward' = positions go around a centre (not handled: needs a reconstruction we do not have). 'unknown' otherwise.
  function orbitKind(shots, opts) {
    opts = opts || {};
    var s = (shots || []).filter(function (x) { return x && isFinite(x.heading); });
    if (s.length < 3) { return { kind: 'unknown', reason: '至少要三張有方向資料的照片' }; }
    var gps = s.filter(function (x) { return isFinite(x.lat) && isFinite(x.lon); }), spot = opts.spotM || 25, spread = 0;
    var hs = s.map(function (x) { return ((x.heading % 360) + 360) % 360; }).sort(function (a, b) { return a - b; }), maxGap = 0;
    for (var i = 0; i < hs.length; i++) { var gap = (i === hs.length - 1 ? hs[0] + 360 : hs[i + 1]) - hs[i]; if (gap > maxGap) { maxGap = gap; } }
    var cover = 360 - maxGap;
    if (gps.length >= 3) {
      var la = gps.reduce(function (a, x) { return a + x.lat; }, 0) / gps.length, lo = gps.reduce(function (a, x) { return a + x.lon; }, 0) / gps.length;
      gps.forEach(function (x) { var dy = (x.lat - la) * 111320, dx = (x.lon - lo) * 111320 * Math.cos(la * Math.PI / 180); spread = Math.max(spread, Math.sqrt(dx * dx + dy * dy)); });
    }
    if (cover >= 240 && spread <= spot) { return { kind: 'outward', coverDeg: Math.round(cover), spreadM: Math.round(spread * 10) / 10, order: s.map(function (x, i) { return i; }).sort(function (a, b) { return (((s[a].heading % 360) + 360) % 360) - (((s[b].heading % 360) + 360) % 360); }) }; }
    if (spread > spot && cover >= 180) { return { kind: 'inward', coverDeg: Math.round(cover), spreadM: Math.round(spread * 10) / 10 }; }
    return { kind: 'unknown', coverDeg: Math.round(cover), spreadM: Math.round(spread * 10) / 10 };
  }

  // a scene's objects (not the backdrop) merged into ONE mesh with front-projected texture coordinates -> { vertices, faces, uvs } | null; every object is closed, so the merge is closed too
  function subjectMesh(scene) {
    var vs = [], fs = [], uvs = [], md = Math.max(scene.width || 1, scene.height || 1), W = scene.width || md, H = scene.height || md;
    (scene.objects || []).forEach(function (o) {
      var base = vs.length;
      o.mesh.vertices.forEach(function (v) { vs.push([v[0], v[1], v[2]]); uvs.push([Math.round(Math.max(0, Math.min(1, v[0] * md / W)) * 10000) / 10000, Math.round(Math.max(0, Math.min(1, v[1] * md / H)) * 10000) / 10000]); });
      o.mesh.faces.forEach(function (f) { fs.push([f[0] + base, f[1] + base, f[2] + base]); });
    });
    return vs.length ? { vertices: vs, faces: fs, uvs: uvs } : null;
  }

  // ---------- options from the user's words (the program decides; the model is only asked when this cannot) ----------
  // close: 'objects' (default; every found object is a closed solid, the backdrop is a thin closed slab) | 'all' (the user wants everything closed / printable: the backdrop is a full-thickness solid too)
  function parseOptions(text) {
    var t = String(text || ''), out = { close: 'objects', shape: 'auto', whole: false, segment: false, panorama: false, closeSource: 'default' }, m;
    if (/--panorama(?![a-z])|全景|環景|轉圈|panorama/i.test(t)) { out.panorama = true; }
    if (/--segment(?![a-z])|自動(?:分割|分物件)|分割模型|segment\s+objects/i.test(t)) { out.segment = true; }
    if ((m = /--close[=\s]+(objects|all)(?![a-z])/i.exec(t))) { out.close = m[1].toLowerCase(); out.closeSource = 'flag'; }
    else if (/(?:全部|所有|整個|整張|統一|每個|一律)[^，。,.\n]{0,8}封閉|要能?(?:3d)?列印|可(?:以)?列印|print(?:able)?|watertight|everything\s+closed|close\s+all/i.test(t)) { out.close = 'all'; out.closeSource = 'phrase'; }
    else if (/(?:物件|東西|蘋果|人物|人臉)[^，。,.\n]{0,6}(?:要|得|需要)?封閉|closed\s+objects?/i.test(t)) { out.close = 'objects'; out.closeSource = 'phrase'; }
    if ((m = /--shape[=\s]+(auto|cylinder|blocks|smooth)(?![a-z])/i.exec(t))) { out.shape = m[1].toLowerCase(); }
    else if (/圓柱|柱體|cylinder/i.test(t)) { out.shape = 'cylinder'; }
    else if (/樂高|方塊|lego|blocks?/i.test(t)) { out.shape = 'blocks'; }
    if (/--whole(?![a-z])|整張圖當一個|整張當一個|不要?分物件|whole\s+image/i.test(t)) { out.whole = true; }
    return out;
  }

  // ---------- scene -> raw editor spec (/edit-3d-model): a group holding the background and one custom-shape (mesh:'polygon') object per found object ----------
  // opts: { sizeM (longest side in metres, default 1.5), title, colors:{ id | 'background': '#rrggbb' }, texture: the original picture (a data: URL or ref: key) }
  // With a texture every part gets uvs by projecting the picture straight onto the model from the front (so the front looks like the photo; the sides and back get the nearest edge colours, stretched).
  function toSpec(scene, opts) {
    opts = opts || {};
    var parts = [], mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    if (scene.background && scene.background.mesh) { parts.push({ name: '背景', key: 'background', res: scene.background }); }
    scene.objects.forEach(function (o, i) { parts.push({ name: '物件' + (i + 1), key: o.id, res: o }); });
    parts.forEach(function (p) { p.res.mesh.vertices.forEach(function (v) { for (var a = 0; a < 3; a++) { if (v[a] < mn[a]) { mn[a] = v[a]; } if (v[a] > mx[a]) { mx[a] = v[a]; } } }); });
    if (!parts.length) { return null; }
    var pano = scene.pano || null;
    var k = pano ? 1 : (opts.sizeM || 1.5), cx = pano ? 0 : (mn[0] + mx[0]) / 2, cz = pano ? 0 : (mn[2] + mx[2]) / 2, y0 = pano ? 0 : mn[1], r = function (x) { return Math.round(x * k * 10000) / 10000; };
    var palette = ['#e57373', '#64b5f6', '#81c784', '#ffd54f', '#ba68c8', '#4db6ac', '#ff8a65', '#a1887f'];
    var objects = [{ id: 'g1', type: 'group', name: opts.title || '圖片轉3D', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }];
    parts.forEach(function (p, i) {
      var col = opts.colors && opts.colors[p.key] || (p.key === 'background' ? '#9e9e9e' : palette[i % palette.length]);
      objects.push({ id: 'p' + (i + 1), type: 'mesh', mesh: 'polygon', name: (pano && p.res.name) || p.name, parent: 'g1', position: [0, 0, 0], rotation: [0, 0, 0], material: { color: col, roughness: 0.7, metalness: 0.02 },
        extra: { vertices: p.res.mesh.vertices.map(function (v) { return [r(v[0] - cx), r(v[1] - y0), r(v[2] - cz)]; }), faces: p.res.mesh.faces } });
      if (opts.texture && pano) {
        var part0 = objects[objects.length - 1], sc2 = pano.radius * pano.fovRad / pano.xSpan;
        part0.extra.uvs = p.res.mesh.vertices.map(function (v) {
          var u = Math.atan2(v[0], -v[2]) / pano.fovRad + 0.5, vv = ((v[1] - pano.eye) / sc2 + pano.ySpan / 2) / pano.ySpan;
          return [Math.round(Math.max(0, Math.min(1, u)) * 10000) / 10000, Math.round(Math.max(0, Math.min(1, vv)) * 10000) / 10000];
        });
        part0.material = { color: '#ffffff', roughness: 0.9, metalness: 0, texture: opts.texture, side: 'double' };
      } else if (opts.texture && scene.width && scene.height) {
        var md = Math.max(scene.width, scene.height), part = objects[objects.length - 1];
        part.extra.uvs = p.res.mesh.vertices.map(function (v) { return [Math.round(Math.max(0, Math.min(1, v[0] * md / scene.width)) * 10000) / 10000, Math.round(Math.max(0, Math.min(1, v[1] * md / scene.height)) * 10000) / 10000]; });
        part.material = { color: '#ffffff', roughness: 0.8, metalness: 0, texture: opts.texture, side: 'double' };
      }
    });
    var spec = { v: 1, title: opts.title || '圖片轉3D', objects: objects };
    if (pano) { spec.camera = { position: [0, pano.eye == null ? 1.6 : pano.eye, 0], look_at: [0, pano.eye == null ? 1.6 : pano.eye, -1], fov: 75 }; }
    return spec;
  }

  return { subjectMesh: subjectMesh, stitchDepths: stitchDepths, panoFov: panoFov, buildPanorama: buildPanorama, bendCylinder: bendCylinder, depthBands: depthBands, readExif: readExif, orbitKind: orbitKind, diffMask: diffMask, labelsFromMasks: labelsFromMasks, parseOptions: parseOptions, toSpec: toSpec, prepareInput: prepareInput, labelComponents: labelComponents, resampleGrid: resampleGrid, resampleMask: resampleMask, buildObject: buildObject, buildScene: buildScene, fillBackground: fillBackground, isClosed: isClosed, blocksMesh: blocksMesh, cylinderMesh: cylinderMesh, earClip: earClip, boxMesh: boxMesh };
});
