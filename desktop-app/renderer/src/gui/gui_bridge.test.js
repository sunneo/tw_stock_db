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

console.log('gui_bridge: ' + n + ' assertions passed');
