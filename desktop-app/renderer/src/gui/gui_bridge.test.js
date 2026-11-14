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
  assert.deepStrictEqual(add('root', { id: 'mb', kind: 'menubar' }), { ok: true }); ok();
  assert.match(add('mb', { id: 'mi0', kind: 'menuitem', text: 'x' }).error, /only be added to a menu/); ok();
  assert.deepStrictEqual(add('mb', { id: 'mn', kind: 'menu', text: 'File' }), { ok: true }); ok();
  assert.deepStrictEqual(add('mn', { id: 'mi', kind: 'menuitem', text: 'Save', keys: 'Ctrl+S' }), { ok: true }); ok();
  assert.strictEqual(JSON.parse(G.eventLine(S, 'wt2', 'mi', 'click')).node, 'mi'); ok();
}

console.log('gui_bridge: ' + n + ' assertions passed');
