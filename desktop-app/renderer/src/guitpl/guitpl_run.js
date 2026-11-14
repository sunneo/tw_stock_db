// 範本庫載入與一條龍：需求文字 → 領域 → 逐步選擇 → 規格 → Python 程式（純函式、UMD；設計見 DESIGN.gui-templates.md 2.1、2.4、2.5）
//   FaGuiTplRun.buildLibrary({ '_common': {...}, 'text-editor': {...}, ... }, userSpecs?) -> { domains[], byId{}, errors[] }
//   FaGuiTplRun.design(lib, text, opts)  -> { status, ... }
//     opts.answers: { 步驟: 選項id }（使用者或模型已答的）；opts.domain: 指定領域（略過領域判斷）；opts.defaults: true 時沒答的走預設
//     status: 'need_domain'（領域不明，ranking 給選單）| 'need_answer'（還有步驟沒答，step 是下一題）| 'ok'（spec、code、auto、picks）| 'error'
(function (root, factory) {
  var req = (typeof require === 'function' && typeof module === 'object');
  var Core = req ? require('./guitpl_core.js') : root.FaGuiTpl;
  var Compose = req ? require('./compose_core.js') : root.FaGuiTplCompose;
  if (typeof module === 'object' && module.exports) { module.exports = factory(Core, Compose); } else { root.FaGuiTplRun = factory(Core, Compose); }
}(typeof self !== 'undefined' ? self : this, function (Core, Compose) {
  'use strict';

  // 領域檔的預設組（presets）要指到真的步驟與選項
  function checkPresets(d) {
    var errors = [];
    (d.presets || []).forEach(function (p) {
      Object.keys(p.picks || {}).forEach(function (stepId) {
        var st = d.steps.filter(function (x) { return x.id === stepId; })[0];
        if (!st) { errors.push(d.domain + ' 預設組 ' + p.id + ' 指到不存在的步驟 ' + stepId); return; }
        if (!(st.options || []).some(function (o) { return o.id === p.picks[stepId]; })) { errors.push(d.domain + ' 預設組 ' + p.id + ' 的 ' + stepId + ' 沒有選項 ' + p.picks[stepId]); }
      });
    });
    return errors;
  }

  function buildLibrary(files, userSpecs) {
    var common = files._common || {};
    var domains = [], errors = [];
    Object.keys(files).forEach(function (name) {
      if (name === '_common') { return; }
      var d;
      try { d = Core.expandUses(files[name], common); } catch (e) { errors.push(name + '：' + e.message); return; }
      var v = Core.validateDomain(d);
      if (!v.ok) { v.errors.forEach(function (e) { errors.push(name + '：' + e); }); return; }
      checkPresets(d).forEach(function (e) { errors.push(e); });
      d.userSpecs = (userSpecs || []).filter(function (u) { return u.domain === d.domain; });
      domains.push(d);
    });
    var byId = {};
    domains.forEach(function (d) { byId[d.domain] = d; });
    return { domains: domains, byId: byId, errors: errors };
  }

  function specFrom(domain, merged, picks) {
    var spec = Object.assign({ format: 'guitpl/1', id: domain.domain + '-' + Object.keys(picks).map(function (k) { return picks[k]; }).join('-'), domain: domain.domain, title: domain.label, source: 'builtin' }, merged);
    return spec;
  }

  function design(lib, text, opts) {
    opts = opts || {};
    var domain = opts.domain ? lib.byId[opts.domain] : null;
    if (opts.domain && !domain) { return { status: 'error', error: '沒有這個領域：' + opts.domain }; }
    if (!domain) {
      var found = Core.findDomain(text, lib.domains);
      if (!found.decided) { return { status: 'need_domain', ranking: found.ranking, domain: found.domain }; }
      domain = lib.byId[found.domain];
    }
    var state = Core.newState(domain, text);
    // 需求文字含預設組的關鍵字就整組套用
    var preset = (domain.presets || []).filter(function (p) { return (p.keywords || []).some(function (k) { return String(text || '').toLowerCase().indexOf(String(k).toLowerCase()) >= 0; }); })[0];
    if (preset) { Object.keys(preset.picks).forEach(function (stepId) { if (!state.asked[stepId]) { state = Core.answer(state, stepId, preset.picks[stepId]); } }); }
    Object.keys(opts.answers || {}).forEach(function (stepId) { state = Core.answer(state, stepId, opts.answers[stepId]); });
    if (opts.defaults) { state = Core.fillDefaults(state); }
    var next = Core.nextStep(state);
    if (next) { return { status: 'need_answer', domain: domain.domain, step: next, menu: Core.choiceMenu(next), auto: state.auto, picks: state.picks }; }
    var merged = Core.mergeFragments(Core.picksOf(state));
    var spec = specFrom(domain, merged, state.picks);
    var out = Compose.compose(spec, domain.actions || {});
    if (!out.ok) { return { status: 'error', domain: domain.domain, spec: spec, errors: out.errors }; }
    return { status: 'ok', domain: domain.domain, spec: spec, code: out.code, loop: out.loop, auto: state.auto, picks: state.picks, preset: preset ? preset.id : null };
  }

  return { buildLibrary: buildLibrary, design: design, checkPresets: checkPresets };
}));
