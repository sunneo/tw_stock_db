'use strict';
// 圖片處理核心的單元測試（純 Node）：node renderer/src/imgproc/imgproc_core.test.js
const assert = require('assert'); const P = require('./imgproc_core.js');
let ok = 0; const bad = []; const t = (n, f) => { try { f(); ok++; } catch (e) { bad.push(n); console.log('FAIL', n, e.message.slice(0, 400)); } };
const img = (w, h, f) => { const o = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y), i = (y * w + x) * 4; o.data[i] = c[0]; o.data[i + 1] = c[1]; o.data[i + 2] = c[2]; o.data[i + 3] = c.length > 3 ? c[3] : 255; } return o; };
const px = (im, x, y) => Array.from(im.data.slice((y * im.width + x) * 4, (y * im.width + x) * 4 + 4));
const run = (im, ops) => { const n = P.normalizeOps(ops); assert.ok(n.ok, n.errors.join('；')); return P.run(im, n.ops).img; };
const grad = (w, h) => img(w, h, (x, y) => [Math.round(x * 255 / (w - 1)), Math.round(y * 255 / (h - 1)), 128]);

t('灰階：R=G=B，亮度用 Rec.601', () => { const o = run(img(2, 1, () => [200, 100, 50]), ['grayscale']); const y = Math.round(0.299 * 200 + 0.587 * 100 + 0.114 * 50); assert.deepStrictEqual(px(o, 0, 0), [y, y, y, 255]); });
t('不改傳入的影像（run 先複製）', () => { const a = grad(8, 8), before = Array.from(a.data); run(a, ['grayscale', { op: 'blur', radius: 2 }]); assert.deepStrictEqual(Array.from(a.data), before); });
t('亮度／對比／gamma 的方向正確，0 不動', () => {
  const a = img(1, 1, () => [100, 100, 100]); assert.ok(px(run(a, [{ op: 'brightness', amount: 20 }]), 0, 0)[0] > 100); assert.ok(px(run(a, [{ op: 'brightness', amount: -20 }]), 0, 0)[0] < 100);
  assert.deepStrictEqual(px(run(a, [{ op: 'brightness', amount: 0 }, { op: 'contrast', amount: 0 }]), 0, 0), [100, 100, 100, 255]);
  const lo = img(1, 1, () => [60, 60, 60]), hi = img(1, 1, () => [200, 200, 200]); assert.ok(px(run(lo, [{ op: 'contrast', amount: 50 }]), 0, 0)[0] < 60); assert.ok(px(run(hi, [{ op: 'contrast', amount: 50 }]), 0, 0)[0] > 200);
  assert.ok(px(run(a, [{ op: 'gamma', value: 2 }]), 0, 0)[0] > 100);
});
t('飽和度 -100＝灰階；+ 讓顏色更鮮', () => { const a = img(1, 1, () => [200, 100, 50]); const g = px(run(a, [{ op: 'saturation', amount: -100 }]), 0, 0); assert.ok(g[0] === g[1] && g[1] === g[2]); const s = px(run(a, [{ op: 'saturation', amount: 50 }]), 0, 0); assert.ok(s[0] - s[2] > 150); });
t('自動對比：低對比的圖被拉到接近 0..255；已經飽滿的不變', () => {
  const low = img(16, 16, (x) => { const v = 100 + x * 4; return [v, v, v]; }); const o = run(low, [{ op: 'auto_contrast', clip: 0 }]); let mn = 255, mx = 0; for (let i = 0; i < o.data.length; i += 4) { mn = Math.min(mn, o.data[i]); mx = Math.max(mx, o.data[i]); } assert.ok(mn <= 2 && mx >= 253, mn + ',' + mx);
  const full = img(16, 4, (x) => [x * 17, x * 17, x * 17]); assert.deepStrictEqual(Array.from(run(full, [{ op: 'auto_contrast', clip: 0 }]).data), Array.from(full.data));
});
t('色調強化：偏黃的圖被白平衡拉回、增益有上限', () => { const yellow = img(8, 8, () => [200, 190, 100]); const o = run(yellow, [{ op: 'tone', contrast: 0, saturation: 0 }]); const p = px(o, 0, 0); assert.ok(Math.abs(p[0] - p[2]) < Math.abs(200 - 100), JSON.stringify(p)); assert.ok(p[2] <= 100 * 1.4 + 1); });
t('影像強化：不丟例外、尺寸不變、對比提高', () => { const low = img(32, 32, (x, y) => { const v = 110 + ((x + y) % 8) * 4; return [v, v, v]; }); const o = run(low, [{ op: 'enhance' }]); assert.strictEqual(o.width, 32); let mn = 255, mx = 0; for (let i = 0; i < o.data.length; i += 4) { mn = Math.min(mn, o.data[i]); mx = Math.max(mx, o.data[i]); } assert.ok(mx - mn > 60, mn + ',' + mx); });
t('高斯模糊：常數圖不變；總亮度守恆（約）；變異數下降；半徑 0 不動', () => {
  const flat = img(20, 20, () => [90, 90, 90]); assert.deepStrictEqual(px(run(flat, [{ op: 'blur', radius: 5 }]), 10, 10), [90, 90, 90, 255]);
  const dot = img(41, 41, (x, y) => (x === 20 && y === 20 ? [255, 255, 255] : [0, 0, 0])); const b = run(dot, [{ op: 'blur', radius: 3 }]); let sum = 0, max = 0; for (let i = 0; i < b.data.length; i += 4) { sum += b.data[i]; max = Math.max(max, b.data[i]); } assert.ok(Math.abs(sum - 255) < 40, 'sum=' + sum); assert.ok(max < 40);
  const noise = img(32, 32, (x, y) => { const v = ((x * 7 + y * 13) % 5) * 60; return [v, v, v]; }); const vr = (im) => { let m = 0, q = 0; const n = im.width * im.height; for (let i = 0; i < im.data.length; i += 4) m += im.data[i]; m /= n; for (let i = 0; i < im.data.length; i += 4) q += (im.data[i] - m) ** 2; return q / n; };
  assert.ok(vr(run(noise, [{ op: 'blur', radius: 2 }])) < vr(noise) / 3); assert.deepStrictEqual(Array.from(run(noise, [{ op: 'blur', radius: 0 }]).data), Array.from(noise.data));
});
t('高斯模糊：邊緣（大半徑、小圖）不爆、不出 NaN', () => { const o = run(grad(5, 3), [{ op: 'blur', radius: 50 }]); assert.strictEqual(o.data.length, 5 * 3 * 4); assert.ok(Array.from(o.data).every((v) => v >= 0 && v <= 255)); });
t('銳化：邊緣對比增加，平坦區不變', () => { const e = img(16, 16, (x) => (x < 8 ? [100, 100, 100] : [150, 150, 150])); const o = run(e, [{ op: 'sharpen', amount: 2, radius: 1.5 }]); assert.ok(px(o, 7, 8)[0] < 100); assert.ok(px(o, 8, 8)[0] > 150); assert.deepStrictEqual(px(o, 1, 8), [100, 100, 100, 255]); });
t('馬賽克：每個格子是單一顏色＝原本的平均；region 外不動', () => {
  const a = img(8, 8, (x, y) => [x * 30, y * 30, 7]); const o = run(a, [{ op: 'mosaic', block: 4 }]); for (const [bx, by] of [[0, 0], [4, 0], [0, 4], [4, 4]]) { const c = px(o, bx, by); for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) assert.deepStrictEqual(px(o, bx + x, by + y), c); }
  assert.strictEqual(px(o, 0, 0)[0], Math.round((0 + 30 + 60 + 90) / 4));
  const part = run(a, [{ op: 'mosaic', block: 4, region: { x: 50, y: 0, w: 50, h: 50 } }]); assert.deepStrictEqual(px(part, 1, 1), px(a, 1, 1)); assert.deepStrictEqual(px(part, 5, 5), px(a, 5, 5)); assert.deepStrictEqual(px(part, 4, 0), px(part, 7, 3));
});
t('減少色彩：結果最多 N 種顏色；N=2 的黑白圖保持黑白；dither 也不超過 N', () => {
  const count = (im) => { const s = new Set(); for (let i = 0; i < im.data.length; i += 4) s.add(im.data[i] + ',' + im.data[i + 1] + ',' + im.data[i + 2]); return s.size; };
  const g = grad(32, 32); assert.ok(count(g) > 100); assert.ok(count(run(g, [{ op: 'reduce_colors', colors: 8 }])) <= 8); assert.ok(count(run(g, [{ op: 'reduce_colors', colors: 8, dither: true }])) <= 8);
  const bw = img(8, 8, (x) => (x < 4 ? [0, 0, 0] : [255, 255, 255])); const o = run(bw, [{ op: 'reduce_colors', colors: 2 }]); assert.ok(px(o, 0, 0)[0] < 10 && px(o, 7, 0)[0] > 245);
});
t('色階分離、二值化（Otsu）、反相', () => {
  const p = run(img(1, 1, () => [130, 130, 130]), [{ op: 'posterize', levels: 2 }]); assert.ok(p.data[0] === 0 || p.data[0] === 255);
  const doc = img(10, 10, (x) => (x < 5 ? [30, 30, 30] : [220, 220, 220])); const th = run(doc, ['threshold']); assert.strictEqual(px(th, 0, 0)[0], 0); assert.strictEqual(px(th, 9, 0)[0], 255); assert.strictEqual(px(run(doc, [{ op: 'threshold', invert: true }]), 0, 0)[0], 255);
  assert.deepStrictEqual(px(run(img(1, 1, () => [10, 20, 30]), ['invert']), 0, 0), [245, 235, 225, 255]);
});
t('旋轉：90／180／270 精確（順時針）、尺寸對調', () => {
  const a = img(3, 2, (x, y) => [x * 10 + y * 100, 0, 0]); const r90 = run(a, [{ op: 'rotate', degrees: 90 }]); assert.deepStrictEqual([r90.width, r90.height], [2, 3]); assert.strictEqual(px(r90, 1, 0)[0], px(a, 0, 0)[0]); assert.strictEqual(px(r90, 0, 0)[0], px(a, 0, 1)[0]); assert.strictEqual(px(r90, 1, 2)[0], px(a, 2, 0)[0]);
  const r180 = run(a, [{ op: 'rotate', degrees: 180 }]); assert.strictEqual(px(r180, 0, 0)[0], px(a, 2, 1)[0]); const r270 = run(a, [{ op: 'rotate', degrees: -90 }]); assert.deepStrictEqual([r270.width, r270.height], [2, 3]); assert.strictEqual(px(r270, 0, 2)[0], px(a, 0, 0)[0]);
  assert.deepStrictEqual(Array.from(run(run(a, [{ op: 'rotate', degrees: 90 }]), [{ op: 'rotate', degrees: 270 }]).data), Array.from(a.data));
});
t('旋轉任意角度：擴大畫布、角落填底色、中心不變', () => { const a = img(20, 20, () => [10, 200, 10]); const r = run(a, [{ op: 'rotate', degrees: 45, background: '#ff0000' }]); assert.ok(r.width > 20 && r.height > 20); assert.deepStrictEqual(px(r, 0, 0), [255, 0, 0, 255]); assert.deepStrictEqual(px(r, r.width >> 1, r.height >> 1).slice(0, 3), [10, 200, 10]); const nb = run(a, [{ op: 'rotate', degrees: 30, expand: false }]); assert.deepStrictEqual([nb.width, nb.height], [20, 20]); });
t('縮放：percent／width／框內等比／max_side（只縮不放）、色彩平均', () => {
  const a = img(100, 50, (x) => (x < 50 ? [0, 0, 0] : [255, 255, 255]));
  const h = run(a, [{ op: 'scale', percent: 50 }]); assert.deepStrictEqual([h.width, h.height], [50, 25]); assert.strictEqual(px(h, 5, 5)[0], 0); assert.strictEqual(px(h, 45, 5)[0], 255);
  assert.deepStrictEqual([run(a, [{ op: 'scale', width: 20 }]).width, run(a, [{ op: 'scale', width: 20 }]).height], [20, 10]);
  const box = run(a, [{ op: 'scale', width: 40, height: 40 }]); assert.deepStrictEqual([box.width, box.height], [40, 20]); const st = run(a, [{ op: 'scale', width: 40, height: 40, stretch: true }]); assert.deepStrictEqual([st.width, st.height], [40, 40]);
  assert.deepStrictEqual([run(a, [{ op: 'scale', max_side: 50 }]).width, run(a, [{ op: 'scale', max_side: 500 }]).width], [50, 100]);
  const chk = img(4, 4, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0])); assert.ok(Math.abs(px(run(chk, [{ op: 'scale', percent: 25 }]), 0, 0)[0] - 128) <= 1);
  assert.deepStrictEqual([run(img(2, 2, () => [9, 9, 9]), [{ op: 'scale', percent: 300 }]).width], [6]);
});
t('裁切（百分比與像素）、翻轉', () => {
  const a = img(10, 10, (x, y) => [x * 20, y * 20, 0]); const c = run(a, [{ op: 'crop', x: 50, y: 0, w: 50, h: 50 }]); assert.deepStrictEqual([c.width, c.height], [5, 5]); assert.strictEqual(px(c, 0, 0)[0], px(a, 5, 0)[0]);
  const cp = run(a, [{ op: 'crop', x: 2, y: 3, w: 4, h: 2, unit: 'px' }]); assert.deepStrictEqual([cp.width, cp.height], [4, 2]); assert.strictEqual(px(cp, 0, 0)[1], px(a, 2, 3)[1]);
  assert.strictEqual(px(run(a, [{ op: 'flip', direction: 'horizontal' }]), 0, 0)[0], px(a, 9, 0)[0]); assert.strictEqual(px(run(a, [{ op: 'flip', direction: 'vertical' }]), 0, 0)[1], px(a, 0, 9)[1]);
});
t('normalizeOps：別名（中文／英文）、縮寫、錯誤一次講完、範圍檢查', () => {
  const n = P.normalizeOps(['灰階', { op: '高斯模糊', radius: 3 }, { rotate: 90 }, { scale: 50 }, 'blur:4', { op: 'mosaic', block: 10 }, { grayscale: true }, '馬賽克']);
  assert.ok(n.ok, n.errors.join()); assert.deepStrictEqual(n.ops.map((o) => o.op), ['grayscale', 'blur', 'rotate', 'scale', 'blur', 'mosaic', 'grayscale', 'mosaic']); assert.strictEqual(n.ops[4].radius, '4'.length ? 4 : 0); assert.strictEqual(n.ops[2].degrees, 90); assert.strictEqual(n.ops[3].percent, 50);
  const e = P.normalizeOps([{ op: 'sparkle' }, { op: 'blur', radius: 999 }, { op: 'rotate' }, { op: 'scale' }, { op: 'crop' }, 42]); assert.ok(!e.ok); assert.strictEqual(e.errors.length, 6); assert.ok(/sparkle/.test(e.errors[0]) && /可用/.test(e.errors[0]));
  assert.ok(P.normalizeOps(null).ok && P.normalizeOps([]).ops.length === 0);
});
t('透明度：flatten 鋪底色；hasTransparency', () => { const a = img(1, 1, () => [0, 0, 255, 0]); assert.ok(P.hasTransparency(a)); const f = P.flatten(a, '#ffffff'); assert.deepStrictEqual(px(f, 0, 0), [255, 255, 255, 255]); assert.ok(!P.hasTransparency(f)); });
t('自然排序：img2 在 img10 前面', () => { assert.deepStrictEqual(['img10.png', 'img2.png', 'img1.png', 'IMG3.png'].sort(P.naturalCompare), ['img1.png', 'img2.png', 'IMG3.png', 'img10.png']); });
t('效能：2000×1500 做 灰階＋模糊＋縮放 在合理時間內', () => { const big = img(2000, 1500, (x, y) => [x & 255, y & 255, (x + y) & 255]); const t0 = Date.now(); run(big, ['grayscale', { op: 'blur', radius: 6 }, { op: 'scale', percent: 50 }]); assert.ok(Date.now() - t0 < 4000, (Date.now() - t0) + 'ms'); });

t('頁面排版：A4 contain 置中等比；auto 方向；cover 填滿；stretch；actual；zoom；fit 頁面＝圖片大小', () => {
  const A4 = [210 * 72 / 25.4, 297 * 72 / 25.4]; const near = (a, b, e = 0.01) => assert.ok(Math.abs(a - b) <= e, a + ' vs ' + b);
  let L = P.layoutPage(1000, 2000, { page_size: 'a4' }); near(L.pw, A4[0]); near(L.ph, A4[1]); near(L.dw / L.dh, 0.5, 1e-6); near(L.dx, (L.pw - L.dw) / 2); near(L.dy, (L.ph - L.dh) / 2); assert.ok(L.dh <= L.ph + 1e-6 && L.dw <= L.pw + 1e-6);
  L = P.layoutPage(3000, 1000, { page_size: 'a4' }); near(L.pw, A4[1]); near(L.ph, A4[0]); near(L.dw, L.pw);
  L = P.layoutPage(3000, 1000, { page_size: 'a4', orientation: 'portrait' }); near(L.pw, A4[0]); near(L.dw, L.pw); assert.ok(L.dh < L.ph);
  L = P.layoutPage(3000, 1000, { page_size: 'a4', orientation: 'portrait', fit: 'cover' }); near(L.dw, L.pw); near(L.dh, L.ph); near(L.dx, 0); near(L.dy, 0); assert.ok(L.crop && L.crop.w < 3000 && L.crop.h === 1000, JSON.stringify(L.crop)); near(L.crop.w / L.crop.h, L.pw / L.ph, 0.01); assert.strictEqual(L.crop.x, Math.round((3000 - L.crop.w) / 2));
  L = P.layoutPage(1000, 3000, { page_size: 'a4', orientation: 'portrait', fit: 'cover', margin: 20 }); near(L.dx, 20); near(L.dw, L.pw - 40); assert.ok(L.crop.h < 3000 && L.crop.w === 1000);
  L = P.layoutPage(210, 297, { page_size: 'a4', fit: 'cover' }); assert.ok(L.crop === null || (L.crop.w >= 209 && L.crop.h >= 296)); assert.strictEqual(P.layoutPage(3000, 1000, { page_size: 'a4', fit: 'contain' }).crop, null);
  L = P.layoutPage(3000, 1000, { page_size: 'a4', orientation: 'portrait', fit: 'cover', zoom: 150 }); assert.ok(L.crop.w < P.layoutPage(3000, 1000, { page_size: 'a4', orientation: 'portrait', fit: 'cover' }).crop.w);
  L = P.layoutPage(3000, 1000, { page_size: 'a4', fit: 'stretch' }); near(L.dw, L.pw); near(L.dh, L.ph);
  L = P.layoutPage(100, 100, { page_size: 'a4', fit: 'actual' }); near(L.dw, 75); L = P.layoutPage(5000, 5000, { page_size: 'a4', fit: 'actual' }); assert.ok(L.dw <= L.pw + 1e-6);
  L = P.layoutPage(1000, 2000, { page_size: 'a4', zoom: 80 }); const L100 = P.layoutPage(1000, 2000, { page_size: 'a4' }); near(L.dw, L100.dw * 0.8);
  L = P.layoutPage(960, 480, { page_size: 'fit' }); near(L.pw, 720); near(L.ph, 360); near(L.dw, 720);
  L = P.layoutPage(1000, 1000, { page_size: '100x50mm', orientation: 'landscape', margin: 10 }); near(L.pw, 100 * 72 / 25.4); near(L.dh, L.ph - 20);
  assert.throws(() => P.layoutPage(10, 10, { page_size: 'a9' }), /不認得/);
});
t('buildItemOps：rotate／scale 縮寫在前、全域 ops、頁面 ops 在後；錯誤要報', () => {
  const r = P.buildItemOps([{ op: 'grayscale' }], { rotate: 90, scale: 50, ops: [{ op: 'blur', radius: 2 }] }); assert.ok(r.ok); assert.deepStrictEqual(r.ops.map((o) => o.op), ['rotate', 'scale', 'grayscale', 'blur']);
  assert.deepStrictEqual(P.buildItemOps([], {}).ops, []); assert.ok(!P.buildItemOps([{ op: 'nope' }], {}).ok);
});
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
