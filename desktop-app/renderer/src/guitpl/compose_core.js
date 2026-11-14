// 組合器：設計規格（guitpl/1）＋動作表 → 一支完整的 Python 圖形介面程式（確定性、純函式、UMD；設計見 DESIGN.gui-templates.md 2.7）
//   FaGuiTplCompose.compose(spec, actions) -> { ok, code, errors[], loop, usedActions[] }
//   FaGuiTplCompose.KIND_METHODS            規格節點種類 → gui.Window 方法與可用屬性
// 產生的程式結構固定：import → 視窗 → 主題 → 節點樹 → 快捷鍵 → 狀態與 ctx → 動作函式 → 事件迴圈。
// ctx（動作函式的唯一參數）：ctx.w 視窗；ctx.state 字典；ctx.id(名稱) 節點代號；ctx.get(名稱) 目前值；
//   ctx.set(名稱, **屬性)；ctx.tone(音效名)；ctx.quit() 結束迴圈；ctx.event 目前事件。
(function (root, factory) {
  var Core = (typeof require === 'function' && typeof module === 'object') ? require('./guitpl_core.js') : root.FaGuiTpl;
  if (typeof module === 'object' && module.exports) { module.exports = factory(Core); } else { root.FaGuiTplCompose = factory(Core); }
}(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  // 節點種類 → { method, props: 規格屬性名 → 位置/關鍵字引數名, positional: 依序的位置引數 }
  var KIND_METHODS = {
    column: { method: 'column', positional: [], props: [] },
    row: { method: 'row', positional: [], props: [] },
    expander: { method: 'expander', positional: ['text'], props: ['expanded'] },
    grid: { method: 'grid', positional: [], props: ['columns'] },
    scroll: { method: 'scroll', positional: [], props: ['height'] },
    label: { method: 'label', positional: ['text'], props: [] },
    button: { method: 'button', positional: ['text'], props: [] },
    entry: { method: 'entry', positional: ['value'], props: [] },
    textarea: { method: 'textarea', positional: ['value'], props: ['rows', 'placeholder'] },
    editor: { method: 'editor', positional: ['value'], props: ['lang', 'rows'] },
    checkbox: { method: 'checkbox', positional: ['text'], props: ['checked'] },
    progress: { method: 'progress', positional: ['value'], props: ['max'] },
    list: { method: 'listbox', positional: ['items'], props: ['selected'] },
    multilist: { method: 'multilist', positional: ['items'], props: ['selected'] },
    table: { method: 'table', positional: ['columns', 'rows'], props: [] },
    canvas: { method: 'canvas', positional: [], props: ['width', 'height', 'fps'] }
  };
  var CONTAINERS = ['column', 'row', 'expander', 'grid', 'scroll'];
  // 加在節點後用 w.set 設定的通用屬性
  var AFTER_PROPS = ['enabled', 'visible'];
  // 音效名 → 頻率、毫秒、波形
  var TONES = {
    ok: [880, 80, 'sine'], click: [660, 40, 'sine'], warn: [440, 150, 'triangle'], error: [220, 200, 'square'],
    done: [1046, 160, 'sine'], tick: [1200, 20, 'square']
  };
  // 一定走輪詢（不是 wait）的事件：wait 只會回傳 click、shortcut、close
  var WAIT_EVENTS = ['click', 'shortcut'];

  function py(v) {
    if (v === null || v === undefined) { return 'None'; }
    if (v === true) { return 'True'; }
    if (v === false) { return 'False'; }
    if (typeof v === 'number') { return String(v); }
    if (typeof v === 'string') { return JSON.stringify(v); } // JSON 的跳脫都是合法的 Python 字串
    if (Array.isArray(v)) { return '[' + v.map(py).join(', ') + ']'; }
    return '{' + Object.keys(v).map(function (k) { return py(k) + ': ' + py(v[k]); }).join(', ') + '}';
  }
  function ident(id) { return 'n_' + String(id).replace(/[^A-Za-z0-9_]/g, '_'); }

  function compose(spec, actions) {
    actions = actions || {};
    var errors = [];
    var kinds = Object.keys(KIND_METHODS);
    var check = Core.validateSpec(spec, { kinds: kinds, actions: actions });
    if (!check.ok) { return { ok: false, code: '', errors: check.errors, loop: null, usedActions: [] }; }

    var lines = [];
    function emit(s) { lines.push(s); }
    var win = spec.layout.window;
    var used = {};
    var nameOfId = {};
    var auto = 0;

    emit('# -*- coding: utf-8 -*-');
    emit('# ' + (spec.title || spec.id) + '（由圖形介面範本「' + spec.id + '」組合；規格是 ' + spec.format + '）');
    emit('import gui');
    emit('');
    emit('w = gui.Window(' + py(win.title || spec.title || spec.id) + ', width=' + py(win.width || 360) +
      ', resizable=' + py(!!win.resizable) + ', maximizable=' + py(!!win.maximizable) + ')');

    // 主題
    var themeArgs = [];
    if (spec.palette) { themeArgs.push('palette=' + py(spec.palette)); }
    if (spec.theme) {
      if (spec.theme.font) { themeArgs.push('font=' + py(spec.theme.font)); }
      if (spec.theme.size) { themeArgs.push('size=' + py(spec.theme.size)); }
      if (spec.theme.radius !== undefined) { themeArgs.push('radius=' + py(spec.theme.radius)); }
    }
    if (themeArgs.length) { emit('w.theme(' + themeArgs.join(', ') + ')'); }
    emit('');
    emit('# 節點樹');
    emit('ids = {}');

    function build(nodes, parentVar) {
      nodes.forEach(function (n) {
        var m = KIND_METHODS[n.kind];
        var id = n.id || ('auto_' + (++auto));
        nameOfId[id] = true;
        var args = [];
        m.positional.forEach(function (p) {
          if (n[p] !== undefined) { args.push(py(n[p])); } else if (p === 'columns') { errors.push('table ' + id + ' 缺 columns'); args.push('[]'); } else { args.push(p === 'items' ? '[]' : (p === 'value' ? '""' : '""')); }
        });
        Object.keys(n).forEach(function (k) {
          if (k === 'kind' || k === 'id' || k === 'children' || m.positional.indexOf(k) >= 0 || AFTER_PROPS.indexOf(k) >= 0) { return; }
          if (m.props.indexOf(k) < 0) { errors.push('節點 ' + id + '（' + n.kind + '）不支援屬性 ' + k); return; }
          args.push(k + '=' + py(n[k]));
        });
        if (parentVar) { args.push('parent=' + parentVar); }
        emit('ids[' + py(id) + '] = w.' + m.method + '(' + args.join(', ') + ')');
        var after = [];
        AFTER_PROPS.forEach(function (k) { if (n[k] !== undefined) { after.push(k + '=' + py(n[k])); } });
        if (after.length) { emit('w.set(ids[' + py(id) + '], ' + after.join(', ') + ')'); }
        if (n.children && n.children.length) {
          if (CONTAINERS.indexOf(n.kind) < 0) { errors.push('節點 ' + id + '（' + n.kind + '）不是容器，不能有子節點'); return; }
          build(n.children, 'ids[' + py(id) + ']');
        }
      });
    }
    build(spec.layout.tree, null);

    // 路由：(事件, 節點代號或名稱) → 動作
    var routes = [];
    var handlers = (spec.behavior && spec.behavior.handlers) || [];
    var needPoll = false;
    var canvasFrames = false;
    handlers.forEach(function (h) {
      var m = /^([a-z]+):(.+)$/.exec(h.on);
      used[h.do] = true;
      routes.push({ ev: m[1], node: m[2], act: h.do });
      if (WAIT_EVENTS.indexOf(m[1]) < 0) { needPoll = true; }
      if (m[1] === 'frame' || m[1] === 'key' || m[1] === 'mouse') { canvasFrames = true; }
    });
    (spec.shortcuts || []).forEach(function (s) {
      used[s.do] = true;
      // 快捷鍵的名稱就是動作名稱（同一個動作可有多個按鍵）
    });
    if ((spec.shortcuts || []).length) {
      emit('');
      emit('# 快捷鍵（名稱就是動作名稱）');
      (spec.shortcuts || []).forEach(function (s) { emit('w.shortcut(' + py(s.keys) + ', ' + py(s.do) + ')'); });
    }
    var loop = (needPoll || canvasFrames || (spec.behavior && spec.behavior.loop === 'poll_frame')) ? 'poll' : 'wait';

    // 狀態與 ctx
    emit('');
    emit('state = ' + py((spec.behavior && spec.behavior.state) || {}));
    emit('TONES = ' + py(TONES));
    emit('SOUNDS = ' + py((spec.sound || []).reduce(function (o, s) { (o[s.on] = o[s.on] || []).push(s.tone); return o; }, {})));
    emit('');
    emit('');
    emit('class Ctx(object):');
    emit('    def __init__(self):');
    emit('        self.w = w');
    emit('        self.state = state');
    emit('        self.event = None');
    emit('        self.running = True');
    emit('');
    emit('    def id(self, name):');
    emit('        return ids[name]');
    emit('');
    emit('    def get(self, name):');
    emit('        return w.value(ids[name])');
    emit('');
    emit('    def set(self, name, **props):');
    emit('        w.set(ids[name], **props)');
    emit('');
    emit('    def tone(self, name):');
    emit('        t = TONES.get(name)');
    emit('        if t is not None:');
    emit('            w.tone(t[0], t[1], t[2])');
    emit('');
    emit('    def quit(self):');
    emit('        self.running = False');
    emit('');
    emit('');
    emit('ctx = Ctx()');

    // 動作函式
    var usedNames = Object.keys(used);
    if (usedNames.length) { emit(''); emit('# 動作'); }
    usedNames.forEach(function (name) {
      var a = actions[name];
      var body = String(a.python || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
      if (!new RegExp('^def ' + name + '\\(ctx\\)\\s*:', 'm').test(body)) { errors.push('動作 ' + name + ' 的程式必須以 def ' + name + '(ctx): 開頭'); }
      emit('');
      emit('');
      emit(body);
    });

    // 事件迴圈
    emit('');
    emit('');
    emit('ROUTES = {');
    routes.forEach(function (r) {
      var key = r.ev === 'shortcut' ? py(r.node) : 'ids[' + py(r.node) + ']';
      emit('    (' + py(r.ev) + ', ' + key + '): ' + r.act + ',');
    });
    (spec.shortcuts || []).forEach(function (s) {
      if (!routes.some(function (r) { return r.ev === 'shortcut' && r.node === s.do; })) { emit('    ("shortcut", ' + py(s.do) + '): ' + s.do + ','); }
    });
    emit('}');
    emit('');
    emit('');
    emit('def dispatch(ev):')
    emit('    if ev["event"] == "shortcut":');
    emit('        key = ("shortcut", ev.get("value"))');
    emit('    else:');
    emit('        key = (ev["event"], ev.get("node"))');
    emit('    action = ROUTES.get(key)');
    emit('    if action is None:');
    emit('        return');
    emit('    ctx.event = ev');
    emit('    action(ctx)');
    emit('    for name in SOUNDS.get(action.__name__, []):');
    emit('        ctx.tone(name)');
    emit('');
    emit('');
    if (loop === 'wait') {
      emit('while ctx.running:');
      emit('    ev = w.wait(timeout=3600)');
      emit('    if ev is None or ev["event"] == "close":');
      emit('        break');
      emit('    dispatch(ev)');
    } else {
      emit('import time');
      emit('');
      emit('');
      emit('while ctx.running:');
      emit('    ev = w.poll()');
      emit('    if ev is None:');
      emit('        time.sleep(0.02)');
      emit('        continue');
      emit('    if ev["event"] == "close":');
      emit('        break');
      emit('    dispatch(ev)');
    }
    emit('w.close()');
    emit('');

    if (errors.length) { return { ok: false, code: '', errors: errors, loop: loop, usedActions: usedNames }; }
    return { ok: true, code: lines.join('\n'), errors: [], loop: loop, usedActions: usedNames };
  }

  return { compose: compose, KIND_METHODS: KIND_METHODS, TONES: TONES, py: py, ident: ident };
}));
