// node scripts/edit-tests/subject_3d.test.js -- 不認識的東西(3D):GitHub 公開 OBJ 的搜尋挑選、OBJ 解析、縮減面數、擺正、變成編輯器物件
const M = require('../../renderer/src/edit/subject_3d.js');
const D = require('../../renderer/src/edit/edit3d_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const sub = { name: '兔子', en: 'bunny' };

check('repoSearchUrl: public repositories, the English name, obj', /^https:\/\/api\.github\.com\/search\/repositories\?/.test(M.repoSearchUrl(sub)) && /bunny%20obj/.test(M.repoSearchUrl(sub)));
const repos = { items: [
  { full_name: 'a/bunny-obj', name: 'bunny-obj', description: 'a bunny 3d model', topics: ['obj'], license: { spdx_id: 'MIT' }, stargazers_count: 5, default_branch: 'master', size: 900, fork: false },
  { full_name: 'b/bunny-gpl', name: 'bunny', description: 'bunny', license: { spdx_id: 'GPL-3.0' }, stargazers_count: 99, size: 10 },
  { full_name: 'c/nolicense', name: 'bunny', description: 'bunny', license: null, stargazers_count: 99, size: 10 },
  { full_name: 'd/huge-bunny', name: 'huge-bunny', description: 'x', license: { spdx_id: 'MIT' }, stargazers_count: 50, size: 900000 },
  { full_name: 'e/other', name: 'tools', description: 'a toolbox', license: { spdx_id: 'MIT' }, stargazers_count: 200, size: 10 },
  { full_name: 'f/bunnies-cc0', name: 'models', description: 'Bunnies and rabbits', license: { spdx_id: 'CC0-1.0' }, stargazers_count: 40, size: 10, default_branch: 'main' }] };
const pr = M.pickRepos(repos, sub);
check('pickRepos: permissive licences first (most stars first), then public repositories with no licence at all; copyleft and huge ones are skipped; the name must be in the name/description/topics', pr.length === 3 && pr[0].full === 'f/bunnies-cc0' && pr[1].full === 'a/bunny-obj' && pr[1].branch === 'master' && pr[1].license === 'mit' && pr[2].full === 'c/nolicense' && pr[2].license === 'none' && !pr.some((x) => x.full === 'b/bunny-gpl' || x.full === 'd/huge-bunny'), pr);
check('pickRepos: empty or odd input gives nothing', M.pickRepos({}, sub).length === 0 && M.pickRepos(null, sub).length === 0 && M.pickRepos(repos, { name: 'x', en: '' }).length === 0);
check('treeUrl and rawUrl: recursive tree of the branch; raw file with encoded path', /repos\/a\/bunny-obj\/git\/trees\/master\?recursive=1/.test(M.treeUrl(pr[1])) && M.rawUrl(pr[1], 'models/my bunny.obj') === 'https://raw.githubusercontent.com/a/bunny-obj/master/models/my%20bunny.obj');
const tree = { tree: [{ path: 'README.md', type: 'blob', size: 900 }, { path: 'models/teapot.obj', type: 'blob', size: 50000 }, { path: 'models/deep/dir/Bunny_high.OBJ', type: 'blob', size: 4000000 }, { path: 'bunny.obj', type: 'blob', size: 30000 }, { path: 'tiny/bunny.obj', type: 'blob', size: 100 }, { path: 'big/bunny.obj', type: 'blob', size: 99000000 }, { path: 'models', type: 'tree' }] };
check('pickObj: a .obj of a sensible size whose path has the name; the shallowest path, then the smallest file; tiny and huge files are skipped', M.pickObj(tree, sub, pr[1]).path === 'bunny.obj' && M.pickObj({ tree: [tree.tree[1]] }, sub, { full: 'x/y', description: '' }) === null);
check('pickObj: a single .obj in a repository that is about the thing is taken even if the path does not say so; otherwise not', M.pickObj({ tree: [{ path: 'model.obj', type: 'blob', size: 5000 }] }, sub, { full: 'a/bunny-obj', description: 'bunny' }).path === 'model.obj' && M.pickObj({ tree: [{ path: 'model.obj', type: 'blob', size: 5000 }, { path: 'other.obj', type: 'blob', size: 5000 }] }, sub, { full: 'a/bunny-obj', description: 'bunny' }) === null);

const cube = ['# cube', 'v -1 -1 -1', 'v 1 -1 -1', 'v 1 1 -1', 'v -1 1 -1', 'v -1 -1 1', 'v 1 -1 1', 'v 1 1 1', 'v -1 1 1', 'vt 0 0', 'vt 1 0', 'vt 1 1', 'vt 0 1', 'vn 0 0 1',
  'f 1/1/1 2/2/1 3/3/1 4/4/1', 'f 5/1 6/2 7/3 8/4', 'f 1//1 2//1 6//1 5//1', 'f -4 -3 -2 -1'].join('\n');
const po = M.parseObj(cube);
check('parseObj: quads become triangles, v/vt/vn and v//vn and negative indices work, uvs line up with vertices', po.ok && po.faces === 8 && po.mesh.uvs && po.mesh.uvs.length === po.mesh.vertices.length && po.mesh.faces.every((f) => f.every((i) => i >= 0 && i < po.mesh.vertices.length)), po);
check('parseObj: without texture coordinates there are no uvs; a file without faces, or garbage, is refused', M.parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3').mesh.uvs === null && !M.parseObj('v 0 0 0\nv 1 1 1').ok && !M.parseObj('hello').ok && !M.parseObj('').ok);
check('parseObj: degenerate faces and unknown lines are skipped', M.parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl x\ns off\nf 1 1 2\nf 1 2 3').faces === 1);
// 很大的模型:球面格子 200x200 = 8 萬面
function sphere(n) { const L = []; for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) { const th = Math.PI * i / n, ph = 2 * Math.PI * j / n; L.push('v ' + (Math.sin(th) * Math.cos(ph)).toFixed(5) + ' ' + Math.cos(th).toFixed(5) + ' ' + (Math.sin(th) * Math.sin(ph)).toFixed(5)); } for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const a = i * (n + 1) + j + 1, b = a + 1, c = a + n + 1, d = c + 1; L.push('f ' + a + ' ' + b + ' ' + d + ' ' + c); } return L.join('\n'); }
const big = M.parseObj(sphere(200), { maxFaces: 6000 });
check('parseObj: a huge model is cut down to the face budget and keeps its shape (the box stays about the same)', big.ok && big.original.faces > 70000 && big.faces <= 6000 && big.faces > 800 && (() => { const b = M.bbox(big.mesh.vertices); return Math.abs((b.max[0] - b.min[0]) - 2) < 0.2 && Math.abs((b.max[1] - b.min[1]) - 2) < 0.2; })(), [big.original, big.faces]);

const fitted = M.fit(po.mesh, 0.3), fb = M.bbox(fitted.vertices);
check('fit: centred on x and z, the bottom on the ground, the longest side as asked', Math.abs(fb.min[1]) < 1e-6 && Math.abs(fb.max[1] - 0.3) < 1e-3 && Math.abs(fb.min[0] + fb.max[0]) < 1e-3 && Math.abs(fb.min[2] + fb.max[2]) < 1e-3 && fitted.zUp === false, fb);
const zup = { vertices: [[0, 0, 0], [1, 0, 0], [0, 0.5, 0], [0, 0, 4], [1, 0.5, 4]], faces: [[0, 1, 2], [2, 3, 4]], uvs: null }, fz = M.fit(zup, 1), fzb = M.bbox(fz.vertices);
check('fit: a model standing along z (Z-up export) is turned to stand along y', fz.zUp === true && fzb.max[1] > fzb.max[2] && Math.abs(fzb.max[1] - 1) < 1e-3, fz);
const obj = M.toObject(sub, fitted, { color: '#aa8855' }), applied = D.applyEdits(D.starter('blank'), [{ op: 'add_object', object: obj }]);
check('toObject: the editor accepts it as a custom shape with vertices, faces and uvs; the colour is kept', applied.rejected.length === 0 && applied.spec.objects.some((o) => o.mesh === 'polygon' && o.name === '兔子' && o.extra.faces.length === 8 && o.extra.uvs.length === o.extra.vertices.length && o.material.color === '#aa8855'), applied.rejected);
check('assetNote: tells the model the model is placed and how to arrange it', /不要再用圖元拼/.test(M.assetNote([{ name: '兔子' }])) && M.assetNote([]) === '');

// ---- 第三階:背景切除與分解結果
function disc(w, h, r, fgc, bgc) { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = (y * w + x) * 4, inside = Math.hypot(x - w / 2, y - h / 2) <= r, c = inside ? fgc : bgc; d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255; } return { width: w, height: h, data: d }; }
const white = disc(60, 40, 14, [200, 130, 50], [255, 255, 255]), bm = M.bgMask(white);
check('bgMask: the plain border colour is the background, the object in the middle is the foreground', bm.bg.join() === '255,255,255' && bm.fg > 0.2 && bm.fg < 0.35 && bm.mask[20 * 60 + 30] === 1 && bm.mask[0] === 0 && bm.mask[39 * 60 + 59] === 0, [bm.fg, bm.bg]);
const grey = disc(60, 40, 14, [200, 130, 50], [90, 100, 110]), bg2 = M.bgMask(grey);
check('bgMask: a dark background works too; an object of the same colour as its background is lost (fg tiny), which the caller treats as unusable', bg2.fg > 0.2 && bg2.bg.join() === '90,100,110' && M.bgMask(disc(60, 40, 14, [250, 250, 250], [255, 255, 255])).fg < 0.02);
const hole = disc(60, 40, 14, [200, 130, 50], [255, 255, 255]); for (let y = 15; y < 25; y++) for (let x = 25; x < 35; x++) { const k = (y * 60 + x) * 4; hole.data[k] = hole.data[k + 1] = hole.data[k + 2] = 255; }
check('bgMask: white inside the object (not connected to the border) stays foreground', M.bgMask(hole).mask[20 * 60 + 30] === 1);
const sceneJson = JSON.stringify({ nodes: [{ id: 'image-model', mesh: 'polygon', vertices: [[-5, -3, 1], [5, -3, 1], [5, 3, 1], [-5, 3, 1], [0, 0, 2]], faces: [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]], material: { texture: 'data:image/jpeg;base64,AAAA', color: '#fff' } }] });
const ps = M.parseScene(sceneJson);
check('parseScene: takes the polygon node (vertices, faces, uvs) and its texture; other text gives null', ps && ps.mesh.vertices.length === 5 && ps.mesh.uvs.length === 5 && /^data:image\/jpeg/.test(ps.texture) && M.parseScene('x') === null && M.parseScene('{"nodes":[]}') === null && M.parseScene(JSON.stringify({ nodes: [{ mesh: 'polygon', vertices: [[0, 0, 0]], faces: [], uvs: [] }] })) === null);
// 底邊兩個三角形的中心在圖的下方背景、其餘在前景:用一張下半是背景的遮罩
const m2 = new Uint8Array(60 * 40); for (let y = 0; y < 20; y++) for (let x = 0; x < 60; x++) m2[y * 60 + x] = 1;   // 上半(圖的上方)是前景
const cut = M.cutBackground(ps.mesh, m2, 60, 40);
check('cutBackground: triangles whose centre falls on the background are dropped, the used vertices are kept and renumbered (v=1 is the top of the picture)', cut.total === 4 && cut.kept === 1 && cut.faces.length === 1 && cut.vertices.length === 3 && cut.uvs.length === 3 && cut.faces[0].every((i) => i < 3), cut);
check('cutBackground: a mask that is all foreground keeps everything', M.cutBackground(ps.mesh, new Uint8Array(60 * 40).fill(1), 60, 40).kept === 4);
const slab = { vertices: [[-5, -3, 1], [5, -3, 1.1], [5, 3, 1.2], [-5, 3, 1.1], [0, 0, 1.4]], faces: [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]] };
const thin = M.fit(slab, 0.3), thick = M.fit(slab, 0.3, { depthRatio: 0.4 }), tb = M.bbox(thick.vertices);
check('fit with depthRatio: a thin relief is made at least 40% as deep as its smaller side; a relief that is deep enough, or no option, is left alone', thin.size_m[2] < 0.03 && Math.abs((tb.max[2] - tb.min[2]) - 0.4 * 0.18) < 0.004 && thick.size_m[2] > 0.06 && M.fit(slab, 0.3).size_m[2] === thin.size_m[2], [thin.size_m, thick.size_m]);
check('toObject: a textured object is drawn on both sides; the editor keeps the texture and side', (() => { const o = M.toObject({ name: '蘋果' }, thick, { texture: 'data:image/jpeg;base64,AAAA' }), a = D.applyEdits(D.starter('blank'), [{ op: 'add_object', object: o }]); const m = a.spec.objects.find((x) => x.mesh === 'polygon'); return a.rejected.length === 0 && m.material.side === 'double' && /^data:image/.test(m.material.texture); })());
console.log('subject_3d: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED\n - ' + bad.join('\n - ') : '')); process.exit(bad.length ? 1 : 0);
