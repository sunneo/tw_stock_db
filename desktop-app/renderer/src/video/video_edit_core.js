// /edit-video: pure helpers of the video + transcript editor (no DOM, tested in Node: test/edit_video/video_edit_core.test.js). Design: DESIGN.edit-video.md.
//   TwVideoEdit.clock(t)  parseT(text)  newProject(name)  layout(l)  clampPanelWidth(w, total)  TABS
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.TwVideoEdit = factory(); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var TABS = ['transcript', 'ask', 'jobs'];     // the right-hand tabs: transcript | job queue (the OBJECT bar, with the dubs, is the left panel: resizable, hideable)
  var PANEL_MIN = 140, PANEL_MAX_FRAC = 0.5, PANEL_DEFAULT = 220;

  function clock(t) { t = Math.max(0, +t || 0); var m = Math.floor(t / 60), s = t - m * 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
  // "1:05.5", "01:02:03.5" or plain seconds -> seconds; null when it is not a time
  function parseT(s) {
    s = String(s == null ? '' : s).trim(); var m;
    if ((m = /^(\d+):(\d+(?:[.,]\d+)?)$/.exec(s))) { return +m[1] * 60 + parseFloat(m[2].replace(',', '.')); }
    if ((m = /^(\d+):(\d+):(\d+(?:[.,]\d+)?)$/.exec(s))) { return +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3].replace(',', '.')); }
    if (!/^\d+(?:[.,]\d+)?$/.test(s)) { return null; }
    return parseFloat(s.replace(',', '.'));
  }
  // the object panel (left) must stay usable: not narrower than PANEL_MIN, not wider than half of the editor
  function clampPanelWidth(w, total) {
    var max = Math.max(PANEL_MIN, Math.floor((+total || 0) * PANEL_MAX_FRAC)), n = +w;
    if (!isFinite(n)) { n = PANEL_DEFAULT; }
    return Math.max(PANEL_MIN, Math.min(max, Math.round(n)));
  }
  // what is remembered of the frame: panel width, panel hidden, active tab. Anything else is dropped; wrong values fall back.
  function layout(l) {
    l = l && typeof l === 'object' ? l : {};
    return { panelW: clampPanelWidth(l.panelW == null ? PANEL_DEFAULT : l.panelW, 100000), panelHidden: l.panelHidden === true, subs: l.subs !== false, genScope: l.genScope === 'whole' ? 'whole' : 'playhead', burnMix: l.burnMix === 'subs' ? 'subs' : 'all', tab: TABS.indexOf(l.tab) >= 0 ? l.tab : 'transcript' };
  }
  // the saved project: the video is a client file (AiChatPersistentStorage id) -- never the bytes -- plus the frame layout; cues = the transcript; dubs come with a later step
  function newProject(name) { return { v: 1, name: String(name || '').slice(0, 80), video: null, layout: layout(null), cues: [], dubs: [], jobs: [] }; }

  // ---- the transcript: cues {id, start, end, text} in seconds, kept sorted by start. Every function returns a NEW list (the editor's undo history keeps the old ones).
  var MAX_TEXT = 500, MAX_CUES = 5000, EPS = 0.001;
  // how long "a line at the playhead" is: the default length of a line added at the playhead AND of what "Generate transcript > From playhead" recognizes -- a few seconds, the same on purpose
  var CUE_SECONDS = 2;
  function r3(n) { return Math.round(n * 1000) / 1000; }
  function cleanText(t) { return String(t == null ? '' : t).replace(/\r\n?/g, '\n').slice(0, MAX_TEXT); }
  function sortCues(list) { return list.slice().sort(function (a, b) { return a.start - b.start || a.end - b.end; }); }
  // a list read from a saved project or an import: bad rows dropped, times rounded, ids made unique, sorted
  function normalize(list) {
    var seen = {}, out = [], n = 0;
    (Array.isArray(list) ? list : []).forEach(function (c) {
      if (!c || out.length >= MAX_CUES) { return; }
      var a = +c.start, b = +c.end; if (!isFinite(a) || !isFinite(b) || a < 0 || b <= a) { return; }
      var id = typeof c.id === 'string' && /^c\d+$/.test(c.id) && !seen[c.id] ? c.id : null;
      if (id) { seen[id] = 1; n = Math.max(n, +id.slice(1)); }
      out.push({ id: id, start: r3(a), end: r3(b), text: cleanText(c.text) });
    });
    out.forEach(function (c) { if (!c.id) { do { n++; } while (seen['c' + n]); c.id = 'c' + n; seen[c.id] = 1; } });
    return sortCues(out);
  }
  function nextId(cues) { var n = 0; cues.forEach(function (c) { n = Math.max(n, parseInt(String(c.id).slice(1), 10) || 0); }); return 'c' + (n + 1); }
  // times must be 0 <= start < end, and inside the video when its length is known (duration > 0)
  function checkTimes(start, end, duration) {
    if (!isFinite(start) || !isFinite(end)) { return 'time'; } if (start < 0) { return 'negative'; } if (end <= start) { return 'order'; }
    if (duration > 0 && end > duration + EPS) { return 'beyond'; } return null;
  }
  // add a cue at `at` (the playing position), `dur` long (default 2 s, cut at the end of the video); text may be given
  function addCue(cues, o) {
    o = o || {}; if (cues.length >= MAX_CUES) { return { ok: false, error: 'full', cues: cues }; }
    var d = +o.duration || 0, at = Math.max(0, +o.at || 0); if (d > 0 && at > d - 0.2) { at = Math.max(0, d - 0.2); }
    var end = at + (+o.dur > 0 ? +o.dur : CUE_SECONDS); if (d > 0) { end = Math.min(end, d); }
    var err = checkTimes(at, end, d); if (err) { return { ok: false, error: err, cues: cues }; }
    var id = nextId(cues); return { ok: true, id: id, cues: sortCues(cues.concat([{ id: id, start: r3(at), end: r3(end), text: cleanText(o.text) }])) };
  }
  // patch = any of {start, end, text}; the result is refused (cues unchanged, error = 'negative' | 'order' | 'beyond' | 'time' | 'missing') when the times would be wrong
  function updateCue(cues, id, patch, duration) {
    var i = cues.findIndex(function (c) { return c.id === id; }); if (i < 0) { return { ok: false, error: 'missing', cues: cues }; }
    var c = cues[i], n = { id: c.id, start: patch.start !== undefined ? +patch.start : c.start, end: patch.end !== undefined ? +patch.end : c.end, text: patch.text !== undefined ? cleanText(patch.text) : c.text };
    var err = checkTimes(n.start, n.end, duration); if (err) { return { ok: false, error: err, cues: cues }; }
    n.start = r3(n.start); n.end = r3(n.end); var copy = cues.slice(); copy[i] = n; return { ok: true, cues: sortCues(copy) };
  }
  function removeCue(cues, id) { var out = cues.filter(function (c) { return c.id !== id; }); return { ok: out.length !== cues.length, cues: out }; }
  // the cue shown at time t (start <= t < end); the first one when they overlap
  function activeCue(cues, t) { for (var i = 0; i < cues.length; i++) { if (cues[i].start <= t && t < cues[i].end) { return cues[i]; } if (cues[i].start > t) { break; } } return null; }
  // undo / redo over whole lists:  h = history(list);  h.push(list) h.undo() h.redo() h.current() h.canUndo() h.canRedo()
  function history(initial) {
    var stack = [initial], ptr = 0, LIMIT = 100;
    return { push: function (l) { stack = stack.slice(0, ptr + 1); stack.push(l); if (stack.length > LIMIT) { stack.shift(); } ptr = stack.length - 1; },
      undo: function () { if (ptr > 0) { ptr--; } return stack[ptr]; }, redo: function () { if (ptr < stack.length - 1) { ptr++; } return stack[ptr]; },
      current: function () { return stack[ptr]; }, canUndo: function () { return ptr > 0; }, canRedo: function () { return ptr < stack.length - 1; } };
  }

  // ---- SRT / WebVTT: parseSrt(text) -> { cues, skipped } (cues normalized: sorted, ids, rounded); formatSrt(cues) -> text.
  // Reads .srt (with or without the index lines, "," or "." before the milliseconds, hours optional), WebVTT (header, NOTE / STYLE blocks, cue ids, <tags> and {\an8} dropped) and the plain
  // "[M:SS - M:SS] text" lines that /media-transcribe writes. A block whose times cannot be read is counted in `skipped`, never guessed. (ai_chat.js still has its own older parser for /media-burn-subtitles; left untouched on purpose.)
  function tsToSec(x) {
    var m = String(x).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/); if (!m) { return null; }
    return (m[1] ? +m[1] : 0) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +('0.' + m[4]) : 0);
  }
  function parseSrt(text) {
    var raw = String(text == null ? '' : text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim(), out = [], skipped = 0;
    if (!raw) { return { cues: [], skipped: 0 }; }
    if (/-->/.test(raw)) {
      raw.split(/\n{2,}/).forEach(function (block) {
        var lines = block.split('\n').map(function (l) { return l.replace(/\s+$/, ''); }).filter(function (l) { return l !== ''; });
        if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) { return; }
        var ti = -1; lines.forEach(function (l, i) { if (ti < 0 && l.indexOf('-->') >= 0) { ti = i; } });
        if (ti < 0) { skipped++; return; }
        var parts = lines[ti].split('-->'), a = tsToSec(parts[0]), b = tsToSec(String(parts[1] || '').trim().split(/\s+/)[0]);   // VTT may put settings after the end time
        var body = lines.slice(ti + 1).join('\n').replace(/<[^>]*>/g, '').replace(/\{\\an?\d\}/g, '').trim();
        if (a === null || b === null || b <= a || !body) { skipped++; return; }
        out.push({ start: a, end: b, text: body });
      });
    } else {
      raw.split('\n').forEach(function (line) {
        var m = line.match(/^\s*\[\s*([\d:.,]+)\s*[-–]\s*([\d:.,]+)\s*\]\s*(.+)$/); if (!m) { if (line.trim()) { skipped++; } return; }
        var a = tsToSec(m[1]), b = tsToSec(m[2]);
        if (a === null || b === null || b <= a) { skipped++; return; } out.push({ start: a, end: b, text: m[3].trim() });
      });
    }
    var cues = normalize(out); return { cues: cues, skipped: skipped + (out.length - cues.length) };
  }
  function srtTime(t) {
    var ms = Math.max(0, Math.round((+t || 0) * 1000)), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, z = function (n, w) { return ('00' + n).slice(-w); };
    return z(h, 2) + ':' + z(m, 2) + ':' + z(s, 2) + ',' + z(ms % 1000, 3);
  }
  function formatSrt(cues) {
    return sortCues(cues).map(function (c, i) { return (i + 1) + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + String(c.text).replace(/\n{2,}/g, '\n'); }).join('\n\n') + (cues.length ? '\n' : '');
  }

  // Whisper segments [{start,end,text}] (seconds from the START OF WHAT WAS RECOGNIZED) -> cues on the video's own time line: +offset, cut to the video length, empty text / bad times dropped
  function fromSegments(segments, offset, duration) {
    var off = +offset > 0 ? +offset : 0, d = +duration > 0 ? +duration : 0;
    return normalize((Array.isArray(segments) ? segments : []).map(function (g) {
      if (!g) { return null; } var a = +g.start + off, b = +g.end + off, t = String(g.text == null ? '' : g.text).trim(); if (d > 0) { b = Math.min(b, d); }
      return t ? { start: a, end: b, text: t } : null;
    }));
  }

  // ---- dubs (voice-over recorded from the microphone): {id 'd<n>', start, duration, fileId (client file id of the recording), name}, sorted by start. Same style as the cues: every function returns a NEW list.
  var MAX_DUBS = 50;
  // a dub made by text-to-speech keeps what made it: {kind:'tts', text, lang, voiceId}; a microphone dub has none of these
  function ttsInfo(o) { return o && o.kind === 'tts' ? { kind: 'tts', text: cleanText(o.text), lang: String(o.lang || '').slice(0, 12), voiceId: String(o.voiceId || '').slice(0, 60) } : {}; }
  function normalizeDubs(list) {
    var seen = {}, out = [], n = 0;
    (Array.isArray(list) ? list : []).forEach(function (d) {
      if (!d || out.length >= MAX_DUBS) { return; } var a = +d.start, l = +d.duration; if (!isFinite(a) || !isFinite(l) || a < 0 || l <= 0) { return; }
      var id = typeof d.id === 'string' && /^d\d+$/.test(d.id) && !seen[d.id] ? d.id : null; if (id) { seen[id] = 1; n = Math.max(n, +id.slice(1)); }
      out.push(Object.assign({ id: id, start: r3(a), duration: r3(l), fileId: typeof d.fileId === 'string' ? d.fileId.slice(0, 64) : null, name: String(d.name == null ? '' : d.name).slice(0, 80) }, ttsInfo(d)));
    });
    out.forEach(function (d) { if (!d.id) { do { n++; } while (seen['d' + n]); d.id = 'd' + n; seen[d.id] = 1; } });
    return out.sort(function (a, b) { return a.start - b.start; });
  }
  function addDub(dubs, o) {
    o = o || {}; if (dubs.length >= MAX_DUBS) { return { ok: false, error: 'full', dubs: dubs }; }
    var a = +o.start, l = +o.duration; if (!isFinite(a) || a < 0 || !isFinite(l) || l <= 0) { return { ok: false, error: 'time', dubs: dubs }; }
    var n = 0; dubs.forEach(function (d) { n = Math.max(n, parseInt(String(d.id).slice(1), 10) || 0); }); var id = 'd' + (n + 1);
    return { ok: true, id: id, dubs: dubs.concat([Object.assign({ id: id, start: r3(a), duration: r3(l), fileId: o.fileId || null, name: String(o.name || ('配音 ' + (n + 1))).slice(0, 80) }, ttsInfo(o))]).sort(function (x, y) { return x.start - y.start; }) };
  }
  // move a dub: start >= 0, and inside the video when its length is known (it may run past the end: only its START has to be inside)
  function moveDub(dubs, id, start, videoDuration) {
    var i = dubs.findIndex(function (d) { return d.id === id; }); if (i < 0) { return { ok: false, error: 'missing', dubs: dubs }; }
    start = +start; if (!isFinite(start)) { return { ok: false, error: 'time', dubs: dubs }; } if (start < 0) { return { ok: false, error: 'negative', dubs: dubs }; }
    if (videoDuration > 0 && start >= videoDuration) { return { ok: false, error: 'beyond', dubs: dubs }; }
    var copy = dubs.slice(); copy[i] = Object.assign({}, dubs[i], { start: r3(start) }); return { ok: true, dubs: copy.sort(function (x, y) { return x.start - y.start; }) };
  }
  function removeDub(dubs, id) { var out = dubs.filter(function (d) { return d.id !== id; }); return { ok: out.length !== dubs.length, dubs: out }; }
  function activeDubs(dubs, t) { return dubs.filter(function (d) { return d.start <= t && t < d.start + d.duration; }); }

  // which samples of a decoded recording to recognize: from startSec, lenSec long (0 = to the end), never outside the recording -> { from, to } (to > from, or null when nothing is left)
  function pcmWindow(total, rate, startSec, lenSec) {
    var from = Math.min(total, Math.floor(Math.max(0, +startSec || 0) * rate)), to = +lenSec > 0 ? Math.min(total, from + Math.round(+lenSec * rate)) : total;
    return to > from ? { from: from, to: to } : null;
  }

  return { clock: clock, parseT: parseT, clampPanelWidth: clampPanelWidth, layout: layout, newProject: newProject, TABS: TABS, PANEL_MIN: PANEL_MIN,
    pcmWindow: pcmWindow, CUE_SECONDS: CUE_SECONDS, normalize: normalize, addCue: addCue, updateCue: updateCue, removeCue: removeCue, activeCue: activeCue, history: history, checkTimes: checkTimes, parseSrt: parseSrt, fromSegments: fromSegments, normalizeDubs: normalizeDubs, addDub: addDub, moveDub: moveDub, removeDub: removeDub, activeDubs: activeDubs, formatSrt: formatSrt, MAX_TEXT: MAX_TEXT };
}));
