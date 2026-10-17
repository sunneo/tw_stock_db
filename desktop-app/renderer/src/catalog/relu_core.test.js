// node renderer/src/catalog/relu_core.test.js
const M = require('./matrix_core.js'); const R = require('./relu_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };
let seed = 20261017; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const bitsEq = (X, Y) => { if (X.n !== Y.n) return false; for (let i = 0; i < X.n; i++) for (let w = 0; w < X.w; w++) if (X.rows[i][w] !== Y.rows[i][w]) return false; return true; };

// ---- 三個零件 ----
check('relu', R.relu(-3) === 0 && R.relu(0) === 0 && R.relu(2.5) === 2.5);
check('sat(x) = x - relu(x-1) 把計數壓成 0/1（非負整數精確）', [0, 1, 2, 3, 7, 1000].map(R.sat).join() === '0,1,1,1,1,1');
check('max2(a,b) = b + relu(a-b) 就是 max', [[1, 2], [5, 3], [-1, -4], [0, 0], [2.5, 2.5]].every(([a, b]) => R.max2(a, b) === Math.max(a, b)));

// ---- 可達性：ReLU 形式 = 位元版（逐位元相同）----
let allSame = true, cases = 0;
for (const [n, d] of [[1, 0.5], [3, 0.5], [8, 0.3], [31, 0.1], [32, 0.1], [33, 0.1], [65, 0.06], [90, 0.04], [120, 0.05]]) {
    for (let t = 0; t < 3; t++) {
        const A = M.newBits(n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (rnd() < d) M.setBit(A, i, j);
        const ref = M.reachWithin(A, 4), got = R.reachWithin(A, 4); cases++;
        for (let k = 1; k <= 4; k++) if (!bitsEq(ref[k], got[k])) { allSame = false; bad.push('reach n=' + n + ' k=' + k); }
    }
}
check('reachWithin：' + cases + ' 個隨機矩陣、L=4，ReLU 版與位元版逐位元相同', allSame);
const chain = M.newBits(6); for (let i = 0; i < 5; i++) M.setBit(chain, i, i + 1);
const rc = R.reachWithin(chain, 5); check('鏈：第 k 步剛好多走一格', M.getBit(rc[2], 0, 2) === 1 && M.getBit(rc[2], 0, 3) === 0 && M.getBit(rc[5], 0, 5) === 1 && M.getBit(rc[5], 5, 0) === 0);
const cyc = M.newBits(3); M.setBit(cyc, 0, 1); M.setBit(cyc, 1, 2); M.setBit(cyc, 2, 0); const rcy = R.reachWithin(cyc, 6); check('有環：計數會變大但壓縮後還是 0/1', bitsEq(rcy[6], M.reachWithin(cyc, 6)[6]) && M.getBit(rcy[6], 0, 0) === 1);

// ---- 真正的 relu 網路：x → relu(Wx+b) 的層疊 ----
let netSame = true; const nets = [];
for (const [n, d, L] of [[5, 0.3, 3], [12, 0.15, 4], [40, 0.05, 4]]) {
    const A = M.newBits(n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (rnd() < d) M.setBit(A, i, j);
    const net = R.reachNet(A, L); nets.push(net); const ref = M.reachWithin(A, L)[L];
    for (let s = 0; s < n; s++) { const x = new Float32Array(n); x[s] = 1; const y = R.forward(net, x); for (let j = 0; j < n; j++) { const want = j === s ? 1 : M.getBit(ref, s, j); if (y[j] !== want) { netSame = false; bad.push('net n=' + n + ' s=' + s + ' j=' + j + ' got ' + y[j] + ' want ' + want); } } }
}
check('reachNet：ReLU 層疊對每個起點，輸出等於「最多走 L 步到得了（含自己）」', netSame);
check('reachNet 的層：前面都是 relu，最後一層線性；層數 = L + 1', nets.every((net) => net.layers.length === net.L + 1 && net.layers.slice(0, -1).every((l) => l.act === 'relu') && net.layers[net.layers.length - 1].act === 'linear'));
check('reachNet 的輸出只有 0 和 1', (() => { const A = M.newBits(6); M.setBit(A, 0, 1); M.setBit(A, 0, 2); M.setBit(A, 1, 3); M.setBit(A, 2, 3); M.setBit(A, 3, 0); const net = R.reachNet(A, 5); const x = new Float32Array(6); x[0] = 1; return Array.from(R.forward(net, x)).every((v) => v === 0 || v === 1); })());
check('多個起點同時（向量相加再壓縮）也對', (() => { const A = M.newBits(5); M.setBit(A, 0, 1); M.setBit(A, 3, 4); const net = R.reachNet(A, 1); const x = Float32Array.from([1, 0, 0, 1, 0]); const y = Array.from(R.forward(net, x)); return y.join() === '1,1,0,1,1'; })());

// ---- 最佳接線分數：動態規劃（max 用 ReLU 算）= findPipelines 第一名 ----
const U = (name, params, returns, extra) => Object.assign({ id: 'tool:' + name, runtime: 'app', name, summary: '', params: params.map(([n, t, req]) => ({ name: n, kind: 'named', type: t, type_src: 'schema', required: !!req })), returns: { type: returns, type_src: 'doc' }, effects: ['state.read'], pure: false, avail: { state: 'builtin', needs: [] }, domains: [], tests: [], tier: 1 }, extra || {});
const units = [
    U('download', [['url', 'url', true]], 'object{ok:bool,file_id:file_id}'), U('to_pdf', [['file_id', 'file_id', true], ['page_size', 'text']], 'object{ok:bool,pdf_file_id:file_id}'),
    U('remove_pages', [['file_id', 'file_id', true], ['pages', 'list<int>', true]], 'object{ok:bool,pdf_file_id:file_id,filename:text}'), U('pdf_images', [['file_id', 'file_id', true]], 'object{ok:bool,image_file_id:file_id}'),
    U('describe', [['file_id', 'file_id', true]], 'object{text:text}'), U('say', [['text', 'text', true]], 'object{ok:bool}'), U('search', [['query', 'query', true]], 'object{urls:list<url>}'),
];
const mx = M.buildMatrix(units); const q1 = { from: 'url', to: 'file_id' };
const ref1 = M.findPipelines(mx, q1, { k: 10 }).paths[0], got1 = R.bestPipeline(mx, q1);
check('範例目錄：第一名分數與路徑相同', Math.abs(ref1.score - got1.score) <= 0.0006 && ref1.units.join() === got1.units.join(), { ref: [ref1.score, ref1.units], got: [got1.score, got1.units] });
const q2 = { from: 'url', to: 'pdf_file' }; const ref2 = M.findPipelines(mx, q2, { k: 5 }).paths[0], got2 = R.bestPipeline(mx, q2);
check('另一組起訖也相同（沒有路線時兩邊都是空）', (!ref2 && got2.score === 0) || (ref2 && Math.abs(ref2.score - got2.score) <= 0.0006), { ref2, got2 });
check('沒有路線：分數 0、路徑空', R.bestPipeline(mx, { from: 'bool', to: 'file_id' }).score === 0 && R.bestPipeline(mx, { from: 'url', to: 'yaml' }).units.length === 0);
const q3 = { from: { unit: 'tool:download' }, to: { unit: 'tool:pdf_images' } }; const ref3 = M.findPipelines(mx, q3, { k: 3 }).paths[0], got3 = R.bestPipeline(mx, q3);
check('單元到單元：相同', ref3 && Math.abs(ref3.score - got3.score) <= 0.0006 && ref3.units.join() === got3.units.join(), { ref3, got3 });

// 隨機目錄：30 個單元，幾種型別
const TYPES = ['url', 'file_id', 'text', 'pdf_file', 'image_file', 'path', 'number', 'int', 'query', 'audio_file'];
let rndSame = 0, rndTotal = 0, rndBad = [];
for (let c = 0; c < 6; c++) {
    const us = []; for (let i = 0; i < 30; i++) { const np = 1 + ((rnd() * 3) | 0); const ps = []; for (let p = 0; p < np; p++) ps.push(['p' + p, TYPES[(rnd() * TYPES.length) | 0], rnd() < 0.7]); const rt = TYPES[(rnd() * TYPES.length) | 0]; us.push(U('u' + c + '_' + i, ps, 'object{ok:bool,out:' + rt + '}')); }
    const m = M.buildMatrix(us, { minScore: 0.3 });
    for (let t = 0; t < 12; t++) {
        const q = { from: TYPES[(rnd() * TYPES.length) | 0], to: TYPES[(rnd() * TYPES.length) | 0] }; const ref = M.findPipelines(m, q, { k: 3 }).paths[0], got = R.bestPipeline(m, q); rndTotal++;
        const same = ref ? Math.abs(ref.score - got.score) <= 0.0006 : got.score === 0; if (same) rndSame++; else rndBad.push([q, ref && ref.score, got.score, ref && ref.units.length, got.length]);
    }
}
check('隨機目錄 ' + rndTotal + ' 組起訖：最佳分數都與 findPipelines 第一名相同', rndSame === rndTotal, rndBad.slice(0, 3));

// ---- 後端一致性檢查 ----
check('預設後端通過一致性檢查', R.selfCheck(R.matmulJs).ok);
const wrong = (X, Y, n) => { const C = R.matmulJs(X, Y, n); if (C.length) C[C.length - 1] += 1; return C; };
const sc = R.selfCheck(wrong); check('算錯的後端會被擋下來', !sc.ok && sc.failed.length > 0, sc);
const slicedRows = (X, Y, n) => { const C = new Float32Array(n * n); const half = n >> 1; const part = (lo, hi) => { for (let i = lo; i < hi; i++) for (let k = 0; k < n; k++) { const a = X[i * n + k]; if (!a) continue; for (let j = 0; j < n; j++) C[i * n + j] += a * Y[k * n + j]; } }; part(0, half); part(half, n); return C; };
check('把列切成兩段各自算（Worker 平行版的做法）一樣通過', R.selfCheck(slicedRows).ok);
R.use({ name: 'sliced', matmul: slicedRows }); const A5 = M.newBits(40); for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) if (rnd() < 0.1) M.setBit(A5, i, j);
check('換後端之後結果不變', R.current() === 'sliced' && bitsEq(R.reachWithin(A5, 3)[3], M.reachWithin(A5, 3)[3])); R.use(null); check('可以換回預設', R.current() === 'js');

console.log('relu_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' failed ' + JSON.stringify(bad) : ''));
if (bad.length) process.exit(1);
