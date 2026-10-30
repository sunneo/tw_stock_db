// /edit-video: the TIMELINE -- clips (a range of a source video), the transitions between them, picture overlays. Pure functions (the canvas drawing of a transition takes the context as an argument), tested in Node: scripts/video-tests/video_timeline.test.js
// Non-destructive: the project keeps a list of clips {id, fileId, name, in, out, tr} -- ranges of source files, never the bytes. The timeline time of a clip starts where the previous one ends; transcript lines, dubs and overlays are in TIMELINE time.
//   TwVideoTimeline.normalizeClips(list)  fromVideo(fileId, name, dur)  total(clips)  starts(clips)  locate(clips, t)  splitAt(clips, t)  removeRange(clips, a, b)  append(clips, clip)  setTransition(clips, id, {type, dur})
//   TwVideoTimeline.transitionAt(clips, t) -> {i, type, p} | null     TRANSITIONS     drawTransition(ctx, type, p, A, B, W, H)
//   TwVideoTimeline.rippleRemove(items, a, b, opt)      normalizeOverlays(list)  addOverlay(list, o)  updateOverlay(list, id, patch)  removeOverlay(list, id)  activeOverlays(list, t)
// A transition belongs to the clip it goes INTO (clip i, i >= 1: the cut between clip i-1 and clip i). It does not shorten the timeline: it is drawn over a window of `dur` seconds centered on the cut, from the outgoing clip's picture
// and the incoming clip's first picture held still (before the cut) / the outgoing clip's last picture held still (after the cut), so nothing in the transcript, the dubs or the overlays moves when a transition is set.
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.TwVideoTimeline = factory(); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX_CLIPS = 100, MAX_OVERLAYS = 50, MIN_LEN = 0.1, EDGE = 0.05, TR_MIN = 0.2, TR_MAX = 3, TR_DEFAULT = 1;
  // [id, zh, en]
  var TRANSITION_LIST = [
    ['none', '無', 'None'], ['fade', '淡入淡出(經過黑色)', 'Fade (through black)'], ['dissolve', '交叉淡化', 'Cross dissolve'], ['fade-white', '淡入淡出(經過白色)', 'Fade (through white)'],
    ['slide-left', '從右滑入', 'Slide in from the right'], ['slide-right', '從左滑入', 'Slide in from the left'], ['slide-up', '從下滑入', 'Slide in from the bottom'], ['slide-down', '從上滑入', 'Slide in from the top'],
    ['push-left', '向左推出', 'Push left'], ['push-right', '向右推出', 'Push right'], ['push-up', '向上推出', 'Push up'], ['push-down', '向下推出', 'Push down'],
    ['wipe-left', '掃描線 由左到右', 'Wipe left to right'], ['wipe-right', '掃描線 由右到左', 'Wipe right to left'], ['wipe-up', '掃描線 由上到下', 'Wipe top to bottom'], ['wipe-down', '掃描線 由下到上', 'Wipe bottom to top'],
    ['split-h', '中心向左右展開', 'Open from the center (horizontal)'], ['split-v', '中心向上下展開', 'Open from the center (vertical)'],
    ['circle-open', '圓圈由中心展開', 'Circle opens from the center'], ['circle-close', '圓圈向中心收合', 'Circle closes to the center'],
    ['blinds', '百葉窗', 'Blinds'], ['zoom', '放大淡入', 'Zoom in']
  ];
  var TRANSITIONS = TRANSITION_LIST.map(function (t) { return t[0]; });
  function r3(n) { return Math.round(n * 1000) / 1000; }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function nextId(list, p) { var n = 0; list.forEach(function (x) { n = Math.max(n, parseInt(String(x.id).slice(1), 10) || 0); }); return p + (n + 1); }
  function cleanTr(t) {
    t = t && typeof t === 'object' ? t : {}; var type = TRANSITIONS.indexOf(t.type) >= 0 ? t.type : 'none', d = +t.dur;
    return { type: type, dur: isFinite(d) && d >= TR_MIN && d <= TR_MAX ? r3(d) : TR_DEFAULT };
  }
  // a list read from a saved project: bad rows dropped, ids unique, the first clip never has a transition
  function normalizeClips(list) {
    var seen = {}, out = [];
    (Array.isArray(list) ? list : []).forEach(function (c) {
      if (!c || out.length >= MAX_CLIPS) { return; } var a = +c.in, b = +c.out; if (!isFinite(a) || !isFinite(b) || a < 0 || b - a < MIN_LEN) { return; }
      var id = typeof c.id === 'string' && /^k\d+$/.test(c.id) && !seen[c.id] ? c.id : null; if (id) { seen[id] = 1; }
      out.push({ id: id, fileId: c.fileId == null ? null : String(c.fileId), name: String(c.name || '').slice(0, 120), in: r3(a), out: r3(b), tr: cleanTr(c.tr) });
    });
    out.forEach(function (c, i) { if (!c.id) { var n = 0; out.forEach(function (x) { if (x.id) { n = Math.max(n, +x.id.slice(1)); } }); do { n++; } while (seen['k' + n]); c.id = 'k' + n; seen[c.id] = 1; } if (i === 0) { c.tr = { type: 'none', dur: TR_DEFAULT }; } });
    return out;
  }
  function fromVideo(fileId, name, dur) { return normalizeClips([{ fileId: fileId, name: name, in: 0, out: dur }]); }
  function len(c) { return c.out - c.in; }
  function total(clips) { return r3(clips.reduce(function (s, c) { return s + len(c); }, 0)); }
  function starts(clips) { var t = 0; return clips.map(function (c) { var s = t; t += len(c); return r3(s); }); }
  // timeline time -> { i, local (seconds into the clip), src (seconds in the source file) }; t is clamped to [0, total]; the end of the timeline is the end of the last clip
  function locate(clips, t) {
    if (!clips.length) { return null; } var tt = clamp(+t || 0, 0, total(clips)), s = starts(clips);
    for (var i = clips.length - 1; i >= 0; i--) { if (tt >= s[i] - 1e-9) { var l = Math.min(len(clips[i]), tt - s[i]); return { i: i, local: r3(l), src: r3(clips[i].in + l) }; } }
    return { i: 0, local: 0, src: clips[0].in };
  }
  // cut the clip under t in two (the second half starts with no transition). Not within 0.05 s of an edge.
  function splitAt(clips, t) {
    if (clips.length >= MAX_CLIPS) { return { ok: false, error: 'full', clips: clips }; } var loc = locate(clips, t); if (!loc) { return { ok: false, error: 'empty', clips: clips }; }
    var c = clips[loc.i]; if (loc.local < EDGE || len(c) - loc.local < EDGE) { return { ok: false, error: 'edge', clips: clips }; }
    var b = { id: nextId(clips, 'k'), fileId: c.fileId, name: c.name, in: loc.src, out: c.out, tr: { type: 'none', dur: TR_DEFAULT } }, a = Object.assign({}, c, { out: loc.src });
    var next = clips.slice(); next.splice(loc.i, 1, a, b); return { ok: true, clips: next, id: b.id };
  }
  // take out [a, b] of the timeline (the clips after it move up). Returns the new list; error 'all' when nothing would be left.
  function removeRange(clips, a, b) {
    var tot = total(clips); a = clamp(+a || 0, 0, tot); b = clamp(+b || 0, 0, tot); if (b - a < EDGE) { return { ok: false, error: 'range', clips: clips }; }
    var list = clips, r;
    if (a > 0) { r = splitAt(list, a); if (r.ok) { list = r.clips; } else if (r.error === 'full') { return r; } }
    if (b < tot) { r = splitAt(list, b); if (r.ok) { list = r.clips; } else if (r.error === 'full') { return r; } }
    var s = starts(list), keep = list.filter(function (c, i) { return !(s[i] >= a - 1e-6 && s[i] + len(c) <= b + 1e-6); });
    if (!keep.length) { return { ok: false, error: 'all', clips: clips }; }
    keep[0] = Object.assign({}, keep[0], { tr: { type: 'none', dur: TR_DEFAULT } });
    return { ok: true, clips: keep, a: r3(a), b: r3(b) };
  }
  function append(clips, c) {
    if (clips.length >= MAX_CLIPS) { return { ok: false, error: 'full', clips: clips }; }
    var one = normalizeClips([{ fileId: c.fileId, name: c.name, in: c.in == null ? 0 : c.in, out: c.out, tr: c.tr }]); if (!one.length) { return { ok: false, error: 'range', clips: clips }; }
    one[0].id = nextId(clips, 'k'); return { ok: true, clips: clips.concat(one), id: one[0].id };
  }
  function setTransition(clips, id, tr) {
    var i = -1; clips.forEach(function (c, k) { if (c.id === id) { i = k; } }); if (i < 0) { return { ok: false, error: 'missing', clips: clips }; } if (i === 0) { return { ok: false, error: 'first', clips: clips }; }
    var next = clips.slice(); next[i] = Object.assign({}, clips[i], { tr: cleanTr(Object.assign({}, clips[i].tr, tr)) }); return { ok: true, clips: next };
  }
  // the transition window of the cut into clip i (i >= 1): dur is cut down to what both neighbours can give
  function windowOf(clips, i) {
    if (i < 1 || i >= clips.length) { return null; } var tr = clips[i].tr; if (!tr || tr.type === 'none') { return null; }
    var d = Math.min(tr.dur, len(clips[i - 1]), len(clips[i])), cut = starts(clips)[i]; if (d < 0.05) { return null; }
    return { i: i, type: tr.type, dur: d, cut: cut, from: cut - d / 2, to: cut + d / 2 };
  }
  // -> { i, type, p (0..1 across the window), before (true while still in the outgoing clip) } | null
  function transitionAt(clips, t) {
    for (var i = 1; i < clips.length; i++) { var w = windowOf(clips, i); if (w && t >= w.from && t < w.to) { return { i: i, type: w.type, p: (t - w.from) / w.dur, before: t < w.cut, window: w }; } }
    return null;
  }

  // ---- cut a stretch out of the timeline: what lies after it moves up by (b - a); what lies inside it goes; what overlaps an edge is trimmed.
  //   items: [{start, end}] (opt.end = 'end', the default) or [{start, <opt.end>}] with a length field (e.g. 'duration', 'dur'); opt.keepLen: do not trim an item (a dub is a recording: it is only moved, and dropped when it started inside the cut and ends inside it)
  function rippleRemove(items, a, b, opt) {
    opt = opt || {}; var key = opt.end || 'end', cut = b - a, out = [], dropped = 0;
    (items || []).forEach(function (it) {
      var s = it.start, e = key === 'end' ? it.end : it.start + it[key];
      if (e <= a + 1e-9) { out.push(it); return; }
      if (s >= b - 1e-9) { out.push(shift(it, s - cut, e - cut)); return; }
      if (s >= a - 1e-9 && e <= b + 1e-9) { dropped++; return; }
      if (opt.keepLen) { out.push(shift(it, s < a ? s : a, (s < a ? s : a) + (e - s))); return; }
      var ns = s < a ? s : a, ne = e <= b ? a : e - cut; out.push(shift(it, ns, ne));
    });
    function shift(it, ns, ne) { var c = Object.assign({}, it); c.start = r3(ns); if (key === 'end') { c.end = r3(ne); } else { c[key] = r3(ne - ns); } return c; }
    return { items: out, dropped: dropped };
  }

  // ---- picture overlays: {id, fileId, name, start, dur, x, y, w} -- x, y = the CENTER of the picture as fractions of the video frame, w = its width as a fraction of the frame width
  function cleanOverlay(o) {
    var s = +o.start, d = +o.dur; if (!isFinite(s) || s < 0 || !isFinite(d) || d <= 0) { return null; }
    var x = +o.x, y = +o.y, w = +o.w;
    return { id: o.id, fileId: o.fileId == null ? null : String(o.fileId), name: String(o.name || '').slice(0, 120), start: r3(s), dur: r3(d), x: isFinite(x) ? clamp(x, 0, 1) : 0.5, y: isFinite(y) ? clamp(y, 0, 1) : 0.5, w: isFinite(w) ? clamp(w, 0.05, 1) : 0.3 };
  }
  function normalizeOverlays(list) {
    var seen = {}, out = [];
    (Array.isArray(list) ? list : []).forEach(function (o) { if (!o || out.length >= MAX_OVERLAYS) { return; } var c = cleanOverlay(o); if (!c) { return; } if (!(typeof c.id === 'string' && /^o\d+$/.test(c.id) && !seen[c.id])) { c.id = null; } else { seen[c.id] = 1; } out.push(c); });
    out.forEach(function (c) { if (!c.id) { var n = 0; out.forEach(function (x) { if (x.id) { n = Math.max(n, +x.id.slice(1)); } }); do { n++; } while (seen['o' + n]); c.id = 'o' + n; seen[c.id] = 1; } });
    return out.sort(function (a, b) { return a.start - b.start; });
  }
  function addOverlay(list, o) {
    if (list.length >= MAX_OVERLAYS) { return { ok: false, error: 'full', overlays: list }; }
    var c = cleanOverlay(Object.assign({ dur: 3, x: 0.5, y: 0.5, w: 0.3 }, o || {})); if (!c) { return { ok: false, error: 'time', overlays: list }; }
    c.id = nextId(list, 'o'); return { ok: true, id: c.id, overlays: list.concat([c]).sort(function (a, b) { return a.start - b.start; }) };
  }
  function updateOverlay(list, id, patch) {
    var i = -1; list.forEach(function (o, k) { if (o.id === id) { i = k; } }); if (i < 0) { return { ok: false, error: 'missing', overlays: list }; }
    var c = cleanOverlay(Object.assign({}, list[i], patch || {})); if (!c) { return { ok: false, error: 'time', overlays: list }; }
    var next = list.slice(); next[i] = c; return { ok: true, overlays: next.sort(function (a, b) { return a.start - b.start; }) };
  }
  function removeOverlay(list, id) { var next = list.filter(function (o) { return o.id !== id; }); return { ok: next.length !== list.length, overlays: next }; }
  function activeOverlays(list, t) { return list.filter(function (o) { return t >= o.start - 1e-9 && t < o.start + o.dur; }); }

  // ---- drawing a transition: A = the outgoing picture, B = the incoming one (canvases or anything drawImage takes), p 0..1. ctx is cleared and filled here.
  function ease(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function drawTransition(ctx, type, p, A, B, W, H) {
    p = clamp(p, 0, 1); var e = ease(p), m = type.split('-')[0], dir = type.split('-')[1];
    ctx.save(); ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    function clipTo(fn) { ctx.save(); ctx.beginPath(); fn(); ctx.clip(); ctx.drawImage(B, 0, 0, W, H); ctx.restore(); }
    if (type === 'fade' || type === 'fade-white') {
      if (type === 'fade-white') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
      if (p < 0.5) { ctx.globalAlpha = 1 - 2 * p; ctx.drawImage(A, 0, 0, W, H); } else { ctx.globalAlpha = 2 * p - 1; ctx.drawImage(B, 0, 0, W, H); }
    } else if (type === 'dissolve') { ctx.drawImage(A, 0, 0, W, H); ctx.globalAlpha = p; ctx.drawImage(B, 0, 0, W, H); }
    else if (m === 'slide') {   // the new picture slides over the old one
      ctx.drawImage(A, 0, 0, W, H); var dx = dir === 'left' ? W * (1 - e) : dir === 'right' ? -W * (1 - e) : 0, dy = dir === 'up' ? H * (1 - e) : dir === 'down' ? -H * (1 - e) : 0; ctx.drawImage(B, dx, dy, W, H);
    } else if (m === 'push') {  // both move
      var px = dir === 'left' ? -W * e : dir === 'right' ? W * e : 0, py = dir === 'up' ? -H * e : dir === 'down' ? H * e : 0; ctx.drawImage(A, px, py, W, H);
      ctx.drawImage(B, px + (dir === 'left' ? W : dir === 'right' ? -W : 0), py + (dir === 'up' ? H : dir === 'down' ? -H : 0), W, H);
    } else if (m === 'wipe') {  // a scan line moves across and uncovers the new picture
      ctx.drawImage(A, 0, 0, W, H);
      clipTo(function () { if (dir === 'left') { ctx.rect(0, 0, W * e, H); } else if (dir === 'right') { ctx.rect(W * (1 - e), 0, W * e, H); } else if (dir === 'up') { ctx.rect(0, 0, W, H * e); } else { ctx.rect(0, H * (1 - e), W, H * e); } });
      ctx.fillStyle = 'rgba(255,255,255,.85)'; if (p > 0 && p < 1) { if (dir === 'left') { ctx.fillRect(W * e - 1, 0, 2, H); } else if (dir === 'right') { ctx.fillRect(W * (1 - e) - 1, 0, 2, H); } else if (dir === 'up') { ctx.fillRect(0, H * e - 1, W, 2); } else { ctx.fillRect(0, H * (1 - e) - 1, W, 2); } }
    } else if (type === 'split-h') { ctx.drawImage(A, 0, 0, W, H); clipTo(function () { ctx.rect(W * (1 - e) / 2, 0, W * e, H); }); }
    else if (type === 'split-v') { ctx.drawImage(A, 0, 0, W, H); clipTo(function () { ctx.rect(0, H * (1 - e) / 2, W, H * e); }); }
    else if (type === 'circle-open') { var R = Math.sqrt(W * W + H * H) / 2; ctx.drawImage(A, 0, 0, W, H); clipTo(function () { ctx.arc(W / 2, H / 2, R * e, 0, Math.PI * 2); }); }
    else if (type === 'circle-close') { var R2 = Math.sqrt(W * W + H * H) / 2; ctx.drawImage(B, 0, 0, W, H); ctx.save(); ctx.beginPath(); ctx.arc(W / 2, H / 2, R2 * (1 - e), 0, Math.PI * 2); ctx.clip(); ctx.drawImage(A, 0, 0, W, H); ctx.restore(); }
    else if (type === 'blinds') { ctx.drawImage(A, 0, 0, W, H); var n = 8, bh = H / n; clipTo(function () { for (var k = 0; k < n; k++) { ctx.rect(0, k * bh, W, bh * e); } }); }
    else if (type === 'zoom') { ctx.drawImage(A, 0, 0, W, H); ctx.globalAlpha = e; ctx.translate(W / 2, H / 2); var s = 0.7 + 0.3 * e; ctx.scale(s, s); ctx.translate(-W / 2, -H / 2); ctx.drawImage(B, 0, 0, W, H); }
    else { ctx.drawImage(B, 0, 0, W, H); }
    ctx.restore();
  }

  return { TRANSITIONS: TRANSITIONS, TRANSITION_LIST: TRANSITION_LIST, TR_MIN: TR_MIN, TR_MAX: TR_MAX, TR_DEFAULT: TR_DEFAULT, MIN_LEN: MIN_LEN, EDGE: EDGE, normalizeClips: normalizeClips, fromVideo: fromVideo, total: total, starts: starts, locate: locate, splitAt: splitAt, removeRange: removeRange, append: append, setTransition: setTransition, windowOf: windowOf, transitionAt: transitionAt, rippleRemove: rippleRemove, normalizeOverlays: normalizeOverlays, addOverlay: addOverlay, updateOverlay: updateOverlay, removeOverlay: removeOverlay, activeOverlays: activeOverlays, drawTransition: drawTransition };
}));
