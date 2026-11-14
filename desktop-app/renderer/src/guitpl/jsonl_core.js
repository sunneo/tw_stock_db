// 範本索引（純函式、UMD）：讀 jsonl 範本的 meta／param／scene，讓線上與離線 AI 檢索範本、逐步詢問參數（設計見 DESIGN.gui-templates.md 第 4 節）
//   FaGuiTplIndex.parseJsonl(text)        -> { records[], errors[] }
//   FaGuiTplIndex.summarize(id, text)     -> { id, title, keywords, standalone, extends, params[], scenes[], requires[], slots[] } 或 { error }
//   FaGuiTplIndex.buildIndex(files)       -> files 是 { '代號': jsonl 文字 }；只收 standalone 的領域範本當入口，其餘當元件
//   FaGuiTplIndex.search(index, query, n) -> 依關鍵字命中數排序的 [{ id, score, title }]（平手以代號排）
//   FaGuiTplIndex.questions(entry)        -> 逐步詢問要問的話：[{ name, ask, default }]
(function (root, factory) {
  var req = (typeof require === 'function' && typeof module === 'object');
  var Yaml = req ? require('./yaml_core.js') : root.FaGuiTplYaml;
  if (typeof module === 'object' && module.exports) { module.exports = factory(Yaml); } else { root.FaGuiTplIndex = factory(Yaml); }
}(typeof self !== 'undefined' ? self : this, function (Yaml) {
  'use strict';

  // 範本文字是 jsonl（第一個有內容的行以 { 開頭）還是 YAML 子集（yaml_core.js）
  function isYaml(text) {
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].trim();
      if (!s || s.charAt(0) === '#') { continue; }
      return s.charAt(0) !== '{';
    }
    return false;
  }

  function parseJsonl(text) {
    var records = [], errors = [];
    if (isYaml(text)) {
      if (!Yaml) { return { records: [], errors: ['這個環境沒有 YAML 解析'] }; }
      try {
        Yaml.parseDocuments(text).forEach(function (rec, i) {
          if (!rec.kind) { errors.push('第 ' + (i + 1) + ' 筆缺少 kind'); } else { records.push(rec); }
        });
      } catch (e) { errors.push('YAML 寫法有問題：' + e.message); }
      return { records: records, errors: errors };
    }
    String(text || '').split(/\r?\n/).forEach(function (line, i) {
      var s = line.trim();
      if (!s || s.charAt(0) === '#') { return; }
      try {
        var rec = JSON.parse(s);
        if (!rec || typeof rec !== 'object' || Array.isArray(rec) || !rec.kind) { errors.push('第 ' + (i + 1) + ' 行缺少 kind'); return; }
        records.push(rec);
      } catch (e) { errors.push('第 ' + (i + 1) + ' 行不是合法的 JSON'); }
    });
    return { records: records, errors: errors };
  }

  function summarize(id, text) {
    var p = parseJsonl(text);
    if (p.errors.length) { return { id: id, error: p.errors.join('；') }; }
    var meta = p.records.filter(function (r) { return r.kind === 'meta'; })[0];
    if (!meta) { return { id: id, error: '缺少 meta 紀錄' }; }
    var of = function (k) { return p.records.filter(function (r) { return r.kind === k; }); };
    return {
      id: id, title: meta.title || id, keywords: meta.keywords || [], standalone: !!meta.standalone, extends: meta.extends || null,
      params: of('param').map(function (r) { return { name: r.name, ask: r.ask || '', default: r.default }; }),
      scenes: of('scene').map(function (r) { return { id: r.id, title: r.title, note: r.note || '', show: r.show || [], hide: r.hide || [], on: r.on || {} }; }),
      requires: of('require').map(function (r) { return r.module; }),
      slots: of('slot').map(function (r) { return { name: r.name, use: r.use }; })
    };
  }

  function buildIndex(files) {
    var entries = [], parts = [], errors = [];
    Object.keys(files).sort().forEach(function (id) {
      var s = summarize(id, files[id]);
      if (s.error) { errors.push(id + '：' + s.error); return; }
      (s.standalone || s.extends ? entries : parts).push(s);
    });
    return { entries: entries, parts: parts, errors: errors };
  }

  function search(index, query, n) {
    var q = String(query || '').toLowerCase();
    var out = index.entries.map(function (e) {
      var score = 0;
      (e.keywords || []).concat([e.title]).forEach(function (w) { var lw = String(w).toLowerCase(); if (lw && q.indexOf(lw) >= 0) { score++; } });
      var dom = e.id.split('/')[0].toLowerCase();
      if (dom && q.indexOf(dom) >= 0) { score++; }
      return { id: e.id, score: score, title: e.title };
    }).filter(function (x) { return x.score > 0; });
    out.sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : 1); });
    return out.slice(0, n || 5);
  }

  function questions(entry) {
    return entry.params.filter(function (p) { return p.ask; }).map(function (p) { return { name: p.name, ask: p.ask, default: p.default }; });
  }

  return { parseJsonl: parseJsonl, summarize: summarize, buildIndex: buildIndex, search: search, questions: questions };
}));
