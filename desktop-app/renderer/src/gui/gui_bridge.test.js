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
// every op may be long (no small per-message cap); only a runaway line above MAX_LINE is refused
{
  const big = (op, n) => G.PREFIX + JSON.stringify({ v: 1, op, id: 'w1', node: 'c', name: 'a', data: 'A'.repeat(n) });
  assert.ok(G.parseLine(big('image', 20000)).msg); ok();
  assert.ok(G.parseLine(big('glbuf', 20000)).msg); ok();
  assert.ok(G.parseLine(big('set', 20000)).msg); ok(); // set and add may carry a long editor text; the value limit is checked later
  assert.ok(G.parseLine(big('remove', 20000)).msg); ok();
  assert.match(G.parseLine(big('glbuf', G.LIMITS.MAX_LINE + 1)).error, /longer than/); ok();
}

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
assert.match(G.apply(L, { op: 'open', id: 'extra' }).error, /at most [0-9]+ windows/); ok();
assert.match(G.apply(L, { op: 'add', id: 'w0', node: { id: 'big', kind: 'label', text: 'x'.repeat(G.LIMITS.MAX_TEXT + 1) } }).error, /longer than/); ok();
assert.match(G.apply(L, { op: 'add', id: 'w0', node: { id: 'l', kind: 'list', items: new Array(G.LIMITS.MAX_ITEMS + 1).fill('a') } }).error, /at most [0-9]+/); ok();
for (let i = 0; i < G.LIMITS.MAX_NODES - 1; i++) { assert.ok(G.apply(L, { op: 'add', id: 'w1', node: { id: 'n' + i, kind: 'label' } }).ok); }
assert.match(G.apply(L, { op: 'add', id: 'w1', node: { id: 'over', kind: 'label' } }).error, /at most [0-9]+ nodes/); ok();
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
  assert.ok(run(S, msg({ op: 'shortcut', id: 'wt', keys: 'Ctrl+Alt+Q', name: 'more' })).ok); ok(); // no small fixed cap on shortcuts

  // the event: only for a registered name, on the window ("root")
  assert.deepStrictEqual(JSON.parse(G.eventLine(S, 'wt', 'root', 'shortcut', 'save')), { v: 1, event: 'shortcut', id: 'wt', node: 'root', value: 'save' }); ok();
  assert.strictEqual(G.eventLine(S, 'wt', 'root', 'shortcut', 'unknown'), null); ok();
  assert.strictEqual(G.eventLine(S, 'wt', 'n1', 'shortcut', 'save'), null); ok();
  assert.strictEqual(G.eventLine(S, 'wt', 'root', 'shortcut', 5), null); ok();

  assert.deepStrictEqual(run(S, msg({ op: 'tone', id: 'wt', freq: 440, ms: 120, wave: 'square' })), { ok: true }); ok();
  assert.deepStrictEqual(run(S, msg({ op: 'tone', id: 'wt', freq: 440, ms: 120 })), { ok: true }); ok();
  assert.match(run(S, msg({ op: 'tone', id: 'wt', freq: 10, ms: 120 })).error, /freq/); ok();
  assert.match(run(S, msg({ op: 'tone', id: 'wt', freq: 440, ms: 700000 })).error, /ms/); ok();
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
  // Redmine 版的程式用空字串表示沒有色調：樹的 tones 與文件區塊的 tone 都要收（回傳 null／省略）
  assert.strictEqual(G.apply(S, { op: 'add', id: 'wt', node: { id: 'emp', kind: 'tree', columns: cols, rows: [{ id: 'r', cells: ['1', '2'], tones: ['', 'muted'] }] } }).error, undefined); ok();
  assert.match(G.apply(S, { op: 'add', id: 'wt', node: { id: 'bad2', kind: 'tree', columns: cols, rows: [{ id: 'r', cells: ['1', '2'], tones: ['loud', null] }] } }).error, /tones\[0\]/); ok();
  assert.match(G.apply(S, { op: 'add', id: 'wt', node: { id: 'bad3', kind: 'tree', columns: cols, rows: [{ id: 'r', depth: 101, cells: ['1', '2'] }] } }).error, /depth must be/); ok();
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
  assert.strictEqual(ap({ op: 'add', id: 'wd', node: { id: 'x6', kind: 'doc', blocks: [{ t: 'pre', text: 'y'.repeat(300001) }] } }).error, undefined); ok(); // no small cap on a block of text
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

// WebGL2 canvas (gl: true): glbuf / glprog / glframe, their limits, and that 2D ops are refused on it
{
  const S = G.createSession();
  G.apply(S, { op: 'open', id: 'wg', title: 'GL' });
  assert.deepStrictEqual(G.apply(S, { op: 'add', id: 'wg', node: { id: 'cv', kind: 'canvas', width: 320, height: 240, gl: true } }), { ok: true }); ok();
  G.apply(S, { op: 'add', id: 'wg', node: { id: 'c2', kind: 'canvas', width: 320, height: 240 } });
  const tri = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64');
  const vs = '#version 300 es\nin vec3 pos; uniform mat4 mvp; void main(){ gl_Position = mvp * vec4(pos,1.0); }';
  const fs = '#version 300 es\nprecision mediump float; out vec4 o; void main(){ o = vec4(1.0); }';
  assert.deepStrictEqual(G.apply(S, { op: 'glbuf', id: 'wg', node: 'cv', name: 'tri', type: 'f32', data: tri }), { ok: true }); ok();
  assert.deepStrictEqual(G.apply(S, { op: 'glprog', id: 'wg', node: 'cv', name: 'flat', vs, fs }), { ok: true }); ok();
  const cmds = [['clear', 0, 0, 0, 1], ['state', 'depth', 1], ['use', 'flat'], ['uf', 'mvp', 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], ['attr', 'pos', 'tri', 3, 12, 0], ['draw', 'triangles', 0, 3]];
  assert.deepStrictEqual(G.apply(S, { op: 'glframe', id: 'wg', node: 'cv', cmds }), { ok: true }); ok();
  const snapGl = G.snapshot(S, 'wg').root.children[0];
  assert.strictEqual(snapGl.glframe.length, 6); assert.strictEqual(snapGl.glbufs.tri.v, 1); ok();
  G.apply(S, { op: 'glbuf', id: 'wg', node: 'cv', name: 'tri', type: 'f32', data: tri });
  assert.strictEqual(G.snapshot(S, 'wg').root.children[0].glbufs.tri.v, 2); ok();   // same name again: replaced, version counts up
  // refusals
  assert.match(G.apply(S, { op: 'glframe', id: 'wg', node: 'c2', cmds: [] }).error, /not a gl canvas/); ok();
  assert.match(G.apply(S, { op: 'draw', id: 'wg', node: 'cv', ops: [] }).error, /gl canvas: send glframe/); ok();
  assert.match(G.apply(S, { op: 'glframe', id: 'wg', node: 'cv', cmds: [['use', 'nope']] }).error, /use needs a program/); ok();
  assert.match(G.apply(S, { op: 'glframe', id: 'wg', node: 'cv', cmds: [['draw', 'quads', 0, 3]] }).error, /draw needs a mode/); ok();
  assert.match(G.apply(S, { op: 'glframe', id: 'wg', node: 'cv', cmds: [['bogus']] }).error, /not supported/); ok();
  assert.deepStrictEqual(G.apply(S, { op: 'glframe', id: 'wg', node: 'cv', cmds: [['state', 'additive', 1], ['state', 'additive', 0]] }), { ok: true }); ok();
  assert.match(G.apply(S, { op: 'glframe', id: 'wg', node: 'cv', cmds: new Array(100001).fill(['clear', 0, 0, 0, 1]) }).error, /at most 100000/); ok();
  assert.match(G.apply(S, { op: 'glbuf', id: 'wg', node: 'cv', name: 'bad', type: 'f32', data: Buffer.from([1, 2, 3]).toString('base64') }).error, /multiple of 4/); ok();
  assert.match(G.apply(S, { op: 'glbuf', id: 'wg', node: 'cv', name: 'big', type: 'f32', data: Buffer.alloc(48 * 1024 * 1024 + 4).toString('base64') }).error, /larger than 48 MB/); ok();
  assert.match(G.apply(S, { op: 'glprog', id: 'wg', node: 'cv', name: 'x', vs: 'void main(){}  // no version line', fs }).error, /#version 300 es/); ok();
  assert.match(G.apply(S, { op: 'glframe', id: 'wg', node: 'cv', cmds: [['attr', 'pos', 'missing', 3, 12, 0]] }).error, /attr needs/); ok();
  assert.match(G.apply(S, { op: 'glframe', id: 'wg', node: 'cv', cmds: [['uf', 'u', 1, 2, 3, 4, 5]] }).error, /uf needs/); ok();
  // 2D canvas has no gl ops, and the glerror event carries short text
  assert.strictEqual(G.eventLine(S, 'wg', 'cv', 'glerror', 'program "x": bad'), JSON.stringify({ v: 1, event: 'glerror', id: 'wg', node: 'cv', value: 'program "x": bad' })); ok();
  assert.strictEqual(G.eventLine(S, 'wg', 'cv', 'glerror', 5), null); ok();
  // image flip flags
  G.apply(S, { op: 'image', id: 'wg', node: 'c2', name: 'p', data: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.deepStrictEqual(G.apply(S, { op: 'draw', id: 'wg', node: 'c2', ops: [['image', 'p', 1, 2, 30, 40, 1, 0]] }), { ok: true }); ok();
  assert.deepStrictEqual(G.snapshot(S, 'wg').root.children[1].frame[0], ['image', 'p', 1, 2, 30, 40, 1, 0]); ok();
  assert.ok(G.apply(S, { op: 'draw', id: 'wg', node: 'c2', ops: [['image', 'p', 1, 2, 30, 40, 1]] }).error); ok();
}

// stack (children drawn on top of each other) and a transparent 2D canvas
{
  const S = G.createSession();
  G.apply(S, { op: 'open', id: 'ws', title: 'S' });
  assert.deepStrictEqual(G.apply(S, { op: 'add', id: 'ws', node: { id: 'st', kind: 'stack', grow: 1 } }), { ok: true }); ok();
  assert.deepStrictEqual(G.apply(S, { op: 'add', id: 'ws', parent: 'st', node: { id: 'g', kind: 'canvas', width: 300, height: 200, gl: true, fps: 30 } }), { ok: true }); ok();
  assert.deepStrictEqual(G.apply(S, { op: 'add', id: 'ws', parent: 'st', node: { id: 'h', kind: 'canvas', width: 300, height: 200, transparent: true } }), { ok: true }); ok();
  assert.deepStrictEqual(G.snapshot(S, 'ws').root.children[0].children.map((c) => c.id), ['g', 'h']); ok();   // order = stacking order, the last is on top
  assert.strictEqual(G.snapshot(S, 'ws').root.children[0].children[1].transparent, true); ok();
  assert.match(G.apply(S, { op: 'add', id: 'ws', parent: 'st', node: { id: 'x', kind: 'label', text: 'a', transparent: true } }).error, /not allowed on label/); ok();
}

// 長文字編輯器：整個檔案能放進編輯器，編輯後的內容回傳不被截成 2000 字
{
  const T = G.createSession();
  G.apply(T, { op: 'open', id: 'ed' });
  assert.ok(G.apply(T, { op: 'add', id: 'ed', node: { id: 'e1', kind: 'editor', value: 'a' } }).ok); ok();
  const longText = 'x'.repeat(200000);
  assert.ok(G.apply(T, { op: 'set', id: 'ed', node: 'e1', props: { value: longText } }).ok); ok();
  assert.match(G.apply(T, { op: 'set', id: 'ed', node: 'e1', props: { value: 'y'.repeat(G.LIMITS.MAX_TEXT + 1) } }).error, /longer than/); ok();
  assert.strictEqual(JSON.parse(G.eventLine(T, 'ed', 'e1', 'input', longText)).value.length, 200000); ok();
  assert.ok(G.apply(T, { op: 'add', id: 'ed', node: { id: 'l1', kind: 'label' } }).ok);
  assert.match(G.apply(T, { op: 'set', id: 'ed', node: 'l1', props: { text: 'z'.repeat(G.LIMITS.MAX_TEXT + 1) } }).error, /longer than/); ok();
}

// 大圖分段傳送：不設大小上限，依序接起來，最後一段才註冊
{
  const P = G.createSession();
  G.apply(P, { op: 'open', id: 'pw' });
  G.apply(P, { op: 'add', id: 'pw', node: { id: 'c', kind: 'canvas', width: 100, height: 100 } });
  const piece = (n) => Buffer.alloc(n, 7).toString('base64');
  const send = (i, parts, chunk, mime) => G.apply(P, { op: 'image', id: 'pw', node: 'c', name: 'big', mime: mime || 'png', part: i, parts, chunk });
  assert.deepStrictEqual(send(0, 3, piece(3000)), { ok: true, pending: true }); ok();
  assert.deepStrictEqual(send(1, 3, piece(3000)), { ok: true, pending: true }); ok();
  assert.deepStrictEqual(send(2, 3, piece(10)), { ok: true }); ok();
  const url = P.windows.pw.nodes.c.images.big;
  assert.ok(url.startsWith('data:image/png;base64,') && url.length === 'data:image/png;base64,'.length + piece(3000).length * 2 + piece(10).length); ok();
  // 順序錯、中途缺段、不是 base64、格式不對都被拒絕，且不留下半張圖
  assert.match(send(1, 3, piece(30)).error, /in order/); ok();
  send(0, 2, piece(30));
  assert.match(send(0, 2, piece(30), 'bmp').error, /mime/); ok();
  assert.match(G.apply(P, { op: 'image', id: 'pw', node: 'c', name: 'big', mime: 'png', part: 0, parts: 2, chunk: 'not base64!' }).error, /base64/); ok();
  // 超過舊上限（1 MB）的單張圖不再被拒
  const huge = 'data:image/png;base64,' + Buffer.alloc(2 * 1024 * 1024, 1).toString('base64');
  assert.ok(G.apply(P, { op: 'image', id: 'pw', node: 'c', name: 'h2', data: huge }).ok); ok();
}

console.log('gui_bridge: ' + n + ' assertions passed');
