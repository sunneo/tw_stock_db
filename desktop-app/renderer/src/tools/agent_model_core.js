// Agent Model Configure 核心：不同「多重子Agent模式」的不同階段（Orchestrator／路由／領域子Agent／Reducer…）各自偏好哪些模型。
// 純函式，node 與瀏覽器都能跑（UMD，嵌入成 FaAgentModel，見 scripts/embed-code-ui.js）。
//
// 設定的形狀（存在 advancedSettings.agentModels，整份保留；開關只決定「套不套用」，不會動到已存的設定）：
//   { v:1, enabled:false,                         // 總開關，預設關：關著時行為跟以前完全一樣（模型列的順序）
//     useBuiltin:true,                            // 沒有自訂時，要不要用「內建預設」（依模型名稱樣式挑）
//     modes:{ router:{ enabled:true, stages:{ orchestrator:{ prefs:[列id,…] }, … } }, … } }
// 解析順序（resolve）：總開關關 → 不套用；這個模式被關 → 不套用；這個階段有自訂偏好（只算還存在的列）→ 用自訂；
// 否則用內建預設（有對得上的列才用）；都沒有 → 不套用（那個階段照原本的順序）。
// 偏好只是「優先順序」：實際呼叫時排在前面，後面照原本的備援順序補上，所以挑到壞掉的模型也不會卡死。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaAgentModel = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var TRAITS = ['speed', 'context', 'tools', 'accuracy'];
  var TRAIT_LABEL = { speed: '回應速度', context: '上下文長度', tools: '工具呼叫', accuracy: '謹慎正確' };
  // 階段：每個階段是「一種模型呼叫」；weights 是這種呼叫最在意哪些特性（程式自動決定時用）
  var STAGES = {
    orchestrator: { label: 'Orchestrator', desc: '接使用者的話、決定自己做還是委派。要反應快。', weights: { speed: 0.55, tools: 0.25, context: 0.2 } },
    category_router: { label: '類別路由', desc: '兩層路由的第一層：先選大類別。短、要快。', weights: { speed: 0.6, context: 0.3, accuracy: 0.1 } },
    router: { label: '路由（認識全部功能）', desc: '認識全部領域與工具，挑出這個任務要開放哪些領域。要快、context 大。', weights: { speed: 0.45, context: 0.4, accuracy: 0.15 } },
    domain_agent: { label: '領域子Agent', desc: '真正呼叫工具、把事做完。工具呼叫要穩。', weights: { tools: 0.45, accuracy: 0.3, speed: 0.25 } },
    reducer: { label: 'Reducer（統整）', desc: '把子Agent回來的結果收攏、寫給使用者的最後回覆。要謹慎、能吃長內容。', weights: { accuracy: 0.7, context: 0.25, speed: 0.05 } }
  };
  var MODES = {
    off: { label: '不使用子Agent', desc: '全部工具直接掛在根層級，只有一個 Orchestrator 自己做完。', stages: ['orchestrator'], edges: [], tweak: { orchestrator: { tools: 0.35, accuracy: 0.3, speed: 0.15, context: 0.2 } } },
    router: { label: '1. 兩層委派（router）', desc: 'Orchestrator 不認識領域；先問路由子Agent，再交給領域子Agent，最後統整。', stages: ['orchestrator', 'router', 'domain_agent', 'reducer'], edges: [['orchestrator', 'router'], ['router', 'domain_agent'], ['domain_agent', 'reducer']], tweak: {} },
    full: { label: '2. 認識全部領域（full）', desc: 'Orchestrator 直接看得到全部領域、自己指定，省掉路由那一輪。', stages: ['orchestrator', 'domain_agent', 'reducer'], edges: [['orchestrator', 'domain_agent'], ['domain_agent', 'reducer']], tweak: { orchestrator: { speed: 0.4, context: 0.35, tools: 0.25 } } },
    hierarchical: { label: '4. 兩層領域路由（hierarchical）', desc: '先選類別、再選細分領域，適合領域很多的時候。', stages: ['orchestrator', 'category_router', 'router', 'domain_agent', 'reducer'], edges: [['orchestrator', 'category_router'], ['category_router', 'router'], ['router', 'domain_agent'], ['domain_agent', 'reducer']], tweak: {} },
    intent: { label: '5. 意圖過濾（intent）', desc: '用程式比對意圖挑工具與領域（不呼叫模型）；比對沒把握才用路由當備援。', stages: ['orchestrator', 'router', 'domain_agent', 'reducer'], edges: [['orchestrator', 'domain_agent'], ['router', 'domain_agent'], ['domain_agent', 'reducer']], dashed: ['router'], tweak: { orchestrator: { speed: 0.5, tools: 0.3, context: 0.2 }, router: { speed: 0.5, context: 0.3, accuracy: 0.2 } } }
  };
  // 內建預設：依「模型名稱的樣式」挑，順序＝偏好順序（對得上現有模型列才用；沒有對得上的階段就不套用）。預設不啟用，啟用後才生效。
  var BUILTIN = {
    orchestrator: ['lightning|flash|mini|nano|haiku|lite|turbo', '20b|8b|7b|9b', 'free'],
    category_router: ['lightning|flash|mini|nano|haiku|lite|turbo', '20b|8b|7b|9b'],
    router: ['super|120b|flash|lightning|sonnet|pro', '30b|20b|nano'],
    domain_agent: ['super|120b|sonnet|ultra|opus|qwen3|deepseek', 'gpt-oss|nemotron', 'lightning|20b'],
    reducer: ['ultra|opus|550b|405b|thinking|pro|sonnet', '120b|super|deepseek', 'gpt-oss|nemotron']
  };
  function clamp(n, a, b) { n = Number(n); if (!isFinite(n)) return a; return Math.max(a, Math.min(b, n)); }
  function sizeB(name) { var s = String(name || '').toLowerCase(), m = /[-_](?:a)(\d+(?:\.\d+)?)b/.exec(s); if (m) return { active: parseFloat(m[1]), total: ((/(\d+(?:\.\d+)?)b/.exec(s) || [])[1] ? parseFloat(/(\d+(?:\.\d+)?)b/.exec(s)[1]) : parseFloat(m[1])) }; m = /(\d+(?:\.\d+)?)b\b/.exec(s); return m ? { active: parseFloat(m[1]), total: parseFloat(m[1]) } : null; }
  // 一個模型列的四種特性（0～1）。優先用實測（模型卡 /benchmark-model、CoLU 體檢），沒有才用名稱與設定估；notes 說明每個數字從哪來
  function profile(row, card) {
    row = row || {}; card = card || null; var name = String(row.modelName || ''), low = name.toLowerCase(), notes = [], p = {}; var sz = sizeB(name);
    // speed
    if (card && typeof card.test1Score === 'number') { p.speed = clamp(card.test1Score / 100, 0, 1); notes.push('速度：實測 ' + card.test1Score + ' 分'); }
    else { var s = sz ? (sz.active <= 8 ? 0.9 : sz.active <= 30 ? 0.75 : sz.active <= 70 ? 0.55 : sz.active <= 130 ? 0.4 : 0.25) : 0.5; if (/lightning|flash|mini|nano|haiku|lite|turbo|fast|instant/.test(low)) s += 0.15; if (/thinking|reason|opus|ultra|pro\b/.test(low)) s -= 0.1; p.speed = clamp(s, 0.05, 1); notes.push('速度：依名稱估計'); }
    // context
    var cw = Number(row.contextWindowTokens); if (cw > 0) { p.context = clamp(Math.log(cw / 8000) / Math.log(2) / 4, 0, 1); notes.push('context：設定 ' + Math.round(cw / 1000) + 'k'); } else { p.context = clamp(/1m|million|long|super|ultra/.test(low) ? 0.7 : 0.4, 0, 1); notes.push('context：沒填，估計'); }
    // tools
    var tl = null; if (card && (typeof card.test2Score === 'number' || typeof card.test3avgScore === 'number')) { var xs = [card.test2Score, card.test3avgScore].filter(function (x) { return typeof x === 'number'; }); tl = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length / 100; notes.push('工具：實測 ' + xs.join('／') + ' 分'); }
    else if (row.coluProfile && row.coluProfile.advice) { tl = { self: 0.8, guided: 0.55, auto: 0.4 }[row.coluProfile.advice]; if (tl != null) notes.push('工具：CoLU 體檢（' + row.coluProfile.advice + '）'); }
    if (row.abilityTags && row.abilityTags.toolCall === false) { tl = 0.1; notes.push('工具：不支援原生工具呼叫'); }
    p.tools = clamp(tl == null ? 0.5 : tl, 0, 1); if (tl == null) notes.push('工具：沒有資料，估 0.5');
    // accuracy
    if (card && typeof card.overallScore === 'number') { p.accuracy = clamp(card.overallScore / 100, 0, 1); notes.push('謹慎：基準總分 ' + card.overallScore); }
    else { var a = sz ? (sz.total >= 300 ? 0.9 : sz.total >= 100 ? 0.8 : sz.total >= 30 ? 0.65 : 0.45) : 0.55; if (/opus|ultra|pro\b|thinking|reason/.test(low)) a += 0.05; p.accuracy = clamp(a, 0.1, 1); notes.push('謹慎：依名稱估計'); }
    return { speed: p.speed, context: p.context, tools: p.tools, accuracy: p.accuracy, notes: notes };
  }
  function weightsFor(mode, stage) { var base = STAGES[stage] && STAGES[stage].weights || {}, tw = MODES[mode] && MODES[mode].tweak && MODES[mode].tweak[stage]; return tw || base; }
  function score(pr, w) { var t = 0, sum = 0; TRAITS.forEach(function (k) { var wk = w[k] || 0; t += wk * (pr[k] || 0); sum += wk; }); return sum ? t / sum : 0; }
  function usable(rows) { return (rows || []).filter(function (r) { return r && r.id && r.modelName && !r.isEmbeddingModel; }); }
  // 程式自動決定：依每個階段在意的特性，用現有資料（模型卡、體檢、設定）給每個模型打分，挑前 top 個
  function autoDecide(rows, cards, opt) {
    opt = opt || {}; var top = clamp(opt.top || 3, 1, 6), out = {}, list = usable(rows), seen = {}; var modes = opt.mode ? [opt.mode] : Object.keys(MODES);
    var profs = {}; list.forEach(function (r) { profs[r.id] = profile(r, (cards || {})[r.modelName]); });
    modes.forEach(function (m) {
      out[m] = {};
      MODES[m].stages.forEach(function (st) {
        var w = weightsFor(m, st); var ranked = list.filter(function (r) { return !(st !== 'reducer' && st !== 'category_router' && r.abilityTags && r.abilityTags.toolCall === false && (st === 'domain_agent' || st === 'orchestrator')); }).map(function (r) { return { r: r, s: score(profs[r.id], w) }; }).sort(function (a, b) { return b.s - a.s; });
        var names = {}, ids = [], why = []; ranked.forEach(function (x) { if (ids.length >= top || names[x.r.modelName]) return; names[x.r.modelName] = 1; ids.push(x.r.id); var pr = profs[x.r.id]; why.push(x.r.modelName + '（' + TRAITS.filter(function (k) { return (w[k] || 0) >= 0.2; }).map(function (k) { return TRAIT_LABEL[k] + ' ' + Math.round(pr[k] * 100); }).join('、') + '）'); });
        out[m][st] = { prefs: ids, why: why };
      });
    });
    return { assign: out, profiles: profs };
  }
  function builtinFor(rows, stage) {
    var list = usable(rows), pats = BUILTIN[stage] || [], ids = [], used = {};
    pats.forEach(function (p) { var re = new RegExp(p, 'i'); list.forEach(function (r) { if (!used[r.id] && re.test(r.modelName)) { used[r.id] = 1; ids.push(r.id); } }); });
    return ids;
  }
  function defaults() { return { v: 1, enabled: false, useBuiltin: true, modes: {} }; }
  function normalize(raw) {
    var o = defaults(); if (!raw || typeof raw !== 'object') return o; o.enabled = raw.enabled === true; o.useBuiltin = raw.useBuiltin !== false;
    Object.keys(MODES).forEach(function (m) {
      var rm = raw.modes && raw.modes[m]; if (!rm || typeof rm !== 'object') return; var stages = {};
      MODES[m].stages.forEach(function (st) { var ps = rm.stages && rm.stages[st] && rm.stages[st].prefs; if (Array.isArray(ps)) { var ids = [], seen = {}; ps.forEach(function (x) { x = String(x); if (x && !seen[x] && ids.length < 12) { seen[x] = 1; ids.push(x); } }); if (ids.length) stages[st] = { prefs: ids }; } });
      o.modes[m] = { enabled: rm.enabled !== false, stages: stages };
    });
    return o;
  }
  function ensureMode(cfg, m) { cfg.modes[m] = cfg.modes[m] || { enabled: true, stages: {} }; return cfg.modes[m]; }
  function setPrefs(cfg, mode, stage, ids) { if (!MODES[mode] || MODES[mode].stages.indexOf(stage) < 0) return cfg; var m = ensureMode(cfg, mode); if (ids && ids.length) m.stages[stage] = { prefs: ids.slice(0, 12) }; else delete m.stages[stage]; return cfg; }
  function setModeEnabled(cfg, mode, on) { ensureMode(cfg, mode).enabled = on !== false; return cfg; }
  // 全部重置成預設值：自訂的偏好與各模式的開關都清掉；總開關（套不套用）是使用者的選擇，不動
  function reset(cfg) { var e = cfg && cfg.enabled === true; var o = defaults(); o.enabled = e; return o; }
  // 一個階段實際要用的模型列（依序）；{ids, source:'off'|'custom'|'builtin'|'none'}
  function resolve(cfg, mode, stage, rows) {
    cfg = normalize(cfg); if (!cfg.enabled) return { ids: [], source: 'off' }; var m = cfg.modes[mode]; if (m && m.enabled === false) return { ids: [], source: 'off' };
    var exist = {}; usable(rows).forEach(function (r) { exist[r.id] = 1; });
    var mine = ((m && m.stages[stage] && m.stages[stage].prefs) || []).filter(function (x) { return exist[x]; }); if (mine.length) return { ids: mine, source: 'custom' };
    if (cfg.useBuiltin) { var b = builtinFor(rows, stage); if (b.length) return { ids: b, source: 'builtin' }; }
    return { ids: [], source: 'none' };
  }
  // 把偏好排到前面：groups 是備援用的分組（每組有 rows），偏好列所在的組依偏好順序移到最前面，其餘照原順序補在後面
  function orderGroups(groups, ids) {
    if (!ids || !ids.length) return groups; var out = [], used = {};
    ids.forEach(function (id) { for (var i = 0; i < groups.length; i++) { if (used[i]) continue; if ((groups[i].rows || []).some(function (r) { return r.id === id; })) { used[i] = 1; out.push(groups[i]); break; } } });
    groups.forEach(function (g, i) { if (!used[i]) out.push(g); }); return out;
  }
  // 讓 AI 決定：一次把所有模型的實測與設定給它，只准回封閉的 JSON（用字母代號指模型）；程式檢查後才採用
  function aiPrompt(rows, cards) {
    var list = usable(rows).slice(0, 26), letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', map = {};
    var lines = list.map(function (r, i) { map[letters[i]] = r.id; var p = profile(r, (cards || {})[r.modelName]); return letters[i] + '. ' + r.modelName + '｜速度 ' + Math.round(p.speed * 100) + '｜context ' + Math.round(p.context * 100) + '｜工具 ' + Math.round(p.tools * 100) + '｜謹慎 ' + Math.round(p.accuracy * 100) + (r.abilityTags && r.abilityTags.vision ? '｜看圖' : ''); });
    var stages = Object.keys(STAGES).map(function (k) { return k + '：' + STAGES[k].label + '——' + STAGES[k].desc; }).join('\n');
    return { map: map, system: '你是 AI 助理的模型調度顧問。下面是可用的模型（分數 0～100，是實測或估計）與各個階段的需求。為每個階段挑 1～3 個偏好的模型，依偏好順序。只回一段 JSON，不要說明、不要 markdown：{"orchestrator":["A","C"],"category_router":["B"],"router":["A"],"domain_agent":["D","A"],"reducer":["E"]}。模型一律用字母代號；沒有適合的階段回空陣列。不要編造不在清單裡的代號。',
      user: '可用的模型：\n' + lines.join('\n') + '\n\n階段：\n' + stages };
  }
  function parseAi(text, map) {
    var s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b <= a) return { ok: false, error: '回覆讀不成 JSON' }; var j; try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { return { ok: false, error: '回覆讀不成 JSON' }; }
    var assign = {}, dropped = 0; Object.keys(STAGES).forEach(function (st) { var ids = [], seen = {}; (Array.isArray(j[st]) ? j[st] : []).forEach(function (l) { var id = map[String(l).trim().toUpperCase()]; if (!id) { dropped++; return; } if (!seen[id] && ids.length < 3) { seen[id] = 1; ids.push(id); } }); assign[st] = ids; });
    return { ok: true, assign: assign, dropped: dropped };
  }
  // 把「各階段的偏好」套到所有模式（模式沒有那個階段就略過）；onlyEmpty＝只填還沒自訂的階段
  function applyAssign(cfg, assign, opt) {
    opt = opt || {}; var modes = opt.mode ? [opt.mode] : Object.keys(MODES);
    modes.forEach(function (m) { MODES[m].stages.forEach(function (st) { var ids = assign && (assign[st] || (assign[m] && assign[m][st] && assign[m][st].prefs)); if (assign && assign[m] && assign[m][st]) ids = assign[m][st].prefs; if (!ids || !ids.length) return; if (opt.onlyEmpty && cfg.modes[m] && cfg.modes[m].stages[st]) return; setPrefs(cfg, m, st, ids); }); });
    return cfg;
  }
  return { TRAITS: TRAITS, TRAIT_LABEL: TRAIT_LABEL, STAGES: STAGES, MODES: MODES, BUILTIN: BUILTIN, profile: profile, weightsFor: weightsFor, score: score, autoDecide: autoDecide, builtinFor: builtinFor, defaults: defaults, normalize: normalize, setPrefs: setPrefs, setModeEnabled: setModeEnabled, reset: reset, resolve: resolve, orderGroups: orderGroups, aiPrompt: aiPrompt, parseAi: parseAi, applyAssign: applyAssign, usable: usable };
});
