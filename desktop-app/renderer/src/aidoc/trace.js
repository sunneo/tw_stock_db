// AIDoc debugging locator, part 1 (pure functions, no DOM, no network): turn a pasted text backtrace / journal log into frames, rank the index's
// definitions for each frame, check the index's tree version against the trace, and check that an AI explanation only cites places we located.
// Exposes `FaAidocTrace` (browser, embedded into floating-assistant.js by scripts/embed-code-ui.js) and module.exports (node tests). Ported from the Redmine plugin redmine_ai_chat (ai_chat_aidoc_trace.js).
//   parse(text)            -> { frames:[{n,line_no,raw,fmt,func,qual,file,line,col,addr,off,module,lib}], versions:{...}, formats:[...] }
//   rankCandidates(frame, defs, opts) -> { status:'exact'|'file'|'unique'|'ambiguous'|'none', picks:[def...] }
//   treeCheck(treeRef, versions)      -> { level:'ok'|'warn'|'unknown', msg }
//   checkCitations(text, located)     -> { ok, bad:[ 'path:line'... ] }
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaAidocTrace = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // compiler-made suffixes that are not part of the source name: foo.isra.0, foo.part.1, foo.cold, foo.constprop.2, foo.lto_priv.0, foo.llvm.1234
  function cleanFunc(n) {
    var s = String(n || '');
    for (var i = 0; i < 4; i++) { var t = s.replace(/\.(?:isra|part|cold|constprop|lto_priv|llvm|localalias|clone)(?:\.\d+)*$/, ''); if (t === s) { break; } s = t; }
    return s;
  }
  // "ns::Cls::fn(args)" / "pkg.Class.method" / "crate::mod::fn::h0123456789abcdef" / "pkg.(*T).Method" -> { func, qual }
  function splitQualified(raw) {
    var s = String(raw || '').trim();
    s = s.replace(/::h[0-9a-f]{16}$/, '').replace(/\.\(\*?([A-Za-z0-9_]+)\)/g, '.$1');
    s = s.replace(/\s*\(.*$/, '').replace(/<.*$/, '');
    var parts = s.split(/::|\./).filter(Boolean);
    if (!parts.length) { return { func: '', qual: '' }; }
    var func = cleanFunc(parts[parts.length - 1]);
    return { func: func, qual: parts.slice(0, -1).join('::') };
  }
  function mk(o) {
    var f = { n: 0, line_no: o.line_no, raw: o.raw, fmt: o.fmt, func: '', qual: '', file: '', line: 0, col: 0, addr: '', off: '', module: '', lib: '' };
    for (var k in o) { f[k] = o[k]; }
    return f;
  }
  var FILE_EXT = '(?:c|cc|cpp|cxx|h|hh|hpp|hxx|S|s|rs|go|py|java|kt|js|mjs|ts|tsx|rb|php|cs|lua|sh|pl|swift|m|mm|inc|asm|dts|dtsi|v|vhd)';

  // each format: a regex over ONE line, and a builder. First matching format wins for a line.
  var FORMATS = [
    // gdb: "#3  0x00007ffff7a2d1c9 in foo (a=1) at src/x.c:123"  /  "#1  foo (a=1) at src/x.c:123"  /  "#4  0x... in __libc_start_main () from /lib/libc.so.6"
    { id: 'gdb', re: /^\s*#(\d+)\s+(?:(0x[0-9a-fA-F]+)\s+in\s+)?([^\s(][^()]*?)\s*\((.*)$/, build: function (m, o) {
      var rest = m[4], at = /\)\s+at\s+(\S+?):(\d+)\s*$/.exec(rest), fr = /\)\s+from\s+(\S+)\s*$/.exec(rest);
      var q = splitQualified(m[3]);
      return mk({ line_no: o.line_no, raw: o.raw, fmt: 'gdb', func: q.func, qual: q.qual, addr: m[2] || '', file: at ? at[1] : '', line: at ? +at[2] : 0, lib: fr ? fr[1] : '' });
    } },
    // AddressSanitizer / Valgrind-like: "#0 0x4f2a1c in foo /src/x.c:12:5"  /  "#1 0x... (/lib/libc.so.6+0x2d1c9)"
    { id: 'asan', re: /^\s*#(\d+)\s+(0x[0-9a-fA-F]+)\s+in\s+(\S+)\s+(\S+?):(\d+)(?::(\d+))?\s*$/, build: function (m, o) {
      var q = splitQualified(m[3]);
      return mk({ line_no: o.line_no, raw: o.raw, fmt: 'asan', func: q.func, qual: q.qual, addr: m[2], file: m[4], line: +m[5], col: +(m[6] || 0) });
    } },
    // glibc backtrace_symbols: "./prog(foo+0x1a) [0x401136]"  /  "/lib/x86_64-linux-gnu/libc.so.6(+0x2d1c9) [0x7f...]"
    { id: 'glibc', re: /^\s*(\S+?)\(([A-Za-z_][^+)\s]*)?(?:\+(0x[0-9a-fA-F]+))?\)\s*\[(0x[0-9a-fA-F]+)\]\s*$/, build: function (m, o) {
      var q = splitQualified(m[2] || '');
      return mk({ line_no: o.line_no, raw: o.raw, fmt: 'glibc', func: q.func, qual: q.qual, off: m[3] || '', addr: m[4], module: m[1] });
    } },
    // Linux kernel Oops / Call Trace: " foo+0x1a/0x80", " ? bar.isra.0+0x2c/0x90 [mymod]", "[<ffffffff81234567>] foo+0x1a/0x80", "RIP: 0010:foo+0x1a/0x80"
    { id: 'kernel', re: /^(?:\[\s*\d+\.\d+\]\s*)?\s*(?:RIP:\s*[0-9a-f]{4}:|PC is at\s+|LR is at\s+|pc\s*:\s*|lr\s*:\s*|\[<[0-9a-fA-F]+>\]\s*|\?\s*)?([A-Za-z_][\w.$]*)\+(0x[0-9a-fA-F]+)\/(0x[0-9a-fA-F]+)(?:\s+\[([\w.-]+)\])?\s*$/, build: function (m, o) {
      return mk({ line_no: o.line_no, raw: o.raw, fmt: 'kernel', func: cleanFunc(m[1]), off: m[2] + '/' + m[3], module: m[4] || '', inexact: /\?\s*[A-Za-z_]/.test(o.raw) });
    } },
    // Python: '  File "/app/x.py", line 12, in handler'
    { id: 'python', re: /^\s*File "([^"]+)", line (\d+)(?:, in (\S+))?\s*$/, build: function (m, o) {
      return mk({ line_no: o.line_no, raw: o.raw, fmt: 'python', func: m[3] && m[3][0] !== '<' ? m[3] : '', file: m[1], line: +m[2] });
    } },
    // Java: "at com.acme.Foo.bar(Foo.java:123)"
    { id: 'java', re: /^\s*at\s+([\w$.<>]+)\(([\w$.]+\.(?:java|kt|scala)):(\d+)\)\s*$/, build: function (m, o) {
      var q = splitQualified(m[1]);
      return mk({ line_no: o.line_no, raw: o.raw, fmt: 'java', func: q.func, qual: q.qual, file: m[2], line: +m[3] });
    } },
    // Node / browser JS: "at fn (/app/x.js:12:5)" / "at async fn (file:///app/x.mjs:12:5)" / "at /app/x.js:12:5"
    { id: 'js', re: /^\s*at\s+(?:async\s+)?(?:([\w$.<>\[\] ]+?)\s+\()?(?:file:\/\/)?([^\s()]+?\.(?:js|mjs|cjs|ts|tsx|jsx)):(\d+):(\d+)\)?\s*$/, build: function (m, o) {
      var q = splitQualified(m[1] || '');
      return mk({ line_no: o.line_no, raw: o.raw, fmt: 'js', func: q.func, qual: q.qual, file: m[2], line: +m[3], col: +m[4] });
    } },
    // Rust panic: "thread 'main' panicked at src/main.rs:5:9:" / "panicked at 'msg', src/main.rs:5:9"
    { id: 'rustpanic', re: /panicked at\s+(?:'[^']*',\s*)?([^\s:]+\.rs):(\d+)(?::(\d+))?/, build: function (m, o) {
      return mk({ line_no: o.line_no, raw: o.raw, fmt: 'rustpanic', file: m[1], line: +m[2], col: +(m[3] || 0) });
    } },
    // Rust backtrace location line: "             at ./src/x.rs:12:5"  (attaches to the frame above, see attachLocations)
    { id: 'at-loc', re: /^\s+at\s+(\S+?\.(?:rs|go|c|cc|cpp|h|hpp)):(\d+)(?::(\d+))?\s*$/, build: function (m, o) {
      return mk({ line_no: o.line_no, raw: o.raw, fmt: 'at-loc', file: m[1], line: +m[2], col: +(m[3] || 0), locOnly: true });
    } },
    // Rust backtrace function line: "   3: crate::mod::func"
    { id: 'rust', re: /^\s*(\d+):\s+(?:0x[0-9a-f]+\s+-\s+)?([A-Za-z_][\w:<>$ ,&'()]*?)\s*$/, build: function (m, o) {
      var q = splitQualified(m[2]);
      return mk({ line_no: o.line_no, raw: o.raw, fmt: 'rust', func: q.func, qual: q.qual });
    } },
    // Go: "main.handler(0xc000...)" followed by "\t/app/x.go:123 +0x1f"; the second line is the location
    { id: 'go-loc', re: /^\s+(\/?\S+?\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?\s*$/, build: function (m, o) {
      return mk({ line_no: o.line_no, raw: o.raw, fmt: 'go-loc', file: m[1], line: +m[2], locOnly: true });
    } },
    { id: 'go', re: /^((?:[\w./-]+)\.(?:\(\*?[\w]+\)\.)?[A-Za-z_]\w*)\((?:.*)\)\s*$/, build: function (m, o) {
      var q = splitQualified(m[1]);
      return mk({ line_no: o.line_no, raw: o.raw, fmt: 'go', func: q.func, qual: q.qual });
    } }
  ];
  var BARE_LOC = new RegExp('(?:^|[\\s\\[\\(\'"=:])(/?(?:[\\w.+@-]+/)*[\\w.+@-]+\\.' + FILE_EXT + '):(\\d+)(?::(\\d+))?(?![\\w])', 'g');

  function versionsOf(text) {
    var v = {};
    var m;
    if ((m = /Linux version (\S+)/.exec(text))) { v.kernel = m[1]; }
    else if ((m = /CPU:\s*\d+\s+PID:\s*\d+\s+Comm:\s*\S+(?:\s+(?:Not tainted|Tainted:[^\n]*?))?\s+(\d+\.\d+[\w.+-]*)\s+#/.exec(text))) { v.kernel = m[1]; }
    if ((m = /build[-_ ]?id[:= ]+([0-9a-f]{8,40})/i.exec(text))) { v.build_id = m[1].toLowerCase(); }
    if ((m = /\b(?:git[- ]?(?:commit|sha|hash|describe)|commit|revision)[:= ]+([0-9a-f]{7,40})\b/i.exec(text))) { v.git = m[1].toLowerCase(); }
    else if ((m = /\bg([0-9a-f]{7,12})\b/.exec(text)) && /\d+\.\d+[\w.+-]*-\d+-g[0-9a-f]{7,12}/.test(text)) { v.git = m[1]; }
    return v;
  }

  function parse(text) {
    var src = String(text == null ? '' : text).replace(/\r/g, '');
    var lines = src.split('\n'), frames = [], formats = {}, others = [];
    var last = null;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (!raw.trim()) { continue; }
      var f = null;
      for (var k = 0; k < FORMATS.length; k++) {
        var m = FORMATS[k].re.exec(raw);
        if (m) { f = FORMATS[k].build(m, { line_no: i + 1, raw: raw.trim() }); break; }
      }
      if (f && f.locOnly) {
        // the location line belongs to the function line just above (Go, Rust); alone it is a bare file:line frame
        if (last && !last.file && (last.fmt === 'go' || last.fmt === 'rust') && last.line_no === i) { last.file = f.file; last.line = f.line; last.col = f.col; last.raw += ' | ' + f.raw; last = null; continue; }
        f.fmt = f.fmt === 'go-loc' ? 'go' : 'rust'; f.locOnly = false;
      }
      if (f) {
        // a "rust"-shaped line ("12: something") must at least look like a path with :: , else it is ordinary text such as a numbered list
        if (f.fmt === 'rust' && !/::/.test(f.qual) && !/::/.test(raw)) { f = null; }
      }
      if (!f) {
        // anything else: bare file:line references (journal / syslog / compiler-style lines)
        BARE_LOC.lastIndex = 0;
        var bm, any = false;
        while ((bm = BARE_LOC.exec(raw))) { frames.push(mk({ line_no: i + 1, raw: raw.trim().slice(0, 300), fmt: 'log', file: bm[1], line: +bm[2], col: +(bm[3] || 0) })); formats.log = 1; any = true; }
        last = null;
        if (!any) { others.push({ line_no: i + 1, raw: raw.trim().slice(0, 400) }); }
        continue;
      }
      formats[f.fmt === 'go-loc' ? 'go' : f.fmt] = 1;
      frames.push(f);
      last = f;
    }
    frames.forEach(function (f, i) { f.n = i + 1; });
    return { frames: frames, others: others, versions: versionsOf(src), formats: Object.keys(formats) };
  }

  function norm(p) { return String(p || '').replace(/\\/g, '/').replace(/^file:\/\//, '').replace(/\/+/g, '/'); }
  // how many trailing path components agree (build paths like /build/src/linux-5.15/drivers/x.c vs the index's drivers/x.c)
  function suffixScore(framePath, indexPath) {
    var a = norm(framePath).split('/').filter(Boolean), b = norm(indexPath).split('/').filter(Boolean), n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) { n++; }
    return n === b.length || n === a.length ? n : n; // a full match of the shorter path is the strongest
  }
  function fullySuffixed(framePath, indexPath) {
    var a = norm(framePath), b = norm(indexPath);
    return a === b || a.slice(-b.length - 1) === '/' + b || b.slice(-a.length - 1) === '/' + a;
  }

  // defs = what the index returned for the frame's function name: [{name,kind,path,line,sig}] ; files = index files whose base name matches the frame's file
  // Result status: exact (name + file agree) / file (only the file is known) / unique (one definition, nothing contradicts) / ambiguous (several: all listed, uncertain) / none
  function rankCandidates(frame, defs, files, opts) {
    opts = opts || {};
    defs = defs || []; files = files || [];
    var out = { status: 'none', picks: [], files: [], note: '' };
    var sameCase = defs.filter(function (d) { return d.name === frame.func; });
    var pool = sameCase.length ? sameCase : defs;
    if (frame.file) {
      var inFile = pool.filter(function (d) { return fullySuffixed(frame.file, d.path); });
      var fileHit = files.filter(function (p) { return fullySuffixed(frame.file, p); });
      out.files = fileHit.slice(0, 5);
      if (inFile.length) { out.status = 'exact'; out.picks = inFile.slice(0, 5); if (inFile.length > 1) { out.note = '同一個檔案裡有多個同名定義'; } return out; }
      if (fileHit.length) { out.status = 'file'; out.picks = []; if (pool.length) { out.note = '索引裡有同名函式，但在別的檔案：' + pool.slice(0, 3).map(function (d) { return d.path; }).join('、'); } return out; }
    }
    if (!pool.length) { return out; }
    if (frame.file) {
      // the frame names a file that the tree does not have: a definition elsewhere with the same name is NOT the frame
      var best = 0;
      pool.forEach(function (d) { best = Math.max(best, suffixScore(frame.file, d.path)); });
      var near = pool.filter(function (d) { return suffixScore(frame.file, d.path) === best && best >= 1; });
      if (near.length === 1 && best >= 2) { out.status = 'unique'; out.picks = near; out.note = '堆疊的檔案路徑與索引不完全相同（' + frame.file + '）'; return out; }
      out.status = 'ambiguous'; out.picks = pool.slice(0, opts.maxCandidates || 6); out.note = '堆疊指的檔案 ' + frame.file + ' 不在索引裡，以下是同名函式的候選'; return out;
    }
    if (pool.length === 1) { out.status = 'unique'; out.picks = pool; if (!sameCase.length) { out.note = '只有大小寫不同的名稱相符'; } return out; }
    out.status = 'ambiguous'; out.picks = pool.slice(0, opts.maxCandidates || 6); out.note = '索引裡有 ' + pool.length + ' 個同名定義（例如 static 函式），無法只靠名稱判斷是哪一個'; return out;
  }

  // The tree the index was built from vs what the trace says it ran. Never claims a match it cannot see.
  function treeCheck(treeRef, versions) {
    versions = versions || {};
    var have = treeRef && treeRef.git ? String(treeRef.git).toLowerCase() : '';
    var stack = versions.git || '';
    if (stack && have) {
      var n = Math.min(stack.length, have.length);
      if (stack.slice(0, n) === have.slice(0, n)) { return { level: 'ok', msg: '堆疊記錄的版本（' + stack + '）與索引的樹（' + have.slice(0, 12) + '）相同。' }; }
      return { level: 'warn', msg: '⚠️ 堆疊來自版本 ' + stack + '，但索引是在 ' + have.slice(0, 12) + ' 建的：行號與函式很可能對不上。' };
    }
    if (!have) { return { level: 'unknown', msg: '索引沒有記錄它是從哪個版本的樹建的（舊索引或資料夾不是 git）：無法確認行號對得上。重新建立索引後會記錄。' }; }
    return { level: 'unknown', msg: '堆疊沒有帶版本資訊' + (versions.kernel ? '（只看到 kernel ' + versions.kernel + '）' : '') + '，無法確認與索引的樹（' + have.slice(0, 12) + '）是同一版：行號僅供參考。' };
  }

  // an explanation may only cite path:line places that were located (+- the snippet window). Anything else is reported, not shown as fact.
  function checkCitations(text, located) {
    var seen = {}, bad = [], re = /([\w.+@\/-]+\.[A-Za-z0-9]{1,6}):(\d+)/g, m;
    var src = String(text || '');
    while ((m = re.exec(src))) {
      var key = m[1] + ':' + m[2];
      if (seen[key]) { continue; }
      seen[key] = 1;
      var ln = +m[2];
      var okc = (located || []).some(function (l) { return fullySuffixed(m[1], l.path) && ln >= (l.from || l.line) && ln <= (l.to || l.line); });
      if (!okc) { bad.push(key); }
    }
    return { ok: !bad.length, bad: bad };
  }


  // =============================================================== P2: log messages -> the line that prints them
  // extractLogs(text) finds the message literal of every logging-looking call (printk / pr_err / dev_err / printf / syslog / LOG_ERROR / logger.warning / print /
  // console.error / throw new Error / raise X(...), also C++ `log<level::ERR>("...")` and Rust `error!(...)`) and returns [{l: line, fn: callee, fmt: the literal as
  // the program sees it (escapes decoded, adjacent C literals joined)}]. Literals without enough fixed text to recognise (e.g. "%s: %d") are skipped, not indexed.
  // fmtPattern(fmt) turns printf / python / Go / {} / ${} placeholders into wildcards; matchLogs(msg, rows) verifies candidates the index returned.
  var LOG_TOKENS = { log: 1, logger: 1, logging: 1, print: 1, printf: 1, fprintf: 1, vprintf: 1, vfprintf: 1, dprintf: 1, printk: 1, println: 1, eprintln: 1, eprint: 1, puts: 1, fputs: 1, dbg: 1, debug: 1,
    err: 1, error: 1, errorf: 1, errx: 1, warn: 1, warnx: 1, warning: 1, info: 1, trace: 1, fatal: 1, fatalf: 1, crit: 1, critical: 1, notice: 1, alert: 1, emerg: 1, panic: 1, perror: 1, syslog: 1, vsyslog: 1,
    journal: 1, fail: 1, failed: 1, console: 1, echo: 1, die: 1, assert: 1, bug: 1, msg: 1, message: 1, say: 1, report: 1, verbose: 1 };
  function nameTokens(n) { return String(n).replace(/!$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[^A-Za-z0-9]+/).filter(Boolean).map(function (x) { return x.toLowerCase(); }); }
  function looksLikeLogCall(name) { var t = nameTokens(name); for (var i = 0; i < t.length; i++) { if (LOG_TOKENS[t[i]]) { return true; } } return false; }
  var LOG_LANGS = { c: 1, cpp: 1, cs: 1, java: 1, kt: 1, swift: 1, dart: 1, php: 1, go: 1, rs: 1, js: 1, ts: 1, py: 1, rb: 1, lua: 1, sh: 1 };
  function decodeEsc(s, q) {
    return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[0-7]{1,3}|[\s\S])/g, function (_m, c) {
      if (c === 'n' || c === 'r') { return '\n'; } if (c === 't') { return '\t'; } if (c === '0') { return ''; }
      if (c[0] === 'x' || c[0] === 'u') { return String.fromCharCode(parseInt(c.slice(1), 16)); }
      return c;
    });
  }
  // read one string literal at text[i] (a quote char); returns {s, end} or null. Raw/backtick strings: no escapes (Go/JS template keep ${}).
  function readLiteral(text, i) {
    var q = text[i], j = i + 1, out = '';
    if (q === '`') { var e = text.indexOf('`', j); if (e < 0 || e - j > 600) { return null; } return { s: text.slice(j, e), end: e + 1 }; }
    while (j < text.length && j - i < 700) {
      var ch = text[j];
      if (ch === '\\') { out += ch + (text[j + 1] || ''); j += 2; continue; }
      if (ch === q) { return { s: decodeEsc(out, q), end: j + 1 }; }
      if (ch === '\n' && q !== '"' ) { return null; }
      out += ch; j++;
    }
    return null;
  }
  function constLen(fmt) { var p = fmtPattern(fmt); return p.konst; }
  function extractLogs(text, lang, opts) {
    opts = opts || {};
    if (lang && !LOG_LANGS[lang]) { return []; }
    var src = String(text || ''), out = [], maxPer = opts.max || 4000;
    var re = /(?:\b(?:throw\s+new|raise|new)\s+)?([A-Za-z_][\w:.$]*!?)\s*(?:<[^<>()\n]*>)?\s*\(/g, m, guard = 0, lineAt = null;
    // line numbers: count newlines lazily
    var lineStarts = null;
    function lineOf(pos) {
      if (!lineStarts) { lineStarts = [0]; for (var k = 0; k < src.length; k++) { if (src.charCodeAt(k) === 10) { lineStarts.push(k + 1); } } }
      var lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) { lo = mid; } else { hi = mid - 1; } }
      return lo + 1;
    }
    while ((m = re.exec(src)) && guard++ < 200000 && out.length < maxPer) {
      var name = m[1], isThrow = /^(?:throw\s+new|raise|new)\s/.test(m[0]);
      var raised = isThrow && /(?:Error|Exception|Failure|Fault)$/.test(name);
      if (!raised && !looksLikeLogCall(name)) { continue; }
      if (/^(?:if|for|while|switch|catch|return|sizeof|defined)$/.test(name)) { continue; }
      // walk the arguments: depth 0 literal(s), at most the first 4 top-level arguments
      var i = m.index + m[0].length, depth = 0, args = 0, lit = null, limit = Math.min(src.length, i + 900);
      while (i < limit) {
        var ch = src[i];
        if (ch === '"' || ch === '`' || (ch === "'" && (lang === 'py' || lang === 'js' || lang === 'ts' || lang === 'sh' || lang === 'rb' || lang === 'lua' || lang === 'php'))) {
          var r = readLiteral(src, i);
          if (r) {
            lit = r.s; var pos = r.end;
            // adjacent literals (C concatenation, possibly with a PRIu64-like macro in between)
            for (var g = 0; g < 12; g++) {
              var mm = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*(?:(?:(?:PRI|SCN)[A-Za-z0-9_]*|[A-Z_][A-Z0-9_]*)(?:\s|\/\*[\s\S]*?\*\/)*)*(["`])/.exec(src.slice(pos, pos + 160));
              if (!mm) { break; }
              var r2 = readLiteral(src, pos + mm[0].length - 1);
              if (!r2) { break; }
              lit += r2.s; pos = r2.end;
            }
            break;
          }
          i++; continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') { depth++; }
        else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) { break; } depth--; }
        else if (ch === ',' && depth === 0) { if (++args >= 4) { break; } }
        else if (ch === ';' && depth === 0) { break; }
        i++;
      }
      if (lit == null) { continue; }
      var fmt = lit.replace(/\s+$/, '').slice(0, 300);
      var pat = fmtPattern(fmt);
      if (pat.konst + cjkN(pat.fixed) < 8 || !/[A-Za-z]{3}|[一-鿿]{3}/.test(pat.fixed) || pat.key.length + cjkN(pat.key) < 6) { continue; } // Chinese fixed text counts double (a Chinese log line is short but just as specific); whether a pasted Chinese sentence is a log or the user's own words is decided by the index (verbatim match), never by the script
      out.push({ l: lineOf(m.index), fn: name.replace(/^(?:throw\s+new|raise|new)\s+/, ''), fmt: fmt, key: pat.key });
    }
    return out;
  }
  // placeholder -> wildcard. Returns {src: regex source, konst: count of fixed characters, key: longest fixed run (lowercase), fixed: all fixed text}
  var PH = /%(?:%|p[A-Za-z0-9]*|\([A-Za-z_][\w]*\)[-+ #0]*\d*(?:\.\d+)?[sdifrxXgGeEc]|[-+ #0']*(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:hh|h|ll|l|z|j|t|L|q)?[diouxXeEfFgGaAcspnvwqTt])|\{\{[^{}]*\}\}|\$\{[^{}]*\}|\{[A-Za-z0-9_.\[\]]*(?:![rsa])?(?::[^{}]*)?\}|<%=?[^%]*%>/g;
  function fmtPattern(fmt) {
    var s = String(fmt || ''), parts = [], last = 0, m, fixedParts = [];
    PH.lastIndex = 0;
    var push = function (t) { if (t) { fixedParts.push(t); parts.push(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')); } };
    while ((m = PH.exec(s))) {
      push(s.slice(last, m.index));
      if (m[0] === '%%') { fixedParts.push('%'); parts.push('%'); } else { parts.push('.{0,200}?'); fixedParts.push('\u0000'); }
      last = m.index + m[0].length;
    }
    push(s.slice(last));
    var runs = fixedParts.join('').split('\u0000'), key = '', konst = 0;
    runs.forEach(function (r) {
      konst += r.replace(/\s+/g, ' ').trim().length;
      // the key must be a plain substring of the message: split at line breaks / tabs (a log line has none), keep inner spaces as they are
      r.split(/[\n\r\t]+/).forEach(function (piece) { var t = piece.trim(); if (t.length > key.length) { key = t; } });
    });
    return { src: parts.join(''), konst: konst, key: key.toLowerCase(), fixed: runs.join(' ') };
  }
  // text after the syslog / journald / kernel prefix
  function cjkN(s) { var m = String(s || '').match(/[一-鿿]/g); return m ? m.length : 0; }
  function messageOf(line) {
    var s = String(line || '').replace(/\r$/, ''), m;
    if ((m = /^\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\S+\s+[^\s:]+:\s+(.*)$/.exec(s))) { return m[1]; }
    if ((m = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?\s+(?:\S+\s+)?[^\s:]+:\s+(.*)$/.exec(s))) { return m[1]; }
    if ((m = /^(?:<\d+>)?\[\s*\d+\.\d+\]\s*(.*)$/.exec(s))) { return m[1]; }
    return s.trim();
  }
  // is this line worth looking up as a log message? (not blank, not a frame, enough words)
  function isMessageLine(msg) { msg = String(msg); return (msg.length >= 12 && /[A-Za-z]{3,}.*[A-Za-z]{3,}/.test(msg)) || (msg.length >= 6 && cjkN(msg) >= 4); }
  // rows = [{path, line, fn, fmt}] from the index; returns the ones whose pattern really occurs in msg, best (most fixed text) first
  function matchLogs(msg, rows) {
    var out = [];
    (rows || []).forEach(function (r) {
      var p = fmtPattern(r.fmt), re;
      try { re = new RegExp(p.src); } catch (e) { return; }
      if (re.test(msg)) { out.push({ path: r.path, line: r.line, fn: r.fn, fmt: r.fmt, konst: p.konst }); }
    });
    out.sort(function (a, b) { return b.konst - a.konst || (a.path < b.path ? -1 : 1); });
    return out;
  }
  // how sure are we: one clearly longest pattern -> 'best' (+ others as alternatives); equal best patterns in several places -> 'ambiguous'; very short fixed text -> weak
  function judgeLogMatches(ms) {
    if (!ms.length) { return { status: 'none', picks: [] }; }
    var top = ms[0], ties = ms.filter(function (x) { return x.konst === top.konst; });
    var weak = top.konst < 14;
    if (ties.length > 1) { return { status: 'ambiguous', picks: ties.slice(0, 5), weak: weak }; }
    return { status: 'best', picks: [top].concat(ms.slice(1, 3)), weak: weak };
  }


  // =============================================================== P3: function-level call edges
  // extractCalls(text, lang, symbols) -> [{c: caller name, cl: caller's definition line, f: callee name, l: line of the call}] for every function / method whose body can be
  // delimited: C-like languages by brace matching (comments and string contents blanked first, so a "{" in a string cannot confuse it), Python by indentation.
  // Other languages give no edges (the locator then says the call graph does not cover the language). A callee is only a NAME: which definition it is,
  // is decided at query time (several definitions of one name are listed as uncertain, never merged).
  var CALL_BRACE = { c: 1, cpp: 1, cs: 1, java: 1, kt: 1, swift: 1, dart: 1, php: 1, go: 1, rs: 1, js: 1, ts: 1 };
  var CALL_LANGS = Object.assign({ py: 1 }, CALL_BRACE);
  var NOT_CALLS = {};
  ('if else for while switch case return sizeof typeof alignof catch do defined elif with await async yield lambda assert static_assert new delete throw try function def class void int char long short float double unsigned signed struct enum union and or not in is print exec self super this').split(' ').forEach(function (w) { NOT_CALLS[w] = 1; });
  // text with comments and string / char literal CONTENTS replaced by spaces (newlines and length kept, so offsets and line numbers stay valid)
  function maskCode(src, lang) {
    var out = [], i = 0, n = src.length, hashComment = lang === 'py' || lang === 'sh' || lang === 'rb';
    var blank = function (a, b) { for (var k = a; k < b; k++) { out.push(src[k] === '\n' ? '\n' : ' '); } };
    var TQ1 = '"""', TQ2 = "'" + "'" + "'";
    while (i < n) {
      var c = src[i], c2 = src[i + 1];
      if (c === '/' && c2 === '/' && !hashComment) { var e = src.indexOf('\n', i); if (e < 0) { e = n; } blank(i, e); i = e; continue; }
      if (c === '/' && c2 === '*' && !hashComment) { var e2 = src.indexOf('*/', i + 2); e2 = e2 < 0 ? n : e2 + 2; blank(i, e2); i = e2; continue; }
      if (c === '#' && hashComment) { var e3 = src.indexOf('\n', i); if (e3 < 0) { e3 = n; } blank(i, e3); i = e3; continue; }
      if (lang === 'py' && (src.substr(i, 3) === TQ1 || src.substr(i, 3) === TQ2)) { var q3 = src.substr(i, 3), e4 = src.indexOf(q3, i + 3); e4 = e4 < 0 ? n : e4 + 3; blank(i, e4); i = e4; continue; }
      if (c === '"' || c === '`' || (c === "'" && (lang === 'py' || lang === 'js' || lang === 'ts' || lang === 'php' || lang === 'sh' || lang === 'rb' || lang === 'dart' || lang === 'kt' || lang === 'swift'))) {
        var j = i + 1;
        while (j < n && src[j] !== c && (src[j] !== '\n' || c === '`')) { j += src[j] === '\\' ? 2 : 1; }
        blank(i, Math.min(n, j + 1)); i = Math.min(n, j + 1); continue;
      }
      if (c === "'") { var m = /^'(?:\\.[0-9a-fA-Fx]*|[^'\\\n])'/.exec(src.substr(i, 12)); if (m) { blank(i, i + m[0].length); i += m[0].length; continue; } }
      out.push(c); i++;
    }
    return out.join('');
  }
  // [firstLine, lastLine] (1-based) of the body of the function defined at `defLine`, or null (a declaration, or too long / unbalanced)
  function bodySpan(masked, lineStarts, defLine, lang) {
    var maxLines = 2000, start = lineStarts[defLine - 1];
    if (start == null) { return null; }
    if (lang === 'py') {
      var lines = masked.split('\n'), ind = /^\s*/.exec(lines[defLine - 1] || '')[0].length, last = defLine;
      for (var i = defLine; i < lines.length && i - defLine < maxLines; i++) {
        if (!lines[i].trim()) { continue; }
        if (/^\s*/.exec(lines[i])[0].length <= ind) { break; }
        last = i + 1;
      }
      return last > defLine ? [defLine, last] : null;
    }
    var depthP = 0, k = start, n = masked.length, open = -1;
    for (; k < n && k - start < 6000; k++) {
      var ch = masked[k];
      if (ch === '(') { depthP++; } else if (ch === ')') { depthP--; }
      else if (depthP <= 0 && ch === ';') { return null; }
      else if (depthP <= 0 && ch === '{') { open = k; break; }
    }
    if (open < 0) { return null; }
    var depth = 0, endPos = -1;
    for (k = open; k < n; k++) {
      var c = masked[k];
      if (c === '{') { depth++; } else if (c === '}') { depth--; if (depth === 0) { endPos = k; break; } }
    }
    if (endPos < 0) { return null; }
    var lineOf = function (pos) { var lo = 0, hi = lineStarts.length - 1; while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) { lo = mid; } else { hi = mid - 1; } } return lo + 1; };
    var el = lineOf(endPos);
    return el - defLine > maxLines ? null : [defLine, el];
  }
  function extractCalls(text, lang, symbols, opts) {
    opts = opts || {};
    if (!CALL_LANGS[lang] || !symbols || !symbols.length) { return []; }
    var src = String(text || ''), masked = maskCode(src, lang), lineStarts = [0], k;
    for (k = 0; k < masked.length; k++) { if (masked.charCodeAt(k) === 10) { lineStarts.push(k + 1); } }
    var perFn = opts.perFn || 60, perFile = opts.perFile || 1500, out = [];
    var fns = symbols.filter(function (x) { return (x.k === 'function' || x.k === 'method') && x.l > 0; }).sort(function (a, b) { return a.l - b.l; });
    for (var fi = 0; fi < fns.length && out.length < perFile; fi++) {
      var fn = fns[fi], span = bodySpan(masked, lineStarts, fn.l, lang);
      if (!span) { continue; }
      var a = lineStarts[span[0] - 1], b = span[1] < lineStarts.length ? lineStarts[span[1]] : masked.length;
      var body = masked.slice(a, b), re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g, m, seen = Object.create(null), cnt = 0;
      // the definition's own "name(" is not a call; start after the first "{" (or the ":" that ends a Python signature) so the parameter list is skipped
      var skipTo = lang === 'py' ? body.indexOf(':', body.indexOf(')')) : body.indexOf('{');
      if (skipTo < 0) { skipTo = 0; }
      re.lastIndex = skipTo;
      while ((m = re.exec(body)) && cnt < perFn) {
        var w = m[1];
        if (NOT_CALLS[w] || w === fn.n || w.length < 3 || seen[w]) { continue; }
        seen[w] = 1; cnt++;
        var line = span[0] + (body.slice(0, m.index).match(/\n/g) || []).length;
        out.push({ c: fn.n, cl: fn.l, f: w, l: line });
      }
    }
    return out;
  }
  // call chain consistency: frames are innermost first (frame i was called by frame i+1). `callerRows` = [{path, caller, cline, line}] from the index for the callee.
  // 'match' = the next frame's function is among the callers; 'missing' = callers are known but the next frame is none of them (function pointer, inline, another version);
  // 'unknown' = the index has no caller edges for it.
  function chainCheck(callerRows, nextFrame) {
    if (!callerRows || !callerRows.length) { return { level: 'unknown' }; }
    var want = nextFrame && nextFrame.func ? nextFrame.func.toLowerCase() : '';
    var hit = want ? callerRows.filter(function (r) { return String(r.caller).toLowerCase() === want; }) : [];
    return hit.length ? { level: 'match', rows: hit } : { level: 'missing' };
  }

  var api = { extractCalls: extractCalls, maskCode: maskCode, chainCheck: chainCheck, extractLogs: extractLogs, fmtPattern: fmtPattern, messageOf: messageOf, isMessageLine: isMessageLine, matchLogs: matchLogs, judgeLogMatches: judgeLogMatches, looksLikeLogCall: looksLikeLogCall, parse: parse, rankCandidates: rankCandidates, treeCheck: treeCheck, checkCitations: checkCitations, cleanFunc: cleanFunc, splitQualified: splitQualified, fullySuffixed: fullySuffixed, versionsOf: versionsOf };
  return api;
});
