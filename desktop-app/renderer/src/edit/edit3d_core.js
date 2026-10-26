// /edit-3d-model:3D 場景編輯器的文件核心(純函式,node 與瀏覽器都能跑)。設計見 DESIGN.edit-3d.md。
// 一個場景是一串「物件」(跟 /edit-svg 同一套外框 FaEditShell):
//   mesh   { mesh:'box'|'sphere'|'cylinder'|'cone'|'plane'|'torus'|'polygon'|'particles'|'line', position, rotation(弧度), size|radius|height|tube_radius, material:{color,metalness,roughness,opacity,emissive,texture,texture_repeat,side}, skins:[…], extra:{…} }
//   group  { position, rotation, scale }   把一些物件綁在一起(樹狀);子物件的座標是相對於群組
//   light  { light:'directional'|'point'|'ambient', position, intensity, color }
//   每個物件另有 id、name、parent(群組的 id 或 null)、visible、locked。物件順序就是物件欄的樹狀順序。
// 「完全基於使用者的相對視角」:AI 用說的位置(在我的左前方、畫面中間、桌子的上面、桌子的右邊…),由程式用「目前相機」算座標——
//   我的「前方」=相機看過去的方向(投影在地面)、「右」=前方的右手邊;不讓模型猜座標。place:{ of:'me'|'view'|'origin'|<id|名字>|'selection', rel:'front'|'back'|'left'|'right'|'left-front'|'right-front'|'left-back'|'right-back'|'above'|'on'|'below'|'inside'|'center'|'beside', dist?, gap?, dx?, dy?, dz? }
//   (dx 往我的右、dy 往上、dz 往我的前方,最後加上去)。座標系:右手、y 向上、單位是場景單位(跟 render_3d_scene 一樣)。
// 編輯動作是封閉集合(模型只填 JSON,程式驗證、拒絕不合法的):
//   set_title set_background set_camera add_object update_object remove_object rename_object move_object set_visible set_locked duplicate_object clear_objects place_object transform_object
//   group_objects ungroup set_parent set_material add_skin update_skin remove_skin clear_skins set_skins drop_to_ground align_objects;宿主執行的:find_picture generate_image
// 輸出:toScene(spec) 展平成 render_3d_scene 可以直接播放的場景(群組攤開、貼皮變成貼在面上的薄平面、整面貼圖烘成材質),toYaml 給「原始碼」分頁(多了 id/name/parent/group/hidden/locked/skins),fromYaml 兩種都讀得進來。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./mesh_gen.js')); else root.FaEdit3d = factory(root.FaMeshGen || (typeof FaMeshGen !== 'undefined' ? FaMeshGen : null)); })(typeof self !== 'undefined' ? self : this, function (MG) {
  'use strict';
  var PI = Math.PI, LIM = { objects: 400, name: 60, title: 80, coord: 10000, skins: 24, extra: 3000000 };
  var MESHES = { box: '方塊', sphere: '球', cylinder: '圓柱', cone: '圓錐', plane: '平面', torus: '圓環', polygon: '自訂形狀', particles: '粒子', line: '線' };
  var OPS = ['set_title', 'set_background', 'set_camera', 'replace_scene', 'add_model', 'add_object', 'update_object', 'remove_object', 'rename_object', 'move_object', 'set_visible', 'set_locked', 'duplicate_object', 'clear_objects', 'place_object', 'transform_object', 'group_objects', 'ungroup', 'set_parent', 'set_material', 'add_skin', 'update_skin', 'remove_skin', 'clear_skins', 'set_skins', 'drop_to_ground', 'align_objects'];
  var HOST_OPS = ['find_picture', 'generate_image'];
  function str(v, max) { return String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, max || 200); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function num(v, lo, hi, d) { var n = Number(v); if (!isFinite(n)) { return d; } return Math.max(lo, Math.min(hi, n)); }
  function r3(n) { return Math.round(n * 1000) / 1000; }
  function vec(v, d, lo, hi) { if (!Array.isArray(v) || v.length < 3) { return d.slice(); } return [r3(num(v[0], lo == null ? -LIM.coord : lo, hi == null ? LIM.coord : hi, d[0])), r3(num(v[1], lo == null ? -LIM.coord : lo, hi == null ? LIM.coord : hi, d[1])), r3(num(v[2], lo == null ? -LIM.coord : lo, hi == null ? LIM.coord : hi, d[2]))]; }
  var COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/;
  function color(v, d) { v = String(v == null ? '' : v).trim(); return COLOR.test(v) ? v : d; }
  var TEX_BUILTIN = ['water', 'grass', 'sand', 'wood', 'brick'];
  function texture(v) { v = v == null ? '' : String(v).trim(); if (!v) { return ''; } if (/^ref:[A-Za-z0-9_-]{1,40}$/.test(v) || /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 2500000 || /^https?:\/\/[^\s]{3,500}$/i.test(v)) { return v; } return TEX_BUILTIN.indexOf(v.toLowerCase()) >= 0 ? v.toLowerCase() : ''; }

  // ───────────────────────── math (right-handed, y up; Euler 'XYZ' as in three.js: M = Rx · Ry · Rz) ─────────────────────────
  function mmul(a, b) { var o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], i, j, k; for (i = 0; i < 3; i++) { for (j = 0; j < 3; j++) { for (k = 0; k < 3; k++) { o[i][j] += a[i][k] * b[k][j]; } } } return o; }
  function rotMat(r) { var cx = Math.cos(r[0]), sx = Math.sin(r[0]), cy = Math.cos(r[1]), sy = Math.sin(r[1]), cz = Math.cos(r[2]), sz = Math.sin(r[2]); return mmul(mmul([[1, 0, 0], [0, cx, -sx], [0, sx, cx]], [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]), [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]); }
  function mvec(m, v) { return [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]]; }
  function mT(m) { return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]]; }
  function matEuler(m) { var m13 = m[0][2], y = Math.asin(Math.max(-1, Math.min(1, m13))), x, z; if (Math.abs(m13) < 0.9999999) { x = Math.atan2(-m[1][2], m[2][2]); z = Math.atan2(-m[0][1], m[0][0]); } else { x = Math.atan2(m[2][1], m[1][1]); z = 0; } return [r3(x), r3(y), r3(z)]; }
  function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vmul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vlen(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function vnorm(a) { var l = vlen(a); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }
  var IDENT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  // ───────────────────────── objects ─────────────────────────
  var DEFAULTS = {
    box: { size: [1, 1, 1] }, sphere: { radius: 0.5 }, cylinder: { radius: 0.4, height: 1 }, cone: { radius: 0.5, height: 1 }, plane: { size: [4, 4], rotation: [-PI / 2, 0, 0] }, torus: { radius: 0.5, tube_radius: 0.15 }, polygon: {}, particles: {}, line: {}
  };
  var MATERIAL_KEYS = ['color', 'metalness', 'roughness', 'opacity', 'emissive', 'emissive_intensity', 'texture', 'texture_repeat', 'side'];
  function material(m, d) {
    m = m && typeof m === 'object' ? m : {}; d = d || {}; var out = {};
    out.color = color(m.color, d.color || '#4E79A7'); out.metalness = r3(num(m.metalness, 0, 1, d.metalness == null ? 0.2 : d.metalness)); out.roughness = r3(num(m.roughness, 0, 1, d.roughness == null ? 0.7 : d.roughness));
    if (m.opacity != null && Number(m.opacity) < 1) { out.opacity = r3(num(m.opacity, 0.05, 1, 1)); }
    if (m.emissive && color(m.emissive, '')) { out.emissive = color(m.emissive, '#000000'); out.emissive_intensity = r3(num(m.emissive_intensity, 0, 20, 1)); }
    var t = texture(m.texture); if (t) { out.texture = t; var rp = Array.isArray(m.texture_repeat) && m.texture_repeat.length >= 2 ? [r3(num(m.texture_repeat[0], 0.01, 1000, 1)), r3(num(m.texture_repeat[1], 0.01, 1000, 1))] : null; if (rp) { out.texture_repeat = rp; } }
    if (m.side === 'back' || m.side === 'double') { out.side = m.side; }
    return out;
  }
  var ZONE_LABEL = { '+x': '右面', '-x': '左面', '+y': '上面', '-y': '下面', '+z': '前面', '-z': '後面', side: '側面', top: '頂面', bottom: '底面', wrap: '整個表面', front: '正面' };
  function zonesOf(meshType) { return ({ box: ['+z', '-z', '-x', '+x', '+y', '-y'], cylinder: ['side', 'top', 'bottom'], cone: ['side', 'bottom'], sphere: ['wrap'], torus: ['wrap'], plane: ['front'] })[meshType] || []; }
  function defaultZone(meshType) { return zonesOf(meshType)[0] || ''; }
  function skin(s, meshType, seq) {
    s = s && typeof s === 'object' ? s : {}; var zones = zonesOf(meshType); if (!zones.length) { return null; }
    var zone = zones.indexOf(String(s.zone)) >= 0 ? String(s.zone) : defaultZone(meshType), img = s.image == null || s.image === '' ? '' : texture(s.image), col = s.color ? color(s.color, '') : '';
    if (!img && !col) { return null; }
    var id = /^k[0-9]{1,5}$/.test(String(s.id || '')) ? String(s.id) : 'k' + seq;
    return { id: id, name: str(s.name, 40) || (ZONE_LABEL[zone] + (img ? '貼圖' : '上色')), zone: zone, image: img, color: col, u: r3(num(s.u, -2, 3, 0.5)), v: r3(num(s.v, -2, 3, 0.5)), w: r3(num(s.w, 0.01, 4, 1)), h: r3(num(s.h, 0.01, 4, 1)), rotate: r3(num(s.rotate, -3600, 3600, 0)), opacity: r3(num(s.opacity, 0.05, 1, 1)) };
  }
  function skins(list, meshType) { var out = [], seq = 0; (Array.isArray(list) ? list : []).forEach(function (s) { if (out.length >= LIM.skins) { return; } seq++; var k = skin(s, meshType, seq); if (k) { if (out.some(function (x) { return x.id === k.id; })) { k.id = 'k' + (seq + 100); } out.push(k); } }); return out; }
  var KNOWN = { id: 1, name: 1, type: 1, parent: 1, visible: 1, locked: 1, mesh: 1, position: 1, rotation: 1, size: 1, radius: 1, height: 1, tube_radius: 1, material: 1, skins: 1, extra: 1, scale: 1, light: 1, intensity: 1, color: 1, group: 1, hidden: 1, rotation_deg: 1 };
  function validateObject(o, problems) {
    if (!o || typeof o !== 'object') { return null; }
    var type = o.type, out = {};
    if (!type) { type = o.group === true || o.mesh === 'group' ? 'group' : (o.light && !o.mesh ? 'light' : 'mesh'); }
    if (type === 'group') { out = { type: 'group', position: vec(o.position, [0, 0, 0]), rotation: vec(o.rotation, [0, 0, 0], -100, 100), scale: r3(num(o.scale, 0.001, 1000, 1)) }; }
    else if (type === 'light') { var lt = ['directional', 'point', 'ambient'].indexOf(o.light) >= 0 ? o.light : 'point'; out = { type: 'light', light: lt, position: vec(o.position, lt === 'directional' ? [5, 8, 5] : [0, 3, 0]), intensity: r3(num(o.intensity, 0, 100, lt === 'ambient' ? 0.5 : 1)), color: color(o.color, '#ffffff') }; }
    else if (type === 'mesh') {
      if (!MESHES[o.mesh]) { problems.push('未知的形狀 "' + str(o.mesh, 20) + '",略過'); return null; }
      var D = DEFAULTS[o.mesh] || {}, rot = Array.isArray(o.rotation) ? vec(o.rotation, [0, 0, 0], -100, 100) : (Array.isArray(o.rotation_deg) ? vec(o.rotation_deg.map(function (d) { return Number(d) * PI / 180; }), [0, 0, 0], -100, 100) : (D.rotation ? D.rotation.slice() : [0, 0, 0]));
      out = { type: 'mesh', mesh: o.mesh, position: vec(o.position, [0, 0, 0]), rotation: rot, material: material(o.material, {}) };
      if (o.mesh === 'box') { out.size = vec(o.size, D.size, 0.001, 5000); }
      else if (o.mesh === 'plane') { var sz = Array.isArray(o.size) ? o.size : D.size; out.size = [r3(num(sz[0], 0.001, 5000, 4)), r3(num(sz.length >= 3 ? sz[2] : sz[1], 0.001, 5000, 4))]; }
      else if (o.mesh === 'sphere') { out.radius = r3(num(o.radius, 0.001, 5000, D.radius)); }
      else if (o.mesh === 'cylinder' || o.mesh === 'cone') { out.radius = r3(num(o.radius, 0.001, 5000, D.radius)); out.height = r3(num(o.height, 0.001, 5000, D.height)); }
      else if (o.mesh === 'torus') { out.radius = r3(num(o.radius, 0.001, 5000, D.radius)); out.tube_radius = r3(num(o.tube_radius, 0.001, 5000, D.tube_radius)); }
      var sk = skins(o.skins, o.mesh); if (sk.length) { out.skins = sk; }
      var ex = {}, any = false; if (o.extra && typeof o.extra === 'object') { Object.keys(o.extra).forEach(function (k) { ex[k] = o.extra[k]; any = true; }); } Object.keys(o).forEach(function (k) { if (!KNOWN[k] && !/^_/.test(k)) { ex[k] = o[k]; any = true; } });
      if (any) { try { if (JSON.stringify(ex).length > LIM.extra) { problems.push('「' + str(o.name, 20) + '」的資料太大,略過'); return null; } out.extra = clone(ex); } catch (e) { /* skip */ } }
      if ((o.mesh === 'polygon') && !(out.extra && Array.isArray(out.extra.vertices) && out.extra.vertices.length >= 3)) { problems.push('自訂形狀沒有 vertices,略過'); return null; }
      if (o.mesh === 'line' && !(out.extra && (Array.isArray(out.extra.points) || out.extra.shape === 'circle'))) { problems.push('線沒有 points,略過'); return null; }
    } else { problems.push('未知的物件類型 "' + str(type, 20) + '",略過'); return null; }
    out.id = /^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(String(o.id || '')) ? String(o.id) : null; out.name = str(o.name, LIM.name).trim() || (type === 'group' ? '群組' : type === 'light' ? '燈光' : MESHES[o.mesh]);
    out.parent = o.parent ? String(o.parent) : null; out.visible = o.visible !== false && o.hidden !== true; out.locked = !!o.locked;
    return out;
  }
  function defaultSpec() { return { v: 1, title: '3D 場景', background: '#1a1d24', camera: { position: [5, 4, 7], look_at: [0, 0.5, 0], fov: 50 }, seq: 0, objects: [] }; }
  function cameraOf(c, d) { c = c && typeof c === 'object' ? c : {}; d = d || defaultSpec().camera; var p = vec(c.position, d.position, -5000, 5000), l = vec(c.look_at, d.look_at, -5000, 5000); if (vlen(vsub(p, l)) < 0.01) { p = vadd(l, [0, 1, 4]); } return { position: p, look_at: l, fov: r3(num(c.fov, 10, 120, d.fov || 50)) }; }
  function validate(input) {
    var problems = [], d = defaultSpec(), r = input && typeof input === 'object' ? input : {}, s = { v: 1, title: str(r.title, LIM.title) || d.title, background: color(r.background, d.background), camera: cameraOf(r.camera, d.camera), seq: 0, objects: [] }, ids = {};
    (Array.isArray(r.objects) ? r.objects : []).forEach(function (o) {
      if (s.objects.length >= LIM.objects) { if (!ids.__full) { problems.push('物件太多,只留前 ' + LIM.objects + ' 個'); ids.__full = 1; } return; }
      var v = validateObject(o, problems); if (!v) { return; }
      if (v.id && ids[v.id]) { v.id = null; } s.objects.push(v); if (v.id) { ids[v.id] = 1; }
    });
    var maxSeq = Number(r.seq) || 0; s.objects.forEach(function (o) { var m = /^o(\d+)$/.exec(o.id || ''); if (m) { maxSeq = Math.max(maxSeq, Number(m[1])); } });
    s.objects.forEach(function (o) { if (!o.id) { do { maxSeq++; } while (ids['o' + maxSeq]); o.id = 'o' + maxSeq; ids[o.id] = 1; } });
    s.seq = maxSeq;
    // parents must be existing groups, no cycles
    var byid = {}; s.objects.forEach(function (o) { byid[o.id] = o; });
    s.objects.forEach(function (o) { if (o.parent && (!byid[o.parent] || byid[o.parent].type !== 'group' || o.parent === o.id)) { o.parent = null; } });
    s.objects.forEach(function (o) { var seen = {}, p = o; while (p && p.parent) { if (seen[p.id]) { o.parent = null; break; } seen[p.id] = 1; p = byid[p.parent]; } });
    return { ok: true, spec: s, problems: problems };
  }
  function byId(spec, id) { for (var i = 0; i < spec.objects.length; i++) { if (spec.objects[i].id === id) { return i; } } return -1; }
  function find(spec, ref) { var i = byId(spec, ref); if (i >= 0) { return i; } var low = String(ref == null ? '' : ref).trim().toLowerCase(); if (!low) { return -1; } for (var k = spec.objects.length - 1; k >= 0; k--) { if (spec.objects[k].name.toLowerCase() === low) { return k; } } return -1; }
  function childrenOf(spec, id) { return spec.objects.filter(function (o) { return o.parent === id; }); }
  function descendants(spec, id) { var out = [], stack = [id]; while (stack.length) { var cur = stack.pop(); childrenOf(spec, cur).forEach(function (c) { out.push(c); stack.push(c.id); }); } return out; }
  function depthOf(spec, o) { var d = 0, p = o, guard = 0; while (p && p.parent && guard++ < 60) { p = spec.objects[byId(spec, p.parent)]; d++; } return d; }
  // the tree in the order the objects view shows it: a parent, then its children (in the order of the list)
  function tree(spec) { var rows = []; function walk(parent, depth) { spec.objects.forEach(function (o) { if ((o.parent || null) === parent) { rows.push({ obj: o, depth: depth }); if (o.type === 'group') { walk(o.id, depth + 1); } } }); } walk(null, 0); return rows; }

  // ───────────────────────── world transforms and boxes ─────────────────────────
  function localT(o) { return { R: rotMat(o.rotation || [0, 0, 0]), t: o.position || [0, 0, 0], s: o.type === 'group' ? (o.scale || 1) : 1 }; }
  function worldT(spec, o) {
    var chain = [], p = o, guard = 0; while (p && guard++ < 60) { chain.unshift(p); p = p.parent ? spec.objects[byId(spec, p.parent)] : null; }
    var W = { R: IDENT, t: [0, 0, 0], s: 1 };
    chain.forEach(function (c) { var L = localT(c); W = { R: mmul(W.R, L.R), t: vadd(mvec(W.R, vmul(L.t, W.s)), W.t), s: W.s * L.s }; });
    return W;
  }
  function parentWorld(spec, o) { return o.parent ? worldT(spec, spec.objects[byId(spec, o.parent)]) : { R: IDENT, t: [0, 0, 0], s: 1 }; }
  // the box of a mesh in its own axes: { c:[x,y,z], h:[hx,hy,hz] }
  function localBox(o) {
    var s;
    switch (o.mesh) {
      case 'box': s = o.size; return { c: [0, 0, 0], h: [s[0] / 2, s[1] / 2, s[2] / 2] };
      case 'sphere': return { c: [0, 0, 0], h: [o.radius, o.radius, o.radius] };
      case 'cylinder': case 'cone': return { c: [0, 0, 0], h: [o.radius, o.height / 2, o.radius] };
      case 'plane': return { c: [0, 0, 0], h: [o.size[0] / 2, o.size[1] / 2, 0.0005] };
      case 'torus': return { c: [0, 0, 0], h: [o.radius + o.tube_radius, o.radius + o.tube_radius, o.tube_radius] };
      case 'polygon': return pointsBox((o.extra && o.extra.vertices) || []);
      case 'line': return o.extra && Array.isArray(o.extra.points) ? pointsBox(o.extra.points) : (o.extra && o.extra.radius ? { c: [0, 0, 0], h: [o.extra.radius, 0.01, o.extra.radius] } : { c: [0, 0, 0], h: [0.1, 0.1, 0.1] });
      default: return { c: [0, 0, 0], h: [0.5, 0.5, 0.5] };
    }
  }
  function pointsBox(pts) { var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; pts.forEach(function (p) { for (var i = 0; i < 3; i++) { var v = Number(p[i]) || 0; mn[i] = Math.min(mn[i], v); mx[i] = Math.max(mx[i], v); } }); if (mn[0] === Infinity) { return { c: [0, 0, 0], h: [0.1, 0.1, 0.1] }; } return { c: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2], h: [(mx[0] - mn[0]) / 2, (mx[1] - mn[1]) / 2, (mx[2] - mn[2]) / 2] }; }
  function boxOfCorners(corners) { var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; corners.forEach(function (p) { for (var i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); } }); return { min: mn, max: mx, center: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2], half: [(mx[0] - mn[0]) / 2, (mx[1] - mn[1]) / 2, (mx[2] - mn[2]) / 2] }; }
  function cornersOf(lb) { var out = [], a, b, c; for (a = -1; a <= 1; a += 2) { for (b = -1; b <= 1; b += 2) { for (c = -1; c <= 1; c += 2) { out.push([lb.c[0] + a * lb.h[0], lb.c[1] + b * lb.h[1], lb.c[2] + c * lb.h[2]]); } } } return out; }
  // the box of an object (a group: of everything in it) in the world: { min, max, center, half } or null
  function worldBox(spec, o) {
    if (o.type === 'light') { var wl = worldT(spec, o); return boxOfCorners([wl.t]); }
    if (o.type === 'group') { var kids = descendants(spec, o.id).filter(function (c) { return c.type === 'mesh' && c.visible; }), pts = []; kids.forEach(function (c) { var b = worldBox(spec, c); if (b) { pts.push(b.min, b.max); } }); return pts.length ? boxOfCorners(pts) : boxOfCorners([worldT(spec, o).t]); }
    var W = worldT(spec, o), lb = localBox(o); return boxOfCorners(cornersOf(lb).map(function (p) { return vadd(mvec(W.R, vmul(p, W.s)), W.t); }));
  }
  function bounds(spec) { var pts = []; spec.objects.forEach(function (o) { if (o.type === 'mesh' && o.visible) { var b = worldBox(spec, o); if (b) { pts.push(b.min, b.max); } } }); return pts.length ? boxOfCorners(pts) : null; }

  // ───────────────────────── the user's view: "me", forward, right ─────────────────────────
  function frameOf(spec, env) {
    var v = env && env.view && Array.isArray(env.view.position) && Array.isArray(env.view.target) ? env.view : { position: spec.camera.position, target: spec.camera.look_at };
    var pos = vec(v.position, [5, 4, 7], -1e6, 1e6), tgt = vec(v.target, [0, 0, 0], -1e6, 1e6), f = vnorm([tgt[0] - pos[0], 0, tgt[2] - pos[2]]);
    if (vlen(f) < 1e-6) { f = vnorm([-pos[0] + 0.0001, 0, -pos[2] - 1]); if (vlen(f) < 1e-6) { f = [0, 0, -1]; } }
    var right = [-f[2], 0, f[0]], hd = Math.sqrt((tgt[0] - pos[0]) * (tgt[0] - pos[0]) + (tgt[2] - pos[2]) * (tgt[2] - pos[2]));
    return { pos: pos, target: tgt, forward: f, right: right, hdist: hd < 0.01 ? 5 : hd };
  }
  var DIRS = { front: [1, 0], back: [-1, 0], left: [0, -1], right: [0, 1], 'left-front': [1, -1], 'right-front': [1, 1], 'left-back': [-1, -1], 'right-back': [-1, 1], beside: [0, 1] };   // [forward, right]
  function dirVec(F, rel) { var d = DIRS[rel]; if (!d) { return null; } return vnorm(vadd(vmul(F.forward, d[0]), vmul(F.right, d[1]))); }
  var REL_ALIASES = { ahead: 'front', forward: 'front', behind: 'back', 'front-left': 'left-front', 'front-right': 'right-front', 'back-left': 'left-back', 'back-right': 'right-back', up: 'above', top: 'above', over: 'above', down: 'below', under: 'below', next: 'beside', near: 'beside', middle: 'center', in: 'inside' };
  function refBox(spec, ref, env) {
    if (ref === 'selection') { ref = env && env.selection; if (!ref) { return { error: '沒有選取任何物件' }; } }
    var i = find(spec, ref); if (i < 0) { return { error: '找不到物件 "' + str(ref, 30) + '"' }; } var b = worldBox(spec, spec.objects[i]); return b ? { box: b, obj: spec.objects[i] } : { error: '物件 "' + str(ref, 30) + '" 沒有位置' };
  }
  // where the box (half extents `half`, centre now at `cur`) has to be to sit at `place` -> { center } | { error }; `skipId` = the object itself (it does not block its own place)
  function resolvePlace(spec, half, place, env, skipId) {
    place = place && typeof place === 'object' ? place : {}; var F = frameOf(spec, env), rel = String(place.rel || '').toLowerCase(); rel = REL_ALIASES[rel] || rel; if (rel && !DIRS[rel] && ['above', 'on', 'below', 'inside', 'center'].indexOf(rel) < 0) { return { error: '不認得的位置 "' + str(place.rel, 20) + '"(front/back/left/right/left-front/right-front/left-back/right-back/above/on/below/inside/center/beside)' }; } var of = place.of == null || place.of === '' ? null : String(place.of), gap = place.gap == null ? 0.05 : num(place.gap, 0, 1000, 0.05), c;
    if (!of) { of = (rel === 'center' || !rel) ? 'view' : (DIRS[rel] ? 'me' : null); if (!of && (rel === 'above' || rel === 'on' || rel === 'below' || rel === 'inside')) { of = 'selection'; } if (!of) { of = 'view'; } }
    var ofl = of.toLowerCase();
    if (ofl === 'me' || ofl === 'view' || ofl === 'origin' || ofl === 'ground' || ofl === 'scene') {
      var base, grounded = true;
      if (ofl === 'me') { base = [F.pos[0], 0, F.pos[2]]; } else if (ofl === 'view') { base = [F.target[0], 0, F.target[2]]; } else if (ofl === 'scene') { var bb = bounds(spec); base = bb ? [bb.center[0], 0, bb.center[2]] : [0, 0, 0]; } else { base = [0, 0, 0]; }
      var dist = place.dist != null ? num(place.dist, 0, 5000, 2) : (ofl === 'me' ? Math.max(1.5, Math.min(10, 0.6 * F.hdist)) : (ofl === 'view' ? (DIRS[rel] ? Math.max(1.2, Math.min(6, 0.25 * F.hdist)) : 0) : 0)), dv = DIRS[rel] ? dirVec(F, rel) : [0, 0, 0];
      if (rel === 'above' || rel === 'below') { dv = [0, 0, 0]; }
      c = [base[0] + dv[0] * dist, grounded ? half[1] : 0, base[2] + dv[2] * dist];
      if (rel === 'above') { c[1] = half[1] + (place.dist != null ? num(place.dist, 0, 5000, 2) : 2); }
      if (place.auto && ofl === 'view') {   // the middle of the view: do not stack on what is already there, step to the user's right
        for (var tries = 0; tries < 8; tries++) { var blocked = spec.objects.some(function (o) { if (o.type !== 'mesh' || !o.visible || o.id === skipId) { return false; } var b = worldBox(spec, o); return b && Math.abs(b.center[0] - c[0]) < b.half[0] + half[0] - 1e-6 && Math.abs(b.center[2] - c[2]) < b.half[2] + half[2] - 1e-6 && b.min[1] < c[1] + half[1] - 1e-6 && b.max[1] > c[1] - half[1] + 1e-6; }); if (!blocked) { break; } c = vadd(c, vmul(F.right, half[0] * 2 + 0.2)); }
      }
    } else {
      var rb = refBox(spec, of, env); if (rb.error) { return { error: rb.error }; } var B = rb.box;
      if (rel === 'above' || rel === 'on') { c = [B.center[0], B.max[1] + half[1] + (place.gap == null ? 0 : gap), B.center[2]]; }
      else if (rel === 'below') { c = [B.center[0], B.min[1] - half[1] - gap, B.center[2]]; }
      else if (rel === 'inside' || rel === 'center' || !rel) { c = B.center.slice(); }
      else if (DIRS[rel]) { var d = dirVec(F, rel), ext = Math.abs(d[0]) * B.half[0] + Math.abs(d[2]) * B.half[2], mine = Math.abs(d[0]) * half[0] + Math.abs(d[2]) * half[2], dd = ext + mine + gap + (place.dist != null ? num(place.dist, 0, 5000, 0) : 0); c = [B.center[0] + d[0] * dd, B.min[1] + half[1], B.center[2] + d[2] * dd]; }
      else { return { error: '不認得的位置 "' + str(place.rel, 20) + '"' }; }
    }
    if (place.dx || place.dy || place.dz) { c = vadd(c, vadd(vadd(vmul(F.right, num(place.dx, -1e5, 1e5, 0)), [0, num(place.dy, -1e5, 1e5, 0), 0]), vmul(F.forward, num(place.dz, -1e5, 1e5, 0)))); }
    return { center: [r3(c[0]), r3(c[1]), r3(c[2])] };
  }

  // ───────────────────────── applying edits ─────────────────────────
  function nameFor(spec, base) { var names = {}; spec.objects.forEach(function (o) { names[o.name] = 1; }); if (!names[base]) { return base; } for (var n = 2; n < 500; n++) { if (!names[base + ' ' + n]) { return base + ' ' + n; } } return base; }
  function nextId(spec) { var id; do { spec.seq++; id = 'o' + spec.seq; } while (byId(spec, id) >= 0); return id; }
  function moveBy(spec, o, delta) { if (o.parent) { var P = parentWorld(spec, o), l = mvec(mT(P.R), vmul(delta, 1 / P.s)); o.position = [r3(o.position[0] + l[0]), r3(o.position[1] + l[1]), r3(o.position[2] + l[2])]; } else { o.position = [r3(o.position[0] + delta[0]), r3(o.position[1] + delta[1]), r3(o.position[2] + delta[2])]; } }
  function moveToCenter(spec, o, center) { var b = worldBox(spec, o); if (!b) { return; } moveBy(spec, o, vsub(center, b.center)); }
  function placeOf(spec, o, place, env) { var b = worldBox(spec, o), half = b ? b.half : [0.5, 0.5, 0.5], r = resolvePlace(spec, half, place, env, o.id); if (r.error) { return r; } moveToCenter(spec, o, r.center); return {}; }
  function meshesIn(spec, o) { return o.type === 'mesh' ? [o] : o.type === 'group' ? descendants(spec, o.id).filter(function (c) { return c.type === 'mesh'; }) : []; }
  function scaleMesh(o, f) { if (o.size) { o.size = o.size.map(function (v) { return r3(Math.max(0.001, v * f)); }); } ['radius', 'height', 'tube_radius'].forEach(function (k) { if (o[k] != null) { o[k] = r3(Math.max(0.001, o[k] * f)); } }); if (o.extra && Array.isArray(o.extra.vertices)) { o.extra.vertices = o.extra.vertices.map(function (v) { return [r3(v[0] * f), r3(v[1] * f), r3(v[2] * f)]; }); } if (o.extra && Array.isArray(o.extra.points)) { o.extra.points = o.extra.points.map(function (v) { return v.map(function (x) { return r3(Number(x) * f); }); }); } if (o.extra && o.extra.radius) { o.extra.radius = r3(o.extra.radius * f); } }
  function resolveId(spec, ref, env) { if (ref === 'selection' || ref === 'it' || ref === 'selected') { ref = env && env.selection; } if (ref == null || ref === '') { ref = env && env.selection; } var i = find(spec, ref); return i; }
  function hasName(o) { return o && typeof o.name === 'string'; }
  function newObjectFrom(spec, raw, problems) {
    var v = validateObject(raw, problems); if (!v) { return null; }
    var shape = v.type === 'mesh' ? v.mesh : v.type; v.id = nextId(spec); if (!raw.name) { var cw = v.type === 'mesh' && v.material && raw.material && raw.material.color ? colorWord(v.material.color) : ''; v.name = nameFor(spec, (cw ? cw : '') + (v.type === 'mesh' ? MESHES[v.mesh] : v.type === 'group' ? '群組' : '燈光')); } else { v.name = nameFor(spec, v.name); }
    return v;
  }
  var COLOR_WORDS = [['紅', '#e53935'], ['橙', '#fb8c00'], ['黃', '#fdd835'], ['綠', '#43a047'], ['藍', '#1e88e5'], ['紫', '#8e24aa'], ['粉紅', '#f48fb1'], ['白', '#f5f5f5'], ['黑', '#212121'], ['灰', '#9e9e9e'], ['棕', '#795548'], ['金', '#d4af37'], ['銀', '#c0c0c0']];
  function hexRgb(h) { h = String(h || '').replace('#', ''); if (h.length === 3) { h = h.replace(/(.)/g, '$1$1'); } if (!/^[0-9a-fA-F]{6}/.test(h)) { return null; } return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function colorWord(hex) { var rgb = hexRgb(hex); if (!rgb) { return ''; } var best = '', bd = 1e9; COLOR_WORDS.forEach(function (c) { var q = hexRgb(c[1]), d = (rgb[0] - q[0]) * (rgb[0] - q[0]) + (rgb[1] - q[1]) * (rgb[1] - q[1]) + (rgb[2] - q[2]) * (rgb[2] - q[2]); if (d < bd) { bd = d; best = c[0]; } }); return bd < 9000 ? best + '色' : ''; }

  var OPFN = {
    set_title: function (s, e) { s.title = str(e.text, LIM.title).trim() || s.title; return {}; },
    set_background: function (s, e) { var c = color(e.color || e.background, ''); if (!c) { return { error: '不認得這個顏色' }; } s.background = c; return {}; },
    set_camera: function (s, e) {
      var cam = clone(s.camera);
      if (e.preset) {
        var b = bounds(s) || { center: [0, 0.5, 0], half: [1, 1, 1] }, R = Math.max(1.5, vlen(b.half)) * 2.6, c = b.center, p = ({ front: [0, 0.3, 1], back: [0, 0.3, -1], left: [-1, 0.3, 0], right: [1, 0.3, 0], top: [0.001, 1, 0.001], iso: [0.7, 0.6, 0.9] })[String(e.preset)];
        if (!p) { return { error: '視角 "' + str(e.preset, 20) + '" 不認得(front/back/left/right/top/iso)' }; } var pv = vmul(vnorm(p), R); cam.position = [r3(c[0] + pv[0]), r3(c[1] + pv[1]), r3(c[2] + pv[2])]; cam.look_at = [r3(c[0]), r3(c[1]), r3(c[2])];
      }
      if (e.position) { cam.position = vec(e.position, cam.position, -5000, 5000); } if (e.look_at) { cam.look_at = vec(e.look_at, cam.look_at, -5000, 5000); } if (e.fov != null) { cam.fov = num(e.fov, 10, 120, cam.fov); }
      if (e.zoom != null) { var k = num(e.zoom, 0.05, 20, 1), dv = vsub(cam.position, cam.look_at); cam.position = vadd(cam.look_at, vmul(dv, 1 / k)); cam.position = [r3(cam.position[0]), r3(cam.position[1]), r3(cam.position[2])]; }
      s.camera = cameraOf(cam, s.camera); return {};
    },
    // 整個場景換成另一份（成功範例當起點用）：{op:'replace_scene', spec}，spec 要先過檢查；標題保留目前的
    replace_scene: function (s, e) {
      if (!e.spec || typeof e.spec !== 'object') { return { error: 'replace_scene 要有 spec' }; } var v = validate(e.spec).spec; if (!v.objects.length) { return { error: '範例是空的' }; }
      s.objects = v.objects; s.background = v.background; s.camera = v.camera; s.seq = v.seq; return {};
    },
    // 內建模型庫的東西：{op:'add_model', model:'teapot', name?, height?, color?, place?}（沒有這個模型就回錯誤，說明有哪些）
    add_model: function (s, e, env, st) {
      var id = String(e.model || e.name || '').toLowerCase(), hit = (MG && (MG.info(id) || MG.find(id))) || null; if (!hit) { return { error: '沒有內建模型「' + str(id, 20) + '」（有：' + (MG ? MG.CATALOG.map(function (c) { return c.id + '=' + c.label; }).join('、') : '無') + '）；改用基本圖元組合，或 mesh:"polygon" 自己給 vertices／faces' }; }
      var obj = modelObject(hit.id, { name: e.name && e.name !== e.model ? str(e.name, 40) : '', color: e.color || (e.material && e.material.color), height: e.height }); if (!obj) { return { error: '產生不出模型' }; }
      return OPFN.add_object(s, { op: 'add_object', object: obj, place: e.place, parent: e.parent }, env, st);
    },
    add_object: function (s, e, env, st) {
      if (s.objects.length >= LIM.objects) { return { error: '物件太多了' }; } var raw = e.object && typeof e.object === 'object' ? clone(e.object) : null; if (!raw) { return { error: 'add_object 要有 object' }; }
      if (e.parent != null && !raw.parent) { raw.parent = e.parent; } if (raw.parent) { var pi = find(s, raw.parent); raw.parent = pi >= 0 && s.objects[pi].type === 'group' ? s.objects[pi].id : null; }
      var probs = [], o = newObjectFrom(s, raw, probs); if (!o) { return { error: probs[0] || '這個物件不合法' }; } o.parent = raw.parent || null; s.objects.push(o);
      var hasPos = Array.isArray(raw.position), place = e.place || (raw.place && typeof raw.place === 'object' ? raw.place : null);
      if (place || !hasPos) { var pr = placeOf(s, o, place || { of: 'view', rel: 'center', auto: true }, env); if (pr.error) { s.objects.pop(); s.seq--; return pr; } if (o.type === 'light' && !(place && place.dy != null)) { var lb = worldBox(s, o); if (lb && o.light !== 'ambient' && lb.center[1] < 1) { moveBy(s, o, [0, 3 - lb.center[1], 0]); } } }
      st.added.push(o.id); return {};
    },
    update_object: function (s, e, env) {
      var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var o = s.objects[i], p = e.props && typeof e.props === 'object' ? e.props : {}, raw = clone(o);
      Object.keys(p).forEach(function (k) {
        if (k === 'material' && p.material && typeof p.material === 'object') { raw.material = Object.assign({}, raw.material || {}, p.material); }
        else if (k === 'color' && o.type === 'mesh') { raw.material = Object.assign({}, raw.material || {}, { color: p.color }); }
        else if (k === 'rotation_deg' && Array.isArray(p.rotation_deg)) { raw.rotation = p.rotation_deg.map(function (d) { return Number(d) * PI / 180; }); }
        else if (k !== 'id' && k !== 'type' && k !== 'mesh' && k !== 'parent' && k !== 'skins') { raw[k] = p[k]; }
      });
      var probs = [], v = validateObject(raw, probs); if (!v) { return { error: probs[0] || '改完之後物件不合法' }; } v.id = o.id; v.parent = o.parent; s.objects[i] = v; return {};
    },
    remove_object: function (s, e, env) { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var gone = {}; gone[s.objects[i].id] = 1; descendants(s, s.objects[i].id).forEach(function (c) { gone[c.id] = 1; }); s.objects = s.objects.filter(function (o) { return !gone[o.id]; }); return {}; },
    rename_object: function (s, e, env) { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var n = str(e.name, LIM.name).trim(); if (!n) { return { error: '名字是空的' }; } s.objects[i].name = n; return {}; },
    move_object: function (s, e, env) {
      var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var o = s.objects[i], to = e.to, sib = s.objects.filter(function (x) { return (x.parent || null) === (o.parent || null); }), k = sib.indexOf(o), nk;
      if (to === 'up' || to === 'earlier') { nk = k - 1; } else if (to === 'down' || to === 'later') { nk = k + 1; } else if (to === 'front' || to === 'first') { nk = 0; } else if (to === 'back' || to === 'last') { nk = sib.length - 1; } else if (isFinite(Number(to))) { nk = Math.round(Number(to)); } else { return { error: 'to 要是 up/down/earlier/later/first/last 或數字' }; }
      nk = Math.max(0, Math.min(sib.length - 1, nk)); if (nk === k) { return { error: '已經在最' + (nk === 0 ? '前' : '後') + '面了' }; }
      var tgt = sib[nk], cut = s.objects.indexOf(o); s.objects.splice(cut, 1); var at = s.objects.indexOf(tgt); if (nk > k) { var tail = [tgt].concat(descendants(s, tgt.id)), last = tail.reduce(function (m, x) { return Math.max(m, s.objects.indexOf(x)); }, at); at = last + 1; } s.objects.splice(at, 0, o); var kids = descendants(s, o.id); if (kids.length) { s.objects = s.objects.filter(function (x) { return kids.indexOf(x) < 0; }); s.objects.splice.apply(s.objects, [s.objects.indexOf(o) + 1, 0].concat(kids)); } return {};
    },
    set_visible: function (s, e, env) { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } s.objects[i].visible = e.visible !== false; return {}; },
    set_locked: function (s, e, env) { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } s.objects[i].locked = !!e.locked; return {}; },
    duplicate_object: function (s, e, env, st) {
      var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var o = s.objects[i], list = [o].concat(descendants(s, o.id)), map = {};
      if (s.objects.length + list.length > LIM.objects) { return { error: '物件太多了' }; } var copies = [];
      list.forEach(function (x) { var c = clone(x); map[x.id] = nextId(s); c.id = map[x.id]; c.name = x === o ? nameFor(s, x.name) : x.name; copies.push(c); });
      copies.forEach(function (c) { if (c.parent && map[c.parent]) { c.parent = map[c.parent]; } }); var at = s.objects.indexOf(list[list.length - 1]) + 1; s.objects.splice.apply(s.objects, [at, 0].concat(copies));
      var F = frameOf(s, env), b = worldBox(s, o), w = b ? 2 * Math.abs(F.right[0]) * b.half[0] + 2 * Math.abs(F.right[2]) * b.half[2] : 1; moveBy(s, copies[0], e.place ? [0, 0, 0] : vmul(F.right, w + 0.15)); if (e.place) { var pr = placeOf(s, copies[0], e.place, env); if (pr.error) { return pr; } } st.added.push(copies[0].id); return {};
    },
    clear_objects: function (s) { s.objects = []; return {}; },
    place_object: function (s, e, env) { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } if (!e.place) { return { error: 'place_object 要有 place' }; } return placeOf(s, s.objects[i], e.place, env); },
    transform_object: function (s, e, env) {
      var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var o = s.objects[i], F = frameOf(s, env), done = false;
      if (Array.isArray(e.move)) { var m = vec(e.move, [0, 0, 0], -1e5, 1e5); moveBy(s, o, vadd(vadd(vmul(F.right, m[0]), [0, m[1], 0]), vmul(F.forward, m[2]))); done = true; }
      if (Array.isArray(e.move_world)) { moveBy(s, o, vec(e.move_world, [0, 0, 0], -1e5, 1e5)); done = true; }
      if (e.turn != null || e.tilt != null || e.roll != null) { var rot = (o.rotation || [0, 0, 0]).slice(); rot[1] = r3(rot[1] + num(e.turn, -3600, 3600, 0) * PI / 180); rot[0] = r3(rot[0] + num(e.tilt, -3600, 3600, 0) * PI / 180); rot[2] = r3(rot[2] + num(e.roll, -3600, 3600, 0) * PI / 180); if (o.type !== 'light') { o.rotation = rot; done = true; } }
      if (Array.isArray(e.rotate_deg)) { if (o.type !== 'light') { o.rotation = vec(e.rotate_deg.map(function (d) { return Number(d) * PI / 180; }), [0, 0, 0], -100, 100); done = true; } }
      if (e.scale != null) { var f = num(e.scale, 0.01, 100, 1); if (o.type === 'group') { o.scale = r3(Math.max(0.001, o.scale * f)); } else if (o.type === 'mesh') { var b0 = worldBox(s, o), bot = b0 ? b0.min[1] : null; scaleMesh(o, f); if (e.keep_bottom !== false && b0 && bot != null && Math.abs(bot) < 1e-6) { var b1 = worldBox(s, o); if (b1) { moveBy(s, o, [0, bot - b1.min[1], 0]); } } } else if (o.type === 'light') { o.intensity = r3(num(o.intensity * f, 0, 100, o.intensity)); } done = true; }
      return done ? {} : { error: 'transform_object 要有 move/move_world/turn/tilt/roll/rotate_deg/scale 其中之一' };
    },
    ungroup: function (s, e, env) {
      var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var g = s.objects[i]; if (g.type !== 'group') { return { error: '「' + g.name + '」不是群組' }; }
      var P = worldT(s, g), parentId = g.parent || null; childrenOf(s, g.id).forEach(function (c) { var L = localT(c), R = mmul(P.R, L.R), pos = vadd(mvec(P.R, vmul(c.position, g.scale)), g.position); if (c.type === 'mesh') { scaleMesh(c, g.scale); } if (c.type === 'group') { c.scale = r3(c.scale * g.scale); } c.position = vec(pos, [0, 0, 0]); c.rotation = matEuler(R); c.parent = parentId; });
      s.objects.splice(i, 1); return {};
    },
    set_parent: function (s, e, env) {
      var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var o = s.objects[i], np = null;
      if (e.parent != null && e.parent !== '') { var pi = find(s, e.parent); if (pi < 0 || s.objects[pi].type !== 'group') { return { error: '找不到群組 "' + str(e.parent, 30) + '"' }; } if (s.objects[pi] === o || descendants(s, o.id).indexOf(s.objects[pi]) >= 0) { return { error: '不能放進自己裡面' }; } np = s.objects[pi].id; }
      var W = worldT(s, o); o.parent = np; var P = np ? worldT(s, s.objects[byId(s, np)]) : { R: IDENT, t: [0, 0, 0], s: 1 };
      if (o.type !== 'light' || true) { o.position = vec(mvec(mT(P.R), vmul(vsub(W.t, P.t), 1 / P.s)), [0, 0, 0]); } if (o.type !== 'light') { o.rotation = matEuler(mmul(mT(P.R), W.R)); }
      if (o.type === 'mesh' && Math.abs(W.s / P.s - 1) > 1e-6) { /* a mesh's own size already includes everything above it */ scaleMesh(o, (W.s / P.s)); } if (o.type === 'group') { o.scale = r3(Math.max(0.001, W.s / P.s)); }
      var kids = [o].concat(descendants(s, o.id)); s.objects = s.objects.filter(function (x) { return kids.indexOf(x) < 0; }); var at = np ? s.objects.indexOf(s.objects[byId(s, np)]) + 1 + descendants(s, np).length : s.objects.length; s.objects.splice.apply(s.objects, [at, 0].concat(kids)); return {};
    },
    set_material: function (s, e, env) {
      var targets = []; if (e.id === 'all') { targets = s.objects.filter(function (o) { return o.type === 'mesh'; }); } else { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } targets = meshesIn(s, s.objects[i]); }
      if (!targets.length) { return { error: '這個物件沒有表面可以上色' }; } var m = {}; MATERIAL_KEYS.forEach(function (k) { if (e[k] !== undefined) { m[k] = e[k]; } }); if (e.material && typeof e.material === 'object') { Object.assign(m, e.material); }
      if (!Object.keys(m).length) { return { error: 'set_material 要有 color/metalness/roughness/opacity/emissive/texture/texture_repeat/side 其中之一' }; }
      if (m.color != null && !color(m.color, '')) { return { error: '不認得這個顏色 "' + str(m.color, 20) + '"' }; } if (m.texture != null && m.texture !== '' && !texture(m.texture)) { return { error: '貼圖要是 water/grass/sand/wood/brick、ref:… 或圖片網址' }; }
      targets.forEach(function (o) { var cur = Object.assign({}, o.material); Object.keys(m).forEach(function (k) { if ((k === 'texture' && (m[k] === '' || m[k] === null)) || (k === 'texture_repeat' && m[k] === null)) { delete cur[k]; } else if (k === 'opacity' && Number(m[k]) >= 1) { delete cur.opacity; } else if (k === 'emissive' && !m[k]) { delete cur.emissive; delete cur.emissive_intensity; } else { cur[k] = m[k]; } }); o.material = material(cur, {}); }); return {};
    },
    add_skin: function (s, e, env, st) { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var o = s.objects[i]; if (o.type !== 'mesh' || !zonesOf(o.mesh).length) { return { error: '「' + o.name + '」這種形狀不能貼皮(要是方塊、圓柱、圓錐、球、圓環或平面)' }; } var cur = o.skins || [], seq = 1; cur.forEach(function (k) { seq = Math.max(seq, Number(String(k.id).slice(1)) + 1); }); var k = skin(Object.assign({}, e.skin || {}, { id: 'k' + seq }), o.mesh, seq); if (!k) { return { error: '貼皮要有 image(貼圖)或 color(顏色)' }; } if (cur.length >= LIM.skins) { return { error: '貼皮太多了' }; } o.skins = cur.concat([k]); st.skin = k.id; return {}; },
    update_skin: function (s, e, env) { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var o = s.objects[i], list = o.skins || [], j = -1; list.forEach(function (k, n) { if (k.id === e.skin_id) { j = n; } }); if (j < 0) { return { error: '找不到貼皮 "' + str(e.skin_id, 20) + '"' }; } var k = skin(Object.assign({}, list[j], e.props || {}, { id: list[j].id }), o.mesh, 1); if (!k) { return { error: '貼皮要有 image(貼圖)或 color(顏色)' }; } list[j] = k; o.skins = list; return {}; },
    remove_skin: function (s, e, env) { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var o = s.objects[i], n0 = (o.skins || []).length; o.skins = (o.skins || []).filter(function (k) { return k.id !== e.skin_id; }); if (o.skins.length === n0) { return { error: '找不到貼皮 "' + str(e.skin_id, 20) + '"' }; } if (!o.skins.length) { delete o.skins; } return {}; },
    clear_skins: function (s, e, env) { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } delete s.objects[i].skins; return {}; },
    set_skins: function (s, e, env) { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var o = s.objects[i]; if (o.type !== 'mesh') { return { error: '只有形狀可以貼皮' }; } var list = skins(e.skins, o.mesh); if (list.length) { o.skins = list; } else { delete o.skins; } if (e.material && typeof e.material === 'object') { o.material = material(Object.assign({}, o.material, e.material), {}); } return {}; },
    drop_to_ground: function (s, e, env) { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到物件 "' + str(e.id, 30) + '"' }; } var b = worldBox(s, s.objects[i]); if (!b) { return { error: '沒有位置' }; } moveBy(s, s.objects[i], [0, -b.min[1], 0]); return {}; },
    align_objects: function (s, e, env) {
      var objs = (Array.isArray(e.ids) ? e.ids : []).map(function (x) { return resolveId(s, x, env); }).filter(function (i) { return i >= 0; }).map(function (i) { return s.objects[i]; }), ax = { x: 0, y: 1, z: 2 }[String(e.axis || '').toLowerCase()], to = String(e.to || 'center');
      if (objs.length < 2 || ax == null) { return { error: 'align_objects 要有 2 個以上的 ids 與 axis(x/y/z)' }; } var boxes = objs.map(function (o) { return worldBox(s, o); });
      var key = function (b) { return to === 'min' ? b.min[ax] : to === 'max' ? b.max[ax] : b.center[ax]; }, target = to === 'min' ? Math.min.apply(null, boxes.map(key)) : to === 'max' ? Math.max.apply(null, boxes.map(key)) : (Math.min.apply(null, boxes.map(function (b) { return b.min[ax]; })) + Math.max.apply(null, boxes.map(function (b) { return b.max[ax]; }))) / 2;
      objs.forEach(function (o, k) { var d = [0, 0, 0]; d[ax] = target - key(boxes[k]); moveBy(s, o, d); }); return {};
    }
  };
  function applyEdits(spec, edits, env) {
    var s = validate(clone(spec)).spec, applied = [], appliedEdits = [], rejected = [], st = { added: [] }; env = env || {};
    (Array.isArray(edits) ? edits : []).forEach(function (e) {
      if (!e || typeof e !== 'object' || OPS.indexOf(e.op) < 0) { rejected.push({ op: str(e && e.op, 30) || '?', error: HOST_OPS.indexOf(e && e.op) >= 0 ? '這個動作要由宿主執行(找圖、生圖)' : '不是可以做的動作' }); return; }
      var before = clone(s), r;
      try { r = e.op === 'group_objects' ? groupImpl(s, e, env) : OPFN[e.op](s, e, env, st); } catch (x) { r = { error: String((x && x.message) || x) }; }
      if (r && r.error) { s.objects = before.objects; s.seq = Math.max(s.seq, before.seq); s.title = before.title; s.background = before.background; s.camera = before.camera; rejected.push({ op: e.op, error: r.error }); return; }
      applied.push(e.op); appliedEdits.push(e);
    });
    var res = validate(s); return { spec: res.spec, applied: applied, appliedEdits: appliedEdits, rejected: rejected, added: st.added.filter(function (id) { return byId(res.spec, id) >= 0; }) };
  }
  // group_objects needs the whole list (the grouped objects keep their world places): done here, on the spec itself
  function groupImpl(s, e, env) {
    var ids = (Array.isArray(e.ids) ? e.ids : []).map(function (x) { return resolveId(s, x, env); }).filter(function (i) { return i >= 0; }), uniq = []; ids.forEach(function (i) { if (uniq.indexOf(i) < 0) { uniq.push(i); } });
    if (!uniq.length) { return { error: 'group_objects 要有 ids(要綁在一起的物件)' }; } var objs = uniq.map(function (i) { return s.objects[i]; }), par = objs[0].parent || null;
    if (objs.some(function (o) { return (o.parent || null) !== par; })) { return { error: '要綁在一起的物件必須在同一層' }; } if (objs.some(function (o) { return objs.some(function (q) { return q !== o && descendants(s, q.id).indexOf(o) >= 0; }); })) { return { error: '不能把群組跟它裡面的東西一起綁' }; }
    var pts = []; objs.forEach(function (o) { var b = worldBox(s, o); if (b) { pts.push(b.min, b.max); } }); var bb = pts.length ? boxOfCorners(pts) : { center: [0, 0, 0], min: [0, 0, 0] }, pivotW = [bb.center[0], bb.min[1], bb.center[2]];
    var P = par ? worldT(s, s.objects[byId(s, par)]) : { R: IDENT, t: [0, 0, 0], s: 1 }, pivotL = par ? mvec(mT(P.R), vmul(vsub(pivotW, P.t), 1 / P.s)) : pivotW;
    var g = { type: 'group', id: nextId(s), name: nameFor(s, str(e.name, LIM.name).trim() || '群組'), parent: par, visible: true, locked: false, position: [r3(pivotL[0]), r3(pivotL[1]), r3(pivotL[2])], rotation: [0, 0, 0], scale: 1 };
    var block = []; objs.forEach(function (o) { block.push(o); descendants(s, o.id).forEach(function (c) { block.push(c); }); });
    var at = Math.min.apply(null, block.map(function (o) { return s.objects.indexOf(o); })); s.objects = s.objects.filter(function (o) { return block.indexOf(o) < 0; });
    // the children now live under g (no rotation, scale 1): their local positions are relative to its pivot
    objs.forEach(function (o) { o.parent = g.id; o.position = [r3(o.position[0] - g.position[0]), r3(o.position[1] - g.position[1]), r3(o.position[2] - g.position[2])]; });
    s.objects.splice.apply(s.objects, [Math.min(at, s.objects.length), 0, g].concat(block)); return {};
  }
  OPFN.group_objects = function (s, e, env) { return groupImpl(s, e, env); };

  function editWords(e) {
    if (!e) { return ''; } var id = e.id ? (' ' + str(e.id, 30)) : '';
    switch (e.op) {
      case 'set_title': return '標題改成「' + str(e.text, 40) + '」'; case 'set_background': return '背景 ' + str(e.color || e.background, 20); case 'set_camera': return '調整視角';
      case 'replace_scene': return '用範例的場景當起點（' + ((e.spec && e.spec.objects && e.spec.objects.length) || 0) + ' 個物件）';
      case 'add_model': { var mi = MG && (MG.info(String(e.model || '').toLowerCase()) || MG.find(String(e.model || ''))); return '新增模型「' + (e.name || (mi && mi.label) || str(e.model, 20)) + '」' + (e.place ? '（' + placeWords(e.place) + '）' : ''); }
      case 'add_object': { var o = e.object || {}; return '新增' + (o.name ? ' ' + str(o.name, 30) : (o.type === 'light' ? '燈光' : o.type === 'group' ? '群組' : (MESHES[o.mesh] || '物件'))) + (e.place ? '（' + placeWords(e.place) + '）' : ''); }
      case 'update_object': return '修改物件' + id; case 'remove_object': return '刪掉物件' + id; case 'rename_object': return str(e.id, 30) + ' 改名為 ' + str(e.name, 30);
      case 'move_object': return '調整' + id + ' 的順序'; case 'set_visible': return (e.visible === false ? '隱藏' : '顯示') + id; case 'set_locked': return (e.locked ? '鎖定' : '解鎖') + id; case 'duplicate_object': return '複製' + id;
      case 'clear_objects': return '清空場景'; case 'place_object': return '把' + id + ' 放到（' + placeWords(e.place) + '）'; case 'transform_object': return '變形' + id;
      case 'group_objects': return '把 ' + (e.ids || []).join('、') + ' 綁成群組'; case 'ungroup': return '解散群組' + id; case 'set_parent': return str(e.id, 30) + ' 放進群組 ' + str(e.parent, 30);
      case 'set_material': return '改' + id + ' 的材質'; case 'add_skin': return '替' + id + ' 貼皮'; case 'update_skin': return '修改' + id + ' 的貼皮'; case 'remove_skin': return '拿掉' + id + ' 的貼皮'; case 'clear_skins': return '清掉' + id + ' 的貼皮'; case 'set_skins': return '編輯' + id + ' 的貼皮';
      case 'drop_to_ground': return id + ' 放到地上'; case 'align_objects': return '對齊物件'; default: return e.op;
    }
  }
  var REL_WORDS = { front: '前方', back: '後方', left: '左邊', right: '右邊', 'left-front': '左前方', 'right-front': '右前方', 'left-back': '左後方', 'right-back': '右後方', above: '上面', on: '上面', below: '下面', inside: '裡面', center: '中間', beside: '旁邊' };
  function placeWords(p) { p = p || {}; var rel = REL_ALIASES[String(p.rel || '').toLowerCase()] || p.rel || 'center', of = p.of == null ? '' : String(p.of), who = of === 'me' || !of && DIRS[rel] ? '我的' : of === 'view' || !of ? '畫面' : of === 'selection' ? '選取的物件' : str(of, 20); return who + (REL_WORDS[rel] || str(rel, 12)); }
  function describeObject(o) {
    var f = function (v) { return '[' + v.map(function (x) { return Math.round(x * 100) / 100; }).join(',') + ']'; };
    if (o.type === 'group') { return '群組 @' + f(o.position) + (o.scale !== 1 ? ' ×' + o.scale : ''); } if (o.type === 'light') { return o.light + '燈 ' + (o.light === 'ambient' ? '' : '@' + f(o.position) + ' ') + '強度' + o.intensity; }
    var dim = o.size ? ' ' + f(o.size) : (o.radius != null ? ' r' + o.radius + (o.height != null ? ' h' + o.height : '') : ''); return o.mesh + dim + ' @' + f(o.position) + ' ' + (o.material && o.material.color || '') + (o.material && o.material.texture ? ' 貼圖' : '') + (o.skins ? ' 貼皮×' + o.skins.length : '');
  }
  function list(spec) { return tree(validate(spec).spec).map(function (r) { return new Array(r.depth + 1).join('  ') + r.obj.id + ' ' + r.obj.name + '：' + describeObject(r.obj); }).join('\n'); }

  // ───────────────────────── words the program reads itself (no model) ─────────────────────────
  var SHAPE_WORDS = [['mesh:sphere', /(球體|圓球|球|sphere|ball)/i], ['mesh:box', /(立方體|方塊|方形|盒子|箱子|積木|cube|box|block)/i], ['mesh:cylinder', /(圓柱體|圓柱|柱子|cylinder|pillar)/i], ['mesh:cone', /(圓錐體|圓錐|錐體|cone)/i], ['mesh:plane', /(平面|地板|地面|桌面|plane|floor)/i], ['mesh:torus', /(甜甜圈|圓環|環|torus|donut|ring)/i], ['light:point', /(點光源|燈泡|燈|point\s*light|lamp|light)/i], ['group:group', /(群組|group)/i]];
  var COLOR_RE = [['#e53935', /(紅|red)/i], ['#fb8c00', /(橙|橘|orange)/i], ['#fdd835', /(黃|yellow)/i], ['#43a047', /(綠|green)/i], ['#1e88e5', /(藍|blue)/i], ['#8e24aa', /(紫|purple|violet)/i], ['#f48fb1', /(粉紅|粉|pink)/i], ['#f5f5f5', /(白|white)/i], ['#212121', /(黑|black)/i], ['#9e9e9e', /(灰|gr[ae]y)/i], ['#795548', /(棕|咖啡|褐|brown)/i], ['#d4af37', /(金|gold)/i], ['#c0c0c0', /(銀|silver)/i]];
  function colorIn(t) { var m = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/.exec(t); if (m) { return m[0]; } var best = null, at = 1e9; COLOR_RE.forEach(function (c) { var mm = c[1].exec(t); if (mm && mm.index < at - (c[0] === '#f48fb1' ? 1 : 0)) { at = mm.index; best = c[0]; } }); if (/粉紅|pink/i.test(t)) { return '#f48fb1'; } if (/天藍|淺藍/.test(t)) { return '#4fc3f7'; } if (/深藍|藏青/.test(t)) { return '#1a237e'; } if (/草綠|淺綠/.test(t)) { return '#8bc34a'; } if (/深綠/.test(t)) { return '#1b5e20'; } return best; }
  var NUMW = { '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  function nnum(s) { if (s == null || s === '') { return null; } if (/^\d+(\.\d+)?$/.test(s)) { return Number(s); } return NUMW[s] != null ? NUMW[s] : null; }
  var REL_RE = [['left-front', /(左前方?|前左|左前側)/], ['right-front', /(右前方?|前右|右前側)/], ['left-back', /(左後方?|後左|左後側|左後面)/], ['right-back', /(右後方?|後右|右後側|右後面)/], ['above', /(上面|上方|頂上|上頭|上)(?![^，。]*[左右前後])/], ['below', /(下面|下方|底下|下頭)/], ['inside', /(裡面|裡頭|內部|其中)/], ['center', /(正中間|中央|中間|中心|畫面中)/], ['front', /(前方|前面|正前|前側|面前|前)/], ['back', /(後方|後面|後側|背後|後)/], ['left', /(左邊|左側|左方|左手邊|左)/], ['right', /(右邊|右側|右方|右手邊|右)/], ['beside', /(旁邊|旁|附近|身邊)/]];
  function relIn(t) { for (var i = 0; i < REL_RE.length; i++) { var m = REL_RE[i][1].exec(t); if (m) { return { rel: REL_RE[i][0], at: m.index, text: m[0] }; } } return null; }
  // the object an expression names: the longest name found in the text, or an id
  function objectIn(spec, t) { var best = -1, bl = 0; spec.objects.forEach(function (o, i) { var n = o.name.toLowerCase(); if (n && t.toLowerCase().indexOf(n) >= 0 && n.length > bl) { best = i; bl = n.length; } }); if (best >= 0) { return spec.objects[best]; } var m = /\b(o\d+)\b/.exec(t); if (m) { var k = byId(spec, m[1]); if (k >= 0) { return spec.objects[k]; } } return null; }
  function parsePlace(spec, t) {
    var r = relIn(t); var ob = objectIn(spec, t), p = {};
    if (/(我的|我身|我左|我右|我前|我後|我旁|在我|離我|我這)/.test(t) || /^我/.test(t)) { p.of = 'me'; }
    else if (ob) { p.of = ob.id; } else if (/(畫面|視野|螢幕|眼前)/.test(t)) { p.of = 'view'; } else if (/(地上|地面|地板上)/.test(t)) { p.of = 'view'; if (!r) { r = { rel: 'center' }; } } else if (/(這裡|這邊|此處)/.test(t)) { p.of = 'view'; }
    if (r) { p.rel = r.rel; } else if (ob) { p.rel = 'beside'; } else if (p.of === 'me') { p.rel = 'front'; }
    var d = /(\d+(?:\.\d+)?)\s*(?:公尺|米|格|單位|m\b)/.exec(t); if (d) { p.dist = Number(d[1]); }
    return p.of || p.rel ? p : null;
  }
  // 沒有內建圖元的東西（茶壺、花瓶、杯子…）：程式產生一個「自訂形狀」物件（mesh:'polygon'，extra:{vertices,faces}），跟匯入 OBJ 是同一種東西
  function modelObject(id, opt) {
    opt = opt || {}; var m = MG && MG.build(id, { height: opt.height }); if (!m) { return null; }
    return { type: 'mesh', mesh: 'polygon', name: opt.name || m.label, material: { color: opt.color || m.color, roughness: m.roughness, metalness: m.metalness }, extra: { vertices: m.vertices, faces: m.faces, uvs: m.uvs, generated: m.id } };
  }
  function parseObjectPhrase(spec, t) {
    var mdl = MG && MG.find(t);
    if (mdl) {
      var colM = colorIn(t.replace(/(顏色|色的|色)/, '')), cntM = 1, cmM = /(\d+|[一二兩三四五六七八九十])\s*(?:個|顆|塊|張|座|隻|把|只|組)/.exec(t); if (cmM) { cntM = Math.max(1, Math.min(10, nnum(cmM[1]) || 1)); }
      var hM = /(?:高度?|height)\s*(\d+(?:\.\d+)?)/i.exec(t), bigM = /(超大|巨大|特大)/.test(t) ? 3 : /(很大|大型|大的|大)/.test(t.replace(/大小/g, '')) ? 2 : /(迷你)/.test(t) ? 0.35 : /(很小|小型|小的|小)/.test(t) ? 0.5 : 1;
      return { object: modelObject(mdl.id, { color: colM, height: hM ? Number(hM[1]) : mdl.height * bigM }), count: cntM, shape: 'model:' + mdl.id };
    }
    var shape = null; SHAPE_WORDS.forEach(function (s) { if (!shape && s[1].test(t)) { shape = s[0]; } }); if (!shape) { return null; }
    var col = colorIn(t.replace(/(顏色|色的|色)/, '')), cnt = 1, cm = /(\d+|[一二兩三四五六七八九十])\s*(?:個|顆|塊|張|座|盞|根|片|只|組)/.exec(t); if (cm) { cnt = Math.max(1, Math.min(10, nnum(cm[1]) || 1)); }
    var kind = shape.split(':'), o = kind[0] === 'mesh' ? { type: 'mesh', mesh: kind[1] } : kind[0] === 'light' ? { type: 'light', light: 'point' } : { type: 'group' }; if (o.type === 'group') { return null; }
    if (col && o.type === 'mesh') { o.material = { color: col }; } if (col && o.type === 'light') { o.color = col; }
    var big = /(超大|巨大|很大|特大|大型|大的|大)/.test(t.replace(/大小/g, '')) ? (/(超大|巨大|特大)/.test(t) ? 3 : 2) : 1, small = /(迷你|很小|小型|小的|小)/.test(t) ? (/(迷你)/.test(t) ? 0.35 : 0.5) : 1, f = big > 1 ? big : small;
    var sizeN = /(?:邊長|寬|大小為?|尺寸)\s*(\d+(?:\.\d+)?)/.exec(t), radN = /(?:半徑|r=?)\s*(\d+(?:\.\d+)?)/i.exec(t), hN = /(?:高度?|height)\s*(\d+(?:\.\d+)?)/i.exec(t);
    if (o.mesh === 'box') { var side = sizeN ? Number(sizeN[1]) : f; o.size = [side, hN ? Number(hN[1]) : side, side]; } else if (o.mesh === 'sphere') { o.radius = radN ? Number(radN[1]) : 0.5 * f; } else if (o.mesh === 'cylinder' || o.mesh === 'cone') { o.radius = radN ? Number(radN[1]) : (o.mesh === 'cone' ? 0.5 : 0.4) * f; o.height = hN ? Number(hN[1]) : f; } else if (o.mesh === 'plane') { var ps = sizeN ? Number(sizeN[1]) : 4 * f; o.size = [ps, ps]; } else if (o.mesh === 'torus') { o.radius = radN ? Number(radN[1]) : 0.5 * f; o.tube_radius = o.radius * 0.3; } else if (o.type === 'light') { o.intensity = 1.2 * (big > 1 ? 1.5 : small < 1 ? 0.6 : 1); }
    return { object: o, count: cnt, shape: shape };
  }
  // one clause at a time; what no rule reads goes back as `unmatched` (the AI gets it)
  function parseCommands(text, spec) {
    var s = validate(spec).spec, edits = [], matched = [], unmatched = [];
    String(text || '').split(/[，,。；;\n]+|(?:然後|接著|之後再|再來|並且)/).map(function (c) { return c.trim(); }).filter(Boolean).forEach(function (c0) {
      var c = c0.replace(/^(?:請你?|幫我|請幫我|麻煩|可以|我要|我想要?|給我)\s*/, ''), m, e = null;
      if ((m = /^把\s*(.+?)\s*(?:改名|重新命名|命名)\s*(?:為|成)\s*[「"]?(.+?)[」"]?$/.exec(c))) { var o1 = objectIn(s, m[1]); if (o1) { e = [{ op: 'rename_object', id: o1.id, name: m[2] }]; } }
      else if ((m = /^(?:刪除|刪掉|移除|拿掉|去掉|清除|delete|remove)\s*(?:掉)?\s*(.+)$/i.exec(c))) { if (/^(所有|全部|整個場景|場景)/.test(m[1])) { e = [{ op: 'clear_objects' }]; } else { var o2 = objectIn(s, m[1]); if (o2) { e = [{ op: 'remove_object', id: o2.id }]; } else if (/^(它|這個|選取的?|選中的?)/.test(m[1])) { e = [{ op: 'remove_object', id: 'selection' }]; } } }
      else if ((m = /^(?:把\s*)?(.+?)\s*(隱藏|藏起來|顯示|顯現|鎖定|解鎖|解除鎖定)$/.exec(c)) || (m = /^(隱藏|顯示|鎖定|解鎖)\s*(.+)$/.exec(c))) { var w = /^(隱藏|藏起來|顯示|顯現|鎖定|解鎖|解除鎖定)$/.test(m[2]) ? m[2] : m[1], tx = w === m[2] ? m[1] : m[2], o3 = /^(它|這個|選取的?)$/.test(tx) ? { id: 'selection' } : objectIn(s, tx); if (o3) { e = [{ op: /隱藏|藏起來|顯示|顯現/.test(w) ? 'set_visible' : 'set_locked', id: o3.id }]; if (e[0].op === 'set_visible') { e[0].visible = /顯/.test(w); } else { e[0].locked = /^鎖定$/.test(w); } } }
      else if ((m = /^(?:複製|再來一個|再做一個|再加一個)\s*(.+)$/.exec(c))) { var o4 = objectIn(s, m[1]); if (o4) { e = [{ op: 'duplicate_object', id: o4.id }]; } else if (/^(它|這個|選取的?)/.test(m[1])) { e = [{ op: 'duplicate_object', id: 'selection' }]; } }
      else if ((m = /^把\s*(.+?)\s*(?:的)?(?:顏色)?\s*(?:改成|換成|變成|塗成|漆成|染成|上色成|換)\s*(.+?)\s*(?:色)?$/.exec(c)) && !/^(?:場景的?)?背景/.test(m[1]) && colorIn(m[2])) { var tgt = /^(它|這個|選取的?|選中的?)$/.test(m[1].trim()) ? { id: 'selection' } : objectIn(s, m[1]); if (tgt) { e = [{ op: 'set_material', id: tgt.id, color: colorIn(m[2]) }]; } }
      else if ((m = /^把\s*(.+?)\s*(?:移到|放到|放在|搬到|擺到|移動到|挪到|移去|放去)\s*(.+)$/.exec(c))) { var o5 = /^(它|這個|選取的?|選中的?)$/.test(m[1].trim()) ? { id: 'selection' } : objectIn(s, m[1]), pl = parsePlace(s, m[2]); if (o5 && pl) { if (pl.of === o5.id) { pl = null; } if (pl) { e = [{ op: 'place_object', id: o5.id, place: pl }]; } } }
      else if ((m = /^把\s*(.+?)\s*(?:往|向)\s*(左前|右前|左後|右後|左|右|前|後|上|下)\s*(?:方)?\s*(?:移動|移|挪|推|拉|平移)?\s*(\d+(?:\.\d+)?)?\s*(?:公尺|米|格|單位)?$/.exec(c))) { var o6 = /^(它|這個|選取的?|選中的?)$/.test(m[1].trim()) ? { id: 'selection' } : objectIn(s, m[1]), dist = m[3] ? Number(m[3]) : 1, dirs = { '左': [-1, 0, 0], '右': [1, 0, 0], '前': [0, 0, 1], '後': [0, 0, -1], '上': [0, 1, 0], '下': [0, -1, 0], '左前': [-1, 0, 0.7], '右前': [1, 0, 0.7], '左後': [-1, 0, -0.7], '右後': [1, 0, -0.7] }, dv = dirs[m[2]]; if (o6 && dv) { e = [{ op: 'transform_object', id: o6.id, move: [dv[0] * dist, dv[1] * dist, dv[2] * dist] }]; } }
      else if ((m = /^把\s*(.+?)\s*(?:向|往)?(?:左|右)?(?:旋轉|轉|轉動|轉向)\s*(-?\d+(?:\.\d+)?)\s*度$/.exec(c))) { var o7 = /^(它|這個|選取的?|選中的?)$/.test(m[1].trim()) ? { id: 'selection' } : objectIn(s, m[1]); if (o7) { var ang = Number(m[2]) * (/往右|向右/.test(c) ? -1 : 1); e = [{ op: 'transform_object', id: o7.id, turn: ang }]; } }
      else if ((m = /^把\s*(.+?)\s*(放大|縮小)\s*(?:到)?\s*(一倍|兩倍|二倍|三倍|\d+(?:\.\d+)?\s*倍|一半|一點|一些|些|點)?$/.exec(c))) { var o8 = /^(它|這個|選取的?|選中的?)$/.test(m[1].trim()) ? { id: 'selection' } : objectIn(s, m[1]); if (o8) { var amt = m[3] || '', fac = /一半/.test(amt) ? 0.5 : /(一倍|兩倍|二倍)/.test(amt) ? 2 : /三倍/.test(amt) ? 3 : /(\d+(?:\.\d+)?)\s*倍/.test(amt) ? Number(/(\d+(?:\.\d+)?)/.exec(amt)[1]) : 1.5; if (m[2] === '縮小') { fac = fac > 1.4 && fac !== 1.5 ? 1 / fac : (fac === 1.5 ? 0.7 : fac); } e = [{ op: 'transform_object', id: o8.id, scale: fac }]; } }
      else if ((m = /^(?:把\s*)?(.+?)\s*(?:放到地上|放在地上|落地|貼地|放到地面)$/.exec(c))) { var o9 = /^(它|這個|選取的?)$/.test(m[1].trim()) ? { id: 'selection' } : objectIn(s, m[1]); if (o9) { e = [{ op: 'drop_to_ground', id: o9.id }]; } }
      else if ((m = /^(?:把)?(?:背景)\s*(?:改成|換成|變成|設成|設為)?\s*(.+?)\s*(?:色)?$/.exec(c)) && colorIn(m[1])) { e = [{ op: 'set_background', color: colorIn(m[1]) }]; }
      else if ((m = /^(?:把)?(?:視角|鏡頭|相機)\s*(?:切到|換到|轉到|改成|切換到)?\s*(正面|前面|背面|後面|左邊|左面|右邊|右面|上面|俯視|頂視|斜角|等角|斜視)/.exec(c))) { var pre = { '正面': 'front', '前面': 'front', '背面': 'back', '後面': 'back', '左邊': 'left', '左面': 'left', '右邊': 'right', '右面': 'right', '上面': 'top', '俯視': 'top', '頂視': 'top', '斜角': 'iso', '等角': 'iso', '斜視': 'iso' }; e = [{ op: 'set_camera', preset: pre[m[1]] }]; }
      else if ((m = /^(?:把)?(?:視角|鏡頭|相機)\s*(拉遠|拉近|放大|縮小|靠近|遠離)/.exec(c))) { e = [{ op: 'set_camera', zoom: /拉遠|縮小|遠離/.test(m[1]) ? 0.6 : 1.6 }]; }
      else if ((m = /^(?:把)?\s*(.+?)\s*(?:綁成|組成|做成|變成)\s*(?:一個)?\s*(?:群組|一組)$/.exec(c))) { var names = m[1].split(/[和與跟、及]/).map(function (x) { return objectIn(s, x.trim()); }).filter(Boolean); if (names.length) { e = [{ op: 'group_objects', ids: names.map(function (o) { return o.id; }) }]; } }
      else {
        // creating: "在我的左前方放一個紅色的球"  /  "放一個藍色方塊在桌子上面"  /  "加一個球"
        var cm1 = /^(?:在|於|到)\s*(.+?)\s*(?:放|擺|加|新增|做|畫|建立|生成|產生|產出|製作|創造|變出|生出|放置|加上|加入|弄|擺放|來一個|給我一個)\s*(?:上|入)?\s*(.+)$/.exec(c), cm2 = /^(?:放|擺|加|新增|做|畫|建立|生成|產生|產出|製作|創造|變出|生出|放置|加上|加入|弄|擺放|來一個|給我一個)\s*(?:上|入)?\s*(.+?)\s*(?:在|於|到|放在|放到)\s*(.+)$/.exec(c), cm3 = /^(?:放|擺|加|新增|做|畫|建立|生成|產生|產出|製作|創造|變出|生出|放置|加上|加入|弄|擺放|來一個|給我一個)\s*(?:上|入)?\s*(.+)$/.exec(c), objText = null, placeText = null;
        if (cm1) { placeText = cm1[1]; objText = cm1[2]; } else if (cm2) { objText = cm2[1]; placeText = cm2[2]; } else if (cm3) { objText = cm3[1]; }
        if (objText) { var op = parseObjectPhrase(s, objText); if (op) { var place = placeText ? parsePlace(s, placeText) : null; if (placeText && !place) { op = null; } if (op) { e = []; for (var n = 0; n < op.count; n++) { var ed = { op: 'add_object', object: clone(op.object) }; if (place) { ed.place = clone(place); if (n > 0) { ed.place = { of: 'selection', rel: 'right' }; } } else if (n > 0) { ed.place = { of: 'selection', rel: 'right' }; } e.push(ed); } } } }
      }
      if (e && e.length) { e.forEach(function (x) { edits.push(x); }); matched.push(c0); } else { unmatched.push(c0); }
    });
    return { edits: edits, matched: matched, unmatched: unmatched };
  }

  // ───────────────────────── the AI: the closed actions it may answer with ─────────────────────────
  function viewWords(spec, env) { var F = frameOf(spec, env), f = function (v) { return '(' + v.map(function (x) { return Math.round(x * 100) / 100; }).join(', ') + ')'; }; return '使用者現在的視角：相機在 ' + f(F.pos) + '，看向 ' + f(F.target) + '；「前方」在世界座標是 ' + f(F.forward) + '、「右邊」是 ' + f(F.right) + '（y 向上）。'; }
  var ACTIONS = '封閉的動作(只能用這些,JSON):'
    + '{op:"add_model",model:"' + (MG ? MG.CATALOG.map(function (c) { return c.id; }).join('|') : '') + '",name?,height?:公尺,color?:"#rrggbb",place?}(內建模型庫,有「' + (MG ? MG.CATALOG.map(function (c) { return c.label; }).join('、') : '') + '」;基本圖元沒有的形狀先找這個,place 同 add_object)、'
    + '{op:"add_object",object:{type:"mesh",mesh:"box|sphere|cylinder|cone|plane|torus",name?,size:[w,h,d](box)|size:[w,l](plane)|radius|height|tube_radius,material:{color:"#rrggbb",metalness?,roughness?,opacity?,emissive?,texture?:"water|grass|sand|wood|brick",texture_repeat?:[rx,ry]},rotation_deg?:[x,y,z]},place:{of:"me|view|origin|selection|<物件 id 或名字>",rel:"front|back|left|right|left-front|right-front|left-back|right-back|above|on|below|inside|center|beside",dist?,gap?,dx?,dy?,dz?}}(也可以加 type:"light"+light:"point|directional|ambient"+intensity+color,或 type:"group")、'
    + '{op:"place_object",id,place}、{op:"transform_object",id,move?:[右,上,前](我的視角,單位)|move_world?:[x,y,z]|turn?:度(繞垂直軸)|tilt?|roll?|rotate_deg?:[x,y,z]|scale?:倍數}、{op:"update_object",id,props:{name?,size?,radius?,height?,position?,rotation_deg?,visible?,locked?,material?:{…},intensity?,color?}}、'
    + '{op:"set_material",id|"all",color?,metalness?,roughness?,opacity?,emissive?,texture?,texture_repeat?,side?}、{op:"remove_object",id}、{op:"rename_object",id,name}、{op:"duplicate_object",id,place?}、{op:"set_visible",id,visible}、{op:"set_locked",id,locked}、{op:"drop_to_ground",id}、{op:"align_objects",ids:[…],axis:"x|y|z",to:"min|center|max"}、'
    + '{op:"group_objects",ids:[…],name?}、{op:"ungroup",id}、{op:"set_parent",id,parent}、{op:"move_object",id,to:"earlier|later|first|last"}、{op:"set_camera",preset?:"front|back|left|right|top|iso",position?,look_at?,fov?,zoom?}、{op:"set_background",color}、{op:"set_title",text}、{op:"clear_objects"}、'
    + '{op:"add_skin",id,skin:{zone:"+z前面|-z後面|-x左面|+x右面|+y上面|-y下面(方塊);side|top|bottom(圓柱);side|bottom(圓錐);wrap(球、圓環);front(平面)",color?|image?,u,v(中心 0..1),w,h(佔該面的比例),rotate,opacity}}、{op:"update_skin",id,skin_id,props}、{op:"remove_skin",id,skin_id}、'
    + '{op:"find_picture",query:"英文關鍵字"}、{op:"generate_image",prompt}(兩個是宿主做的:上網找圖／生圖,結果會當成貼圖)';
  function editPrompt(spec, request, extra, selection, env) {
    var sp = validate(spec).spec;
    var system = '你是 3D 場景編輯器的助手。使用者用說的來擺放與修改 3D 場景;你只能回一個 JSON 物件 {"say":"一句話說明","edits":[動作…]},不要回別的字。' + ACTIONS + '。\n規則:1) 位置一律用 place(以使用者的視角:我的左前方=of "me" rel "left-front"、畫面中間=of "view" rel "center"、桌子的上面=of "<桌子>" rel "above"、桌子的右邊=of "<桌子>" rel "right"),不要自己算座標;「它／這個」就是選取的物件(id 用 "selection")。2) 座標單位跟場景一樣,y 向上;球半徑 0.5、方塊邊長 1 大約一個人的小物件。3) 每個新東西獨立成一個物件並取有意義的名字(例如「桌子」「紅色球」);桌子之類的組合物先逐個零件 add_object 再 group_objects。4) 顏色用 #rrggbb。5) 不確定就少做,說明理由,不要編造不存在的 id。6) 使用者要的東西不在基本圖元裡(茶壺、花瓶、杯子、瓶子…):**不要拒絕、也不要反問要不要做**——先用 add_model(模型庫有就用);沒有就用基本圖元逐個零件 add_object 再 group_objects 組出來;真的需要特殊外形才用 mesh:"polygon"、extra:{vertices:[[x,y,z],…],faces:[[a,b,c],…],uvs?:[[u,v],…]}(三角形,最多幾百個頂點,y 向上、底面在 y=0)。想貼圖的話 material.texture 用 wood|brick|grass|sand|water 或使用者貼的圖,模型庫的東西已經有貼圖座標。';
    var user = viewWords(sp, env) + '\n場景「' + sp.title + '」目前的物件(樹狀,每行:id 名字:類型 尺寸 @位置 顏色):\n' + (sp.objects.length ? list(sp) : '(空的)') + (selection ? '\n選取的物件:' + selection : '') + (extra ? '\n' + extra : '') + '\n\n使用者說:' + String(request || '');
    return { system: system, user: user };
  }
  function parseEditsReply(text) {
    var t = String(text || ''), a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b <= a) { return { ok: false, error: '沒有 JSON' }; }
    var obj; try { obj = JSON.parse(t.slice(a, b + 1)); } catch (e) { try { obj = JSON.parse(t.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1')); } catch (e2) { return { ok: false, error: 'JSON 讀不懂' }; } }
    var arr = Array.isArray(obj) ? obj : (Array.isArray(obj.edits) ? obj.edits : (obj.op ? [obj] : null)); if (!arr) { return { ok: false, error: '沒有 edits' }; }
    var edits = [], dropped = 0; arr.forEach(function (e) { if (e && typeof e === 'object' && (OPS.indexOf(e.op) >= 0 || HOST_OPS.indexOf(e.op) >= 0)) { edits.push(e); } else { dropped++; } });
    return { ok: true, say: str(obj.say, 400), edits: edits, dropped: dropped };
  }
  function refPrompt() { return 'Describe the 3D objects in this picture for someone who will rebuild them from boxes, spheres, cylinders and cones: what each thing is, its colours, and where it is relative to the others. Short.'; }

  // ───────────────────────── skins on the faces: what each one covers (a face of an object, in the object's own axes) ─────────────────────────
  // frame of a planar zone: { n: outward normal, rot: Euler that turns a plane (its normal is +z, its x to the right, its y up) onto the face as seen from outside, w, h (the face), c: its centre }
  var ZONE_ROT = { '+z': [0, 0, 0], '-z': [0, PI, 0], '+x': [0, PI / 2, 0], '-x': [0, -PI / 2, 0], '+y': [-PI / 2, 0, 0], '-y': [PI / 2, 0, 0], front: [0, 0, 0] };
  var ZONE_N = { '+z': [0, 0, 1], '-z': [0, 0, -1], '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], front: [0, 0, 1], top: [0, 1, 0], bottom: [0, -1, 0] };
  function zoneFrame(o, zone) {
    var n = ZONE_N[zone]; if (!n) { return null; }
    if (o.mesh === 'box') { var s = o.size, ax = zone.charAt(1), sgn = zone.charAt(0) === '+' ? 1 : -1, w = ax === 'x' ? s[2] : s[0], h = ax === 'y' ? s[2] : s[1], d = ax === 'x' ? s[0] : ax === 'y' ? s[1] : s[2]; return { n: n, rot: ZONE_ROT[zone], w: w, h: h, c: vmul(n, d / 2), planar: true }; }
    if (o.mesh === 'cylinder' || o.mesh === 'cone') { if (zone === 'top' && o.mesh === 'cylinder') { return { n: n, rot: ZONE_ROT['+y'], w: o.radius * 2, h: o.radius * 2, c: [0, o.height / 2, 0], planar: true }; } if (zone === 'bottom') { return { n: n, rot: ZONE_ROT['-y'], w: o.radius * 2, h: o.radius * 2, c: [0, -o.height / 2, 0], planar: true }; } return null; }
    if (o.mesh === 'plane' && zone === 'front') { return { n: n, rot: [0, 0, 0], w: o.size[0], h: o.size[1], c: [0, 0, 0], planar: true }; }
    return null;
  }
  // which zone of the object a point on its surface (object axes) belongs to, and where in it (u, v: 0..1, v up as seen from outside)
  function zoneAt(o, p, normal) {
    var n = normal || [0, 0, 1], ax = Math.abs(n[0]) > Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    if (o.mesh === 'box') { var zone = (n[ax] >= 0 ? '+' : '-') + 'xyz'.charAt(ax), F = zoneFrame(o, zone), q = mvec(mT(rotMat(F.rot)), vsub(p, F.c)); return { zone: zone, u: r3(0.5 + q[0] / F.w), v: r3(0.5 + q[1] / F.h) }; }
    if (o.mesh === 'cylinder') { if (ax === 1 && Math.abs(n[1]) > 0.7) { var top = n[1] > 0, F2 = zoneFrame(o, top ? 'top' : 'bottom'), q2 = mvec(mT(rotMat(F2.rot)), vsub(p, F2.c)); return { zone: top ? 'top' : 'bottom', u: r3(0.5 + q2[0] / F2.w), v: r3(0.5 + q2[1] / F2.h) }; } return { zone: 'side', u: r3((Math.atan2(p[0], p[2]) / (2 * PI) + 1) % 1), v: r3(0.5 + p[1] / o.height) }; }
    if (o.mesh === 'cone') { if (Math.abs(n[1]) > 0.7 && n[1] < 0) { var F3 = zoneFrame(o, 'bottom'), q3 = mvec(mT(rotMat(F3.rot)), vsub(p, F3.c)); return { zone: 'bottom', u: r3(0.5 + q3[0] / F3.w), v: r3(0.5 + q3[1] / F3.h) }; } return { zone: 'side', u: r3((Math.atan2(p[0], p[2]) / (2 * PI) + 1) % 1), v: r3(0.5 + p[1] / o.height) }; }
    if (o.mesh === 'plane') { return { zone: 'front', u: r3(0.5 + p[0] / o.size[0]), v: r3(0.5 + p[1] / o.size[1]) }; }
    if (o.mesh === 'sphere' || o.mesh === 'torus') { return { zone: 'wrap', u: r3((Math.atan2(p[0], p[2]) / (2 * PI) + 1) % 1), v: r3(0.5 + Math.asin(Math.max(-1, Math.min(1, p[1] / (o.radius || 1)))) / PI) }; }
    return null;
  }
  function Rz(a) { var c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; }
  // a skin on a planar face -> a thin plane node (render_3d_scene format) in the object's own axes; { position, rotation, size, material }
  function skinPlane(o, k, index, resolve) {
    var F = zoneFrame(o, k.zone); if (!F) { return null; } var eps = 0.0015 * Math.max(0.5, Math.max(F.w, F.h)) * (index + 1) + 0.0008, cu = (k.u - 0.5) * F.w, cv = (k.v - 0.5) * F.h, R = rotMat(F.rot), centre = vadd(vadd(F.c, vmul(F.n, eps)), mvec(R, [cu, cv, 0])), rot = matEuler(mmul(R, Rz(k.rotate * PI / 180)));
    var m = { color: k.image ? '#ffffff' : (k.color || '#ffffff'), metalness: 0.1, roughness: 0.8, side: 'double' }; if (k.opacity < 1) { m.opacity = k.opacity; }
    if (k.image) { var tex = /^ref:/.test(k.image) ? (resolve ? resolve(k.image) : null) : k.image; if (!tex) { return null; } m.texture = tex; }
    return { position: centre, rotation: rot, size: [r3(F.w * k.w), r3(F.h * k.h)], material: m };
  }

  // ───────────────────────── out: one scene that render_3d_scene can play ─────────────────────────
  // opts: resolve(ref) -> data URL | null (textures kept by the project), bake(obj, wrapSkins, resolve) -> { texture, color? } | null (skins on a curved surface are painted into the texture; needs a canvas),
  //       tags:true -> every node carries `_src` (the object it came from; the viewer picks with it), hidden:true -> hidden objects stay in
  function toScene(spec, opts) {
    opts = opts || {}; var s = validate(spec).spec, nodes = [], lights = [], resolve = opts.resolve || null;
    function visibleChain(o) { var p = o, g = 0; while (p && g++ < 60) { if (!p.visible && !opts.hidden) { return false; } p = p.parent ? s.objects[byId(s, p.parent)] : null; } return true; }
    s.objects.forEach(function (o) {
      if (o.type === 'group' || !visibleChain(o)) { return; } var W = worldT(s, o);
      if (o.type === 'light') { var L = { type: o.light, intensity: o.intensity, color: o.color }; if (o.light !== 'ambient') { L.position = vec(W.t, [0, 0, 0]); } if (opts.tags) { L._src = o.id; } lights.push(L); return; }
      var n = { mesh: o.mesh, position: vec(W.t, [0, 0, 0]), rotation: matEuler(W.R) };   // worldT already folds in the groups above and the mesh's own place and rotation
      var f = W.s, mm = clone(o.material || {}); if (mm.texture && /^ref:/.test(mm.texture)) { var tx = resolve ? resolve(mm.texture) : null; if (tx) { mm.texture = tx; } else { delete mm.texture; delete mm.texture_repeat; } }
      var wrap = (o.skins || []).filter(function (k) { return !zoneFrame(o, k.zone); }), planar = (o.skins || []).filter(function (k) { return zoneFrame(o, k.zone); });
      if (wrap.length && opts.bake) { var bk = opts.bake(o, wrap, resolve, mm); if (bk && bk.texture) { mm.texture = bk.texture; if (bk.color) { mm.color = bk.color; } delete mm.texture_repeat; } }
      n.material = mm;
      if (o.size) { n.size = o.size.map(function (v) { return r3(v * f); }); } ['radius', 'height', 'tube_radius'].forEach(function (k) { if (o[k] != null) { n[k] = r3(o[k] * f); } });
      if (o.extra) { Object.keys(o.extra).forEach(function (k) { n[k] = o.extra[k]; }); if (f !== 1) { if (Array.isArray(n.vertices)) { n.vertices = n.vertices.map(function (v) { return [r3(v[0] * f), r3(v[1] * f), r3(v[2] * f)]; }); } if (Array.isArray(n.points)) { n.points = n.points.map(function (v) { return v.map(function (x) { return r3(Number(x) * f); }); }); } if (n.radius && o.mesh === 'line') { n.radius = r3(n.radius * f); } } }
      if (o.mesh === 'plane') { n.size = [n.size[0], n.size[1]]; }
      if (opts.tags) { n._src = o.id; } nodes.push(n);
      planar.forEach(function (k, idx) {
        var pl = skinPlane(o, k, idx, resolve); if (!pl) { return; }
        var wp = vadd(mvec(W.R, vmul(pl.position, f)), W.t), wr = matEuler(mmul(W.R, rotMat(pl.rotation)));
        var dn = { mesh: 'plane', position: vec(wp, [0, 0, 0]), rotation: wr, size: [r3(pl.size[0] * f), r3(pl.size[1] * f)], material: pl.material }; if (opts.tags) { dn._src = o.id; dn._skin = k.id; } nodes.push(dn);
      });
    });
    var out = { title: s.title, background: s.background, camera: { position: s.camera.position.slice(), look_at: s.camera.look_at.slice(), fov: s.camera.fov }, lights: lights.length ? lights : [{ type: 'ambient', intensity: 0.5 }, { type: 'directional', position: [5, 8, 5], intensity: 0.9 }], nodes: nodes };
    return out;
  }

  // ───────────────────────── YAML ─────────────────────────
  function yamlLib() { if (typeof jsyaml !== 'undefined') { return jsyaml; } try { return typeof require === 'function' ? require('js-yaml') : null; } catch (e) { return null; } }
  var PLAIN = /^[A-Za-z0-9_一-鿿][A-Za-z0-9_\-. 一-鿿]*$/;
  function scalar(v) { if (typeof v === 'string') { return PLAIN.test(v) && !/^(true|false|null|yes|no|on|off|~|[-+]?\d[\d.eE+-]*)$/i.test(v) && !/\s$/.test(v) ? v : JSON.stringify(v); } if (typeof v === 'number') { return String(v); } if (typeof v === 'boolean') { return v ? 'true' : 'false'; } return 'null'; }
  function flow(v) { if (Array.isArray(v)) { return '[' + v.map(flow).join(', ') + ']'; } if (v && typeof v === 'object') { return '{' + Object.keys(v).map(function (k) { return scalar(k) + ': ' + flow(v[k]); }).join(', ') + '}'; } return scalar(v); }
  function dump(v, ind) {
    ind = ind || ''; var L = [];
    if (Array.isArray(v)) { v.forEach(function (x) { if (x && typeof x === 'object' && !(Array.isArray(x) && x.every(function (y) { return typeof y !== 'object'; }))) { var sub = dump(x, ind + '  ').split('\n'); L.push(ind + '- ' + sub[0].slice(ind.length + 2)); sub.slice(1).forEach(function (l) { L.push(l); }); } else { L.push(ind + '- ' + flow(x)); } }); return L.join('\n'); }
    Object.keys(v).forEach(function (k) { var x = v[k]; if (x === undefined) { return; } if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length && JSON.stringify(x).length > 90) { L.push(ind + scalar(k) + ':'); L.push(dump(x, ind + '  ')); } else if (Array.isArray(x) && x.length && x.some(function (y) { return y && typeof y === 'object' && !Array.isArray(y); }) || (Array.isArray(x) && JSON.stringify(x).length > 120 && x.some(function (y) { return Array.isArray(y); }) && x.length > 4)) { L.push(ind + scalar(k) + ':'); L.push(dump(x, ind + '  ')); } else { L.push(ind + scalar(k) + ': ' + flow(x)); } });
    return L.join('\n');
  }
  // the editor's own YAML (render_3d_scene's format + id, name, parent, mesh:group, hidden, locked, skins): the "source" tab and the project file
  function toYaml(spec) {
    var s = validate(spec).spec, nodes = [], lights = [];
    s.objects.forEach(function (o) {
      var n = { id: o.id, name: o.name }; if (o.parent) { n.parent = o.parent; }
      if (o.type === 'light') { var L = { id: o.id, name: o.name, type: o.light, intensity: o.intensity, color: o.color }; if (o.light !== 'ambient') { L.position = o.position; } if (o.parent) { L.parent = o.parent; } if (!o.visible) { L.hidden = true; } if (o.locked) { L.locked = true; } lights.push(L); return; }
      if (o.type === 'group') { n.mesh = 'group'; n.position = o.position; n.rotation = o.rotation; if (o.scale !== 1) { n.scale = o.scale; } }
      else { n.mesh = o.mesh; n.position = o.position; n.rotation = o.rotation; if (o.size) { n.size = o.size; } ['radius', 'height', 'tube_radius'].forEach(function (k) { if (o[k] != null) { n[k] = o[k]; } }); n.material = o.material; if (o.skins) { n.skins = o.skins.map(function (k) { var x = { id: k.id, name: k.name, zone: k.zone }; if (k.image) { x.image = k.image; } if (k.color) { x.color = k.color; } x.u = k.u; x.v = k.v; x.w = k.w; x.h = k.h; if (k.rotate) { x.rotate = k.rotate; } if (k.opacity < 1) { x.opacity = k.opacity; } return x; }); } if (o.extra) { Object.keys(o.extra).forEach(function (k) { n[k] = o.extra[k]; }); } }
      if (!o.visible) { n.hidden = true; } if (o.locked) { n.locked = true; } nodes.push(n);
    });
    var doc = { title: s.title, background: s.background, camera: { position: s.camera.position, look_at: s.camera.look_at, fov: s.camera.fov }, lights: lights, nodes: nodes }; if (!lights.length) { delete doc.lights; }
    return '# /edit-3d-model 的場景(render_3d_scene 格式,多了 id、name、parent、mesh: group、hidden、locked、skins;匯出「場景 YAML」時會展平成 render_3d_scene 可以直接播放的樣子)\n' + dump(doc) + '\n';
  }
  function fromYaml(text) {
    var Y = yamlLib(); if (!Y) { return { ok: false, error: '沒有 YAML 讀取器' }; } var doc;
    try { doc = Y.load(String(text || '')); } catch (e) { return { ok: false, error: 'YAML 語法錯誤:' + String((e && e.message) || e).split('\n')[0].slice(0, 160) }; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { return { ok: false, error: '場景要是一個物件(有 nodes)' }; }
    var objects = [], defs = doc.defs && typeof doc.defs === 'object' ? doc.defs : {};
    (Array.isArray(doc.nodes) ? doc.nodes : []).forEach(function (n) {
      if (!n || typeof n !== 'object') { return; }
      if (n.use) { var def = defs[n.use]; if (def && Array.isArray(def.nodes)) { var off = Array.isArray(n.position) ? n.position : [0, 0, 0], sc = n.scale != null ? Number(n.scale) || 1 : 1; def.nodes.forEach(function (c0) { var c = clone(c0), p = Array.isArray(c.position) ? c.position : [0, 0, 0]; c.position = [off[0] + p[0] * sc, off[1] + p[1] * sc, off[2] + p[2] * sc]; if (sc !== 1) { if (c.size) { c.size = c.size.map(function (v) { return v * sc; }); } if (c.radius != null) { c.radius *= sc; } if (c.height != null) { c.height *= sc; } } c.name = c.name || String(n.use); objects.push(c); }); } return; }
      var o = clone(n); if (o.mesh === 'group') { o.type = 'group'; delete o.mesh; } objects.push(o);
    });
    (Array.isArray(doc.lights) ? doc.lights : []).forEach(function (l) { if (l && typeof l === 'object') { var o = clone(l); o.light = o.type; o.type = 'light'; objects.push(o); } });
    var cam = doc.camera && typeof doc.camera === 'object' ? doc.camera : {};
    var r = validate({ title: doc.title, background: doc.background, camera: { position: cam.position, look_at: cam.look_at, fov: cam.fov }, objects: objects });
    // lights of a plain scene come last; the object order of a project is the order of the file: keep the lights where the file had them only when it said so (editor YAML has ids on both)
    return { ok: true, spec: r.spec, problems: r.problems };
  }
  function toSceneYaml(spec, opts) { var sc = toScene(spec, opts), Y = yamlLib(); var clean = clone(sc); return (Y && Y.dump ? Y.dump(clean, { lineWidth: 140, noRefs: true }) : dump(clean)); }

  // ───────────────────────── starters ─────────────────────────
  function table() { return [{ type: 'group', id: 'table', name: '桌子', position: [0, 0, 0] }, { type: 'mesh', mesh: 'box', parent: 'table', name: '桌面', size: [2.4, 0.12, 1.2], position: [0, 0.76, 0], material: { color: '#a1744a', roughness: 0.6 } }].concat([[-1.1, -0.5], [1.1, -0.5], [-1.1, 0.5], [1.1, 0.5]].map(function (p, i) { return { type: 'mesh', mesh: 'box', parent: 'table', name: '桌腳 ' + (i + 1), size: [0.1, 0.7, 0.1], position: [p[0], 0.35, p[1]], material: { color: '#7d5a38', roughness: 0.7 } }; })); }
  var STARTERS = {
    blank: { label: '空白', desc: '只有燈光', spec: function () { return { title: '3D 場景', objects: [{ type: 'light', light: 'ambient', name: '環境光', intensity: 0.55 }, { type: 'light', light: 'directional', name: '主光', position: [5, 8, 5], intensity: 0.95 }] }; } },
    room: { label: '房間', desc: '地板、一張桌子、一盞燈', spec: function () { return { title: '房間', background: '#20242c', objects: [{ type: 'light', light: 'ambient', name: '環境光', intensity: 0.5 }, { type: 'light', light: 'directional', name: '主光', position: [4, 8, 5], intensity: 0.9 }, { type: 'mesh', mesh: 'plane', name: '地板', size: [10, 10], position: [0, 0, 0], material: { color: '#8c8f99', roughness: 0.9 } }].concat(table()) }; } },
    model: { label: '模型台', desc: '一個方塊與圓柱底座,給「貼皮」用(像塑膠模型)', spec: function () { return { title: '模型', background: '#23262f', objects: [{ type: 'light', light: 'ambient', name: '環境光', intensity: 0.55 }, { type: 'light', light: 'directional', name: '主光', position: [4, 7, 6], intensity: 0.95 }, { type: 'mesh', mesh: 'cylinder', name: '底座', radius: 1.4, height: 0.15, position: [0, 0.075, 0], material: { color: '#3a3f4b', roughness: 0.5 } }, { type: 'mesh', mesh: 'box', name: '模型', size: [1.2, 1.6, 1.2], position: [0, 0.95, 0], material: { color: '#c9ccd6', roughness: 0.6 } }] }; } },
    studio: { label: '攝影棚', desc: '地板加三盞燈', spec: function () { return { title: '攝影棚', background: '#15171c', objects: [{ type: 'light', light: 'ambient', name: '環境光', intensity: 0.35 }, { type: 'light', light: 'directional', name: '主光', position: [5, 8, 4], intensity: 0.9 }, { type: 'light', light: 'point', name: '補光', position: [-4, 3, 3], intensity: 0.7, color: '#aac8ff' }, { type: 'light', light: 'point', name: '輪廓光', position: [0, 4, -5], intensity: 0.8, color: '#ffd7a8' }, { type: 'mesh', mesh: 'plane', name: '地板', size: [14, 14], position: [0, 0, 0], material: { color: '#2a2d36', roughness: 0.4, metalness: 0.2 } }] }; } }
  };
  function listStarters() { return Object.keys(STARTERS).map(function (k) { return { id: k, label: STARTERS[k].label, desc: STARTERS[k].desc }; }); }
  function starter(id) { var st = STARTERS[String(id || '')]; return st ? validate(st.spec()).spec : null; }
  function promptOf(spec, steps) {
    var sp = validate(spec).spec, L = ['請做一個 3D 場景「' + sp.title + '」(右手座標、y 向上、單位同 render_3d_scene),背景 ' + sp.background + '。', '', '物件(樹狀):', list(sp)];
    var texts = (steps || []).filter(function (x) { return x.text; }); if (texts.length) { L.push('', '(有效的指示,依序;位置都是以當時的視角說的):'); texts.forEach(function (x, i) { L.push((i + 1) + '. ' + x.text + (x.summary ? ' → ' + x.summary : '')); }); } return L.join('\n');
  }

  var api = { OPS: OPS, HOST_OPS: HOST_OPS, MESHES: MESHES, LIMITS: LIM, ZONE_LABEL: ZONE_LABEL, validate: validate, applyEdits: applyEdits, editWords: editWords, list: list, find: find, byId: byId, tree: tree, childrenOf: childrenOf, descendants: descendants, depthOf: depthOf, worldBox: worldBox, worldT: worldT, bounds: bounds, frameOf: frameOf, resolvePlace: resolvePlace, parseCommands: parseCommands, editPrompt: editPrompt, parseEditsReply: parseEditsReply, refPrompt: refPrompt,
    toScene: toScene, toSceneYaml: toSceneYaml, toYaml: toYaml, fromYaml: fromYaml, dump: dump, starter: starter, listStarters: listStarters, promptOf: promptOf, describeObject: describeObject, normSkin: skin, skins: skins, zonesOf: zonesOf, zoneFrame: zoneFrame, zoneAt: zoneAt, skinPlane: skinPlane, defaultZone: defaultZone, colorWord: colorWord, colorIn: colorIn, matEuler: matEuler, rotMat: rotMat, texture: texture, material: material, MATERIAL_KEYS: MATERIAL_KEYS, ACTIONS: ACTIONS };
  return api;
});
