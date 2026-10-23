// node scripts/edit-tests/edit3d_part_core.test.js -- the single-object (skin) editor core of /edit-3d-model
const C = require('../../renderer/src/edit/edit3d_core.js');
const P = require('../../renderer/src/edit/edit3d_part_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 500) : '')); }
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 0.02 : e);
const box = () => P.validate({ title: '模型', base: { mesh: 'box', size: [2, 3, 2], material: { color: '#cccccc' } } }).spec;

let s = box();
check('validate: a base that can wear skins; a shape that cannot (polygon) becomes a box with a problem', s.base.mesh === 'box' && P.validate({ base: { mesh: 'polygon' } }).problems.length >= 1 && P.validate({ base: { mesh: 'polygon' } }).spec.base.mesh === 'box');
let a = P.applyEdits(s, [{ op: 'add_object', object: { type: 'skin', zone: '+z', color: '#ff0000' } }, { op: 'add_object', object: { type: 'skin', zone: '+y', image: 'ref:abc', w: 0.5, h: 0.5 } }, { op: 'add_object', object: { type: 'skin', zone: 'side', color: '#fff' } }, { op: 'add_object', object: { type: 'skin' } }]);
check('add skins: a face of the shape, a picture or a colour; a face it has not (side on a box) and an empty skin are refused with the reason', a.applied.length === 2 && a.rejected.length === 2 && a.spec.objects.length === 2 && a.spec.objects[0].id === 's1' && /沒有/.test(a.rejected[0].error), a.rejected);
a = P.applyEdits(a.spec, [{ op: 'add_object', object: { type: 'skin', zone: '-x', color: '#00f', w: 0.4, h: 0.4 }, place: { at: 'top-left' } }]);
const tl = a.spec.objects[a.spec.objects.length - 1];
check('place by words: top-left puts the centre toward the top left of the face (u small, v big), the whole skin stays inside', tl.u < 0.5 && tl.v > 0.5 && tl.u - tl.w / 2 >= 0 && tl.v + tl.h / 2 <= 1.001, tl);
a = P.applyEdits(a.spec, [{ op: 'place_object', id: 's1', place: { at: 'bottom-right', size: 0.3 } }, { op: 'transform_object', id: 's1', du: -0.1, scale: 2, turn: 30 }, { op: 'transform_object', id: 's1', opacity: 0.5 }]);
const k1 = a.spec.objects[0];
check('place_object and transform_object: move (du, dv), scale (w and h together), turn (degrees), opacity', a.applied.length === 3 && near(k1.w, 0.6) && near(k1.rotate, 30) && near(k1.opacity, 0.5) && k1.u < 0.9 && k1.v < 0.3, k1);
a = P.applyEdits(a.spec, [{ op: 'set_base', color: '#112233', roughness: 0.1 }, { op: 'set_base', texture: 'wood' }, { op: 'set_base', texture: 'zzz' }]);
check('set_base: colour and material of the whole object, a builtin texture; a bad texture changes nothing (the colour of a bad one is dropped by the check)', a.spec.base.material.color === '#112233' && a.spec.base.material.texture === 'wood' && a.spec.base.material.roughness === 0.1, a.spec.base.material);
a = P.applyEdits(a.spec, [{ op: 'move_object', id: 's1', to: 'front' }, { op: 'set_visible', id: 's2', visible: false }, { op: 'duplicate_object', id: 's2' }, { op: 'remove_object', id: 's3' }, { op: 'rename_object', id: 's2', name: '頂蓋' }, { op: 'set_zone', id: 's2', zone: '-y' }, { op: 'set_zone', id: 's2', zone: 'side' }]);
check('layers: reorder (top = last), hide, duplicate, remove, rename, change face; a face the shape does not have is refused', a.applied.length === 6 && a.rejected.length === 1 && a.spec.objects[a.spec.objects.length - 1].id === 's1' && a.spec.objects.some((o) => o.name === '頂蓋' && o.zone === '-y' && !o.visible), a.spec.objects.map((o) => [o.id, o.name, o.zone, o.visible]));
const patch = P.toObjectPatch(a.spec);
check('toObjectPatch: only the visible skins go back to the scene object, with the material', patch.skins.length === a.spec.objects.filter((o) => o.visible).length && patch.material.color === '#112233' && patch.skins.every((k) => k.zone && (k.image || k.color)));
const obj = C.applyEdits(C.validate({ objects: [{ type: 'mesh', mesh: 'box', name: '箱子', size: [1, 1, 1] }] }).spec, [{ op: 'set_skins', id: '箱子', skins: patch.skins, material: patch.material }]).spec.objects[0];
const round = P.fromObject(obj);
check('scene <-> part: the object takes the skins and material; opening it again gives the same layers', obj.skins.length === patch.skins.length && obj.material.color === '#112233' && round.objects.length === patch.skins.length && round.base.mesh === 'box' && /箱子/.test(round.title), round);
// words
const W = (t, sp) => P.parseCommands(t, sp || box());
let p = W('把前面塗成紅色，上面漆成藍色，底面改成黃色');
check('words: paint faces by name -> add_object skins with the face and colour', p.edits.length === 3 && p.edits[0].object.zone === '+z' && p.edits[0].object.color === '#e53935' && p.edits[1].object.zone === '+y' && p.edits[2].object.zone === '-y' && p.unmatched.length === 0, p);
p = W('底色改成白色');
check('words: "the base colour" -> set_base', p.edits.length === 1 && p.edits[0].op === 'set_base' && p.edits[0].color === '#f5f5f5', p);
p = W('把右邊的貼圖拿掉', a.spec);
check('words: take off what is on a face (only if something is there)', p.edits.length === 0 || p.edits.every((e) => e.op === 'remove_object'), p);
const withLeft = P.applyEdits(box(), [{ op: 'add_object', object: { type: 'skin', zone: '-x', color: '#f00' } }]).spec;
p = W('把左邊的貼皮拿掉', withLeft);
check('words: removing the skin on the left face gives a remove_object of it', p.edits.length === 1 && p.edits[0].op === 'remove_object' && p.edits[0].id === 's1', p);
p = W('把它放大一倍，往右移，轉 45 度，變半透明，移到右上角');
check('words: scale, move, turn, opacity and place of the selected skin ("it")', p.edits.length === 5 && p.edits.every((e) => e.id === 'selection') && p.edits[0].scale === 2 && p.edits[1].du > 0 && p.edits[2].turn === 45 && p.edits[3].opacity === 0.5 && p.edits[4].place.at === 'top-right', p);
p = W('讓它看起來更有科技感');
check('words: what no rule reads goes to the AI', p.edits.length === 0 && p.unmatched.length === 1);
const cyl = P.validate({ base: { mesh: 'cylinder', radius: 1, height: 2 } }).spec;
check('words: a cylinder has top, bottom and side', (() => { const r = P.parseCommands('把頂面塗成綠色，側面塗成紅色', cyl); return r.edits.length === 2 && r.edits[0].object.zone === 'top' && r.edits[1].object.zone === 'side'; })());
const pr = P.editPrompt(a.spec, '把正面貼上這張圖', '', 's2');
check('prompt: the faces of this shape, the layers, the selection, "attached"', /\+z=前面/.test(pr.system) && /attached/.test(pr.system) && /s2/.test(pr.user) && /選取的貼皮:s2/.test(pr.user) && /把正面貼上這張圖/.test(pr.user));
check('reply: JSON read; actions not on the list dropped; host actions kept', (() => { const r = P.parseEditsReply('{"say":"好","edits":[{"op":"add_object","object":{"type":"skin","zone":"+z","image":"attached"}},{"op":"zzz"},{"op":"generate_image","prompt":"x"}]}'); return r.ok && r.edits.length === 2 && r.dropped === 1; })());
check('editWords: a sentence for every action', P.OPS.every((op) => P.editWords({ op, id: 's1', object: { zone: '+z' }, place: { at: 'top' }, zone: '+z' }).length > 1));
check('list and promptOf describe the base and every layer', /底:box/.test(P.list(a.spec)) && /頂蓋/.test(P.list(a.spec)) && /1\. 塗前面/.test(P.promptOf(a.spec, [{ text: '塗前面', summary: 'x' }])));

console.log('edit3d_part_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n  ' + bad.join('\n  ') : ''));
process.exit(bad.length ? 1 : 0);
