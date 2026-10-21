/* Knowledge Inventory 的核心（純函式，UMD）：把各種格式的文字整理成「帶行號的來源」，切片段、建關鍵字索引、檢索、
 * 選原句做摘要、找字面上的關聯。每一個輸出都帶出處（哪個來源、第幾行、哪個章節／頁／投影片／工作表／時間），
 * 而且摘要與回答只會是「來源裡原本就有的字」——不改寫、不補充，核對不過的丟掉。
 *
 * 行號的意思：把來源轉成「純文字行」之後的第幾行（從 1 算）。純文字類（txt、md、textile、mediawiki、log、csv…）就是檔案本身的行號；
 * json 會先格式化成每個欄位一行（引用時會註明是格式化後的行號，並附欄位路徑）；docx／pdf／pptx／mp3／mp4 先由 app 轉成文字，
 * 轉換時留下的 [第 3 頁]、[投影片 2]、[00:01:23] 標記會成為該行的位置資訊。
 * 儲存（.keeplookup＝SQLite3 檔）與介面不在這裡，這裡只有不碰儲存的邏輯，方便測試。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../tools/article_outline.js')); else root.FaKnowledge = factory(root.FaArticleOutline || (typeof FaArticleOutline !== 'undefined' ? FaArticleOutline : undefined));
})(typeof self !== 'undefined' ? self : this, function (Outline) {
  'use strict';
  var CHUNK_CHARS = 1200;

  // ───── 斷詞：英文數字用整個字（小寫），中日韓用相鄰兩字（bigram）＋單字，檢索與建索引用同一套 ─────
  var CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;
  function tokenize(text) {
    var out = [], s = String(text == null ? '' : text).toLowerCase(), i = 0, n = s.length;
    while (i < n) {
      var c = s[i];
      if (CJK.test(c)) { var j = i; while (j < n && CJK.test(s[j])) j++; var run = s.slice(i, j); for (var k = 0; k < run.length; k++) { out.push(run[k]); if (k + 1 < run.length) out.push(run.slice(k, k + 2)); } i = j; }
      else if (/[a-z0-9]/.test(c)) { var j2 = i; while (j2 < n && /[a-z0-9_.\-]/.test(s[j2]) && !CJK.test(s[j2])) j2++; var w = s.slice(i, j2).replace(/[.\-_]+$/, ''); if (w) out.push(w); i = j2; }
      else i++;
    }
    return out;
  }

  // ───── 各種格式 → 純文字行（含每一行的位置資訊 locator）─────
  function pathLocators(lines, kind) {
    // json／yaml／toon：用縮排追出欄位路徑（只是說明位置用，不影響內容）
    var stack = [], loc = [];
    lines.forEach(function (ln) {
      var m = /^(\s*)(?:- )?"?([^":\s][^":]*)"?\s*:/.exec(ln);
      if (!m) { loc.push(stack.length ? { path: stack.map(function (x) { return x.k; }).join('.') } : {}); return; }
      var ind = m[1].length; while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
      stack.push({ ind: ind, k: m[2] }); loc.push({ path: stack.map(function (x) { return x.k; }).join('.') });
    });
    return loc;
  }
  function prettyJson(raw) { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { return null; } }

  // raw：原始文字；kind：副檔名或種類（md、txt、json、jsonl、csv、yaml、toon、textile、mediawiki、log、docx…）
  // xlsx 這種已由 app 解析好的，用 { sheets:[{ name, rows:[[…]] }] } 當 raw
  function normalize(kind, raw) {
    kind = String(kind || 'txt').toLowerCase().replace(/^\./, '');
    var notes = [], text, locators = null;
    if (raw && typeof raw === 'object' && Array.isArray(raw.sheets)) {
      var ls = [], lc = [];
      raw.sheets.forEach(function (sh) { (sh.rows || []).forEach(function (row, ri) { ls.push(sh.name + '!' + (ri + 1) + '：' + (row || []).map(function (c) { return c == null ? '' : String(c); }).join(' | ')); lc.push({ sheet: sh.name, row: ri + 1 }); }); });
      return { kind: 'xlsx', text: ls.join('\n'), locators: lc, notes: ['xlsx：每一行是「工作表!列號：儲存格 | 儲存格…」'] };
    }
    text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').replace(/^﻿/, '');
    if (kind === 'json') { var p = prettyJson(text); if (p != null) { text = p; notes.push('json：行號是格式化（每個欄位一行）之後的行號'); } else notes.push('json 解析失敗，當純文字處理'); }
    if (kind === 'jsonl' || kind === 'ndjson') { var recs = text.split('\n'); locators = recs.map(function (_, i) { return { record: i + 1 }; }); notes.push('jsonl：每一行是一筆記錄'); }
    if (kind === 'json' || kind === 'yaml' || kind === 'yml' || kind === 'toon') { locators = pathLocators(text.split('\n'), kind); }
    if (kind === 'csv' || kind === 'tsv') notes.push(kind + '：第 1 行是欄位名稱，之後每行一筆，行號就是檔案裡的行號');
    // 位置標記：[第 3 頁]、[page 3]、[投影片 2]、[slide 2]、[00:01:23]、[00:01:23 - 00:01:30]
    var lines = text.split('\n'); var cur = {}; var loc2 = [];
    lines.forEach(function (ln, i) {
      var m = /^\s*\[\s*(?:第\s*(\d+)\s*頁|page\s*(\d+)|投影片\s*(\d+)|slide\s*(\d+)|(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[-–~～]\s*\d{1,2}:\d{2}(?::\d{2})?)?)\s*\]/i.exec(ln);
      if (m) { cur = m[1] || m[2] ? { page: +(m[1] || m[2]) } : m[3] || m[4] ? { slide: +(m[3] || m[4]) } : { time: m[5] }; }
      var base = locators && locators[i] ? locators[i] : {};
      loc2.push(Object.assign({}, cur, base));
    });
    return { kind: kind, text: text, locators: loc2, notes: notes };
  }

  // ───── 來源：行、章節目錄、片段 ─────
  function locLabel(l) { if (!l) return ''; var o = []; if (l.sheet) o.push('工作表 ' + l.sheet + ' 第 ' + l.row + ' 列'); if (l.page) o.push('第 ' + l.page + ' 頁'); if (l.slide) o.push('投影片 ' + l.slide); if (l.time) o.push('時間 ' + l.time); if (l.record) o.push('第 ' + l.record + ' 筆'); if (l.path) o.push('欄位 ' + l.path); return o.join('，'); }

  // opts: { id, name, kind, raw, url, chunkChars }
  function ingest(opts) {
    opts = opts || {};
    var n = normalize(opts.kind, opts.raw), text = n.text;
    var lines = text.split('\n'), starts = [0]; for (var i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    var lineOf = function (off) { var lo = 0, hi = starts.length - 1; while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
    var ol = Outline.outline(text);
    var sections = ol.sections.map(function (s) { return { n: s.n, level: s.level, title: s.title, line_start: lineOf(s.start), line_end: lineOf(Math.max(s.start, s.end - 1)), chars: s.chars }; });
    var secOfLine = function (ln) { for (var k = sections.length - 1; k >= 0; k--) if (sections[k].line_start <= ln) return sections[k]; return null; };
    var chunks = [], max = Math.max(200, opts.chunkChars || CHUNK_CHARS), buf = [], bufChars = 0, bufStart = 1;
    var flush = function (endLine) { if (!buf.length) return; var t = buf.join('\n'); if (t.trim()) { var sec = secOfLine(bufStart); chunks.push({ n: chunks.length + 1, line_start: bufStart, line_end: endLine, text: t, section: sec ? sec.title : '', section_n: sec ? sec.n : 0, loc: locLabel(n.locators[bufStart - 1]) }); } buf = []; bufChars = 0; };
    var headerLine = (n.kind === 'csv' || n.kind === 'tsv') ? lines[0] : null;
    for (var li = 0; li < lines.length; li++) {
      var ln = lines[li], lineNo = li + 1, sec2 = secOfLine(lineNo), prevSec = buf.length ? secOfLine(bufStart) : null;
      if (buf.length && ((sec2 && prevSec && sec2.n !== prevSec.n) || bufChars + ln.length + 1 > max)) { flush(lineNo - 1); }
      if (!buf.length) bufStart = lineNo;
      buf.push(ln); bufChars += ln.length + 1;
    }
    flush(lines.length);
    return { id: opts.id || null, name: opts.name || '(未命名)', kind: n.kind, url: opts.url || null, notes: n.notes, text: text, lines: lines, locators: n.locators, sections: sections, chunks: chunks, outline_style: ol.style, total_chars: text.length };
  }

  // ───── 出處 ─────
  // 每一則檢索結果與摘要句都長這樣：{ source, source_id, kind, line_start, line_end, section, loc, quote }
  function cite(src, a, b, quote) {
    var sec = null; for (var k = src.sections.length - 1; k >= 0; k--) if (src.sections[k].line_start <= a) { sec = src.sections[k]; break; }
    var lbl = '「' + src.name + '」' + (a === b ? '第 ' + a + ' 行' : '第 ' + a + '–' + b + ' 行') + (src.kind === 'json' ? '（json 格式化後）' : '') + (sec && sec.title && sec.title.indexOf('（開頭') !== 0 ? '，章節「' + sec.title + '」' : '');
    var loc = locLabel(src.locAt ? src.locAt(a) : src.locators[a - 1]); if (loc) lbl += '，' + loc;
    return { source: src.name, source_id: src.id, kind: src.kind, line_start: a, line_end: b, section: sec ? sec.title : '', loc: loc, label: lbl, quote: quote };
  }

  // 片段裡「真正回答問題的那幾行」：每行算和查詢共有幾個詞，取最高分那行，連著分數夠高的相鄰行（最多 3 行）。
  // 出處指到這幾行（不是整個片段）；片段本身的範圍另外放在 chunk_line_start／chunk_line_end。沒有任何一行有共同詞（純語意命中）就用整個片段。
  function pinpoint(src, ch, qt) {
    var set = {}; qt.forEach(function (t) { set[t] = 1; });
    var sc = [], best = 0, bi = -1;
    for (var ln = ch.line_start; ln <= ch.line_end; ln++) { var toks = Array.from(new Set(tokenize(src.lines[ln - 1] || ''))), n = 0; toks.forEach(function (t) { if (set[t]) n += t.length > 1 ? 1 : 0.3; }); sc.push(n); if (n > best) { best = n; bi = ln; } }
    if (bi < 0) return { a: ch.line_start, b: ch.line_end, exact: false };
    var a = bi, b = bi, thr = Math.max(0.5, best / 2);
    while (b - a < 2 && a > ch.line_start && sc[a - 1 - ch.line_start] >= thr) a--;
    while (b - a < 2 && b < ch.line_end && sc[b + 1 - ch.line_start] >= thr) b++;
    return { a: a, b: b, exact: true };
  }

  // ───── 關鍵字索引與檢索（BM25）；儲存層用 FTS5 時也用同一套斷詞（toks 欄位）─────
  function buildIndex(sources) {
    var docs = [], df = {}, total = 0;
    sources.forEach(function (src) { src.chunks.forEach(function (ch) { var toks = tokenize(ch.text + ' ' + (ch.section || '')); var tf = {}; toks.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; }); Object.keys(tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; }); docs.push({ src: src, ch: ch, tf: tf, len: toks.length || 1 }); total += toks.length || 1; }); });
    return { docs: docs, df: df, avg: docs.length ? total / docs.length : 1, n: docs.length };
  }
  function search(index, query, opts) {
    opts = opts || {}; var qt = Array.from(new Set(tokenize(query))); if (!qt.length || !index.n) return [];
    var allowed = opts.sources ? new Set(opts.sources) : null, k1 = 1.5, b = 0.75, hits = [];
    index.docs.forEach(function (d) {
      if (allowed && !allowed.has(d.src.id) && !allowed.has(d.src.name)) return;
      var score = 0, matched = 0;
      qt.forEach(function (t) { var f = d.tf[t]; if (!f) return; matched++; var idf = Math.log(1 + (index.n - (index.df[t] || 0) + 0.5) / ((index.df[t] || 0) + 0.5)); score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / index.avg)) * (t.length > 1 ? 1 : 0.4); });
      if (score > 0) hits.push({ score: score, coverage: matched / qt.length, d: d });
    });
    hits.sort(function (a, c) { return c.score - a.score; });
    var minCov = opts.minCoverage == null ? 0.3 : opts.minCoverage;
    return hits.filter(function (h) { return h.coverage >= minCov; }).slice(0, opts.limit || 5).map(function (h) { var ch = h.d.ch, pp = pinpoint(h.d.src, ch, qt); return Object.assign(cite(h.d.src, pp.a, pp.b, h.d.src.lines.slice(pp.a - 1, pp.b).join('\n')), { score: Math.round(h.score * 100) / 100, coverage: Math.round(h.coverage * 100) / 100, chunk_n: ch.n, chunk_line_start: ch.line_start, chunk_line_end: ch.line_end }); });
  }

  // 哪些向量命中算數。multilingual-e5-small 的相似度很擠（實測：相關的問題 0.86–0.92，完全無關的也有 0.78–0.82），所以不能只設一個低門檻：
  //   ① sim ≥ strict（預設 0.85）→ 算；
  //   ② 不到 strict 但 ≥ floor（0.75），而且比「全部片段相似度的中位數」高出 gap（0.045）以上、池子有 5 個以上片段 → 也算（跨語言的問法會落在這裡，例如英文問中文文件）；
  //   其餘一律不算。寧可漏掉也不要把無關的片段交出去（回傳的是原文，但「看起來有關」的無關片段仍然會誤導）。
  function denseKeep(pool, opts) {
    opts = opts || {}; var strict = opts.minDense == null ? 0.85 : opts.minDense, floor = opts.floorDense == null ? 0.75 : opts.floorDense, gap = opts.minGap == null ? 0.045 : opts.minGap;
    var med = null; if (pool.length >= 5) { var s = pool.map(function (x) { return x.sim; }).sort(function (a, b) { return a - b; }); med = s[s.length >> 1]; }
    return pool.filter(function (x) { return x.sim >= strict || (med != null && x.sim >= floor && x.sim - med >= gap); });
  }

  // ───── 混合檢索：關鍵字（BM25）＋小型向量模型（語意）─────
  // 向量由 app 端用小型嵌入模型算好（每個片段一條、已正規化）放進 index.docs[i].vec；查詢向量用 opts.queryVec。
  // 兩邊各自排名，用 RRF 合併；向量命中要夠像（minDense）才算，避免「語意上有點像」的片段混進來——回傳的永遠是原文片段與出處。
  function searchHybrid(index, query, opts) {
    opts = opts || {}; var limit = opts.limit || 5, k = 60;
    var lex = search(index, query, Object.assign({}, opts, { limit: Math.max(limit * 4, 20), minCoverage: opts.minCoverage == null ? 0.3 : opts.minCoverage }));
    var qv = opts.queryVec, dense = [];
    if (qv && qv.length) {
      var allowed = opts.sources ? new Set(opts.sources) : null, pool = [];
      index.docs.forEach(function (d) { if (!d.vec || d.vec.length !== qv.length) return; if (allowed && !allowed.has(d.src.id) && !allowed.has(d.src.name)) return; var dot = 0; for (var i = 0; i < qv.length; i++) dot += qv[i] * d.vec[i]; pool.push({ d: d, sim: dot }); });
      dense = denseKeep(pool, opts).sort(function (a, b) { return b.sim - a.sim; });
    }
    var key = function (src, ch) { return (src.id || src.name) + '#' + ch.n; }, fused = {};
    lex.forEach(function (h, r) { var kk = (h.source_id || h.source) + '#' + h.chunk_n; fused[kk] = fused[kk] || { rrf: 0, hit: h, how: [] }; fused[kk].rrf += 1 / (k + r + 1); fused[kk].how.push('關鍵字'); });
    dense.slice(0, Math.max(limit * 4, 20)).forEach(function (x, r) { var kk = key(x.d.src, x.d.ch); if (!fused[kk]) fused[kk] = { rrf: 0, hit: (function () { var pp = pinpoint(x.d.src, x.d.ch, Array.from(new Set(tokenize(query)))); return Object.assign(cite(x.d.src, pp.a, pp.b, x.d.src.lines.slice(pp.a - 1, pp.b).join('\n')), { chunk_n: x.d.ch.n, chunk_line_start: x.d.ch.line_start, chunk_line_end: x.d.ch.line_end }); })(), how: [] }; fused[kk].rrf += 1 / (k + r + 1); fused[kk].how.push('語意'); fused[kk].hit.similarity = Math.round(x.sim * 1000) / 1000; });
    return Object.keys(fused).map(function (kk) { var f = fused[kk]; return Object.assign({}, f.hit, { score: Math.round(f.rrf * 10000) / 10000, found_by: f.how.join('＋') }); }).sort(function (a, b) { return b.score - a.score; }).slice(0, limit);
  }

  // ───── 摘要：只選原句 ─────
  function sentencesOf(src) {
    var out = [];
    src.lines.forEach(function (ln, i) {
      var t = ln.trim(); if (!t || /^(#{1,6}\s|={2,6}|h[1-6]\.\s|[-=]{3,}\s*$)/.test(t) || t.length < 6) return;
      t.split(/(?<=[。！？!?；;])|(?<=[.])\s+(?=[A-Z0-9「"'(（])/).forEach(function (s) { s = s.trim(); if (s.length >= 6) out.push({ text: s, line: i + 1 }); });
    });
    return out;
  }
  // 每個章節挑最有代表性的幾句（詞頻分數），回傳原句與出處；不改寫
  function summarize(src, opts) {
    opts = opts || {}; var per = opts.perSection || 2, ss = sentencesOf(src), df = {}, tf = {};
    ss.forEach(function (s) { s.toks = Array.from(new Set(tokenize(s.text))); s.toks.forEach(function (t) { df[t] = (df[t] || 0) + 1; }); tokenize(s.text).forEach(function (t) { tf[t] = (tf[t] || 0) + 1; }); });
    var N = ss.length || 1;
    ss.forEach(function (s) { var sc = 0; s.toks.forEach(function (t) { if (t.length > 1) sc += (tf[t] || 1) * Math.log(1 + N / (df[t] || 1)); }); s.score = sc / Math.sqrt(s.toks.length || 1); });
    var bySec = {}; ss.forEach(function (s) { var sec = src.sections.slice().reverse().find(function (x) { return x.line_start <= s.line; }); var key = sec ? sec.n : 0; (bySec[key] = bySec[key] || []).push(s); });
    var out = [];
    Object.keys(bySec).map(Number).sort(function (a, b) { return a - b; }).forEach(function (key) {
      var pick = bySec[key].slice().sort(function (a, b) { return b.score - a.score; }).slice(0, per).sort(function (a, b) { return a.line - b.line; });
      pick.forEach(function (s) { out.push(cite(src, s.line, s.line, s.text)); });
    });
    var cap = opts.maxSentences || 40; if (out.length > cap) out = out.sort(function (a, b) { return b.quote.length - a.quote.length; }).slice(0, cap).sort(function (a, b) { return a.line_start - b.line_start; });
    return out;
  }

  // 核對：一句話（摘要、回答裡引用的字）真的出現在來源的那幾行裡？（忽略空白差異）
  function verifyQuote(src, quote, a, b) {
    var squash = function (s) { return String(s).replace(/\s+/g, ''); };
    var q = squash(quote); if (!q) return false;
    var from = Math.max(1, a || 1), to = Math.min(src.lines.length, b || src.lines.length);
    return squash(src.lines.slice(from - 1, to).join('\n')).indexOf(q) >= 0;
  }
  function verifyAll(src, cites) { var bad = []; cites.forEach(function (c) { if (!verifyQuote(src, c.quote, c.line_start, c.line_end)) bad.push(c); }); return { ok: bad.length === 0, bad: bad }; }

  // 細節：某個章節（或行範圍）的原文，逐行附行號
  function detail(src, which, opts) {
    opts = opts || {}; var a, b;
    if (which && typeof which === 'object' && which.line_start) { a = which.line_start; b = which.line_end || a; }
    else { var sec = typeof which === 'number' ? src.sections[which - 1] : src.sections.filter(function (s) { return s.title.toLowerCase().indexOf(String(which).toLowerCase()) >= 0; })[0]; if (!sec) return { error: '找不到這個章節：' + which }; a = sec.line_start; b = sec.line_end; }
    var cap = opts.maxLines || 200, to = Math.min(b, a + cap - 1);
    return { cite: cite(src, a, to, null), lines: src.lines.slice(a - 1, to).map(function (t, i) { return { line: a + i, text: t }; }), truncated: to < b, next_line: to < b ? to + 1 : null };
  }

  // ───── 關聯：只用字面上確定的證據 ─────
  // 1) 來源 A 的文字直接提到來源 B 的名稱（去掉副檔名）  2) 兩個來源共有的專有名詞／數字／較長的詞（都附雙方的行號）
  function links(sources, opts) {
    opts = opts || {}; var out = [], cap = opts.max || 60;
    var base = function (s) { return String(s.name).replace(/\.[A-Za-z0-9]+$/, ''); };
    sources.forEach(function (a) {
      sources.forEach(function (b) {
        if (a === b || out.length >= cap) return; var nm = base(b); if (nm.length < 3) return;
        for (var i = 0; i < a.lines.length; i++) if (a.lines[i].indexOf(nm) >= 0) { out.push({ kind: 'mentions', from: cite(a, i + 1, i + 1, a.lines[i].trim().slice(0, 160)), to: { source: b.name, source_id: b.id }, term: nm }); break; }
      });
    });
    var termLines = function (src) { var m = {}; src.lines.forEach(function (ln, i) { (ln.match(/[A-Z][A-Za-z]{3,}(?:\s[A-Z][A-Za-z]{3,})*|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|[A-Za-z][A-Za-z0-9_]{5,}|[㐀-鿿]{3,6}/g) || []).forEach(function (t) { if (!m[t]) m[t] = i + 1; }); }); return m; };
    var maps = sources.map(termLines);
    for (var x = 0; x < sources.length; x++) for (var y = x + 1; y < sources.length; y++) {
      var shared = Object.keys(maps[x]).filter(function (t) { return maps[y][t] != null; });
      shared.sort(function (p, q) { return q.length - p.length; }).slice(0, 5).forEach(function (t) { if (out.length < cap) out.push({ kind: 'shared_term', term: t, from: cite(sources[x], maps[x][t], maps[x][t], sources[x].lines[maps[x][t] - 1].trim().slice(0, 160)), to: cite(sources[y], maps[y][t], maps[y][t], sources[y].lines[maps[y][t] - 1].trim().slice(0, 160)) }); });
    }
    return out;
  }

  // 回答：只把檢索到的原文片段與出處交出去（不生成）；找不到就明說找不到
  function answer(index, question, opts) {
    var hits = (opts && opts.queryVec) ? searchHybrid(index, question, opts) : search(index, question, opts);
    if (!hits.length) return { ok: true, found: false, message: '在目前選用的來源裡找不到相關內容。', hits: [] };
    return { ok: true, found: true, hits: hits.map(function (h) { return { label: h.label, source: h.source, line_start: h.line_start, line_end: h.line_end, section: h.section, loc: h.loc, quote: h.quote, score: h.score, found_by: h.found_by || '關鍵字' }; }) };
  }

  return { denseKeep: denseKeep, pinpoint: pinpoint, tokenize: tokenize, normalize: normalize, ingest: ingest, cite: cite, buildIndex: buildIndex, search: search, searchHybrid: searchHybrid, summarize: summarize, verifyQuote: verifyQuote, verifyAll: verifyAll, detail: detail, links: links, answer: answer, locLabel: locLabel };
});
