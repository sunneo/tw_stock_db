// /edit-csv 與 /edit-xlsx 的文件核心（純函式，Node 與瀏覽器都能跑）。設計見 DESIGN.edit-docs.md。
// 文件的「物件」是工作表（所以共用外框 FaEditShell 的物件欄＝工作表清單、復原、AI 對話都直接能用）：
//   { v:1, title, format:'csv'|'xlsx', delim, eol, bom, finalNl, quoteAll, src?, sig?, notes:[], seq, objects:[ { id, name, type:'sheet', visible, locked, header, cols:[{id, w?}], rows:[{ id, c:{ colId: 值 } }], seq, cseq, frozen:{r,c}, merges:[…] } ] }
//   格子的值：字串（CSV 一律是字串，原文字原樣保存）| 數字 | 布林 | { f:'公式字串(沒有=)', v:快取值 }（只有 xlsx；公式由 FaSheetFormula 算）。列 1＝rows[0]；標題列只是 header:true 時畫面與排序當標題看。
//   往返：CSV 匯入時保存原文（src，≤1MB）與格子簽章（sig）；沒改過的 serialize 原樣輸出原文，所以不會把你的檔案重新格式化。xlsx：沒改過由呼叫端輸出原檔位元組；改過就重新產生（樣式、圖表、樞紐表等編輯器不懂的部分不保留，開檔時會在 notes 列出）。
// API：FaEditSheet.parseCsv(text, name) → spec    serializeCsv(spec, sheetId?) → 文字    readXlsx(bytes, JSZip, name) → Promise<spec>    buildXlsx(spec, JSZip) → Promise<Uint8Array>
//   validate / applyEdits / editWords / find（同 FaEditObjects）    parseCommands(text, spec) → { edits, matched, unmatched }（程式讀得懂的白話）    editPrompt / parseEditsReply / AI_OPS（給模型）    computed(sheet) → 算好的值    starter / listStarters
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./edit_objects_core.js'), require('./sheet_formula.js'));
  else root.FaEditSheet = factory(root.FaEditObjects || (typeof FaEditObjects !== 'undefined' ? FaEditObjects : undefined), root.FaSheetFormula || (typeof FaSheetFormula !== 'undefined' ? FaSheetFormula : undefined));
})(typeof self !== 'undefined' ? self : this, function (O, FX) {
  'use strict';
  var MAXROWS = 20000, MAXCOLS = 200, MAXCELL = 32767, MAXSRC = 1000000, MAXSHEETS = 50;
  function str(v, max) { return String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, max || 200); }
  function int(v, lo, hi, d) { var n = Math.round(Number(v)); if (!isFinite(n)) { return d; } return Math.max(lo, Math.min(hi, n)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function snippet(t, n) { var s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); return s.length > (n || 18) ? s.slice(0, n || 18) + '…' : s; }
  var isF = function (x) { return x && typeof x === 'object' && typeof x.f === 'string'; };
  function raw(x) { return isF(x) ? x.v : x; }
  function cellStr(x) { var v = raw(x); return v === undefined || v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v); }
  function cleanCell(x, csv) {
    if (x === undefined || x === null) { return undefined; }
    if (isF(x)) { if (csv) { return str('=' + x.f, MAXCELL); } var v = x.v; return { f: str(x.f, 8000).replace(/^=/, ''), v: typeof v === 'number' || typeof v === 'boolean' ? v : (v === undefined || v === null ? '' : str(v, MAXCELL)) }; }
    if (typeof x === 'number') { return isFinite(x) ? x : ''; } if (typeof x === 'boolean') { return csv ? (x ? 'TRUE' : 'FALSE') : x; }
    var s = String(x).replace(/\u0000/g, '').slice(0, MAXCELL); return csv ? s : s;
  }

  // ───────── CSV：解析（保留分隔符、行尾、BOM、結尾換行、是否全部加引號）
  function detectDelim(text) {
    var first = text.slice(0, 20000).split(/\r\n|\n|\r/)[0] || '', cnt = function (c) { var q = false, n = 0; for (var i = 0; i < first.length; i++) { var ch = first[i]; if (ch === '"') { q = !q; } else if (!q && ch === c) { n++; } } return n; };
    var best = ',', bn = cnt(','); [['\t', cnt('\t')], [';', cnt(';')], ['|', cnt('|')]].forEach(function (p) { if (p[1] > bn) { best = p[0]; bn = p[1]; } }); return best;
  }
  function parseRows(text, delim) {
    var rows = [], row = [], f = '', q = false, i = 0, n = text.length, quotedAny = 0, plainAny = 0, wasQ = false;
    while (i < n) {
      var c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; } f += c; i++; continue; }
      if (c === '"' && f === '') { q = true; wasQ = true; i++; continue; }
      if (c === delim) { row.push(f); if (wasQ) { quotedAny++; } else if (f !== '') { plainAny++; } wasQ = false; f = ''; i++; continue; }
      if (c === '\r' || c === '\n') { row.push(f); if (wasQ) { quotedAny++; } else if (f !== '') { plainAny++; } wasQ = false; rows.push(row); row = []; f = ''; if (c === '\r' && text[i + 1] === '\n') { i++; } i++; continue; }
      f += c; i++;
    }
    var finalNl = true; if (f !== '' || row.length || wasQ) { row.push(f); if (wasQ) { quotedAny++; } else if (f !== '') { plainAny++; } rows.push(row); finalNl = false; }
    return { rows: rows, finalNl: finalNl, quoteAll: quotedAny > 0 && plainAny === 0 };
  }
  function newSheet(name, rows, o) {
    o = o || {}; var w = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0); w = Math.min(MAXCOLS, Math.max(w, o.minCols || 0));
    var cols = []; for (var j = 0; j < w; j++) { cols.push({ id: 'c' + (j + 1) }); }
    var rs = rows.slice(0, MAXROWS).map(function (r, i) { var c = {}; for (var k = 0; k < Math.min(r.length, w); k++) { var v = r[k]; if (v !== '' && v !== undefined && v !== null) { c[cols[k].id] = v; } } return { id: 'r' + (i + 1), c: c }; });
    var s = { id: o.id || 's1', name: name || 'Sheet1', type: 'sheet', visible: true, locked: false, header: o.header !== false, cols: cols, rows: rs, seq: rs.length, cseq: w, frozen: o.frozen || { r: 0, c: 0 }, merges: o.merges || [] }; return s;
  }
  function sigOf(spec) { var s = JSON.stringify([spec.delim, spec.eol, !!spec.bom, !!spec.quoteAll, spec.finalNl !== false, spec.objects.map(function (o) { return [o.name, o.cols.map(function (c) { return c.id; }), o.rows.map(function (r) { return [r.id, r.c]; })]; })]); var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16) + ':' + s.length; }
  function headerGuess(rows) { if (rows.length < 2) { return rows.length === 1 && rows[0].some(function (x) { return x !== '' && isNaN(Number(x)); }); } var h = rows[0]; if (!h.length || h.some(function (x) { return x === ''; })) { return false; } if (h.every(function (x) { return isNaN(Number(x)); })) { return true; } return false; }
  function parseCsv(text, name) {
    text = String(text == null ? '' : text); var bom = text.charCodeAt(0) === 0xFEFF; if (bom) { text = text.slice(1); }
    var delim = detectDelim(text), eol = /\r\n/.test(text) ? '\r\n' : (/\r/.test(text) && !/\n/.test(text) ? '\r' : '\n'), p = parseRows(text, delim), rows = p.rows;
    var sh = newSheet(name || 'Sheet1', rows, { header: headerGuess(rows) });
    var spec = { v: 1, title: name || '未命名表格', format: 'csv', delim: delim, eol: eol, bom: bom, finalNl: p.finalNl, quoteAll: p.quoteAll, notes: [], seq: 1, canvas: { x: 0, y: 0, w: 800, h: 600, bg: '#ffffff' }, objects: [sh] };
    if (text.length <= MAXSRC) { spec.src = (bom ? '﻿' : '') + text; } spec.sig = sigOf(spec); if (rows.length > MAXROWS) { spec.notes.push('檔案有 ' + rows.length + ' 列，只讀入前 ' + MAXROWS + ' 列'); }
    return spec;
  }
  function csvField(v, d, quoteAll) { var s = cellStr(v); if (quoteAll || /["\r\n]/.test(s) || s.indexOf(d) >= 0 || /^\s|\s$/.test(s) && false) { return '"' + s.replace(/"/g, '""') + '"'; } return s; }
  function serializeCsv(spec, sheetId) {
    var s = validate(spec).spec, sh = sheetId ? s.objects.filter(function (o) { return o.id === sheetId; })[0] : s.objects[0]; if (!sh) { return ''; }
    if (!sheetId && s.src != null && s.sig && sigOf(s) === s.sig) { return s.src; }
    var d = s.delim || ',', eol = s.eol || '\n', f = FX && s.format === 'xlsx' ? computed(sh) : null;
    var lines = sh.rows.map(function (r, i) { return sh.cols.map(function (c, j) { var x = r.c[c.id]; return csvField(f && isF(x) ? FX.show(f[i][j]) : cellStr(x), d, s.quoteAll); }).join(d); });
    while (s.format !== 'csv' && lines.length && lines[lines.length - 1].replace(new RegExp('\\' + d, 'g'), '') === '') { lines.pop(); }
    return (s.bom ? '﻿' : '') + lines.join(eol) + (lines.length && s.finalNl !== false ? eol : '');
  }
  function computed(sh) { return FX ? FX.compute(sh).values : sh.rows.map(function (r) { return sh.cols.map(function (c) { return raw(r.c[c.id]); }); }); }

  // ───────── XLSX 讀寫（自己解 XML；保留公式與快取值、欄寬、凍結窗格、合併儲存格；不懂的內容只列在 notes）
  var xmlUnesc = function (s) { return String(s).replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, function (m, e) { return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e] || (e[1] === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10))); }); };
  var xmlEsc = function (s) { return String(s).replace(/[&<>"\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : ''; }); };
  async function readXlsx(bytes, JSZip, name) {
    if (!JSZip) { throw new Error('JSZip 還沒載入'); }
    var zip = await JSZip.loadAsync(bytes), rd = async function (p) { var f = zip.file(p); return f ? f.async('string') : ''; };
    var wb = await rd('xl/workbook.xml'), rels = await rd('xl/_rels/workbook.xml.rels'), ss = await rd('xl/sharedStrings.xml'), shared = [];
    if (ss) { var re0 = /<si>([\s\S]*?)<\/si>/g, m0; while ((m0 = re0.exec(ss))) { var t = '', tr = /<t[^>]*>([\s\S]*?)<\/t>/g, tm; while ((tm = tr.exec(m0[1]))) { t += xmlUnesc(tm[1]); } shared.push(t); } }
    var relMap = {}, rre = /<Relationship\b[^>]*>/g, rm0; while ((rm0 = rre.exec(rels))) { var id = /Id="([^"]+)"/.exec(rm0[0]), tg = /Target="([^"]+)"/.exec(rm0[0]); if (id && tg) { relMap[id[1]] = tg[1]; } }
    var sheets = [], notes = [], sre = /<sheet\b[^>]*>/g, sm, k = 0;
    while ((sm = sre.exec(wb)) && sheets.length < MAXSHEETS) {
      var nm = /name="([^"]*)"/.exec(sm[0]), rid = /r:id="([^"]+)"/.exec(sm[0]); if (!nm || !rid) { continue; }
      var target = (relMap[rid[1]] || '').replace(/^\/?(xl\/)?/, 'xl/'), xml = await rd(target), rows = [], maxC = 0, shared_f = 0;
      var rr = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, rmm;
      while ((rmm = rr.exec(xml))) {
        var rn = /r="(\d+)"/.exec(rmm[1]), ri = rn ? Number(rn[1]) - 1 : rows.length; if (ri >= MAXROWS) { continue; } while (rows.length <= ri) { rows.push([]); }
        var cr = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
        while ((cm = cr.exec(rmm[2] || ''))) {
          var attrs = cm[1], body = cm[2] || '', ref = /r="([A-Z]+)(\d+)"/.exec(attrs); if (!ref) { continue; } var ci = FX.colIndex(ref[1]); if (ci >= MAXCOLS) { continue; } var ty = (/t="(\w+)"/.exec(attrs) || [])[1], v = '', fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
          if (ty === 'inlineStr') { var tt = /<t[^>]*>([\s\S]*?)<\/t>/g, x; while ((x = tt.exec(body))) { v += xmlUnesc(x[1]); } }
          else { var vm = /<v>([\s\S]*?)<\/v>/.exec(body); if (vm) { var rv = xmlUnesc(vm[1]); if (ty === 's') { v = shared[+rv] || ''; } else if (ty === 'b') { v = rv === '1'; } else if (ty === 'str' || ty === 'e') { v = rv; } else { var nn = Number(rv); v = isFinite(nn) ? nn : rv; } } }
          if (fm && fm[2]) { v = { f: xmlUnesc(fm[2]), v: v }; } else if (fm) { shared_f++; }
          while (rows[ri].length <= ci) { rows[ri].push(undefined); } rows[ri][ci] = v; if (ci + 1 > maxC) { maxC = ci + 1; }
        }
      }
      var s2 = newSheet(xmlUnesc(nm[1]), rows.map(function (r) { return r.map(function (x) { return x === undefined ? '' : x; }); }), { id: 's' + (++k), header: false });
      // 欄寬（字元數）、凍結窗格、合併儲存格
      var cw = /<col\b[^>]*>/g, cx; while ((cx = cw.exec(xml))) { var mn = /min="(\d+)"/.exec(cx[0]), mx = /max="(\d+)"/.exec(cx[0]), wd = /width="([\d.]+)"/.exec(cx[0]); if (mn && mx && wd) { for (var q = Number(mn[1]); q <= Math.min(Number(mx[1]), s2.cols.length); q++) { s2.cols[q - 1].w = Math.round(Number(wd[1]) * 10) / 10; } } }
      var pn = /<pane\b[^>]*>/.exec(xml); if (pn) { var xs = /xSplit="(\d+)"/.exec(pn[0]), ys = /ySplit="(\d+)"/.exec(pn[0]); s2.frozen = { r: ys ? Number(ys[1]) : 0, c: xs ? Number(xs[1]) : 0 }; }
      var mg = /<mergeCell\b[^>]*ref="([A-Z]+\d+:[A-Z]+\d+)"/g, mgm; while ((mgm = mg.exec(xml))) { s2.merges.push(mgm[1]); }
      if (shared_f) { notes.push('「' + s2.name + '」有 ' + shared_f + ' 個共用公式，只保留算好的值'); }
      var unk = []; if (/<conditionalFormatting/.test(xml)) { unk.push('條件式格式'); } if (/<dataValidations/.test(xml)) { unk.push('資料驗證'); } if (/<drawing\b/.test(xml)) { unk.push('圖表／圖片'); } if (/<tableParts/.test(xml)) { unk.push('表格物件'); } if (unk.length) { notes.push('「' + s2.name + '」有' + unk.join('、') + '：修改後匯出不會保留'); }
      sheets.push(s2);
    }
    var names = Object.keys(zip.files); if (names.some(function (n) { return /^xl\/(pivotTables|charts)\//.test(n); })) { notes.push('檔案有圖表或樞紐表：修改後匯出不會保留'); } if (names.some(function (n) { return /vbaProject/.test(n); })) { notes.push('檔案有巨集：修改後匯出不會保留'); }
    if (!sheets.length) { sheets.push(newSheet('Sheet1', [[]], { id: 's1', header: false, minCols: 1 })); }
    var spec = { v: 1, title: name || '未命名活頁簿', format: 'xlsx', delim: ',', eol: '\n', bom: false, notes: notes, seq: sheets.length, canvas: { x: 0, y: 0, w: 800, h: 600, bg: '#ffffff' }, objects: sheets };
    spec.sig = sigOf(spec); return spec;
  }
  function sheetXml(sh) {
    var vals = computed(sh), rows = [], lastNonEmpty = -1; sh.rows.forEach(function (r, i) { if (Object.keys(r.c).length) { lastNonEmpty = i; } });
    for (var i = 0; i <= lastNonEmpty; i++) {
      var r = sh.rows[i], cells = '';
      sh.cols.forEach(function (c, j) {
        var x = r.c[c.id]; if (x === undefined || x === '') { return; } var ref = FX.colLetter(j) + (i + 1);
        if (isF(x)) { var v = vals[i][j], isE = FX.isErr(v), vs = isE ? v.code : (typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? '1' : '0') : xmlEsc(String(v == null ? '' : v))); cells += '<c r="' + ref + '"' + (isE ? ' t="e"' : typeof v === 'boolean' ? ' t="b"' : typeof v === 'number' ? '' : ' t="str"') + '><f>' + xmlEsc(x.f) + '</f><v>' + vs + '</v></c>'; }
        else if (typeof x === 'number') { cells += '<c r="' + ref + '"><v>' + x + '</v></c>'; } else if (typeof x === 'boolean') { cells += '<c r="' + ref + '" t="b"><v>' + (x ? 1 : 0) + '</v></c>'; }
        else { cells += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(String(x)) + '</t></is></c>'; }
      });
      rows.push('<row r="' + (i + 1) + '">' + cells + '</row>');
    }
    var colsX = sh.cols.map(function (c, j) { return c.w ? '<col min="' + (j + 1) + '" max="' + (j + 1) + '" width="' + c.w + '" customWidth="1"/>' : ''; }).join('');
    var fr = sh.frozen || {}, pane = fr.r || fr.c ? '<sheetViews><sheetView workbookViewId="0"><pane' + (fr.c ? ' xSplit="' + fr.c + '"' : '') + (fr.r ? ' ySplit="' + fr.r + '"' : '') + ' topLeftCell="' + FX.colLetter(fr.c || 0) + ((fr.r || 0) + 1) + '" activePane="' + (fr.r && fr.c ? 'bottomRight' : fr.r ? 'bottomLeft' : 'topRight') + '" state="frozen"/></sheetView></sheetViews>' : '';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + pane + (colsX ? '<cols>' + colsX + '</cols>' : '') + '<sheetData>' + rows.join('') + '</sheetData>' + ((sh.merges || []).length ? '<mergeCells count="' + sh.merges.length + '">' + sh.merges.map(function (m) { return '<mergeCell ref="' + xmlEsc(m) + '"/>'; }).join('') + '</mergeCells>' : '') + '</worksheet>';
  }
  async function buildXlsx(spec, JSZip) {
    if (!JSZip) { throw new Error('JSZip 還沒載入'); } var s = validate(spec).spec, sheets = s.objects.length ? s.objects : [newSheet('Sheet1', [[]], { minCols: 1 })], used = {};
    var names = sheets.map(function (o) { var n = String(o.name || 'Sheet').replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31) || 'Sheet', b = n, i = 2; while (used[n.toLowerCase()]) { n = b.slice(0, 28) + '~' + (i++); } used[n.toLowerCase()] = 1; return n; });
    var zip = new JSZip(), X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    zip.file('[Content_Types].xml', X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map(function (_, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') + '</Types>');
    zip.file('_rels/.rels', X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    zip.file('xl/workbook.xml', X + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + names.map(function (n, i) { return '<sheet name="' + xmlEsc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map(function (_, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') + '</Relationships>');
    sheets.forEach(function (o, i) { zip.file('xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(o)); });
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  // ───────── 公式參照隨列／欄的插入、刪除移動（只改字串，不計算）
  function shiftFormula(f, dim, at, delta) {   // dim 'r'|'c'；at＝0 起算的位置；delta>0 插入 delta 個、<0 刪掉 -delta 個（刪到的參照變 #REF!）
    return String(f).replace(/("(?:[^"]|"")*")|(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(])/g, function (m, qs, d1, L, d2, N) {
      if (qs) { return qs; } var c = FX.colIndex(L), r = Number(N) - 1, v = dim === 'r' ? r : c;
      if (delta > 0) { if (v >= at) { v += delta; } } else { if (v >= at && v < at - delta) { return '#REF!'; } if (v >= at - delta) { v += delta; } }
      return dim === 'r' ? d1 + L + d2 + (v + 1) : d1 + FX.colLetter(v) + d2 + N;
    });
  }
  function shiftAll(sh, dim, at, delta) { sh.rows.forEach(function (r) { Object.keys(r.c).forEach(function (k) { var x = r.c[k]; if (isF(x)) { x.f = shiftFormula(x.f, dim, at, delta); } }); }); }
  function hasFormula(sh) { return sh.rows.some(function (r) { return Object.keys(r.c).some(function (k) { return isF(r.c[k]); }); }); }

  // ───────── 型別與動作
  function mkSheetType() {
    return { label: '工作表', defaults: { header: false, cols: [], rows: [], seq: 0, cseq: 0, frozen: { r: 0, c: 0 }, merges: [] }, bbox: function () { return { x: 0, y: 0, w: 1, h: 1 }; },
      validate: function (o) {
        var csv = !!o.__csv, cols = [], seenC = {}; (Array.isArray(o.cols) ? o.cols : []).slice(0, MAXCOLS).forEach(function (c) { var id = c && /^[A-Za-z][A-Za-z0-9_-]{0,20}$/.test(String(c.id || '')) && !seenC[c.id] ? String(c.id) : null; if (!id) { var n = 1; while (seenC['c' + n]) { n++; } id = 'c' + n; } seenC[id] = 1; var col = { id: id }; if (c && Number(c.w) > 0) { col.w = Math.min(500, Math.round(Number(c.w) * 10) / 10); } cols.push(col); });
        var seenR = {}, rows = []; (Array.isArray(o.rows) ? o.rows : []).slice(0, MAXROWS).forEach(function (r) { var id = r && /^[A-Za-z][A-Za-z0-9_-]{0,20}$/.test(String(r.id || '')) && !seenR[r.id] ? String(r.id) : null; if (!id) { var n = rows.length + 1; while (seenR['r' + n]) { n++; } id = 'r' + n; } seenR[id] = 1; var c = {}; var src = r && r.c && typeof r.c === 'object' ? r.c : {}; cols.forEach(function (col) { var v = cleanCell(src[col.id], csv); if (v !== undefined && v !== '') { c[col.id] = v; } }); rows.push({ id: id, c: c }); });
        var fr = o.frozen && typeof o.frozen === 'object' ? o.frozen : {}, mg = (Array.isArray(o.merges) ? o.merges : []).slice(0, 2000).map(function (m) { return str(m, 30); }).filter(function (m) { return /^[A-Z]+\d+:[A-Z]+\d+$/.test(m); });
        return { obj: { header: !!o.header, cols: cols, rows: rows, seq: Math.max(rows.length, int(o.seq, 0, 1e9, 0)), cseq: Math.max(cols.length, int(o.cseq, 0, 1e9, 0)), frozen: { r: int(fr.r, 0, 1000, 0), c: int(fr.c, 0, 100, 0) }, merges: mg }, problems: [] };
      } };
  }
  var types = { sheet: mkSheetType() };
  function find(spec, ref) { var i = O_find(spec, ref); return i; }
  function O_find(spec, ref) { for (var i = 0; i < spec.objects.length; i++) { if (spec.objects[i].id === ref || spec.objects[i].name === ref) { return i; } } return -1; }
  function sheetFor(s, e, H) { var i = e.sheet != null && e.sheet !== '' ? O_find(s, String(e.sheet)) : (s.objects.length ? 0 : -1); if (i < 0 && e.sheet == null) { return null; } return i < 0 ? null : s.objects[i]; }
  function headerText(sh, j) { return sh.header && sh.rows[0] ? cellStr(sh.rows[0].c[sh.cols[j].id]) : (!sh.header && sh.rows[0] ? cellStr(sh.rows[0].c[sh.cols[j].id]) : ''); }
  // 欄的說法：數字（1 起算）、欄字母、colId、標題文字（標題列的字，沒有標題列就看第一列）
  function colRef(sh, ref) {
    if (ref == null || ref === '') { return -1; } var r = String(ref).trim().replace(/^[「"'『]|[」"'』]$/g, ''), i;
    for (i = 0; i < sh.cols.length; i++) { if (sh.cols[i].id === r) { return i; } }
    if (/^[A-Za-z]{1,3}$/.test(r) && FX.colIndex(r) < sh.cols.length && !sh.rows.some(function (x, k) { return k === 0 && false; })) { var byHead = -1; for (i = 0; i < sh.cols.length; i++) { if (headerText(sh, i).toLowerCase() === r.toLowerCase()) { byHead = i; } } return byHead >= 0 ? byHead : FX.colIndex(r); }
    if (/^\d+$/.test(r)) { var n = Number(r) - 1; return n >= 0 && n < sh.cols.length ? n : -1; }
    for (i = 0; i < sh.cols.length; i++) { if (headerText(sh, i).toLowerCase() === r.toLowerCase()) { return i; } }
    for (i = 0; i < sh.cols.length; i++) { if (headerText(sh, i).toLowerCase().indexOf(r.toLowerCase()) >= 0 && r) { return i; } }
    return -1;
  }
  function rowRef(sh, ref) { if (ref == null || ref === '') { return -1; } var r = String(ref).trim(); for (var i = 0; i < sh.rows.length; i++) { if (sh.rows[i].id === r) { return i; } } if (/^\d+$/.test(r)) { var n = Number(r) - 1; return n >= 0 && n < sh.rows.length ? n : -1; } return -1; }
  function newRowId(sh) { var n = sh.seq || sh.rows.length, ids = {}; sh.rows.forEach(function (r) { ids[r.id] = 1; }); do { n++; } while (ids['r' + n]); sh.seq = n; return 'r' + n; }
  function newColId(sh) { var n = sh.cseq || sh.cols.length, ids = {}; sh.cols.forEach(function (c) { ids[c.id] = 1; }); do { n++; } while (ids['c' + n]); sh.cseq = n; return 'c' + n; }
  function setVal(spec, sh, r, cid, v) {
    if (v === '' || v == null) { delete sh.rows[r].c[cid]; return; }
    if (spec.format === 'xlsx' && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) && v.trim().length < 16 && !/^0\d/.test(v.trim())) { sh.rows[r].c[cid] = Number(v); } else { sh.rows[r].c[cid] = v; }
  }
  function cmpVals(a, b, numeric) { var A = raw(a), B = raw(b), ea = A === undefined || A === '' || A === null, eb = B === undefined || B === '' || B === null; if (ea || eb) { return ea && eb ? 0 : ea ? 1 : -1; } var na = Number(String(A).replace(/,/g, '')), nb = Number(String(B).replace(/,/g, '')); if (numeric !== false && isFinite(na) && isFinite(nb)) { return na - nb; } var sa = String(A).toLowerCase(), sb = String(B).toLowerCase(); return sa < sb ? -1 : sa > sb ? 1 : 0; }
  function A(words, apply) { return { words: words, apply: apply }; }
  function need(s, e) { var sh = sheetFor(s, e); return sh || null; }
  var NOS = { error: 'there is no such sheet (use a sheet id or name from the list)' };
  var extraOps = {
    set_cell: A(function (e) { return '改格子 ' + (e.col == null ? '' : e.col) + (e.row == null ? '' : e.row); }, function (s, e) {
      var sh = need(s, e); if (!sh) { return NOS; } if (sh.locked) { return { error: 'the sheet is locked' }; } var r = rowRef(sh, e.row), c = colRef(sh, e.col);
      if (r < 0 && /^\d+$/.test(String(e.row)) && Number(e.row) >= 1 && Number(e.row) <= MAXROWS) { while (sh.rows.length < Number(e.row)) { sh.rows.push({ id: newRowId(sh), c: {} }); } r = Number(e.row) - 1; }
      if (c < 0 && /^[A-Za-z]{1,3}$/.test(String(e.col)) && FX.colIndex(String(e.col)) < MAXCOLS) { while (sh.cols.length <= FX.colIndex(String(e.col))) { sh.cols.push({ id: newColId(sh) }); } c = FX.colIndex(String(e.col)); }
      if (r < 0 || c < 0) { return { error: 'no such row or column' }; }
      if (e.f != null && s.format === 'xlsx') { sh.rows[r].c[sh.cols[c].id] = { f: String(e.f).replace(/^=/, ''), v: '' }; } else { setVal(s, sh, r, sh.cols[c].id, e.v == null ? '' : (typeof e.v === 'number' || typeof e.v === 'boolean' ? (s.format === 'csv' ? String(e.v) : e.v) : String(e.v))); } return {};
    }),
    fill_col: A(function (e) { return '填滿欄 ' + e.col; }, function (s, e) {
      var sh = need(s, e); if (!sh) { return NOS; } if (sh.locked) { return { error: 'the sheet is locked' }; } var c = colRef(sh, e.col); if (c < 0) { return { error: 'no such column' }; }
      var from = e.from != null ? Number(e.from) - 1 : (sh.header ? 1 : 0), to = e.to != null ? Number(e.to) - 1 : sh.rows.length - 1; from = Math.max(0, from); to = Math.min(sh.rows.length - 1, to); var n = 0;
      for (var r = from; r <= to; r++) {
        var v; if (e.formula != null && s.format === 'xlsx') { sh.rows[r].c[sh.cols[c].id] = { f: String(e.formula).replace(/^=/, '').replace(/\{r\}/g, String(r + 1)), v: '' }; n++; continue; }
        if (e.series && typeof e.series === 'object') { v = Number(e.series.start || 0) + (r - from) * Number(e.series.step == null ? 1 : e.series.step); } else { v = e.value == null ? '' : e.value; }
        setVal(s, sh, r, sh.cols[c].id, typeof v === 'number' ? (s.format === 'csv' ? String(v) : v) : String(v)); n++;
      } return n ? {} : { error: 'no rows to fill' };
    }),
    add_col: A(function (e) { return '加一欄' + (e.name ? '「' + snippet(e.name, 10) + '」' : ''); }, function (s, e) {
      var sh = need(s, e); if (!sh) { return NOS; } if (sh.locked) { return { error: 'the sheet is locked' }; } if (sh.cols.length >= MAXCOLS) { return { error: 'too many columns' }; }
      var at = e.after === 'start' ? 0 : (e.after == null || e.after === 'end' ? sh.cols.length : colRef(sh, e.after) + 1); if (at < 0) { return { error: 'no such column' }; } var id = newColId(sh); sh.cols.splice(at, 0, { id: id });
      if (s.format === 'xlsx' && hasFormula(sh)) { shiftAll(sh, 'c', at, 1); }
      var vals = Array.isArray(e.values) ? e.values : null; if (e.name != null && sh.rows.length === 0) { sh.rows.push({ id: newRowId(sh), c: {} }); } if (e.name != null && sh.rows[0]) { setVal(s, sh, 0, id, String(e.name)); }
      var from = e.name != null ? 1 : 0; for (var r = from; r < sh.rows.length; r++) { if (e.formula != null && s.format === 'xlsx') { sh.rows[r].c[id] = { f: String(e.formula).replace(/^=/, '').replace(/\{r\}/g, String(r + 1)), v: '' }; } else if (vals && vals[r - from] != null) { setVal(s, sh, r, id, String(vals[r - from])); } else if (e.value != null) { setVal(s, sh, r, id, String(e.value)); } }
      return {};
    }),
    del_col: A(function (e) { return '刪掉欄 ' + e.col; }, function (s, e) {
      var sh = need(s, e); if (!sh) { return NOS; } if (sh.locked) { return { error: 'the sheet is locked' }; } var c = colRef(sh, e.col); if (c < 0) { return { error: 'no such column' }; } if (sh.cols.length <= 1) { return { error: 'cannot delete the last column' }; }
      var id = sh.cols[c].id; sh.cols.splice(c, 1); sh.rows.forEach(function (r) { delete r.c[id]; }); if (s.format === 'xlsx' && hasFormula(sh)) { shiftAll(sh, 'c', c, -1); } return {};
    }),
    move_col: A(function (e) { return '移動欄 ' + e.col; }, function (s, e) {
      var sh = need(s, e); if (!sh) { return NOS; } if (sh.locked) { return { error: 'the sheet is locked' }; } if (s.format === 'xlsx' && hasFormula(sh)) { return { error: 'this sheet has formulas; moving a column would break their references' }; } var c = colRef(sh, e.col); if (c < 0) { return { error: 'no such column' }; }
      var col = sh.cols.splice(c, 1)[0], to = e.to === 'start' ? 0 : e.to === 'end' ? sh.cols.length : colRef(sh, e.to) + 1; if (to < 0) { sh.cols.splice(c, 0, col); return { error: 'no such target column' }; } sh.cols.splice(to, 0, col); return {};
    }),
    set_width: A(function (e) { return '欄寬 ' + e.col; }, function (s, e) { var sh = need(s, e); if (!sh) { return NOS; } var c = colRef(sh, e.col); if (c < 0) { return { error: 'no such column' }; } var w = Number(e.w); if (!(w > 0)) { delete sh.cols[c].w; } else { sh.cols[c].w = Math.min(500, w); } return {}; }),
    add_row: A(function (e) { return '加一列'; }, function (s, e) {
      var sh = need(s, e); if (!sh) { return NOS; } if (sh.locked) { return { error: 'the sheet is locked' }; } if (sh.rows.length >= MAXROWS) { return { error: 'too many rows' }; }
      var at = e.after === 'start' ? 0 : (e.after == null || e.after === 'end' ? sh.rows.length : rowRef(sh, e.after) + 1); if (at < 0) { return { error: 'no such row' }; } var row = { id: newRowId(sh), c: {} }; sh.rows.splice(at, 0, row);
      if (s.format === 'xlsx' && hasFormula(sh)) { shiftAll(sh, 'r', at, 1); } var vals = Array.isArray(e.values) ? e.values : []; for (var j = 0; j < Math.min(vals.length, sh.cols.length); j++) { if (vals[j] != null) { setVal(s, sh, at, sh.cols[j].id, String(vals[j])); } } return {};
    }),
    del_rows: A(function (e) { return '刪列'; }, function (s, e) {
      var sh = need(s, e); if (!sh) { return NOS; } if (sh.locked) { return { error: 'the sheet is locked' }; } var kill = {}, first = sh.header ? 1 : 0, i;
      if (Array.isArray(e.rows)) { e.rows.forEach(function (x) { var r = rowRef(sh, x); if (r >= 0) { kill[r] = 1; } }); }
      if (e.blank) { for (i = first; i < sh.rows.length; i++) { if (!Object.keys(sh.rows[i].c).length) { kill[i] = 1; } } }
      if (e.duplicates) { var cs = Array.isArray(e.duplicates.cols) ? e.duplicates.cols.map(function (x) { return colRef(sh, x); }).filter(function (x) { return x >= 0; }) : sh.cols.map(function (_, j) { return j; }), seen = {}; for (i = first; i < sh.rows.length; i++) { var key = JSON.stringify(cs.map(function (j) { return cellStr(sh.rows[i].c[sh.cols[j].id]); })); if (seen[key]) { kill[i] = 1; } else { seen[key] = 1; } } }
      if (e.where && typeof e.where === 'object') { var wc = colRef(sh, e.where.col); if (wc < 0) { return { error: 'no such column in where' }; } var op = String(e.where.op || '='), val = String(e.where.value == null ? '' : e.where.value);
        for (i = first; i < sh.rows.length; i++) { var t = cellStr(sh.rows[i].c[sh.cols[wc].id]), nt = Number(t), nv = Number(val), hit = op === '=' ? t === val : op === '!=' ? t !== val : op === 'contains' ? t.toLowerCase().indexOf(val.toLowerCase()) >= 0 : op === 'empty' ? t === '' : op === '>' ? isFinite(nt) && isFinite(nv) && nt > nv : op === '<' ? isFinite(nt) && isFinite(nv) && nt < nv : op === '>=' ? isFinite(nt) && isFinite(nv) && nt >= nv : op === '<=' ? isFinite(nt) && isFinite(nv) && nt <= nv : false; if (hit) { kill[i] = 1; } } }
      var idx = Object.keys(kill).map(Number).sort(function (a, b) { return b - a; }); if (!idx.length) { return { error: 'no rows matched' }; }
      var xl = s.format === 'xlsx' && hasFormula(sh); idx.forEach(function (r) { sh.rows.splice(r, 1); if (xl) { shiftAll(sh, 'r', r, -1); } }); return {};
    }),
    move_row: A(function (e) { return '移動列'; }, function (s, e) {
      var sh = need(s, e); if (!sh) { return NOS; } if (sh.locked) { return { error: 'the sheet is locked' }; } if (s.format === 'xlsx' && hasFormula(sh)) { return { error: 'this sheet has formulas; moving a row would break their references' }; } var r = rowRef(sh, e.row); if (r < 0) { return { error: 'no such row' }; }
      var row = sh.rows.splice(r, 1)[0], to = e.to === 'start' ? 0 : e.to === 'end' ? sh.rows.length : rowRef(sh, e.to) + 1; if (to < 0) { sh.rows.splice(r, 0, row); return { error: 'no such target row' }; } sh.rows.splice(to, 0, row); return {};
    }),
    sort: A(function (e) { return '依「' + e.col + '」' + (e.dir === 'desc' ? '由大到小' : '由小到大') + '排序'; }, function (s, e) {
      var sh = need(s, e); if (!sh) { return NOS; } if (sh.locked) { return { error: 'the sheet is locked' }; } if (s.format === 'xlsx' && hasFormula(sh)) { return { error: 'this sheet has formulas; sorting would break their references' }; } var c = colRef(sh, e.col); if (c < 0) { return { error: 'no such column' }; }
      var id = sh.cols[c].id, first = sh.header ? 1 : 0, head = sh.rows.slice(0, first), body = sh.rows.slice(first), dir = e.dir === 'desc' ? -1 : 1;
      var idx = body.map(function (r, i) { return { r: r, i: i }; }); idx.sort(function (a, b) { var d = cmpVals(a.r.c[id], b.r.c[id], e.numeric); var ea = raw(a.r.c[id]) === undefined || raw(a.r.c[id]) === '', eb = raw(b.r.c[id]) === undefined || raw(b.r.c[id]) === ''; if (ea || eb) { return d || a.i - b.i; } return d * dir || a.i - b.i; });
      sh.rows = head.concat(idx.map(function (x) { return x.r; })); return {};
    }),
    set_header: A(function (e) { return e.header === false ? '第一列不當標題' : '第一列當標題'; }, function (s, e) { var sh = need(s, e); if (!sh) { return NOS; } sh.header = e.header !== false; return {}; }),
    trim: A(function (e) { return '去掉前後空白'; }, function (s, e) { var sh = need(s, e); if (!sh) { return NOS; } if (sh.locked) { return { error: 'the sheet is locked' }; } var cs = e.col != null ? [colRef(sh, e.col)] : sh.cols.map(function (_, j) { return j; }); if (cs.some(function (x) { return x < 0; })) { return { error: 'no such column' }; } var n = 0;
      sh.rows.forEach(function (r) { cs.forEach(function (j) { var id = sh.cols[j].id, x = r.c[id]; if (typeof x === 'string' && x !== x.trim().replace(/[ \t]+/g, ' ')) { r.c[id] = x.trim().replace(/[ \t]+/g, ' '); if (r.c[id] === '') { delete r.c[id]; } n++; } }); }); return n ? {} : { error: 'nothing to trim' }; }),
    replace_all: A(function (e) { return '全部取代「' + snippet(e.find, 12) + '」→「' + snippet(e.repl, 12) + '」'; }, function (s, e) {
      var find = String(e.find == null ? '' : e.find), repl = String(e.repl == null ? '' : e.repl); if (!find) { return { error: 'find must not be empty' }; } var re;
      try { re = e.regex ? new RegExp(find, e.caseSensitive ? 'g' : 'gi') : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), e.caseSensitive ? 'g' : 'gi'); } catch (x) { return { error: 'bad pattern: ' + x.message }; }
      var n = 0; s.objects.forEach(function (sh) { if (sh.locked || (e.sheet != null && e.sheet !== '' && sh.id !== e.sheet && sh.name !== e.sheet)) { return; } var cs = e.col != null ? [colRef(sh, e.col)] : sh.cols.map(function (_, j) { return j; }); cs.forEach(function (j) { if (j < 0) { return; } var id = sh.cols[j].id; sh.rows.forEach(function (r) { var x = r.c[id]; if (typeof x === 'string') { var nx = x.replace(re, function () { n++; return repl; }); if (nx !== x) { r.c[id] = nx; if (nx === '') { delete r.c[id]; } } } }); }); });
      return n ? {} : { error: 'nothing found' };
    }),
    set_doc: A(function (e) { return '檔案設定'; }, function (s, e) { if (e.delim != null) { if ([',', ';', '\t', '|'].indexOf(e.delim) < 0) { return { error: 'delimiter must be , ; tab or |' }; } s.delim = e.delim; } if (e.eol != null) { s.eol = e.eol === 'crlf' || e.eol === '\r\n' ? '\r\n' : '\n'; } if (e.bom != null) { s.bom = !!e.bom; } if (e.quoteAll != null) { s.quoteAll = !!e.quoteAll; } return {}; }),
  };
  var E = O.make({
    types: types, extraOps: extraOps, keep: ['format', 'delim', 'eol', 'bom', 'finalNl', 'quoteAll', 'src', 'sig', 'notes'], limits: { objects: MAXSHEETS, canvas: 16384 },
    defaultSpec: function () { return { v: 1, title: '未命名表格', format: 'csv', delim: ',', eol: '\n', bom: false, finalNl: true, quoteAll: false, notes: [], canvas: { x: 0, y: 0, w: 800, h: 600, bg: '#ffffff' }, seq: 0, objects: [] }; },
    describeObject: function (o) { return o.type + ' ' + o.name; },
  });
  function validate(spec) {
    var src = spec && typeof spec === 'object' ? spec : {}, fmt = src.format === 'xlsx' ? 'xlsx' : 'csv', input = clone(src); (input.objects || []).forEach(function (o) { o.__csv = fmt === 'csv'; });
    var r = E.validate(input), s = r.spec; s.format = fmt; s.delim = [',', ';', '\t', '|'].indexOf(src.delim) >= 0 ? src.delim : ','; s.eol = src.eol === '\r\n' ? '\r\n' : (src.eol === '\r' ? '\r' : '\n'); s.bom = !!src.bom; s.finalNl = src.finalNl !== false; s.quoteAll = !!src.quoteAll;
    s.notes = Array.isArray(src.notes) ? src.notes.slice(0, 30).map(function (x) { return str(x, 300); }) : []; if (typeof src.src === 'string' && src.src.length <= MAXSRC + 2) { s.src = src.src; } if (typeof src.sig === 'string') { s.sig = str(src.sig, 40); }
    if (!s.objects.length) { s.objects.push(Object.assign({ id: 's1', name: 'Sheet1', type: 'sheet', visible: true, locked: false }, types.sheet.validate({ cols: [{ id: 'c1' }], rows: [{ id: 'r1', c: {} }], header: false }).obj)); }
    s.objects.forEach(function (o) { delete o.__csv; if (!o.name) { o.name = 'Sheet'; } }); return r;
  }
  function applyEdits(spec, edits, env) {
    var fmt = spec && spec.format === 'xlsx' ? 'xlsx' : 'csv', mapped = (edits || []).map(function (e) { if (e && e.op === 'add_sheet') { return { op: 'add_object', object: Object.assign({ type: 'sheet', name: e.name || 'Sheet', header: !!e.header }, e.rows ? { cols: (e.rows[0] || []).map(function (_, j) { return { id: 'c' + (j + 1) }; }), rows: e.rows.map(function (rw, i) { var c = {}; rw.forEach(function (v, j) { if (v !== '' && v != null) { c['c' + (j + 1)] = v; } }); return { id: 'r' + (i + 1), c: c }; }) } : { cols: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], rows: [{ id: 'r1', c: {} }] }) }; } if (e && e.op === 'rename_sheet') { return { op: 'rename_object', id: e.sheet || e.id, name: e.name }; } if (e && e.op === 'del_sheet') { return { op: 'remove_object', id: e.sheet || e.id }; } if (e && e.op === 'dup_sheet') { return { op: 'duplicate_object', id: e.sheet || e.id }; } return e; });
    var src2 = clone(spec); (src2.objects || []).forEach(function (o) { o.__csv = fmt === 'csv'; }); var r = E.applyEdits(src2, mapped, env); r.spec.objects.forEach(function (o) { delete o.__csv; }); r.spec.format = fmt;
    if (r.spec.objects.length === 0) { r.spec.objects = clone(spec.objects).slice(0, 1); r.rejected.push({ op: 'remove_object', error: 'a workbook needs at least one sheet' }); }
    return r;
  }
  // ───── 程式讀得懂的白話（不經過模型）。「第 N 列」「B 欄」「「單價」那一欄」從目前（第一張）工作表算
  var ZH = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  function parseCommands(text, spec) {
    var out = { edits: [], matched: [], unmatched: [] }, s = validate(spec).spec, sh = s.objects[0];
    function col(r) { r = String(r || '').trim().replace(/^第\s*/, '').replace(/\s*(?:欄|欄位|那一欄|這一欄|列)$/, '').replace(/^[「"'『]|[」"'』]$/g, '').trim(); var i = colRef(sh, r); return i >= 0 ? sh.cols[i].id : null; }
    function rowNo(r) { r = String(r || '').trim(); var m = /^(?:第\s*)?(\d+)\s*(?:列|行)?$/.exec(r); if (m) { return Number(m[1]); } if (/^(最後|最後一列|最後一行)$/.test(r)) { return sh.rows.length; } if (/^(最前|第一列|第一行|標題列|開頭)$/.test(r)) { return 1; } return 0; }
    var clauses = String(text || '').split(/[。；;\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    clauses.forEach(function (c) {
      var m, e = null, cid, rn;
      if ((m = /^(?:把)?\s*(.+?)\s*(?:欄)?\s*(?:由大到小|從大到小|降冪|遞減)\s*排序$/.exec(c)) || (m = /^(?:依|按|照)\s*(.+?)\s*(?:欄)?\s*(?:由大到小|從大到小|降冪|遞減)\s*排序$/.exec(c))) { cid = col(m[1]); if (cid) { e = { op: 'sort', col: cid, dir: 'desc' }; } }
      else if ((m = /^(?:把)?\s*(.+?)\s*(?:欄)?\s*(?:由小到大|從小到大|升冪|遞增|排序)$/.exec(c)) || (m = /^(?:依|按|照)\s*(.+?)\s*(?:欄)?\s*(?:由小到大|從小到大|升冪|遞增)?\s*排序$/.exec(c))) { cid = col(m[1].replace(/排序$/, '')); if (cid) { e = { op: 'sort', col: cid, dir: 'asc' }; } }
      else if (/^(?:刪掉|刪除|移除|拿掉)\s*(?:所有的?)?(?:空白列|空列|空白行|空行)$/.test(c)) { e = { op: 'del_rows', blank: true }; }
      else if (/^(?:去掉|刪掉|刪除|移除)\s*(?:重複|重複的列|重複列|重複的資料)$/.test(c) || /^(?:去除重複|去重|去重複)$/.test(c)) { e = { op: 'del_rows', duplicates: {} }; }
      else if (/^(?:去掉|去除|刪掉)\s*(?:前後|多餘的?)?空白$/.test(c)) { e = { op: 'trim' }; }
      else if ((m = /^(?:把|將)?\s*第\s*(\d+)\s*(?:列|行)\s*(?:到|至|~|－|-)\s*第?\s*(\d+)\s*(?:列|行)?\s*(?:刪掉|刪除|移除)$/.exec(c))) { var rs = []; for (var q = Number(m[1]); q <= Math.min(Number(m[2]), Number(m[1]) + 5000); q++) { rs.push(q); } e = { op: 'del_rows', rows: rs }; }
      else if ((m = /^(?:把|將)?\s*(?:第\s*)?(\d+)\s*(?:列|行)\s*(?:刪掉|刪除|移除)$/.exec(c)) || (m = /^(?:刪掉|刪除|移除)\s*第\s*(\d+)\s*(?:列|行)$/.exec(c))) { e = { op: 'del_rows', rows: [Number(m[1])] }; }
      else if ((m = /^(?:把|將)?\s*(.+?)\s*(?:欄|欄位)\s*(?:刪掉|刪除|移除)$/.exec(c)) || (m = /^(?:刪掉|刪除|移除)\s*(.+?)\s*(?:欄|欄位)$/.exec(c))) { cid = col(m[1]); if (cid) { e = { op: 'del_col', col: cid }; } }
      else if ((m = /^(?:刪掉|刪除|移除)\s*(?:所有)?[「"'『]?(.+?)[」"'』]?\s*(?:欄|欄位)?\s*(?:是|為|等於)\s*[「"'『]?(.+?)[」"'』]?\s*的列$/.exec(c))) { cid = col(m[1]); if (cid) { e = { op: 'del_rows', where: { col: cid, op: '=', value: m[2] } }; } }
      else if ((m = /^(?:在)?\s*最後\s*(?:加|新增)\s*一?(?:列|行)(?:\s*[：:]\s*(.+))?$/.exec(c))) { e = { op: 'add_row', after: 'end' }; if (m[1]) { e.values = m[1].split(/[,，、\t]/).map(function (x) { return x.trim(); }); } }
      // 只收看起來真的是公式的；「單價乘數量」這種用標題名字寫的交給離線 harness 推導
      else if ((m = /^(?:在)?\s*最後\s*(?:加|新增)\s*一?欄\s*[「"'『]?(.+?)[」"'』]?\s*(?:=|＝|等於|公式)\s*([A-Za-z0-9$.:(),+\-*/^&<>=" ]+)$/.exec(c)) && s.format === 'xlsx') { e = { op: 'add_col', after: 'end', name: m[1], formula: m[2].replace(/^=/, '') }; }
      else if ((m = /^(?:在)?\s*最後\s*(?:加|新增)\s*一?欄(?:\s*[「"'『]?(.+?)[」"'』]?)?$/.exec(c)) && !/[」』"'=＝]|等於|公式/.test(m[1] || '')) { e = { op: 'add_col', after: 'end', name: m[1] || '新欄位' }; }
      else if ((m = /^(?:把)?\s*([A-Za-z]{1,3}\s*\d{1,6})\s*(?:改成|換成|改為|設成|設為|=|＝)\s*(.+)$/.exec(c))) { var ad = FX.addr(m[1].replace(/\s+/g, '')); if (ad && ad.c < MAXCOLS) { var v = m[2].trim().replace(/^[「"'『]|[」"'』]$/g, ''); e = /^=/.test(v) && s.format === 'xlsx' ? { op: 'set_cell', row: ad.r + 1, col: FX.colLetter(ad.c), f: v } : { op: 'set_cell', row: ad.r + 1, col: FX.colLetter(ad.c), v: v }; } }
      else if ((m = /^(?:把)?\s*第\s*(\d+)\s*(?:列|行)\s*[「"'『]?(.+?)[」"'』]?\s*(?:欄)?\s*(?:改成|換成|改為|設成)\s*(.+)$/.exec(c))) { cid = col(m[2]); if (cid) { e = { op: 'set_cell', row: Number(m[1]), col: cid, v: m[3].trim().replace(/^[「"'『]|[」"'』]$/g, '') }; } }
      else if ((m = /^(?:把)?\s*[「"'『](.+?)[」"'』]\s*(?:全部)?(?:都)?(?:改成|換成|改為|取代成)\s*[「"'『]?(.*?)[」"'』]?$/.exec(c)) || (m = /^(?:把|將)\s*(.+?)\s*全部(?:都)?(?:改成|換成|取代成|取代為)\s*(.+)$/.exec(c))) { e = { op: 'replace_all', find: m[1].replace(/^[「"'『]|[」"'』]$/g, ''), repl: m[2].replace(/^[「"'『]|[」"'』]$/g, '') }; }
      else if ((m = /^(?:把)?\s*第一列\s*(?:當|當作|設為|設成)\s*(?:標題|表頭)$/.exec(c))) { e = { op: 'set_header', header: true }; }
      else if (/^(?:第一列|標題列)\s*(?:不是|不要當|不當)\s*(?:標題|表頭)?$/.test(c)) { e = { op: 'set_header', header: false }; }
      if (e) { out.edits.push(e); out.matched.push(c); } else { out.unmatched.push(c); }
    });
    return out;
  }
  var AI_OPS = ['set_cell', 'fill_col', 'add_col', 'del_col', 'move_col', 'add_row', 'del_rows', 'move_row', 'sort', 'set_header', 'trim', 'replace_all', 'set_width', 'add_sheet', 'rename_sheet', 'del_sheet', 'dup_sheet', 'set_title'];
  // 給模型的提示：只給「概要」（欄位字母＋標題＋型別＋樣本列），不把整份文件丟過去
  function profile(sh, nSample) {
    var vals = computed(sh), first = sh.header ? 1 : 0, cols = sh.cols.map(function (c, j) { var seen = 0, nums = 0, empty = 0, samples = []; for (var i = first; i < sh.rows.length; i++) { var v = vals[i][j]; if (v === '' || v == null) { empty++; continue; } seen++; if (typeof v === 'number' || (v !== '' && isFinite(Number(String(v).replace(/,/g, ''))))) { nums++; } if (samples.length < 3 && samples.indexOf(String(v)) < 0) { samples.push(String(v).slice(0, 24)); } } return { letter: FX.colLetter(j), name: headerText(sh, j), type: seen && nums === seen ? 'number' : 'text', empty: empty, samples: samples }; });
    return { rows: sh.rows.length, cols: cols, head: sh.rows.slice(0, nSample || 5).map(function (r, i) { return sh.cols.map(function (c, j) { return String(vals[i][j] == null ? '' : vals[i][j]).slice(0, 24); }); }) };
  }
  function editPrompt(spec, request, selection, o) {
    var s = validate(spec).spec, lines = s.objects.map(function (sh) { var p = profile(sh, 5); return 'Sheet id=' + sh.id + ' name="' + sh.name + '" rows=' + p.rows + (sh.header ? ' (row 1 is the header)' : '') + '\n  columns: ' + p.cols.map(function (c) { return c.letter + (c.name ? '="' + c.name + '"' : '') + ':' + c.type + (c.samples.length ? ' e.g. ' + c.samples.map(function (x) { return JSON.stringify(x); }).join(',') : ''); }).join('; ') + '\n  first rows:\n' + p.head.map(function (r) { return '    ' + r.join(' | '); }).join('\n'); });
    var system = 'You edit a ' + (s.format === 'xlsx' ? 'spreadsheet' : 'CSV table') + ' by answering ONLY with JSON {"say":"one short sentence","edits":[...]}. Rows are numbered from 1 (row 1 is the first row of the sheet); columns are letters (A, B, ...) or header names. Every edit is one of these actions (sheet is optional = the first sheet; never invent columns or sheets):\n'
      + '{op:"set_cell",row,col,v' + (s.format === 'xlsx' ? '|f' : '') + '} one cell' + (s.format === 'xlsx' ? ' (f is a formula without the leading = like SUM(B2:B9); supported: + - * / ^ & comparison, SUM AVERAGE MIN MAX COUNT COUNTA IF IFERROR AND OR NOT ROUND ABS INT MOD SQRT POWER CONCAT LEN LEFT RIGHT MID UPPER LOWER TRIM VLOOKUP SUMIF COUNTIF TODAY)' : '') + '\n'
      + '{op:"fill_col",col,value|series:{start,step}' + (s.format === 'xlsx' ? '|formula:"B{r}*C{r}"' : '') + ',from?,to?} fill a column (from/to are row numbers)\n{op:"add_col",after:"start|end|<col>",name,value?' + (s.format === 'xlsx' ? ',formula?' : '') + '}  {op:"del_col",col}  {op:"move_col",col,to:"start|end|<col>"}  {op:"set_width",col,w}\n'
      + '{op:"add_row",after:"start|end|<row number>",values?:[...]}  {op:"del_rows",rows?:[numbers],blank?:true,duplicates?:{cols?},where?:{col,op:"=|!=|contains|empty|>|<|>=|<=",value}}  {op:"move_row",row,to}\n'
      + '{op:"sort",col,dir:"asc|desc"}  {op:"set_header",header:true|false}  {op:"trim",col?}  {op:"replace_all",find,repl,col?,regex?}  {op:"add_sheet",name,rows?:[[...]]}  {op:"rename_sheet",sheet,name}  {op:"del_sheet",sheet}  {op:"dup_sheet",sheet}\n'
      + 'Change only what was asked; keep the rest untouched. If the request cannot be done with these actions, return {"say":"why","edits":[]}.';
    return { system: system, user: (s.title ? 'File "' + s.title + '"\n' : '') + lines.join('\n') + (selection ? '\nSelected: ' + selection : '') + '\n\nRequest: ' + String(request || '') };
  }
  function parseEditsReply(text) { return O.parseEditsReply(text, AI_OPS); }
  var STARTERS = [
    { id: 'blank', label: '空白表格', desc: '3 欄、1 列，從零開始。', spec: function () { var sp = parseCsv('A,B,C\n,,\n', '未命名表格'); delete sp.src; return sp; } },
    { id: 'sheet', label: '空白試算表', desc: '空白的活頁簿（xlsx），可以用公式。', spec: function () { var sh = newSheet('Sheet1', [['', '', ''], ['', '', '']], { id: 's1', header: false }); return { v: 1, title: '未命名試算表', format: 'xlsx', objects: [sh] }; } },
    { id: 'budget', label: '收支表（xlsx，有公式）', desc: '日期、項目、收入、支出、餘額（公式）。', spec: function () { var rows = [['日期', '項目', '收入', '支出', '餘額'], ['2026-01-01', '期初', 1000, '', { f: 'C2-D2', v: 1000 }], ['2026-01-02', '午餐', '', 120, { f: 'E2+C3-D3', v: 880 }]]; var sh = newSheet('收支', rows, { id: 's1', header: true }); return { v: 1, title: '收支表', format: 'xlsx', objects: [sh] }; } },
  ];
  function starter(id) { var t = STARTERS.filter(function (x) { return x.id === id; })[0]; return t ? validate(t.spec()).spec : null; }
  function listStarters() { return STARTERS.map(function (t) { return { id: t.id, label: t.label, desc: t.desc }; }); }
  return { types: types, extraOps: extraOps, OPS: E.OPS, validate: validate, applyEdits: applyEdits, editWords: E.editWords, find: E.find, list: E.list, parseCsv: parseCsv, serializeCsv: serializeCsv, readXlsx: readXlsx, buildXlsx: buildXlsx, computed: computed, newSheet: newSheet, sigOf: sigOf, colRef: colRef, rowRef: rowRef, cellStr: cellStr, isF: isF, raw: raw, parseCommands: parseCommands, editPrompt: editPrompt, parseEditsReply: parseEditsReply, AI_OPS: AI_OPS, profile: profile, starter: starter, listStarters: listStarters, shiftFormula: shiftFormula, MAXROWS: MAXROWS, MAXCOLS: MAXCOLS };
});
