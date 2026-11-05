// JSONL 分頁器（純函式，無 DOM、無 I/O、UMD；嵌入 floating-assistant 後用 new Function 載入）。
// 用途：很大的 JSON 回應（記錄清單）不再「只放開頭就截斷」，而是一頁一頁、每行一筆記錄地給模型，模型可以用 cursor 一直讀到完。
// 設計見 DESIGN.TODO.md「JSONL 分頁器與檢視器」。
//
// 一頁的文字格式：第一行是 meta：{"_page":{...}}，其後每行一筆記錄（單行 JSON，內容裡的換行都已跳脫）。
//   單筆比一頁還大：不丟、不截斷，拆成多頁，每段一行 {"_part":{"record":i,"part":k,"of":n,"text":"…"}}，把 text 依序接起來就是那一筆的原文。
// 大小跟內容窗口按比例（budgetChars），沒有字元下限；一頁至少 1 筆（或 1 段）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatJsonlPager = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var VERSION = 'c1';
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
  function toRecords(input) {
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
      if (!dom) return null;
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
    var budget = Math.max(1, budgetChars(opts) - META_OVERHEAD);
    var i = cur.index, part = cur.part, out = [], used = 0, partInfo = null;
    if (i >= total) return { ok: true, text: safeStringify({ _page: { source: cleanSource(opts.source), page: cur.page + 1, from: total, to: total, returned: 0, total: total, total_exact: true, has_more: false, next_cursor: null, done: true, read_records: total } }), meta: { done: true }, nextCursor: null, from: total, to: total, hasMore: false };
    if (part > 0 || lines[i].length + 1 > budget) {
      // 這一筆放不進一頁（或上次讀到一半）：只送這一筆的一段
      var rec = lines[i]; var from = 0;
      // 每段的 text 因 JSON 跳脫會變長，抓一個保守比例讓整行不超過預算
      var perPart = Math.max(1, Math.floor((budget - 80) / 2));
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
        var len = lines[i].length + 1;
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
    if (cur.index === 0 && cur.part === 0 && opts.head != null) meta.head = opts.head;
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

  return {
    VERSION: VERSION, budgetChars: budgetChars, digest: digest, parseLines: parseLines,
    toRecords: toRecords, page: page, parsePage: parsePage, encodeCursor: encodeCursor, decodeCursor: decodeCursor
  };
}));
