// node renderer/src/gui/py_worker.test.js -- the Worker source (syntax and the base URL it gets), the Python prelude and runner text,
// the "@gui" message shape, and gui.wait by polling (events, a closed window, timeout) with a fake host and a fake clock
const assert = require('assert');
const vm = require('vm');
const W = require('./py_worker.js');
let n = 0; const ok = () => { n++; };

// the worker source must parse as a script (module workers run it as a module; vm.Script checks the syntax only)
const src = W.workerSource('https://cdn.jsdelivr.net/pyodide/v314.0.7/full/');
assert.doesNotThrow(() => new vm.Script(src)); ok();
assert.ok(src.includes('"https://cdn.jsdelivr.net/pyodide/v314.0.7/full/"')); ok();
assert.ok(src.includes("import(base + 'pyodide.mjs')")); ok();
assert.ok(src.includes('registerJsModule')); ok();
assert.ok(src.includes('go.callPromising()')); ok();
// a quote in the base must not break the source
assert.doesNotThrow(() => new vm.Script(W.workerSource('https://x.example/a"b/'))); ok();

// Python text: the runner defines go() that execs the script in a fresh __main__-like dict
assert.ok(W.RUNNER_PY.startsWith('def go():')); ok();
assert.ok(W.RUNNER_PY.includes("'__name__': '__main__'")); ok();
assert.ok(W.RUNNER_PY.includes('exec(compile(__fa_src__, __fa_path__')); ok();
assert.ok(W.PRELUDE_PY.includes("sys.path.insert(0, '/work')")); ok();
assert.ok(W.PRELUDE_PY.includes('import fa_bridge')); ok();
assert.ok(!W.PRELUDE_PY.includes('install_hooks'), 'install_hooks runs inside go(), not at the top level'); ok();
assert.ok(W.RUNNER_PY.indexOf('fa_bridge.install_hooks()') < W.RUNNER_PY.indexOf('exec(')); ok();

// the Python prelude and runner must be valid Python: compiled with the same names the worker sets (checked only when python3 exists)
// (done in gui_pygame_test-style checks by hand; here the text is compared, not run)

// the message shape the page sends to the GUI host
assert.deepStrictEqual(W.guiMessage('open', { id: 'w1', title: 'hi', width: 320 }), { v: 1, op: 'open', id: 'w1', title: 'hi', width: 320 }); ok();
assert.deepStrictEqual(W.guiMessage('add', { id: 'w1', parent: 'root', node: { id: 'b1', kind: 'button' } }).node.id, 'b1'); ok();
assert.deepStrictEqual(W.guiMessage('close', { id: 'w1' }), { v: 1, op: 'close', id: 'w1' }); ok();
assert.ok(W.GUI_OPS.indexOf('image') >= 0 && W.GUI_OPS.indexOf('draw') >= 0); ok();

// gui.wait with a fake host and a fake clock
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}
function fakeHost(queue, open) {
  const calls = { poll: 0 };
  return {
    calls,
    poll: (id) => { calls.poll++; return queue.length ? queue.shift() : null; },
    isOpen: () => open.value,
  };
}
(async () => {
  // an event already queued comes back as the parsed object
  const q1 = [JSON.stringify({ event: 'click', id: 'w1', node: 'b1' })];
  const r1 = await W.waitEvent(fakeHost(q1, { value: true }), 'w1', 5, clock());
  assert.deepStrictEqual(r1, { event: 'click', id: 'w1', node: 'b1' }); ok();

  // an event that arrives during the wait is picked up on a later poll
  const c2 = clock();
  const q2 = [];
  const h2 = { poll: () => { if (c2.now() >= 100) { return q2.length ? q2.shift() : null; } return null; }, isOpen: () => true };
  q2.push(JSON.stringify({ event: 'input', id: 'w1', node: 'e1', value: 'x' }));
  const r2 = await W.waitEvent(h2, 'w1', 5, c2);
  assert.strictEqual(r2.event, 'input'); ok();

  // nothing queued and the window is closed: a close event, not a timeout
  const r3 = await W.waitEvent(fakeHost([], { value: false }), 'w1', 5, clock());
  assert.deepStrictEqual(r3, { event: 'close', id: 'w1' }); ok();

  // timeout with the window still open: null, and it took about the given seconds of fake time
  const c4 = clock();
  const r4 = await W.waitEvent(fakeHost([], { value: true }), 'w1', 1, c4);
  assert.strictEqual(r4, null); ok();
  assert.ok(c4.now() >= 1000 && c4.now() < 1100, 'timeout near 1000 ms, got ' + c4.now()); ok();

  // timeout 0: one poll, then null
  const h5 = fakeHost([], { value: true });
  assert.strictEqual(await W.waitEvent(h5, 'w1', 0, clock()), null); ok();
  assert.strictEqual(h5.calls.poll, 1); ok();

  console.log('py_worker.test.js: ' + n + ' 項通過');
})().catch((e) => { console.error(e); process.exit(1); });
