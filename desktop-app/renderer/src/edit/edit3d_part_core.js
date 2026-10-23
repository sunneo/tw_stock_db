// /edit-3d-model 的「單一物件編輯」核心(純函式):像在做一個塑膠模型(GK)——一個物件、它的底色與材質、以及一層一層的「貼皮」:
// 每一層貼皮說明「貼在哪個面(zone)、貼什麼(圖或顏色)、貼在那個面的哪裡(u、v 是中心,0..1,v 往上;w、h 是佔那個面的比例;rotate 度數;opacity)」。
// 跟場景編輯器同一套外框(FaEditShell):貼皮就是這個編輯器的「圖層」(物件欄、屬性、復原重做、AI 對話、整理成 prompt 都一樣);按「完成」才把結果交回場景的那個物件(場景的一步)。
//   spec: { v:1, title, base:{ mesh, size|radius|height|tube_radius, material:{color,metalness,roughness,opacity,texture,texture_repeat…} }, seq, objects:[ { id:'s1', name, type:'skin', zone, image, color, u, v, w, h, rotate, opacity, visible, locked } ] }   objects[0] 在最下面
//   封閉的動作:set_title set_base add_object(skin) update_object remove_object rename_object move_object set_visible set_locked duplicate_object clear_objects place_object transform_object set_zone;宿主執行的:find_picture generate_image
//   用說的位置(place_object / add_object 的 place):{ at:'center|top|bottom|left|right|top-left|top-right|bottom-left|bottom-right', size?:0.1..1 },相對於那個面(從外面看過去的左右上下)。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./edit3d_core.js')); else root.FaEdit3dPart = factory((root.FaEdit3d || (typeof FaEdit3d !== 'undefined' ? FaEdit3d : undefined))); })(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  var OPS = ['set_title', 'set_base', 'add_object', 'update_object', 'remove_object', 'rename_object', 'move_object', 'set_visible', 'set_locked', 'duplicate_object', 'clear_objects', 'place_object', 'transform_object', 'set_zone'];
  var HOST_OPS = ['find_picture', 'generate_image'];
  var LIM = { objects: 40 };
  function str(v, max) { return String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, max || 200); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function num(v, lo, hi, d) { var n = Number(v); if (!isFinite(n)) { return d; } return Math.max(lo, Math.min(hi, n)); }
  function r3(n) { return Math.round(n * 1000) / 1000; }
  var BASE_KEYS = ['size', 'radius', 'height', 'tube_radius'];
  function validBase(b, problems) {
    var v = C.validate({ objects: [Object.assign({ type: 'mesh', mesh: 'box' }, b || {})] }); var o = v.spec.objects[0];
    if (!o || o.type !== 'mesh' || !C.zonesOf(o.mesh).length) { problems.push('這種形狀不能貼皮,改用方塊'); o = C.validate({ objects: [{ type: 'mesh', mesh: 'box' }] }).spec.objects[0]; }
    var out = { mesh: o.mesh, material: o.material }; BASE_KEYS.forEach(function (k) { if (o[k] != null) { out[k] = o[k]; } }); return out;
  }
  function layer(s, mesh, id, problems) {
    var k = C.normSkin(Object.assign({}, s, { id: 'k1' }), mesh, 1); if (!k) { return null; }
    return { id: id, name: str(s.name, 40).trim() || k.name, type: 'skin', zone: k.zone, image: k.image, color: k.color, u: k.u, v: k.v, w: k.w, h: k.h, rotate: k.rotate, opacity: k.opacity, visible: s.visible !== false, locked: !!s.locked };
  }
  function defaultSpec() { return { v: 1, title: '貼皮', base: validBase({ mesh: 'box', size: [1.2, 1.6, 1.2], material: { color: '#c9ccd6', roughness: 0.6 } }, []), seq: 0, objects: [] }; }
  function validate(input) {
    var problems = [], r = input && typeof input === 'object' ? input : {}, d = defaultSpec(), s = { v: 1, title: str(r.title, 80) || d.title, base: r.base ? validBase(r.base, problems) : d.base, seq: 0, objects: [] }, ids = {};
    (Array.isArray(r.objects) ? r.objects : []).forEach(function (o) {
      if (s.objects.length >= LIM.objects) { return; } var id = /^s\d{1,5}$/.test(String(o && o.id || '')) && !ids[o.id] ? String(o.id) : null; var l = o && typeof o === 'object' ? layer(o, s.base.mesh, id || 's0', problems) : null; if (!l) { return; }
      if (!id) { l.id = null; } else { ids[id] = 1; } s.objects.push(l);
    });
    var maxSeq = Number(r.seq) || 0; s.objects.forEach(function (o) { var m = /^s(\d+)$/.exec(o.id || ''); if (m) { maxSeq = Math.max(maxSeq, Number(m[1])); } });
    s.objects.forEach(function (o) { if (!o.id) { do { maxSeq++; } while (ids['s' + maxSeq]); o.id = 's' + maxSeq; ids[o.id] = 1; } }); s.seq = maxSeq;
    return { ok: true, spec: s, problems: problems };
  }
  function byId(spec, id) { for (var i = 0; i < spec.objects.length; i++) { if (spec.objects[i].id === id) { return i; } } return -1; }
  function find(spec, ref) { var i = byId(spec, ref); if (i >= 0) { return i; } var low = String(ref == null ? '' : ref).trim().toLowerCase(); if (!low) { return -1; } for (var k = spec.objects.length - 1; k >= 0; k--) { if (spec.objects[k].name.toLowerCase() === low) { return k; } } return -1; }
  function resolveId(s, ref, env) { if (ref == null || ref === '' || ref === 'selection' || ref === 'it' || ref === 'selected') { ref = env && env.selection; } return find(s, ref); }
  function zoneLabel(mesh, zone) { return C.ZONE_LABEL[zone] || zone; }
  function describe(spec) { var b = spec.base; return b.mesh + ' ' + (b.size ? '[' + b.size.join(',') + ']' : 'r' + b.radius + (b.height != null ? ' h' + b.height : '')) + ' 底色 ' + b.material.color + (b.material.texture ? ' 材質貼圖' : ''); }
  function list(spec) { var s = validate(spec).spec; return '底:' + describe(s) + '\n' + (s.objects.length ? s.objects.map(function (o) { return o.id + ' ' + o.name + '：' + zoneLabel(s.base.mesh, o.zone) + ' ' + (o.image ? '圖' : o.color) + ' 中心(' + o.u + ',' + o.v + ') 大小(' + o.w + '×' + o.h + ')' + (o.rotate ? ' 轉' + o.rotate + '度' : ''); }).join('\n') : '(還沒有貼皮)'); }
  // "at" words -> the centre of the skin on a face (u, v) given its size
  var AT = { center: [0.5, 0.5], top: [0.5, 'T'], bottom: [0.5, 'B'], left: ['L', 0.5], right: ['R', 0.5], 'top-left': ['L', 'T'], 'top-right': ['R', 'T'], 'bottom-left': ['L', 'B'], 'bottom-right': ['R', 'B'] };
  function atUV(at, w, h) { var a = AT[String(at || 'center').toLowerCase()]; if (!a) { return null; } function f(x, size) { return x === 'L' || x === 'B' ? size / 2 + 0.04 : x === 'R' || x === 'T' ? 1 - size / 2 - 0.04 : x; } return { u: r3(f(a[0], w)), v: r3(f(a[1], h)) }; }
  function opsFor(s, e, env, st) {
    switch (e.op) {
      case 'set_title': s.title = str(e.text, 80).trim() || s.title; return {};
      case 'set_base': { var m = {}; C.MATERIAL_KEYS.forEach(function (k) { if (e[k] !== undefined) { m[k] = e[k]; } }); if (e.material && typeof e.material === 'object') { Object.assign(m, e.material); } if (!Object.keys(m).length) { return { error: 'set_base 要有 color/metalness/roughness/opacity/emissive/texture/texture_repeat 其中之一' }; } if (m.color != null && C.material({ color: m.color }).color !== String(m.color).trim()) { return { error: '不認得這個顏色 "' + str(m.color, 20) + '"' }; } if (m.texture != null && m.texture !== '' && !C.texture(m.texture)) { return { error: '材質貼圖要是 water/grass/sand/wood/brick、ref:… 或圖片網址' }; } var cur = Object.assign({}, s.base.material); Object.keys(m).forEach(function (k) { if (m[k] === '' || m[k] === null) { delete cur[k]; } else { cur[k] = m[k]; } }); s.base.material = C.material(cur, {}); return {}; }
      case 'add_object': {
        if (s.objects.length >= LIM.objects) { return { error: '貼皮太多了' } } var raw = e.object && typeof e.object === 'object' ? clone(e.object) : null; if (!raw) { return { error: 'add_object 要有 object' } } var place = e.place || raw.place; if (place && typeof place === 'object') { var uv = atUV(place.at, num(raw.w == null ? place.size : raw.w, 0.01, 4, 0.5), num(raw.h == null ? place.size : raw.h, 0.01, 4, 0.5)); if (!uv) { return { error: '不認得的位置 "' + str(place.at, 20) + '"' }; } raw.u = uv.u; raw.v = uv.v; if (raw.w == null && place.size != null) { raw.w = num(place.size, 0.01, 4, 0.5); } if (raw.h == null && place.size != null) { raw.h = num(place.size, 0.01, 4, 0.5); } }
        s.seq++; var l = layer(raw, s.base.mesh, 's' + s.seq, []); if (!l) { s.seq--; return { error: '貼皮要有 image(貼圖)或 color(顏色)' }; } if (raw.zone && C.zonesOf(s.base.mesh).indexOf(String(raw.zone)) < 0) { s.seq--; return { error: '這個形狀沒有 "' + str(raw.zone, 12) + '" 這一面(有:' + C.zonesOf(s.base.mesh).join('、') + ')' }; }
        var names = {}; s.objects.forEach(function (o) { names[o.name] = 1; }); if (names[l.name]) { for (var n = 2; n < 99; n++) { if (!names[l.name + ' ' + n]) { l.name = l.name + ' ' + n; break; } } }
        var at = e.at === 'bottom' ? 0 : s.objects.length; s.objects.splice(at, 0, l); st.added.push(l.id); return {};
      }
      case 'update_object': { var i = resolveId(s, e.id, env); if (i < 0) { return { error: '找不到貼皮 "' + str(e.id, 20) + '"' }; } var o = s.objects[i], p = e.props && typeof e.props === 'object' ? e.props : {}, raw2 = Object.assign({}, o, p); if (p.zone && C.zonesOf(s.base.mesh).indexOf(String(p.zone)) < 0) { return { error: '這個形狀沒有 "' + str(p.zone, 12) + '" 這一面' }; } var l2 = layer(raw2, s.base.mesh, o.id, []); if (!l2) { return { error: '改完之後貼皮沒有圖也沒有顏色' }; } s.objects[i] = l2; return {}; }
      case 'remove_object': { var j = resolveId(s, e.id, env); if (j < 0) { return { error: '找不到貼皮 "' + str(e.id, 20) + '"' }; } s.objects.splice(j, 1); return {}; }
      case 'rename_object': { var k = resolveId(s, e.id, env); if (k < 0) { return { error: '找不到貼皮 "' + str(e.id, 20) + '"' }; } var nm = str(e.name, 40).trim(); if (!nm) { return { error: '名字是空的' }; } s.objects[k].name = nm; return {}; }
      case 'move_object': { var q = resolveId(s, e.id, env); if (q < 0) { return { error: '找不到貼皮 "' + str(e.id, 20) + '"' }; } var to = e.to, nq = to === 'up' || to === 'front' || to === 'later' ? (to === 'front' ? s.objects.length - 1 : q + 1) : to === 'down' || to === 'back' || to === 'earlier' ? (to === 'back' ? 0 : q - 1) : Math.round(Number(to)); if (!isFinite(nq)) { return { error: 'to 要是 up/down/front/back 或數字' }; } nq = Math.max(0, Math.min(s.objects.length - 1, nq)); if (nq === q) { return { error: '已經在最' + (nq === 0 ? '下' : '上') + '面了' }; } var it = s.objects.splice(q, 1)[0]; s.objects.splice(nq, 0, it); return {}; }
      case 'set_visible': { var a = resolveId(s, e.id, env); if (a < 0) { return { error: '找不到貼皮 "' + str(e.id, 20) + '"' }; } s.objects[a].visible = e.visible !== false; return {}; }
      case 'set_locked': { var b = resolveId(s, e.id, env); if (b < 0) { return { error: '找不到貼皮 "' + str(e.id, 20) + '"' }; } s.objects[b].locked = !!e.locked; return {}; }
      case 'duplicate_object': { var c = resolveId(s, e.id, env); if (c < 0) { return { error: '找不到貼皮 "' + str(e.id, 20) + '"' }; } if (s.objects.length >= LIM.objects) { return { error: '貼皮太多了' }; } var cp = clone(s.objects[c]); s.seq++; cp.id = 's' + s.seq; cp.name = cp.name + ' 2'; cp.u = r3(cp.u + 0.1); cp.v = r3(cp.v - 0.1); s.objects.splice(c + 1, 0, cp); st.added.push(cp.id); return {}; }
      case 'clear_objects': s.objects = []; return {};
      case 'place_object': { var d = resolveId(s, e.id, env); if (d < 0) { return { error: '找不到貼皮 "' + str(e.id, 20) + '"' }; } var pl = e.place || {}, o4 = s.objects[d], w = pl.size != null ? num(pl.size, 0.01, 4, o4.w) : o4.w, h = pl.size != null ? num(pl.size, 0.01, 4, o4.h) : o4.h, uv2 = atUV(pl.at, w, h); if (!uv2) { return { error: '不認得的位置 "' + str(pl.at, 20) + '"(center/top/bottom/left/right/top-left/top-right/bottom-left/bottom-right)' }; } o4.u = uv2.u; o4.v = uv2.v; if (pl.size != null) { o4.w = r3(w); o4.h = r3(h); } return {}; }
      case 'transform_object': { var f = resolveId(s, e.id, env); if (f < 0) { return { error: '找不到貼皮 "' + str(e.id, 20) + '"' }; } var o5 = s.objects[f], did = false; if (e.du != null || e.dv != null) { o5.u = r3(num(o5.u + num(e.du, -3, 3, 0), -2, 3, o5.u)); o5.v = r3(num(o5.v + num(e.dv, -3, 3, 0), -2, 3, o5.v)); did = true; } if (e.scale != null) { var sc = num(e.scale, 0.05, 20, 1); o5.w = r3(num(o5.w * sc, 0.01, 4, o5.w)); o5.h = r3(num(o5.h * sc, 0.01, 4, o5.h)); did = true; } if (e.scale_w != null) { o5.w = r3(num(o5.w * num(e.scale_w, 0.05, 20, 1), 0.01, 4, o5.w)); did = true; } if (e.scale_h != null) { o5.h = r3(num(o5.h * num(e.scale_h, 0.05, 20, 1), 0.01, 4, o5.h)); did = true; } if (e.turn != null) { o5.rotate = r3(num(o5.rotate + num(e.turn, -3600, 3600, 0), -3600, 3600, 0)); did = true; } if (e.opacity != null) { o5.opacity = r3(num(e.opacity, 0.05, 1, 1)); did = true; } return did ? {} : { error: 'transform_object 要有 du/dv/scale/scale_w/scale_h/turn/opacity 其中之一' }; }
      case 'set_zone': { var g = resolveId(s, e.id, env); if (g < 0) { return { error: '找不到貼皮 "' + str(e.id, 20) + '"' }; } if (C.zonesOf(s.base.mesh).indexOf(String(e.zone)) < 0) { return { error: '這個形狀沒有 "' + str(e.zone, 12) + '" 這一面(有:' + C.zonesOf(s.base.mesh).join('、') + ')' }; } s.objects[g].zone = String(e.zone); return {}; }
      default: return { error: '不是可以做的動作' };
    }
  }
  function applyEdits(spec, edits, env) {
    var s = validate(clone(spec)).spec, applied = [], appliedEdits = [], rejected = [], st = { added: [] }; env = env || {};
    (Array.isArray(edits) ? edits : []).forEach(function (e) {
      if (!e || typeof e !== 'object' || OPS.indexOf(e.op) < 0) { rejected.push({ op: str(e && e.op, 30) || '?', error: HOST_OPS.indexOf(e && e.op) >= 0 ? '這個動作要由宿主執行(找圖、生圖)' : '不是可以做的動作' }); return; }
      var before = clone(s), r; try { r = opsFor(s, e, env, st); } catch (x) { r = { error: String((x && x.message) || x) }; }
      if (r && r.error) { s.objects = before.objects; s.base = before.base; s.title = before.title; s.seq = Math.max(s.seq, before.seq); rejected.push({ op: e.op, error: r.error }); return; }
      applied.push(e.op); appliedEdits.push(e);
    });
    var res = validate(s); return { spec: res.spec, applied: applied, appliedEdits: appliedEdits, rejected: rejected, added: st.added.filter(function (id) { return byId(res.spec, id) >= 0; }) };
  }
  function editWords(e) {
    if (!e) { return ''; } var id = e.id ? ' ' + str(e.id, 20) : '';
    switch (e.op) {
      case 'set_title': return '標題改成「' + str(e.text, 40) + '」'; case 'set_base': return '改底色／材質'; case 'add_object': { var o = e.object || {}; return '新增貼皮' + (o.name ? ' ' + str(o.name, 30) : '') + (o.zone ? '（' + (C.ZONE_LABEL[o.zone] || o.zone) + '）' : ''); }
      case 'update_object': return '修改貼皮' + id; case 'remove_object': return '拿掉貼皮' + id; case 'rename_object': return str(e.id, 20) + ' 改名為 ' + str(e.name, 30); case 'move_object': return '調整' + id + ' 的上下順序'; case 'set_visible': return (e.visible === false ? '隱藏' : '顯示') + id; case 'set_locked': return (e.locked ? '鎖定' : '解鎖') + id;
      case 'duplicate_object': return '複製' + id; case 'clear_objects': return '清掉所有貼皮'; case 'place_object': return '把' + id + ' 放到' + str(e.place && e.place.at, 20); case 'transform_object': return '調整' + id; case 'set_zone': return id + ' 換到' + (C.ZONE_LABEL[e.zone] || e.zone); default: return e.op;
    }
  }
  // ───────────────────────── the words the program reads itself ─────────────────────────
  var ZONE_RE = { box: [['+z', /(正面|前面|前方|前側|前|正前)/], ['-z', /(背面|後面|後方|後側|後背|後)/], ['-x', /(左面|左邊|左側|左方|左)/], ['+x', /(右面|右邊|右側|右方|右)/], ['+y', /(頂面|上面|上方|頂部|頂|上)/], ['-y', /(底面|下面|下方|底部|底|下)/]], cylinder: [['top', /(頂面|上面|上方|頂部|頂|蓋子|上)/], ['bottom', /(底面|下面|下方|底部|底|下)/], ['side', /(側面|周圍|四周|圍|外面|側)/]], cone: [['bottom', /(底面|下面|底部|底|下)/], ['side', /(側面|周圍|四周|外面|側)/]], sphere: [['wrap', /(整個|全部|表面|球面)/]], torus: [['wrap', /(整個|全部|表面)/]], plane: [['front', /(正面|表面|整個|全部)/]] };
  function zoneIn(mesh, t) { var l = ZONE_RE[mesh] || [], best = null, at = 1e9; l.forEach(function (z) { var m = z[1].exec(t); if (m && m.index < at) { at = m.index; best = z[0]; } }); return best; }
  function atIn(t) { var h = /(左上)/.test(t) ? 'top-left' : /(右上)/.test(t) ? 'top-right' : /(左下)/.test(t) ? 'bottom-left' : /(右下)/.test(t) ? 'bottom-right' : null; if (h) { return h; } if (/(正中|中間|中央|中心)/.test(t)) { return 'center'; } if (/(偏上|上緣|上方|頂端)/.test(t)) { return 'top'; } if (/(偏下|下緣|下方|底端)/.test(t)) { return 'bottom'; } if (/(偏左|左側|左邊)/.test(t)) { return 'left'; } if (/(偏右|右側|右邊)/.test(t)) { return 'right'; } return null; }
  function colorOf(t) { return C.colorIn(String(t || '').replace(/色$/, '')); }
  function parseCommands(text, spec) {
    var s = validate(spec).spec, mesh = s.base.mesh, edits = [], matched = [], unmatched = [];
    String(text || '').split(/[，,。；;\n]+|(?:然後|接著|再來|並且)/).map(function (c) { return c.trim(); }).filter(Boolean).forEach(function (c0) {
      var c = c0.replace(/^(?:請你?|幫我|請幫我|麻煩|可以|我要|給我)\s*/, ''), m, e = null, z;
      if ((m = /^(?:把)?\s*(?:底色|基本顏色|整體顏色|本體|整個(?:物件|模型)?)\s*(?:的顏色)?\s*(?:改成|換成|變成|塗成|漆成|設成)?\s*(.+?)\s*(?:色)?$/.exec(c)) && colorOf(m[1])) { e = [{ op: 'set_base', color: colorOf(m[1]) }]; }
      else if ((m = /^(?:把)?\s*(.+?)\s*(?:塗成|漆成|染成|上色成|塗上|漆上|上色|改成|換成)\s*(.+?)\s*(?:色)?$/.exec(c)) && (z = zoneIn(mesh, m[1])) && colorOf(m[2])) { e = [{ op: 'add_object', object: { type: 'skin', zone: z, color: colorOf(m[2]), name: C.ZONE_LABEL[z] + '上色' } }]; }
      else if ((m = /^(?:把)?\s*(.+?)\s*(?:的)?(?:貼圖|貼皮|顏色)\s*(?:拿掉|移除|刪掉|刪除|清掉|去掉)$/.exec(c)) && (z = zoneIn(mesh, m[1]))) { var ids = s.objects.filter(function (o) { return o.zone === z; }).map(function (o) { return o.id; }); if (ids.length) { e = ids.map(function (id) { return { op: 'remove_object', id: id }; }); } }
      else if ((m = /^(?:拿掉|移除|刪掉|刪除|清掉|去掉)\s*(?:所有|全部|每個)\s*(?:貼皮|貼圖)$/.exec(c))) { e = [{ op: 'clear_objects' }]; }
      else if ((m = /^(?:把)?\s*(?:(?:它|這個|選取的?|選中的?|貼皮)\s*)?(?:移到|放到|放在|挪到|移動到)\s*(?:該面的?|這面的?)?\s*(.+)$/.exec(c)) && atIn(m[1])) { e = [{ op: 'place_object', id: 'selection', place: { at: atIn(m[1]) } }]; }
      else if ((m = /^(?:把)?\s*(?:它|這個|選取的?|選中的?|貼皮)?\s*(放大|縮小)\s*(一倍|兩倍|一半|一點|一些)?$/.exec(c))) { var amt = m[2] || '', fac = /一半/.test(amt) ? 0.5 : /(一倍|兩倍)/.test(amt) ? 2 : 1.3; if (m[1] === '縮小' && fac > 1) { fac = 0.7; } e = [{ op: 'transform_object', id: 'selection', scale: fac }]; }
      else if ((m = /^(?:把)?\s*(?:它|這個|選取的?|選中的?|貼皮)?\s*(?:往|向)?\s*(左|右|上|下)\s*(?:移動|移|挪|推)\s*(\d+(?:\.\d+)?)?\s*(?:%|％)?$/.exec(c))) { var step = m[2] ? (Number(m[2]) > 1 ? Number(m[2]) / 100 : Number(m[2])) : 0.1; e = [{ op: 'transform_object', id: 'selection', du: m[1] === '右' ? step : m[1] === '左' ? -step : 0, dv: m[1] === '上' ? step : m[1] === '下' ? -step : 0 }]; }
      else if ((m = /^(?:把)?\s*(?:它|這個|選取的?|選中的?|貼皮)?\s*(?:旋轉|轉)\s*(-?\d+(?:\.\d+)?)\s*度$/.exec(c))) { e = [{ op: 'transform_object', id: 'selection', turn: Number(m[1]) }]; }
      else if ((m = /^(?:把)?\s*(?:它|這個|選取的?|選中的?|貼皮)?\s*(?:變|設成|設為)?\s*(半透明|透明一點|不透明)$/.exec(c))) { e = [{ op: 'transform_object', id: 'selection', opacity: /不透明/.test(m[1]) ? 1 : 0.5 }]; }
      if (e && e.length) { e.forEach(function (x) { edits.push(x); }); matched.push(c0); } else { unmatched.push(c0); }
    });
    return { edits: edits, matched: matched, unmatched: unmatched };
  }
  var ACTIONS = '封閉的動作(只能用這些,JSON):{op:"set_base",color?,metalness?,roughness?,opacity?,texture?:"water|grass|sand|wood|brick",texture_repeat?:[rx,ry]}(整個物件的底色與材質)、'
    + '{op:"add_object",object:{type:"skin",zone,color?|image?:"attached"(使用者貼的圖)|"ref:…",u?,v?(中心 0..1,v 往上),w?,h?(佔該面的比例 0.01..1),rotate?:度,opacity?:0.05..1,name?},place?:{at:"center|top|bottom|left|right|top-left|top-right|bottom-left|bottom-right",size?}}、{op:"update_object",id,props:{zone?,color?,image?,u?,v?,w?,h?,rotate?,opacity?,name?}}、{op:"place_object",id,place:{at,size?}}、{op:"transform_object",id,du?,dv?,scale?,scale_w?,scale_h?,turn?,opacity?}、'
    + '{op:"set_zone",id,zone}、{op:"remove_object",id}、{op:"rename_object",id,name}、{op:"move_object",id,to:"up|down|front|back"}、{op:"set_visible",id,visible}、{op:"duplicate_object",id}、{op:"clear_objects"}、{op:"find_picture",query:"英文關鍵字"}、{op:"generate_image",prompt}(宿主做的:上網找圖／生圖,會變成一層貼皮)';
  function editPrompt(spec, request, extra, selection) {
    var sp = validate(spec).spec, zones = C.zonesOf(sp.base.mesh).map(function (z) { return z + '=' + (C.ZONE_LABEL[z] || z); }).join('、');
    var system = '你是「模型貼皮」編輯器的助手(像在做塑膠模型:決定哪個面貼什麼圖、塗什麼顏色)。使用者用說的;你只能回一個 JSON 物件 {"say":"一句話說明","edits":[動作…]},不要回別的字。' + ACTIONS + '。\n規則:1) zone 只能是這個形狀有的面:' + zones + '(方塊的左右上下前後都是「從外面看那一面」的位置,前面=+z)。2) 位置用 place.at 這種說法或 u、v、w、h 的比例,不要編座標。3) 使用者貼了圖,圖就是 image:"attached"。4) 「它／這個」就是選取的貼皮(id 用 "selection")。5) 不確定就少做並說明。';
    return { system: system, user: '物件:' + describe(sp) + '\n貼皮(由下到上,每行:id 名字:面 內容 中心 大小):\n' + list(sp) + (selection ? '\n選取的貼皮:' + selection : '') + (extra ? '\n' + extra : '') + '\n\n使用者說:' + String(request || '') };
  }
  function parseEditsReply(text) {
    var t = String(text || ''), a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b <= a) { return { ok: false, error: '沒有 JSON' }; } var obj; try { obj = JSON.parse(t.slice(a, b + 1)); } catch (e) { try { obj = JSON.parse(t.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1')); } catch (e2) { return { ok: false, error: 'JSON 讀不懂' }; } }
    var arr = Array.isArray(obj) ? obj : (Array.isArray(obj.edits) ? obj.edits : (obj.op ? [obj] : null)); if (!arr) { return { ok: false, error: '沒有 edits' }; } var edits = [], dropped = 0; arr.forEach(function (e) { if (e && typeof e === 'object' && (OPS.indexOf(e.op) >= 0 || HOST_OPS.indexOf(e.op) >= 0)) { edits.push(e); } else { dropped++; } });
    return { ok: true, say: str(obj.say, 400), edits: edits, dropped: dropped };
  }
  // from a scene object to this editor, and what goes back
  function fromObject(obj, title) {
    var base = { mesh: obj.mesh, material: obj.material }; BASE_KEYS.forEach(function (k) { if (obj[k] != null) { base[k] = obj[k]; } });
    return validate({ title: title || (obj.name + ' 的貼皮'), base: base, objects: (obj.skins || []).map(function (k, i) { return Object.assign({}, k, { id: 's' + (i + 1), type: 'skin' }); }) }).spec;
  }
  function toObjectPatch(spec) { var s = validate(spec).spec; return { skins: s.objects.filter(function (o) { return o.visible; }).map(function (o) { var k = { zone: o.zone, name: o.name, u: o.u, v: o.v, w: o.w, h: o.h, rotate: o.rotate, opacity: o.opacity }; if (o.image) { k.image = o.image; } if (o.color) { k.color = o.color; } return k; }), material: s.base.material }; }
  function promptOf(spec, steps) { var sp = validate(spec).spec, L = ['請替這個物件貼皮(像做塑膠模型:每個面貼什麼、塗什麼顏色)。', '', list(sp)]; var t = (steps || []).filter(function (x) { return x.text; }); if (t.length) { L.push('', '(有效的指示,依序):'); t.forEach(function (x, i) { L.push((i + 1) + '. ' + x.text + (x.summary ? ' → ' + x.summary : '')); }); } return L.join('\n'); }
  return { OPS: OPS, HOST_OPS: HOST_OPS, validate: validate, applyEdits: applyEdits, editWords: editWords, list: list, find: find, byId: byId, parseCommands: parseCommands, editPrompt: editPrompt, parseEditsReply: parseEditsReply, fromObject: fromObject, toObjectPatch: toObjectPatch, promptOf: promptOf, zoneLabel: zoneLabel, zoneIn: zoneIn, atUV: atUV, defaultSpec: defaultSpec };
});
