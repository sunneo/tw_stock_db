// "code" and "terminal" visuals of "/media-presentation": a syntax-highlighted, scrollable code window (also for patches / unified
// diffs) and the canvas look of a terminal window.
//
// Pure like ai_chat_deck_core.js: no DOM, no network -- it only needs a 2D context to draw into, so node can test it against a mock
// canvas and the MP4 / PPTX exporters draw exactly what the player shows. The scroll position is the one piece of state (a viewer
// scrolling with the wheel, dragging the scrollbar, or the visual's own `autoscroll`); everything else is a function of the arguments.
//
// Loadable both as a browser global (window.AiChatDeckCode) and by node (test/media/deck_code.test.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatDeckCode = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // GitHub-dark flavoured; one palette for code, patches and the terminal so a deck with all three looks like one thing.
  var THEME = {
    bg: '#0d1117', bar: '#161b22', fg: '#e6edf3', gutter: '#6e7681', line: '#30363d',
    kw: '#ff7b72', str: '#a5d6ff', com: '#8b949e', num: '#79c0ff', fn: '#d2a8ff', type: '#ffa657', key: '#7ee787', pre: '#ff7b72', tag: '#7ee787', op: '#e6edf3', plain: '#e6edf3',
    add: 'rgba(46,160,67,0.25)', del: 'rgba(248,81,73,0.25)', hunk: 'rgba(56,139,253,0.18)', addFg: '#7ee787', delFg: '#ffa198', hunkFg: '#79c0ff', metaFg: '#d2a8ff', msgFg: '#c9d1d9',
    mark: 'rgba(210,153,34,0.22)', markBar: '#d29922', thumb: 'rgba(139,148,158,0.55)', thumbHot: 'rgba(200,208,216,0.8)', track: 'rgba(139,148,158,0.12)'
  };
  var MONO = '"DejaVu Sans Mono","Noto Sans Mono CJK TC","Consolas","Menlo","Courier New",monospace';
  var MAX_LINES = 20000, MAX_CHARS = 400000, TAB = 4;

  function words(s) { var o = {}; s.split(/\s+/).forEach(function (w) { if (w) { o[w] = true; } }); return o; }
  var C_KW = 'if else for while do switch case break continue return goto sizeof typedef struct union enum static const volatile extern inline register auto void int char short long float double signed unsigned bool true false NULL nullptr default new delete class public private protected virtual override namespace using template typename this try catch throw final';
  var SPECS = {
    c: { kw: words(C_KW + ' size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t'), line: ['//'], block: ['/*', '*/'], quotes: '"\'', pre: true, types: true },
    java: { kw: words(C_KW + ' abstract assert boolean byte extends implements import instanceof interface native package strictfp super synchronized throws transient var record sealed permits string String null'), line: ['//'], block: ['/*', '*/'], quotes: '"\'', types: true },
    cs: { kw: words(C_KW + ' abstract as base checked decimal delegate event explicit fixed foreach get set in interface internal is lock null object operator out params readonly ref sealed stackalloc string unchecked unsafe ushort var async await'), line: ['//'], block: ['/*', '*/'], quotes: '"\'', types: true },
    js: { kw: words('var let const function return if else for while do switch case break continue new delete typeof instanceof in of this class extends super import export from default async await yield try catch finally throw null undefined true false void static get set interface type enum implements public private protected readonly abstract as declare namespace module'), line: ['//'], block: ['/*', '*/'], quotes: '"\'`', multi: '`', types: true },
    go: { kw: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 byte rune bool error float32 float64'), line: ['//'], block: ['/*', '*/'], quotes: '"\'`', multi: '`', types: true },
    rust: { kw: words('as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn u8 u16 u32 u64 usize i8 i16 i32 i64 isize f32 f64 bool str String Vec Option Result Some None Ok Err'), line: ['//'], block: ['/*', '*/'], quotes: '"\'', types: true },
    py: { kw: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self cls print'), line: ['#'], quotes: '"\'', triple: true, types: true },
    rb: { kw: words('alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require require_relative include extend attr_accessor attr_reader attr_writer puts'), line: ['#'], quotes: '"\'', types: true },
    php: { kw: words('abstract and array as break case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global if implements include include_once instanceof interface isset list namespace new or print private protected public require require_once return static switch throw trait try unset use var while yield true false null'), line: ['//', '#'], block: ['/*', '*/'], quotes: '"\'', types: true, vars: '$' },
    sh: { kw: words('if then else elif fi for while until do done case esac in function select time return exit break continue export local readonly declare unset shift set source alias echo cd test true false'), line: ['#'], quotes: '"\'', vars: '$' },
    sql: { kw: words('select from where and or not in is null like between join left right inner outer full cross on group by order having limit offset insert into values update set delete create alter drop table index view database primary key foreign references unique default constraint as distinct union all case when then else end exists asc desc count sum avg min max begin commit rollback with'), line: ['--'], block: ['/*', '*/'], quotes: '"\'', nocase: true },
    json: { kw: words('true false null'), quotes: '"', keys: true },
    yaml: { kw: words('true false null yes no on off'), line: ['#'], quotes: '"\'', keys: true, yamlKeys: true },
    css: { kw: words('important'), block: ['/*', '*/'], quotes: '"\'', css: true },
    html: { kw: {}, block: ['<!--', '-->'], quotes: '"\'', tags: true },
    make: { kw: words('ifeq ifneq ifdef ifndef else endif include define endef override export'), line: ['#'], quotes: '"\'', vars: '$' },
    text: { kw: {}, quotes: '' }
  };
  var ALIASES = {
    c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', 'c++': 'c', ino: 'c', asm: 'c',
    java: 'java', kt: 'java', kotlin: 'java', scala: 'java', swift: 'java', dart: 'java', groovy: 'java',
    cs: 'cs', csharp: 'cs', 'c#': 'cs',
    js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js',
    go: 'go', golang: 'go', rs: 'rust', rust: 'rust',
    py: 'py', python: 'py', pyi: 'py', rb: 'rb', ruby: 'rb', erb: 'rb', rake: 'rb',
    php: 'php', sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', ksh: 'sh', console: 'sh', bat: 'sh',
    sql: 'sql', json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', conf: 'yaml',
    css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', xhtml: 'html',
    make: 'make', makefile: 'make', mk: 'make', cmake: 'make', dockerfile: 'sh',
    text: 'text', txt: 'text', log: 'text', md: 'text', plain: 'text'
  };

  function specOf(lang) { return SPECS[ALIASES[String(lang || '').toLowerCase()] || 'text'] || SPECS.text; }
  function langKey(lang) { return ALIASES[String(lang || '').toLowerCase()] || 'text'; }

  // 'a/src/foo.c' -> 'c'; 'Makefile' -> 'make'
  function langFromFilename(name) {
    var base = String(name || '').replace(/^[ab]\//, '').split('/').pop().toLowerCase();
    if (!base) { return null; }
    if (ALIASES[base]) { return ALIASES[base]; }
    var m = /\.([a-z0-9+#]+)$/.exec(base);
    return m && ALIASES[m[1]] ? ALIASES[m[1]] : null;
  }

  var PATCH_RE = /^(diff --git |diff -[a-z]+ |Index: \S|--- \S.*\n\+\+\+ \S|@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/m;
  function isPatch(text) { return PATCH_RE.test(String(text || '').slice(0, 20000)); }

  // A guess for code that came without a language: shebang, then telltale tokens. 'text' when nothing fits.
  function detectLang(text, filename) {
    var byName = langFromFilename(filename);
    if (byName) { return byName; }
    var s = String(text || '').slice(0, 4000);
    var m = /^#!.*\b(bash|sh|zsh|python\d?|ruby|node|php|perl)\b/.exec(s);
    if (m) { return ALIASES[m[1].replace(/\d$/, '')] || 'sh'; }
    if (/^\s*[{[]/.test(s) && /"\s*:\s*/.test(s)) { return 'json'; }
    if (/^\s*<(\?xml|!DOCTYPE|html|svg|\w+[\s>])/i.test(s)) { return 'html'; }
    if (/^\s*#include\s*[<"]|\b(?:int|void|char)\s+\**\w+\s*\([^)]*\)\s*\{?/.test(s)) { return 'c'; }
    if (/^\s*(def |class \w+.*:|import \w+|from \w+ import)/m.test(s)) { return 'py'; }
    if (/\b(function\s*\w*\s*\(|const\s+\w+\s*=|let\s+\w+\s*=|=>\s*[{(]|console\.log)/.test(s)) { return 'js'; }
    if (/^\s*(select|insert|update|delete|create)\s/im.test(s)) { return 'sql'; }
    if (/^\s*package\s+\w+|\bfunc\s+\w+\(/m.test(s)) { return 'go'; }
    if (/^\s*[\w.-]+:\s*(\S.*)?$/m.test(s) && !/[{;]\s*$/m.test(s)) { return 'yaml'; }
    if (/^\s*(\$ |#\s|[a-z_]+=\S)/m.test(s)) { return 'sh'; }
    return 'text';
  }

  // ------------------------------------------------------------------ tokenizer
  // tokenizeLine(line, spec, st) -> [[cls, text], ...]; st = {block: endMarker|null, str: delimiter|null} is carried from line to line.
  function newState() { return { block: null, str: null }; }

  function pushRun(runs, cls, text) {
    if (!text) { return; }
    var last = runs[runs.length - 1];
    if (last && last[0] === cls) { last[1] += text; } else { runs.push([cls, text]); }
  }

  var NUM_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[uUlLfF]*)/;

  function tokenizeLine(line, spec, st) {
    var runs = [], i = 0, n = line.length, ch, m;
    var ident = spec.yamlKeys ? /^[A-Za-z_][\w.\/-]*/ : /^[A-Za-z_$][\w$]*/;
    while (i < n) {
      if (st.block) {
        var e = line.indexOf(st.block, i);
        if (e < 0) { pushRun(runs, 'com', line.slice(i)); return runs; }
        pushRun(runs, 'com', line.slice(i, e + st.block.length)); i = e + st.block.length; st.block = null; continue;
      }
      if (st.str) {
        var j = i, closed = false;
        while (j < n) {
          if (line[j] === '\\' && st.str.length === 1) { j += 2; continue; }
          if (line.substr(j, st.str.length) === st.str) { j += st.str.length; closed = true; break; }
          j++;
        }
        pushRun(runs, 'str', line.slice(i, Math.min(j, n)));
        i = Math.min(j, n);
        if (closed) { st.str = null; }
        continue;
      }
      ch = line[i];
      if (ch === ' ' || ch === '\t') { var k = i; while (k < n && (line[k] === ' ' || line[k] === '\t')) { k++; } pushRun(runs, 'plain', line.slice(i, k)); i = k; continue; }
      // preprocessor (#include / #define) of the C family: the whole directive word
      if (spec.pre && ch === '#' && /^\s*$/.test(line.slice(0, i))) {
        m = /^#\s*[a-z_]+/.exec(line.slice(i));
        if (m) { pushRun(runs, 'pre', m[0]); i += m[0].length; continue; }
      }
      var cmt = null;
      (spec.line || []).forEach(function (lc) { if (!cmt && line.substr(i, lc.length) === lc && !(lc === '#' && spec.vars === '$' && line[i - 1] === '$')) { cmt = lc; } });
      if (cmt && !(cmt === '#' && spec.yamlKeys && i > 0 && !/\s/.test(line[i - 1]))) { pushRun(runs, 'com', line.slice(i)); return runs; }
      if (spec.block && line.substr(i, spec.block[0].length) === spec.block[0]) { st.block = spec.block[1]; pushRun(runs, 'com', spec.block[0]); i += spec.block[0].length; continue; }
      // html / xml tags
      if (spec.tags && ch === '<' && (m = /^<\/?[A-Za-z][\w:-]*|^<[!?][\w-]*/.exec(line.slice(i)))) { pushRun(runs, 'tag', m[0]); i += m[0].length; continue; }
      if (spec.tags && (ch === '>' || line.substr(i, 2) === '/>')) { var tl = ch === '>' ? 1 : 2; pushRun(runs, 'tag', line.substr(i, tl)); i += tl; continue; }
      if (spec.tags && (m = /^[A-Za-z_:][\w:.-]*(?=\s*=)/.exec(line.slice(i)))) { pushRun(runs, 'type', m[0]); i += m[0].length; continue; }
      // strings
      if (spec.quotes && spec.quotes.indexOf(ch) >= 0) {
        var q = ch;
        if (spec.triple && line.substr(i, 3) === q + q + q) { q = q + q + q; }
        if (q.length === 1 && q !== spec.multi) {
          // a single-line string: scan to its end here so an unterminated one cannot swallow the rest of the file
          var p = i + 1, ok = false;
          while (p < n) { if (line[p] === '\\') { p += 2; continue; } if (line[p] === q) { p++; ok = true; break; } p++; }
          p = Math.min(p, n);
          var isKey = spec.keys && ok && /^\s*:/.test(line.slice(p));
          pushRun(runs, isKey ? 'key' : 'str', line.slice(i, p)); i = p;
        } else { st.str = q; pushRun(runs, 'str', q); i += q.length; }
        continue;
      }
      if (spec.vars && ch === spec.vars && (m = /^\$(?:\{[^}]*\}|[A-Za-z_]\w*|[0-9@#?*!$-])/.exec(line.slice(i)))) { pushRun(runs, 'num', m[0]); i += m[0].length; continue; }
      if (/\d/.test(ch) && !/[\w$]/.test(line[i - 1] || ' ') && (m = NUM_RE.exec(line.slice(i)))) { pushRun(runs, 'num', m[0]); i += m[0].length; continue; }
      if (spec.css && (m = /^[A-Za-z-]+(?=\s*:)/.exec(line.slice(i)))) { pushRun(runs, 'key', m[0]); i += m[0].length; continue; }
      if (spec.css && (m = /^[.#@][\w-]+/.exec(line.slice(i)))) { pushRun(runs, 'type', m[0]); i += m[0].length; continue; }
      if ((m = ident.exec(line.slice(i)))) {
        var w = m[0], after2 = line.slice(i + w.length), lw = spec.nocase ? w.toLowerCase() : w, cls = 'plain';
        if (spec.kw[lw]) { cls = 'kw'; }
        else if (spec.keys && spec.yamlKeys && /^\s*:(\s|$)/.test(after2)) { cls = 'key'; }
        else if (/^\s*\(/.test(after2)) { cls = 'fn'; }
        else if (spec.types && /^[A-Z][A-Za-z0-9_]*$/.test(w) && w.length > 1) { cls = 'type'; }
        pushRun(runs, cls, w); i += w.length; continue;
      }
      pushRun(runs, 'op', ch); i++;
    }
    return runs;
  }

  // Source text -> rows [{type:'code', n, runs}] (n = 1-based source line). Tabs become TAB spaces; very long input is cut (the window says so).
  function normalizeText(text) {
    var s = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\t/g, new Array(TAB + 1).join(' '));
    var cut = false;
    if (s.length > MAX_CHARS) { s = s.slice(0, MAX_CHARS); cut = true; }
    var lines = s.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') { lines.pop(); }
    if (lines.length > MAX_LINES) { lines = lines.slice(0, MAX_LINES); cut = true; }
    return { lines: lines, cut: cut };
  }

  function highlightCode(text, lang) {
    var norm = normalizeText(text), spec = specOf(lang), st = newState();
    var rows = norm.lines.map(function (l, k) { return { type: 'code', n: k + 1, runs: tokenizeLine(l, spec, st) }; });
    return { rows: rows, cut: norm.cut };
  }

  // A patch (git diff / format-patch / plain unified diff) -> rows. Each file's code is highlighted in the language of its filename;
  // + / - / context rows carry the old and the new line number from the hunk header.
  // Models often write patches loosely: a bare "@@" header with no line ranges, context lines without the leading space. Such a hunk is read
  // in "loose" mode -- a line starting with + is added, - is removed, anything else is context -- until the next file header / hunk; no line numbers then.
  var PATCH_HEADER_RE = /^(--- |\+\+\+ |index |new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to) |copy (from|to) |Binary files |diff )/;
  function highlightPatch(text, fallbackLang) {
    var norm = normalizeText(text), rows = [], file = null, spec = specOf(fallbackLang), stNew = newState(), stOld = newState();
    var oldN = 0, newN = 0, inHunk = false, loose = false, seenFile = false, remOld = 0, remNew = 0, files = [], m;
    function setFile(name) {
      var lg = langFromFilename(name); file = name; spec = lg ? specOf(lg) : specOf(fallbackLang);
      if (name && files.indexOf(name) < 0) { files.push(name); }
    }
    function body(l, kind) {
      var c = kind === 'plain' ? ' ' : l[0], text2 = kind === 'plain' ? l : l.slice(1);
      if (c === '\\') { rows.push({ type: 'meta', runs: [['com', l]] }); return; }
      if (c === '+') { rows.push({ type: 'add', o: null, n: loose ? null : newN++, runs: tokenizeLine(text2, spec, stNew) }); if (!loose) { remNew--; } }
      else if (c === '-') { rows.push({ type: 'del', o: loose ? null : oldN++, n: null, runs: tokenizeLine(text2, spec, stOld) }); if (!loose) { remOld--; } }
      else { tokenizeLine(text2, spec, stOld); rows.push({ type: 'ctx', o: loose ? null : oldN++, n: loose ? null : newN++, runs: tokenizeLine(text2, spec, stNew) }); if (!loose) { remOld--; remNew--; } }
    }
    norm.lines.forEach(function (l) {
      var isHeader = PATCH_HEADER_RE.test(l) || /^@@/.test(l);
      // inside a loose hunk everything that is not a header / new hunk is a hunk line
      if (inHunk && loose && !isHeader) { body(l, /^[ +\-\\]/.test(l) ? 'prefixed' : 'plain'); return; }
      if (inHunk && !loose && (remOld > 0 || remNew > 0) && (/^[ +\-\\]/.test(l) || l === '')) { body(l === '' ? ' ' : l, 'prefixed'); return; }
      inHunk = false;
      if ((m = /^@@(?: -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@)?(.*)$/.exec(l))) {
        stNew = newState(); stOld = newState(); inHunk = true; seenFile = true;
        if (m[1] != null) {
          loose = false; oldN = +m[1]; newN = +m[3]; remOld = m[2] == null ? 1 : +m[2]; remNew = m[4] == null ? 1 : +m[4];
          var runs = [['hunk', '@@ -' + m[1] + (m[2] != null ? ',' + m[2] : '') + ' +' + m[3] + (m[4] != null ? ',' + m[4] : '') + ' @@']];
          if (m[5]) { tokenizeLine(m[5], spec, newState()).forEach(function (r) { runs.push(r); }); }
          rows.push({ type: 'hunk', runs: runs });
        } else { loose = true; rows.push({ type: 'hunk', runs: [['hunk', l]] }); }
        return;
      }
      if ((m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l))) { setFile(m[2]); seenFile = true; rows.push({ type: 'file', runs: [['meta', l]] }); return; }
      if ((m = /^\+\+\+ (?:b\/)?(\S+)/.exec(l)) && !/^\+\+\+ \/dev\/null/.test(l)) { setFile(m[1]); seenFile = true; rows.push({ type: 'meta', runs: [['meta', l]] }); return; }
      if (PATCH_HEADER_RE.test(l)) { seenFile = true; rows.push({ type: 'meta', runs: [['meta', l]] }); return; }
      // the commit message / mail header in front of the first file of a format-patch
      rows.push({ type: seenFile ? 'meta' : 'msg', runs: [[seenFile ? 'com' : 'msg', l]] });
    });
    return { rows: rows, cut: norm.cut, files: files };
  }

  // ------------------------------------------------------------------ window
  var BAR_H = 46, PAD = 18, SB = 12;

  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function ease(u) { return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; }

  function titleBar(ctx, rect, title, badge) {
    ctx.fillStyle = THEME.bar; ctx.fillRect(rect.x, rect.y, rect.w, BAR_H);
    ctx.fillStyle = THEME.line; ctx.fillRect(rect.x, rect.y + BAR_H - 1, rect.w, 1);
    ['#ff5f56', '#ffbd2e', '#27c93f'].forEach(function (c, k) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(rect.x + 26 + k * 26, rect.y + BAR_H / 2, 7, 0, Math.PI * 2); ctx.fill(); });
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = '22px ' + MONO; ctx.fillStyle = THEME.fg;
    var tx = rect.x + 110;
    if (title) { ctx.fillText(String(title).slice(0, 70), tx, rect.y + BAR_H / 2 + 1); }
    if (badge) {
      ctx.font = '18px ' + MONO; var bw = ctx.measureText(badge).width + 20;
      ctx.fillStyle = 'rgba(139,148,158,0.22)'; rrect(ctx, rect.x + rect.w - bw - 16, rect.y + 9, bw, BAR_H - 18, 8); ctx.fill();
      ctx.fillStyle = THEME.gutter; ctx.textAlign = 'center'; ctx.fillText(badge, rect.x + rect.w - bw / 2 - 16, rect.y + BAR_H / 2 + 1);
    }
  }

  // create({code, lang, patch, filename, size, start_line, highlight:[[a,b]], autoscroll, wrap}) -> a drawable code window.
  //   draw(ctx, rect, t)  the window in rect (design units); t only matters while autoscroll runs and nobody has scrolled by hand
  //   scrollBy(dx, dy) / scrollToLine(n) / reset()  the viewer's scrolling (marks the window as hand-scrolled)
  //   hitThumb(x, y) / dragThumb(axis, delta)       the scrollbar of the last drawn frame
  function create(opts) {
    opts = opts || {};
    var code = String(opts.code == null ? '' : opts.code);
    var patch = opts.patch === true || (opts.patch !== false && (/^(diff|patch)$/i.test(opts.lang || '') || isPatch(code)));
    var lang = patch ? 'diff' : (opts.lang && ALIASES[String(opts.lang).toLowerCase()] ? ALIASES[String(opts.lang).toLowerCase()] : detectLang(code, opts.filename));
    var parsed = patch ? highlightPatch(code, opts.fallbackLang || (opts.filename && langFromFilename(opts.filename)) || 'text') : highlightCode(code, lang);
    var rows = parsed.rows;
    var size = clamp(+opts.size || 24, 14, 44), lh = Math.round(size * 1.5);
    var marks = (opts.highlight || []).map(function (r) { return Array.isArray(r) ? [r[0], r[1] == null ? r[0] : r[1]] : [r, r]; });
    var st = { x: 0, y: 0, user: false }, last = null, cw = 0, cwFont = '';
    var maxLen = 1, numW = 0;
    rows.forEach(function (r) { var len = r.runs.reduce(function (a, x) { return a + x[1].length; }, 0) + (r.type === 'add' || r.type === 'del' || r.type === 'ctx' ? 1 : 0); if (len > maxLen) { maxLen = len; } });
    rows.forEach(function (r) { numW = Math.max(numW, String(r.n || 0).length, String(r.o || 0).length); });
    numW = Math.max(numW, 2);
    var title = opts.filename || (patch ? (parsed.files && parsed.files.length ? parsed.files.length + ' file' + (parsed.files.length > 1 ? 's' : '') + ' changed' : 'patch') : '');
    var badge = patch ? 'patch' : (lang === 'text' ? '' : lang);

    function metrics(ctx) {
      var f = size + 'px ' + MONO;
      if (cwFont !== f) { ctx.font = f; cw = ctx.measureText('0').width || size * 0.6; cwFont = f; }
      var gut = patch ? (numW * 2 + 3) * cw : (numW + 2) * cw;
      return { gut: gut };
    }

    function bounds() {
      if (!last) { return { maxX: 0, maxY: 0 }; }
      return { maxX: Math.max(0, last.contentW - last.viewW), maxY: Math.max(0, last.contentH - last.viewH) };
    }

    function autoY(t, maxY) {
      var period = opts.autoscroll === true ? 12 : +opts.autoscroll;
      if (!(period > 0) || maxY <= 0) { return null; }
      var u = (t || 0) / period;
      if (opts.mode === 'timed') { return ease(clamp(u, 0, 1)) * maxY; }
      var ph = u % 2; return ease(ph <= 1 ? ph : 2 - ph) * maxY;
    }

    function draw(ctx, rect, t) {
      ctx.save();
      rrect(ctx, rect.x, rect.y, rect.w, rect.h, 14); ctx.clip();
      ctx.fillStyle = THEME.bg; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      titleBar(ctx, rect, title, badge);
      var body = { x: rect.x, y: rect.y + BAR_H, w: rect.w, h: rect.h - BAR_H };
      var mt = metrics(ctx), gut = mt.gut + PAD;
      var contentH = rows.length * lh + PAD, contentW = gut + maxLen * cw + PAD * 2;
      var viewH = body.h, viewW = body.w;
      last = { body: body, contentW: contentW, contentH: contentH, viewH: viewH, viewW: viewW, gut: gut };
      var bd = bounds();
      if (!st.user) {
        var a = autoY(t, bd.maxY);
        if (a != null) { st.y = a; }
        else if (!st.init) { st.y = opts.start_line > 1 ? clamp((opts.start_line - 1) * lh, 0, bd.maxY) : 0; }
        st.init = true;
      }
      st.x = clamp(st.x, 0, bd.maxX); st.y = clamp(st.y, 0, bd.maxY);
      ctx.save();
      ctx.beginPath(); ctx.rect(body.x, body.y, body.w, body.h); ctx.clip();
      ctx.font = size + 'px ' + MONO; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      var first = Math.max(0, Math.floor(st.y / lh)), lastRow = Math.min(rows.length - 1, Math.ceil((st.y + viewH) / lh));
      for (var i = first; i <= lastRow; i++) {
        var r = rows[i], y = body.y + 8 + i * lh - st.y, ymid = y + lh / 2;
        var bg = r.type === 'add' ? THEME.add : r.type === 'del' ? THEME.del : r.type === 'hunk' ? THEME.hunk : null;
        var marked = r.n != null && !patch && marks.some(function (mk) { return r.n >= mk[0] && r.n <= mk[1]; });
        if (marked) { bg = THEME.mark; }
        if (bg) { ctx.fillStyle = bg; ctx.fillRect(body.x, y, body.w, lh); }
        if (marked) { ctx.fillStyle = THEME.markBar; ctx.fillRect(body.x, y, 5, lh); }
        // gutter (fixed: it does not move sideways)
        ctx.fillStyle = THEME.gutter; ctx.textAlign = 'right';
        if (patch) {
          if (r.o != null) { ctx.fillText(String(r.o), body.x + PAD + numW * cw, ymid); }
          if (r.n != null) { ctx.fillText(String(r.n), body.x + PAD + (numW * 2 + 1) * cw, ymid); }
        } else if (r.n != null) { ctx.fillText(String(r.n), body.x + PAD + numW * cw, ymid); }
        ctx.textAlign = 'left';
        var x = body.x + gut - st.x;
        if (r.type === 'add' || r.type === 'del' || r.type === 'ctx') {
          ctx.fillStyle = r.type === 'add' ? THEME.addFg : r.type === 'del' ? THEME.delFg : THEME.gutter;
          ctx.fillText(r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ', x, ymid); x += cw;
        }
        for (var k = 0; k < r.runs.length; k++) {
          var run = r.runs[k], wpx = run[1].length * cw;
          if (x + wpx >= body.x + gut - 2 && x <= body.x + body.w) {
            ctx.fillStyle = run[0] === 'hunk' ? THEME.hunkFg : run[0] === 'meta' ? THEME.metaFg : run[0] === 'msg' ? THEME.msgFg : (THEME[run[0]] || THEME.plain);
            ctx.fillText(run[1], x, ymid);
          }
          x += wpx;
        }
      }
      // the gutter stays readable over text that scrolled sideways
      if (st.x > 0) { ctx.fillStyle = THEME.bg; ctx.fillRect(body.x + gut - 8, body.y, 8, body.h); }
      if (parsed.cut) { ctx.fillStyle = THEME.markBar; ctx.textAlign = 'right'; ctx.font = '18px ' + MONO; ctx.fillText('(內容過長,只顯示前 ' + rows.length + ' 行)', body.x + body.w - 28, body.y + body.h - 16); }
      ctx.restore();
      // scrollbars
      [['y', true], ['x', false]].forEach(function (a2) {
        var g = thumbGeom(a2[0]); if (!g) { return; }
        ctx.fillStyle = THEME.track; rrect(ctx, g.track.x, g.track.y, g.track.w, g.track.h, SB / 2); ctx.fill();
        ctx.fillStyle = st.drag === a2[0] ? THEME.thumbHot : THEME.thumb; rrect(ctx, g.thumb.x, g.thumb.y, g.thumb.w, g.thumb.h, SB / 2); ctx.fill();
      });
      ctx.restore();
    }

    function thumbGeom(axis) {
      if (!last) { return null; }
      var b = bounds(), body = last.body;
      if (axis === 'y') {
        if (b.maxY <= 0) { return null; }
        var tr = { x: body.x + body.w - SB - 4, y: body.y + 6, w: SB, h: body.h - 12 - (b.maxX > 0 ? SB + 4 : 0) };
        var th = Math.max(40, tr.h * last.viewH / last.contentH);
        return { track: tr, thumb: { x: tr.x, y: tr.y + (tr.h - th) * (b.maxY ? st.y / b.maxY : 0), w: SB, h: th }, travel: tr.h - th, max: b.maxY };
      }
      if (b.maxX <= 0) { return null; }
      var trx = { x: body.x + last.gut, y: body.y + body.h - SB - 4, w: body.w - last.gut - SB - 12, h: SB };
      var thw = Math.max(40, trx.w * (last.viewW - last.gut) / (last.contentW - last.gut));
      return { track: trx, thumb: { x: trx.x + (trx.w - thw) * (b.maxX ? st.x / b.maxX : 0), y: trx.y, w: thw, h: SB }, travel: trx.w - thw, max: b.maxX };
    }

    return {
      kind: 'code', lang: lang, patch: patch, rows: rows, files: parsed.files || [], lineHeight: lh, cut: parsed.cut,
      draw: draw,
      get scrollY() { return st.y; }, get scrollX() { return st.x; }, get handScrolled() { return st.user; },
      scrollBy: function (dx, dy) { st.user = true; st.x += dx || 0; st.y += dy || 0; var b = bounds(); st.x = clamp(st.x, 0, b.maxX); st.y = clamp(st.y, 0, b.maxY); },
      scrollToLine: function (n) { st.user = true; st.y = clamp((n - 1) * lh, 0, bounds().maxY); },
      reset: function () { st.user = false; st.init = false; st.x = 0; st.y = 0; st.drag = null; },
      bodyRect: function () { return last && last.body; },
      // is (x, y) (design units) on a scrollbar thumb of the last frame? -> 'x' | 'y' | null
      hitThumb: function (x, y) {
        var found = null;
        ['y', 'x'].forEach(function (a) { var g = thumbGeom(a); if (!found && g && x >= g.thumb.x - 8 && x <= g.thumb.x + g.thumb.w + 8 && y >= g.thumb.y && y <= g.thumb.y + g.thumb.h) { found = a; } });
        return found;
      },
      dragThumb: function (axis, delta) { var g = thumbGeom(axis); if (!g || g.travel <= 0) { return; } st.user = true; st.drag = axis; if (axis === 'y') { st.y += delta / g.travel * g.max; } else { st.x += delta / g.travel * g.max; } var b = bounds(); st.x = clamp(st.x, 0, b.maxX); st.y = clamp(st.y, 0, b.maxY); },
      endDrag: function () { st.drag = null; },
      // a track click pages (like a native scrollbar)
      hitTrack: function (x, y) { var g = thumbGeom('y'); return !!g && x >= g.track.x - 8 && x <= g.track.x + g.track.w + 8 && y >= g.track.y && y <= g.track.y + g.track.h; }
    };
  }

  // ------------------------------------------------------------------ terminal window (canvas look; the live one is a DOM overlay)
  // What MP4 / PPTX show of a terminal is its last screen WITH xterm's colours and attributes: snapshotTerminal() reads the cells of the real
  // xterm buffer into a plain object (rows of styled runs) and drawTerminal() paints that, cell by cell on the character grid. The same object
  // goes into a deck pack and back into a fresh terminal (snapshotToAnsi) -- the screen the viewer left is the screen they find again.
  var XTERM_ANSI = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];   // xterm.js' own default palette
  function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }
  function paletteColor(n) {
    if (n < 16) { return XTERM_ANSI[n]; }
    if (n < 232) { var k = n - 16, lv = [0, 95, 135, 175, 215, 255]; return '#' + hex2(lv[Math.floor(k / 36)]) + hex2(lv[Math.floor(k / 6) % 6]) + hex2(lv[k % 6]); }
    var g = 8 + (n - 232) * 10; return '#' + hex2(g) + hex2(g) + hex2(g);
  }
  function cellColor(isDefault, isRgb, isPalette, value) {
    if (isDefault) { return null; }
    if (isRgb) { return '#' + hex2((value >> 16) & 255) + hex2((value >> 8) & 255) + hex2(value & 255); }
    if (isPalette) { return paletteColor(value); }
    return null;
  }
  function isWide(ch) { var c = ch.codePointAt(0); return c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)); }

  // term = an xterm.js Terminal (anything with buffer.active.getLine(y).getCell(x), cols, rows). -> {cols, rows, cursor, bg, fg, lines: [[{t, fg, bg, b, i, u, d, v}]]}
  // fg / bg are CSS colours or null (= the terminal's default); v = inverse. Only the rows on screen (the viewport), like a screenshot.
  function snapshotTerminal(term, theme) {
    var buf = term.buffer.active, cols = term.cols, rows = term.rows, lines = [], cell;
    for (var y = 0; y < rows; y++) {
      var line = buf.getLine(buf.viewportY + y), runs = [], cur = null;
      if (line) {
        for (var x = 0; x < cols; x++) {
          cell = line.getCell(x, cell); if (!cell) { break; }
          if (cell.getWidth() === 0) { continue; }   // the right half of a wide character
          var ch = cell.getChars() || ' ';
          var st = { fg: cellColor(cell.isFgDefault(), cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor()), bg: cellColor(cell.isBgDefault(), cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor()),
            b: !!cell.isBold(), i: !!cell.isItalic(), u: !!cell.isUnderline(), d: !!cell.isDim(), v: !!cell.isInverse() };
          if (cur && cur.fg === st.fg && cur.bg === st.bg && cur.b === st.b && cur.i === st.i && cur.u === st.u && cur.d === st.d && cur.v === st.v) { cur.t += ch; }
          else { cur = Object.assign({ t: ch }, st); runs.push(cur); }
        }
      }
      // trailing plain blanks carry no information (a blank with a background, inverse video or underline does)
      while (runs.length) {
        var lr = runs[runs.length - 1];
        if (lr.bg || lr.v || lr.u) { break; }
        lr.t = lr.t.replace(/ +$/, '');
        if (lr.t) { break; }
        runs.pop();
      }
      lines.push(runs);
    }
    theme = theme || {};
    return { cols: cols, rows: rows, cursor: { x: buf.cursorX, y: buf.cursorY }, bg: theme.background || '#000000', fg: theme.foreground || '#e8e8e8', lines: lines };
  }

  function rgbOf(css) { var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css || ''); return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null; }

  // Snapshot -> the escape sequences that paint it on a fresh, empty terminal of the same size (clear, then every row; the cursor ends where it was).
  function snapshotToAnsi(snap) {
    var out = '\x1b[0m\x1b[2J\x1b[H', last = -1;
    snap.lines.forEach(function (runs, y) { if (runs.length) { last = y; } });
    last = Math.max(last, snap.cursor ? snap.cursor.y : 0);
    for (var y = 0; y <= last; y++) {
      (snap.lines[y] || []).forEach(function (r) {
        var codes = ['0'];
        if (r.b) { codes.push('1'); } if (r.d) { codes.push('2'); } if (r.i) { codes.push('3'); } if (r.u) { codes.push('4'); } if (r.v) { codes.push('7'); }
        var f = rgbOf(r.fg), g = rgbOf(r.bg);
        if (f) { codes.push('38;2;' + f.join(';')); } if (g) { codes.push('48;2;' + g.join(';')); }
        out += '\x1b[' + codes.join(';') + 'm' + r.t;
      });
      out += '\x1b[0m' + (y < last ? '\r\n' : '');
    }
    return out + (snap.cursor ? '\x1b[' + (snap.cursor.y + 1) + ';' + (snap.cursor.x + 1) + 'H' : '');
  }

  // lines = a snapshot (coloured, from snapshotTerminal) or an array of plain strings (a transcript before the shell has run).
  function drawTerminal(ctx, rect, lines, opts) {
    opts = opts || {};
    var snap = lines && !Array.isArray(lines) ? lines : null;
    var bgCol = snap ? snap.bg : '#000000', fgCol = snap ? snap.fg : '#e8e8e8';
    ctx.save();
    rrect(ctx, rect.x, rect.y, rect.w, rect.h, 14); ctx.clip();
    ctx.fillStyle = bgCol; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    titleBar(ctx, rect, opts.title || 'terminal', opts.badge === undefined ? 'busybox ash' : opts.badge);
    var size = clamp(+opts.size || 24, 10, 40), body = { x: rect.x + PAD, y: rect.y + BAR_H + 12, w: rect.w - PAD * 2, h: rect.h - BAR_H - 24 };
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    var rowsOut;   // [{runs: [{t, fg, bg, b, i, u, d, v}], y: screen row}]
    if (snap) {
      var lastRow = 0; snap.lines.forEach(function (r, y) { if (r.length) { lastRow = y; } }); lastRow = Math.max(lastRow, snap.cursor ? snap.cursor.y : 0);
      rowsOut = snap.lines.slice(0, lastRow + 1).map(function (runs, y) { return { runs: runs, y: y }; });
    } else { rowsOut = (lines || []).map(function (l, y) { return { runs: [{ t: String(l), fg: /^[^\s]*[$#] /.test(l) ? '#7ee787' : null }], y: y }; }); }
    // the font is the largest that fits the terminal's own number of columns in the window, as the real terminal does
    var cols = snap ? snap.cols : Math.max(40, Math.floor(body.w / (size * 0.6)));
    ctx.font = size + 'px ' + MONO; var cw = ctx.measureText('0').width || size * 0.6;
    if (cw * cols > body.w) { size = Math.max(8, Math.floor(size * body.w / (cw * cols))); ctx.font = size + 'px ' + MONO; cw = ctx.measureText('0').width || size * 0.6; }
    var lh = Math.round(size * 1.3), fit = Math.max(1, Math.floor(body.h / lh)), shown = rowsOut.slice(-fit), first = shown.length ? shown[0].y : 0;
    shown.forEach(function (row) {
      var y = body.y + (row.y - first) * lh, col = 0;
      row.runs.forEach(function (r) {
        var fg = r.fg || fgCol, bg = r.bg || null;
        if (r.v) { var t = fg; fg = bg || bgCol; bg = t; }
        var w = 0; for (var i = 0; i < r.t.length; i++) { w += isWide(r.t[i]) ? 2 : 1; }
        if (bg) { ctx.fillStyle = bg; ctx.fillRect(body.x + col * cw, y, w * cw, lh); }
        ctx.font = (r.i ? 'italic ' : '') + (r.b ? 'bold ' : '') + size + 'px ' + MONO;
        ctx.globalAlpha = r.d ? 0.6 : 1; ctx.fillStyle = fg;
        if (/^[\x20-\x7e]*$/.test(r.t)) { ctx.fillText(r.t, body.x + col * cw, y + 2); }
        else { var cx = col; for (var k = 0; k < r.t.length; k++) { ctx.fillText(r.t[k], body.x + cx * cw, y + 2); cx += isWide(r.t[k]) ? 2 : 1; } }
        if (r.u) { ctx.fillRect(body.x + col * cw, y + lh - 3, w * cw, 1.5); }
        ctx.globalAlpha = 1; col += w;
      });
    });
    if (snap && snap.cursor && opts.cursor !== false && snap.cursor.y >= first && snap.cursor.y < first + fit) {
      ctx.fillStyle = fgCol; ctx.globalAlpha = 0.65; ctx.fillRect(body.x + snap.cursor.x * cw, body.y + (snap.cursor.y - first) * lh, cw, lh); ctx.globalAlpha = 1;
    }
    if (opts.note) { ctx.fillStyle = THEME.markBar; ctx.font = '18px ' + MONO; ctx.textAlign = 'right'; ctx.fillText(opts.note, rect.x + rect.w - 20, rect.y + rect.h - 30); }
    ctx.restore();
  }

  return {
    THEME: THEME, MONO: MONO, LIMITS: { lines: MAX_LINES, chars: MAX_CHARS },
    langFromFilename: langFromFilename, detectLang: detectLang, isPatch: isPatch, langKey: langKey,
    tokenizeLine: tokenizeLine, newState: newState, specOf: specOf, highlightCode: highlightCode, highlightPatch: highlightPatch,
    create: create, drawTerminal: drawTerminal, snapshotTerminal: snapshotTerminal, snapshotToAnsi: snapshotToAnsi, paletteColor: paletteColor
  };
});
