const K = require('./skin_core.js');
let ok = 0, bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const near = (a, b, e) => Math.abs(a - b) < (e || 1e-3);
const joints = [{ name: 'root', parent: null, pos: [0, 0, 0] }, { name: 'elbow', parent: 'root', pos: [1, 0, 0] }, { name: 'hand', parent: 'elbow', pos: [2, 0, 0] }];
const motion = { name: 'bend', duration: 2, loop: true, ease: 'linear', tracks: [{ joint: 'elbow', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1, rot: [0, 0, Math.PI / 2] }, { t: 2, rot: [0, 0, 0] }] }] };
const verts = [[0, 0, 0], [0.2, 0.1, 0], [1.9, 0, 0], [2, 0, 0], [20, 20, 0]];
const rig = K.prepare({ skeleton: { joints }, motions: [motion], static_radius: 6 }, verts);
const out = new Float32Array(verts.length * 3);
// 靜止姿勢＝原位置
let m0 = rig.pose('bend', 0); rig.apply(verts, m0, out);
check('rest pose leaves vertices', verts.every((v, i) => near(out[i * 3], v[0]) && near(out[i * 3 + 1], v[1])), Array.from(out));
// 手肘轉 90°：手尖（2,0,0）繞手肘（1,0,0）→（1,1,0）
let m1 = rig.pose('bend', 1); rig.apply(verts, m1, out);
check('hand tip follows elbow rotation', near(out[3 * 3], 1, 0.15) && near(out[3 * 3 + 1], 1, 0.15), [out[9], out[10]]);
check('vertex at root stays', near(out[0], 0, 0.05) && near(out[1], 0, 0.05), [out[0], out[1]]);
check('far vertex is static', near(out[12], 20) && near(out[13], 20), [out[12], out[13]]);
check('weights normalised', Array.from({ length: verts.length }, (_, v) => [0, 1, 2, 3].reduce((s, k) => s + rig.weights.w[v * 4 + k], 0)).every((s) => near(s, 1)));
check('upper-arm vertex mostly follows root (barely moves)', Math.hypot(out[3] - 0.2, out[4] - 0.1) < 0.35, [out[3], out[4]]);
// 循環、loop、非 loop
const m3 = rig.pose('bend', 3); rig.apply(verts, m3, out); check('loop wraps (t=3 ≡ t=1)', near(out[9], 1, 0.15) && near(out[10], 1, 0.15));
const rig2 = K.prepare({ skeleton: { joints }, motions: [Object.assign({}, motion, { loop: false })] }, verts); const mm = rig2.pose('bend', 99); check('non-loop holds the end', mm.every((v, i) => near(v, rig2.pose('bend', 2)[i])));
check('ease in_out changes midpoint value', (() => { const e = K.evalTrack([{ t: 0, rot: [0, 0, 0] }, { t: 1, rot: [0, 0, 1] }], 0.25, 'ease_in'); return near(e[2], 0.0625); })());
let err = null; try { K.prepare({ skeleton: { joints: [{ name: 'a', parent: 'b', pos: [0, 0, 0] }, { name: 'b', parent: 'a', pos: [0, 0, 0] }] } }, verts); } catch (e) { err = e.message; } check('cycle rejected', /循環/.test(err || ''), err);
err = null; try { K.prepare({ skeleton: { joints: [{ name: 'a', parent: 'zz', pos: [0, 0, 0] }] } }, verts); } catch (e) { err = e.message; } check('missing parent rejected', /不存在/.test(err || ''), err);
// 限制：rot_max 把 90° 夾到 0.5
const lj = joints.map((j) => Object.assign({}, j)); lj[1].limits = { min: [0, 0, -0.5], max: [0, 0, 0.5] };
const rig3 = K.prepare({ skeleton: { joints: lj }, motions: [motion] }, verts); rig3.apply(verts, rig3.pose('bend', 1), out); check('joint limits clamp the rotation', out[9] > 1.5 && out[10] < 0.6, [out[9], out[10]]);
// 放置：relative 單位、y 往下→場景 y 往上
const placed = K.placeSkeleton({ joints: [{ name: 'neck', offset: [0, 0, 0] }, { name: 'head', parent: 'neck', offset: [0, -0.3, 0] }, { name: 'jaw', parent: 'head', offset: [0, 0.35, 0.05] }] }, { anchor: [0, 0, 0], scale: 10 });
check('placeSkeleton flips y and scales', near(placed.joints[1].pos[1], 3) && near(placed.joints[2].pos[1], -0.5) && near(placed.joints[2].pos[2], 0.5), placed.joints.map((j) => j.pos));
// 驗證
check('validate ok', K.validate({ skeleton: { joints }, motions: [motion] }, 5).length === 0);
check('validate catches bad track joint', K.validate({ skeleton: { joints }, motions: [{ name: 'x', duration: 1, tracks: [{ joint: 'nope', keys: [{ t: 0 }] }] }] }, 5).length === 1);
check('validate catches weight length', K.validate({ skeleton: { joints }, weights: [[[0, 1]]] }, 5).some((e) => /長度/.test(e)));
const ex = K.prepare({ skeleton: { joints }, weights: [[[0, 1]], [[0, 1]], [[1, 0.5], [2, 0.5]], [[2, 1]], [[-1, 1]]] }, verts); check('explicit weights accepted', ex.weights.idx[2 * 4] === 1 && near(ex.weights.w[2 * 4], 0.5));
console.log(ok + ' passed, ' + bad.length + ' failed', bad);
