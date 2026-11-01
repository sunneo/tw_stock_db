// /edit-docx 的文件核心（純函式，Node 與瀏覽器都能跑）。設計見 DESIGN.edit-docs.md §4（package patching）。
// 文件是「區塊」的清單（放在 spec.objects，所以共用外框 FaEditShell 的物件欄、復原、AI 對話、遠端共筆全部直接能用）：
//   { v:1, title, format:'docx', head, tail, sig, notes:[], seq, objects:[ { id, name, type, visible, locked, …, xml? } ] }
//   type：heading{level, runs} para{runs, align?} li{runs, ordered, lvl} table{rows:[[儲存格文字]]} pagebreak raw{text}（編輯器不懂的：圖片、欄位、追蹤修訂、文字方塊、目錄…原樣保留）
//   runs：[{ t:文字, rpr?:原本的 w:rPr 內容, rid?:超連結的關聯代號, href? }]；格式（粗／斜／底線／顏色）改 rpr，其餘字型大小等照舊
//   xml：這個區塊在原檔 document.xml 裡的原始 XML——**沒被改過的區塊匯出時原樣輸出**（任何會改內容的動作之後 xml 自動清掉）；head／tail：document.xml 在 body 前與 sectPr 之後的原文（命名空間、頁面設定）
//   package patching：匯出時只重寫 word/document.xml 的 body（必要時補 styles.xml 的標題樣式與 numbering.xml 的清單定義）；頁首頁尾、樣式、主題、圖片、關聯等其他 part 一律原封不動。沒改過就由呼叫端輸出原檔位元組（sig 相同）。
// API：FaEditDocx.read(bytes, JSZip, name) → Promise<spec>    build(spec, JSZip, origBytes?) → Promise<Uint8Array>    validate / applyEdits / editWords / find    parseCommands / editPrompt / parseEditsReply / AI_OPS    toHtml / blockHtml    plain(block)    starter / listStarters
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./edit_objects_core.js'));
  else root.FaEditDocx = factory(root.FaEditObjects || (typeof FaEditObjects !== 'undefined' ? FaEditObjects : undefined));
})(typeof self !== 'undefined' ? self : this, function (O) {
  'use strict';
  var MAXBLOCKS = 20000, MAXTEXT = 1000000, MAXXML = 3000000;
  function str(v, max) { return String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, max || 200); }
  function int(v, lo, hi, d) { var n = Math.round(Number(v)); if (!isFinite(n)) { return d; } return Math.max(lo, Math.min(hi, n)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function snippet(t, n) { var s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); return s.length > (n || 18) ? s.slice(0, n || 18) + '…' : s; }
  var xmlEsc = function (s) { return String(s).replace(/[&<>"\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : ''; }); };
  var xmlUnesc = function (s) { return String(s).replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, function (m, e) { return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e] || (e[1] === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10))); }); };

  // ───────── 極小的 XML 掃描：樹＋每個元素在原文裡的位置（區塊原樣輸出靠它）
  function scan(s, from, to) {
    var re = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, root = { n: '#root', c: [], s: from || 0, e: to == null ? s.length : to }, stack = [root], m;
    re.lastIndex = from || 0; var end = to == null ? s.length : to;
    while ((m = re.exec(s)) && m.index < end) {
      if (m[2] === undefined) { continue; }
      if (m[1]) { var top = stack[stack.length - 1]; if (top.n === m[2] && stack.length > 1) { top.e = m.index + m[0].length; top.ie = m.index; stack.pop(); } continue; }
      var node = { n: m[2], a: m[3] || '', c: [], s: m.index, e: m.index + m[0].length, is: m.index + m[0].length }; stack[stack.length - 1].c.push(node);
      if (!m[4]) { stack.push(node); } else { node.ie = node.is; }
    }
    return root;
  }
  var attr = function (a, name) { var m = new RegExp('(?:^|\\s)' + name.replace(':', '\\:') + '="([^"]*)"').exec(a || ''); return m ? xmlUnesc(m[1]) : null; };
  function kids(n, name) { return n.c.filter(function (k) { return k.n === name; }); }
  function inner(s, n) { return n.ie == null ? '' : s.slice(n.is, n.ie); }

  // ───────── run 的格式（w:rPr 的內容，保持 schema 順序）
  var RORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath'];
  function rprParts(rpr) { var out = [], rest = String(rpr || ''), re = /<w:([A-Za-z]+)\b[^>]*\/>/g, m; while ((m = re.exec(rest))) { out.push({ tag: m[1], xml: m[0] }); } var leftover = rest.replace(re, ''); return { parts: out, extra: leftover }; }
  function rprSet(rpr, tag, xml) {
    var p = rprParts(rpr), parts = p.parts.filter(function (x) { return x.tag !== tag; }); if (xml) { parts.push({ tag: tag, xml: xml }); }
    parts.sort(function (a, b) { var ia = RORDER.indexOf(a.tag), ib = RORDER.indexOf(b.tag); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); }); return parts.map(function (x) { return x.xml; }).join('') + p.extra;
  }
  function rprHas(rpr, tag) { var p = rprParts(rpr).parts.filter(function (x) { return x.tag === tag; })[0]; if (!p) { return false; } var v = attr(p.xml, 'w:val'); return !(v === '0' || v === 'false' || v === 'none'); }
  function rprColor(rpr) { var p = rprParts(rpr).parts.filter(function (x) { return x.tag === 'color'; })[0]; var v = p ? attr(p.xml, 'w:val') : null; return v && /^[0-9A-Fa-f]{6}$/.test(v) ? '#' + v.toUpperCase() : null; }
  var COLORS = { '紅': 'C00000', '紅色': 'C00000', '藍': '0070C0', '藍色': '0070C0', '綠': '00B050', '綠色': '00B050', '黃': 'FFC000', '黃色': 'FFC000', '橘': 'ED7D31', '橘色': 'ED7D31', '黑': '000000', '黑色': '000000', '灰': '7F7F7F', '灰色': '7F7F7F', '紫': '7030A0', '紫色': '7030A0', 'red': 'C00000', 'blue': '0070C0', 'green': '00B050', 'black': '000000', 'gray': '7F7F7F', 'orange': 'ED7D31', 'purple': '7030A0', 'yellow': 'FFC000' };
  function applyFmt(rpr, f) {
    if (f.bold != null) { rpr = rprSet(rpr, 'b', f.bold ? '<w:b/>' : null); rpr = rprSet(rpr, 'bCs', f.bold ? '<w:bCs/>' : null); }
    if (f.italic != null) { rpr = rprSet(rpr, 'i', f.italic ? '<w:i/>' : null); rpr = rprSet(rpr, 'iCs', f.italic ? '<w:iCs/>' : null); }
    if (f.underline != null) { rpr = rprSet(rpr, 'u', f.underline ? '<w:u w:val="single"/>' : null); }
    if (f.strike != null) { rpr = rprSet(rpr, 'strike', f.strike ? '<w:strike/>' : null); }
    if (f.color !== undefined) { var c = f.color === null || f.color === 'none' ? null : (COLORS[String(f.color).toLowerCase()] || String(f.color).replace(/^#/, '')); if (c && !/^[0-9A-Fa-f]{6}$/.test(c)) { c = null; } rpr = rprSet(rpr, 'color', c ? '<w:color w:val="' + c.toUpperCase() + '"/>' : null); }
    return rpr;
  }

  // ───────── runs
  function plain(b) { return (b.runs || []).map(function (r) { return r.t; }).join(''); }
  function mergeRuns(runs) { var out = []; runs.forEach(function (r) { if (r.t === '') { return; } var l = out[out.length - 1]; if (l && (l.rpr || '') === (r.rpr || '') && (l.rid || '') === (r.rid || '')) { l.t += r.t; } else { out.push(clone(r)); } }); return out; }
  function cleanRuns(rs) { return mergeRuns((Array.isArray(rs) ? rs : []).slice(0, 5000).map(function (r) { var o = { t: str(r && r.t, MAXTEXT) }; if (r && r.rpr) { o.rpr = str(r.rpr, 3000); } if (r && r.rid) { o.rid = str(r.rid, 40); } if (r && r.href) { o.href = str(r.href, 2000); } return o; })); }
  // 把文字換成 newText：頭尾沒變的部分保留原本每段的格式，中間改掉的部分用改動開頭那段的格式
  function retext(runs, newText) {
    var old = runs.map(function (r) { return r.t; }).join(''); if (old === newText) { return runs; } if (!runs.length) { return newText === '' ? [] : [{ t: newText }]; }
    var p = 0; while (p < old.length && p < newText.length && old[p] === newText[p]) { p++; } var q = 0; while (q < old.length - p && q < newText.length - p && old[old.length - 1 - q] === newText[newText.length - 1 - q]) { q++; }
    var mid = newText.slice(p, newText.length - q), cut = old.length - q, pos = 0, fmt = runs[0], acc = 0; for (var k = 0; k < runs.length; k++) { var a0 = acc, b0 = acc + runs[k].t.length; acc = b0; if (p === 0) { fmt = runs[0]; break; } if (a0 < p && b0 >= p) { fmt = runs[k]; break; } }
    var out = [], done = false;
    runs.forEach(function (r) {
      var a = pos, b = pos + r.t.length; pos = b; var pre = r.t.slice(0, Math.max(0, Math.min(r.t.length, p - a))); var post = r.t.slice(Math.max(0, Math.min(r.t.length, cut - a)));
      if (pre) { out.push(Object.assign({}, r, { t: pre })); }
      if (!done && r === fmt) { if (mid) { out.push(Object.assign({}, fmt, { t: mid })); } done = true; }
      if (post && b > cut) { out.push(Object.assign({}, r, { t: post })); }
    });
    return mergeRuns(out);
  }
  function formatRange(runs, find, f, all) {   // find 為空＝整段；否則只改第一個（all＝全部）符合的文字
    if (!find) { return runs.map(function (r) { return Object.assign({}, r, { rpr: applyFmt(r.rpr || '', f) }); }); }
    var text = plain({ runs: runs }), idxs = [], i = text.indexOf(find); while (i >= 0 && (all || !idxs.length)) { idxs.push(i); i = text.indexOf(find, i + find.length); } if (!idxs.length) { return null; }
    var cuts = {}; idxs.forEach(function (s) { cuts[s] = 1; cuts[s + find.length] = 1; }); var out = [], pos = 0;
    runs.forEach(function (r) { var pieces = [], a = pos, last = 0; Object.keys(cuts).map(Number).sort(function (x, y) { return x - y; }).forEach(function (c) { if (c > a && c < a + r.t.length) { pieces.push(r.t.slice(last, c - a)); last = c - a; } }); pieces.push(r.t.slice(last)); var o = a; pieces.forEach(function (pt) { var inside = idxs.some(function (s) { return o >= s && o + pt.length <= s + find.length; }); out.push(Object.assign({}, r, { t: pt }, inside ? { rpr: applyFmt(r.rpr || '', f) } : {})); o += pt.length; }); pos += r.t.length; });
    return mergeRuns(out);
  }

  // ───────── 讀：document.xml → 區塊
  var UNSUP = /<w:(drawing|pict|object|fldChar|fldSimple|instrText|sdt|ins|del|moveFrom|moveTo|footnoteReference|endnoteReference|commentReference|commentRangeStart|txbxContent|AlternateContent|bookmarkStart|sym|ruby|smartTag|customXml)\b/;
  function readRun(s, r, rid, href) {
    var rp = kids(r, 'w:rPr')[0], rpr = rp ? inner(s, rp) : '', t = '';
    r.c.forEach(function (k) { if (k.n === 'w:t') { t += xmlUnesc(inner(s, k)); } else if (k.n === 'w:tab') { t += '\t'; } else if (k.n === 'w:br') { t += attr(k.a, 'w:type') === 'page' ? '' : '\n'; } else if (k.n === 'w:noBreakHyphen') { t += '-'; } });
    var o = { t: t }; if (rpr) { o.rpr = rpr; } if (rid) { o.rid = rid; if (href) { o.href = href; } } return o;
  }
  function parseBlock(s, n, ctx, id) {
    var xml = s.slice(n.s, n.e);
    if (n.n === 'w:tbl') {
      var rows = kids(n, 'w:tr').map(function (tr) { return kids(tr, 'w:tc').map(function (tc) { return kids(tc, 'w:p').map(function (p) { return paraText(s, p); }).join('\n'); }); });
      var simple = !/<w:(vMerge|hMerge|gridSpan|tbl\b)/.test(xml.slice(5)) || true; return { type: 'table', rows: rows.length ? rows : [['']], xml: xml, simple: simple };
    }
    if (n.n !== 'w:p') { return { type: 'raw', text: '', xml: xml }; }
    var ppr = kids(n, 'w:pPr')[0], pin = ppr ? inner(s, ppr) : '', style = ppr ? (function () { var ps = kids(ppr, 'w:pStyle')[0]; return ps ? attr(ps.a, 'w:val') : null; })() : null;
    var npr = ppr ? kids(ppr, 'w:numPr')[0] : null, num = null; if (npr) { var ni = kids(npr, 'w:numId')[0], il = kids(npr, 'w:ilvl')[0]; num = { id: ni ? attr(ni.a, 'w:val') : null, lvl: il ? Number(attr(il.a, 'w:val')) || 0 : 0 }; }
    var inn = inner(s, n), pbr = /<w:br\b[^>]*w:type="page"/.test(inn);
    if (pbr && !/<w:t[ >]/.test(inn)) { return { type: 'pagebreak', xml: xml }; }
    if (UNSUP.test(inn)) { return { type: 'raw', text: paraText(s, n), xml: xml }; }
    var runs = [];
    n.c.forEach(function (k) {
      if (k.n === 'w:r') { runs.push(readRun(s, k)); }
      else if (k.n === 'w:hyperlink') { var rid = attr(k.a, 'r:id'), href = rid && ctx.rels[rid] ? ctx.rels[rid] : null; var anchor = attr(k.a, 'w:anchor'); k.c.forEach(function (r) { if (r.n === 'w:r') { var o = readRun(s, r, rid || ('#' + anchor), href || (anchor ? '#' + anchor : null)); runs.push(o); } }); }
    });
    var pr = pin.replace(/<w:pStyle\b[^>]*\/>/, '').replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, '');
    var out = { runs: mergeRuns(runs), xml: xml }; if (pr) { out.ppr = pr; }
    var hm = style && /^(?:Heading|heading|標題\s*)(\d)$/.exec(style); if (style === 'Title') { hm = [0, '1']; }
    if (hm) { out.type = 'heading'; out.level = int(hm[1], 1, 6, 1); out.pstyle = style; return out; }
    if (num && num.id !== '0') { out.type = 'li'; out.num = num; out.lvl = num.lvl; out.ordered = !!(ctx.numFmt && ctx.numFmt[num.id] === 'decimal'); if (style) { out.pstyle = style; } return out; }
    out.type = 'para'; if (style && style !== 'Normal') { out.pstyle = style; } var jc = ppr ? kids(ppr, 'w:jc')[0] : null; if (jc) { var al = attr(jc.a, 'w:val'); if (al === 'center' || al === 'right' || al === 'both' || al === 'left') { out.align = al; } } return out;
  }
  function paraText(s, p) { var t = ''; (function walk(n) { n.c.forEach(function (k) { if (k.n === 'w:t') { t += xmlUnesc(inner(s, k)); } else if (k.n === 'w:tab') { t += '\t'; } else { walk(k); } }); })(p); return t; }
  function parseRels(x) { var out = {}, re = /<Relationship\b[^>]*>/g, m; while ((m = re.exec(x || ''))) { var id = /Id="([^"]+)"/.exec(m[0]), tg = /Target="([^"]+)"/.exec(m[0]), mode = /TargetMode="External"/.test(m[0]); if (id && tg && mode) { out[id[1]] = xmlUnesc(tg[1]); } } return out; }
  function parseNumFmts(x) {
    var abs = {}, re = /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g, m; while ((m = re.exec(x || ''))) { var lv = /<w:lvl\b[^>]*w:ilvl="0"[\s\S]*?<w:numFmt\b[^>]*w:val="(\w+)"/.exec(m[0]); abs[m[1]] = lv ? lv[1] : 'bullet'; }
    var out = {}, nm = /<w:num\b[^>]*w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId\b[^>]*w:val="(\d+)"/g, n; while ((n = nm.exec(x || ''))) { out[n[1]] = abs[n[2]] || 'bullet'; } return out;
  }
  async function read(bytes, JSZip, name) {
    if (!JSZip) { throw new Error('JSZip 還沒載入'); }
    var zip = await JSZip.loadAsync(bytes), rd = async function (p) { var f = zip.file(p); return f ? f.async('string') : ''; };
    var doc = await rd('word/document.xml'); if (!doc) { throw new Error('這不是 Word 文件（找不到 word/document.xml）'); }
    var b0 = doc.indexOf('<w:body'), b1 = doc.indexOf('>', b0) + 1, b2 = doc.lastIndexOf('</w:body>'); if (b0 < 0 || b2 < 0) { throw new Error('document.xml 沒有 body'); }
    var ctx = { rels: parseRels(await rd('word/_rels/document.xml.rels')), numFmt: parseNumFmts(await rd('word/numbering.xml')) };
    var tree = scan(doc, b1, b2), blocks = [], sect = '', notes = [];
    tree.c.forEach(function (n) {
      if (n.n === 'w:sectPr') { sect = doc.slice(n.s, n.e); return; }
      if (blocks.length >= MAXBLOCKS) { return; } if (n.n === 'w:bookmarkStart' || n.n === 'w:bookmarkEnd' || n.n === 'w:proofErr') { blocks.push({ type: 'raw', text: '', xml: doc.slice(n.s, n.e), hidden: true }); return; }
      blocks.push(parseBlock(doc, n, ctx));
    });
    var raws = blocks.filter(function (b) { return b.type === 'raw' && !b.hidden; }).length; if (raws) { notes.push(raws + ' 個區塊（圖片、欄位、追蹤修訂、文字方塊、目錄等）編輯器不能改，會原樣保留'); }
    if (/<w:(ins|del)\b/.test(doc)) { notes.push('文件有追蹤修訂：有修訂的段落不能改，會原樣保留'); }
    if (/w:vMerge|w:gridSpan/.test(doc)) { notes.push('有合併儲存格的表格只能改儲存格文字'); }
    var names = Object.keys(zip.files); if (names.some(function (n) { return /^word\/(header|footer)\d*\.xml$/.test(n); })) { notes.push('頁首頁尾原樣保留（這個編輯器不改）'); }
    var title = name || ((await rd('docProps/core.xml')).match(/<dc:title>([^<]*)<\/dc:title>/) || [0, ''])[1] || '未命名文件';
    var spec = { v: 1, title: str(xmlUnesc(title), 80), format: 'docx', head: doc.slice(0, b1), tail: doc.slice(b2), sect: sect, notes: notes, seq: 0, canvas: { x: 0, y: 0, w: 800, h: 600, bg: '#ffffff' }, objects: blocks.filter(function (b) { return !b.hidden || true; }) };
    spec = validate(spec).spec; spec.sig = sigOf(spec); return spec;
  }
  function sigOf(spec) { var s = JSON.stringify(spec.objects.map(function (b) { return [b.id, b.type, b.xml ? 1 : 0, b.runs, b.rows, b.level, b.ordered, b.text]; })); var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16) + ':' + s.length; }

  // ───────── 寫：區塊 → XML
  var HEADHEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>';
  var HEADTAIL = '</w:body></w:document>', DEFSECT = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
  function runXml(r) {
    var rp = r.rpr ? '<w:rPr>' + r.rpr + '</w:rPr>' : '', parts = String(r.t).split(/(\n|\t)/), x = '';
    parts.forEach(function (p) { if (p === '\n') { x += '<w:br/>'; } else if (p === '\t') { x += '<w:tab/>'; } else if (p !== '') { x += '<w:t xml:space="preserve">' + xmlEsc(p) + '</w:t>'; } });
    return '<w:r>' + rp + x + '</w:r>';
  }
  function runsXml(runs) { var out = '', i = 0; while (i < runs.length) { var r = runs[i]; if (r.rid && !/^#/.test(r.rid)) { var g = []; while (i < runs.length && runs[i].rid === r.rid) { g.push(runXml(runs[i])); i++; } out += '<w:hyperlink r:id="' + xmlEsc(r.rid) + '" w:history="1">' + g.join('') + '</w:hyperlink>'; } else if (r.rid) { var g2 = []; while (i < runs.length && runs[i].rid === r.rid) { g2.push(runXml(runs[i])); i++; } out += '<w:hyperlink w:anchor="' + xmlEsc(r.rid.slice(1)) + '" w:history="1">' + g2.join('') + '</w:hyperlink>'; } else { out += runXml(r); i++; } } return out; }
  var PPR_AFTER_NUM = ['suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
  function pprXml(b, nums) {
    var style = b.type === 'heading' ? 'Heading' + b.level : (b.type === 'li' ? (b.pstyle && !/^Heading/.test(b.pstyle) ? b.pstyle : 'ListParagraph') : (b.pstyle && !/^(Heading\d|Title)$/.test(b.pstyle) ? b.pstyle : null)), rest = b.ppr || '';
    rest = rest.replace(/<w:jc\b[^>]*\/>/, ''); var jc = b.type === 'para' || b.type === 'heading' ? (b.align ? '<w:jc w:val="' + b.align + '"/>' : '') : '';
    var numXml = ''; if (b.type === 'li') { var id = (b.num && b.num.id && !b.numChanged) ? b.num.id : (nums ? nums(!!b.ordered) : '1'); numXml = '<w:numPr><w:ilvl w:val="' + (b.lvl || 0) + '"/><w:numId w:val="' + id + '"/></w:numPr>'; }
    var pre = '', post = rest; if (numXml) { var cut = -1; PPR_AFTER_NUM.forEach(function (t) { var i = rest.indexOf('<w:' + t); if (i >= 0 && (cut < 0 || i < cut)) { cut = i; } }); if (cut < 0) { pre = rest; post = ''; } else { pre = rest.slice(0, cut); post = rest.slice(cut); } }
    var inn = (style ? '<w:pStyle w:val="' + style + '"/>' : '') + pre + numXml + post + jc; return inn ? '<w:pPr>' + inn + '</w:pPr>' : '';
  }
  function tableXml(b) {
    var rows = b.rows, w = Math.max.apply(null, rows.map(function (r) { return r.length; })), cw = Math.floor(9000 / Math.max(1, w));
    return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (e) { return '<w:' + e + ' w:val="single" w:sz="4" w:space="0" w:color="808080"/>'; }).join('') + '</w:tblBorders></w:tblPr><w:tblGrid>' + rows[0].map(function () { return '<w:gridCol w:w="' + cw + '"/>'; }).join('') + '</w:tblGrid>'
      + rows.map(function (r) { return '<w:tr>' + r.map(function (c) { return '<w:tc><w:tcPr><w:tcW w:w="' + cw + '" w:type="dxa"/></w:tcPr>' + String(c).split('\n').map(function (l) { return '<w:p>' + (l === '' ? '' : runXml({ t: l })) + '</w:p>'; }).join('') + '</w:tc>'; }).join('') + '</w:tr>'; }).join('') + '</w:tbl>';
  }
  // 改過的表格：把儲存格的文字寫回原本的 XML（框線、欄寬、儲存格格式不動）；列數欄數變了就重新產生
  function patchTable(b) {
    var xml = b.xml0; if (!xml) { return tableXml(b); } var t = scan(xml, 0, xml.length).c[0]; if (!t || t.n !== 'w:tbl') { return tableXml(b); } var trs = kids(t, 'w:tr');
    if (trs.length !== b.rows.length || trs.some(function (tr, i) { return kids(tr, 'w:tc').length !== b.rows[i].length; })) { return tableXml(b); }
    var edits = []; trs.forEach(function (tr, i) { kids(tr, 'w:tc').forEach(function (tc, j) { var ps = kids(tc, 'w:p'), old = ps.map(function (p) { return paraText(xml, p); }).join('\n'); if (old === b.rows[i][j]) { return; } if (ps.some(function (p) { return UNSUP.test(inner(xml, p)); })) { return; }
      var p0 = ps[0], ppr = p0 ? kids(p0, 'w:pPr')[0] : null, r0 = p0 ? kids(p0, 'w:r')[0] : null, rp = r0 ? kids(r0, 'w:rPr')[0] : null, lines = b.rows[i][j].split('\n');
      var pxml = lines.map(function (l) { return '<w:p>' + (ppr ? xml.slice(ppr.s, ppr.e) : '') + (l === '' ? '' : runXml({ t: l, rpr: rp ? inner(xml, rp) : '' })) + '</w:p>'; }).join(''); var first = ps[0], last = ps[ps.length - 1]; if (first) { edits.push([first.s, last.e, pxml]); } else { edits.push([tc.ie, tc.ie, pxml]); } }); });
    edits.sort(function (a, c) { return c[0] - a[0]; }); edits.forEach(function (e) { xml = xml.slice(0, e[0]) + e[2] + xml.slice(e[1]); }); return xml;
  }
  function blockXml(b, nums) {
    if (b.xml) { return b.xml; }
    switch (b.type) {
      case 'heading': case 'para': case 'li': return '<w:p>' + pprXml(b, nums) + runsXml(b.runs || []) + '</w:p>';
      case 'pagebreak': return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      case 'table': return patchTable(b);
      default: return b.xml0 || '';
    }
  }
  var HSTYLES = [[1, 32, true], [2, 26, true], [3, 24, true], [4, 22, true], [5, 22, false], [6, 22, false]];
  function styleDefs(has) {
    var x = ''; HSTYLES.forEach(function (h) { var id = 'Heading' + h[0]; if (!has[id]) { x += '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="heading ' + h[0] + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="' + (h[0] - 1) + '"/></w:pPr><w:rPr><w:b/><w:sz w:val="' + h[1] * 1 + '"/><w:szCs w:val="' + h[1] + '"/></w:rPr></w:style>'; } });
    if (!has.ListParagraph) { x += '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'; }
    return x;
  }
  var NEWSTYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft JhengHei" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-TW"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>';
  function numberingNew(bulletId, decId) {
    function lvl(i, fmt, txt) { return '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="' + fmt + '"/><w:lvlText w:val="' + txt + '"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="' + (720 * (i + 1)) + '" w:hanging="360"/></w:pPr>' + (fmt === 'bullet' ? '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>' : '') + '</w:lvl>'; }
    var bl = '', dl = ''; for (var i = 0; i < 9; i++) { bl += lvl(i, 'bullet', ''); dl += lvl(i, 'decimal', '%' + (i + 1) + '.'); }
    return { abs: '<w:abstractNum w:abstractNumId="' + bulletId + '"><w:multiLevelType w:val="hybridMultilevel"/>' + bl + '</w:abstractNum><w:abstractNum w:abstractNumId="' + decId + '"><w:multiLevelType w:val="hybridMultilevel"/>' + dl + '</w:abstractNum>', nums: '<w:num w:numId="' + bulletId + '"><w:abstractNumId w:val="' + bulletId + '"/></w:num><w:num w:numId="' + decId + '"><w:abstractNumId w:val="' + decId + '"/></w:num>' };
  }
  async function build(spec, JSZip, origBytes) {
    if (!JSZip) { throw new Error('JSZip 還沒載入'); } var s = validate(spec).spec, zip = origBytes ? await JSZip.loadAsync(origBytes) : new JSZip(), rd = async function (p) { var f = zip.file(p); return f ? f.async('string') : ''; };
    var needHead = s.objects.some(function (b) { return b.type === 'heading' && !b.xml; }), needList = s.objects.some(function (b) { return b.type === 'li' && !b.xml; });
    if (!origBytes) {
      var X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
      zip.file('[Content_Types].xml', X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
      zip.file('_rels/.rels', X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
      zip.file('word/_rels/document.xml.rels', X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>');
      zip.file('word/styles.xml', NEWSTYLES + styleDefs({}) + '</w:styles>'); var nn = numberingNew(1, 2); zip.file('word/numbering.xml', X + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + nn.abs + nn.nums + '</w:numbering>');
    } else {
      if (needHead || needList) { var st = await rd('word/styles.xml'); if (st) { var has = {}; (st.match(/w:styleId="[^"]+"/g) || []).forEach(function (m) { has[m.slice(11, -1)] = 1; }); var add = styleDefs(has); if (add) { zip.file('word/styles.xml', st.replace('</w:styles>', add + '</w:styles>')); } } }
    }
    // 清單：找原本有的項目符號／編號定義，沒有就補一組
    var numCache = {}, numXml = await rd('word/numbering.xml'), fmts = parseNumFmts(numXml);
    function pick(ordered) { var want = ordered ? 'decimal' : 'bullet'; for (var k in fmts) { if (fmts[k] === want || (!ordered && fmts[k] !== 'decimal' && fmts[k] !== 'lowerLetter' && fmts[k] !== 'upperLetter' && fmts[k] !== 'lowerRoman' && fmts[k] !== 'upperRoman')) { return k; } } return null; }
    var created = null;
    function nums(ordered) {
      var k = ordered ? 'd' : 'b'; if (numCache[k]) { return numCache[k]; } var id = pick(ordered); if (id) { numCache[k] = id; return id; }
      if (!created) { var maxA = 0, maxN = 0; (numXml.match(/w:abstractNumId="(\d+)"/g) || []).forEach(function (m) { maxA = Math.max(maxA, Number(m.replace(/\D/g, ''))); }); (numXml.match(/w:numId="(\d+)"/g) || []).forEach(function (m) { maxN = Math.max(maxN, Number(m.replace(/\D/g, ''))); }); var a1 = maxA + 1, a2 = maxA + 2, n1 = maxN + 1, n2 = maxN + 2; var nn2 = numberingNew(a1, a2); nn2.nums = '<w:num w:numId="' + n1 + '"><w:abstractNumId w:val="' + a1 + '"/></w:num><w:num w:numId="' + n2 + '"><w:abstractNumId w:val="' + a2 + '"/></w:num>'; created = { n1: n1, n2: n2, xml: nn2 }; }
      numCache[k] = String(ordered ? created.n2 : created.n1); return numCache[k];
    }
    var body = s.objects.map(function (b) { return blockXml(b, nums); }).join('');
    if (s.objects.length && s.objects[s.objects.length - 1].type === 'table') { body += '<w:p/>'; }   // body 的最後不能是表格（Word 要求表格後面有一個段落）
    if (created && origBytes) {
      if (numXml) { zip.file('word/numbering.xml', numXml.replace(/<w:num\b/, created.xml.abs + '<w:num').replace('</w:numbering>', created.xml.nums + '</w:numbering>')); }
      else {
        var X2 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'; zip.file('word/numbering.xml', X2 + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + created.xml.abs + created.xml.nums + '</w:numbering>');
        var ct = await rd('[Content_Types].xml'); if (ct && ct.indexOf('/word/numbering.xml') < 0) { zip.file('[Content_Types].xml', ct.replace('</Types>', '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>')); }
        var rl = await rd('word/_rels/document.xml.rels'); if (rl) { var rid = 'rIdNum' + Date.now() % 100000; zip.file('word/_rels/document.xml.rels', rl.replace('</Relationships>', '<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>')); }
      }
    }
    zip.file('word/document.xml', (s.head || HEADHEAD) + body + (s.sect || DEFSECT) + (s.tail || HEADTAIL));
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  // ───────── 區塊型別
  function nameOf(b) {
    var L = { heading: '標題', para: '段落', li: '清單', table: '表格', pagebreak: '分頁', raw: '原樣' }[b.type] || b.type, t = b.type === 'table' ? (b.rows && b.rows[0] && b.rows[0].join(' ')) : (b.type === 'raw' ? b.text : plain(b)); var s = snippet(t, 16);
    return (b.type === 'heading' ? 'H' + b.level + ' ' : L + ' ') + (s || (b.type === 'raw' ? '（圖片或欄位）' : b.type === 'pagebreak' ? '' : '（空）'));
  }
  function keepXml(o) { var t = {}; if (o.xml) { t.xml = str(o.xml, MAXXML); } if (o.xml0) { t.xml0 = str(o.xml0, MAXXML); } return t; }
  function tail(o) { var t = keepXml(o); if (o.ppr) { t.ppr = str(o.ppr, 4000); } if (o.pstyle) { t.pstyle = str(o.pstyle, 60); } if (o.align === 'left' || o.align === 'center' || o.align === 'right' || o.align === 'both') { t.align = o.align; } return t; }
  function mk(label, defaults, fn) { return { label: label, defaults: defaults, validate: function (o) { var r = fn(o); return { obj: Object.assign(r, tail(o)), problems: [] }; }, bbox: function () { return { x: 0, y: 0, w: 1, h: 1 }; } }; }
  var types = {
    heading: mk('標題', { runs: [], level: 1 }, function (o) { return { runs: cleanRuns(o.runs), level: int(o.level, 1, 6, 1) }; }),
    para: mk('段落', { runs: [] }, function (o) { return { runs: cleanRuns(o.runs) }; }),
    li: mk('清單', { runs: [], ordered: false, lvl: 0 }, function (o) { var r = { runs: cleanRuns(o.runs), ordered: !!o.ordered, lvl: int(o.lvl, 0, 8, 0) }; if (o.num && typeof o.num === 'object') { r.num = { id: str(o.num.id, 12), lvl: int(o.num.lvl, 0, 8, 0) }; } if (o.numChanged) { r.numChanged = true; } return r; }),
    table: mk('表格', { rows: [['', ''], ['', '']] }, function (o) { var rows = Array.isArray(o.rows) ? o.rows.slice(0, 500).map(function (r) { return (Array.isArray(r) ? r : []).slice(0, 60).map(function (c) { return str(c, 20000); }); }) : []; rows = rows.length ? rows : [['']]; var w = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1); rows = rows.map(function (r) { while (r.length < w) { r.push(''); } return r; }); return { rows: rows }; }),
    pagebreak: mk('分頁', {}, function () { return {}; }),
    raw: mk('原樣保留', { text: '' }, function (o) { return { text: str(o.text, 2000) }; }),
  };
  var extraOps = {};
  function blk(s, e, H) { var i = H.find(s, e.id); if (i < 0) { return { error: 'there is no block "' + str(e.id, 30) + '"' }; } var o = s.objects[i]; if (o.locked) { return { error: '"' + o.name + '" is locked' }; } return { i: i, o: o }; }
  function textual(o) { return o.type === 'heading' || o.type === 'para' || o.type === 'li'; }
  function A(words, apply) { return { words: words, apply: apply }; }
  extraOps.set_text = A(function (e) { return '改文字 ' + e.id; }, function (s, e, H) { var b = blk(s, e, H); if (b.error) { return b; } if (!textual(b.o)) { return { error: 'only headings, paragraphs and list items have text' }; } b.o.runs = retext(b.o.runs || [], String(e.text == null ? '' : e.text).replace(/\r\n?/g, '\n')); return {}; });
  extraOps.set_heading = A(function (e) { return '標題層級 ' + e.id + ' → H' + e.level; }, function (s, e, H) { var b = blk(s, e, H); if (b.error) { return b; } if (!textual(b.o)) { return { error: 'not a text block' }; } var lv = int(e.level, 0, 6, 1); if (lv === 0) { b.o.type = 'para'; delete b.o.level; } else { var keepNum = b.o.type === 'li'; b.o.type = 'heading'; b.o.level = lv; if (keepNum) { delete b.o.ordered; delete b.o.lvl; delete b.o.num; } } delete b.o.pstyle; return {}; });
  extraOps.list_toggle = A(function (e) { return '清單 ' + e.id + (e.ordered ? '（編號）' : e.off ? '（取消）' : '（項目符號）'); }, function (s, e, H) { var b = blk(s, e, H); if (b.error) { return b; } if (!textual(b.o)) { return { error: 'not a text block' }; } if (e.off || e.ordered === 'none') { b.o.type = 'para'; delete b.o.ordered; delete b.o.lvl; delete b.o.num; delete b.o.pstyle; return {}; } var was = b.o.type === 'li' ? !!b.o.ordered : null; b.o.type = 'li'; b.o.ordered = !!e.ordered; b.o.lvl = b.o.lvl || 0; if (was !== null && was !== b.o.ordered) { b.o.numChanged = true; } if (was === null) { b.o.numChanged = true; delete b.o.num; } delete b.o.level; return {}; });
  extraOps.set_style = A(function (e) { return '格式 ' + e.id + (e.find ? '「' + snippet(e.find, 8) + '」' : '') + (e.bold != null ? (e.bold ? ' 粗體' : ' 取消粗體') : '') + (e.italic != null ? (e.italic ? ' 斜體' : '') : '') + (e.underline ? ' 底線' : '') + (e.color ? ' ' + e.color : ''); }, function (s, e, H) {
    var b = blk(s, e, H); if (b.error) { return b; } if (!textual(b.o)) { return { error: 'only text blocks have a style' }; } var f = {}; ['bold', 'italic', 'underline', 'strike'].forEach(function (k) { if (e[k] != null) { f[k] = !!e[k]; } }); if (e.color !== undefined) { f.color = e.color; }
    if (e.align) { if (['left', 'center', 'right', 'both'].indexOf(e.align) < 0) { return { error: 'align must be left, center, right or both' }; } b.o.align = e.align; }
    if (!Object.keys(f).length && !e.align) { return { error: 'nothing to change' } } if (Object.keys(f).length) { var r = formatRange(b.o.runs || [], e.find ? String(e.find) : '', f, !!e.all); if (!r) { return { error: 'the text "' + snippet(e.find, 20) + '" is not in that block' }; } b.o.runs = r; } return {};
  });
  extraOps.convert_block = A(function (e) { return '轉成' + ({ para: '段落', heading: '標題', list: '清單', olist: '編號清單' }[e.to] || e.to) + ' ' + e.id; }, function (s, e, H) { var b = blk(s, e, H); if (b.error) { return b; } if (!textual(b.o)) { return { error: 'only text blocks can be converted' }; } var to = String(e.to || ''); if (to === 'para') { return extraOps.list_toggle.apply(s, { id: e.id, off: true }, H) || (b.o.type = 'para', {}); } if (to === 'heading') { return extraOps.set_heading.apply(s, { id: e.id, level: e.level || 1 }, H); } if (to === 'list' || to === 'olist') { return extraOps.list_toggle.apply(s, { id: e.id, ordered: to === 'olist' }, H); } return { error: 'unknown target ' + to }; });
  extraOps.set_cell = A(function (e) { return '表格 ' + e.id + ' 第 ' + (Number(e.row) + 1) + ' 列第 ' + (Number(e.col) + 1) + ' 欄'; }, function (s, e, H) { var b = blk(s, e, H); if (b.error) { return b; } if (b.o.type !== 'table') { return { error: 'not a table' }; } var r = int(e.row, 0, 499, -1), c = int(e.col, 0, 59, -1); if (r < 0 || c < 0 || r >= b.o.rows.length || c >= b.o.rows[0].length) { return { error: 'no such cell' }; } if (!b.o.xml0 && b.o.xml) { b.o.xml0 = b.o.xml; } b.o.rows[r][c] = str(e.text, 20000); return {}; });
  extraOps.table_rows = A(function (e) { return '表格 ' + e.id + (e.add != null ? ' 加一列' : ' 刪一列'); }, function (s, e, H) { var b = blk(s, e, H); if (b.error) { return b; } if (b.o.type !== 'table') { return { error: 'not a table' }; } if (e.add != null) { var at = e.add === 'end' ? b.o.rows.length : int(e.add, 0, b.o.rows.length, b.o.rows.length); b.o.rows.splice(at, 0, b.o.rows[0].map(function () { return ''; })); } else { var d = int(e.del, 0, b.o.rows.length - 1, -1); if (d < 0 || b.o.rows.length <= 1) { return { error: 'cannot delete that row' }; } b.o.rows.splice(d, 1); } delete b.o.xml0; delete b.o.xml; return {}; });
  extraOps.replace_all = A(function (e) { return '全部取代「' + snippet(e.find, 12) + '」→「' + snippet(e.repl, 12) + '」'; }, function (s, e, H) {
    var find = String(e.find == null ? '' : e.find), repl = String(e.repl == null ? '' : e.repl); if (!find) { return { error: 'find must not be empty' }; } var re; try { re = e.regex ? new RegExp(find, e.caseSensitive ? 'g' : 'gi') : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), e.caseSensitive ? 'g' : 'gi'); } catch (x) { return { error: 'bad pattern: ' + x.message }; }
    var n = 0, scope = e.scope && e.scope !== 'all' ? String(e.scope) : null; s.objects.forEach(function (b) {
      if (b.locked || (scope && b.id !== scope)) { return; }
      if (textual(b)) { var old = plain(b), nt = old.replace(re, function () { n++; return repl; }); if (nt !== old) { b.runs = retext(b.runs, nt); } }
      if (b.type === 'table') { var ch = false; b.rows = b.rows.map(function (r) { return r.map(function (c) { var nc = c.replace(re, function () { n++; return repl; }); if (nc !== c) { ch = true; } return nc; }); }); if (ch && !b.xml0 && b.xml) { b.xml0 = b.xml; } }
    }); return n ? {} : { error: 'nothing found' };
  });
  extraOps.move_block = A(function (e) { return '移動 ' + e.id + ' → ' + e.to; }, function (s, e, H) { var b = blk(s, e, H); if (b.error) { return b; } var to = String(e.to || ''), arr = s.objects, i = b.i, o = arr.splice(i, 1)[0], at = to === 'first' ? 0 : to === 'last' ? arr.length : to === 'earlier' ? Math.max(0, i - 1) : to === 'later' ? Math.min(arr.length, i + 1) : -1; if (at < 0) { arr.splice(i, 0, o); return { error: 'to must be first, last, earlier or later' }; } arr.splice(at, 0, o); return {}; });
  var E = O.make({
    types: types, extraOps: extraOps, keep: ['format', 'head', 'tail', 'sect', 'sig', 'notes'], limits: { objects: MAXBLOCKS, canvas: 16384 },
    defaultSpec: function () { return { v: 1, title: '未命名文件', format: 'docx', head: '', tail: '', sect: '', notes: [], canvas: { x: 0, y: 0, w: 800, h: 600, bg: '#ffffff' }, seq: 0, objects: [] }; },
    describeObject: function (o) { return o.type + ' ' + snippet(plain(o) || o.text, 20); },
  });
  function validate(spec) {
    var src = spec && typeof spec === 'object' ? spec : {}, r = E.validate(src), s = r.spec; s.format = 'docx'; s.head = str(src.head, 20000); s.tail = str(src.tail, 20000); s.sect = str(src.sect, 20000); s.notes = Array.isArray(src.notes) ? src.notes.slice(0, 30).map(function (x) { return str(x, 300); }) : []; if (typeof src.sig === 'string') { s.sig = str(src.sig, 40); }
    s.objects.forEach(function (b) { b.name = nameOf(b); }); return r;
  }
  function applyEdits(spec, edits, env) {
    var mapped = (edits || []).map(function (e) {
      if (e && e.op === 'add_block') { var at = e.at; if (e.after === 'start') { at = 'bottom'; } else if (e.after && e.after !== 'end') { at = { above: e.after }; } var blk0 = Object.assign({}, e.block || {}); if (typeof blk0.text === 'string' && !blk0.runs) { blk0.runs = blk0.text ? [{ t: blk0.text }] : []; delete blk0.text; } if (blk0.type === 'list') { blk0.type = 'li'; } if (blk0.type === 'li' && blk0.items) { return null; } if (blk0.type === 'table' && Array.isArray(blk0.rows)) { blk0.rows = blk0.rows.map(function (r) { return r.map(function (c) { return String(c); }); }); } return { op: 'add_object', object: blk0, at: at === 'bottom' ? 'bottom' : (at && at.above ? at : 'top') }; }
      if (e && e.op === 'remove_block') { return { op: 'remove_object', id: e.id }; } if (e && e.op === 'update_block') { return { op: 'update_object', id: e.id, props: e.props }; } return e;
    });
    // add_block 的 after 語意：在指定區塊之後（原核心的 at 是「上面」，反過來）：用 duplicate 的方式太繞，這裡直接先套再整理順序
    var wantAfter = []; (edits || []).forEach(function (e, i) { if (e && e.op === 'add_block' && e.after && e.after !== 'end' && e.after !== 'start') { wantAfter.push({ i: i, after: e.after }); } });
    var before = clone(spec), r = E.applyEdits(clone(spec), mapped.filter(Boolean).map(function (e) { return e.op === 'add_object' && e.at && e.at.above ? Object.assign({}, e, { at: 'top' }) : e; }), env);
    // 新增的區塊：預設放最後(top)；有 after 的搬到那個區塊後面
    var addedIds = r.added || []; wantAfter.forEach(function (w, k) { var id = addedIds[k]; if (!id) { return; } var arr = r.spec.objects, ai = arr.findIndex(function (b) { return b.id === id; }), ti = arr.findIndex(function (b) { return b.id === w.after || b.name === w.after; }); if (ai >= 0 && ti >= 0) { var o = arr.splice(ai, 1)[0]; ti = arr.findIndex(function (b) { return b.id === w.after || b.name === w.after; }); arr.splice(ti + 1, 0, o); } });
    // 內容有變的區塊清掉原始 XML；其餘照原樣輸出
    var old = {}; before.objects.forEach(function (b) { old[b.id] = b; });
    r.spec.objects.forEach(function (b) { var o = old[b.id]; if (!o) { delete b.xml; return; } if (b.xml) { var a = clone(b), c = clone(o); delete a.xml; delete c.xml; delete a.name; delete c.name; delete a.xml0; delete c.xml0; delete a.visible; delete c.visible; delete a.locked; delete c.locked; if (JSON.stringify(a) !== JSON.stringify(c)) { if (b.type === 'table' && !b.xml0) { b.xml0 = o.xml || o.xml0; } delete b.xml; } } });
    r.spec.objects.forEach(function (b) { b.name = nameOf(b); }); return r;
  }
  // ───── 預覽 HTML（文字先跳脫）
  function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function runsHtml(runs) {
    return (runs || []).map(function (r) {
      var h = esc(r.t).replace(/\n/g, '<br>').replace(/\t/g, '&emsp;'), rp = r.rpr || ''; if (rprHas(rp, 'b')) { h = '<strong>' + h + '</strong>'; } if (rprHas(rp, 'i')) { h = '<em>' + h + '</em>'; } if (rprHas(rp, 'u')) { h = '<u>' + h + '</u>'; } if (rprHas(rp, 'strike')) { h = '<s>' + h + '</s>'; } var c = rprColor(rp); if (c) { h = '<span style="color:' + c + '">' + h + '</span>'; }
      if (r.rid && r.href && /^(https?:|mailto:)/i.test(r.href)) { h = '<a href="' + esc(r.href) + '" target="_blank" rel="noopener noreferrer">' + h + '</a>'; } return h;
    }).join('');
  }
  function blockHtml(b) {
    switch (b.type) {
      case 'heading': return '<h' + b.level + '>' + (runsHtml(b.runs) || '&nbsp;') + '</h' + b.level + '>';
      case 'para': return '<p' + (b.align ? ' style="text-align:' + (b.align === 'both' ? 'justify' : b.align) + '"' : '') + '>' + (runsHtml(b.runs) || '&nbsp;') + '</p>';
      case 'li': return '<' + (b.ordered ? 'ol' : 'ul') + ' style="margin:0 0 0 ' + (1.4 + (b.lvl || 0) * 1.4) + 'em"><li>' + (runsHtml(b.runs) || '&nbsp;') + '</li></' + (b.ordered ? 'ol' : 'ul') + '>';
      case 'table': return '<table>' + b.rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c).replace(/\n/g, '<br>') + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>';
      case 'pagebreak': return '<div class="pb">— 分頁 —</div>';
      default: return '<div class="raw">🧱 ' + esc(b.text ? snippet(b.text, 60) : '（圖片、欄位或其他編輯器不能改的內容，原樣保留）') + '</div>';
    }
  }
  function toHtml(spec) { var s = validate(spec).spec; return '<!doctype html>\n<html><head><meta charset="utf-8"><title>' + esc(s.title) + '</title><style>body{font:16px/1.7 system-ui,"Microsoft JhengHei",sans-serif;max-width:48em;margin:2em auto;padding:0 1em}table{border-collapse:collapse}td{border:1px solid #888;padding:.3em .6em}.pb{border-top:1px dashed #888;color:#888;text-align:center;margin:1em 0}</style></head><body>\n' + s.objects.filter(function (b) { return b.visible !== false; }).map(blockHtml).join('\n') + '\n</body></html>\n'; }
  // ───── 程式讀得懂的白話
  var ZH = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
  function parseCommands(text, spec) {
    var out = { edits: [], matched: [], unmatched: [] }, s = validate(spec).spec, bl = s.objects, all = bl.map(function (b) { return plain(b) + ' ' + (b.rows || []).join(' ') + ' ' + (b.text || ''); }).join('\n').toLowerCase();
    function ref(r) { r = String(r || '').trim().replace(/^[「"'『]|[」"'』]$/g, ''); var m = /^(?:第\s*)?(\d+)\s*(?:個|段|節|行|項|區塊|號)?$/.exec(r); if (m) { var k = Number(m[1]) - 1; return k >= 0 && k < bl.length ? bl[k].id : null; } if (/^(最後|最後一段|最後一個)$/.test(r)) { return bl.length ? bl[bl.length - 1].id : null; } if (/^(第一|第一段|第一個|開頭)$/.test(r)) { return bl.length ? bl[0].id : null; } var low = r.toLowerCase(), hit = bl.filter(function (b) { return low && plain(b).toLowerCase().indexOf(low) >= 0; }); return hit.length === 1 ? hit[0].id : null; }
    var clauses = String(text || '').split(/[。；;\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    clauses.forEach(function (c) {
      var m, e = null, id;
      if ((m = /^(?:把|將)?\s*(?:所有的?|全部的?)?[「"'『](.+?)[」"'』]\s*(?:全部)?(?:都)?(?:改成|換成|改為|取代成|取代為)\s*[「"'『]?(.*?)[」"'』]?$/.exec(c)) && all.indexOf(m[1].toLowerCase()) >= 0) { e = { op: 'replace_all', find: m[1], repl: m[2] }; }
      else if ((m = /^(?:把|將)?\s*(.+?)\s*(?:刪掉|刪除|移除|拿掉)$/.exec(c)) || (m = /^(?:刪掉|刪除|移除|拿掉)\s*(.+)$/.exec(c))) { id = ref(m[1]); if (id) { e = { op: 'remove_block', id: id }; } }
      else if ((m = /^(?:把|將)?\s*(.+?)\s*(?:改成|換成|變成|設成|設為)\s*(粗體|斜體|底線|刪除線|不要粗體|取消粗體|取消斜體|取消底線|置中|靠左|靠右|(紅|藍|綠|黃|橘|黑|灰|紫)色?)$/.exec(c))) { var tgt = m[1], what = m[2], find = null, mm; if ((mm = /^[「"'『](.+?)[」"'』]$/.exec(tgt)) && all.indexOf(mm[1].toLowerCase()) >= 0) { find = mm[1]; id = null; var hit = bl.filter(function (b) { return plain(b).indexOf(find) >= 0; }); id = hit.length ? hit[0].id : null; } else { id = ref(tgt); }
        if (id) { var st = { op: 'set_style', id: id }; if (find) { st.find = find; st.all = true; } if (what === '粗體') { st.bold = true; } else if (what === '斜體') { st.italic = true; } else if (what === '底線') { st.underline = true; } else if (what === '刪除線') { st.strike = true; } else if (/^(不要粗體|取消粗體)$/.test(what)) { st.bold = false; } else if (what === '取消斜體') { st.italic = false; } else if (what === '取消底線') { st.underline = false; } else if (what === '置中') { st.align = 'center'; } else if (what === '靠左') { st.align = 'left'; } else if (what === '靠右') { st.align = 'right'; } else { st.color = m[3] + '色'; } e = st; } }
      else if ((m = /^(?:把|將)?\s*(.+?)\s*(?:改成|換成|改為)\s*(?:第?\s*([1-6一二三四五六])\s*(?:級|層)標題|H([1-6])|標題\s*([1-6]))$/i.exec(c))) { id = ref(m[1]); var lv = m[2] || m[3] || m[4]; lv = ZH[lv] || Number(lv); if (id && lv) { e = { op: 'set_heading', id: id, level: lv }; } }
      else if ((m = /^(?:把|將)?\s*(.+?)\s*(?:改成|換成|變成|轉成)\s*(編號清單|項目清單|項目符號清單|清單|一般段落|段落)$/.exec(c))) { id = ref(m[1]); var to = { '編號清單': 'olist', '項目清單': 'list', '項目符號清單': 'list', '清單': 'list', '一般段落': 'para', '段落': 'para' }[m[2]]; if (id && to) { e = { op: 'convert_block', id: id, to: to }; } }
      else if ((m = /^(?:把|將)?\s*(.+?)\s*(?:改成|換成|改為)\s*[：:]?\s*(.+)$/.exec(c)) && !/^[「"'『]/.test(m[1]) && (id = ref(m[1]))) { var bo = bl.filter(function (b) { return b.id === id; })[0]; if (bo && textual(bo)) { e = { op: 'set_text', id: id, text: m[2].replace(/^[「"'『]|[」"'』]$/g, '') }; } }
      else if ((m = /^(?:在)?\s*(最後|結尾|文末|最前面|開頭|文首|(?:第\s*\d+\s*(?:段|個|節)))(?:的)?(?:後面|之後|下面)?\s*(?:加|新增|加入|插入|補)\s*(?:上)?\s*(?:一個|一段)?\s*(?:(?:([1-6一二三四五六])\s*(?:級|層)標題|標題\s*([1-6])?|分頁|(編號清單|項目清單|清單|段落))\s*)?[：:]?\s*(.*)$/.exec(c))) {
        var where = m[1], after = /最後|結尾|文末/.test(where) ? 'end' : /最前面|開頭|文首/.test(where) ? 'start' : ref(where); if (after) { var isPB = /分頁/.test(c) && !m[4]; var isH = /標題/.test(c.replace(m[4] || '', '')); var hl = ZH[m[2]] || Number(m[2]) || Number(m[3]) || 2, kind = m[4] ? '' : '', body = m[5]; var kd = /編號清單/.test(c) ? 'olist' : /清單/.test(c) ? 'list' : '';
          if (isPB) { e = { op: 'add_block', after: after, block: { type: 'pagebreak' } }; } else if (body) { e = { op: 'add_block', after: after, block: isH ? { type: 'heading', level: hl, text: body } : kd ? { type: 'li', ordered: kd === 'olist', text: body } : { type: 'para', text: body } }; } }
      }
      if (e) { out.edits.push(e); out.matched.push(c); } else { out.unmatched.push(c); }
    });
    return out;
  }
  var AI_OPS = ['set_text', 'set_heading', 'list_toggle', 'set_style', 'set_cell', 'table_rows', 'replace_all', 'convert_block', 'add_block', 'remove_block', 'move_block', 'set_title'];
  function editPrompt(spec, request, selection, o) {
    o = o || {}; var s = validate(spec).spec, budget = o.budget || 9000, total = s.objects.reduce(function (n, b) { return n + (plain(b) || (b.rows || []).join('')).length; }, 0), full = total <= budget;
    var lines = s.objects.map(function (b, i) { var body = b.type === 'table' ? b.rows.map(function (r) { return r.join(' | '); }).join('\n') : (b.type === 'raw' ? '(image or object, cannot be changed)' : b.type === 'pagebreak' ? '(page break)' : plain(b)); if (!(full || b.id === selection)) { body = body.length > 160 ? body.slice(0, 160) + '…' : body; } return '[' + b.id + '] ' + b.type + (b.type === 'heading' ? ' H' + b.level : b.type === 'li' ? (b.ordered ? ' (numbered)' : ' (bullet)') : '') + (rprHasAny(b) ? ' (formatted)' : '') + ': ' + body; });
    var system = 'You edit a Word document by answering ONLY with JSON {"say":"one short sentence","edits":[...]}. Every edit is one of these actions (ids come from the list; never invent ids):\n'
      + '{op:"set_text",id,text} replace the text of a heading/paragraph/list item (existing formatting at the start and end is kept)\n{op:"set_heading",id,level:0-6} make a block a heading (0 = back to a normal paragraph)\n{op:"list_toggle",id,ordered:true|false|off:true} bullet list, numbered list, or back to a paragraph\n'
      + '{op:"set_style",id,find?,all?,bold?,italic?,underline?,strike?,color?:"red|blue|green|black|#RRGGBB",align?:"left|center|right|both"} text formatting of the whole block, or only of the text find\n{op:"set_cell",id,row,col,text} a table cell (0-based)  {op:"table_rows",id,add:"end"|<index>} or {op:"table_rows",id,del:<index>}\n'
      + '{op:"replace_all",find,repl,scope?}  {op:"convert_block",id,to:"para|heading|list|olist"}  {op:"remove_block",id}  {op:"move_block",id,to:"first|last|earlier|later"}\n'
      + '{op:"add_block",after:"start|end|<blockId>",block:{type:"heading|para|li|table|pagebreak",text?,level?,ordered?,rows?}}\nBlocks marked image/object cannot be changed. Change only what was asked; keep the rest of the document untouched. Write new text in the language of the document. If the request cannot be done with these actions, return {"say":"why","edits":[]}.';
    return { system: system, user: 'Document "' + s.title + '" (' + s.objects.length + ' blocks' + (full ? '' : ', long: bodies shortened') + '):\n\n' + (lines.join('\n') || '(empty)') + '\n\nRequest: ' + String(request || '') };
  }
  function rprHasAny(b) { return (b.runs || []).some(function (r) { return r.rpr && (rprHas(r.rpr, 'b') || rprHas(r.rpr, 'i') || rprHas(r.rpr, 'u') || rprColor(r.rpr)); }); }
  function parseEditsReply(text) { return O.parseEditsReply(text, AI_OPS); }
  var STARTERS = [
    { id: 'blank', label: '空白文件', desc: '一個標題與一段文字。', spec: function () { return { v: 1, title: '未命名文件', objects: [{ type: 'heading', level: 1, runs: [{ t: '標題' }] }, { type: 'para', runs: [] }] }; } },
    { id: 'letter', label: '信件', desc: '日期、收件人、內文、署名。', spec: function () { return { v: 1, title: '信件', objects: [{ type: 'para', runs: [{ t: '日期：' }] }, { type: 'para', runs: [{ t: '敬啟者：' }] }, { type: 'para', runs: [{ t: '（內文）' }] }, { type: 'para', runs: [{ t: '此致' }] }, { type: 'para', runs: [{ t: '署名' }] }] }; } },
    { id: 'report', label: '報告', desc: '標題、摘要、章節、表格。', spec: function () { return { v: 1, title: '報告', objects: [{ type: 'heading', level: 1, runs: [{ t: '報告標題' }] }, { type: 'heading', level: 2, runs: [{ t: '摘要' }] }, { type: 'para', runs: [{ t: '一兩句話說明重點。' }] }, { type: 'heading', level: 2, runs: [{ t: '內容' }] }, { type: 'li', ordered: false, runs: [{ t: '重點一' }] }, { type: 'li', ordered: false, runs: [{ t: '重點二' }] }, { type: 'table', rows: [['項目', '說明'], ['', '']] }] }; } },
  ];
  function starter(id) { var t = STARTERS.filter(function (x) { return x.id === id; })[0]; return t ? validate(t.spec()).spec : null; }
  function listStarters() { return STARTERS.map(function (t) { return { id: t.id, label: t.label, desc: t.desc }; }); }
  return { types: types, extraOps: extraOps, OPS: E.OPS, validate: validate, applyEdits: applyEdits, editWords: E.editWords, find: E.find, list: E.list, read: read, build: build, sigOf: sigOf, plain: plain, retext: retext, toHtml: toHtml, blockHtml: blockHtml, parseCommands: parseCommands, editPrompt: editPrompt, parseEditsReply: parseEditsReply, AI_OPS: AI_OPS, starter: starter, listStarters: listStarters, rprHas: rprHas, rprColor: rprColor, scan: scan };
});
