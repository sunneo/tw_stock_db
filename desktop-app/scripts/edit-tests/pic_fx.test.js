// node test/edit_picture/pic_fx.test.js -- style filters and repair of /edit-picture
const F = require('../../renderer/src/edit/pic_fx.js');
const IP = require('../../renderer/src/imgproc/imgproc_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
function pic(w, h, fn) { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y), i = (y * w + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; } return { width: w, height: h, data: d }; }
const px = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
const near = (a, b, t) => Math.abs(a[0] - b[0]) <= t && Math.abs(a[1] - b[1]) <= t && Math.abs(a[2] - b[2]) <= t;
const RED = [220, 30, 30], BLUE = [30, 80, 220], YEL = [245, 235, 60];
const split = pic(64, 64, (x) => (x < 32 ? RED : BLUE));        // (red and blue have nearly the same brightness)
const split2 = pic(64, 64, (x) => (x < 32 ? [30, 30, 40] : YEL));  // a dark and a bright side: an edge the brightness filters can see
const rnd = (x, y) => { let n = (x * 374761393 + y * 668265263) | 0; n = (n ^ (n >>> 13)) * 1274126177; return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
const noisy = pic(64, 64, (x, y) => { const n = Math.round(rnd(x, y) * 60); return [100 + n, 100 + n, 100 + n]; });
const sd = (im) => { let s = 0, s2 = 0, n = im.data.length / 4; for (let i = 0; i < im.data.length; i += 4) { s += im.data[i]; s2 += im.data[i] * im.data[i]; } return Math.sqrt(s2 / n - (s / n) * (s / n)); };
// every filter returns a picture of the same size and does not change the input
['oil', 'sketch', 'cartoon', 'watercolor', 'emboss', 'halftone', 'neon', 'denoise', 'despeckle'].forEach((n) => {
  const before = new Uint8ClampedArray(split.data), out = F[n](split);
  check(n + ': same size, a new picture, the input is not touched, alpha kept', out.width === 64 && out.height === 64 && out !== split && split.data.every((v, i) => v === before[i]) && out.data[3] === 255);
});
check('oil: flat areas keep their colour, the edge between a dark and a bright side stays sharp (no grey band in between)', (() => { const o = F.oil(split2, { radius: 3 }); const D = [30, 30, 40]; return near(px(o, 5, 5), D, 6) && near(px(o, 58, 5), YEL, 6) && (near(px(o, 30, 30), D, 12) || near(px(o, 30, 30), YEL, 12)) && (near(px(o, 33, 30), D, 12) || near(px(o, 33, 30), YEL, 12)); })());
check('sketch: a flat picture becomes white paper, an edge becomes a dark line', (() => { const o = F.sketch(split2); const flat = px(o, 5, 5)[0], edge = Math.min(px(o, 31, 20)[0], px(o, 32, 20)[0]); return flat > 235 && edge < flat - 20 && o.data[0] === o.data[1]; })(), (() => { const o = F.sketch(split2); return [px(o, 5, 5), px(o, 31, 20), px(o, 32, 20)]; })());
check('cartoon: colours are reduced to a few levels and edges are dark', (() => { const o = F.cartoon(split2, { levels: 4 }); const set = new Set(); for (let i = 0; i < o.data.length; i += 4) set.add(o.data[i] + ',' + o.data[i + 1] + ',' + o.data[i + 2]); return set.size <= 40 && Math.min(px(o, 31, 30)[0], px(o, 32, 30)[0]) < 60; })());
check('watercolor: deterministic (same input, same output) and lighter / softer than the input', (() => { const a = F.watercolor(split), b = F.watercolor(split); return a.data.every((v, i) => v === b.data[i]) && px(a, 5, 5)[0] > 150 && px(a, 5, 5)[1] > 40; })());
check('emboss: a flat picture becomes mid grey', (() => { const o = F.emboss(pic(20, 20, () => [50, 90, 200])); return near(px(o, 10, 10), [128, 128, 128], 3); })());
check('halftone: white paper with dots, darker where the picture is darker', (() => { const o = F.halftone(pic(60, 30, (x) => (x < 30 ? [20, 20, 20] : [235, 235, 235])), { size: 6 }); const dark = [0, 0]; for (let y = 0; y < 30; y++) for (let x = 0; x < 60; x++) { if (px(o, x, y)[0] < 200) dark[x < 30 ? 0 : 1]++; } return dark[0] > dark[1] * 3 && dark[0] > 200; })());
check('neon: dark where nothing changes, bright on the edge', (() => { const o = F.neon(split2); return px(o, 5, 5)[0] < 40 && Math.max(...px(o, 32, 30)) > 100; })());
check('denoise: noise is reduced (the standard deviation drops to less than half)', sd(F.denoise(noisy, { strength: 1 })) < sd(noisy) * 0.5, [sd(F.denoise(noisy, { strength: 1 })), sd(noisy)]);
check('despeckle: an isolated bright pixel is removed, a real edge is kept', (() => { const d = pic(30, 30, (x) => (x < 15 ? [40, 40, 40] : [200, 200, 200])); const i = (10 * 30 + 5) * 4; d.data[i] = d.data[i + 1] = d.data[i + 2] = 255; const o = F.despeckle(d, { threshold: 40 }); return near(px(o, 5, 10), [40, 40, 40], 3) && near(px(o, 14, 10), [40, 40, 40], 3) && near(px(o, 15, 10), [200, 200, 200], 3); })());
// repair: inpaint
const spot = pic(60, 60, (x, y) => ((x - 30) * (x - 30) + (y - 30) * (y - 30) < 36 ? [10, 10, 10] : RED));
const mask = F.marksToMask([{ x: 30, y: 30, r: 9 }], { x: 0, y: 0, w: 60, h: 60 }, 60, 60);
const fixed = F.inpaint(spot, mask);
check('marksToMask: a round spot, a box and a brush stroke, scaled to the region', (() => { const m1 = F.marksToMask([{ x: 10, y: 10, r: 5 }], { x: 0, y: 0, w: 20, h: 20 }, 40, 40), c = m1.reduce((a, v) => a + v, 0); const m2 = F.marksToMask([{ x: 0, y: 0, w: 10, h: 5 }], { x: 0, y: 0, w: 20, h: 20 }, 20, 20), m3 = F.marksToMask([{ points: [[2, 10], [18, 10]], r: 2 }], { x: 0, y: 0, w: 20, h: 20 }, 20, 20); return Math.abs(c - Math.PI * 100) < 25 && m2.reduce((a, v) => a + v, 0) === 50 && m3[10 * 20 + 3] === 1 && m3[10 * 20 + 17] === 1 && m3[2 * 20 + 10] === 0; })());
check('inpaint: the marked dark spot is filled with the colour around it, nothing outside the mark changes', near(px(fixed, 30, 30), RED, 12) && near(px(fixed, 27, 31), RED, 12) && px(fixed, 5, 5).join() === RED.join() && px(spot, 30, 30)[0] === 10, [px(fixed, 30, 30), px(fixed, 27, 31)]);
check('inpaint: across an edge the fill follows both sides (no wild colours)', (() => { const e = pic(40, 20, (x) => (x < 20 ? RED : BLUE)); const mk = F.marksToMask([{ x: 20, y: 10, r: 5 }], { x: 0, y: 0, w: 40, h: 20 }, 40, 20); const o = F.inpaint(e, mk); const c = px(o, 20, 10); return c[0] > 20 && c[0] < 230 && c[2] > 20; })());
check('inpaint: an empty mask changes nothing; a mask over everything does not hang', (() => { const a = F.inpaint(spot, new Uint8Array(3600)), b = F.inpaint(spot, new Uint8Array(3600).fill(1)); return a.data.every((v, i) => v === spot.data[i]) && b.width === 60; })());
// run: fx and imgproc together, in order
const r = F.run(split, [{ op: 'brightness', amount: 20 }, { op: 'sketch' }, { op: 'invert' }], { imgproc: IP });
check('run: filters of this module and imgproc operations are run in the order given', r.applied.map((a) => a.op).join() === 'brightness,sketch,invert' && r.img.width === 64, r.applied);
check('run: without imgproc the other operations are skipped, the filters still run; an unknown name is ignored', (() => { const o = F.run(split, [{ op: 'oil' }, { op: 'brightness', amount: 5 }, { op: 'nonsense' }]); return o.applied.length === 1 && o.applied[0].op === 'oil'; })());
check('fxName: English and Chinese names', F.fxName('油畫') === 'oil' && F.fxName('Watercolor') === 'watercolor' && F.fxName('去污點') === 'despeckle' && F.fxName('blur') === null);
// styles: every named look is made of operations that exist (imgproc or here)
check('STYLES: every operation of every look is known, with parameters imgproc accepts', Object.keys(F.STYLES).every((id) => F.STYLES[id].ops.every((o) => F.fxName(o.op) || IP.normalizeOps([o]).ok)), Object.keys(F.STYLES).filter((id) => !F.STYLES[id].ops.every((o) => F.fxName(o.op) || IP.normalizeOps([o]).ok)));
check('STYLES: each look runs on a picture and keeps its size', Object.keys(F.STYLES).every((id) => { const o = F.run(noisy, F.STYLES[id].ops, { imgproc: IP }); return o.img.width === 64 && o.img.height === 64; }));
check('styleFor: the words the user says find the look (longer words win)', F.styleFor('把它變成水彩風格') === 'watercolor' && F.styleFor('make it look like an oil painting') === 'oil' && F.styleFor('黑白') === 'mono' && F.styleFor('老照片') === 'vintage' && F.styleFor('今天天氣很好') === null);
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'pic_fx: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
