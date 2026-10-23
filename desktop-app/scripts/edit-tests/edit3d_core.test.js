// node scripts/edit-tests/edit3d_core.test.js -- the /edit-3d-model document core
const E = require('../../renderer/src/edit/edit3d_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 500) : '')); }
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 0.02 : e);
const nearV = (a, b, e) => a.length === b.length && a.every((x, i) => near(x, b[i], e));
const room = () => E.starter('room');
// the camera at (0,5,10) looks at the origin: forward = -z, right = +x
const ENV = { view: { position: [0, 5, 10], target: [0, 0, 0] } };
const get = (sp, ref) => sp.objects[E.find(sp, ref)];
const box = (sp, ref) => E.worldBox(sp, get(sp, ref));

// ── the document
let s = E.validate({ title: 'T', objects: [{ type: 'mesh', mesh: 'box', name: '方塊', size: [2, 1, 1], position: [0, 0.5, 0] }, { type: 'mesh', mesh: 'blob' }, { type: 'light', light: 'point', position: [1, 2, 3] }, { type: 'zzz' }] });
check('validate: kinds are checked, unknown ones are dropped with a problem, ids are made (o1, o2…)', s.spec.objects.length === 2 && s.problems.length === 2 && s.spec.objects[0].id === 'o1' && s.spec.objects[1].id === 'o2' && s.spec.objects[1].type === 'light', s);
check('validate: defaults and clamping (a sphere radius, a plane lies flat, colours checked)', (() => { const x = E.validate({ objects: [{ type: 'mesh', mesh: 'sphere', radius: -4, material: { color: 'not a colour', roughness: 9 } }, { type: 'mesh', mesh: 'plane', size: [3, 99, 5] }] }).spec; const a = x.objects[0], p = x.objects[1]; return a.radius === 0.001 && a.material.color === '#4E79A7' && a.material.roughness === 1 && nearV(p.rotation, [-Math.PI / 2, 0, 0], 0.001) && nearV(p.size, [3, 5], 0.001); })());
check('validate: parents must be groups that exist, no cycles; the tree lists a parent before its children', (() => { const x = E.validate({ objects: [{ id: 'a', type: 'group', parent: 'b' }, { id: 'b', type: 'group', parent: 'a' }, { id: 'c', type: 'mesh', mesh: 'box', parent: 'zz' }, { id: 'd', type: 'mesh', mesh: 'box', parent: 'a' }] }).spec; return x.objects.every((o) => !o.parent || E.byId(x, o.parent) >= 0) && E.tree(x).length === 4; })());
check('starters: blank, room (a table of 6 parts in a group), model, studio all validate', E.listStarters().length >= 4 && E.listStarters().every((t) => E.starter(t.id) && E.starter(t.id).objects.length >= 2) && E.starter('room').objects.filter((o) => o.parent === 'table').length === 5, E.listStarters());

// ── my view: "me", forward, right
const F = E.frameOf(room(), ENV);
check('frame: forward is where the camera looks (on the ground), right is its right hand', nearV(F.forward, [0, 0, -1], 0.001) && nearV(F.right, [1, 0, 0], 0.001), F);
const F2 = E.frameOf(room(), { view: { position: [10, 5, 0], target: [0, 0, 0] } });
check('frame: turn the camera round and left / right follow it (standing at +x looking toward -x: my right is -z)', nearV(F2.forward, [-1, 0, 0], 0.001) && nearV(F2.right, [0, 0, -1], 0.001), F2);

// ── placement
let a = E.applyEdits(room(), [{ op: 'add_object', object: { type: 'mesh', mesh: 'sphere', name: '紅色球', radius: 0.5, material: { color: '#e53935' } }, place: { of: 'me', rel: 'left-front' } }], ENV);
let ball = get(a.spec, '紅色球');
check('place: "in front-left of me" -> in front of the camera (z smaller), left of it (x < 0), the sphere rests on the ground', a.applied.length === 1 && ball.position[0] < -0.5 && ball.position[2] < 10 && near(ball.position[1], 0.5, 0.001) && a.added[0] === ball.id, ball.position);
const rv = E.applyEdits(room(), [{ op: 'add_object', object: { type: 'mesh', mesh: 'sphere', name: 'R', radius: 0.5 }, place: { of: 'me', rel: 'left-front' } }], { view: { position: [10, 5, 0], target: [0, 0, 0] } }).spec;
check('place: the same words from another side give another place (looking toward -x, "left" is +z)', get(rv, 'R').position[2] > 0 && get(rv, 'R').position[0] < 10, get(rv, 'R').position);
a = E.applyEdits(a.spec, [{ op: 'add_object', object: { type: 'mesh', mesh: 'box', name: '盒子', size: [1, 1, 1] }, place: { of: '桌子', rel: 'above' } }], ENV);
let tbl = box(a.spec, '桌子'), bx = box(a.spec, '盒子');
check('place: "above the table" -> centred over it, its bottom on the table top (the box of the whole group)', near(bx.min[1], tbl.max[1], 0.01) && near(bx.center[0], tbl.center[0], 0.01) && near(bx.center[2], tbl.center[2], 0.01), { bx, tbl });
a = E.applyEdits(a.spec, [{ op: 'place_object', id: '盒子', place: { of: '桌子', rel: 'right' } }], ENV); tbl = box(a.spec, '桌子'); bx = box(a.spec, '盒子');
check('place: "right of the table" -> beyond its right edge (x), standing on the ground, not touching it', bx.min[0] >= tbl.max[0] - 0.001 && bx.min[0] - tbl.max[0] < 0.2 && near(bx.min[1], tbl.min[1], 0.01), { bx: bx.min, tbl: tbl.max });
a = E.applyEdits(a.spec, [{ op: 'place_object', id: '盒子', place: { of: '桌子', rel: 'left' } }, { op: 'place_object', id: '紅色球', place: { of: '桌子', rel: 'back' } }], ENV); tbl = box(a.spec, '桌子');
check('place: left of the table is -x, behind it (away from the viewer on this side: toward the camera) is +z', box(a.spec, '盒子').max[0] <= tbl.min[0] + 0.001 && box(a.spec, '紅色球').min[2] >= tbl.max[2] - 0.001);
a = E.applyEdits(room(), [{ op: 'add_object', object: { type: 'mesh', mesh: 'box', name: 'A', size: [1, 1, 1] } }, { op: 'add_object', object: { type: 'mesh', mesh: 'box', name: 'B', size: [1, 1, 1] } }], ENV);
check('place: no place given -> the middle of the view, and a second one does not land on the first (steps to my right)', Math.abs(get(a.spec, 'A').position[0] - get(a.spec, 'B').position[0]) >= 1, [get(a.spec, 'A').position, get(a.spec, 'B').position]);
a = E.applyEdits(room(), [{ op: 'add_object', object: { type: 'mesh', mesh: 'box', name: 'M', size: [1, 1, 1] }, place: { of: 'me', rel: 'front', dist: 4, dx: 1 } }], ENV);
check('place: dist and dx are in my frame (4 ahead, 1 to my right)', nearV(get(a.spec, 'M').position, [1, 0.5, 6], 0.01), get(a.spec, 'M').position);
check('place: an unknown object or position is refused with the reason and nothing is added', (() => { const r = E.applyEdits(room(), [{ op: 'add_object', object: { type: 'mesh', mesh: 'box' }, place: { of: '不存在', rel: 'right' } }, { op: 'add_object', object: { type: 'mesh', mesh: 'box' }, place: { of: 'me', rel: 'sideways' } }], ENV); return r.applied.length === 0 && r.rejected.length === 2 && r.spec.objects.length === room().objects.length; })());

// ── the actions
a = E.applyEdits(room(), [{ op: 'transform_object', id: '桌子', move: [2, 0, 0] }], ENV);
check('transform: move is in my frame (2 to the right = +x here); the group carries its children', near(box(a.spec, '桌子').center[0] - box(room(), '桌子').center[0], 2, 0.001));
a = E.applyEdits(room(), [{ op: 'transform_object', id: '桌子', scale: 2 }], ENV);
check('transform: scaling a group scales its world box about its pivot (twice as wide); it stays on the ground', near(box(a.spec, '桌子').half[0], 2 * box(room(), '桌子').half[0], 0.01) && near(box(a.spec, '桌子').half[0] > 0 ? box(a.spec, '桌子').min[1] : 1, box(room(), '桌子').min[1], 0.01));
a = E.applyEdits(room(), [{ op: 'transform_object', id: '桌面', turn: 90 }]); const rot = get(a.spec, '桌面').rotation;
check('transform: turn adds degrees around the vertical axis', near(rot[1], Math.PI / 2, 0.01), rot);
a = E.applyEdits(room(), [{ op: 'add_object', object: { type: 'mesh', mesh: 'box', name: 'X', size: [1, 1, 1] }, place: { of: 'view', rel: 'center' } }, { op: 'transform_object', id: 'X', scale: 3 }]);
check('transform: a mesh is scaled in its own size and keeps its bottom on the ground', near(get(a.spec, 'X').size[0], 3, 0.001) && near(box(a.spec, 'X').min[1], 0, 0.001), box(a.spec, 'X'));
a = E.applyEdits(room(), [{ op: 'set_material', id: '桌子', color: '#00ff00', roughness: 0.2 }]);
check('set_material on a group colours every part of it', E.descendants(a.spec, 'table').every((o) => o.material.color === '#00ff00' && o.material.roughness === 0.2));
check('set_material: a texture must be a builtin, ref: or an address; a bad colour is refused', (() => { const x = E.applyEdits(room(), [{ op: 'set_material', id: '地板', texture: 'grass', texture_repeat: [4, 4] }, { op: 'set_material', id: '地板', texture: 'zzz' }, { op: 'set_material', id: '地板', color: 'x y' }]); return x.applied.length === 1 && x.rejected.length === 2 && get(x.spec, '地板').material.texture === 'grass' && get(x.spec, '地板').material.texture_repeat[0] === 4; })());
a = E.applyEdits(room(), [{ op: 'remove_object', id: '桌子' }]);
check('remove: a group goes with everything in it', a.spec.objects.length === room().objects.length - 6 && !a.spec.objects.some((o) => o.parent === 'table'));
a = E.applyEdits(room(), [{ op: 'duplicate_object', id: '桌子' }], ENV);
check('duplicate: a group is copied with its parts (new ids, the copy moved to my right)', a.spec.objects.length === room().objects.length + 6 && a.added.length === 1 && box(a.spec, '桌子 2').center[0] > box(a.spec, '桌子').center[0] + 1, a.added);
a = E.applyEdits(room(), [{ op: 'ungroup', id: '桌子' }]);
check('ungroup: the parts stay where they were in the world and the group is gone', a.spec.objects.length === room().objects.length - 1 && near(box(a.spec, '桌面').center[1], box(room(), '桌面').center[1], 0.001) && !a.spec.objects.some((o) => o.parent));
a = E.applyEdits(a.spec, [{ op: 'group_objects', ids: ['桌面', '桌腳 1'], name: '桌子2' }]);
check('group_objects: the objects keep their world places and are children of the new group', (() => { const g = get(a.spec, '桌子2'); return g && g.type === 'group' && get(a.spec, '桌面').parent === g.id && near(box(a.spec, '桌面').center[1], box(room(), '桌面').center[1], 0.001) && near(box(a.spec, '桌面').center[0], box(room(), '桌面').center[0], 0.001); })());
check('group_objects: objects on different levels are refused', (() => { const x = E.applyEdits(room(), [{ op: 'group_objects', ids: ['桌面', '地板'] }]); return x.applied.length === 0 && x.rejected.length === 1; })());
a = E.applyEdits(room(), [{ op: 'set_parent', id: '地板', parent: '桌子' }]);
check('set_parent keeps the world place; set_parent with no parent puts it back', (() => { const x = get(a.spec, '地板'); const y = E.applyEdits(a.spec, [{ op: 'set_parent', id: '地板', parent: null }]).spec; return x.parent === 'table' && near(box(a.spec, '地板').center[1], box(room(), '地板').center[1], 0.001) && !get(y, '地板').parent; })());
a = E.applyEdits(room(), [{ op: 'move_object', id: '桌面', to: 'later' }, { op: 'move_object', id: '桌腳 4', to: 'first' }]);
check('move_object reorders among the siblings only (the children stay under their group)', E.descendants(a.spec, 'table').map((o) => o.name).join() === '桌腳 4,桌腳 1,桌面,桌腳 2,桌腳 3', E.descendants(a.spec, 'table').map((o) => o.name));
a = E.applyEdits(room(), [{ op: 'set_camera', preset: 'front' }, { op: 'set_background', color: '#112233' }, { op: 'set_title', text: '我的房間' }]);
check('camera preset looks at the scene from the front; background and title', a.spec.camera.position[2] > a.spec.camera.look_at[2] && Math.abs(a.spec.camera.position[0] - a.spec.camera.look_at[0]) < 0.1 && a.spec.background === '#112233' && a.spec.title === '我的房間', a.spec.camera);
check('light: added at a height by default; a point light keeps its colour', (() => { const x = E.applyEdits(room(), [{ op: 'add_object', object: { type: 'light', light: 'point', color: '#ff0000', intensity: 2 }, place: { of: 'me', rel: 'front' } }], ENV); const l = x.spec.objects[x.spec.objects.length - 1]; return l.type === 'light' && l.color === '#ff0000' && l.position[1] >= 2; })());
check('align_objects lines boxes up (centres on x); drop_to_ground', (() => { let x = E.applyEdits(E.validate({ objects: [{ type: 'mesh', mesh: 'box', name: 'A', size: [1, 1, 1], position: [0, 3, 0] }, { type: 'mesh', mesh: 'sphere', name: 'B', radius: 1, position: [5, 1, 2] }] }).spec, [{ op: 'align_objects', ids: ['A', 'B'], axis: 'x', to: 'center' }, { op: 'drop_to_ground', id: 'A' }]); return near(box(x.spec, 'A').center[0], box(x.spec, 'B').center[0], 0.001) && near(box(x.spec, 'A').min[1], 0, 0.001); })());
check('every action is checked: unknown ones, bad ids and the host ones come back as rejected with a reason; the document is not changed by a refused one', (() => { const x = E.applyEdits(room(), [{ op: 'explode' }, { op: 'remove_object', id: 'zz' }, { op: 'find_picture', query: 'x' }, { op: 'update_object', id: '地板', props: { size: 'x' } }]); return x.applied.length === 1 && x.rejected.length === 3 && x.rejected.every((r) => r.error); })());
a = E.applyEdits(room(), [{ op: 'update_object', id: '桌面', props: { name: '桌板', color: '#112233', rotation_deg: [0, 45, 0] } }]);
check('update_object: name, colour, rotation in degrees', get(a.spec, '桌板') && get(a.spec, '桌板').material.color === '#112233' && near(get(a.spec, '桌板').rotation[1], Math.PI / 4, 0.01));

// ── skins: where a picture or a colour goes on an object
let sk = E.validate({ objects: [{ type: 'mesh', mesh: 'box', name: '模型', size: [2, 2, 2] }, { type: 'mesh', mesh: 'sphere', name: '球', radius: 1 }] }).spec;
a = E.applyEdits(sk, [{ op: 'add_skin', id: '模型', skin: { zone: '+z', color: '#ff0000', u: 0.5, v: 0.5, w: 0.5, h: 0.5 } }, { op: 'add_skin', id: '模型', skin: { zone: '+y', image: 'ref:abc', w: 1, h: 1 } }, { op: 'add_skin', id: '球', skin: { color: '#00f' } }, { op: 'add_skin', id: '模型', skin: {} }]);
check('add_skin: zones per shape, needs a picture or a colour; a sphere is one wrap surface', a.applied.length === 3 && a.rejected.length === 1 && get(a.spec, '模型').skins.length === 2 && get(a.spec, '球').skins[0].zone === 'wrap', a.rejected);
const sc = E.toScene(a.spec, { resolve: (r) => (r === 'ref:abc' ? 'data:image/png;base64,AAAA' : null) });
const decals = sc.nodes.filter((n) => n.mesh === 'plane');
check('toScene: a skin on a face is a thin plane lying on it, facing out, a little in front of the face', decals.length === 2 && decals.every((d) => d.material.side === 'double') && near(decals[0].position[2], 1, 0.02) && near(decals[0].size[0], 1, 0.001) && decals[1].material.texture === 'data:image/png;base64,AAAA' && near(decals[1].position[1], 1, 0.02), decals);
check('toScene: a skin whose picture is missing is left out; skins on a curved surface need a bake callback (given -> the texture is on the sphere)', (() => { const x = E.toScene(a.spec, { resolve: () => null }); const y = E.toScene(a.spec, { bake: (o, list) => ({ texture: 'data:image/png;base64,BBBB', color: '#ffffff' }), resolve: () => null }); return x.nodes.filter((n) => n.mesh === 'plane').length === 1 && y.nodes.filter((n) => n.mesh === 'sphere')[0].material.texture === 'data:image/png;base64,BBBB'; })());
check('toScene: every face looks outward — the decal plane faces away from the object centre for all six faces', (() => { const o = E.validate({ objects: [{ type: 'mesh', mesh: 'box', name: 'b', size: [2, 4, 6] }] }).spec; const zs = ['+x', '-x', '+y', '-y', '+z', '-z']; const sp = E.applyEdits(o, zs.map((z) => ({ op: 'add_skin', id: 'b', skin: { zone: z, color: '#fff' } }))).spec; return E.toScene(sp).nodes.filter((n) => n.mesh === 'plane').every((d, i) => { const R = E.rotMat(d.rotation), n = [R[0][2], R[1][2], R[2][2]], p = d.position, dot = n[0] * p[0] + n[1] * p[1] + n[2] * p[2]; return dot > 0.9; }); })());
check('toScene: skin place on a face (u, v, w, h, rotate) — v is up as seen from outside; the front face of a 2x2x2 box, u 0.75 v 0.75 lands at x +0.5, y +0.5', (() => { const o = E.applyEdits(E.validate({ objects: [{ type: 'mesh', mesh: 'box', name: 'b', size: [2, 2, 2] }] }).spec, [{ op: 'add_skin', id: 'b', skin: { zone: '+z', color: '#f00', u: 0.75, v: 0.75, w: 0.25, h: 0.25 } }]).spec; const d = E.toScene(o).nodes.filter((n) => n.mesh === 'plane')[0]; return near(d.position[0], 0.5, 0.01) && near(d.position[1], 0.5, 0.01) && near(d.size[0], 0.5, 0.001); })());
check('zoneAt: a point on the front of a box -> zone +z and its u / v; the top of a cylinder -> top; the side -> side', (() => { const b = E.validate({ objects: [{ type: 'mesh', mesh: 'box', size: [2, 2, 2] }, { type: 'mesh', mesh: 'cylinder', radius: 1, height: 2 }] }).spec; const z1 = E.zoneAt(b.objects[0], [0.5, 0.5, 1], [0, 0, 1]), z2 = E.zoneAt(b.objects[1], [0.2, 1, 0.3], [0, 1, 0]), z3 = E.zoneAt(b.objects[1], [1, 0, 0], [1, 0, 0]); return z1.zone === '+z' && near(z1.u, 0.75) && near(z1.v, 0.75) && z2.zone === 'top' && z3.zone === 'side'; })());

// ── out: a scene render_3d_scene can play; YAML both ways
const sc2 = E.toScene(room());
check('toScene: groups are gone (the parts are in the world), hidden objects are left out, lights are lights', (() => { const x = E.applyEdits(room(), [{ op: 'set_visible', id: '桌腳 1', visible: false }]).spec, y = E.toScene(x); return sc2.nodes.length === 6 && y.nodes.length === 5 && sc2.lights.length === 2 && sc2.nodes.every((n) => n.mesh && Array.isArray(n.position) && Array.isArray(n.rotation)); })());
check('toScene: a group moved and turned carries its parts (a part 1 unit right of the pivot, group turned 90 deg about y -> the part ends up 1 unit toward +z\'s side)', (() => { const sp = E.validate({ objects: [{ type: 'group', id: 'g', position: [10, 0, 0], rotation: [0, Math.PI / 2, 0], scale: 2 }, { type: 'mesh', mesh: 'box', parent: 'g', size: [1, 1, 1], position: [1, 0, 0] }] }).spec; const n = E.toScene(sp).nodes[0]; return nearV(n.position, [10, 0, -2], 0.01) && nearV(n.size, [2, 2, 2], 0.01) && near(n.rotation[1], Math.PI / 2, 0.01); })());
check('toScene: tags put the source object on every node (the viewer picks with it)', E.toScene(room(), { tags: true }).nodes.every((n) => n._src) && !JSON.stringify(sc2).includes('_src'));
const y1 = E.toYaml(a.spec), back = E.fromYaml(y1);
check('YAML: the editor\'s YAML reads back to the same scene (ids, names, groups, skins, hidden, locked, lights)', (() => { const sp0 = E.applyEdits(room(), [{ op: 'set_visible', id: '桌腳 1', visible: false }, { op: 'set_locked', id: '地板', locked: true }, { op: 'add_skin', id: '桌面', skin: { zone: '+y', color: '#ff00ff', u: 0.3 } }]).spec; const r = E.fromYaml(E.toYaml(sp0)); return r.ok && JSON.stringify(E.validate(r.spec).spec.objects.map((o) => [o.id, o.name, o.type, o.parent, o.visible, o.locked, o.mesh || o.light, o.skins && o.skins.length]).sort()) === JSON.stringify(sp0.objects.map((o) => [o.id, o.name, o.type, o.parent, o.visible, o.locked, o.mesh || o.light, o.skins && o.skins.length]).sort()); })(), back.error);
check('YAML: a plain render_3d_scene (no ids, lights on top, defs and use) is read; polygon and particles keep their own fields', (() => { const r = E.fromYaml('title: X\nbackground: "#001122"\ncamera: {position: [1,2,3], look_at: [0,0,0], fov: 40}\nlights:\n  - {type: point, position: [0,3,0], intensity: 2}\ndefs:\n  tree:\n    nodes:\n      - {mesh: cone, radius: 0.5, height: 1, position: [0,0.5,0]}\nnodes:\n  - {use: tree, position: [5,0,0], scale: 2}\n  - {mesh: polygon, vertices: [[0,0,0],[1,0,0],[0,1,0]], material: {color: "#fff"}, animation: spin}\n'); const sp = r.spec; const poly = sp.objects.filter((o) => o.mesh === 'polygon')[0]; return r.ok && sp.title === 'X' && sp.camera.fov === 40 && sp.objects.filter((o) => o.mesh === 'cone').length === 1 && near(sp.objects.filter((o) => o.mesh === 'cone')[0].position[0], 5, 0.001) && near(sp.objects.filter((o) => o.mesh === 'cone')[0].radius, 1, 0.001) && poly.extra.vertices.length === 3 && poly.extra.animation === 'spin' && sp.objects.some((o) => o.type === 'light' && o.intensity === 2) && E.toScene(sp).nodes.filter((n) => n.mesh === 'polygon')[0].animation === 'spin'; })());
check('YAML: a syntax error and a non-scene come back with a reason', (() => { const a1 = E.fromYaml('a: [1,'), a2 = E.fromYaml('- 1\n- 2'); return !a1.ok && /YAML/.test(a1.error) && !a2.ok; })());
check('YAML: toSceneYaml is the flattened scene (no ids, no groups) that parses to the same nodes', (() => { const t = E.toSceneYaml(room()), r = require('js-yaml').load(t); return r.nodes.length === 6 && !/mesh: group/.test(t) && !('id' in r.nodes[0]) && r.camera.fov === 50 && r.lights.length === 2; })());

// ── the words the program reads itself
const P = (t, sp) => E.parseCommands(t, sp || room());
let p = P('在我的左前方放一個紅色的球');
check('words: "put a red ball in front-left of me" -> add_object sphere, red, place me/left-front, no model needed', p.edits.length === 1 && p.unmatched.length === 0 && p.edits[0].op === 'add_object' && p.edits[0].object.mesh === 'sphere' && p.edits[0].object.material.color === '#e53935' && p.edits[0].place.of === 'me' && p.edits[0].place.rel === 'left-front', p);
p = P('放一個藍色方塊在桌子上面');
check('words: "a blue cube on the table" (object first) -> place of the table, above', p.edits.length === 1 && p.edits[0].object.mesh === 'box' && p.edits[0].object.material.color === '#1e88e5' && p.edits[0].place.of === 'table' && p.edits[0].place.rel === 'above', p);
p = P('在畫面中間加兩個綠色圓柱');
check('words: two cylinders in the middle of the view -> 2 add_objects (the second to the right of the first)', p.edits.length === 2 && p.edits[0].object.mesh === 'cylinder' && p.edits[0].place.of === 'view' && p.edits[1].place.of === 'selection' && p.edits[1].place.rel === 'right', p);
p = P('把桌子移到地板的右邊，然後把桌面改成紅色');
check('words: move X to the right of Y, and change a colour, in one sentence', p.edits.length === 2 && p.edits[0].op === 'place_object' && p.edits[0].place.of === get(room(), '地板').id && p.edits[0].place.rel === 'right' && p.edits[1].op === 'set_material' && p.edits[1].color === '#e53935', p);
p = P('把桌子往左移 2 公尺，把桌子轉 90 度，把桌子放大一倍');
check('words: move left 2, turn 90 degrees, double it', p.edits.length === 3 && p.edits[0].move[0] === -2 && p.edits[1].turn === 90 && p.edits[2].scale === 2, p);
p = P('刪除桌子，隱藏地板，複製桌子，把桌子改名為書桌');
check('words: delete, hide, duplicate, rename', p.edits.map((e) => e.op).join() === 'remove_object,set_visible,duplicate_object,rename_object' && p.edits[1].visible === false && p.edits[3].name === '書桌', p);
p = P('視角切到上面，背景改成黑色，把視角拉遠');
check('words: camera preset, background, zoom out', p.edits.map((e) => e.op).join() === 'set_camera,set_background,set_camera' && p.edits[0].preset === 'top' && p.edits[1].color === '#212121' && p.edits[2].zoom < 1, p);
p = P('讓整個場景看起來更溫馨一點');
check('words: what no rule reads goes to the AI (unmatched), nothing is guessed', p.edits.length === 0 && p.unmatched.length === 1, p);
check('words: an end to end run — the words, the view, the result (a red ball in front-left of me ends up where the camera sees it)', (() => { const r = E.applyEdits(room(), P('在我的右前方放一個大的黃色球體').edits, ENV); const b = get(r.spec, r.spec.objects[r.spec.objects.length - 1].id); return r.applied.length === 1 && b.position[0] > 0.5 && b.position[2] < 10 && near(b.radius, 1, 0.001); })());

// ── the AI: the prompt and the reply
const pr = E.editPrompt(room(), '把桌子放到我的左邊', '', 'table', ENV);
check('prompt: names the closed actions, describes my view and every object, mentions the selection and the request', /place_object/.test(pr.system) && /add_skin/.test(pr.system) && /相機在/.test(pr.user) && /桌面/.test(pr.user) && /選取的物件:table/.test(pr.user) && /把桌子放到我的左邊/.test(pr.user));
check('reply: JSON with say and edits is read; actions not on the list are dropped and counted; the host ones are kept', (() => { const r = E.parseEditsReply('好的\n{"say":"加了","edits":[{"op":"add_object","object":{"type":"mesh","mesh":"box"}},{"op":"explode"},{"op":"find_picture","query":"wood"}],}'); return r.ok && r.say === '加了' && r.edits.length === 2 && r.dropped === 1 && !E.parseEditsReply('no json').ok; })());
check('prompt of the steps: the effective ones in order', /1\. 放球/.test(E.promptOf(room(), [{ text: '放球', summary: '新增球' }])) && /桌面/.test(E.promptOf(room(), [])));
check('editWords: a sentence for every action', E.OPS.every((op) => E.editWords({ op, id: 'o1', object: { mesh: 'box' }, place: { of: 'me', rel: 'front' } }).length > 1) && /我的左前方/.test(E.editWords({ op: 'add_object', object: { mesh: 'sphere' }, place: { of: 'me', rel: 'left-front' } })));

// the matrices are the ones three.js uses: Euler XYZ -> matrix -> Euler
check('math: Euler XYZ round trip, and Rx·Ry·Rz order (a 90 deg turn about y then x moves +z as three.js does)', (() => { const e = [0.3, -0.5, 1.1], back2 = E.matEuler(E.rotMat(e)); const m = E.rotMat([Math.PI / 2, 0, 0]); return nearV(back2, e, 0.002) && near(m[1][2], -1, 0.001) && near(m[2][1], 1, 0.001); })());

console.log('edit3d_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n  ' + bad.join('\n  ') : ''));
process.exit(bad.length ? 1 : 0);
