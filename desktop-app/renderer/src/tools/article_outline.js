/* 長文章的目錄與分段閱讀（純函式，UMD）：外面的 wiki、新聞、一整本小說、上傳的文件都用同一套。
 * 做法：先看目錄（各章節的標題、層級、字數），再挑要讀的章節，不用一直翻頁讀不完。
 *   outline(text)                 → { style, total_chars, sections:[{ n, level, title, start, end, chars, preview }] }
 *   sectionText(text, outline, which, { offset, maxChars }) → { section, content, offset, has_more, next_offset }
 * 標題的認法（依序試，第一種找到 2 個以上就用它）：Markdown（#）、MediaWiki（== 標題 ==）、Textile（h2.）、
 *   HTML（<h2>）、底線式標題（標題下一行是 === 或 ---）、小說章回（第一章／第十二回／Chapter 3／序章／楔子／尾聲）、
 *   編號標題（1. 簡介、1.2 背景、一、緒論）。都認不出來就依段落切成大小差不多的幾份。
 * 程式碼區塊（```）裡的 # 不算標題。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaArticleOutline = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX_SECTIONS = 300, PREVIEW = 60, FALLBACK_TARGET = 6000;
  var CN_NUM = '零〇一二三四五六七八九十百千萬两兩壹貳參叁肆伍陸柒捌玖拾佰仟0-9０-９';

  function lineStarts(text) { var out = [0], i = -1; while ((i = text.indexOf('\n', i + 1)) >= 0) out.push(i + 1); return out; }
  function strip(s) { return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

  // 每種寫法一個偵測器：回傳 [{ start, level, title }]（start 是該標題行在全文的起點）
  var DETECTORS = [
    { style: 'markdown', find: function (lines, starts) {
      var out = [], fence = false;
      for (var i = 0; i < lines.length; i++) {
        if (/^\s*(```|~~~)/.test(lines[i])) { fence = !fence; continue; }
        if (fence) continue;
        var m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]); if (m) out.push({ start: starts[i], level: m[1].length, title: strip(m[2]) });
      }
      return out;
    } },
    { style: 'mediawiki', find: function (lines, starts) {
      var out = [];
      for (var i = 0; i < lines.length; i++) { var m = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(lines[i]); if (m) out.push({ start: starts[i], level: m[1].length - 1, title: strip(m[2]) }); }
      return out;
    } },
    { style: 'textile', find: function (lines, starts) {
      var out = [];
      for (var i = 0; i < lines.length; i++) { var m = /^h([1-6])\.\s+(.+)$/.exec(lines[i]); if (m) out.push({ start: starts[i], level: +m[1], title: strip(m[2]) }); }
      return out;
    } },
    { style: 'html', find: function (lines, starts) {
      var out = [];
      for (var i = 0; i < lines.length; i++) { var m = /^\s*<h([1-6])[^>]*>(.*?)<\/h\1>\s*$/i.exec(lines[i]); if (m) out.push({ start: starts[i], level: +m[1], title: strip(m[2]) }); }
      return out;
    } },
    { style: 'underline', find: function (lines, starts) {
      var out = [];
      for (var i = 0; i + 1 < lines.length; i++) {
        if (!lines[i].trim() || lines[i].length > 120) continue;
        var u = /^\s*(={3,}|-{3,})\s*$/.exec(lines[i + 1]); if (u && !/^\s*(={3,}|-{3,})\s*$/.test(lines[i])) out.push({ start: starts[i], level: u[1][0] === '=' ? 1 : 2, title: strip(lines[i]) });
      }
      return out;
    } },
    { style: 'chapters', find: function (lines, starts) {
      // 小說：第一章／第十二回／第3節／卷二、Chapter 3、CHAPTER IV、序章、楔子、引子、尾聲、後記、番外
      var re = new RegExp('^\\s*(第[' + CN_NUM + ']+[章回節节卷部篇集話话幕].{0,60}|[卷篇部][' + CN_NUM + ']+.{0,40}|(?:chapter|part|book|section)\\s+(?:[0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\\b.{0,60}|(?:序章|序幕|序言|序|楔子|引子|前言|後記|后记|尾聲|尾声|終章|终章|番外[^\\n]{0,30}|附錄[^\\n]{0,30}|prologue|epilogue|preface|afterword)\\s*[:：]?.{0,40})\\s*$', 'i');
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i]; if (ln.length > 90) continue;
        var m = re.exec(ln); if (m) out.push({ start: starts[i], level: /^\s*[卷篇部]|^\s*(part|book)\b/i.test(ln) ? 1 : 2, title: strip(ln) });
      }
      return out;
    } },
    { style: 'numbered', find: function (lines, starts) {
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i]; if (ln.length > 80 || !ln.trim()) continue;
        var m = /^\s*(\d+(?:\.\d+){0,3})[.)、．]?\s+(\S.{0,70})$/.exec(ln) || /^\s*([一二三四五六七八九十]+)[、.．]\s*(\S.{0,70})$/.exec(ln);
        if (m && !/[。！？!?]$/.test(ln.trim())) out.push({ start: starts[i], level: /^\d/.test(m[1]) ? m[1].split('.').length : 1, title: strip(ln) });
      }
      return out;
    } },
  ];

  function fallbackSections(text) {
    // 沒有標題：依空行把段落湊成差不多大的幾份
    var out = [], pos = 0, n = text.length;
    while (pos < n) {
      var end = Math.min(n, pos + FALLBACK_TARGET);
      if (end < n) { var br = text.indexOf('\n\n', end); end = br >= 0 && br - end < FALLBACK_TARGET ? br + 2 : Math.min(n, end); }
      var first = text.slice(pos, end).trim().split('\n')[0] || '';
      out.push({ start: pos, level: 1, title: '第 ' + (out.length + 1) + ' 段：' + strip(first).slice(0, 30) });
      pos = end;
    }
    return out;
  }

  function outline(text, opts) {
    opts = opts || {};
    text = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    var total = text.length, lines = text.split('\n'), starts = lineStarts(text);
    var found = null, style = 'paragraphs';
    for (var d = 0; d < DETECTORS.length; d++) {
      var hits = DETECTORS[d].find(lines, starts);
      if (hits.length >= 2 || (hits.length === 1 && total > 20000 && DETECTORS[d].style === 'markdown')) { found = hits; style = DETECTORS[d].style; break; }
    }
    if (!found) found = fallbackSections(text);
    // 層級太多時只留上層，目錄不要比文章還長
    if (found.length > MAX_SECTIONS) { var maxLv = 1; for (var lv = 6; lv >= 1; lv--) { if (found.filter(function (h) { return h.level <= lv; }).length <= MAX_SECTIONS) { maxLv = lv; break; } } found = found.filter(function (h) { return h.level <= maxLv; }).slice(0, MAX_SECTIONS); }
    var depth = Number(opts.max_depth); if (depth >= 1) found = found.filter(function (h) { return h.level <= depth; });
    var sections = [];
    // 第一個標題之前的文字（前言、摘要）自成一節
    if (found.length && text.slice(0, found[0].start).replace(/\s+/g, '').length > 10 && style !== 'paragraphs') sections.push({ start: 0, level: 1, title: '（開頭：第一個標題之前）' });
    found.forEach(function (h) { sections.push(h); });
    sections.forEach(function (s, i) {
      s.n = i + 1; s.end = i + 1 < sections.length ? sections[i + 1].start : total; s.chars = s.end - s.start;
      var body = text.slice(s.start, s.end).split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
      s.preview = body.slice(0, PREVIEW);
    });
    return { style: style, total_chars: total, count: sections.length, sections: sections };
  }

  // which：章節編號（數字）、標題的一部分（字串）、或 { from, to } 連續幾節
  function pick(ol, which) {
    if (which && typeof which === 'object' && which.from != null) {
      var a = Math.max(1, Math.floor(+which.from)), b = Math.min(ol.sections.length, Math.floor(+which.to || a));
      if (!(a >= 1) || a > ol.sections.length) return null;
      return { from: ol.sections[a - 1], to: ol.sections[Math.max(a, b) - 1], label: a === b ? ol.sections[a - 1].title : '第 ' + a + '–' + b + ' 節' };
    }
    if (typeof which === 'number' || /^\d+$/.test(String(which))) { var s = ol.sections[+which - 1]; return s ? { from: s, to: s, label: s.title } : null; }
    var q = String(which == null ? '' : which).trim().toLowerCase(); if (!q) return null;
    var hit = ol.sections.filter(function (s) { return s.title.toLowerCase() === q; })[0] || ol.sections.filter(function (s) { return s.title.toLowerCase().indexOf(q) >= 0; })[0];
    return hit ? { from: hit, to: hit, label: hit.title } : null;
  }

  function sectionText(text, ol, which, opts) {
    opts = opts || {};
    text = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    var p = pick(ol, which);
    if (!p) return { error: 'no such section: ' + JSON.stringify(which) + ' (sections 1.. ' + ol.sections.length + '; give the number from article_outline, part of its title, or {from, to})' };
    var start = p.from.start, end = p.to.end, total = end - start;
    var budget = Math.max(500, Math.min(120000, Math.floor(+opts.maxChars || 12000)));
    var off = Math.max(0, Math.min(total, Math.floor(+opts.offset || 0)));
    var stop = Math.min(total, off + budget);
    if (stop < total) { var nl = text.lastIndexOf('\n', start + stop); if (nl > start + off + budget * 0.5) stop = nl + 1 - start; }
    var more = stop < total;
    return { section: p.label, from_section: p.from.n, to_section: p.to.n, content: text.slice(start + off, start + stop), offset: off, returned_chars: stop - off, section_chars: total, has_more: more, next_offset: more ? stop : null };
  }

  return { outline: outline, sectionText: sectionText, pick: pick };
});
