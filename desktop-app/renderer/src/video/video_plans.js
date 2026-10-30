// /edit-video: PLAN TEMPLATES for the offline AI -- a multi-step goal in one sentence ("cut the first 5 seconds", "keep only 0:10-0:40", "dub every line in English", "cut every 30 s") is expanded by the PROGRAM
// into the editor's closed actions (video_edit_ai.js OPS). No model writes the plan; the numbers come from the sentence (or from the state: the length of the video, the transcript lines), and every action is checked later by applyEdits.
// Same shape as DESIGN.offline-plans.md: goal classification by trigger words -> expansion into ordered steps -> the host runs them (preview first, then ONE undo step).
//   TwVideoPlans.GOALS   expand(text, state) -> { goal, label, edits, notes } | null      state = { duration, cues:[{text}], now, clips }
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.TwVideoPlans = factory(); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var NUM = '(\\d+(?:\\.\\d+)?)', T0 = '(\\d+(?::\\d+){1,2}(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*(?:秒|s)?', DEL = '(?:剪掉|刪掉|刪除|去掉|拿掉|砍掉|移除|不要|cut|remove|delete)';
  function sec(s) { var p = String(s).split(':').map(Number); return p.reduce(function (a, b) { return a * 60 + b; }, 0); }
  var LANGS = [[/英文|英語|english/i, 'en-US'], [/日文|日語/, 'ja-JP'], [/韓文|韓語/, 'ko-KR'], [/廣東話|粵語/, 'zh-HK'], [/簡體|普通話|大陸/, 'zh-CN'], [/中文|華語|國語/, 'zh-TW']];
  function langOf(t) { for (var i = 0; i < LANGS.length; i++) { if (LANGS[i][0].test(t)) { return LANGS[i][1]; } } return ''; }
  // each goal: id, label, re (trigger), plan(m, text, state) -> { edits } | { error }
  var GOALS = [
    { id: 'trim_head', label: '剪掉片頭', re: new RegExp(DEL + '[^，。]{0,6}?(?:片頭|開頭|開始|前面|最前面|前)\\s*' + T0 + '|(?:片頭|開頭|前面|最前面|前)\\s*' + T0 + '\\s*(?:不要|剪掉|刪掉|刪除|去掉|拿掉)', 'i'), plan: function (m) { var n = Number(m[1] != null && m[1] !== undefined ? sec(m[1]) : sec(m[2])); return n > 0 ? { edits: [{ op: 'remove_range', start: 0, end: n }] } : { error: '要剪幾秒？' }; } },
    { id: 'trim_tail', label: '剪掉片尾', re: new RegExp(DEL + '[^，。]{0,6}?(?:片尾|結尾|尾巴|最後|後面|最後面|後)\\s*' + T0 + '|(?:片尾|結尾|最後|後面)\\s*' + T0 + '\\s*(?:不要|剪掉|刪掉|刪除|去掉|拿掉)', 'i'), plan: function (m, t, st) { var n = m[1] != null ? sec(m[1]) : sec(m[2]); if (!(st.duration > n) || n <= 0) { return { error: '片尾要剪的秒數不合法' }; } return { edits: [{ op: 'remove_range', start: Math.round((st.duration - n) * 1000) / 1000, end: st.duration }] }; } },
    { id: 'keep_range', label: '只保留一段', re: new RegExp('只(?:要|保留|留下|留)\\s*' + T0 + '\\s*(?:到|至|~|-|–)\\s*' + T0, 'i'), plan: function (m, t, st) { var a = sec(m[1]), b = sec(m[2]); if (!(b > a)) { return { error: '結束要大於開始' }; } var e = []; if (st.duration > b + 0.05) { e.push({ op: 'remove_range', start: b, end: st.duration }); } if (a > 0.05) { e.push({ op: 'remove_range', start: 0, end: a }); } return e.length ? { edits: e } : { error: '已經是這一段了' }; } },
    { id: 'split_every', label: '每隔一段時間切一刀', re: new RegExp('每\\s*' + NUM + '\\s*(分鐘|分|秒)\\s*(?:就)?\\s*(?:切一刀|切開|分割|剪開)'), plan: function (m, t, st) { var step = Number(m[1]) * (m[2] === '秒' ? 1 : 60), e = []; if (!(step >= 1) || !(st.duration > step)) { return { error: '間隔不合法' }; } for (var p = step; p < st.duration - 0.2 && e.length < 40; p += step) { e.push({ op: 'split', at: Math.round(p * 1000) / 1000 }); } return e.length ? { edits: e } : { error: '沒有地方可以切' }; } },
    { id: 'dub_all', label: '全部逐字稿用 TTS 配音', re: /(?:全部|所有|每一句|每句|整份|整支|整段|每一列)[^，。]{0,10}?(?:配音|唸出來|念出來|朗讀)|(?:配音|唸出來|念出來|朗讀)[^，。]{0,6}?(?:全部|所有|每一句|每句)/, plan: function (m, t, st) { var lg = langOf(t), e = []; (st.cues || []).forEach(function (c, i) { if (String(c.text || '').trim() && e.length < 50) { var o = { op: 'add_tts_dub', n: i + 1 }; if (lg) { o.lang = lg; } e.push(o); } }); return e.length ? { edits: e } : { error: '逐字稿是空的,沒有可以配音的句子' }; } },
    { id: 'transcribe_all_chunks', label: '整支影片分段辨識', re: /(?:整支|整部|全部|整個)[^，。]{0,6}?(?:影片)?[^，。]{0,6}?(?:辨識|逐字稿|聽寫)/, plan: function (m, t, st) { var e = { op: 'transcribe' }, lg = langOf(t); if (lg) { e.lang = lg.slice(0, 2); } var ev = /每\s*(\d+(?:\.\d+)?)\s*(分鐘|分|秒)/.exec(t); if (ev) { e.every = Number(ev[1]) * (ev[2] === '秒' ? 1 : 60); } return { edits: [e] }; } }
  ];
  function expand(text, state) {
    var t = String(text || '').trim(), st = state || {}; if (!t) { return null; }
    for (var i = 0; i < GOALS.length; i++) {
      var m = GOALS[i].re.exec(t); if (!m) { continue; } var r = GOALS[i].plan(m, t, st);
      if (r && r.edits && r.edits.length) { return { goal: GOALS[i].id, label: GOALS[i].label, edits: r.edits, notes: [] }; }
      if (r && r.error) { return { goal: GOALS[i].id, label: GOALS[i].label, edits: [], notes: [r.error] }; }
    }
    return null;
  }

  // ---- the editor's actions <-> the app's agent tools (video_*): the SAME closed actions, so the chat agent, the offline trainer, the plan templates and the CoLU catalog all drive the editor through one vocabulary
  var STR = { type: 'string' }, TIME = { type: 'string', description: 'seconds or m:ss(.s) on the timeline' };
  var TOOLS = {
    video_split: { op: 'split', desc: '在影片編輯器的時間軸上,把播放位置(或指定時間 at)的片段切成兩段。回傳 {ok: true, applied: [], clips: 2, total: 12.5}', props: { at: TIME } },
    video_cut_range: { op: 'remove_range', desc: '把影片編輯器時間軸上 start 到 end 之間的影片整段拿掉,後面的內容(逐字稿、配音、圖片)往前接。回傳 {ok: true, applied: [], clips: 2, total: 12.5}', props: { start: TIME, end: TIME }, required: ['start', 'end'] },
    video_cut_line: { op: 'remove_cue', desc: '把影片編輯器逐字稿第 n 句整句刪掉。回傳 {ok: true, applied: [], lines: 4, total: 12.5}', props: { n: { type: 'integer', description: 'line number, 1-based' } }, required: ['n'] },
    video_cut_clip: { op: 'remove_clip', desc: '把影片編輯器時間軸上第 n 個片段拿掉。回傳 {ok: true, applied: [], clips: 2, total: 12.5}', props: { n: { type: 'integer', description: 'clip number, 1-based' } }, required: ['n'] },
    video_set_transition: { op: 'set_transition', desc: '設定影片編輯器裡片段之間的轉場(進入第 n 個片段,n>=2;n 不給=全部)。type: none fade fade-white dissolve slide-left slide-right slide-up slide-down push-left push-right push-up push-down wipe-left wipe-right wipe-up wipe-down split-h split-v circle-open circle-close blinds zoom。回傳 {ok: true, applied: [], clips: 3, total: 12.5}', props: { n: { type: 'string', description: 'clip number >= 2, or all' }, type: { type: 'string', enum: ['none', 'fade', 'fade-white', 'dissolve', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'push-left', 'push-right', 'push-up', 'push-down', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'split-h', 'split-v', 'circle-open', 'circle-close', 'blinds', 'zoom'] }, dur: { type: 'number', description: 'seconds, 0.2-3' } }, required: ['type'] },
    video_transcribe: { op: 'transcribe', desc: '在影片編輯器裡把某段時間的聲音辨識成逐字稿(Whisper,排進編輯器的工作佇列,不是立刻完成)。every=每幾秒一個工作。回傳 {ok: true, applied: [], clips: 1, total: 12.5}', props: { start: TIME, end: TIME, secs: { type: 'number', description: 'length from start' }, every: { type: 'number', description: 'seconds per job' }, lang: { type: 'string', enum: ['zh', 'en', 'ja', 'ko'] } } },
    video_tts_dub: { op: 'add_tts_dub', desc: '在影片編輯器裡把文字(或第 n 句逐字稿)用 TTS 合成成配音,放在 start 秒。回傳 {ok: true, applied: [], dubs: 1, total: 12.5}', props: { n: { type: 'integer', description: 'transcript line number' }, text: STR, start: TIME, lang: { type: 'string', description: 'zh-TW zh-CN zh-HK en-US en-GB ja-JP ko-KR' }, voice: STR } },
    video_set_line: { op: 'set_text', desc: '把影片編輯器逐字稿第 n 句的文字改成 text。回傳 {ok: true, applied: [], lines: 5, total: 12.5}', props: { n: { type: 'integer', description: 'line number' }, text: STR }, required: ['n', 'text'] },
    video_shift_lines: { op: 'shift', desc: '把影片編輯器的逐字稿整體提早(負數)或延後 seconds 秒。回傳 {ok: true, applied: [], lines: 5, total: 12.5}', props: { seconds: { type: 'number' } }, required: ['seconds'] },
    video_add_media: { op: 'add_video', desc: '在影片編輯器加入素材:kind=video 接在時間軸最後(合併)、picture 在 at 秒疊一張圖、sound 在 at 秒加一段聲音;會開檔案選擇讓使用者挑檔。回傳 {ok: true, applied: [], clips: 2, total: 12.5}', props: { kind: { type: 'string', enum: ['video', 'picture', 'sound'] }, at: TIME }, required: ['kind'] }
  };
  var ARG_KEYS = { split: ['at'], remove_range: ['start', 'end'], remove_clip: ['n'], remove_cue: ['n'], set_transition: ['n', 'type', 'dur'], transcribe: ['start', 'end', 'secs', 'every', 'lang'], add_tts_dub: ['n', 'text', 'start', 'lang', 'voice'], set_text: ['n', 'text'], shift: ['seconds'], add_video: [], add_picture: ['at'], add_sound: ['at'] };
  function toOp(name, args) {
    var t = TOOLS[name]; if (!t) { return null; } var a = args || {}, op = t.op;
    if (name === 'video_add_media') { op = a.kind === 'picture' ? 'add_picture' : a.kind === 'sound' ? 'add_sound' : 'add_video'; }
    var e = { op: op }; (ARG_KEYS[op] || []).forEach(function (k) { if (a[k] !== undefined && a[k] !== null && a[k] !== '') { e[k] = a[k]; } });
    if (op === 'set_transition' && e.n === undefined) { e.n = 'all'; } return e;
  }
  function toTool(e) {
    if (!e || !e.op) { return null; } var name = null; Object.keys(TOOLS).forEach(function (k) { if (TOOLS[k].op === e.op) { name = k; } }); var args = {};
    if (e.op === 'add_video' || e.op === 'add_picture' || e.op === 'add_sound') { name = 'video_add_media'; args.kind = e.op === 'add_video' ? 'video' : e.op === 'add_picture' ? 'picture' : 'sound'; if (e.at !== undefined) { args.at = e.at; } return { name: name, args: args }; }
    if (!name) { return null; } (ARG_KEYS[e.op] || []).forEach(function (k) { if (e[k] !== undefined) { args[k] = e[k]; } }); return { name: name, args: args };
  }
  // ---- learn back: an ONLINE answer that worked ("在 0:30 分割" -> split at 30) becomes a general rule for the offline trainer: the numbers of the sentence turn into capture groups ("在 (\d+...) 分割"),
  // the quoted text into the {quoted} slot. -> { expr, steps:[{tool, args}] } | null when an argument cannot be found in the sentence (then only the exact sentence can be replayed)
  var NUMTOK = /\d+(?::\d+){1,2}(?:\.\d+)?|\d+(?:\.\d+)?/g, NUMARGS = { at: 1, start: 1, end: 1, secs: 1, every: 1, seconds: 1, dur: 1, n: 1 };
  function tokSec(tk) { return String(tk).split(':').map(Number).reduce(function (a, b) { return a * 60 + b; }, 0); }
  function generalize(text, edits) {
    var t = String(text || '').trim(), calls = (edits || []).map(toTool); if (!t || !calls.length || calls.some(function (c) { return !c; })) { return null; }
    var toks = [], m; NUMTOK.lastIndex = 0; while ((m = NUMTOK.exec(t))) { toks.push({ at: m.index, end: m.index + m[0].length, val: tokSec(m[0]), used: false }); }
    var q = /[「『“"]([^」』”"]{1,80})[」』”"]/.exec(t), groups = [], steps = [];
    for (var ci = 0; ci < calls.length; ci++) {
      var args = {}, c = calls[ci];
      for (var k in c.args) {
        if (!Object.prototype.hasOwnProperty.call(c.args, k)) { continue; } var v = c.args[k];
        if (NUMARGS[k] && v !== 'all' && isFinite(parseFloat(String(v).replace(/^-/, ''))) && /^-?[\d.:]+$/.test(String(v))) {
          var want = String(v).indexOf(':') >= 0 ? tokSec(v) : Math.abs(Number(v)), hit = null; toks.forEach(function (x) { if (!hit && !x.used && Math.abs(x.val - want) < 1e-6) { hit = x; } });
          if (!hit) { return null; } hit.used = true; groups.push(hit); args[k] = (Number(v) < 0 ? '-' : '') + '{' + 'G' + (groups.length) + '}';
        } else if (k === 'text') { if (q && q[1] === String(v)) { args[k] = '{quoted}'; } else { return null; } }
        else { args[k] = v; }
      }
      steps.push({ tool: c.name, args: args });
    }
    if (!groups.length && !steps.some(function (s0) { return JSON.stringify(s0.args).indexOf('{quoted}') >= 0; }) && /\d/.test(t)) { /* the sentence has numbers that no argument uses: keep them literal in the rule (an exact phrase) */ }
    // the groups are numbered in the order they appear in the sentence (the regex's order), so renumber G<n> by position
    var order = groups.slice().sort(function (a, b) { return a.at - b.at; }), idx = {}; order.forEach(function (g, i) { idx[groups.indexOf(g) + 1] = i + 1; });
    steps.forEach(function (s0) { Object.keys(s0.args).forEach(function (k) { s0.args[k] = String(s0.args[k]).replace(/\{G(\d+)\}/, function (x, n) { return '{' + idx[+n] + '}'; }); }); });
    var expr = '', pos = 0; function esc(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'); }
    order.forEach(function (g) { expr += esc(t.slice(pos, g.at)) + '(\\d+(?::\\d+){0,2}(?:\\.\\d+)?)'; pos = g.end; }); expr += esc(t.slice(pos));
    if (q) { expr = expr.replace(esc(q[1]), '[^」』”"]{1,80}'); }
    return { expr: '^\\s*' + expr + '\\s*$', steps: steps };
  }
  return { GOALS: GOALS, expand: expand, TOOLS: TOOLS, toOp: toOp, toTool: toTool, generalize: generalize };
}));
