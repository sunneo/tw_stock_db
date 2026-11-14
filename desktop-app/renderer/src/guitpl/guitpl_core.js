// 圖形介面範本核心（純函式、UMD、node 與瀏覽器都能跑；設計見 DESIGN.gui-templates.md 第 2 節）
//   FaGuiTpl.validateSpec(spec)            -> { ok, errors[] }   設計規格（guitpl/1）的形狀檢查
//   FaGuiTpl.validateDomain(domainFile)    -> { ok, errors[] }   領域範本檔（guitpl-domain/1）的形狀檢查
//   FaGuiTpl.findDomain(text, domains)     -> { domain, score, margin, decided, ranking[] }
//   FaGuiTpl.pickOption(text, step)        -> { option, score, byDefault }
//   FaGuiTpl.nextStep(state)               -> 下一個要問的步驟（或 null）
//   FaGuiTpl.answer(state, stepId, optId)  -> 新 state（不改原物件）
//   FaGuiTpl.mergeFragments(picks)         -> 規格（依步驟順序合併；layout.tree、behavior.handlers 附加）
//   FaGuiTpl.choiceMenu(step)              -> { letters: {A: optId, …}, text }  離線字母選擇題
//   FaGuiTpl.letterToOption(step, reply)   -> optId 或 null（回覆不合法）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.FaGuiTpl = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STEP_ORDER = ['layout', 'behavior', 'palette', 'theme', 'shortcuts', 'sound'];
  var PALETTE_KEYS = ['bg', 'fg', 'accent', 'danger', 'muted'];
  var COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var KEYS_RE = /^((Ctrl|Shift|Alt)\+)*([A-Za-z0-9]|F([1-9]|1[0-2])|Enter|Esc|Space|Up|Down|Left|Right)$/;
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  // 領域領先第二名多少分才算「決定」
  var DOMAIN_MARGIN = 1;

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }

  function walkTree(nodes, fn, depth) {
    depth = depth || 1;
    (nodes || []).forEach(function (n) {
      fn(n, depth);
      if (n && Array.isArray(n.children)) { walkTree(n.children, fn, depth + 1); }
    });
  }

  // ---------- 規格檢查 ----------
  function validateSpec(spec, opts) {
    var errors = [];
    var kinds = (opts && opts.kinds) || null; // 允許的節點種類（呼叫端可傳橋接的 KINDS 鍵加新容器）
    if (!isObj(spec)) { return { ok: false, errors: ['規格必須是物件'] }; }
    if (spec.format !== 'guitpl/1') { errors.push('format 必須是 guitpl/1'); }
    if (!spec.id || typeof spec.id !== 'string') { errors.push('缺 id'); }
    if (!spec.domain || typeof spec.domain !== 'string') { errors.push('缺 domain'); }
    if (['builtin', 'user', 'designed'].indexOf(spec.source) < 0) { errors.push('source 必須是 builtin、user 或 designed'); }

    var layout = spec.layout;
    if (!isObj(layout) || !isObj(layout.window) || !Array.isArray(layout.tree) || !layout.tree.length) {
      errors.push('layout 需要 window 與非空的 tree');
    } else {
      var ids = {};
      var count = 0;
      walkTree(layout.tree, function (n, depth) {
        count++;
        if (!isObj(n) || !n.kind) { errors.push('節點缺 kind'); return; }
        if (kinds && kinds.indexOf(n.kind) < 0) { errors.push('不支援的節點種類 ' + n.kind); }
        if (n.id) {
          if (ids[n.id]) { errors.push('節點 id 重複：' + n.id); }
          ids[n.id] = true;
        }
        if (depth > 8) { errors.push('節點巢狀超過 8 層'); }
      });
      if (count > 200) { errors.push('節點超過 200 個'); }
      // 行為與快捷鍵、聲音引用的動作名稱需存在於 actions（若呼叫端有給）
      var actions = opts && opts.actions;
      var refs = [];
      ((spec.behavior && spec.behavior.handlers) || []).forEach(function (h) {
        if (!isObj(h) || !h.on || !h.do) { errors.push('handler 需要 on 與 do'); return; }
        refs.push(h.do);
        var m = /^(click|input|select|toggle|cell|change):(.+)$/.exec(h.on);
        if (m && !ids[m[2]]) { errors.push('handler 指到不存在的節點 ' + m[2]); }
      });
      (spec.shortcuts || []).forEach(function (s) {
        if (!isObj(s) || !KEYS_RE.test(String(s.keys || ''))) { errors.push('快捷鍵寫法不合法：' + (s && s.keys)); return; }
        if (!s.do) { errors.push('快捷鍵缺 do：' + s.keys); } else { refs.push(s.do); }
      });
      (spec.sound || []).forEach(function (s) { if (!isObj(s) || !s.on || !s.tone) { errors.push('sound 需要 on 與 tone'); } });
      if (actions) {
        refs.forEach(function (r) { if (!Object.prototype.hasOwnProperty.call(actions, r)) { errors.push('動作不存在：' + r); } });
      }
    }

    if (spec.palette !== undefined) {
      if (!isObj(spec.palette)) { errors.push('palette 必須是物件'); }
      else {
        PALETTE_KEYS.forEach(function (k) { if (!COLOR_RE.test(String(spec.palette[k] || ''))) { errors.push('palette.' + k + ' 必須是 #rgb 或 #rrggbb'); } });
        Object.keys(spec.palette).forEach(function (k) { if (PALETTE_KEYS.indexOf(k) < 0 && !COLOR_RE.test(String(spec.palette[k]))) { errors.push('palette.' + k + ' 不是顏色'); } });
      }
    }
    if (spec.theme !== undefined && (!isObj(spec.theme) || !spec.theme.name)) { errors.push('theme 需要 name'); }
    if (spec.scenes !== undefined) {
      if (!Array.isArray(spec.scenes)) { errors.push('scenes 必須是陣列'); }
      else {
        var seen = {};
        spec.scenes.forEach(function (s) {
          if (!isObj(s) || !s.id || !s.title) { errors.push('場景需要 id 與 title'); return; }
          if (seen[s.id]) { errors.push('場景 id 重複：' + s.id); }
          seen[s.id] = true;
        });
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  // ---------- 領域範本檔檢查 ----------
  function validateDomain(d) {
    var errors = [];
    if (!isObj(d)) { return { ok: false, errors: ['領域檔必須是物件'] }; }
    if (d.format !== 'guitpl-domain/1') { errors.push('format 必須是 guitpl-domain/1'); }
    if (!d.domain) { errors.push('缺 domain'); }
    if (!d.label) { errors.push('缺 label'); }
    if (!Array.isArray(d.keywords) || !d.keywords.length) { errors.push('keywords 需要非空陣列'); }
    if (!Array.isArray(d.steps) || !d.steps.length) { errors.push('steps 需要非空陣列'); return { ok: false, errors: errors }; }
    var stepIds = {};
    d.steps.forEach(function (st) {
      if (!isObj(st) || STEP_ORDER.indexOf(st.id) < 0) { errors.push('不認得的步驟 ' + (st && st.id)); return; }
      if (stepIds[st.id]) { errors.push('步驟重複：' + st.id); }
      stepIds[st.id] = true;
      if (!st.ask) { errors.push('步驟 ' + st.id + ' 缺 ask'); }
      if (st.use) { return; } // 引用共用選項，選項在載入時展開
      if (!Array.isArray(st.options) || !st.options.length) { errors.push('步驟 ' + st.id + ' 需要選項'); return; }
      var optIds = {};
      var defaults = 0;
      st.options.forEach(function (o) {
        if (!isObj(o) || !o.id || !o.label || !isObj(o.fragment)) { errors.push('步驟 ' + st.id + ' 的選項需要 id、label、fragment'); return; }
        if (optIds[o.id]) { errors.push('步驟 ' + st.id + ' 選項 id 重複：' + o.id); }
        optIds[o.id] = true;
        if (o.default) { defaults++; }
      });
      if (!st.optional && defaults !== 1) { errors.push('步驟 ' + st.id + ' 必須剛好一個 default（現在 ' + defaults + '）'); }
    });
    if (!stepIds.layout) { errors.push('至少要有 layout 步驟'); }
    return { ok: errors.length === 0, errors: errors };
  }

  // 展開 "use": "_common:palette" 的引用；common 是 _common.json 的內容 { palette:{ask, options}, … }
  function expandUses(domain, common) {
    var out = JSON.parse(JSON.stringify(domain));
    out.steps = out.steps.map(function (st) {
      if (!st.use) { return st; }
      var key = String(st.use).split(':')[1];
      var src = common && common[key];
      if (!src) { throw new Error('找不到共用步驟 ' + st.use); }
      var merged = JSON.parse(JSON.stringify(src));
      merged.id = st.id;
      if (st.ask) { merged.ask = st.ask; }
      if (st.optional) { merged.optional = true; }
      return merged;
    });
    return out;
  }

  // ---------- 檢索 ----------
  function score(text, words) {
    var t = lower(text), s = 0;
    (words || []).forEach(function (w) { var lw = lower(w); if (lw && t.indexOf(lw) >= 0) { s++; } });
    return s;
  }

  // domains: 領域檔陣列（已展開）；使用者範本放在 domain.userSpecs（規格陣列）以加權
  function findDomain(text, domains) {
    var ranking = (domains || []).map(function (d) {
      var s = score(text, d.keywords) + score(text, [d.label]);
      (d.userSpecs || []).forEach(function (u) { s += 2 * score(text, [u.title].concat(u.keywords || [])); });
      return { domain: d.domain, score: s };
    }).sort(function (a, b) { return b.score - a.score; });
    var top = ranking[0], second = ranking[1];
    var margin = top ? top.score - (second ? second.score : 0) : 0;
    return {
      domain: top && top.score > 0 ? top.domain : null,
      score: top ? top.score : 0,
      margin: margin,
      decided: !!(top && top.score > 0 && margin >= DOMAIN_MARGIN),
      ranking: ranking
    };
  }

  function pickOption(text, step) {
    var best = null, bestScore = 0, def = null;
    (step.options || []).forEach(function (o) {
      if (o.default) { def = o; }
      var s = score(text, (o.keywords || []).concat([o.label]));
      if (s > bestScore) { best = o; bestScore = s; }
    });
    if (best) { return { option: best, score: bestScore, byDefault: false }; }
    return { option: def, score: 0, byDefault: true };
  }

  // ---------- 逐步詢問狀態機 ----------
  function newState(domain, text) {
    var picks = {};
    var asked = {};
    var auto = [];
    var steps = domain.steps.slice().sort(function (a, b) { return STEP_ORDER.indexOf(a.id) - STEP_ORDER.indexOf(b.id); });
    steps.forEach(function (st) {
      if (!text) { return; }
      var p = pickOption(text, st);
      if (p.option && !p.byDefault) { picks[st.id] = p.option.id; asked[st.id] = true; auto.push(st.id); }
    });
    return { domain: domain, steps: steps, picks: picks, asked: asked, auto: auto, text: text || '' };
  }

  function nextStep(state) {
    for (var i = 0; i < state.steps.length; i++) {
      var st = state.steps[i];
      if (!state.asked[st.id]) { return st; }
    }
    return null;
  }

  function answer(state, stepId, optId) {
    var st = state.steps.filter(function (x) { return x.id === stepId; })[0];
    if (!st) { throw new Error('沒有這個步驟 ' + stepId); }
    if (optId !== null && !(st.options || []).some(function (o) { return o.id === optId; })) { throw new Error('步驟 ' + stepId + ' 沒有選項 ' + optId); }
    var picks = Object.assign({}, state.picks), asked = Object.assign({}, state.asked);
    if (optId === null) { delete picks[stepId]; } else { picks[stepId] = optId; }
    asked[stepId] = true;
    return Object.assign({}, state, { picks: picks, asked: asked });
  }

  // 使用者說「你決定」：所有沒問過的步驟走預設（可選步驟不選）
  function fillDefaults(state) {
    var s = state;
    state.steps.forEach(function (st) {
      if (s.asked[st.id]) { return; }
      var def = (st.options || []).filter(function (o) { return o.default; })[0];
      s = answer(s, st.id, def ? def.id : null);
    });
    return s;
  }

  // ---------- 合併 ----------
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function deepMerge(base, add) {
    Object.keys(add).forEach(function (k) {
      if (isObj(add[k]) && isObj(base[k])) { deepMerge(base[k], add[k]); } else { base[k] = clone(add[k]); }
    });
    return base;
  }

  // picks: [{step, option}]（依步驟順序）。layout.tree、behavior.handlers、shortcuts、sound、scenes 是附加；其餘後蓋前
  function mergeFragments(picks) {
    var spec = { layout: { window: {}, tree: [] }, behavior: { state: {}, handlers: [] }, shortcuts: [], sound: [], scenes: [] };
    picks.forEach(function (p) {
      var f = clone(p.option.fragment);
      if (f.layout) {
        if (f.layout.window) { deepMerge(spec.layout.window, f.layout.window); }
        if (f.layout.tree) { spec.layout.tree = spec.layout.tree.concat(f.layout.tree); }
        delete f.layout;
      }
      if (f.behavior) {
        if (f.behavior.state) { deepMerge(spec.behavior.state, f.behavior.state); }
        if (f.behavior.handlers) { spec.behavior.handlers = spec.behavior.handlers.concat(f.behavior.handlers); }
        if (f.behavior.loop) { spec.behavior.loop = f.behavior.loop; }
        delete f.behavior;
      }
      ['shortcuts', 'sound', 'scenes'].forEach(function (k) {
        if (f[k]) { spec[k] = spec[k].concat(f[k]); delete f[k]; }
      });
      deepMerge(spec, f);
    });
    return spec;
  }

  function picksOf(state) {
    var out = [];
    state.steps.forEach(function (st) {
      var id = state.picks[st.id];
      if (!id) { return; }
      var o = st.options.filter(function (x) { return x.id === id; })[0];
      if (o) { out.push({ step: st.id, option: o }); }
    });
    return out;
  }

  // ---------- 離線字母選擇題 ----------
  function choiceMenu(step) {
    var letters = {}, lines = [step.ask];
    (step.options || []).forEach(function (o, i) {
      var L = LETTERS[i];
      letters[L] = o.id;
      lines.push(L + '. ' + o.label + (o.default ? '（預設）' : ''));
    });
    lines.push('只回答一個字母。');
    return { letters: letters, text: lines.join('\n') };
  }

  function letterToOption(step, reply) {
    var m = /^\s*([A-Za-z])\b/.exec(String(reply || ''));
    if (!m) { return null; }
    var menu = choiceMenu(step);
    return Object.prototype.hasOwnProperty.call(menu.letters, m[1].toUpperCase()) ? menu.letters[m[1].toUpperCase()] : null;
  }

  return {
    STEP_ORDER: STEP_ORDER, PALETTE_KEYS: PALETTE_KEYS, DOMAIN_MARGIN: DOMAIN_MARGIN,
    validateSpec: validateSpec, validateDomain: validateDomain, expandUses: expandUses,
    findDomain: findDomain, pickOption: pickOption,
    newState: newState, nextStep: nextStep, answer: answer, fillDefaults: fillDefaults,
    mergeFragments: mergeFragments, picksOf: picksOf, choiceMenu: choiceMenu, letterToOption: letterToOption
  };
}));
