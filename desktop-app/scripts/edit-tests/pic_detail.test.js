// node scripts/edit-tests/pic_detail.test.js -- /edit-picture 擴散細化層的純函式:裁哪裡、羽化遮罩、色調對齊、蓋回去、借細節、縮放
const D = require('../../renderer/src/edit/pic_detail.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const img = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y), o = (y * w + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; } return { width: w, height: h, data: d }; };
const px = (m, x, y) => { const o = (y * m.width + x) * 4; return [m.data[o], m.data[o + 1], m.data[o + 2]]; };

// ---------- plan:裁哪裡 ----------
const B = { x: 0, y: 0, w: 1000, h: 800 };
const p1 = D.plan({ x: 400, y: 300, w: 100, h: 80 }, B, { context: 0.5, target: 512 });
check('plan: the crop is the region plus a ring of context (half the size on each side by default)', p1.ok && p1.crop.x === 350 && p1.crop.y === 260 && p1.crop.w === 200 && p1.crop.h === 160, p1.crop);
check('plan: the long side of the output is the model size, in multiples of 8, with the right shape', p1.out.w === 512 && p1.out.h === 408 && p1.out.w % 8 === 0 && p1.out.h % 8 === 0 && Math.abs(p1.out.scale - 2.56) < 1e-9, p1.out);
check('plan: the region sits in the middle of the crop (in output pixels)', Math.abs(p1.inner.x - 128) < 1 && Math.abs(p1.inner.y - 102) < 3 && Math.abs(p1.inner.w - 256) < 1, p1.inner);
check('plan: a region at the edge of the picture is cut to it and the context is cut to the picture', (() => { const p = D.plan({ x: -50, y: 0, w: 120, h: 100 }, B, { context: 1 }); return p.ok && p.region.x === 0 && p.region.w === 70 && p.crop.x === 0 && p.crop.y === 0; })());
check('plan: a region outside the picture or too small is refused with the reason', !D.plan({ x: 2000, y: 0, w: 50, h: 50 }, B).ok && /outside|smaller/.test(D.plan({ x: 10, y: 10, w: 3, h: 3 }, B).error) && !D.plan(null, B).ok);
check('plan: context 0 means no ring; context is limited to 0..2', D.plan({ x: 100, y: 100, w: 60, h: 60 }, B, { context: 0 }).crop.w === 60 && D.plan({ x: 400, y: 300, w: 100, h: 80 }, B, { context: 9 }).crop.w === 500);
check('plan: the feather is a share of the region (8% by default), at least 2 px', (() => { const p = D.plan({ x: 400, y: 300, w: 100, h: 80 }, B, {}); const q = D.plan({ x: 400, y: 300, w: 100, h: 80 }, B, { feather: 0.2 }); return p.feather === Math.round(Math.min(p.inner.w, p.inner.h) * 0.08) && q.feather > p.feather && D.plan({ x: 400, y: 300, w: 100, h: 80 }, B, { feather: 0 }).feather === 2; })());
check('plan: the same input gives the same plan', JSON.stringify(D.plan({ x: 400, y: 300, w: 100, h: 80 }, B, {})) === JSON.stringify(D.plan({ x: 400, y: 300, w: 100, h: 80 }, B, {})));
check('featherEdges: only the sides that have context around them are feathered', (() => { const p = D.plan({ x: 0, y: 100, w: 100, h: 100 }, B, { context: 0.5 }), e = D.featherEdges(p); return e.l === false && e.t === true && e.r === true && e.b === true; })());

// ---------- 遮罩 ----------
const inner = { x: 20, y: 20, w: 60, h: 40 };
const rm = D.rectMask(100, 80, inner, 10);
check('rectMask: 1 in the middle of the region, 0 outside, a smooth ramp inside the edge', rm[40 * 100 + 50] === 1 && rm[5 * 100 + 5] === 0 && rm[40 * 100 + 10] === 0 && rm[40 * 100 + 21] > 0 && rm[40 * 100 + 21] < 0.1 && rm[40 * 100 + 24] > rm[40 * 100 + 21] && rm[40 * 100 + 30] === 1);
check('rectMask: the ramp never goes down going inward (no ripple) and stays in 0..1', (() => { let prev = -1; for (let x = 20; x < 50; x++) { const v = rm[40 * 100 + x]; if (v < prev - 1e-9 || v < 0 || v > 1) return false; prev = v; } return true; })());
check('rectMask: a side without context (edges.l false) is not feathered', (() => { const m = D.rectMask(100, 80, inner, 10, { l: false, t: true, r: true, b: true }); return m[40 * 100 + 20] === 1 && rm[40 * 100 + 20] < 0.05; })());
check('softMask: a stroke shape keeps its inside whole and fades a little outward; far away is 0', (() => { const b = new Uint8Array(100 * 80); for (let y = 30; y < 50; y++) for (let x = 30; x < 70; x++) b[y * 100 + x] = 1; const m = D.softMask(b, 100, 80, 8); return m[40 * 100 + 50] === 1 && m[40 * 100 + 31] > 0.95 && m[40 * 100 + 28] > 0 && m[40 * 100 + 28] < 1 && m[40 * 100 + 5] === 0 && m[5 * 100 + 5] === 0; })());
check('boxBlur: keeps a flat field flat, spreads a spike, keeps the sum', (() => { const f = new Float32Array(30 * 30).fill(7); const b = D.boxBlur(f, 30, 30, 3, 3); const s = new Float32Array(30 * 30); s[15 * 30 + 15] = 100; const c = D.boxBlur(s, 30, 30, 2, 3); let sum = 0; c.forEach((v) => { sum += v; }); return Math.abs(b[400] - 7) < 1e-4 && c[15 * 30 + 15] < 100 && c[15 * 30 + 16] > 0 && Math.abs(sum - 100) < 0.5; })());

// ---------- 色調對齊 ----------
const ref = img(40, 40, (x, y) => [100 + (x % 5), 120 + (y % 5), 90]);
const gen = img(40, 40, (x, y) => [200 + (x % 9) * 3, 60 + (y % 9) * 3, 180]);
const all = new Float32Array(40 * 40).fill(1);
const tm = D.toneMatch(gen, ref, all, 1), sa = D.stats(tm, null), sr = D.stats(ref, null);
check('toneMatch: the mean of each channel goes to the original\'s (and the spread moves toward it)', Math.abs(sa.mean[0] - sr.mean[0]) < 6 && Math.abs(sa.mean[1] - sr.mean[1]) < 6 && Math.abs(sa.mean[2] - sr.mean[2]) < 6);
check('toneMatch: strength 0 changes nothing; 0.5 is halfway', (() => { const z = D.toneMatch(gen, ref, all, 0), h = D.toneMatch(gen, ref, all, 0.5); const m0 = D.stats(gen, null).mean[0], mz = D.stats(z, null).mean[0], mh = D.stats(h, null).mean[0], m1 = D.stats(tm, null).mean[0]; return Math.abs(mz - m0) < 1e-6 && Math.abs(mh - (m0 + m1) / 2) < 6; })());
check('toneMatch: it does not touch the picture it is given and works on the masked part only', (() => { const copy = new Uint8ClampedArray(gen.data); D.toneMatch(gen, ref, all, 1); const m = new Float32Array(40 * 40); for (let i = 0; i < 800; i++) m[i] = 1; const t = D.toneMatch(gen, ref, m, 1); return gen.data.every((v, i) => v === copy[i]) && t.width === 40; })());
check('toneMatch: a flat generated picture does not blow up (std ratio is limited)', (() => { const flat = img(20, 20, () => [10, 10, 10]); const t = D.toneMatch(flat, ref, new Float32Array(400).fill(1), 1); return t.data.every((v) => v >= 0 && v <= 255); })());

// ---------- 蓋回去 ----------
const base = img(40, 40, () => [0, 0, 0]), white = img(40, 40, () => [255, 255, 255]);
const half = new Float32Array(40 * 40); for (let y = 0; y < 40; y++) for (let x = 20; x < 40; x++) half[y * 40 + x] = 1;
const cmp = D.composite(base, white, half, 1);
check('composite: where the mask is 1 the generated pixel, where it is 0 the original, in between a mix', px(cmp, 30, 10)[0] === 255 && px(cmp, 5, 10)[0] === 0 && (() => { const m = new Float32Array(1600).fill(0.5); return Math.abs(D.composite(base, white, m, 1).data[0] - 127.5) < 1; })());
check('composite: opacity scales the mask; alpha of the base is kept', Math.abs(D.composite(base, white, half, 0.5).data[(10 * 40 + 30) * 4] - 127.5) < 1 && D.composite(base, white, half, 1).data[3] === 255);
check('composite: no seam -- the step across a feathered edge is smaller than the step of a hard edge', (() => { const pl = D.plan({ x: 10, y: 10, w: 20, h: 20 }, { x: 0, y: 0, w: 40, h: 40 }, { context: 0.5, target: 40, feather: 0.3 }); const soft = D.rectMask(40, 40, { x: 10, y: 10, w: 20, h: 20 }, 6), hard = D.rectMask(40, 40, { x: 10, y: 10, w: 20, h: 20 }, 0.5); const a = D.composite(base, white, soft, 1), b = D.composite(base, white, hard, 1); let ms = 0, mh = 0; for (let x = 0; x < 39; x++) { ms = Math.max(ms, Math.abs(px(a, x + 1, 20)[0] - px(a, x, 20)[0])); mh = Math.max(mh, Math.abs(px(b, x + 1, 20)[0] - px(b, x, 20)[0])); } return pl.ok && ms < mh * 0.5; })());
check('composite + toneMatch: after the tone is matched the generated part is close to the original colours (no colour block)', (() => { const o = img(40, 40, (x, y) => [90 + (x % 4), 110 + (y % 4), 80]), g = img(40, 40, (x, y) => [220 + (x % 7), 40 + (y % 7), 200]), mk = D.rectMask(40, 40, { x: 8, y: 8, w: 24, h: 24 }, 6), t = D.toneMatch(g, o, mk, 1), withT = D.composite(o, t, mk, 1), without = D.composite(o, g, mk, 1); return D.meanAbsDiff(withT, o, mk, 0.9) < 20 && D.meanAbsDiff(without, o, mk, 0.9) > 80; })());

// ---------- 借細節 ----------
const lowBase = img(40, 40, (x) => [100 + x, 100, 100]), texture = img(40, 40, (x, y) => [128 + ((x + y) % 2 ? 30 : -30), 128, 128]);
const dt = D.detailTransfer(lowBase, texture, 1, 2);
check('detailTransfer: the original colours stay (its low frequencies) and the texture\'s detail is added', (() => { const a = px(dt, 20, 20), a2 = px(dt, 21, 20); return Math.abs(a[0] - a2[0]) > 30 && Math.abs(D.stats(dt, null).mean[0] - D.stats(lowBase, null).mean[0]) < 3 && Math.abs(px(dt, 20, 20)[1] - 100) < 3; })());
check('detailTransfer: amount 0 gives the original; the result stays in 0..255', JSON.stringify(Array.from(D.detailTransfer(lowBase, texture, 0, 2).data)) === JSON.stringify(Array.from(lowBase.data)) && D.detailTransfer(lowBase, texture, 3, 2).data.every((v) => v >= 0 && v <= 255));

// ---------- 縮放 ----------
check('scale: same size copies; down by area average keeps the mean; up keeps the corners', (() => { const s = img(8, 8, (x, y) => [x * 30, y * 30, 50]); const same = D.scale(s, 8, 8), dn = D.scale(s, 4, 4), up = D.scale(s, 16, 16); return same.data.every((v, i) => v === s.data[i]) && Math.abs(D.stats(dn, null).mean[0] - D.stats(s, null).mean[0]) < 1.5 && px(up, 0, 0)[0] === 0 && px(up, 15, 15)[0] > 190; })());
check('scale: a checkerboard shrunk by 2 becomes the average grey (no aliasing)', (() => { const c = img(8, 8, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0])); const s = D.scale(c, 4, 4); return s.data.every((v, i) => i % 4 === 3 || Math.abs(v - 127.5) < 1.5); })());

// ---------- 標記 → 區域 ----------
check('regionOfMarks: spots, boxes and strokes make one box (with padding); nothing gives null', (() => { const r = D.regionOfMarks([{ x: 50, y: 50, r: 10 }, { x: 100, y: 120, w: 30, h: 20 }, { points: [[200, 200], [220, 210]], r: 5 }], 4); return r && r.x === 36 && r.y === 36 && r.w > 190 && D.regionOfMarks([], 0) === null; })());

console.log(ok + ' passed, ' + bad.length + ' failed'); bad.forEach((b) => console.log('FAIL', b)); process.exit(bad.length ? 1 : 0);
