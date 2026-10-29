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

t('labelComponents：兩塊、過小的雜點被丟掉、最大的是 1', () => {
  const m = grid(30, 20, (x, y) => ((x >= 2 && x < 10 && y >= 2 && y < 10) || (x >= 15 && x < 27 && y >= 5 && y < 18) || (x === 0 && y === 19) ? 1 : 0));
  const r = C.labelComponents(m, { minAreaFrac: 0.01 });
  assert.strictEqual(r.count, 2); assert.strictEqual(r.dropped, 1);
  assert.strictEqual(r.labels[10][20], 1); assert.strictEqual(r.labels[5][5], 2); assert.strictEqual(r.labels[19][0], 0);
});
t('resampleGrid：線性漸層縮放後仍是漸層，端點不變', () => {
  const g = C.resampleGrid(Array.from({ length: 16 }, (_, i) => i % 4), 4, 4, 7, 7);
  assert(Math.abs(g[0][0]) < 1e-9 && Math.abs(g[3][6] - 3) < 1e-9 && g[3][3] > g[3][2]);
});
t('prepareInput：深度圖與遮罩尺寸不同也能對上，輸出可直接 buildScene', () => {
  const depth = { w: 80, h: 60, data: Float32Array.from({ length: 4800 }, (_, i) => (i % 80) / 80) };
  const mask = { w: 160, h: 120, data: Uint8Array.from({ length: 19200 }, (_, i) => { const x = i % 160, y = Math.floor(i / 160); return ((x - 60) ** 2 + (y - 60) ** 2 < 1600 || (x > 110 && x < 150 && y > 20 && y < 90)) ? 1 : 0; }) };
  const p = C.prepareInput(depth, mask, { workMax: 64 });
  assert.strictEqual(p.count, 2); assert.strictEqual(p.width, 64); assert.strictEqual(p.height, 48);
  const s = C.buildScene({ labels: p.labels, depth: p.depth }, {});
  assert.strictEqual(s.objects.length, 2); s.objects.forEach((o) => assert(C.isClosed(o.mesh))); assert(C.isClosed(s.background.mesh));
  const w = C.prepareInput(depth, null, {}); assert.strictEqual(w.count, 1);
  const w2 = C.prepareInput(depth, mask, { mode: 'whole' }); assert.strictEqual(w2.count, 1);
  const e = C.prepareInput(depth, { w: 2, h: 2, data: [0, 0, 0, 0] }, {}); assert(e.empty && e.count === 1);
});

t('parseOptions：旗標、中文說法、預設', () => {
  assert.deepStrictEqual(C.parseOptions('').close, 'objects');
  assert.strictEqual(C.parseOptions('--close all --shape blocks').close, 'all');
  assert.strictEqual(C.parseOptions('--close all --shape blocks').shape, 'blocks');
  assert.strictEqual(C.parseOptions('我要能列印').close, 'all');
  assert.strictEqual(C.parseOptions('全部都要封閉').close, 'all');
  assert.strictEqual(C.parseOptions('蘋果要封閉').close, 'objects');
  assert.strictEqual(C.parseOptions('用樂高方塊').shape, 'blocks');
  assert.strictEqual(C.parseOptions('用圓柱').shape, 'cylinder');
  assert(C.parseOptions('整張圖當一個物件').whole);
  assert.strictEqual(C.parseOptions('').closeSource, 'default');
});
t('toSpec：交給編輯器的檢查通過，每個物件都是自訂形狀、都在同一個群組、底面貼地', () => {
  const E = require('../../renderer/src/edit/edit3d_core.js');
  const W = 48, H = 32, labels = grid(W, H, (x, y) => (((x - 14) ** 2 + (y - 16) ** 2 < 64) ? 1 : (x >= 28 && x < 42 && y >= 8 && y < 24 ? 2 : 0)));
  const s = C.buildScene({ labels, depth: grid(W, H, (x, y) => (labels[y][x] ? 0.8 : 0.2)) }, {});
  const raw = C.toSpec(s, { colors: { 1: '#ff0000' } });
  const v = E.validate(raw);
  assert(v.ok && v.problems.length === 0, JSON.stringify(v.problems));
  const polys = v.spec.objects.filter((o) => o.mesh === 'polygon');
  assert.strictEqual(polys.length, 3); polys.forEach((o) => assert.strictEqual(o.parent, 'g1'));
  assert.strictEqual(polys[1].material.color, '#ff0000');
  const ys = [].concat.apply([], polys.map((o) => o.extra.vertices.map((p) => p[1])));
  assert(Math.min.apply(null, ys) >= -1e-9 && Math.min.apply(null, ys) < 1e-3);
  polys.forEach((o) => assert(C.isClosed({ vertices: o.extra.vertices, faces: o.extra.faces })));
  assert.strictEqual(C.toSpec({ objects: [], background: null }, {}), null);
});

t('labelsFromMasks：重複的遮罩合併、整張圖那種遮罩丟掉、小遮罩在大遮罩裡仍是自己的物件', () => {
  const W = 40, H = 40, mk = (f, score) => ({ w: W, h: H, score, data: Uint8Array.from({ length: W * H }, (_, i) => (f(i % W, Math.floor(i / W)) ? 1 : 0)) });
  const big = mk((x, y) => x >= 4 && x < 30 && y >= 4 && y < 30, 0.9), dup = mk((x, y) => x >= 5 && x < 30 && y >= 4 && y < 30, 0.8);
  const small = mk((x, y) => x >= 10 && x < 18 && y >= 10 && y < 18, 0.95), all = mk(() => true, 0.99), speck = mk((x, y) => x === 0 && y === 0, 0.9);
  const r = C.labelsFromMasks([big, dup, small, all, speck], W, H, {});
  assert.strictEqual(r.count, 2); assert.strictEqual(r.labels[14][14], 2); assert.strictEqual(r.labels[25][25], 1); assert.strictEqual(r.labels[38][38], 0);
});
t('prepareInput 用分割結果分物件，後面照樣全部封閉', () => {
  const depth = { w: 60, h: 40, data: Float32Array.from({ length: 2400 }, (_, i) => (i % 60) / 60) };
  const seg = [{ w: 60, h: 40, score: 0.9, data: Uint8Array.from({ length: 2400 }, (_, i) => ((i % 60) < 25 && Math.floor(i / 60) > 5 && Math.floor(i / 60) < 30 ? 1 : 0)) }, { w: 60, h: 40, score: 0.8, data: Uint8Array.from({ length: 2400 }, (_, i) => ((i % 60) > 35 && Math.floor(i / 60) > 8 ? 1 : 0)) }];
  const p = C.prepareInput(depth, null, { segments: seg, workMax: 60 });
  assert.strictEqual(p.count, 2);
  C.buildScene({ labels: p.labels, depth: p.depth }, {}).objects.forEach((o) => assert(C.isClosed(o.mesh)));
  assert(C.parseOptions('--segment').segment && C.parseOptions('自動分割').segment && !C.parseOptions('').segment);
});

t('diffMask 背景差分：主體取出、雜訊與微小光線變化不算、尺寸不同回 null', () => {
  const W = 40, H = 30, mk = (f) => { const d = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set(f(x, y), (y * W + x) * 4); return { width: W, height: H, data: d }; };
  const bg = mk(() => [200, 200, 200, 255]);
  const a = mk((x, y) => (x >= 10 && x < 25 && y >= 8 && y < 22 ? [30, 60, 200, 255] : (x === 3 && y === 3 ? [0, 0, 0, 255] : [205, 198, 202, 255])));
  const r = C.diffMask(a, bg, {});
  assert.strictEqual(r.mask[15 * W + 15], 1); assert.strictEqual(r.mask[1 * W + 1], 0); assert.strictEqual(r.mask[3 * W + 3], 0);
  assert(r.fg > 0.15 && r.fg < 0.2, String(r.fg));
  assert.strictEqual(C.diffMask(a, { width: 5, height: 5, data: new Uint8ClampedArray(100) }, {}), null);
});

t('buildPanorama：遠中近三層，彎到圓柱後每層仍封閉，遠的半徑比近的大', () => {
  const W = 120, H = 40, data = Float32Array.from({ length: W * H }, (_, i) => { const x = i % W, y = Math.floor(i / W); return 0.2 + 0.6 * Math.abs(Math.sin(x / 9)) * (y / H); });
  const sc = C.buildPanorama({ w: W, h: H, data }, { bands: 3, radius: 5, fovDeg: 360, workMax: 90 });
  assert(sc.panorama && sc.objects.length >= 2 && sc.background === null);
  sc.objects.forEach((o) => assert(C.isClosed(o.mesh), o.name));
  const meanR = (o) => o.mesh.vertices.reduce((a, v) => a + Math.hypot(v[0], v[2]), 0) / o.mesh.vertices.length;
  const far = sc.objects.find((o) => o.id === 1), near = sc.objects[sc.objects.length - 1];
  assert(meanR(far) > meanR(near), meanR(far) + ' ' + meanR(near));
  assert.strictEqual(far.name, '遠景');
  const E = require('../../renderer/src/edit/edit3d_core.js');
  assert(E.validate(C.toSpec(sc, {})).problems.length === 0);
});
t('orbitKind：站在原地轉一圈＝outward、繞著一個點＝inward、方向資料不足＝unknown', () => {
  const turn = [0, 60, 120, 180, 240, 300].map((h) => ({ lat: 25.0, lon: 121.5 + h * 1e-7, heading: h }));
  const r = C.orbitKind(turn, {}); assert.strictEqual(r.kind, 'outward'); assert.strictEqual(r.order.length, 6);
  const ring = [0, 90, 180, 270].map((a) => ({ lat: 25 + 0.0005 * Math.sin(a * Math.PI / 180), lon: 121.5 + 0.0005 * Math.cos(a * Math.PI / 180), heading: (a + 180) % 360 }));
  assert.strictEqual(C.orbitKind(ring, {}).kind, 'inward');
  assert.strictEqual(C.orbitKind([{ heading: 10 }, { heading: 20 }], {}).kind, 'unknown');
  assert.strictEqual(C.orbitKind([{ heading: 10 }, { heading: 20 }, { heading: 30 }], {}).kind, 'unknown');
});
t('readExif：讀出 GPS 與方向（手工組一個最小的 JPEG）', () => {
  const rat = (n, d) => [n, d];
  const parts = []; // little-endian TIFF: IFD0 (GPS pointer) -> GPS IFD (lat, lon, direction)
  const buf = Buffer.alloc(220); let o = 0; const w16 = (v) => { buf.writeUInt16LE(v, o); o += 2; }, w32 = (v) => { buf.writeUInt32LE(v, o); o += 4; };
  buf.write('II', 0); o = 2; w16(42); w32(8);
  o = 8; w16(1); w16(0x8825); w16(4); w32(1); w32(26); w32(0);          // IFD0 at 8: one entry, GPS IFD at 26
  o = 26; w16(5); // GPS IFD: 5 entries
  const e = (tag, type, count, val) => { w16(tag); w16(type); w32(count); w32(val); };
  e(1, 2, 2, 0x4E); e(2, 5, 3, 100); e(3, 2, 2, 0x45); e(4, 5, 3, 148); e(17, 5, 1, 196); w32(0);
  const putR = (at, a) => { a.forEach((r, i) => { buf.writeUInt32LE(r[0], at + i * 8); buf.writeUInt32LE(r[1], at + i * 8 + 4); }); };
  putR(100, [rat(25, 1), rat(2, 1), rat(30, 1)]); putR(148, [rat(121, 1), rat(30, 1), rat(0, 1)]); putR(196, [rat(90, 1)]);
  const tiff = buf.slice(0, 210), head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0, 0, 0x45, 0x78, 0x69, 0x66, 0, 0]); head.writeUInt16BE(tiff.length + 8, 4);
  const jpg = Buffer.concat([head, tiff, Buffer.from([0xFF, 0xDA, 0, 2])]);
  const x = C.readExif(new Uint8Array(jpg));
  assert(x && Math.abs(x.lat - (25 + 2 / 60 + 30 / 3600)) < 1e-9 && Math.abs(x.lon - 121.5) < 1e-9 && x.heading === 90, JSON.stringify(x));
  assert.strictEqual(C.readExif(new Uint8Array([1, 2, 3])), null);
});

console.log(pass + ' passed' + (process.exitCode ? ', with failures' : ''));
