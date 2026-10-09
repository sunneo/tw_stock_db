// "/media-presentation" in the browser: loads a *.deck.yaml (see ai_chat_deck_core.js for the format), PREPARES it
// (pictures, 2D scenes, tables, and the TTS narration of every slide) a few slides ahead of the playhead, and plays it in
// a window that can be docked in the chat, floated, or maximised, with previous/next on the left/right edges, chapters,
// subtitles, transitions and an Export menu (MP4 / PPTX / source yaml / subtitles / bundle -- see ai_chat_deck_export.js).
//
// Everything the viewer draws goes through AiChatDeckCore.renderFrame, the same function the MP4 exporter calls.
(function (window) {
  'use strict';

  var Core = window.AiChatDeckCore;
  var DECK_URL_RE = /\.deck\.yaml(\?.*)?$/i;
  var PREHEAT = 3;      // slides that must be ready before the play button appears
  var LOOKAHEAD = 3;    // slides prepared ahead of the one being shown
  var ttsProvider = null, ttsConcurrent = false;
  var audioCtx = null;

  // ------------------------------------------------------------------ small utilities
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  function isDeckUrl(url) { return typeof url === 'string' && DECK_URL_RE.test(url); }
  function isClientFileUrl(url) { return typeof url === 'string' && window.AiChatFileSink && url.indexOf(window.AiChatFileSink.CLIENT_FILE_PREFIX) === 0; }
  function stripSuffix(url) { return url.replace(DECK_URL_RE, ''); }
  function getAudioCtx() {
    if (!audioCtx) { var C = window.AudioContext || window.webkitAudioContext; audioCtx = C ? new C() : null; }
    return audioCtx;
  }
  function fmt(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }

  // Attachment urls are saved with the server's own configured host (e.g. https://tracker.example.com/attachments/download/12/x.jpg), which a
  // browser reaching Redmine through a proxy (https://gateway.example.net/proxy/redmine/...) cannot resolve. Any attachment url (absolute, on any
  // host, or just a "/attachments/..." path) is therefore re-addressed to the origin and the Redmine root of the PAGE the viewer is on
  // (the part of the page path before "/projects/"), so it works whichever way Redmine was reached.
  // Where this Redmine is mounted ("" when it is at the root of the site, "/proxy/redmine" behind a proxy). Several clues, because none is
  // reliable on its own: (1) a root already PROVEN to work (an attachment url that loaded -- learnRoot), (2) the url this very script was
  // loaded from ("<root>/plugin_assets/..."), (3) the page path before "/projects/", (4) the server's relative url root.
  var knownRoot = null;
  var scriptRoot = (function () {
    try {
      var el = document.currentScript, m = el && /^(?:https?:\/\/[^\/]+)?(.*?)\/plugin_assets\//.exec(el.getAttribute('src') || el.src || '');
      return m ? m[1] : null;
    } catch (e) { return null; }
  })();
  function appRoots() {
    var roots = [], i = location.pathname.indexOf('/projects/');
    var base = (window.AiChatAttachmentDownloadUrlBase || '').replace(/\/attachments\/download\/?$/, '').replace(/\/$/, '');
    [knownRoot, scriptRoot, i >= 0 ? location.pathname.slice(0, i) : null, base].forEach(function (r) { if (r != null && roots.indexOf(r) < 0) { roots.push(r); } });
    return roots;
  }
  function appRoot() { return appRoots()[0]; }
  // an attachment url on this origin that worked: remember the mount point it shows
  function learnRoot(url) {
    var m = /^(https?:\/\/[^\/]+)(.*?)\/attachments\//.exec(url || '');
    if (m && m[1].replace(/^https?:\/\//, '') === location.host) { knownRoot = m[2]; }
  }
  var ATT_RE = /^(?:https?:\/\/[^\/]+)?(?:\/[^?#]*?)?(\/attachments\/(?:download|thumbnail)\/\d+(?:\/[^?#]*)?(?:\?[^#]*)?)$/;
  function localizeUrl(url) {
    if (typeof url !== 'string') { return url; }
    var m = ATT_RE.exec(url);
    if (!m) { return url; }
    return location.origin + appRoot() + m[1];
  }

  // The addresses to try for one url, best first: the url as given, and the attachment re-addressed under every mount point we can think of
  // (see appRoots), because which one works depends on how Redmine is reached and on what a proxy does with urls inside saved files.
  function urlCandidates(url) {
    var m = typeof url === 'string' ? ATT_RE.exec(url) : null, list = [];
    if (!m) { return [url]; }
    var given = url, givenSameHost = false;
    try { givenSameHost = /^https?:/.test(url) && new URL(url).host === location.host; } catch (e) { /* relative */ }
    var locals = appRoots().map(function (r) { return location.origin + r + m[1]; });
    list = givenSameHost ? [given].concat(locals) : locals.concat([given]);
    // A proxy may treat ".../x.jpg" as a static file of its own (404) while Redmine itself serves the attachment by id alone: the same
    // url without the file name is the last resort.
    var bare = /^(.*\/attachments\/download\/\d+)\/[^?#\/]+(\?.*)?$/.exec(locals[0]);
    if (bare) { list.push(bare[1] + (bare[2] || '')); }
    return list.filter(function (u, i) { return u && list.indexOf(u) === i; });
  }

  function fetchText(url) {
    if (isClientFileUrl(url)) {
      return window.AiChatFileSink.resolve(stripSuffix(url)).then(function (r) { return r.blob.text(); });
    }
    var tried = [];
    function attempt(list) {
      if (!list.length) { return Promise.reject(new Error(tried.join('; '))); }
      return fetch(list[0], { credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) { tried.push('HTTP ' + res.status + ' ' + list[0]); return attempt(list.slice(1)); }
        learnRoot(list[0]);
        return res.text();
      }, function (e) { tried.push((e && e.message || 'network error') + ' ' + list[0]); return attempt(list.slice(1)); });
    }
    return attempt(urlCandidates(url));
  }

  function fetchBlob(url) {
    if (isClientFileUrl(url)) { return window.AiChatFileSink.resolve(stripSuffix(url)).then(function (r) { return r.blob; }); }
    var tried = [];
    function attempt(list) {
      if (!list.length) { return Promise.reject(new Error(tried.join('; '))); }
      return fetch(list[0], { credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) { tried.push('HTTP ' + res.status + ' ' + list[0]); return attempt(list.slice(1)); }
        learnRoot(list[0]);
        return res.blob();
      }, function (e) { tried.push((e && e.message || 'network error') + ' ' + list[0]); return attempt(list.slice(1)); });
    }
    return attempt(urlCandidates(url));
  }

  // Any image reference a deck can hold: a Redmine/wiki attachment url, a "client-file/ID" (a screenshot or file that never
  // left this browser), a data: uri, or a plain http(s) url. A different-origin url is requested with CORS so the canvas is
  // not tainted (an untainted canvas is what MP4/PPTX export needs); a server that does not allow it fails visibly.
  function loadImage(src) {
    if (isClientFileUrl(src)) {
      return window.AiChatFileSink.resolve(stripSuffix(src)).then(function (r) { return loadOne(URL.createObjectURL(r.blob), src); });
    }
    var list = urlCandidates(src), tried = [];
    function attempt(i) {
      if (i >= list.length) { return Promise.reject(new Error('image failed to load: ' + String(src).slice(0, 80) + (tried.length > 1 ? ' (tried ' + tried.join(', ') + ')' : ''))); }
      tried.push(list[i]);
      return loadOne(list[i], src).catch(function () { return attempt(i + 1); });
    }
    return attempt(0);
  }

  function loadOne(url, label) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      try { if (/^https?:/i.test(url) && new URL(url, location.href).origin !== location.origin) { img.crossOrigin = 'anonymous'; } } catch (e) { /* relative url: same origin */ }
      img.onload = function () { learnRoot(url); resolve(img); };
      img.onerror = function () { reject(new Error('image failed to load: ' + String(label).slice(0, 80))); };
      img.src = url;
    });
  }

  // SVG markup -> Image. An SVG shown through <img> can neither run script nor fetch anything, so no sanitising is needed
  // for display; the size is forced from the viewBox because width="100%" (mermaid) gives an <img> no natural size.
  //
  // Chrome refuses to read back (toDataURL / VideoFrame -- i.e. every export) a canvas an SVG with <foreignObject> was drawn
  // on ("tainted canvas"), and mermaid labels are foreignObject HTML. So: the picture is tested once, and if it would taint
  // the canvas the foreignObject labels are rewritten as plain SVG <text> (single line, centred) and loaded again.
  function svgToImage(svgText, noRetry) {
    var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    var root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) { return Promise.reject(new Error('the svg could not be parsed')); }
    if (!root.getAttribute('xmlns')) { root.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); }
    var vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { root.setAttribute('width', String(vb[2])); root.setAttribute('height', String(vb[3])); }
    else if (!parseFloat(root.getAttribute('width')) || !parseFloat(root.getAttribute('height'))) { root.setAttribute('width', '800'); root.setAttribute('height', '600'); }
    var markup = new XMLSerializer().serializeToString(root);
    return loadImage(URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))).then(function (img) {
      if (noRetry || !/<foreignObject/i.test(markup) || canvasStaysClean(img)) { return img; }
      return svgToImage(foreignObjectsToText(root), true);
    });
  }

  function canvasStaysClean(img) {
    try { var c = document.createElement('canvas'); c.width = c.height = 2; var x = c.getContext('2d'); x.drawImage(img, 0, 0, 2, 2); x.getImageData(0, 0, 1, 1); return true; } catch (e) { return false; }
  }

  function foreignObjectsToText(root) {
    var NS = 'http://www.w3.org/2000/svg';
    Array.prototype.slice.call(root.getElementsByTagName('foreignObject')).forEach(function (fo) {
      var text = (fo.textContent || '').replace(/\s+/g, ' ').trim();
      var w = parseFloat(fo.getAttribute('width')) || 0, h = parseFloat(fo.getAttribute('height')) || 0;
      var x = (parseFloat(fo.getAttribute('x')) || 0) + w / 2, y = (parseFloat(fo.getAttribute('y')) || 0) + h / 2;
      var t = document.createElementNS(NS, 'text');
      t.setAttribute('x', String(x)); t.setAttribute('y', String(y)); t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'middle');
      t.setAttribute('font-size', '16'); t.setAttribute('fill', '#333'); t.setAttribute('font-family', 'sans-serif');
      t.textContent = text;
      fo.parentNode.replaceChild(t, fo);
    });
    return new XMLSerializer().serializeToString(root);
  }

  function containDraw(img) {
    return function (ctx, rect) {
      var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      var s = Math.min(rect.w / iw, rect.h / ih), dw = iw * s, dh = ih * s;
      ctx.drawImage(img, rect.x + (rect.w - dw) / 2, rect.y + (rect.h - dh) / 2, dw, dh);
    };
  }

  // ---------------------------------------------------------- 2D scenes (shapes / anim2d) through the existing 2D engine
  function hasOpacityAnim(a) { return a && (a.type === 'fade' || (a.type === 'keyframes' && (a.keyframes || []).some(function (k) { return k && k.opacity != null; }))); }
  function hasScaleAnim(a) { return a && (a.type === 'scale' || (a.type === 'keyframes' && (a.keyframes || []).some(function (k) { return k && k.scale != null; }))); }
  function hasPositionAnim(a) { return a && (a.type === 'move' || a.type === 'orbit' || (a.type === 'keyframes' && (a.keyframes || []).some(function (k) { return k && k.position; }))); }

  // Applies the cue state of shapes with an id ("show: shape:<id>") to a per-frame copy of the scene.
  function applyShapeFx(data, fx) {
    var ids = Object.keys(fx || {});
    if (!ids.length) { return data; }
    var shapes = [];
    data.shapes.forEach(function (shape) {
      var st = shape && shape.id && fx[shape.id];
      if (!st) { shapes.push(shape); return; }
      var a = shape.animation, c = Object.assign({}, shape), p = Math.max(0, Math.min(1, st.p));
      if (p <= 0) { if (hasOpacityAnim(a)) { return; } c.opacity = 0; shapes.push(c); return; }
      if (p < 1) {
        if (!hasOpacityAnim(a)) { c.opacity = (shape.opacity != null ? shape.opacity : 1) * (1 - Math.pow(1 - p, 3)); }
        if (st.effect === 'pop' && !hasScaleAnim(a)) { c.scale = (shape.scale != null ? shape.scale : 1) * (0.8 + 0.2 * p); }
        if (st.effect === 'rise' && !hasPositionAnim(a) && shape.position) { c.position = [shape.position[0], shape.position[1] + (1 - p) * 40]; }
      }
      if (st.pulse > 0 && !hasScaleAnim(a)) { c.scale = (c.scale != null ? c.scale : (shape.scale != null ? shape.scale : 1)) * (1 + 0.15 * st.pulse); }
      shapes.push(c);
    });
    return Object.assign({}, data, { shapes: shapes });
  }

  function sceneVisual(scene) {
    var two = window.AiChat2D && window.AiChat2D._internal;
    if (!two) { return Promise.reject(new Error('the 2D animation engine is not loaded')); }
    return window.AiChat2D.ensureJsYamlLoaded().then(function () {
      var data = two.parseAnimation(JSON.stringify(Object.assign({ kind: 'ai_chat_animation_2d' }, scene)));
      if (!data.background) { data.background = 'rgba(0,0,0,0)'; }
      var images = two.preloadImages(data);
      var sw = data.width || 480, sh = data.height || 320, off = null;
      return {
        duration: data.duration || 4,
        draw: function (ctx, rect, tv, fx) {
          var s = Math.min(rect.w / sw, rect.h / sh), dw = sw * s, dh = sh * s;
          var dev = ctx.getTransform ? ctx.getTransform().a : 1;
          var ow = Math.max(2, Math.round(dw * dev)), oh = Math.max(2, Math.round(dh * dev));
          if (!off || off.width !== ow || off.height !== oh) { off = document.createElement('canvas'); off.width = ow; off.height = oh; }
          var octx = off.getContext('2d');
          octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, ow, oh);
          octx.setTransform(ow / sw, 0, 0, oh / sh, 0, 0);
          two.drawFrame(octx, applyShapeFx(data, fx), images, tv, sw, sh);
          ctx.drawImage(off, rect.x + (rect.w - dw) / 2, rect.y + (rect.h - dh) / 2, dw, dh);
        }
      };
    });
  }

  // ---------------------------------------------------------- live 3D scene (the existing 3D engine, driven by the slide clock)
  // The 3D engine's animators advance by dt, so "state at time t" is made by stepping from the start in fixed 1/60 s slices
  // (and rebuilding when the clock goes backwards: a loop, a seek). Two ways to show it, sharing that one state:
  //   draw(ctx, rect, tv)  -- flat decks: a small renderer of its own (created on first use, so a deck with many 3D slides never
  //                           holds many WebGL contexts), the camera slowly circling unless orbit is false;
  //   model                -- the 3D stage (ai_chat_deck_stage3d.js) renders the same scene itself, on its own stage, with the
  //                           viewer's camera.
  function scene3dVisual(sceneObj, visual) {
    var three = window.AiChat3D;
    if (!three || !three.ensureLibsLoaded) { return Promise.reject(new Error('the 3D viewer is not loaded')); }
    return three.ensureLibsLoaded().then(function () {
      var I = three._internal, data = I.parseScene(JSON.stringify(sceneObj));
      var gl = null, renderer = null, soft = null, rendererTried = false;
      var state = { built: null, cur: 0, w: 0, h: 0 };
      var orbit = visual && visual.orbit === false ? 0 : ((visual && visual.orbit) || 24);
      var camData = data.camera || {}, pos0 = (camData.position || [3, 3, 5]).slice(), look = (camData.look_at || [0, 0, 0]).slice();
      function rebuild() {
        if (state.built) { try { state.built.scene.traverse(function (o) { if (o.geometry) { o.geometry.dispose(); } }); } catch (e) { /* best effort */ } }
        state.built = I.buildScene(data); state.cur = 0;
      }
      function advanceTo(tv) {
        if (tv < state.cur - 1e-6) { rebuild(); }
        while (state.cur < tv - 1e-9) { var dt = Math.min(1 / 60, tv - state.cur); state.built.animators.forEach(function (fn) { fn(dt); }); state.cur += dt; }
      }
      rebuild();
      return state.built.texturesReady.then(function () {
        return {
          duration: sceneObj.duration || data.duration || 8,
          model: { advanceTo: advanceTo, root: function () { return state.built.scene; } },
          draw: function (ctx, rect, tv) {
            if (!rendererTried) { rendererTried = true; gl = document.createElement('canvas'); renderer = I.tryCreateWebGLRenderer(gl, { preserveDrawingBuffer: true }); }
            var dev = ctx.getTransform ? ctx.getTransform().a : 1;
            var pw = Math.max(64, Math.min(1600, Math.round(rect.w * dev))), ph = Math.max(64, Math.min(900, Math.round(rect.h * dev)));
            if (pw !== state.w || ph !== state.h) {
              state.w = pw; state.h = ph;
              if (renderer) { renderer.setSize(pw, ph, false); } else { soft = document.createElement('canvas'); soft.width = pw; soft.height = ph; }
            }
            advanceTo(tv);
            if (renderer && state.built.scene.background == null) { state.built.scene.background = new window.THREE.Color(data.background || '#1a1a1a'); }
            var ang = orbit ? 2 * Math.PI * tv / orbit : 0, dx = pos0[0] - look[0], dz = pos0[2] - look[2];
            var cam = I.buildCamera(data, pw / ph, [look[0] + dx * Math.cos(ang) - dz * Math.sin(ang), pos0[1], look[2] + dx * Math.sin(ang) + dz * Math.cos(ang)], look);
            var src;
            if (renderer) { renderer.render(state.built.scene, cam); src = gl; }
            else { I.rasterFrame(soft.getContext('2d'), pw, ph, data, state.built, cam); src = soft; }
            ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h);
          }
        };
      });
    });
  }

  // One visual node prepared: a group prepares its items, any node may carry a 2D overlay scene.
  function prepNode(v) {
    var base;
    if (v.kind === 'group') {
      base = Promise.all(v.items.map(prepNode)).then(function (children) {
        return { children: children, duration: Math.max.apply(null, [0].concat(children.map(function (c) { return (c && c.duration) || 0; }))) };
      });
    } else { base = prepLeaf(v); }
    if (!v.overlay) { return base; }
    return base.then(function (pv) {
      return sceneVisual(v.overlay.scene).then(function (ov) { pv.overlay = ov; if (ov.duration && !pv.duration) { pv.duration = ov.duration; } return pv; }, function (e) { console.warn('[deck] overlay: ' + (e && e.message || e)); return pv; });
    });
  }

  function prepVisual(slide) { return slide.visual ? prepNode(slide.visual) : Promise.resolve(null); }

  function prepLeaf(v) {
    var p;
    switch (v.kind) {
      case 'table': return Promise.resolve({});
      case 'image': {
        var list = Array.isArray(v.images) ? v.images : [{ src: v.src }];
        var out = { images: [], failed: [] };
        out.errors = [];
        return Promise.all(list.map(function (im, i) {
          return loadImage(im.src).then(function (img) { out.images[i] = img; }, function (e) { out.failed[i] = true; out.errors.push(String(e && e.message || e)); });
        })).then(function () { return out; });
      }
      case 'shapes': p = sceneVisual(v.scene); break;
      case 'anim2d': p = window.AiChat2D.ensureJsYamlLoaded().then(function () { return fetchText(v.ref); }).then(function (t) { var o = window.jsyaml.load(t); delete o.kind; return sceneVisual(o); }); break;
      case 'svg': p = v.svg ? svgToImage(v.svg).then(imageVisual) : (/\.svg(\?.*)?$/i.test(v.src) ? fetchText(v.src).then(svgToImage).then(imageVisual) : loadImage(v.src).then(imageVisual)); break;
      case 'chart': p = (/\.svg(\?.*)?$/i.test(v.src) ? fetchText(v.src).then(svgToImage) : loadImage(v.src)).then(imageVisual); break;
      case 'mermaid': p = window.AiChatMermaid ? window.AiChatMermaid.renderSvg(Core.fixMermaidSource(v.source)).then(svgToImage).then(imageVisual) : Promise.reject(new Error('the mermaid viewer is not loaded')); break;
      case 'scene3d': p = v.scene ? scene3dVisual(v.scene, v) : window.AiChat2D.ensureJsYamlLoaded().then(function () { return fetchText(v.ref); }).then(function (t) { return scene3dVisual(window.jsyaml.load(t), v); }); break;
      case 'code': p = codeVisual(v); break;
      case 'terminal': p = Promise.resolve(terminalVisual(v)); break;
      case 'quiz': p = Promise.resolve(quizVisual(v)); break;
      case 'widget': p = Promise.resolve(widgetVisual(v)); break;
      default: p = Promise.reject(new Error('unknown visual kind ' + v.kind));
    }
    return p.catch(function (e) { console.warn('[deck] visual (' + v.kind + '): ' + (e && e.message || e)); return { failed: true, error: String(e && e.message || e) }; });
  }
  function visualFailed(v) { return !!v && (v.failed === true || (Array.isArray(v.failed) && v.failed.some(Boolean)) || (Array.isArray(v.children) && v.children.some(visualFailed))); }
  function imageVisual(img) { return { images: [img], draw: containDraw(img) }; }

  // ------------------------------------------------------------------ interactive visuals: code window, terminal, answer card
  // Each one keeps its own live state in the prepared visual (scroll position / shell session / answers); draw() only paints that state, so
  // the player, the MP4 exporter and the PPTX snapshot all paint what the viewer sees now.
  function codeVisual(v) {
    var Code = window.AiChatDeckCode;
    if (!Code) { return Promise.reject(new Error('the code viewer script is not loaded')); }
    var text = v.code != null && String(v.code).trim() ? Promise.resolve(String(v.code)) : fetchText(v.src);
    return text.then(function (code) {
      var win = Code.create({ code: code, lang: v.lang, patch: v.patch, filename: v.filename || (v.src ? String(v.src).split('?')[0].split('/').pop() : ''), size: v.size, start_line: v.start_line, highlight: v.highlight, autoscroll: v.autoscroll, mode: v.mode });
      var period = v.autoscroll === true ? 12 : (+v.autoscroll || 0);
      return { code: win, duration: period ? (v.mode === 'timed' ? period : period * 2) : 0, draw: function (ctx, rect, t) { win.draw(ctx, rect, t); } };
    });
  }

  // What a terminal visual paints on the canvas (and so what MP4 / PPTX show): the live screen WITH its colours; else the screen kept from
  // before (a deck pack); else the commands as a plain transcript.
  function terminalView(tv) {
    if (tv.handle) { try { var snap = tv.handle.snapshot(); if (snap) { return snap; } } catch (e) { /* disposed */ } }
    if (tv.saved) { return tv.saved; }
    return (tv.commands || []).map(function (c) { return '$ ' + c; });
  }
  function terminalVisual(v) {
    var Code = window.AiChatDeckCode, tv = { handle: null, state: 'idle', commands: v.commands || [], error: '' };
    return { terminal: tv, draw: function (ctx, rect) {
      if (!Code) { return; }
      Code.drawTerminal(ctx, rect, terminalView(tv), { title: v.title || 'terminal', size: v.size || 24, note: tv.error ? '終端機無法啟動:' + tv.error : '' });
    } };
  }

  function quizVisual(v) {
    var Quiz = window.AiChatDeckQuiz, Code = window.AiChatDeckCode;
    var pv = { quiz: { v: v, state: { selected: [], text: '', result: null, busy: false, response: null } }, term: { handle: null, state: 'idle', commands: (v.terminal && v.terminal.commands) || [], error: '' } };
    pv.draw = function (ctx, rect) {
      if (!Quiz) { return; }
      Quiz.draw(ctx, rect, v, pv.quiz.state, { font: Core.FONT, live: !!pv.live, drawTerminal: v.type === 'terminal' && Code ? function (c, r) { Code.drawTerminal(c, r, terminalView(pv.term), { title: 'terminal', size: 20, badge: '', note: pv.term.error }); } : null });
    };
    return pv;
  }

  // An AI-written widget. pv.widget.state = {result, done, data, summary}: what the widget reported through deck.* (result counts in the score chip).
  function widgetVisual(v) {
    var W = window.AiChatDeckWidget, wd = { v: v, state: { result: null, done: false, data: null, summary: '' }, grades: 0, ready: false };
    var pv = { widget: wd, ok: !!W };
    pv.draw = function (ctx, rect) {
      // the card behind the iframe: also all that MP4 / PPTX snapshots (and a browser without the sandbox) show
      var Quiz = window.AiChatDeckQuiz, r = wd.state.result;
      ctx.save();
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = '#77BD1D'; ctx.fillRect(rect.x, rect.y, rect.w, 8);
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      var y = rect.y + 26, pad = 28; ctx.font = 'bold 20px ' + Core.FONT; ctx.fillStyle = '#77BD1D'; ctx.fillText('互動小工具' + (v.title ? ' · ' + v.title : ''), rect.x + pad, y); y += 40;
      ctx.font = '28px ' + Core.FONT; ctx.fillStyle = '#333333';
      var lines = [v.fallback || ''].concat(wd.state.summary ? ['', wd.state.summary] : []);
      lines.forEach(function (para) { Core.wrapLines(ctx, para, rect.w - pad * 2).forEach(function (l) { if (y < rect.y + rect.h - 60) { ctx.fillText(l, rect.x + pad, y); y += 40; } }); });
      if (r && Quiz) { ctx.font = 'bold 26px ' + Core.FONT; ctx.fillStyle = r.correct === true ? '#2E9E4F' : r.correct === null ? '#E8890C' : '#D64545'; ctx.fillText((r.score == null ? '' : r.got + ' / ' + r.points + ' 分') + (r.feedback ? '  ' + r.feedback : ''), rect.x + pad, rect.y + rect.h - 52); }
      ctx.restore();
    };
    return pv;
  }

  // The AI grader. Default: the online model through the server's one-shot endpoint, the offline model when there is none (AiChatDesignLlm);
  // AiChatDeck.setGradeProvider(fn) replaces it. fn(system, user) -> Promise<{score: 0..1, feedback}>
  var gradeProvider = function (system, user) {
    var D = window.AiChatDesignLlm, Quiz = window.AiChatDeckQuiz;
    if (!D || !Quiz) { return Promise.reject(new Error('no AI grader is available here')); }
    return D.jsonStep({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 400, tries: 2,
      parse: function (t) { return Quiz.parseAiReply(t); }, validate: function (o) { return typeof o.score === 'number' ? [] : ['"score" must be a number 0..1']; } })
      .then(function (r) { if (r && r.ok) { return r.value; } throw new Error('the AI grader gave no usable answer'); });
  };

  // ------------------------------------------------------------------ narration (TTS)
  // ai_chat.js installs the provider (it owns the Kokoro worker / the relay): fn(text, voiceId, speed, lang) -> Promise<ArrayBuffer mp3>
  var audioChain = Promise.resolve();
  var audioCache = {};

  // ---- the narration survives a page reload: every synthesised mp3 is also kept in the browser's Cache Storage under a hash of
  // (text, voice, speed), so reopening / reloading a deck takes the voices from disk instead of synthesising them again. Entries
  // older than 14 days (and beyond 400 entries) are dropped. Cache Storage may be missing or full (private window): then it is
  // simply the in-memory behaviour as before.
  var DISK_CACHE = 'ai-chat-deck-tts-v1', DISK_TTL_MS = 14 * 24 * 3600 * 1000, DISK_MAX = 400, pruned = false;

  function sha256Hex(text) {
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
      });
    }
    var h = 5381; for (var i = 0; i < text.length; i++) { h = ((h << 5) + h + text.charCodeAt(i)) | 0; }
    return Promise.resolve('d' + (h >>> 0).toString(16) + '-' + text.length);
  }
  function diskUrl(hash) { return location.origin + '/__ai_chat_deck_tts/' + hash + '.mp3'; }

  // Cache Storage only exists on secure origins (https / localhost); Redmine reached over plain http (e.g. through an internal proxy)
  // has IndexedDB but no Cache Storage -- so the same cache lives in IndexedDB there.
  var idbPromise = null;
  function idb() {
    if (idbPromise) { return idbPromise; }
    idbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no IndexedDB')); return; }
      var rq = indexedDB.open('AiChatDeckTts', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('mp3', { keyPath: 'hash' }); };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });
    idbPromise.catch(function () { idbPromise = Promise.reject(new Error('no IndexedDB')); idbPromise.catch(function () {}); });
    return idbPromise;
  }
  function idbReq(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('mp3', mode), out = fn(tx.objectStore('mp3'));
        tx.oncomplete = function () { resolve(out && out.result); };
        tx.onerror = tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function diskGet(hash) {
    if (window.caches) {
      return caches.open(DISK_CACHE).then(function (c) { return c.match(diskUrl(hash)); }).then(function (r) { return r ? r.arrayBuffer() : null; }).catch(function () { return null; });
    }
    return idbReq('readonly', function (st) { return st.get(hash); }).then(function (rec) { return rec ? rec.mp3 : null; }).catch(function () { return null; });
  }
  function diskPut(hash, mp3) {
    if (window.caches) {
      caches.open(DISK_CACHE).then(function (c) {
        return c.put(diskUrl(hash), new Response(mp3.slice(0), { headers: { 'Content-Type': 'audio/mpeg', 'x-ai-chat-stored-at': String(Date.now()) } })).then(function () { return prune(c); });
      }).catch(function () { /* full / private mode: fine */ });
      return;
    }
    idbReq('readwrite', function (st) { return st.put({ hash: hash, mp3: mp3.slice(0), at: Date.now() }); }).then(pruneIdb).catch(function () { /* fine */ });
  }
  function pruneIdb() {
    if (pruned) { return null; }
    pruned = true;
    return idbReq('readwrite', function (st) {
      var rq = st.openCursor(), rows = [];
      rq.onsuccess = function () {
        var cur = rq.result;
        if (cur) { rows.push({ key: cur.key, at: cur.value.at || 0 }); cur.continue(); return; }
        rows.sort(function (a, b) { return b.at - a.at; });
        var now = Date.now();
        rows.forEach(function (row, i) { if (i >= DISK_MAX || now - row.at > DISK_TTL_MS) { st.delete(row.key); } });
      };
      return rq;
    }).catch(function () { /* best effort */ });
  }
  function prune(c) {
    if (pruned) { return null; }
    pruned = true;
    return c.keys().then(function (reqs) {
      return Promise.all(reqs.map(function (rq) { return c.match(rq).then(function (r) { return { rq: rq, at: Number(r && r.headers.get('x-ai-chat-stored-at')) || 0 }; }); })).then(function (rows) {
        rows.sort(function (a, b) { return b.at - a.at; });
        var now = Date.now();
        rows.forEach(function (row, i) { if (i >= DISK_MAX || now - row.at > DISK_TTL_MS) { c.delete(row.rq); } });
      });
    }).catch(function () { /* best effort */ });
  }

  // Decoded PCM is big (a 30 s slide is ~6 MB) and a 30 minute deck has 60+ of them: only the mp3 bytes and the length are kept per slide;
  // the PCM is decoded again when a slide is about to be played / mixed (Session.audioBuffer, a small LRU).
  function decodeMp3(mp3) {
    var ctx = getAudioCtx();
    if (!ctx) { return Promise.reject(new Error('this browser has no Web Audio')); }
    return ctx.decodeAudioData(mp3.slice(0)).then(function (buffer) { return { mp3: mp3, duration: buffer.duration, sampleRate: buffer.sampleRate }; });
  }

  function synthesize(text, voice, speed, lang) {
    var key = [voice || '', speed || 1, text].join('|');
    if (audioCache[key]) { return audioCache[key]; }
    var p = sha256Hex(key).then(function (hash) {
      return diskGet(hash).then(function (hit) {
        if (hit) { return decodeMp3(hit); }
        var run = function () {
          if (!ttsProvider) { return Promise.reject(new Error('no text-to-speech engine is available here')); }
          return ttsProvider(text, voice, speed, lang).then(function (mp3) { diskPut(hash, mp3); return decodeMp3(mp3); });
        };
        // a disk hit never waits for the (one-at-a-time) synthesiser; a miss queues behind it
        // a provider that schedules its own work (concurrent: voices from a service can be made several at a time; a local model one at a time)
        // is called at once; otherwise every call waits for the one before it
        var q;
        if (ttsConcurrent) { q = run(); } else { q = audioChain.then(run, run); audioChain = q.then(function () {}, function () {}); }
        return q;
      });
    });
    audioCache[key] = p;
    p.catch(function () { delete audioCache[key]; });
    return p;
  }

  // ------------------------------------------------------------------ session: one deck, prepared slide by slide
  function Session(deck, raw, url) {
    this.deck = deck; this.raw = raw; this.url = url || '';
    this.preps = deck.slides.map(function (s) { return { timing: Core.timingFor(s, 0, 0), visual: null, audio: null, state: 'pending', error: null, promise: null }; });
    this.tl = Core.buildTimeline(deck, this.preps.map(function (p) { return p.timing; }));
    this.listeners = [];
    this.assets = {};
    this.cursor = 0;
    this.inflight = 0;
  }
  Session.prototype.on = function (fn) { this.listeners.push(fn); };
  Session.prototype.emit = function (what) { var self = this; this.listeners.forEach(function (fn) { try { fn(what, self); } catch (e) { console.warn(e); } }); };
  // Every scored interactive piece of the deck (answer cards and widgets): [{slide, v, pv, result}] -- pv exists once its slide was prepared,
  // result is what the viewer has earned so far (null until answered).
  Session.prototype.quizItems = function () {
    var out = [], self = this;
    function walk(i, v, pv) {
      if (!v) { return; }
      if (v.kind === 'group') { (v.items || []).forEach(function (it, k) { walk(i, it, pv && pv.children && pv.children[k]); }); }
      else if (v.kind === 'quiz' || v.kind === 'widget') {
        var st = pv && (v.kind === 'quiz' ? pv.quiz && pv.quiz.state : pv.widget && pv.widget.state);
        out.push({ slide: i, v: v, pv: pv && st ? pv : null, result: st ? st.result : null, done: !!(st && st.done) });
      }
    }
    this.deck.slides.forEach(function (sl, i) { walk(i, sl.visual, self.preps[i].visual); });
    return out;
  };
  // Every terminal of the deck (terminal visuals and terminal answer cards): [{slide, v, tv}] -- tv = {handle, saved, commands, ...}
  Session.prototype.terminalItems = function () {
    var out = [], self = this;
    function walk(i, v, pv) {
      if (!v || !pv) { return; }
      if (v.kind === 'group') { (v.items || []).forEach(function (it, k) { walk(i, it, pv.children && pv.children[k]); }); }
      else if (v.kind === 'terminal' && pv.terminal) { out.push({ slide: i, v: v, tv: pv.terminal }); }
      else if (v.kind === 'quiz' && v.type === 'terminal' && pv.term) { out.push({ slide: i, v: v, tv: pv.term }); }
    }
    this.deck.slides.forEach(function (sl, i) { walk(i, sl.visual, self.preps[i].visual); });
    return out;
  };

  // A terminal the viewer never opened still has a "last state": what its setup commands leave on the screen. Before an export each such
  // terminal is run once, unseen (80x24), and its screen kept -- so MP4 / PPTX show the colours of the real result, not a bare transcript.
  Session.prototype.settleTerminals = function (onProgress) {
    var items = this.terminalItems().filter(function (it) { return !it.tv.handle && !it.tv.saved && it.tv.state === 'idle'; }), done = 0;
    if (!items.length || !window.AiChatTerminal || !window.AiChatTerminal.mountEmbedded) { return Promise.resolve(); }
    return items.reduce(function (chain, it) {
      return chain.then(function () {
        var box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:460px;visibility:hidden';
        document.body.appendChild(box);
        it.tv.state = 'settling';
        return window.AiChatTerminal.mountEmbedded(box, { commands: it.tv.commands }).then(function (h) {
          h.resize(80, 24); it.tv.saved = h.snapshot(true); h.dispose();
        }).catch(function (e) { it.tv.error = String(e && e.message || e).slice(0, 100); }).then(function () {
          it.tv.state = 'idle'; if (box.parentNode) { box.parentNode.removeChild(box); }
          done++; if (onProgress) { onProgress(done, items.length); }
        });
      });
    }, Promise.resolve());
  };
  Session.prototype.isReady = function (i) { return this.preps[i] && this.preps[i].state === 'ready'; };
  Session.prototype.readyCount = function () { return this.preps.filter(function (p) { return p.state === 'ready'; }).length; };

  // The 3D stage of a deck with style "3d" (three.js, WebGL). Without WebGL the deck still plays, flat; stageNote says why.
  Session.prototype.loadStage = function () {
    var self = this;
    if (!this.deck.slides.some(function (sl) { return sl.stage === '3d'; })) { return Promise.resolve(); }
    if (!window.AiChatDeckStage3D) { this.stageNote = '3D 腳本未載入,改用平面轉場'; return Promise.resolve(); }
    return window.AiChatDeckStage3D.create().then(function (stage) { self.stage3d = stage; self.emit('state'); }, function (e) {
      self.stageNote = '無法啟動 3D 舞台(' + (e && e.message || e) + '),改用平面轉場'; self.emit('state');
    });
  };

  Session.prototype.loadAssets = function () {
    var urls = window.AiChatExportAssetUrls || {}, self = this;
    var map = { titleBg: 'pptxTitleBackground', topicBg: 'pptxTopicBackground', contentBg: 'pptxContentBackground', logo: 'pptxLogo' };
    return Promise.all(Object.keys(map).map(function (k) {
      return urls[map[k]] ? loadImage(window.AiChatRooted ? window.AiChatRooted(urls[map[k]]) : urls[map[k]]).then(function (img) { self.assets[k] = img; }, function () { /* the renderer falls back to plain colours */ }) : Promise.resolve();
    }));
  };

  // Prepares slide i (visual + narration); memoised. Never rejects: a failure is recorded and the slide still plays (silent / placeholder).
  // A step that never answers (a library that cannot be fetched, a voice service that hangs) must not hold the whole deck: after `ms` it fails
  // like any other error, and the slide plays without it (silent / without that visual).
  function withTimeout(p, ms, what) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(what + ' did not answer within ' + Math.round(ms / 1000) + ' seconds')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }
  Session.prototype.prepare = function (i) {
    var self = this, pr = this.preps[i], slide = this.deck.slides[i];
    if (pr.promise) { return pr.promise; }
    pr.state = 'loading'; this.emit('state');
    var voice = slide.voice || this.deck.deck.voice, speed = this.deck.deck.speed || 1;
    var packed = this.packAudio && this.packAudio[slide.id];
    var audioP = slide.narration ? withTimeout(packed ? decodeMp3(packed) : synthesize(slide.narration, voice, speed, this.deck.deck.lang), 240000, 'narration').then(function (a) { pr.audio = a; }, function (e) { pr.error = String(e && e.message || e); }) : Promise.resolve();
    var visualP = withTimeout(prepVisual(slide), 90000, 'visual').then(function (v) { pr.visual = v; self.restoreResults(i); }, function (e) { pr.visual = null; pr.error = pr.error || String(e && e.message || e); });
    pr.promise = Promise.all([audioP, visualP]).then(function () {
      pr.timing = Core.timingFor(slide, pr.audio ? pr.audio.duration : 0, pr.visual && pr.visual.duration || 0);
      pr.state = 'ready';
      self.retime();
    });
    return pr.promise;
  };

  // Answers saved in a deck pack go back into the cards / widgets of slide i (keyed "<slide id>#<n-th scored piece of the slide>").
  Session.prototype.restoreResults = function (i) {
    var sid = this.deck.slides[i].id, tn = 0, ts = this.packTerminals || {};
    this.terminalItems().filter(function (it) { return it.slide === i; }).forEach(function (it) { var snap = ts[sid + '#' + tn++]; if (snap) { it.tv.saved = snap; } });
    if (!this.packResults) { return; }
    var id = this.deck.slides[i].id, n = 0, saved = this.packResults;
    this.quizItems().filter(function (it) { return it.slide === i; }).forEach(function (it) {
      var rec = saved[id + '#' + n++]; if (!rec || !it.pv) { return; }
      var st = it.v.kind === 'quiz' ? it.pv.quiz.state : it.pv.widget.state;
      Object.keys(rec).forEach(function (k) { if (k !== '_r') { st[k] = rec[k]; } });
      st.busy = false;
    });
  };

  // Rebuilds the timeline after a slide's real length became known. Callers that hold a playhead keep (slide, time) and re-derive T.
  Session.prototype.retime = function () {
    this.tl = Core.buildTimeline(this.deck, this.preps.map(function (p) { return p.timing; }));
    this.emit('timings'); this.emit('state');
  };

  // Keeps preparing: the slides nearest the cursor first (cursor .. cursor+LOOKAHEAD), then the rest, two slides at a time.
  Session.prototype.pump = function () {
    var self = this;
    if (this.dead) { return; }
    var order = [], n = this.preps.length, i;
    for (i = this.cursor; i < n; i++) { order.push(i); }
    for (i = 0; i < this.cursor; i++) { order.push(i); }
    for (var k = 0; k < order.length && this.inflight < 2; k++) {
      var idx = order[k], pr = this.preps[idx];
      if (pr.state !== 'pending') { continue; }
      this.inflight++;
      this.prepare(idx).then(function () { self.inflight--; self.pump(); });
    }
  };
  Session.prototype.setCursor = function (i) {
    this.cursor = Math.max(0, Math.min(this.preps.length - 1, i)); this.pump();
    var self = this;
    [this.cursor, this.cursor + 1].forEach(function (k) { if (self.preps[k] && self.preps[k].audio) { self.audioBuffer(k).catch(function () {}); } });
  };
  Session.prototype.whenReady = function (i) { return this.prepare(i); };
  Session.prototype.whenAllReady = function (onProgress) {
    var self = this, done = 0;
    return Promise.all(this.preps.map(function (_p, i) { return self.prepare(i).then(function () { done++; if (onProgress) { onProgress(done, self.preps.length); } }); }));
  };
  // One info object per output size (it carries the offscreen canvases the renderer reuses), updated in place.
  Session.prototype.info = function (opts) {
    opts = opts || {};
    var w = opts.width || 1280, h = opts.height || 720, key = w + 'x' + h;
    this.infos = this.infos || {};
    var info = this.infos[key];
    if (!info) {
      info = this.infos[key] = { width: w, height: h, preps: this.preps, assets: this.assets,
        makeCanvas: function (cw, ch) { var c = document.createElement('canvas'); c.width = cw; c.height = ch; return c; } };
    }
    info.subtitles = opts.subtitles !== false;
    info.stage3d = this.stage3d || null;
    return info;
  };
  // The decoded narration of slide i (AudioBuffer), kept in a small LRU (the playhead's slide and the next one are never evicted).
  Session.prototype.audioBuffer = function (i) {
    var self = this, pr = this.preps[i];
    if (!pr || !pr.audio) { return Promise.resolve(null); }
    this.pcm = this.pcm || {};
    if (this.pcm[i]) { this.pcm[i].at = Date.now(); return this.pcm[i].promise; }
    var ctx = getAudioCtx();
    var promise = ctx.decodeAudioData(pr.audio.mp3.slice(0));
    this.pcm[i] = { promise: promise, at: Date.now() };
    var keys = Object.keys(this.pcm);
    if (keys.length > 5) {
      keys.filter(function (k) { return +k !== self.cursor && +k !== self.cursor + 1 && +k !== i; })
        .sort(function (a2, b2) { return self.pcm[a2].at - self.pcm[b2].at; }).slice(0, keys.length - 5).forEach(function (k) { delete self.pcm[k]; });
    }
    promise.catch(function () { delete self.pcm[i]; });
    return promise;
  };

  // The whole narration as ONE mono track, produced chunk by chunk (never all at once): {sampleRate, channels:1, length, read(pos, n)}.
  // Used by the MP4 export, which feeds it straight into the audio encoder.
  Session.prototype.audioSource = function () {
    var self = this, ctx = getAudioCtx();
    var withAudio = this.preps.map(function (p, i) { return p.audio ? i : -1; }).filter(function (i) { return i >= 0; });
    if (!withAudio.length || !ctx) { return null; }
    var sr = ctx.sampleRate;
    var spans = withAudio.map(function (i) {
      var seg = self.tl.segs[i], start = Math.round((seg.bodyStart + self.preps[i].timing.narrStart) * sr);
      return { i: i, start: start, end: start + Math.ceil(self.preps[i].audio.duration * sr) };
    });
    return {
      sampleRate: sr, channels: 1, length: Math.ceil(this.tl.total * sr),
      read: function (pos, n) {
        var out = new Float32Array(n), end = pos + n;
        var hits = spans.filter(function (sp) { return sp.start < end && sp.end > pos; });
        return hits.reduce(function (chain, sp) {
          return chain.then(function () {
            return self.audioBuffer(sp.i).then(function (buf) {
              var ch = buf.getChannelData(0), from = Math.max(pos, sp.start), to = Math.min(end, sp.start + ch.length);
              for (var k = from; k < to; k++) { var v = out[k - pos] + ch[k - sp.start]; out[k - pos] = v > 1 ? 1 : (v < -1 ? -1 : v); }
            });
          });
        }, Promise.resolve()).then(function () { return out; });
      }
    };
  };
  Session.prototype.destroy = function () {
    this.dead = true;
    this.preps.forEach(function (p) {
      (function walk(pv) {
        if (!pv) { return; }
        [pv.terminal, pv.term].forEach(function (t) { if (t && t.handle) { try { t.handle.dispose(); } catch (e) { /* gone */ } t.handle = null; } });
        (pv.children || []).forEach(walk);
      })(p.visual);
    });
  };

  // ------------------------------------------------------------------ player (the window)
  function Player(session, container) {
    var self = this;
    this.s = session; this.box = container;
    this.T = 0; this.playing = false; this.speed = 1; this.muted = false; this.subtitles = true;
    this.last = 0; this.alive = true; this.src = null; this.audioFor = -1; this.buffering = -1; this.started = false; this.ended = false;
    this.build();
    session.on(function (what) { if (what === 'state') { self.updateStatus(); } if (what === 'timings') { self.updateChapters(); } });
    session.loadAssets().then(function () { self.draw(); });
    session.loadStage().then(function () { self.updateStatus(); });
    session.setCursor(0);
    this.updateStatus();
    requestAnimationFrame(function tick(now) { if (!self.alive) { return; } self.tick(now); requestAnimationFrame(tick); });
  }

  Player.prototype.build = function () {
    var self = this, b = this.box, deck = this.s.deck;
    b.innerHTML = '';
    b.classList.add('ai-chat-deck'); b.tabIndex = 0;
    var bar = el('div', 'ai-chat-deck-bar');
    this.titleEl = el('span', 'ai-chat-deck-title', deck.deck.title);
    bar.appendChild(this.titleEl);
    this.chapterSel = el('select', 'ai-chat-deck-chapters'); this.chapterSel.title = '章節 / 投影片';
    this.chapterSel.addEventListener('change', function () { self.goTo(parseInt(self.chapterSel.value, 10)); });
    bar.appendChild(this.chapterSel);
    var floatBtn = this.btn('⧉', '視窗化(可拖曳、可縮放)', function () { self.toggleFloat(); });
    var maxBtn = this.btn('⛶', '最大化 (F)', function () { self.toggleFullscreen(); });
    var expBtn = this.btn('⤓ 匯出', '匯出 MP4 / PPTX / 原始檔 / 字幕', function (e) { self.exportMenu(e.currentTarget); }); expBtn.classList.add('ai-chat-deck-export-btn');
    [floatBtn, maxBtn, expBtn].forEach(function (x) { bar.appendChild(x); });
    this.bar = bar;
    b.appendChild(bar);

    var stage = el('div', 'ai-chat-deck-stage');
    this.canvas = el('canvas', 'ai-chat-deck-canvas');
    stage.appendChild(this.canvas);
    // the 3D stage is interactive: drag to orbit, wheel to zoom, double-click to reset (only while a 3D model is on stage)
    var drag = null;
    this.canvas.addEventListener('pointerdown', function (e) {
      if (self.regionPointerDown(e)) { return; }
      if (!self.interactive3D()) { return; }
      drag = { x: e.clientX, y: e.clientY }; self.canvas.setPointerCapture(e.pointerId); self.canvas.classList.add('dragging');
    });
    this.canvas.addEventListener('pointermove', function (e) {
      if (self.regionPointerMove(e)) { return; }
      if (!drag || !self.s.stage3d) { return; }
      var v = self.s.stage3d.view; v.yaw -= (e.clientX - drag.x) * 0.006; v.pitch += (e.clientY - drag.y) * 0.004;
      drag.x = e.clientX; drag.y = e.clientY; self.s.stage3d.clampView(); self.draw();
    });
    ['pointerup', 'pointercancel'].forEach(function (n) { self.canvas.addEventListener(n, function () { drag = null; self.uiDrag = null; self.canvas.classList.remove('dragging'); self.canvas.classList.remove('dragging-ui'); }); });
    this.canvas.addEventListener('wheel', function (e) {
      if (self.regionWheel(e)) { return; }
      if (!self.interactive3D()) { return; }
      e.preventDefault(); self.s.stage3d.view.zoom -= e.deltaY * 0.0012; self.s.stage3d.clampView(); self.draw();
    }, { passive: false });
    this.canvas.addEventListener('dblclick', function () { if (self.interactive3D()) { self.s.stage3d.resetView(); self.draw(); } });
    this.prevZone = el('button', 'ai-chat-deck-zone ai-chat-deck-zone-prev', '‹'); this.prevZone.type = 'button'; this.prevZone.title = '上一頁 (←)';
    this.nextZone = el('button', 'ai-chat-deck-zone ai-chat-deck-zone-next', '›'); this.nextZone.type = 'button'; this.nextZone.title = '下一頁 (→)';
    this.prevZone.addEventListener('click', function () { self.prev(); });
    this.nextZone.addEventListener('click', function () { self.next(); });
    stage.appendChild(this.prevZone); stage.appendChild(this.nextZone);
    // shown on the stage (the status line is hidden in full screen) while the deck waits for an answer
    this.toastEl = el('div', 'ai-chat-deck-toast'); this.toastEl.style.display = 'none'; stage.appendChild(this.toastEl);
    this.holdEl = el('div', 'ai-chat-deck-hold', '⏸ 請先回答並按「提交」(或按右側 › 略過)'); this.holdEl.style.display = 'none'; stage.appendChild(this.holdEl);
    this.overlay = el('div', 'ai-chat-deck-overlay');
    this.overlayText = el('div', 'ai-chat-deck-overlay-text', '準備中…');
    this.bigPlay = el('button', 'ai-chat-deck-bigplay', '▶'); this.bigPlay.type = 'button'; this.bigPlay.style.display = 'none';
    this.bigPlay.addEventListener('click', function () { self.play(); });
    this.overlay.appendChild(this.overlayText); this.overlay.appendChild(this.bigPlay);
    stage.appendChild(this.overlay);
    b.appendChild(stage);

    var ctl = el('div', 'ai-chat-deck-controls');
    this.playBtn = this.btn('▶', '播放 / 暫停 (空白鍵)', function () { self.toggle(); }); ctl.appendChild(this.playBtn);
    this.progress = el('div', 'ai-chat-deck-progress');
    this.progressFill = el('div', 'ai-chat-deck-progress-fill'); this.progress.appendChild(this.progressFill);
    this.ticks = el('div', 'ai-chat-deck-ticks'); this.progress.appendChild(this.ticks);
    this.progress.addEventListener('click', function (e) { var r = self.progress.getBoundingClientRect(); self.seekFraction((e.clientX - r.left) / r.width); });
    ctl.appendChild(this.progress);
    this.timeEl = el('span', 'ai-chat-deck-time', '0:00 / 0:00'); ctl.appendChild(this.timeEl);
    this.scoreEl = el('span', 'ai-chat-deck-score'); this.scoreEl.style.display = 'none'; this.scoreEl.title = '互動卡片的得分'; ctl.appendChild(this.scoreEl);
    this.ccBtn = this.btn('CC', '字幕開關 (C)', function () { self.subtitles = !self.subtitles; self.ccBtn.classList.toggle('off', !self.subtitles); self.draw(); }); ctl.appendChild(this.ccBtn);
    this.muteBtn = this.btn('🔊', '靜音 (M)', function () { self.setMuted(!self.muted); }); ctl.appendChild(this.muteBtn);
    var spd = el('select', 'ai-chat-deck-speed');
    [0.75, 1, 1.25, 1.5, 2].forEach(function (v) { var o = el('option', null, v + 'x'); o.value = v; if (v === 1) { o.selected = true; } spd.appendChild(o); });
    spd.addEventListener('change', function () { self.setSpeed(parseFloat(spd.value)); }); ctl.appendChild(spd);
    b.appendChild(ctl);

    this.dots = el('div', 'ai-chat-deck-dots');
    deck.slides.forEach(function (_s, i) {
      var d = el('span', 'ai-chat-deck-dot'); d.title = (i + 1) + '. ' + deck.slides[i].title;
      d.addEventListener('click', function () { self.goTo(i); }); self.dots.appendChild(d);
    });
    b.appendChild(this.dots);
    this.status = el('div', 'ai-chat-deck-status'); b.appendChild(this.status);

    b.addEventListener('keydown', function (e) {
      if (e.target && (/^(select|input|textarea)$/i.test(e.target.tagName) || (e.target.closest && e.target.closest('.ai-chat-deck-host')))) { return; }
      var k = e.key;
      if (k === 'ArrowRight' || k === 'PageDown') { self.next(); } else if (k === 'ArrowLeft' || k === 'PageUp') { self.prev(); }
      else if (k === ' ') { self.toggle(); } else if (k === 'f' || k === 'F') { self.toggleFullscreen(); }
      else if (k === 'c' || k === 'C') { self.ccBtn.click(); } else if (k === 'm' || k === 'M') { self.setMuted(!self.muted); }
      else if (k === 'Escape' && self.floating) { self.toggleFloat(); } else { return; }
      e.preventDefault();
    });
    window.addEventListener('message', function (e) { if (self.alive) { self.widgetMessage(e); } });
    document.addEventListener('fullscreenchange', function () { if (self.alive) { self.resize(); self.draw(); } });
    if (window.ResizeObserver) { new ResizeObserver(function () { self.resize(); self.draw(); }).observe(stage); }
    this.updateChapters();
    this.resize();
  };

  Player.prototype.btn = function (label, title, fn) {
    var b = el('button', 'ai-chat-deck-btn', label); b.type = 'button'; b.title = title; b.addEventListener('click', fn); return b;
  };

  Player.prototype.updateChapters = function () {
    var deck = this.s.deck, sel = this.chapterSel, cur = sel.value;
    sel.innerHTML = '';
    deck.chapters.forEach(function (ch, ci) {
      var og = document.createElement('optgroup'); og.label = (ci + 1) + '. ' + ch.title;
      deck.slides.forEach(function (s, i) { if (s.chapter === ci) { var o = el('option', null, (i + 1) + '. ' + (s.title || '(untitled)')); o.value = i; og.appendChild(o); } });
      sel.appendChild(og);
    });
    sel.value = this.curIndex() + '' || cur;
    this.ticks.innerHTML = '';
    var tl = this.s.tl, total = Math.max(tl.total, 0.001);
    deck.chapters.forEach(function (ch) { var t = el('span', 'ai-chat-deck-tick'); t.style.left = (tl.segs[ch.first].transStart / total * 100) + '%'; t.title = ch.title; this.ticks.appendChild(t); }, this);
  };

  Player.prototype.resize = function () {
    var stage = this.canvas.parentNode, w = stage.clientWidth || 640, dpr = window.devicePixelRatio || 1;
    var px = w * dpr > 1400 ? 1920 : 1280;
    if (this.canvas.width !== px) { this.canvas.width = px; this.canvas.height = Math.round(px * 9 / 16); }
  };

  // True while the slide on show has a 3D model on the 3D stage (so drag / wheel / double-click mean something).
  Player.prototype.interactive3D = function () {
    var s = this.s, st = s.stage3d;
    if (!st) { return false; }
    var slide = s.deck.slides[this.curIndex()], prep = s.preps[slide.index];
    if (!Core.stageSlide(s.deck, slide, { stage3d: st, makeCanvas: true, preps: s.preps })) { return false; }
    var found = Core.findModel(slide.visual, prep && prep.visual);
    return !!found && found.node.interactive !== false;
  };

  // ---- interactive visuals (code window, live terminal, answer card) of the slide on show
  // The 16:9 picture sits centred ("contain") in the stage: in full screen, or any window that is not 16:9, there are bars at the sides or at the
  // top. Everything laid over the canvas (the DOM terminal / inputs / widgets) and every pointer position is mapped through THIS box, never
  // through the stage's own size, or it lands outside the slide's frame.
  Player.prototype.picture = function () {
    var stage = this.canvas.parentNode, sw = stage.clientWidth || 640, sh = stage.clientHeight || 360, k = Math.min(sw / Core.W, sh / Core.H);
    return { k: k, left: (sw - Core.W * k) / 2, top: (sh - Core.H * k) / 2, width: Core.W * k, height: Core.H * k };
  };
  // Design units (1920x1080) of a pointer event over the canvas; k = design units per screen pixel.
  Player.prototype.toDesign = function (e) {
    var r = this.canvas.getBoundingClientRect(), k = Math.min(r.width / Core.W, r.height / Core.H) || 1;
    var ox = (r.width - Core.W * k) / 2, oy = (r.height - Core.H * k) / 2;
    return { x: (e.clientX - r.left - ox) / k, y: (e.clientY - r.top - oy) / k, k: 1 / k };
  };
  // The operable parts of the slide on show; none while a transition runs or the slide is not prepared.
  Player.prototype.regionsNow = function () {
    var loc = this.loc();
    if (loc.phase !== 'body' || !this.s.isReady(loc.i)) { return []; }
    return Core.interactiveRegions(this.s.deck.slides[loc.i], this.s.preps[loc.i].visual ? { visual: this.s.preps[loc.i].visual } : null);
  };
  function inRect(r, x, y) { return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

  Player.prototype.regionPointerDown = function (e) {
    var d = this.toDesign(e), self = this, Quiz = window.AiChatDeckQuiz, regs = this.regionsNow(), done = false;
    regs.forEach(function (rg) {
      if (done) { return; }
      if (rg.kind === 'quiz' && Quiz && rg.pv.quiz && inRect(rg.rect, d.x, d.y)) {
        var st = rg.pv.quiz.state, h = Quiz.hit(st, d.x, d.y), v = rg.node, locked = !!st.result || st.busy;
        if (h && h.type === 'option' && !locked) { Quiz.pick(v, st, h.i); self.draw(); }
        else if (h && h.type === 'button') { self.quizAction(rg, h.id); }
        done = !!h;
      } else if (rg.kind === 'code' && rg.pv.code && inRect(rg.rect, d.x, d.y)) {
        var axis = rg.pv.code.hitThumb(d.x, d.y);
        self.uiDrag = { rg: rg, x: e.clientX, y: e.clientY, axis: axis }; self.canvas.setPointerCapture(e.pointerId); self.canvas.classList.add('dragging-ui'); done = true;
      }
    });
    return done;
  };
  Player.prototype.regionPointerMove = function (e) {
    var dr = this.uiDrag;
    if (dr) {
      var k = this.toDesign(e).k, dx = (e.clientX - dr.x) * k, dy = (e.clientY - dr.y) * k, win = dr.rg.pv.code;
      if (dr.axis) { win.dragThumb(dr.axis, dr.axis === 'y' ? dy : dx); } else { win.scrollBy(-dx, -dy); }
      dr.x = e.clientX; dr.y = e.clientY; this.draw(); return true;
    }
    // hover: a hand over anything clickable
    var d = this.toDesign(e), Quiz = window.AiChatDeckQuiz, pointer = false;
    this.regionsNow().forEach(function (rg) { if (rg.kind === 'quiz' && Quiz && rg.pv.quiz) { var h = Quiz.hit(rg.pv.quiz.state, d.x, d.y); if (h && (h.type === 'button' || (h.type === 'option' && !rg.pv.quiz.state.result))) { pointer = true; } } });
    this.canvas.style.cursor = pointer ? 'pointer' : '';
    return false;
  };
  Player.prototype.regionWheel = function (e) {
    var d = this.toDesign(e), hit = null;
    this.regionsNow().forEach(function (rg) { if (!hit && rg.kind === 'code' && rg.pv.code && inRect(rg.rect, d.x, d.y)) { hit = rg; } });
    if (!hit) { return false; }
    var win = hit.pv.code, unit = e.deltaMode === 1 ? win.lineHeight : (e.deltaMode === 2 ? win.lineHeight * 20 : d.k);
    win.scrollBy(e.shiftKey ? e.deltaY * unit : (e.deltaX || 0) * unit, e.shiftKey ? 0 : e.deltaY * unit);
    e.preventDefault(); this.draw(); return true;
  };

  function quizEmpty(v, resp) {
    if (v.type === 'choice' || v.type === 'multi') { return !(resp.selected || []).length; }
    if (v.type === 'short' || v.type === 'open') { return !String(resp.text || '').trim(); }
    return false;
  }
  function quizResponse(rg) {
    var q = rg.pv.quiz, st = q.state, h = rg.pv.term && rg.pv.term.handle;
    return { selected: (st.selected || []).slice(), text: st.text || '', screen: h ? h.text() : '', history: h ? h.history() : [] };
  }
  Player.prototype.setNote = function (text) { this.status.textContent = text; };
  // A message on the stage itself (the status line is hidden in full screen): errors of a widget, for a few seconds.
  Player.prototype.toast = function (text, ms) {
    var self = this; this.toastEl.textContent = text; this.toastEl.style.display = '';
    clearTimeout(this.toastTimer); this.toastTimer = setTimeout(function () { self.toastEl.style.display = 'none'; }, ms || 8000);
  };

  // submit / reveal / retry on an answer card
  Player.prototype.quizAction = function (rg, id) {
    var self = this, Quiz = window.AiChatDeckQuiz, v = rg.node, q = rg.pv.quiz, st = q.state;
    if (id === 'retry') { st.result = null; st.busy = false; st.selected = []; st.text = ''; st.response = null; if (rg.pv.hostInput) { rg.pv.hostInput.value = ''; } this.draw(); return; }
    if (id === 'reveal') {
      var ans = v.reference || (v.options && v.answer != null ? Quiz.keyOf(v).map(function (i) { return v.options[i]; }).join('、') : (Array.isArray(v.answer) ? v.answer.join(' / ') : v.answer)) || '';
      st.response = quizResponse(rg); st.result = { score: 0, points: Quiz.points(v), got: 0, correct: false, feedback: '參考答案:' + ans, revealed: true };
      this.draw(); return;
    }
    var resp = quizResponse(rg);
    if (quizEmpty(v, resp)) { this.setNote('請先作答再提交'); return; }
    var g = Quiz.grade(v, resp);
    if (!g.needsAi) { st.response = resp; st.result = g; this.draw(); return; }
    st.busy = true; this.draw();
    var pr = Quiz.aiPrompt(v, resp);
    gradeProvider(pr.system, pr.user).then(function (ai) {
      st.busy = false; st.response = resp;
      st.result = Quiz.applyAi(v, { score: Math.max(0, Math.min(1, Number(ai.score) || 0)), feedback: String(ai.feedback || '') });
      self.draw();
    }, function (err) {
      st.busy = false; st.response = resp;
      st.result = { score: null, points: Quiz.points(v), got: 0, correct: null, feedback: 'AI 評分暫時無法使用(' + String(err && err.message || err).slice(0, 80) + ')。' + (v.reference ? '參考答案:' + v.reference : ''), unavailable: true };
      self.draw();
    });
  };

  // The other side of the widget protocol (ai_chat_deck_widget.js): messages from a widget's iframe, answered to that iframe only.
  Player.prototype.widgetMessage = function (e) {
    var d = e.data;
    if (!d || d.t !== 'deck' || !this.hosts) { return; }
    var self = this, host = null, Quiz = window.AiChatDeckQuiz, W = window.AiChatDeckWidget;
    Object.keys(this.hosts).forEach(function (k) { var h = self.hosts[k]; if (h.widget && h.el.contentWindow === e.source) { host = h; } });
    if (!host || !Quiz) { return; }
    var wd = host.widget, v = host.node, st = wd.state, pts = Quiz.points(v);
    function reply(m) { try { host.el.contentWindow.postMessage(Object.assign({ t: 'deck' }, m), '*'); } catch (err) { /* frame gone */ } }
    if (d.op === 'ready') { wd.ready = true; reply({ op: 'init', points: pts, data: st.data }); }
    else if (d.op === 'score') {
      var got = Number(d.got), max = Number(d.max);
      if (!isFinite(got)) { return; }
      if (isFinite(max) && max > 0 && max !== pts) { got = got / max * pts; }
      got = Math.max(0, Math.min(pts, Math.round(got * 100) / 100));
      st.result = { score: pts ? got / pts : 0, points: pts, got: got, correct: pts && got >= pts ? true : (got <= 0 ? false : null), feedback: String(d.feedback || '').slice(0, 300), widget: true };
      this.draw();
    }
    else if (d.op === 'error') { st.error = String(d.message || 'error').slice(0, 200); this.setNote('⚠ 互動小工具發生錯誤:' + st.error + '(簡報本身不受影響)'); this.toast('⚠ 互動小工具發生錯誤:' + st.error + '(簡報本身不受影響)'); }
    else if (d.op === 'done') { st.done = true; this.draw(); }
    else if (d.op === 'summary') { st.summary = String(d.text || '').slice(0, 400); this.draw(); }
    else if (d.op === 'state') { try { var js = JSON.stringify(d.data); if (js && js.length <= 50000) { st.data = JSON.parse(js); } } catch (err) { /* not serialisable */ } }
    else if (d.op === 'grade') {
      var id = d.id;
      if (!v.grade) { reply({ op: 'grade-result', id: id, error: 'this widget has no "grade" settings in the deck' }); return; }
      if (wd.grades >= W.MAX_GRADES) { reply({ op: 'grade-result', id: id, error: 'too many AI gradings from this widget (max ' + W.MAX_GRADES + ')' }); return; }
      wd.grades++;
      var pr = Quiz.aiPrompt({ type: 'open', question: v.grade.question, reference: v.grade.reference, rubric: v.grade.rubric }, { text: String(d.answer || '').slice(0, 2000) });
      gradeProvider(pr.system, pr.user).then(function (ai) { reply({ op: 'grade-result', id: id, score: Math.max(0, Math.min(1, Number(ai.score) || 0)), feedback: String(ai.feedback || '') }); },
        function (err) { reply({ op: 'grade-result', id: id, error: String(err && err.message || err).slice(0, 120) }); });
    }
  };

  Player.prototype.setHold = function (i) {
    var text = this.holdReason(i) === 'terminal' ? '⏸ 請在終端機輸入指令(或按右側 › 略過)' : '⏸ 請先回答並按「提交」(或按右側 › 略過)';
    this.status.textContent = text; this.holdEl.textContent = text;
  };

  // True while the deck must wait at the end of slide i: an answer card nobody answered, a widget with wait: true that has not reported, or an
  // interactive terminal where the viewer has not typed a command yet (the slide asked them to; wait: false lets the deck run past).
  Player.prototype.holdsForQuiz = function (i) {
    return !!this.holdReason(i);
  };
  Player.prototype.holdReason = function (i) {
    var quiz = this.s.quizItems().some(function (it) { return it.slide === i && it.v.wait === true && it.pv && !it.result && !it.done; });
    if (quiz) { return 'quiz'; }
    var term = this.s.terminalItems().some(function (it) {
      if (it.slide !== i || it.v.kind !== 'terminal' || it.v.wait === false || it.v.interactive === false) { return false; }
      var tv = it.tv;
      if (tv.state === 'failed' || tv.saved) { return false; }   // no shell to type into / a pack that already holds the viewer's screen
      return !(tv.handle && tv.handle.history().length > (tv.commands || []).length);
    });
    return term ? 'terminal' : '';
  };

  // DOM that has to be real: the shell of a terminal, the text box of a short / open answer. Created on first need, kept (a terminal keeps its
  // session when the viewer pages away and back), shown only for the slide on show, laid over the canvas by the same design-unit rectangles.
  Player.prototype.place = function (host, r) {
    var st = host.style, p = this.picture();
    st.left = (p.left + r.x * p.k) + 'px'; st.top = (p.top + r.y * p.k) + 'px'; st.width = (r.w * p.k) + 'px'; st.height = (r.h * p.k) + 'px';
  };
  Player.prototype.hostFor = function (key, make) {
    this.hosts = this.hosts || {};
    if (!this.hosts[key]) { this.hosts[key] = make(); this.canvas.parentNode.appendChild(this.hosts[key].el); }
    return this.hosts[key];
  };
  Player.prototype.startTerminal = function (tv, host, size) {
    var self = this;
    if (tv.state !== 'idle') { return; }
    if (!window.AiChatTerminal || !window.AiChatTerminal.mountEmbedded) { tv.state = 'failed'; tv.error = '此環境沒有終端機模組'; return; }
    tv.state = 'starting';
    window.AiChatTerminal.mountEmbedded(host.el, { commands: tv.commands, restore: tv.saved || null }).then(function (h) {
      tv.handle = h; tv.state = 'ready'; host.handle = h;
      if (window.ResizeObserver) { new ResizeObserver(function () { self.fitTerminal(host, size); }).observe(host.el); }
      self.fitTerminal(host, size); self.draw();
    }, function (e) { tv.state = 'failed'; tv.error = String(e && e.message || e).slice(0, 100); self.draw(); });
  };
  Player.prototype.fitTerminal = function (host, designSize) {
    if (!host.handle) { return; }
    host.handle.setFontSize(Math.max(9, Math.round(designSize * this.picture().k)));
  };

  // Starts a widget: at the click (start: click / auto) or after a 3-2-1 countdown (start: countdown, the default). Only then is the game's
  // document loaded, so its clock, score and first frame begin at that moment; the frame is focused so the keyboard works at once.
  Player.prototype.startWidget = function (wh) {
    var self = this, mode = wh.node.start || 'countdown';
    if (wh.started || wh.counting) { return; }
    function go() {
      wh.counting = false; wh.started = true; wh.ov.style.display = 'none';
      wh.el.addEventListener('load', function () { try { wh.el.contentWindow.focus(); } catch (e) { /* not focusable */ } }, { once: true });
      wh.el.srcdoc = window.AiChatDeckWidget.buildSrcdoc(wh.node.html);
    }
    if (mode !== 'countdown') { go(); return; }
    wh.counting = true; wh.ovBtn.className = 'ai-chat-deck-widget-start-count';
    (function tick(n) {
      if (!self.alive) { return; }
      if (n === 0) { wh.ovBtn.className = 'ai-chat-deck-widget-start-btn'; wh.ovBtn.textContent = '▶ 點一下開始'; go(); return; }
      wh.ovBtn.textContent = String(n); wh.timer = setTimeout(function () { tick(n - 1); }, 1000);
    })(3);
  };

  Player.prototype.syncHosts = function () {
    var self = this, hosts = this.hosts || {}, show = {}, regs = this.regionsNow(), loc = this.loc(), Code = window.AiChatDeckCode;
    regs.forEach(function (rg, idx) {
      var key = loc.i + ':' + idx;
      if (rg.kind === 'terminal' && rg.pv.terminal) {
        var body = { x: rg.rect.x + 18, y: rg.rect.y + 46 + 10, w: rg.rect.w - 36, h: rg.rect.h - 46 - 22 };
        var host = self.hostFor(key, function () { var d = el('div', 'ai-chat-deck-host ai-chat-deck-host-term'); return { el: d }; });
        self.place(host.el, body); host.el.style.display = rg.node.interactive === false ? 'none' : ''; show[key] = true;
        self.startTerminal(rg.pv.terminal, host, rg.node.size || 24);
      } else if (rg.kind === 'widget' && rg.pv.widget && rg.pv.ok) {
        var wh = self.hostFor(key, function () {
          var f = el('iframe', 'ai-chat-deck-host ai-chat-deck-host-widget');
          // the cage: scripts only -- no same-origin (no cookies, no Redmine session, no parent DOM), no forms / popups / navigation
          f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('referrerpolicy', 'no-referrer'); f.setAttribute('allow', ''); f.setAttribute('title', rg.node.title || 'widget');
          // no srcdoc yet: the game is loaded (and so starts) only when the viewer clicks start -- see startWidget
          return { el: f, widget: rg.pv.widget, node: rg.node, started: false };
        });
        if (!wh.ov) {
          wh.ov = el('div', 'ai-chat-deck-host ai-chat-deck-widget-start');
          wh.ovBtn = el('button', 'ai-chat-deck-widget-start-btn', '▶ 點一下開始'); wh.ovBtn.type = 'button';
          wh.ovBtn.addEventListener('click', function () { self.startWidget(wh); });
          wh.ov.appendChild(wh.ovBtn); self.canvas.parentNode.appendChild(wh.ov);
          if (rg.node.start === 'auto') { self.startWidget(wh); }
        }
        self.place(wh.el, rg.rect); wh.el.style.display = ''; show[key] = true;
        self.place(wh.ov, rg.rect); wh.ov.style.display = wh.started ? 'none' : '';
      } else if (rg.kind === 'quiz' && rg.pv.quiz) {
        var R = rg.pv.quiz.state._r;
        if (!R) { return; }
        var st = rg.pv.quiz.state, locked = !!st.result || st.busy;
        if (R.input && !locked) {
          var hk = key + ':in', multi = rg.node.type === 'open';
          var h2 = self.hostFor(hk, function () {
            var inp = el(multi ? 'textarea' : 'input', 'ai-chat-deck-host ai-chat-deck-host-input'); inp.placeholder = '在這裡輸入答案…';
            inp.addEventListener('input', function () { rg.pv.quiz.state.text = inp.value; });
            rg.pv.hostInput = inp; return { el: inp };
          });
          if (h2.el.value !== st.text) { h2.el.value = st.text; }
          self.place(h2.el, R.input); h2.el.style.fontSize = Math.round(26 * self.picture().k) + 'px'; h2.el.style.display = ''; show[hk] = true; rg.pv.live = true;
        } else { rg.pv.live = false; }
        if (R.term && rg.pv.term) {
          var tk = key + ':term';
          var h3 = self.hostFor(tk, function () { return { el: el('div', 'ai-chat-deck-host ai-chat-deck-host-term') }; });
          self.place(h3.el, { x: R.term.x + 8, y: R.term.y + 46, w: R.term.w - 16, h: R.term.h - 54 }); h3.el.style.display = ''; show[tk] = true;
          self.startTerminal(rg.pv.term, h3, 20);
        }
      }
    });
    Object.keys(hosts).forEach(function (k) { if (!show[k]) { hosts[k].el.style.display = 'none'; if (hosts[k].ov) { hosts[k].ov.style.display = 'none'; } } });
    // the left / right paging zones leave the slide's own controls alone
    var busy = regs.length > 0;
    this.prevZone.classList.toggle('narrow', busy); this.nextZone.classList.toggle('narrow', busy);
  };

  // ---- playhead helpers
  Player.prototype.loc = function () { return Core.locate(this.s.tl, this.T); };
  Player.prototype.curIndex = function () { return this.loc().i; };

  Player.prototype.goTo = function (i) {
    var self = this;
    i = Math.max(0, Math.min(this.s.deck.slides.length - 1, i));
    this.s.setCursor(i);
    this.stopAudio();
    this.ended = false;
    if (!this.s.isReady(i)) {
      this.buffering = i; this.showOverlay('準備第 ' + (i + 1) + ' 頁…'); this.updateStatus();
      this.s.whenReady(i).then(function () { if (self.buffering === i) { self.buffering = -1; self.hideOverlay(); self.T = self.s.tl.segs[i].bodyStart; self.draw(); } });
      return;
    }
    this.T = this.s.tl.segs[i].bodyStart; this.draw(); this.updateUi();
  };
  Player.prototype.next = function () {
    var i = this.curIndex(), n = this.s.deck.slides.length;
    if (i + 1 >= n) { return; }
    if (this.s.isReady(i + 1)) { this.stopAudio(); this.T = this.s.tl.segs[i + 1].transStart; this.s.setCursor(i + 1); this.started = true; this.ended = false; this.draw(); } else { this.goTo(i + 1); }
  };
  Player.prototype.prev = function () {
    var loc = this.loc();
    // a second press within the first 2 seconds of a slide goes to the previous slide; otherwise restarts this one
    if (loc.phase === 'body' && loc.t > 2 || loc.i === 0) { this.goTo(loc.i); } else { this.goTo(loc.i - 1); }
  };
  Player.prototype.seekFraction = function (f) {
    var T = Math.max(0, Math.min(1, f)) * this.s.tl.total, loc = Core.locate(this.s.tl, T);
    this.goTo(loc.i);
    var self = this;
    this.s.whenReady(loc.i).then(function () { var seg = self.s.tl.segs[loc.i]; self.T = Math.min(seg.end - 0.01, Math.max(seg.bodyStart, T)); self.draw(); });
  };

  Player.prototype.play = function () {
    var ctx = getAudioCtx();
    if (ctx && ctx.state === 'suspended') { ctx.resume(); }
    if (this.ended) { this.T = 0; this.ended = false; }
    this.started = true; this.playing = true; this.audioFor = -1; this.hideOverlay(); this.updateUi();
  };
  Player.prototype.pause = function () { this.playing = false; this.stopAudio(); this.updateUi(); };
  Player.prototype.toggle = function () { if (this.playing) { this.pause(); } else { this.play(); } };
  Player.prototype.setSpeed = function (v) { this.speed = v; if (this.src) { try { this.src.playbackRate.value = v; } catch (e) { /* ended */ } } };
  Player.prototype.setMuted = function (m) {
    this.muted = m; this.muteBtn.textContent = m ? '🔇' : '🔊';
    if (this.gain) { this.gain.gain.value = m ? 0 : 1; }
  };

  Player.prototype.stopAudio = function () {
    if (this.src) { try { this.src.onended = null; this.src.stop(); } catch (e) { /* not started */ } this.src = null; }
    this.audioFor = -1;
  };
  // Starts slide i's narration so it lines up with the playhead (a slide starts its narration LEAD seconds in). The decoded audio comes
  // from the session's small LRU; if it is not there yet the start waits for the decode (a few ms) and re-reads the playhead.
  Player.prototype.syncAudio = function (loc) {
    if (!this.playing || loc.phase !== 'body') { if (loc.phase !== 'body') { this.stopAudio(); } return; }
    if (this.audioFor === loc.i) { return; }
    this.stopAudio();
    var self = this, idx = loc.i;
    this.audioFor = idx;
    var pr = this.s.preps[idx], ctx = getAudioCtx();
    if (!pr.audio || !ctx) { return; }
    this.s.audioBuffer(idx).then(function (buffer) {
      if (!buffer || self.audioFor !== idx || !self.playing) { return; }
      var now = self.loc();
      if (now.i !== idx || now.phase !== 'body') { return; }
      var narrStart = pr.timing.narrStart, dur = buffer.duration, offset = Math.max(0, now.t - narrStart);
      if (offset >= dur) { return; }
      var src = ctx.createBufferSource();
      src.buffer = buffer; src.playbackRate.value = self.speed;
      if (!self.gain) { self.gain = ctx.createGain(); self.gain.connect(ctx.destination); }
      self.gain.gain.value = self.muted ? 0 : 1;
      src.connect(self.gain);
      src.start(ctx.currentTime + Math.max(0, (narrStart - now.t) / self.speed), offset);
      self.src = src;
    }, function () { /* decode failed: this slide is silent */ });
  };

  Player.prototype.tick = function (now) {
    var dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    if (this.playing && this.buffering < 0) {
      var tl = this.s.tl, cur = Core.locate(tl, this.T), nextT = this.T + dt * this.speed;
      var n = Core.locate(tl, nextT);
      if (nextT >= tl.total && this.holdsForQuiz(cur.i)) {
        // the last slide is an answer card: the deck does not end before it is answered
        this.T = tl.total - 0.002; this.setHold(cur.i); this.holding = true;
      }
      else if (nextT >= tl.total) { this.T = tl.total - 0.001; this.playing = false; this.ended = true; this.holding = false; this.stopAudio(); this.updateUi(); }
      else if (n.i !== cur.i && !this.s.isReady(n.i)) {
        // the next slide is not prepared yet: hold at the end of this one until it is
        var self = this, want = n.i;
        this.T = tl.segs[cur.i].end - 0.002; this.buffering = want; this.showOverlay('準備第 ' + (want + 1) + ' 頁…');
        this.s.setCursor(want);
        this.s.whenReady(want).then(function () { if (self.buffering === want) { self.buffering = -1; self.hideOverlay(); self.T = self.s.tl.segs[want].transStart; self.audioFor = -1; } });
      } else if (n.i !== cur.i && this.holdsForQuiz(cur.i)) {
        // an answer card with wait: true: the deck waits at the end of the slide until it is answered (or the viewer pages on)
        this.T = tl.segs[cur.i].end - 0.002; this.setHold(cur.i); this.holding = true;
      } else { this.T = nextT; this.holding = false; }
    }
    var loc = this.loc();
    if (loc.i !== this.s.cursor && loc.phase === 'body') { this.s.setCursor(loc.i); }
    this.syncAudio(loc);
    if (this.holding && !(this.playing && this.holdsForQuiz(loc.i))) { this.holding = false; }
    this.holdEl.style.display = this.holding ? '' : 'none';
    this.draw();
    this.updateUi();
  };

  Player.prototype.draw = function () {
    var c = this.canvas, ctx = c.getContext('2d');
    var info = this.s.info({ width: c.width, height: c.height, subtitles: this.subtitles });
    try { Core.renderFrame(ctx, this.s.deck, this.s.tl, this.T, info); } catch (e) { console.warn('[deck] render: ' + (e && e.message || e)); }
    try { this.syncHosts(); } catch (e) { console.warn('[deck] overlays: ' + (e && e.message || e)); }
  };

  Player.prototype.updateUi = function () {
    var tl = this.s.tl, loc = this.loc();
    this.progressFill.style.width = (this.T / Math.max(tl.total, 0.001) * 100) + '%';
    this.timeEl.textContent = fmt(this.T) + ' / ' + fmt(tl.total) + ' · ' + (loc.i + 1) + '/' + this.s.deck.slides.length;
    this.playBtn.textContent = this.playing ? '⏸' : '▶';
    if (this.chapterSel.value !== String(loc.i)) { this.chapterSel.value = String(loc.i); }
    var dots = this.dots.children;
    for (var i = 0; i < dots.length; i++) { dots[i].classList.toggle('current', i === loc.i); }
    this.prevZone.classList.toggle('disabled', loc.i === 0);
    this.nextZone.classList.toggle('disabled', loc.i >= this.s.deck.slides.length - 1);
    this.box.classList.toggle('ended', this.ended);
    this.canvas.classList.toggle('interactive', this.interactive3D());
    this.updateScore();
  };

  Player.prototype.updateScore = function () {
    var Quiz = window.AiChatDeckQuiz, items = this.s.quizItems();
    if (!Quiz || !items.length) { return; }
    var t = Quiz.total(items.map(function (it) { return { points: Quiz.points(it.v), result: it.result }; }));
    this.scoreEl.style.display = ''; this.scoreEl.textContent = '🏅 ' + t.got + ' / ' + t.max + '(' + t.answered + '/' + t.count + ' 題)';
  };

  Player.prototype.showOverlay = function (text) { this.overlay.style.display = 'flex'; this.overlayText.textContent = text; this.bigPlay.style.display = 'none'; };
  Player.prototype.hideOverlay = function () { this.overlay.style.display = 'none'; };

  Player.prototype.updateStatus = function () {
    var s = this.s, n = s.preps.length, ready = s.readyCount(), need = Math.min(PREHEAT, n);
    var dots = this.dots.children, errs = [];
    s.preps.forEach(function (p, i) {
      if (dots[i]) { dots[i].classList.toggle('ready', p.state === 'ready'); dots[i].classList.toggle('loading', p.state === 'loading'); dots[i].classList.toggle('warn', !!(p.error || visualFailed(p.visual))); }
      if (p.error) { errs.push(p.error); }
    });
    var silent = !ttsProvider ? '(此環境沒有語音引擎,以字幕呈現)' : '';
    var text = '已準備 ' + ready + '/' + n + ' 頁' + (silent ? ' ' + silent : '');
    if (s.deck.slides.some(function (sl) { return sl.stage === '3d'; })) { text += s.stage3d ? ' · 3D 視窗(拖曳旋轉、滾輪縮放、雙擊回到這頁的鏡頭)' : (s.stageNote ? ' · ' + s.stageNote : ' · 3D 舞台載入中…'); }
    if (errs.length) { text += ' · 🔇 ' + errs.length + ' 頁旁白失敗:' + errs[0].slice(0, 80); }
    var failedVis = s.preps.filter(function (p) { return visualFailed(p.visual); }).length;
    if (failedVis) {
      var firstBad = s.preps.filter(function (p) { return visualFailed(p.visual); })[0].visual;
      var why = firstBad.error || (firstBad.errors && firstBad.errors[0]) || '';
      text += ' · ⚠ ' + failedVis + ' 頁視覺無法載入' + (why ? ':' + String(why).slice(0, 300) : '');
    }
    this.status.textContent = text;
    if (!this.started && this.buffering < 0) {
      var first = 0, k;
      for (k = 0; k < need; k++) { if (s.isReady(k)) { first++; } }
      if (first >= need) { this.overlay.style.display = 'flex'; this.overlayText.textContent = '預熱完成(' + need + ' 頁已就緒)'; this.bigPlay.style.display = ''; }
      else { this.showOverlay('預熱中 ' + first + '/' + need + '…'); }
    }
    this.draw();
  };

  // ---- window modes
  Player.prototype.toggleFloat = function () {
    var self = this, b = this.box;
    if (document.fullscreenElement) { document.exitFullscreen(); }
    if (!this.floating) {
      this.placeholder = el('div', 'ai-chat-deck-placeholder', '播放視窗已浮出 — 再按 ⧉ 放回'); this.placeholder.style.height = Math.max(60, b.offsetHeight / 3) + 'px';
      b.parentNode.insertBefore(this.placeholder, b);
      document.body.appendChild(b); b.classList.add('floating'); this.floating = true;
      b.style.right = '24px'; b.style.bottom = '24px';
      this.bar.onpointerdown = function (e) {
        if (e.target !== self.bar && e.target !== self.titleEl) { return; }
        var r = b.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
        b.style.right = 'auto'; b.style.bottom = 'auto'; b.style.left = r.left + 'px'; b.style.top = r.top + 'px';
        function move(ev) { b.style.left = Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - dx)) + 'px'; b.style.top = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - dy)) + 'px'; }
        function up() { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); }
        document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
      };
    } else {
      b.classList.remove('floating'); this.floating = false; b.style.left = b.style.top = b.style.right = b.style.bottom = '';
      this.placeholder.parentNode.insertBefore(b, this.placeholder); this.placeholder.remove(); this.bar.onpointerdown = null;
    }
    this.resize(); this.draw(); b.focus();
  };
  Player.prototype.toggleFullscreen = function () {
    if (document.fullscreenElement) { document.exitFullscreen(); } else if (this.box.requestFullscreen) { this.box.requestFullscreen(); }
  };

  Player.prototype.exportMenu = function (anchor) {
    var self = this;
    var old = this.box.querySelector('.ai-chat-deck-menu'); if (old) { old.remove(); return; }
    var menu = el('div', 'ai-chat-deck-menu');
    [['mp4', '🎬 MP4 影片(含旁白與字幕)'], ['pptx', '📊 PPTX 投影片(靜態,旁白放備忘稿)'], ['yaml', '📄 原始動畫描述檔 (.deck.yaml)'], ['srt', '💬 字幕 (.srt)'], ['vtt', '💬 字幕 (.vtt)'], ['pack', '📦 簡報封包 (.deckpack:含圖片、旁白、作答,可再開啟播放)'], ['zip', '🗜 完整封包 (yaml + 旁白音檔 + 字幕)']].forEach(function (pair) {
      var item = el('button', 'ai-chat-deck-menu-item', pair[1]); item.type = 'button';
      item.addEventListener('click', function () { menu.remove(); self.runExport(pair[0]); });
      menu.appendChild(item);
    });
    this.bar.appendChild(menu);
    setTimeout(function () { document.addEventListener('click', function close() { menu.remove(); document.removeEventListener('click', close); }); }, 0);
  };
  Player.prototype.runExport = function (fmtName) {
    var self = this;
    if (!window.AiChatDeckExport) { window.AiChatDialog && window.AiChatDialog.notify('export script is not loaded'); return; }
    this.pause();
    var setStatus = function (t) { self.status.textContent = t; };
    // the export shows its own progress card (steps, bars, what is happening, time left, Cancel) over the player
    window.AiChatDeckExport.run(fmtName, this.s, this.box, setStatus).then(function (msg) { setStatus(msg || '匯出完成'); setTimeout(function () { self.updateStatus(); }, 4000); }, function (err) {
      setStatus('匯出失敗:' + (err && err.message || err));
    });
  };

  Player.prototype.destroy = function () { this.alive = false; this.stopAudio(); Object.keys(this.hosts || {}).forEach(function (k) { var h = this.hosts[k]; clearTimeout(h.timer); if (h.el.parentNode) { h.el.parentNode.removeChild(h.el); } if (h.ov && h.ov.parentNode) { h.ov.parentNode.removeChild(h.ov); } }, this); this.s.destroy(); };

  // ------------------------------------------------------------------ mounting into the chat
  function mount(container) {
    var url = container.getAttribute('data-deck-url');
    var status = el('div', 'ai-chat-deck-loading', '載入簡報中…');
    container.appendChild(status);
    var ready = window.AiChat2D ? window.AiChat2D.ensureJsYamlLoaded() : Promise.reject(new Error('js-yaml loader is not available'));
    ready.then(function () { return fetchText(url); }).then(function (raw) {
      var deck;
      try { deck = Core.parseDeck(raw, window.jsyaml); } catch (e) {
        container.innerHTML = '';
        var box = el('div', 'ai-chat-deck-error', '簡報描述檔有問題:'); var pre = el('pre', null, String(e.message || e)); box.appendChild(pre); container.appendChild(box); return;
      }
      var session = new Session(deck, raw, url);
      container._deckPlayer = new Player(session, container);
    }).catch(function (e) { status.textContent = '簡報載入失敗:' + (e && e.message || e) + '  [' + url + ']'; status.className = 'ai-chat-deck-loading ai-chat-deck-error'; });
  }

  function mountAll(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) { return; }
    Array.prototype.forEach.call(rootEl.querySelectorAll('img[src]'), function (img) {
      var src = img.getAttribute('src');
      if (!isDeckUrl(src)) { return; }
      var box = el('div', 'ai-chat-deck'); box.setAttribute('data-deck-url', src);
      img.parentNode.replaceChild(box, img);
      mount(box);
    });
  }

  window.AiChatDeck = {
    isDeckUrl: isDeckUrl, mountAll: mountAll, mount: mount,
    // fn(text, voiceId|null, speed, lang) -> Promise<ArrayBuffer (mp3)>; installed by ai_chat.js
    setTtsProvider: function (fn, opts) { ttsProvider = fn; ttsConcurrent = !!(opts && opts.concurrent); },
    hasTts: function () { return !!ttsProvider; },
    // fn(system, user) -> Promise<{score: 0..1, feedback}>; replaces the default AI grader of answer cards
    setGradeProvider: function (fn) { gradeProvider = fn; },
    // opens a .deckpack (a File / Blob) in `container` and plays it
    openPack: function (file, container) { return window.AiChatDeckPack ? window.AiChatDeckPack.open(file, container) : Promise.reject(new Error('the pack script is not loaded')); },
    Session: Session, Player: Player, getAudioCtx: getAudioCtx,
    _internal: { fetchBlob: fetchBlob, localizeUrl: localizeUrl, applyShapeFx: applyShapeFx, svgToImage: svgToImage, loadImage: loadImage, prepVisual: prepVisual, synthesize: synthesize, PREHEAT: PREHEAT, LOOKAHEAD: LOOKAHEAD }
  };
})(window);
