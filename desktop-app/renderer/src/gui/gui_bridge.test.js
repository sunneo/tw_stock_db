// node renderer/src/gui/gui_bridge.test.js -- the GUI bridge protocol core (parse, validate, apply, events) with no DOM
const assert = require('assert');
const G = require('./gui_bridge.js');
let n = 0; const ok = () => { n++; };
const msg = (o) => G.PREFIX + JSON.stringify(Object.assign({ v: 1 }, o));
const run = (s, line) => { const p = G.parseLine(line); assert.ok(p && p.msg, 'parse failed: ' + line); return G.apply(s, p.msg); };

// 1. ordinary program output is not a GUI message
assert.strictEqual(G.parseLine('hello world'), null); ok();
assert.strictEqual(G.parseLine(''), null); ok();

// 2. broken GUI lines are reported, not applied
assert.ok(G.parseLine(G.PREFIX + '{not json}').error); ok();
assert.ok(G.parseLine(G.PREFIX + JSON.stringify({ v: 2, op: 'open', id: 'w' })).error); ok();
assert.ok(G.parseLine(G.PREFIX + JSON.stringify({ v: 1, op: 'exec', id: 'w' })).error); ok();
assert.ok(G.parseLine(G.PREFIX + 'x'.repeat(G.LIMITS.MAX_LINE)).error); ok();

// 3. open / add / set / remove / close happy path, and the snapshot a renderer reads
const s = G.createSession();
assert.deepStrictEqual(run(s, msg({ op: 'open', id: 'w1', title: 'Hello', width: 300 })), { ok: true }); ok();
assert.deepStrictEqual(run(s, msg({ op: 'add', id: 'w1', node: { id: 'lbl', kind: 'label', text: 'Name?' } })), { ok: true }); ok();
assert.deepStrictEqual(run(s, msg({ op: 'add', id: 'w1', node: { id: 'row', kind: 'row' } })), { ok: true }); ok();
assert.deepStrictEqual(run(s, msg({ op: 'add', id: 'w1', parent: 'row', node: { id: 'e1', kind: 'entry', value: '', placeholder: 'type' } })), { ok: true }); ok();
assert.deepStrictEqual(run(s, msg({ op: 'add', id: 'w1', parent: 'row', node: { id: 'b1', kind: 'button', text: 'OK' } })), { ok: true }); ok();
let snap = G.snapshot(s, 'w1');
assert.strictEqual(snap.title, 'Hello'); assert.strictEqual(snap.width, 300); ok();
assert.deepStrictEqual(snap.root.children.map((c) => c.id), ['lbl', 'row']); ok();
assert.deepStrictEqual(snap.root.children[1].children.map((c) => c.id), ['e1', 'b1']); ok();
assert.deepStrictEqual(run(s, msg({ op: 'set', id: 'w1', node: 'b1', props: { text: 'Done', enabled: false } })), { ok: true }); ok();
snap = G.snapshot(s, 'w1');
assert.strictEqual(snap.root.children[1].children[1].text, 'Done'); assert.strictEqual(snap.root.children[1].children[1].enabled, false); ok();
assert.deepStrictEqual(run(s, msg({ op: 'remove', id: 'w1', node: 'row' })), { ok: true }); ok();
assert.deepStrictEqual(snap.root.children.map((c) => c.id), ['lbl', 'row']); // the earlier snapshot is a copy, not a live view
assert.deepStrictEqual(G.snapshot(s, 'w1').root.children.map((c) => c.id), ['lbl']); ok();
assert.strictEqual(s.windows.w1.nodes.e1, undefined); ok(); // descendants of a removed node are gone too
assert.deepStrictEqual(run(s, msg({ op: 'close', id: 'w1' })), { ok: true }); ok();
assert.strictEqual(G.snapshot(s, 'w1'), null); ok();

// 4. rejected messages: each one returns ok:false with a reason, never throws, never changes the session
const t = G.createSession();
run(t, msg({ op: 'open', id: 'w' }));
run(t, msg({ op: 'add', id: 'w', node: { id: 'b', kind: 'button', text: 'x' } }));
const before = JSON.stringify(G.snapshot(t, 'w'));
const bad = [
  [{ op: 'open', id: 'w' }, /already open/],
  [{ op: 'open', id: 'bad id!' }, /letters, digits/],
  [{ op: 'open', id: 'x', width: 5000 }, /width must be a number/],
  [{ op: 'add', id: 'nope', node: { id: 'a', kind: 'label' } }, /not open/],
  [{ op: 'add', id: 'w', node: { id: 'a', kind: 'iframe' } }, /kind "iframe" is not supported/],
  [{ op: 'add', id: 'w', node: { id: 'a', kind: 'label', html: '<b>x</b>' } }, /prop "html" is not allowed/],
  [{ op: 'add', id: 'w', node: { id: 'a', kind: 'label', text: '<img src=x onerror=alert(1)>' } }, null],
  [{ op: 'add', id: 'w', node: { id: 'b', kind: 'label' } }, /already exists/],
  [{ op: 'add', id: 'w', parent: 'b', node: { id: 'c', kind: 'label' } }, /not a container/],
  [{ op: 'add', id: 'w', parent: 'ghost', node: { id: 'c', kind: 'label' } }, /does not exist/],
  [{ op: 'add', id: 'w', node: { id: 'root', kind: 'label' } }, /reserved/],
  [{ op: 'set', id: 'w', node: 'b', props: { checked: true } }, /prop "checked" is not allowed on button/],
  [{ op: 'set', id: 'w', node: 'b', props: 'text' }, /props must be an object/],
  [{ op: 'remove', id: 'w', node: 'root' }, /does not exist/],
  [{ op: 'add', id: 'w', node: { id: 'p', kind: 'progress', value: 'high' } }, /value must be a number/]
];
bad.forEach(([m, re]) => {
  const r = G.apply(t, m);
  if (re === null) { assert.strictEqual(r.ok, true, 'escaped text must be accepted as plain text'); ok(); return; }
  assert.strictEqual(r.ok, false, 'should be rejected: ' + JSON.stringify(m)); assert.match(r.error, re); ok();
});
assert.strictEqual(G.snapshot(t, 'w').root.children.find((c) => c.id === 'a').text, '<img src=x onerror=alert(1)>'); ok();
// the escaped text stays data; only the rejected ones left no trace
assert.ok(JSON.stringify(G.snapshot(t, 'w')).indexOf(before.slice(0, 20)) >= 0); ok();

// 5. limits
const L = G.createSession();
for (let i = 0; i < G.LIMITS.MAX_WINDOWS; i++) { assert.ok(G.apply(L, { op: 'open', id: 'w' + i }).ok); ok(); }
assert.match(G.apply(L, { op: 'open', id: 'extra' }).error, /at most 4 windows/); ok();
assert.match(G.apply(L, { op: 'add', id: 'w0', node: { id: 'big', kind: 'label', text: 'x'.repeat(G.LIMITS.MAX_TEXT + 1) } }).error, /longer than/); ok();
assert.match(G.apply(L, { op: 'add', id: 'w0', node: { id: 'l', kind: 'list', items: new Array(G.LIMITS.MAX_ITEMS + 1).fill('a') } }).error, /at most 500/); ok();
for (let i = 0; i < G.LIMITS.MAX_NODES - 1; i++) { assert.ok(G.apply(L, { op: 'add', id: 'w1', node: { id: 'n' + i, kind: 'label' } }).ok); }
assert.match(G.apply(L, { op: 'add', id: 'w1', node: { id: 'over', kind: 'label' } }).error, /at most 200 nodes/); ok();
let deep = G.createSession(); G.apply(deep, { op: 'open', id: 'd' }); let parent = 'root';
for (let i = 0; i < G.LIMITS.MAX_DEPTH; i++) { assert.ok(G.apply(deep, { op: 'add', id: 'd', parent: parent, node: { id: 'c' + i, kind: 'column' } }).ok); parent = 'c' + i; ok(); }
assert.match(G.apply(deep, { op: 'add', id: 'd', parent: parent, node: { id: 'too', kind: 'column' } }).error, /nesting deeper/); ok();

// 6. events: only the event a kind declares, and the value is text (checkbox: boolean)
const E = G.createSession();
G.apply(E, { op: 'open', id: 'e' });
G.apply(E, { op: 'add', id: 'e', node: { id: 'b', kind: 'button', text: 'Go' } });
G.apply(E, { op: 'add', id: 'e', node: { id: 'k', kind: 'checkbox', text: 'Keep' } });
G.apply(E, { op: 'add', id: 'e', node: { id: 'x', kind: 'entry' } });
assert.deepStrictEqual(JSON.parse(G.eventLine(E, 'e', 'b', 'click')), { v: 1, event: 'click', id: 'e', node: 'b' }); ok();
assert.strictEqual(G.eventLine(E, 'e', 'b', 'input', 'x'), null); ok();
assert.strictEqual(JSON.parse(G.eventLine(E, 'e', 'k', 'change', 1)).value, true); ok();
assert.strictEqual(JSON.parse(G.eventLine(E, 'e', 'x', 'input', 'hi')).value, 'hi'); ok();
assert.strictEqual(G.eventLine(E, 'e', 'ghost', 'click'), null); ok();
assert.strictEqual(G.eventLine(E, 'gone', 'b', 'click'), null); ok();

// 7. shell side: `gui wait <window-id> [VAR]` argument parsing
assert.deepStrictEqual(G.parseWait('wait w1 ANS'), { ok: true, win: 'w1', varName: 'ANS' }); ok();
assert.deepStrictEqual(G.parseWait('  wait  w1  '), { ok: true, win: 'w1', varName: null }); ok();
assert.strictEqual(G.parseWait('ask w1').ok, false); ok();
assert.strictEqual(G.parseWait('wait').ok, false); ok();
assert.strictEqual(G.parseWait('wait w1 ANS extra').ok, false); ok();
assert.match(G.parseWait('wait bad!id').error, /window id/); ok();
assert.match(G.parseWait('wait w1 1ANS').error, /shell variable name/); ok();
assert.match(G.parseWait('wait w1 a=b').error, /shell variable name/); ok();

// theme, shortcut, tone (window-level look, keys and beeps)
{
  const S = G.createSession();
  run(S, msg({ op: 'open', id: 'wt', title: 'T' }));
  assert.deepStrictEqual(G.snapshot(S, 'wt').theme, {}); assert.deepStrictEqual(G.snapshot(S, 'wt').shortcuts, {}); ok();
  assert.deepStrictEqual(run(S, msg({ op: 'theme', id: 'wt', palette: { bg: '#112233', accent: '#4aa' }, font: 'monospace', size: 14, radius: 4 })), { ok: true }); ok();
  assert.deepStrictEqual(G.snapshot(S, 'wt').theme, { palette: { bg: '#112233', accent: '#4aa' }, font: 'monospace', size: 14, radius: 4 }); ok();
  run(S, msg({ op: 'theme', id: 'wt', palette: { fg: '#eee' } }));
  assert.deepStrictEqual(G.snapshot(S, 'wt').theme.palette, { bg: '#112233', accent: '#4aa', fg: '#eee' }, 'palette merges, size stays'); assert.strictEqual(G.snapshot(S, 'wt').theme.size, 14); ok();
  assert.match(run(S, msg({ op: 'theme', id: 'wt', palette: { bg: 'red' } })).error, /palette\.bg/); ok();
  assert.match(run(S, msg({ op: 'theme', id: 'wt', palette: { sky: '#fff' } })).error, /not supported/); ok();
  assert.match(run(S, msg({ op: 'theme', id: 'wt', font: 'comic' })).error, /font must/); ok();
  assert.match(run(S, msg({ op: 'theme', id: 'wt', size: 99 })).error, /size must/); ok();
  assert.strictEqual(G.snapshot(S, 'wt').theme.size, 14, 'a refused theme changes nothing'); ok();

  assert.deepStrictEqual(run(S, msg({ op: 'shortcut', id: 'wt', keys: 'Ctrl+S', name: 'save' })), { ok: true }); ok();
  run(S, msg({ op: 'shortcut', id: 'wt', keys: 'Ctrl+Shift+Z', name: 'redo' }));
  run(S, msg({ op: 'shortcut', id: 'wt', keys: 'F5', name: 'run' }));
  assert.deepStrictEqual(G.snapshot(S, 'wt').shortcuts, { 'Ctrl+S': 'save', 'Ctrl+Shift+Z': 'redo', F5: 'run' }); ok();
  assert.match(run(S, msg({ op: 'shortcut', id: 'wt', keys: 'Ctrl+Ctrl', name: 'x' })).error, /keys must/); ok();
  assert.match(run(S, msg({ op: 'shortcut', id: 'wt', keys: 'S', name: 'bad name' })).error, /name must/); ok();
  assert.match(run(S, msg({ op: 'shortcut', id: 'wt', keys: 'Shift+Ctrl+S', name: 'x' })).error, /keys must/, 'modifier order is fixed'); ok();
  run(S, msg({ op: 'shortcut', id: 'wt', keys: 'F5', name: null }));
  assert.strictEqual(G.snapshot(S, 'wt').shortcuts.F5, undefined); ok();
  for (let i = 0; i < 40; i++) { run(S, msg({ op: 'shortcut', id: 'wt', keys: (i < 36 ? 'Alt+' : 'Ctrl+Alt+') + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[i % 36], name: 'n' + i })); }
  assert.match(run(S, msg({ op: 'shortcut', id: 'wt', keys: 'Ctrl+Alt+Q', name: 'more' })).error || '', /at most 40/); ok();

  // the event: only for a registered name, on the window ("root")
  assert.deepStrictEqual(JSON.parse(G.eventLine(S, 'wt', 'root', 'shortcut', 'save')), { v: 1, event: 'shortcut', id: 'wt', node: 'root', value: 'save' }); ok();
  assert.strictEqual(G.eventLine(S, 'wt', 'root', 'shortcut', 'unknown'), null); ok();
  assert.strictEqual(G.eventLine(S, 'wt', 'n1', 'shortcut', 'save'), null); ok();
  assert.strictEqual(G.eventLine(S, 'wt', 'root', 'shortcut', 5), null); ok();

  assert.deepStrictEqual(run(S, msg({ op: 'tone', id: 'wt', freq: 440, ms: 120, wave: 'square' })), { ok: true }); ok();
  assert.deepStrictEqual(run(S, msg({ op: 'tone', id: 'wt', freq: 440, ms: 120 })), { ok: true }); ok();
  assert.match(run(S, msg({ op: 'tone', id: 'wt', freq: 10, ms: 120 })).error, /freq/); ok();
  assert.match(run(S, msg({ op: 'tone', id: 'wt', freq: 440, ms: 99999 })).error, /ms/); ok();
  assert.match(run(S, msg({ op: 'tone', id: 'wt', freq: 440, ms: 100, wave: 'noise' })).error, /wave/); ok();
  assert.match(run(S, msg({ op: 'tone', id: 'nope', freq: 440, ms: 100 })).error, /not open/); ok();
  assert.ok(G.OPS.indexOf('theme') >= 0 && G.OPS.indexOf('shortcut') >= 0 && G.OPS.indexOf('tone') >= 0); ok();
}

// grid and scroll containers
{
  const S = G.createSession();
  run(S, msg({ op: 'open', id: 'wg', title: 'G' }));
  assert.deepStrictEqual(run(S, msg({ op: 'add', id: 'wg', node: { id: 'g1', kind: 'grid', columns: 3 } })), { ok: true }); ok();
  assert.deepStrictEqual(run(S, msg({ op: 'add', id: 'wg', parent: 'g1', node: { id: 'l1', kind: 'label', text: 'a' } })), { ok: true }); ok();
  assert.deepStrictEqual(run(S, msg({ op: 'add', id: 'wg', node: { id: 's1', kind: 'scroll', height: 120 } })), { ok: true }); ok();
  assert.deepStrictEqual(run(S, msg({ op: 'add', id: 'wg', parent: 's1', node: { id: 'l2', kind: 'label', text: 'b' } })), { ok: true }); ok();
  assert.strictEqual(G.snapshot(S, 'wg').root.children[0].columns, 3); ok();
  assert.match(run(S, msg({ op: 'add', id: 'wg', node: { id: 'g2', kind: 'grid', columns: 99 } })).error, /columns must/); ok();
  assert.match(run(S, msg({ op: 'add', id: 'wg', node: { id: 's2', kind: 'scroll', height: 5 } })).error, /height must/); ok();
  assert.deepStrictEqual(run(S, msg({ op: 'set', id: 'wg', node: 'g1', props: { columns: 2 } })), { ok: true }); ok();
}

// tabs, split, menus
{
  const S = G.createSession();
  run(S, msg({ op: 'open', id: 'wt2', title: 'T' }));
  const add = (parent, node) => run(S, msg({ op: 'add', id: 'wt2', parent, node }));
  assert.deepStrictEqual(add('root', { id: 'tb', kind: 'tabs' }), { ok: true }); ok();
  assert.match(add('root', { id: 'bad', kind: 'tab', text: 'x' }).error, /only be added to a tabs/); ok();
  assert.match(add('tb', { id: 'bad2', kind: 'label', text: 'x' }).error, /only holds tab/); ok();
  assert.deepStrictEqual(add('tb', { id: 'p1', kind: 'tab', text: 'One' }), { ok: true }); ok();
  assert.deepStrictEqual(add('tb', { id: 'p2', kind: 'tab', text: 'Two' }), { ok: true }); ok();
  assert.deepStrictEqual(add('p2', { id: 'inside', kind: 'label', text: 'in two' }), { ok: true }); ok();
  assert.strictEqual(G.eventLine(S, 'wt2', 'tb', 'select', 'zzz'), null); ok();
  const line = JSON.parse(G.eventLine(S, 'wt2', 'tb', 'select', 'p2'));
  assert.strictEqual(line.value, 'p2'); assert.strictEqual(G.snapshot(S, 'wt2').root.children[0].selected, 'p2'); ok();
  assert.deepStrictEqual(add('root', { id: 'sp', kind: 'split', direction: 'column', ratio: 30 }), { ok: true }); ok();
  assert.match(add('root', { id: 'sp2', kind: 'split', ratio: 5 }).error, /ratio must/); ok();
  assert.match(add('root', { id: 'sp3', kind: 'split', direction: 'diag' }).error, /direction/); ok();
  assert.deepStrictEqual(add('root', { id: 'sp4', kind: 'split', direction: 'row', weights: [22, 44, 34] }), { ok: true }); ok();
  assert.match(add('root', { id: 'sp5', kind: 'split', weights: [50] }).error, /weights must/); ok();
  assert.match(add('root', { id: 'sp6', kind: 'split', weights: [50, 0] }).error, /weights\[1\] must/); ok();
  assert.deepStrictEqual(add('root', { id: 'mb', kind: 'menubar' }), { ok: true }); ok();
  assert.match(add('mb', { id: 'mi0', kind: 'menuitem', text: 'x' }).error, /only be added to a menu/); ok();
  assert.deepStrictEqual(add('mb', { id: 'mn', kind: 'menu', text: 'File' }), { ok: true }); ok();
  assert.deepStrictEqual(add('mn', { id: 'mi', kind: 'menuitem', text: 'Save', keys: 'Ctrl+S' }), { ok: true }); ok();
  assert.strictEqual(JSON.parse(G.eventLine(S, 'wt2', 'mi', 'click')).node, 'mi'); ok();
}

// grow, gap, pad, role on any node; the window's first height; theme density
{
  const S = G.createSession();
  const ap = (m) => G.apply(S, m);
  assert.ok(ap({ op: 'open', id: 'wg2', title: 'G', height: 400, resizable: true }).ok); ok();
  assert.strictEqual(G.snapshot(S, 'wg2').height, 400); ok();
  assert.ok(!ap({ op: 'open', id: 'wg3', title: 'G', height: 20 }).ok); ok();
  assert.ok(ap({ op: 'add', id: 'wg2', node: { id: 'ed', kind: 'editor', grow: 1, role: 'card', gap: 4, pad: 8, numbers: false } }).ok); ok();
  assert.ok(!ap({ op: 'add', id: 'wg2', node: { id: 'e2', kind: 'editor', grow: 11 } }).ok); ok();
  assert.ok(ap({ op: 'add', id: 'wg2', node: { id: 'ew', kind: 'editor', wrap: true, prose: true } }).ok); ok();
  assert.ok(ap({ op: 'add', id: 'wg2', node: { id: 'md', kind: 'markdown', value: '# t\n- a' } }).ok); ok();
  assert.ok(ap({ op: 'set', id: 'wg2', node: 'md', props: { value: '## x' } }).ok); ok();
  assert.ok(!ap({ op: 'add', id: 'wg2', node: { id: 'md2', kind: 'markdown', wrap: true } }).ok); ok();
  assert.ok(!ap({ op: 'add', id: 'wg2', node: { id: 'e3', kind: 'label', role: 'nope' } }).ok); ok();
  assert.ok(!ap({ op: 'add', id: 'wg2', node: { id: 'e4', kind: 'label', pad: 99 } }).ok); ok();
  assert.ok(ap({ op: 'set', id: 'wg2', node: 'ed', props: { grow: 3, role: 'surface' } }).ok); ok();
  assert.strictEqual(G.snapshot(S, 'wg2').root.children[0].grow, 3); ok();
  assert.ok(ap({ op: 'theme', id: 'wg2', density: 'compact' }).ok); assert.ok(!ap({ op: 'theme', id: 'wg2', density: 'tiny' }).ok); ok();
  assert.strictEqual(G.snapshot(S, 'wg2').theme.density, 'compact'); ok();
}


// what the user typed or picked stays in the node (a rebuilt window shows it again)
{
  const S = G.createSession();
  const ap = (m) => { const r = G.apply(S, m); assert.ok(r.ok, r.error); };
  ap({ op: 'open', id: 'wr', title: 'R' });
  ap({ op: 'add', id: 'wr', node: { id: 'e', kind: 'entry', value: '' } });
  ap({ op: 'add', id: 'wr', node: { id: 'c', kind: 'checkbox', text: 'x' } });
  ap({ op: 'add', id: 'wr', node: { id: 'l', kind: 'list', items: ['a', 'b'], selected: 'a' } });
  ap({ op: 'add', id: 'wr', node: { id: 'ml', kind: 'multilist', items: ['a', 'b'], selected: [] } });
  ap({ op: 'add', id: 'wr', node: { id: 'tb', kind: 'table', columns: ['x'], rows: [['1']] } });
  G.eventLine(S, 'wr', 'e', 'input', 'typed'); G.eventLine(S, 'wr', 'c', 'change', true); G.eventLine(S, 'wr', 'l', 'select', 'b');
  G.eventLine(S, 'wr', 'ml', 'select', ['a', 'b']); G.eventLine(S, 'wr', 'tb', 'cell', { row: 0, col: 0, text: '9' });
  const kids = G.snapshot(S, 'wr').root.children;
  assert.strictEqual(kids[0].value, 'typed'); assert.strictEqual(kids[1].checked, true); assert.strictEqual(kids[2].selected, 'b'); ok();
  assert.deepStrictEqual(kids[3].selected, ['a', 'b']); assert.strictEqual(kids[4].rows[0][0], '9'); ok();
}

// tree: shapes, cell counts, select and toggle events, and the folded state the bridge keeps
{
  const S = G.createSession();
  const ap = (m) => { const r = G.apply(S, m); assert.ok(r.ok, r.error); };
  const cols = [{ title: 'Name', width: 200 }, { title: 'Result', align: 'right' }];
  const rows = [
    { id: 'a', depth: 0, cells: ['suite', 'ok'], tones: [null, 'pass'], expanded: true },
    { id: 'b', depth: 1, cells: ['case 1', 'fail'], tones: [null, 'fail'], bold: true },
    { id: 'c', depth: 0, cells: ['other', '-'], expanded: false },
    { id: 'd', depth: 1, cells: ['hidden', 'x'] }
  ];
  ap({ op: 'open', id: 'wt', title: 'T' });
  ap({ op: 'add', id: 'wt', node: { id: 'tr', kind: 'tree', columns: cols, rows: rows, selected: 'b' } });
  const sn = G.snapshot(S, 'wt').root.children[0];
  assert.strictEqual(sn.kind, 'tree'); assert.strictEqual(sn.rows.length, 4); assert.strictEqual(sn.rows[1].bold, true); ok();
  assert.strictEqual(sn.columns[1].align, 'right'); assert.strictEqual(sn.rows[2].expanded, false); ok();
  assert.match(G.apply(S, { op: 'add', id: 'wt', node: { id: 'bad1', kind: 'tree', columns: [{ title: 'x' }], rows: [{ id: 'r', depth: 0, cells: ['1', '2'] }] } }).error, /2 cells, the tree has 1/); ok();
  assert.match(G.apply(S, { op: 'add', id: 'wt', node: { id: 'bad2', kind: 'tree', columns: cols, rows: [{ id: 'r', cells: ['1', '2'], tones: ['loud', null] }] } }).error, /tones\[0\]/); ok();
  assert.match(G.apply(S, { op: 'add', id: 'wt', node: { id: 'bad3', kind: 'tree', columns: cols, rows: [{ id: 'r', depth: 99, cells: ['1', '2'] }] } }).error, /depth must be/); ok();
  assert.match(G.apply(S, { op: 'add', id: 'wt', node: { id: 'bad4', kind: 'tree', columns: [{ title: 'x', align: 'justify' }] } }).error, /align must be/); ok();
  assert.match(G.apply(S, { op: 'set', id: 'wt', node: 'tr', props: { rows: [{ id: 'r', cells: ['only one'] }] } }).error, /1 cells, the tree has 2/); ok();
  assert.strictEqual(G.eventLine(S, 'wt', 'tr', 'select', 'b').indexOf('"value":"b"') > 0, true); ok();
  assert.strictEqual(G.eventLine(S, 'wt', 'tr', 'select', 'nope'), null); ok();
  assert.strictEqual(G.eventLine(S, 'wt', 'tr', 'toggle', 'b'), null); ok();
  assert.strictEqual(G.eventLine(S, 'wt', 'tr', 'toggle', 'c').indexOf('"value":"c"') > 0, true); ok();
  assert.strictEqual(G.snapshot(S, 'wt').root.children[0].selected, 'b'); ok();
  assert.strictEqual(G.snapshot(S, 'wt').root.children[0].rows[2].expanded, true); ok();
  assert.strictEqual(G.eventLine(S, 'wt', 'tr', 'toggle', 'c').indexOf('"value":"c"') > 0, true); ok();
  assert.strictEqual(G.snapshot(S, 'wt').root.children[0].rows[2].expanded, false); ok();
}

// doc: block kinds and their props, table shapes, kv rows, the length limits, and ref events that must name a ref block of the doc
{
  const S = G.createSession();
  const ap = (m) => G.apply(S, m);
  ap({ op: 'open', id: 'wd', title: 'D' });
  const blocks = [
    { t: 'title', text: 'Run', badge: 'PASS', tone: 'pass' },
    { t: 'p', text: 'some text', tone: 'muted' },
    { t: 'h', text: 'Cases' },
    { t: 'pre', text: 'a\nb', wrap: true },
    { t: 'list', items: ['x', 'y'], tone: 'fail' },
    { t: 'table', columns: ['#', 'Result'], rows: [['1', 'PASS']] },
    { t: 'kv', rows: [['Key', 'Value', true, false], ['Other', 'v']] },
    { t: 'ref', text: 'case 1', ref: 'c1' }
  ];
  assert.deepStrictEqual(ap({ op: 'add', id: 'wd', node: { id: 'dd', kind: 'doc', blocks: blocks } }), { ok: true }); ok();
  const kept = G.snapshot(S, 'wd').root.children[0].blocks;
  assert.strictEqual(kept.length, 8); assert.strictEqual(kept[4].tone, 'fail'); assert.deepStrictEqual(kept[6].rows[1], ['Other', 'v', false, false]); ok();
  assert.match(ap({ op: 'add', id: 'wd', node: { id: 'x1', kind: 'doc', blocks: [{ t: 'nope' }] } }).error, /\.t must be one of/); ok();
  assert.match(ap({ op: 'add', id: 'wd', node: { id: 'x2', kind: 'doc', blocks: [{ t: 'h', text: 'a', items: [] }] } }).error, /prop "items" is not allowed on h/); ok();
  assert.match(ap({ op: 'add', id: 'wd', node: { id: 'x3', kind: 'doc', blocks: [{ t: 'table', columns: ['a', 'b'], rows: [['1']] }] } }).error, /one cell per column/); ok();
  assert.match(ap({ op: 'add', id: 'wd', node: { id: 'x4', kind: 'doc', blocks: [{ t: 'p', text: 'a', tone: 'loud' }] } }).error, /pass, fail, warn or muted/); ok();
  assert.match(ap({ op: 'add', id: 'wd', node: { id: 'x5', kind: 'doc', blocks: [{ t: 'kv', rows: [['only']] }] } }).error, /key, value, highlight, mono/); ok();
  assert.match(ap({ op: 'add', id: 'wd', node: { id: 'x6', kind: 'doc', blocks: [{ t: 'pre', text: 'y'.repeat(300001) }] } }).error, /longer than 300000/); ok();
  const big = []; for (let i = 0; i < 3; i++) { big.push({ t: 'pre', text: 'z'.repeat(200000) }); }
  assert.match(ap({ op: 'add', id: 'wd', node: { id: 'x7', kind: 'doc', blocks: big } }).error, /the doc is longer than 400000/); ok();
  assert.strictEqual(G.eventLine(S, 'wd', 'dd', 'ref', 'c1').indexOf('"value":"c1"') > 0, true); ok();
  assert.strictEqual(G.eventLine(S, 'wd', 'dd', 'ref', 'nope'), null); ok();
  assert.strictEqual(G.eventLine(S, 'wd', 'dd', 'ref', undefined), null); ok();
  assert.match(ap({ op: 'set', id: 'wd', node: 'dd', props: { blocks: [{ t: 'ref', text: 'only', ref: 'c2' }] } }).ok ? 'yes' : 'no', /yes/); ok();
  assert.strictEqual(G.eventLine(S, 'wd', 'dd', 'ref', 'c1'), null); ok();
  assert.strictEqual(G.eventLine(S, 'wd', 'dd', 'ref', 'c2').indexOf('"value":"c2"') > 0, true); ok();
}

// filepick: a button; its pick event carries no value
{
  const S = G.createSession();
  G.apply(S, { op: 'open', id: 'wp', title: 'P' });
  assert.deepStrictEqual(G.apply(S, { op: 'add', id: 'wp', node: { id: 'fp', kind: 'filepick', text: 'Open files' } }), { ok: true }); ok();
  assert.strictEqual(G.eventLine(S, 'wp', 'fp', 'pick'), JSON.stringify({ v: 1, event: 'pick', id: 'wp', node: 'fp' })); ok();
  assert.match(G.apply(S, { op: 'add', id: 'wp', node: { id: 'fp2', kind: 'filepick', value: 'x' } }).error, /prop "value" is not allowed on filepick/); ok();
}

console.log('gui_bridge: ' + n + ' assertions passed');
