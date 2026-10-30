// /edit-video as a DOMAIN of the general offline harness (renderer/src/harness/intent_harness.js, DESIGN.offline-harness.md): its frames (the video-editing vocabulary), its UML operations and the plain words of its tools. Pure, tested in Node: scripts/video-tests/video_semantics.test.js.
// INTENT DECOMPOSITION + SEMANTIC DERIVATION for the offline AI:
// A request is cut into atomic INTENTS (clause by clause: the command = a canonical verb, the object = clip / line / segment / dub / picture ...), every intent gets its arguments by DERIVING them from the words and from the editor's state:
//   "前半段" = 0 .. D/2, "最後 10 秒" = D-10 .. D, "第 3 句那一段" = the time range of line 3, "沒有字幕的地方" = the gaps between the lines, "只保留 A 到 B" = remove what is outside, "正中間" = D/2 ...
// Each derivation is recorded (derived[]) so the user sees WHY a number is what it is. What the request does not say and cannot be derived becomes a gap (a closed question), never a guess.
// The intents are then written as a UML use case (toUml: User -> VideoEditor.removeSegment(start,end) -> ...) for the CoLU unit catalog, which WIRES each step to a tool (video_* units) by name/semantics/types: the host fills the unit's parameters from intent.args by parameter NAME.
//   TwVideoSemantics.decompose(text, state) -> { intents:[{ text, op, args, derived[], gaps[] }], gaps[], derived[] }     state = { duration, now, cues:[{start,end,text}], clips:[{in,out,name}] }
//   TwVideoSemantics.toUml(intents) -> UML text     TwVideoSemantics.UNIT_INTENTS -> { unitName: 'synonyms (zh + en)' }     TwVideoSemantics.OPS -> the UML operations (canonical verbs) and the closed action each stands for
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(require('../harness/intent_harness.js')); } else { root.TwVideoSemantics = factory(root.FaHarness); } }(typeof self !== 'undefined' ? self : this, function (FH) {
  'use strict';
  var r3 = function (n) { return Math.round(n * 1000) / 1000; };
  var CN = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  function cn(s) { s = String(s == null ? '' : s).trim(); if (/^\d+(?:\.\d+)?$/.test(s)) { return Number(s); } var m = /^([一二兩三四五六七八九])?十([一二三四五六七八九])?$/.exec(s); if (m) { return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0); } return s.length === 1 && CN[s] != null ? CN[s] : null; }
  function clock(t) { t = Math.max(0, +t || 0); var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + (Math.round(s * 10) / 10).toFixed(1).replace(/\.0$/, ''); }
  var TT = '(\\d+(?::\\d+){1,2}(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*(?:秒|s\\b)?', NUMK = '(\\d+|[一二兩三四五六七八九十]+)';
  function tsec(x) { var p = String(x).split(':').map(Number); return p.reduce(function (a, b) { return a * 60 + b; }, 0); }
  var LANGS = [[/英文|英語|english/i, 'en-US'], [/日文|日語/, 'ja-JP'], [/韓文|韓語/, 'ko-KR'], [/廣東話|粵語/, 'zh-HK'], [/簡體|普通話|大陸/, 'zh-CN'], [/中文|華語|國語/, 'zh-TW']];
  function langOf(t) { for (var i = 0; i < LANGS.length; i++) { if (LANGS[i][0].test(t)) { return LANGS[i][1]; } } return ''; }
  var TRANS = [[/(?:取消|移除|不要|沒有|none)/, 'none'], [/(?:圓(?:圈|形)?(?:收合|收縮|縮小|向中心)|circle.?close)/i, 'circle-close'], [/(?:圓(?:圈|形)?|circle)/i, 'circle-open'], [/(?:百葉窗|blinds)/i, 'blinds'], [/(?:放大|zoom)/i, 'zoom'], [/(?:交叉淡化|溶解|疊化|dissolve)/i, 'dissolve'], [/(?:白色?淡|經過白|fade.?white)/i, 'fade-white'],
    [/(?:中心|center)[^。,]*?(?:上下|垂直)/i, 'split-v'], [/(?:中心|center|split)/i, 'split-h'], [/推[^。,]*?上|push.?up/i, 'push-up'], [/推[^。,]*?下|push.?down/i, 'push-down'], [/推[^。,]*?右|push.?right/i, 'push-right'], [/推|push/i, 'push-left'],
    [/(?:掃描線?|掃過|wipe)[^。,]*?(?:由右到左|從右)/i, 'wipe-right'], [/(?:掃描線?|掃過|wipe)[^。,]*?(?:由上到下|從上)/i, 'wipe-up'], [/(?:掃描線?|掃過|wipe)[^。,]*?(?:由下到上|從下)/i, 'wipe-down'], [/掃描線?|掃過|wipe/i, 'wipe-left'],
    [/(?:從左|左邊)[^。,]*?滑入/i, 'slide-right'], [/(?:從下|下面|下方)[^。,]*?滑入/i, 'slide-up'], [/(?:從上|上面|上方)[^。,]*?滑入/i, 'slide-down'], [/滑入|slide/i, 'slide-left'], [/淡入淡出|淡入|淡出|fade/i, 'fade']];
  function transOf(t) { for (var i = 0; i < TRANS.length; i++) { if (TRANS[i][0].test(t)) { return TRANS[i][1]; } } return null; }

  // ---- the UML operations (canonical verbs) and the closed action each one means; the unit it is WIRED to is decided by the catalog, not here
  var OPS = {
    splitClip: { tool: 'video_split', params: 'at:str', ret: 'bool' }, removeSegment: { tool: 'video_cut_range', params: 'start:str,end:str', ret: 'bool' }, removeClip: { tool: 'video_cut_clip', params: 'n:int', ret: 'bool' }, removeLine: { tool: 'video_cut_line', params: 'n:int', ret: 'bool' },
    setTransition: { tool: 'video_set_transition', params: 'n:str,type:str,dur:float', ret: 'bool' }, transcribeAudio: { tool: 'video_transcribe', params: 'start:str,end:str,every:float,lang:str', ret: 'bool' }, speakText: { tool: 'video_tts_dub', params: 'text:str,start:str,lang:str', ret: 'bool' },
    dubLine: { tool: 'video_tts_dub', params: 'n:int,lang:str', ret: 'bool' }, editLine: { tool: 'video_set_line', params: 'n:int,text:str', ret: 'bool' }, shiftLines: { tool: 'video_shift_lines', params: 'seconds:float', ret: 'bool' }, addMedia: { tool: 'video_add_media', params: 'kind:str,at:str', ret: 'bool' }
  };
  // what the catalog's units are called in plain words (zh + en): the SEMANTIC side of the wiring (the unit index = its name + summary + these)
  var UNIT_INTENTS = {
    video_split: '把影片切成兩段 分割 切開 切一刀 剪開 split cut the clip in two at a time splitClip',
    video_cut_range: '把某一段時間的影片拿掉 刪除一段 剪掉一段 去掉 移除一個區間 後面接上 remove segment delete range trim cut out removeSegment',
    video_cut_line: '刪除某一句逐字稿 刪掉第幾句字幕 remove subtitle line delete line removeLine',
    video_cut_clip: '刪除某一個片段 拿掉第幾個片段 remove clip delete clip removeClip',
    video_set_transition: '設定轉場效果 片段之間的轉場 淡入淡出 滑入 掃描線 圓圈展開 溶解 transition between clips fade wipe slide dissolve setTransition',
    video_transcribe: '辨識聲音產生逐字稿 語音辨識 聽寫 轉成文字 transcribe speech recognition subtitles from audio transcribeAudio',
    video_tts_dub: '用 TTS 配音 合成語音 朗讀文字 唸出來 把某一句配音 text to speech dub speak line speakText dubLine',
    video_set_line: '改某一句逐字稿的文字 修改字幕 edit line change subtitle text editLine',
    video_shift_lines: '逐字稿整體提早或延後 平移字幕時間 shift subtitles earlier later shiftLines',
    video_add_media: '加入影片 合併影片 插入圖片 疊上圖片 插入聲音 加入音樂 add video merge picture overlay sound addMedia'
  };

  // ---- reading a TIME SPAN out of words (and the state): -> { start, end, why } | null
  function spanIn(c, st) {
    var D = st.duration || 0, cues = st.cues || [], m, why;
    if ((m = new RegExp('(?:從|由|from)?\\s*' + TT + '\\s*(?:到|至|~|-|–|to)\\s*' + TT, 'i').exec(c))) { return { start: tsec(m[1]), end: tsec(m[2]), why: '' }; }
    if ((m = new RegExp('(?:從|由|from)\\s*' + TT + '\\s*(?:到|至|直到)?\\s*(?:結尾|最後|片尾|尾巴|end)').exec(c))) { return D ? { start: tsec(m[1]), end: D, why: '從 ' + clock(tsec(m[1])) + ' 到結尾 = 到 ' + clock(D) } : null; }
    if ((m = new RegExp('(?:從開頭|從頭|從最前面|從片頭)\\s*(?:到|至|直到)\\s*' + TT).exec(c))) { return { start: 0, end: tsec(m[1]), why: '從開頭 = 0:00' }; }
    if ((m = new RegExp('(?:從|由)\\s*' + TT + '\\s*(?:起|開始)?\\s*(?:往後|後|共|長)?\\s*(\\d+(?:\\.\\d+)?)\\s*秒').exec(c))) { return { start: tsec(m[1]), end: tsec(m[1]) + Number(m[2]), why: '' }; }
    if ((m = new RegExp('(?:前|開頭|片頭|最前面|頭)\\s*' + NUMK + '\\s*(?:秒|s)').exec(c))) { var n1 = cn(m[1]); if (n1 != null) { return { start: 0, end: n1, why: '前 ' + n1 + ' 秒 = 0:00 到 ' + clock(n1) }; } }
    if ((m = new RegExp('(?:後|最後|結尾|片尾|尾巴|最後面)\\s*' + NUMK + '\\s*(?:秒|s)').exec(c))) { var n2 = cn(m[1]); if (n2 != null && D > n2) { return { start: r3(D - n2), end: D, why: '最後 ' + n2 + ' 秒 = 影片長 ' + clock(D) + ' 往回 ' + n2 + ' 秒' }; } }
    if (/前半(?:段|部分|部)?|上半(?:段|部分)?|first half/i.test(c) && D) { return { start: 0, end: r3(D / 2), why: '前半段 = 0:00 到 ' + clock(D / 2) + '(影片長 ' + clock(D) + ' 的一半)' }; }
    if (/後半(?:段|部分|部)?|下半(?:段|部分)?|second half/i.test(c) && D) { return { start: r3(D / 2), end: D, why: '後半段 = ' + clock(D / 2) + ' 到結尾' }; }
    if (/(?:中間|中段|中央)(?:段|部分|三分之一)?/.test(c) && D) { return { start: r3(D / 3), end: r3(2 * D / 3), why: '中間 = 中間三分之一(' + clock(D / 3) + ' 到 ' + clock(2 * D / 3) + ')' }; }
    if ((m = new RegExp('第\\s*' + NUMK + '\\s*(?:句|列|行)(?:那[一]?(?:段|個地方|裡)|的(?:時間|時段|部分|範圍|畫面)|這[一]?段|所在的(?:時間|時段))').exec(c))) { var ln = cn(m[1]), cu = cues[ln - 1]; if (cu) { return { start: cu.start, end: cu.end, why: '第 ' + ln + ' 句 = 它的時間範圍 ' + clock(cu.start) + ' 到 ' + clock(cu.end) }; } return { gap: '第 ' + ln + ' 句不存在' }; }
    if ((m = new RegExp('第\\s*' + NUMK + '\\s*(?:個|段)?\\s*(?:片段|clip)').exec(c)) && (st.clips || []).length) { var k = cn(m[1]), cl = st.clips, s0 = 0, i; for (i = 0; i < cl.length; i++) { var len = cl[i].out - cl[i].in; if (i + 1 === k) { return { start: r3(s0), end: r3(s0 + len), why: '第 ' + k + ' 個片段 = 時間軸 ' + clock(s0) + ' 到 ' + clock(s0 + len) }; } s0 += len; } return { gap: '第 ' + k + ' 個片段不存在' }; }
    if (/(?:這段|目前這段|現在這段|播放位置起)/.test(c) && st.now != null) { return null; }
    return null;
  }
  // the stretches without any transcript line (>= 1 s), including the head and the tail
  function gapsOfCues(st, min) {
    var D = st.duration || 0, cues = (st.cues || []).slice().sort(function (a, b) { return a.start - b.start; }), out = [], at = 0; min = min || 1;
    cues.forEach(function (c) { if (c.start - at >= min) { out.push({ start: r3(at), end: r3(c.start) }); } at = Math.max(at, c.end); }); if (D - at >= min) { out.push({ start: r3(at), end: r3(D) }); } return out;
  }
  function timeIn(c) { var m = /(\d+(?::\d+){1,2}(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:秒|s\b)/.exec(c); return m ? tsec(m[1] || m[2]) : null; }
  var DEL = '(?:剪掉|刪掉|刪除|去掉|拿掉|砍掉|移除|切掉|剪去|不要|cut out|remove|delete|trim off)';
  var CLIPREF = new RegExp('第\\s*' + NUMK + '\\s*(?:個|段)?\\s*(?:片段|clip)', 'i'), LINEREF = new RegExp('第\\s*' + NUMK + '\\s*(?:句|列|行)');

  // ---- frames: [name, test(c), build(c, st) -> [intent...] ]; the first frame that fits the clause decides
  var FRAMES = [
    ['remove_gaps', function (c) { return new RegExp(DEL).test(c) && /(?:沒有|無|沒|空的)[^，。]{0,4}(?:逐字稿|字幕|文字|講話|說話)[^，。]{0,4}(?:地方|部分|片段|時段|段落|的)/.test(c); }, function (c, st) {
      var g = gapsOfCues(st, 1); if (!g.length) { return [{ op: 'removeSegment', args: {}, derived: [], gaps: ['沒有找到沒有逐字稿的地方(或逐字稿是空的)'] }]; }
      return g.slice().reverse().map(function (x) { return { op: 'removeSegment', args: { start: x.start, end: x.end }, derived: ['沒有逐字稿的地方 = ' + clock(x.start) + ' 到 ' + clock(x.end)], gaps: [] }; });
    }],
    ['keep', function (c) { return /只(?:要|保留|留下|留)|僅(?:保留|留)|only keep|keep only/i.test(c); }, function (c, st) {
      var sp = spanIn(c.replace(/只(?:要|保留|留下|留)|僅(?:保留|留)/, ''), st); if (!sp || sp.gap) { return [{ op: 'removeSegment', args: {}, derived: [], gaps: [(sp && sp.gap) || '只保留哪一段?(例如「只保留 0:10 到 0:40」「只留前半段」)'] }]; }
      var D = st.duration || 0, out = [], why = (sp.why ? sp.why + ';' : '') + '只保留這段 = 刪掉它前後的部分'; if (D > sp.end + 0.05) { out.push({ op: 'removeSegment', args: { start: sp.end, end: D }, derived: [why + '(先刪後面,前面的時間才不會變)'], gaps: [] }); } if (sp.start > 0.05) { out.push({ op: 'removeSegment', args: { start: 0, end: sp.start }, derived: [why], gaps: [] }); }
      return out.length ? out : [{ op: 'removeSegment', args: {}, derived: [], gaps: ['已經只有這一段了'] }];
    }],
    ['remove', function (c) { return new RegExp(DEL).test(c) && !/逐字稿|字幕/.test(c.replace(/(?:沒有|無)[^，。]{0,4}(?:逐字稿|字幕)/, '')) || (new RegExp(DEL).test(c) && (CLIPREF.test(c) || /(?:片段|影片|畫面|這段|那段)/.test(c))); }, function (c, st) {
      var mc = CLIPREF.exec(c); if (mc) { var n = cn(mc[1]); return [{ op: 'removeClip', args: { n: n }, derived: ['第 ' + n + ' 個片段'], gaps: n ? [] : ['第幾個片段?'] }]; }
      var ml = LINEREF.exec(c); if (ml && !/(?:那[一]?段|的時間|的時段|所在|這[一]?段)/.test(c)) { var nl = cn(ml[1]); return [{ op: 'removeLine', args: { n: nl }, derived: ['第 ' + nl + ' 句逐字稿'], gaps: [] }]; }
      var sp = spanIn(c, st); if (sp && sp.gap) { return [{ op: 'removeSegment', args: {}, derived: [], gaps: [sp.gap] }]; }
      if (sp) { return [{ op: 'removeSegment', args: { start: sp.start, end: sp.end }, derived: sp.why ? [sp.why] : [], gaps: [] }]; }
      return [{ op: 'removeSegment', args: {}, derived: [], gaps: ['要刪哪一段?(例如「刪除 0:10 到 0:20」「剪掉前 5 秒」「剪掉後半段」「刪掉第 2 個片段」)'] }];
    }],
    ['split', function (c) { return /(?:分割|切開|切成(?:兩|二|2)段|切一刀|剪開|一分為二|split)/i.test(c); }, function (c, st) {
      var t = timeIn(c), d = []; if (t == null) { if (/(?:正中間|一半|中間點|正中央)/.test(c) && st.duration) { t = r3(st.duration / 2); d.push('正中間 = 影片長 ' + clock(st.duration) + ' 的一半 = ' + clock(t)); } else { var ml = LINEREF.exec(c); if (ml && (st.cues || [])[cn(ml[1]) - 1]) { var cu = st.cues[cn(ml[1]) - 1]; t = /結束|後面|之後/.test(c) ? cu.end : cu.start; d.push('第 ' + cn(ml[1]) + ' 句' + (/結束|後面|之後/.test(c) ? '結束' : '開始') + '處 = ' + clock(t)); } } }
      if (t == null) { return [{ op: 'splitClip', args: {}, derived: ['沒說時間:用播放位置'], gaps: [] }]; } return [{ op: 'splitClip', args: { at: t }, derived: d, gaps: [] }];
    }],
    ['transition', function (c) { return /轉場|transition/i.test(c) || (/(?:片段|clip)[^，。]{0,4}(?:之間|間|交界|接縫)/i.test(c) && transOf(c)); }, function (c) {
      var type = transOf(c), mc = CLIPREF.exec(c) || /(?:clip|片段)\s*(\d+)/i.exec(c), a = { type: type || '' }, d = [], gaps = [];
      if (mc && !/(?:所有|全部|每個|每一個|all|each)/i.test(c)) { a.n = cn(mc[1]); d.push('轉場進入第 ' + a.n + ' 個片段(第 ' + (a.n - 1) + ' 與第 ' + a.n + ' 個之間)'); } else { a.n = 'all'; d.push('沒指定哪一個:所有片段之間'); }
      var du = /(\d+(?:\.\d+)?)\s*秒/.exec(c); if (du) { a.dur = Number(du[1]); } if (!type) { gaps.push('要哪一種轉場?(淡入淡出、滑入、掃描線、圓圈展開、百葉窗…)'); } return [{ op: 'setTransition', args: a, derived: d, gaps: gaps }];
    }],
    ['transcribe', function (c) { return /(?:辨識|辨认|(?:產生|生成|插入|加入|轉成?)[^，。]{0,8}逐字稿|聽寫|transcribe)/i.test(c) && !LINEREF.test(c); }, function (c, st) {
      var a = {}, d = [], sp = spanIn(c, st), ev = /每\s*(\d+(?:\.\d+)?)\s*(分鐘|分|秒)/.exec(c), lg = langOf(c);
      if (sp && !sp.gap) { a.start = sp.start; a.end = sp.end; if (sp.why) { d.push(sp.why); } } else if (/播放位置|這裡|目前位置|現在/.test(c) && st.now != null) { a.start = st.now; a.end = st.now + 2; d.push('播放位置起 2 秒'); } else { d.push('沒說範圍:整支影片'); }
      if (ev) { a.every = Number(ev[1]) * (ev[2] === '秒' ? 1 : 60); d.push('每 ' + a.every + ' 秒一個工作'); } if (lg) { a.lang = lg.slice(0, 2); } return [{ op: 'transcribeAudio', args: a, derived: d, gaps: [] }];
    }],
    ['dub', function (c) { return /(?:配音|朗讀|唸出來|念出來|tts)/i.test(c); }, function (c, st) {
      var lg = langOf(c), ml = LINEREF.exec(c), q = /[「『“"]([^」』”"]{1,80})[」』”"]/.exec(c), ts = timeIn(c), cues = st.cues || [];
      if (q) { var a0 = { text: q[1], start: ts != null ? ts : (st.now || 0) }; if (lg) { a0.lang = lg; } return [{ op: 'speakText', args: a0, derived: ts == null ? ['沒說時間:從播放位置'] : [], gaps: [] }]; }
      if (ml && !/(?:那[一]?段|的時間|的時段|所在|這[一]?段)/.test(c)) { var a1 = { n: cn(ml[1]) }; if (lg) { a1.lang = lg; } return [{ op: 'dubLine', args: a1, derived: [], gaps: [] }]; }
      var sp = spanIn(c, st), pick = [];
      if (sp && !sp.gap) { cues.forEach(function (cu, i) { if (cu.start >= sp.start - 0.05 && cu.end <= sp.end + 0.05 && String(cu.text || '').trim()) { pick.push(i + 1); } }); }
      else if (/(?:全部|所有|每一句|每句|整份|整段|整支)/.test(c)) { cues.forEach(function (cu, i) { if (String(cu.text || '').trim()) { pick.push(i + 1); } }); }
      if (!pick.length) { return [{ op: 'dubLine', args: {}, derived: [], gaps: [sp && sp.gap ? sp.gap : (cues.length ? '配音哪一句?(說「第 3 句」,或「全部」,或把要唸的字放在「」裡)' : '逐字稿是空的:先產生逐字稿,或把要唸的字放在「」裡')] }]; }
      return pick.slice(0, 50).map(function (n) { var a2 = { n: n }; if (lg) { a2.lang = lg; } return { op: 'dubLine', args: a2, derived: [], gaps: [] }; }).map(function (x, i) { if (i === 0) { x.derived = [(sp && sp.why ? sp.why + ';' : '') + '範圍內的逐字稿共 ' + pick.length + ' 句']; } return x; });
    }],
    ['edit_line', function (c) { return LINEREF.test(c) && /(?:改成|改為|換成|改)/.test(c); }, function (c) { var ml = LINEREF.exec(c), q = /[「『“"]([^」』”"]{1,200})[」』”"]/.exec(c) || /(?:改成|改為|換成)\s*[:：]?\s*(.+)$/.exec(c); return [{ op: 'editLine', args: q ? { n: cn(ml[1]), text: String(q[1]).trim() } : { n: cn(ml[1]) }, derived: [], gaps: q ? [] : ['要改成什麼字?'] }]; }],
    ['shift', function (c) { return /(?:提早|提前|延後|往後|往前|延遲)/.test(c) && /秒/.test(c) && !/片段|轉場/.test(c); }, function (c) { var m = /(\d+(?:\.\d+)?)\s*秒/.exec(c); return [{ op: 'shiftLines', args: m ? { seconds: (/提早|提前|往前/.test(c) ? -1 : 1) * Number(m[1]) } : {}, derived: [], gaps: m ? [] : ['要移幾秒?'] }]; }],
    ['add_media', function (c) { return /(?:加入|插入|新增|合併|接上|串接|疊上|add|insert|merge)/i.test(c) && /(?:影片|圖片|照片|圖|聲音|音樂|音效|音訊|video|picture|image|sound|audio)/i.test(c); }, function (c) { var t = timeIn(c), k = /(?:圖片|照片|圖|picture|image)/i.test(c) ? 'picture' : /(?:聲音|音樂|音效|音訊|sound|audio)/i.test(c) ? 'sound' : 'video', a = { kind: k }; if (t != null && k !== 'video') { a.at = t; } return [{ op: 'addMedia', args: a, derived: ['會開檔案選擇讓你挑檔'], gaps: [] }]; }]
  ];
  var DOMAIN = { id: 'video', label: '影片編輯器', className: 'VideoEditor', ops: OPS, unitIntents: UNIT_INTENTS, frames: FRAMES.map(function (f) { return { name: f[0], test: f[1], build: f[2] }; }) };
  if (FH) { FH.registerDomain(DOMAIN); }
  function decompose(text, state) { return FH ? FH.decompose('video', text, state) : { ok: false, intents: [], gaps: ['no harness'], derived: [] }; }
  function toUml(intents) { return FH ? FH.toUml(DOMAIN, intents) : ''; }
  return { DOMAIN: DOMAIN, decompose: decompose, toUml: toUml, spanIn: spanIn, gapsOfCues: gapsOfCues, OPS: OPS, UNIT_INTENTS: UNIT_INTENTS, FRAMES: FRAMES };
}));
