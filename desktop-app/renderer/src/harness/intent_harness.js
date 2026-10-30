// OFFLINE HARNESS -- the domain-independent core (FaHarness, pure functions, UMD, no DOM, no model).
// Why: a small offline model cannot be trusted with a whole request, so the program does the reading in small CLOSED steps and the model only chooses among options (DESIGN.offline-harness.md; same shape as DESIGN.colu.md):
//   request  ->  ① DECOMPOSE   the sentence is cut into atomic intents (command + object + qualifiers); a REASONER does this (built-in: "frames"; add your own, e.g. an NLP intent reasoner)
//            ->  ② DERIVE      what the words do not say but the state does ("the second half", "the last 10 s", "the gaps between the lines") becomes arguments, each derivation recorded (derived[]); what cannot be derived is a gap (a closed question), never a guess
//            ->  ③ UML         the intents are written as a UML use case: User -> Editor.removeSegment(start,end) -> Editor.setTransition(...)  (toUml)
//            ->  ④ WIRING      the CoLU unit catalog binds every UML step to a tool by name / semantics / types (host side: harness_host.js)  (callsOf fills the unit's parameters by NAME from the intent's arguments)
//            ->  ⑤ the calls are checked by the domain's own validator before anything changes (preview first)
// A DOMAIN plugs in: { id, label, ops: { opName: { params: 'a:str,b:int', ret: 'bool', tool: 'fallback_tool_name' } }, unitIntents: { toolName: 'plain words (zh + en)' }, frames: [{ name, test(clause), build(clause, state) -> [intent] }], clauseSplit?: RegExp, toAction?(call) }
// an intent: { op, args, derived[], gaps[], text }.   A REASONER: { id, priority, decompose(text, state, domain) -> { intents, gaps?, derived? } | null } -- registered per domain (or '*'); the highest priority that returns intents wins (domain.mergeReasoners: the later ones can add).
//   FaHarness.registerDomain(d)  registerReasoner(domainId, r)  decompose(domainId, text, state)  toUml(domain, intents)  callsOf(domain, intents, bindResult, catalog)  explain(result)
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.FaHarness = factory(); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var domains = {}, reasoners = {};
  function registerDomain(d) {
    if (!d || !/^[a-z][\w-]{1,30}$/.test(String(d.id || ''))) { throw new Error('domain id'); } if (!d.ops || typeof d.ops !== 'object') { throw new Error('domain ops'); }
    domains[d.id] = d; return d;
  }
  function getDomain(id) { return domains[id] || null; }
  function registerReasoner(domainId, r) {
    if (!r || typeof r.decompose !== 'function' || !r.id) { throw new Error('reasoner'); } var key = domainId || '*', list = reasoners[key] = (reasoners[key] || []).filter(function (x) { return x.id !== r.id; });
    list.push({ id: r.id, priority: typeof r.priority === 'number' ? r.priority : 10, decompose: r.decompose }); list.sort(function (a, b) { return b.priority - a.priority; }); return r.id;
  }
  function removeReasoner(domainId, id) { var k = domainId || '*'; reasoners[k] = (reasoners[k] || []).filter(function (x) { return x.id !== id; }); }
  var DEFAULT_SPLIT = /[，。；;\n]+|(?:然後|接著|再來|並且|而且|之後再|跟著)/, LEAD = /^(?:先|再|最後|並|也|幫我|請|麻煩)+/;
  // the built-in reasoner: the domain's frames, clause by clause; the first frame that fits a clause decides
  var framesReasoner = { id: 'frames', priority: 0, decompose: function (text, state, domain) {
    var out = { intents: [], gaps: [], derived: [] }, frames = domain.frames || [];
    String(text || '').split(domain.clauseSplit || DEFAULT_SPLIT).map(function (x) { return x.trim().replace(LEAD, ''); }).filter(Boolean).forEach(function (c) {
      for (var i = 0; i < frames.length; i++) {
        if (!frames[i].test(c, state)) { continue; } var made = frames[i].build(c, state) || [];
        made.forEach(function (x) { x.text = c; x.frame = frames[i].name; x.derived = x.derived || []; x.gaps = x.gaps || []; out.intents.push(x); x.derived.forEach(function (d) { out.derived.push(d); }); x.gaps.forEach(function (g) { out.gaps.push(g); }); }); return;
      }
      out.gaps.push('沒讀懂這句:' + c);
    });
    return out;
  } };
  function decompose(domainId, text, state, opts) {
    var d = domains[domainId]; if (!d) { return { ok: false, error: 'no such domain: ' + domainId, intents: [], gaps: [], derived: [], via: [] }; }
    var list = (reasoners[domainId] || []).concat(reasoners['*'] || []).concat([framesReasoner]).sort(function (a, b) { return b.priority - a.priority; }), out = { ok: true, domain: domainId, intents: [], gaps: [], derived: [], via: [] };
    for (var i = 0; i < list.length; i++) {
      var r = null; try { r = list[i].decompose(text, state || {}, d); } catch (e) { out.gaps.push(list[i].id + ': ' + String((e && e.message) || e).slice(0, 80)); r = null; }
      if (r && r.intents && r.intents.length) { out.via.push(list[i].id); r.intents.forEach(function (x) { x.by = list[i].id; x.derived = x.derived || []; x.gaps = x.gaps || []; out.intents.push(x); }); (r.gaps || []).forEach(function (g) { out.gaps.push(g); }); (r.derived || []).forEach(function (g) { out.derived.push(g); }); if (!d.mergeReasoners) { break; } }
      else if (r && r.gaps) { r.gaps.forEach(function (g) { out.gaps.push(g); }); }
    }
    out.intents = out.intents.filter(function (x) { return !!d.ops[x.op]; }); out.ok = out.intents.length > 0; return out;
  }
  function paramNames(ps) { return String(ps || '').split(',').map(function (p) { return p.trim().split(':')[0]; }).filter(Boolean); }
  // UML for the unit catalog's binder: one class (the domain's editor) with the operations used, the request as ONE chain of calls
  function toUml(domain, intents) {
    var used = {}, order = []; (intents || []).forEach(function (x) { if (domain.ops[x.op] && !used[x.op]) { used[x.op] = 1; order.push(x.op); } }); if (!order.length) { return ''; }
    var cls = domain.className || 'Editor', L = ['model: ' + (domain.label || domain.id).replace(/[\r\n:]/g, ' ').slice(0, 40), 'actor: User', 'class ' + cls + ' { ' + order.map(function (o) { return '+' + o + '(' + (domain.ops[o].params || '') + '):' + (domain.ops[o].ret || 'bool'); }).join('; ') + ' }'];
    L.push('usecase Request: User -> ' + intents.filter(function (x) { return domain.ops[x.op]; }).map(function (x) { return cls + '.' + x.op + '(' + paramNames(domain.ops[x.op].params).join(',') + ')'; }).join(' -> ')); return L.join('\n');
  }
  // the binder's answer -> tool calls. Each UML step is one intent (same order). The unit's parameters are filled by NAME from intent.args; a required parameter the intent could not give is a gap.
  // A step the catalog could not wire falls back to the op's own tool (ops[op].tool) when the domain names one -- reported as by:'fallback', so wiring quality stays measurable.
  function callsOf(domain, intents, bind, catalog) {
    var steps = (bind && bind.results && bind.results[0] && bind.results[0].steps) || [], units = {}, calls = [], gaps = [];
    ((catalog && catalog.units) || []).forEach(function (u) { units[u.id] = u; }); var list = (intents || []).filter(function (x) { return domain.ops[x.op]; });
    list.forEach(function (it, i) {
      var s = steps[i] || {}, uid = s.unit || (s.units && s.units[0]) || null, u = uid ? units[uid] : null, by = u ? (s.by || 'wired') : 'fallback', tool = u ? u.name : domain.ops[it.op].tool;
      if (!tool) { gaps.push('沒有單元可以做「' + it.op + '」'); return; } var args = {}, missing = [];
      if (u) { u.params.forEach(function (p) { if (it.args && it.args[p.name] !== undefined && it.args[p.name] !== null) { args[p.name] = it.args[p.name]; } else if (p.required) { missing.push(p.name); } }); }
      else { Object.keys(it.args || {}).forEach(function (k) { args[k] = it.args[k]; }); }
      if (missing.length) { gaps.push(it.op + ' 缺少:' + missing.join('、')); }
      calls.push({ i: i, op: it.op, tool: tool, args: args, by: by, wired: !!u, missing: missing, text: it.text });
    });
    return { calls: calls, gaps: gaps, wired: calls.filter(function (c) { return c.wired; }).length, total: list.length };
  }
  function explain(res) { var L = []; (res.derived || []).forEach(function (d) { L.push('推導:' + d); }); (res.gaps || []).forEach(function (g) { L.push('缺:' + g); }); return L; }
  return { registerDomain: registerDomain, getDomain: getDomain, registerReasoner: registerReasoner, removeReasoner: removeReasoner, decompose: decompose, toUml: toUml, callsOf: callsOf, explain: explain, framesReasoner: framesReasoner, _domains: domains };
}));
