// 遊戲的 UML(由 YAML 推導,不叫模型;可以編修回寫成遊戲的封閉動作;設計見 DESIGN.edit-game.md §11)。輸出是 Mermaid 文字。
//   FaGameUml.classDiagram(spec)        原型與元件、行為、場景裡各放了幾個
//   FaGameUml.stateDiagram(spec, id)    一個行為的狀態圖(轉移＝規則裡的 to 動作)
//   FaGameUml.sceneGraph(spec)          場景圖(活動圖:場景為節點,區域／規則裡的 goto 為邊)
//   FaGameUml.sequence(spec, ref)       一段對白或一條規則的循序圖
//   FaGameUml.all(spec) -> { 檔名: 文字 }(遊戲包的 uml/ 資料夾)
//   FaGameUml.transitions(spec, id) -> [{ from, to, event, index, label }]      FaGameUml.toEdits(spec, uml) -> 遊戲的封閉動作:{ kind:'add_transition', behavior, from, to, event, with?, key? } / { kind:'remove_transition', behavior, from, index } / { kind:'add_state', behavior, name }
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./game_core.js'), require('./game_vocab.js')); else root.FaGameUml = factory((root.FaGame || (typeof FaGame !== 'undefined' ? FaGame : undefined)), (root.FaGameVocab || (typeof FaGameVocab !== 'undefined' ? FaGameVocab : undefined))); })(typeof self !== 'undefined' ? self : this, function (G, V) {
  'use strict';
  const q = (s) => String(s == null ? '' : s).replace(/["\n\r]/g, ' ').replace(/[<>{}]/g, '').slice(0, 40);
  const nid = (s) => 'n_' + String(s).replace(/[^A-Za-z0-9_]/g, '_');
  function classDiagram(spec) {
    const s = G.validate(spec).spec, L = ['classDiagram']; const pf = G.of(s, 'prefab'), bh = G.of(s, 'behavior');
    pf.forEach((p) => { L.push('  class ' + nid(p.id) + '["' + q(p.name) + '"] {'); L.push('    sprite ' + p.sprite.kind); L.push('    body ' + p.body.shape + ' ' + p.body.layer + (p.body.solid ? ' solid' : '') + (p.body.trigger ? ' trigger' : '')); if (p.control) { L.push('    control ' + p.control); } Object.keys(p.stats).slice(0, 4).forEach((k) => L.push('    ' + k + ' ' + p.stats[k])); (p.rules || []).slice(0, 3).forEach((r) => L.push('    rule ' + q(r.event + (r.with ? '(' + r.with + ')' : '')))); L.push('  }'); });
    bh.forEach((b) => { L.push('  class ' + nid(b.id) + '["' + q(b.name) + '"] {'); L.push('    <<behavior>>'); Object.keys(b.states).forEach((st) => L.push('    state ' + q(st))); L.push('  }'); });
    pf.forEach((p) => { if (p.behavior && G.byId(s, p.behavior) >= 0) { L.push('  ' + nid(p.id) + ' --> ' + nid(p.behavior) + ' : behavior'); } });
    G.of(s, 'scene').forEach((sc) => { const cnt = {}; G.children(s, sc.id).forEach((c) => { if (c.type === 'object') { cnt[c.prefab] = (cnt[c.prefab] || 0) + 1; } }); L.push('  class ' + nid(sc.id) + '["' + q(sc.name) + '"] {'); L.push('    <<scene>>'); L.push('    kind ' + sc.kind); L.push('  }'); Object.keys(cnt).forEach((k) => { if (G.byId(s, k) >= 0) { L.push('  ' + nid(sc.id) + ' o-- "' + cnt[k] + '" ' + nid(k)); } }); });
    return L.join('\n');
  }
  // 行為的轉移:state.on 裡 do 有 to 動作的規則(事件→目標狀態);on_enter 裡的 to 當作立刻轉移
  function transitions(spec, ref) {
    const s = G.validate(spec).spec, b = s.objects[G.find(s, ref, 'behavior')]; if (!b) { return []; } const out = [];
    Object.keys(b.states).forEach((from) => { (b.states[from].on || []).forEach((r, index) => { (r.do || []).forEach((a) => { if (a.to) { out.push({ from, to: a.to, event: r.event, index, label: V.ruleWords(Object.assign({}, r, { do: [] })).replace(/ → $/, ''), rule: r }); } }); }); (b.states[from].on_enter || []).forEach((a) => { if (a.to) { out.push({ from, to: a.to, event: 'on_enter', index: -1, label: '進入就轉' }); } }); });
    return out;
  }
  function stateDiagram(spec, ref) {
    const s = G.validate(spec).spec, b = s.objects[G.find(s, ref, 'behavior')]; if (!b) { return 'stateDiagram-v2\n  [*] --> 沒有這個行為'; } const L = ['stateDiagram-v2']; if (b.start) { L.push('  [*] --> ' + q(b.start)); }
    Object.keys(b.states).forEach((st) => { const stt = b.states[st]; const acts = (stt.on_enter || []).filter((a) => !a.to).map(V.actionWords).slice(0, 2); L.push('  ' + q(st) + (acts.length ? ' : 進入:' + q(acts.join('、')) : '')); (stt.on || []).forEach((r) => { if (!(r.do || []).some((a) => a.to)) { L.push('  ' + q(st) + ' : ' + q(V.ruleWords(r))); } }); });
    transitions(s, ref).forEach((t) => L.push('  ' + q(t.from) + ' --> ' + q(t.to) + ' : ' + q(t.label || t.event)));
    return L.join('\n');
  }
  function sceneEdges(spec) {
    const s = G.validate(spec).spec, edges = []; const scan = (owner, actions, label, sceneId) => { (actions || []).forEach((a) => { if (a.goto) { edges.push({ from: sceneId, to: a.goto, label }); } }); };
    G.of(s, 'scene').forEach((sc) => { (sc.rules || []).forEach((r) => scan(sc.id, r.do, V.EVENTS[r.event] ? V.EVENTS[r.event].label : r.event, sc.id)); G.children(s, sc.id).forEach((c) => { if (c.type === 'zone') { scan(c.id, c.on_enter, c.name, sc.id); } if (c.type === 'dialog') { (c.choices || []).forEach((ch) => scan(c.id, ch.do, ch.text, sc.id)); } }); });
    G.of(s, 'prefab').forEach((p) => { (p.rules || []).forEach((r) => { const t = (r.do || []).find((a) => a.goto); if (t) { G.of(s, 'scene').forEach((sc) => { if (G.children(s, sc.id).some((c) => c.type === 'object' && c.prefab === p.id)) { edges.push({ from: sc.id, to: t.goto, label: p.name }); } }); } }); });
    return edges;
  }
  function sceneGraph(spec) {
    const s = G.validate(spec).spec, L = ['flowchart LR']; G.of(s, 'scene').forEach((sc) => { L.push('  ' + nid(sc.id) + '["' + q(sc.name) + '<br/>' + q((V.KINDS[sc.kind] || {}).label || sc.kind) + '"]'); }); if (s.game.start) { L.push('  START(("開始")) --> ' + nid(s.game.start)); }
    const seen = {}; sceneEdges(s).forEach((e) => { if (G.byId(s, e.to) < 0) { return; } const k = e.from + '>' + e.to + '>' + e.label; if (seen[k]) { return; } seen[k] = 1; L.push('  ' + nid(e.from) + ' -->|' + q(e.label) + '| ' + nid(e.to)); });
    G.of(s, 'scene').forEach((sc) => { const has = sceneEdges(s).some((e) => e.from === sc.id); if (!has && sc.id !== s.game.start) { L.push('  style ' + nid(sc.id) + ' stroke-dasharray: 4 3'); } });
    return L.join('\n');
  }
  function sequence(spec, ref) {
    const s = G.validate(spec).spec, L = ['sequenceDiagram']; const di = G.find(s, ref, 'dialog');
    if (di >= 0) { const d = s.objects[di]; const who = []; d.lines.forEach((l) => { if (who.indexOf(l.who || '旁白') < 0) { who.push(l.who || '旁白'); } }); L.push('  participant 玩家'); who.forEach((w) => L.push('  participant ' + nid(w) + ' as ' + q(w))); L.push('  玩家->>' + nid(who[0]) + ': 靠近／互動'); d.lines.forEach((l) => L.push('  ' + nid(l.who || '旁白') + '->>玩家: ' + q(l.text))); (d.choices || []).forEach((c) => L.push('  玩家->>' + nid(who[0]) + ': ' + q(c.text))); return L.join('\n'); }
    // 一個原型的規則:事件 → 動作
    const pi = G.find(s, ref, 'prefab'); if (pi >= 0) { const p = s.objects[pi]; const rules = (p.rules || []).concat(p.behavior && G.find(s, p.behavior, 'behavior') >= 0 ? Object.keys(s.objects[G.find(s, p.behavior, 'behavior')].states).reduce((a, st) => a.concat(s.objects[G.find(s, p.behavior, 'behavior')].states[st].on || []), []) : []); L.push('  participant 引擎'); L.push('  participant ' + nid(p.id) + ' as ' + q(p.name)); rules.slice(0, 12).forEach((r) => { L.push('  引擎->>' + nid(p.id) + ': ' + q(V.EVENTS[r.event] ? V.EVENTS[r.event].label + (r.with ? ' ' + r.with : '') : r.event)); (r.do || []).slice(0, 3).forEach((a) => L.push('  ' + nid(p.id) + '-->>引擎: ' + q(V.actionWords(a)))); }); return L.join('\n'); }
    L.push('  Note over 玩家: 沒有這個對白或原型:' + q(ref)); return L.join('\n');
  }
  function all(spec) {
    const s = G.validate(spec).spec, out = { 'classes.mmd': classDiagram(s), 'scenes.mmd': sceneGraph(s) }; G.of(s, 'behavior').forEach((b) => { out['state-' + b.id + '.mmd'] = stateDiagram(s, b.id); }); G.of(s, 'dialog').slice(0, 20).forEach((d) => { out['dialog-' + d.id + '.mmd'] = sequence(s, d.id); }); return out;
  }
  // 編修:UML 上的小動作 → 遊戲的封閉動作
  function toEdits(spec, uml) {
    const s = G.validate(spec).spec; const out = []; (Array.isArray(uml) ? uml : [uml]).forEach((u) => {
      if (!u) { return; }
      if (u.kind === 'add_state') { out.push({ op: 'add_state', behavior: u.behavior, name: u.name, start: !!u.start }); }
      else if (u.kind === 'remove_state') { out.push({ op: 'remove_state', behavior: u.behavior, name: u.name }); }
      else if (u.kind === 'add_transition') { const rule = { event: u.event || 'tick', do: [{ to: u.to }] }; if (u.with) { rule.with = u.with; } if (u.key) { rule.key = u.key; } if (u.zone) { rule.zone = u.zone; } if (u.after) { rule.after = u.after; } if (u.if) { rule.if = u.if; } out.push({ op: 'add_rule', target: { behavior: u.behavior, state: u.from }, rule }); }
      else if (u.kind === 'remove_transition') { out.push({ op: 'delete_rule', target: { behavior: u.behavior, state: u.from }, index: u.index }); }
      else if (u.kind === 'rename_state') { /* 改名需要重寫引用:交給編輯器的 YAML 分頁 */ }
    }); void s; return out;
  }
  return { classDiagram, stateDiagram, sceneGraph, sequence, all, transitions, sceneEdges, toEdits };
});
