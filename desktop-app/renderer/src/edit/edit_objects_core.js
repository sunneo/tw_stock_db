// There is NO real boundary: an object can be anywhere (any coordinates; the user can ask the chat to add something far away). The "canvas" is only the export frame { x, y, w, h, bg } (what PNG / SVG export
// show; fit_canvas wraps it around the content), not a wall. The viewer is an endless plane (edit_viewport.js).
// PLACEMENT IS RELATIVE (the idea of a "concept painter led by language"): the AI says WHERE in words -- to the right of the sun, above the house, centred on the picture, inside the canvas at the
// bottom -- and the program works the coordinates out from the boxes of the objects, so nobody has to guess numbers and nothing is held back by a canvas size:
//   place:{ of:<id|name>|'selection'|'canvas'|'view'|'content', rel:'right'|'left'|'above'|'below'|'inside'|'center', gap?:16, align?:'start'|'center'|'end', at?:'center'|'top-left'|'top'|'top-right'|'left'|'right'|'bottom-left'|'bottom'|'bottom-right', dx?, dy? }
//   in add_object (the new object is moved there) and in place_object{id, place} (an existing one is). 'view' is the part of the plane the user is looking at, 'content' the box around everything.
// The object (layer) model shared by /edit-svg and /edit-picture (pure functions; node and the browser). A document is
//   { v:1, title, canvas:{ x, y, w, h, bg }, seq, objects:[ { id, name, type, visible, locked, ...props of the type } ] }       objects[0] is the BOTTOM, the last one is on top
// Everything the AI adds through the editor's own chat becomes ONE NEW OBJECT with a name (never a change of the whole document), so the user sees it in the objects view and can hide, move, rename,
// lock, duplicate or delete it, and undo it. The AI can only answer with the CLOSED set of actions below; the program checks every one of them (ids, sizes, types) and says what it refused.
//
//   FaEditObjects.make({ types:{ <type>:{ label, defaults:{…}, validate(obj)->{obj, problems[]} } }, types[t].move(obj,dx,dy) (default: x and y), limits:{ objects, canvas } (canvas = the largest size of the export frame), types[t].bbox(obj) -> {x,y,w,h} for fit_canvas / bounds, extraOps:{ <op>:{ words(e), apply(spec, e, helpers)->{spec}|{error} } }, defaultSpec })
//     -> { OPS, validate(spec), applyEdits(spec, edits) -> { spec, applied:[op], rejected:[{op,error}] }, editWords(e), list(spec) -> text, byId(spec,id), parseObjectCommand(text, spec) -> { edits, matched, unmatched } }
//
// closed actions:  set_title{text}  set_canvas{w,h,bg}  add_object{object:{type,name?,…}, at?:'top'|'bottom'|<index>|{above:id}}  update_object{id, props:{…}}  remove_object{id}  rename_object{id,name}
//                  move_object{id, to:'front'|'back'|'up'|'down'|<index>}  set_visible{id,visible}  set_locked{id,locked}  duplicate_object{id}  clear_objects{}  fit_canvas{margin?}  place_object{id,place}   (+ the editor's extraOps)
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditObjects = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var OPS = ['set_title', 'set_canvas', 'add_object', 'update_object', 'remove_object', 'rename_object', 'move_object', 'set_visible', 'set_locked', 'duplicate_object', 'clear_objects', 'fit_canvas', 'place_object'];
  function str(v, max) { return String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, max || 200); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function num(v, lo, hi, d) { var n = Number(v); if (!isFinite(n)) { return d; } return Math.max(lo, Math.min(hi, n)); }
  var COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|transparent|none)$/;

  function make(cfg) {
    var types = cfg.types || {}, LIM = Object.assign({ objects: 500, canvas: 16384, name: 60 }, cfg.limits || {}), extra = cfg.extraOps || {};
    var ALL_OPS = OPS.concat(Object.keys(extra));
    function defaultSpec() { return cfg.defaultSpec ? clone(cfg.defaultSpec()) : { v: 1, title: 'Untitled', canvas: { x: 0, y: 0, w: 800, h: 600, bg: '#ffffff' }, seq: 0, objects: [] }; }
    function canvasOf(c, d) { c = c && typeof c === 'object' ? c : {}; d = d || { x: 0, y: 0, w: 800, h: 600, bg: '#ffffff' }; return { x: Math.round(num(c.x, -1e7, 1e7, d.x || 0)), y: Math.round(num(c.y, -1e7, 1e7, d.y || 0)), w: Math.round(num(c.w, 16, LIM.canvas, d.w)), h: Math.round(num(c.h, 16, LIM.canvas, d.h)), bg: COLOR.test(String(c.bg || '')) ? String(c.bg) : d.bg }; }
    function validateObject(o, problems, ids) {
      if (!o || typeof o !== 'object') { return null; }
      var t = types[o.type]; if (!t) { problems.push('unknown object type "' + str(o.type, 30) + '" skipped'); return null; }
      var r = t.validate(Object.assign({}, t.defaults || {}, o)); (r.problems || []).forEach(function (p) { problems.push(p); }); if (!r.obj) { return null; }
      var out = r.obj; out.type = o.type; out.id = /^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(String(o.id || '')) && !ids[o.id] ? String(o.id) : null; out.name = str(o.name, LIM.name).trim() || (t.label || o.type);
      out.visible = o.visible !== false; out.locked = !!o.locked; return out;
    }
    function validate(input) {
      var problems = [], d = defaultSpec(), r = input && typeof input === 'object' ? input : {}, s = { v: 1, title: str(r.title, 80) || d.title, canvas: canvasOf(r.canvas, d.canvas), seq: 0, objects: [] }, ids = {};
      (Array.isArray(r.objects) ? r.objects : []).forEach(function (o) {
        if (s.objects.length >= LIM.objects) { if (!ids.__full) { problems.push('too many objects, only the first ' + LIM.objects + ' are kept'); ids.__full = 1; } return; }
        var v = validateObject(o, problems, ids); if (!v) { return; }
        s.objects.push(v); if (v.id) { ids[v.id] = 1; }
      });
      var maxSeq = Number(r.seq) || 0; s.objects.forEach(function (o) { var m = /^o(\d+)$/.exec(o.id || ''); if (m) { maxSeq = Math.max(maxSeq, Number(m[1])); } });
      s.objects.forEach(function (o) { if (!o.id) { do { maxSeq++; } while (ids['o' + maxSeq]); o.id = 'o' + maxSeq; ids[o.id] = 1; } });
      s.seq = maxSeq;
      return { ok: true, spec: s, problems: problems };
    }
    function byId(spec, id) { for (var i = 0; i < spec.objects.length; i++) { if (spec.objects[i].id === id) { return i; } } return -1; }
    // an id the AI wrote may be the object's id or its name ("the circle")
    function find(spec, ref) { var i = byId(spec, ref); if (i >= 0) { return i; } var low = String(ref == null ? '' : ref).trim().toLowerCase(); if (!low) { return -1; } for (var k = spec.objects.length - 1; k >= 0; k--) { if (spec.objects[k].name.toLowerCase() === low) { return k; } } return -1; }
    // the box around everything that is shown (the objects' own boxes: types[t].bbox), or null; the viewer and fit_canvas use it
    function boundsOf(spec) {
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
      (spec.objects || []).forEach(function (o) { var t = types[o.type]; if (!o.visible || !t || !t.bbox) { return; } var b; try { b = t.bbox(o); } catch (e) { b = null; } if (!b || !isFinite(b.x + b.y + b.w + b.h)) { return; } any = true; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
      return any ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    }
    function bboxOf(o) { var t = types[o.type]; var b; try { b = t && t.bbox ? t.bbox(o) : null; } catch (e) { b = null; } return b && isFinite(b.x + b.y + b.w + b.h) ? b : null; }
    function moveObj(o, dx, dy) { var t = types[o.type]; if (t && t.move) { t.move(o, dx, dy); } else { if ('x' in o) { o.x = Math.round((o.x + dx) * 100) / 100; } if ('y' in o) { o.y = Math.round((o.y + dy) * 100) / 100; } } }
    // where a box has to move so that it sits at `place`: -> { dx, dy } or { error }
    function resolvePlace(spec, box, place, env, selfId) {
      env = env || {}; place = place && typeof place === 'object' ? place : {}; var ref = place.of, anchor = null, c = spec.canvas;
      function rectOf(o) { return { x: o.x, y: o.y, w: o.w, h: o.h }; }
      if (ref == null || ref === '') { ref = env.selection && byId(spec, env.selection) >= 0 && env.selection !== selfId ? env.selection : null; if (ref == null) { for (var k = spec.objects.length - 1; k >= 0; k--) { if (spec.objects[k].id !== selfId && spec.objects[k].visible) { ref = spec.objects[k].id; break; } } } if (ref == null) { ref = env.view ? 'view' : 'canvas'; } }
      if (ref === 'selection') { ref = env.selection; if (!ref || byId(spec, ref) < 0) { return { error: 'nothing is selected' }; } }
      if (ref === 'canvas') { anchor = rectOf(c); } else if (ref === 'view') { anchor = env.view ? rectOf(env.view) : rectOf(c); } else if (ref === 'content') { anchor = boundsOf(spec) || rectOf(c); }
      else { var i = find(spec, ref); if (i < 0) { return { error: 'there is no object "' + str(ref, 30) + '" to place it relative to' }; } anchor = bboxOf(spec.objects[i]); if (!anchor) { return { error: 'the object "' + spec.objects[i].name + '" has no size to place relative to' }; } }
      var rel = String(place.rel || 'center').toLowerCase(), gap = num(place.gap, -1e5, 1e5, 16), al = String(place.align || 'center').toLowerCase(), at = String(place.at || 'center').toLowerCase(), tx, ty;
      function cross(aStart, aSize, bSize) { return al === 'start' ? aStart : al === 'end' ? aStart + aSize - bSize : aStart + (aSize - bSize) / 2; }
      if (rel === 'right') { tx = anchor.x + anchor.w + gap; ty = cross(anchor.y, anchor.h, box.h); }
      else if (rel === 'left') { tx = anchor.x - gap - box.w; ty = cross(anchor.y, anchor.h, box.h); }
      else if (rel === 'above' || rel === 'on-top') { tx = cross(anchor.x, anchor.w, box.w); ty = anchor.y - gap - box.h; }
      else if (rel === 'below') { tx = cross(anchor.x, anchor.w, box.w); ty = anchor.y + anchor.h + gap; }
      else if (rel === 'inside' || rel === 'center') {
        var pad = rel === 'center' ? 0 : Math.max(0, gap), cx = anchor.x + (anchor.w - box.w) / 2, cy = anchor.y + (anchor.h - box.h) / 2;
        tx = /left/.test(at) ? anchor.x + pad : /right/.test(at) ? anchor.x + anchor.w - box.w - pad : cx; ty = /top/.test(at) ? anchor.y + pad : /bottom/.test(at) ? anchor.y + anchor.h - box.h - pad : cy;
        if (at === 'top' || at === 'bottom') { tx = cx; } if (at === 'left' || at === 'right') { ty = cy; } if (rel === 'center') { tx = cx; ty = cy; }
      } else { return { error: 'rel must be right, left, above, below, inside or center' }; }
      return { dx: tx - box.x + (Number(place.dx) || 0), dy: ty - box.y + (Number(place.dy) || 0) };
    }
    // an object made by an editor's own action goes on top like add_object does (a new id, checked, counted as added); -> { error } or { id }
    function addTop(s, obj) {
      if (s.objects.length >= LIM.objects) { return { error: 'too many objects (at most ' + LIM.objects + ')' }; }
      var probs = []; s.seq++; var v = validateObject(Object.assign({}, obj, { id: 'o' + s.seq }), probs, {}); if (!v) { return { error: probs[0] || 'the object is not valid' }; }
      v.id = 'o' + s.seq; s.objects.push(v); s._added = (s._added || []).concat([v.id]); return { id: v.id };
    }
    function helpers() { return { find: find, byId: byId, validateObject: validateObject, clone: clone, str: str, num: num, bbox: bboxOf, move: moveObj, resolvePlace: resolvePlace, addTop: addTop }; }
    function applyOne(s, e, env) {
      if (!e || typeof e !== 'object') { return { error: 'not an action' }; }
      var i, o, t;
      switch (e.op) {
        case 'set_title': { var tt = str(e.text, 80).trim(); if (!tt) { return { error: 'the title must not be empty' }; } s.title = tt; return {}; }
        case 'set_canvas': { var c0 = s.canvas, c = canvasOf({ x: e.x != null ? e.x : c0.x, y: e.y != null ? e.y : c0.y, w: e.w != null ? e.w : c0.w, h: e.h != null ? e.h : c0.h, bg: e.bg != null ? e.bg : c0.bg }, c0); if (e.bg != null && !COLOR.test(String(e.bg))) { return { error: 'the background is not a colour' }; } s.canvas = c; return {}; }
        case 'add_object': {
          if (s.objects.length >= LIM.objects) { return { error: 'too many objects (at most ' + LIM.objects + ')' }; }
          var probs = []; s.seq++; var cand = Object.assign({}, e.object || {}, { id: 'o' + s.seq }); var v = validateObject(cand, probs, {}); if (!v) { return { error: (probs[0] || 'the object is not valid') }; }
          v.id = 'o' + s.seq; var at = e.at, idx = s.objects.length;
          if (at === 'bottom') { idx = 0; } else if (typeof at === 'number') { idx = Math.max(0, Math.min(s.objects.length, Math.round(at))); } else if (at && typeof at === 'object' && at.above) { var a = find(s, at.above); if (a >= 0) { idx = a + 1; } }
          if (e.place && bboxOf(v)) { var bx = bboxOf(v); var pr = resolvePlace(s, bx, e.place, env, null); if (pr.error) { return { error: pr.error }; } moveObj(v, pr.dx, pr.dy); }
          else if (s.objects.length === 0 && env && env.view && !('place' in e)) { /* the first object stays where it was written */ }
          s.objects.splice(idx, 0, v); s._added = (s._added || []).concat([v.id]); return {};
        }
        case 'place_object': {
          i = find(s, e.id); if (i < 0) { return { error: 'there is no object "' + str(e.id, 30) + '"' }; } o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; }
          var bo = bboxOf(o); if (!bo) { return { error: '"' + o.name + '" has no size to place' }; } var pp = resolvePlace(s, bo, e.place, env, o.id); if (pp.error) { return { error: pp.error }; } var moved = clone(o); moveObj(moved, pp.dx, pp.dy); s.objects[i] = moved; return {};
        }
        case 'update_object': {
          i = find(s, e.id); if (i < 0) { return { error: 'there is no object "' + str(e.id, 30) + '"' }; } o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; }
          var props = e.props && typeof e.props === 'object' ? e.props : null; if (!props || !Object.keys(props).length) { return { error: 'props is empty' }; }
          var next = Object.assign({}, o, props, { id: o.id, type: o.type }), p2 = [], v2 = validateObject(next, p2, {}); if (!v2) { return { error: p2[0] || 'the new values are not valid' }; }
          v2.id = o.id; s.objects[i] = v2; return {};
        }
        case 'remove_object': { i = find(s, e.id); if (i < 0) { return { error: 'there is no object "' + str(e.id, 30) + '"' }; } if (s.objects[i].locked) { return { error: '"' + s.objects[i].name + '" is locked' }; } s.objects.splice(i, 1); return {}; }
        case 'rename_object': { i = find(s, e.id); if (i < 0) { return { error: 'there is no object "' + str(e.id, 30) + '"' }; } var nm = str(e.name, LIM.name).trim(); if (!nm) { return { error: 'the name must not be empty' }; } s.objects[i].name = nm; return {}; }
        case 'move_object': {
          i = find(s, e.id); if (i < 0) { return { error: 'there is no object "' + str(e.id, 30) + '"' }; } o = s.objects.splice(i, 1)[0]; var to = e.to, n = s.objects.length, j;
          if (to === 'front' || to === 'top') { j = n; } else if (to === 'back' || to === 'bottom') { j = 0; } else if (to === 'up') { j = Math.min(n, i + 1); } else if (to === 'down') { j = Math.max(0, i - 1); } else if (typeof to === 'number') { j = Math.max(0, Math.min(n, Math.round(to))); } else { s.objects.splice(i, 0, o); return { error: 'to must be front, back, up, down or a position' }; }
          s.objects.splice(j, 0, o); return {};
        }
        case 'set_visible': { i = find(s, e.id); if (i < 0) { return { error: 'there is no object "' + str(e.id, 30) + '"' }; } s.objects[i].visible = e.visible !== false; return {}; }
        case 'set_locked': { i = find(s, e.id); if (i < 0) { return { error: 'there is no object "' + str(e.id, 30) + '"' }; } s.objects[i].locked = !!e.locked; return {}; }
        case 'duplicate_object': {
          i = find(s, e.id); if (i < 0) { return { error: 'there is no object "' + str(e.id, 30) + '"' }; } if (s.objects.length >= LIM.objects) { return { error: 'too many objects' }; }
          s.seq++; t = clone(s.objects[i]); t.id = 'o' + s.seq; t.name = str(t.name + ' copy', LIM.name); s.objects.splice(i + 1, 0, t); s._added = (s._added || []).concat([t.id]); return {};
        }
        case 'fit_canvas': { var bb = boundsOf(s); if (!bb) { return { error: 'there is nothing to fit the canvas around' }; } var mg = num(e.margin, 0, 2000, 20); s.canvas = canvasOf({ x: bb.x - mg, y: bb.y - mg, w: bb.w + 2 * mg, h: bb.h + 2 * mg, bg: s.canvas.bg }, s.canvas); return {}; }
        case 'clear_objects': { s.objects = s.objects.filter(function (x) { return x.locked; }); return {}; }
        default:
          if (extra[e.op]) { var r = extra[e.op].apply(s, e, helpers(), env || {}); return r || {}; }
          return { error: 'unknown action "' + str(e.op, 30) + '" (allowed: ' + ALL_OPS.join(', ') + ')' };
      }
    }
    function applyEdits(spec, edits, env) {
      var s = clone(validate(spec).spec), applied = [], rejected = [], appliedEdits = [], added = [];
      (Array.isArray(edits) ? edits : []).forEach(function (e) {
        var work = clone(s), r; try { r = applyOne(work, e, env); } catch (err) { r = { error: String((err && err.message) || err) }; }
        if (r && r.error) { rejected.push({ op: e && e.op, error: r.error }); return; }
        if (work._added) { added = added.concat(work._added); delete work._added; }
        s = work; applied.push(e.op); appliedEdits.push(e);
      });
      var out = validate(s); return { spec: out.spec, applied: applied, appliedEdits: appliedEdits, rejected: rejected, added: added, problems: out.problems };
    }
    var REL = { right: '右邊', left: '左邊', above: '上面', 'on-top': '上面', below: '下面', inside: '裡面', center: '中央' };
    function placeWords(p) { return (p.of ? p.of + ' 的' : '') + (REL[p.rel] || p.rel || ''); }
    function editWords(e) {
      var t = {
        set_title: function () { return '標題改成「' + e.text + '」'; }, set_canvas: function () { return '畫布 ' + (e.w || '') + '×' + (e.h || '') + (e.bg ? ' ' + e.bg : ''); }, fit_canvas: function () { return '畫布貼合內容'; }, place_object: function () { return '放置物件 ' + e.id; },
        add_object: function () { var o = e.object || {}; return '新增物件「' + (o.name || (types[o.type] && types[o.type].label) || o.type) + '」' + (e.place ? '（' + placeWords(e.place) + '）' : ''); }, update_object: function () { return '修改物件 ' + e.id; },
        remove_object: function () { return '刪掉物件 ' + e.id; }, rename_object: function () { return e.id + ' 改名為 ' + e.name; }, move_object: function () { return '移動物件 ' + e.id + '（' + e.to + '）'; },
        set_visible: function () { return (e.visible === false ? '隱藏 ' : '顯示 ') + e.id; }, set_locked: function () { return (e.locked ? '鎖定 ' : '解鎖 ') + e.id; },
        duplicate_object: function () { return '複製物件 ' + e.id; }, clear_objects: function () { return '清空所有物件'; }
      };
      if (e && extra[e.op] && extra[e.op].words) { return extra[e.op].words(e); }
      return t[e && e.op] ? t[e.op]() : String(e && e.op || '');
    }
    // the object list as text for a model (and for the summary)
    function list(spec) {
      var s = validate(spec).spec;
      if (!s.objects.length) { return '(no objects)'; }
      return s.objects.map(function (o, i) { return (s.objects.length - i) + '. [' + o.id + '] ' + o.name + ' (' + o.type + (o.visible ? '' : ', hidden') + (o.locked ? ', locked' : '') + ')' + (cfg.describeObject ? ' ' + cfg.describeObject(o) : ''); }).reverse().join('\n');
    }
    // what the program can read itself (no model): delete / rename / hide / lock / move an object by its name or number
    function parseObjectCommand(text, spec) {
      var out = { edits: [], matched: [], unmatched: [] }, s = validate(spec).spec, clauses = String(text || '').split(/[，。；;\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
      function ref(r) { r = String(r || '').trim().replace(/^[「"'『]|[」"'』]$/g, ''); var m = /^(?:第\s*)?(\d+)(?:\s*個|\s*號)?$/.exec(r); if (m) { var k = s.objects.length - Number(m[1]); return k >= 0 && k < s.objects.length ? s.objects[k].id : null; } var i = find(s, r); return i >= 0 ? s.objects[i].id : null; }
      clauses.forEach(function (c) {
        var m, e = null, id;
        if ((m = /^(?:把)?\s*(.+?)\s*(?:刪掉|刪除|移除|拿掉)$/.exec(c)) || (m = /^(?:刪掉|刪除|移除|拿掉)\s*(?:物件|圖層)?\s*(.+)$/.exec(c))) { id = ref(m[1].replace(/^(?:物件|圖層)\s*/, '')); if (id) { e = { op: 'remove_object', id: id }; } }
        else if ((m = /^(?:把)?\s*(.+?)\s*(?:隱藏|藏起來)$/.exec(c)) || (m = /^(?:隱藏)\s*(.+)$/.exec(c))) { id = ref(m[1]); if (id) { e = { op: 'set_visible', id: id, visible: false }; } }
        else if ((m = /^(?:把)?\s*(.+?)\s*(?:顯示出來|顯示)$/.exec(c)) || (m = /^(?:顯示)\s*(.+)$/.exec(c))) { id = ref(m[1]); if (id) { e = { op: 'set_visible', id: id, visible: true }; } }
        else if ((m = /^(?:鎖定)\s*(.+)$/.exec(c)) || (m = /^(?:把)?\s*(.+?)\s*鎖定$/.exec(c))) { id = ref(m[1]); if (id) { e = { op: 'set_locked', id: id, locked: true }; } }
        else if ((m = /^(?:解鎖)\s*(.+)$/.exec(c)) || (m = /^(?:把)?\s*(.+?)\s*解鎖$/.exec(c))) { id = ref(m[1]); if (id) { e = { op: 'set_locked', id: id, locked: false }; } }
        else if ((m = /^(?:把)?\s*(.+?)\s*(?:改名(?:成|為)?|重新命名(?:成|為)?)\s*[「"'『]?(.+?)[」"'』]?$/.exec(c))) { id = ref(m[1]); if (id) { e = { op: 'rename_object', id: id, name: m[2] }; } }
        else if ((m = /^(?:把)?\s*(.+?)\s*(移到最上面|移到最上層|放到最上面|移到最下面|移到最下層|放到最下面|往上一層|上移|往下一層|下移)$/.exec(c))) { id = ref(m[1]); if (id) { var w = m[2]; e = { op: 'move_object', id: id, to: /最上|上移|往上/.test(w) ? (/一層|上移/.test(w) ? 'up' : 'front') : (/一層|下移/.test(w) ? 'down' : 'back') }; } }
        else if ((m = /^(?:把)?\s*(.+?)\s*(?:放到|移到|放在|擺到|搬到)\s*(.+?)\s*的?\s*(右邊|右側|左邊|左側|上面|上方|下面|下方|中間|中央|裡面)$/.exec(c))) { id = ref(m[1]); var anchorId = ref(m[2]); if (id && anchorId && id !== anchorId) { var w2 = m[3]; e = { op: 'place_object', id: id, place: { of: anchorId, rel: /右/.test(w2) ? 'right' : /左/.test(w2) ? 'left' : /上/.test(w2) ? 'above' : /下/.test(w2) ? 'below' : /裡面/.test(w2) ? 'inside' : 'center' } }; } }
        else if ((m = /^(?:複製)\s*(.+)$/.exec(c))) { id = ref(m[1]); if (id) { e = { op: 'duplicate_object', id: id }; } }
        else if ((m = /(?:標題)\s*(?:改成|換成|改為|設為|叫做?|是)\s*[「"'『]?(.+?)[」"'』]?$/.exec(c))) { e = { op: 'set_title', text: m[1] }; }
        if (e) { out.edits.push(e); out.matched.push(c); } else { out.unmatched.push(c); }
      });
      return out;
    }
    return { OPS: ALL_OPS, bounds: boundsOf, validate: validate, applyEdits: applyEdits, editWords: editWords, list: list, byId: byId, find: find, parseObjectCommand: parseObjectCommand, clone: clone };
  }
  // the JSON an editor's AI may answer with: only { say, edits:[…] }, every action in the list
  function parseEditsReply(text, ops) {
    var s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b <= a) { return { ok: false, say: '', edits: [], error: 'the answer is not JSON' }; }
    var j; try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { return { ok: false, say: '', edits: [], error: 'the answer is not JSON' }; }
    var all = Array.isArray(j.edits) ? j.edits : [], edits = all.filter(function (e) { return e && ops.indexOf(e.op) >= 0; }).slice(0, 30);
    return { ok: true, say: j.say ? str(j.say, 300) : '', edits: edits, dropped: all.length - edits.length };
  }
  return { make: make, parseEditsReply: parseEditsReply, OPS: OPS, COLOR: COLOR, str: str, num: num, clone: clone };
});
