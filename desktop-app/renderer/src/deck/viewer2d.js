// Interactive 2D animation viewer for render_2d_animation tool results. An
// "animation" is a declarative YAML document (see animation_2d_tools.rb)
// describing a fixed set of vector shapes/animations -- there is
// deliberately NO way to embed arbitrary JavaScript here, the exact same
// boundary ai_chat_3d_viewer.js already draws for 3D scenes (see that
// file's own header comment for the full rationale).
//
// Unlike the 3D viewer, this needs no three.js/OrbitControls -- Canvas2D
// drawing is native to every browser. js-yaml is still needed to parse the
// yaml itself, and IS shared with the 3D viewer (same vendored file, same
// window.AiChatExportAssetUrls.jsYaml lazy-load config) -- whichever viewer
// mounts first pays the one-time script-load cost, the second reuses it.
(function (window) {
  'use strict';

  var ANIM_URL_RE = /\.2danim\.yaml(\?.*)?$/i;
  var jsYamlPromise = null;
  var mounted = [];

  // A client-only "/media-to-animation" result has no real extension to
  // sniff on its own (its bytes are a "client-file/ID" reference, per
  // AiChatFileSink's own convention -- see that file's comment on why the
  // prefix is colon-less) -- so the server-built reply markdown
  // (ai_chat_tts_settings_controller.rb#record, embed_as: 'animation')
  // deliberately APPENDS the literal ".2danim.yaml" suffix onto the
  // otherwise-opaque id, purely so ANIM_URL_RE's plain extension match
  // (which already works identically for a real Attachment url) also
  // recognizes this client-only one. A PLAIN client-file image (e.g.
  // "/media-to-animated-gif"'s own output, embed_as: 'image', no suffix)
  // must NOT match here -- it needs ai_chat.js's own generic
  // resolveClientFileImages instead, not this animation-specific viewer.
  function isSceneUrl(url) {
    return typeof url === 'string' && ANIM_URL_RE.test(url);
  }

  function isClientFileUrl(url) {
    return typeof url === 'string' && window.AiChatFileSink && url.indexOf(window.AiChatFileSink.CLIENT_FILE_PREFIX) === 0;
  }

  // Strips the ".2danim.yaml" suffix isSceneUrl matched on back off before
  // handing the remaining id to AiChatFileSink.resolve() -- that suffix is
  // never part of the real persistentStorage id (see the comment above).
  // A no-op for a real http(s) url or a client-file id that never had the
  // suffix in the first place (e.g. one of preloadImages' own per-frame
  // image srcs, which never carry it).
  function stripAnimSuffix(url) {
    return url.replace(ANIM_URL_RE, '');
  }

  // Shared by mount()/snapshotToDataUri -- a real http(s) url is fetched
  // over the network as before; a client-file url is resolved through
  // AiChatFileSink instead (the bytes never left this browser in the first
  // place, so there is nothing to fetch).
  function fetchYamlText(url) {
    if (isClientFileUrl(url)) {
      return window.AiChatFileSink.resolve(stripAnimSuffix(url)).then(function (resolved) { return resolved.blob.text(); });
    }
    return fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) { throw new Error('HTTP ' + res.status); }
      return res.text();
    });
  }

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      if (!src) { reject(new Error('missing script url')); return; }
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(script);
    });
  }

  function ensureJsYamlLoaded() {
    if (jsYamlPromise) { return jsYamlPromise; }
    var urls = window.AiChatExportAssetUrls || {};
    if (!urls.jsYaml) {
      return Promise.reject(new Error('2D animation viewer assets are not configured (window.AiChatExportAssetUrls missing jsYaml).'));
    }
    jsYamlPromise = loadScriptOnce(urls.jsYaml);
    return jsYamlPromise;
  }

  function parseAnimation(yamlText) {
    var data = window.jsyaml.load(yamlText);
    if (!data || typeof data !== 'object') { throw new Error('animation file did not decode to an object'); }
    if (data.kind !== 'ai_chat_animation_2d') { throw new Error('missing/unexpected "kind" (expected "ai_chat_animation_2d")'); }
    if (!Array.isArray(data.shapes) || !data.shapes.length) { throw new Error('animation has no "shapes"'); }
    normalizeAnimation(data);
    return data;
  }

  // Models routinely write coordinates the way SVG/CSS/other canvas formats
  // do instead of this format's "position": [x, y] -- bare "x"/"y" or
  // "cx"/"cy" on a shape or on a keyframe. Left alone, such a shape sat at
  // the top-left corner (half clipped) and never moved, i.e. the animation
  // looked empty. Translate those spellings into real positions up front.
  // A circle/rect/text/image with no placement at all is centered on the
  // canvas instead of pinned to the corner (polygon/line "points" are
  // usually absolute coordinates, so they keep the [0,0] origin).
  function normalizeAnimation(data) {
    var W = data.width || 480, H = data.height || 320;
    function axisX(o) { return o.cx != null ? o.cx : o.x; }
    function axisY(o) { return o.cy != null ? o.cy : o.y; }
    data.shapes.forEach(function (shape) {
      if (!shape || typeof shape !== 'object') { return; }
      var centered = ['circle', 'rect', 'text', 'image'].indexOf(shape.type) !== -1;
      if (!shape.position) {
        var bx = axisX(shape), by = axisY(shape);
        if (bx != null || by != null) { shape.position = [bx != null ? bx : (centered ? W / 2 : 0), by != null ? by : (centered ? H / 2 : 0)]; }
        else if (centered) { shape.position = [W / 2, H / 2]; }
      }
      var anim = shape.animation;
      if (!anim || anim.type !== 'keyframes' || !Array.isArray(anim.keyframes)) { return; }
      var cur = (shape.position || [0, 0]).slice();
      anim.keyframes.forEach(function (kf) {
        if (!kf || typeof kf !== 'object') { return; }
        if (Array.isArray(kf.position)) { cur = kf.position.slice(); return; }
        var kx = axisX(kf), ky = axisY(kf);
        if (kx == null && ky == null) { return; }
        if (kx != null) { cur[0] = kx; }
        if (ky != null) { cur[1] = ky; }
        kf.position = cur.slice();
      });
    });
  }

  // Keyframe easing ("curve"/"easing"/"ease" on the keyframe a segment
  // starts from): the usual CSS-style names.
  function applyEasing(name, f) {
    switch (String(name || 'linear').toLowerCase().replace(/[_\s]/g, '-')) {
      case 'ease-in': case 'in': case 'quad-in': return f * f;
      case 'ease-out': case 'out': case 'quad-out': return 1 - (1 - f) * (1 - f);
      case 'ease-in-out': case 'in-out': case 'ease': case 'smooth': return f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
      case 'cubic-in': return f * f * f;
      case 'cubic-out': return 1 - Math.pow(1 - f, 3);
      default: return f;
    }
  }

  // -------------------------------------------------------- shape drawing
  //
  // Every shape type is drawn in its OWN local coordinate space, with the
  // canvas already translated/rotated/scaled to that shape's current
  // resolved position/rotation/scale (see resolveShapeStates below) --
  // circle/rect/text/image are centered at the local origin, polygon/line
  // "points" are local offsets from it. This is what lets "move"/"orbit"/
  // "keyframes" animate any shape type identically: they only ever change
  // where the local origin is, never how the shape itself is drawn.
  var SHAPE_DRAWERS = {
    circle: function (ctx, shape) {
      ctx.beginPath();
      // "radius_y" is optional (added for render_block_diagram's "ellipse"
      // shape template -- a plain circle has no way to express a wide/flat
      // cloud or start/end terminator) -- when given, draws a real ellipse
      // instead of a circle; every existing circle (no radius_y) behaves
      // byte-for-byte the same as before.
      if (shape.radius_y != null) {
        ctx.ellipse(0, 0, shape.radius, shape.radius_y, 0, 0, Math.PI * 2);
      } else {
        ctx.arc(0, 0, shape.radius, 0, Math.PI * 2);
      }
      fillAndStroke(ctx, shape);
    },
    rect: function (ctx, shape) {
      ctx.beginPath();
      ctx.rect(-shape.width / 2, -shape.height / 2, shape.width, shape.height);
      fillAndStroke(ctx, shape);
    },
    polygon: function (ctx, shape) {
      ctx.beginPath();
      shape.points.forEach(function (p, i) { if (i === 0) { ctx.moveTo(p[0], p[1]); } else { ctx.lineTo(p[0], p[1]); } });
      ctx.closePath();
      fillAndStroke(ctx, shape);
    },
    line: function (ctx, shape) {
      ctx.beginPath();
      shape.points.forEach(function (p, i) { if (i === 0) { ctx.moveTo(p[0], p[1]); } else { ctx.lineTo(p[0], p[1]); } });
      if (shape.closed) { ctx.closePath(); }
      ctx.strokeStyle = shape.stroke || '#000000';
      ctx.lineWidth = shape.stroke_width || 1;
      ctx.stroke();
    },
    text: function (ctx, shape) {
      ctx.font = (shape.font_size || 16) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = resolvePaint(ctx, shape.fill, { x0: 0, y0: 0, x1: 1, y1: 1 }) || '#000000';
      ctx.fillText(shape.content, 0, 0);
    },
    image: function (ctx, shape, images) {
      var img = images[shape._imageKey];
      if (img && img.complete && img.naturalWidth) {
        ctx.drawImage(img, -shape.width / 2, -shape.height / 2, shape.width, shape.height);
      }
    }
  };

  // Local-space bounding box of a shape (drawn around its own origin) --
  // what a gradient's fractional coordinates are relative to.
  function shapeBox(shape) {
    if (shape.type === 'circle') {
      var rx = shape.radius || 0, ry = shape.radius_y != null ? shape.radius_y : rx;
      return { x0: -rx, y0: -ry, x1: rx, y1: ry };
    }
    if (shape.type === 'rect') { return { x0: -shape.width / 2, y0: -shape.height / 2, x1: shape.width / 2, y1: shape.height / 2 }; }
    var xs = (shape.points || []).map(function (p) { return p[0]; }), ys = (shape.points || []).map(function (p) { return p[1]; });
    return { x0: Math.min.apply(null, xs.concat([0])), y0: Math.min.apply(null, ys.concat([0])), x1: Math.max.apply(null, xs.concat([0])), y1: Math.max.apply(null, ys.concat([0])) };
  }

  // A "fill" may be a plain color string or a gradient object:
  //   {type: linearGradient|radialGradient, stops:[{offset,color}...],
  //    radial: cx,cy,r (0..1, of the shape's box; default .5/.5/.5),
  //    linear: x1,y1,x2,y2 (0..1; default top to bottom)}
  // Anything unusable falls back to its first stop color, never to "no
  // fill" (an ignored/invalid fillStyle silently keeps the PREVIOUS shape's
  // color, which is how a gradient ball once came out background-colored
  // and invisible).
  function resolvePaint(ctx, paint, box) {
    if (typeof paint === 'string') { return paint; }
    if (!paint || typeof paint !== 'object') { return null; }
    var stops = Array.isArray(paint.stops) ? paint.stops.filter(function (st) { return st && st.color; }) : [];
    if (!stops.length) { return null; }
    var w = box.x1 - box.x0, h = box.y1 - box.y0;
    var kind = String(paint.type || '').toLowerCase();
    var g;
    try {
      if (kind.indexOf('radial') !== -1) {
        var cx = box.x0 + (paint.cx != null ? paint.cx : 0.5) * w, cy = box.y0 + (paint.cy != null ? paint.cy : 0.5) * h;
        var r = (paint.r != null ? paint.r : 0.5) * Math.max(w, h);
        g = ctx.createRadialGradient(paint.fx != null ? box.x0 + paint.fx * w : cx, paint.fy != null ? box.y0 + paint.fy * h : cy, 0, cx, cy, Math.max(r, 0.001));
      } else if (kind.indexOf('linear') !== -1) {
        g = ctx.createLinearGradient(
          box.x0 + (paint.x1 != null ? paint.x1 : 0) * w, box.y0 + (paint.y1 != null ? paint.y1 : 0) * h,
          box.x0 + (paint.x2 != null ? paint.x2 : 0) * w, box.y0 + (paint.y2 != null ? paint.y2 : 1) * h
        );
      } else { return stops[0].color; }
      stops.forEach(function (st) { g.addColorStop(Math.max(0, Math.min(1, Number(st.offset) || 0)), st.color); });
      return g;
    } catch (e) { return stops[0].color; }
  }

  function fillAndStroke(ctx, shape) {
    var paint = resolvePaint(ctx, shape.fill, shapeBox(shape));
    if (paint) { ctx.fillStyle = paint; ctx.fill(); }
    if (shape.stroke && shape.stroke_width) {
      ctx.strokeStyle = shape.stroke;
      ctx.lineWidth = shape.stroke_width;
      ctx.stroke();
    }
  }

  // Lazily loads every "src"/"fill_image" referenced by any shape, keyed
  // by the shape's own array index (stable across the whole animation's
  // lifetime, unlike relying on the url string itself as a key) -- a
  // missing/broken image just never draws (same "must not break the whole
  // scene" leniency ai_chat_3d_viewer.js already applies to a missing
  // shared texture), not a fatal error for the rest of the animation.
  function preloadImages(data) {
    var images = {};
    data.shapes.forEach(function (shape, i) {
      var src = shape.type === 'image' ? shape.src : shape.fill_image;
      if (!src) { return; }
      shape._imageKey = 'img' + i;
      var img = new Image();
      images[shape._imageKey] = img;
      // A "/media-to-animation" frame's own src is a client-file reference
      // (its bytes are never uploaded anywhere) -- resolved async via
      // AiChatFileSink into a blob url before assignment; every other
      // (real http(s)/data:) src is assigned directly as before. Either
      // way img.src ends up set once ready -- the continuously-looping
      // rAF draw loop just picks it up on its next tick, same leniency a
      // slow-loading http image already gets.
      if (isClientFileUrl(src)) {
        window.AiChatFileSink.resolve(stripAnimSuffix(src)).then(function (resolved) {
          img.src = URL.createObjectURL(resolved.blob);
        }, function () { /* leave unset -- same "just never draws" leniency as a broken http url */ });
      } else {
        img.src = src;
      }
    });
    return images;
  }

  // ---------------------------------------------------------- animators
  //
  // Each returns the shape's CURRENT { position, rotation, scale, opacity }
  // for time t (seconds since this animation's own loop started) -- a pure
  // function of t, never mutating anything, so a shape's state can always
  // be recomputed exactly the same way for any frame (including the single
  // frame snapshotToDataUri needs). "position"/"rotation"/"scale"/"opacity"
  // given here OVERRIDE the shape's own static base values entirely while
  // the animation is active, matching how ai_chat_3d_viewer.js's own
  // "orbit"/"bounce" animations override a mesh's base position instead of
  // adding to it.
  function lerp(a, b, f) { return a + (b - a) * f; }
  function lerpPoint(a, b, f) { return [lerp(a[0], b[0], f), lerp(a[1], b[1], f)]; }

  function loopFraction(t, duration, loop) {
    if (duration <= 0) { return { f: 1, reverse: false }; }
    if (!loop) { return { f: Math.min(1, t / duration), reverse: false }; }
    if (loop === 'pingpong') {
      var cycle = (t / duration) % 2;
      return cycle <= 1 ? { f: cycle, reverse: false } : { f: 2 - cycle, reverse: true };
    }
    return { f: (t / duration) % 1, reverse: false }; // loop: true -- jump back to start each cycle
  }

  var ANIMATORS = {
    move: function (shape, anim, t) {
      var lf = loopFraction(t, anim.duration, anim.loop);
      return { position: lerpPoint(anim.from, anim.to, lf.f) };
    },
    rotate: function (shape, anim, t) {
      return { rotation: (shape.rotation || 0) + anim.speed * t };
    },
    scale: function (shape, anim, t) {
      var wave = 0.5 + 0.5 * Math.sin(2 * Math.PI * anim.speed * t);
      return { scale: lerp(anim.min, anim.max, wave) };
    },
    fade: function (shape, anim, t) {
      var lf = loopFraction(t, anim.duration, anim.loop);
      return { opacity: lerp(anim.from, anim.to, lf.f) };
    },
    // Resolved in a second pass (see resolveShapeStates) once every
    // non-orbiting shape's position for this frame is already known --
    // "center" needs no such dependency and could resolve here directly,
    // but both forms are handled together in that second pass for one
    // consistent code path.
    orbit: function (shape, anim, t, centerPoint) {
      var angle = (anim.speed * t) * Math.PI / 180;
      return { position: [centerPoint[0] + Math.cos(angle) * anim.radius, centerPoint[1] + Math.sin(angle) * anim.radius] };
    },
    keyframes: function (shape, anim, t, _centerPoint, duration) {
      var kfs = anim.keyframes;
      duration = anim.duration > 0 ? anim.duration : duration;
      var localT = duration > 0 ? t % duration : 0;
      var prev = kfs[0], next = kfs[kfs.length - 1];
      for (var i = 0; i < kfs.length; i++) {
        if (kfs[i].t <= localT) { prev = kfs[i]; }
        if (kfs[i].t >= localT) { next = kfs[i]; break; }
      }
      var span = next.t - prev.t;
      var f = span > 0 ? (localT - prev.t) / span : 0;
      f = applyEasing(prev.curve || prev.easing || prev.ease, f);
      var out = {};
      if (prev.position && next.position) { out.position = lerpPoint(prev.position, next.position, f); }
      else if (prev.position) { out.position = prev.position; }
      if (prev.rotation != null && next.rotation != null) { out.rotation = lerp(prev.rotation, next.rotation, f); }
      else if (prev.rotation != null) { out.rotation = prev.rotation; }
      if (prev.scale != null && next.scale != null) { out.scale = lerp(prev.scale, next.scale, f); }
      else if (prev.scale != null) { out.scale = prev.scale; }
      if (prev.opacity != null && next.opacity != null) { out.opacity = lerp(prev.opacity, next.opacity, f); }
      else if (prev.opacity != null) { out.opacity = prev.opacity; }
      return out;
    }
  };

  // Resolves every shape's { position, rotation, scale, opacity } for time
  // t, in two passes so "orbit" with a "parent" (rather than a fixed
  // "center") can read that parent's ALREADY-resolved position for this
  // same frame, regardless of which array position either shape is
  // declared at (scene_tools.rb's own validation already allows either
  // order -- see animation_2d_tools.rb's validate_orbit_animation!).
  function resolveShapeStates(data, t) {
    var byId = {};
    var pass1 = data.shapes.map(function (shape) {
      var state = {
        position: shape.position || [0, 0], rotation: shape.rotation || 0,
        scale: shape.scale != null ? shape.scale : 1, opacity: shape.opacity != null ? shape.opacity : 1
      };
      var anim = shape.animation;
      if (anim && anim.type !== 'orbit' && ANIMATORS[anim.type]) {
        Object.assign(state, ANIMATORS[anim.type](shape, anim, t));
      }
      if (shape.id) { byId[shape.id] = state; }
      return state;
    });

    data.shapes.forEach(function (shape, i) {
      var anim = shape.animation;
      if (!anim || anim.type !== 'orbit') { return; }
      var center = anim.center || (anim.parent && byId[anim.parent] && byId[anim.parent].position) || [0, 0];
      Object.assign(pass1[i], ANIMATORS.orbit(shape, anim, t, center));
    });

    data.shapes.forEach(function (shape, i) {
      var anim = shape.animation;
      if (anim && anim.type === 'keyframes') {
        Object.assign(pass1[i], ANIMATORS.keyframes(shape, anim, t, null, data.duration || 0));
      }
    });

    return pass1;
  }

  // `view` (optional, on-screen viewer only): {k, tx, ty} -- device px per
  // scene unit plus a device-px offset. The canvas is then exactly as large
  // as the visible window and the scene is drawn straight into it at the
  // current zoom, so lines and text are re-rendered sharp at every zoom
  // level instead of a fixed-resolution bitmap being stretched with CSS.
  // Without it the scene fills the canvas 1:1 (export/snapshot callers).
  function drawFrame(ctx, data, images, t, width, height, view) {
    if (view) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.fillStyle = data.background || '#ffffff';
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.setTransform(view.k, 0, 0, view.k, view.tx, view.ty);
    } else {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = data.background || '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }

    var states = resolveShapeStates(data, t);
    data.shapes.forEach(function (shape, i) {
      var draw = SHAPE_DRAWERS[shape.type];
      if (!draw) { return; } // unknown shape type -- skip rather than crash the whole animation over one bad shape

      var s = states[i];
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, s.opacity));
      ctx.translate(s.position[0], s.position[1]);
      ctx.rotate((s.rotation || 0) * Math.PI / 180);
      ctx.scale(s.scale, s.scale);
      try {
        draw(ctx, shape, images);
      } catch (e) {
        console.warn('[ai_chat_2d_viewer] shape "' + (shape.id || shape.type) + '": ' + (e && e.message || e));
      }
      ctx.restore();
    });
  }

  // ------------------------------------------------------ on-screen viewer

  function buildViewerContainer(url, alt) {
    var container = document.createElement('div');
    container.className = 'ai-chat-2d-viewer';
    container.setAttribute('data-scene-url', url);
    container.setAttribute('data-scene-alt', alt || 'animation');

    var status = document.createElement('div');
    status.className = 'ai-chat-2d-status';
    status.textContent = 'Loading 2D animation…';
    container.appendChild(status);

    // A wrapping "viewport" div (not just the bare canvas) -- same reason
    // ai_chat_mermaid_viewer.js wraps its <svg> in its own "body" div:
    // wirePanZoom needs a clipping element whose OWN size (not the
    // content's, which can now be scaled far past it) defines the visible
    // window, plus somewhere to attach its scrollbar/focus-hint overlays
    // without disturbing the canvas element itself.
    var viewport = document.createElement('div');
    viewport.className = 'ai-chat-2d-viewport';
    var canvas = document.createElement('canvas');
    canvas.className = 'ai-chat-2d-canvas';
    viewport.appendChild(canvas);
    container.appendChild(viewport);

    var toolbar = document.createElement('div');
    toolbar.className = 'ai-chat-2d-toolbar';
    var title = document.createElement('span');
    title.className = 'ai-chat-2d-title';
    title.textContent = alt || '';
    toolbar.appendChild(title);

    var zoomWrap = document.createElement('div');
    zoomWrap.className = 'ai-chat-2d-zoom-controls';
    var zoomOutBtn = document.createElement('button');
    zoomOutBtn.type = 'button';
    zoomOutBtn.className = 'ai-chat-2d-zoom-btn';
    zoomOutBtn.textContent = '−';
    zoomOutBtn.title = 'Zoom out';
    var zoomResetBtn = document.createElement('button');
    zoomResetBtn.type = 'button';
    zoomResetBtn.className = 'ai-chat-2d-zoom-btn';
    zoomResetBtn.textContent = '⤢';
    zoomResetBtn.title = 'Reset zoom';
    var zoomInBtn = document.createElement('button');
    zoomInBtn.type = 'button';
    zoomInBtn.className = 'ai-chat-2d-zoom-btn';
    zoomInBtn.textContent = '+';
    zoomInBtn.title = 'Zoom in';
    zoomWrap.appendChild(zoomOutBtn);
    zoomWrap.appendChild(zoomResetBtn);
    zoomWrap.appendChild(zoomInBtn);
    toolbar.appendChild(zoomWrap);

    var exportWrap = document.createElement('div');
    exportWrap.className = 'ai-chat-2d-export-wrap';
    var exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'ai-chat-2d-export-btn';
    exportBtn.textContent = 'Export ▾';
    var exportMenu = document.createElement('div');
    exportMenu.className = 'ai-chat-2d-export-menu';
    exportMenu.style.display = 'none';
    [['yaml', 'YAML'], ['mp4', '🎬 MP4影片']].forEach(function (pair) {
      var item = document.createElement('div');
      item.className = 'ai-chat-2d-export-item';
      item.setAttribute('data-fmt', pair[0]);
      item.textContent = pair[1];
      exportMenu.appendChild(item);
    });
    exportBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      document.querySelectorAll('.ai-chat-2d-export-menu').forEach(function (m) { if (m !== exportMenu) { m.style.display = 'none'; } });
      exportMenu.style.display = exportMenu.style.display === 'block' ? 'none' : 'block';
    });
    document.addEventListener('click', function () { exportMenu.style.display = 'none'; });
    exportWrap.appendChild(exportBtn);
    exportWrap.appendChild(exportMenu);
    toolbar.appendChild(exportWrap);

    container.appendChild(toolbar);

    return container;
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // Exported for ai_chat_video_export.js's MP4 export wiring (see
  // ai_chat.js's export-menu click handler) -- driving this same
  // drawFrame/resolveShapeStates pair frame-by-frame is exactly how the
  // live on-screen animation loop below works too, just captured to a
  // video encoder instead of requestAnimationFrame.
  function exportAnimationToMp4(yamlText, opts, onProgress) {
    opts = opts || {};
    return ensureJsYamlLoaded().then(function () {
      var data = parseAnimation(yamlText);
      var images = preloadImages(data);
      var durationSeconds = Number.isFinite(opts.durationSeconds) ? Math.max(1, opts.durationSeconds) : (data.duration || 4);
      var fps = Number.isFinite(opts.fps) ? Math.max(10, Math.min(60, opts.fps)) : 30;
      var speed = Number.isFinite(opts.speed) && opts.speed > 0 ? Math.max(0.1, Math.min(4, opts.speed)) : 1;
      var width = data.width || 480, height = data.height || 320;

      var canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      var ctx = canvas.getContext('2d');

      var totalFrames = Math.round(durationSeconds * fps);
      return window.AiChatVideoExport.encodeCanvasFramesToMp4(canvas, totalFrames, fps, function (i) {
        var t = (i / fps) * speed;
        drawFrame(ctx, data, images, t, width, height);
      }, onProgress);
    });
  }

  // Same pan/zoom/scrollbar/focus-gated-wheel interaction as
  // ai_chat_mermaid_viewer.js's own wirePanZoom (a real, explicit ask: "跟
  // mermaid的方式一樣，只有focus的時候才wheel zoomin zoom out") -- copied
  // rather than shared/extracted (this codebase's own convention: small
  // duplication over a fragile cross-viewer abstraction), adapted only in
  // that `el` here is a <canvas> (a CSS transform on it works exactly like
  // one on an <svg> -- the canvas keeps redrawing at its fixed internal
  // pixel resolution via requestAnimationFrame regardless of this purely
  // visual scale/translate on top of it).
  function wirePanZoom2D(viewport, el, sceneWidth) {
    var MIN_SCALE = 0.2, MAX_SCALE = 8, WHEEL_ZOOM_FACTOR = 1.15;
    var scale = 1, tx = 0, ty = 0;
    var focused = false;

    var baseRect = el.getBoundingClientRect();
    var baseWidth = baseRect.width || 1;
    var baseHeight = baseRect.height || 1;
    // Screen px one scene unit occupies at scale 1 (the canvas is shown
    // shrunk to fit its container, so this is usually below 1).
    var baseUnitPx = baseWidth / Math.max(1, sceneWidth || baseWidth);
    var dpr = window.devicePixelRatio || 1;

    // The canvas stops determining its container's size (it becomes exactly
    // as large as the visible window, redrawn at the current zoom -- see
    // drawFrame's `view`), so pin the window to the size the scene
    // naturally had, capped at the stylesheet's 70vh limit.
    viewport.style.width = baseWidth + 'px';
    viewport.style.height = Math.min(baseHeight, window.innerHeight * 0.7) + 'px';
    el.style.maxWidth = 'none';
    var lastCssW = 0, lastCssH = 0;
    function sizeCanvas() {
      var w = Math.max(1, viewport.clientWidth);
      var h = Math.max(1, viewport.clientHeight);
      if (w === lastCssW && h === lastCssH) { return; }
      lastCssW = w; lastCssH = h;
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }

    var hScrollbar = document.createElement('div');
    hScrollbar.className = 'ai-chat-2d-scrollbar ai-chat-2d-scrollbar-h';
    var hThumb = document.createElement('div');
    hThumb.className = 'ai-chat-2d-scrollbar-thumb';
    hScrollbar.appendChild(hThumb);

    var vScrollbar = document.createElement('div');
    vScrollbar.className = 'ai-chat-2d-scrollbar ai-chat-2d-scrollbar-v';
    var vThumb = document.createElement('div');
    vThumb.className = 'ai-chat-2d-scrollbar-thumb';
    vScrollbar.appendChild(vThumb);

    var hint = document.createElement('div');
    hint.className = 'ai-chat-2d-focus-hint';
    hint.textContent = 'Click to pan / zoom';

    viewport.appendChild(hScrollbar);
    viewport.appendChild(vScrollbar);
    viewport.appendChild(hint);

    function setFocused(next) {
      if (focused === next) { return; }
      focused = next;
      viewport.classList.toggle('ai-chat-2d-focused', focused);
    }

    function updateScrollbars() {
      var vpWidth = viewport.clientWidth;
      var vpHeight = viewport.clientHeight;
      var contentWidth = baseWidth * scale;
      var contentHeight = baseHeight * scale;

      if (contentWidth <= vpWidth + 0.5) {
        hScrollbar.style.display = 'none';
      } else {
        hScrollbar.style.display = '';
        var hFrac = vpWidth / contentWidth;
        var hLeft = Math.min(Math.max(-tx / contentWidth, 0), 1 - hFrac);
        hThumb.style.width = (hFrac * 100) + '%';
        hThumb.style.left = (hLeft * 100) + '%';
      }

      if (contentHeight <= vpHeight + 0.5) {
        vScrollbar.style.display = 'none';
      } else {
        vScrollbar.style.display = '';
        var vFrac = vpHeight / contentHeight;
        var vTop = Math.min(Math.max(-ty / contentHeight, 0), 1 - vFrac);
        vThumb.style.height = (vFrac * 100) + '%';
        vThumb.style.top = (vTop * 100) + '%';
      }
    }

    function clampPan() {
      var vpWidth = viewport.clientWidth;
      var vpHeight = viewport.clientHeight;
      var contentWidth = baseWidth * scale;
      var contentHeight = baseHeight * scale;
      var minTx = Math.min(0, vpWidth - contentWidth);
      var maxTx = Math.max(0, vpWidth - contentWidth);
      tx = Math.min(maxTx, Math.max(minTx, tx));
      var minTy = Math.min(0, vpHeight - contentHeight);
      var maxTy = Math.max(0, vpHeight - contentHeight);
      ty = Math.min(maxTy, Math.max(minTy, ty));
    }

    function apply() {
      clampPan();
      sizeCanvas();
      updateScrollbars();
    }

    function zoomAt(cx, cy, factor) {
      var newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
      if (newScale === scale) { return; }
      tx = cx - (cx - tx) * (newScale / scale);
      ty = cy - (cy - ty) * (newScale / scale);
      scale = newScale;
      apply();
    }

    viewport.addEventListener('wheel', function (e) {
      if (!focused) { return; } // let the page scroll normally
      e.preventDefault();
      var rect = viewport.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR);
    }, { passive: false });

    var dragging = false, lastX = 0, lastY = 0;
    viewport.addEventListener('mousedown', function (e) {
      setFocused(true);
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      viewport.classList.add('ai-chat-2d-dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) { return; }
      tx += e.clientX - lastX; ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      apply();
    });
    window.addEventListener('mouseup', function () {
      dragging = false;
      viewport.classList.remove('ai-chat-2d-dragging');
    });
    document.addEventListener('click', function (e) {
      if (focused && !viewport.contains(e.target)) { setFocused(false); }
    }, true);

    if (window.ResizeObserver) {
      new ResizeObserver(function () { apply(); }).observe(viewport);
    }

    apply();

    return {
      zoomIn: function () { var r = viewport.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, WHEEL_ZOOM_FACTOR); },
      zoomOut: function () { var r = viewport.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / WHEEL_ZOOM_FACTOR); },
      reset: function () { scale = 1; tx = 0; ty = 0; apply(); },
      // Read every animation frame by the draw loop.
      getView: function () { return { k: baseUnitPx * scale * dpr, tx: tx * dpr, ty: ty * dpr }; }
    };
  }

  function mount(container) {
    var url = container.getAttribute('data-scene-url');
    var status = container.querySelector('.ai-chat-2d-status');
    var canvas = container.querySelector('.ai-chat-2d-canvas');

    ensureJsYamlLoaded().then(function () {
      return fetchYamlText(url);
    }).then(function (yamlText) {
      var data = parseAnimation(yamlText);
      var images = preloadImages(data);

      var baseName = (container.getAttribute('data-scene-alt') || 'animation').replace(/\s+/g, '_').replace(/[^\w-]/g, '') || 'animation';
      container.querySelectorAll('.ai-chat-2d-export-item').forEach(function (item) {
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          item.parentNode.style.display = 'none';
          var fmt = item.getAttribute('data-fmt');
          if (fmt === 'yaml') {
            downloadBlob(new Blob([yamlText], { type: 'application/x-yaml' }), baseName + '.2danim.yaml');
            return;
          }
          if (fmt === 'mp4') {
            var defaults = { durationSeconds: data.duration || 4, speed: 1 };
            window.AiChatVideoExport.showMp4ExportOptionsDialog(defaults).then(function (chosen) {
              if (!chosen) { return; }
              return exportAnimationToMp4(yamlText, chosen, function (current, total) {
                item.textContent = total > 0 ? '⏳' + Math.round((current / total) * 100) + '%' : item.textContent;
              }).then(function (result) {
                downloadBlob(result.blob, baseName + '.mp4');
              });
            }).catch(function (err) {
              window.AiChatDialog.notify('MP4 export failed: ' + (err && err.message || err));
            });
          }
        });
      });

      var width = data.width || 480;
      var height = data.height || 320;
      canvas.width = width; canvas.height = height;

      status.style.display = 'none';

      // Must run only after canvas is attached+sized (see
      // wirePanZoom2D/ai_chat_mermaid_viewer.js's own wirePanZoom comment
      // on why -- getBoundingClientRect() before this point measures 0x0).
      var viewport = container.querySelector('.ai-chat-2d-viewport');
      var panZoom = viewport ? wirePanZoom2D(viewport, canvas, width) : null;
      if (panZoom) {
        var zoomOutBtn = container.querySelector('.ai-chat-2d-zoom-btn[title="Zoom out"]');
        var zoomResetBtn = container.querySelector('.ai-chat-2d-zoom-btn[title="Reset zoom"]');
        var zoomInBtn = container.querySelector('.ai-chat-2d-zoom-btn[title="Zoom in"]');
        if (zoomOutBtn) { zoomOutBtn.addEventListener('click', function () { panZoom.zoomOut(); }); }
        if (zoomResetBtn) { zoomResetBtn.addEventListener('click', function () { panZoom.reset(); }); }
        if (zoomInBtn) { zoomInBtn.addEventListener('click', function () { panZoom.zoomIn(); }); }
      }

      var startTime = null;
      var stopped = false;
      var duration = data.duration || 4;
      function frame(now) {
        if (stopped) { return; }
        if (startTime === null) { startTime = now; }
        var t = ((now - startTime) / 1000) % Math.max(duration, 0.001);
        drawFrame(canvas.getContext('2d'), data, images, t, width, height, panZoom ? panZoom.getView() : null);
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);

      mounted.push({ container: container, stop: function () { stopped = true; } });
    }).catch(function (e) {
      status.textContent = '2D animation failed to load: ' + e.message;
      status.className = 'ai-chat-2d-status ai-chat-2d-error';
    });
  }

  // Scans rootEl (a freshly-rendered message's content element) for plain
  // <img> tags pointing at a *.2danim.yaml url and replaces each with a
  // live, mounted viewer -- same mechanism as ai_chat_3d_viewer.js's own
  // mountAll, reusing the exact same markdown image syntax the model
  // already uses for every other tool result.
  function mountAll(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) { return; }
    var imgs = rootEl.querySelectorAll('img[src]');
    Array.prototype.forEach.call(imgs, function (img) {
      var src = img.getAttribute('src');
      if (!isSceneUrl(src)) { return; }
      var container = buildViewerContainer(src, img.getAttribute('alt'));
      img.parentNode.replaceChild(container, img);
      mount(container);
    });
  }

  // Static snapshot for PDF/PPTX embedding -- mirrors
  // ai_chat_3d_viewer.js's snapshotToDataUri (see ai_chat_markdown.js's
  // isSceneUrl/snapshotToDataUri dispatch), frozen at t=0 since a static
  // document can't show motion.
  function snapshotToDataUri(url) {
    return ensureJsYamlLoaded().then(function () {
      return fetchYamlText(url);
    }).then(function (yamlText) {
      var data = parseAnimation(yamlText);
      var images = preloadImages(data);
      var width = data.width || 480, height = data.height || 320;
      var canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      drawFrame(canvas.getContext('2d'), data, images, 0, width, height);
      return canvas.toDataURL('image/png');
    });
  }

  window.AiChat2D = {
    isSceneUrl: isSceneUrl,
    mountAll: mountAll,
    mount: mount,
    snapshotToDataUri: snapshotToDataUri,
    // Exposed so a caller that needs to BUILD a new .2danim.yaml document
    // client-side (e.g. "/media-to-animation") can reuse the one already-
    // vendored js-yaml load instead of duplicating that script-load logic
    // -- resolves once window.jsyaml is ready to call (.dump/.load).
    ensureJsYamlLoaded: ensureJsYamlLoaded,
    // Exposed for testing only -- not part of the supported external API.
    _internal: {
      parseAnimation: parseAnimation,
      resolveShapeStates: resolveShapeStates,
      drawFrame: drawFrame,
      preloadImages: preloadImages,
      loopFraction: loopFraction,
      ANIMATORS: ANIMATORS,
      SHAPE_DRAWERS: SHAPE_DRAWERS,
      exportAnimationToMp4: exportAnimationToMp4
    }
  };
})(window);
