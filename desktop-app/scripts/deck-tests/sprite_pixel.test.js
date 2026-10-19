// node scripts/deck-tests/sprite_pixel.test.js -- 點陣精靈（去背、縮進畫格、調色盤、外框、物件樣板）；純函式，不需要瀏覽器
const SP = require('../../renderer/src/deck/sprite_pixel.js');
const yaml = require('js-yaml');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }

// 合成一個「渲染」：背景 key 色上的物件（實心矩形 + 一個半透明邊 + 圓）；alpha 由 cover 決定
function render(W, H, key, shape) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, s = shape(x, y); const a = s ? s.a : 0, c = s ? s.c : [0, 0, 0];
    for (let k = 0; k < 3; k++) d[o + k] = Math.round(c[k] * a + key[k] * (1 - a)); d[o + 3] = 255;
  }
  return { width: W, height: H, data: d };
}
const KA = [255, 0, 255], KB = [0, 255, 0];
// 一棵「樹」：棕色樹幹（下方）、綠色樹冠（上方，圓形），上面有半透明的柔邊
const tree = (x, y) => {
  if (x >= 90 && x < 110 && y >= 140 && y < 200) return { c: [107, 68, 35], a: 1 };
  const dx = x - 100, dy = y - 90, r = Math.sqrt(dx * dx + dy * dy);
  if (r < 50) return { c: [60, 148, 71], a: 1 };
  if (r < 52) return { c: [60, 148, 71], a: 0.5 };
  return null;
};
const A = render(200, 220, KA, tree), B = render(200, 220, KB, tree);
const cut = SP.matte(A, B, KA, KB);
const px = (img, x, y) => { const o = (y * img.width + x) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]]; };
check('matte: inside the object is opaque with its own colour (no background tint)', JSON.stringify(px(cut, 100, 90)) === JSON.stringify([60, 148, 71, 255]), px(cut, 100, 90));
check('matte: the background is fully transparent', px(cut, 5, 5)[3] === 0 && px(cut, 195, 215)[3] === 0);
check('matte: a half-covered pixel is half transparent and keeps the object colour (no magenta fringe)', (() => { const p = px(cut, 151, 90); return p[3] > 100 && p[3] < 155 && Math.abs(p[0] - 60) < 6 && Math.abs(p[1] - 148) < 6; })(), px(cut, 151, 90));
const bb = SP.bboxOf(cut, 8);
check('bbox: the object only', bb && bb.x >= 48 && bb.x <= 50 && bb.y >= 38 && bb.y <= 40 && bb.h >= 160 && bb.h <= 163, bb);

const sp = SP.pixelate(cut, { frame: [32, 48], palette: 16 });
check('pixelate: the frame is 32x48 by default', sp.width === 32 && sp.height === 48 && sp.data.length === 32 * 48 * 4);
check('pixelate: the alpha is only 0 or 255 (pixel art has no soft edges)', (() => { for (let i = 3; i < sp.data.length; i += 4) { if (sp.data[i] !== 0 && sp.data[i] !== 255) return false; } return true; })());
check('pixelate: the colours stay within the palette plus the outline', sp.palette.length <= 17 && sp.palette.length >= 3, sp.palette);
check('pixelate: it passes the programme check (not empty, big enough, standing on the bottom)', SP.check(sp, { palette: 16 }).length === 0, SP.check(sp, { palette: 16 }));
check('pixelate: the content does not touch the frame edge on the left / right / top (room for the outline)', (() => { const b = SP.bboxOf(sp, 255); return b.x >= 0 && b.x + b.w <= 32 && b.y >= 0; })());
check('pixelate: the foot is on the bottom row (standing on its tile)', (() => { const b = SP.bboxOf(sp, 255); return b.y + b.h === 48; })());
check('pixelate: the outline is the dark ink colour around the leaf colour', (() => { const o = px(sp, 16, 0), any = []; for (let y = 0; y < 48; y++) for (let x = 0; x < 32; x++) { const p = px(sp, x, y); if (p[3] === 255 && p[0] === 32 && p[1] === 24 && p[2] === 43) any.push(1); } return any.length >= 20; })());
check('pixelate: the same input gives the same picture (deterministic)', JSON.stringify(Array.from(SP.pixelate(cut, { frame: [32, 48], palette: 16 }).data)) === JSON.stringify(Array.from(sp.data)));
check('pixelate: a 4-colour palette really has at most 4 + outline colours', SP.pixelate(cut, { frame: [32, 48], palette: 4 }).palette.length <= 5);
check('pixelate: outline none leaves no ink colour', !SP.pixelate(cut, { frame: [32, 48], palette: 16, outline: 'none' }).palette.some((h) => h === '#20182b'));
check('pixelate: a 64x48 frame (a house) keeps the aspect ratio of the content', (() => { const w = SP.pixelate(cut, { frame: [64, 48] }), b = SP.bboxOf(w, 255); return b.h <= 48 && b.w <= 64 && b.h >= 44; })());
check('pixelate: an empty render is reported as empty, not a blank sprite', SP.pixelate({ width: 10, height: 10, data: new Uint8ClampedArray(400) }, {}).empty === true && SP.check(SP.pixelate({ width: 10, height: 10, data: new Uint8ClampedArray(400) }, {}), {}).length === 1);
check('pixelate: gamma brightens the dark side (the raster\'s light is fixed) and changes nothing at 1', (() => { const lum = (q) => { let t = 0, n = 0; for (let i = 0; i < q.data.length; i += 4) { if (q.data[i + 3] === 255) { t += q.data[i] + q.data[i + 1] + q.data[i + 2]; n++; } } return t / n; }; const base = SP.pixelate(cut, { frame: [32, 48], outline: 'none' }), g1 = SP.pixelate(cut, { frame: [32, 48], outline: 'none', gamma: 1 }), g2 = SP.pixelate(cut, { frame: [32, 48], outline: 'none', gamma: 1.7 }); return JSON.stringify(Array.from(base.data)) === JSON.stringify(Array.from(g1.data)) && lum(g2) > lum(base) + 10; })());
check('median cut: deterministic and bounded', (() => { const p = []; for (let i = 0; i < 200; i++) p.push([i, 255 - i, (i * 7) % 256]); const a = SP.medianCut(p, 8), b = SP.medianCut(p, 8); return a.length === 8 && JSON.stringify(a) === JSON.stringify(b); })());

// 物件樣板：每一種都是 render_3d_scene 的合法 YAML（頂層欄位、網格種類），顏色選項是封閉的
const MESH = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'torus'];
SP.KINDS.forEach((k) => {
  const y = SP.objectYaml(k), doc = yaml.load(y);
  check('template ' + k + ': valid YAML with a camera, lights and nodes of known mesh types', doc && doc.camera && Array.isArray(doc.camera.position) && Array.isArray(doc.nodes) && doc.nodes.length >= 2 && doc.nodes.every((n) => MESH.indexOf(n.mesh) >= 0 && n.material && /^#[0-9a-f]{6}$/i.test(n.material.color)), y.slice(0, 200));
  check('template ' + k + ': a default frame', SP.defaultFrame(k).length === 2);
});
check('template: an unknown kind gives nothing', SP.objectYaml('dragon') === null);
check('template: colour options change the colour; an unknown colour falls back to the default', SP.objectYaml('tree', { color: 'autumn' }).indexOf('#d9822b') >= 0 && SP.objectYaml('tree', { color: 'neon' }).indexOf('#3c9447') >= 0);
check('template: scale scales sizes and positions', yaml.load(SP.objectYaml('tree', { scale: 2 })).nodes[0].radius === 0.26);
check('template: a house is 64x48, a tree 32x48', JSON.stringify(SP.defaultFrame('house')) === '[64,48]' && JSON.stringify(SP.defaultFrame('tree')) === '[32,48]');

console.log(ok + ' passed, ' + bad.length + ' failed'); bad.forEach((b) => console.log('FAIL', b)); process.exit(bad.length ? 1 : 0);
