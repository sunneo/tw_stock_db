// 接到 AI 的範本檢索與組合（純函式、UMD；讀的是 lib 底下一對一對的 jsonl＋py，格式見 DESIGN.gui-templates.md 第 4 節）
//   FaGuiTplAI.find(files, query, opts)   -> { status:'ok'|'choose'|'none', candidates[], menu?, hint }
//        files：{ '範本代號': jsonl 文字 }（內建的加使用者的）；opts.limit 預設 5
//        candidates：[{ id, title, score, questions:[{name,ask,default}], scenes:[{id,title,note}], requires[] }]
//        前兩名分數相同或差距太小時 status 為 'choose'，menu 是離線字母選擇題（{ letters:{A:id}, text }）
//   FaGuiTplAI.compose(files, args, opts) -> { ok, id, code, scenes[], defaulted[], errors[], custom }
//        args：{ id, params?, jsonl?, py?, name? }；有 jsonl 就是模型自己寫的新範本（找不到現成的時候），和現成範本走同一個執行模組
//        opts.userFiles：{ 代號: { jsonl, py } }（使用者範本；組合到使用者範本時一起寫進暫存資料夾）
//   FaGuiTplAI.letterToId(menu, reply)    -> 範本代號或 null
//   FaGuiTplAI.GUIDE                      -> 給線上系統提示的短指引
(function (root, factory) {
  var req = (typeof require === 'function' && typeof module === 'object');
  var Index = req ? require('./jsonl_core.js') : root.FaGuiTplIndex;
  if (typeof module === 'object' && module.exports) { module.exports = factory(Index); } else { root.FaGuiTplAI = factory(Index); }
}(typeof self !== 'undefined' ? self : this, function (Index) {
  'use strict';

  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var GUIDE = '要寫有視窗的程式（辦公、文件、遊戲、專案、投影片、進銷存、美顏拍貼、證件照、MIDI、文字編輯器、網頁設計、影像處理、多媒體）時，先用 gui_template_find 找現成範本；'
    + '有候選就只問使用者真正有歧義的參數（questions 裡沒問過的用預設），再用 gui_template_compose 組合，把回傳的 code 存成 .py 用 python3 執行；'
    + '找不到範本時，照同一格式自己寫 jsonl（meta、param、require、style、layout、scene、shortcut）與選配的 py，一起交給 gui_template_compose（jsonl、py 欄位），不要另寫一套視窗程式。';

  function find(files, query, opts) {
    var limit = (opts && opts.limit) || 5;
    var idx = Index.buildIndex(files || {});
    var hits = Index.search(idx, query, limit);
    var userIds = (opts && opts.userIds) || [];
    // 使用者自己存的範本加一分（同分時排前面），並標出來
    hits.forEach(function (h) { if (userIds.indexOf(h.id) >= 0) { h.score += 1; h.user = true; } });
    hits.sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : 1); });
    var byId = {};
    idx.entries.forEach(function (e) { byId[e.id] = e; });
    var candidates = hits.map(function (h) {
      var e = byId[h.id];
      return { id: e.id, title: e.title, score: h.score, user: !!h.user, questions: Index.questions(e), scenes: e.scenes, requires: e.requires };
    });
    if (!candidates.length) {
      // 沒有現成的：把使用者自己存過的範本全文當參考案例給模型（照同一格式寫新的）
      var refs = userIds.slice(0, 2).map(function (id) { return { id: id, jsonl: files[id] }; }).filter(function (r) { return r.jsonl; });
      return { status: 'none', candidates: [], references: refs, hint: '沒有現成範本：照 gui_template_compose 的 jsonl／py 格式自己寫一份，交給同一個執行模組。可參考的範本：' + idx.entries.slice(0, 8).map(function (e) { return e.id; }).join('、') };
    }
    var tied = candidates.length > 1 && candidates[0].score - candidates[1].score < 1;
    var out = { status: tied ? 'choose' : 'ok', candidates: candidates, hint: tied ? '前兩名分數相同，請使用者用字母選一個' : '只問 questions 裡真正有歧義的；使用者沒說的用 default' };
    if (tied) { out.menu = menu(candidates.filter(function (c) { return c.score === candidates[0].score; }).slice(0, LETTERS.length)); }
    return out;
  }

  // 各場景分鏡（文字）：每個場景顯示與隱藏哪些節點、哪個事件換到哪個場景
  function storyboard(summary) {
    var lines = ['分鏡：' + summary.title + '（' + summary.id + '）'];
    if (!summary.scenes.length) { lines.push('（這個範本沒有場景，只有一個畫面）'); }
    summary.scenes.forEach(function (s, i) {
      lines.push((i + 1) + '. ' + s.title + ' [' + s.id + ']' + (s.note ? '：' + s.note : ''));
      if (s.show && s.show.length) { lines.push('   顯示：' + s.show.join('、')); }
      if (s.hide && s.hide.length) { lines.push('   隱藏：' + s.hide.join('、')); }
      Object.keys(s.on || {}).forEach(function (ev) { lines.push('   ' + ev + ' → 換到 ' + s.on[ev]); });
    });
    return lines.join('\n');
  }

  function menu(candidates) {
    var letters = {}, lines = [];
    candidates.forEach(function (c, i) { letters[LETTERS.charAt(i)] = c.id; lines.push(LETTERS.charAt(i) + '. ' + c.title + '（' + c.id + '）'); });
    return { letters: letters, text: '請選一個，只回一個字母：\n' + lines.join('\n') };
  }

  function letterToId(m, reply) {
    var s = String(reply == null ? '' : reply).trim().toUpperCase();
    var mm = /^[（(]?([A-Z])[)）.。]?$/.exec(s);
    return mm && m && m.letters[mm[1]] ? m.letters[mm[1]] : null;
  }

  function pyStr(s) { return 'json.loads(' + JSON.stringify(JSON.stringify(s)) + ')'; }
  // 一個 jsonl 要配一個 py：模型沒寫行為時補一支空的（只有版面，沒有事件處理）
  var STUB_PY = ['# -*- coding: utf-8 -*-', '', '', 'def build(win, spec, slots):', '    return {"handlers": {}}', ''].join('\n');
  var ID_RE = /^[a-z0-9_][a-z0-9_\-]*(\/[a-z0-9_][a-z0-9_\-]*)*$/;

  function compose(files, args, opts) {
    args = args || {}; opts = opts || {};
    var errors = [];
    var custom = typeof args.jsonl === 'string' && args.jsonl.trim() !== '';
    var id = String(args.id || args.name || '').trim();
    var summary;
    if (custom) {
      if (!id) { errors.push('自己寫的範本要給 name（例如 user/my_app）'); }
      else if (!ID_RE.test(id)) { errors.push('範本代號只能用小寫英數、底線、連字號與斜線：' + id); }
      summary = Index.summarize(id || 'x', args.jsonl);
      if (summary.error) { errors.push(summary.error); }
      else if (!(summary.standalone || summary.extends)) { errors.push('meta 要標 "standalone":true（整個應用程式）或 "extends"（變體）才能直接執行'); }
    } else {
      if (!id) { errors.push('缺少 id'); }
      else if (!files || files[id] == null) { errors.push('沒有這個範本：' + id + '（先用 gui_template_find 找）'); }
      else { summary = Index.summarize(id, files[id]); if (summary.error) { errors.push(summary.error); } }
    }
    var given = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params : {};
    var defaulted = [];
    if (summary && !summary.error) {
      var known = {};
      summary.params.forEach(function (p) { known[p.name] = true; if (!(p.name in given)) { defaulted.push(p.name); } });
      Object.keys(given).forEach(function (k) { if (!known[k]) { errors.push('範本沒有參數 ' + k + '（有：' + (summary.params.map(function (p) { return p.name; }).join('、') || '無') + '）'); } });
    }
    if (errors.length) { return { ok: false, errors: errors, id: id, custom: custom }; }

    var lines = ['import json', 'import gui', 'import guitpl'];
    var written = [];
    var extra = {};
    if (custom) { extra[id] = { jsonl: args.jsonl, py: typeof args.py === 'string' && args.py.trim() ? args.py : STUB_PY }; }
    else if (/^user\//.test(id) && opts.userFiles) {
      Object.keys(opts.userFiles).forEach(function (k) { extra[k] = opts.userFiles[k]; });
    }
    Object.keys(extra).forEach(function (k) { written.push(k); });
    if (written.length) {
      lines.push('import os', 'import tempfile', '_d = tempfile.mkdtemp()');
      lines.push('def _w(cid, ext, text):', '    p = os.path.join(_d, *cid.split("/")) + ext', '    os.makedirs(os.path.dirname(p), exist_ok=True)',
        '    f = open(p, "w", encoding="utf-8")', '    f.write(text)', '    f.close()');
      written.forEach(function (k) {
        lines.push('_w(' + JSON.stringify(k) + ', ".jsonl", ' + pyStr(extra[k].jsonl) + ')');
        if (extra[k].py) { lines.push('_w(' + JSON.stringify(k) + ', ".py", ' + pyStr(extra[k].py) + ')'); }
      });
    }
    var call = 'guitpl.run(' + JSON.stringify(id) + ', params=json.loads(' + JSON.stringify(JSON.stringify(given)) + ')' + (written.length ? ', roots=[_d] + guitpl.default_roots()' : '') + ')';
    if (args.standalone) {
      // 單一檔案的程式：不執行，而是寫出一個可獨立執行的 .py（範本、引用、外部呼叫與執行器都在裡面，只需要 gui）
      var outName = String(args.output || (id.replace(/[^a-z0-9_\-]+/g, '_') + '_app.py'));
      call = 'src = guitpl.compile_standalone(' + JSON.stringify(id) + ', params=json.loads(' + JSON.stringify(JSON.stringify(given)) + ')' + (written.length ? ', roots=[_d] + guitpl.default_roots()' : '') + ')';
      lines.push(call);
      lines.push('f = open(' + JSON.stringify(outName) + ', "w", encoding="utf-8")', 'f.write(src)', 'f.close()', 'print("已寫出單一檔案程式：" + ' + JSON.stringify(outName) + ')');
    } else { lines.push(call); }
    return { ok: true, id: id, code: lines.join('\n') + '\n', scenes: summary.scenes, storyboard: storyboard(summary), defaulted: defaulted, errors: [], custom: custom, standalone: !!args.standalone };
  }

  return { find: find, compose: compose, storyboard: storyboard, letterToId: letterToId, menu: menu, GUIDE: GUIDE };
}));
