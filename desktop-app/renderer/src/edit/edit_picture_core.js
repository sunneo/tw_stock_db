// /edit-picture: the document core (pure functions; node and the browser). A picture is a stack of OBJECTS (layers) on an endless plane, like /edit-svg, but the result is a raster picture and there is
// GIMP-like after-work. Object types:
//   image    { ref, mime, x, y, w, h, opacity, rotate, blend, flipX, flipY, credit, prompt, seed }      a raster picture (pasted, from the web, made by the local model)
//   shape    as in /edit-svg (rect, ellipse, line, arrow, triangle, polygon, star, path, text) + blend
//   svg      as in /edit-svg (free SVG elements: what the AI draws) + blend
//   adjust   { ops:[ {op:'brightness',amount:10}, {op:'oil',radius:3}, ... ], target:'all'|<object id>, region?:{x,y,w,h}, opacity }   a FILTER layer: it changes everything below it (or one object), without
//            touching the pixels of the pictures below; hide it and the picture is as before
//   heal     { marks:[ {x,y,r} | {x,y,w,h} | {points:[[x,y],...], r} ], method:'inpaint'|'denoise'|'despeckle', radius, target }   a REPAIR layer: the marked spots are filled from what is around them
//   detail   { region:{x,y,w,h} | marks, target, prompt, strength, feather, context, model:'auto'|'online'|'local', seed, crop, result, refine, state:'pending'|'preview'|'applied', opacity }   a DETAIL layer (diffusion): the model redraws ONE small
//            region (with a ring of context around it) and the result is laid back over the picture with a feathered edge and matched tones (pic_detail.js); the picture below is never changed, hide the layer and it is as before
// Everything the AI adds through the chat is a new object. Actions: the closed ones of edit_objects_core.js, transform_object (as in /edit-svg), and
//   apply_style{style, strength?, target?}   a named look as one filter layer (oil, watercolor, sketch, ink, cartoon, pixel, poster, vintage, neon, emboss, halftone, dreamy, mono, warm, cool, night)
//   add_heal{of?, at?, r?, method?}           repair a spot of a picture, said in words: the corner / the middle of an object
//   add_detail{of?, at?, r?, prompt?, strength?}  a detail layer on a spot of a picture, said in words (the host then redraws that region: generate_detail)
// and two actions the HOST carries out (they need the network or the local model): find_picture{query}, generate_image{prompt, style?}.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./edit_objects_core.js'), require('./edit_svg_core.js'), require('./pic_fx.js'), require('../imgproc/imgproc_core.js')); else root.FaEditPicture = factory((root.FaEditObjects || (typeof FaEditObjects !== 'undefined' ? FaEditObjects : undefined)), (root.FaEditSvg || (typeof FaEditSvg !== 'undefined' ? FaEditSvg : undefined)), (root.FaPicFx || (typeof FaPicFx !== 'undefined' ? FaPicFx : undefined)), (root.FaImgProc || (typeof FaImgProc !== 'undefined' ? FaImgProc : undefined))); })(typeof self !== 'undefined' ? self : this, function (O, S, F, IP) {
  'use strict';
  var num = O.num, str = O.str;
  var BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion'];
  var GEOM = { rotate: 1, scale: 1, crop: 1, flip: 1 };
  function r2(n) { return Math.round(n * 100) / 100; }
  function withBlend(t, extraDefaults) {
    return Object.assign({}, t, { defaults: Object.assign({}, t.defaults, { blend: 'normal' }, extraDefaults || {}), validate: function (o) { var r = t.validate(o); if (r.obj) { r.obj.blend = BLENDS.indexOf(o.blend) >= 0 ? o.blend : 'normal'; } return r; } });
  }
  var NUM_PARAMS = { radius: [1, 12], levels: [3, 64], strength: [0.1, 4], size: [3, 60], edge: [20, 400], paper: [0, 1], threshold: [5, 150] };
  function normOps(list, problems) {
    var out = [], arr = Array.isArray(list) ? list : [];
    arr.slice(0, 12).forEach(function (o) {
      if (typeof o === 'string') { o = { op: o }; }   // 'oil' / '油畫' as a short form
      if (!o || typeof o !== 'object') { return; }
      var fx = F.fxName(o.op);
      if (fx) { var c = { op: fx }; Object.keys(NUM_PARAMS).forEach(function (k) { if (o[k] != null && isFinite(Number(o[k]))) { c[k] = r2(num(o[k], NUM_PARAMS[k][0], NUM_PARAMS[k][1], NUM_PARAMS[k][0])); } }); out.push(c); return; }
      var n = IP.normalizeOps([o]);
      if (!n.ok) { problems.push(n.errors[0]); return; }
      if (GEOM[n.ops[0].op]) { problems.push('"' + n.ops[0].op + '" changes the size: use the object\'s rotate / flip, or the canvas frame, instead of a filter layer'); return; }
      out.push(n.ops[0]);
    });
    return out;
  }
  function idOk(v) { return v === 'all' || /^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(String(v || '')); }
  function regionOf(r) { if (!r || typeof r !== 'object') { return null; } var w = Number(r.w), h = Number(r.h); if (!(w > 0 && h > 0)) { return null; } return { x: r2(num(r.x, -1e6, 1e6, 0)), y: r2(num(r.y, -1e6, 1e6, 0)), w: r2(num(w, 1, 1e5, 100)), h: r2(num(h, 1, 1e5, 100)) }; }
  function markBox(m) {
    if (m.points && m.points.length) { var xs = m.points.map(function (p) { return p[0]; }), ys = m.points.map(function (p) { return p[1]; }), r = m.r || 8; return { x: Math.min.apply(null, xs) - r, y: Math.min.apply(null, ys) - r, w: Math.max.apply(null, xs) - Math.min.apply(null, xs) + 2 * r, h: Math.max.apply(null, ys) - Math.min.apply(null, ys) + 2 * r }; }
    if (m.w != null) { return { x: m.x, y: m.y, w: m.w, h: m.h }; }
    var rr = m.r || 10; return { x: m.x - rr, y: m.y - rr, w: 2 * rr, h: 2 * rr };
  }

  var types = {
    image: {
      label: '圖片', defaults: { ref: '', mime: 'image/png', x: 0, y: 0, w: 200, h: 150, opacity: 1, rotate: 0, blend: 'normal', flipX: false, flipY: false, credit: '', prompt: '', seed: null },
      validate: function (o) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(o.ref || ''))) { return { obj: null, problems: ['the picture has no reference'] }; }
        return { obj: { ref: String(o.ref), mime: /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(o.mime) ? o.mime : 'image/png', x: r2(num(o.x, -1e6, 1e6, 0)), y: r2(num(o.y, -1e6, 1e6, 0)), w: r2(num(o.w, 1, 1e5, 200)), h: r2(num(o.h, 1, 1e5, 150)), opacity: r2(num(o.opacity, 0, 1, 1)), rotate: r2(num(o.rotate, -3600, 3600, 0)), blend: BLENDS.indexOf(o.blend) >= 0 ? o.blend : 'normal', flipX: !!o.flipX, flipY: !!o.flipY, credit: str(o.credit, 300), prompt: str(o.prompt, 600), seed: o.seed == null || o.seed === '' ? null : Math.round(num(o.seed, 0, 4294967295, 0)) }, problems: [] };
      },
      bbox: function (o) { return { x: o.x, y: o.y, w: o.w, h: o.h }; }
    },
    shape: withBlend(S.types.shape), svg: withBlend(S.types.svg),
    adjust: {
      label: '濾鏡', defaults: { ops: [], target: 'all', region: null, opacity: 1 },
      validate: function (o) {
        var p = [], ops = normOps(o.ops, p); if (!ops.length) { return { obj: null, problems: p.length ? p : ['a filter layer needs at least one operation'] }; }
        var t = o.target == null || o.target === '' ? 'all' : String(o.target); if (!idOk(t)) { p.push('target must be all or an object id'); t = 'all'; }
        return { obj: { ops: ops, target: t, region: regionOf(o.region), opacity: r2(num(o.opacity, 0, 1, 1)) }, problems: p };
      },
      bbox: function (o) { return o.region ? { x: o.region.x, y: o.region.y, w: o.region.w, h: o.region.h } : null; },
      move: function (o, dx, dy) { if (o.region) { o.region.x = r2(o.region.x + dx); o.region.y = r2(o.region.y + dy); } }
    },
    detail: {
      label: '細化', defaults: { region: null, marks: [], target: 'all', prompt: '', strength: 0.5, feather: 0.08, context: 0.5, model: 'auto', seed: null, crop: null, result: '', refine: '', state: 'pending', opacity: 1, repaint: false },
      validate: function (o) {
        var p = [], region = regionOf(o.region), marks = [];
        (Array.isArray(o.marks) ? o.marks : []).slice(0, 200).forEach(function (m) {
          if (!m || typeof m !== 'object') { return; }
          if (Array.isArray(m.points)) { var pts = m.points.slice(0, 2000).filter(function (q) { return Array.isArray(q) && isFinite(q[0]) && isFinite(q[1]); }).map(function (q) { return [r2(Number(q[0])), r2(Number(q[1]))]; }); if (pts.length) { marks.push({ points: pts, r: r2(num(m.r, 1, 500, 8)) }); } }
          else if (m.w != null && m.h != null && Number(m.w) > 0 && Number(m.h) > 0) { marks.push({ x: r2(num(m.x, -1e6, 1e6, 0)), y: r2(num(m.y, -1e6, 1e6, 0)), w: r2(num(m.w, 1, 1e5, 10)), h: r2(num(m.h, 1, 1e5, 10)) }); }
        });
        if (!region && !marks.length) { return { obj: null, problems: ['say or mark which part to refine (a box or a stroke)'] }; }
        var t = o.target == null || o.target === '' ? 'all' : String(o.target); if (!idOk(t)) { p.push('target must be all or an object id'); t = 'all'; }
        var result = /^[A-Za-z0-9_-]{1,64}$/.test(String(o.result || '')) ? String(o.result) : '', st = ['pending', 'preview', 'applied'].indexOf(o.state) >= 0 ? o.state : 'pending'; if (!result) { st = 'pending'; } else if (st === 'pending') { st = 'preview'; }
        return { obj: { region: region, marks: region ? [] : marks, target: t, prompt: str(o.prompt, 600), strength: r2(num(o.strength, 0.1, 1, 0.5)), feather: r2(num(o.feather, 0, 0.5, 0.08)), context: r2(num(o.context, 0, 2, 0.5)), model: ['auto', 'online', 'local'].indexOf(o.model) >= 0 ? o.model : 'auto', seed: o.seed == null || o.seed === '' ? null : Math.round(num(o.seed, 0, 4294967295, 0)), crop: regionOf(o.crop), result: result, refine: ['edit', 'texture'].indexOf(o.refine) >= 0 ? o.refine : '', state: st, opacity: r2(num(o.opacity, 0, 1, 1)), repaint: o.repaint === true || o.repaint === 'true' || o.repaint === 1 }, problems: p };
      },
      bbox: function (o) { if (o.region) { return { x: o.region.x, y: o.region.y, w: o.region.w, h: o.region.h }; } if (!o.marks.length) { return null; } var x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18; o.marks.forEach(function (m) { var b = markBox(m); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; },
      move: function (o, dx, dy) { if (o.region) { o.region.x = r2(o.region.x + dx); o.region.y = r2(o.region.y + dy); } if (o.crop) { o.crop.x = r2(o.crop.x + dx); o.crop.y = r2(o.crop.y + dy); } o.marks.forEach(function (m) { if (m.points) { m.points = m.points.map(function (q) { return [r2(q[0] + dx), r2(q[1] + dy)]; }); } else { m.x = r2(m.x + dx); m.y = r2(m.y + dy); } }); }
    },
    heal: {
      label: '修復', defaults: { marks: [], method: 'inpaint', radius: 3, target: 'all' },
      validate: function (o) {
        var p = [], marks = [];
        (Array.isArray(o.marks) ? o.marks : []).slice(0, 200).forEach(function (m) {
          if (!m || typeof m !== 'object') { return; }
          if (Array.isArray(m.points)) { var pts = m.points.slice(0, 2000).filter(function (q) { return Array.isArray(q) && isFinite(q[0]) && isFinite(q[1]); }).map(function (q) { return [r2(Number(q[0])), r2(Number(q[1]))]; }); if (pts.length) { marks.push({ points: pts, r: r2(num(m.r, 1, 500, 8)) }); } }
          else if (m.w != null && m.h != null && Number(m.w) > 0 && Number(m.h) > 0) { marks.push({ x: r2(num(m.x, -1e6, 1e6, 0)), y: r2(num(m.y, -1e6, 1e6, 0)), w: r2(num(m.w, 1, 1e5, 10)), h: r2(num(m.h, 1, 1e5, 10)) }); }
          else if (isFinite(Number(m.x)) && isFinite(Number(m.y))) { marks.push({ x: r2(num(m.x, -1e6, 1e6, 0)), y: r2(num(m.y, -1e6, 1e6, 0)), r: r2(num(m.r, 1, 500, 10)) }); }
        });
        if (!marks.length && ['denoise', 'despeckle'].indexOf(o.method) < 0) { return { obj: null, problems: ['mark the spots to repair (a spot, a box or a stroke)'] }; }
        var t = o.target == null || o.target === '' ? 'all' : String(o.target); if (!idOk(t)) { p.push('target must be all or an object id'); t = 'all'; }
        return { obj: { marks: marks, method: ['inpaint', 'denoise', 'despeckle'].indexOf(o.method) >= 0 ? o.method : 'inpaint', radius: Math.round(num(o.radius, 1, 12, 3)), target: t }, problems: p };
      },
      bbox: function (o) { if (!o.marks.length) { return null; } var x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18; o.marks.forEach(function (m) { var b = markBox(m); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; },
      move: function (o, dx, dy) { o.marks.forEach(function (m) { if (m.points) { m.points = m.points.map(function (q) { return [r2(q[0] + dx), r2(q[1] + dy)]; }); } else { m.x = r2(m.x + dx); m.y = r2(m.y + dy); } }); }
    }
  };
  // intensity: the numbers that say "how much" are scaled (a stronger look for the second and third try)
  function scaleOps(ops, k) {
    if (!k || k === 1) { return ops.map(function (o) { return Object.assign({}, o); }); }
    var more = { radius: 1, strength: 1, size: 1, block: 1, amount: 1, paper: 1 }, less = { levels: 1 };
    return ops.map(function (o) { var c = Object.assign({}, o); Object.keys(c).forEach(function (key) { if (typeof c[key] !== 'number') { return; } if (more[key] && key !== 'amount') { c[key] = r2(c[key] * k); } else if (key === 'amount' && (c.op === 'saturation' || c.op === 'contrast' || c.op === 'glow')) { c[key] = r2(c[key] * k); } else if (less[key]) { c[key] = Math.max(3, Math.round(c[key] / k)); } }); return c; });
  }
  // a point of an object in words: the middle, or a corner / side
  var AT = { center: [0.5, 0.5], top: [0.5, 0.12], bottom: [0.5, 0.88], left: [0.12, 0.5], right: [0.88, 0.5], 'top-left': [0.12, 0.12], 'top-right': [0.88, 0.12], 'bottom-left': [0.12, 0.88], 'bottom-right': [0.88, 0.88] };

  var extraOps = {
    transform_object: {   // as in /edit-svg; a filter / repair layer has no x / y: its region or marks move
      words: S.extraOps.transform_object.words,
      apply: function (s, e, H, env) {
        var i = H.find(s, e.id); if (i >= 0 && (s.objects[i].type === 'adjust' || s.objects[i].type === 'heal' || s.objects[i].type === 'detail')) {
          var o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; } var n = H.clone(o); H.move(n, Number(e.dx) || 0, Number(e.dy) || 0); var p = [], v = H.validateObject(n, p, {}); if (!v) { return { error: p[0] || 'the new values are not valid' }; } v.id = o.id; s.objects[i] = v; return {};
        }
        return S.extraOps.transform_object.apply(s, e, H, env);
      }
    },
    apply_style: {
      words: function (e) { var st = F.STYLES[e.style]; return '套用風格「' + (st ? st.label : e.style) + '」'; },
      apply: function (s, e, H, env) {
        var st = F.STYLES[String(e.style || '').toLowerCase()] || F.STYLES[F.styleFor(e.style)]; if (!st) { return { error: 'unknown style "' + str(e.style, 30) + '" (' + Object.keys(F.STYLES).join(', ') + ')' }; }
        var target = 'all', ref = e.target != null && e.target !== '' ? e.target : (env && env.selection && env.selection !== 'none' ? env.selection : null);
        if (ref != null && ref !== 'all') { var i = H.find(s, ref); if (i < 0) { return { error: 'there is no object "' + str(ref, 30) + '" to apply the style to' }; } if (['adjust', 'heal'].indexOf(s.objects[i].type) < 0) { target = s.objects[i].id; } }
        var k = num(e.strength, 0.3, 3, 1), r = H.addTop(s, { type: 'adjust', name: st.label + (target === 'all' ? '' : '（' + s.objects[H.find(s, target)].name + '）'), ops: scaleOps(st.ops, k), target: target, opacity: 1 });
        return r.error ? { error: r.error } : {};
      }
    },
    add_heal: {
      words: function (e) { return '修復 ' + (e.of || '') + (e.at ? ' ' + e.at : ''); },
      apply: function (s, e, H, env) {
        var ref = e.of != null && e.of !== '' ? e.of : null, anchor = null, anchorId = 'all';
        if (ref == null && env && env.selection) { var si = H.find(s, env.selection); if (si >= 0 && ['image', 'shape', 'svg'].indexOf(s.objects[si].type) >= 0) { ref = env.selection; } }
        if (ref == null) { for (var k = s.objects.length - 1; k >= 0 && ref == null; k--) { if (s.objects[k].type === 'image') { ref = s.objects[k].id; } } }
        if (ref == null) { for (var k2 = s.objects.length - 1; k2 >= 0 && ref == null; k2--) { if (s.objects[k2].type === 'shape' || s.objects[k2].type === 'svg') { ref = s.objects[k2].id; } } }
        if (ref == null) { return { error: 'there is no picture to repair' }; }
        var i = H.find(s, ref); if (i < 0) { return { error: 'there is no object "' + str(ref, 30) + '" to repair' }; } anchor = H.bbox(s.objects[i]); if (!anchor) { return { error: 'that object has no size' }; } if (['image', 'shape', 'svg'].indexOf(s.objects[i].type) >= 0) { anchorId = s.objects[i].id; }
        var f = AT[String(e.at || 'center').toLowerCase()]; if (!f) { return { error: 'at must be one of ' + Object.keys(AT).join(', ') }; }
        var r = num(e.r, 1, 500, Math.max(6, Math.round(Math.min(anchor.w, anchor.h) * 0.06))), mark = { x: anchor.x + anchor.w * f[0], y: anchor.y + anchor.h * f[1], r: r };
        var res = H.addTop(s, { type: 'heal', name: '修復', marks: [mark], method: e.method || 'inpaint', radius: 3, target: anchorId }); return res.error ? { error: res.error } : {};
      }
    }
  };
  extraOps.add_detail = {
    words: function (e) { return '細化 ' + (e.of || '') + (e.at ? ' ' + e.at : ''); },
    apply: function (s, e, H, env) {
      var ref = e.of != null && e.of !== '' ? e.of : null, anchorId = 'all';
      if (ref == null && env && env.selection) { var si = H.find(s, env.selection); if (si >= 0 && ['image', 'shape', 'svg'].indexOf(s.objects[si].type) >= 0) { ref = env.selection; } }
      if (ref == null) { for (var k = s.objects.length - 1; k >= 0 && ref == null; k--) { if (s.objects[k].type === 'image') { ref = s.objects[k].id; } } }
      if (ref == null) { return { error: 'there is no picture to refine' }; }
      var i = H.find(s, ref); if (i < 0) { return { error: 'there is no object "' + str(ref, 30) + '" to refine' }; } var anchor = H.bbox(s.objects[i]); if (!anchor) { return { error: 'that object has no size' }; } if (['image', 'shape', 'svg'].indexOf(s.objects[i].type) >= 0) { anchorId = s.objects[i].id; }
      var f = AT[String(e.at || 'center').toLowerCase()]; if (!f) { return { error: 'at must be one of ' + Object.keys(AT).join(', ') }; }
      var r = num(e.r, 4, 2000, Math.max(16, Math.round(Math.min(anchor.w, anchor.h) * 0.18))), cx = anchor.x + anchor.w * f[0], cy = anchor.y + anchor.h * f[1];
      var res = H.addTop(s, { type: 'detail', name: '細化', region: { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, target: anchorId, prompt: str(e.prompt, 600), strength: e.strength, repaint: e.repaint === true }); return res.error ? { error: res.error } : {};
    }
  };
  var HOST_OPS = ['find_picture', 'generate_image', 'generate_detail'];
  var E = O.make({
    types: types, extraOps: extraOps, limits: { objects: 400, canvas: 16384 },
    defaultSpec: function () { return { v: 1, title: '我的圖片', canvas: { x: 0, y: 0, w: 800, h: 600, bg: '#ffffff' }, seq: 0, objects: [] }; },
    describeObject: function (o) { var b = types[o.type].bbox(o); return (b ? '@(' + Math.round(b.x) + ',' + Math.round(b.y) + ' ' + Math.round(b.w) + '×' + Math.round(b.h) + ')' : '') + (o.type === 'adjust' ? ' ' + o.ops.map(function (x) { return x.op; }).join('+') + (o.target !== 'all' ? ' on ' + o.target : '') : o.type === 'heal' ? ' ' + o.method + ' ×' + o.marks.length : o.type === 'detail' ? ' ' + o.state + (o.prompt ? ' "' + o.prompt.slice(0, 20) + '"' : '') : o.type === 'shape' ? ' ' + o.shape : ''); }
  });
  var ALL_OPS = E.OPS.concat(HOST_OPS);

  // ───────────────────────── what the program reads itself ─────────────────────────
  var QUICK = [
    [/^(?:把)?(?:它|圖片|這張圖|這張|整張圖)?\s*(?:調亮|變亮|亮一點|亮一些|調亮一點|調亮一些|提高亮度|增加亮度|亮度高一點|亮度提高|亮度增加)$/, { op: 'brightness', amount: 18 }, '調亮'], [/^(?:把)?(?:它|圖片|這張圖|這張|整張圖)?\s*(?:調暗|變暗|暗一點|暗一些|調暗一點|調暗一些|降低亮度|減少亮度|亮度低一點|亮度降低|亮度減少)$/, { op: 'brightness', amount: -18 }, '調暗'],
    [/^(?:把)?(?:它|圖片|這張圖|這張|整張圖)?\s*(?:增加對比|對比高一點|提高對比|對比強一點)$/, { op: 'contrast', amount: 20 }, '提高對比'], [/^(?:把)?(?:它|圖片|這張圖|這張|整張圖)?\s*(?:降低對比|對比低一點)$/, { op: 'contrast', amount: -20 }, '降低對比'],
    [/^(?:把)?(?:它|圖片|這張圖|這張|整張圖)?\s*(?:更鮮豔|飽和度高一點|提高飽和度|增加飽和度)$/, { op: 'saturation', amount: 25 }, '提高飽和度'], [/^(?:把)?(?:它|圖片|這張圖|這張|整張圖)?\s*(?:淡一點|飽和度低一點|降低飽和度)$/, { op: 'saturation', amount: -25 }, '降低飽和度'],
    [/^(?:把)?(?:它|圖片|這張圖|這張|整張圖)?\s*(?:模糊|模糊一點|柔化)$/, { op: 'blur', radius: 3 }, '模糊'], [/^(?:把)?(?:它|圖片|這張圖|這張|整張圖)?\s*(?:銳利一點|銳化|更清晰|清楚一點)$/, { op: 'sharpen', amount: 1 }, '銳化'],
    [/^(?:把)?(?:它|圖片|這張圖|這張|整張圖)?\s*(?:反相|負片)$/, { op: 'invert' }, '反相'], [/^(?:把)?(?:它|圖片|這張圖|這張|整張圖)?\s*(?:自動調整|自動對比|自動色階|一鍵修正)$/, { op: 'auto_contrast' }, '自動對比'],
    [/^(?:把)?(?:它|圖片|這張圖|這張|整張圖)?\s*(?:去雜訊|去噪|降噪|去除雜訊)$/, { op: 'denoise' }, '去雜訊'], [/^(?:把)?(?:它|圖片|這張圖|這張|整張圖)?\s*(?:去污點|去雜點|去刮痕|去灰塵|去除污點|去除刮痕)$/, { op: 'despeckle' }, '去污點與刮痕']
  ];
  function parseCommands(text, spec, opts) {
    var s = E.validate(spec).spec, edits = [], matched = [], rest = [], clauses = String(text || '').split(/[，。；;\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    clauses.forEach(function (c) {
      var oc = E.parseObjectCommand(c, spec); if (oc.edits.length) { edits = edits.concat(oc.edits); matched.push(c); return; }
      var sv = S.parseCommands(c, spec); if (sv.edits.length && sv.edits.every(function (e) { return ['update_object', 'transform_object', 'set_canvas', 'fit_canvas'].indexOf(e.op) >= 0; })) { edits = edits.concat(sv.edits); matched.push(c); return; }
      for (var i = 0; i < QUICK.length; i++) { if (QUICK[i][0].test(c)) { edits.push({ op: 'add_object', object: { type: 'adjust', name: QUICK[i][2], ops: [QUICK[i][1]], target: 'all' } }); matched.push(c); return; } }
      var m = /^(?:把)?\s*(?:它|圖片|這張圖|這張|整張圖)?\s*(?:變成|轉成|改成|換成|做成|弄成|套用|加上|加)\s*(.+?)\s*(?:風格|風|效果|濾鏡|的樣子|樣式)?$/.exec(c), st = m ? F.styleFor(m[1]) : null;
      if (st && m[1].length <= 12 && !(opts && opts.styleToHost)) { edits.push({ op: 'apply_style', style: st }); matched.push(c); return; }
      rest.push(c);
    });
    return { edits: edits, matched: matched, unmatched: rest };
  }

  // ───────────────────────── for the AI ─────────────────────────
  var OPNAMES = 'brightness、contrast、saturation（amount −100～100）、gamma（value）、auto_contrast、enhance、tone、grade（preset: warm cool dusk night noon teal_orange sepia fade）、vignette（strength）、hue、shadows_highlights、blur（radius）、sharpen（amount）、glow（amount）、grayscale、invert、posterize（levels）、reduce_colors（colors）、mosaic（block）、lens_blur、bokeh、motion_blur、chroma_shift、threshold；油畫 oil（radius）、素描 sketch、卡通 cartoon、水彩 watercolor、浮雕 emboss、網點 halftone、霓虹 neon、降噪 denoise、去污點 despeckle';
  var ACTIONS = '{op:"apply_style",style:"watercolor",target:"o2"}（一句話套用風格：' + Object.keys(F.STYLES).join('、') + '；target 是某個圖片物件，不寫就是整張；strength 1～3 越大越強）、'
    + '{op:"add_object",object:{type:"adjust",name:"調亮",ops:[{op:"brightness",amount:20},{op:"contrast",amount:10}],target:"all"}}（濾鏡層：ops 可用 ' + OPNAMES + '；它改變它下面的所有東西或 target 指定的那個物件，原圖不動，隱藏它就回到原樣；不能用旋轉、縮放、裁切）、'
    + '{op:"add_heal",of:"o2",at:"bottom-right",r:30,method:"inpaint"}（修復某個圖片物件的某個位置：at 是 center、top、bottom、left、right、top-left、top-right、bottom-left、bottom-right；method 是 inpaint 補洞、denoise、despeckle）、'
    + '{op:"add_detail",of:"o2",at:"top",r:60,prompt:"臉的細節"}（擴散細化：只針對圖片物件的某一小塊，請生圖模型重畫細節再羽化蓋回去；at 同 add_heal；要使用者啟用「擴散編修」才做得到，之後由程式執行 generate_detail）、'
    + '{op:"add_object",object:{type:"shape",name:"太陽",shape:"ellipse",w:120,h:120,fill:"#fdd835"},place:{of:"o2",rel:"above",gap:20}}（形狀與 svg 物件的寫法同 SVG 編輯器：shape 可以是 rect、ellipse、line、arrow、triangle、polygon、star、path、text；place 說在哪個物件的哪一邊）、'
    + '{op:"add_object",object:{type:"svg",name:"小房子",markup:"<g>…</g>",w:120,h:100},place:{of:"view",rel:"center"}}、{op:"update_object",id:"o3",props:{opacity:0.5,blend:"multiply",rotate:10,flipX:true}}（blend：' + BLENDS.join('、') + '）、{op:"transform_object",id:"o3",dx:50,dy:0,scale:1.5,rotate:15}、{op:"place_object",id:"o3",place:{of:"o5",rel:"right"}}、'
    + '{op:"remove_object",id:"o3"}、{op:"rename_object",id:"o3",name:"…"}、{op:"move_object",id:"o3",to:"front"|"back"|"up"|"down"}、{op:"set_visible",id:"o3",visible:false}、{op:"set_locked",id:"o3",locked:true}、{op:"duplicate_object",id:"o3"}、{op:"set_canvas",x:0,y:0,w:800,h:600,bg:"#ffffff"}（畫布就是裁切／輸出的範圍）、{op:"fit_canvas"}、{op:"set_title",text:"…"}、'
    + '{op:"find_picture",query:"airplane wing"}（程式上網找一張照片放進來，英文關鍵字）、{op:"generate_image",prompt:"一隻貓坐在窗邊",style:"watercolor"}（用生圖模型（線上或本機）畫一張新圖放進來）';
  function editPrompt(spec, text, extra, selection) {
    var s = E.validate(spec).spec, b = E.bounds(s);
    var system = '你是圖片編輯助手（像 GIMP，但用說話操作）。使用者說想怎麼改這張圖，你把它翻成「編輯動作」。只回一段 JSON，不要說明、不要 markdown 區塊：{"say":"一句話告訴使用者你做了什麼（做不到就說做不到）","edits":[…]}。\n'
      + '**你新增的每一樣東西都是一個新的物件（圖層）**，要取一個看得懂的 name；後製（調色、風格、修復）用濾鏡層與修復層，**不要動原圖**。畫面是一個沒有邊界的平面，座標可以是任何數字；「畫布」只是裁切／輸出的範圍框。y 往下增加。\n'
      + '動作只能是下面這些（不要發明新的動作）：\n' + ACTIONS + '\n優先用 place／at 這種相對位置，不要自己猜座標。一次最多 25 個動作。\n使用者要「把這張圖變成某某風格」：用 apply_style，不要自己拼一堆 ops；想要完全重畫成那個風格才用 generate_image。';
    var user = '目前的圖片「' + s.title + '」，畫布範圍框 x=' + s.canvas.x + ' y=' + s.canvas.y + ' ' + s.canvas.w + '×' + s.canvas.h + (b ? '；內容範圍 x=' + Math.round(b.x) + ' y=' + Math.round(b.y) + ' ' + Math.round(b.w) + '×' + Math.round(b.h) : '；目前沒有內容') + '。\n圖層（最上層是 1）：\n' + E.list(s) + (selection ? '\n\n使用者目前選取的是 ' + selection + '（說「它」「這個」就是指它）。' : '') + (extra ? '\n\n' + extra : '') + '\n\n使用者說：' + String(text || '');
    return { system: system, user: user };
  }
  function refPrompt() { return 'Describe this picture in two or three short sentences: the subject, the style (photo, painting, drawing, 3D, pixel ...), the main colours and the mood. Only what you can see.'; }
  function specToPrompt(spec, steps) {
    var s = E.validate(spec).spec, L = ['請做一張圖片「' + s.title + '」，範圍 ' + s.canvas.w + '×' + s.canvas.h + '，背景 ' + s.canvas.bg + '。', '', '圖層（由下到上）：'];
    s.objects.forEach(function (o, i) { L.push((i + 1) + '. ' + o.name + '（' + o.type + (o.type === 'image' && o.prompt ? '，用「' + o.prompt + '」畫的' : '') + (o.type === 'image' && o.credit ? '，出處：' + o.credit : '') + (o.type === 'adjust' ? '：' + o.ops.map(function (x) { return x.op; }).join('、') : '') + '）'); });
    var texts = (steps || []).filter(function (x) { return x.text; });
    if (texts.length) { L.push('', '（有效的指示，依序）：'); texts.forEach(function (x, i) { L.push((i + 1) + '. ' + x.text + (x.summary ? ' → ' + x.summary : '')); }); }
    return L.join('\n');
  }
  // the program reads "refine this part" itself (the host does the drawing)
  var DETAIL_WORDS = /(細化|加細節|多一點細節|更多細節|補細節|更精細|精細一點|refine|more detail|add (?:more )?detail)/i;
  function detailIntent(text) { return DETAIL_WORDS.test(String(text || '')); }
  function parseEditsReply(t) { return O.parseEditsReply(t, ALL_OPS); }
  var STARTERS = [
    { id: 'blank', label: '空白畫布', desc: '一張空的畫布，貼圖進來、找圖或用說的畫。', spec: function () { return { title: '我的圖片', objects: [] }; } },
    { id: 'poster', label: '海報底稿', desc: '一張海報的底稿：背景、標題、形狀，可以再請 AI 加圖與風格。', spec: function () { return { title: '海報', canvas: { w: 600, h: 800, bg: '#fff8e1' }, objects: [{ type: 'shape', name: '色塊', shape: 'rect', x: 0, y: 0, w: 600, h: 280, fill: '#ffb300' }, { type: 'shape', name: '標題', shape: 'text', x: 40, y: 150, text: '標題在這裡', size: 64, fill: '#3e2723' }, { type: 'shape', name: '圓', shape: 'ellipse', x: 400, y: 500, w: 160, h: 160, fill: '#e53935' }] }; } }
  ];
  function starter(id) { var t = STARTERS.filter(function (x) { return x.id === id; })[0]; return t ? E.validate(t.spec()).spec : null; }
  function listStarters() { return STARTERS.map(function (t) { return { id: t.id, label: t.label, desc: t.desc }; }); }

  return { E: E, types: types, OPS: ALL_OPS, CORE_OPS: E.OPS, HOST_OPS: HOST_OPS, BLENDS: BLENDS, validate: E.validate, applyEdits: E.applyEdits, editWords: E.editWords, list: E.list, find: E.find, bounds: E.bounds, parseCommands: parseCommands, editPrompt: editPrompt, parseEditsReply: parseEditsReply,
    refPrompt: refPrompt, specToPrompt: specToPrompt, scaleOps: scaleOps, markBox: markBox, detailIntent: detailIntent, starter: starter, listStarters: listStarters, STARTERS: listStarters(), STYLES: F.STYLES, AT: AT };
});
