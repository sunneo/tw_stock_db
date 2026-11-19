// node renderer/src/gui/gui_render.test.js -- the GUI renderer on a recording fake document (no jsdom): structure, text-only values, events, hidden/disabled
const assert = require('assert');
const G = require('./gui_bridge.js');
const R = require('./gui_render.js');
let n = 0; const ok = () => { n++; };

// a minimal document: elements keep children, attributes, listeners; setting innerHTML is recorded as a violation
const violations = [];
function El(tag) {
  this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.hidden = false; this.disabled = false;
  this._text = ''; this.value = ''; this.checked = false; this.options = [];
}
El.prototype.appendChild = function (c) { this.children.push(c); return c; };
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
El.prototype.addEventListener = function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); };
El.prototype.fire = function (t) { (this.listeners[t] || []).forEach((fn) => fn({ target: this })); };
Object.defineProperty(El.prototype, 'textContent', { get() { return this._text; }, set(v) { this._text = String(v); } });
Object.defineProperty(El.prototype, 'innerHTML', { get() { return ''; }, set(v) { violations.push(v); } });
const doc = { createElement: (tag) => new El(tag) };
const find = (el, pred) => { if (pred(el)) { return el; } for (const c of el.children) { const f = find(c, pred); if (f) { return f; } } return null; };
const byNode = (el, id) => find(el, (e) => e.attrs['data-node'] === id);

// build a window with every kind
const s = G.createSession();
const apply = (m) => { const r = G.apply(s, m); assert.ok(r.ok, r.error); };
apply({ op: 'open', id: 'w', title: '<b>Title</b>', width: 360 });
apply({ op: 'add', id: 'w', node: { id: 'hi', kind: 'label', text: '<img src=x onerror=alert(1)>' } });
apply({ op: 'add', id: 'w', node: { id: 'row', kind: 'row' } });
apply({ op: 'add', id: 'w', parent: 'row', node: { id: 'name', kind: 'entry', value: 'ab', placeholder: 'your name' } });
apply({ op: 'add', id: 'w', parent: 'row', node: { id: 'ok', kind: 'button', text: 'OK', enabled: false } });
apply({ op: 'add', id: 'w', node: { id: 'memo', kind: 'textarea', value: 'x', rows: 5 } });
apply({ op: 'add', id: 'w', node: { id: 'keep', kind: 'checkbox', text: 'Keep', checked: true } });
apply({ op: 'add', id: 'w', node: { id: 'bar', kind: 'progress', value: 40, max: 80 } });
apply({ op: 'add', id: 'w', node: { id: 'pick', kind: 'list', items: ['one', 'two'], selected: 'two' } });
apply({ op: 'add', id: 'w', node: { id: 'gone', kind: 'label', text: 'hidden', visible: false } });
apply({ op: 'add', id: 'w', node: { id: 'tall', kind: 'list', items: ['a', 'b', 'c'], rows: 24 } });

const events = [];
let closed = 0;
const win = R.renderWindow(doc, G.snapshot(s, 'w'), (name, node, value) => events.push([name, node, value]), () => { closed++; });
assert.strictEqual(byNode(win, 'tall').size, 24); assert.strictEqual(byNode(win, 'pick').size, 2); assert.strictEqual(byNode(win, 'tall').style.minHeight, '432px'); ok();

// 1. structure and title; the title and label text is text, not markup
assert.strictEqual(win.className, 'gui-window'); ok();
assert.strictEqual(win.attrs['data-window'], 'w'); ok();
assert.strictEqual(win.style.width, '360px'); ok();
assert.strictEqual(find(win, (e) => e.className === 'gui-titlebar').children[0].textContent, '<b>Title</b>'); ok();
assert.strictEqual(byNode(win, 'hi').textContent, '<img src=x onerror=alert(1)>'); ok();
assert.strictEqual(violations.length, 0); ok(); // innerHTML was never assigned

// 2. each kind maps to its element with the right state
assert.strictEqual(byNode(win, 'name').value, 'ab'); assert.strictEqual(byNode(win, 'name').placeholder, 'your name'); ok();
assert.strictEqual(byNode(win, 'ok').disabled, true); assert.strictEqual(byNode(win, 'ok').textContent, 'OK'); ok();
assert.strictEqual(byNode(win, 'memo').rows, 5); ok();
assert.strictEqual(find(byNode(win, 'keep'), (e) => e.tagName === 'input').checked, true); ok();
assert.strictEqual(byNode(win, 'bar').value, 40); assert.strictEqual(byNode(win, 'bar').max, 80); ok();
const opts = byNode(win, 'pick').children;
assert.deepStrictEqual(opts.map((o) => o.value), ['one', 'two']); assert.strictEqual(opts[1].selected, true); ok();
assert.strictEqual(byNode(win, 'gone').hidden, true); ok();

// 3. events go out with node id and value; only real user actions fire
byNode(win, 'ok').fire('click');
assert.deepStrictEqual(events[0], ['click', 'ok', undefined]); ok();
byNode(win, 'name').value = 'carol'; byNode(win, 'name').fire('input');
assert.deepStrictEqual(events[1], ['input', 'name', 'carol']); ok();
const box = find(byNode(win, 'keep'), (e) => e.tagName === 'input');
box.checked = false; box.fire('change');
assert.deepStrictEqual(events[2], ['change', 'keep', false]); ok();
byNode(win, 'pick').value = 'one'; byNode(win, 'pick').fire('change');
assert.deepStrictEqual(events[3], ['select', 'pick', 'one']); ok();
assert.strictEqual(events.length, 4); ok();

// 4. the close button calls onClose, not onEvent
find(win, (e) => e.className === 'gui-close').fire('click');
assert.strictEqual(closed, 1); assert.strictEqual(events.length, 4); ok();

// 5. an unknown kind cannot be rendered (defence in depth: the bridge already rejects it)
assert.throws(() => R.renderWindow(doc, { id: 'x', title: 't', width: 200, root: { id: 'root', kind: 'iframe', children: [] } }, () => {}, () => {}), /unknown GUI kind/); ok();

// 6. batch 3b widgets: table, expander, editor, multilist (a second window in the same session)
apply({ op: 'open', id: 'w2', title: 'Widgets', width: 400 });
apply({ op: 'add', id: 'w2', node: { id: 'tb', kind: 'table', columns: ['name', 'qty'], rows: [['a', '1'], ['b', '2']], enabled: true } });
apply({ op: 'add', id: 'w2', node: { id: 'ex', kind: 'expander', text: 'More', expanded: true } });
apply({ op: 'add', id: 'w2', parent: 'ex', node: { id: 'inner', kind: 'label', text: 'inside' } });
apply({ op: 'add', id: 'w2', node: { id: 'ed', kind: 'editor', value: 'if x:\n\tpass', lang: 'python', rows: 6 } });
apply({ op: 'add', id: 'w2', node: { id: 'ml', kind: 'multilist', items: ['red', 'green', 'blue'], selected: ['green'] } });
const events2 = [];
const win2 = R.renderWindow(doc, G.snapshot(s, 'w2'), (name, node, value) => events2.push([name, node, value]), () => {});

// table: header from columns, one text input per cell, drawn with the row and column indexes
const tbl = byNode(win2, 'tb');
assert.strictEqual(tbl.className, 'gui-tablebox'); assert.strictEqual(find(tbl, (e) => e.tagName === 'table').className, 'gui-table'); ok();
assert.deepStrictEqual(find(tbl, (e) => e.tagName === 'thead').children[0].children.map((th) => th.textContent), ['name', 'qty']); ok();
const cells = find(tbl, (e) => e.tagName === 'tbody').children.map((tr) => tr.children.map((td) => td.children[0].value));
assert.deepStrictEqual(cells, [['a', '1'], ['b', '2']]); ok();
const cell = find(tbl, (e) => e.tagName === 'tbody').children[1].children[1].children[0];
cell.value = '9'; cell.fire('change');
assert.deepStrictEqual(events2[0], ['cell', 'tb', { row: 1, col: 1, text: '9' }]); ok();
// a table with enabled false disables every cell
apply({ op: 'set', id: 'w2', node: 'tb', props: { enabled: false } });
const lockedCell = find(byNode(R.renderWindow(doc, G.snapshot(s, 'w2'), () => {}, () => {}), 'tb'), (e) => e.className === 'gui-cell');
assert.strictEqual(lockedCell.disabled, true); ok();
apply({ op: 'set', id: 'w2', node: 'tb', props: { enabled: true } });

// expander: details + summary, open from expanded, child drawn inside, toggle sends the open flag
const ex = byNode(win2, 'ex');
assert.strictEqual(ex.tagName, 'details'); assert.strictEqual(ex.open, true); ok();
assert.strictEqual(find(ex, (e) => e.tagName === 'summary').textContent, 'More'); ok();
assert.strictEqual(byNode(ex, 'inner').textContent, 'inside'); ok();
ex.open = false; ex.fire('toggle');
assert.deepStrictEqual(events2[1], ['toggle', 'ex', false]); ok();

// editor: monospace textarea, text value, Tab inserts two spaces, Shift+Tab is left alone
const edBox = byNode(win2, 'ed');
assert.strictEqual(edBox.className, 'gui-editor'); assert.strictEqual(edBox.attrs['data-lang'], 'python'); ok();
const ed = find(edBox, (e) => e.tagName === 'textarea');
assert.strictEqual(ed.className, 'gui-ed-ta'); assert.strictEqual(edBox.value, 'if x:\n\tpass'); ok();
assert.strictEqual(find(edBox, (e) => e.className === 'gui-ed-gutter') !== null, true, 'line numbers'); ok();
assert.ok(find(edBox, (e) => e.className === 'gui-tok-keyword' && e.textContent === 'if'), 'python keywords are colored'); ok();
assert.strictEqual(ed.spellcheck, false); assert.strictEqual(ed.value, 'if x:\n\tpass'); ok();
let prevented = 0;
ed.value = 'ab'; ed.selectionStart = 1; ed.selectionEnd = 1;
ed.listeners.keydown[0]({ key: 'Tab', shiftKey: false, preventDefault() { prevented++; } });
assert.strictEqual(ed.value, 'a  b'); assert.strictEqual(ed.selectionStart, 3); assert.strictEqual(prevented, 1); ok();
assert.deepStrictEqual(events2[2], ['input', 'ed', 'a  b']); ok();
ed.listeners.keydown[0]({ key: 'Tab', shiftKey: true, preventDefault() { prevented++; } });
assert.strictEqual(prevented, 1); assert.strictEqual(ed.value, 'a  b'); ok();
ed.value = 'typed'; edBox.fire('input');
assert.deepStrictEqual(events2[3], ['input', 'ed', 'typed']); ok();

// multilist: a multiple select, options selected from the list, change sends the picked items in order
const ml = byNode(win2, 'ml');
assert.strictEqual(ml.multiple, true); ok();
assert.deepStrictEqual(ml.children.map((o) => o.selected), [false, true, false]); ok();
ml.options = ml.children;
ml.options[0].selected = true; ml.options[1].selected = false; ml.options[2].selected = true; ml.fire('change');
assert.deepStrictEqual(events2[4], ['select', 'ml', ['red', 'blue']]); ok();
ml.options.forEach((o) => { o.selected = false; }); ml.fire('change');
assert.deepStrictEqual(events2[5], ['select', 'ml', []]); ok();

assert.strictEqual(violations.length, 0); ok();

// theme: colors, font, size, radius reach the window and its controls; shortcuts fire "shortcut" on the window
{
  const S = G.createSession();
  const ap = (m) => { const r = G.apply(S, m); assert.ok(r.ok, r.error); };
  ap({ op: 'open', id: 'wt', title: 'T', width: 300 });
  ap({ op: 'add', id: 'wt', node: { id: 'b', kind: 'button', text: 'Go' } });
  ap({ op: 'add', id: 'wt', node: { id: 'e', kind: 'entry', value: '' } });
  ap({ op: 'add', id: 'wt', node: { id: 'pb', kind: 'progress', value: 1, max: 2 } });
  ap({ op: 'theme', id: 'wt', palette: { bg: '#102030', fg: '#eeeeee', accent: '#ffffcc', muted: '#778899' }, font: 'monospace', size: 15, radius: 6 });
  ap({ op: 'shortcut', id: 'wt', keys: 'Ctrl+S', name: 'save' });
  ap({ op: 'shortcut', id: 'wt', keys: 'Q', name: 'quit' });
  const evs = [];
  const w = R.renderWindow(doc, G.snapshot(S, 'wt'), (name, node, value) => evs.push([name, node, value]), () => {});
  assert.strictEqual(w.style.background, '#102030'); assert.strictEqual(w.style.color, '#eeeeee'); ok();
  assert.strictEqual(w.style.fontFamily, 'var(--gui-mono)'); assert.strictEqual(w.style.fontSize, '15px'); assert.strictEqual(w.style['--gui-radius'], '6px'); ok();
  assert.strictEqual(w.style['--gui-accent'], '#ffffcc'); ok();
  const b = byNode(w, 'b');
  assert.strictEqual(w.style['--gui-on-accent'], '#000000', 'dark text on a light accent'); assert.strictEqual(w.style['--gui-muted'], '#778899'); ok();
  assert.strictEqual(w.attrs['data-scheme'], 'dark'); assert.strictEqual(w.style['--gui-radius'], '6px'); ok();
  assert.strictEqual(R.textOn('#102030'), '#ffffff'); assert.strictEqual(R.textOn('#fff'), '#000000'); ok();
  // a real DOM's children is an array-like without forEach (HTMLCollection): the theme must still apply
  {
    const mk = (tag) => ({ tagName: tag, style: {}, className: '', _kids: [], get children() { return { length: this._kids.length, item: (i) => this._kids[i], 0: this._kids[0], 1: this._kids[1], 2: this._kids[2] }; } });
    const root = mk('div'); const b = mk('button'); root._kids.push(b);
    R.applyTheme(root, { palette: { bg: '#000000', accent: '#ffd400' } });
    assert.strictEqual(root.style['--gui-accent'], '#ffd400'); ok();
    R.applyTheme(root, {}); R.applyTheme(root, null); ok();
  }
  // no theme: nothing is touched
  const plain = R.renderWindow(doc, { id: 'p', title: 'P', width: 100, root: { id: 'root', kind: 'column', children: [] } }, () => {}, () => {});
  assert.strictEqual(plain.style.background, undefined); ok();

  // shortcuts
  const key = (o) => Object.assign({ target: { tagName: 'div' }, preventDefault() { this.stopped = true; } }, o);
  assert.strictEqual(R.shortcutKey({ key: 's', ctrlKey: true }), 'Ctrl+S');
  assert.strictEqual(R.shortcutKey({ key: 'Z', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Z');
  assert.strictEqual(R.shortcutKey({ key: 'z', metaKey: true, altKey: true }), 'Ctrl+Alt+Z');
  assert.strictEqual(R.shortcutKey({ key: 'Escape' }), 'Esc'); assert.strictEqual(R.shortcutKey({ key: ' ' }), 'Space');
  assert.strictEqual(R.shortcutKey({ key: 'ArrowLeft' }), 'Left'); assert.strictEqual(R.shortcutKey({ key: 'F5' }), 'F5');
  assert.strictEqual(R.shortcutKey({ key: 'Shift' }), null); ok();
  assert.strictEqual(w.attrs.tabindex, undefined); assert.strictEqual(w.tabIndex, -1, 'the window can take the keyboard'); ok();
  const e1 = key({ key: 's', ctrlKey: true });
  (w.listeners.keydown || []).forEach((fn) => fn(e1));
  assert.deepStrictEqual(evs[evs.length - 1], ['shortcut', 'root', 'save']); assert.strictEqual(e1.stopped, true); ok();
  const before = evs.length;
  (w.listeners.keydown || []).forEach((fn) => fn(key({ key: 'x', ctrlKey: true })));
  assert.strictEqual(evs.length, before, 'an unregistered key sends nothing'); ok();
  (w.listeners.keydown || []).forEach((fn) => fn(key({ key: 'q', target: { tagName: 'input' } })));
  assert.strictEqual(evs.length, before, 'a bare letter is typing in a text box'); ok();
  (w.listeners.keydown || []).forEach((fn) => fn(key({ key: 'q' })));
  assert.deepStrictEqual(evs[evs.length - 1], ['shortcut', 'root', 'quit']); ok();
  (w.listeners.keydown || []).forEach((fn) => fn(key({ key: 's', ctrlKey: true, target: { tagName: 'input' } })));
  assert.deepStrictEqual(evs[evs.length - 1], ['shortcut', 'root', 'save'], 'Ctrl+S works inside a text box'); ok();
}

// grid and scroll containers
{
  const S = G.createSession();
  const ap = (m) => { const r = G.apply(S, m); assert.ok(r.ok, r.error); };
  ap({ op: 'open', id: 'wg', title: 'G' });
  ap({ op: 'add', id: 'wg', node: { id: 'g1', kind: 'grid', columns: 3 } });
  ap({ op: 'add', id: 'wg', parent: 'g1', node: { id: 'l1', kind: 'label', text: 'a' } });
  ap({ op: 'add', id: 'wg', node: { id: 's1', kind: 'scroll', height: 120 } });
  ap({ op: 'add', id: 'wg', parent: 's1', node: { id: 'l2', kind: 'label', text: 'b' } });
  const w = R.renderWindow(doc, G.snapshot(S, 'wg'), () => {}, () => {});
  const g = byNode(w, 'g1'), sc = byNode(w, 's1');
  assert.strictEqual(g.style.display, 'grid'); assert.strictEqual(g.style.gridTemplateColumns, 'repeat(3, 1fr)'); ok();
  assert.strictEqual(g.children.length, 1); assert.strictEqual(g.children[0].textContent, 'a'); ok();
  assert.strictEqual(sc.style.overflow, 'auto'); assert.strictEqual(sc.style.maxHeight, '120px'); ok();
  assert.strictEqual(sc.children[0].textContent, 'b'); ok();
}

// tabs, split, menus
{
  El.prototype.insertBefore = function (c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) { this.children.push(c); } else { this.children.splice(i, 0, c); } return c; };
  Object.defineProperty(El.prototype, 'firstChild', { get() { return this.children[0] || null; } });
  const S = G.createSession();
  const ap = (m) => { const r = G.apply(S, m); assert.ok(r.ok, r.error); };
  ap({ op: 'open', id: 'wt', title: 'T' });
  ap({ op: 'add', id: 'wt', node: { id: 'tb', kind: 'tabs' } });
  ap({ op: 'add', id: 'wt', parent: 'tb', node: { id: 'p1', kind: 'tab', text: 'One' } });
  ap({ op: 'add', id: 'wt', parent: 'tb', node: { id: 'p2', kind: 'tab', text: 'Two' } });
  ap({ op: 'add', id: 'wt', parent: 'p1', node: { id: 'a', kind: 'label', text: 'A' } });
  ap({ op: 'add', id: 'wt', node: { id: 'sp', kind: 'split', direction: 'row', ratio: 30 } });
  ap({ op: 'add', id: 'wt', parent: 'sp', node: { id: 'l', kind: 'label', text: 'left' } });
  ap({ op: 'add', id: 'wt', parent: 'sp', node: { id: 'r', kind: 'label', text: 'right' } });
  ap({ op: 'add', id: 'wt', node: { id: 'mb', kind: 'menubar' } });
  ap({ op: 'add', id: 'wt', parent: 'mb', node: { id: 'mn', kind: 'menu', text: 'File' } });
  ap({ op: 'add', id: 'wt', parent: 'mn', node: { id: 'mi', kind: 'menuitem', text: 'Save', keys: 'Ctrl+S' } });
  const ev = [];
  const w = R.renderWindow(doc, G.snapshot(S, 'wt'), (name, node, value) => ev.push([name, node, value]), () => {});
  const tabs = byNode(w, 'tb');
  const bar = tabs.children[0];
  assert.strictEqual(bar.children.length, 2); assert.strictEqual(bar.children[0].textContent, 'One'); ok();
  assert.strictEqual(byNode(w, 'p1').hidden, false); assert.strictEqual(byNode(w, 'p2').hidden, true); ok();
  bar.children[1].fire('click');
  assert.strictEqual(byNode(w, 'p1').hidden, true); assert.strictEqual(byNode(w, 'p2').hidden, false); ok();
  assert.deepStrictEqual(ev[ev.length - 1], ['select', 'tb', 'p2']); ok();
  const sp = byNode(w, 'sp');
  assert.strictEqual(sp.style.display, 'flex'); assert.strictEqual(sp.children[0].style.flex, '0 0 30%'); assert.strictEqual(sp.children[1].style.flex, '1 1 0'); ok();
  const mi = byNode(w, 'mi');
  assert.strictEqual(mi.textContent, 'Save'); assert.strictEqual(find(mi, (e) => e.className === 'gui-keys').textContent, 'Ctrl+S'); mi.fire('click');
  assert.deepStrictEqual(ev[ev.length - 1], ['click', 'mi', undefined]); ok();
  assert.strictEqual(byNode(w, 'mn').children[0].textContent, 'File'); ok();
}

// grow, gap, pad, role: hints for the flex layout and the design system; the window's first height
{
  const S = G.createSession();
  const ap = (m) => { const r = G.apply(S, m); assert.ok(r.ok, r.error); };
  ap({ op: 'open', id: 'wl', title: 'L', width: 400, height: 300, resizable: true });
  ap({ op: 'add', id: 'wl', node: { id: 'page', kind: 'column', role: 'page' } });
  ap({ op: 'add', id: 'wl', parent: 'page', node: { id: 'bar', kind: 'row', role: 'toolbar', gap: 4, pad: 6 } });
  ap({ op: 'add', id: 'wl', parent: 'page', node: { id: 'main', kind: 'editor', value: 'x = 1', lang: 'python', grow: 2, numbers: false } });
  const w = R.renderWindow(doc, G.snapshot(S, 'wl'), () => {}, () => {});
  const main = byNode(w, 'main');
  assert.strictEqual(main.style.flex, '2 1 0%'); assert.strictEqual(main.attrs['data-grow'], '2'); assert.strictEqual(main.style.height, ''); ok();
  assert.ok(/gui-role-page/.test(byNode(w, 'page').className)); assert.ok(/gui-role-toolbar/.test(byNode(w, 'bar').className)); ok();
  assert.strictEqual(byNode(w, 'bar').style.gap, '4px'); assert.strictEqual(byNode(w, 'bar').style.padding, '6px'); ok();
  assert.ok(/gui-body/.test(w.children[1].className), 'the window body fills the window'); ok();
  assert.strictEqual(find(main, (e) => e.className === 'gui-ed-gutter'), null, 'numbers:false hides the gutter'); ok();
  assert.ok(R.GUI_CSS.indexOf('.gui-role-toolbar') > 0 && R.GUI_CSS.indexOf('data-scheme=dark') > 0); ok();
}

// syntax coloring: every line's tokens join back to its text; states carry multi-line constructs
{
  const T = R.tokenizeLine;
  const join = (r) => r.tokens.map((t) => t[1]).join('');
  const cls = (r, text) => (r.tokens.find((t) => t[1] === text) || [])[0];
  const samples = [
    ['python', 'def foo(x, y=3):  # note'], ['python', 'f"hello {name}" + \'a\''], ['javascript', 'const a = `t${1}` + /* c */ 5; // end'], ['json', '{"a": [1, 2.5e3, true, null], "b": "s"}'],
    ['markdown', '## Title'], ['markdown', '- item **bold** and `code` and [x](http://y)'], ['html', '<div class="a" id=b>text &amp; more</div>'], ['css', '.a:hover { color: #fff; margin: 4px 0 !important; }'], ['text', 'plain text'], ['', '']
  ];
  samples.forEach(([l, t]) => { assert.strictEqual(join(T(l, t, '')), t, l + ': ' + t); ok(); });
  assert.strictEqual(cls(T('python', 'def foo(x):', ''), 'def'), 'keyword'); assert.strictEqual(cls(T('python', 'def foo(x):', ''), 'foo'), 'fn'); ok();
  assert.strictEqual(cls(T('python', 'x = None', ''), 'None'), 'const'); assert.strictEqual(cls(T('python', 'x = 42', ''), '42'), 'number'); ok();
  assert.strictEqual(T('python', 's = """open', '').state, 'q3d'); assert.strictEqual(T('python', 'still inside', 'q3d').tokens[0][0], 'string'); assert.strictEqual(T('python', 'end""" + x', 'q3d').state, ''); ok();
  assert.strictEqual(T('javascript', 'a /* open', '').state, 'cmt'); assert.strictEqual(T('javascript', 'close */ b', 'cmt').state, ''); assert.strictEqual(T('javascript', 'x = `open', '').state, 'tpl'); ok();
  assert.strictEqual(cls(T('json', '{"k": "v"}', ''), '"k"'), 'key'); assert.strictEqual(cls(T('json', '{"k": "v"}', ''), '"v"'), 'string'); ok();
  assert.strictEqual(T('markdown', '```py', '').state, 'fence'); assert.strictEqual(T('markdown', 'code here', 'fence').tokens[0][0], 'code'); assert.strictEqual(T('markdown', '```', 'fence').state, ''); ok();
  assert.strictEqual(T('markdown', '# Hi', '').tokens[0][0], 'mark'); assert.strictEqual(T('markdown', '# Hi', '').tokens[1][0], 'heading'); ok();
  assert.strictEqual(cls(T('html', '<a href="x">', ''), 'a'), 'tag'); assert.strictEqual(cls(T('html', '<a href="x">', ''), 'href'), 'attr'); assert.strictEqual(T('html', '<!-- open', '').state, 'hcmt'); assert.strictEqual(T('html', '<div', '').state, 'tag'); ok();
  assert.strictEqual(cls(T('css', 'a { color: red; }', ''), 'color'), 'attr'); assert.strictEqual(T('css', '/* open', '').state, 'c'); assert.strictEqual(T('css', 'a {', '').state, '1'); ok();
  assert.strictEqual(T('python', 'x' .repeat(3000), '').tokens.length, 1, 'a very long line is left plain'); ok();
}


// patchNode: a set of plain props changes the one element in place; anything else says "rebuild" (false)
{
  const S = G.createSession();
  const ap = (m) => { const r = G.apply(S, m); assert.ok(r.ok, r.error); };
  ap({ op: 'open', id: 'wp', title: 'P' });
  ap({ op: 'add', id: 'wp', node: { id: 'lb', kind: 'label', text: 'a' } });
  ap({ op: 'add', id: 'wp', node: { id: 'en', kind: 'entry', value: '' } });
  ap({ op: 'add', id: 'wp', node: { id: 'bt', kind: 'button', text: 'Go', icon: '+' } });
  ap({ op: 'add', id: 'wp', node: { id: 'pg', kind: 'progress', value: 1, max: 10 } });
  const w = R.renderWindow(doc, G.snapshot(S, 'wp'), () => {}, () => {});
  const node = (id) => G.snapshot(S, 'wp').root.children.find((c) => c.id === id);
  assert.strictEqual(R.patchNode(byNode(w, 'lb'), Object.assign({}, node('lb'), { text: 'b' }), { text: 'b' }), true); assert.strictEqual(byNode(w, 'lb').textContent, 'b'); ok();
  assert.strictEqual(R.patchNode(byNode(w, 'en'), Object.assign({}, node('en'), { value: 'hi' }), { value: 'hi' }), true); assert.strictEqual(byNode(w, 'en').value, 'hi'); ok();
  assert.strictEqual(R.patchNode(byNode(w, 'bt'), Object.assign({}, node('bt'), { text: 'Stop' }), { text: 'Stop' }), true);
  assert.strictEqual(byNode(w, 'bt').children[1].textContent, 'Stop'); assert.strictEqual(byNode(w, 'bt').children[0].textContent, '+', 'the icon stays'); ok();
  assert.strictEqual(R.patchNode(byNode(w, 'bt'), Object.assign({}, node('bt'), { enabled: false }), { enabled: false }), true); assert.strictEqual(byNode(w, 'bt').disabled, true); ok();
  assert.strictEqual(R.patchNode(byNode(w, 'pg'), Object.assign({}, node('pg'), { value: 5 }), { value: 5 }), true); assert.strictEqual(byNode(w, 'pg').value, 5); ok();
  assert.strictEqual(R.patchNode(byNode(w, 'lb'), node('lb'), { visible: false }), true); ok();
  assert.strictEqual(R.patchNode(byNode(w, 'lb'), node('lb'), { grow: 1 }), false, 'a layout prop needs a rebuild'); ok();
  assert.strictEqual(R.patchNode(byNode(w, 'bt'), node('bt'), { icon: 'x' }), false); ok();
}

// markdown view: real elements, no markup from the text; editor wrap
{
  const S = G.createSession();
  const ap = (m) => { const r = G.apply(S, m); assert.ok(r.ok, r.error); };
  ap({ op: 'open', id: 'wm', title: 'M' });
  const MD = ['# Title', '', 'some **bold** and *it* `c` [l](u)', '', '- a', '- b', '', '> q', '', '```', 'code <b>x</b>', '```', '', '---'].join(String.fromCharCode(10));
  ap({ op: 'add', id: 'wm', node: { id: 'md', kind: 'markdown', value: MD } });
  ap({ op: 'add', id: 'wm', node: { id: 'ed', kind: 'editor', value: 'x', wrap: true } });
  const w = R.renderWindow(doc, G.snapshot(S, 'wm'), () => {}, () => {});
  const md = byNode(w, 'md');
  const tags = md.children.map((c) => c.tagName);
  assert.deepStrictEqual(tags, ['h1', 'p', 'ul', 'blockquote', 'pre', 'hr']); ok();
  assert.strictEqual(md.children[0].children[0].textContent, 'Title'); ok();
  const para = md.children[1].children.map((c) => c.tagName);
  assert.ok(para.indexOf('strong') >= 0 && para.indexOf('em') >= 0 && para.indexOf('code') >= 0); ok();
  assert.strictEqual(md.children[2].children.length, 2); ok();
  assert.strictEqual(md.children[4].children[0].textContent, 'code <b>x</b>'); ok();
  assert.ok(/gui-editor-wrap/.test(byNode(w, 'ed').className)); ok();
  assert.strictEqual(find(byNode(w, 'ed'), (e) => e.className === 'gui-ed-gutter'), null); ok();
  assert.strictEqual(violations.length, 0); ok();
}

// split with weights: three children take the space in the proportions 22 : 44 : 34
{
  const S3 = G.createSession();
  const ap3 = (m) => { const r = G.apply(S3, m); assert.ok(r.ok, r.error); };
  ap3({ op: 'open', id: 'wx', title: 'X' });
  ap3({ op: 'add', id: 'wx', node: { id: 'sp', kind: 'split', direction: 'row', weights: [22, 44, 34] } });
  ap3({ op: 'add', id: 'wx', parent: 'sp', node: { id: 'a', kind: 'label', text: 'a' } });
  ap3({ op: 'add', id: 'wx', parent: 'sp', node: { id: 'b', kind: 'label', text: 'b' } });
  ap3({ op: 'add', id: 'wx', parent: 'sp', node: { id: 'c', kind: 'label', text: 'c' } });
  const w3 = R.renderWindow(doc, G.snapshot(S3, 'wx'), () => {}, () => {});
  const sp = byNode(w3, 'sp');
  assert.strictEqual(sp.children.length, 3); ok();
  assert.deepStrictEqual(sp.children.map((c) => c.style.flex), ['22 1 0%', '44 1 0%', '34 1 0%']); ok();
}

// tree: folding hides the deeper rows below a folded row (display), a click on the arrow sends toggle and a click on a row sends select
{
  const S4 = G.createSession();
  const ap4 = (m) => { const r = G.apply(S4, m); assert.ok(r.ok, r.error); };
  ap4({ op: 'open', id: 'wtr', title: 'T' });
  ap4({ op: 'add', id: 'wtr', node: { id: 'tr', kind: 'tree', columns: [{ title: 'Name' }, { title: 'Result', align: 'right' }], selected: 'b',
    rows: [
      { id: 'a', depth: 0, cells: ['suite', 'ok'], tones: [null, 'pass'], expanded: true },
      { id: 'b', depth: 1, cells: ['case 1', 'fail'], tones: [null, 'fail'], bold: true },
      { id: 'c', depth: 0, cells: ['other', '-'], expanded: true },
      { id: 'd', depth: 1, cells: ['child', 'x'] }
    ] } });
  const got = [];
  const w4 = R.renderWindow(doc, G.snapshot(S4, 'wtr'), (name, node, value) => got.push([name, node, value]), () => {});
  const tree = byNode(w4, 'tr');
  const body = find(tree, (e) => e.tagName === 'tbody');
  const trs = body.children;
  assert.strictEqual(trs.length, 4); ok();
  assert.ok(trs[1].className.indexOf('gui-tree-sel') >= 0 && trs[1].className.indexOf('gui-tree-bold') >= 0); ok();
  assert.strictEqual(trs[0].children[0].style.paddingLeft, '10px'); assert.strictEqual(trs[1].children[0].style.paddingLeft, '26px'); ok();
  assert.strictEqual(trs[1].children[1].style.textAlign, 'right'); ok();
  const arrowA = find(trs[0].children[0], (e) => e.className === 'gui-tree-arrow');
  assert.strictEqual(arrowA.textContent, '▾'); ok();
  arrowA.fire('click');
  assert.strictEqual(arrowA.textContent, '▸'); ok();
  // b is a child of a (hidden now); d is a child of c, which is open, so d stays shown
  assert.strictEqual(trs[1].style.display, 'none'); assert.strictEqual(trs[3].style.display, ''); assert.strictEqual(trs[2].style.display, ''); ok();
  assert.deepStrictEqual(got[got.length - 1], ['toggle', 'tr', 'a']); ok();
  trs[2].fire('click');
  assert.deepStrictEqual(got[got.length - 1], ['select', 'tr', 'c']); ok();
  assert.ok(trs[2].className.indexOf('gui-tree-sel') >= 0 && trs[1].className.indexOf('gui-tree-sel') < 0); ok();
  arrowA.fire('click');
  assert.strictEqual(trs[1].style.display, ''); ok();
}

// doc: blocks become elements with their text (never markup), badges and tones, tables, kv highlight, and a ref block click sends ref
{
  const S5 = G.createSession();
  const ap5 = (m) => { const r = G.apply(S5, m); assert.ok(r.ok, r.error); };
  ap5({ op: 'open', id: 'wdr', title: 'D' });
  ap5({ op: 'add', id: 'wdr', node: { id: 'dd', kind: 'doc', blocks: [
    { t: 'title', text: '<b>Run</b>', badge: 'FAIL', tone: 'fail' },
    { t: 'list', items: ['cause'], tone: 'warn' },
    { t: 'table', columns: ['#', 'Result'], rows: [['1', 'PASS']] },
    { t: 'kv', rows: [['Key', 'Value', true, true]] },
    { t: 'ref', text: 'case 1', ref: 'c1' }
  ] } });
  const got5 = [];
  const w5 = R.renderWindow(doc, G.snapshot(S5, 'wdr'), (name, node, value) => got5.push([name, node, value]), () => {});
  const d = byNode(w5, 'dd');
  assert.ok(d.className.indexOf('gui-doc') >= 0); ok();
  const title = d.children[0];
  assert.strictEqual(title.textContent, '<b>Run</b>'); assert.ok(title.className.indexOf('gui-tone-fail') >= 0); ok();
  assert.strictEqual(find(title, (e) => e.className && e.className.indexOf('gui-doc-badge') >= 0).textContent, 'FAIL'); ok();
  assert.strictEqual(find(d.children[1], (e) => e.tagName === 'li').textContent, 'cause'); ok();
  assert.strictEqual(find(d.children[2], (e) => e.tagName === 'td').textContent, '1'); ok();
  const kvv = find(d.children[3], (e) => e.className && e.className.indexOf('gui-doc-v') >= 0);
  assert.ok(kvv.className.indexOf('gui-doc-hl') >= 0 && kvv.className.indexOf('gui-doc-mono') >= 0); ok();
  const link = d.children[4];
  link.fire('click');
  assert.deepStrictEqual(got5[got5.length - 1], ['ref', 'dd', 'c1']); ok();
  assert.strictEqual(violations.length, 0); ok();
}

// filepick: a button that sends pick (no value) when pressed
{
  const S6 = G.createSession();
  G.apply(S6, { op: 'open', id: 'wfp', title: 'P' });
  G.apply(S6, { op: 'add', id: 'wfp', node: { id: 'fp', kind: 'filepick', text: 'Open files' } });
  const got6 = [];
  const w6 = R.renderWindow(doc, G.snapshot(S6, 'wfp'), (name, node, value) => got6.push([name, node, value]), () => {});
  const btn = byNode(w6, 'fp');
  assert.strictEqual(btn.tagName, 'button'); assert.strictEqual(btn.textContent, 'Open files'); ok();
  btn.fire('click');
  assert.deepStrictEqual(got6[got6.length - 1], ['pick', 'fp', undefined]); ok();
}

// paintFrame: a flipped picture mirrors inside its box; paintGl: buffers and programs are made once per version, commands run in order
{
  const log = [];
  const ctx = new Proxy({}, { get: (t, k) => (k === 'fillStyle' || k === 'strokeStyle' ? '' : (...a) => log.push([k, ...a])), set: () => true });
  R.paintFrame(ctx, [['image', 'p', 10, 20, 30, 40, 1, 0]], 100, 100, () => ({}));
  assert.deepStrictEqual(log.filter((l) => ['translate', 'scale', 'drawImage'].includes(l[0])).map((l) => l[0] + ':' + l.slice(1).filter((x) => typeof x === 'number').join(',')), ['translate:40,20', 'scale:-1,1', 'drawImage:0,0,30,40']); ok();
  const calls = [];
  const gl = new Proxy({ COMPILE_STATUS: 1, LINK_STATUS: 2, ARRAY_BUFFER: 3, ELEMENT_ARRAY_BUFFER: 4, TRIANGLES: 5, POINTS: 6, LINES: 7, LINE_STRIP: 8, TRIANGLE_STRIP: 9, FLOAT: 10,
    UNSIGNED_SHORT: 11, UNSIGNED_INT: 12, DEPTH_TEST: 13, BLEND: 14, CULL_FACE: 15, DYNAMIC_DRAW: 16, VERTEX_SHADER: 17, FRAGMENT_SHADER: 18, COLOR_BUFFER_BIT: 1, DEPTH_BUFFER_BIT: 2 }, {
    get: (t, k) => (k in t ? t[k] : (...a) => { calls.push(String(k)); return /^get(Shader|Program)Parameter$/.test(k) ? true : /^(getUniformLocation)$/.test(k) ? { u: a[1] } : k === 'getAttribLocation' ? 0 : {}; }) });
  const el = { width: 64, height: 48, getContext: (t) => (t === 'webgl2' ? gl : null) };
  const b64 = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64');
  const node = { glbufs: { tri: { type: 'f32', data: b64, v: 1 } }, glprogs: { flat: { vs: '#version 300 es\nx', fs: '#version 300 es\ny', v: 1 } },
    glframe: [['clear', 0, 0, 0, 1], ['use', 'flat'], ['uf', 'mvp', 1, 2, 3, 4], ['attr', 'pos', 'tri', 3, 12, 0], ['draw', 'triangles', 0, 3, 1]] };
  const errs = [];
  R.paintGl(el, node, (m) => errs.push(m));
  assert.deepStrictEqual(errs, []); ok();
  const first = calls.slice();
  assert.ok(first.indexOf('bufferData') >= 0 && first.indexOf('linkProgram') >= 0 && first.indexOf('drawArraysInstanced') > first.indexOf('vertexAttribPointer')); ok();
  calls.length = 0; R.paintGl(el, node, (m) => errs.push(m));   // same versions: no new upload, no recompile
  assert.ok(calls.indexOf('bufferData') < 0 && calls.indexOf('linkProgram') < 0 && calls.indexOf('drawArraysInstanced') >= 0); ok();
  calls.length = 0; node.glbufs.tri.v = 2; R.paintGl(el, node, (m) => errs.push(m));   // a changed version uploads again
  assert.ok(calls.indexOf('bufferData') >= 0 && calls.indexOf('linkProgram') < 0); ok();
  // additive blending: enable BLEND with (SRC_ALPHA, ONE); switching it off disables BLEND
  calls.length = 0; const nodeA = { glbufs: {}, glprogs: node.glprogs, glframe: [['state', 'additive', 1], ['state', 'additive', 0]] };
  R.paintGl(el, nodeA, (m) => errs.push(m));
  assert.ok(calls.indexOf('enable') >= 0 && calls.indexOf('blendFunc') > calls.indexOf('enable') && calls.indexOf('disable') > calls.indexOf('blendFunc')); ok();
  // an index buffer is used by the next draw only: a mesh followed by plain lines draws indexed first, then arrays
  calls.length = 0;
  const node2 = { glbufs: { tri: { type: 'f32', data: b64, v: 2 }, ix: { type: 'u16', data: Buffer.from(new Uint16Array([0, 1, 2]).buffer).toString('base64'), v: 1 } }, glprogs: node.glprogs,
    glframe: [['use', 'flat'], ['attr', 'pos', 'tri', 3, 12, 0], ['index', 'ix'], ['draw', 'triangles', 0, 3, 1], ['draw', 'lines', 0, 2, 1]] };
  R.paintGl(el, node2, (m) => errs.push(m));
  const di = calls.indexOf('drawElementsInstanced'), da = calls.indexOf('drawArraysInstanced');
  assert.ok(di >= 0 && da > di); ok();
  // no WebGL2: one report, no throw
  const e2 = { width: 8, height: 8, getContext: () => null }, errs2 = [];
  R.paintGl(e2, node, (m) => errs2.push(m)); R.paintGl(e2, node, (m) => errs2.push(m));
  assert.deepStrictEqual(errs2, ['WebGL2 is not available']); ok();
}

// a transparent canvas starts each frame with clearRect; an ordinary one starts black
{
  const log = [];
  const ctx = new Proxy({}, { get: (t, k) => (k === 'fillStyle' || k === 'strokeStyle' ? '' : (...a) => log.push([k, ...a])), set: () => true });
  R.paintFrame(ctx, [], 10, 10, null, true);
  assert.deepStrictEqual(log.map((l) => l[0]), ['clearRect']); ok();
  log.length = 0; R.paintFrame(ctx, [], 10, 10, null, false);
  assert.deepStrictEqual(log.map((l) => l[0]), ['fillRect']); ok();
  // a stack renders its children in order inside one element with the stack class
  const S2 = G.createSession();
  G.apply(S2, { op: 'open', id: 'wz', title: 'Z' });
  G.apply(S2, { op: 'add', id: 'wz', node: { id: 'st', kind: 'stack' } });
  G.apply(S2, { op: 'add', id: 'wz', parent: 'st', node: { id: 'a', kind: 'canvas', width: 20, height: 20 } });
  G.apply(S2, { op: 'add', id: 'wz', parent: 'st', node: { id: 'b', kind: 'canvas', width: 20, height: 20, transparent: true } });
  const ctx2 = new Proxy({}, { get: (t, k) => (k === 'fillStyle' || k === 'strokeStyle' ? '' : () => {}), set: () => true });
  El.prototype.getContext = () => ctx2;     // the fake elements need a 2D context to paint a canvas
  const view = R.renderWindow(doc, G.snapshot(S2, 'wz'), () => {}, () => {});
  delete El.prototype.getContext;
  const st = byNode(view, 'st');
  assert.ok(st && /gui-stack/.test(st.className)); ok();
  assert.deepStrictEqual(st.children.map((c) => c.attrs['data-node']), ['a', 'b']); ok();
  assert.ok(/gui-canvas-clear/.test(byNode(view, 'b').className) && !/gui-canvas-clear/.test(byNode(view, 'a').className)); ok();
}


// extern: a picture the host supplies (another API's canvas) is uploaded and drawn over the whole canvas; no source means nothing is drawn
{
  const calls = [];
  const gl = new Proxy({ COMPILE_STATUS: 1, LINK_STATUS: 2, TRIANGLES: 5, DEPTH_TEST: 13, BLEND: 14, CULL_FACE: 15, VERTEX_SHADER: 17, FRAGMENT_SHADER: 18, COLOR_BUFFER_BIT: 1, DEPTH_BUFFER_BIT: 2, TEXTURE0: 30, TEXTURE_2D: 31, RGBA: 32, UNSIGNED_BYTE: 33, UNPACK_FLIP_Y_WEBGL: 34 }, {
    get: (t, k) => (k in t ? t[k] : (...a) => { calls.push(String(k)); return /^get(Shader|Program)Parameter$/.test(k) ? true : k === 'isEnabled' ? false : {}; }),
  });
  const el = { width: 64, height: 48, getContext: (t) => (t === 'webgl2' ? gl : null) };
  const node = { glbufs: {}, glprogs: {}, glframe: [['clear', 0, 0, 0, 1], ['extern', 'clpts']] };
  const errs = [], src = { fake: 'offscreen canvas' };
  R.paintGl(el, node, (m) => errs.push(m), (name) => (name === 'clpts' ? src : null));
  assert.deepStrictEqual(errs, []); ok();
  assert.ok(calls.indexOf('texImage2D') >= 0 && calls.lastIndexOf('drawArrays') > calls.indexOf('texImage2D')); ok();
  calls.length = 0; R.paintGl(el, node, (m) => errs.push(m), () => null);
  assert.ok(calls.indexOf('texImage2D') < 0 && calls.indexOf('drawArrays') < 0); ok();
  calls.length = 0; R.paintGl(el, node, (m) => errs.push(m));   // no lookup at all
  assert.ok(calls.indexOf('texImage2D') < 0); ok();
}
console.log('gui_render: ' + n + ' assertions passed');
