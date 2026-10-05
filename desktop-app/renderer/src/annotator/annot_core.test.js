const A = require('./annot_core.js');
let ok = 0, bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
// 魔術棒：藍底上有紅圓與漸層
const W = 100, H = 80, d = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; let c = [40, 60, 160]; if ((x - 50) ** 2 + (y - 40) ** 2 < 15 * 15) c = [200, 40, 40]; d.set([...c, 255], i); }
const lab = A.buildLab(d, W, H);
let r = A.wand(lab, W, H, 50, 40, 12);
check('wand circle area', Math.abs(r.area - Math.PI * 225) < 40, r.area);
check('wand circle bbox', r.bbox[0] >= 34 && r.bbox[2] <= 66 && r.bbox[2] - r.bbox[0] >= 28, r.bbox);
r = A.wand(lab, W, H, 5, 5, 12, 0.95); check('wand background', r.area > W * H * 0.7 && !r.truncated, r.area);
r = A.wand(lab, W, H, 5, 5, 12, 0.3); check('wand truncated by max fraction', r.truncated);
const cr = A.colorRangeOf(lab, A.wand(lab, W, H, 50, 40, 12).mask); check('color range covers red', cr && cr.a[0] < 60 && cr.a[1] > 50, cr);
check('relBox', JSON.stringify(A.relBox([10, 10, 20, 20], [0, 0, 100, 50])) === '[0.1,0.2,0.2,0.4]');
// 切格：三個方塊字母（間隔 6），之後空一大格再兩個
const gw = 200, gh = 30, g = new Float32Array(gw * gh).fill(1);
const block = (x0, wd) => { for (let y = 5; y < 25; y++) for (let x = x0; x < x0 + wd; x++) g[y * gw + x] = 0; };
[10, 26, 42].forEach((x) => block(x, 12)); [110, 126].forEach((x) => block(x, 12));
const cells = A.splitCells(g, gw, [0, 0, gw, gh], { dir: 'h', script: 'latin' });
check('split 5 cells', cells.length === 5, cells.map((c) => c.box));
check('word break before 4th cell', cells[3] && cells[3].gapBefore && !cells[1].gapBefore, cells.map((c) => c.gapBefore));
check('cell tight vertical', cells[0].box[1] === 5 && cells[0].box[3] === 25, cells[0].box);
// 兩個黏在一起的字母（連續 26 寬）要被切開
const g2 = new Float32Array(gw * gh).fill(1); for (let y = 5; y < 25; y++) for (let x = 10; x < 36; x++) g2[y * gw + x] = 0;
for (let y = 5; y < 25; y++) { g2[y * gw + 22] = 1; }  // 中間一條縫（1px）
const c2 = A.splitCells(g2, gw, [0, 0, gw, gh], { dir: 'h', script: 'latin' }); check('touching letters split by valley', c2.length >= 2, c2.map((c) => c.box));
// 垂直文字、漢字等寬
const vg = new Float32Array(30 * 120).fill(1); for (const y0 of [5, 45, 85]) for (let y = y0; y < y0 + 30; y++) for (let x = 3; x < 27; x++) vg[y * 30 + x] = ((x + y) % 5 === 0) ? 1 : 0;
const vc = A.splitCells(vg, 30, [0, 0, 30, 120], { dir: 'v', script: 'cjk' }); check('vertical cjk 3 cells', vc.length === 3, vc.map((c) => c.box));
// 字形特徵：同一形狀不同大小 → 高相似；不同形狀 → 較低
const mk = (fn, S) => { const w = 60, h = 60, im = new Float32Array(w * h).fill(1); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fn(x / S, y / S)) im[y * w + x] = 0; return { im, w, h }; };
const bar = (x, y) => x > 0.4 && x < 0.6 && y > 0.1 && y < 0.9, box = (x, y) => x > 0.1 && x < 0.9 && y > 0.1 && y < 0.9;
const f1 = A.glyphFeature(mk(bar, 40).im, 60, [0, 0, 60, 60]), f2 = A.glyphFeature(mk(bar, 55).im, 60, [0, 0, 60, 60]), f3 = A.glyphFeature(mk(box, 50).im, 60, [0, 0, 60, 60]);
check('glyph same shape high sim', A.similarity(f1.f, f2.f) > 0.93, A.similarity(f1.f, f2.f)); check('glyph different shape lower', A.similarity(f1.f, f3.f) < 0.6, A.similarity(f1.f, f3.f));
const rk = A.rankGlyph(f1, [{ ch: 'l', f: f2.f, aspect: f2.aspect }, { ch: 'o', f: f3.f, aspect: f3.aspect }], 2); check('rankGlyph picks l', rk[0].ch === 'l', rk);
// 詞庫過濾：直接讀成 'hcllo'（c 與 e 很像），詞庫把它拉成 hello
const mkc = (...cs) => ({ cands: cs.map(([ch, score]) => ({ ch, score })), gapBefore: false });
const cl = [mkc(['h', .9]), mkc(['c', .8], ['e', .78]), mkc(['l', .9]), mkc(['l', .9]), mkc(['o', .9])];
let gwds = A.guessWords(cl, ['hello', 'world', 'help', 'hallo']);
check('lexicon fixes hcllo→hello', gwds[0].direct === 'hcllo' && gwds[0].best === 'hello' && gwds[0].from_lexicon, gwds[0]);
cl[1] = mkc(['c', .9], ['e', .3]); gwds = A.guessWords(cl, ['hello']); check('confident misread keeps direct when lexicon much worse', gwds[0].best === 'hcllo', gwds[0]);
cl.push(Object.assign(mkc(['w', .9]), { gapBefore: true })); gwds = A.guessWords(cl, ['hello', 'w']); check('word groups by gap', gwds.length === 2 && gwds[1].length === 1);
// 字形碼
const tbl = A.parseCodeTable('明\tab\n日\ta\n月\tb\n晴\tabqmd\n', 'cangjie').map((r) => r); tbl.forEach((r) => { if (r.ch === '明') r.four_corner = '6702'; });
check('parse table', tbl.length === 4 && tbl[0].cangjie === 'ab', tbl);
check('filter cangjie wildcard', A.filterGlyphs(tbl, { cangjie: 'a?' }).map((r) => r.ch).join('') === '明', A.filterGlyphs(tbl, { cangjie: 'a?' }));
check('filter prefix', A.filterGlyphs(tbl, { cangjie: 'ab' }, { prefix: true }).map((r) => r.ch).join('') === '明晴');
check('filter combined four corner', A.filterGlyphs(tbl, { cangjie: 'ab*', four_corner: '67*' }).map((r) => r.ch).join('') === '明');
const uni = A.parseCodeTable('U+660E\tkCangjie\tab\nU+660E\tkFourCornerCode\t6702.0\nU+65E5\tkCangjie\ta\n', 'cangjie'); check('parse unihan', uni.length === 2 && uni[0].ch === '明' && uni[0].cangjie === 'ab', uni);
console.log(ok + ' passed, ' + bad.length + ' failed', bad);
