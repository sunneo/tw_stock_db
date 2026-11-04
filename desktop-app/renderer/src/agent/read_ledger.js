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
    return 'args=' + stableStr(a);
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

  // Returns a new ledger after one tool result. Failed results (ok:false) change nothing.
  function record(ledger, toolName, args, resultObj) {
    var base = isObj(ledger) && isObj(ledger.entries) ? ledger : createLedger();
    if (!isObj(resultObj) || resultObj.ok === false) return { entries: Object.assign({}, base.entries) };
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
    return { entries: entries };
  }

  // Unfinished reads, oldest first (insertion order).
  function pending(ledger) {
    var entries = isObj(ledger) && isObj(ledger.entries) ? ledger.entries : {};
    return Object.keys(entries).map(function (k) { return entries[k]; });
  }

  // Chinese reminder that lists each unfinished source and where to continue. Empty list gives an empty string.
  function reminderText(list) {
    var items = Array.isArray(list) ? list : [];
    if (!items.length) return '';
    var lines = items.map(function (e) {
      var where = e.nextOffset != null ? '下一個 offset：' + e.nextOffset
        : e.nextStartLine != null ? '下一個起始行：' + e.nextStartLine
        : '沒有提供續讀位置，可能只讀了一部分';
      var total = e.total != null ? '（總量 ' + e.total + '）' : '';
      return '・來源 ' + e.label + '（工具 ' + e.toolName + '）：' + where + total;
    });
    return '【讀取尚未完成】以下來源還沒有讀到最後一頁：\n' + lines.join('\n') +
      '\n請用上面的續讀位置繼續呼叫工具讀完。讀完之前不可下結論，不要說「報告都正確」之類的話。';
  }

  return {
    createLedger: createLedger,
    record: record,
    pending: pending,
    reminderText: reminderText,
    sourceKey: sourceKey
  };
}));
