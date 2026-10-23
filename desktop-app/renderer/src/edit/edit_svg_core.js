// /edit-svg: the document core (pure functions; node and the browser). A drawing is a list of OBJECTS on an endless plane (see edit_objects_core.js); the user and the AI add, change, hide, lock, move and
// delete objects, and the whole thing is composed into ONE SVG for export. Object types:
//   shape   { shape:'rect'|'ellipse'|'line'|'arrow'|'triangle'|'polygon'|'star'|'path'|'text', x, y, w, h, fill, stroke, sw, opacity, rotate, rx, text, size, sides, d }
//   svg     { markup, x, y, w, h, scale, rotate, opacity }       free SVG elements (what the AI draws, what a traced picture becomes): coordinates inside `markup` are the object's own, x / y move it
//   image   { ref, mime, x, y, w, h, opacity, credit }             a raster picture (from the web, pasted into the chat, ...); the pixels are kept apart (ref) so the history stays small
// Everything the AI adds through the chat is a NEW OBJECT with a name; it answers only with the closed actions of edit_objects_core.js plus  transform_object{id,dx,dy,scale,rotate}  patch_markup{id,find,replace}.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./edit_objects_core.js')); else root.FaEditSvg = factory((root.FaEditObjects || (typeof FaEditObjects !== 'undefined' ? FaEditObjects : undefined))); })(typeof self !== 'undefined' ? self : this, function (O) {
  'use strict';
  var num = O.num, str = O.str, COLOR = O.COLOR;
  var SHAPES = ['rect', 'ellipse', 'line', 'arrow', 'triangle', 'polygon', 'star', 'path', 'text'];
  var PATH_OK = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]{1,20000}$/;
  var NAMED = { 紅: '#e53935', 紅色: '#e53935', 橘: '#fb8c00', 橘色: '#fb8c00', 橙色: '#fb8c00', 黃: '#fdd835', 黃色: '#fdd835', 綠: '#43a047', 綠色: '#43a047', 藍: '#1e88e5', 藍色: '#1e88e5', 紫: '#8e24aa', 紫色: '#8e24aa', 粉紅: '#ec407a', 粉紅色: '#ec407a', 粉色: '#ec407a', 黑: '#111111', 黑色: '#111111', 白: '#ffffff', 白色: '#ffffff', 灰: '#9e9e9e', 灰色: '#9e9e9e', 棕: '#6d4c41', 棕色: '#6d4c41', 咖啡色: '#6d4c41', 天藍: '#4fc3f7', 天藍色: '#4fc3f7', 金色: '#ffc107', 銀色: '#b0bec5',
    red: '#e53935', orange: '#fb8c00', yellow: '#fdd835', green: '#43a047', blue: '#1e88e5', purple: '#8e24aa', pink: '#ec407a', black: '#111111', white: '#ffffff', gray: '#9e9e9e', grey: '#9e9e9e', brown: '#6d4c41' };
  function colorOf(v, d) { var s = String(v == null ? '' : v).trim(); if (NAMED[s.toLowerCase()] || NAMED[s]) { return NAMED[s.toLowerCase()] || NAMED[s]; } return COLOR.test(s) ? s : d; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function r2(n) { return Math.round(n * 100) / 100; }

  // what in a piece of SVG is never allowed: scripts, foreign objects, event handlers, links that leave the picture (the browser also runs DOMPurify over it before showing)
  function checkMarkup(m) {
    var s = String(m == null ? '' : m), problems = [];
    if (!s.trim()) { return { ok: false, problems: ['the drawing is empty'] }; }
    if (s.length > 400000) { problems.push('the drawing is too big (more than 400000 characters)'); }
    if (/<\s*(script|foreignObject|iframe|object|embed|audio|video|style\b[^>]*>[\s\S]*?@import)/i.test(s)) { problems.push('script / foreignObject / iframe / @import are not allowed'); }
    if (/\son[a-z]+\s*=/i.test(s)) { problems.push('event attributes (onclick ...) are not allowed'); }
    if (/(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/(?:png|jpe?g|gif|webp|svg\+xml))[^"']*["']/i.test(s)) { problems.push('links to other addresses are not allowed (only #id and embedded pictures)'); }
    if (/javascript:|vbscript:/i.test(s)) { problems.push('javascript: addresses are not allowed'); }
    if (!/<\s*(?:g|rect|circle|ellipse|line|polyline|polygon|path|text|image|use|defs|linearGradient|radialGradient)\b/i.test(s)) { problems.push('there is no drawing element in it (rect, circle, path, text ...)'); }
    return { ok: problems.length === 0, problems: problems };
  }
  function unwrap(markup) {   // a whole <svg>...</svg> given as markup: keep its content (the AI often writes the wrapper)
    var s = String(markup || '').trim().replace(/^<\?xml[\s\S]*?\?>/i, '').replace(/<!doctype[^>]*>/i, '').trim(), m = /^<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i.exec(s); return m ? m[1].trim() : s;
  }

  var types = {
    shape: {
      label: '形狀', defaults: { shape: 'rect', x: 0, y: 0, w: 120, h: 80, fill: '#4f8ef7', stroke: 'none', sw: 2, opacity: 1, rotate: 0, rx: 0, text: '', size: 24, sides: 5, d: '' },
      validate: function (o) {
        var p = [], sh = SHAPES.indexOf(o.shape) >= 0 ? o.shape : 'rect'; if (SHAPES.indexOf(o.shape) < 0) { p.push('unknown shape "' + str(o.shape, 20) + '", a rectangle was used'); }
        var out = { shape: sh, x: r2(num(o.x, -1e6, 1e6, 0)), y: r2(num(o.y, -1e6, 1e6, 0)), w: r2(num(o.w, 1, 1e5, 120)), h: r2(num(o.h, 1, 1e5, 80)), fill: colorOf(o.fill, sh === 'line' || sh === 'arrow' ? 'none' : '#4f8ef7'), stroke: colorOf(o.stroke, 'none'), sw: r2(num(o.sw, 0, 200, 2)), opacity: r2(num(o.opacity, 0, 1, 1)), rotate: r2(num(o.rotate, -3600, 3600, 0)), rx: r2(num(o.rx, 0, 1e4, 0)), text: str(o.text, 400), size: r2(num(o.size, 1, 2000, 24)), sides: Math.round(num(o.sides, 3, 60, 5)), d: '' };
        if (sh === 'line' || sh === 'arrow') { out.w = r2(num(o.w, -1e5, 1e5, 120)); out.h = r2(num(o.h, -1e5, 1e5, 0)); if (out.stroke === 'none') { out.stroke = colorOf(o.fill, '#333333'); if (out.stroke === 'none') { out.stroke = '#333333'; } } out.fill = 'none'; }
        if (sh === 'path') { var d = String(o.d == null ? '' : o.d).trim(); if (!PATH_OK.test(d)) { p.push('the path data is empty or has characters a path may not have'); out.d = 'M0 0'; } else { out.d = d; } }
        if (sh === 'text') { out.w = r2(num(o.w, 1, 1e5, Math.max(20, out.size * 0.6 * Math.max(1, out.text.length)))); out.h = r2(out.size * 1.2); if (!out.text) { p.push('the text is empty'); out.text = 'Text'; } }
        return { obj: out, problems: p };
      },
      bbox: function (o) {
        if (o.shape === 'line' || o.shape === 'arrow') { return { x: Math.min(o.x, o.x + o.w), y: Math.min(o.y, o.y + o.h), w: Math.abs(o.w) || 1, h: Math.abs(o.h) || 1 }; }
        if (o.shape === 'text') { return { x: o.x, y: o.y - o.size, w: o.w, h: o.h }; }
        if (o.shape === 'path') { var nums = (o.d.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) || []).map(Number), xs = [], ys = []; nums.forEach(function (n, i) { (i % 2 ? ys : xs).push(n); }); if (xs.length && ys.length) { var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys); return { x: o.x + x0, y: o.y + y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }; } }
        return { x: o.x, y: o.y, w: o.w, h: o.h };
      }
    },
    svg: {
      label: '圖形', defaults: { markup: '', x: 0, y: 0, w: 100, h: 100, scale: 1, rotate: 0, opacity: 1 },
      validate: function (o) {
        var m = unwrap(o.markup), c = checkMarkup(m); if (!c.ok) { return { obj: null, problems: c.problems }; }
        return { obj: { markup: m, x: r2(num(o.x, -1e6, 1e6, 0)), y: r2(num(o.y, -1e6, 1e6, 0)), w: r2(num(o.w, 1, 1e5, 100)), h: r2(num(o.h, 1, 1e5, 100)), scale: r2(num(o.scale, 0.01, 1000, 1)), rotate: r2(num(o.rotate, -3600, 3600, 0)), opacity: r2(num(o.opacity, 0, 1, 1)) }, problems: [] };
      },
      bbox: function (o) { return { x: o.x, y: o.y, w: o.w * o.scale, h: o.h * o.scale }; }
    },
    image: {
      label: '圖片', defaults: { ref: '', mime: 'image/png', x: 0, y: 0, w: 200, h: 150, opacity: 1, credit: '' },
      validate: function (o) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(o.ref || ''))) { return { obj: null, problems: ['the picture has no reference'] }; }
        return { obj: { ref: String(o.ref), mime: /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(o.mime) ? o.mime : 'image/png', x: r2(num(o.x, -1e6, 1e6, 0)), y: r2(num(o.y, -1e6, 1e6, 0)), w: r2(num(o.w, 1, 1e5, 200)), h: r2(num(o.h, 1, 1e5, 150)), opacity: r2(num(o.opacity, 0, 1, 1)), credit: str(o.credit, 300) }, problems: [] };
      },
      bbox: function (o) { return { x: o.x, y: o.y, w: o.w, h: o.h }; }
    }
  };

  var extraOps = {
    transform_object: {
      words: function (e) { return '變形物件 ' + e.id; },
      apply: function (s, e, H) {
        var i = H.find(s, e.id); if (i < 0) { return { error: 'there is no object "' + str(e.id, 30) + '"' } } var o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; }
        var n = H.clone(o), dx = Number(e.dx) || 0, dy = Number(e.dy) || 0;
        if (o.type === 'shape' && (o.shape === 'line' || o.shape === 'arrow')) { n.x += dx; n.y += dy; if (e.scale) { n.w *= Number(e.scale); n.h *= Number(e.scale); } }
        else if (o.type === 'svg') { n.x += dx; n.y += dy; if (e.scale) { n.scale = n.scale * Number(e.scale); } }
        else { n.x += dx; n.y += dy; if (e.scale) { var k = Number(e.scale), cx = n.x + n.w / 2, cy = n.y + n.h / 2; n.w *= k; n.h *= k; if (n.size) { n.size *= k; } n.x = cx - n.w / 2; n.y = cy - n.h / 2; } }
        if (e.rotate != null && 'rotate' in n) { n.rotate = (Number(n.rotate) || 0) + Number(e.rotate); }
        var p = [], v = H.validateObject(n, p, {}); if (!v) { return { error: p[0] || 'the new values are not valid' }; } v.id = o.id; s.objects[i] = v; return {};
      }
    },
    patch_markup: {
      words: function (e) { return '修改圖形 ' + e.id; },
      apply: function (s, e, H) {
        var i = H.find(s, e.id); if (i < 0) { return { error: 'there is no object "' + str(e.id, 30) + '"' }; } var o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; } if (o.type !== 'svg') { return { error: 'patch_markup works on svg objects only' }; }
        var find = String(e.find == null ? '' : e.find); if (!find) { return { error: 'find must not be empty' }; } var n = 0, at = 0; while ((at = o.markup.indexOf(find, at)) >= 0) { n++; at += find.length; }
        if (!n) { return { error: 'the text to replace was not found (it has to be exactly as in the markup)' }; } if (n > 1 && !e.all) { return { error: 'the text to replace appears ' + n + ' times: take more context so it is unique, or add all:true' }; }
        var next = H.clone(o); next.markup = e.all ? o.markup.split(find).join(String(e.replace == null ? '' : e.replace)) : o.markup.replace(find, function () { return String(e.replace == null ? '' : e.replace); });
        var p = [], v = H.validateObject(next, p, {}); if (!v) { return { error: p[0] || 'the new markup is not valid' }; } v.id = o.id; s.objects[i] = v; return {};
      }
    }
  };

  var E = O.make({
    types: types, extraOps: extraOps, limits: { objects: 500, canvas: 16384 },
    defaultSpec: function () { return { v: 1, title: '我的圖', canvas: { x: 0, y: 0, w: 800, h: 600, bg: '#ffffff' }, seq: 0, objects: [] }; },
    describeObject: function (o) { var b = types[o.type].bbox(o); return '@(' + Math.round(b.x) + ',' + Math.round(b.y) + ' ' + Math.round(b.w) + '×' + Math.round(b.h) + ')' + (o.type === 'shape' ? ' ' + o.shape + ' ' + o.fill : ''); }
  });

  // ───────────────────────── composing: object -> markup, document -> one SVG ─────────────────────────
  function starPoints(cx, cy, rx, ry, n) { var pts = []; for (var i = 0; i < n * 2; i++) { var a = -Math.PI / 2 + i * Math.PI / n, k = i % 2 ? 0.42 : 1; pts.push(r2(cx + Math.cos(a) * rx * k) + ',' + r2(cy + Math.sin(a) * ry * k)); } return pts.join(' '); }
  function polyPoints(cx, cy, rx, ry, n) { var pts = []; for (var i = 0; i < n; i++) { var a = -Math.PI / 2 + i * 2 * Math.PI / n; pts.push(r2(cx + Math.cos(a) * rx) + ',' + r2(cy + Math.sin(a) * ry)); } return pts.join(' '); }
  function shapeMarkup(o) {
    var st = ' fill="' + esc(o.fill) + '" stroke="' + esc(o.stroke) + '" stroke-width="' + o.sw + '"', cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    switch (o.shape) {
      case 'rect': return '<rect x="' + o.x + '" y="' + o.y + '" width="' + o.w + '" height="' + o.h + '" rx="' + o.rx + '"' + st + '/>';
      case 'ellipse': return '<ellipse cx="' + r2(cx) + '" cy="' + r2(cy) + '" rx="' + r2(o.w / 2) + '" ry="' + r2(o.h / 2) + '"' + st + '/>';
      case 'triangle': return '<polygon points="' + r2(cx) + ',' + o.y + ' ' + r2(o.x + o.w) + ',' + r2(o.y + o.h) + ' ' + o.x + ',' + r2(o.y + o.h) + '"' + st + '/>';
      case 'polygon': return '<polygon points="' + polyPoints(cx, cy, o.w / 2, o.h / 2, o.sides) + '"' + st + '/>';
      case 'star': return '<polygon points="' + starPoints(cx, cy, o.w / 2, o.h / 2, Math.max(3, o.sides)) + '"' + st + '/>';
      case 'line': return '<line x1="' + o.x + '" y1="' + o.y + '" x2="' + r2(o.x + o.w) + '" y2="' + r2(o.y + o.h) + '" stroke="' + esc(o.stroke) + '" stroke-width="' + o.sw + '" stroke-linecap="round"/>';
      case 'arrow': { var x2 = o.x + o.w, y2 = o.y + o.h, a = Math.atan2(o.h, o.w), L = Math.max(8, o.sw * 4), p1 = [x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45)], p2 = [x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45)]; return '<line x1="' + o.x + '" y1="' + o.y + '" x2="' + r2(x2) + '" y2="' + r2(y2) + '" stroke="' + esc(o.stroke) + '" stroke-width="' + o.sw + '" stroke-linecap="round"/><polygon points="' + r2(x2) + ',' + r2(y2) + ' ' + r2(p1[0]) + ',' + r2(p1[1]) + ' ' + r2(p2[0]) + ',' + r2(p2[1]) + '" fill="' + esc(o.stroke) + '"/>'; }
      case 'path': return '<path transform="translate(' + o.x + ' ' + o.y + ')" d="' + esc(o.d) + '"' + st + '/>';
      case 'text': return '<text x="' + o.x + '" y="' + o.y + '" font-size="' + o.size + '" font-family="sans-serif"' + (o.fill === 'none' ? '' : ' fill="' + esc(o.fill) + '"') + (o.stroke !== 'none' ? ' stroke="' + esc(o.stroke) + '" stroke-width="' + o.sw + '"' : '') + '>' + esc(o.text) + '</text>';
      default: return '';
    }
  }
  function objectMarkup(o, resolve) {
    var inner, tr = '', b = types[o.type].bbox(o), cx = r2(b.x + b.w / 2), cy = r2(b.y + b.h / 2);
    if (o.type === 'shape') { inner = shapeMarkup(o); if (o.rotate) { tr = ' transform="rotate(' + o.rotate + ' ' + cx + ' ' + cy + ')"'; } }
    else if (o.type === 'svg') { inner = o.markup; tr = ' transform="translate(' + o.x + ' ' + o.y + ')' + (o.rotate ? ' rotate(' + o.rotate + ' ' + r2(o.w * o.scale / 2) + ' ' + r2(o.h * o.scale / 2) + ')' : '') + (o.scale !== 1 ? ' scale(' + o.scale + ')' : '') + '"'; }
    else if (o.type === 'image') { var href = resolve ? resolve(o.ref) : ''; inner = href ? '<image x="' + o.x + '" y="' + o.y + '" width="' + o.w + '" height="' + o.h + '" preserveAspectRatio="none" href="' + esc(href) + '"/>' : '<rect x="' + o.x + '" y="' + o.y + '" width="' + o.w + '" height="' + o.h + '" fill="#cccccc" stroke="#999"/>'; }
    else { inner = ''; }
    return '<g id="' + esc(o.id) + '" data-name="' + esc(o.name) + '"' + (o.opacity != null && o.opacity !== 1 ? ' opacity="' + o.opacity + '"' : '') + tr + '>' + inner + '</g>';
  }
  // the exported / shown SVG. opts: { resolve(ref)->data URL, region:{x,y,w,h} (what to show; default the canvas frame), frame:true (draw the frame's background) }
  function compose(spec, opts) {
    opts = opts || {}; var s = E.validate(spec).spec, c = s.canvas, reg = opts.region || { x: c.x, y: c.y, w: c.w, h: c.h }, out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + r2(reg.x) + ' ' + r2(reg.y) + ' ' + r2(reg.w) + ' ' + r2(reg.h) + '" width="' + Math.round(opts.width || reg.w) + '" height="' + Math.round(opts.height || reg.h) + '">');
    if (opts.frame !== false) { out.push('<rect x="' + c.x + '" y="' + c.y + '" width="' + c.w + '" height="' + c.h + '" fill="' + esc(c.bg) + '"/>'); }
    s.objects.forEach(function (o) { if (o.visible) { out.push(objectMarkup(o, opts.resolve)); } });
    out.push('</svg>'); return out.join('\n');
  }
  // an SVG given as text (typed in the source tab, pasted, a file): every top-level element becomes an object; the viewBox / size becomes the frame
  function decompose(svgText, base) {
    var s = String(svgText || ''), m = /<svg\b([^>]*)>([\s\S]*)<\/svg>/i.exec(s); if (!m) { return { ok: false, error: 'this is not an SVG (no <svg> element)' }; }
    var attrs = m[1], body = m[2], vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(attrs), box = vb ? vb[1].trim().split(/[\s,]+/).map(Number) : null, w = /\swidth\s*=\s*["']([\d.]+)/i.exec(attrs), h = /\sheight\s*=\s*["']([\d.]+)/i.exec(attrs);
    var canvas = box && box.length === 4 && box[2] > 0 && box[3] > 0 ? { x: box[0], y: box[1], w: box[2], h: box[3] } : { x: 0, y: 0, w: w ? Number(w[1]) : 800, h: h ? Number(h[1]) : 600 };
    var parts = [], depth = 0, cur = '', i = 0, re = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>|<!--[\s\S]*?-->|[^<]+/g, t;
    var defs = '';
    while ((t = re.exec(body))) {
      var tok = t[0]; if (/^<!--/.test(tok)) { continue; }
      if (!t[2]) { if (depth > 0) { cur += tok; } continue; }
      var closing = !!t[1], selfc = !!t[4] || /^(path|rect|circle|ellipse|line|polyline|polygon|image|use|stop)$/i.test(t[2]) && !closing && /\/$/.test(tok.replace(/>$/, ''));
      if (!closing) { if (selfc) { if (depth === 0) { parts.push(tok); } else { cur += tok; } } else { depth++; cur += tok; } }
      else { depth--; cur += tok; if (depth === 0) { parts.push(cur); cur = ''; } }
    }
    var drawable = [];
    parts.forEach(function (p) { var tag = /^<\s*([a-zA-Z][\w:-]*)/.exec(p); if (!tag) { return; } if (/^(defs|style|title|desc|metadata)$/i.test(tag[1])) { if (/^defs$/i.test(tag[1])) { defs += p; } return; } drawable.push(p); });
    var objects = drawable.slice(0, 400).map(function (p, k) {
      var id = /\sid\s*=\s*["']([^"']+)["']/i.exec(p), nm = /\sdata-name\s*=\s*["']([^"']+)["']/i.exec(p) || id, tag = /^<\s*([a-zA-Z][\w:-]*)/.exec(p)[1];
      return { type: 'svg', name: nm ? nm[1] : tag + ' ' + (k + 1), markup: defs ? defs + p : p, x: 0, y: 0, w: canvas.w, h: canvas.h };
    });
    return { ok: true, canvas: Object.assign({ bg: (base && base.bg) || '#ffffff' }, canvas), objects: objects, dropped: Math.max(0, drawable.length - 400) };
  }

  // ───────────────────────── what the program reads itself ─────────────────────────
  function parseCommands(text, spec) {
    var s = E.validate(spec).spec, rest = [], edits = [], matched = [], clauses = String(text || '').split(/[，。；;\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);   // in the order the user said them
    function ref(r) { r = String(r || '').trim().replace(/^[「"'『]|[」"'』]$/g, '').replace(/^(?:物件|圖層)\s*/, ''); var i = E.find(s, r); if (i >= 0) { return s.objects[i].id; } var m = /^(?:第\s*)?(\d+)(?:\s*個|\s*號)?$/.exec(r); if (m) { var k = s.objects.length - Number(m[1]); return k >= 0 && k < s.objects.length ? s.objects[k].id : null; } return null; }
    clauses.forEach(function (c) {
      var oc = E.parseObjectCommand(c, spec); if (oc.edits.length) { edits = edits.concat(oc.edits); matched.push(c); return; }
      var m, id, e = null, colorWord = '(紅色?|橘色?|橙色|黃色?|綠色?|藍色?|天藍色?|紫色?|粉紅色?|粉色|黑色?|白色?|灰色?|棕色?|咖啡色|金色|銀色|#[0-9a-fA-F]{3,8})';
      if ((m = new RegExp('^(?:把)?\\s*(.+?)\\s*(?:的)?\\s*(填色|顏色|邊框|外框|線條)\\s*(?:改成|換成|改為|設為|變成)\\s*' + colorWord + '$').exec(c)) && (id = ref(m[1]))) { var which = m[2], col = colorOf(m[3], null); if (col) { e = { op: 'update_object', id: id, props: /邊框|外框|線條/.test(which) ? { stroke: col } : { fill: col } }; } }
      else if ((m = /^(?:把)?\s*(.+?)\s*(?:移到|搬到|放到)\s*\(?\s*(?:x\s*=\s*)?(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(?:y\s*=\s*)?(-?\d+(?:\.\d+)?)\s*\)?$/i.exec(c)) && (id = ref(m[1]))) { var i = E.find(s, id), o = s.objects[i]; e = { op: 'transform_object', id: id, dx: Number(m[2]) - o.x, dy: Number(m[3]) - o.y }; }
      else if ((m = /^(?:把)?\s*(.+?)\s*往(右|左|上|下)(?:移動?|移)?\s*(\d+(?:\.\d+)?)$/.exec(c)) && (id = ref(m[1]))) { var n = Number(m[3]); e = { op: 'transform_object', id: id, dx: m[2] === '右' ? n : m[2] === '左' ? -n : 0, dy: m[2] === '下' ? n : m[2] === '上' ? -n : 0 }; }
      else if ((m = /^(?:把)?\s*(.+?)\s*(放大|縮小)\s*(\d+(?:\.\d+)?)\s*倍$/.exec(c)) && (id = ref(m[1]))) { var k2 = Number(m[3]) || 1; e = { op: 'transform_object', id: id, scale: m[2] === '放大' ? k2 : 1 / k2 }; }
      else if ((m = /^(?:把)?\s*(.+?)\s*(?:旋轉|轉)\s*(-?\d+(?:\.\d+)?)\s*度$/.exec(c)) && (id = ref(m[1]))) { e = { op: 'transform_object', id: id, rotate: Number(m[2]) }; }
      else if ((m = /^畫布\s*(?:改成|設為|設成)?\s*(\d+)\s*[x×*]\s*(\d+)$/i.exec(c))) { e = { op: 'set_canvas', w: Number(m[1]), h: Number(m[2]) }; }
      else if (/^(?:畫布)?(?:貼合|符合|包住)內容$/.test(c)) { e = { op: 'fit_canvas' }; }
      if (e) { edits.push(e); matched.push(c); } else { rest.push(c); }
    });
    return { edits: edits, matched: matched, unmatched: rest };
  }

  // ───────────────────────── for the AI ─────────────────────────
  var ACTIONS = '{op:"add_object",object:{type:"shape",name:"太陽",shape:"ellipse",w:120,h:120,fill:"#fdd835",stroke:"none"},place:{of:"房子",rel:"above",gap:20}}（place＝放在哪裡：of 是某個物件的 id 或名字（或 selection 目前選取的、canvas 畫布、view 使用者正在看的範圍、content 全部內容），rel 是 right／left／above／below／inside／center，gap 是間距，align 是 start／center／end，inside 時用 at：top-left、top、top-right、left、right、bottom-left、bottom、bottom-right，還可以加 dx、dy 微調；程式會算座標。**優先用 place，不要自己猜座標**；沒有 place 才用 x、y）、'
    + '{op:"place_object",id:"o3",place:{of:"o5",rel:"right",gap:12}}（把既有的物件放到另一個物件的旁邊）、'
    + 'shape 可以是 rect、ellipse、line、arrow、triangle、polygon、star、path、text；text 用 text 與 size；line／arrow 的 w、h 是終點相對起點的位移；path 用 d；polygon／star 用 sides）、'
    + '{op:"add_object",object:{type:"svg",name:"小房子",markup:"<g>…SVG 元素…</g>",x:0,y:0,w:120,h:100}}（自由畫法：markup 只放 SVG 元素，不要 <svg> 外框，座標是這個物件自己的，x、y 把它放到畫面上；w、h 是它大約的大小）、'
    + '{op:"update_object",id:"o3",props:{fill:"#e53935",x:300}}、{op:"transform_object",id:"o3",dx:50,dy:0,scale:1.5,rotate:15}、{op:"patch_markup",id:"o4",find:"原文",replace:"新文"}、{op:"remove_object",id:"o3"}、{op:"rename_object",id:"o3",name:"…"}、'
    + '{op:"move_object",id:"o3",to:"front"|"back"|"up"|"down"}、{op:"set_visible",id:"o3",visible:false}、{op:"set_locked",id:"o3",locked:true}、{op:"duplicate_object",id:"o3"}、{op:"set_canvas",x:0,y:0,w:800,h:600,bg:"#ffffff"}、{op:"fit_canvas"}、{op:"set_title",text:"…"}';
  function editPrompt(spec, text, extra, selection) {
    var s = E.validate(spec).spec, b = E.bounds(s);
    var system = '你是向量圖編輯助手。使用者說想怎麼畫或怎麼改，你把它翻成「編輯動作」。只回一段 JSON，不要說明、不要 markdown 區塊：{"say":"一句話告訴使用者你做了什麼（做不到就說做不到）","edits":[…]}。\n'
      + '**你新增的每一樣東西都是一個新的物件**（add_object，要取一個看得懂的 name），不要用 set 整張圖覆蓋；改既有的東西用物件的 id（或 name）。畫面是一個沒有邊界的平面，座標可以是任何數字（含負數與很遠的地方）；「畫布」只是匯出用的範圍框。y 往下增加。\n'
      + '動作只能是下面這些（不要發明新的動作）：\n' + ACTIONS + '\n顏色用 #RRGGBB 或常見英文色名。不要 script、不要外部連結、不要事件屬性。一次最多 25 個動作；複雜的畫（例如一棟房子、一隻動物）用一個 svg 物件把它畫完整，或拆成幾個有名字的形狀物件。\n使用者是用說話在畫：「在太陽右邊加一朵雲」＝一個新物件加 place:{of:"太陽",rel:"right"}；「把煙囪放到房子上面」＝place_object；沒說位置就放在使用者正在看的地方（place:{of:"view",rel:"center"}）。';
    var user = '目前的圖「' + s.title + '」，畫布範圍框 x=' + s.canvas.x + ' y=' + s.canvas.y + ' ' + s.canvas.w + '×' + s.canvas.h + '，背景 ' + s.canvas.bg + (b ? '；所有內容的範圍 x=' + Math.round(b.x) + ' y=' + Math.round(b.y) + ' ' + Math.round(b.w) + '×' + Math.round(b.h) : '；目前沒有內容') + '。\n物件（最上層是 1）：\n' + E.list(s) + (selection ? '\n\n使用者目前選取的是 ' + selection + '（說「它」「這個」就是指它）。' : '') + (extra ? '\n\n' + extra : '') + '\n\n使用者說：' + String(text || '');
    return { system: system, user: user };
  }
  function refPrompt() { return 'Describe this picture for someone who has to redraw it as a vector drawing: the main subject, every distinct object and where it is (left / right / top / bottom / centre), its colour (give #RRGGBB when you can), the background, and the style (flat, photo, sketch ...). Only what you can see; short sentences.'; }
  // the picture was turned into vector objects: compare the description of the original with the description of the result (the words that name things)
  function specToPrompt(spec, steps) {
    var s = E.validate(spec).spec, L = ['請畫一張向量圖（SVG）「' + s.title + '」，畫布 ' + s.canvas.w + '×' + s.canvas.h + '，背景 ' + s.canvas.bg + '。', '', '物件（由下到上）：'];
    s.objects.forEach(function (o, i) { L.push((i + 1) + '. ' + o.name + '（' + (o.type === 'shape' ? o.shape : o.type) + '，' + E.list({ canvas: s.canvas, objects: [o] }).replace(/^\d+\.\s*\[[^\]]*\]\s*/, '').replace(/^.*?\)\s*/, '') + (o.type === 'image' && o.credit ? '，出處：' + o.credit : '') + '）'); });
    var texts = (steps || []).filter(function (x) { return x.text; });
    if (texts.length) { L.push('', '（有效的指示，依序）：'); texts.forEach(function (x, i) { L.push((i + 1) + '. ' + x.text + (x.summary ? ' → ' + x.summary : '')); }); }
    return L.join('\n');
  }

  var STARTERS = [
    { id: 'blank', label: '空白畫布', desc: '一張空的畫布，從零開始用對話畫。', spec: function () { return { title: '我的圖', objects: [] }; } },
    { id: 'shapes', label: '形狀範例', desc: '幾種基本形狀，每一個都是一個物件。', spec: function () { return { title: '形狀範例', objects: [
      { type: 'shape', name: '藍色方塊', shape: 'rect', x: 60, y: 60, w: 160, h: 110, rx: 12, fill: '#4f8ef7' }, { type: 'shape', name: '黃色圓', shape: 'ellipse', x: 280, y: 60, w: 120, h: 120, fill: '#fdd835' },
      { type: 'shape', name: '紅色三角', shape: 'triangle', x: 460, y: 60, w: 130, h: 110, fill: '#e53935' }, { type: 'shape', name: '綠色星星', shape: 'star', x: 90, y: 240, w: 130, h: 130, fill: '#43a047', sides: 5 },
      { type: 'shape', name: '紫色六邊形', shape: 'polygon', x: 290, y: 240, w: 120, h: 120, fill: '#8e24aa', sides: 6 }, { type: 'shape', name: '箭頭', shape: 'arrow', x: 460, y: 300, w: 150, h: 0, stroke: '#333333', sw: 5 },
      { type: 'shape', name: '標題', shape: 'text', x: 60, y: 450, text: '形狀範例', size: 40, fill: '#222222' }] }; } },
    { id: 'flow', label: '流程圖', desc: '三個步驟與箭頭，可以接著請 AI 加分支。', spec: function () { return { title: '流程圖', canvas: { w: 760, h: 260 }, objects: [
      { type: 'shape', name: '開始', shape: 'rect', x: 40, y: 90, w: 170, h: 80, rx: 40, fill: '#43a047' }, { type: 'shape', name: '開始文字', shape: 'text', x: 92, y: 138, text: '開始', size: 26, fill: '#ffffff' },
      { type: 'shape', name: '箭頭一', shape: 'arrow', x: 214, y: 130, w: 70, h: 0, stroke: '#555555', sw: 4 }, { type: 'shape', name: '處理', shape: 'rect', x: 290, y: 90, w: 170, h: 80, rx: 8, fill: '#4f8ef7' },
      { type: 'shape', name: '處理文字', shape: 'text', x: 346, y: 138, text: '處理', size: 26, fill: '#ffffff' }, { type: 'shape', name: '箭頭二', shape: 'arrow', x: 464, y: 130, w: 70, h: 0, stroke: '#555555', sw: 4 },
      { type: 'shape', name: '結束', shape: 'rect', x: 540, y: 90, w: 170, h: 80, rx: 40, fill: '#e53935' }, { type: 'shape', name: '結束文字', shape: 'text', x: 592, y: 138, text: '結束', size: 26, fill: '#ffffff' }] }; } }
  ];
  function starter(id) { var t = STARTERS.filter(function (x) { return x.id === id; })[0]; return t ? E.validate(t.spec()).spec : null; }
  function listStarters() { return STARTERS.map(function (t) { return { id: t.id, label: t.label, desc: t.desc }; }); }

  return { E: E, types: types, extraOps: extraOps, OPS: E.OPS, validate: E.validate, applyEdits: E.applyEdits, editWords: E.editWords, list: E.list, find: E.find, bounds: E.bounds, compose: compose, decompose: decompose, objectMarkup: objectMarkup, shapeMarkup: shapeMarkup,
    checkMarkup: checkMarkup, unwrap: unwrap, parseCommands: parseCommands, editPrompt: editPrompt, parseEditsReply: function (t) { return O.parseEditsReply(t, E.OPS); }, refPrompt: refPrompt, specToPrompt: specToPrompt, colorOf: colorOf, starter: starter, listStarters: listStarters, STARTERS: listStarters(), SHAPES: SHAPES };
});
