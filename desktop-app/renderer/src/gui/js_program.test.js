// node test/gui_bridge/js_program.test.js -- the pure part of ai_chat_js_program.js: the srcdoc keeps the program text inside one script
// element and gives the same text back. (The iframe run itself needs a browser: see the terminal's `node` command.)
'use strict';
const assert = require('assert');
const path = require('path');
const P = require(path.join(__dirname, 'js_program.js'));

function literalOf(srcdoc) {
  const start = srcdoc.indexOf(')("') + 2;
  const end = srcdoc.lastIndexOf(');</script>');
  return JSON.parse(srcdoc.slice(start, end));
}

let n = 0;
function t(name, fn) { fn(); n++; }

t('program text round-trips', () => {
  const code = 'console.log("a </script> b");\nconst s = `x\\n${1}`;\nreturn 1;';
  assert.strictEqual(literalOf(P.buildSrcdoc(code)), code);
});

t('a closing script tag in the program cannot end the script element', () => {
  const doc = P.buildSrcdoc('var x = "</script><script>alert(1)</script>";');
  assert.strictEqual(doc.split('</script>').length, 2, 'exactly one closing script tag');
  assert.strictEqual(literalOf(doc), 'var x = "</script><script>alert(1)</script>";');
});

t('the srcdoc is a complete document with a charset', () => {
  const doc = P.buildSrcdoc('');
  assert.ok(doc.startsWith('<!doctype html>'));
  assert.ok(doc.includes('charset="utf-8"'));
});

// The gui API itself: the shim runs in a vm context with a fake window and parent. Every gui.* message the program sends is
// answered from `responder`; gui.wait takes its events from `events` (a null entry is a timeout).
const vm = require('vm');
const outbox = [], listeners = [], events = [];
let responder = () => null;
const fakeParent = { postMessage(msg) { outbox.push(msg); } };
const fakeWin = { addEventListener(type, fn) { listeners.push(fn); } };
const sandbox = { window: fakeWin, parent: fakeParent, console: { log() {}, error() {}, warn() {} }, Promise: Promise, Date: Date, Math: Math, Number: Number, String: String, JSON: JSON };
vm.createContext(sandbox);
vm.runInContext('(' + P.programShim.toString() + ')("");', sandbox);
let answered = 0;
const pump = setInterval(() => {
  while (answered < outbox.length) {
    const m = outbox[answered++];
    if (!m.__gui) { continue; }
    const result = m.__gui.op === 'gui.wait' ? (events.length ? events.shift() : null) : responder(m.__gui.op, m.__gui.args);
    for (const fn of listeners) { fn({ source: fakeParent, data: { __reply: { rid: m.__gui.rid, ok: true, result: result === undefined ? null : result } } }); }
  }
}, 0);

(async () => {
  const win = await fakeWin.gui.open('T', 320);
  const ops = [];
  responder = (op, args) => { ops.push([op, args]); return null; };

  const tb = await win.table(['name', 'qty'], [['a', '1'], ['b', '2']]);
  const addTable = ops.find(o => o[1].node && o[1].node.kind === 'table')[1];
  assert.deepEqual(addTable.node, { id: tb, kind: 'table', columns: ['name', 'qty'], rows: [['a', '1'], ['b', '2']] });
  assert.strictEqual(addTable.parent, 'root');
  assert.deepEqual(win.value(tb), [['a', '1'], ['b', '2']]);
  assert.throws(() => win.table(['x', 'y'], [['only one']]), /1 cells/);

  const ex = await win.expander('More', true);
  assert.strictEqual(win.value(ex), true);
  const inner = await win.label('inside', ex);
  assert.strictEqual(ops[ops.length - 1][1].parent, ex);
  assert.ok(inner !== ex);

  const ed = await win.editor('print(1)', 'python', 4);
  assert.deepEqual(ops[ops.length - 1][1].node, { id: ed, kind: 'editor', value: 'print(1)', lang: 'python', rows: 4 });
  assert.strictEqual(win.value(ed), 'print(1)');

  const ml = await win.multilist(['red', 'green', 'blue'], ['green']);
  assert.deepEqual(ops[ops.length - 1][1].node, { id: ml, kind: 'multilist', items: ['red', 'green', 'blue'], selected: ['green'] });
  assert.deepEqual(win.value(ml), ['green']);

  // value events do not return from wait(); the click does
  events.push({ v: 1, event: 'cell', id: win.id, node: tb, value: { row: 1, col: 1, text: '9' } });
  events.push({ v: 1, event: 'toggle', id: win.id, node: ex, value: false });
  events.push({ v: 1, event: 'input', id: win.id, node: ed, value: 'x = 2' });
  events.push({ v: 1, event: 'select', id: win.id, node: ml, value: ['red', 'blue'] });
  events.push({ v: 1, event: 'click', id: win.id, node: 'b9' });
  const ev = await win.wait(30);
  assert.strictEqual(ev.event, 'click');
  assert.deepEqual(win.value(tb), [['a', '1'], ['b', '9']]);
  assert.strictEqual(win.value(ex), false);
  assert.strictEqual(win.value(ed), 'x = 2');
  assert.deepEqual(win.value(ml), ['red', 'blue']);

  clearInterval(pump);
  console.log('js_program: ' + n + ' tests passed, gui API checks passed');
})().catch((e) => { clearInterval(pump); console.error(e); process.exitCode = 1; });
