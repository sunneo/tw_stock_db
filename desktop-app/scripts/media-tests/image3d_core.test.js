// node scripts/media-tests/image3d_core.test.js
const assert = require('assert');
const C = require('../../renderer/src/media/image3d_core.js');

let pass = 0;
function t(name, fn) { try { fn(); pass++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); process.exitCode = 1; } }
function grid(w, h, f) { const a = []; for (let y = 0; y < h; y++) { a.push([]); for (let x = 0; x < w; x++) { a[y].push(f(x, y)); } } return a; }
const ramp = (w, h) => grid(w, h, (x, y) => (x + y) / (w + h));

t('isClosed: 方塊是封閉的', () => assert(C.isClosed(C.boxMesh(0, 0, 1, 1, 0, 1))));
t('isClosed: 少一個面不封閉', () => { const m = C.boxMesh(0, 0, 1, 1, 0, 1); m.faces.pop(); assert(!C.isClosed(m)); });
t('isClosed: 退化面不合格', () => { const m = C.boxMesh(0, 0, 1, 1, 0, 1); m.faces[0] = [m.faces[0][0], m.faces[0][0], m.faces[0][1]]; assert(!C.isClosed(m)); });
t('isClosed: 面反向（不一致）不合格', () => { const m = C.boxMesh(0, 0, 1, 1, 0, 1); m.faces[0] = m.faces[0].slice().reverse(); assert(!C.isClosed(m)); });

for (const shape of ['cylinder', 'blocks', 'auto']) {
  t('圓形遮罩封閉 (' + shape + ')', () => {
    const W = 40, H = 40, mask = grid(W, H, (x, y) => ((x - 20) ** 2 + (y - 20) ** 2 < 14 * 14 ? 1 : 0));
    const r = C.buildObject(mask, ramp(W, H), { shape });
    assert(r && C.isClosed(r.mesh), JSON.stringify(r && { s: r.shape, n: r.notes }));
    if (shape !== 'auto') { assert.strictEqual(r.shape, shape); assert(!r.fallback); }
  });
  t('L 形遮罩封閉 (' + shape + ')', () => {
    const W = 30, H = 30, mask = grid(W, H, (x, y) => ((x >= 5 && x < 12 && y >= 4 && y < 26) || (x >= 5 && x < 25 && y >= 19 && y < 26) ? 1 : 0));
    const r = C.buildObject(mask, ramp(W, H), { shape });
    assert(r && C.isClosed(r.mesh));
    if (shape !== 'auto') { assert.strictEqual(r.shape, shape); }
  });
}

t('中間有洞的遮罩 (auto 走方塊) 封閉', () => {
  const W = 30, H = 30, mask = grid(W, H, (x, y) => (x >= 3 && x < 27 && y >= 3 && y < 27 && !(x >= 11 && x < 19 && y >= 11 && y < 19) ? 1 : 0));
  const r = C.buildObject(mask, ramp(W, H), {});
  assert(r && C.isClosed(r.mesh)); assert.strictEqual(r.shape, 'blocks');
});

t('只靠一個角相連的兩塊 (對角) 仍封閉', () => {
  const W = 20, H = 20, mask = grid(W, H, (x, y) => ((x < 10 && y < 10) || (x >= 10 && y >= 10) ? 1 : 0));
  const r = C.buildObject(mask, ramp(W, H), { shape: 'blocks' });
  assert(r && C.isClosed(r.mesh));
});

t('兩個分開的塊 (柱體) 各自封閉成同一個網格', () => {
  const W = 40, H = 20, mask = grid(W, H, (x, y) => ((x >= 2 && x < 14 && y >= 4 && y < 16) || (x >= 24 && x < 36 && y >= 4 && y < 16) ? 1 : 0));
  const r = C.buildObject(mask, ramp(W, H), { shape: 'cylinder' });
  assert(r && C.isClosed(r.mesh) && r.shape === 'cylinder');
});

t('面數上限', () => {
  const W = 60, H = 60, mask = grid(W, H, (x, y) => ((x - 30) ** 2 + (y - 30) ** 2 < 26 * 26 ? 1 : 0));
  const dep = grid(W, H, (x, y) => Math.sin(x / 5) * Math.cos(y / 5));
  for (const shape of ['cylinder', 'blocks']) {
    const small = C.buildObject(mask, dep, { shape, maxFaces: 300 }), big = C.buildObject(mask, dep, { shape, maxFaces: 12000 });
    assert(small.mesh.faces.length <= 300, shape + ' small ' + small.mesh.faces.length);
    assert(big.mesh.faces.length <= 12000 && big.mesh.faces.length > small.mesh.faces.length, shape + ' big');
    assert(C.isClosed(small.mesh) && C.isClosed(big.mesh));
  }
});

t('面數上限太小退回外框方塊（仍封閉）', () => {
  const W = 20, H = 20, mask = grid(W, H, (x, y) => ((x - 10) ** 2 + (y - 10) ** 2 < 64 ? 1 : 0));
  const r = C.buildObject(mask, ramp(W, H), { maxFaces: 12 });
  assert(r.shape === 'box' && r.fallback && C.isClosed(r.mesh));
});

t('前表面貼著深度：近的地方 z 較大', () => {
  const W = 20, H = 20, mask = grid(W, H, () => 1), dep = grid(W, H, (x) => x / W);
  const r = C.buildObject(mask, dep, { shape: 'blocks' });
  const zOf = (px) => Math.max.apply(null, r.mesh.vertices.filter((v) => Math.abs(v[0] - px) < 3).map((v) => v[2]));
  assert(zOf(18) > zOf(2));
});

t('空遮罩回傳 null', () => assert.strictEqual(C.buildObject(grid(5, 5, () => 0), ramp(5, 5), {}), null));

t('fillBackground：被挖掉的格子由周圍補平', () => {
  const dep = grid(9, 9, () => 0.5), unk = grid(9, 9, (x, y) => (x > 2 && x < 6 && y > 2 && y < 6));
  dep[4][4] = 99;
  const f = C.fillBackground(dep, unk);
  for (let y = 0; y < 9; y++) { for (let x = 0; x < 9; x++) { assert(Math.abs(f[y][x] - 0.5) < 1e-9); } }
});

t('場景：兩個物件加背景，全部封閉', () => {
  const W = 48, H = 32, labels = grid(W, H, (x, y) => (((x - 14) ** 2 + (y - 16) ** 2 < 64) ? 1 : (x >= 28 && x < 42 && y >= 8 && y < 24 ? 2 : 0)));
  const dep = grid(W, H, (x, y) => (labels[y][x] ? 0.8 : 0.2) + x / 400);
  for (const mode of ['objects', 'all']) {
    const s = C.buildScene({ labels, depth: dep }, { closeMode: mode });
    assert.strictEqual(s.objects.length, 2); assert.strictEqual(s.closeMode, mode);
    s.objects.forEach((o) => assert(C.isClosed(o.mesh), 'object ' + o.id));
    assert(s.background && C.isClosed(s.background.mesh), 'background');
    const total = s.objects.reduce((a, o) => a + o.mesh.faces.length, 0) + s.background.mesh.faces.length;
    assert(total <= 12000, 'total ' + total);
    s.objects.forEach((o) => o.mesh.vertices.forEach((v) => assert(v[0] >= 0 && v[0] <= 1.0001 && v[1] >= 0 && v[1] <= 1.0001)));
  }
});

t('隨機遮罩與深度（固定種子）：每個結果都封閉，方塊殼不退回外框', () => {
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let boxes = 0;
  for (let n = 0; n < 40; n++) {
    const W = 24 + Math.floor(rnd() * 24), H = 24 + Math.floor(rnd() * 24), blobs = [];
    for (let b = 0; b < 4; b++) { blobs.push([rnd() * W, rnd() * H, 3 + rnd() * 9]); }
    const mask = grid(W, H, (x, y) => (blobs.some((o) => (x - o[0]) ** 2 + (y - o[1]) ** 2 < o[2] * o[2]) ? 1 : 0));
    const dep = grid(W, H, () => rnd());
    for (const shape of ['blocks', 'cylinder', 'auto']) {
      const r = C.buildObject(mask, dep, { shape });
      if (!r) { continue; }
      assert(C.isClosed(r.mesh), 'case ' + n + ' ' + shape);
      if (shape === 'blocks' && r.shape === 'box') { boxes++; }
    }
  }
  assert.strictEqual(boxes, 0);
});

console.log(pass + ' passed' + (process.exitCode ? ', with failures' : ''));
