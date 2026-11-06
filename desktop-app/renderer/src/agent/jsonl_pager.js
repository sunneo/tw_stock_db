// JSONL 分頁器（純函式，無 DOM、無 I/O、UMD；嵌入 floating-assistant 後用 new Function 載入）。
// 用途：很大的 JSON 回應（記錄清單）不再「只放開頭就截斷」，而是一頁一頁、每行一筆記錄地給模型，模型可以用 cursor 一直讀到完。
// 設計與實證見 DESIGN.jsonl-paging.md。
//
// 一頁的文字格式：第一行是 meta：{"_page":{...}}，其後每行一筆記錄（單行 JSON，內容裡的換行都已跳脫）。
//   單筆比一頁還大：不丟、不截斷，拆成多頁，每段一行 {"_part":{"record":i,"part":k,"of":n,"text":"…"}}，把 text 依序接起來就是那一筆的原文。
// 大小跟內容窗口按比例（budgetChars），沒有字元下限；一頁至少 1 筆（或 1 段）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatJsonlPager = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var VERSION = 'c1';
  var META_TOKENS = 130; // 同上，以 token 計（JSON 標點與中文提示分詞很碎）
  var META_OVERHEAD = 320; // meta 那一行大約佔多少字元（含 hint），從預算裡先扣掉

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function safeStringify(v) { try { var s = JSON.stringify(v); return s === undefined ? 'null' : s; } catch (e) { return null; } }

  // 一頁可以放多少字元：內容窗口 token × 比例 × 每 token 約幾個字元。沒有下限常數。
  function budgetChars(o) {
    o = o || {};
    if (Number(o.chars) > 0) return Math.floor(Number(o.chars));
    var ctx = Number(o.ctxTokens) || 0, fr = Number(o.fraction) || 0.15, cpt = Number(o.charsPerToken) || 3;
    return Math.max(1, Math.floor(ctx * fr * cpt));
  }

  // 短雜湊（FNV-1a 32 位元），讓帳本核對「這一頁真的拿到過」
  function digest(text) {
    var h = 0x811c9dc5; text = String(text);
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // 逐行解析 JSONL 文字：回傳 { values:[{line, value}], bad:[{line, raw, error}], lines } ；空行略過但行號照算，壞行保留不丟
  function parseLines(text) {
    var out = { values: [], bad: [], lines: 0 };
    var rows = String(text == null ? '' : text).replace(/^﻿/, '').split(/\r?\n/);
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i]; if (!s.trim()) continue;
      out.lines++;
      try { out.values.push({ line: i + 1, value: JSON.parse(s) }); }
      catch (e) { out.bad.push({ line: i + 1, raw: s.length > 200 ? s.slice(0, 200) + '…' : s, error: String(e && e.message || e).split('\n')[0] }); }
    }
    return out;
  }

  // 找頂層物件裡「占大宗」的陣列欄位（最多往下兩層）：回傳 { path:[...], arr }；沒有回 null
  function dominantArray(obj, totalLen) {
    var best = null;
    function visit(o, path, depth) {
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (Array.isArray(v) && v.length >= 2) {
          var s = safeStringify(v); var len = s ? s.length : 0;
          if (!best || len > best.len) best = { path: path.concat(k), arr: v, len: len };
        } else if (isObj(v) && depth < 1) visit(v, path.concat(k), depth + 1);
      });
    }
    visit(obj, [], 0);
    if (!best || best.len < totalLen * 0.5) return null;
    return best;
  }

  function withoutPath(obj, path) {
    var copy = Array.isArray(obj) ? obj.slice() : Object.assign({}, obj);
    if (path.length === 1) { copy[path[0]] = '[見後面的記錄]'; return copy; }
    copy[path[0]] = withoutPath(obj[path[0]], path.slice(1));
    return copy;
  }

  // 把一個結果轉成「一行一筆」的記錄。input：JSON 文字、JSONL 文字或已解析的值。
  // 回傳 { lines:[每筆一行的字串], shape, head, bad, path } 或 null（不是記錄清單，呼叫者退回原本的截斷）。

  // 超深的結構攤平成 JSONL：每個節點一行 {"path":"/a/b/0/c","type":"string","value":…}（JSON Pointer；容器行只有 type 與 keys／length，
  // 沒有 value），先序、鍵順序不變，所以 unflatten 可以逐字還原。單行不含實體換行（JSON.stringify），單一葉子太大由分頁器分段。
  function ptrEsc(k) { return String(k).replace(/~/g, '~0').replace(/\//g, '~1'); }
  // maxDepth：只攤到這一層，更深的容器變成一行 {collapsed:true,size:子孫節點數}（先看全貌，要哪裡再用 expand 往下鑽）；沒給就攤到底。
  function dkeys(o) { return Object.keys(o).filter(function (k) { return o[k] !== undefined && typeof o[k] !== 'function'; }); } // 跟 JSON.stringify 一樣：值是 undefined／函式的欄位不存在
  function countNodes(v) { var n = 1; if (Array.isArray(v)) for (var i = 0; i < v.length; i++) n += countNodes(v[i]); else if (isObj(v)) { var dk = dkeys(v); for (var q = 0; q < dk.length; q++) n += countNodes(v[dk[q]]); } return n; }
  function flatten(value, opts) {
    opts = opts || {}; var maxNodes = Number(opts.maxNodes) > 0 ? Number(opts.maxNodes) : 2000000;
    var limit = opts.maxDepth != null && Number(opts.maxDepth) >= 0 ? Number(opts.maxDepth) : Infinity, base = opts.basePath || '', d0 = Number(opts.baseDepth) || 0;
    var out = [], count = 0, truncated = false;
    (function walk(v, path, depth) {
      if (truncated) return;
      if (++count > maxNodes) { truncated = true; return; }
      var isArr = Array.isArray(v), isO = isObj(v);
      if (isArr || isO) {
        var row = { path: path, depth: depth, type: isArr ? 'array' : 'object' }; if (isArr) row.length = v.length; else row.keys = dkeys(v).length;
        if (depth - d0 >= limit && (isArr ? v.length : row.keys)) { row.collapsed = true; row.size = countNodes(v) - 1; out.push(safeStringify(row)); return; }
        out.push(safeStringify(row));
        if (isArr) for (var i = 0; i < v.length; i++) walk(v[i], path + '/' + i, depth + 1);
        else { var ks = dkeys(v); for (var j = 0; j < ks.length; j++) walk(v[ks[j]], path + '/' + ptrEsc(ks[j]), depth + 1); }
      } else out.push(safeStringify({ path: path, depth: depth, type: v === null ? 'null' : typeof v, value: v === undefined ? null : v }));
    })(value, base, d0);
    return { lines: out, nodes: out.length, truncated: truncated };
  }
  // 往下鑽：把 path（JSON Pointer）那個節點再攤開 levels 層（預設 1），行的 path 是從根算起的完整路徑，可以直接接在先前的行後面一起 unflatten。
  function getByPointer(value, path) {
    var cur = value; if (path === '' || path == null) return { ok: true, value: cur };
    var segs = String(path).split('/').slice(1).map(function (x) { return x.replace(/~1/g, '/').replace(/~0/g, '~'); });
    for (var i = 0; i < segs.length; i++) { if (cur === null || typeof cur !== 'object' || !(segs[i] in cur)) return { ok: false, error: '找不到路徑 ' + path }; cur = cur[segs[i]]; }
    return { ok: true, value: cur };
  }
  function expand(value, path, opts) {
    opts = opts || {}; var g = getByPointer(value, path); if (!g.ok) return g;
    var base = path || '', depth = base ? base.split('/').length - 1 : 0;
    var f = flatten(g.value, { maxDepth: opts.levels == null ? 1 : opts.levels, basePath: base, baseDepth: depth, maxNodes: opts.maxNodes });
    return { ok: true, lines: f.lines, nodes: f.nodes, truncated: f.truncated };
  }
  // 反向：把 flatten／expand 的行還原成原本的值。同一路徑的行後來的覆蓋前面的（collapsed 的占位行會被 expand 的行取代，已有的子節點不清掉）；
  // 還有 collapsed 沒展開的節點會留下空容器，並列在回傳的 collapsedPaths（用 unflattenInfo 取得）。
  function unflattenInfo(lines) {
    var root, have = false, collapsed = {};
    for (var n = 0; n < lines.length; n++) {
      var r = typeof lines[n] === 'string' ? JSON.parse(lines[n]) : lines[n];
      var isC = r.type === 'array' || r.type === 'object';
      var node = r.type === 'array' ? [] : r.type === 'object' ? {} : r.value;
      if (isC) { if (r.collapsed) collapsed[r.path] = r.size || 1; else delete collapsed[r.path]; }
      if (r.path === '') { if (!have || !isC || typeof root !== 'object' || root === null) root = node; have = true; continue; }
      var segs = r.path.split('/').slice(1).map(function (x) { return x.replace(/~1/g, '/').replace(/~0/g, '~'); });
      var cur = root; for (var i = 0; i < segs.length - 1; i++) cur = cur[segs[i]];
      var last = segs[segs.length - 1], prev = cur[last];
      if (isC && prev !== null && typeof prev === 'object' && Array.isArray(prev) === Array.isArray(node)) continue; // 已有同型容器（含已展開的子節點）：保留
      cur[last] = node;
    }
    return { value: have ? root : undefined, collapsedPaths: Object.keys(collapsed) };
  }
  function unflatten(lines) { return unflattenInfo(lines).value; }

  // 程式結構（AST／語法樹／任何「有 type 或 kind 的節點巢狀」）攤平：一個節點一行
  //   {"id":n,"parent":p,"field":"body","index":0,"type":"IfStatement","depth":d,"props":{純量屬性…},"children":k}
  // id 從 0 起、先序；parent＝上層節點的 id（根是 null）；field／index＝它掛在上層的哪個欄位（第幾個）。
  // 位置資訊（loc／range／start／end／span）留在 props，方便用行號回頭找原始碼。非節點的巢狀（普通物件／陣列）掛在最近的節點底下，欄位路徑放 field。
  function isAstNode(v) { return isObj(v) && (typeof v.type === 'string' || typeof v.kind === 'string' || typeof v.node_type === 'string'); }
  function nodeType(v) { return typeof v.type === 'string' ? v.type : typeof v.kind === 'string' ? v.kind : v.node_type; }
  function flattenAst(root, opts) {
    opts = opts || {}; var maxNodes = Number(opts.maxNodes) > 0 ? Number(opts.maxNodes) : 2000000;
    var out = [], truncated = false;
    function emit(v, parent, field, index, depth, path) {
      if (out.length >= maxNodes) { truncated = true; return; }
      var id = out.length, props = {}, kids = [];
      var tp = nodeType(v), mypath = (path ? path + '>' : '') + tp;
      var line = { id: id, parent: parent, field: field, index: index, type: tp, path: mypath, depth: depth, props: props, children: 0, size: 1 };
      out.push(null);
      Object.keys(v).forEach(function (k) {
        var x = v[k];
        if (k === 'type' && typeof x === 'string' && nodeType(v) === x) return;
        if (x !== null && typeof x === 'object') {
          if (Array.isArray(x)) { if (x.some(function (e) { return e !== null && typeof e === 'object'; })) { kids.push({ k: k, arr: x }); return; } props[k] = x; return; }
          if (isAstNode(x)) { kids.push({ k: k, one: x }); return; }
          if (hasNode(x, 3)) { kids.push({ k: k, plain: x }); return; }
          props[k] = x; return; // 位置、小型設定物件（loc、range…）
        }
        props[k] = x;
      });
      var n = 0;
      kids.forEach(function (c) {
        if (c.one) { n++; emit(c.one, id, c.k, null, depth + 1, mypath); }
        else if (c.arr) c.arr.forEach(function (e, i) { if (isAstNode(e)) { n++; emit(e, id, c.k, i, depth + 1, mypath); } else if (e !== null && typeof e === 'object' && hasNode(e, 3)) { Object.keys(e).forEach(function (kk) { if (isAstNode(e[kk])) { n++; emit(e[kk], id, c.k + '[' + i + '].' + kk, null, depth + 1, mypath); } }); } else { (line.props[c.k + '[' + i + ']'] = e); } });
        else Object.keys(c.plain).forEach(function (kk) { var e = c.plain[kk]; if (isAstNode(e)) { n++; emit(e, id, c.k + '.' + kk, null, depth + 1, mypath); } else if (Array.isArray(e)) e.forEach(function (z, i) { if (isAstNode(z)) { n++; emit(z, id, c.k + '.' + kk, i, depth + 1, mypath); } }); else props[c.k + '.' + kk] = e; });
      });
      line.children = n; line.size = out.length - id; out[id] = safeStringify(line);
    }
    emit(root, null, null, null, 0, '');
    return { lines: out.filter(function (l) { return l !== null; }), nodes: out.length, truncated: truncated };
  }
  function hasNode(v, d) { if (d <= 0 || v === null || typeof v !== 'object') return false; if (isAstNode(v)) return true; var ks = Object.keys(v); for (var i = 0; i < ks.length && i < 50; i++) if (hasNode(v[ks[i]], d - 1)) return true; return false; }
  function maxDepth(v, cap) {
    var m = 0; (function w(x, d) { if (d > m) m = d; if (m >= cap) return; if (Array.isArray(x)) for (var i = 0; i < x.length && m < cap; i++) w(x[i], d + 1); else if (isObj(x)) for (var k in x) { w(x[k], d + 1); if (m >= cap) return; } })(v, 0);
    return m;
  }
  function toRecords(input, opts) {
    opts = opts || {};
    var value, jsonlRes = null;
    if (typeof input === 'string') {
      var t = input.replace(/^﻿/, '').trim();
      if (!t) return null;
      var first = t[0];
      if (first !== '{' && first !== '[') return null;
      try { value = JSON.parse(t); }
      catch (e) {
        // 整串不是合法 JSON：看是不是一行一筆的 JSONL
        jsonlRes = parseLines(t);
        var nonEmpty = jsonlRes.values.length + jsonlRes.bad.length;
        if (jsonlRes.values.length < 2 || jsonlRes.values.length < nonEmpty * 0.5) return null;
        var ls = jsonlRes.values.map(function (r) { return safeStringify(r.value); });
        jsonlRes.bad.forEach(function (b) { ls.push(safeStringify({ _bad_line: b.line, error: b.error, raw: b.raw })); });
        return { lines: ls, shape: 'jsonl', head: null, bad: jsonlRes.bad.length, path: [] };
      }
    } else value = input;
    if (Array.isArray(value)) {
      if (value.length < 2) return null;
      var lines = value.map(safeStringify);
      if (lines.indexOf(null) >= 0) return null;
      return { lines: lines, shape: 'array', head: null, bad: 0, path: [] };
    }
    if (isObj(value)) {
      var totalLen = (safeStringify(value) || '').length;
      var dom = dominantArray(value, totalLen);
      if (opts.flatten !== false && isAstNode(value) && maxDepth(value, 5) >= 4) {
        var fa = flattenAst(value); if (fa.lines.length >= 2) return { lines: fa.lines, shape: 'ast', head: fa.truncated ? { note: '節點太多，只攤平了前 ' + fa.nodes + ' 個' } : null, bad: 0, path: [] };
      }
      if ((opts.flatten || (!dom && maxDepth(value, 6) >= 5)) && !(opts.flatten === false)) {
        // 超深的巢狀（沒有占大宗的陣列，或明確要求）：攤平成一個節點一行
        var fl = flatten(value); if (fl.lines.length >= 2 && fl.lines.indexOf(null) < 0) return { lines: fl.lines, shape: 'flat', head: fl.truncated ? { note: '節點太多，只攤平了前 ' + fl.nodes + ' 個' } : null, bad: 0, path: [] };
      }
      if (!dom) {
        // 沒有占大宗的陣列（例如 id→物件的對照表、很多欄位的大物件）：一個欄位一行 {"key":…,"value":…}；單一欄位太大由分頁器分段
        var keys = Object.keys(value); if (keys.length < 3) return null;
        var le = keys.map(function (k) { return safeStringify({ key: k, value: value[k] }); });
        if (le.indexOf(null) >= 0) return null;
        return { lines: le, shape: 'entries', head: null, bad: 0, path: [] };
      }
      var ls2 = dom.arr.map(safeStringify);
      if (ls2.indexOf(null) >= 0) return null;
      return { lines: ls2, shape: 'field:' + dom.path.join('.'), head: withoutPath(value, dom.path), bad: 0, path: dom.path };
    }
    return null;
  }

  // ===== cursor =====
  function cleanSource(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_\-.]/g, '_'); }
  function encodeCursor(c) { return [VERSION, cleanSource(c.source), c.index | 0, c.part | 0, c.page | 0].join(':'); }
  // 驗證：版本、來源（有給才比對）、位置範圍；失敗回 { ok:false, error }，不亂讀
  function decodeCursor(cursor, expect) {
    expect = expect || {};
    if (cursor == null || cursor === '') return { ok: true, index: 0, part: 0, page: 0, source: expect.source != null ? cleanSource(expect.source) : '' };
    var p = String(cursor).split(':');
    if (p.length !== 5 || p[0] !== VERSION) return { ok: false, error: 'cursor 格式不對：請原樣帶回上一頁 _page.next_cursor 的值，不要自己改。' };
    var idx = Number(p[2]), part = Number(p[3]), page = Number(p[4]);
    if (![idx, part, page].every(function (n) { return isFinite(n) && n >= 0 && Math.floor(n) === n; })) return { ok: false, error: 'cursor 的位置不是整數。' };
    if (expect.source != null && p[1] !== cleanSource(expect.source)) return { ok: false, error: 'cursor 屬於另一份內容（' + p[1] + '），不是 ' + cleanSource(expect.source) + '。' };
    if (expect.total != null && idx > expect.total) return { ok: false, error: 'cursor 超出範圍（第 ' + idx + ' 筆，共 ' + expect.total + ' 筆）。' };
    return { ok: true, source: p[1], index: idx, part: part, page: page };
  }

  // 單筆太大時切一段（不切在代理對中間）
  function sliceSafe(s, from, len) {
    var end = Math.min(s.length, from + Math.max(1, len));
    if (end < s.length) { var c = s.charCodeAt(end - 1); if (c >= 0xD800 && c <= 0xDBFF && end - from > 1) end--; }
    return s.slice(from, end);
  }

  // 取一頁。lines＝toRecords().lines；opts：{ source, cursor, budgetChars|ctxTokens+fraction, head, total_exact, hintTool }
  // 回傳 { ok, text, meta, nextCursor, from, to, hasMore }；cursor 不合法回 { ok:false, error }
  function page(lines, opts) {
    opts = opts || {};
    var total = lines.length;
    var cur = decodeCursor(opts.cursor, { source: opts.source, total: total });
    if (!cur.ok) return { ok: false, error: cur.error };
    // 預算單位：給了 maxTokens＋tokensOf（宿主的 token 估計）就用 token 算——中文 JSON 大約 1 字 1 token，用「3 字元＝1 token」會低估 3 倍，
    // 小窗口（4096）一頁就吃掉四成；沒給就照字元算（跟以前完全一樣）
    var tokMode = typeof opts.tokensOf === 'function' && Number(opts.maxTokens) > 0;
    var cost = function (str) { return tokMode ? Number(opts.tokensOf(str)) + 1 : str.length + 1; };
    var budget = tokMode ? Math.max(1, Math.floor(Number(opts.maxTokens)) - META_TOKENS) : Math.max(1, budgetChars(opts) - META_OVERHEAD);
    var i = cur.index, part = cur.part, out = [], used = 0, partInfo = null;
    if (i >= total) return { ok: true, text: safeStringify({ _page: { source: cleanSource(opts.source), page: cur.page + 1, from: total, to: total, returned: 0, total: total, total_exact: true, has_more: false, next_cursor: null, done: true, read_records: total } }), meta: { done: true }, nextCursor: null, from: total, to: total, hasMore: false };
    if (part > 0 || cost(lines[i]) > budget) {
      // 這一筆放不進一頁（或上次讀到一半）：只送這一筆的一段
      var rec = lines[i]; var from = 0;
      // 每段的 text 因 JSON 跳脫會變長，抓一個保守比例讓整行不超過預算
      var ratio = tokMode ? Math.max(0.05, cost(rec) / Math.max(1, rec.length)) : 1; // 每個字元約幾個單位
      var perPart = Math.max(1, Math.floor(((budget - (tokMode ? 40 : 80)) / 2) / ratio));
      var starts = [0];
      for (var pos = 0; pos < rec.length;) { var piece = sliceSafe(rec, pos, perPart); pos += piece.length; if (pos < rec.length) starts.push(pos); }
      var nParts = starts.length;
      if (part >= nParts) part = 0; // 防呆
      from = starts[part];
      var seg = rec.slice(from, part + 1 < nParts ? starts[part + 1] : rec.length);
      var row = safeStringify({ _part: { record: i, part: part, of: nParts, text: seg } });
      out.push(row);
      var lastPart = from + seg.length >= rec.length;
      partInfo = { record: i, part: part, of: nParts };
      if (lastPart) { i++; part = 0; } else part++;
    } else {
      while (i < total) {
        var len = cost(lines[i]);
        if (out.length && used + len > budget) break;
        if (!out.length && len > budget) break; // 第一筆就放不下：下一輪走分段
        out.push(lines[i]); used += len; i++;
      }
    }
    var hasMore = i < total;
    var nextCursor = hasMore ? encodeCursor({ source: opts.source, index: i, part: part, page: cur.page + 1 }) : null;
    var pageNo = cur.page + 1;
    var meta = {
      source: cleanSource(opts.source), page: pageNo,
      from: cur.index, to: partInfo ? (part === 0 ? i : cur.index) : i, returned: partInfo ? 0 : out.length,
      total: total, total_exact: opts.total_exact !== false,
      has_more: hasMore, next_cursor: nextCursor, limit: partInfo ? 1 : out.length
    };
    if (partInfo) { meta.record_part = partInfo; meta.to = part === 0 ? i : cur.index; }
    if (!hasMore) { meta.done = true; meta.read_records = total; }
    if (cur.index === 0 && cur.part === 0 && opts.head != null) {
      var hs = safeStringify(opts.head) || '';
      if ((tokMode ? Number(opts.tokensOf(hs)) : hs.length) <= Math.floor(budget * 0.25)) meta.head = opts.head; else meta.head_omitted = true; // 其餘欄位太大就不塞進第一頁
    }
    // 樹狀記錄（flattenAst：先序，每個節點有 id 與 size＝子樹節點數）：這一頁切在樹的中間時，列出「子節點還沒讀完」的節點，
    // 不完整的節點會讓人誤讀（例如 if 只看到條件沒看到 else），所以提醒不要對它下結論，並附要接著讀的位置。
    if (!partInfo && out.length) {
      var openNodes = []; var lastId = null, firstId = null;
      for (var oi = 0; oi < out.length; oi++) {
        var nd = null; try { nd = JSON.parse(out[oi]); } catch (e0) { nd = null; }
        if (!nd || typeof nd.id !== 'number' || typeof nd.size !== 'number') { openNodes = null; break; }
        if (firstId === null) firstId = nd.id; lastId = nd.id;
        if (nd.size > 1) openNodes.push({ id: nd.id, type: nd.type, last_id: nd.id + nd.size - 1 });
      }
      if (openNodes && lastId !== null) {
        var inc = openNodes.filter(function (x) { return x.last_id > lastId; });
        if (inc.length) { meta.incomplete = inc.slice(0, 20).map(function (x) { return { id: x.id, type: x.type, missing: [lastId + 1, x.last_id] }; }); meta.incomplete_note = '這一頁切在樹的中間：incomplete 裡的節點，子節點還有（missing 的 id 範圍）在後面的頁，先不要對它們下結論，讀完下一頁再看。'; }
        if (firstId > 0 || (out.length && JSON.parse(out[0]).parent != null)) meta.starts_inside = '這一頁從樹的中間開始：每個節點的 path 是從根到它的類型鏈，parent 是上層節點的 id（可能在前一頁）。';
      }
    }
    if (hasMore && !partInfo && out.length) meta.pages_left = Math.ceil((total - i) / out.length); // 估計：照這一頁讀到的筆數，後面大約還有幾頁（上下文放得下幾頁要跟這個比）
    if (opts.continueWith && hasMore) meta.continue = String(opts.continueWith).replace('<CURSOR>', nextCursor);
    meta.digest = digest(out.join('\n'));
    meta.hint = hasMore
      ? (partInfo ? '這一筆太大，分成 ' + partInfo.of + ' 段，這是第 ' + (partInfo.part + 1) + ' 段；把各段 text 依序接起來才是完整的一筆。' : '') + '還沒讀完（已到第 ' + i + ' 筆，共 ' + total + ' 筆）：用 next_cursor 原樣帶回再讀下一頁，讀完才可以下結論。'
      : '已讀到最後一頁（共 ' + total + ' 筆）。';
    var text = safeStringify({ _page: meta }) + (out.length ? '\n' + out.join('\n') : '');
    return { ok: true, text: text, meta: meta, nextCursor: nextCursor, from: cur.index, to: i, hasMore: hasMore };
  }

  // 解析一頁的文字（帳本、測試、模型輸出核對用）：回傳 { meta, records:[值], parts:[...], bad:[...] }；第一行不是 _page 回 null
  function parsePage(text) {
    var rows = String(text || '').split('\n'); if (!rows.length) return null;
    var m; try { m = JSON.parse(rows[0]); } catch (e) { return null; }
    if (!m || !m._page) return null;
    var res = { meta: m._page, records: [], parts: [], bad: [] };
    for (var i = 1; i < rows.length; i++) {
      if (!rows[i]) continue;
      try { var v = JSON.parse(rows[i]); if (v && v._part && Object.keys(v).length === 1) res.parts.push(v._part); else res.records.push(v); }
      catch (e) { res.bad.push({ row: i, raw: rows[i].slice(0, 200) }); }
    }
    return res;
  }

  // ===== 模型輸出成 JSONL 並自動續傳 =====
  // 線上視覺模型一次輸出有上限（max_tokens），拆解一張圖可能有幾千個物件，一次寫不完就會在半行斷掉。
  // 做法：要求「一行一個 JSON 物件」、完整一行才算一筆；被截斷（finish_reason 是 length）就丟掉最後那半行，
  // 用「已經輸出 N 筆，從第 N+1 筆接著輸出」再要一次，累積到模型說完（_end 標記或自然結束）或達上限。壞行保留標示不丟。
  var END_KEY = '_end';
  function streamPrompt(userQuestion) {
    return String(userQuestion || '').trim() + '\n\n【輸出格式——一定要照這個寫】\n' +
      '1. 一行一個 JSON 物件（JSON Lines）：不要用陣列包起來、不要 markdown 的程式碼區塊、不要行尾逗號、不要任何前言或結語。\n' +
      '2. 每個物件都要有 "id"（從 1 開始連續編號），其餘欄位（label、bbox 等）依問題需要。\n' +
      '3. 一個物件只佔一行，寫完整才換行；全部輸出完，最後一行寫 {"' + END_KEY + '":true}。\n' +
      '4. 內容太多寫不完也沒關係，寫到哪算哪，我會要你接著寫。';
  }
  function continuePrompt(userQuestion, st) {
    var last = st.lines.length ? st.lines[st.lines.length - 1] : '';
    var lastId = st.lastId;
    return streamPrompt(userQuestion) + '\n\n【接續】你上一次輸出到一半被截斷了。目前已經收到 ' + st.lines.length + ' 筆' +
      (lastId != null ? '（最後一筆的 id 是 ' + lastId + '）' : '') + '，最後一筆是：\n' + (last.length > 300 ? last.slice(0, 300) + '…' : last) +
      '\n請從下一筆' + (typeof lastId === 'number' ? '（id 從 ' + (lastId + 1) + ' 開始）' : '') + '接著輸出，格式一樣，不要重複前面已輸出的。';
  }
  function newStream() { return { lines: [], ids: {}, bad: 0, dup: 0, partial: 0, ended: false, lastId: null, badSeq: 0 }; }
  // 吸收模型這一次的輸出。finishReason：'length'＝被截斷；'stop'＝自然結束；其他／空＝不確定。回傳這一次的統計。
  function absorb(st, text, finishReason) {
    var res = { added: 0, dup: 0, bad: 0, partial: 0, ended: false };
    var whole = String(text == null ? '' : text);
    var rows = whole.replace(/\r/g, '').split('\n');
    var cut = finishReason === 'length' || (finishReason !== 'stop' && !/\n\s*$/.test(whole));
    for (var i = 0; i < rows.length; i++) {
      var raw = rows[i].trim(); var isLast = i === rows.length - 1;
      if (!raw || raw.indexOf('```') === 0 || raw === '[' || raw === ']') continue;
      if (raw.charAt(raw.length - 1) === ',') raw = raw.slice(0, -1);
      var v = null, ok = false;
      try { v = JSON.parse(raw); ok = true; } catch (e) { ok = false; }
      if (!ok) {
        if (isLast && cut) { res.partial++; st.partial++; continue; } // 被截斷的半行：丟掉，下一次從這一筆重來
        st.bad++; res.bad++; st.badSeq++;
        st.lines.push(safeStringify({ _bad_line: st.badSeq, error: 'JSON 解析失敗', raw: raw.length > 300 ? raw.slice(0, 300) + '…' : raw }));
        continue;
      }
      if (isObj(v)) {
        if (v[END_KEY] === true) { st.ended = true; res.ended = true; continue; }
        if (v.id != null) {
          var key = typeof v.id + ':' + v.id;
          if (st.ids[key]) { st.dup++; res.dup++; continue; }
          st.ids[key] = true; if (typeof v.id === 'number') st.lastId = v.id;
        }
        st.lines.push(safeStringify(v)); res.added++;
      } else { st.bad++; res.bad++; st.badSeq++; st.lines.push(safeStringify({ _bad_line: st.badSeq, error: '不是物件', raw: raw.slice(0, 300) })); }
    }
    return res;
  }
  // 整個續傳流程。opts：{ question, generate: async({prompt, round}) → {content, finishReason}, maxRounds, maxRecords, deadlineMs, retries, sleep, shouldStop, onRound }
  // 回傳 { lines, complete, stop_reason, rounds, bad, dup, partial_dropped, errors:[…] }；complete 只有在模型真的說完（_end 或自然結束）時才是 true。
  async function runStream(opts) {
    var st = newStream(), errors = [], rounds = 0, stall = 0, stop = null, uncertain = 0;
    var maxRounds = opts.maxRounds || 400, maxRecords = opts.maxRecords || 100000, retries = opts.retries == null ? 3 : opts.retries;
    var deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : 0;
    while (true) {
      if (rounds >= maxRounds) { stop = 'max_rounds'; break; }
      if (st.lines.length >= maxRecords) { stop = 'max_records'; break; }
      if (deadline && Date.now() > deadline) { stop = 'deadline'; break; }
      if (opts.shouldStop && opts.shouldStop()) { stop = 'user_stop'; break; }
      var prompt = rounds === 0 ? streamPrompt(opts.question) : continuePrompt(opts.question, st), out = null;
      for (var a = 0; a <= retries; a++) {
        try { out = await opts.generate({ prompt: prompt, round: rounds + 1, attempt: a + 1 }); break; }
        catch (e) { errors.push({ round: rounds + 1, attempt: a + 1, error: String(e && e.message || e) }); if (opts.sleep) await opts.sleep(Math.min(8000, 1000 * (a + 1))); }
      }
      rounds++;
      if (!out) { stop = 'error'; break; }
      var r = absorb(st, out.content, out.finishReason);
      if (opts.onRound) { try { opts.onRound({ round: rounds, total: st.lines.length, added: r.added, finishReason: out.finishReason }); } catch (e) { /* */ } }
      if (r.ended) { stop = 'ended'; break; }
      if (out.finishReason === 'stop') { stop = 'finished'; break; } // 模型自己說完了（沒寫 _end 也算完成，但 end_marker 會是 false）
      stall = r.added === 0 ? stall + 1 : 0;
      if (stall >= 2) { stop = 'stalled'; break; }
      if (out.finishReason !== 'length') { uncertain++; if (uncertain >= 3) { stop = 'unsure'; break; } }
    }
    return { lines: st.lines, complete: stop === 'ended' || stop === 'finished', stop_reason: stop, end_marker: st.ended, rounds: rounds, bad: st.bad, dup: st.dup, partial_dropped: st.partial, errors: errors };
  }

  return {
    flatten: flatten, unflatten: unflatten, unflattenInfo: unflattenInfo, expand: expand, flattenAst: flattenAst, isAstNode: isAstNode,
    VERSION: VERSION, budgetChars: budgetChars, digest: digest, parseLines: parseLines,
    streamPrompt: streamPrompt, continuePrompt: continuePrompt, newStream: newStream, absorb: absorb, runStream: runStream,
    toRecords: toRecords, page: page, parsePage: parsePage, encodeCursor: encodeCursor, decodeCursor: decodeCursor
  };
}));
