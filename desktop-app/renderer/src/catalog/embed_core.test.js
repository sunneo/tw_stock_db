// node renderer/src/catalog/embed_core.test.js
const E = require('./embed_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };
const U = (id, name, summary, params) => ({ id, name, summary, params: (params || []).map((n) => ({ name: n, required: true })) });

// ---- 單元文字 ----
const u1 = U('py:math.log2', 'math.log2', 'Return the base 2 logarithm of x.', ['x']);
check('docText name/summary/params', E.docText(u1) === 'math log2. Return the base 2 logarithm of x. (x)', E.docText(u1));
check('docText appends intent', E.docText(u1, '算以 2 為底的對數').endsWith(' 算以 2 為底的對數'));
check('docText strips prefix and underscores', E.docText(U('tool:render_chart', 'render_chart', '畫圖', ['categories'])) === 'render chart. 畫圖 (categories)');
check('optional params left out', E.docText({ id: 'x', name: 'f', summary: '', params: [{ name: 'a', required: false }] }) === 'f. ');

// ---- 打包 ----
const v = Float32Array.from([0.5, -0.25, 1, 0, 3.5]);
const back = E.unpack(E.pack(v));
check('pack/unpack round-trips', back.length === 5 && Array.from(back).every((x, i) => x === v[i]), Array.from(back));
check('pack accepts plain arrays', E.unpack(E.pack([1, 2, 3])).join() === '1,2,3');
const big = Float32Array.from({ length: 384 }, (_, i) => Math.sin(i)); check('384-dim round-trip', E.unpack(E.pack(big)).every((x, i) => x === big[i]));

// ---- 存檔失效 ----
const units = [u1, U('py:math.sqrt', 'math.sqrt', 'Return the square root of x.', ['x'])];
const intents = { 'py:math.log2': '算以 2 為底的對數' };
let st = E.emptyStore(); let pend = E.pending(st, units, intents);
check('everything pending at first', pend.length === 2 && pend[0].text.includes('算以 2'), pend.map((p) => p.id));
E.putMany(st, pend, [E.normalize([1, 0, 0]), E.normalize([0, 1, 0])]);
check('nothing pending after put', E.pending(st, units, intents).length === 0);
check('intent change invalidates only that unit', E.pending(st, units, { 'py:math.log2': '對數' }).map((p) => p.id).join() === 'py:math.log2');
check('summary change invalidates', E.pending(st, [U('py:math.sqrt', 'math.sqrt', 'Square root.', ['x']), units[0]], intents).map((p) => p.id).join() === 'py:math.sqrt');
check('new unit pending', E.pending(st, units.concat([U('py:math.exp', 'math.exp', 'e^x', ['x'])]), intents).map((p) => p.id).join() === 'py:math.exp');
const vecs = E.vectorsFor(st, units, { 'py:math.log2': '改了' }); check('stale vectors dropped', vecs.size === 1 && vecs.has('py:math.sqrt'));
check('coverage', E.coverage(st, units, intents).pct === 100 && E.coverage(st, units, { 'py:math.log2': 'x' }).pct === 50);
check('JSON-serializable store', JSON.parse(JSON.stringify(st)).items['py:math.sqrt'].v === st.items['py:math.sqrt'].v);

// ---- 排名 ----
const q = E.normalize([0.9, 0.1, 0]); const ranked = E.rankDense(q, E.vectorsFor(st, units, intents), 5);
check('dense ranks closest first', ranked[0].id === 'py:math.log2' && ranked[0].score > ranked[1].score, ranked);
check('normalize makes unit length', Math.abs(E.dot(E.normalize([3, 4]), E.normalize([3, 4])) - 1) < 1e-6);
check('rankDense k limit', E.rankDense(q, E.vectorsFor(st, units, intents), 1).length === 1);

// ---- 融合 ----
const a = [{ id: 'A' }, { id: 'B' }, { id: 'C' }], b = [{ id: 'C' }, { id: 'A' }, { id: 'D' }];
const f = E.rrf([a, b]);
check('rrf: shared items on top', f[0].id === 'A' && f[1].id === 'C', f.map((x) => x.id));
check('rrf: union of both lists', f.length === 4);
check('rrf: ranks recorded', f[0].ranks.join() === '1,2');
check('rrf: single list keeps order', E.rrf([a]).map((x) => x.id).join() === 'A,B,C');
check('rrf: carries unit object', E.rrf([[{ id: 'Z', u: { name: 'z' } }]])[0].u.name === 'z');
check('rrf: ties break by id', E.rrf([[{ id: 'B' }], [{ id: 'A' }]]).map((x) => x.id).join() === 'A,B');

console.log('embed_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED' : '')); bad.forEach((x) => console.log('FAIL', x)); process.exit(bad.length ? 1 : 0);
