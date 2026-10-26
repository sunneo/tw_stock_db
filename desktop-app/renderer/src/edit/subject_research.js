/* 不認識的東西，先去查（UMD，純函式，不碰網路、儲存、模型；桌面版與網頁版共用）。測試 scripts/edit-tests/subject_research.test.js；設計見 DESIGN.subject-research.md。
 * 起因：在 /edit-3d 說「放一個盤子、把雞翅放到盤子」，模型不知道雞翅長怎樣，就放了兩個圓錐。圖像設計（畫圖、/edit-svg、/edit-picture）也一樣會遇到「不知道長怎樣的東西」。
 * 做法（由便宜到貴，前面做到就不往後）：① 自己的知識（模型庫、成功案例）→ ② 上網查外形描述（維基百科）→ 模型整理成「由哪幾塊什麼形狀組成、多大、什麼顏色」→ 存起來（下次不用再查）→ ③ 參考圖／④ 模型檔（設計見文件）。
 * 這個檔案只有三件封閉的事：問模型「這句話裡哪些東西你不確定長怎樣」並驗證答案、把查到的資料變成給模型的整理題目並驗證答案、把整理好的結果變成一小段參考文字（字數有上限，不污染對話）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaSubjectResearch = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LIM = { subjects: 3, name: 24, en: 60, parts: 12, partName: 20, look: 160, notes: 200, evidence: 1400, cacheEntries: 200, minText: 4 };
  var SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'ellipsoid', 'capsule', 'wedge', 'disc'];
  function str(v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); }
  function num(v, lo, hi) { var x = Number(v); return isFinite(x) ? Math.max(lo, Math.min(hi, x)) : null; }
  function key(name) { return str(name, LIM.name).toLowerCase().replace(/\s+/g, ''); }

  // ───── ① 問模型：這句話裡有哪些東西，你不確定長怎樣（或不是簡單的幾何體）？ known＝我們已經會做的東西（模型庫的名字）
  function subjectsPrompt(text, known, kind) {
    var what = kind === 'edit-3d' ? '3D 場景' : '圖';
    return { system: '你只回 JSON，不要說明。', user: '使用者要編輯一張' + what + '，需求是：\n「' + str(text, 400) + '」\n\n請找出需求裡「真實世界的具體東西」之中，外形不是簡單幾何體（方塊、球、圓柱、圓錐）、而且你不確定能不能畫對的（例如雞翅、小提琴、吉他、消防栓、水母）。'
      + '常見而且簡單的東西（桌子、盤子、杯子、球、樹、房子）、抽象的東西、顏色位置動作都不要列。\n已經內建、不用查的東西：' + (known && known.length ? known.slice(0, 40).join('、') : '（無）') + '。\n'
      + '回 {"subjects":[{"name":"原文名稱","en":"英文名稱"}]}，最多 ' + LIM.subjects + ' 個；沒有就回 {"subjects":[]}。' };
  }
  function parseJson(text) {
    var s = String(text == null ? '' : text), a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b <= a) return null; try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }
  function parseSubjects(reply, known) {
    var j = parseJson(reply), list = j && Array.isArray(j.subjects) ? j.subjects : [], seen = {}, out = [], knownKeys = {};
    (known || []).forEach(function (k) { knownKeys[key(k)] = 1; });
    list.forEach(function (x) { if (!x) return; var name = str(typeof x === 'string' ? x : x.name, LIM.name), en = str(typeof x === 'string' ? '' : x.en, LIM.en); if (name.length < 1 || seen[key(name)] || knownKeys[key(name)]) return; seen[key(name)] = 1; out.push({ name: name, en: /^[\x20-\x7e]+$/.test(en) ? en : '' }); });
    return out.slice(0, LIM.subjects);
  }

  // ───── ② 維基百科查詢（網址由呼叫端去抓）：先中文、沒有再英文
  function wikiUrl(lang, query) {
    return 'https://' + (lang === 'en' ? 'en' : 'zh') + '.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1&prop=extracts&exintro=1&explaintext=1&exchars=1200&generator=search&gsrlimit=2&gsrsearch=' + encodeURIComponent(str(query, 80));
  }
  // 回傳最相關的一段 { title, text }；標題跟查詢字完全對不上的結果不收（避免查「雞翅」收到「雞」以外的東西）
  function pickExtract(json, query) {
    var pages = json && json.query && json.query.pages ? Object.keys(json.query.pages).map(function (k) { return json.query.pages[k]; }) : []; if (!pages.length) return null;
    pages.sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
    var q = str(query, 80).toLowerCase().replace(/\s+/g, ' ');
    for (var i = 0; i < pages.length; i++) { var p = pages[i], title = str(p.title, 80), ex = str(p.extract, LIM.evidence); if (ex.length < 30) continue; if (sameTitle(title, q)) return { title: title, text: ex }; }
    return null;
  }

  // 標題要「就是這個東西」才收：去掉括號註解、複數的 s 之後一樣；中文標題只多一兩個字也算（雞翅 → 炸雞翅）。"Plate tectonics" 不是 "plate"
  function sameTitle(title, q) {
    var t = String(title).toLowerCase().replace(/\s*[(（][^)）]*[)）]\s*/g, ' ').replace(/\s+/g, ' ').trim(), plain = function (x) { return x.replace(/(es|s)$/, ''); };
    if (!t || !q) return false; if (t === q || plain(t) === plain(q)) return true;
    if (/[一-鿿]/.test(q)) return t.indexOf(q) >= 0 && t.length - q.length <= 2;
    return false;
  }

  // ───── ③ 問模型：把查到的資料整理成「由哪幾塊組成」。evidence 可以是空的（沒查到，就用模型自己知道的，並標明）
  function briefPrompt(subject, evidence, kind) {
    var d3 = kind === 'edit-3d';
    return { system: '你只回 JSON，不要說明。', user: '請把「' + subject.name + '」' + (subject.en ? '（' + subject.en + '）' : '') + '的外形，整理成可以用基本形狀（' + SHAPES.join('、') + '）拼出來的做法。\n'
      + (evidence ? '參考資料（網路上查到的）：\n' + str(evidence, LIM.evidence) + '\n' : '沒有查到網路資料，請用你自己對它外形的認識，不確定就在 notes 說明。\n')
      + '回 {"name":"' + subject.name + '","look":"一句話：整體長怎樣","size_cm":[長,寬,高],"parts":[{"name":"部位","shape":"' + SHAPES.join('|') + '","size_cm":[x,y,z],"offset_cm":[x,y,z],"color":"#rrggbb","rot_deg":[x,y,z]?}],"notes":"拼的時候要注意的事"}。\n'
      + 'parts 最多 ' + LIM.parts + ' 個，offset 是相對整體中心；尺寸用公分、要符合真實比例' + (d3 ? '（y 是向上）' : '') + '；顏色要像真的。' };
  }
  function parseBrief(reply, subject, source) {
    var j = parseJson(reply); if (!j || typeof j !== 'object') return null;
    var parts = [], list = Array.isArray(j.parts) ? j.parts : [];
    list.forEach(function (p) {
      if (!p || parts.length >= LIM.parts) return; var shape = String(p.shape || '').toLowerCase(); if (SHAPES.indexOf(shape) < 0) return;
      var size = vec3(p.size_cm, 0.1, 500); if (!size) return; var off = vec3(p.offset_cm, -500, 500) || [0, 0, 0], rot = vec3(p.rot_deg, -360, 360), color = /^#[0-9a-f]{6}$/i.test(String(p.color || '')) ? String(p.color).toLowerCase() : '';
      parts.push({ name: str(p.name, LIM.partName) || shape, shape: shape, size_cm: size, offset_cm: off, color: color, rot_deg: rot || undefined });
    });
    if (!parts.length) return null;
    return { name: subject.name, en: subject.en || '', look: str(j.look, LIM.look), size_cm: vec3(j.size_cm, 0.1, 1000) || null, parts: parts, notes: str(j.notes, LIM.notes), source: source || 'model', at: 0 };
  }
  function vec3(a, lo, hi) { if (!Array.isArray(a) || a.length < 3) return null; var o = [num(a[0], lo, hi), num(a[1], lo, hi), num(a[2], lo, hi)]; return o.some(function (x) { return x === null; }) ? null : o.map(function (x) { return Math.round(x * 10) / 10; }); }

  // ───── ④ 給模型的一小段參考（budgetChars 由呼叫端依模型上下文算；夾在 300～1600）
  function refBlock(briefs, budgetChars, kind) {
    var budget = Math.max(300, Math.min(1600, Math.round(budgetChars || 800))), per = Math.floor(budget / Math.max(1, briefs.length)), d3 = kind === 'edit-3d', out = [];
    briefs.forEach(function (b) {
      var head = '【物件資料：' + b.name + (b.source === 'web' ? '（網路資料整理）' : '（沒查到網路資料，模型憑印象整理，僅供參考）') + '】' + (b.look ? b.look : '') + (b.size_cm ? '；整體約 ' + b.size_cm.join('×') + ' 公分' : ''), lines = [];
      b.parts.forEach(function (p) { lines.push('・' + p.name + ' ' + p.shape + ' ' + p.size_cm.join('×') + 'cm' + (p.offset_cm && p.offset_cm.some(function (x) { return x; }) ? ' 位置' + p.offset_cm.join(',') : '') + (p.color ? ' ' + p.color : '') + (p.rot_deg ? ' 轉' + p.rot_deg.join(',') : '')); });
      var text = head + '\n' + lines.join('\n') + (b.notes ? '\n注意：' + b.notes : ''); if (text.length > per) text = text.slice(0, per - 1) + '…'; out.push(text);
    });
    return out.join('\n') + '\n（照這些部位用基本形狀拼出來，不要只放一兩個圓錐；' + (d3 ? '尺寸公分換成公尺、y 向上。' : '尺寸依畫面大小等比例縮放。') + '）';
  }

  // ───── 快取（host 存在自己的資料表；這裡只決定怎麼淘汰、怎麼比對）
  function cacheKey(name) { return key(name); }
  function evictPlan(entries, max) { max = max || LIM.cacheEntries; if (entries.length <= max) return []; return entries.slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); }).slice(0, entries.length - max).map(function (e) { return e.key; }); }
  // 這句話值不值得問模型「有沒有不認識的東西」：太短、純數字顏色位置動作的指令就不用
  function worthAsking(text) { var t = str(text, 600); if (t.length < LIM.minText) return false; return /[一-鿿A-Za-z]{2,}/.test(t); }

  return { LIM: LIM, SHAPES: SHAPES, subjectsPrompt: subjectsPrompt, parseSubjects: parseSubjects, wikiUrl: wikiUrl, pickExtract: pickExtract, briefPrompt: briefPrompt, parseBrief: parseBrief, refBlock: refBlock, cacheKey: cacheKey, evictPlan: evictPlan, worthAsking: worthAsking, parseJson: parseJson };
});
