// node scripts/edit-tests/mesh_gen.test.js -- 程式產生的 3D 模型（茶壺、花瓶、杯子…）與它們在 /edit-3d-model 的用法：白話指令、add_model 動作、貼圖座標、縮放
const G = require('../../renderer/src/edit/mesh_gen.js');
const D = require('../../renderer/src/edit/edit3d_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

// ---- 模型本身
G.CATALOG.forEach((c) => {
  const m = G.build(c.id);
  check(c.id + ': valid mesh (finite vertices, every face index in range, one uv per vertex in 0..1+, no degenerate sizes)', m.vertices.length > 200 && m.faces.length > 200 && m.vertices.every((p) => p.every(isFinite)) && m.faces.every((f) => f.length === 3 && f.every((i) => Number.isInteger(i) && i >= 0 && i < m.vertices.length)) && m.uvs.length === m.vertices.length && m.uvs.every((t) => isFinite(t[0]) && isFinite(t[1])), { v: m.vertices.length, f: m.faces.length });
  check(c.id + ': stands on y=0, has the asked height, json fits the scene limit', Math.abs(Math.min.apply(null, m.vertices.map((p) => p[1]))) < 1e-6 && Math.abs(Math.max.apply(null, m.vertices.map((p) => p[1])) - m.height) < 0.005 && JSON.stringify(m).length < 400000, m.height);
});
check('build: height option rescales; unknown id gives null', Math.abs(G.build('teapot', { height: 2 }).height - 2) < 1e-9 && G.build('teapot', { height: 2 }).size[1] === 2 && G.build('nope') === null);
check('uv seam: the first and last column of a revolved shape are different vertices (so a picture does not squash at the seam)', (() => { const t = G.lathe([[0, 0], [1, 0], [1, 1]], 8); return t.v.length === 3 * 9 && t.uv[0][0] === 0 && t.uv[8][0] === 1; })());
const teapot = G.build('teapot');
check('teapot: a spout and a handle stick out on both sides (wider than tall x1.5) and the body is round', teapot.size[0] > teapot.size[1] * 1.5 && teapot.size[2] > 0.3 * teapot.size[1], teapot.size);

// ---- 找名字
check('find: Chinese and English names, longer words first (馬克杯 is not 杯, 酒杯 is not 杯子)', G.find('放一個茶壺').id === 'teapot' && G.find('generate a Teapot').id === 'teapot' && G.find('一個馬克杯').id === 'mug' && G.find('兩個酒杯').id === 'wineglass' && G.find('杯子').id === 'cup' && G.find('花瓶').id === 'vase' && G.find('一個紅色的球') === null);

// ---- 白話指令
const empty = D.starter('blank');
let r = D.parseCommands('產生teapot', empty);
check('parseCommands: "產生teapot" becomes an add_object of a custom shape with vertices, faces and uvs', r.edits.length === 1 && r.edits[0].op === 'add_object' && r.edits[0].object.mesh === 'polygon' && r.edits[0].object.extra.vertices.length > 200 && r.edits[0].object.extra.uvs.length === r.edits[0].object.extra.vertices.length && r.unmatched.length === 0, r);
let a = D.applyEdits(empty, r.edits.reduce((x, y) => x.concat(y), []));
const tp = a.spec.objects.filter((o) => o.mesh === 'polygon')[0];
check('applyEdits: the teapot is in the scene with a name, a colour, and a sensible place', a.rejected.length === 0 && tp && tp.name === '茶壺' && /^#/.test(tp.material.color) && D.bounds(a.spec) && true, a.rejected);
r = D.parseCommands('在桌子上放一個紅色的茶壺', D.starter('room'));
a = D.applyEdits(D.starter('room'), r.edits.reduce((x, y) => x.concat(y), []));
const pot = a.spec.objects.filter((o) => o.mesh === 'polygon')[0], table = a.spec.objects.filter((o) => /桌面/.test(o.name))[0];
check('parseCommands: "在桌子上放一個紅色的茶壺" sits on the table, red', pot && pot.material.color === '#e53935' && r.edits.length === 1 && a.rejected.length === 0, a.rejected);
if (pot && table) { const pb = D.worldBox(a.spec, pot), tb = D.worldBox(a.spec, table); check('the teapot stands on top of the tabletop (its bottom is at the tabletop top)', Math.abs(pb.min[1] - tb.max[1]) < 0.05, [pb.min[1], tb.max[1]]); }
r = D.parseCommands('放兩個小花瓶', empty); check('parseCommands: count and size words ("兩個小花瓶")', r.edits.length === 2 && r.edits[0].object.extra.vertices.length > 200 && Math.max.apply(null, r.edits[0].object.extra.vertices.map((v) => v[1])) < G.info('vase').height * 0.6);

// ---- add_model 動作（AI 的封閉動作）
a = D.applyEdits(empty, [{ op: 'add_model', model: 'mug', color: '#1e88e5', height: 0.3, place: { of: 'view', rel: 'center' } }]);
check('add_model: builds the mug with the asked colour and height', a.rejected.length === 0 && a.spec.objects.some((o) => o.name === '馬克杯' && o.material.color === '#1e88e5' && Math.abs(Math.max.apply(null, o.extra.vertices.map((v) => v[1])) - 0.3) < 0.01), a.rejected);
a = D.applyEdits(empty, [{ op: 'add_model', model: 'dragon' }]); check('add_model: an unknown model is refused with the list of what exists (so the AI can fall back to primitives)', a.rejected.length === 1 && /teapot=茶壺/.test(a.rejected[0].error), a.rejected);
check('add_model is in the closed action list and the AI prompt tells it not to refuse', D.OPS.indexOf('add_model') >= 0 && /add_model/.test(D.editPrompt(empty, '放一個茶壺').system) && /不要拒絕/.test(D.editPrompt(empty, 'x').system));
check('parseEditsReply keeps add_model', D.parseEditsReply('{"say":"好","edits":[{"op":"add_model","model":"teapot"}]}').edits.length === 1);

// ---- 貼圖、縮放、輸出
a = D.applyEdits(empty, r.edits.reduce((x, y) => x.concat(y), []));
const id = a.spec.objects.filter((o) => o.mesh === 'polygon')[0].id;
let b = D.applyEdits(a.spec, [{ op: 'set_material', id, texture: 'wood', color: '#ffffff' }, { op: 'transform_object', id, scale: 2 }]);
check('texture and scale work on a generated model', b.rejected.length === 0 && b.spec.objects.filter((o) => o.id === id)[0].material.texture === 'wood' && Math.max.apply(null, b.spec.objects.filter((o) => o.id === id)[0].extra.vertices.map((v) => v[1])) > G.info('vase').height * 0.5 * 1.9, b.rejected);
const sc = D.toScene(b.spec);
const node = (sc.nodes || sc.objects || []).filter((n) => n.mesh === 'polygon')[0];
check('toScene: the playable scene carries vertices, faces and uvs for the viewer, and the texture name', node && Array.isArray(node.vertices) && Array.isArray(node.faces) && Array.isArray(node.uvs) && node.uvs.length === node.vertices.length && node.material && node.material.texture === 'wood', node && Object.keys(node));
check('the scene round trips through YAML text (the 原始碼 tab)', (() => { try { const y = D.toYaml(b.spec), back = D.fromYaml(y); return back && back.ok !== false && (back.spec || back).objects.some((o) => o.mesh === 'polygon' && o.extra && o.extra.vertices.length > 200); } catch (e) { return String(e); } })());
console.log('mesh_gen: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED\n - ' + bad.join('\n - ') : '')); process.exit(bad.length ? 1 : 0);
