// 網頁內文 → 區塊記錄（純函式，無 DOM、無 I/O、UMD；嵌入 floating-assistant 後用 new Function 載入）。
// 用途：很長的網頁內文（Markdown）不再「整份一大段」，而是一個區塊一行 JSONL，交給 JSONL 分頁器一頁頁讀，
// 每筆都有所屬章節（sec）、類型、連結參照，另外附一份章節參照表（outline）。設計見 DESIGN.jsonl-paging.md 第九節。
//   toBlocks(markdown, { maxRecordChars }) → { lines:[JSON 字串], blocks:n, outline:[{ref,level,title,from,to,chars}], links:n, total_chars }
// 記錄：{i, t:'h'|'p'|'li'|'code'|'table'|'quote', sec:'s3', level?, text, links?:[{text,url}], lang?}
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaWebBlocks = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LINK_RE = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  // 連結拆成 text＋links：內文只留連結文字，網址放 links（省字元，也方便模型照網址再抓）
  function splitLinks(s) {
    var links = [];
    var text = s.replace(LINK_RE, function (m, t, u) {
      if (m.charAt(0) === '!') return t ? '[圖：' + t + ']' : '[圖]';
      if (t) links.push({ text: t, url: u });
      return t || u;
    });
    return { text: text, links: links };
  }

  function toBlocks(markdown, opts) {
    opts = opts || {};
    var maxRec = Number(opts.maxRecordChars) > 0 ? Number(opts.maxRecordChars) : 0; // 0＝不切；單筆過大由分頁器的 record_part 處理
    var rows = String(markdown == null ? '' : markdown).replace(/^﻿/, '').split(/\r?\n/);
    var recs = [], starts = [], pend = -1, outline = [], secCount = 0, curSec = 's0', linkTotal = 0;
    var para = [], list = [], table = [], quote = [];
    function push(r, at) { r.i = recs.length; recs.push(r); starts.push(at != null ? at : (pend >= 0 ? pend : 0)); }
    function withLinks(t, r) { var x = splitLinks(t); r.text = x.text; if (x.links.length) { r.links = x.links; linkTotal += x.links.length; } return r; }
    function flush() {
      var at = pend; pend = -1;
      if (para.length) { push(withLinks(para.join(' ').replace(/\s+/g, ' ').trim(), { t: 'p', sec: curSec }), at); para = []; }
      if (list.length) { for (var i = 0; i < list.length; i++) push(withLinks(list[i].text, { t: 'li', sec: curSec, depth: list[i].depth }), list[i].at); list = []; }
      if (table.length) { push({ t: 'table', sec: curSec, text: table.join('\n') }, at); table = []; }
      if (quote.length) { push(withLinks(quote.join(' ').trim(), { t: 'quote', sec: curSec }), at); quote = []; }
    }
    var fence = null, code = [], off = 0;
    for (var n = 0; n < rows.length; n++) {
      var line = rows[n], lineOff = off; off += line.length + 1;
      var fm = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
      if (fence) {
        if (fm && fm[1] === fence.mark) { push({ t: 'code', sec: curSec, lang: fence.lang || undefined, text: code.join('\n') }, fence.at); fence = null; code = []; } else code.push(line);
        continue;
      }
      if (fm) { flush(); fence = { mark: fm[1], lang: fm[2], at: lineOff }; code = []; continue; }
      if (!line.trim()) { flush(); continue; }
      var hm = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (hm) {
        flush(); secCount++; curSec = 's' + secCount;
        var ht = splitLinks(hm[2]).text; var r = { t: 'h', sec: curSec, level: hm[1].length, text: ht }; push(r, lineOff);
        outline.push({ ref: curSec, level: r.level, title: ht, from: r.i, to: r.i, chars: 0, from_char: lineOff, to_char: 0 });
        continue;
      }
      var lm = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (lm) { if (para.length || table.length || quote.length) flush(); list.push({ text: lm[2], depth: Math.floor(lm[1].replace(/\t/g, '  ').length / 2), at: lineOff }); continue; }
      if (/^\s*\|/.test(line)) { if (para.length || list.length || quote.length) flush(); if (pend < 0) pend = lineOff; table.push(line.trim()); continue; }
      var qm = /^\s*>\s?(.*)$/.exec(line);
      if (qm) { if (para.length || list.length || table.length) flush(); if (pend < 0) pend = lineOff; quote.push(qm[1]); continue; }
      if (list.length || table.length || quote.length) flush();
      if (pend < 0) pend = lineOff; para.push(line.trim());
    }
    if (fence) push({ t: 'code', sec: curSec, lang: fence.lang || undefined, text: code.join('\n') }, fence.at);
    flush();
    // 章節的涵蓋範圍與字數
    var os = {}; for (var k = 0; k < outline.length; k++) os[outline[k].ref] = outline[k];
    for (var q = 0; q < outline.length; q++) outline[q].to_char = q + 1 < outline.length ? outline[q + 1].from_char : off; // 章節在原文（參照文件）裡的字元範圍
    var total = 0;
    for (var j = 0; j < recs.length; j++) { var o = os[recs[j].sec]; var len = (recs[j].text || '').length; total += len; if (o) { o.to = j; o.chars += len; } }
    var lines = recs.map(function (r) { return JSON.stringify(r); });
    void maxRec;
    return { lines: lines, starts: starts, lens: recs.map(function (r) { return (r.text || '').length; }), blocks: recs.length, outline: outline, links: linkTotal, total_chars: total };
  }

  // 章節參照表壓成一小段（放第一頁的 head）：最多 maxItems 筆，超過就只留最上層標題並註明
  function outlineForHead(outline, maxItems) {
    maxItems = maxItems || 60;
    var o = outline.slice();
    if (o.length > maxItems) { var minL = Math.min.apply(null, o.map(function (x) { return x.level; })); var top = o.filter(function (x) { return x.level <= minL + 1; }); o = top.length > maxItems ? top.slice(0, maxItems) : top; }
    return o.map(function (x) { return { ref: x.ref, level: x.level, title: x.title.slice(0, 60), from: x.from, to: x.to, chars: x.chars }; });
  }

  // 第 0 層（章節索引，一章一行）：{ref,level,title,parent,blocks:[from,to],chars,doc:{offset,chars}}；parent＝上一個比它淺的標題。
  // 沒有任何標題時給一個 s0 假章節涵蓋全部，確保有索引可讀。
  function sectionIndex(built, docChars, opts) {
    var out = [], stack = [], ol = built.outline;
    if (!ol.length) {
      var target = Number(opts && opts.chunkChars) > 0 ? Number(opts.chunkChars) : 6000, st = built.starts || [], parts = [], from = 0, acc = 0, lens = built.lens || [];
      if (built.blocks <= 1 || built.total_chars <= target) return [{ ref: 's0', level: 0, title: '（全文，沒有標題）', parent: null, blocks: [0, Math.max(0, built.blocks - 1)], chars: built.total_chars, doc: { offset: 0, chars: docChars || built.total_chars } }];
      for (var b = 0; b < built.blocks; b++) { acc += lens[b] || 0; if (acc >= target || b === built.blocks - 1) { parts.push({ from: b - (b - from), to: b, chars: acc }); from = b + 1; acc = 0; } }
      return parts.map(function (pt, n) {
        var off = st[pt.from] || 0, end = n + 1 < parts.length ? (st[parts[n + 1].from] || docChars || 0) : (docChars || built.total_chars);
        return { ref: 's' + (n + 1), level: 1, title: '第 ' + (n + 1) + ' 段（區塊 ' + pt.from + '–' + pt.to + '）', parent: null, blocks: [pt.from, pt.to], chars: pt.chars, doc: { offset: off, chars: Math.max(0, end - off) } };
      });
    }
    var lead = ol[0].from_char > 0 && ol[0].from > 0; // 第一個標題之前有內容
    if (lead) out.push({ ref: 's0', level: 0, title: '（開頭，第一個標題之前）', parent: null, blocks: [0, ol[0].from - 1], chars: 0, doc: { offset: 0, chars: ol[0].from_char } });
    for (var i = 0; i < ol.length; i++) {
      var o = ol[i]; while (stack.length && stack[stack.length - 1].level >= o.level) stack.pop();
      out.push({ ref: o.ref, level: o.level, title: o.title, parent: stack.length ? stack[stack.length - 1].ref : null, blocks: [o.from, o.to], chars: o.chars, doc: { offset: o.from_char, chars: Math.max(0, Math.min(o.to_char, docChars || o.to_char) - o.from_char) } });
      stack.push(o);
    }
    return out;
  }

  return { sectionIndex: sectionIndex, toBlocks: toBlocks, splitLinks: splitLinks, outlineForHead: outlineForHead };
}));
