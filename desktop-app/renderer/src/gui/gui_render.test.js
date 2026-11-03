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

const events = [];
let closed = 0;
const win = R.renderWindow(doc, G.snapshot(s, 'w'), (name, node, value) => events.push([name, node, value]), () => { closed++; });

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
assert.strictEqual(tbl.className, 'gui-table'); ok();
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
const ed = byNode(win2, 'ed');
assert.strictEqual(ed.tagName, 'textarea'); assert.strictEqual(ed.className, 'gui-editor'); ok();
assert.strictEqual(ed.spellcheck, false); assert.strictEqual(ed.rows, 6); assert.strictEqual(ed.value, 'if x:\n\tpass'); ok();
let prevented = 0;
ed.value = 'ab'; ed.selectionStart = 1; ed.selectionEnd = 1;
ed.listeners.keydown[0]({ key: 'Tab', shiftKey: false, preventDefault() { prevented++; } });
assert.strictEqual(ed.value, 'a  b'); assert.strictEqual(ed.selectionStart, 3); assert.strictEqual(prevented, 1); ok();
assert.deepStrictEqual(events2[2], ['input', 'ed', 'a  b']); ok();
ed.listeners.keydown[0]({ key: 'Tab', shiftKey: true, preventDefault() { prevented++; } });
assert.strictEqual(prevented, 1); assert.strictEqual(ed.value, 'a  b'); ok();
ed.value = 'typed'; ed.fire('input');
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

console.log('gui_render: ' + n + ' assertions passed');
