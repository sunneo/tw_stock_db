// node scripts/deck-tests/sprite_char.test.js -- 人物精靈圖：3D 人物零件（char_model）、z-buffer 光柵（sprite_raster）、多格共用調色盤（pixelateMany）、精靈圖打包；純函式，不需要瀏覽器
const CM = require('../../renderer/src/deck/char_model.js');
const SR = require('../../renderer/src/deck/sprite_raster.js');
const SP = require('../../renderer/src/deck/sprite_pixel.js');
const Art = require('../../renderer/src/deck/rpg_art.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const px = (img, x, y) => { const o = (y * img.width + x) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]]; };
const cam = { fov: 30, position: [0, 0, 6], lookAt: [0, 0, 0] };

// ---------- 光柵：深度、透明度、形狀、確定性 ----------
const box = (z, color, w) => ({ shape: 'box', pos: [0, 0, z], rot: [0, 0, 0], size: [w || 2, 2, 0.2], color });
const two = SR.render([box(0, '#ff0000'), box(1, '#0000ff', 1)], cam, { width: 120, height: 120, ambient: 1 });
check('raster: the background is transparent', px(two, 2, 2)[3] === 0);
check('raster: the nearer box hides the farther one (z-buffer), whatever the drawing order', (() => { const a = SR.render([box(0, '#ff0000'), box(1, '#0000ff', 1)], cam, { width: 120, height: 120, ambient: 1 }), b = SR.render([box(1, '#0000ff', 1), box(0, '#ff0000')], cam, { width: 120, height: 120, ambient: 1 }); const c1 = px(a, 60, 60), c2 = px(b, 60, 60); return c1[2] > 200 && c1[0] < 40 && c2[2] > 200 && c2[0] < 40 && px(a, 60, 60).join() === px(b, 60, 60).join(); })(), [px(two, 60, 60)]);
check('raster: outside the near box the far (wider) box shows', (() => { const c = px(two, 28, 60); return c[0] > 200 && c[2] < 40; })());
check('raster: a sphere is round (a filled disc)', (() => { const im = SR.render([{ shape: 'sphere', pos: [0, 0, 0], rot: [0, 0, 0], r: 0.8, color: '#00ff00' }], cam, { width: 100, height: 100 }); let inside = 0, corner = 0; for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) { if (im.data[(y * 100 + x) * 4 + 3]) { inside++; if ((x < 30 || x > 69) && (y < 30 || y > 69) && Math.hypot(x - 50, y - 50) > 27) corner++; } } return inside > 1700 && inside < 2200 && corner === 0 && px(im, 50, 50)[3] === 255; })());
check('raster: the lit side is brighter than the shaded side (light from the right)', (() => { const im = SR.render([{ shape: 'sphere', pos: [0, 0, 0], rot: [0, 0, 0], r: 1.4, color: '#c8c8c8' }], cam, { width: 100, height: 100, light: [1, 0, 0.3], ambient: 0.2 }); return px(im, 68, 50)[0] > px(im, 32, 50)[0] + 40; })());
check('raster: the same input gives the same picture', JSON.stringify(Array.from(SR.render([box(0, '#ff8800')], cam, { width: 40, height: 40 }).data)) === JSON.stringify(Array.from(SR.render([box(0, '#ff8800')], cam, { width: 40, height: 40 }).data)));
check('raster: cylinders and cones draw', ['cylinder', 'cone'].every((sh) => { const im = SR.render([{ shape: sh, pos: [0, 0, 0], rot: [0, 0, 0], r: 0.8, h: 2, color: '#ffffff' }], cam, { width: 80, height: 80 }); return px(im, 40, 40)[3] === 255; }));
check('raster: a rotated box covers other pixels than the plain one (YXZ rotation applies)', (() => { const a = SR.render([box(0, '#fff')], cam, { width: 80, height: 80 }), b = SR.render([Object.assign(box(0, '#fff'), { rot: [0, Math.PI / 2, 0] })], cam, { width: 80, height: 80 }); return px(a, 15, 40)[3] === 255 && px(b, 15, 40)[3] === 0; })());

// ---------- 人物零件 ----------
const LB = Art.PRESETS.liu_bei;
check('char: the styles, directions and sheet are the closed lists', JSON.stringify(CM.STYLES) === '["real","anime","cute"]' && JSON.stringify(CM.DIRS) === '["down","left","right","up"]' && CM.SHEET.cols === 4 && CM.SHEET.rows === 4 && CM.SHEET.idle === 1);
check('char: 16 frames, a row for each direction and a column for each walk phase', (() => { const l = CM.frameList(); return l.length === 16 && l[0].dir === 'down' && l[4].dir === 'left' && l[8].dir === 'right' && l[12].dir === 'up' && l[5].step === 1; })());
const P = (look, o) => CM.parts(look, o);
check('char: parts are valid (known shapes, hex colours, finite numbers)', CM.STYLES.every((st) => CM.DIRS.every((d) => P(LB, { style: st, dir: d, step: 1 }).parts.every((p) => ['box', 'sphere', 'cylinder', 'cone'].indexOf(p.shape) >= 0 && /^#[0-9a-f]{6}$/i.test(p.color) && p.pos.concat(p.rot).every(Number.isFinite) && (p.shape === 'box' ? p.size.every((v) => v > 0) : p.r > 0)))));
check('char: the legs swing against each other and are together when it stands (steps 1 and 3)', (() => { const z = (st, tag) => P(LB, { style: 'real', dir: 'down', step: st }).parts.find((p) => p.tag === tag).pos[2]; return z(0, 'leg_l') > 0.1 && z(0, 'leg_r') < -0.1 && z(2, 'leg_l') < -0.1 && z(2, 'leg_r') > 0.1 && Math.abs(z(1, 'leg_l')) < 1e-6 && Math.abs(z(3, 'leg_r')) < 1e-6; })());
check('char: the arms swing against the legs on the same side', (() => { const z = (tag) => P(LB, { style: 'real', dir: 'down', step: 0 }).parts.find((p) => p.tag === tag).pos[2]; return z('leg_l') > 0 && z('arm_l') < 0 && z('arm_r') > 0; })());
check('char: turned to the right, the front of the head (the eyes) points to +x; turned up it is at -z; turned left at -x', (() => { const e = (d) => P(LB, { style: 'real', dir: d, step: 1 }).parts.find((p) => p.tag === 'eye_l').pos; return e('right')[0] > 0.1 && e('up')[2] < -0.1 && e('left')[0] < -0.1 && e('down')[2] > 0.1; })());
check('char: looks change the parts (topknot, beard, headband, hat, long hair, wild hair)', (() => { const t = (look) => P(Object.assign({}, LB, look), { style: 'real', dir: 'down', step: 1 }).parts.map((p) => p.tag); return t({ hairStyle: 'topknot' }).indexOf('topknot') >= 0 && t({ beard: 'long' }).indexOf('beard') >= 0 && t({ head: 'headband' }).indexOf('headband') >= 0 && t({ head: 'hat' }).indexOf('hat') >= 0 && t({ hairStyle: 'long' }).indexOf('hair_back') >= 0 && t({ hairStyle: 'wild' }).indexOf('wild_a') >= 0 && t({ beard: 'none', head: 'none', hairStyle: 'short' }).indexOf('beard') < 0; })());
check('char: the three styles really differ in proportion (cute has the biggest head against the body, anime the longest legs)', (() => { const g = (st, tag) => P(LB, { style: st, dir: 'down', step: 1 }).parts.find((p) => p.tag === tag); const ratio = (st) => g(st, 'head').r / P(LB, { style: st, dir: 'down', step: 1 }).height; return ratio('cute') > ratio('real') * 1.6 && g('anime', 'leg_l').size[1] > g('real', 'leg_l').size[1] && g('cute', 'blush_l') && !g('real', 'blush_l') && g('anime', 'shine_l'); })());
check('char: look errors name the allowed values', CM.lookErrors({ robe: 'pink' }).length === 1 && /green, red, blue/.test(CM.lookErrors({ robe: 'pink' })[0]) && CM.lookErrors({ hair: 'blue', beard: 'x' }).length === 2 && CM.lookErrors(LB).length === 0);
check('char: every preset of the drawn actors makes a character', Art.PRESET_NAMES.every((n) => CM.lookErrors(Art.PRESETS[n]).length === 0 && P(Art.PRESETS[n], { style: 'cute', dir: 'left', step: 2 }).parts.length > 15));

// ---------- 精靈圖：渲染 → 共用調色盤 → 打包 ----------
const frame = [32, 48];
function cuts(look, style) { return CM.frameList().map((f) => { const m = P(look, { style, dir: f.dir, step: f.step }); return SR.render(m.parts, m.camera, { width: 256, height: 384, light: m.light, ambient: m.ambient }); }); }
CM.STYLES.forEach((st) => {
  const cs = cuts(LB, st), po = CM.pixelOpts(st), fr = SP.pixelateMany(cs, Object.assign({ frame }, po));
  check('sheet ' + st + ': 16 frames of 32x48, none empty, each passes the programme check', fr.length === 16 && fr.every((f) => f.width === 32 && f.height === 48 && !f.empty && SP.check(f, { palette: po.palette, outline: po.outline, sheet: true }).length === 0), fr.map((f) => SP.check(f, { palette: po.palette, outline: po.outline, sheet: true })));
  const all = new Set(); fr.forEach((f) => f.palette.forEach((c) => all.add(c)));
  check('sheet ' + st + ': one shared palette for all 16 frames (at most the palette size plus its outline colours)', all.size <= (po.outline === 'shade' ? po.palette * 2 : po.palette + 1), all.size);
  const diff = (a, b) => { let n = 0; for (let i = 0; i < a.data.length; i += 4) { if (a.data[i + 3] !== b.data[i + 3] || (a.data[i + 3] && (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1]))) n++; } return n; };
  check('sheet ' + st + ': the walk frames differ from each other and the four directions differ', diff(fr[0], fr[1]) > 10 && diff(fr[0], fr[2]) > 10 && diff(fr[1], fr[3]) < diff(fr[0], fr[1]) && diff(fr[0], fr[4]) > 30 && diff(fr[4], fr[8]) > 30 && diff(fr[0], fr[12]) > 20);
  check('sheet ' + st + ': the same crop and scale for all frames (the feet stay on the same line when standing)', (() => { const b = (f) => SP.bboxOf(f, 255); return b(fr[1]).y + b(fr[1]).h === b(fr[3]).y + b(fr[3]).h && b(fr[5]).y + b(fr[5]).h === b(fr[7]).y + b(fr[7]).h; })());
  check('sheet ' + st + ': deterministic', JSON.stringify(Array.from(SP.packSheet(SP.pixelateMany(cuts(LB, st), Object.assign({ frame }, po)), 4).data)) === JSON.stringify(Array.from(SP.packSheet(fr, 4).data)));
  const sh = SP.packSheet(fr, 4);
  check('sheet ' + st + ': packed 4 columns x 4 rows = 128x192, the cell (col, row) is frame row*4+col', sh.width === 128 && sh.height === 192 && sh.cols === 4 && sh.rows === 4 && px(sh, 32 * 2 + 16, 48 * 1 + 30).join() === px(fr[6], 16, 30).join());
});
check('sheet: anime is cel-shaded (few brightness levels) and real has more colours than cute', (() => { const n = (st) => { const f = SP.pixelateMany(cuts(LB, st), Object.assign({ frame }, CM.pixelOpts(st))); const s = new Set(); f.forEach((x) => x.palette.forEach((c) => s.add(c))); return s.size; }; return n('real') > n('cute') && n('anime') <= 16 + 1; })());
check('objects: the template parts match the YAML nodes and render with the same raster', (() => { return SP.KINDS.every((k) => { const y = SP.objectYaml(k), m = SP.objectParts(k), n = (y.match(/\{ mesh:/g) || []).length; const im = SR.render(m.parts, m.camera, { width: 128, height: 192, light: m.light, ambient: m.ambient }); return m.parts.length === n && SP.bboxOf(im, 8) && SP.pixelate(im, { frame: SP.defaultFrame(k) }).empty === false; }); })());
check('objects: an unknown kind gives no parts', SP.objectParts('dragon') === null);

console.log(ok + ' passed, ' + bad.length + ' failed'); bad.forEach((b) => console.log('FAIL', b)); process.exit(bad.length ? 1 : 0);
