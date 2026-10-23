// node test/edit_shell/edit_objects_core.test.js -- the object (layer) model shared by /edit-svg and /edit-picture
const O = require('../../renderer/src/edit/edit_objects_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); }
const E = O.make({
  types: {
    rect: { label: 'Rect', bbox: (o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }), defaults: { x: 0, y: 0, w: 100, h: 50, fill: '#336699' }, validate: (o) => { const p = []; const w = O.num(o.w, 1, 5000, 100); if (Number(o.w) !== w) p.push('w was limited'); return { obj: { x: O.num(o.x, -5000, 5000, 0), y: O.num(o.y, -5000, 5000, 0), w: w, h: O.num(o.h, 1, 5000, 50), fill: O.COLOR.test(String(o.fill)) ? o.fill : '#336699' }, problems: p }; } },
    text: { label: 'Text', defaults: { text: 'Hi' }, validate: (o) => ({ obj: { text: O.str(o.text, 200), x: O.num(o.x, -5000, 5000, 0), y: O.num(o.y, -5000, 5000, 0) }, problems: [] }) }
  },
  extraOps: { nudge: { words: (e) => 'nudge ' + e.id, apply: (s, e, h) => { const i = h.find(s, e.id); if (i < 0) return { error: 'no such object' }; s.objects[i].x += Number(e.dx) || 0; return {}; } } }
});
const base = () => E.validate({ title: 'T', objects: [{ type: 'rect', name: 'Sky', fill: '#88f' }, { type: 'text', name: 'Label', text: 'Hello' }] }).spec;

let s = base();
check('validate: ids o1, o2 are made, names kept, bottom first', s.objects.map((o) => o.id).join() === 'o1,o2' && s.objects[0].name === 'Sky' && s.seq === 2, s);
check('validate: an unknown type is skipped with a problem', (() => { const r = E.validate({ objects: [{ type: 'nope' }, { type: 'rect' }] }); return r.spec.objects.length === 1 && r.problems.length === 1; })());
check('validate: defaults fill in, the canvas is clamped', (() => { const r = E.validate({ canvas: { w: 99999, h: 1, bg: 'javascript:x' }, objects: [{ type: 'rect' }] }); return r.spec.objects[0].w === 100 && r.spec.canvas.w === 16384 && r.spec.canvas.h === 16 && r.spec.canvas.bg === '#ffffff'; })());
check('validate: an id that repeats gets a new one', (() => { const r = E.validate({ objects: [{ type: 'rect', id: 'a' }, { type: 'rect', id: 'a' }] }); return r.spec.objects[0].id === 'a' && r.spec.objects[1].id !== 'a'; })());

let r = E.applyEdits(s, [{ op: 'add_object', object: { type: 'rect', name: 'Sun', fill: '#fa0', x: 10, y: 10, w: 30, h: 30 } }]);
check('add_object: ONE new object on top, with its name, and the id is reported as added', r.spec.objects.length === 3 && r.spec.objects[2].name === 'Sun' && r.added.join() === 'o3' && r.applied.join() === 'add_object', r);
r = E.applyEdits(s, [{ op: 'add_object', at: 'bottom', object: { type: 'rect', name: 'Ground' } }]);
check('add_object at bottom / above', r.spec.objects[0].name === 'Ground' && E.applyEdits(s, [{ op: 'add_object', at: { above: 'o1' }, object: { type: 'text', name: 'Mid' } }]).spec.objects[1].name === 'Mid');
check('add_object: a bad type is refused with a reason, nothing changes', (() => { const x = E.applyEdits(s, [{ op: 'add_object', object: { type: 'cube' } }]); return x.rejected.length === 1 && x.spec.objects.length === 2 && /unknown object type/.test(x.rejected[0].error); })());
r = E.applyEdits(s, [{ op: 'update_object', id: 'o1', props: { fill: '#f00', w: 200 } }]);
check('update_object: new values are validated and kept, the id and type cannot change', r.spec.objects[0].fill === '#f00' && r.spec.objects[0].w === 200 && r.spec.objects[0].id === 'o1' && r.spec.objects[0].type === 'rect');
check('update_object: an object can be addressed by its name', E.applyEdits(s, [{ op: 'update_object', id: 'sky', props: { fill: '#0f0' } }]).spec.objects[0].fill === '#0f0');
check('update_object / remove_object: a locked object refuses', (() => { const l = E.applyEdits(s, [{ op: 'set_locked', id: 'o1', locked: true }]).spec; return E.applyEdits(l, [{ op: 'update_object', id: 'o1', props: { fill: '#000' } }]).rejected.length === 1 && E.applyEdits(l, [{ op: 'remove_object', id: 'o1' }]).rejected.length === 1; })());
check('remove_object / rename_object / set_visible', (() => { const a = E.applyEdits(s, [{ op: 'remove_object', id: 'o2' }, { op: 'rename_object', id: 'o1', name: 'Blue sky' }, { op: 'set_visible', id: 'o1', visible: false }]); return a.spec.objects.length === 1 && a.spec.objects[0].name === 'Blue sky' && a.spec.objects[0].visible === false && a.applied.length === 3; })());
check('move_object: front, back, up, down, index', (() => { let t = s; const names = (x) => x.objects.map((o) => o.name).join(); t = E.applyEdits(t, [{ op: 'add_object', object: { type: 'text', name: 'C' } }]).spec; const a = E.applyEdits(t, [{ op: 'move_object', id: 'o1', to: 'front' }]).spec; const b = E.applyEdits(a, [{ op: 'move_object', id: 'o1', to: 'back' }]).spec; const c = E.applyEdits(t, [{ op: 'move_object', id: 'o1', to: 'up' }]).spec; const d = E.applyEdits(c, [{ op: 'move_object', id: 'o1', to: 'down' }]).spec; const e = E.applyEdits(t, [{ op: 'move_object', id: 'o3', to: 0 }]).spec; return names(a) === 'Label,C,Sky' && names(b) === 'Sky,Label,C' && names(c) === 'Label,Sky,C' && names(d) === 'Sky,Label,C' && names(e) === 'C,Sky,Label'; })());
check('duplicate_object: a copy above the original with a new id', (() => { const a = E.applyEdits(s, [{ op: 'duplicate_object', id: 'o1' }]); return a.spec.objects.length === 3 && a.spec.objects[1].name === 'Sky copy' && a.spec.objects[1].id === 'o3' && a.added.join() === 'o3'; })());
check('set_canvas / set_title / clear_objects (locked ones stay)', (() => { const l = E.applyEdits(s, [{ op: 'set_locked', id: 'o1', locked: true }, { op: 'set_canvas', w: 400, h: 300, bg: '#000' }, { op: 'set_title', text: 'New' }, { op: 'clear_objects' }]).spec; return l.canvas.w === 400 && l.canvas.bg === '#000' && l.title === 'New' && l.objects.length === 1 && l.objects[0].id === 'o1'; })());
check('set_canvas: a bad colour is refused', E.applyEdits(s, [{ op: 'set_canvas', bg: 'url(x)' }]).rejected.length === 1);
check('an unknown action is refused and names the allowed ones; the editor\'s own action works', (() => { const a = E.applyEdits(s, [{ op: 'format_disk' }, { op: 'nudge', id: 'o1', dx: 5 }]); return a.rejected.length === 1 && /allowed/.test(a.rejected[0].error) && a.spec.objects[0].x === 5; })());
check('applyEdits: one refused action does not stop the others', (() => { const a = E.applyEdits(s, [{ op: 'remove_object', id: 'zz' }, { op: 'rename_object', id: 'o1', name: 'X' }]); return a.applied.length === 1 && a.rejected.length === 1 && a.spec.objects[0].name === 'X'; })());
check('too many objects are refused', (() => { const E2 = O.make({ types: { rect: { validate: (o) => ({ obj: {} }) } }, limits: { objects: 2 } }); const a = E2.applyEdits(E2.validate({ objects: [{ type: 'rect' }, { type: 'rect' }] }).spec, [{ op: 'add_object', object: { type: 'rect' } }]); return a.rejected.length === 1; })());
check('editWords: a short sentence for the history', E.editWords({ op: 'add_object', object: { type: 'rect', name: 'Sun' } }) === '新增物件「Sun」' && E.editWords({ op: 'nudge', id: 'o1' }) === 'nudge o1');
check('list: the top object is number 1 and listed first, with ids, types and flags', (() => { const l = E.list(E.applyEdits(s, [{ op: 'set_visible', id: 'o1', visible: false }]).spec); return /^1\. \[o2\] Label \(text\)/.test(l) && /2\. \[o1\] Sky \(rect, hidden\)/.test(l); })(), E.list(s));
// what the program reads itself
let pc = E.parseObjectCommand('刪掉Label，Sky改名成「藍天」，隱藏第 1 個，把Sky移到最上面，加一個很特別的東西', s);
check('parseObjectCommand: delete / rename / hide / move by name or number; the rest is left for the AI', pc.edits.length === 4 && pc.edits[0].op === 'remove_object' && pc.edits[1].name === '藍天' && pc.edits[2].id === 'o2' && pc.edits[2].visible === false && pc.edits[3].to === 'front' && pc.unmatched.length === 1, pc);
check('parseObjectCommand: an object that does not exist is not guessed', E.parseObjectCommand('刪掉不存在的東西', s).edits.length === 0);
const R = O.parseEditsReply('blah {"say":"ok","edits":[{"op":"add_object","object":{"type":"rect"}},{"op":"hack"}]} trailing', E.OPS);
check('parseEditsReply: only closed actions survive, the rest is counted', R.ok && R.edits.length === 1 && R.dropped === 1 && R.say === 'ok', R);
check('parseEditsReply: not JSON is reported', !O.parseEditsReply('no json here', E.OPS).ok);
check('no boundary: an object may be anywhere (far away, negative), the canvas is only a frame that can be moved', (() => { const a = E.applyEdits(s, [{ op: 'add_object', object: { type: 'rect', name: 'Far', x: -4000, y: 4500, w: 10, h: 10 } }, { op: 'set_canvas', x: -5000, y: -100 }]); return a.spec.objects[2].x === -4000 && a.spec.objects[2].y === 4500 && a.spec.canvas.x === -5000 && a.spec.canvas.y === -100 && a.rejected.length === 0; })());
check('bounds: the box around the shown objects (hidden ones do not count)', (() => { let a = E.applyEdits(s, [{ op: 'update_object', id: 'o1', props: { x: 10, y: 20, w: 100, h: 50 } }, { op: 'add_object', object: { type: 'rect', x: -30, y: 200, w: 10, h: 10 } }]).spec; const b = E.bounds(a); const c = E.bounds(E.applyEdits(a, [{ op: 'set_visible', id: 'o3', visible: false }]).spec); return b.x === -30 && b.y === 20 && b.w === 140 && b.h === 190 && c.x === 10 && c.w === 100; })());
check('fit_canvas: the export frame wraps the content with a margin; nothing shown is refused', (() => { const a = E.applyEdits(E.applyEdits(s, [{ op: 'update_object', id: 'o1', props: { x: 100, y: 100, w: 50, h: 50 } }, { op: 'set_visible', id: 'o2', visible: false }]).spec, [{ op: 'fit_canvas', margin: 10 }]); const e = E.applyEdits(E.validate({}).spec, [{ op: 'fit_canvas' }]); return a.spec.canvas.x === 90 && a.spec.canvas.w === 70 && e.rejected.length === 1; })());
// ---- relative placement: the words say where, the program computes the numbers
const R0 = E.validate({ canvas: { x: 0, y: 0, w: 400, h: 300 }, objects: [{ type: 'rect', name: 'House', x: 100, y: 100, w: 100, h: 80 }, { type: 'rect', name: 'Sun', x: 300, y: 20, w: 40, h: 40 }] }).spec;
const pl = (place, obj, env) => { const a = E.applyEdits(R0, [{ op: 'add_object', object: Object.assign({ type: 'rect', name: 'New', w: 20, h: 10 }, obj || {}), place: place }], env); return a.rejected.length ? a : a.spec.objects[a.spec.objects.length - 1]; };
let n1 = pl({ of: 'House', rel: 'right', gap: 10 });
check('place right of: the left edge is the anchor\'s right edge plus the gap, centred vertically', n1.x === 210 && n1.y === 135, n1);
n1 = pl({ of: 'o1', rel: 'left', gap: 10, align: 'start' }); check('place left of (by id), aligned to the top', n1.x === 70 && n1.y === 100, n1);
n1 = pl({ of: 'house', rel: 'above', gap: 0 }); check('place above (by name, any case), touching, centred horizontally', n1.x === 140 && n1.y === 90, n1);
n1 = pl({ of: 'House', rel: 'below', align: 'end' }); check('place below, the right edges aligned', n1.x === 180 && n1.y === 196, n1);
n1 = pl({ of: 'House', rel: 'center' }); check('place at the centre of another object', n1.x === 140 && n1.y === 135, n1);
n1 = pl({ of: 'House', rel: 'inside', at: 'bottom-right', gap: 5 }); check('place inside, at a corner, with an inset', n1.x === 175 && n1.y === 165, n1);
n1 = pl({ of: 'canvas', rel: 'inside', at: 'top', gap: 8 }); check('place inside the canvas frame, at the top middle', n1.x === 190 && n1.y === 8, n1);
n1 = pl({ rel: 'right', gap: 0 }, {}, { selection: 'o1' }); check('no anchor named: the selected object is the anchor', n1.x === 200, n1);
n1 = pl({ rel: 'right', gap: 0 }, {}, {}); check('no anchor and no selection: the object on top is the anchor', n1.x === 340, n1);
n1 = pl({ of: 'view', rel: 'center' }, {}, { view: { x: 1000, y: 2000, w: 200, h: 100 } }); check('place at the middle of what the user is looking at (far away from the canvas: no boundary)', n1.x === 1090 && n1.y === 2045, n1);
n1 = pl({ of: 'House', rel: 'right', gap: 10, dx: 5, dy: -5 }); check('dx / dy nudge after the relation', n1.x === 215 && n1.y === 130, n1);
check('place: an anchor that does not exist is refused with the reason, nothing is added', (() => { const a = pl({ of: 'Moon', rel: 'right' }); return a.rejected && a.rejected.length === 1 && /no object "Moon"/.test(a.rejected[0].error); })());
check('place: a wrong relation is refused', pl({ of: 'House', rel: 'sideways' }).rejected.length === 1);
const mv = E.applyEdits(R0, [{ op: 'place_object', id: 'Sun', place: { of: 'House', rel: 'above', gap: 20 } }]).spec.objects[1];
check('place_object: an existing object moves relative to another (locked ones do not)', mv.x === 130 && mv.y === 40 && E.applyEdits(E.applyEdits(R0, [{ op: 'set_locked', id: 'o2', locked: true }]).spec, [{ op: 'place_object', id: 'o2', place: { of: 'House', rel: 'above' } }]).rejected.length === 1, mv);
check('place_object: the object cannot be placed relative to itself by default (the next one on top is used)', (() => { const a = E.applyEdits(R0, [{ op: 'place_object', id: 'o2', place: { rel: 'left', gap: 0 } }]).spec.objects[1]; return a.x === 100 - 40; })());
check('placing works for far away objects and keeps the order: relative to something at x = -4000', (() => { const a = E.applyEdits(R0, [{ op: 'add_object', object: { type: 'rect', name: 'Far', x: -4000, y: 4000, w: 10, h: 10 } }, { op: 'add_object', object: { type: 'rect', name: 'Next', w: 10, h: 10 }, place: { of: 'Far', rel: 'right', gap: 5 } }]).spec; return a.objects[3].x === -3985 && a.objects[3].y === 4000; })());
check('add_object without place stays where it was written (the old behaviour)', E.applyEdits(R0, [{ op: 'add_object', object: { type: 'rect', x: 7, y: 9 } }]).spec.objects[2].x === 7);
check('parseObjectCommand: "put A to the right of B" is read by the program', (() => { const c = E.parseObjectCommand('把Sun放到House的上面', R0); return c.edits.length === 1 && c.edits[0].op === 'place_object' && c.edits[0].place.of === 'o1' && c.edits[0].place.rel === 'above'; })());
check('editWords: the placement is in the sentence', /House 的右邊/.test(E.editWords({ op: 'add_object', object: { type: 'rect', name: 'N' }, place: { of: 'House', rel: 'right' } })));
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'edit_objects_core: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
