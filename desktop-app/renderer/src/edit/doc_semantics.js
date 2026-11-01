// 表格／文字／Word 編輯器的離線 harness 領域（DESIGN.edit-docs.md §7；通用核心在 renderer/src/harness/intent_harness.js）。純函式，Node 測得到。
// 一句話被細切成意圖（子句一個）→ 用編輯器的狀態推導參數（「B 欄」「單價那一欄」「最後一列」「第二段」「「背景」那一段」「選取的」→ 欄字母／區塊 id，每個推導都記在 derived[]）→ 寫成 UML 使用案例 → CoLU 單元目錄接線成工具呼叫
// → toEdit 變成編輯器自己的封閉動作（之後仍由 applyEdits 逐項檢查）。推導不出來的是缺口（封閉小問題），不猜；要模型自由寫字的（縮短、改語氣、翻譯）沒有封閉動作，明講需要 AI。
//   FaDocSemantics.stateOf(kind, spec, selection) → state    decompose(domain, text, state) → { intents, gaps, derived }    TOOLS → { 工具名: { domain, desc, props, required } }    toEdit(tool, args, fmt) → 封閉動作
//   領域：'sheet'（csv+xlsx）、'text'（md+txt）、'doc'（docx，含 text 的全部加上樣式與分頁）。state：sheet { format, header, rows, cols:[{letter,name,type}], sheets:[名稱] }；text／doc { format, blocks:[{id,n,type,text,level,ordered}], selection }
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(require('../harness/intent_harness.js')); } else { root.FaDocSemantics = factory(root.FaHarness || (typeof FaHarness !== 'undefined' ? FaHarness : undefined)); } }(typeof self !== 'undefined' ? self : this, function (FH) {
  'use strict';
  var CN = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  function cn(s) { s = String(s == null ? '' : s).trim(); if (/^\d+$/.test(s)) { return Number(s); } var m = /^([一二兩三四五六七八九])?十([一二三四五六七八九])?$/.exec(s); if (m) { return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0); } return s.length === 1 && CN[s] != null ? CN[s] : null; }
  var NUM = '(\\d+|[一二兩三四五六七八九十]+)', Q = '[「『“"\'](.+?)[」』”"\']';
  var unq = function (s) { return String(s == null ? '' : s).trim().replace(/^[「『“"']|[」』”"']$/g, '').trim(); };
  function colLetter(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  // ───────── state
  function stateOf(kind, spec, selection) {
    spec = spec || {};
    if (kind === 'sheet') {
      var sh = (spec.objects || [])[0] || { cols: [], rows: [] }, hd = sh.header ? 1 : 0;
      var cols = (sh.cols || []).map(function (c, j) { var name = '', nums = 0, seen = 0; if (sh.rows && sh.rows[0]) { var x = sh.rows[0].c[c.id]; name = x && typeof x === 'object' && x.f !== undefined ? '' : (x == null ? '' : String(x)); } for (var i = hd; i < Math.min((sh.rows || []).length, 200); i++) { var v = sh.rows[i].c[c.id]; v = v && typeof v === 'object' ? v.v : v; if (v === undefined || v === '' || v === null) { continue; } seen++; if (typeof v === 'number' || isFinite(Number(String(v).replace(/,/g, '')))) { nums++; } } return { letter: colLetter(j), name: name, type: seen && nums === seen ? 'number' : 'text' }; });
      return { format: spec.format || 'csv', header: !!sh.header, rows: (sh.rows || []).length, cols: cols, sheets: (spec.objects || []).map(function (o) { return o.name; }), xlsx: spec.format === 'xlsx' };
    }
    var bl = (spec.objects || []).map(function (b, i) { var text = b.type === 'table' ? (b.rows || []).map(function (r) { return r.join(' '); }).join(' ') : b.type === 'list' ? (b.items || []).join(' ') : (b.text != null ? b.text : (b.runs || []).map(function (r) { return r.t; }).join('')); return { id: b.id, n: i + 1, type: b.type, text: String(text || ''), level: b.level, ordered: !!b.ordered }; });
    return { format: spec.format || 'md', blocks: bl, selection: selection || null };
  }
  // ───────── 參照：欄、列、區塊
  function colOf(phrase, st) {
    var r = unq(phrase).replace(/(?:那一欄|這一欄|那欄|這欄|欄位|欄|那一|這一)$/, '').trim(), cols = st.cols || [], i, m;
    if (!r || !cols.length) { return null; }
    if (/^(最後|最後一)$/.test(r)) { var l = cols[cols.length - 1]; return { ref: l.letter, why: '最後一欄 = ' + l.letter + ' 欄' }; } if (/^(第一|最前|最左)$/.test(r)) { return { ref: 'A', why: '第一欄 = A 欄' }; }
    if ((m = /^第?\s*(\d+|[一二兩三四五六七八九十]+)$/.exec(r)) && !/^[A-Za-z]/.test(r)) { var n = cn(m[1]); if (n && n <= cols.length) { return { ref: colLetter(n - 1), why: '第 ' + n + ' 欄 = ' + colLetter(n - 1) + ' 欄' }; } }
    if (/^[A-Za-z]{1,2}$/.test(r) && cols.some(function (c) { return c.letter === r.toUpperCase(); }) && !cols.some(function (c) { return c.name.toLowerCase() === r.toLowerCase(); })) { return { ref: r.toUpperCase(), why: '' }; }
    var low = r.toLowerCase(); for (i = 0; i < cols.length; i++) { if (cols[i].name.toLowerCase() === low) { return { ref: cols[i].letter, why: '「' + r + '」那一欄 = ' + cols[i].letter + ' 欄' }; } }
    var hit = cols.filter(function (c) { return c.name && (c.name.toLowerCase().indexOf(low) >= 0 || low.indexOf(c.name.toLowerCase()) >= 0 && c.name.length >= 2); }); if (hit.length === 1) { return { ref: hit[0].letter, why: '「' + r + '」那一欄 ≈ 「' + hit[0].name + '」(' + hit[0].letter + ' 欄)' }; }
    return null;
  }
  function blockOf(phrase, st) {
    var raw = String(phrase == null ? '' : phrase).trim().replace(/(?:那一段|這一段|那一個|這一個|那一行|這一行|的段落|那段|這段)$/, '').trim(), r = unq(raw), bl = st.blocks || [], m, hits;
    if (!bl.length) { return null; }
    if (/^(選取的|選到的|選著的|這個|這一個|這一段|這段|目前選的|選取|這)$/.test(r) || /^(?:選取的|選到的)/.test(r) || /^(?:選取的|選到的|這一段|這段)$/.test(String(phrase).trim())) { var sel = bl.filter(function (b) { return b.id === st.selection; })[0]; return sel ? { id: sel.id, why: '「選取的」= 第 ' + sel.n + ' 個區塊' } : { gap: '現在沒有選取任何區塊（先點一下要改的那一段）' }; }
    if ((m = new RegExp('^第?\\s*' + NUM + '\\s*(?:個|段|節|行|項|區塊|號)?$').exec(r))) { var n = cn(m[1]); if (n >= 1 && n <= bl.length) { return { id: bl[n - 1].id, why: '第 ' + n + ' 個區塊' }; } return { gap: '只有 ' + bl.length + ' 個區塊，沒有第 ' + n + ' 個' }; }
    if (/^(最後|最後一段|最後一個|最後一行|結尾|最末)$/.test(r)) { return { id: bl[bl.length - 1].id, why: '最後一個 = 第 ' + bl.length + ' 個區塊' }; }
    if (/^(第一|第一段|第一個|第一行|開頭|最前面)$/.test(r)) { return { id: bl[0].id, why: '第一個區塊' }; }
    if ((m = /^標題\s*[「『“"'](.+?)[」』”"']$/.exec(raw)) || (m = /^[「『“"'](.+?)[」』”"']$/.exec(raw)) || (m = /^標題\s*(.+)$/.exec(r)) || (r.length >= 2 && !/^第|^最|^選/.test(r) && (m = [0, r]))) {
      var q = m[1].toLowerCase(), heads = bl.filter(function (b) { return b.type === 'heading' && b.text.toLowerCase().indexOf(q) >= 0; }); if (heads.length === 1) { return { id: heads[0].id, why: '標題「' + heads[0].text.slice(0, 16) + '」= 第 ' + heads[0].n + ' 個區塊' }; }
      hits = bl.filter(function (b) { return b.text.toLowerCase().indexOf(q) >= 0; }); if (hits.length === 1) { return { id: hits[0].id, why: '含「' + m[1] + '」的區塊 = 第 ' + hits[0].n + ' 個' }; } if (hits.length > 1) { return { gap: '有 ' + hits.length + ' 個區塊含「' + m[1] + '」（第 ' + hits.slice(0, 5).map(function (b) { return b.n; }).join('、') + ' 個…），要哪一個？說「第 N 段」' }; }
      return { gap: '找不到含「' + m[1] + '」的區塊' };
    }
    return null;
  }
  // ───────── 領域的操作（UML 的操作名）：params 的名字就是工具的參數名（CoLU 接線依名字填）
  var SHEET_OPS = {
    setCell: { tool: 'sheet_set_cell', params: 'row:str,col:str,value:str,formula:str', ret: 'bool' }, fillColumn: { tool: 'sheet_fill_column', params: 'col:str,value:str,formula:str', ret: 'bool' }, addColumn: { tool: 'sheet_add_column', params: 'name:str,after:str,formula:str,value:str', ret: 'bool' },
    deleteColumn: { tool: 'sheet_delete_column', params: 'col:str', ret: 'bool' }, moveColumn: { tool: 'sheet_move_column', params: 'col:str,to:str', ret: 'bool' }, addRow: { tool: 'sheet_add_row', params: 'after:str,values:str', ret: 'bool' },
    deleteRows: { tool: 'sheet_delete_rows', params: 'rows:str,blank:bool,duplicates:bool,where_col:str,where_op:str,where_value:str', ret: 'bool' }, sortBy: { tool: 'sheet_sort', params: 'col:str,dir:str', ret: 'bool' }, setHeader: { tool: 'sheet_set_header', params: 'header:bool', ret: 'bool' },
    trimCells: { tool: 'sheet_trim', params: 'col:str', ret: 'bool' }, replaceAll: { tool: 'sheet_replace_all', params: 'find:str,repl:str,col:str', ret: 'bool' }, addSheet: { tool: 'sheet_add_sheet', params: 'name:str', ret: 'bool' }, renameSheet: { tool: 'sheet_rename_sheet', params: 'sheet:str,name:str', ret: 'bool' },
    deleteSheet: { tool: 'sheet_delete_sheet', params: 'sheet:str', ret: 'bool' }, duplicateSheet: { tool: 'sheet_duplicate_sheet', params: 'sheet:str', ret: 'bool' },
  };
  var TEXT_OPS = {
    setText: { tool: 'text_set_text', params: 'id:str,text:str', ret: 'bool' }, setHeading: { tool: 'text_set_heading', params: 'id:str,level:int', ret: 'bool' }, toList: { tool: 'text_list', params: 'id:str,ordered:bool', ret: 'bool' }, unList: { tool: 'text_list', params: 'id:str,off:bool', ret: 'bool' },
    removeBlock: { tool: 'text_remove_block', params: 'id:str', ret: 'bool' }, addBlock: { tool: 'text_add_block', params: 'after:str,type:str,text:str,level:int', ret: 'bool' }, moveBlock: { tool: 'text_move_block', params: 'id:str,to:str', ret: 'bool' }, replaceAll: { tool: 'text_replace_all', params: 'find:str,repl:str', ret: 'bool' },
  };
  var DOC_OPS = (function () { var o = {}; Object.keys(TEXT_OPS).forEach(function (k) { o[k] = { tool: TEXT_OPS[k].tool.replace(/^text_/, 'doc_'), params: TEXT_OPS[k].params, ret: 'bool' }; }); o.styleBlock = { tool: 'doc_set_style', params: 'id:str,find:str,bold:bool,italic:bool,underline:bool,strike:bool,color:str,align:str', ret: 'bool' }; o.pageBreak = { tool: 'doc_page_break', params: 'after:str', ret: 'bool' }; return o; })();
  // 沒有封閉動作的（要模型自由寫字）：不假裝能做，退路工具是空的，harness 會回缺口
  var NEED_AI = { rewriteBlock: { tool: '', params: 'id:str,how:str', ret: 'bool' } }; Object.keys(NEED_AI).forEach(function (k) { TEXT_OPS[k] = NEED_AI[k]; DOC_OPS[k] = NEED_AI[k]; });
  // 單元的白話說明（中英）：接線的語意面
  var UNIT_INTENTS = {
    sheet_set_cell: '改某一格的值 設定儲存格 A1 改成 cell set value setCell', sheet_fill_column: '整欄填同一個值 填滿一欄 序列 公式 fill column fillColumn', sheet_add_column: '加一欄 新增欄位 加總價欄 add column addColumn', sheet_delete_column: '刪掉一欄 移除欄位 delete column deleteColumn', sheet_move_column: '移動欄位 調整欄的順序 move column moveColumn',
    sheet_add_row: '加一列 新增一筆資料 add row addRow', sheet_delete_rows: '刪列 刪掉空白列 去掉重複 條件式刪除 delete rows remove blank duplicates deleteRows', sheet_sort: '排序 由大到小 由小到大 依某欄排序 sort by column sortBy', sheet_set_header: '第一列當標題 標題列 header row setHeader',
    sheet_trim: '去掉前後空白 清理空白 trim whitespace trimCells', sheet_replace_all: '全部取代 查找取代 把某字換成某字 replace all find replace replaceAll', sheet_add_sheet: '新增工作表 add sheet addSheet', sheet_rename_sheet: '工作表改名 rename sheet renameSheet', sheet_delete_sheet: '刪掉工作表 delete sheet deleteSheet', sheet_duplicate_sheet: '複製工作表 duplicate sheet duplicateSheet',
  };
  ['text', 'doc'].forEach(function (p) {
    var label = p === 'doc' ? 'Word 文件' : '文件';
    UNIT_INTENTS[p + '_set_text'] = '改某一段的文字 把這段改成 修改' + label + '內容 set text replace paragraph setText'; UNIT_INTENTS[p + '_set_heading'] = '改成標題 標題層級 二級標題 heading level setHeading'; UNIT_INTENTS[p + '_list'] = '改成清單 項目符號 編號清單 取消清單 bullet numbered list toList unList'; UNIT_INTENTS[p + '_remove_block'] = '刪掉一段 移除區塊 delete paragraph remove block removeBlock';
    UNIT_INTENTS[p + '_add_block'] = '在某處加一段 新增標題 新增清單項目 add paragraph add heading insert block addBlock'; UNIT_INTENTS[p + '_move_block'] = '移動一段 往上往下 移到最前面最後面 move block moveBlock'; UNIT_INTENTS[p + '_replace_all'] = '全部取代 把某字換成某字 replace all find replace replaceAll';
  });
  UNIT_INTENTS.doc_set_style = '粗體 斜體 底線 刪除線 文字顏色 置中 靠右 格式 bold italic underline color align style styleBlock'; UNIT_INTENTS.doc_page_break = '加分頁 換頁 page break pageBreak';
  // 工具表（聊天裡的 agent、離線訓練器、CoLU 單元目錄都用同一套）：props 是 JSON Schema 屬性
  var S = { type: 'string' }, I = { type: 'integer' }, B = { type: 'boolean' };
  var TOOLS = {
    sheet_set_cell: { domain: 'sheet', desc: '在開著的 CSV／試算表編輯器改一格。row 是列號(1 起算)或列 id，col 是欄字母／標題文字，value 是新值；xlsx 可以給 formula(不含 =)。回傳 {ok, applied, rejected}', props: { row: S, col: S, value: S, formula: S }, required: ['row', 'col'] },
    sheet_fill_column: { domain: 'sheet', desc: '在開著的 CSV／試算表編輯器把一欄填成同一個值(value)或公式(formula，xlsx，{r} 換成列號)，不動標題列。回傳 {ok, applied, rejected}', props: { col: S, value: S, formula: S, from: I, to: I }, required: ['col'] },
    sheet_add_column: { domain: 'sheet', desc: '在開著的表格編輯器加一欄：name 是標題，after 是 start/end/某欄，formula(xlsx，{r} 換成列號)或 value 填滿。回傳 {ok, applied, rejected}', props: { name: S, after: S, formula: S, value: S }, required: ['name'] },
    sheet_delete_column: { domain: 'sheet', desc: '在開著的表格編輯器刪掉一欄(col＝欄字母或標題文字)。回傳 {ok, applied, rejected}', props: { col: S }, required: ['col'] },
    sheet_move_column: { domain: 'sheet', desc: '在開著的表格編輯器移動一欄：to 是 start/end/某欄(放在它後面)。回傳 {ok, applied, rejected}', props: { col: S, to: S }, required: ['col', 'to'] },
    sheet_add_row: { domain: 'sheet', desc: '在開著的表格編輯器加一列：after 是 start/end/列號，values 用逗號分隔的各欄值。回傳 {ok, applied, rejected}', props: { after: S, values: S }, required: [] },
    sheet_delete_rows: { domain: 'sheet', desc: '在開著的表格編輯器刪列：rows(列號，逗號分隔)、blank(空白列)、duplicates(重複列)、或條件 where_col／where_op(= != contains empty > < >= <=)／where_value。回傳 {ok, applied, rejected}', props: { rows: S, blank: B, duplicates: B, where_col: S, where_op: S, where_value: S }, required: [] },
    sheet_sort: { domain: 'sheet', desc: '在開著的表格編輯器依某欄排序(標題列不動；有公式的表不能排序)：dir 是 asc 或 desc。回傳 {ok, applied, rejected}', props: { col: S, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['col'] },
    sheet_set_header: { domain: 'sheet', desc: '設定表格第一列是不是標題(header true／false)。回傳 {ok, applied, rejected}', props: { header: B }, required: [] },
    sheet_trim: { domain: 'sheet', desc: '去掉表格儲存格前後多餘的空白(col 不給＝全部)。回傳 {ok, applied, rejected}', props: { col: S }, required: [] },
    sheet_replace_all: { domain: 'sheet', desc: '在開著的表格編輯器把 find 全部換成 repl(col 不給＝全部欄)。回傳 {ok, applied, rejected}', props: { find: S, repl: S, col: S }, required: ['find', 'repl'] },
    sheet_add_sheet: { domain: 'sheet', desc: '在開著的試算表編輯器新增一張工作表(name)。回傳 {ok, applied, rejected}', props: { name: S }, required: ['name'] },
    sheet_rename_sheet: { domain: 'sheet', desc: '工作表改名(sheet＝目前的名稱或 id，name＝新名稱)。回傳 {ok, applied, rejected}', props: { sheet: S, name: S }, required: ['sheet', 'name'] },
    sheet_delete_sheet: { domain: 'sheet', desc: '刪掉一張工作表(至少留一張)。回傳 {ok, applied, rejected}', props: { sheet: S }, required: ['sheet'] },
    sheet_duplicate_sheet: { domain: 'sheet', desc: '複製一張工作表。回傳 {ok, applied, rejected}', props: { sheet: S }, required: ['sheet'] },
  };
  [['text', 'Markdown／純文字'], ['doc', 'Word 文件']].forEach(function (pp) {
    var p = pp[0], L = pp[1]; function T(name, o) { TOOLS[p + '_' + name] = Object.assign({ domain: p }, o); }
    T('set_text', { desc: '在開著的' + L + '編輯器改某一段的文字(id＝區塊 id，或 n＝第幾個區塊)。回傳 {ok, applied, rejected}', props: { id: S, n: I, text: S }, required: ['text'] });
    T('set_heading', { desc: '把某個區塊改成標題(level 1-6；0＝回到一般段落)。回傳 {ok, applied, rejected}', props: { id: S, n: I, level: I }, required: ['level'] });
    T('list', { desc: '把某個區塊改成項目符號清單或編號清單(ordered)，或取消清單(off)。回傳 {ok, applied, rejected}', props: { id: S, n: I, ordered: B, off: B }, required: [] });
    T('remove_block', { desc: '刪掉' + L + '編輯器的某個區塊。回傳 {ok, applied, rejected}', props: { id: S, n: I }, required: [] });
    T('add_block', { desc: '在' + L + '編輯器加一個區塊：after 是 start/end/區塊 id，type 是 para／heading／list，text 是內容，level 是標題層級。回傳 {ok, applied, rejected}', props: { after: S, type: S, text: S, level: I }, required: ['text'] });
    T('move_block', { desc: '移動某個區塊：to 是 first／last／earlier／later。回傳 {ok, applied, rejected}', props: { id: S, n: I, to: S }, required: ['to'] });
    T('replace_all', { desc: '在' + L + '編輯器把 find 全部換成 repl。回傳 {ok, applied, rejected}', props: { find: S, repl: S }, required: ['find', 'repl'] });
  });
  TOOLS.doc_set_style = { domain: 'doc', desc: '在開著的 Word 編輯器改某個區塊的格式（find 給了就只改那段字）：bold italic underline strike color(red／blue／green／#RRGGBB) align(left center right both)。回傳 {ok, applied, rejected}', props: { id: S, n: I, find: S, bold: B, italic: B, underline: B, strike: B, color: S, align: S }, required: [] };
  TOOLS.doc_page_break = { domain: 'doc', desc: '在 Word 編輯器的某個區塊後面加分頁(after＝start/end/區塊 id)。回傳 {ok, applied, rejected}', props: { after: S }, required: [] };
  // ───────── 工具呼叫 → 編輯器的封閉動作
  function csvList(v) { return Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,，、]/).map(function (x) { return x.trim(); }); }
  function toEdit(tool, a, fmt) {
    a = a || {}; var m = /^(sheet|text|doc)_(.+)$/.exec(tool); if (!m) { return null; } var dom = m[1], name = m[2], docx = fmt === 'docx', txt = fmt === 'txt';
    if (dom === 'sheet') {
      switch (name) {
        case 'set_cell': { var e = { op: 'set_cell', row: a.row, col: a.col }; if (a.formula) { e.f = a.formula; } else { e.v = a.value == null ? '' : String(a.value); } return e; }
        case 'fill_column': { var f = { op: 'fill_col', col: a.col }; if (a.formula) { f.formula = a.formula; } else { f.value = a.value == null ? '' : String(a.value); } if (a.from != null) { f.from = a.from; } if (a.to != null) { f.to = a.to; } return f; }
        case 'add_column': return { op: 'add_col', after: a.after || 'end', name: a.name, formula: a.formula, value: a.value };
        case 'delete_column': return { op: 'del_col', col: a.col }; case 'move_column': return { op: 'move_col', col: a.col, to: a.to };
        case 'add_row': return { op: 'add_row', after: a.after || 'end', values: a.values ? csvList(a.values) : undefined };
        case 'delete_rows': { var d = { op: 'del_rows' }; if (a.rows != null) { d.rows = (Array.isArray(a.rows) ? a.rows : String(a.rows).split(/[,，]/)).map(Number).filter(function (x) { return x > 0; }); } if (a.blank) { d.blank = true; } if (a.duplicates) { d.duplicates = {}; } if (a.where_col) { d.where = { col: a.where_col, op: a.where_op || '=', value: a.where_value }; } return d; }
        case 'sort': return { op: 'sort', col: a.col, dir: a.dir === 'desc' ? 'desc' : 'asc' }; case 'set_header': return { op: 'set_header', header: a.header !== false && a.header !== 'false' };
        case 'trim': return { op: 'trim', col: a.col }; case 'replace_all': return { op: 'replace_all', find: a.find, repl: a.repl, col: a.col };
        case 'add_sheet': return { op: 'add_sheet', name: a.name }; case 'rename_sheet': return { op: 'rename_sheet', sheet: a.sheet, name: a.name }; case 'delete_sheet': return { op: 'del_sheet', sheet: a.sheet }; case 'duplicate_sheet': return { op: 'dup_sheet', sheet: a.sheet };
      } return null;
    }
    switch (name) {
      case 'set_text': return { op: 'set_text', id: a.id, text: a.text }; case 'set_heading': return { op: 'set_heading', id: a.id, level: Number(a.level) };
      case 'list': if (a.off) { return docx ? { op: 'list_toggle', id: a.id, off: true } : { op: 'convert_block', id: a.id, to: 'para' }; } return { op: 'list_toggle', id: a.id, ordered: !!a.ordered };
      case 'remove_block': return { op: 'remove_block', id: a.id }; case 'move_block': return { op: 'move_block', id: a.id, to: a.to }; case 'replace_all': return { op: 'replace_all', find: a.find, repl: a.repl };
      case 'add_block': { var t = a.type || 'para', blk; if (t === 'heading') { blk = { type: 'heading', level: Number(a.level) || 2, text: a.text }; } else if (t === 'list' || t === 'li') { blk = docx ? { type: 'li', ordered: !!a.ordered, text: a.text } : { type: 'list', ordered: !!a.ordered, items: [a.text] }; } else { blk = { type: txt ? 'line' : 'para', text: a.text }; } return { op: 'add_block', after: a.after || 'end', block: blk }; }
      case 'set_style': { var s = { op: 'set_style', id: a.id }; ['find', 'bold', 'italic', 'underline', 'strike', 'color', 'align'].forEach(function (k) { if (a[k] !== undefined && a[k] !== null && a[k] !== '') { s[k] = a[k]; } }); if (a.find) { s.all = true; } return s; }
      case 'page_break': return { op: 'add_block', after: a.after || 'end', block: { type: 'pagebreak' } };
    }
    return null;
  }
  // ───────── frames：子句 → 意圖
  var TARGET = '(.+?)';
  function sheetFrames() {
    var F = [];
    function colArg(phrase, st, gaps, derived, what) { var c = colOf(phrase, st); if (!c) { gaps.push('哪一欄' + (what ? '（' + what + '）' : '') + '？「' + unq(phrase) + '」對不到欄位（欄位：' + (st.cols || []).map(function (x) { return x.letter + (x.name ? '=' + x.name : ''); }).slice(0, 8).join('、') + '）'); return null; } if (c.why) { derived.push(c.why); } return c.ref; }
    F.push(['sort', function (c) { return /排序|由大到小|由小到大|sort/i.test(c); }, function (c, st) { var m = /(?:依|按|照|把|用|以)?\s*(.+?)\s*(?:欄|欄位)?\s*(?:由大到小|從大到小|降冪|遞減|由小到大|從小到大|升冪|遞增|大到小|小到大)?\s*(?:來)?\s*排序/.exec(c), d = [], g = []; if (!m) { return [{ op: 'sortBy', args: {}, derived: d, gaps: ['依哪一欄排序？'] }]; } var col = colArg(m[1], st, g, d); var dir = /由大到小|從大到小|降冪|遞減|大到小|倒序|反向/.test(c) ? 'desc' : 'asc'; return [{ op: 'sortBy', args: col ? { col: col, dir: dir } : { dir: dir }, derived: d, gaps: g }]; }]);
    F.push(['blank_rows', function (c) { return /(?:刪|移除|去掉|拿掉|清掉).{0,6}(?:空白|空)(?:的)?(?:列|行|資料)/.test(c); }, function () { return [{ op: 'deleteRows', args: { blank: true }, derived: ['空白列 = 每一格都是空的列'], gaps: [] }]; }]);
    F.push(['dedupe', function (c) { return /去(?:掉|除)?重複|刪(?:掉|除)?重複|重複的(?:列|資料|行)(?:刪|去|移)|dedup/i.test(c); }, function (c, st) { var m = /(?:依|按|看|只看)\s*(.+?)\s*(?:欄)?\s*去/.exec(c), a = { duplicates: true }, d = [], g = []; if (m) { var col = colArg(m[1], st, g, d); if (col) { a.where_col = undefined; a.dup_col = col; } } return [{ op: 'deleteRows', args: { duplicates: true }, derived: d.concat(a.dup_col ? ['只依 ' + a.dup_col + ' 欄判斷重複（目前工具先比對整列）'] : ['重複 = 每一格都一樣的列，留第一列']), gaps: g }]; }]);
    F.push(['trim', function (c) { return /(?:去(?:掉|除)?|刪掉|清掉|清理)\s*(?:前後|多餘|開頭結尾)?(?:的)?空白(?!列|行)|trim/i.test(c); }, function (c, st) { var m = /(.+?)\s*欄\s*(?:裡|的|內)?/.exec(c), a = {}, d = [], g = []; if (m && !/^(?:把|將|去|刪|清)/.test(unq(m[1])) ) { var col = colArg(m[1], st, g, d); if (col) { a.col = col; } } else if (/(?:把|將)\s*(.+?)\s*欄/.test(c)) { var m2 = /(?:把|將)\s*(.+?)\s*欄/.exec(c); var col2 = colArg(m2[1], st, g, d); if (col2) { a.col = col2; } } return [{ op: 'trimCells', args: a, derived: d, gaps: g }]; }]);
    F.push(['delete_rows_nth', function (c) { return /(?:刪|刪掉|刪除|移除|拿掉).{0,4}(?:第\s*\S+\s*(?:列|行)|最後\s*(?:一|幾|\d+|[二三四五六七八九十]+)\s*(?:列|行)|前\s*\S+\s*(?:列|行)|標題列)|第\s*\S+\s*(?:列|行).{0,6}(?:刪|移除|拿掉|去掉|拿走)/.test(c) && !/欄/.test(c.replace(/(?:列|行)/g, '')); }, function (c, st) {
      var m, rows = [], d = [], N = st.rows || 0;
      if ((m = new RegExp('第\\s*' + NUM + '\\s*(?:列|行)\\s*(?:到|至|~|-)\\s*第?\\s*' + NUM + '\\s*(?:列|行)?').exec(c))) { var a = cn(m[1]), b = cn(m[2]); for (var i = a; i <= Math.min(b, a + 5000); i++) { rows.push(i); } }
      else if ((m = new RegExp('最後\\s*' + NUM + '\\s*(?:列|行)').exec(c))) { var n = cn(m[1]); for (var j = Math.max(1, N - n + 1); j <= N; j++) { rows.push(j); } d.push('最後 ' + n + ' 列 = 第 ' + Math.max(1, N - n + 1) + ' 到 ' + N + ' 列（共 ' + N + ' 列）'); }
      else if (/最後(?:一)?\s*(?:列|行)/.test(c)) { rows.push(N); d.push('最後一列 = 第 ' + N + ' 列'); }
      else if ((m = new RegExp('前\\s*' + NUM + '\\s*(?:列|行)').exec(c))) { var k = cn(m[1]); for (var q = 1; q <= k; q++) { rows.push(q); } }
      else if (/標題列/.test(c)) { rows.push(1); d.push('標題列 = 第 1 列'); }
      else if ((m = new RegExp('第\\s*' + NUM + '\\s*(?:列|行)').exec(c))) { rows.push(cn(m[1])); }
      return [{ op: 'deleteRows', args: rows.length ? { rows: rows.join(',') } : {}, derived: d, gaps: rows.length ? [] : ['刪哪幾列？（說「第 3 列」或「第 3 列到第 10 列」）'] }];
    }]);
    F.push(['delete_rows_where', function (c) { return /(?:刪|刪掉|刪除|移除|拿掉|去掉).{0,4}(?:所有|全部)?.{0,24}(?:的列|的資料|的行|那幾列|的紀錄)/.test(c) && /(?:是|為|等於|含有|包含|有|大於|小於|超過|不到|少於|多於|空白|沒有填|為空)/.test(c); }, function (c, st) {
      var d = [], g = [], m, col = null, op = '=', val = '';
      if ((m = /(?:刪掉|刪除|移除|拿掉|去掉)\s*(?:所有|全部)?\s*[「『“"']?(.+?)[」』”"']?\s*(?:欄|欄位)?\s*(是|為|等於|含有|包含|大於|小於|超過|不到|少於|多於|>=|<=|≥|≤)\s*[「『“"']?(.+?)[」』”"']?\s*的(?:列|資料|行|紀錄)/.exec(c))) { col = colArg(m[1], st, g, d); var w = m[2]; op = /是|為|等於/.test(w) ? '=' : /含有|包含/.test(w) ? 'contains' : /大於|超過|多於/.test(w) ? '>' : /小於|不到|少於/.test(w) ? '<' : w === '≥' ? '>=' : w === '≤' ? '<=' : w; val = unq(m[3]); }
      else if ((m = /(?:刪掉|刪除|移除|拿掉|去掉)\s*(?:所有|全部)?\s*[「『“"']?(.+?)[」』”"']?\s*(?:欄|欄位)?\s*(?:是空的|為空|沒有填|空白)\s*的(?:列|資料|行)/.exec(c))) { col = colArg(m[1], st, g, d); op = 'empty'; }
      else if ((m = /(?:刪掉|刪除|移除|拿掉|去掉)\s*(?:所有|全部)?\s*(?:含有|包含|有)\s*[「『“"'](.+?)[」』”"']\s*的(?:列|資料|行)/.exec(c))) { return [{ op: 'deleteRows', args: {}, derived: [], gaps: ['含「' + m[1] + '」要看哪一欄？（說「X 欄含有「' + m[1] + '」的列」）'] }]; }
      if (!col && !g.length) { g.push('這句我看不出是哪一欄的條件'); } var a = {}; if (col) { a.where_col = col; a.where_op = op; if (op !== 'empty') { a.where_value = val; } d.push('條件：' + col + ' 欄 ' + op + (op === 'empty' ? '' : ' ' + val)); } return [{ op: 'deleteRows', args: a, derived: d, gaps: g }];
    }]);
    F.push(['delete_col', function (c) { return /(?:刪|刪掉|刪除|移除|拿掉).{0,8}(?:欄|欄位)|(?:欄|欄位).{0,6}(?:刪掉|刪除|移除|拿掉)/.test(c) && !/(?:列|行)$/.test(c); }, function (c, st) { var m = /(?:把|將)?\s*(?:刪掉|刪除|移除|拿掉)\s*(.+?)\s*(?:欄位|欄)\s*$/.exec(c) || /(?:把|將)\s*(.+?)\s*(?:欄位|欄)\s*(?:刪掉|刪除|移除|拿掉)/.exec(c) || /(?:刪掉|刪除|移除|拿掉)\s*(?:欄位|欄)\s*(.+)$/.exec(c), d = [], g = []; if (!m) { return [{ op: 'deleteColumn', args: {}, derived: d, gaps: ['刪哪一欄？'] }]; } var col = colArg(m[1], st, g, d); return [{ op: 'deleteColumn', args: col ? { col: col } : {}, derived: d, gaps: g }]; }]);
    F.push(['move_col', function (c) { return /(?:移到|搬到|放到|調到|挪到).{0,6}(?:最前面|最前|最左邊|最左|第一欄|最後面|最後|最右邊|最右|最後一欄)|(?:欄).{0,4}(?:移到|搬到)/.test(c) && /欄/.test(c); }, function (c, st) { var m = /(?:把|將)?\s*(.+?)\s*(?:欄位|欄)\s*(?:移到|搬到|放到|調到|挪到)\s*(最前面|最前|最左邊|最左|第一欄|最後面|最後|最右邊|最右|最後一欄)/.exec(c), d = [], g = []; if (!m) { return [{ op: 'moveColumn', args: {}, derived: d, gaps: ['要移哪一欄、移到哪裡？（說「把 X 欄移到最前面」）'] }]; } var col = colArg(m[1], st, g, d), to = /前|左|第一/.test(m[2]) ? 'start' : 'end'; return [{ op: 'moveColumn', args: col ? { col: col, to: to } : { to: to }, derived: d.concat(['「' + m[2] + '」= ' + (to === 'start' ? '最前面' : '最後面')]), gaps: g }]; }]);
    F.push(['add_col', function (c) { return /(?:加|新增|加入|插入|多加|補)\s*(?:上)?\s*(?:一|1)?\s*(?:個)?\s*(?:欄|欄位)/.test(c); }, function (c, st) {
      var d = [], g = [], a = { after: 'end' }, nm = new RegExp('(?:欄位|欄)\\s*' + Q).exec(c) || new RegExp(Q + '\\s*(?:這一|這)?(?:欄|欄位)').exec(c) || /(?:欄位|欄)\s*(?:叫|名稱為|名為|叫做)\s*(\S+?)(?:\s|=|＝|等於|，|$)/.exec(c);
      if (nm) { a.name = unq(nm[1]); } else { a.name = '新欄位'; d.push('沒說欄名：先叫「新欄位」'); }
      if (/(?:最前面|最左|開頭)/.test(c)) { a.after = 'start'; } var after = /(?:在|放在)\s*(.+?)\s*(?:欄|欄位)\s*(?:的)?\s*(?:後面|右邊|之後)/.exec(c); if (after) { var cc = colOf(after[1], st); if (cc) { a.after = cc.ref; d.push(cc.why || ('放在 ' + cc.ref + ' 欄後面')); } }
      var fm = /(?:=|＝|等於|公式\s*[:：]?|算出|為)\s*(.+)$/.exec(c.replace(nm ? nm[0] : '', ''));
      if (fm && /[×*xX乘加減除÷+\-/＋－]|SUM|AVERAGE|IF|\(/.test(fm[1])) {
        var expr = fm[1].trim(), ok = true, out = expr.replace(/[「『“"'](.+?)[」』”"']|(?:^|(?<=[×*xX乘加減除÷+\-/＋－(（\s]))([^×*xX乘加減除÷+\-/＋－()（）\s,，0-9.]+?)(?=$|[×*xX乘加減除÷+\-/＋－)）\s,，])/g, function (mm, q1, q2) { var ph = unq(q1 || q2); var cc2 = colOf(ph, st); if (!cc2) { ok = false; return mm; } d.push('「' + ph + '」= ' + cc2.ref + ' 欄'); return cc2.ref + '{r}'; });
        out = out.replace(/[×xX乘]/g, '*').replace(/[÷除]/g, '/').replace(/[＋加]/g, '+').replace(/[－減]/g, '-').replace(/（/g, '(').replace(/）/g, ')').replace(/\b([A-Z]{1,2})(\d+)\b/g, function (mm, L, n) { return mm; });
        if (!st.xlsx) { g.push('這是 CSV，不能放公式（改用 xlsx，或先說明要怎麼算好填進去）'); } else if (!ok) { g.push('公式裡有對不到欄位的字：' + expr); } else { a.formula = out.replace(/\s+/g, ''); d.push('公式 = ' + a.formula + '（{r} 換成每一列的列號）'); }
      }
      return [{ op: 'addColumn', args: a, derived: d, gaps: g }];
    }]);
    F.push(['add_row', function (c) { return /(?:加|新增|加入|插入|補)\s*(?:上)?\s*(?:一|1)?\s*(?:個)?\s*(?:列|行|筆)(?!欄)/.test(c) && !/欄/.test(c.replace(/(?:列|行)/g, 'X')) ; }, function (c, st) { var a = { after: 'end' }, d = [], m = /(?:：|:)\s*(.+)$/.exec(c); if (/(?:最前面|最上面|標題列上面|開頭)/.test(c)) { a.after = 'start'; } var mm = new RegExp('第\\s*' + NUM + '\\s*(?:列|行)\\s*(?:的)?(?:後面|之後|下面)').exec(c); if (mm) { a.after = String(cn(mm[1])); d.push('第 ' + cn(mm[1]) + ' 列後面'); } if (m) { a.values = m[1].trim(); } return [{ op: 'addRow', args: a, derived: d, gaps: [] }]; }]);
    F.push(['set_cell', function (c) { return /(?:^|[^A-Za-z])[A-Za-z]{1,2}\s*\d{1,6}\s*(?:改成|換成|改為|設成|設為|=|＝|填|寫)|第\s*\S+\s*(?:列|行).{0,14}(?:改成|換成|改為|設成|設為|填)/.test(c); }, function (c, st) {
      var d = [], g = [], m = /([A-Za-z]{1,2})\s*(\d{1,6})\s*(?:改成|換成|改為|設成|設為|=|＝|填入|填|寫成|寫)\s*(.+)$/.exec(c), a;
      if (m) { a = { row: m[2], col: m[1].toUpperCase() }; var v = unq(m[3]); if (/^[=＝]/.test(v) && st.xlsx) { a.formula = v.replace(/^[=＝]/, ''); } else { a.value = v; } return [{ op: 'setCell', args: a, derived: d, gaps: [] }]; }
      var m2 = new RegExp('(?:把)?\\s*(第\\s*' + NUM + '\\s*(?:列|行)|最後(?:一)?\\s*(?:列|行)|標題列)\\s*(?:的)?\\s*(.+?)\\s*(?:欄)?\\s*(?:改成|換成|改為|設成|設為|填入|填)\\s*(.+)$').exec(c);
      if (m2) { var rn = /最後/.test(m2[1]) ? st.rows : /標題/.test(m2[1]) ? 1 : cn(m2[2]); var colTxt = /最後|標題/.test(m2[1]) ? m2[2] : m2[3], valTxt = /最後|標題/.test(m2[1]) ? m2[3] : m2[4]; if (/最後/.test(m2[1])) { d.push('最後一列 = 第 ' + st.rows + ' 列'); } var col = colArg(colTxt, st, g, d); a = { row: String(rn) }; if (col) { a.col = col; } var vv = unq(valTxt); if (/^[=＝]/.test(vv) && st.xlsx) { a.formula = vv.replace(/^[=＝]/, ''); } else { a.value = vv; } return [{ op: 'setCell', args: a, derived: d, gaps: g }]; }
      return [{ op: 'setCell', args: {}, derived: d, gaps: ['改哪一格？（說「B2 改成 99」）'] }];
    }]);
    F.push(['fill_col', function (c) { return /(?:欄|欄位).{0,10}(?:全部|都|通通|統統)\s*(?:填|設成|設為|改成|寫)|(?:全部|整欄|整個).{0,6}(?:填|設成|設為)/.test(c) && /欄/.test(c); }, function (c, st) { var m = /(?:把|將)?\s*(.+?)\s*(?:欄位|欄)\s*(?:全部|都|通通|統統|整欄)?\s*(?:填入|填|設成|設為|改成|寫成|寫)\s*(.+)$/.exec(c), d = [], g = []; if (!m) { return [{ op: 'fillColumn', args: {}, derived: d, gaps: ['填哪一欄、填什麼？'] }]; } var col = colArg(m[1], st, g, d), v = unq(m[2]), a = col ? { col: col } : {}; if (/^[=＝]/.test(v) && st.xlsx) { a.formula = v.replace(/^[=＝]/, ''); } else { a.value = v; } return [{ op: 'fillColumn', args: a, derived: d.concat(['不動標題列']), gaps: g }]; }]);
    F.push(['replace_all', function (c) { return /(?:全部|所有|通通|都)\s*(?:改成|換成|改為|取代成|取代為|替換成)|取代|[「『“"'].+?[」』”"']\s*(?:全部|都|通通)?\s*(?:改成|換成|改為|取代成)/.test(c) && /(?:換成|取代|全部|都|通通)/.test(c); }, function (c, st) { var m = new RegExp('(?:把|將)?\\s*(?:(.+?)\\s*欄\\s*(?:裡|裡面|的|中)\\s*(?:的)?)?\\s*(?:所有的?|全部的?)?\\s*' + Q + '\\s*(?:全部|都|通通)?\\s*(?:改成|換成|改為|取代成|取代為|替換成)\\s*[「『“"\']?(.*?)[」』”"\']?$').exec(c) || /(?:把|將)\s*(\S+?)\s*(?:全部|都|通通)\s*(?:改成|換成|取代成|取代為)\s*(\S+)$/.exec(c), d = [], g = []; if (!m) { return [{ op: 'replaceAll', args: {}, derived: d, gaps: ['要把什麼換成什麼？（說「把「舊」全部換成「新」」）'] }]; } var find, repl, colT = null; if (m.length === 4) { colT = m[1]; find = m[2]; repl = m[3]; } else { find = m[1]; repl = m[2]; } var a = { find: unq(find), repl: unq(repl) }; if (colT) { var col = colArg(colT, st, g, d); if (col) { a.col = col; } } return [{ op: 'replaceAll', args: a, derived: d, gaps: g }]; }]);
    F.push(['header', function (c) { return /(?:第一列|標題列).{0,6}(?:當|當作|設為|設成|是|不是|不要當|不當)/.test(c); }, function (c) { return [{ op: 'setHeader', args: { header: !/(?:不是|不要當|不當|取消)/.test(c) }, derived: [], gaps: [] }]; }]);
    F.push(['sheet_ops', function (c) { return /工作表|分頁(?!符)/.test(c); }, function (c, st) {
      var q = new RegExp(Q).exec(c), d = [], g = [], names = st.sheets || [];
      if (/(?:新增|加入|加一個|加一張|建立|新建)/.test(c)) { return [{ op: 'addSheet', args: { name: q ? q[1] : '工作表' + (names.length + 1) }, derived: q ? [] : ['沒說名稱：叫「工作表' + (names.length + 1) + '」'], gaps: [] }]; }
      var two = new RegExp('(?:把)?\\s*(?:工作表)?\\s*' + Q + '\\s*(?:這張|這個)?(?:工作表)?\\s*(?:改名成|改名為|改成|改叫|重新命名為|重新命名成)\\s*[「『“"\']?(.+?)[」』”"\']?$').exec(c); if (two && /改名|改成|改叫|重新命名/.test(c)) { return [{ op: 'renameSheet', args: { sheet: two[1], name: unq(two[2]) }, derived: [], gaps: names.indexOf(two[1]) < 0 ? ['沒有叫「' + two[1] + '」的工作表（有：' + names.join('、') + '）'] : [] }]; }
      if (/(?:刪掉|刪除|移除)/.test(c)) { if (q) { return [{ op: 'deleteSheet', args: { sheet: q[1] }, derived: [], gaps: names.indexOf(q[1]) < 0 ? ['沒有叫「' + q[1] + '」的工作表（有：' + names.join('、') + '）'] : [] }]; } return [{ op: 'deleteSheet', args: {}, derived: [], gaps: ['刪哪一張工作表？（說「刪掉工作表「名稱」」）'] }]; }
      if (/(?:複製|拷貝|副本)/.test(c)) { var s0 = q ? q[1] : names[0]; return [{ op: 'duplicateSheet', args: { sheet: s0 }, derived: q ? [] : ['沒說哪一張：複製第一張「' + s0 + '」'], gaps: [] }]; }
      return [{ op: 'addSheet', args: {}, derived: [], gaps: ['工作表要做什麼？（新增、改名、刪除、複製）'] }];
    }]);
    return F;
  }
  // 文字／Word 區塊
  function textFrames(isDoc) {
    var F = [];
    function blk(phrase, st, g, d) { var b = blockOf(phrase, st); if (!b) { g.push('哪一段？「' + unq(phrase) + '」對不到區塊（說「第 N 段」、「最後一段」、「標題「…」那一段」，或先選取）'); return null; } if (b.gap) { g.push(b.gap); return null; } if (b.why) { d.push(b.why); } return b.id; }
    F.push(['rewrite', function (c) { return /(?:改短|縮短|簡短|精簡|拉長|擴寫|延伸|改語氣|口語|正式一點|翻成|翻譯|潤飾|改寫|(?:做成|寫成|整理成|濃縮成)摘要|摘要一下|校對|寫得更)/.test(c); }, function (c, st) { var m = /(?:把)?\s*(.+?)\s*(?:改短|縮短|精簡|拉長|擴寫|改語氣|翻成|翻譯|潤飾|改寫|摘要|校對)/.exec(c), g = ['「' + c.slice(0, 24) + '」要請 AI 自由寫字（縮短、拉長、改語氣、翻譯、潤飾），離線時請直接雙擊改字，或說程式讀得懂的句子']; return [{ op: 'rewriteBlock', args: {}, derived: [], gaps: g }]; }]);
    F.push(['replace_all', function (c) { return /(?:全部|所有|通通|都)\s*(?:改成|換成|改為|取代成|取代為|替換成)|取代|(?:把|將)\s*[「『“"'].+?[」』”"']\s*(?:改成|換成|改為)/.test(c) && !/(?:第\s*\S+\s*(?:段|個|節|行))/.test(c); }, function (c) { var m = new RegExp('(?:把|將)?\\s*(?:所有的?|全部的?)?\\s*' + Q + '\\s*(?:全部|都|通通)?\\s*(?:改成|換成|改為|取代成|取代為|替換成)\\s*[「『“"\']?(.*?)[」』”"\']?$').exec(c) || /(?:把|將)\s*(\S+?)\s*(?:全部|都|通通)\s*(?:改成|換成|取代成|取代為)\s*(\S+)$/.exec(c); if (!m) { return [{ op: 'replaceAll', args: {}, derived: [], gaps: ['要把什麼換成什麼？（說「把「舊」全部換成「新」」）'] }]; } return [{ op: 'replaceAll', args: { find: unq(m[1]), repl: unq(m[2]) }, derived: [], gaps: [] }]; }]);
    F.push(['remove', function (c) { return /(?:刪|刪掉|刪除|移除|拿掉|去掉)/.test(c) && !/(?:欄|格)/.test(c); }, function (c, st) { var m = /(?:把|將)?\s*(?:刪掉|刪除|移除|拿掉|去掉)\s*(.+)$/.exec(c) || /(?:把|將)\s*(.+?)\s*(?:刪掉|刪除|移除|拿掉|去掉)$/.exec(c), g = [], d = []; if (!m) { return [{ op: 'removeBlock', args: {}, derived: d, gaps: ['刪哪一段？'] }]; } var id = blk(m[1], st, g, d); return [{ op: 'removeBlock', args: id ? { id: id } : {}, derived: d, gaps: g }]; }]);
    if (isDoc) {
      F.push(['page_break', function (c) { return /(?:加|新增|插入)\s*(?:一個)?\s*(?:分頁|換頁|分頁符號)|換頁/.test(c); }, function (c, st) { var m = /(?:在)?\s*(.+?)\s*(?:後面|之後|下面)\s*(?:加|新增|插入)/.exec(c), g = [], d = [], a = { after: 'end' }; if (m && !/^(最後|結尾)$/.test(unq(m[1]))) { var id = blk(m[1], st, g, d); if (id) { a.after = id; } } return [{ op: 'pageBreak', args: a, derived: d, gaps: g }]; }]);
      F.push(['style', function (c) { return /(?:粗體|加粗|斜體|底線|刪除線|置中|靠左|靠右|左右對齊|(?:紅|藍|綠|黃|橘|黑|灰|紫)色?)/.test(c) && /(?:改成|變成|設成|設為|加|用|變|取消|不要|還原)/.test(c); }, function (c, st) {
        var g = [], d = [], a = {}, m = new RegExp('(?:把|將)?\\s*(?:(.+?)\\s*(?:裡|裡面|中)?的)?\\s*' + Q + '\\s*(?:這個字|這幾個字|這段字|這個詞|兩個字)?\\s*(?:改成|變成|設成|設為|加|用|變)?').exec(c), target = null, find = null;
        var tm = /(?:把|將)?\s*(第\s*\S+\s*(?:段|個|節|行|項|區塊)|最後(?:一段|一個)?|第一(?:段|個)?|選取的|這一段|這段|標題\s*[「『“"'].+?[」』”"'])\s*(?:的)?/.exec(c);
        if (tm) { target = tm[1]; } var qm = new RegExp(Q).exec(c); if (qm && !(tm && /標題/.test(tm[1]) && tm[1].indexOf(qm[1]) >= 0 && new RegExp('^標題').test(tm[1]) && qm.index > tm.index)) { if (!tm || tm[1].indexOf(qm[0]) < 0) { find = qm[1]; } }
        var id = null; if (target) { id = blk(target, st, g, d); } else if (find) { var hit = (st.blocks || []).filter(function (b) { return b.text.indexOf(find) >= 0; }); if (hit.length === 1) { id = hit[0].id; d.push('「' + find + '」在第 ' + hit[0].n + ' 個區塊'); } else if (hit.length > 1) { id = hit[0].id; d.push('「' + find + '」出現在 ' + hit.length + ' 個區塊，改每一個出現的地方'); a.multi = hit.map(function (b) { return b.id; }); } else { g.push('找不到「' + find + '」'); } } else if (st.selection) { id = st.selection; d.push('沒說哪一段：用選取的'); } else { g.push('要改哪一段的格式？（說「第 N 段」，或把要改的字放在「」裡，或先選取）'); }
        if (/粗體|加粗/.test(c)) { a.bold = !/(?:取消|不要|不是|還原)(?:粗體|加粗)|不要加粗/.test(c); } if (/斜體/.test(c)) { a.italic = !/(?:取消|不要|還原)斜體/.test(c); } if (/底線/.test(c)) { a.underline = !/(?:取消|不要|還原)底線/.test(c); } if (/刪除線/.test(c)) { a.strike = !/(?:取消|不要|還原)刪除線/.test(c); }
        var cm = /(紅|藍|綠|黃|橘|黑|灰|紫)色?/.exec(c); if (cm) { a.color = cm[1] + '色'; } if (/置中/.test(c)) { a.align = 'center'; } else if (/靠左/.test(c)) { a.align = 'left'; } else if (/靠右/.test(c)) { a.align = 'right'; } else if (/左右對齊/.test(c)) { a.align = 'both'; }
        if (find) { a.find = find; } var multi = a.multi; delete a.multi; if (!Object.keys(a).some(function (k) { return k !== 'find'; })) { g.push('要改成什麼格式？（粗體、斜體、底線、顏色、置中…）'); }
        if (multi && multi.length) { return multi.map(function (mid, i) { return { op: 'styleBlock', args: Object.assign({ id: mid }, a), derived: i === 0 ? d : [], gaps: i === 0 ? g : [] }; }); } return [{ op: 'styleBlock', args: id ? Object.assign({ id: id }, a) : a, derived: d, gaps: g }];
      }]);
    }
    F.push(['heading', function (c) { return /(?:改成|換成|變成|設成|設為|當作)\s*(?:第?\s*[1-6一二三四五六]\s*(?:級|層)標題|H[1-6]|標題\s*[1-6一二三四五六]?|大標題|小標題)/i.test(c); }, function (c, st) { var m = /(?:把|將)?\s*(.+?)\s*(?:改成|換成|變成|設成|設為|當作)\s*(?:第?\s*([1-6一二三四五六])\s*(?:級|層)標題|H([1-6])|標題\s*([1-6一二三四五六])?|(大標題)|(小標題))/i.exec(c), g = [], d = []; if (!m) { return [{ op: 'setHeading', args: {}, derived: d, gaps: ['改哪一段？'] }]; } var lv = m[2] || m[3] || m[4]; lv = lv ? (cn(lv) || Number(lv)) : (m[5] ? 1 : m[6] ? 3 : 2); if (!m[2] && !m[3] && !m[4] && !m[5] && !m[6]) { d.push('沒說幾級：用二級標題'); } var id = blk(m[1], st, g, d); return [{ op: 'setHeading', args: id ? { id: id, level: lv } : { level: lv }, derived: d, gaps: g }]; }]);
    F.push(['list', function (c) { return /(?:改成|換成|變成|轉成|設成|設為)\s*(?:編號清單|項目清單|項目符號清單|清單|條列|編號|項目符號)|(?:取消|不要|拿掉|去掉)\s*(?:清單|條列|項目符號|編號)|(?:改回|變回|還原成)\s*(?:一般)?段落/.test(c); }, function (c, st) { var off = /(?:取消|不要|拿掉|去掉)\s*(?:清單|條列|項目符號|編號)|(?:改回|變回|還原成)\s*(?:一般)?段落/.test(c), m = /(?:把|將)?\s*(.+?)\s*(?:改成|換成|變成|轉成|設成|設為|改回|變回|還原成|取消|不要|拿掉|去掉)/.exec(c), g = [], d = []; var id = m ? blk(m[1], st, g, d) : null; if (!m) { g.push('哪一段？'); } return [off ? { op: 'unList', args: id ? { id: id, off: true } : { off: true }, derived: d, gaps: g } : { op: 'toList', args: id ? { id: id, ordered: /編號/.test(c) } : { ordered: /編號/.test(c) }, derived: d, gaps: g }]; }]);
    F.push(['move', function (c) { return /(?:移到|搬到|放到|調到|挪到)\s*(?:最前面|最前|開頭|最上面|最後面|最後|結尾|最下面)|(?:往上|上移|往前|前移|往下|下移|往後|後移)\s*(?:一個|一段|一格)?$/.test(c); }, function (c, st) { var m = /(?:把|將)?\s*(.+?)\s*(?:移到|搬到|放到|調到|挪到|往上|上移|往前|前移|往下|下移|往後|後移)/.exec(c), g = [], d = [], id = m ? blk(m[1], st, g, d) : null; var to = /最前面|最前|開頭|最上面/.test(c) ? 'first' : /最後面|最後|結尾|最下面/.test(c) ? 'last' : /往上|上移|往前|前移/.test(c) ? 'earlier' : 'later'; return [{ op: 'moveBlock', args: id ? { id: id, to: to } : { to: to }, derived: d, gaps: g }]; }]);
    F.push(['add', function (c) { return /(?:加|新增|加入|插入|補)\s*(?:上)?\s*(?:一個|一段|一行|一條|一項)?\s*(?:標題|段落|清單項目|項目|重點|一段|一行|一個)?\s*[：:「]/.test(c) && /(?:在|後面|之後|最後|開頭|結尾)/.test(c) || /^(?:在)?(?:最後|結尾|文末|開頭|文首).{0,4}(?:加|新增|加入|插入)/.test(c); }, function (c, st) {
      var m = /^(?:在)?\s*(最後|結尾|文末|最前面|開頭|文首|[^，：:]+?(?:的)?(?:後面|之後|下面))\s*(?:再)?\s*(?:加|新增|加入|插入|補)\s*(?:上)?\s*(?:一個|一段|一行|一條|一項)?\s*(?:([1-6一二三四五六])\s*(?:級|層)標題|標題|編號清單|項目清單|清單項目|清單|項目|重點|段落)?\s*[：:]?\s*(.*)$/.exec(c), g = [], d = [];
      if (!m) { return [{ op: 'addBlock', args: {}, derived: d, gaps: ['要在哪裡加什麼？（說「在最後加一段：…」）'] }]; }
      var where = m[1], after = 'end'; if (/^(最前面|開頭|文首)$/.test(where)) { after = 'start'; d.push('開頭'); } else if (!/^(最後|結尾|文末)$/.test(where)) { var ph = where.replace(/(?:的)?(?:後面|之後|下面)$/, ''), id = blk(ph, st, g, d); if (id) { after = id; } else { after = null; } }
      var kind = /標題/.test(c.slice(0, c.length - m[3].length)) ? 'heading' : /清單|項目|重點/.test(c.slice(0, c.length - m[3].length)) ? 'list' : 'para', lvl = m[2] ? cn(m[2]) : 2, body = unq(m[3]);
      if (!body) { g.push('要加的內容是什麼？（在冒號後面寫出來）'); } var a = { type: kind, text: body }; if (after) { a.after = after; } if (kind === 'heading') { a.level = lvl; if (!m[2]) { d.push('沒說幾級：用二級標題'); } } if (kind === 'list') { a.ordered = /編號/.test(c); }
      return [{ op: 'addBlock', args: a, derived: d, gaps: g }];
    }]);
    F.push(['set_text', function (c) { return /(?:改成|換成|改為|寫成)\s*[：:「]?/.test(c) && /(?:第\s*\S+\s*(?:段|個|節|行|項|區塊)|最後|第一|選取|這一段|這段|標題\s*[「『“"'])/.test(c); }, function (c, st) { var m = /(?:把|將)?\s*(.+?)\s*(?:改成|換成|改為|寫成)\s*[：:]?\s*(.+)$/.exec(c), g = [], d = []; if (!m) { return [{ op: 'setText', args: {}, derived: d, gaps: ['改哪一段、改成什麼？'] }]; } var id = blk(m[1], st, g, d); return [{ op: 'setText', args: id ? { id: id, text: unq(m[2]) } : { text: unq(m[2]) }, derived: d, gaps: g }]; }]);
    return F;
  }
  var DOMAINS = {
    sheet: { id: 'sheet', label: '試算表／CSV 編輯器', className: 'SheetEditor', ops: SHEET_OPS, unitIntents: UNIT_INTENTS, frames: sheetFrames().map(function (f) { return { name: f[0], test: f[1], build: f[2] }; }) },
    text: { id: 'text', label: 'Markdown／純文字編輯器', className: 'TextEditor', ops: TEXT_OPS, unitIntents: UNIT_INTENTS, frames: textFrames(false).map(function (f) { return { name: f[0], test: f[1], build: f[2] }; }) },
    doc: { id: 'doc', label: 'Word 文件編輯器', className: 'DocEditor', ops: DOC_OPS, unitIntents: UNIT_INTENTS, frames: textFrames(true).map(function (f) { return { name: f[0], test: f[1], build: f[2] }; }) },
  };
  if (FH) { Object.keys(DOMAINS).forEach(function (k) { FH.registerDomain(DOMAINS[k]); }); }
  function decompose(domain, text, state) { return FH ? FH.decompose(domain, text, state) : { ok: false, intents: [], gaps: ['no harness'], derived: [] }; }
  function toUml(domain, intents) { return FH ? FH.toUml(DOMAINS[domain], intents) : ''; }
  return { DOMAINS: DOMAINS, TOOLS: TOOLS, UNIT_INTENTS: UNIT_INTENTS, stateOf: stateOf, decompose: decompose, toUml: toUml, toEdit: toEdit, colOf: colOf, blockOf: blockOf };
}));
