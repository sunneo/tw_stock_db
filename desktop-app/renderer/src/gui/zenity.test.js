// node renderer/src/gui/zenity.test.js -- zenity-compatible dialogs: argument parsing, the window each dialog builds (checked by the bridge's own validator), and the answers
const assert = require('assert');
const G = require('./gui_bridge.js');
const Z = require('./zenity.js');
let n = 0; const ok = () => { n++; };

// open a dialog: parse, build, apply every message to a fresh bridge session (fails loudly if the bridge would reject any of them)
function open(words, winId) {
  const p = Z.parse(words);
  assert.ok(p.ok, 'parse failed: ' + (p.error || '') + ' for ' + JSON.stringify(words));
  const s = G.createSession();
  Z.build(p, winId || 'z1').forEach((m) => { const r = G.apply(s, m); assert.ok(r.ok, 'bridge rejected ' + JSON.stringify(m) + ': ' + r.error); });
  return { p, s, win: winId || 'z1', st: Z.start(p) };
}
const ev = (o) => Object.assign({ v: 1, id: 'z1' }, o);
const err = (words, re) => { const p = Z.parse(words); assert.strictEqual(p.ok, false, 'should fail: ' + JSON.stringify(words)); assert.match(p.error, re, JSON.stringify(words)); ok(); };

// 1. parsing: the forms winetricks uses, both option spellings, defaults
let p = Z.parse(['--info', '--text=Done', '--title', 'Setup']);
assert.ok(p.ok); assert.strictEqual(p.mode, 'info'); assert.strictEqual(p.opts.text, 'Done'); assert.strictEqual(p.title, 'Setup'); ok();
assert.strictEqual(p.width, 420); assert.strictEqual(p.separator, '|'); ok();
p = Z.parse(['--question', '--text=Install?', '--width=500', '--ok-label=Yes', '--cancel-label=No']);
assert.strictEqual(p.mode, 'question'); assert.strictEqual(p.width, 500); assert.strictEqual(p.title, 'Question'); ok();
p = Z.parse(['--width=5000', '--timeout=9999', '--info', '--text=x']);
assert.strictEqual(p.width, 1200); assert.strictEqual(p.timeout, 300); ok(); // clamped
p = Z.parse(['--info', '--text=a=b=c']); assert.strictEqual(p.opts.text, 'a=b=c'); ok(); // only the first = splits
p = Z.parse(['--info', '--text', '', '--title=']); assert.strictEqual(p.opts.text, ''); assert.strictEqual(p.title, ''); ok();
p = Z.parse(['--list', '--checklist', '--column', '', '--column', 'Name', 'TRUE', 'dotnet', 'FALSE', 'vcrun']);
assert.strictEqual(p.mode, 'checklist'); assert.strictEqual(p.flagged, true); assert.strictEqual(p.multiple, true); assert.strictEqual(p.rows.length, 2); ok();

// 2. parse errors, each with a reason
err(['--text=x'], /pick a dialog/); ok();
err(['--info', '--question'], /only one dialog type/);
err(['--list', '--info', '--column', 'a'], /cannot be combined/);
err(['--file-selection'], /not supported by the bridge/);
err(['--calendar', '--text=x'], /not supported/);
err(['--info', '--bogus'], /unknown option --bogus/);
err(['--info', '--text'], /--text needs a value/);
err(['--info', '--timeout=soon'], /timeout needs a number/);
err(['--list', '--text=x'], /needs at least one --column/);
err(['--list', '--column', 'a', '--column', 'b', 'x', 'y', 'z'], /groups of 2/);
err(['--checklist', '--column', '', '--column', 'n', 'MAYBE', 'x'], /TRUE or FALSE/);
err(['--list', '--column', 'a', '--print-column=3', 'x'], /--print-column must be between 1 and 1/);
err(['--list', '--column', 'a', '--hide-column=0', 'x'], /--hide-column must be between/);
err(['--list', '--column', 'a', ...new Array(Z.MAX_ROWS + 1).fill('r')], /at most 150 rows/);

// 3. the windows: question has OK and Cancel, info only OK, entry has a value, password is secret, progress has a bar and no buttons
let d = open(['--question', '--text=Install?']);
assert.deepStrictEqual(d.s.windows.z1.nodes.ok.kind, 'button'); assert.strictEqual(d.s.windows.z1.nodes.cancel.text, 'Cancel'); ok();
assert.strictEqual(d.s.windows.z1.nodes.msg.text, 'Install?'); ok();
d = open(['--info', '--text=Done']);
assert.strictEqual(d.s.windows.z1.nodes.cancel, undefined); ok();
d = open(['--entry', '--entry-text=abc', '--text=Name']);
assert.strictEqual(d.s.windows.z1.nodes.val.value, 'abc'); assert.strictEqual(d.s.windows.z1.nodes.val.secret, false); ok();
d = open(['--password', '--text=Pass']);
assert.strictEqual(d.s.windows.z1.nodes.val.secret, true); ok();
d = open(['--progress', '--percentage=40', '--text=Downloading', '--auto-close']);
assert.strictEqual(d.s.windows.z1.nodes.bar.value, 40); assert.strictEqual(d.s.windows.z1.nodes.ok, undefined); ok();
d = open(['--progress', '--pulsate']); assert.strictEqual(d.s.windows.z1.nodes.bar.value, 0); ok();
d = open(['--list', '--column', 'Pick', '--column', 'Name', 'a', 'Alpha', 'b', 'Beta']);
assert.deepStrictEqual(d.s.windows.z1.nodes.pick.items, ['a | Alpha', 'b | Beta']); assert.strictEqual(d.s.windows.z1.nodes.pick.selected, undefined); ok();
d = open(['--radiolist', '--column', '', '--column', 'Name', 'FALSE', 'dotnet', 'TRUE', 'vcrun']);
assert.strictEqual(d.s.windows.z1.nodes.pick.selected, 'vcrun'); ok();
d = open(['--checklist', '--column', '', '--column', 'Name', 'TRUE', 'dotnet', 'FALSE', 'vcrun']);
assert.strictEqual(d.s.windows.z1.nodes.c0.checked, true); assert.strictEqual(d.s.windows.z1.nodes.c1.checked, false); assert.strictEqual(d.s.windows.z1.nodes.c1.text, 'vcrun'); ok();
d = open(['--list', '--multiple', '--column', 'Name', 'x', 'y']); assert.strictEqual(d.s.windows.z1.nodes.c1.kind, 'checkbox'); ok();
d = open(['--list', '--column', 'Id', '--column', 'Name', '--hide-column=1', 'a', 'Alpha']);
assert.deepStrictEqual(d.s.windows.z1.nodes.pick.items, ['Alpha']); ok();

// 4. answers: zenity's exit codes and printed text
d = open(['--question', '--text=Install?']);
assert.deepStrictEqual(Z.onEvent(d.p, d.st, ev({ event: 'click', node: 'ok' })), { exit_code: 0, stdout: '' }); ok();
assert.deepStrictEqual(Z.onEvent(d.p, d.st, ev({ event: 'click', node: 'cancel' })), { exit_code: 1, stdout: '' }); ok();
assert.deepStrictEqual(Z.onEvent(d.p, d.st, ev({ event: 'close' })), { exit_code: 1, stdout: '' }); ok();
d = open(['--info', '--text=x']);
assert.deepStrictEqual(Z.onEvent(d.p, d.st, ev({ event: 'click', node: 'ok' })), { exit_code: 0, stdout: '' }); ok();
d = open(['--entry', '--text=Name']);
assert.strictEqual(Z.onEvent(d.p, d.st, ev({ event: 'input', node: 'val', value: 'carol' })), null); ok();
assert.deepStrictEqual(Z.onEvent(d.p, d.st, ev({ event: 'click', node: 'ok' })), { exit_code: 0, stdout: 'carol\n' }); ok();
d = open(['--entry', '--text=Name']);
Z.onEvent(d.p, d.st, ev({ event: 'input', node: 'val', value: 'typed' }));
assert.deepStrictEqual(Z.onEvent(d.p, d.st, ev({ event: 'click', node: 'cancel' })), { exit_code: 1, stdout: '' }); ok();
d = open(['--password', '--text=Pass']);
Z.onEvent(d.p, d.st, ev({ event: 'input', node: 'val', value: 's3cret' }));
assert.strictEqual(Z.onEvent(d.p, d.st, ev({ event: 'click', node: 'ok' })).stdout, 's3cret\n'); ok();
d = open(['--list', '--column', 'Pick', '--column', 'Name', 'a', 'Alpha', 'b', 'Beta']);
assert.deepStrictEqual(Z.onEvent(d.p, d.st, ev({ event: 'click', node: 'ok' })), { exit_code: 1, stdout: '' }); ok(); // OK with no selection
Z.onEvent(d.p, d.st, ev({ event: 'select', node: 'pick', value: 'a | Alpha' }));
assert.deepStrictEqual(Z.onEvent(d.p, d.st, ev({ event: 'click', node: 'ok' })), { exit_code: 0, stdout: 'a\n' }); ok(); // no --print-column: column 1 (Pick) is printed, not the displayed Name
d = open(['--list', '--column', 'Id', '--column', 'Name', '--print-column=1', 'a', 'Alpha', 'b', 'Beta']);
Z.onEvent(d.p, d.st, ev({ event: 'select', node: 'pick', value: 'b | Beta' }));
assert.strictEqual(Z.onEvent(d.p, d.st, ev({ event: 'click', node: 'ok' })).stdout, 'b\n'); ok();
d = open(['--radiolist', '--column', '', '--column', 'Id', '--column', 'Name', 'FALSE', 'dn', 'dotnet', 'TRUE', 'vc', 'vcrun']);
assert.strictEqual(d.p.printColumn, 2); ok(); // default for a flagged list: the first non-flag column (Id)
assert.strictEqual(Z.onEvent(d.p, d.st, ev({ event: 'click', node: 'ok' })).stdout, 'vc\n'); ok(); // preselected row, its Id
d = open(['--checklist', '--column', '', '--column', 'Name', '--print-column=2', 'TRUE', 'dotnet', 'FALSE', 'vcrun', 'FALSE', 'xna'], 'z2');
assert.deepStrictEqual(Z.onEvent(d.p, d.st, ev({ id: 'z2', event: 'change', node: 'c1', value: true })), null); ok();
assert.strictEqual(Z.onEvent(d.p, d.st, ev({ id: 'z2', event: 'change', node: 'c2', value: true })), null); ok();
assert.strictEqual(Z.onEvent(d.p, d.st, ev({ id: 'z2', event: 'change', node: 'c0', value: false })), null); ok();
assert.deepStrictEqual(Z.onEvent(d.p, d.st, ev({ id: 'z2', event: 'click', node: 'ok' })), { exit_code: 0, stdout: 'vcrun|xna\n' }); ok();
d = open(['--checklist', '--column', '', '--column', 'Name', 'FALSE', 'a']);
assert.deepStrictEqual(Z.onEvent(d.p, d.st, ev({ event: 'click', node: 'ok' })), { exit_code: 0, stdout: '' }); ok(); // nothing checked: empty output, exit 0 (zenity does the same)
assert.strictEqual(Z.onEvent(d.p, d.st, ev({ event: 'input', node: 'val', value: 'x' })), null); ok(); // unrelated events are ignored
assert.strictEqual(Z.onEvent(d.p, d.st, null), null); ok();

// 5. progress returns at once (no stdin in this version); the other dialogs wait
assert.deepStrictEqual(Z.immediate(Z.parse(['--progress', '--text=x'])), { exit_code: 0, stdout: '' }); ok();
assert.strictEqual(Z.immediate(Z.parse(['--info', '--text=x'])), null); ok();

console.log('zenity: ' + n + ' assertions passed');
