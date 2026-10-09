// Core of "/media-presentation": the deck format (a declarative .deck.yaml; the only script a deck may carry is the html of a "widget" visual, which runs in its own sandboxed frame), its validator, the
// narration/subtitle timing, the cue schedule, the whole-deck timeline and the frame renderer.
//
// Pure: no DOM, no network. Everything that touches the browser (loading images, TTS, the player window, the exporters)
// lives in ai_chat_deck_player.js and hands this file ready-made things (Image objects, a visual "drawer", audio length).
// That split is what makes the renderer deterministic: renderFrame(ctx, deck, timeline, T, info) is a function of T only,
// so the live player and the MP4 exporter call the SAME function and what you see is what is exported.
//
// Loadable both as a browser global (window.AiChatDeckCore) and by node (test/media/*.test.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatDeckCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 1920, H = 1080;
  var KIND = 'ai_chat_deck';
  var LAYOUTS = ['title', 'topic', 'content', 'split', 'visual'];
  var VISUAL_KINDS = ['shapes', 'anim2d', 'svg', 'mermaid', 'chart', 'image', 'table', 'scene3d', 'group', 'code', 'terminal', 'quiz', 'widget'];
  var TRANSITIONS = ['fade', 'slide-left', 'slide-right', 'push', 'zoom', 'wipe', 'curtain', 'spin', 'fly', 'none'];
  var STYLES = ['flat', '3d'];
  var ENVIRONMENTS = ['template', 'studio', 'opera', 'space'];
  // The camera of a 3D slide (see ai_chat_deck_stage3d.js): a shot, or a list of shots the camera moves through during the slide.
  var CAMERA_PRESETS = ['front', 'three-quarter', 'left', 'right', 'back', 'top', 'wide', 'closeup'];
  var CAMERA_KEYS = ['preset', 'azimuth', 'elevation', 'distance', 'focus', 'fov', 'at'];
  var MAX_SHOTS = 8;
  // A flat deck draws "curtain"/"spin"/"fly" with their flat look-alike; the 3D view draws every flat name as a camera fly unless the name
  // exists there ("curtain" only really closes curtains in the opera environment; elsewhere it is a fly).
  var FLAT_OF = { curtain: 'wipe', spin: 'zoom', fly: 'zoom' };
  var STAGE_TRANSITIONS = { fly: 'fly', curtain: 'curtain', spin: 'spin', fade: 'fade', none: 'none' };
  var IN_EFFECTS = ['fade', 'rise', 'pop', 'wipe'];
  var MOTIONS = ['none', 'float', 'pulse', 'spin', 'kenburns'];
  var MODES = ['loop', 'timed'];
  var LIMITS = { chapters: 30, slides: 150, bullets: 6, narration: 1200, svg: 200000, mermaid: 4000, title: 120, bullet: 220,
    cols: 8, rows: 12, cell: 120, images: 8, callouts: 6, duration: 180, groupItems: 4,
    code: 400000, codeLines: 20000, commands: 20, command: 300, question: 400, option: 160, options: 6, explain: 600 };
  var LEAD = 0.3, TAIL = 0.6, MIN_SLIDE = 2.5, MIN_SILENT = 4;
  var SPEED_TALK = /說話速度|語速|播放速度|語音速度|倍速播放|speaking (?:speed|rate)|speech (?:speed|rate)|voice speed|playback speed/i;
  var FONT = '"Microsoft JhengHei","Noto Sans CJK TC","PingFang TC","Noto Sans TC",sans-serif';  // replaced by the template's font (applyTemplate)
  var COLORS = { heading: '#0E2841', body: '#333333', accent: '#77BD1D', soft: '#E8E8E8', white: '#FFFFFF' };

  // ------------------------------------------------------------------ the template (the look of every slide)
  // DEFAULT_TEMPLATE is a copy of config/deck_template.default.json (the server's single source; test/media/deck_template.test.js keeps them equal). An
  // admin can override any part of it (Configure > Presentation template); applyTemplate() makes the renderer use the merged result. Everything the
  // renderer draws that is a colour, a font, a size or a position comes from here -- in the 1920x1080 design space.
  var DEFAULT_TEMPLATE = {
    "version": 1,
    "name": "Default",
    "font": "\"Microsoft JhengHei\",\"Noto Sans CJK TC\",\"PingFang TC\",\"Noto Sans TC\",sans-serif",
    "pptxFont": "Microsoft JhengHei",
    "colors": {
      "heading": "#0E2841",
      "body": "#333333",
      "accent": "#77BD1D",
      "soft": "#E8E8E8",
      "white": "#FFFFFF",
      "dark": "#0E2841",
      "stripe": "#F4F7F0",
      "contentBg": "#FFFFFF",
      "titleText": "#FFFFFF",
      "subtitleBar": "rgba(14,40,65,0.82)",
      "subtitleText": "#FFFFFF"
    },
    "images": {
      "titleBg": "file",
      "topicBg": "file",
      "contentBg": "file",
      "logo": "file"
    },
    "logo": {
      "x": 131,
      "y": 161,
      "w": 841,
      "h": 207
    },
    "title": {
      "x": 157,
      "y": 387,
      "w": 1520,
      "h": 205,
      "size": 72,
      "minSize": 44,
      "subtitleSize": 34
    },
    "topic": {
      "x": 156,
      "y": 276,
      "w": 1398,
      "h": 282,
      "size": 76,
      "minSize": 44,
      "topBar": 12,
      "rule": {
        "x": 171,
        "y": 573,
        "w": 1387,
        "h": 7
      }
    },
    "header": {
      "x": 63,
      "y": 55,
      "w": 1721,
      "h": 114,
      "size": 56,
      "minSize": 36,
      "labelSize": 24,
      "labelY": 40
    },
    "contentBar": {
      "h": 11
    },
    "area": {
      "x": 63,
      "y": 195,
      "w": 1794,
      "h": 690
    },
    "split": {
      "bulletsW": 790,
      "visualX": 880,
      "visualW": 977
    },
    "bullets": {
      "size": 46,
      "minSize": 28,
      "gap": 30,
      "dot": 9
    },
    "subtitle": {
      "x": 160,
      "y": 905,
      "w": 1600,
      "h": 140,
      "size": 38,
      "minSize": 26,
      "radius": 18
    }
  };
  var TPL = null;

  function isPlain(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
  function cloneJson(o) { return JSON.parse(JSON.stringify(o)); }
  function mergeTemplate(base, over) {
    var out = cloneJson(base);
    (function walk(dst, src) {
      Object.keys(src || {}).forEach(function (k) {
        if (isPlain(src[k]) && isPlain(dst[k])) { walk(dst[k], src[k]); } else { dst[k] = isPlain(src[k]) || Array.isArray(src[k]) ? cloneJson(src[k]) : src[k]; }
      });
    })(out, over);
    return out;
  }

  // Makes `t` (a whole template or any subset of one, over the default) the look of every slide drawn from now on. Colours / geometry objects that
  // the rest of the file holds by reference are updated in place.
  function applyTemplate(t) {
    TPL = mergeTemplate(DEFAULT_TEMPLATE, t || {});
    FONT = TPL.font;
    Object.keys(TPL.colors).forEach(function (k) { COLORS[k] = TPL.colors[k]; });
    ['header', 'area', 'subtitle'].forEach(function (k) { ['x', 'y', 'w', 'h'].forEach(function (f) { GEO[k][f] = TPL[k][f]; }); });
    return TPL;
  }
  function template() { return TPL; }

  // ------------------------------------------------------------------ small helpers
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
  function easeOut(p) { return 1 - Math.pow(1 - clamp(p, 0, 1), 3); }
  function easeInOut(p) { p = clamp(p, 0, 1); return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function easeOutBack(p) { p = clamp(p, 0, 1); var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }

  // ------------------------------------------------------------------ narration -> sentences
  // Splits on CJK/latin sentence enders; a "." only ends a sentence when followed by a space or the end (so "3.5" and
  // "v1.2" stay whole). Closing quotes/brackets stay with their sentence.
  function splitSentences(text) {
    var s = str(text).replace(/\s+/g, ' ').trim();
    if (!s) { return []; }
    var out = [], cur = '';
    var closers = '」』”’)）"\'';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      cur += c;
      var end = '。！？!?；;'.indexOf(c) >= 0 || (c === '.' && (i + 1 >= s.length || s.charAt(i + 1) === ' '));
      if (!end) { continue; }
      while (i + 1 < s.length && closers.indexOf(s.charAt(i + 1)) >= 0) { cur += s.charAt(++i); }
      if (cur.trim()) { out.push(cur.trim()); }
      cur = '';
    }
    if (cur.trim()) { out.push(cur.trim()); }
    return out;
  }

  function isCjk(ch) { return /[㐀-䶿一-鿿぀-ヿ가-힣]/.test(ch); }

  // Reading time used when there is no audio (no TTS available): ~4.2 CJK chars/s, ~2.6 latin words/s.
  function estimateSeconds(text) {
    var s = str(text), cjk = 0, rest = '';
    for (var i = 0; i < s.length; i++) { if (isCjk(s.charAt(i))) { cjk++; rest += ' '; } else { rest += s.charAt(i); } }
    var words = (rest.match(/[A-Za-z0-9][A-Za-z0-9'’\-.]*/g) || []).length;
    return cjk / 4.2 + words / 2.6;
  }

  function weight(sentence) {
    var n = str(sentence).replace(/[\s。！？!?；;,，、:：.'"「」『』“”()（）]/g, '').length;
    return Math.max(1, n);
  }

  // Sentence i gets a slice of the narration proportional to its length.
  function distribute(sentences, narrationSec, lead) {
    var total = 0, i;
    for (i = 0; i < sentences.length; i++) { total += weight(sentences[i]); }
    var t = lead, out = [];
    for (i = 0; i < sentences.length; i++) {
      var d = total ? narrationSec * weight(sentences[i]) / total : 0;
      out.push({ text: sentences[i], start: t, end: t + d });
      t += d;
    }
    return out;
  }

  // ------------------------------------------------------------------ cue parsing
  // at: "sentence:N" (1-based, start of that sentence) | "sec:S" | a number (seconds into the slide) | "start"
  function validateCamera(c, cp, narration, err) {
    var shots = Array.isArray(c) ? c : [c];
    if (!shots.length || shots.length > MAX_SHOTS) { err(cp, 'must be one shot or a list of 1..' + MAX_SHOTS + ' shots'); return; }
    var sentences = splitSentences(narration).length;
    shots.forEach(function (sh, i) {
      var sp = Array.isArray(c) ? cp + '[' + i + ']' : cp;
      if (typeof sh === 'string') { sh = { preset: sh }; }
      if (!isObj(sh)) { err(sp, 'must be a preset name or a mapping {preset?, azimuth?, elevation?, distance?, focus?, fov?, at?}'); return; }
      Object.keys(sh).forEach(function (k) { if (CAMERA_KEYS.indexOf(k) < 0) { err(sp + '.' + k, 'unknown camera key (use ' + CAMERA_KEYS.join(', ') + ')'); } });
      if (sh.preset != null && CAMERA_PRESETS.indexOf(sh.preset) < 0) { err(sp + '.preset', 'must be one of ' + CAMERA_PRESETS.join(', ')); }
      function num(k, lo, hi) { if (sh[k] != null && !(typeof sh[k] === 'number' && sh[k] >= lo && sh[k] <= hi)) { err(sp + '.' + k, 'must be a number between ' + lo + ' and ' + hi); } }
      num('azimuth', -360, 360); num('elevation', 0, 89); num('distance', 0.1, 6); num('fov', 20, 80);
      if (sh.focus != null && !(typeof sh.focus === 'string' && sh.focus.trim())) { err(sp + '.focus', 'must be the id (name) of a node of the 3D model'); }
      if (sh.at != null) {
        var at = parseAt(sh.at);
        if (!at) { err(sp + '.at', 'must be "sentence:N" (1-based), "sec:S" or a number of seconds'); }
        else if (at.sentence != null && (at.sentence < 1 || at.sentence > Math.max(1, sentences))) { err(sp + '.at', 'sentence ' + at.sentence + ' does not exist (the narration has ' + sentences + ' sentence(s))'); }
      }
      if (i === 0 && sh.at != null && parseAt(sh.at) && (parseAt(sh.at).sec || 0) > 0) { err(sp + '.at', 'the first shot starts the slide: leave "at" out'); }
    });
  }

  function parseAt(v) {
    if (typeof v === 'number' && isFinite(v)) { return { sec: v }; }
    var m = /^\s*sentence\s*:\s*(\d+)\s*$/i.exec(str(v));
    if (m) { return { sentence: parseInt(m[1], 10) }; }
    m = /^\s*sec(?:onds?)?\s*:\s*([\d.]+)\s*$/i.exec(str(v));
    if (m) { return { sec: parseFloat(m[1]) }; }
    if (/^\s*start\s*$/i.test(str(v))) { return { sec: 0 }; }
    return null;
  }

  // target: "title" | "visual" | "bullet:i" (0-based) | "shape:<id>" | "row:i" (table, 0-based) | "callout:i" | "image:i"
  function parseTarget(v) {
    var s = str(v).trim();
    if (s === 'title' || s === 'visual') { return { type: s }; }
    var m = /^(bullet|row|callout|image)\s*:\s*(\d+)$/i.exec(s);
    if (m) { return { type: m[1].toLowerCase(), index: parseInt(m[2], 10) }; }
    m = /^shape\s*:\s*([\w.-]+)$/i.exec(s);
    if (m) { return { type: 'shape', id: m[1] }; }
    return null;
  }

  function targetKey(t) { return t.type + (t.index != null ? ':' + t.index : '') + (t.id ? ':' + t.id : ''); }

  // ------------------------------------------------------------------ validation + normalisation
  // validate(obj) -> {errors:[...], warnings:[...]}; every message starts with the field path so a model can fix it.
  function validate(doc) {
    var errors = [], warnings = [];
    function err(path, msg) { errors.push(path + ': ' + msg); }
    function warn(path, msg) { warnings.push(path + ': ' + msg); }
    if (!isObj(doc)) { return { errors: ['deck: the document must be a YAML mapping'], warnings: [] }; }
    var deck = doc.deck;
    if (!isObj(deck)) { err('deck', 'missing "deck" mapping (title, lang, voice, ...)'); deck = {}; }
    if (!str(deck.title).trim()) { err('deck.title', 'required'); }
    if (str(deck.title).length > LIMITS.title) { err('deck.title', 'longer than ' + LIMITS.title + ' characters'); }
    if (deck.theme != null && deck.theme !== 'default') { err('deck.theme', 'must be "default"'); }
    if (deck.speed != null && !(typeof deck.speed === 'number' && deck.speed >= 0.5 && deck.speed <= 2)) { err('deck.speed', 'must be a number between 0.5 and 2'); }
    if (deck.aspect != null && deck.aspect !== '16:9') { err('deck.aspect', 'only "16:9" is supported'); }
    if (deck.style != null && STYLES.indexOf(deck.style) < 0) { err('deck.style', 'must be flat or 3d'); }
    if (deck.environment != null && ENVIRONMENTS.indexOf(deck.environment) < 0) { err('deck.environment', 'must be one of ' + ENVIRONMENTS.join(', ')); }
    var chapters = doc.chapters;
    if (!Array.isArray(chapters) || !chapters.length) { err('chapters', 'needs a non-empty list of chapters'); return { errors: errors, warnings: warnings }; }
    if (chapters.length > LIMITS.chapters) { err('chapters', 'at most ' + LIMITS.chapters + ' chapters'); }
    var seen = {}, count = 0;
    chapters.forEach(function (ch, ci) {
      var cp = 'chapters[' + ci + ']';
      if (!isObj(ch)) { err(cp, 'must be a mapping'); return; }
      if (!str(ch.title).trim()) { err(cp + '.title', 'required'); }
      if (!Array.isArray(ch.slides) || !ch.slides.length) { err(cp + '.slides', 'needs a non-empty list of slides'); return; }
      ch.slides.forEach(function (s, si) {
        count++;
        validateSlide(s, cp + '.slides[' + si + ']', count === 1, seen, err, warn);
      });
    });
    if (count > LIMITS.slides) { err('chapters', 'more than ' + LIMITS.slides + ' slides in total'); }
    checkQuizReferences(doc, warn);
    return { errors: errors, warnings: warnings };
  }

  function validateSlide(s, p, first, seen, err, warn) {
    if (!isObj(s)) { err(p, 'must be a mapping'); return; }
    if (s.id != null) {
      if (!/^[\w.-]+$/.test(str(s.id))) { err(p + '.id', 'may contain only letters, digits, _ . -'); }
      else if (seen[s.id]) { err(p + '.id', 'duplicate id "' + s.id + '"'); }
      seen[s.id] = true;
    }
    var layout = s.layout || null;
    if (layout && LAYOUTS.indexOf(layout) < 0) { err(p + '.layout', 'must be one of ' + LAYOUTS.join(', ')); }
    if (!str(s.title).trim() && layout !== 'visual') { warn(p + '.title', 'a slide without a title looks unfinished'); }
    if (str(s.title).length > LIMITS.title) { err(p + '.title', 'longer than ' + LIMITS.title + ' characters'); }
    var bullets = s.bullets;
    if (bullets != null) {
      if (!Array.isArray(bullets)) { err(p + '.bullets', 'must be a list of strings'); bullets = []; }
      else {
        if (bullets.length > LIMITS.bullets) { err(p + '.bullets', 'at most ' + LIMITS.bullets + ' bullets per slide (split the slide)'); }
        bullets.forEach(function (b, bi) {
          if (typeof b !== 'string' || !b.trim()) { err(p + '.bullets[' + bi + ']', 'must be a non-empty string'); }
          else if (b.length > LIMITS.bullet) { err(p + '.bullets[' + bi + ']', 'longer than ' + LIMITS.bullet + ' characters'); }
        });
      }
    }
    var narration = s.narration;
    if (narration != null && typeof narration !== 'string') { err(p + '.narration', 'must be a string'); narration = ''; }
    if (str(narration).length > LIMITS.narration) { err(p + '.narration', 'longer than ' + LIMITS.narration + ' characters (split the slide)'); }
    // the narration is what the audience HEARS: how fast the voice is, is a deck setting (deck.speed), never a sentence of the talk
    // (only a warning here: a deck saved before this rule must still play; the server refuses it when a model writes one -- MediaDeckValidator)
    if (SPEED_TALK.test(str(narration))) { warn(p + '.narration', 'mentions the speaking speed -- that is the deck setting deck.speed, not something to say; remove that sentence from the narration'); }
    if (s.duration != null && !(typeof s.duration === 'number' && s.duration >= 1 && s.duration <= LIMITS.duration)) { err(p + '.duration', 'must be a number between 1 and ' + LIMITS.duration + ' seconds'); }
    if (s.notes != null && typeof s.notes !== 'string') { err(p + '.notes', 'must be a string'); }
    if (s.transition != null) {
      if (!isObj(s.transition)) { err(p + '.transition', 'must be a mapping {type, ms}'); }
      else {
        if (TRANSITIONS.indexOf(s.transition.type) < 0) { err(p + '.transition.type', 'must be one of ' + TRANSITIONS.join(', ')); }
        if (s.transition.ms != null && !(typeof s.transition.ms === 'number' && s.transition.ms >= 100 && s.transition.ms <= 3000)) { err(p + '.transition.ms', 'must be 100..3000'); }
      }
    }
    if (s.stage != null && STYLES.indexOf(s.stage) < 0) { err(p + '.stage', 'must be flat or 3d'); }
    if (s.camera != null) { validateCamera(s.camera, p + '.camera', str(s.narration), err); }
    var vctx = { shapeIds: [], images: 0, callouts: 0, rows: 0 };
    if (s.visual != null) { validateVisual(s.visual, p + '.visual', layout, vctx, 0, err, warn); }
    else if (layout === 'visual') { err(p + '.visual', 'layout "visual" needs a "visual"'); }

    var sentences = splitSentences(narration);
    if (s.cues != null) {
      if (!Array.isArray(s.cues)) { err(p + '.cues', 'must be a list'); }
      else {
        s.cues.forEach(function (c, ci) {
          var cp = p + '.cues[' + ci + ']';
          if (!isObj(c)) { err(cp, 'must be a mapping'); return; }
          var at = parseAt(c.at);
          if (!at) { err(cp + '.at', 'must be "sentence:N" (1-based), "sec:S" or a number of seconds'); }
          else if (at.sentence != null && (at.sentence < 1 || at.sentence > Math.max(1, sentences.length))) { err(cp + '.at', 'sentence ' + at.sentence + ' does not exist (the narration has ' + sentences.length + ' sentence(s))'); }
          var which = c.show != null ? 'show' : (c.emphasize != null ? 'emphasize' : null);
          if (!which) { err(cp, 'needs "show" or "emphasize" with a target'); return; }
          var tgt = parseTarget(c[which]);
          if (!tgt) { err(cp + '.' + which, 'target must be title, visual, bullet:N, row:N, callout:N, image:N or shape:<id>'); return; }
          if (tgt.type === 'bullet' && !(Array.isArray(bullets) && tgt.index < bullets.length)) { err(cp + '.' + which, 'bullet ' + tgt.index + ' does not exist'); }
          if (tgt.type === 'row' && tgt.index >= vctx.rows) { err(cp + '.' + which, 'row ' + tgt.index + ' does not exist'); }
          if (tgt.type === 'callout' && tgt.index >= vctx.callouts) { err(cp + '.' + which, 'callout ' + tgt.index + ' does not exist'); }
          if (tgt.type === 'image' && tgt.index >= Math.max(vctx.images, 1)) { err(cp + '.' + which, 'image ' + tgt.index + ' does not exist'); }
          if (tgt.type === 'shape' && vctx.shapeIds.indexOf(tgt.id) < 0) { err(cp + '.' + which, 'no shape with id "' + tgt.id + '" in this slide\'s 2D scenes (a "shapes" visual or an "overlay"; give the shape an "id")'); }
          if (c.effect != null && IN_EFFECTS.indexOf(c.effect) < 0 && c.effect !== 'pulse') { err(cp + '.effect', 'must be one of ' + IN_EFFECTS.concat('pulse').join(', ')); }
          if (c.ms != null && !(typeof c.ms === 'number' && c.ms >= 100 && c.ms <= 3000)) { err(cp + '.ms', 'must be 100..3000'); }
        });
      }
    }
    if (!sentences.length && !s.duration && !(isObj(s.visual) && s.visual.mode === 'timed')) { warn(p, 'no narration: the slide is silent and lasts ' + MIN_SILENT + ' seconds unless you give "duration"'); }
  }

  // One visual (or one item of a group). c collects what cues may point at: shape ids (of shapes visuals AND overlays), image/callout/row counts.
  function validateVisual(v, vp, layout, c, depth, err, warn) {
    if (!isObj(v)) { err(vp, 'must be a mapping'); return; }
    if (VISUAL_KINDS.indexOf(v.kind) < 0) { err(vp + '.kind', 'must be one of ' + VISUAL_KINDS.join(', ')); }
    if (v.mode != null && MODES.indexOf(v.mode) < 0) { err(vp + '.mode', 'must be loop or timed'); }
    if (v.period != null && !(typeof v.period === 'number' && v.period > 0.5 && v.period <= 60)) { err(vp + '.period', 'must be 0.5..60 seconds'); }
    if (v.motion != null) {
      var mt = isObj(v.motion) ? v.motion.type : v.motion;
      if (MOTIONS.indexOf(mt) < 0) { err(vp + '.motion', 'must be one of ' + MOTIONS.join(', ')); }
    }
    // A 2D layer drawn over any visual (also over a 3D model): labels, arrows, highlights that follow the narration.
    if (v.overlay != null) {
      if (!isObj(v.overlay) || !isObj(v.overlay.scene) || !Array.isArray(v.overlay.scene.shapes) || !v.overlay.scene.shapes.length) { err(vp + '.overlay', 'must be {scene: {width, height, shapes: [...]}} -- a 2D scene (same format as kind "shapes") drawn over this visual'); }
      else { v.overlay.scene.shapes.forEach(function (sh) { if (sh && sh.id) { c.shapeIds.push(sh.id); } }); }
    }
    if (v.kind === 'group') {
      if (depth > 0) { err(vp, 'a group cannot be nested in a group'); return; }
      if (!Array.isArray(v.items) || !v.items.length) { err(vp + '.items', 'kind "group" needs "items": 1-' + LIMITS.groupItems + ' visuals, each with a "box"'); return; }
      if (v.items.length > LIMITS.groupItems) { err(vp + '.items', 'at most ' + LIMITS.groupItems + ' items'); }
      v.items.forEach(function (item, k) {
        var ip = vp + '.items[' + k + ']';
        if (isObj(item) && item.kind !== 'group') {
          var b = item.box;
          var okBox = Array.isArray(b) && b.length === 4 && b.every(function (n) { return typeof n === 'number' && n >= 0 && n <= 1; }) && b[2] > 0.05 && b[3] > 0.05 && b[0] + b[2] <= 1.001 && b[1] + b[3] <= 1.001;
          if (!okBox) { err(ip + '.box', 'needs box: [x, y, w, h] as fractions 0..1 of the visual area (w and h > 0.05, inside the area)'); }
        }
        validateVisual(item, ip, layout, c, depth + 1, err, warn);
      });
      return;
    }
    if (v.kind === 'shapes') {
      if (!isObj(v.scene) || !Array.isArray(v.scene.shapes) || !v.scene.shapes.length) { err(vp + '.scene.shapes', 'kind "shapes" needs a "scene" with a non-empty "shapes" list (same format as a 2D animation: circle/rect/polygon/line/text/image + animation)'); }
      else { v.scene.shapes.forEach(function (sh) { if (sh && sh.id) { c.shapeIds.push(sh.id); } }); }
    } else if (v.kind === 'scene3d') {
      var hasScene = isObj(v.scene) && Array.isArray(v.scene.nodes) && v.scene.nodes.length;
      if (!str(v.ref).trim() && !hasScene) { err(vp, 'kind "scene3d" needs "ref" (the url of a .3dscene.yaml, e.g. from render_3d_scene) or an inline "scene" with a "nodes" list'); }
      if (v.interactive != null && typeof v.interactive !== 'boolean') { err(vp + '.interactive', 'must be true or false'); }
      if (v.orbit != null && !(v.orbit === false || (typeof v.orbit === 'number' && v.orbit >= 4 && v.orbit <= 120))) { err(vp + '.orbit', 'seconds per camera turn (4..120) or false'); }
    } else if (v.kind === 'anim2d') {
      if (!str(v.ref).trim()) { err(vp + '.ref', 'kind "anim2d" needs "ref": the url of an existing .2danim.yaml attachment'); }
    } else if (v.kind === 'svg') {
      if (!str(v.svg).trim() && !str(v.src).trim()) { err(vp, 'kind "svg" needs "svg" (inline markup) or "src" (a url)'); }
      if (str(v.svg).length > LIMITS.svg) { err(vp + '.svg', 'larger than ' + LIMITS.svg + ' characters'); }
      if (/<script|on\w+\s*=|javascript:/i.test(str(v.svg))) { err(vp + '.svg', 'must not contain scripts or event handlers'); }
    } else if (v.kind === 'mermaid') {
      if (!str(v.source).trim()) { err(vp + '.source', 'kind "mermaid" needs "source" (mermaid text)'); }
      if (str(v.source).length > LIMITS.mermaid) { err(vp + '.source', 'longer than ' + LIMITS.mermaid + ' characters'); }
    } else if (v.kind === 'chart') {
      if (!str(v.src).trim()) { err(vp + '.src', 'kind "chart" needs "src": the url returned by render_chart'); }
    } else if (v.kind === 'image') {
      var list = Array.isArray(v.images) ? v.images : (str(v.src).trim() ? [{ src: v.src, caption: v.caption }] : null);
      if (!list || !list.length) { err(vp, 'kind "image" needs "src" (a url) or "images": [{src, caption}]'); }
      else {
        c.images = Math.max(c.images, list.length);
        if (list.length > LIMITS.images) { err(vp + '.images', 'at most ' + LIMITS.images + ' images (split the slide)'); }
        list.forEach(function (im, ii) {
          if (!isObj(im) || !str(im.src).trim()) { err(vp + '.images[' + ii + '].src', 'required'); }
          else if (/^\s*javascript:/i.test(im.src)) { err(vp + '.images[' + ii + '].src', 'not allowed'); }
        });
      }
      if (v.fit != null && ['contain', 'cover'].indexOf(v.fit) < 0) { err(vp + '.fit', 'must be contain or cover'); }
      if (v.callouts != null) {
        if (!Array.isArray(v.callouts)) { err(vp + '.callouts', 'must be a list'); }
        else {
          c.callouts = Math.max(c.callouts, v.callouts.length);
          if (v.callouts.length > LIMITS.callouts) { err(vp + '.callouts', 'at most ' + LIMITS.callouts); }
          v.callouts.forEach(function (co, k) {
            var okBox = isObj(co) && ['x', 'y', 'w', 'h'].every(function (f) { return typeof co[f] === 'number' && co[f] >= 0 && co[f] <= 1; });
            if (!okBox) { err(vp + '.callouts[' + k + ']', 'needs x, y, w, h as fractions 0..1 of the (first) image'); }
          });
        }
      }
    } else if (v.kind === 'code') {
      // a long listing / patch in a scrollable, syntax-highlighted window (a screenshot of the current view in PPTX)
      var hasCode = str(v.code).trim(), hasSrc = str(v.src).trim();
      if (!hasCode && !hasSrc) { err(vp, 'kind "code" needs "code" (the text) or "src" (the url of a text attachment)'); }
      if (str(v.code).length > LIMITS.code) { err(vp + '.code', 'longer than ' + LIMITS.code + ' characters (use "src": the url of an attachment)'); }
      // (a warning here, an error on the server: a deck saved with an undefined handle must still open and play)
      // (a warning here, an error on the server: a deck saved before this rule must still open)
      patchNoopLines(v.code).slice(0, 3).forEach(function (l) { warn(vp + '.code', 'the patch removes and adds the identical line ' + JSON.stringify(l.trim()) + ' -- a real diff never does (an unchanged line is a context line)'); });
      if (/^@[a-z]\d+$/.test(str(v.code).trim())) { warn(vp + '.code', JSON.stringify(str(v.code).trim()) + ' is a snippet handle that was never defined -- give the text with define_snippet and use the handle it returns'); }
      if (v.lang != null && !str(v.lang).trim()) { err(vp + '.lang', 'must be a language name such as c, python, js, bash, json, yaml, diff'); }
      if (v.patch != null && typeof v.patch !== 'boolean') { err(vp + '.patch', 'must be true or false (omit it: a unified diff / git patch is recognised by itself)'); }
      if (v.size != null && !(typeof v.size === 'number' && v.size >= 14 && v.size <= 44)) { err(vp + '.size', 'font size in design pixels, 14..44 (default 24)'); }
      if (v.start_line != null && !(Number.isInteger(v.start_line) && v.start_line >= 1)) { err(vp + '.start_line', 'must be a line number >= 1'); }
      if (v.autoscroll != null && !(v.autoscroll === true || v.autoscroll === false || (typeof v.autoscroll === 'number' && v.autoscroll >= 2 && v.autoscroll <= 300))) { err(vp + '.autoscroll', 'true, false or the seconds (2..300) one pass from top to bottom takes'); }
      if (v.highlight != null) {
        var okHl = Array.isArray(v.highlight) && v.highlight.length <= 20 && v.highlight.every(function (h) { return (Number.isInteger(h) && h >= 1) || (Array.isArray(h) && h.length === 2 && h.every(function (n) { return Number.isInteger(n) && n >= 1; }) && h[0] <= h[1]); });
        if (!okHl) { err(vp + '.highlight', 'a list (<= 20) of line numbers or [from, to] ranges, e.g. [12, [20, 25]]'); }
      }
    } else if (v.kind === 'terminal') {
      // a real (busybox) shell in the page: interactive in the player, its current screen as a picture in MP4 / PPTX
      if (v.commands != null) {
        if (!Array.isArray(v.commands) || v.commands.length > LIMITS.commands || !v.commands.every(function (cmd) { return typeof cmd === 'string' && cmd.trim() && cmd.length <= LIMITS.command; })) { err(vp + '.commands', 'a list (<= ' + LIMITS.commands + ') of shell command lines (each <= ' + LIMITS.command + ' characters) run when the slide is first shown'); }
      }
      if (v.interactive != null && typeof v.interactive !== 'boolean') { err(vp + '.interactive', 'must be true or false'); }
      if (v.wait != null && typeof v.wait !== 'boolean') { err(vp + '.wait', 'true (default for an interactive terminal): the deck waits at the end of the slide until the viewer has typed a command; false: it runs past'); }
      if (v.size != null && !(typeof v.size === 'number' && v.size >= 14 && v.size <= 40)) { err(vp + '.size', 'font size in design pixels, 14..40'); }
    } else if (v.kind === 'widget') {
      // AI-written interactive piece (game / simulator / exercise): one self-contained html document, run in a sandboxed iframe (see
      // ai_chat_deck_widget.js). PPTX / MP4 / a browser without the sandbox show `fallback` and what the widget reported.
      var wh = str(v.html);
      if (!wh.trim()) { err(vp + '.html', 'kind "widget" needs "html": one self-contained html document (inline css + js, no network)'); }
      if (/^@[a-z]\d+$/.test(wh.trim())) { warn(vp + '.html', JSON.stringify(wh.trim()) + ' is a snippet handle that was never defined -- give the html with define_snippet and use the handle it returns'); }
      if (wh.length > 120000) { err(vp + '.html', 'longer than 120000 characters'); }
      else if (wh.trim()) { widgetProblems(wh).forEach(function (pr) { err(vp + '.html', pr); }); }
      if (!str(v.fallback).trim()) { err(vp + '.fallback', 'kind "widget" needs "fallback": 1-3 sentences saying what the widget is and what the viewer does with it (shown in PPTX / video / where scripts cannot run)'); }
      if (str(v.fallback).length > 600) { err(vp + '.fallback', 'longer than 600 characters'); }
      if (v.title != null && str(v.title).length > 80) { err(vp + '.title', 'longer than 80 characters'); }
      if (v.points != null && !(typeof v.points === 'number' && v.points >= 0 && v.points <= 100)) { err(vp + '.points', 'must be 0..100 (default 10)'); }
      if (v.wait != null && typeof v.wait !== 'boolean') { err(vp + '.wait', 'must be true or false'); }
      if (v.start != null && ['auto', 'click', 'countdown'].indexOf(v.start) < 0) { err(vp + '.start', 'must be countdown (click, then 3-2-1: the default), click (starts at the click) or auto (starts as soon as the slide shows)'); }
      if (v.grade != null && !(isObj(v.grade) && str(v.grade.question).trim() && (str(v.grade.reference).trim() || str(v.grade.rubric).trim()))) { err(vp + '.grade', 'for deck.grade(answer): {question, reference and/or rubric} -- what the AI grader judges the widget\'s answers against'); }
    } else if (v.kind === 'quiz') {
      validateQuiz(v, vp, err, warn);
    } else if (v.kind === 'table') {
      if (!Array.isArray(v.header) || !v.header.length) { err(vp + '.header', 'kind "table" needs "header": a list of column titles'); }
      else if (v.header.length > LIMITS.cols) { err(vp + '.header', 'at most ' + LIMITS.cols + ' columns'); }
      if (!Array.isArray(v.rows) || !v.rows.length) { err(vp + '.rows', 'needs "rows": a list of rows, each a list of cells'); }
      else {
        c.rows = Math.max(c.rows, v.rows.length);
        if (v.rows.length > LIMITS.rows) { err(vp + '.rows', 'at most ' + LIMITS.rows + ' rows per slide (split the table over several slides)'); }
        v.rows.forEach(function (row, ri) {
          if (!Array.isArray(row)) { err(vp + '.rows[' + ri + ']', 'must be a list of cells'); return; }
          if (Array.isArray(v.header) && row.length !== v.header.length) { err(vp + '.rows[' + ri + ']', 'has ' + row.length + ' cells but the header has ' + v.header.length); }
          row.forEach(function (cell, k) { if (str(cell).length > LIMITS.cell) { err(vp + '.rows[' + ri + '][' + k + ']', 'cell longer than ' + LIMITS.cell + ' characters (summarise it)'); } });
        });
      }
    }
    if (depth === 0 && ['title', 'topic'].indexOf(layout) >= 0) { warn(vp, 'a "' + layout + '" slide does not show a visual'); }
  }


  // Lines a patch both removes and adds, unchanged, inside one hunk (a real diff never has them; a hand-written one does, and "which line was added?" then has two answers).
  function patchNoopLines(code) {
    var text = str(code);
    if (!/^(?:diff --git |@@)/m.test(text)) { return []; }
    var hunks = [], cur = null;
    text.split('\n').forEach(function (l) {
      if (l.indexOf('diff --git ') === 0) { cur = null; }
      else if (l.indexOf('@@') === 0) { cur = { rem: [], add: [] }; hunks.push(cur); }
      else if (cur && !/^(?:--- |\+\+\+ )(?:[ab]\/|\/dev\/null)/.test(l)) {
        if (l.charAt(0) === '-') { cur.rem.push(l.slice(1)); } else if (l.charAt(0) === '+') { cur.add.push(l.slice(1)); }
      }
    });
    var out = [];
    hunks.forEach(function (h) { h.rem.forEach(function (x) { if (x.trim() && h.add.indexOf(x) >= 0 && out.indexOf(x) < 0) { out.push(x); } }); });
    return out;
  }

  // The rules of a self-contained widget live in ai_chat_deck_widget.js (also what the sandbox is built from); node loads it by require, the browser has it as a global.
  function widgetProblems(html) {
    var W = null;
    try { W = (typeof module === 'object' && module.exports) ? require('./deck_widget.js') : (typeof self !== 'undefined' ? self.AiChatDeckWidget : null); } catch (e) { W = null; }
    return W ? W.problems(html) : [];
  }

  // An interactive answer card. type: choice | multi | short | open | terminal; graded by the key it carries (static) or by a model (ai).
  function validateQuiz(v, vp, err, warn) {
    var QTYPES = ['choice', 'multi', 'short', 'open', 'terminal'];
    if (!str(v.question).trim()) { err(vp + '.question', 'kind "quiz" needs "question"'); }
    if (str(v.question).length > LIMITS.question) { err(vp + '.question', 'longer than ' + LIMITS.question + ' characters'); }
    var type = v.type || (Array.isArray(v.options) ? 'choice' : 'short');
    if (QTYPES.indexOf(type) < 0) { err(vp + '.type', 'must be one of ' + QTYPES.join(', ')); return; }
    if (v.grading != null && ['static', 'ai'].indexOf(v.grading) < 0) { err(vp + '.grading', 'must be static (the card carries the answer) or ai (a model scores it)'); }
    if (v.points != null && !(typeof v.points === 'number' && v.points >= 0 && v.points <= 100)) { err(vp + '.points', 'must be 0..100 (default 10)'); }
    if (str(v.explain).length > LIMITS.explain) { err(vp + '.explain', 'longer than ' + LIMITS.explain + ' characters'); }
    var hasKey = v.answer != null && v.answer !== '' && !(Array.isArray(v.answer) && !v.answer.length);
    var grading = v.grading || (type === 'terminal' ? (isObj(v.check) && (v.check.output || v.check.cmd) ? 'static' : 'ai') : type === 'open' ? 'ai' : (hasKey ? 'static' : 'ai'));
    if (type === 'choice' || type === 'multi') {
      if (!Array.isArray(v.options) || v.options.length < 2 || v.options.length > LIMITS.options) { err(vp + '.options', 'needs 2-' + LIMITS.options + ' options (a list of strings)'); }
      else {
        v.options.forEach(function (o, i) { if (!str(o).trim() || str(o).length > LIMITS.option) { err(vp + '.options[' + i + ']', 'a non-empty string of <= ' + LIMITS.option + ' characters'); } });
        if (grading === 'static') {
          var ans = Array.isArray(v.answer) ? v.answer : [v.answer];
          var okAns = hasKey && ans.every(function (a) { return (Number.isInteger(a) && a >= 0 && a < v.options.length) || (typeof a === 'string' && v.options.some(function (o) { return str(o).trim() === a.trim(); })); });
          if (!okAns) { err(vp + '.answer', 'the index (0-based) or text of the correct option' + (type === 'multi' ? 's (a list)' : '') + ' -- or set grading: ai with a "reference"'); }
          else if (type === 'choice' && ans.length !== 1) { err(vp + '.answer', 'a single-choice card has exactly one correct option (use type: multi for several)'); }
        }
      }
    } else if (type === 'short') {
      if (grading === 'static' && !hasKey && !(Array.isArray(v.accept) && v.accept.length)) { err(vp + '.answer', 'a static short-answer card needs "answer" (text or /regex/) or "accept": [..] -- or set grading: ai'); }
    } else if (type === 'terminal') {
      if (v.terminal != null) {
        if (!isObj(v.terminal) || (v.terminal.commands != null && (!Array.isArray(v.terminal.commands) || v.terminal.commands.length > LIMITS.commands || !v.terminal.commands.every(function (c) { return typeof c === 'string' && c.length <= LIMITS.command; })))) { err(vp + '.terminal', '{commands: [shell lines run first (setup)]}'); }
      }
      if (grading === 'static') {
        if (!isObj(v.check) || !(str(v.check.output).trim() || str(v.check.cmd).trim())) { err(vp + '.check', 'a static terminal card needs check: {output: <text or /regex/ the screen must show>, cmd: <what must have been typed>}'); }
      }
    }
    if (grading === 'ai' && !str(v.reference).trim() && !str(v.rubric).trim() && !hasKey) { err(vp, 'an AI-graded card needs "reference" (the model answer) and/or "rubric" (what earns points)'); }
    ['reference', 'rubric'].forEach(function (f) { if (str(v[f]).length > 1200) { err(vp + '.' + f, 'longer than 1200 characters'); } });
    if (v.wait != null && typeof v.wait !== 'boolean') { err(vp + '.wait', 'true: the deck waits at the end of this slide until the card is answered (or skipped)'); }
  }

  // Defaults for one visual (and, in a group, its items): loop mode, and a gentle motion on the still kinds so nothing is ever a dead picture.
  function normalizeVisual(src, depth) {
    var visual = Object.assign({}, src);
    visual.mode = visual.mode || 'loop';
    var m = visual.motion;
    var still = ['svg', 'mermaid', 'chart', 'image'].indexOf(visual.kind) >= 0;
    visual.motion = isObj(m) ? Object.assign({ period: 6 }, m) : { type: m || (still ? (visual.kind === 'image' && (visual.images || []).length > 1 ? 'none' : 'float') : 'none'), period: 6 };
    if (visual.kind === 'quiz' && !visual.type) { visual.type = Array.isArray(visual.options) ? 'choice' : 'short'; }
    // an answer card holds the deck at the end of its slide until it is answered (wait: false lets the deck run past it; the viewer can always page on)
    if (visual.kind === 'quiz' && visual.wait == null) { visual.wait = true; }
    // an interactive terminal waits for the viewer to type (a slide that shows a terminal without asking anything sets wait: false or interactive: false)
    if (visual.kind === 'terminal' && visual.wait == null) { visual.wait = visual.interactive !== false; }
    // a widget (game) does not start by itself: the viewer clicks, then a 3-2-1 countdown (start: click | auto change that)
    if (visual.kind === 'widget' && !visual.start) { visual.start = 'countdown'; }
    if (visual.kind === 'group' && depth === 0) { visual.items = visual.items.map(function (it) { return normalizeVisual(it, 1); }); }
    return visual;
  }

  // Narration is spoken and shown as subtitles, so markup a model sometimes writes into it ("<code>ls</code>", `ls`, **bold**) is removed: the text-to-speech
  // service refuses HTML (422) and a subtitle must not show tags.
  function speakable(text) {
    return str(text).replace(/<\/?(?:code|kbd|b|i|em|strong|tt|pre|span)[^>]*>/gi, '').replace(/`([^`\n]+)`/g, '$1').replace(/\*\*([^*\n]+)\*\*/g, '$1');
  }

  // A question about code / a patch must have that code on the SAME slide (see MediaDeckValidator.check_quiz_references); only a warning here -- a saved deck still plays.
  var QUIZ_BACK_REFERENCE = /剛才|剛剛|上面|前面|上一頁|上一張|先前|稍早|前一頁|above|previous slide|earlier|last slide|the (?:patch|code|listing|diff)\b|這個 ?patch|該 ?patch|這份 ?patch|此 ?patch|patch ?中|patch ?裡|程式碼中|程式碼裡|程式中|這段程式/i;
  function checkQuizReferences(doc, warn) {
    var flat = [];
    (doc.chapters || []).forEach(function (ch, ci) { ((ch && ch.slides) || []).forEach(function (s, si) { if (isObj(s)) { flat.push({ path: 'chapters[' + ci + '].slides[' + si + ']', s: s }); } }); });
    flat.forEach(function (e, i) {
      var v = e.s.visual;
      if (!isObj(v) || v.kind !== 'quiz') { return; }
      var text = [e.s.title, e.s.narration, v.question].concat(Array.isArray(v.options) ? v.options : []).join(' ');
      if (!QUIZ_BACK_REFERENCE.test(text)) { return; }
      var shows = flat.slice(Math.max(0, i - 2), i).some(function (p) {
        var ev = p.s.visual;
        return isObj(ev) && (ev.kind === 'code' || (ev.kind === 'group' && (ev.items || []).some(function (it) { return isObj(it) && it.kind === 'code'; })));
      });
      if (shows) { warn(e.path, 'this question refers to code / a patch on an earlier slide, but the viewer cannot see it while answering -- put the code and the card in one slide (a group: code on the left, the card on the right)'); }
    });
  }

  // Builds the flat, defaulted deck the renderer/player use. Throws (message = all errors) when invalid.
  function normalize(doc) {
    var v = validate(doc);
    if (v.errors.length) { var e = new Error(v.errors.join('\n')); e.errors = v.errors; throw e; }
    var deck = Object.assign({ lang: 'zh-TW', theme: 'default', aspect: '16:9', speed: 1, style: 'flat', environment: 'template' }, doc.deck);
    var slides = [], chapters = [];
    doc.chapters.forEach(function (ch, ci) {
      chapters.push({ index: ci, title: str(ch.title), id: ch.id || ('ch' + (ci + 1)), first: slides.length });
      ch.slides.forEach(function (s) {
        var n = slides.length;
        var visual = s.visual ? Object.assign({}, s.visual) : null;
        var bullets = Array.isArray(s.bullets) ? s.bullets.slice() : [];
        var layout = s.layout;
        if (!layout) {
          if (n === 0 && !bullets.length && !visual) { layout = 'title'; }
          else if (visual && bullets.length) { layout = 'split'; }
          else if (visual) { layout = 'visual'; }
          else if (!bullets.length && !str(s.narration).trim()) { layout = 'topic'; }
          else { layout = 'content'; }
        }
        if (layout === 'content' && visual) { layout = 'split'; }
        // an interactive piece (answer card, code window, terminal, widget) with no bullets beside it gets the whole area, not half a slide of blank space
        if ((layout === 'split' || layout === 'content') && visual && !bullets.length && ['quiz', 'widget', 'code', 'terminal', 'group'].indexOf(visual.kind) >= 0) { layout = 'visual'; }
        if (visual) { visual = normalizeVisual(visual, 0); }
        var tr = s.transition ? Object.assign({ ms: 500 }, s.transition) : { type: n === 0 ? 'none' : (deck.style === '3d' ? 'fly' : 'fade'), ms: deck.style === '3d' ? 1400 : 500 };
        slides.push({ id: s.id || ('s' + (n + 1)), index: n, chapter: ci, chapterTitle: str(ch.title), layout: layout, title: str(s.title),
          subtitle: str(s.subtitle), bullets: bullets, narration: speakable(s.narration), notes: str(s.notes), visual: visual, cues: Array.isArray(s.cues) ? s.cues : [],
          transition: tr, duration: typeof s.duration === 'number' ? s.duration : 0, stage: s.stage || deck.style,
          camera: s.camera == null ? null : (Array.isArray(s.camera) ? s.camera : [s.camera]).map(function (c) { return typeof c === 'string' ? { preset: c } : Object.assign({}, c); }) });
      });
    });
    return { kind: KIND, deck: deck, chapters: chapters, slides: slides, warnings: v.warnings };
  }

  function parseDeck(text, yaml) {
    var doc = yaml.load(text);
    return normalize(doc);
  }

  // The images a slide asks for (for the loader): urls in order.
  function visualImageSources(visual) {
    if (!visual) { return []; }
    if (visual.kind === 'image') { return (Array.isArray(visual.images) ? visual.images : [{ src: visual.src }]).map(function (i) { return i.src; }); }
    return [];
  }

  // ------------------------------------------------------------------ per-slide timing
  // audioSec: real narration length (0/undefined = unknown -> estimated). sceneSec: length of a 2D scene (timed mode).
  function timingFor(slide, audioSec, sceneSec) {
    var sents = splitSentences(slide.narration);
    var hasNarr = sents.length > 0;
    var known = audioSec > 0;
    var narr = hasNarr ? (known ? audioSec : estimateSeconds(slide.narration)) : 0;
    var lead = hasNarr ? LEAD : 0;
    var spans = distribute(sents, narr, lead);
    var vis = slide.visual && slide.visual.mode === 'timed' && sceneSec > 0 ? sceneSec : 0;
    var dur = Math.max(slide.duration || 0, hasNarr ? lead + narr + TAIL : 0, vis, hasNarr ? MIN_SLIDE : (slide.duration ? 1 : MIN_SILENT));
    return { sentences: spans, narrStart: lead, narrSec: narr, duration: dur, audioKnown: known, silent: !hasNarr };
  }

  // Whole-deck timeline. timings[i] = timingFor(...). The transition INTO slide i (i>0) runs first, then its body.
  function buildTimeline(deck, timings) {
    var t = 0, segs = [];
    deck.slides.forEach(function (s, i) {
      var tm = timings[i] || timingFor(s, 0, 0);
      var tdur = i > 0 && s.transition.type !== 'none' ? s.transition.ms / 1000 : 0;
      var seg = { i: i, transStart: t, transDur: tdur, bodyStart: t + tdur, bodyDur: tm.duration, end: t + tdur + tm.duration };
      segs.push(seg);
      t = seg.end;
    });
    return { segs: segs, total: t };
  }

  // -> {i, phase:'transition'|'body', p (transition progress 0..1), t (seconds into the slide body)}
  function locate(tl, T) {
    var segs = tl.segs;
    if (!segs.length) { return { i: 0, phase: 'body', p: 0, t: 0 }; }
    T = clamp(T, 0, Math.max(0, tl.total - 1e-6));
    for (var k = 0; k < segs.length; k++) {
      var s = segs[k];
      if (T < s.end || k === segs.length - 1) {
        if (T < s.bodyStart) { return { i: k, phase: 'transition', p: s.transDur ? (T - s.transStart) / s.transDur : 1, t: 0 }; }
        return { i: k, phase: 'body', p: 1, t: T - s.bodyStart };
      }
    }
    return { i: segs.length - 1, phase: 'body', p: 1, t: 0 };
  }

  // ------------------------------------------------------------------ cue schedule
  // -> [{kind:'show'|'emphasize', target, at (sec into slide body), effect, ms}]
  function cueSchedule(slide, timing) {
    var out = [];
    var sents = timing.sentences;
    function atSec(at) {
      if (at.sec != null) { return at.sec; }
      var sp = sents[Math.min(sents.length, at.sentence) - 1];
      return sp ? sp.start : 0;
    }
    slide.cues.forEach(function (c) {
      var which = c.show != null ? 'show' : 'emphasize';
      var at = parseAt(c.at), tgt = parseTarget(c[which]);
      if (!at || !tgt) { return; }
      out.push({ kind: which, target: tgt, key: targetKey(tgt), at: atSec(at), effect: c.effect || (which === 'emphasize' ? 'pulse' : (tgt.type === 'bullet' ? 'rise' : 'fade')), ms: c.ms || (which === 'emphasize' ? 900 : 600) });
    });
    // No explicit cue for any bullet: reveal them one per sentence (skipping an intro sentence when there are spare ones), or evenly.
    var hasBulletCue = out.some(function (c) { return c.kind === 'show' && c.target.type === 'bullet'; });
    if (!hasBulletCue && slide.bullets.length > 1) {
      var n = slide.bullets.length;
      slide.bullets.forEach(function (_b, i) {
        var at;
        if (sents.length) {
          var si = sents.length > n ? i + 1 : Math.min(i, sents.length - 1);
          at = sents[si].start;
        } else { at = 0.4 + i * 0.7; }
        out.push({ kind: 'show', target: { type: 'bullet', index: i }, key: 'bullet:' + i, at: at, effect: 'rise', ms: 600 });
      });
    }
    // Table rows reveal the same way when not cued.
    var v = slide.visual;
    var hasRowCue = out.some(function (c) { return c.target.type === 'row'; });
    if (v && v.kind === 'table' && !hasRowCue && v.rows.length > 1) {
      var span = sents.length ? Math.max(0.5, timing.narrStart + timing.narrSec - 0.5) : 0.4 + v.rows.length * 0.5;
      v.rows.forEach(function (_r, i) {
        out.push({ kind: 'show', target: { type: 'row', index: i }, key: 'row:' + i, at: 0.4 + (span - 0.4) * i / v.rows.length, effect: 'fade', ms: 500 });
      });
    }
    return out;
  }

  // Where is element `key` at slide time t? -> {p (0..1 visible), effect, pulse (0..1)}
  function elementState(schedule, key, t) {
    var show = null, pulse = 0;
    schedule.forEach(function (c) {
      if (c.key !== key) { return; }
      if (c.kind === 'show' && !show) { show = c; }
      if (c.kind === 'emphasize') {
        var d = (t - c.at) / (c.ms / 1000);
        if (d >= 0 && d <= 1) { pulse = Math.max(pulse, Math.sin(Math.PI * d)); }
      }
    });
    if (!show) { return { p: 1, effect: null, pulse: pulse }; }
    return { p: clamp((t - show.at) / (show.ms / 1000), 0, 1), effect: show.effect, pulse: pulse };
  }

  // ------------------------------------------------------------------ drawing helpers
  function setFont(ctx, px, bold) { ctx.font = (bold ? 'bold ' : '') + px + 'px ' + FONT; }

  // Greedy wrap that breaks CJK anywhere and latin at spaces.
  function wrapLines(ctx, text, maxW) {
    var tokens = str(text).match(/[A-Za-z0-9_'’\-.,:;!?()\/%+#@&=*<>]+|\s+|[\s\S]/g) || [];
    var lines = [], line = '';
    tokens.forEach(function (tok) {
      if (/^\s+$/.test(tok)) { if (line) { line += ' '; } return; }
      var test = line + tok;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line.replace(/\s+$/, '')); line = tok; } else { line = test; }
    });
    if (line) { lines.push(line.replace(/\s+$/, '')); }
    return lines;
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Runs fn() with the entrance effect `st` ({p, effect, pulse}) applied around `box` {x,y,w,h}.
  function withEffect(ctx, st, box, fn) {
    if (st.p <= 0) { return; }
    ctx.save();
    var p = st.p, e = st.effect;
    ctx.globalAlpha *= easeOut(Math.min(1, p * 1.6));
    if (e === 'rise') { ctx.translate(0, (1 - easeOut(p)) * 48); }
    else if (e === 'pop') {
      var s = 0.82 + 0.18 * easeOutBack(p);
      ctx.translate(box.x + box.w / 2, box.y + box.h / 2); ctx.scale(s, s); ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
    } else if (e === 'wipe') {
      ctx.beginPath(); ctx.rect(box.x - 8, box.y - 8, (box.w + 16) * easeOut(p), box.h + 16); ctx.clip(); ctx.globalAlpha = 1;
    }
    if (st.pulse > 0) {
      var k = 1 + 0.06 * st.pulse;
      ctx.translate(box.x + box.w / 2, box.y + box.h / 2); ctx.scale(k, k); ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
    }
    fn();
    ctx.restore();
  }

  // Slide geometry in the 1920x1080 design space (measured from the real template, see DESIGN.md 8.4: 144 px per inch).
  var GEO = {
    header: { x: 63, y: 55, w: 1721, h: 114 },
    area: { x: 63, y: 195, w: 1794, h: 690 },
    subtitle: { x: 160, y: 905, w: 1600, h: 140 }
  };

  function visualRect(layout) {
    var a = GEO.area;
    if (layout === 'visual') { return { x: a.x, y: a.y, w: a.w, h: a.h }; }
    return { x: TPL.split.visualX, y: a.y, w: TPL.split.visualW, h: a.h }; // split: bullets on the left, visual on the right
  }

  // ------------------------------------------------------------------ slide rendering
  // info = { assets:{titleBg, topicBg, contentBg, logo}, preps:[{visual:{draw,duration}|null, timing}], subtitles:bool,
  //          makeCanvas(w,h) }
  function drawBackground(ctx, kind, assets) {
    var img = kind === 'title' ? assets.titleBg : (kind === 'topic' ? assets.topicBg : assets.contentBg);
    if (img) { ctx.drawImage(img, 0, 0, W, H); return; }
    ctx.fillStyle = kind === 'content' ? COLORS.contentBg : COLORS.dark;
    ctx.fillRect(0, 0, W, H);
    if (kind === 'content') { ctx.fillStyle = COLORS.accent; ctx.fillRect(0, 0, W, TPL.contentBar.h); }
  }

  function drawTitleSlide(ctx, slide, sched, t, info) {
    drawBackground(ctx, 'title', info.assets);
    var lg = TPL.logo, tt = TPL.title;
    if (info.assets.logo) { ctx.drawImage(info.assets.logo, lg.x, lg.y, lg.w, lg.h); }
    var st = elementState(sched, 'title', t);
    withEffect(ctx, st, { x: tt.x, y: tt.y, w: tt.w, h: tt.h }, function () {
      ctx.fillStyle = COLORS.titleText; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      var px = tt.size; setFont(ctx, px, true);
      var lines = wrapLines(ctx, slide.title, tt.w);
      while (lines.length > 2 && px > tt.minSize) { px -= 6; setFont(ctx, px, true); lines = wrapLines(ctx, slide.title, tt.w); }
      lines.forEach(function (l, i) { ctx.fillText(l, tt.x, tt.y + i * px * 1.25); });
      if (slide.subtitle) { setFont(ctx, tt.subtitleSize, true); ctx.fillStyle = COLORS.accent; ctx.fillText(slide.subtitle, tt.x, tt.y + lines.length * px * 1.25 + 24); }
    });
  }

  function drawTopicSlide(ctx, slide, sched, t, info) {
    drawBackground(ctx, 'topic', info.assets);
    var tp = TPL.topic, cx = tp.x + tp.w / 2, cy = tp.y + tp.h / 2;
    ctx.fillStyle = COLORS.accent; ctx.fillRect(0, 0, W, tp.topBar);
    var st = elementState(sched, 'title', t);
    withEffect(ctx, st, { x: tp.x, y: tp.y, w: tp.w, h: tp.h }, function () {
      ctx.fillStyle = COLORS.titleText; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var px = tp.size; setFont(ctx, px, true);
      var lines = wrapLines(ctx, slide.title, tp.w);
      while (lines.length > 2 && px > tp.minSize) { px -= 6; setFont(ctx, px, true); lines = wrapLines(ctx, slide.title, tp.w); }
      var y0 = cy - (lines.length - 1) * px * 0.62;
      lines.forEach(function (l, i) { ctx.fillText(l, cx, y0 + i * px * 1.25); });
      ctx.fillStyle = COLORS.accent; ctx.fillRect(tp.rule.x, tp.rule.y, tp.rule.w, tp.rule.h);
    });
  }

  function drawContentHeader(ctx, slide, sched, t, info, noBackground) {
    if (!noBackground) { drawBackground(ctx, 'content', info.assets); }
    var h = GEO.header;
    var st = elementState(sched, 'title', t);
    withEffect(ctx, st, h, function () {
      ctx.fillStyle = COLORS.heading; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      var px = TPL.header.size; setFont(ctx, px, true);
      var lines = wrapLines(ctx, slide.title, h.w - 360);
      while (lines.length > 1 && px > TPL.header.minSize) { px -= 4; setFont(ctx, px, true); lines = wrapLines(ctx, slide.title, h.w - 360); }
      ctx.fillText(lines[0] || '', h.x, h.y + h.h / 2);
    });
    // chapter label, top right
    ctx.fillStyle = COLORS.accent; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; setFont(ctx, TPL.header.labelSize, true);
    ctx.fillText((slide.chapter + 1) + ' · ' + slide.chapterTitle, h.x + h.w, TPL.header.labelY);
  }

  function drawBullets(ctx, slide, sched, t, rect) {
    var n = slide.bullets.length;
    if (!n) { return; }
    var bl = TPL.bullets, px = bl.size, lineH, lines, total, gap = bl.gap, maxW = rect.w - 70;
    for (; px >= bl.minSize; px -= 2) {
      setFont(ctx, px, false);
      lines = slide.bullets.map(function (b) { return wrapLines(ctx, b, maxW); });
      lineH = px * 1.34;
      total = lines.reduce(function (a, l) { return a + l.length * lineH + gap; }, -gap);
      if (total <= rect.h) { break; }
    }
    var y = rect.y + Math.max(0, Math.min(40, (rect.h - total) / 2));
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    slide.bullets.forEach(function (_b, i) {
      var h = lines[i].length * lineH;
      var box = { x: rect.x, y: y, w: rect.w, h: h };
      withEffect(ctx, elementState(sched, 'bullet:' + i, t), box, function () {
        ctx.fillStyle = COLORS.accent; ctx.beginPath(); ctx.arc(rect.x + 14, y + px * 0.62, bl.dot, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = COLORS.body; setFont(ctx, px, false);
        lines[i].forEach(function (l, k) { ctx.fillText(l, rect.x + 50, y + k * lineH); });
      });
      y += h + gap;
    });
  }

  function motionTransform(ctx, motion, rect, t) {
    var type = motion && motion.type, period = (motion && motion.period) || 6;
    if (!type || type === 'none') { return; }
    var ph = 2 * Math.PI * t / period, cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    if (type === 'float') { ctx.translate(0, Math.sin(ph) * 10); }
    else if (type === 'pulse') { var k = 1 + 0.03 * Math.sin(ph); ctx.translate(cx, cy); ctx.scale(k, k); ctx.translate(-cx, -cy); }
    else if (type === 'spin') { ctx.translate(cx, cy); ctx.rotate(ph); ctx.translate(-cx, -cy); }
    else if (type === 'kenburns') {
      var f = 0.5 - 0.5 * Math.cos(ph / 2), k2 = 1 + 0.08 * f;
      ctx.translate(cx, cy); ctx.scale(k2, k2); ctx.translate(-cx + (-20 * f), -cy + (-12 * f));
    }
  }

  function drawTable(ctx, v, sched, t, rect) {
    var cols = v.header.length, rows = v.rows.length;
    var colW = [], i, j;
    setFont(ctx, 28, true);
    var maxLens = v.header.map(function (h) { return Math.max(4, str(h).length); });
    v.rows.forEach(function (r) { r.forEach(function (c, k) { var l = 0; for (var q = 0; q < str(c).length; q++) { l += isCjk(str(c).charAt(q)) ? 2 : 1; } maxLens[k] = Math.max(maxLens[k], Math.min(l, 40)); }); });
    var tw = maxLens.reduce(function (a, b) { return a + b; }, 0);
    for (j = 0; j < cols; j++) { colW.push(Math.max(rect.w * 0.1, rect.w * maxLens[j] / tw)); }
    var sum = colW.reduce(function (a, b) { return a + b; }, 0);
    colW = colW.map(function (w) { return w * rect.w / sum; });
    var px = 30, wrapped, rowH, total, pad = 14;
    for (; px >= 18; px -= 2) {
      setFont(ctx, px, false);
      wrapped = v.rows.map(function (r) { return r.map(function (c, k) { return wrapLines(ctx, str(c), colW[k] - pad * 2); }); });
      rowH = wrapped.map(function (r) { return Math.max.apply(null, r.map(function (l) { return l.length; })) * px * 1.3 + pad * 1.4; });
      total = px * 1.3 + pad * 2 + rowH.reduce(function (a, b) { return a + b; }, 0);
      if (total <= rect.h) { break; }
    }
    var headH = px * 1.3 + pad * 2, y = rect.y, x;
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.heading; roundRect(ctx, rect.x, y, rect.w, headH, 10); ctx.fill();
    ctx.fillStyle = COLORS.white; setFont(ctx, px, true); x = rect.x;
    for (j = 0; j < cols; j++) { ctx.fillText(str(v.header[j]), x + pad, y + pad); x += colW[j]; }
    y += headH;
    for (i = 0; i < rows; i++) {
      var box = { x: rect.x, y: y, w: rect.w, h: rowH[i] };
      withEffect(ctx, elementState(sched, 'row:' + i, t), box, function () {
        ctx.fillStyle = i % 2 ? COLORS.stripe : COLORS.contentBg; ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.fillStyle = COLORS.soft; ctx.fillRect(box.x, box.y + box.h - 1, box.w, 1);
        ctx.fillStyle = COLORS.body; setFont(ctx, px, false); var cx = rect.x;
        for (var c = 0; c < cols; c++) { wrapped[i][c].forEach(function (l, k) { ctx.fillText(l, cx + pad, box.y + pad * 0.7 + k * px * 1.3); }); cx += colW[c]; }
      });
      y += rowH[i];
    }
  }

  // Image(s) with optional caption, slideshow crossfade and callout boxes.
  function drawImages(ctx, v, prepVisual, sched, t, rect) {
    var list = Array.isArray(v.images) ? v.images : [{ src: v.src, caption: v.caption }];
    var n = list.length;
    var per = v.period && n > 1 ? v.period : 5;
    // an "image:i" show cue pins when image i appears; otherwise images take turns every `per` seconds
    var cued = sched.some(function (c) { return c.target.type === 'image'; });
    var idx = 0;
    if (n > 1) {
      if (cued) { for (var i = 0; i < n; i++) { if (elementState(sched, 'image:' + i, t).p > 0 || i === 0) { idx = i; } } }
      else { idx = Math.floor(t / per) % n; }
    }
    var capH = 0;
    function drawOne(i, alpha) {
      var img = prepVisual && prepVisual.images && prepVisual.images[i];
      var caption = str(list[i].caption);
      var ch = caption ? 64 : 0;
      var box = { x: rect.x, y: rect.y, w: rect.w, h: rect.h - ch };
      ctx.save(); ctx.globalAlpha *= alpha;
      if (img && img.width) {
        var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        var cover = v.fit === 'cover';
        var s = cover ? Math.max(box.w / iw, box.h / ih) : Math.min(box.w / iw, box.h / ih);
        var dw = iw * s, dh = ih * s, dx = box.x + (box.w - dw) / 2, dy = box.y + (box.h - dh) / 2;
        ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
        ctx.fillStyle = '#FFFFFF'; ctx.shadowColor = 'rgba(0,0,0,0.18)'; ctx.shadowBlur = 24;
        if (!cover) { roundRect(ctx, dx - 6, dy - 6, dw + 12, dh + 12, 14); ctx.fill(); }
        ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.restore();
        if (i === 0 || n === 1 || true) { v._imgBox = { x: dx, y: dy, w: dw, h: dh }; }
      } else {
        ctx.fillStyle = COLORS.soft; roundRect(ctx, box.x, box.y, box.w, box.h, 14); ctx.fill();
        ctx.fillStyle = '#888888'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; setFont(ctx, 30, false);
        ctx.fillText(prepVisual && prepVisual.failed && prepVisual.failed[i] ? '圖片無法載入' : '載入圖片中…', box.x + box.w / 2, box.y + box.h / 2);
        v._imgBox = null;
      }
      if (caption) {
        ctx.fillStyle = '#555555'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; setFont(ctx, 28, false);
        ctx.fillText(caption, rect.x + rect.w / 2, rect.y + rect.h - 30);
      }
      ctx.restore();
    }
    var tIn = n > 1 && !cued ? (t % per) : 99;
    if (n > 1 && !cued && tIn < 0.5 && t >= per) { drawOne((idx + n - 1) % n, 1 - tIn / 0.5); drawOne(idx, tIn / 0.5); } else { drawOne(idx, 1); }
    capH = list[idx] && list[idx].caption ? 64 : 0;
    // callouts: boxes in fractions of the shown image
    var cs = Array.isArray(v.callouts) ? v.callouts : [];
    if (cs.length && v._imgBox && idx === 0) {
      var ib = v._imgBox;
      cs.forEach(function (c, k) {
        var box = { x: ib.x + c.x * ib.w, y: ib.y + c.y * ib.h, w: c.w * ib.w, h: c.h * ib.h };
        var st = elementState(sched, 'callout:' + k, t);
        if (!sched.some(function (q) { return q.key === 'callout:' + k && q.kind === 'show'; })) { st = { p: 0, effect: 'fade', pulse: 0 }; }
        withEffect(ctx, st, box, function () {
          ctx.strokeStyle = '#E8590C'; ctx.lineWidth = 6; roundRect(ctx, box.x, box.y, box.w, box.h, 10); ctx.stroke();
          if (c.text) {
            setFont(ctx, 28, true);
            var tw = Math.min(ctx.measureText(c.text).width + 28, 620), ty = box.y > rect.y + 60 ? box.y - 56 : box.y + box.h + 8;
            ctx.fillStyle = '#E8590C'; roundRect(ctx, box.x, ty, tw, 48, 10); ctx.fill();
            ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(c.text, box.x + 14, ty + 25);
          }
        });
      });
    }
    return capH;
  }

  // The 3D model (the stage's performer) of a prepared visual: the visual itself or the first item of a group that has one.
  function findModel(v, pv) {
    if (!v || !pv) { return null; }
    if (v.kind === 'group') {
      for (var i = 0; i < (v.items || []).length; i++) { var m = findModel(v.items[i], (pv.children || [])[i]); if (m) { return m; } }
      return null;
    }
    return v.kind === 'scene3d' && pv.model ? { model: pv.model, node: v, pv: pv } : null;
  }

  function visualTime(v, pv, t) {
    var dur = (pv && pv.duration) || (v.scene && v.scene.duration) || 4;
    return v.mode === 'timed' ? Math.min(t, Math.max(0, dur - 0.0005)) : (t % Math.max(v.period || dur, 0.001));
  }

  function shapeFx(sched, t) {
    var fx = {};
    sched.forEach(function (c) { if (c.target.type === 'shape') { fx[c.target.id] = elementState(sched, c.key, t); } });
    return fx;
  }

  // One non-group visual in its rect (a leaf). opts.skipModel: the stage draws 3D models itself.
  function drawLeaf(ctx, v, pv, sched, t, rect, opts) {
    pv = pv || {};
    ctx.save();
    motionTransform(ctx, v.motion, rect, t);
    if (v.kind === 'table') { drawTable(ctx, v, sched, t, rect); }
    else if (v.kind === 'image') { drawImages(ctx, v, pv, sched, t, rect); }
    else if (v.kind === 'scene3d' && opts && opts.skipModel && pv.model) { /* the 3D stage draws it */ }
    else if (pv.draw) { pv.draw(ctx, rect, visualTime(v, pv, t), shapeFx(sched, t)); }
    else {
      ctx.fillStyle = COLORS.soft; roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 14); ctx.fill();
      ctx.fillStyle = '#888888'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; setFont(ctx, 30, false);
      ctx.fillText(pv.failed === true ? '視覺無法載入' : '載入視覺中…', rect.x + rect.w / 2, rect.y + rect.h / 2);
    }
    ctx.restore();
  }

  function boxRect(rect, b) { return { x: rect.x + b[0] * rect.w, y: rect.y + b[1] * rect.h, w: b[2] * rect.w, h: b[3] * rect.h }; }

  // A visual node: a leaf, or a group of boxed leaves (2D and 3D side by side), then its 2D overlay on top of the whole rect.
  function drawNode(ctx, v, pv, sched, t, rect, opts) {
    pv = pv || {};
    if (v.kind === 'group') {
      (v.items || []).forEach(function (item, i) {
        var r = boxRect(rect, item.box);
        withEffect(ctx, { p: 1, effect: null, pulse: 0 }, r, function () { drawNode(ctx, item, (pv.children || [])[i], sched, t, r, opts); });
      });
    } else { drawLeaf(ctx, v, pv, sched, t, rect, opts); }
    if (v.overlay && pv.overlay && pv.overlay.draw) {
      ctx.save();
      pv.overlay.draw(ctx, rect, visualTime(Object.assign({}, v, { period: v.overlay.period || v.period }), pv.overlay, t), shapeFx(sched, t));
      ctx.restore();
    }
  }

  // The parts of a slide's visual the viewer can operate (a code window to scroll, a live terminal, an answer card): [{kind, node, pv, rect}],
  // rect in design units. The player puts its pointer handling / DOM inputs there; the renderer does not care.
  var INTERACTIVE_KINDS = ['code', 'terminal', 'quiz', 'widget'];
  function interactiveRegions(slide, prep) {
    var out = [];
    if (!slide.visual || slide.layout === 'title' || slide.layout === 'topic') { return out; }
    var area = visualRect(slide.layout === 'visual' ? 'visual' : 'split');
    function walk(v, pv, rect) {
      if (!v) { return; }
      if (v.kind === 'group') { (v.items || []).forEach(function (it, i) { walk(it, (pv && pv.children || [])[i], boxRect(rect, it.box)); }); }
      else if (INTERACTIVE_KINDS.indexOf(v.kind) >= 0) { out.push({ kind: v.kind, node: v, pv: pv || {}, rect: rect }); }
    }
    walk(slide.visual, prep && prep.visual, area);
    return out;
  }

  function drawVisual(ctx, slide, prep, sched, t, rect, opts) {
    var v = slide.visual;
    if (!v) { return; }
    var vstate = elementState(sched, 'visual', t);
    withEffect(ctx, vstate, rect, function () { drawNode(ctx, v, prep.visual, sched, t, rect, opts); });
  }

  function currentSentence(timing, t) {
    var ss = timing.sentences;
    for (var i = 0; i < ss.length; i++) { if (t >= ss[i].start && t < ss[i].end + (i === ss.length - 1 ? 0.4 : 0)) { return ss[i]; } }
    return null;
  }

  function drawSubtitle(ctx, timing, t) {
    var s = currentSentence(timing, t);
    if (!s) { return; }
    var g = GEO.subtitle, px = TPL.subtitle.size;
    setFont(ctx, px, false);
    var lines = wrapLines(ctx, s.text, g.w - 70);
    while (lines.length > 2 && px > TPL.subtitle.minSize) { px -= 2; setFont(ctx, px, false); lines = wrapLines(ctx, s.text, g.w - 70); }
    var h = lines.length * px * 1.35 + 30, y = g.y + g.h - h - 6;
    ctx.fillStyle = COLORS.subtitleBar; roundRect(ctx, g.x, y, g.w, h, TPL.subtitle.radius); ctx.fill();
    ctx.fillStyle = COLORS.subtitleText; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    lines.forEach(function (l, i) { ctx.fillText(l, g.x + g.w / 2, y + 15 + i * px * 1.35); });
  }

  // Draws one slide at slide-time t into ctx (the caller has already scaled ctx so the design space is 1920x1080).
  function drawSlide(ctx, deck, slide, t, info) {
    var prep = info.preps[slide.index] || {};
    var timing = prep.timing || timingFor(slide, 0, 0);
    var sched = cueSchedule(slide, timing);
    ctx.save();
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    if (slide.layout === 'title') { drawTitleSlide(ctx, slide, sched, t, info); }
    else if (slide.layout === 'topic') { drawTopicSlide(ctx, slide, sched, t, info); }
    else {
      drawContentHeader(ctx, slide, sched, t, info);
      var a = GEO.area;
      if (slide.layout === 'visual') { drawVisual(ctx, slide, prep, sched, t, visualRect('visual')); }
      else if (slide.layout === 'split') {
        drawBullets(ctx, slide, sched, t, { x: a.x, y: a.y, w: TPL.split.bulletsW, h: a.h });
        drawVisual(ctx, slide, prep, sched, t, visualRect('split'));
      } else { drawBullets(ctx, slide, sched, t, a); }
    }
    if (info.subtitles !== false) { drawSubtitle(ctx, timing, t); }
    ctx.restore();
  }

  // ------------------------------------------------------------------ transitions + whole frame
  function drawTransition(ctx, type, p, a, b) {
    type = FLAT_OF[type] || type;
    p = clamp(p, 0, 1);
    var e = easeInOut(p);
    ctx.save();
    if (type === 'fade') {
      ctx.drawImage(a, 0, 0, W, H); ctx.globalAlpha = e; ctx.drawImage(b, 0, 0, W, H);
    } else if (type === 'slide-left') {
      ctx.drawImage(a, 0, 0, W, H); ctx.drawImage(b, W * (1 - e), 0, W, H);
    } else if (type === 'slide-right') {
      ctx.drawImage(a, 0, 0, W, H); ctx.drawImage(b, -W * (1 - e), 0, W, H);
    } else if (type === 'push') {
      ctx.drawImage(a, -W * e, 0, W, H); ctx.drawImage(b, W * (1 - e), 0, W, H);
    } else if (type === 'zoom') {
      ctx.drawImage(a, 0, 0, W, H);
      var s = 0.8 + 0.2 * e; ctx.globalAlpha = e;
      ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2); ctx.drawImage(b, 0, 0, W, H);
    } else if (type === 'wipe') {
      ctx.drawImage(a, 0, 0, W, H);
      ctx.beginPath(); ctx.rect(0, 0, W * e, H); ctx.clip(); ctx.drawImage(b, 0, 0, W, H);
    } else { ctx.drawImage(b, 0, 0, W, H); }
    ctx.restore();
  }

  // One reusable offscreen canvas per role: a frame is drawn thousands of times in an export, a new canvas each time would flood the GC.
  function scratch(info, key, w, h) {
    info.scratchPool = info.scratchPool || {};
    var c = info.scratchPool[key];
    if (!c || c.width !== w || c.height !== h) { c = info.makeCanvas(w, h); c.width = w; c.height = h; info.scratchPool[key] = c; }
    return c;
  }

  // Mermaid reads `[/text/]` and `[\text\]` as parallelogram / trapezoid nodes, so a plain label such as `Help[/help]` (a slash command) or one
  // with parentheses is a syntax error. Quote the labels that would be misread; real shapes (`[/text/]`) and quoted labels are left alone.
  function fixMermaidSource(src) {
    return str(src).replace(/(\b[\w-]+)\[([^\]\["]+)\]/g, function (m, id, text) {
      var t = text.trim();
      if (t.length > 2 && /^[\/\\].*[\/\\]$/.test(t)) { return m; }
      if (/^[\/\\]|[()]/.test(t)) { return id + '["' + t.replace(/"/g, '#quot;') + '"]'; }
      return m;
    });
  }

  // ------------------------------------------------------------------ the 3D view (a slide with stage "3d" and a 3D model)
  // The slide keeps the company template. A content slide (split / visual layout) is the SAME page as a flat one -- template background,
  // title, chapter label, bullets, subtitle bar -- and its 3D model is shown through a VIEWPORT: a rounded window in the place where a flat
  // slide has its visual, with the slide's camera (info.stage3d, ai_chat_deck_stage3d.js) looking into a 3D scene. A title / topic slide
  // with a model is full-bleed 3D on the template's navy with the title in front. Everything flat the slide has (tables, images, diagrams,
  // 2D shapes, other group items, a 2D overlay over the model) is drawn flat over the page, so 2D and 3D mix freely. A slide that
  // has no 3D model is drawn as a flat slide even if its stage is "3d".
  var STAGE_AREA = { x: 40, y: 150, w: 1840, h: 740 };

  function stageSlide(deck, slide, info) {
    if ((slide.stage || deck.deck.style) !== '3d' || !info.stage3d || !info.makeCanvas) { return false; }
    return !!findModel(slide.visual, (info.preps && info.preps[slide.index] || {}).visual);
  }

  // Content slides show the model in a viewport on the template page; title / topic slides are full-bleed.
  function viewportSlide(slide) { return slide.layout !== 'title' && slide.layout !== 'topic'; }

  // Where the viewport is, in design units: the visual area of the layout, or the box of the 3D item inside a group.
  function viewportOf(slide, prep) {
    var vr = visualRect(slide.layout === 'visual' ? 'visual' : 'split'), f = findModel(slide.visual, prep && prep.visual);
    if (f && f.node !== slide.visual && f.node.box) { var b = f.node.box; return { x: vr.x + b[0] * vr.w, y: vr.y + b[1] * vr.h, w: b[2] * vr.w, h: b[3] * vr.h }; }
    return vr;
  }

  function envFor(deck, slide) { return deck.deck.environment === 'template' && !viewportSlide(slide) ? 'template-dark' : deck.deck.environment; }

  // The 3D view into `rect` (design units) of ctx, which has the design-space transform on entry and on exit.
  function composeViewport(ctx, deck, info, width, height, state, rect) {
    var k = width / W;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    roundRect(ctx, rect.x * k, rect.y * k, rect.w * k, rect.h * k, 16 * k); ctx.clip();
    state.rect = { x: rect.x * k, y: rect.y * k, w: rect.w * k, h: rect.h * k }; state.width = width; state.height = height; state.environment = deck.deck.environment;
    info.stage3d.compose(ctx, state);
    ctx.restore();
    ctx.save(); ctx.strokeStyle = COLORS.soft; ctx.lineWidth = 3; roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 16); ctx.stroke(); ctx.restore();
  }

  // The flat part of a content slide that sits over the page and the viewport: title, chapter label, bullets, and the visual's flat items.
  function drawStageChrome(ctx, slide, prep, sched, t, info, alpha) {
    if (alpha <= 0) { return; }
    var a = GEO.area;
    ctx.save();
    ctx.globalAlpha = alpha;
    drawContentHeader(ctx, slide, sched, t, info, true);
    if (slide.layout === 'split') { drawBullets(ctx, slide, sched, t, { x: a.x, y: a.y, w: TPL.split.bulletsW, h: a.h }); }
    drawVisual(ctx, slide, prep, sched, t, visualRect(slide.layout === 'visual' ? 'visual' : 'split'), { skipModel: true });
    ctx.restore();
  }

  function lerpRect(a, b, u) { return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u }; }

  // Where the flat visuals of a stage slide go. A group keeps its own boxes over the whole area; a lone non-3D visual becomes a card.
  function hudVisualRect(slide, hasModel) {
    if (slide.visual && slide.visual.kind === 'group') { return { rect: STAGE_AREA, card: false }; }
    if (hasModel) { return { rect: STAGE_AREA, card: false }; } // only its overlay is drawn
    return { rect: slide.layout === 'visual' || !slide.bullets.length ? { x: 180, y: 170, w: 1560, h: 690 } : { x: 640, y: 170, w: 1240, h: 690 }, card: true };
  }

  // The words over a full-bleed 3D view (title / topic slides).
  function drawHud(ctx, deck, slide, sched, t, info, alpha) {
    if (alpha <= 0) { return; }
    var prep = info.preps[slide.index] || {}, timing = prep.timing || timingFor(slide, 0, 0);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (slide.layout === 'title' || slide.layout === 'topic') {
      withEffect(ctx, elementState(sched, 'title', t), { x: 160, y: 330, w: 1600, h: 300 }, function () {
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var px = slide.layout === 'title' ? 84 : 92; setFont(ctx, px, true);
        var lines = wrapLines(ctx, slide.title, 1500);
        while (lines.length > 2 && px > 48) { px -= 6; setFont(ctx, px, true); lines = wrapLines(ctx, slide.title, 1500); }
        var y0 = 470 - (lines.length - 1) * px * 0.62;
        ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 18;
        ctx.fillStyle = COLORS.white; lines.forEach(function (l, i) { ctx.fillText(l, W / 2, y0 + i * px * 1.25); });
        if (slide.subtitle) { setFont(ctx, 38, true); ctx.fillStyle = COLORS.accent; ctx.fillText(slide.subtitle, W / 2, y0 + lines.length * px * 1.25 - px * 0.2); }
        ctx.shadowBlur = 0;
        ctx.fillStyle = COLORS.accent; ctx.fillRect(W / 2 - 300, y0 + lines.length * px * 1.25 + (slide.subtitle ? 50 : 10), 600, 7);
      });
    }
    ctx.restore();
    if (info.subtitles !== false) { drawSubtitle(ctx, timing, t); }
  }

  // What the stage needs to show one slide: its live 3D model (if any), and where on the slide clock it is.
  function stageContent(slide, t, info) {
    var prep = info.preps[slide.index] || {};
    var found = findModel(slide.visual, prep.visual);
    var tv = found ? visualTime(found.node, found.pv, t) : 0;
    return { slide: slide, t: t, tv: tv, model: found ? found.model : null, interactive: found ? found.node.interactive !== false : false, orbit: found ? found.node.orbit : undefined,
             key: found && found.node.ref ? String(found.node.ref) : null, shots: cameraShots(slide, prep.timing || timingFor(slide, 0, 0)) };
  }

  // The camera shots of a slide on the slide clock: a shot with "at" starts then, the others share the narration evenly; the first
  // shot starts the slide. [] means the default shot.
  function cameraShots(slide, timing) {
    var list = slide.camera || [], n = list.length, sents = timing.sentences || [], out = [];
    if (!n) { return out; }
    var start = timing.narrSec ? timing.narrStart : 0, span = timing.narrSec || Math.max(0, (timing.duration || 0) - 1);
    list.forEach(function (sh, i) {
      var at = i === 0 ? 0 : start + span * i / n;
      var pa = sh.at != null ? parseAt(sh.at) : null;
      if (i > 0 && pa) { at = pa.sec != null ? pa.sec : ((sents[Math.min(sents.length, pa.sentence) - 1] || { start: at }).start); }
      out.push({ at: at, shot: sh });
    });
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
  }

  function scheduleOf(slide, info) { return cueSchedule(slide, (info.preps[slide.index] || {}).timing || timingFor(slide, 0, 0)); }

  // One slide in whichever look it has (stage or flat), into a canvas context of the given pixel size.
  function drawAny(ctx, deck, slide, t, info, width, height, bodyDur) {
    if (stageSlide(deck, slide, info)) {
      var prep = info.preps[slide.index] || {}, timing = prep.timing || timingFor(slide, 0, 0), sched = scheduleOf(slide, info);
      ctx.save();
      if (viewportSlide(slide)) {
        ctx.setTransform(width / W, 0, 0, height / H, 0, 0);
        drawBackground(ctx, 'content', info.assets);
        composeViewport(ctx, deck, info, width, height, { T: t, phase: 'body', p: 1, type: 'none', cur: stageContent(slide, t, info), prev: null, index: slide.index }, viewportOf(slide, prep));
        drawStageChrome(ctx, slide, prep, sched, t, info, 1);
        if (info.subtitles !== false) { drawSubtitle(ctx, timing, t); }
      } else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        info.stage3d.compose(ctx, { width: width, height: height, T: t, phase: 'body', p: 1, type: 'none', cur: stageContent(slide, t, info), prev: null, index: slide.index, environment: envFor(deck, slide) });
        ctx.setTransform(width / W, 0, 0, height / H, 0, 0);
        drawHud(ctx, deck, slide, sched, t, info, 1);
      }
      ctx.restore();
    } else {
      ctx.save();
      ctx.setTransform(width / W, 0, 0, height / H, 0, 0);
      drawSlide(ctx, deck, slide, t, info);
      ctx.restore();
    }
    void bodyDur;
  }

  // Draws the deck at timeline time T into ctx (the real canvas context of size info.width x info.height).
  // Flat slides draw in the 1920x1080 design space; stage slides go through the 3D stage; a transition between two stage slides is a
  // stage transition (curtain / spin / fade), anything else between a flat and a stage slide is a cross-fade.
  function renderFrame(ctx, deck, tl, T, info) {
    var width = info.width || W, height = info.height || H;
    var loc = locate(tl, T), cur = deck.slides[loc.i], curStage = stageSlide(deck, cur, info);
    ctx.save();
    if (loc.phase === 'body' || !info.makeCanvas) {
      drawAny(ctx, deck, cur, loc.t, info, width, height);
      ctx.restore();
      return;
    }
    var prev = deck.slides[loc.i - 1], prevEnd = tl.segs[loc.i - 1].bodyDur - 1e-3;
    if (curStage && stageSlide(deck, prev, info) && viewportSlide(cur) === viewportSlide(prev)) {
      var type = STAGE_TRANSITIONS[cur.transition.type] || 'fly', p = loc.p;
      var curPrep = info.preps[cur.index] || {}, prevPrep = info.preps[prev.index] || {};
      if (viewportSlide(cur)) {
        // the page stays (same template); the camera flies; the window eases from the old slide's place to the new one's; the words cross-fade
        ctx.setTransform(width / W, 0, 0, height / H, 0, 0);
        drawBackground(ctx, 'content', info.assets);
        composeViewport(ctx, deck, info, width, height, { T: T, phase: 'transition', p: p, type: type, cur: stageContent(cur, 0, info), prev: stageContent(prev, prevEnd, info), index: loc.i },
          lerpRect(viewportOf(prev, prevPrep), viewportOf(cur, curPrep), easeInOut(p)));
        var half = p < 0.5 ? prev : cur, ht = p < 0.5 ? prevEnd : 0;
        drawStageChrome(ctx, half, info.preps[half.index] || {}, scheduleOf(half, info), ht, info, p < 0.5 ? 1 - p * 2 : (p - 0.5) * 2);
        if (info.subtitles !== false) { drawSubtitle(ctx, (info.preps[half.index] || {}).timing || timingFor(half, 0, 0), ht); }
      } else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        info.stage3d.compose(ctx, { width: width, height: height, T: T, phase: 'transition', p: p, type: type, cur: stageContent(cur, 0, info), prev: stageContent(prev, prevEnd, info),
          index: loc.i, environment: envFor(deck, cur) });
        ctx.setTransform(width / W, 0, 0, height / H, 0, 0);
        if (p < 0.5) { drawHud(ctx, deck, prev, scheduleOf(prev, info), prevEnd, info, 1 - p * 2); }
        else { drawHud(ctx, deck, cur, scheduleOf(cur, info), 0, info, (p - 0.5) * 2); }
      }
      ctx.restore();
      return;
    }
    var fa = scratch(info, 'flatA', width, height), fb = scratch(info, 'flatB', width, height);
    var ga = fa.getContext('2d'), gb = fb.getContext('2d');
    ga.setTransform(1, 0, 0, 1, 0, 0); gb.setTransform(1, 0, 0, 1, 0, 0);
    ga.clearRect(0, 0, width, height); gb.clearRect(0, 0, width, height);
    drawAny(ga, deck, prev, prevEnd, info, width, height);
    drawAny(gb, deck, cur, 0, info, width, height);
    ctx.setTransform(width / W, 0, 0, height / H, 0, 0);
    // ctx carries the design-space transform: the offscreen frames are drawn at W x H design units, which scales them to the canvas
    drawTransition(ctx, curStage !== stageSlide(deck, prev, info) ? 'fade' : cur.transition.type, loc.p, fa, fb);
    ctx.restore();
  }

  // PPTX export of a 3D-stage slide: the stage as it looks now (the viewer's current camera angle -- info.stage3d.view is left as the
  // user has it), with the model at the end of its animation, drawn at the pixel size of ctx; and, separately, the flat layer
  // (cards, tables, images, overlays, group items) on a transparent canvas in the 1920x1080 design space.
  function renderStageSnapshot(ctx, deck, slide, info, width, height) {
    var prep = info.preps[slide.index] || {}, timing = prep.timing || timingFor(slide, 0, 0), t = Math.max(0, timing.duration - 1e-3);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    info.stage3d.compose(ctx, { width: width, height: height, T: t, phase: 'body', p: 1, type: 'none', cur: stageContent(slide, t, info), prev: null, index: slide.index, keepView: true, environment: envFor(deck, slide) });
    ctx.restore();
  }

  // PPTX export of a content slide's 3D model: the view through the viewport at the viewer's current camera angle, drawn at the pixel
  // size of ctx (the viewport's own shape).
  function renderViewportSnapshot(ctx, deck, slide, info, width, height) {
    var prep = info.preps[slide.index] || {}, timing = prep.timing || timingFor(slide, 0, 0), t = Math.max(0, timing.duration - 1e-3);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    info.stage3d.compose(ctx, { width: width, height: height, rect: { x: 0, y: 0, w: width, h: height }, T: t, phase: 'body', p: 1, type: 'none', cur: stageContent(slide, t, info), prev: null, index: slide.index, keepView: true, environment: deck.deck.environment });
    ctx.restore();
  }

  function renderStageFlatLayer(ctx, slide, info) {
    if (!slide.visual) { return; }
    var prep = info.preps[slide.index] || {}, timing = prep.timing || timingFor(slide, 0, 0), t = Math.max(0, timing.duration - 1e-3);
    var sched = cueSchedule(slide, timing).filter(function (c) { return c.kind === 'show'; });
    var place = viewportSlide(slide) ? { rect: visualRect(slide.layout === 'visual' ? 'visual' : 'split'), card: false } : hudVisualRect(slide, !!findModel(slide.visual, prep.visual));
    ctx.save();
    if (place.card) { ctx.fillStyle = 'rgba(247,250,252,0.94)'; roundRect(ctx, place.rect.x - 14, place.rect.y - 14, place.rect.w + 28, place.rect.h + 28, 22); ctx.fill(); }
    drawVisual(ctx, Object.assign({}, slide, { visual: Object.assign({}, slide.visual, { motion: { type: 'none' } }) }), prep, sched, t, place.rect, { skipModel: true });
    ctx.restore();
  }

  // The visual alone, at the end of its slide (every cue shown, nothing hidden) -- used by the PPTX exporter, which cannot
  // keep animation and so shows the finished picture. rect is in the same design space as visualRect().
  function renderVisualSnapshot(ctx, slide, prep, rect) {
    var timing = prep.timing || timingFor(slide, 0, 0);
    var sched = cueSchedule(slide, timing).filter(function (c) { return c.kind === 'show'; });
    var tEnd = timing.duration + 10;
    ctx.save();
    drawVisual(ctx, Object.assign({}, slide, { visual: Object.assign({}, slide.visual, { motion: { type: 'none' } }) }), prep, sched, tEnd, rect);
    ctx.restore();
  }

  // ------------------------------------------------------------------ subtitle export
  function fmtTime(sec, comma) {
    var ms = Math.round(sec * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    function p(n, w) { n = String(n); while (n.length < w) { n = '0' + n; } return n; }
    return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + (comma ? ',' : '.') + p(r, 3);
  }

  function buildSubtitleFile(deck, tl, timings, format) {
    var lines = format === 'vtt' ? ['WEBVTT', ''] : [], n = 0;
    deck.slides.forEach(function (_s, i) {
      var seg = tl.segs[i];
      (timings[i] ? timings[i].sentences : []).forEach(function (sp) {
        n++;
        if (format !== 'vtt') { lines.push(String(n)); }
        lines.push(fmtTime(seg.bodyStart + sp.start, format !== 'vtt') + ' --> ' + fmtTime(seg.bodyStart + sp.end, format !== 'vtt'));
        lines.push(sp.text); lines.push('');
      });
    });
    return lines.join('\n');
  }

  applyTemplate(typeof self !== 'undefined' && self.AiChatDeckTemplate ? self.AiChatDeckTemplate : null);

  var api = {
    STYLES: STYLES, ENVIRONMENTS: ENVIRONMENTS, FLAT_OF: FLAT_OF, STAGE_TRANSITIONS: STAGE_TRANSITIONS,
    W: W, H: H, KIND: KIND, LIMITS: LIMITS, LAYOUTS: LAYOUTS, VISUAL_KINDS: VISUAL_KINDS, TRANSITIONS: TRANSITIONS, IN_EFFECTS: IN_EFFECTS, MOTIONS: MOTIONS,
    COLORS: COLORS, GEO: GEO, LEAD: LEAD, TAIL: TAIL,
    DEFAULT_TEMPLATE: DEFAULT_TEMPLATE, applyTemplate: applyTemplate, template: template, mergeTemplate: mergeTemplate,
    splitSentences: splitSentences, estimateSeconds: estimateSeconds, distribute: distribute,
    parseAt: parseAt, parseTarget: parseTarget, validate: validate, normalize: normalize, parseDeck: parseDeck,
    visualImageSources: visualImageSources, visualRect: visualRect, interactiveRegions: interactiveRegions, boxRect: boxRect, INTERACTIVE_KINDS: INTERACTIVE_KINDS,
    timingFor: timingFor, buildTimeline: buildTimeline, locate: locate, cueSchedule: cueSchedule, elementState: elementState,
    wrapLines: wrapLines, drawSlide: drawSlide, drawTransition: drawTransition, renderFrame: renderFrame,
    fixMermaidSource: fixMermaidSource, findModel: findModel, stageSlide: stageSlide, renderStageSnapshot: renderStageSnapshot, renderViewportSnapshot: renderViewportSnapshot, viewportSlide: viewportSlide, viewportOf: viewportOf, cameraShots: cameraShots, renderStageFlatLayer: renderStageFlatLayer, renderVisualSnapshot: renderVisualSnapshot, buildSubtitleFile: buildSubtitleFile, fmtTime: fmtTime
  };
  // the font follows the template (applyTemplate replaces it)
  Object.defineProperty(api, 'FONT', { enumerable: true, get: function () { return FONT; } });
  return api;
});
