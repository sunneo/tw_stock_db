// 試算表的公式求值器（純函式；Node 與瀏覽器都能跑；不用 eval／Function）。設計見 DESIGN.edit-docs.md §5。
//   FaSheetFormula.compute(sheet) → { values:[[…]], errors:n }   sheet = { cols:[{id}], rows:[{ id, c:{ colId: 值 | {f, v} } }] }；values[r][c] 是算好的值（公式格用算出來的，其他格用原值）
//   FaSheetFormula.evaluate(src, ctx) → 值   ctx = { cell(r, c) → 值, range(r1, c1, r2, c2) → [[…]], today? }
//   FaSheetFormula.parse(src) → AST（語法錯誤丟例外）   colLetter(i) / colIndex('AB')   addr('B3') → { r, c }（0 起算）
// 支援：+ - * / ^ & = <> < > <= >= %、括號、A1／$A$1／A1:B9、字串與數字、TRUE／FALSE；函式 SUM AVERAGE MIN MAX COUNT COUNTA IF IFERROR AND OR NOT ROUND ABS INT MOD SQRT POWER CONCAT LEN LEFT RIGHT MID UPPER LOWER TRIM
// VLOOKUP SUMIF COUNTIF TODAY。不認得的函式回 #NAME?（原公式字串保留，不計算）。循環參照回 #CYCLE!，除以零 #DIV/0!，格子超出範圍 #REF!，型別不對 #VALUE!。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaSheetFormula = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function colLetter(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function colIndex(L) { var n = 0; String(L).toUpperCase().split('').forEach(function (ch) { n = n * 26 + ch.charCodeAt(0) - 64; }); return n - 1; }
  function addr(a) { var m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(String(a).trim()); return m ? { r: Number(m[2]) - 1, c: colIndex(m[1]) } : null; }
  function FErr(code) { this.code = code; } FErr.prototype.toString = function () { return this.code; };
  var isErr = function (v) { return v instanceof FErr; };
  // ───── 詞法
  function lex(src) {
    var t = [], i = 0, s = String(src), m;
    while (i < s.length) {
      var ch = s[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '"') { var j = i + 1, out = ''; while (j < s.length) { if (s[j] === '"') { if (s[j + 1] === '"') { out += '"'; j += 2; continue; } break; } out += s[j++]; } if (j >= s.length) { throw new Error('字串沒有結尾'); } t.push({ k: 'str', v: out }); i = j + 1; continue; }
      if ((m = /^\d+(\.\d+)?([eE][+-]?\d+)?|^\.\d+/.exec(s.slice(i)))) { t.push({ k: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
      if ((m = /^\$?[A-Za-z]{1,3}\$?\d{1,7}(?![A-Za-z0-9_(])/.exec(s.slice(i)))) { t.push({ k: 'ref', v: m[0] }); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i)))) { t.push({ k: 'name', v: m[0].toUpperCase() }); i += m[0].length; continue; }
      if ((m = /^(<>|<=|>=)/.exec(s.slice(i)))) { t.push({ k: 'op', v: m[0] }); i += 2; continue; }
      if ('+-*/^&=<>(),:%'.indexOf(ch) >= 0) { t.push({ k: 'op', v: ch }); i++; continue; }
      throw new Error('不認得的字元「' + ch + '」');
    }
    return t;
  }
  // ───── 語法（Pratt）：比較 < 連接 & < 加減 < 乘除 < 次方 < 一元 < 百分比
  var BIN = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
  function parse(src) {
    var t = lex(src), p = 0;
    function peek() { return t[p]; } function next() { return t[p++]; }
    function expr(min) {
      var left = unary();
      for (;;) { var o = peek(); if (!o || o.k !== 'op' || !(o.v in BIN) || BIN[o.v] < min) { break; } next(); var right = expr(o.v === '^' ? BIN[o.v] : BIN[o.v] + 1); left = { t: 'bin', op: o.v, a: left, b: right }; }
      return left;
    }
    function unary() { var o = peek(); if (o && o.k === 'op' && (o.v === '-' || o.v === '+')) { next(); var x = unary(); return o.v === '-' ? { t: 'neg', a: x } : x; } return postfix(); }
    function postfix() { var x = primary(); while (peek() && peek().k === 'op' && peek().v === '%') { next(); x = { t: 'pct', a: x }; } return x; }
    function primary() {
      var k = next(); if (!k) { throw new Error('公式不完整'); }
      if (k.k === 'num') { return { t: 'num', v: k.v }; } if (k.k === 'str') { return { t: 'str', v: k.v }; }
      if (k.k === 'ref') { var a = addr(k.v); if (peek() && peek().k === 'op' && peek().v === ':') { next(); var e = next(); var b = e && e.k === 'ref' ? addr(e.v) : null; if (!b) { throw new Error('範圍的終點不對'); } return { t: 'range', r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) }; } return { t: 'ref', r: a.r, c: a.c }; }
      if (k.k === 'name') {
        if (peek() && peek().k === 'op' && peek().v === '(') { next(); var args = []; if (peek() && peek().k === 'op' && peek().v === ')') { next(); return { t: 'fn', n: k.v, a: args }; } for (;;) { args.push(expr(1)); var s = next(); if (!s) { throw new Error('少了右括號'); } if (s.v === ')') { break; } if (s.v !== ',') { throw new Error('參數之間要用逗號'); } } return { t: 'fn', n: k.v, a: args }; }
        if (k.v === 'TRUE') { return { t: 'bool', v: true }; } if (k.v === 'FALSE') { return { t: 'bool', v: false }; } return { t: 'name', n: k.v };
      }
      if (k.v === '(') { var x = expr(1); var c = next(); if (!c || c.v !== ')') { throw new Error('少了右括號'); } return x; }
      throw new Error('不該出現「' + k.v + '」');
    }
    var ast = expr(1); if (p < t.length) { throw new Error('多出來的「' + t[p].v + '」'); } return ast;
  }
  // ───── 求值
  function num(v) { if (isErr(v)) { return v; } if (v === '' || v == null) { return 0; } if (typeof v === 'boolean') { return v ? 1 : 0; } if (typeof v === 'number') { return v; } var n = Number(String(v).trim().replace(/,/g, '')); return isFinite(n) && String(v).trim() !== '' ? n : new FErr('#VALUE!'); }
  function text(v) { if (isErr(v)) { return v; } if (v == null) { return ''; } if (typeof v === 'boolean') { return v ? 'TRUE' : 'FALSE'; } if (typeof v === 'number') { return String(Math.round(v * 1e12) / 1e12); } return String(v); }
  function truthy(v) { if (isErr(v)) { return v; } if (typeof v === 'string') { var u = v.toUpperCase(); if (u === 'TRUE') { return true; } if (u === 'FALSE' || u === '') { return false; } var n = Number(v); return isFinite(n) ? n !== 0 : new FErr('#VALUE!'); } return !!v; }
  function flat(args, ctx, o) { var out = []; args.forEach(function (a) { var v = ev(a, ctx); if (Array.isArray(v)) { v.forEach(function (row) { row.forEach(function (x) { out.push({ v: x, ranged: true }); }); }); } else { out.push({ v: v, ranged: false }); } }); return out; }
  function nums(args, ctx) { var out = []; for (var x of flat(args, ctx)) { var v = x.v; if (isErr(v)) { return v; } if (x.ranged && (typeof v !== 'number')) { if (typeof v === 'string' && v !== '' && isFinite(Number(v.replace(/,/g, '')))) { out.push(Number(v.replace(/,/g, ''))); } continue; } var n = num(v); if (isErr(n)) { return n; } out.push(n); } return out; }
  function cmp(a, b) { if (typeof a === 'number' && typeof b === 'number') { return a - b; } var na = Number(a), nb = Number(b); if (a !== '' && b !== '' && isFinite(na) && isFinite(nb) && typeof a !== 'boolean') { return na - nb; } var sa = text(a).toLowerCase(), sb = text(b).toLowerCase(); return sa < sb ? -1 : sa > sb ? 1 : 0; }
  function crit(c) { var m = /^(<=|>=|<>|=|<|>)?(.*)$/.exec(String(c)); var op = m[1] || '=', val = m[2]; var n = Number(val); return function (v) { var r = isFinite(n) && val !== '' && v !== '' && isFinite(Number(v)) ? Number(v) - n : (String(v).toLowerCase() < val.toLowerCase() ? -1 : String(v).toLowerCase() > val.toLowerCase() ? 1 : 0); return op === '=' ? r === 0 : op === '<>' ? r !== 0 : op === '<' ? r < 0 : op === '>' ? r > 0 : op === '<=' ? r <= 0 : r >= 0; }; }
  var FN = {
    SUM: function (a, c) { var n = nums(a, c); return isErr(n) ? n : n.reduce(function (s, x) { return s + x; }, 0); },
    AVERAGE: function (a, c) { var n = nums(a, c); return isErr(n) ? n : n.length ? n.reduce(function (s, x) { return s + x; }, 0) / n.length : new FErr('#DIV/0!'); },
    MIN: function (a, c) { var n = nums(a, c); return isErr(n) ? n : n.length ? Math.min.apply(null, n) : 0; }, MAX: function (a, c) { var n = nums(a, c); return isErr(n) ? n : n.length ? Math.max.apply(null, n) : 0; },
    COUNT: function (a, c) { return flat(a, c).filter(function (x) { return !isErr(x.v) && (typeof x.v === 'number' || (x.v !== '' && x.v != null && typeof x.v !== 'boolean' && isFinite(Number(String(x.v).replace(/,/g, ''))))); }).length; },
    COUNTA: function (a, c) { return flat(a, c).filter(function (x) { return x.v !== '' && x.v != null; }).length; },
    IF: function (a, c) { if (a.length < 2) { return new FErr('#VALUE!'); } var t = truthy(ev(a[0], c)); if (isErr(t)) { return t; } return t ? ev(a[1], c) : (a.length > 2 ? ev(a[2], c) : false); },
    IFERROR: function (a, c) { var v = ev(a[0], c); return isErr(v) ? (a.length > 1 ? ev(a[1], c) : '') : v; },
    AND: function (a, c) { var r = true; for (var x of flat(a, c)) { var t = truthy(x.v); if (isErr(t)) { return t; } r = r && t; } return r; }, OR: function (a, c) { var r = false; for (var x of flat(a, c)) { var t = truthy(x.v); if (isErr(t)) { return t; } r = r || t; } return r; },
    NOT: function (a, c) { var t = truthy(ev(a[0], c)); return isErr(t) ? t : !t; },
    ROUND: function (a, c) { var n = num(ev(a[0], c)), d = a.length > 1 ? num(ev(a[1], c)) : 0; if (isErr(n)) { return n; } if (isErr(d)) { return d; } var f = Math.pow(10, d); return Math.round((n + (n < 0 ? -1e-12 : 1e-12)) * f) / f; },
    ABS: function (a, c) { var n = num(ev(a[0], c)); return isErr(n) ? n : Math.abs(n); }, INT: function (a, c) { var n = num(ev(a[0], c)); return isErr(n) ? n : Math.floor(n); },
    MOD: function (a, c) { var x = num(ev(a[0], c)), y = num(ev(a[1], c)); if (isErr(x)) { return x; } if (isErr(y)) { return y; } return y === 0 ? new FErr('#DIV/0!') : x - y * Math.floor(x / y); },
    SQRT: function (a, c) { var n = num(ev(a[0], c)); return isErr(n) ? n : n < 0 ? new FErr('#VALUE!') : Math.sqrt(n); }, POWER: function (a, c) { var x = num(ev(a[0], c)), y = num(ev(a[1], c)); return isErr(x) ? x : isErr(y) ? y : Math.pow(x, y); },
    CONCAT: function (a, c) { var s = ''; for (var x of flat(a, c)) { var t = text(x.v); if (isErr(t)) { return t; } s += t; } return s; },
    LEN: function (a, c) { var t = text(ev(a[0], c)); return isErr(t) ? t : t.length; },
    LEFT: function (a, c) { var t = text(ev(a[0], c)), n = a.length > 1 ? num(ev(a[1], c)) : 1; return isErr(t) ? t : isErr(n) ? n : t.slice(0, Math.max(0, n)); },
    RIGHT: function (a, c) { var t = text(ev(a[0], c)), n = a.length > 1 ? num(ev(a[1], c)) : 1; return isErr(t) ? t : isErr(n) ? n : n <= 0 ? '' : t.slice(-n); },
    MID: function (a, c) { var t = text(ev(a[0], c)), s = num(ev(a[1], c)), n = num(ev(a[2], c)); return isErr(t) ? t : isErr(s) ? s : isErr(n) ? n : t.substr(Math.max(0, s - 1), Math.max(0, n)); },
    UPPER: function (a, c) { var t = text(ev(a[0], c)); return isErr(t) ? t : t.toUpperCase(); }, LOWER: function (a, c) { var t = text(ev(a[0], c)); return isErr(t) ? t : t.toLowerCase(); }, TRIM: function (a, c) { var t = text(ev(a[0], c)); return isErr(t) ? t : t.trim().replace(/\s+/g, ' '); },
    TODAY: function (a, c) { var d = c.today ? c.today() : new Date(); return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000); },
    SUMIF: function (a, c) { var rg = ev(a[0], c), cr = ev(a[1], c), sm = a.length > 2 ? ev(a[2], c) : rg; if (!Array.isArray(rg)) { return new FErr('#VALUE!'); } var f = crit(text(cr)), s = 0; for (var i = 0; i < rg.length; i++) { for (var j = 0; j < rg[i].length; j++) { if (f(rg[i][j] == null ? '' : rg[i][j])) { var v = Array.isArray(sm) ? (sm[i] || [])[j] : sm, n = num(v); if (!isErr(n) && v !== '' && v != null) { s += n; } } } } return s; },
    COUNTIF: function (a, c) { var rg = ev(a[0], c), f = crit(text(ev(a[1], c))), n = 0; if (!Array.isArray(rg)) { return new FErr('#VALUE!'); } rg.forEach(function (row) { row.forEach(function (v) { if (f(v == null ? '' : v)) { n++; } }); }); return n; },
    VLOOKUP: function (a, c) { var key = ev(a[0], c), rg = ev(a[1], c), ci = num(ev(a[2], c)), exact = a.length > 3 ? !truthy(ev(a[3], c)) : false; if (!Array.isArray(rg) || isErr(ci)) { return new FErr('#VALUE!'); } if (ci < 1 || ci > (rg[0] || []).length) { return new FErr('#REF!'); } var best = -1; for (var i = 0; i < rg.length; i++) { var d = cmp(rg[i][0], key); if (d === 0) { return rg[i][ci - 1]; } if (!exact && d < 0) { best = i; } } return !exact && best >= 0 ? rg[best][ci - 1] : new FErr('#N/A'); },
  };
  function ev(n, ctx) {
    switch (n.t) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'ref': return ctx.cell(n.r, n.c);
      case 'range': return ctx.range(n.r1, n.c1, n.r2, n.c2);
      case 'name': return new FErr('#NAME?');
      case 'neg': { var v = num(scalar(ev(n.a, ctx))); return isErr(v) ? v : -v; }
      case 'pct': { var p = num(scalar(ev(n.a, ctx))); return isErr(p) ? p : p / 100; }
      case 'fn': { var f = FN[n.n]; if (!f) { return new FErr('#NAME?'); } try { var r = f(n.a, ctx); return Array.isArray(r) ? scalar(r) : r; } catch (e) { return new FErr('#VALUE!'); } }
      case 'bin': {
        var a = scalar(ev(n.a, ctx)), b = scalar(ev(n.b, ctx)); if (isErr(a)) { return a; } if (isErr(b)) { return b; }
        if (n.op === '&') { return text(a) + text(b); }
        if (n.op === '=' || n.op === '<>' || n.op === '<' || n.op === '>' || n.op === '<=' || n.op === '>=') { var d = cmp(a, b); return n.op === '=' ? d === 0 : n.op === '<>' ? d !== 0 : n.op === '<' ? d < 0 : n.op === '>' ? d > 0 : n.op === '<=' ? d <= 0 : d >= 0; }
        var x = num(a), y = num(b); if (isErr(x)) { return x; } if (isErr(y)) { return y; }
        if (n.op === '+') { return x + y; } if (n.op === '-') { return x - y; } if (n.op === '*') { return x * y; } if (n.op === '/') { return y === 0 ? new FErr('#DIV/0!') : x / y; } if (n.op === '^') { return Math.pow(x, y); }
      }
    }
    return new FErr('#VALUE!');
  }
  function scalar(v) { return Array.isArray(v) ? (v.length && v[0].length ? v[0][0] : '') : v; }
  function evaluate(src, ctx) { var ast; try { ast = parse(String(src).replace(/^=/, '')); } catch (e) { return new FErr('#NAME?'); } var v = scalar(ev(ast, ctx)); return v === undefined ? '' : v; }
  // ───── 整張表：公式格依相依順序遞迴求值，循環回 #CYCLE!
  function compute(sheet) {
    var cols = sheet.cols || [], rows = sheet.rows || [], R = rows.length, C = cols.length, cache = {}, state = {}, errors = 0, cc = cols.map(function (c) { return c.id; });
    function raw(r, c) { var row = rows[r]; return row ? row.c[cc[c]] : undefined; }
    function val(r, c) {
      if (r < 0 || c < 0 || r >= R + 0 || c >= C) { return (r >= 0 && c >= 0 && r < R + 1000 && c < C + 100) ? '' : new FErr('#REF!'); }
      var k = r * 4096 + c, x = raw(r, c);
      if (!(x && typeof x === 'object' && typeof x.f === 'string')) { return x === undefined || x === null ? '' : x; }
      if (k in cache) { return cache[k]; } if (state[k] === 1) { return new FErr('#CYCLE!'); } state[k] = 1;
      var v = evaluate(x.f, { cell: function (rr, c2) { var y = val(rr, c2); return y; }, range: function (r1, c1, r2, c2) { var out = []; for (var i = r1; i <= r2; i++) { var line = []; for (var j = c1; j <= c2; j++) { var y = val(i, j); line.push(y); } out.push(line); } return out; } });
      state[k] = 2; cache[k] = v; return v;
    }
    var values = rows.map(function (row, r) { return cc.map(function (id, c) { var v = val(r, c); if (isErr(v)) { errors++; return v; } return v; }); });
    return { values: values, errors: errors };
  }
  function show(v) { return isErr(v) ? v.code : v === undefined || v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? String(Math.round(v * 1e12) / 1e12) : String(v); }
  return { parse: parse, evaluate: evaluate, compute: compute, colLetter: colLetter, colIndex: colIndex, addr: addr, show: show, isErr: isErr, FUNCTIONS: Object.keys(FN) };
});
