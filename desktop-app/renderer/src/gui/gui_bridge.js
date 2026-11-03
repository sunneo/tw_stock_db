// GUI bridge core (pure, no DOM): the wire protocol between a skill program (shell, JavaScript, Python, later SDL / GTK# / XAML / QML hosts)
// and the window the AI Chat page draws for it. The program never touches the DOM: it writes one JSON message per line, prefixed "@gui ",
// and the page validates each message and keeps a small widget tree per window. The DOM renderer (ai_chat_gui_render.js, a later batch) only
// reads this tree, so every rule that matters for safety (kinds, props, sizes, ids, text-only values) is enforced here and is testable in node.
//
//   program -> page   @gui {"v":1,"op":"open","id":"w1","title":"Hello","width":420}
//                     @gui {"v":1,"op":"add","id":"w1","parent":"root","node":{"id":"b1","kind":"button","text":"OK"}}
//                     @gui {"v":1,"op":"set","id":"w1","node":"b1","props":{"text":"Done"}}
//                     @gui {"v":1,"op":"remove","id":"w1","node":"b1"}   /  {"v":1,"op":"close","id":"w1"}
//   page -> program   {"v":1,"event":"click","id":"w1","node":"b1"}, {"v":1,"event":"input","id":"w1","node":"e1","value":"..."}
//                     (event "close" when the user closes the window; "select" for list, "change" for checkbox)
//
//                     @gui {"v":1,"op":"draw","id":"w1","node":"c1","ops":[["clear","#000"],["rect",10,10,20,4,"#0f0"]]}
//                     (a draw replaces the whole frame of a canvas; a canvas answers "key" and "frame" events)
//                     @gui {"v":1,"op":"image","id":"w1","node":"c1","name":"ship","data":"data:image/png;base64,..."}
//                     (a picture is registered once per canvas; a frame draws it by name: ["image","ship",x,y,w,h]. data null removes it.
//                      Only the Python / JavaScript route sends pictures: the program-output route refuses them, since its lines are short.)
//
// Kinds: column, row, expander (containers, children added with parent), label, button, entry, textarea, editor, checkbox, progress, list, multilist, table, canvas.
// Values are always plain text: no HTML and no script ever reaches the page through this protocol.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatGuiBridge = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var VERSION = 1, PREFIX = '@gui ';
  var MAX_LINE = 8192, MAX_WINDOWS = 4, MAX_NODES = 200, MAX_TEXT = 2000, MAX_ITEMS = 500, MAX_DEPTH = 8;
  var ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  var OPS = ['open', 'add', 'set', 'remove', 'close', 'draw', 'image'];
  var CONTAINERS = ['column', 'row', 'expander'];
  var MAX_COLUMNS = 30, MAX_DRAW = 200, MAX_CANVAS = 1200, MAX_FPS = 60;
  var MAX_IMAGES = 16, MAX_IMAGE_BYTES = 256 * 1024;
  var COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
  // a draw command and its length (name included): every command ends with its color, except clear, which is only the color
  var DRAW_LENGTH = { clear: 2, rect: 6, circle: 5, line: 6, text: 5 };
  var KINDS = {
    column: { props: [] },
    row: { props: [] },
    expander: { props: ['text', 'expanded'], events: ['toggle'] },
    label: { props: ['text'] },
    button: { props: ['text', 'enabled'], events: ['click'] },
    entry: { props: ['value', 'placeholder', 'enabled', 'secret'], events: ['input'] },
    textarea: { props: ['value', 'placeholder', 'rows', 'enabled'], events: ['input'] },
    editor: { props: ['value', 'lang', 'rows', 'enabled'], events: ['input'] },
    checkbox: { props: ['text', 'checked', 'enabled'], events: ['change'] },
    progress: { props: ['value', 'max'] },
    list: { props: ['items', 'selected', 'enabled'], events: ['select'] },
    multilist: { props: ['items', 'selected', 'enabled'], events: ['select'] },
    table: { props: ['columns', 'rows', 'enabled'], events: ['cell'] },
    // a canvas is drawn by whole frames (op "draw" replaces the frame); fps > 0 makes the page send "frame" events, key presses come as "key",
    // the pointer as "mouse" ({kind: down | up | move, x, y, button} with x and y inside the canvas), the wheel as "wheel" ({x, y, dy}),
    // and "resize" ({width, height}: the canvas's new size in pixels when its window is resized or maximized)
    canvas: { props: ['width', 'height', 'fps'], events: ['key', 'frame', 'mouse', 'wheel', 'resize'] }
  };
  var COMMON = ['visible'];

  function fail(error) { return { ok: false, error: error }; }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function text(v, field) {
    if (typeof v !== 'string') { throw new Error(field + ' must be a string'); }
    if (v.length > MAX_TEXT) { throw new Error(field + ' is longer than ' + MAX_TEXT + ' characters'); }
    return v;
  }
  function id(v, field) {
    if (typeof v !== 'string' || !ID_RE.test(v)) { throw new Error(field + ' must be 1-40 letters, digits, _ or -'); }
    return v;
  }
  function num(v, field, lo, hi) {
    if (typeof v !== 'number' || !isFinite(v) || v < lo || v > hi) { throw new Error(field + ' must be a number from ' + lo + ' to ' + hi); }
    return v;
  }
  function bool(v, field) { if (typeof v !== 'boolean') { throw new Error(field + ' must be true or false'); } return v; }

  // one prop, checked by its name; the same rules serve add (node props) and set
  function prop(kind, name, v) {
    switch (name) {
      case 'text': case 'value': case 'placeholder': case 'lang': return text(v, name);
      case 'enabled': case 'checked': case 'visible': case 'secret': case 'expanded': return bool(v, name);
      case 'rows': return num(v, name, 1, 30);
      case 'max': return num(v, name, 0, 1e12);
      case 'selected': return text(v, name);
      case 'items':
        if (!Array.isArray(v) || v.length > MAX_ITEMS) { throw new Error('items must be an array of at most ' + MAX_ITEMS + ' strings'); }
        return v.map(function (s, i) { return text(s, 'items[' + i + ']'); });
    }
    throw new Error('prop "' + name + '" is not allowed on ' + kind);
  }

  // progress takes a number for value; everything else with a value is text
  function propValue(kind, name, v) {
    if (kind === 'progress' && name === 'value') { return num(v, 'value', 0, 1e12); }
    if (kind === 'canvas' && (name === 'width' || name === 'height')) { return num(v, name, 1, MAX_CANVAS); }
    if (kind === 'canvas' && name === 'fps') { return num(v, name, 0, MAX_FPS); }
    if (kind === 'table' && name === 'columns') { return cellList(v, 'columns', 1, MAX_COLUMNS); }
    if (kind === 'table' && name === 'rows') { return tableRows(v); }
    if (kind === 'multilist' && name === 'selected') { return cellList(v, 'selected', 0, MAX_ITEMS); }
    return prop(kind, name, v);
  }

  // an array of text values (table columns, multilist selection)
  function cellList(v, field, min, max) {
    if (!Array.isArray(v) || v.length < min || v.length > max) { throw new Error(field + ' must be an array of ' + min + ' to ' + max + ' strings'); }
    return v.map(function (s, i) { return text(s, field + '[' + i + ']'); });
  }

  // table rows: an array of rows, each with one text value per column
  function tableRows(v) {
    if (!Array.isArray(v) || v.length > MAX_ITEMS) { throw new Error('rows must be an array of at most ' + MAX_ITEMS + ' rows'); }
    return v.map(function (r, i) { return cellList(r, 'rows[' + i + ']', 0, MAX_COLUMNS); });
  }

  // a picture registered on the canvas: data is a PNG, JPEG, GIF or WebP data URL of at most MAX_IMAGE_BYTES (decoded)
  function imageData(v) {
    var bad = 'data must be a data:image/png, jpeg, gif or webp;base64 URL';
    if (typeof v !== 'string') { throw new Error(bad); }
    var m = IMAGE_RE.exec(v);
    if (!m) { throw new Error(bad); }
    var b64 = m[2], pad = (b64.match(/=+$/) || [''])[0].length;
    if (b64.length % 4 !== 0) { throw new Error('data is not valid base64'); }
    if (b64.length / 4 * 3 - pad > MAX_IMAGE_BYTES) { throw new Error('image is larger than ' + (MAX_IMAGE_BYTES / 1024) + ' KB'); }
    return v;
  }

  // draw ["image", name, x, y] or ["image", name, x, y, w, h]: the name must be a picture of this canvas
  function imageCommand(op, what, images) {
    if (op.length !== 4 && op.length !== 6) { throw new Error(what + ' image needs a name, x, y and optionally w, h'); }
    var name = id(op[1], what + '[1]');
    if (!Object.prototype.hasOwnProperty.call(images, name)) { throw new Error(what + ' image "' + name + '" is not loaded on this canvas'); }
    var out = ['image', name, num(op[2], what + '[2]', -1e5, 1e5), num(op[3], what + '[3]', -1e5, 1e5)];
    if (op.length === 6) { out.push(num(op[4], what + '[4]', 0, 1e5), num(op[5], what + '[5]', 0, 1e5)); }
    return out;
  }

  // one draw command: ["rect", x, y, w, h, "#rrggbb"] and the rest of DRAW_LENGTH. Coordinates are checked, never clipped here.
  function drawCommand(op, what, images) {
    if (Array.isArray(op) && op[0] === 'image') { return imageCommand(op, what, images); }
    if (!Array.isArray(op) || !Object.prototype.hasOwnProperty.call(DRAW_LENGTH, op[0])) { throw new Error(what + ' must be [name, ...] with name clear, rect, circle, line, text or image'); }
    var name = op[0];
    if (op.length !== DRAW_LENGTH[name]) { throw new Error(what + ' ' + name + ' needs ' + (DRAW_LENGTH[name] - 1) + ' values after the name'); }
    var color = op[op.length - 1];
    if (typeof color !== 'string' || !COLOR_RE.test(color)) { throw new Error(what + ' color must be #rgb or #rrggbb'); }
    var c = function (i) { return num(op[i], what + '[' + i + ']', -1e5, 1e5); };
    if (name === 'clear') { return [name, color]; }
    if (name === 'rect') { return [name, c(1), c(2), num(op[3], what + '[3]', 0, 1e5), num(op[4], what + '[4]', 0, 1e5), color]; }
    if (name === 'circle') { return [name, c(1), c(2), num(op[3], what + '[3]', 0, 1e4), color]; }
    if (name === 'line') { return [name, c(1), c(2), c(3), c(4), color]; }
    return [name, c(1), c(2), text(op[3], what + '[3]'), color];
  }

  function drawOps(v, images) {
    if (!Array.isArray(v) || v.length > MAX_DRAW) { throw new Error('ops must be an array of at most ' + MAX_DRAW + ' drawing commands'); }
    return v.map(function (op, i) { return drawCommand(op, 'ops[' + i + ']', images); });
  }

  function checkNode(n, what) {
    if (!isObj(n)) { throw new Error(what + ' must be an object'); }
    var kind = n.kind;
    if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) { throw new Error(what + ' kind "' + kind + '" is not supported'); }
    var out = { id: id(n.id, what + '.id'), kind: kind, children: [] };
    if (n.id === 'root') { throw new Error('"root" is reserved for the window'); }
    var allowed = KINDS[kind].props.concat(COMMON);
    Object.keys(n).forEach(function (k) {
      if (k === 'id' || k === 'kind') { return; }
      if (allowed.indexOf(k) < 0) { throw new Error('prop "' + k + '" is not allowed on ' + kind); }
      out[k] = propValue(kind, k, n[k]);
    });
    if (kind === 'table' && out.rows) {
      if (!out.columns) { throw new Error('a table needs columns before its rows'); }
      out.rows.forEach(function (r, i) { if (r.length !== out.columns.length) { throw new Error('rows[' + i + '] has ' + r.length + ' cells, the table has ' + out.columns.length + ' columns'); } });
    }
    return out;
  }

  function createSession() { return { windows: {} }; }
  function nodeCount(win) { return Object.keys(win.nodes).length; }
  function depthOf(win, nid) { var d = 0, cur = win.nodes[nid]; while (cur && cur.parent !== null) { d++; cur = win.nodes[cur.parent]; } return d; }

  // Parse one output line from the program. Returns null for ordinary output (not a GUI message),
  // {error} for a broken GUI line, {msg} for a GUI message.
  function parseLine(line) {
    if (typeof line !== 'string' || line.indexOf(PREFIX) !== 0) { return null; }
    if (line.length > MAX_LINE) { return { error: 'GUI message longer than ' + MAX_LINE + ' bytes' }; }
    var msg;
    try { msg = JSON.parse(line.slice(PREFIX.length)); } catch (e) { return { error: 'GUI message is not valid JSON' }; }
    if (!isObj(msg) || msg.v !== VERSION) { return { error: 'GUI message needs "v":' + VERSION }; }
    if (OPS.indexOf(msg.op) < 0) { return { error: 'GUI op "' + msg.op + '" is not supported' }; }
    return { msg: msg };
  }

  // Apply one validated message to the session. Returns {ok:true} or {ok:false, error}. Never throws.
  function apply(session, msg) {
    try {
      var wid = id(msg.id, 'id');
      if (msg.op === 'open') {
        if (session.windows[wid]) { return fail('window "' + wid + '" is already open'); }
        if (Object.keys(session.windows).length >= MAX_WINDOWS) { return fail('at most ' + MAX_WINDOWS + ' windows'); }
        var title = msg.title === undefined ? 'Skill window' : text(msg.title, 'title');
        var width = msg.width === undefined ? 420 : num(msg.width, 'width', 160, 1200);
        // resizable: the user can drag the window's corner; maximizable: a button fills the terminal's area (both off by default)
        var resizable = msg.resizable === undefined ? false : bool(msg.resizable, 'resizable');
        var maximizable = msg.maximizable === undefined ? false : bool(msg.maximizable, 'maximizable');
        session.windows[wid] = { id: wid, title: title, width: width, resizable: resizable, maximizable: maximizable, nodes: { root: { id: 'root', kind: 'column', parent: null, children: [] } } };
        return { ok: true };
      }
      var win = session.windows[wid];
      if (!win) { return fail('window "' + wid + '" is not open'); }
      if (msg.op === 'close') { delete session.windows[wid]; return { ok: true }; }
      if (msg.op === 'add') {
        var parent = msg.parent === undefined ? 'root' : id(msg.parent, 'parent');
        var p = win.nodes[parent];
        if (!p) { return fail('parent "' + parent + '" does not exist'); }
        if (CONTAINERS.indexOf(p.kind) < 0) { return fail('parent "' + parent + '" is a ' + p.kind + ', not a container'); }
        if (depthOf(win, parent) + 1 > MAX_DEPTH) { return fail('nesting deeper than ' + MAX_DEPTH); }
        var n = checkNode(msg.node, 'node');
        if (win.nodes[n.id]) { return fail('node "' + n.id + '" already exists in window "' + wid + '"'); }
        if (nodeCount(win) >= MAX_NODES) { return fail('at most ' + MAX_NODES + ' nodes per window'); }
        n.parent = parent;
        win.nodes[n.id] = n;
        p.children.push(n.id);
        return { ok: true };
      }
      var nid = id(msg.node, 'node');
      var target = win.nodes[nid];
      if (!target || nid === 'root') { return fail('node "' + nid + '" does not exist in window "' + wid + '"'); }
      if (msg.op === 'set') {
        if (!isObj(msg.props)) { return fail('props must be an object'); }
        Object.keys(msg.props).forEach(function (k) {
          var allowed = KINDS[target.kind].props.concat(COMMON);
          if (allowed.indexOf(k) < 0) { throw new Error('prop "' + k + '" is not allowed on ' + target.kind); }
          target[k] = propValue(target.kind, k, msg.props[k]);
        });
        return { ok: true };
      }
      if (msg.op === 'draw') {
        if (target.kind !== 'canvas') { return fail('node "' + nid + '" is a ' + target.kind + ', not a canvas'); }
        target.frame = drawOps(msg.ops, target.images || {});
        return { ok: true };
      }
      if (msg.op === 'image') {
        if (target.kind !== 'canvas') { return fail('node "' + nid + '" is a ' + target.kind + ', not a canvas'); }
        var name = id(msg.name, 'name');
        target.images = target.images || {};
        if (msg.data === null) { delete target.images[name]; return { ok: true }; }
        var known = Object.prototype.hasOwnProperty.call(target.images, name);
        if (!known && Object.keys(target.images).length >= MAX_IMAGES) { return fail('at most ' + MAX_IMAGES + ' pictures per canvas'); }
        target.images[name] = imageData(msg.data);
        return { ok: true };
      }
      if (msg.op === 'remove') {
        (function drop(nodeId) {
          var node = win.nodes[nodeId];
          node.children.forEach(drop);
          delete win.nodes[nodeId];
        }(nid));
        var par = win.nodes[target.parent];
        par.children = par.children.filter(function (c) { return c !== nid; });
        return { ok: true };
      }
      return fail('op "' + msg.op + '" is not supported');
    } catch (e) {
      return fail(e.message || String(e));
    }
  }

  // Page -> program event line. Only the event each kind declares is allowed; the value is text (or a number for checkbox/progress).
  function eventLine(session, winId, nodeId, eventName, value) {
    var win = session.windows[winId];
    var node = win && win.nodes[nodeId];
    if (!node) { return null; }
    var declared = KINDS[node.kind].events || [];
    if (declared.indexOf(eventName) < 0) { return null; }
    if ((eventName === 'key' || eventName === 'frame' || eventName === 'mouse' || eventName === 'wheel' || eventName === 'resize') && value === undefined) { return null; } // these always carry a value
    var ev = { v: VERSION, event: eventName, id: winId, node: nodeId };
    if (value !== undefined) {
      if (eventName === 'change' || eventName === 'toggle') { ev.value = !!value; }
      else if (eventName === 'key') {
        // {key, down}: a key name such as "ArrowLeft" or " " (space); anything longer than 20 characters is cut
        var key = value && value.key;
        if (typeof key !== 'string' || !key.length) { return null; }
        ev.value = { key: key.slice(0, 20), down: !!value.down };
      } else if (eventName === 'frame') {
        // {t}: milliseconds from the page clock, a whole number
        var t = value && value.t;
        if (typeof t !== 'number' || !isFinite(t)) { return null; }
        ev.value = { t: Math.floor(t) };
      } else if (eventName === 'mouse') {
        // {kind, x, y, button}: the pointer position inside the canvas (rounded and kept inside it); button 0 left, 1 middle, 2 right
        var kind = value && value.kind;
        if (['down', 'up', 'move'].indexOf(kind) < 0) { return null; }
        var mx = Math.round(Number(value.x)), my = Math.round(Number(value.y));
        if (!isFinite(mx) || !isFinite(my)) { return null; }
        var button = Number.isInteger(value.button) && value.button >= 0 && value.button <= 4 ? value.button : 0;
        ev.value = { kind: kind, x: Math.min(node.width, Math.max(0, mx)), y: Math.min(node.height, Math.max(0, my)), button: button };
      } else if (eventName === 'wheel') {
        // {x, y, dy}: the pointer inside the canvas and the wheel's scroll (browser units, clamped to -1000..1000; 0 is refused)
        var wx = Math.round(Number(value.x)), wy = Math.round(Number(value.y)), dy = Number(value.dy);
        if (!isFinite(wx) || !isFinite(wy) || !isFinite(dy) || dy === 0) { return null; }
        ev.value = { x: Math.min(node.width, Math.max(0, wx)), y: Math.min(node.height, Math.max(0, wy)), dy: Math.max(-1000, Math.min(1000, Math.round(dy))) };
      } else if (eventName === 'resize') {
        // {width, height}: the canvas's new size in pixels (16 to 2000 each). The bridge keeps the new size, so the clamps above follow it.
        var rw = Math.round(Number(value.width)), rh = Math.round(Number(value.height));
        if (!isFinite(rw) || !isFinite(rh) || rw < 16 || rh < 16 || rw > 2000 || rh > 2000) { return null; }
        node.width = rw; node.height = rh;
        ev.value = { width: rw, height: rh };
      } else if (eventName === 'cell') {
        // {row, col, text}: a table cell the user changed; the position must be a real cell of the table
        var row = value && value.row, col = value && value.col;
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || !node.rows || row >= node.rows.length || col >= (node.columns || []).length) { return null; }
        ev.value = { row: row, col: col, text: String(value.text).slice(0, MAX_TEXT) };
      } else if (Array.isArray(value)) { ev.value = value.slice(0, MAX_ITEMS).map(function (s) { return String(s).slice(0, MAX_TEXT); }); }
      else { ev.value = String(value).slice(0, MAX_TEXT); }
    }
    return JSON.stringify(ev);
  }

  // Plain-data snapshot of one window (what the renderer and the tests read). No functions, no DOM.
  function snapshot(session, winId) {
    var win = session.windows[winId];
    if (!win) { return null; }
    function build(nid) {
      var n = win.nodes[nid], out = {};
      Object.keys(n).forEach(function (k) { if (k !== 'parent' && k !== 'children') { out[k] = n[k]; } });
      out.children = n.children.map(build);
      return out;
    }
    return { id: win.id, title: win.title, width: win.width, resizable: win.resizable, maximizable: win.maximizable, root: build('root') };
  }

  // shell side: `gui wait <window-id> [VAR]` (the words after `gui`). Returns {ok, win, varName} or {ok:false, error}.
  // VAR is checked here; the caller also refuses the read-only builtins (SECONDS, RANDOM, ...), which live in the terminal engine.
  var VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  function parseWait(text) {
    var words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (words[0] !== 'wait') { return { ok: false, error: 'usage: gui wait <window-id> [VAR]' }; }
    if (words.length < 2 || words.length > 3) { return { ok: false, error: 'usage: gui wait <window-id> [VAR]' }; }
    if (!ID_RE.test(words[1])) { return { ok: false, error: 'window id must be 1-40 letters, digits, _ or -' }; }
    if (words.length === 3 && !VAR_RE.test(words[2])) { return { ok: false, error: 'VAR must be a shell variable name' }; }
    return { ok: true, win: words[1], varName: words[2] || null };
  }

  return {
    VERSION: VERSION, PREFIX: PREFIX, KINDS: KINDS, LIMITS: { MAX_LINE: MAX_LINE, MAX_WINDOWS: MAX_WINDOWS, MAX_NODES: MAX_NODES, MAX_TEXT: MAX_TEXT, MAX_ITEMS: MAX_ITEMS, MAX_DEPTH: MAX_DEPTH },
    createSession: createSession, parseLine: parseLine, parseWait: parseWait, apply: apply, eventLine: eventLine, snapshot: snapshot
  };
}));
