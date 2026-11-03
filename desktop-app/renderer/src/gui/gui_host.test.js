// node renderer/src/gui/gui_host.test.js -- the window host with the real bridge and a fake renderer (no DOM): open/close, the cap of 4 windows,
// the event queue (frame and mouse move merged, queue limit), wait/poll, and closing wakes a waiting program
const assert = require('assert');
const G = require('./gui_bridge.js');
const H = require('./gui_host.js');
let n = 0; const ok = () => { n++; };

// a fake DOM: elements record their children and attributes; enough for the host's own calls
function fakeDoc() {
  const mk = (tag) => ({ tag, children: [], parentNode: null, className: '', appendChild(c) { c.parentNode = this; this.children.push(c); return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }, querySelector() { return null; } });
  return { createElement: mk, defaultView: null };
}
// a fake renderer: renderWindow returns a marker element and remembers the event hook so the test can fire page events
const renders = [];
const fakeRender = {
  renderWindow(doc, snap, onEvent, onClose, opts) { const el = doc.createElement('div'); el.snap = snap; el.onEvent = onEvent; el.onClose = onClose; renders.push(el); return el; },
  paintFrame(ctx, ops) { ctx.painted = (ctx.painted || 0) + 1; ctx.ops = ops; },
};
function newHost(extra) {
  const doc = fakeDoc();
  const container = doc.createElement('div');
  const closed = [];
  const host = H.createHost(Object.assign({ doc, container, bridge: G, render: fakeRender, onClosed: (id) => closed.push(id) }, extra || {}));
  return { host, container, closed };
}
const msg = (o) => G.PREFIX + JSON.stringify(Object.assign({ v: 1 }, o));
const eventOf = (line) => JSON.parse(line);

// 1. open shows a window; a second window with the same id is refused; the cap of 4 is kept
{
  const { host, container } = newHost();
  assert.strictEqual(host.apply(msg({ op: 'open', id: 'w1', title: 'A' })).ok, true); ok();
  assert.strictEqual(host.isOpen('w1'), true); ok();
  assert.strictEqual(container.children.length, 1, 'layer is added to the container'); ok();
  assert.strictEqual(host.apply(msg({ op: 'open', id: 'w1' })).ok, false); ok();
  for (const id of ['w2', 'w3', 'w4']) assert.strictEqual(host.apply(msg({ op: 'open', id })).ok, true); ok();
  const r = host.apply(msg({ op: 'open', id: 'w5' }));
  assert.strictEqual(r.ok, false); assert.ok(/at most 4/.test(r.error)); ok();
}

// 2. a non-GUI line is reported as not a GUI line and changes nothing
{
  const { host } = newHost();
  assert.strictEqual(host.apply('plain output').ok, false); ok();
}

// 3. add/set redraw the window (show again); close removes it and reports to onClosed
{
  const { host, closed } = newHost();
  host.apply(msg({ op: 'open', id: 'w1' }));
  host.apply(msg({ op: 'add', id: 'w1', node: { id: 'b1', kind: 'button', text: 'OK' } }));
  const last = renders[renders.length - 1];
  assert.strictEqual(last.snap.root.children[0].text, 'OK'); ok();
  host.apply(msg({ op: 'close', id: 'w1' }));
  assert.strictEqual(host.isOpen('w1'), false); ok();
  assert.deepStrictEqual(closed, ['w1']); ok();
}

// 4. a page event goes into the queue; poll takes it; frame events keep only the newest
{
  const { host } = newHost();
  host.apply(msg({ op: 'open', id: 'w1' }));
  host.apply(msg({ op: 'add', id: 'w1', node: { id: 'c1', kind: 'canvas', width: 100, height: 80, fps: 10 } }));
  const hook = renders[renders.length - 1].onEvent;
  hook('frame', 'c1', { t: 1 }); hook('frame', 'c1', { t: 2 }); hook('frame', 'c1', { t: 3 });
  assert.strictEqual(host.queueLength('w1'), 1); ok();
  assert.strictEqual(eventOf(host.poll('w1')).value.t, 3); ok();
  assert.strictEqual(host.poll('w1'), null); ok();
}

// 5. mouse moves in a row merge into the last one; a down between them keeps both
{
  const { host } = newHost();
  host.apply(msg({ op: 'open', id: 'w1' }));
  host.apply(msg({ op: 'add', id: 'w1', node: { id: 'c1', kind: 'canvas', width: 100, height: 80 } }));
  const hook = renders[renders.length - 1].onEvent;
  hook('mouse', 'c1', { kind: 'move', x: 1, y: 1, button: 0 });
  hook('mouse', 'c1', { kind: 'move', x: 5, y: 6, button: 0 });
  assert.strictEqual(host.queueLength('w1'), 1); ok();
  hook('mouse', 'c1', { kind: 'down', x: 5, y: 6, button: 0 });
  assert.strictEqual(host.queueLength('w1'), 2); ok();
  assert.strictEqual(eventOf(host.poll('w1')).value.x, 5); ok();
  assert.strictEqual(eventOf(host.poll('w1')).value.kind, 'down'); ok();
}

// 6. the queue is capped: the oldest events go first
{
  const { host } = newHost();
  host.apply(msg({ op: 'open', id: 'w1' }));
  host.apply(msg({ op: 'add', id: 'w1', node: { id: 'b1', kind: 'button', text: 'x' } }));
  const hook = renders[renders.length - 1].onEvent;
  for (let i = 0; i < 60; i++) hook('click', 'b1');
  assert.strictEqual(host.queueLength('w1'), H.QUEUE_MAX); ok();
}

// 7. wait resolves at once with a queued event, or when the next one arrives; closing wakes a waiter with null
(async () => {
  const { host } = newHost();
  host.apply(msg({ op: 'open', id: 'w1' }));
  host.apply(msg({ op: 'add', id: 'w1', node: { id: 'b1', kind: 'button', text: 'x' } }));
  const hook = renders[renders.length - 1].onEvent;
  const waiting = host.wait('w1');
  hook('click', 'b1');
  const got = await waiting;
  assert.strictEqual(eventOf(got).event, 'click'); ok();
  const pending = host.wait('w1');
  host.close('w1');
  assert.strictEqual(await pending, null); ok();
  assert.strictEqual(await host.wait('w1'), null); ok();

  console.log('gui_host: ' + n + ' assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
