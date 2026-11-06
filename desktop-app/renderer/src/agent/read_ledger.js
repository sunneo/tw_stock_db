// Read ledger (pure, no DOM, no I/O): remembers paged reads that the model has not finished.
// A tool result that says there is more (has_more:true, or chunk.hasMore:true, or truncated:true with a continuation offset)
// is recorded under its source. The same source returning a result without has_more (its last page) clears the entry.
// The tool loop asks pending(ledger) before accepting a final answer and uses reminderText(pending) to tell the model what is still unread.
// Every function returns new values; the ledger is plain JSON-serializable data: { entries: { [key]: entry } }.
//
// entry: { key, toolName, label, nextOffset, nextStartLine, total, blocking }
//   blocking:true  -> has_more, or truncated with a continuation offset (the loop may refuse a final answer)
//   blocking:false -> truncated with no continuation offset (only a reminder; never refuses an answer)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatReadLedger = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SOURCE_FIELDS = ['ref', 'path', 'url', 'file_id', 'fileId', 'attachment_id', 'attachmentId', 'id'];
  var PAGING_ARGS = ['offset', 'start', 'start_line', 'startLine', 'page', 'cursor', 'limit', 'max_chars', 'max_lines', 'chunk', 'from', 'to', 'next_offset', 'nextOffset'];

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function pick() { for (var i = 0; i < arguments.length; i++) if (arguments[i] != null && arguments[i] !== '') return arguments[i]; return null; }

  function stableStr(x) {
    if (x === null || typeof x !== 'object') return JSON.stringify(x === undefined ? null : x);
    if (Array.isArray(x)) return '[' + x.map(stableStr).join(',') + ']';
    return '{' + Object.keys(x).sort().map(function (k) { return JSON.stringify(k) + ':' + stableStr(x[k]); }).join(',') + '}';
  }

  // Source identity: the first known id field (ref, path, url, file_id, attachment id ...). A path is qualified by cwd_abs when given.
  function sourceOf(args) {
    var a = isObj(args) ? args : {};
    var cwd = typeof a.cwd_abs === 'string' ? a.cwd_abs : '';
    for (var i = 0; i < SOURCE_FIELDS.length; i++) {
      var f = SOURCE_FIELDS[i], v = a[f];
      if (v != null && v !== '') return (cwd && f === 'path' ? cwd + '|' : '') + f + '=' + String(v);
    }
    // 沒有來源欄位時，用其餘參數當身分；續讀參數（offset、page、cursor ……）每頁都會變，不能算進身分，否則同一來源永遠清不掉
    var rest = {};
    Object.keys(a).forEach(function (k) { if (PAGING_ARGS.indexOf(k) < 0) rest[k] = a[k]; });
    return 'args=' + stableStr(rest);
  }

  function sourceKey(toolName, args) { return String(toolName || '') + '\u0001' + sourceOf(args); }

  function createLedger() { return { entries: {} }; }

  // Reads the paging fields in both snake_case and camelCase forms (the skill reference reader uses chunk.hasMore / chunk.nextOffset).
  function paging(res) {
    var ch = isObj(res.chunk) ? res.chunk : null;
    return {
      more: res.has_more === true || !!(ch && ch.hasMore === true),
      truncated: res.truncated === true || !!(ch && ch.truncated === true),
      nextOffset: pick(res.next_offset, ch && ch.nextOffset),
      nextStartLine: pick(res.next_start_line, ch && ch.nextStartLine),
      total: pick(res.total, ch && ch.total)
    };
  }

  // ===== 覆蓋範圍（JSONL 分頁，見 jsonl_pager.js 與 DESIGN.jsonl-paging.md）=====
  // 一頁的 meta（_page）帶 source、from、to（半開區間，單位＝第幾筆）、total、has_more、done。
  // 帳本記「已讀過哪些區間」，而不只是「下一個位置」：跳到最後一頁不會把中間沒讀的部分清掉，要整份從 0 連續覆蓋到 total，而且收到最後一頁，才算讀完。
  // 以 meta.source 當身分（不分哪個工具回的第一頁），所以 interpret_image 回的第 1 頁與 big_content 讀的第 2 頁會算同一份。
  function mergeRange(list, a, b) {
    if (!(b > a)) return list.slice();
    var out = [];
    list.concat([[a, b]]).sort(function (x, y) { return x[0] - y[0] || x[1] - y[1]; }).forEach(function (r) {
      var last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]]);
    });
    return out;
  }
  function gapsOf(covered, total) {
    var gaps = [], pos = 0;
    covered.forEach(function (r) { if (r[0] > pos) gaps.push([pos, Math.min(r[0], total)]); pos = Math.max(pos, r[1]); });
    if (pos < total) gaps.push([pos, total]);
    return gaps.filter(function (g) { return g[1] > g[0]; });
  }
  function recordPage(base, m) {
    var entries = Object.assign({}, base.entries), key = 'page\u0001' + String(m.source || '');
    if (base.completed && base.completed[key]) return { entries: entries, completed: base.completed };
    var prev = entries[key];
    var total = Number(m.total); if (!isFinite(total) || total < 0) total = 0;
    var from = Number(m.from) || 0, to = Number(m.to) || 0;
    var covered = mergeRange(prev && Array.isArray(prev.covered) ? prev.covered : [], from, to);
    var done = !!(prev && prev.done) || m.done === true;
    var part = m.record_part && m.record_part.part + 1 < m.record_part.of ? { record: m.record_part.record, next: m.record_part.part + 1, of: m.record_part.of } : null; // 單筆太大分段：沒讀到最後一段不算讀過
    var exact = m.total_exact !== false;
    var gaps = gapsOf(covered, total);
    var complete = done && gaps.length === 0 && !part;
    if (complete) { delete entries[key]; var done2 = Object.assign({}, base.completed); done2[key] = true; return { entries: entries, completed: done2 }; } // 讀完的來源記下來：之後再重讀其中一頁，不能又把它變成「沒讀完」
    entries[key] = {
      key: key, toolName: 'jsonl', label: String(m.source || ''), source: String(m.source || ''), unit: 'record',
      covered: covered, total: total, totalExact: exact, gaps: gaps, done: done, pendingPart: part, pages: ((prev && prev.pages) || 0) + 1,
      nextCursor: m.next_cursor || (prev && prev.nextCursor) || null, viaOffset: m.next_cursor == null && m.next_offset != null || !!(prev && prev.viaOffset && m.next_cursor == null), nextOffset: null, nextStartLine: null, blocking: true
    };
    return { entries: entries, completed: base.completed };
  }

  // Returns a new ledger after one tool result. Failed results (ok:false) change nothing.
  function record(ledger, toolName, args, resultObj) {
    var base = isObj(ledger) && isObj(ledger.entries) ? ledger : createLedger();
    if (!isObj(resultObj) || resultObj.ok === false) return { entries: Object.assign({}, base.entries), completed: base.completed };
    if (isObj(resultObj._page) && resultObj._page.source != null) { if (resultObj._page.blocking === false) return { entries: Object.assign({}, base.entries), completed: base.completed }; return recordPage(base, resultObj._page); } // blocking:false＝選擇性翻頁（排名搜尋），不逼模型讀完
    var entries = Object.assign({}, base.entries);
    var key = sourceKey(toolName, args), p = paging(resultObj);
    var hasNext = p.nextOffset != null || p.nextStartLine != null;
    if (p.more || (p.truncated)) {
      entries[key] = {
        key: key,
        toolName: String(toolName || ''),
        label: sourceOf(args),
        nextOffset: p.nextOffset,
        nextStartLine: p.nextStartLine,
        total: p.total,
        blocking: p.more || hasNext
      };
    } else {
      delete entries[key]; // last page of this source: nothing left to read
    }
    return { entries: entries, completed: base.completed };
  }

  // Unfinished reads, oldest first (insertion order).
  function pending(ledger) {
    var entries = isObj(ledger) && isObj(ledger.entries) ? ledger.entries : {};
    return Object.keys(entries).map(function (k) { return entries[k]; });
  }

  // Chinese reminder that lists each unfinished source and where to continue. Empty list gives an empty string.
  // 覆蓋範圍型來源（單位＝第幾筆）的缺口描述：「第 a～b 筆」（人看的是 1 起算，區間是 0 起算半開）
  function gapText(e, cursorFor) {
    var gs = (e.gaps || []).slice(0, 6).map(function (g) { return '第 ' + (g[0] + 1) + '～' + g[1] + ' 筆' + (e.viaOffset ? '（offset：' + g[0] + '）' : typeof cursorFor === 'function' ? '（cursor：' + cursorFor(e.source, g[0]) + '）' : ''); });
    if ((e.gaps || []).length > 6) gs.push('…還有 ' + (e.gaps.length - 6) + ' 段');
    return gs.join('、');
  }
  // 頁數預估：記錄清單還要幾頁（沒讀的筆數 ÷ 平均每頁讀到幾筆）；opts.room（上下文還剩幾 token）與 opts.pageTokens（一頁約幾 token）
  // 給了就一併算「放得下幾頁」。放不下就別無止盡續讀：先用 grep／json 只取需要的，或把已讀的重點寫成摘要（舊頁會被換成 placeholder）。
  function estimate(e, opts) {
    if (!e || e.unit !== 'record' || !(e.total > 0)) return null;
    var got = (e.covered || []).reduce(function (s, r) { return s + (r[1] - r[0]); }, 0), pages = e.pages || 0;
    var left = Math.max(0, e.total - got); if (!left) return { pagesLeft: 0, fits: null, enough: true };
    var per = pages > 0 && got > 0 ? got / pages : 0; var pagesLeft = per > 0 ? Math.ceil(left / per) : null;
    var fits = opts && opts.room > 0 && opts.pageTokens > 0 ? Math.max(0, Math.floor(opts.room / opts.pageTokens)) : null;
    return { pagesLeft: pagesLeft, fits: fits, enough: pagesLeft == null || fits == null ? null : fits >= pagesLeft };
  }
  function reminderText(list, opts) {
    var items = Array.isArray(list) ? list : [];
    if (!items.length) return '';
    var cursorFor = opts && opts.cursorFor;
    var lines = items.map(function (e) {
      if (e.unit === 'record') {
        var got = (e.covered || []).reduce(function (s, r) { return s + (r[1] - r[0]); }, 0);
        var miss = (e.gaps || []).length ? '還沒讀：' + gapText(e, cursorFor) : (e.pendingPart ? '第 ' + (e.pendingPart.record + 1) + ' 筆太大分成 ' + e.pendingPart.of + ' 段，還有第 ' + (e.pendingPart.next + 1) + ' 段以後沒讀' : '還沒收到最後一頁');
        var est = estimate(e, opts), estText = '';
        if (est && est.pagesLeft != null) estText = '；約還要 ' + est.pagesLeft + ' 頁' + (est.fits != null ? '，現在的上下文只放得下約 ' + est.fits + ' 頁' + (est.enough ? '' : '：放不下，別一頁頁全讀——先用 big_content 的 grep／json 只取需要的，或先把已讀的重點寫成一小段摘要再繼續（舊的頁會被省略）') : '');
        return '・來源 ' + e.label + '（記錄清單，已讀 ' + got + '／' + e.total + ' 筆）：' + miss + estText + (e.nextCursor && !(e.gaps || []).length ? '；下一頁 cursor：' + e.nextCursor : '');
      }
      var where = e.nextOffset != null ? '下一個 offset：' + e.nextOffset
        : e.nextStartLine != null ? '下一個起始行：' + e.nextStartLine
        : '沒有提供續讀位置，可能只讀了一部分';
      var total = e.total != null ? '（總量 ' + e.total + '）' : '';
      return '・來源 ' + e.label + '（工具 ' + e.toolName + '）：' + where + total;
    });
    return '【讀取尚未完成】以下來源還沒有讀到最後一頁：\n' + lines.join('\n') +
      '\n請用上面的續讀位置繼續呼叫工具讀完。讀完之前不可下結論，不要說「報告都正確」之類的話。';
  }

  // 給最終回答前面由程式附加的警語用：一個沒讀完的來源讀到哪、缺什麼（不靠模型自己說）
  function describe(e) {
    if (e.unit === 'record') {
      var got = (e.covered || []).reduce(function (s, r) { return s + (r[1] - r[0]); }, 0);
      return e.label + '（只讀了 ' + got + '／' + e.total + ' 筆' + ((e.gaps || []).length ? '，沒讀到：' + gapText(e) : '') + '）';
    }
    return e.label + '（已讀到 ' + (e.nextOffset != null ? 'offset ' + e.nextOffset : '第 ' + e.nextStartLine + ' 行') + '）';
  }

  return {
    createLedger: createLedger,
    record: record,
    pending: pending,
    reminderText: reminderText,
    estimate: estimate,
    describe: describe,
    sourceKey: sourceKey
  };
}));
