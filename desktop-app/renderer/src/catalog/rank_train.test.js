// node renderer/src/catalog/rank_train.test.js
const T = require('./rank_train.js'); const D = require('./discover_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// ---- 可分資料：訓練得出來 ----
const rows = []; for (let g = 0; g < 6; g++) for (let i = 0; i < 8; i++) { const y = i < 2 ? 1 : 0; rows.push({ group: 'g' + g, id: g + '-' + i, y, x: { a: y ? 0.7 + rnd() * 0.3 : rnd() * 0.5, noise: rnd() } }); }
const m = T.fit(rows, { use: ['a', 'noise'] });
check('fit: weight on the informative feature dominates the noise', Math.abs(m.w[0]) > 3 * Math.abs(m.w[1]), m.w);
check('fit: predicts well on the training data', rows.filter((r) => (T.predict(m, r.x) >= 0.5) === !!r.y).length / rows.length > 0.95);
const cv = T.crossValidate(rows, { use: ['a', 'noise'] }); check('crossValidate: leave-one-group-out generalises on separable data', cv.precision === 100 && cv.recall === 100 && cv.top1 === '6/6' && cv.preds.length === rows.length, cv);

// ---- 類別不平衡與標準化 ----
const skew = []; for (let g = 0; g < 5; g++) for (let i = 0; i < 20; i++) { const y = i === 0 ? 1 : 0; skew.push({ group: 'k' + g, id: g + '-' + i, y, x: { f: (y ? 5000 : 0) + rnd() * 1000 } }); }
const ms = T.fit(skew, { use: ['f'] }); check('imbalance: the lone positive of each group is still found with unscaled features', skew.filter((r) => r.y && T.predict(ms, r.x) > 0.5).length >= 4, ms);
check('model is JSON-serialisable and predicts the same after a round trip', (() => { const m2 = JSON.parse(JSON.stringify(m)); return Math.abs(T.predict(m2, rows[0].x) - T.predict(m, rows[0].x)) < 1e-12; })());
check('missing features count as 0', Number.isFinite(T.predict(m, {})));
check('evaluate: threshold changes precision/recall', (() => { const preds = [{ group: 'a', y: 1, p: 0.9 }, { group: 'a', y: 0, p: 0.6 }, { group: 'b', y: 1, p: 0.55 }, { group: 'b', y: 0, p: 0.1 }]; const lo = T.evaluate(preds, 0.5), hi = T.evaluate(preds, 0.8); return lo.recall === 100 && lo.precision === 66.7 && hi.precision === 100 && hi.recall === 50; })());
check('evaluate: top1/top3 per group', T.evaluate([{ group: 'a', y: 0, p: 0.9 }, { group: 'a', y: 1, p: 0.8 }, { group: 'a', y: 0, p: 0.1 }], 0.5).top1 === '0/1' && T.evaluate([{ group: 'a', y: 0, p: 0.9 }, { group: 'a', y: 1, p: 0.8 }], 0.5).top3 === '1/1');

// ---- 跟 discover_core 接起來：特徵與模型排名 ----
const Card = require('./card_core.js'); const j = (...l) => l.join('\n');
const mk = (id, name, md) => ({ id, name, url: id, summary: '', card: Card.cardFromReadme(md, { name }) });
const face = mk('u/face', 'face-smooth', j('# face-smooth', '', 'Smooth skin and beautify faces in photos in the browser with WebGL.', '', '```sh', 'npm install face-smooth', '```', '', '```js', 'faceSmooth.apply(canvas, 0.6)', '```'));
const pdf = mk('u/pdf', 'pdfmaker', j('# pdfmaker', '', 'Generate PDF documents in the browser.', '', '```sh', 'npm install pdfmaker', '```'));
const gap = D.gapsFromNeeds(['smooth skin on faces'])[0];
const fs = D.featurize(gap, [face, pdf], { runtime: 'browser' });
check('featurize: one vector per candidate with every feature name', fs.length === 2 && D.FEATURES.every((n) => typeof fs[0][n] === 'number') && fs[0].rel_all > fs[1].rel_all && fs[0].is_library === 1, fs[0]);
check('featurize: dense features appear when vectors are given', (() => { const nv = (a) => { const n = Math.hypot(...a); return a.map((x) => x / n); }; const f2 = D.featurize(gap, [face, pdf], { runtime: 'browser', dense: { q: nv([1, 0]), cards: new Map([['u/face', nv([0.9, 0.1])], ['u/pdf', nv([0.1, 0.9])]]) } }); return f2[0].cos > f2[1].cos && f2[0].cos_rank === 1 && f2[1].cos_rank === 0 && f2[0].cos_z > 0 && f2[1].cos_z < 0; })());
const train = []; for (let g = 0; g < 4; g++) { train.push({ group: 'g' + g, y: 1, x: Object.assign({}, fs[0]) }); train.push({ group: 'g' + g, y: 0, x: Object.assign({}, fs[1]) }); }
const lm = T.fit(train, { use: ['rel_all', 'rel_head', 'api_hit'] });
const ranked = D.rank(gap, [pdf, face], { runtime: 'browser', model: lm });
check('rank with a trained model: scores are probabilities and the right one leads', ranked[0].id === 'u/face' && ranked[0].score > 0.5 && ranked[1].score < 0.5 && ranked[0].why[0].startsWith('模型分數'), ranked.map((x) => x.id + ':' + x.score));

console.log('rank_train: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED' : '')); bad.forEach((x) => console.log('FAIL', x)); process.exit(bad.length ? 1 : 0);
