// /edit-markdown 與 /edit-text 的文件核心（純函式，Node 與瀏覽器都能跑）。設計見 DESIGN.edit-docs.md。
// 文件是「區塊」的清單（放在 spec.objects，所以共用外框 FaEditShell 的物件欄、復原、AI 對話、整理成 prompt 全部直接能用）：
//   { v:1, title, format:'md'|'txt', eol:'\n'|'\r\n', bom:false, lead:0, pad:'', seq, objects:[ { id, name, type, visible, locked, …, src?, gap } ] }
//   type：heading{text,level} para{text} list{items[],ordered} quote{text} code{text,lang} table{rows[][],align[]} hr raw{text}（不認得的語法原樣保留）line{text}（純文字，一行一個）
//   src：這個區塊在原檔裡的原始文字——**沒被改過的區塊匯出時原樣輸出**，所以不會把你的檔案重新格式化；任何會改內容的動作都會把 src 清掉。gap：區塊後面有幾個空白行（最後一個區塊：結尾換行數 − 1，沒有結尾換行是 −1）。
//   lead／pad：檔案開頭的空白行數／整份只有空白時的原文。往返保證：serialize(parse(t)) === t。
// API：FaEditText.parse(text, format) → spec    serialize(spec) → text    validate / applyEdits / editWords / find（跟 FaEditObjects 一樣）    starter(id) / listStarters()    outline(spec) → 大綱文字    replaceAllText(spec, find, repl, opts)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./edit_objects_core.js'));
  else root.FaEditText = factory(root.FaEditObjects || (typeof FaEditObjects !== 'undefined' ? FaEditObjects : undefined));
})(typeof self !== 'undefined' ? self : this, function (O) {
  'use strict';
  var MAXBLOCKS = 20000, MAXTEXT = 2000000;
  function str(v, max) { return String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, max || 200000); }
  function int(v, lo, hi, d) { var n = Math.round(Number(v)); if (!isFinite(n)) { return d; } return Math.max(lo, Math.min(hi, n)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function snippet(t, n) { var s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > (n || 18) ? s.slice(0, n || 18) + '…' : s; }

  // ───────── 區塊型別（FaEditObjects 的 types）
  function tail(o) { var t = {}; if (o.src != null && o.src !== '') { t.src = str(o.src, MAXTEXT); if (Array.isArray(o.gapLines)) { t.gapLines = o.gapLines.slice(0, 50).map(function (x) { return str(x, 200); }); } } t.gap = int(o.gap, -1, 20, 1); return t; }
  function mk(label, defaults, fn) { return { label: label, defaults: Object.assign({ gap: 1 }, defaults), validate: function (o) { var r = fn(o); return { obj: Object.assign(r, tail(o)), problems: [] }; }, bbox: function () { return { x: 0, y: 0, w: 0, h: 0 }; } }; }
  var types = {
    heading: mk('標題', { text: '', level: 1 }, function (o) { return { text: str(o.text, 5000).replace(/\n/g, ' '), level: int(o.level, 1, 6, 1) }; }),
    para: mk('段落', { text: '' }, function (o) { return { text: str(o.text, MAXTEXT) }; }),
    line: mk('一行', { text: '' }, function (o) { return { text: str(o.text, 100000).replace(/[\r\n]/g, ' ') }; }),
    quote: mk('引用', { text: '' }, function (o) { return { text: str(o.text, MAXTEXT) }; }),
    list: mk('清單', { items: [''], ordered: false }, function (o) { var it = Array.isArray(o.items) ? o.items.slice(0, 2000).map(function (x) { return str(x, 20000); }) : []; return { items: it.length ? it : [''], ordered: !!o.ordered }; }),
    code: mk('程式碼', { text: '', lang: '' }, function (o) { return { text: str(o.text, MAXTEXT), lang: str(o.lang, 30).replace(/[\s`]/g, '') }; }),
    table: mk('表格', { rows: [['', ''], ['', '']], align: [] }, function (o) {
      var rows = Array.isArray(o.rows) ? o.rows.slice(0, 500).map(function (r) { return (Array.isArray(r) ? r : []).slice(0, 60).map(function (c) { return str(c, 5000).replace(/\n/g, ' '); }); }) : [];
      var w = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1); rows = (rows.length ? rows : [['']]).map(function (r) { while (r.length < w) { r.push(''); } return r; });
      var al = Array.isArray(o.align) ? o.align.slice(0, w).map(function (a) { return a === 'left' || a === 'right' || a === 'center' ? a : ''; }) : []; return { rows: rows, align: al };
    }),
    hr: mk('分隔線', {}, function () { return {}; }),
    raw: mk('原樣保留', { text: '' }, function (o) { return { text: str(o.text, MAXTEXT) }; }),
  };

  // ───────── 算出來的名字（物件欄顯示用）
  function nameOf(b) {
    var L = { heading: '標題', para: '段落', line: '行', quote: '引用', list: '清單', code: '程式碼', table: '表格', hr: '分隔線', raw: '原樣' }[b.type] || b.type;
    var t = b.type === 'list' ? (b.items && b.items[0]) : b.type === 'table' ? (b.rows && b.rows[0] && b.rows[0].join(' ')) : b.text; var s = snippet(t, 16);
    return (b.type === 'heading' ? 'H' + b.level + ' ' : L + ' ') + (s || '（空）');
  }

  // ───────── 輸出一個區塊（沒有 src 時）
  function fenceFor(text) { var f = '```'; while (String(text).indexOf(f) >= 0) { f += '`'; } return f; }
  function render(b) {
    switch (b.type) {
      case 'heading': return new Array(b.level + 1).join('#') + ' ' + b.text;
      case 'para': case 'line': case 'raw': return b.text;
      case 'quote': return String(b.text).split('\n').map(function (l) { return l === '' ? '>' : '> ' + l; }).join('\n');
      case 'hr': return '---';
      case 'code': { var f = fenceFor(b.text); return f + (b.lang || '') + '\n' + b.text + (b.text === '' ? '' : '\n') + f; }
      case 'list': return b.items.map(function (it, i) { var mark = b.ordered ? (i + 1) + '. ' : '- ', pad = new Array(mark.length + 1).join(' '); return mark + String(it).split('\n').join('\n' + pad); }).join('\n');
      case 'table': {
        var rows = b.rows, w = rows[0].length, cell = function (r) { return '| ' + r.map(function (c) { return String(c).replace(/\|/g, '\\|'); }).join(' | ') + ' |'; };
        var sep = '|' + rows[0].map(function (_, i) { var a = b.align && b.align[i]; return a === 'left' ? ' :--- ' : a === 'right' ? ' ---: ' : a === 'center' ? ' :---: ' : ' --- '; }).join('|') + '|';
        return [cell(rows[0]), sep].concat(rows.slice(1).map(cell)).join('\n');
      }
      default: return b.text || '';
    }
  }
  var SELF_DELIM = { heading: 1, hr: 1, code: 1 };
  function serialize(spec) {
    var s = spec, eol = s.eol === '\r\n' ? '\r\n' : '\n', bl = s.objects || [];
    if (s.format === 'txt') { return (s.bom ? '\uFEFF' : '') + bl.map(function (b) { return b.text; }).join(eol); }
    var out = [(s.bom ? '\uFEFF' : ''), s.leadLines && s.leadLines.length ? s.leadLines.join(eol) + eol : new Array((s.lead | 0) + 1).join(eol)];
    if (!bl.length) { return out.join('') + (s.pad || ''); }
    for (var k = 0; k < bl.length; k++) {
      var b = bl[k], txt = b.src != null && b.src !== '' ? b.src : render(b), last = k === bl.length - 1, g = b.gap == null ? 1 : b.gap;
      if (!last) { var nx = bl[k + 1]; if (g < 1 && (!b.src || !nx.src) && !(SELF_DELIM[b.type] || SELF_DELIM[nx.type])) { g = 1; } if (g < 0) { g = 0; } }
      if (b.src && b.gapLines && b.gapLines.length) { out.push(txt); out.push(eol + b.gapLines.join(eol) + (last ? '' : eol)); continue; }   // 空白行裡有空白字元：原樣輸出
      out.push(txt); out.push(g + 1 > 0 ? new Array(g + 2).join(eol) : '');   // g+1 個換行（最後一個區塊 g＝−1 → 沒有結尾換行）
    }
    return out.join('');
  }

  // ───────── 解析
  var RE = {
    fence: /^( {0,3})(`{3,}|~{3,})(.*)$/, atx: /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/, hr: /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/, quote: /^ {0,3}>/, setext: /^ {0,3}(=+|-+)\s*$/,
    list: /^( {0,3})([-*+]|\d{1,9}[.)])(\s+|$)/, tsep: /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/, html: /^ {0,3}<(?:[a-zA-Z][a-zA-Z0-9-]*[\s>\/]|\/[a-zA-Z]|!--|!\[CDATA\[|\?|![A-Z])/, blank: /^\s*$/,
  };
  function splitRow(l) { var t = l.trim(); if (t[0] === '|') { t = t.slice(1); } if (t[t.length - 1] === '|' && t[t.length - 2] !== '\\') { t = t.slice(0, -1); } var cells = [], cur = ''; for (var i = 0; i < t.length; i++) { if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; } else if (t[i] === '|') { cells.push(cur.trim()); cur = ''; } else { cur += t[i]; } } cells.push(cur.trim()); return cells; }
  function startsBlock(lines, i, inPara) {
    var l = lines[i]; if (RE.fence.test(l) || RE.atx.test(l) || RE.hr.test(l) || RE.quote.test(l)) { return true; }
    var m = RE.list.exec(l); if (m) { return !inPara || true; }
    if (l.indexOf('|') >= 0 && i + 1 < lines.length && lines[i + 1].indexOf('|') >= 0 && RE.tsep.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) { return true; }
    return false;
  }
  function parse(text, format) {
    text = String(text == null ? '' : text); var bom = text.charCodeAt(0) === 0xFEFF; if (bom) { text = text.slice(1); }
    var eol = /\r\n/.test(text) ? '\r\n' : '\n', spec = { v: 1, title: '', format: format === 'txt' ? 'txt' : 'md', eol: eol, bom: bom, lead: 0, pad: '', seq: 0, objects: [] };
    var id = function () { spec.seq++; return 'b' + spec.seq; };
    if (text.length > MAXTEXT) { text = text.slice(0, MAXTEXT); }
    var lines = text.split(eol === '\r\n' ? /\r\n/ : /\n/);
    if (spec.format === 'txt') { lines.slice(0, MAXBLOCKS).forEach(function (l) { var b = { id: id(), type: 'line', text: l, visible: true, locked: false, gap: 0 }; b.name = nameOf(b); spec.objects.push(b); }); if (lines.length > MAXBLOCKS) { spec.objects[MAXBLOCKS - 1].text += eol + lines.slice(MAXBLOCKS).join(eol); } return spec; }
    var i = 0, n = lines.length;
    if (!text.trim()) { spec.pad = text; return spec; }
    var leadArr = []; while (i < n && RE.blank.test(lines[i])) { leadArr.push(lines[i]); spec.lead++; i++; } if (leadArr.some(function (x) { return x !== ''; })) { spec.leadLines = leadArr; }
    var blocks = spec.objects;
    function push(type, props, from, to) { var b = Object.assign({ id: id(), type: type, visible: true, locked: false }, props); b.src = lines.slice(from, to).join(eol); b.gap = 0; b.name = nameOf(b); blocks.push(b); return b; }
    while (i < n && blocks.length < MAXBLOCKS) {
      var l = lines[i], start = i, m;
      if ((m = RE.fence.exec(l)) && !(m[2][0] === '`' && m[3].indexOf('`') >= 0)) {
        var ch = m[2][0], len = m[2].length, info = m[3].trim(), j = i + 1, inner = [], closer = new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + len + ',}\\s*$');
        while (j < n && !closer.test(lines[j])) { inner.push(lines[j]); j++; }
        var end = j < n ? j + 1 : n; push('code', { text: inner.join('\n'), lang: info.split(/\s+/)[0] || '' }, start, end); i = end;
      }
      else if (RE.hr.test(l)) { push('hr', {}, i, i + 1); i++; }
      else if ((m = RE.atx.exec(l))) { push('heading', { text: (m[2] || '').trim(), level: m[1].length }, i, i + 1); i++; }
      else if (RE.quote.test(l)) { var q = []; while (i < n && RE.quote.test(lines[i])) { q.push(lines[i].replace(/^ {0,3}> ?/, '')); i++; } push('quote', { text: q.join('\n') }, start, i); }
      else if ((m = RE.list.exec(l))) {
        var base = m[1].length, items = [], cur = null, ordered = /\d/.test(m[2][0]); i = start;
        while (i < n) {
          var li = lines[i], lm = RE.list.exec(li);
          if (lm && lm[1].length <= base + 1 && /\d/.test(lm[2][0]) !== ordered) { break; }   // 項目符號與編號是不同的清單
          if (lm && lm[1].length <= base + 1) { if (cur !== null) { items.push(cur); } var cw = lm[0].length; cur = li.slice(cw).replace(/\s+$/, ''); i++; continue; }
          if (RE.blank.test(li)) { var k = i; while (k < n && RE.blank.test(lines[k])) { k++; } if (k < n && cur !== null && (/^ {2,}\S/.test(lines[k]) || (RE.list.exec(lines[k]) && RE.list.exec(lines[k])[1].length <= base + 1 && RE.list.exec(lines[k])[1].length >= base && /\d/.test(RE.list.exec(lines[k])[2][0]) === ordered))) { cur += '\n'; i = k; if (lines[k].match(/^ {2,}\S/) && !RE.list.exec(lines[k])) { continue; } continue; } break; }
          if (/^ {2,}\S/.test(li) && cur !== null) { cur += '\n' + li.replace(/^ {1,4}/, '').replace(/\s+$/, ''); i++; continue; }
          if (cur !== null && !startsBlock(lines, i, true) && !RE.blank.test(li)) { cur += '\n' + li.trim(); i++; continue; }   // 懶惰延續
          break;
        }
        if (cur !== null) { items.push(cur); } while (i > start && RE.blank.test(lines[i - 1])) { i--; }
        push('list', { items: items.map(function (x) { return x.replace(/\n+$/, ''); }), ordered: ordered }, start, i);
      }
      else if (l.indexOf('|') >= 0 && i + 1 < n && lines[i + 1].indexOf('|') >= 0 && RE.tsep.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        var head = splitRow(l), sep = splitRow(lines[i + 1]), rows = [head], align = sep.map(function (c) { return /^:-+:$/.test(c) ? 'center' : /^:-+$/.test(c) ? 'left' : /^-+:$/.test(c) ? 'right' : ''; }); i += 2;
        while (i < n && !RE.blank.test(lines[i]) && lines[i].indexOf('|') >= 0) { rows.push(splitRow(lines[i])); i++; }
        push('table', { rows: rows, align: align }, start, i);
      }
      else if (RE.html.test(l)) { while (i < n && !RE.blank.test(lines[i])) { i++; } push('raw', { text: lines.slice(start, i).join('\n') }, start, i); }
      else {
        var p = [];
        while (i < n && !RE.blank.test(lines[i])) {
          if (p.length && startsBlock(lines, i, true) && !RE.setext.test(lines[i])) { break; }
          if (p.length && RE.setext.test(lines[i])) { var lv = lines[i].trim()[0] === '=' ? 1 : 2; i++; push('heading', { text: p.map(function (x) { return x.trim(); }).join(' '), level: lv }, start, i); p = null; break; }
          p.push(lines[i]); i++;
        }
        if (p) { push('para', { text: p.join('\n') }, start, i); }
      }
      // 區塊後面的空白行數
      var g = 0, run = []; while (i < n && RE.blank.test(lines[i])) { run.push(lines[i]); g++; i++; } var lb = blocks[blocks.length - 1]; if (lb) { lb.gap = i >= n ? g - 1 + 0 : g; if (run.some(function (x) { return x !== ''; })) { lb.gapLines = run; } }
      if (i >= n) { break; }
    }
    if (i < n) { var rest = lines.slice(i).join(eol), r = { id: id(), type: 'raw', visible: true, locked: false, text: rest, src: rest, gap: -1 }; r.name = nameOf(r); blocks[blocks.length - 1].gap = Math.max(blocks[blocks.length - 1].gap, 0); blocks.push(r); }
    // 最後一個區塊的 gap：結尾換行數 − 1（splitting 的結尾空字串被算成一個空白行）
    return spec;
  }

  // ───────── 文件的整體檢查與動作
  var extraOps = {
    set_text: { words: function (e) { return '改文字 ' + e.id; }, apply: function (s, e, H) { var i = H.find(s, e.id); if (i < 0) { return { error: 'there is no block "' + str(e.id, 30) + '"' }; } var o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; } if (!('text' in types[o.type].defaults)) { return { error: o.type + ' blocks have no text' }; } var n = H.clone(o); n.text = e.text; delete n.src; var p = [], v = H.validateObject(n, p, {}); if (!v) { return { error: p[0] || 'invalid' }; } v.id = o.id; v.name = nameOf(v); s.objects[i] = v; return {}; } },
    set_heading: { words: function (e) { return '標題層級 ' + e.id + ' → H' + e.level; }, apply: function (s, e, H) { var i = H.find(s, e.id); if (i < 0) { return { error: 'there is no block "' + str(e.id, 30) + '"' }; } var o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; } var n = H.clone(o); if (o.type !== 'heading') { if (!('text' in types[o.type].defaults) || o.type === 'code' || o.type === 'raw') { return { error: 'only text blocks can become a heading' }; } n.type = 'heading'; n.text = String(o.text).replace(/\s*\n\s*/g, ' '); } n.level = e.level; delete n.src; var p = [], v = H.validateObject(n, p, {}); if (!v) { return { error: p[0] || 'invalid' }; } v.id = o.id; v.name = nameOf(v); s.objects[i] = v; return {}; } },
    list_toggle: { words: function (e) { return '清單 ' + e.id + (e.ordered ? '（編號）' : '（項目符號）'); }, apply: function (s, e, H) { var i = H.find(s, e.id); if (i < 0) { return { error: 'there is no block "' + str(e.id, 30) + '"' }; } var o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; } if (o.type === 'list') { var n = H.clone(o); n.ordered = !!e.ordered; delete n.src; s.objects[i] = Object.assign(H.validateObject(n, [], {}), { id: o.id, name: o.name }); return {}; } if (o.type !== 'para' && o.type !== 'line') { return { error: 'only paragraphs can become a list' }; } var items = String(o.text).split('\n').filter(function (x) { return x.trim(); }); var v = H.validateObject({ type: 'list', items: items, ordered: !!e.ordered, gap: o.gap, name: o.name, visible: o.visible, locked: o.locked }, [], {}); if (!v) { return { error: 'invalid' }; } v.id = o.id; v.name = nameOf(v); s.objects[i] = v; return {}; } },
    set_cell: { words: function (e) { return '表格 ' + e.id + ' 第 ' + (e.row + 1) + ' 列第 ' + (e.col + 1) + ' 欄'; }, apply: function (s, e, H) { var i = H.find(s, e.id); if (i < 0) { return { error: 'there is no block "' + str(e.id, 30) + '"' }; } var o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; } if (o.type !== 'table') { return { error: 'not a table' }; } var r = Number(e.row), c = Number(e.col); if (!(r >= 0 && r < o.rows.length && c >= 0 && c < o.rows[0].length)) { return { error: 'the cell (' + e.row + ', ' + e.col + ') is outside the table' }; } var n = H.clone(o); n.rows[r][c] = e.text; delete n.src; var v = H.validateObject(n, [], {}); v.id = o.id; v.name = nameOf(v); s.objects[i] = v; return {}; } },
    replace_all: { words: function (e) { return '全部取代「' + snippet(e.find, 12) + '」→「' + snippet(e.repl, 12) + '」'; }, apply: function (s, e, H) { var r = replaceAllText(s, e.find, e.repl, { scope: e.scope, caseSensitive: e.caseSensitive, regex: e.regex, whole: e.whole }); if (r.error) { return { error: r.error }; } if (!r.count) { return { error: 'the text "' + snippet(e.find, 30) + '" was not found' }; } return {}; } },
  };
  var E = O.make({
    types: types, extraOps: extraOps, limits: { objects: MAXBLOCKS, canvas: 16384 },
    defaultSpec: function () { return { v: 1, title: '未命名文件', format: 'md', eol: '\n', bom: false, lead: 0, pad: '', canvas: { x: 0, y: 0, w: 800, h: 600, bg: '#ffffff' }, seq: 0, objects: [] }; },
    describeObject: function (o) { return o.type + (o.text ? ' 「' + snippet(o.text, 24) + '」' : ''); },
  });
  function validate(spec) {
    var r = E.validate(spec), s = r.spec, src = spec && typeof spec === 'object' ? spec : {};
    s.format = src.format === 'txt' ? 'txt' : 'md'; s.eol = src.eol === '\r\n' ? '\r\n' : '\n'; s.bom = !!src.bom; s.lead = int(src.lead, 0, 100, 0); s.pad = str(src.pad, 100000); if (Array.isArray(src.leadLines)) { s.leadLines = src.leadLines.slice(0, 100).map(function (x) { return str(x, 200); }); }
    s.objects.forEach(function (b) { if (!b.name || /^(heading|para|list|quote|code|table|hr|raw|line)\b/i.test(b.name) || b.name === (types[b.type] && types[b.type].label)) { b.name = nameOf(b); } });
    return r;
  }
  // 查找取代：scope 'all' 或某個區塊 id；回傳 { count, error? }，直接改傳入的 spec（applyEdits 在複本上呼叫）；碰到的區塊清掉 src
  function replaceAllText(spec, find, repl, o) {
    o = o || {}; find = String(find == null ? '' : find); repl = String(repl == null ? '' : repl); if (!find) { return { error: 'find must not be empty' }; }
    var re; try { re = o.regex ? new RegExp(find, o.caseSensitive ? 'g' : 'gi') : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), o.caseSensitive ? 'g' : 'gi'); } catch (e) { return { error: 'bad pattern: ' + e.message }; }
    if (o.whole && !o.regex) { re = new RegExp('\\b' + find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', o.caseSensitive ? 'g' : 'gi'); }
    var count = 0, scope = o.scope && o.scope !== 'all' ? String(o.scope) : null; var sub = function (t) { return String(t).replace(re, function () { count++; return o.regex ? arguments[0].replace(new RegExp(find, o.caseSensitive ? '' : 'i'), repl) : repl; }); };
    spec.objects.forEach(function (b) {
      if (b.locked || (scope && b.id !== scope) || b.type === 'hr') { return; } var before = count, ch = false;
      if ('text' in b && b.type !== 'raw') { var nt = sub(b.text); if (nt !== b.text) { b.text = nt; ch = true; } }
      if (b.type === 'list') { b.items = b.items.map(function (x) { var nx = sub(x); if (nx !== x) { ch = true; } return nx; }); }
      if (b.type === 'table') { b.rows = b.rows.map(function (r) { return r.map(function (c) { var nc = sub(c); if (nc !== c) { ch = true; } return nc; }); }); }
      if (ch || count !== before) { delete b.src; b.name = nameOf(b); }
    });
    return { count: count };
  }
  function applyEdits(spec, edits, env) {
    // replace_all 直接改複本；其餘交給共用的動作；add_block 是 add_object 的別名（較貼近文件的說法）
    var mapped = (edits || []).map(function (e) { if (e && e.op === 'add_block') { var at = e.at; if (e.after === 'start') { at = 'bottom'; } else if (e.after && e.after !== 'end') { at = { above: e.after }; } else if (e.before) { var bi = E.find(spec, e.before); at = bi >= 0 ? bi : 'top'; } else if (at == null) { at = 'top'; } return { op: 'add_object', object: Object.assign({ type: 'para' }, e.block || e.object || {}), at: at }; } if (e && e.op === 'update_block') { return Object.assign({}, e, { op: 'update_object' }); } if (e && e.op === 'remove_block') { return Object.assign({}, e, { op: 'remove_object' }); } return e; });
    mapped = mapped.map(function (e) { if (e && e.op === 'update_object' && e.props) { var p = Object.assign({}, e.props); if ('text' in p || 'items' in p || 'rows' in p || 'level' in p || 'lang' in p || 'ordered' in p) { p.src = ''; } return Object.assign({}, e, { props: p }); } return e; });
    var r = E.applyEdits(spec, mapped, env);
    // add_object 進來的區塊沒有 src；名字統一
    r.spec.objects.forEach(function (b) { if (!b.name || b.name === (types[b.type] && types[b.type].label) || /^(heading|para|list|quote|code|table|hr|raw|line)\s*\d*$/i.test(b.name)) { b.name = nameOf(b); } if (b.src === '') { delete b.src; } });
    return r;
  }
  var STARTERS = [
    { id: 'blank', label: '空白文件', desc: '從零開始。', spec: function () { return { v: 1, title: '未命名文件', format: 'md', objects: [{ type: 'heading', text: '標題', level: 1 }, { type: 'para', text: '' }] }; } },
    { id: 'notes', label: '會議記錄', desc: '日期、出席、討論、待辦。', spec: function () { return { v: 1, title: '會議記錄', format: 'md', objects: [{ type: 'heading', text: '會議記錄', level: 1 }, { type: 'para', text: '日期：' }, { type: 'heading', text: '出席', level: 2 }, { type: 'list', items: [''] }, { type: 'heading', text: '討論', level: 2 }, { type: 'para', text: '' }, { type: 'heading', text: '待辦', level: 2 }, { type: 'list', items: [''] }] }; } },
    { id: 'readme', label: 'README', desc: '專案說明的骨架。', spec: function () { return { v: 1, title: 'README', format: 'md', objects: [{ type: 'heading', text: '專案名稱', level: 1 }, { type: 'para', text: '一句話說明這個專案做什麼。' }, { type: 'heading', text: '安裝', level: 2 }, { type: 'code', text: 'npm install', lang: 'bash' }, { type: 'heading', text: '使用', level: 2 }, { type: 'para', text: '' }, { type: 'heading', text: '授權', level: 2 }, { type: 'para', text: 'MIT' }] }; } },
  ];
  function starter(id) { var t = STARTERS.filter(function (x) { return x.id === id; })[0]; if (!t) { return null; } var sp = validate(t.spec()).spec; sp.objects.forEach(function (b) { b.name = nameOf(b); }); return sp; }
  function listStarters() { return STARTERS.map(function (t) { return { id: t.id, label: t.label, desc: t.desc }; }); }
  function outline(spec) { return spec.objects.filter(function (b) { return b.type === 'heading'; }).map(function (b) { return new Array(b.level).join('  ') + '- ' + b.text; }).join('\n'); }
  return { types: types, extraOps: extraOps, OPS: E.OPS, validate: validate, applyEdits: applyEdits, editWords: E.editWords, find: E.find, list: E.list, parse: parse, serialize: serialize, render: render, starter: starter, listStarters: listStarters, outline: outline, replaceAllText: replaceAllText, nameOf: nameOf, E: E };
});
