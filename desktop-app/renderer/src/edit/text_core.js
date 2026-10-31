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
    convert_block: { words: function (e) { return '轉成' + ({ para: '段落', quote: '引用', code: '程式碼', heading: '標題', list: '清單', olist: '編號清單', raw: '原樣' }[e.to] || e.to) + ' ' + e.id; }, apply: function (s, e, H) { var i = H.find(s, e.id); if (i < 0) { return { error: 'there is no block "' + str(e.id, 30) + '"' }; } var o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; } var to = String(e.to || ''), flat = o.type === 'list' ? o.items.join('\n') : o.type === 'table' ? o.rows.map(function (r) { return r.join('\t'); }).join('\n') : o.type === 'hr' ? '' : o.text; if (s.format === 'txt') { return { error: 'a plain text file has only lines' }; } var n = { gap: o.gap, visible: o.visible, locked: o.locked };
      if (to === 'para' || to === 'quote' || to === 'raw') { n.type = to; n.text = flat; } else if (to === 'code') { n.type = 'code'; n.text = flat; n.lang = e.lang || ''; } else if (to === 'heading') { n.type = 'heading'; n.text = flat.replace(/\s*\n\s*/g, ' '); n.level = e.level || 2; } else if (to === 'list' || to === 'olist') { n.type = 'list'; n.ordered = to === 'olist'; n.items = flat.split('\n').filter(function (x) { return x.trim(); }); } else { return { error: 'to must be para, quote, code, heading, list, olist or raw' }; }
      var p = [], v = H.validateObject(n, p, {}); if (!v) { return { error: p[0] || 'invalid' }; } v.id = o.id; v.name = nameOf(v); s.objects[i] = v; return {}; } },
    move_block: { words: function (e) { return '移動 ' + e.id + ' → ' + e.to; }, apply: function (s, e, H) { var i = H.find(s, e.id); if (i < 0) { return { error: 'there is no block "' + str(e.id, 30) + '"' }; } var o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; } var n = s.objects.length, w = e.to, j = w === 'up' || w === 'earlier' ? i - 1 : w === 'down' || w === 'later' ? i + 1 : w === 'top' || w === 'front' || w === 'first' || w === 'start' ? 0 : w === 'bottom' || w === 'back' || w === 'last' || w === 'end' ? n - 1 : Number(w); if (!isFinite(j)) { return { error: 'to must be earlier, later, first, last or a position' }; } j = Math.max(0, Math.min(n - 1, Math.round(j))); s.objects.splice(i, 1); s.objects.splice(j, 0, o); return {}; } },
    // 把一個區塊換成「用文件原本的語法寫的一段文字」（雙擊區塊編輯就是這個）：解析出 0 個（＝刪掉）、1 個或多個區塊，第一個沿用 id、顯示／鎖定狀態；打的字原樣當成這個區塊的 src
    replace_block: { words: function (e) { return '改寫區塊 ' + e.id; }, apply: function (s, e, H) { var i = H.find(s, e.id); if (i < 0) { return { error: 'there is no block "' + str(e.id, 30) + '"' }; } var o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; }
      var sub = parse(String(e.text == null ? '' : e.text).replace(/\r\n/g, '\n'), s.format), nb = sub.objects.filter(function (b) { return s.format === 'txt' || !(b.type === 'raw' && !String(b.text).trim()); }); if (s.format !== 'txt' && !String(e.text || '').trim()) { nb = []; }
      if (s.objects.length - 1 + nb.length > MAXBLOCKS) { return { error: 'too many blocks' }; } var eol = s.eol === '\r\n' ? '\r\n' : '\n', out = nb.map(function (b, k) { var n = JSON.parse(JSON.stringify(b)); n.visible = o.visible; n.locked = false; if (k === 0) { n.id = o.id; } else { s.seq++; n.id = 'o' + s.seq; s._added = (s._added || []).concat([n.id]); } if (n.src) { n.src = n.src.replace(/\n/g, eol); } if (k === nb.length - 1) { n.gap = o.gap; delete n.gapLines; if (o.gapLines && n.src) { n.gapLines = o.gapLines; } } return n; });
      s.objects.splice.apply(s.objects, [i, 1].concat(out)); return {}; } },
    set_doc: { words: function (e) { return '文件設定' + (e.eol ? '：換行 ' + (e.eol === '\r\n' ? 'CRLF' : 'LF') : '') + (e.bom != null ? '：BOM ' + (e.bom ? '有' : '無') : ''); }, apply: function (s, e) { if (e.eol != null) { var ne = e.eol === 'crlf' || e.eol === '\r\n' ? '\r\n' : '\n', oe = s.eol === '\r\n' ? '\r\n' : '\n'; if (ne !== oe) { var cv = function (t) { return String(t).replace(/\r\n|\n/g, ne); }; s.objects.forEach(function (b) { if (b.src) { b.src = cv(b.src); } }); if (s.leadLines) { s.leadLines = s.leadLines.slice(); } s.pad = cv(s.pad || ''); s.eol = ne; } } if (e.bom != null) { s.bom = !!e.bom; } return {}; } },
    replace_all: { words: function (e) { return '全部取代「' + snippet(e.find, 12) + '」→「' + snippet(e.repl, 12) + '」'; }, apply: function (s, e, H) { var r = replaceAllText(s, e.find, e.repl, { scope: e.scope, caseSensitive: e.caseSensitive, regex: e.regex, whole: e.whole }); if (r.error) { return { error: r.error }; } if (!r.count) { return { error: 'the text "' + snippet(e.find, 30) + '" was not found' }; } return {}; } },
  };
  var E = O.make({
    types: types, extraOps: extraOps, keep: ['format', 'eol', 'bom', 'lead', 'pad', 'leadLines'], limits: { objects: MAXBLOCKS, canvas: 16384 },
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
    var mapped = (edits || []).map(function (e) { if (e && e.op === 'add_block') { var at = e.at; if (e.after === 'start') { at = 'bottom'; } else if (e.after && e.after !== 'end') { at = { above: e.after }; } else if (e.before) { var bi = E.find(spec, e.before); at = bi >= 0 ? bi : 'top'; } else if (at == null) { at = 'top'; } return { op: 'add_object', object: Object.assign({ type: 'para' }, e.block || e.object || {}), at: at }; } if (e && e.op === 'update_block') { return Object.assign({}, e, { op: 'update_object' }); } if (e && e.op === 'remove_block') { return Object.assign({}, e, { op: 'remove_object' }); } if (e && e.op === 'move_object') { return Object.assign({}, e, { op: 'move_block' }); } return e; });
    mapped = mapped.map(function (e) { if (e && e.op === 'update_object' && e.props) { var p = Object.assign({}, e.props); if ('text' in p || 'items' in p || 'rows' in p || 'level' in p || 'lang' in p || 'ordered' in p) { p.src = ''; } return Object.assign({}, e, { props: p }); } return e; });
    var r = E.applyEdits(spec, mapped, env);
    // 結尾的空白行數屬於「文件的結尾」，不屬於哪個區塊：最後一個區塊換人時（搬動、刪除、在最後加）把它交給新的最後一個，舊的改成普通的一個空白行
    var o0 = spec.objects, ol = o0.length ? o0[o0.length - 1] : null, n1 = r.spec.objects, nl = n1.length ? n1[n1.length - 1] : null;
    if (spec.format !== 'txt' && ol && nl && nl.id !== ol.id) { var tg = ol.gap, tl = ol.gapLines; n1.forEach(function (b) { if (b.id === ol.id) { b.gap = 1; delete b.gapLines; } }); nl.gap = tg; if (tl && nl.src) { nl.gapLines = tl; } else { delete nl.gapLines; } }
    // add_object 進來的區塊沒有 src；名字統一
    r.spec.objects.forEach(function (b) { if (!b.name || b.name === (types[b.type] && types[b.type].label) || /^(heading|para|list|quote|code|table|hr|raw|line)\s*\d*$/i.test(b.name)) { b.name = nameOf(b); } if (b.src === '') { delete b.src; } });
    return r;
  }
  // ───── 程式讀得懂的白話（不經過模型）：改字、全部取代、加／刪區塊、標題層級、清單、移動。讀不懂的回 unmatched 交給 AI。「第 N 段」從文件開頭算
  function parseCommands(text, spec) {
    var out = { edits: [], matched: [], unmatched: [] }, s = validate(spec).spec, bl = s.objects, all = bl.map(function (b) { return JSON.stringify(b); }).join('\n').toLowerCase();
    function ref(r) {
      r = String(r || '').trim().replace(/^[「"'『]|[」"'』]$/g, ''); var m = /^(?:第\s*)?(\d+)\s*(?:個|段|節|行|項|區塊|號)?$/.exec(r); if (m) { var k = Number(m[1]) - 1; return k >= 0 && k < bl.length ? bl[k].id : null; }
      if (/^(最後|最後一段|最後一個|最後一行)$/.test(r)) { return bl.length ? bl[bl.length - 1].id : null; } if (/^(第一|第一段|第一個|第一行|開頭)$/.test(r)) { return bl.length ? bl[0].id : null; }
      var i = E.find(s, r); if (i >= 0) { return bl[i].id; } var low = r.toLowerCase(), hit = bl.filter(function (b) { return String(b.name || '').toLowerCase().indexOf(low) >= 0 || String(b.text || (b.items || []).join(' ') || '').toLowerCase().indexOf(low) >= 0; }); return hit.length === 1 ? hit[0].id : null;
    }
    var clauses = String(text || '').split(/[。；;\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    clauses.forEach(function (c) {
      var m, e = null, id;
      if ((m = /^(?:把|將)?\s*(?:所有的?|全部的?)?[「"'『](.+?)[」"'』]\s*(?:全部)?(?:都)?(?:改成|換成|改為|取代成|取代為|替換成)\s*[「"'『]?(.*?)[」"'』]?$/.exec(c)) && all.indexOf(m[1].toLowerCase()) >= 0) { e = { op: 'replace_all', find: m[1], repl: m[2] }; }
      else if ((m = /^(?:把|將)?\s*(.+?)\s*(?:刪掉|刪除|移除|拿掉)$/.exec(c)) || (m = /^(?:刪掉|刪除|移除|拿掉)\s*(.+)$/.exec(c))) { id = ref(m[1]); if (id) { e = { op: 'remove_block', id: id }; } }
      else if ((m = /^(?:把|將)?\s*(.+?)\s*(?:改成|換成|改為)\s*(?:第?\s*([1-6一二三四五六])\s*(?:級|層)標題|H([1-6])|標題\s*([1-6]))$/i.exec(c))) { id = ref(m[1]); var lv = m[2] || m[3] || m[4], zh = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 }; if (id) { e = { op: 'set_heading', id: id, level: zh[lv] || Number(lv) }; } }
      else if ((m = /^(?:把|將)?\s*(.+?)\s*(?:改成|換成|變成|轉成)\s*(編號清單|項目清單|項目符號清單|清單|引用|引言|程式碼|一般段落|段落)$/.exec(c))) { id = ref(m[1]); var to = { '編號清單': 'olist', '項目清單': 'list', '項目符號清單': 'list', '清單': 'list', '引用': 'quote', '引言': 'quote', '程式碼': 'code', '一般段落': 'para', '段落': 'para' }[m[2]]; if (id && to) { e = { op: 'convert_block', id: id, to: to }; } }
      else if ((m = /^(?:把|將)?\s*(.+?)\s*(?:移到最前面|移到最前|移到開頭|移到最上面|移到最後面|移到最後|移到結尾|往前一個|往前移|往上移|上移|往後一個|往後移|往下移|下移)$/.exec(c))) { id = ref(m[1]); var w = c.slice(c.length - 6); if (id) { e = { op: 'move_object', id: id, to: /最前|開頭|最上/.test(c) ? 'first' : /最後|結尾/.test(c) ? 'last' : /前|上移|往上/.test(c) ? 'earlier' : 'later' }; } }
      else if ((m = /^(?:把|將)?\s*(.+?)\s*(?:改成|換成|改為)\s*[：:]?\s*(.+)$/.exec(c)) && !/^[「"'『]/.test(m[1]) && (id = ref(m[1]))) { var bo = bl[E.find(s, id)]; if (bo && 'text' in types[bo.type].defaults && bo.type !== 'raw') { e = { op: 'set_text', id: id, text: m[2].replace(/^[「"'『]|[」"'』]$/g, '') }; } }
      else if ((m = /^(?:在)?\s*(最後|結尾|文末|最前面|開頭|文首|(?:第\s*\d+\s*(?:段|個|行|節)|.+?)(?:的)?(?:後面|之後|下面))\s*(?:加|新增|加入|插入|補)\s*(?:上)?\s*(?:一個|一段|一行|一條)?\s*(?:(?:([1-6一二三四五六])\s*(?:級|層)標題|標題)|(清單|項目清單|編號清單|段落|引用))?\s*[：:]?\s*(.+)$/.exec(c)) && !(spec.format === 'txt' && false)) {
        var where = m[1], hz = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 }, isH = /標題/.test(c.slice(0, c.length - m[4].length)), after = /最後|結尾|文末/.test(where) ? 'end' : /最前面|開頭|文首/.test(where) ? 'start' : ref(where.replace(/(?:的)?(?:後面|之後|下面)$/, ''));
        if (after) { var body = m[4], kind = m[3] || '', blk = isH ? { type: 'heading', text: body, level: hz[m[2]] || Number(m[2]) || 2 } : /清單/.test(kind) ? { type: 'list', ordered: /編號/.test(kind), items: body.split(/[、,，\n]/).map(function (x) { return x.trim(); }).filter(Boolean) } : kind === '引用' ? { type: 'quote', text: body } : s.format === 'txt' ? { type: 'line', text: body } : { type: 'para', text: body }; if (s.format === 'txt') { blk = { type: 'line', text: body }; } e = { op: 'add_block', after: after, block: blk }; }
      }
      if (!e && (m = /^(?:把|將)\s*(.+?)\s*全部(?:都)?(?:改成|換成|取代成|取代為)\s*(.+)$/.exec(c)) && all.indexOf(m[1].toLowerCase()) >= 0) { e = { op: 'replace_all', find: m[1].replace(/^[「"'『]|[」"'』]$/g, ''), repl: m[2].replace(/^[「"'『]|[」"'』]$/g, '') }; }
      if (!e && s.format !== 'txt' && (m = /^(?:加|新增|加入)\s*(?:一個)?\s*(?:([1-6一二三四五六])\s*(?:級|層))?標題\s*[：:]?\s*(.+)$/.exec(c))) { e = { op: 'add_block', after: 'end', block: { type: 'heading', text: m[2], level: ({ '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 })[m[1]] || Number(m[1]) || 2 } }; }
      if (e) { out.edits.push(e); out.matched.push(c); } else { out.unmatched.push(c); }
    });
    return out;
  }
  var AI_OPS = ['set_text', 'set_heading', 'list_toggle', 'set_cell', 'replace_all', 'convert_block', 'add_block', 'update_block', 'remove_block', 'move_object', 'rename_object', 'duplicate_object', 'set_title'];
  // 給模型的提示：文件的大綱（每個區塊的 id 與開頭）＋選到的區塊全文＋可用動作。很短的文件整份放進去；長的只放每個區塊前 160 字
  function editPrompt(spec, request, selection, o) {
    o = o || {}; var s = validate(spec).spec, budget = o.budget || 9000, total = s.objects.reduce(function (n, b) { return n + (b.text || (b.items || []).join('') || (b.rows || []).join('')).length; }, 0), full = total <= budget;
    var lines = s.objects.map(function (b, i) { var body = b.type === 'list' ? b.items.map(function (x) { return '- ' + x; }).join('\n') : b.type === 'table' ? b.rows.map(function (r) { return r.join(' | '); }).join('\n') : (b.text || ''); if (!(full || b.id === selection)) { body = body.length > 160 ? body.slice(0, 160) + '…' : body; } return (i + 1) + '. [' + b.id + '] ' + b.type + (b.type === 'heading' ? ' H' + b.level : '') + (b.locked ? ' (locked)' : '') + (b.id === selection ? ' (selected)' : '') + '\n' + body; });
    var system = 'You edit a ' + (s.format === 'txt' ? 'plain text file (one block = one line)' : 'Markdown document') + ' by answering ONLY with JSON {"say":"one short sentence","edits":[...]}. Every edit is one of these actions (ids come from the list; never invent ids):\n'
      + '{op:"set_text",id,text} replace the text of a heading/paragraph/quote/code/line block\n{op:"set_heading",id,level:1-6} make a block a heading of that level\n{op:"list_toggle",id,ordered:true|false} turn a paragraph into a list or switch bullets/numbers\n{op:"set_cell",id,row,col,text} one table cell (0-based)\n{op:"replace_all",find,repl,scope?:blockId,caseSensitive?,regex?} find and replace\n'
      + '{op:"convert_block",id,to:"para|quote|code|heading|list|olist"}\n{op:"add_block",after:"start|end|<blockId>",block:{type:"heading|para|list|quote|code|table|hr' + (s.format === 'txt' ? '|line' : '') + '",text?,level?,items?,ordered?,lang?,rows?}}\n{op:"update_block",id,props:{…}}  {op:"remove_block",id}  {op:"move_object",id,to:"earlier|later|first|last|<position>"}  {op:"duplicate_object",id}  {op:"set_title",text}\n'
      + 'Change only what was asked; keep the rest of the document untouched. Write new text in the language of the document. If the request cannot be done with these actions, return {"say":"why","edits":[]}.';
    return { system: system, user: 'Document "' + s.title + '" (' + s.objects.length + ' blocks' + (full ? '' : ', long: bodies shortened' ) + '):\n\n' + (lines.join('\n\n') || '(empty)') + '\n\nRequest: ' + String(request || '') };
  }
  function parseEditsReply(text) { return O.parseEditsReply(text, AI_OPS); }
  // ───── 預覽與匯出 HTML：所有文字先跳脫，再加上我們自己的標籤（連結只收 http／https／mailto），所以預覽可以直接當 innerHTML
  function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function inlineHtml(t, depth) {
    t = String(t == null ? '' : t); depth = depth || 0; var re = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|\*([^*\n]+?)\*|!\[([^\]\n]*)\]\(([^)\s]*)[^)\n]*\)|\[([^\]\n]+)\]\(([^)\s]*)[^)\n]*\)|<(https?:\/\/[^>\s]+)>/g, out = '', last = 0, m;
    while ((m = re.exec(t))) {
      out += esc(t.slice(last, m.index)); last = re.lastIndex;
      if (m[2] != null) { out += '<code>' + esc(m[2]) + '</code>'; } else if (m[3] != null || m[4] != null) { out += '<strong>' + (depth < 3 ? inlineHtml(m[3] != null ? m[3] : m[4], depth + 1) : esc(m[3] || m[4])) + '</strong>'; } else if (m[5] != null) { out += '<del>' + esc(m[5]) + '</del>'; } else if (m[6] != null) { out += '<em>' + (depth < 3 ? inlineHtml(m[6], depth + 1) : esc(m[6])) + '</em>'; }
      else if (m[8] != null) { out += '<span class="img">🖼 ' + esc(m[7] || m[8]) + '</span>'; }
      else if (m[9] != null) { out += /^(https?:|mailto:)/i.test(m[10]) ? '<a href="' + esc(m[10]) + '" target="_blank" rel="noopener noreferrer">' + esc(m[9]) + '</a>' : esc(m[9]); }
      else if (m[11] != null) { out += '<a href="' + esc(m[11]) + '" target="_blank" rel="noopener noreferrer">' + esc(m[11]) + '</a>'; }
    }
    return out + esc(t.slice(last));
  }
  function blockHtml(b) {
    switch (b.type) {
      case 'heading': return '<h' + b.level + '>' + inlineHtml(b.text) + '</h' + b.level + '>';
      case 'para': return '<p>' + inlineHtml(b.text).replace(/\n/g, '<br>') + '</p>';
      case 'line': return '<div class="ln">' + (b.text === '' ? '&nbsp;' : esc(b.text)) + '</div>';
      case 'quote': return '<blockquote>' + inlineHtml(b.text).replace(/\n/g, '<br>') + '</blockquote>';
      case 'list': return '<' + (b.ordered ? 'ol' : 'ul') + '>' + b.items.map(function (x) { return '<li>' + inlineHtml(x).replace(/\n/g, '<br>') + '</li>'; }).join('') + '</' + (b.ordered ? 'ol' : 'ul') + '>';
      case 'code': return '<pre><code' + (b.lang ? ' class="language-' + esc(b.lang) + '"' : '') + '>' + esc(b.text) + '</code></pre>';
      case 'table': { var al = function (i) { return b.align && b.align[i] ? ' style="text-align:' + b.align[i] + '"' : ''; }; return '<table><thead><tr>' + b.rows[0].map(function (c, i) { return '<th' + al(i) + '>' + inlineHtml(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + b.rows.slice(1).map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + al(i) + '>' + inlineHtml(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>'; }
      case 'hr': return '<hr>';
      default: return '<pre class="raw">' + esc(b.text) + '</pre>';
    }
  }
  function toHtml(spec, o) { o = o || {}; var s = validate(spec).spec; return '<!doctype html>\n<html><head><meta charset="utf-8"><title>' + esc(s.title) + '</title><style>body{font:16px/1.7 system-ui,"Microsoft JhengHei",sans-serif;max-width:48em;margin:2em auto;padding:0 1em;color:#1f2328}pre{background:#f6f8fa;padding:.8em;overflow:auto;border-radius:6px}code{background:#f6f8fa;padding:0 .25em;border-radius:3px}pre code{padding:0}blockquote{margin:1em 0;padding:0 1em;border-left:4px solid #d0d7de;color:#59636e}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:.3em .7em}img{max-width:100%}</style></head><body>\n' + s.objects.filter(function (b) { return b.visible !== false; }).map(blockHtml).join('\n') + '\n</body></html>\n'; }
  // 把整份原始碼重新解析，但沒變的區塊沿用原本的 id、名字、顯示／鎖定（前後相同的先配對，中間用最長共同子序列）：改原始碼不會讓每個區塊都換 id（遠端共筆與 AI 引用 id 才不會斷）
  function reparse(spec, text) {
    var old = validate(spec).spec, nu = parse(text, old.format), a = old.objects, b = nu.objects, key = function (x) { return x.type + '\u0001' + (x.src != null && x.src !== '' ? x.src : render(x)); };
    var ka = a.map(key), kb = b.map(key), n = a.length, m = b.length, p = 0; while (p < n && p < m && ka[p] === kb[p]) { p++; } var q = 0; while (q < n - p && q < m - p && ka[n - 1 - q] === kb[m - 1 - q]) { q++; }
    var map = {}; for (var i = 0; i < p; i++) { map[i] = i; } for (var j = 0; j < q; j++) { map[m - 1 - j] = n - 1 - j; }
    var na = n - p - q, nb = m - p - q;
    if (na > 0 && nb > 0 && na * nb <= 4000000) { var L = []; for (var x = 0; x <= na; x++) { L.push(new Int32Array(nb + 1)); } for (x = na - 1; x >= 0; x--) { for (var y = nb - 1; y >= 0; y--) { L[x][y] = ka[p + x] === kb[p + y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]); } } x = 0; y = 0; while (x < na && y < nb) { if (ka[p + x] === kb[p + y]) { map[p + y] = p + x; x++; y++; } else if (L[x + 1][y] >= L[x][y + 1]) { x++; } else { y++; } } }
    // 兩個配對點之間，舊的與新的區塊一樣多：視為「改了內容」，依位置一對一沿用 id（改一段字不會讓那一段換 id）
    var pairs = []; for (var k0 = 0; k0 < m; k0++) { if (map[k0] != null) { pairs.push([map[k0], k0]); } } pairs.unshift([-1, -1]); pairs.push([n, m]);
    for (var g = 0; g + 1 < pairs.length; g++) { var oa = pairs[g + 1][0] - pairs[g][0] - 1, ob = pairs[g + 1][1] - pairs[g][1] - 1; if (oa > 0 && oa === ob) { for (var t = 1; t <= oa; t++) { map[pairs[g][1] + t] = pairs[g][0] + t; } } }
    var used = {}; a.forEach(function (o) { used[o.id] = 1; }); var seq = old.seq || 0; a.forEach(function (o) { var mm = /^[bo](\d+)$/.exec(o.id); if (mm) { seq = Math.max(seq, Number(mm[1])); } });
    var out = b.map(function (nb2, k) { var o = map[k] != null ? a[map[k]] : null, r = JSON.parse(JSON.stringify(nb2)); if (o) { r.id = o.id; r.name = o.name; r.visible = o.visible; r.locked = o.locked; } else { do { seq++; } while (used['o' + seq]); r.id = 'o' + seq; used[r.id] = 1; } return r; });
    var next = JSON.parse(JSON.stringify(nu)); next.objects = out; next.title = old.title; next.seq = seq; return validate(next).spec;
  }
  var STARTERS = [
    { id: 'blank', label: '空白文件', desc: '從零開始。', spec: function () { return { v: 1, title: '未命名文件', format: 'md', objects: [{ type: 'heading', text: '標題', level: 1 }, { type: 'para', text: '' }] }; } },
    { id: 'notes', label: '會議記錄', desc: '日期、出席、討論、待辦。', spec: function () { return { v: 1, title: '會議記錄', format: 'md', objects: [{ type: 'heading', text: '會議記錄', level: 1 }, { type: 'para', text: '日期：' }, { type: 'heading', text: '出席', level: 2 }, { type: 'list', items: [''] }, { type: 'heading', text: '討論', level: 2 }, { type: 'para', text: '' }, { type: 'heading', text: '待辦', level: 2 }, { type: 'list', items: [''] }] }; } },
    { id: 'readme', label: 'README', desc: '專案說明的骨架。', spec: function () { return { v: 1, title: 'README', format: 'md', objects: [{ type: 'heading', text: '專案名稱', level: 1 }, { type: 'para', text: '一句話說明這個專案做什麼。' }, { type: 'heading', text: '安裝', level: 2 }, { type: 'code', text: 'npm install', lang: 'bash' }, { type: 'heading', text: '使用', level: 2 }, { type: 'para', text: '' }, { type: 'heading', text: '授權', level: 2 }, { type: 'para', text: 'MIT' }] }; } },
  ];
  function starter(id) { var t = STARTERS.filter(function (x) { return x.id === id; })[0]; if (!t) { return null; } var sp = validate(t.spec()).spec; sp.objects.forEach(function (b) { b.name = nameOf(b); }); return sp; }
  function listStarters() { return STARTERS.map(function (t) { return { id: t.id, label: t.label, desc: t.desc }; }); }
  function outline(spec) { return spec.objects.filter(function (b) { return b.type === 'heading'; }).map(function (b) { return new Array(b.level).join('  ') + '- ' + b.text; }).join('\n'); }
  return { types: types, extraOps: extraOps, OPS: E.OPS, validate: validate, applyEdits: applyEdits, editWords: E.editWords, find: E.find, list: E.list, parse: parse, serialize: serialize, render: render, starter: starter, listStarters: listStarters, outline: outline, replaceAllText: replaceAllText, parseCommands: parseCommands, reparse: reparse, toHtml: toHtml, blockHtml: blockHtml, inlineHtml: inlineHtml, editPrompt: editPrompt, parseEditsReply: parseEditsReply, AI_OPS: AI_OPS, nameOf: nameOf, E: E };
});
