/*
 * 文件撰寫器的輸出層：把「文件模型」轉成各種格式的內容。純函式，不碰 DOM、Electron、網路，桌面版與網頁版共用。
 *
 * 文件模型：{ title, subtitle?, meta: { version, date, lang, template, source }, blocks: [...] }
 *   區塊：{t:'h', l:1-4, x} {t:'p', x} {t:'ul'|'ol', items:[x]} {t:'table', head:[x], rows:[[x]]}
 *         {t:'code', lang?, x} {t:'fig', src, kind:'mermaid'|'dot', caption?} {t:'quote', x} {t:'pb'}
 *   行內：**粗體**、`程式碼`（其餘一律當純文字）
 *
 * 輸出：toMarkdown／toMediaWiki／toHtml 回傳字串；toPdfmake 回傳 pdfmake 的 docDefinition（字型由呼叫端註冊）；
 *       toDocxParts 回傳 { 路徑: XML 字串 }，由呼叫端用 JSZip 打包。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDocRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function runs(text) {
    var out = [], s = String(text == null ? '' : text), re = /(\*\*[^*]+\*\*|`[^`]+`)/g, last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push({ x: s.slice(last, m.index) });
      var tok = m[0]; if (tok.charAt(0) === '`') out.push({ x: tok.slice(1, -1), c: true }); else out.push({ x: tok.slice(2, -2), b: true });
      last = m.index + tok.length;
    }
    if (last < s.length) out.push({ x: s.slice(last) });
    return out;
  }
  function plain(text) { return runs(text).map(function (r) { return r.x; }).join(''); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function cell(x) { return String(x == null ? '' : x).replace(/\r?\n/g, ' '); }
  function slug(t) { return plain(t).toLowerCase().replace(/[^\w一-鿿]+/g, '-').replace(/^-+|-+$/g, '') || 'sec'; }
  function headings(doc) { return (doc.blocks || []).filter(function (b) { return b.t === 'h' && b.l <= 2; }); }

  // ───── Markdown ─────
  function toMarkdown(doc) {
    var o = ['# ' + plain(doc.title), ''];
    if (doc.subtitle) o.push('*' + plain(doc.subtitle) + '*', '');
    if (doc.meta) { var mm = []; if (doc.meta.version) mm.push('版本：' + doc.meta.version); if (doc.meta.date) mm.push('日期：' + doc.meta.date); if (doc.meta.template) mm.push('範本：' + doc.meta.template); if (mm.length) o.push('> ' + mm.join('　｜　'), ''); }
    (doc.blocks || []).forEach(function (b) {
      if (b.t === 'h') o.push(new Array(Math.min(6, (b.l || 1) + 1) + 1).join('#') + ' ' + b.x, '');
      else if (b.t === 'p') o.push(b.x, '');
      else if (b.t === 'ul') { b.items.forEach(function (i) { o.push('- ' + i); }); o.push(''); }
      else if (b.t === 'ol') { b.items.forEach(function (i, n) { o.push((n + 1) + '. ' + i); }); o.push(''); }
      else if (b.t === 'table') { o.push('| ' + b.head.map(cell).join(' | ') + ' |', '| ' + b.head.map(function () { return '---'; }).join(' | ') + ' |'); b.rows.forEach(function (r) { o.push('| ' + b.head.map(function (_, i) { return cell(r[i]).replace(/\|/g, '\\|'); }).join(' | ') + ' |'); }); o.push(''); }
      else if (b.t === 'code') o.push('```' + (b.lang || ''), String(b.x).replace(/\s+$/, ''), '```', '');
      else if (b.t === 'fig') { o.push('```' + (b.kind === 'dot' ? 'dot' : 'mermaid'), String(b.src).replace(/\s+$/, ''), '```'); if (b.caption) o.push('*圖：' + b.caption + '*'); o.push(''); }
      else if (b.t === 'quote') { String(b.x).split('\n').forEach(function (l) { o.push('> ' + l); }); o.push(''); }
      else if (b.t === 'pb') o.push('---', '');
    });
    return o.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  }

  // ───── MediaWiki ─────
  function wikiInline(text) { return runs(text).map(function (r) { var x = r.x.replace(/\|/g, '&#124;'); return r.c ? '<code>' + esc(r.x) + '</code>' : r.b ? "'''" + x + "'''" : x; }).join(''); }
  function toMediaWiki(doc) {
    var o = ['= ' + plain(doc.title) + ' =', ''];
    if (doc.subtitle) o.push("''" + plain(doc.subtitle) + "''", '');
    if (doc.meta && doc.meta.version) o.push(': 版本：' + doc.meta.version + (doc.meta.date ? '　日期：' + doc.meta.date : ''), '');
    o.push('__TOC__', '');
    (doc.blocks || []).forEach(function (b) {
      if (b.t === 'h') { var eq = new Array(Math.min(6, (b.l || 1) + 1) + 1).join('='); o.push(eq + ' ' + plain(b.x) + ' ' + eq, ''); }
      else if (b.t === 'p') o.push(wikiInline(b.x), '');
      else if (b.t === 'ul') { b.items.forEach(function (i) { o.push('* ' + wikiInline(i)); }); o.push(''); }
      else if (b.t === 'ol') { b.items.forEach(function (i) { o.push('# ' + wikiInline(i)); }); o.push(''); }
      else if (b.t === 'table') { o.push('{| class="wikitable"', '|-'); o.push(b.head.map(function (h) { return '! ' + wikiInline(h); }).join('\n')); b.rows.forEach(function (r) { o.push('|-'); o.push(b.head.map(function (_, i) { return '| ' + wikiInline(cell(r[i])); }).join('\n')); }); o.push('|}', ''); }
      else if (b.t === 'code') o.push('<pre>' + esc(String(b.x).replace(/\s+$/, '')) + '</pre>', '');
      else if (b.t === 'fig') { o.push('<pre>' + esc(String(b.src).replace(/\s+$/, '')) + '</pre>'); if (b.caption) o.push("''圖：" + b.caption + "''"); o.push(''); }
      else if (b.t === 'quote') o.push('<blockquote>' + wikiInline(b.x) + '</blockquote>', '');
      else if (b.t === 'pb') o.push('----', '');
    });
    return o.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  }

  // ───── HTML（獨立一個檔案；圖用 Mermaid，離線時顯示原始碼）─────
  function htmlInline(text) { return runs(text).map(function (r) { return r.c ? '<code>' + esc(r.x) + '</code>' : r.b ? '<strong>' + esc(r.x) + '</strong>' : esc(r.x); }).join(''); }
  var CSS = ':root{--bg:#fff;--fg:#1f2937;--mut:#6b7280;--line:#e5e7eb;--code:#f3f4f6;--acc:#1d4ed8}@media (prefers-color-scheme:dark){:root{--bg:#0f172a;--fg:#e5e7eb;--mut:#94a3b8;--line:#334155;--code:#1e293b;--acc:#93c5fd}}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,"Segoe UI","Noto Sans TC","Microsoft JhengHei",sans-serif}main{max-width:880px;margin:0 auto;padding:24px 16px 64px}h1{font-size:28px;margin:.2em 0}h2{font-size:21px;margin:1.6em 0 .4em;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:17px}h4{font-size:15px}.sub{color:var(--mut)}.meta{color:var(--mut);font-size:13px}nav.toc{border:1px solid var(--line);border-radius:8px;padding:8px 16px;margin:16px 0}nav.toc a{color:var(--acc);text-decoration:none}nav.toc ol{margin:4px 0;padding-left:20px}table{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--code)}code{background:var(--code);padding:1px 5px;border-radius:4px;font-family:Consolas,monospace;font-size:13px}pre{background:var(--code);padding:10px 14px;border-radius:8px;overflow:auto}pre code{padding:0;background:none}blockquote{border-left:3px solid var(--acc);margin:10px 0;padding:2px 14px;color:var(--mut)}figure{margin:12px 0;text-align:center}figcaption{color:var(--mut);font-size:13px}hr.pb{border:none;border-top:2px dashed var(--line);margin:28px 0}@media print{hr.pb{page-break-after:always;border:none}nav.toc{display:none}}';
  function toHtml(doc) {
    var o = [], hs = headings(doc), hasFig = (doc.blocks || []).some(function (b) { return b.t === 'fig'; });
    o.push('<!doctype html><html lang="' + esc((doc.meta && doc.meta.lang) || 'zh-TW') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(plain(doc.title)) + '</title><style>' + CSS + '</style></head><body><main>');
    o.push('<h1>' + htmlInline(doc.title) + '</h1>'); if (doc.subtitle) o.push('<p class="sub">' + htmlInline(doc.subtitle) + '</p>');
    if (doc.meta) { var mm = []; if (doc.meta.version) mm.push('版本 ' + esc(doc.meta.version)); if (doc.meta.date) mm.push(esc(doc.meta.date)); if (doc.meta.template) mm.push('範本：' + esc(doc.meta.template)); if (mm.length) o.push('<p class="meta">' + mm.join('　｜　') + '</p>'); }
    if (hs.length > 2) o.push('<nav class="toc"><strong>目錄</strong><ol>' + hs.filter(function (h) { return h.l === 1; }).map(function (h) { return '<li><a href="#' + slug(h.x) + '">' + esc(plain(h.x)) + '</a></li>'; }).join('') + '</ol></nav>');
    (doc.blocks || []).forEach(function (b) {
      if (b.t === 'h') { var l = Math.min(4, (b.l || 1) + 1); o.push('<h' + l + ' id="' + slug(b.x) + '">' + htmlInline(b.x) + '</h' + l + '>'); }
      else if (b.t === 'p') o.push('<p>' + htmlInline(b.x) + '</p>');
      else if (b.t === 'ul' || b.t === 'ol') o.push('<' + b.t + '>' + b.items.map(function (i) { return '<li>' + htmlInline(i) + '</li>'; }).join('') + '</' + b.t + '>');
      else if (b.t === 'table') o.push('<table><thead><tr>' + b.head.map(function (h) { return '<th>' + htmlInline(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + b.rows.map(function (r) { return '<tr>' + b.head.map(function (_, i) { return '<td>' + htmlInline(cell(r[i])) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>');
      else if (b.t === 'code') o.push('<pre><code>' + esc(String(b.x).replace(/\s+$/, '')) + '</code></pre>');
      else if (b.t === 'fig') o.push('<figure><pre class="mermaid">' + esc(String(b.src).replace(/\s+$/, '')) + '</pre>' + (b.caption ? '<figcaption>圖：' + esc(b.caption) + '</figcaption>' : '') + '</figure>');
      else if (b.t === 'quote') o.push('<blockquote>' + htmlInline(b.x) + '</blockquote>');
      else if (b.t === 'pb') o.push('<hr class="pb">');
    });
    o.push('</main>');
    if (hasFig) o.push('<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script><script>try{mermaid.initialize({startOnLoad:true,securityLevel:"strict"})}catch(e){}</script>');
    o.push('</body></html>');
    return o.join('\n');
  }

  // ───── pdfmake ─────
  var PAL = { navy: '#1e3a5f', txt: '#1f2937', mut: '#6b7280', code: '#f3f4f6', line: '#d1d5db' };
  function pdfRuns(text) { return runs(text).map(function (r) { var n = { text: r.x }; if (r.b) n.bold = true; if (r.c) { n.background = '#eef0f3'; n.fontSize = 9.5; } return n; }); }
  function toPdfmake(doc) {
    var c = [];
    c.push({ text: plain(doc.title), style: 'title' }); if (doc.subtitle) c.push({ text: plain(doc.subtitle), style: 'sub' });
    if (doc.meta) { var mm = []; if (doc.meta.version) mm.push('版本 ' + doc.meta.version); if (doc.meta.date) mm.push(doc.meta.date); if (doc.meta.template) mm.push('範本：' + doc.meta.template); if (mm.length) c.push({ text: mm.join('　|　'), style: 'sub', margin: [0, 0, 0, 10] }); }
    (doc.blocks || []).forEach(function (b) {
      if (b.t === 'h') c.push({ text: pdfRuns(b.x), style: 'h' + Math.min(4, b.l || 1), tocItem: b.l === 1 });
      else if (b.t === 'p') c.push({ text: pdfRuns(b.x), style: 'body' });
      else if (b.t === 'ul') c.push({ ul: b.items.map(pdfRuns), style: 'body', margin: [0, 0, 0, 6] });
      else if (b.t === 'ol') c.push({ ol: b.items.map(pdfRuns), style: 'body', margin: [0, 0, 0, 6] });
      else if (b.t === 'table') {
        var head = b.head.map(function (h) { return { text: plain(h), style: 'th' }; });
        var body = [head].concat(b.rows.map(function (r) { return b.head.map(function (_, i) { return { text: pdfRuns(cell(r[i])), style: 'td' }; }); }));
        c.push({ table: { headerRows: 1, widths: b.head.map(function () { return '*'; }), body: body }, layout: { hLineColor: PAL.line, vLineColor: PAL.line }, margin: [0, 2, 0, 10] });
      } else if (b.t === 'code' || b.t === 'fig') {
        var src = String(b.t === 'fig' ? b.src : b.x).replace(/\s+$/, '');
        c.push({ table: { widths: ['*'], body: [[{ text: src, style: 'code', fillColor: PAL.code }]] }, layout: 'noBorders', margin: [0, 2, 0, b.t === 'fig' && b.caption ? 2 : 10] });
        if (b.t === 'fig' && b.caption) c.push({ text: '圖：' + b.caption, style: 'sub', margin: [0, 0, 0, 10] });
      } else if (b.t === 'quote') c.push({ text: pdfRuns(b.x), style: 'quote' });
      else if (b.t === 'pb') c.push({ text: '', pageBreak: 'after' });
    });
    return {
      pageSize: 'A4', pageMargins: [48, 56, 48, 56], content: c, defaultStyle: { font: 'NotoSansTC' },
      footer: function (cur, total) { return { text: '第 ' + cur + ' / ' + total + ' 頁', alignment: 'center', fontSize: 8, color: PAL.mut, margin: [0, 8, 0, 0] }; },
      styles: {
        title: { fontSize: 24, bold: true, color: PAL.navy, margin: [0, 0, 0, 4] }, sub: { fontSize: 10.5, color: PAL.mut, italics: true },
        h1: { fontSize: 17, bold: true, color: PAL.navy, margin: [0, 14, 0, 6] }, h2: { fontSize: 13.5, bold: true, color: PAL.navy, margin: [0, 10, 0, 4] },
        h3: { fontSize: 11.5, bold: true, margin: [0, 8, 0, 3] }, h4: { fontSize: 10.5, bold: true, margin: [0, 6, 0, 2] },
        body: { fontSize: 10.5, color: PAL.txt, lineHeight: 1.35, margin: [0, 0, 0, 6] }, quote: { fontSize: 10, color: PAL.mut, italics: true, margin: [14, 2, 0, 8] },
        th: { fontSize: 9.5, bold: true, color: '#ffffff', fillColor: PAL.navy, margin: [3, 3, 3, 3] }, td: { fontSize: 9.5, color: PAL.txt, margin: [3, 3, 3, 3] },
        code: { fontSize: 8.5, color: PAL.txt, margin: [6, 5, 6, 5], preserveLeadingSpaces: true }
      }
    };
  }

  // ───── DOCX（最小可開的 OOXML；清單用縮排加符號，不另做編號定義）─────
  function x(s) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function wr(text, o) {
    o = o || {}; var pr = '<w:rFonts w:ascii="' + (o.c ? 'Consolas' : 'Calibri') + '" w:hAnsi="' + (o.c ? 'Consolas' : 'Calibri') + '" w:eastAsia="Microsoft JhengHei"/>' + (o.b ? '<w:b/>' : '') + (o.color ? '<w:color w:val="' + o.color + '"/>' : '') + (o.sz ? '<w:sz w:val="' + o.sz + '"/>' : '') + (o.c ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF0F3"/>' : '');
    return '<w:r><w:rPr>' + pr + '</w:rPr><w:t xml:space="preserve">' + x(text) + '</w:t></w:r>';
  }
  function wruns(text, base) { return runs(text).map(function (r) { return wr(r.x, { b: r.b || (base && base.b), c: r.c, sz: base && base.sz, color: base && base.color }); }).join(''); }
  function wp(inner, o) { o = o || {}; return '<w:p><w:pPr>' + (o.style ? '<w:pStyle w:val="' + o.style + '"/>' : '') + (o.ind ? '<w:ind w:left="' + o.ind + '" w:hanging="' + (o.hang || 0) + '"/>' : '') + (o.shade ? '<w:shd w:val="clear" w:color="auto" w:fill="' + o.shade + '"/>' : '') + (o.after != null ? '<w:spacing w:after="' + o.after + '"/>' : '') + '</w:pPr>' + inner + '</w:p>'; }
  function wtable(b) {
    var n = Math.max(1, b.head.length), w = Math.floor(9000 / n), grid = ''; for (var i = 0; i < n; i++) grid += '<w:gridCol w:w="' + w + '"/>';
    function tc(content, head) { return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + (head ? '<w:shd w:val="clear" w:color="auto" w:fill="1E3A5F"/>' : '') + '</w:tcPr>' + wp(content, { after: 0 }) + '</w:tc>'; }
    return '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>' + grid + '</w:tblGrid>'
      + '<w:tr><w:trPr><w:tblHeader/></w:trPr>' + b.head.map(function (h) { return tc(wruns(plain(h), { b: true, color: 'FFFFFF', sz: 19 }), true); }).join('') + '</w:tr>'
      + b.rows.map(function (r) { return '<w:tr>' + b.head.map(function (_, i) { return tc(wruns(cell(r[i]), { sz: 19 })); }).join('') + '</w:tr>'; }).join('') + '</w:tbl>' + wp('', { after: 120 });
  }
  function toDocxParts(doc) {
    var body = [];
    body.push(wp(wr(plain(doc.title), { b: true, sz: 48, color: '1E3A5F' }), { style: 'Title' }));
    if (doc.subtitle) body.push(wp(wr(plain(doc.subtitle), { sz: 21, color: '6B7280' })));
    if (doc.meta) { var mm = []; if (doc.meta.version) mm.push('版本 ' + doc.meta.version); if (doc.meta.date) mm.push(doc.meta.date); if (doc.meta.template) mm.push('範本：' + doc.meta.template); if (mm.length) body.push(wp(wr(mm.join('　|　'), { sz: 19, color: '6B7280' }))); }
    (doc.blocks || []).forEach(function (b) {
      if (b.t === 'h') body.push(wp(wruns(b.x), { style: 'Heading' + Math.min(4, b.l || 1) }));
      else if (b.t === 'p') body.push(wp(wruns(b.x)));
      else if (b.t === 'ul') b.items.forEach(function (i) { body.push(wp(wr('• ') + wruns(i), { ind: 480, hang: 240, after: 40 })); });
      else if (b.t === 'ol') b.items.forEach(function (i, n) { body.push(wp(wr((n + 1) + '. ') + wruns(i), { ind: 480, hang: 300, after: 40 })); });
      else if (b.t === 'table') body.push(wtable(b));
      else if (b.t === 'code' || b.t === 'fig') {
        String(b.t === 'fig' ? b.src : b.x).replace(/\s+$/, '').split('\n').forEach(function (l) { body.push(wp(wr(l, { c: true, sz: 18 }), { shade: 'F3F4F6', after: 0 })); });
        if (b.t === 'fig' && b.caption) body.push(wp(wr('圖：' + b.caption, { sz: 19, color: '6B7280' }))); else body.push(wp('', { after: 80 }));
      } else if (b.t === 'quote') body.push(wp(wruns(b.x, { color: '6B7280' }), { ind: 360 }));
      else if (b.t === 'pb') body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    });
    var NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    var hstyle = function (id, name, sz, color) { return '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="' + name + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="' + (parseInt(id.slice(-1), 10) - 1) + '"/></w:pPr><w:rPr><w:b/><w:color w:val="' + color + '"/><w:sz w:val="' + sz + '"/></w:rPr></w:style>'; };
    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ' + NS + '><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft JhengHei"/><w:sz w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-TW"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr></w:style>'
      + hstyle('Heading1', 'heading 1', 34, '1E3A5F') + hstyle('Heading2', 'heading 2', 28, '1E3A5F') + hstyle('Heading3', 'heading 3', 24, '111827') + hstyle('Heading4', 'heading 4', 22, '111827')
      + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
      + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/></w:tblBorders></w:tblPr></w:style></w:styles>';
    var parts = {};
    parts['[Content_Types].xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
    parts['_rels/.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    parts['word/_rels/document.xml.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
    parts['word/styles.xml'] = styles;
    parts['word/document.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + NS + '><w:body>' + body.join('') + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>';
    return parts;
  }

  return { runs: runs, plain: plain, toMarkdown: toMarkdown, toMediaWiki: toMediaWiki, toHtml: toHtml, toPdfmake: toPdfmake, toDocxParts: toDocxParts, FORMATS: ['md', 'mediawiki', 'html', 'pdf', 'docx'] };
});
