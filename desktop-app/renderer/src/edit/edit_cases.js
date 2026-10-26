// 編輯器的「成功案例」→ 離線訓練器的知識（純函式，沒有 DOM、沒有儲存；node 與瀏覽器都能跑）。測試 scripts/edit-tests/edit_cases.test.js；設計見 DESIGN.edit-cases.md。
// 想法：使用者跟 AI 來回幾輪、終於做出一張好的小提琴（或好的 3D 場景、簡報、遊戲），這個過程有價值——
//   ① 當時「整理成 prompt」那一段（只收有效的幾輪）是一個已知有效的做法；② 最後的成品（規格）本身可以直接當下次的起點。
// 存進離線訓練器（它自己的領域 editor_cases；一個案例＝一個 semantic pattern：範例語句、意圖、參考 prompt、開對應編輯器的工具與參數樣板），
// 所以案例跟訓練器其他知識一樣：用同一套語意比對與同義詞、在訓練器裡看得到／可以停用／可以刪、離線也能用。
// 下次相似的需求（不論是在編輯器裡說，還是 /edit-svg、/edit-3d、/edit-game-2d 後面接一句話）：
//   強模型：只多一小段參考（範例的 prompt 摘要＋物件清單，字數依模型上下文大小縮放）；
//   弱模型／離線：程式直接把範例的成品放進去當起點（不經過模型），模型只負責後面的微調。
// 成品（大）不放在訓練器的記憶體裡：只有 pattern（小）在訓練器，成品在獨立的資料表，用到才讀；每個案例有大小上限、整體有數量與容量上限。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditCases = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var KINDS = ['edit-svg', 'edit-picture', 'edit-3d', 'edit-media-presentation', 'edit-game-2d', 'edit-game-3d'];
  var DOMAIN = 'editor_cases', PREFIX = 'case_';
  var TOOL_OF = { 'edit-svg': 'edit_svg_open', 'edit-picture': 'edit_picture_open', 'edit-3d': 'edit_3d_open' };
  var LIM = { specBytes: 600000, prompt: 6000, title: 60, request: 200, requests: 4, entries: 300, totalBytes: 48 * 1024 * 1024, names: 40, minSim: 0.5, replaySim: 0.62, strongReplaySim: 0.86 };
  function str(v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); }
  function nameList(kind, spec) {
    var objs = (spec && spec.objects) || [], out = [];
    if (kind === 'edit-media-presentation') { objs = objs.filter(function (o) { return o.type === 'slide'; }); }
    if (kind === 'edit-game-2d' || kind === 'edit-game-3d') { objs = objs.filter(function (o) { return o.type === 'prefab' || o.type === 'scene'; }); }
    objs.forEach(function (o) { if (o && o.name && out.length < LIM.names) { out.push(String(o.name).slice(0, 24)); } });
    return out;
  }
  // 把目前的編輯器狀態變成一個案例：{ pattern（小，進訓練器）, body（大，用到才讀）}；太大／太空就回 { error }
  function makeEntry(o) {
    o = o || {}; var kind = o.kind; if (KINDS.indexOf(kind) < 0) { return { error: '不認得的編輯器種類' }; }
    var spec = o.spec; if (!spec || !Array.isArray(spec.objects) || !spec.objects.length) { return { error: '場景是空的，沒有可以存的成品' }; }
    var specText = JSON.stringify(spec); if (specText.length > LIM.specBytes) { return { error: '成品太大（' + Math.round(specText.length / 1024) + ' KB，上限 ' + Math.round(LIM.specBytes / 1024) + ' KB）' }; }
    var prompt = String(o.prompt || '').slice(0, LIM.prompt), names = nameList(kind, spec), title = str(o.title || spec.title || (names[0] || ''), LIM.title) || '未命名案例';
    var reqs = (Array.isArray(o.requests) ? o.requests : []).map(function (x) { return str(x, LIM.request); }).filter(function (x) { return x.length >= 2; }).slice(0, LIM.requests);
    var now = o.now || Date.now(), id = o.id || (PREFIX + now.toString(36) + Math.random().toString(36).slice(2, 6));
    // 訓練器是拿「範例語句」做語意比對的：標題、使用者當時說的話、有效 prompt 的開頭
    // 標題＋物件名字也當一個範例語句：使用者這次說的話通常是「畫一把小提琴，棕色的琴身、黑色的指板」這種長句，跟只有標題比對不上，跟「標題＋零件名」才比得上
    var examples = [title]; if (names.length) { examples.push(str(title + ' ' + names.slice(0, 8).join(' '), 120)); } examples = examples.concat(reqs); if (prompt) { examples.push(str(prompt, 180)); }
    var seen = {}; examples = examples.filter(function (x) { var k = x.toLowerCase(); if (!x || seen[k]) { return false; } seen[k] = 1; return true; });
    var pattern = { id: id, type: 'semantic', examples: examples, intent: '編輯器成功案例：' + title, description: str(prompt, 300), tool: TOOL_OF[kind] || '', args: TOOL_OF[kind] ? { request: str(prompt || reqs[0] || title, 600) } : {}, risk: 'safe', confidence: 0.7, source: 'editor-case', enabled: true, hits: 0,
      stats: { kind: kind, title: title, objects: spec.objects.length, bytes: specText.length + prompt.length, savedAt: now, lastUsed: now, uses: 0, auto: !!o.auto, names: names.slice(0, 12) } };
    return { pattern: pattern, body: { id: id, spec: spec, prompt: prompt, names: names } };
  }
  function isCase(p) { return !!p && p.source === 'editor-case' && p.stats && KINDS.indexOf(p.stats.kind) >= 0; }
  // 語意比對對「長句」不公平（使用者說「畫一把小提琴，棕色的琴身和黑色的指板」，案例的範例語句是「小提琴」「小提琴 琴身 指板」）：
  // 再用字面對一次——案例的標題出現在這句話裡就是強訊號，案例的零件名也出現越多越像（只在這句話裡有出現才算，不會把不相干的案例拉上來）
  function lexical(text, p) {
    var t = String(text || ''); if (!t || !p || !p.stats) { return 0; } var title = String(p.stats.title || ''), titleHit = title.length >= 2 && t.indexOf(title) >= 0; if (!titleHit) { return 0; }
    var names = p.stats.names || [], hit = names.filter(function (n) { return n && t.indexOf(n) >= 0; }).length, cover = names.length ? hit / names.length : 0; return 0.66 + 0.2 * cover;
  }
  // 訓練器比對出來的結果（[{ p: pattern, sim }]）→ 這個編輯器種類、相似度夠高的案例，由好到壞；使用者自己存的比自動存的優先，用過的略微加分，被停用的不算
  function rank(hits, kind, opt) {
    opt = opt || {}; var minSim = opt.minSim != null ? opt.minSim : LIM.minSim, out = [];
    (hits || []).forEach(function (h) {
      var p = h.p; if (!isCase(p) || p.enabled === false || p.stats.kind !== kind) { return; } var sim = Math.max(h.sim || 0, lexical(opt.text, p));
      if (!(sim >= minSim)) { return; } out.push({ p: p, sim: sim, score: sim * (p.stats.auto ? 0.93 : 1) * (1 + Math.min(p.stats.uses || 0, 5) * 0.01) });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    var seen = {}; return out.filter(function (x) { if (seen[x.p.id]) { return false; } seen[x.p.id] = 1; return true; }).slice(0, opt.top || 2);
  }
  // 給強模型的一小段參考；budgetChars 依模型上下文大小決定（呼叫端算），這裡再夾在 200～1500 字
  function refBlock(body, title, sim, budgetChars) {
    var budget = Math.max(200, Math.min(1500, Math.round(budgetChars || 600))), head = '【成功案例（相似度 ' + Math.round(sim * 100) / 100 + '）：' + title + '】', names = (body.names || []).join('、');
    var tail = names ? '\n這個案例做出來的物件：' + names : '', room = Math.max(60, budget - head.length - tail.length - 40), pr = str(body.prompt, 100000);
    if (pr.length > room) { pr = pr.slice(0, room - 1) + '…'; }
    var out = head + (pr ? '\n當時有效的做法：' + pr : '') + tail; if (out.length > budget - 30) { out = out.slice(0, budget - 31) + '…'; }
    return out + '\n（只當參考，照使用者這一次的要求做；案例的座標與細節可以不同。）';
  }
  // 案例的成品 → 動作（弱模型／離線時程式直接用，不經過模型）。deps.deckToDoc：簡報的規格轉文件（簡報核心提供）
  function replayEdits(kind, spec, deps) {
    if (!spec || !Array.isArray(spec.objects)) { return null; } var copy = JSON.parse(JSON.stringify(spec));
    if (kind === 'edit-3d') { return [{ op: 'replace_scene', spec: copy }]; }
    if (kind === 'edit-game-2d' || kind === 'edit-game-3d') { return [{ op: 'replace_game', spec: copy }]; }
    if (kind === 'edit-media-presentation') { return deps && deps.deckToDoc ? [{ op: 'replace_deck', doc: deps.deckToDoc(copy) }] : null; }
    if (kind === 'edit-svg' || kind === 'edit-picture') { return [{ op: 'clear_objects' }].concat(copy.objects.map(function (o) { delete o.id; return { op: 'add_object', object: o }; })); }
    return null;
  }
  // 這次要不要直接放案例的成品：還沒開始做（場景幾乎是空的，或根本沒改過）、而且相似度夠高；弱模型門檻低、強模型要幾乎一樣
  // fresh＝這個編輯器還沒有任何有效的修改（遊戲一開就是整套範本、有二十幾個物件，也算「還沒開始做」）
  function shouldReplay(sceneObjectCount, sim, weak, fresh) { if (!fresh && sceneObjectCount > 3) { return false; } return sim >= (weak ? LIM.replaySim : LIM.strongReplaySim); }
  // 超過數量或容量時要淘汰哪些（傳 pattern 的 stats 清單）：自動存的先、最久沒用的先；使用者自己存的盡量留
  function evictPlan(list, caps) {
    caps = caps || {}; var maxN = caps.entries || LIM.entries, maxB = caps.totalBytes || LIM.totalBytes, items = (list || []).map(function (p) { return { id: p.id, bytes: p.stats.bytes || 0, lastUsed: p.stats.lastUsed || 0, auto: !!p.stats.auto }; }), total = items.reduce(function (a, m) { return a + m.bytes; }, 0), drop = [];
    items.sort(function (a, b) { return (b.auto ? 1 : 0) - (a.auto ? 1 : 0) || a.lastUsed - b.lastUsed; });
    while (items.length && (items.length > maxN || total > maxB)) { var m = items.shift(); drop.push(m.id); total -= m.bytes; }
    return drop;
  }
  return { KINDS: KINDS, DOMAIN: DOMAIN, PREFIX: PREFIX, TOOL_OF: TOOL_OF, LIM: LIM, makeEntry: makeEntry, isCase: isCase, rank: rank, refBlock: refBlock, replayEdits: replayEdits, shouldReplay: shouldReplay, evictPlan: evictPlan, nameList: nameList };
});
