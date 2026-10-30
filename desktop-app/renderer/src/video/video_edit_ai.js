// /edit-video "Ask AI": the pure part (no DOM, no model call; tested in Node: test/edit_video/video_edit_ai.test.js). Design: DESIGN.edit-video.md "Ask AI".
// The model (or the user's plain sentence, read by localParse) only ever produces CLOSED actions; applyEdits checks every one against the same rules the editor's own fields use and says what it did / refused.
//   TwVideoEditAi.OPS   editPrompt(cues, text, {duration, zh})   parseReply(text) -> {ok, say, edits, dropped, droppedOps}   applyEdits(cues, edits, duration, zh) -> {cues, applied, rejected, tts}   localParse(text, cues, {now, duration}) -> {edits, notes}
// Lines are named by their NUMBER in the list the model was shown (1-based, in time order) or by their id ("c3"); numbers are resolved against the list as it was BEFORE the batch, so an earlier action never renumbers a later one.
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(require('./video_edit_core.js')); } else { root.TwVideoEditAi = factory(root.TwVideoEdit); } }(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';
  var OPS = ['set_text', 'set_time', 'add_cue', 'remove_cue', 'shift', 'replace_text', 'merge', 'translate', 'add_tts_dub'], MAX_EDITS = 200;
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function str(x, n) { return String(x == null ? '' : x).slice(0, n || 500); }
  function num(x) { if (typeof x === 'number') { return isFinite(x) ? x : null; } var s = String(x == null ? '' : x).trim().replace(/\s*(?:秒|s|sec|seconds?)$/i, ''), neg = /^-/.test(s), t = core.parseT(s.replace(/^[-+]/, '')); return t === null ? null : neg ? -t : t; }
  function ref(x) { if (typeof x === 'number' && isFinite(x)) { return Math.round(x); } var s = str(x, 12).trim(); return /^\d+$/.test(s) ? +s : /^c\d+$/.test(s) ? s : null; }
  // only the fields an action may have are kept; anything else is dropped (the model cannot smuggle a field in)
  function normalizeEdit(e) {
    if (!isObj(e)) { return null; } var op = String(e.op || e.action || '').trim();
    if (OPS.indexOf(op) < 0) { return null; } var o = { op: op };
    if (op === 'set_text') { o.n = ref(e.n != null ? e.n : e.id); o.text = str(e.text); }
    else if (op === 'set_time') { o.n = ref(e.n != null ? e.n : e.id); if (e.start !== undefined) { o.start = num(e.start); } if (e.end !== undefined) { o.end = num(e.end); } }
    else if (op === 'add_cue') { o.start = num(e.start); if (e.end !== undefined) { o.end = num(e.end); } o.text = str(e.text); }
    else if (op === 'remove_cue') { o.n = ref(e.n != null ? e.n : e.id); }
    else if (op === 'shift') { o.seconds = num(e.seconds); if (e.from !== undefined) { o.from = ref(e.from); } if (e.to !== undefined) { o.to = ref(e.to); } }
    else if (op === 'replace_text') { o.find = str(e.find, 200); o.with = str(e.with != null ? e.with : e.replace, 200); if (e.n !== undefined) { o.n = ref(e.n); } }
    else if (op === 'merge') { o.n = ref(e.n != null ? e.n : e.id); }
    else if (op === 'translate') { o.items = (Array.isArray(e.items) ? e.items : []).slice(0, 500).map(function (it) { return isObj(it) ? { n: ref(it.n != null ? it.n : it.id), text: str(it.text) } : null; }).filter(Boolean); }
    else if (op === 'add_tts_dub') { if (e.n !== undefined) { o.n = ref(e.n); } if (e.text !== undefined) { o.text = str(e.text); } if (e.start !== undefined) { o.start = num(e.start); } o.lang = str(e.lang, 12).trim(); o.voice = str(e.voice, 60).trim(); }
    return o;
  }
  function parseReply(text) {
    var t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, ''), a = t.indexOf('{'), b = t.lastIndexOf('}'), arr = t.indexOf('['), obj;
    if (a < 0 || b <= a) { return { ok: false, error: 'no JSON' }; }
    try { obj = JSON.parse(t.slice(a, b + 1)); } catch (e) { try { obj = JSON.parse(t.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1')); } catch (e2) { return { ok: false, error: 'bad JSON' }; } }
    var list = Array.isArray(obj) ? obj : Array.isArray(obj.edits) ? obj.edits : obj.op ? [obj] : null; if (!list) { return { ok: false, error: 'no edits' }; }
    var edits = [], droppedOps = []; list.slice(0, MAX_EDITS).forEach(function (e0) { var e = normalizeEdit(e0); if (e) { edits.push(e); } else { droppedOps.push(str(isObj(e0) ? (e0.op || e0.action || '(no op)') : '(not an object)', 30)); } });
    return { ok: true, say: str(obj.say, 400), edits: edits, dropped: droppedOps.length, droppedOps: droppedOps };
  }
  function cueLines(cues) { return core.normalize(cues).map(function (c, i) { return (i + 1) + '. [' + core.clock(c.start) + ' - ' + core.clock(c.end) + '] ' + String(c.text).replace(/\n/g, ' / '); }).join('\n'); }
  function editPrompt(cues, text, o) {
    o = o || {}; var d = +o.duration > 0 ? ' (video length ' + core.clock(o.duration) + ')' : '';
    var system = 'You edit the transcript (subtitle lines) of a video' + d + '. Answer with ONE JSON object only: {"say":"one short sentence for the user","edits":[ ... ]}. Allowed actions (op), nothing else:\n' +
      '- {"op":"set_text","n":3,"text":"new text"}\n- {"op":"set_time","n":3,"start":"0:05.5","end":"0:08"}   (start / end optional; "m:ss.s" or seconds)\n- {"op":"add_cue","start":"0:10","end":"0:12","text":"..."}   (end optional: 2 s)\n- {"op":"remove_cue","n":3}\n' +
      '- {"op":"shift","seconds":-0.5,"from":2,"to":9}   (negative = earlier; from / to optional line numbers, default all)\n- {"op":"replace_text","find":"abc","with":"xyz","n":3}   (n optional: all lines)\n- {"op":"merge","n":3}   (line 3 and the next line become one)\n' +
      '- {"op":"translate","items":[{"n":1,"text":"..."},{"n":2,"text":"..."}]}   (rewrite many lines at once: translate, fix typos, shorten)\n' +
      '- {"op":"add_tts_dub","n":3,"lang":"en-US"}   (speak a transcript line with text-to-speech and add it as a dub starting at that line; or give "text" and "start" instead of "n"; lang optional: zh-TW zh-CN zh-HK en-US en-GB ja-JP ko-KR; "voice" optional)\n' +
      'Line numbers are the numbers in the list. Do not invent actions. If the request cannot be done with these actions, return {"say":"why","edits":[]}.';
    return { system: system, user: 'Transcript:\n' + (cueLines(cues) || '(empty)') + '\n\nRequest: ' + String(text || '') };
  }

  // the main entry: apply a batch of edits to a COPY; returns the new list, what was done (applied[]: {op, text}), what was refused (rejected[]: {op, error, text}) and the TTS dubs asked for (tts[]: {text, lang, voice, start, n}) -- those are made later by the host
  var ERR = { missing: ['找不到這一列', 'line not found'], negative: ['時間不能小於 0', 'time cannot be negative'], order: ['結束時間要大於開始時間', 'end must be after start'], beyond: ['超過影片長度', 'beyond the end of the video'], time: ['時間不正確', 'bad time'], full: ['逐字稿列數已達上限', 'transcript is full'], text: ['沒有文字', 'no text'], not_found: ['找不到要取代的字', 'text to replace not found'], arg: ['參數不完整', 'missing argument'], nomerge: ['後面沒有下一列可合併', 'no next line to merge'] };
  function applyEdits(cues, edits, duration, zh) {
    var cur = core.normalize(cues), ids = cur.map(function (c) { return c.id; }), applied = [], rejected = [], tts = [], dur = +duration > 0 ? +duration : 0;
    function W(a, b) { return zh ? a : b; }
    function resolve(r) { if (typeof r === 'number') { return ids[r - 1] || null; } return typeof r === 'string' && ids.indexOf(r) >= 0 ? r : null; }
    function find(id) { return cur.filter(function (c) { return c.id === id; })[0] || null; }
    function label(e) { return e.n != null ? W('第 ', 'line ') + e.n + W(' 句', '') : ''; }
    function ok(e, text) { applied.push({ op: e.op, text: text }); }
    function no(e, code) { var m = ERR[code] || [code, code]; rejected.push({ op: e.op, error: code, text: (label(e) ? label(e) + ':' : '') + W(m[0], m[1]) }); }
    (edits || []).slice(0, MAX_EDITS).forEach(function (e0) {
      var e = normalizeEdit(e0);
      if (!e || OPS.indexOf(e.op) < 0) { rejected.push({ op: String(e0 && e0.op), error: 'bad_op', text: W('不認得的動作', 'unknown action') }); return; }
      var id, r, c;
      if (e.op === 'set_text' || e.op === 'set_time' || e.op === 'remove_cue' || e.op === 'merge') { id = resolve(e.n); if (!id || !find(id)) { return no(e, 'missing'); } c = find(id); }
      if (e.op === 'set_text') { r = core.updateCue(cur, id, { text: e.text }, dur); if (!r.ok) { return no(e, r.error); } cur = r.cues; ok(e, label(e) + W(' 改成「', ' → "') + str(e.text, 40) + W('」', '"')); }
      else if (e.op === 'set_time') {
        if (e.start == null && e.end == null) { return no(e, 'arg'); } var p = {}; if (e.start != null) { p.start = e.start; } if (e.end != null) { p.end = e.end; }
        r = core.updateCue(cur, id, p, dur); if (!r.ok) { return no(e, r.error); } cur = r.cues; var n2 = find(id); ok(e, label(e) + W(' 時間改為 ', ' time → ') + core.clock(n2.start) + ' - ' + core.clock(n2.end));
      }
      else if (e.op === 'add_cue') {
        if (e.start == null) { return no(e, 'time'); } if (dur > 0 && e.start >= dur) { return no(e, 'beyond'); } var end = e.end != null ? e.end : e.start + core.CUE_SECONDS; if (dur > 0 && e.end == null) { end = Math.min(end, dur); }
        var terr = core.checkTimes(e.start, end, dur); if (terr) { return no(e, terr); } if (cur.length >= 5000) { return no(e, 'full'); }
        var base = cur.length ? Math.max.apply(null, cur.map(function (x) { return parseInt(x.id.slice(1), 10) || 0; })) : 0, nid = 'c' + (base + 1);
        cur = core.normalize(cur.concat([{ id: nid, start: e.start, end: end, text: e.text }])); ok(e, W('新增 ', 'add ') + core.clock(e.start) + ' 「' + str(e.text, 40) + '」');
      }
      else if (e.op === 'remove_cue') { cur = core.removeCue(cur, id).cues; ok(e, W('刪除第 ', 'delete line ') + e.n + W(' 句', '')); }
      else if (e.op === 'shift') {
        if (e.seconds == null || !isFinite(e.seconds) || e.seconds === 0) { return no(e, 'arg'); }
        var from = e.from != null ? ids.indexOf(resolve(e.from)) : 0, to = e.to != null ? ids.indexOf(resolve(e.to)) : ids.length - 1; if (from < 0 || to < 0 || to < from) { return no(e, 'missing'); }
        var pick = {}; ids.slice(from, to + 1).forEach(function (x) { pick[x] = 1; }); var bad = null, moved = cur.map(function (x) { if (!pick[x.id]) { return x; } var s = x.start + e.seconds, t = x.end + e.seconds, er = core.checkTimes(s, t, dur); if (er && !bad) { bad = er; } return { id: x.id, start: s, end: t, text: x.text }; });
        if (bad) { return no(e, bad); } cur = core.normalize(moved); ok(e, (e.seconds < 0 ? W('提早 ', 'earlier by ') : W('延後 ', 'later by ')) + Math.abs(e.seconds) + W(' 秒(', ' s (') + (e.from != null || e.to != null ? W('第 ', 'lines ') + (from + 1) + '–' + (to + 1) + W(' 句', '') : W('全部', 'all')) + ')');
      }
      else if (e.op === 'replace_text') {
        if (!e.find) { return no(e, 'text'); } var only = e.n != null ? resolve(e.n) : null; if (e.n != null && !only) { return no(e, 'missing'); } var hits = 0;
        cur = cur.map(function (x) { if (only && x.id !== only) { return x; } var parts = x.text.split(e.find); if (parts.length < 2) { return x; } hits += parts.length - 1; return { id: x.id, start: x.start, end: x.end, text: parts.join(e.with) }; });
        if (!hits) { return no(e, 'not_found'); } cur = core.normalize(cur); ok(e, W('「', '"') + e.find + W('」換成「', '" → "') + e.with + W('」(', '" (') + hits + W(' 處)', ')'));
      }
      else if (e.op === 'merge') {
        var i = cur.indexOf(c), nx = cur[i + 1]; if (!nx) { return no(e, 'nomerge'); } var cjk = /[一-鿿぀-ヿ가-힣]$/.test(c.text) || /^[一-鿿぀-ヿ가-힣]/.test(nx.text);
        var m = { id: c.id, start: c.start, end: Math.max(c.end, nx.end), text: [c.text, nx.text].filter(Boolean).join(cjk ? '' : ' ').slice(0, 500) }; cur = core.normalize(cur.filter(function (x) { return x.id !== nx.id && x.id !== c.id; }).concat([m])); ok(e, W('合併第 ', 'merge line ') + e.n + W(' 句與下一句', ' with the next'));
      }
      else if (e.op === 'translate') {
        if (!e.items || !e.items.length) { return no(e, 'arg'); } var done = 0;
        e.items.forEach(function (it) { var tid = resolve(it.n); if (!tid) { return no({ op: 'translate', n: it.n }, 'missing'); } var rr = core.updateCue(cur, tid, { text: it.text }, dur); if (!rr.ok) { return no({ op: 'translate', n: it.n }, rr.error); } cur = rr.cues; done++; });
        if (done) { ok(e, W('整批改寫 ', 'rewrote ') + done + W(' 句', ' lines')); }
      }
      else if (e.op === 'add_tts_dub') {
        var src = e.n != null ? find(resolve(e.n)) : null; if (e.n != null && !src) { return no(e, 'missing'); }
        var tx = String(e.text != null && e.text !== '' ? e.text : (src ? src.text : '')).trim(), st = e.start != null ? e.start : (src ? src.start : null);
        if (!tx) { return no(e, 'text'); } if (st == null || !isFinite(st)) { return no(e, 'time'); } if (st < 0) { return no(e, 'negative'); } if (dur > 0 && st >= dur) { return no(e, 'beyond'); }
        tts.push({ text: tx.slice(0, 500), lang: e.lang || '', voice: e.voice || '', start: Math.round(st * 1000) / 1000, n: e.n != null ? e.n : null }); ok(e, W('TTS 配音 ', 'TTS dub ') + core.clock(st) + ' 「' + str(tx, 30) + '」' + (e.lang ? ' (' + e.lang + ')' : ''));
      }
    });
    return { cues: cur, applied: applied, rejected: rejected, tts: tts };
  }

  // ---- the user's plain sentence, read by the program (no model): the common edits that do not need one
  var CN = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  function nnum(s) {
    s = String(s || '').trim(); if (/^\d+$/.test(s)) { return +s; } var m = /^([一二兩三四五六七八九])?十([一二三四五六七八九])?$/.exec(s); if (m) { return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0); } return s.length === 1 && CN[s] != null ? CN[s] : null;
  }
  var LANGS = [[/(?:英文|英語|english)/i, 'en-US'], [/(?:日文|日語|japanese)/i, 'ja-JP'], [/(?:韓文|韓語|korean)/i, 'ko-KR'], [/(?:廣東話|粵語|香港)/, 'zh-HK'], [/(?:簡體|普通話|國語|大陸)/, 'zh-CN'], [/(?:中文|華語|台灣|國語)/, 'zh-TW']];
  function langIn(s) { for (var i = 0; i < LANGS.length; i++) { if (LANGS[i][0].test(s)) { return LANGS[i][1]; } } return ''; }
  var NUM = '(\\d+|[一二兩三四五六七八九十]+)', LINE = '第\\s*' + NUM + '\\s*(?:句|列|行|段)';
  function localParse(text, cues, ctx) {
    var t = String(text || '').trim().replace(/[。.!!]+$/, ''), edits = [], notes = [], m, list = core.normalize(cues);
    if (!t) { return { edits: edits, notes: notes }; }
    if ((m = new RegExp('^(?:請|麻煩|幫我)?(?:把|將)?\\s*' + LINE + '\\s*(?:的文字|的字幕)?\\s*(?:改成|改為|換成|改)\\s*[:：]?\\s*([\\s\\S]+)$').exec(t)) || (m = new RegExp('^(?:set|change)\\s+line\\s+(\\d+)\\s+(?:to|as)\\s*[:：]?\\s*([\\s\\S]+)$', 'i').exec(t))) {
      var n1 = nnum(m[1]); if (n1) { edits.push({ op: 'set_text', n: n1, text: m[2].replace(/^[「"『]|[」"』]$/g, '') }); } return { edits: edits, notes: notes };
    }
    if ((m = new RegExp('(?:把|將)?\\s*' + LINE + '\\s*(?:用\\s*([^\\s配]*?)\\s*)?(?:配音|念出來|唸出來|朗讀)').exec(t)) || (m = /(?:dub|speak|read)\s+line\s+(\d+)(?:\s+in\s+(\w+))?/i.exec(t))) {
      var n2 = nnum(m[1]); if (n2) { var e2 = { op: 'add_tts_dub', n: n2 }; var lg = langIn(m[2] || ''); if (lg) { e2.lang = lg; } edits.push(e2); } return { edits: edits, notes: notes };
    }
    if ((m = /(?:全部|所有|整個|整體|字幕|逐字稿)?\s*(提早|提前|往前|延後|往後|延遲|晚|早)\s*(\d+(?:\.\d+)?)\s*秒/.exec(t)) || (m = /(?:shift|move)\s+(?:all\s+)?(?:lines\s+)?(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)\s+(earlier|later)/i.exec(t))) {
      var early = /提早|提前|往前|早|earlier/i.test(m[1] + (m[2] || '')), sec = parseFloat(/^\d/.test(m[1]) ? m[1] : m[2]); edits.push({ op: 'shift', seconds: early ? -sec : sec }); return { edits: edits, notes: notes };
    }
    if (/(?:刪掉|刪除|移除|delete|remove)\s*(?:所有的?|全部的?|all\s+)?(?:空白|空的|沒有字|empty|blank)/i.test(t)) {
      list.forEach(function (c, i) { if (!String(c.text).trim()) { edits.push({ op: 'remove_cue', n: i + 1 }); } }); if (!edits.length) { notes.push('no empty line'); } return { edits: edits, notes: notes };
    }
    if ((m = new RegExp('(?:刪掉|刪除|移除)\\s*' + LINE).exec(t)) || (m = /(?:delete|remove)\s+line\s+(\d+)/i.exec(t))) { var n3 = nnum(m[1]); if (n3) { edits.push({ op: 'remove_cue', n: n3 }); } return { edits: edits, notes: notes }; }
    if ((m = new RegExp('(?:合併|合併第|merge)\\s*(?:line\\s*)?(?:第\\s*)?' + NUM, 'i').exec(t))) { var n4 = nnum(m[1]); if (n4) { edits.push({ op: 'merge', n: n4 }); } return { edits: edits, notes: notes }; }
    if ((m = /^(?:請|幫我)?(?:把|將)\s*[「"]?(.+?)[」"]?\s*(?:全部)?(?:換成|取代為|取代成|改成)\s*[「"]?(.+?)[」"]?$/.exec(t)) && !/第\s*\S+\s*(?:句|列|行|段)/.test(m[1])) { edits.push({ op: 'replace_text', find: m[1], with: m[2] }); return { edits: edits, notes: notes }; }
    return { edits: edits, notes: notes };
  }
  return { OPS: OPS, editPrompt: editPrompt, parseReply: parseReply, applyEdits: applyEdits, localParse: localParse, normalizeEdit: normalizeEdit, cueLines: cueLines, nnum: nnum };
}));
