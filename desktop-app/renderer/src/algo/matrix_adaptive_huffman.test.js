'use strict';
// G7 動態霍夫曼（matrix_adaptive_huffman_core）：① 隨機序列往返（含減半機制的長序列）；② 每一步的狀態（計數）送給獨立 Python：碼長的 Kraft 和＝1，且 Σ計數×碼長 等於 heapq 的最佳霍夫曼成本；③ 偏態序列的位元數少於定長編碼。
const assert = require('assert'), cp = require('child_process');
const A = require('./matrix_adaptive_huffman_core.js');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 31; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 65536) % n; };
const skewed = (n) => { const r = rnd(100); return r < 60 ? 0 : r < 85 ? 1 + rnd(Math.min(3, n - 1)) : rnd(n); };

// ① 往返
let bad = 0;
for (let t = 0; t < 120; t++) {
    const n = 2 + rnd(23); const len = 1 + rnd(t < 100 ? 200 : 2000);
    const s = Array.from({ length: len }, () => skewed(n));
    const bits = A.encode(n, s);
    const dec = A.decode(n, bits, s.length);
    if (JSON.stringify(dec.symbols) !== JSON.stringify(s) || dec.consumed !== bits.length) bad++;
}
ok(bad === 0, '往返失敗 ' + bad + ' 組');
console.log('① 120 組隨機序列（最長 2000，會觸發減半）往返一致');

// ② 獨立 Python：對每個採樣狀態檢查 Kraft 與最佳成本
const sample = [];
for (let t = 0; t < 60; t++) {
    const n = 2 + rnd(20); const len = 20 + rnd(300); const s = Array.from({ length: len }, () => skewed(n));
    const counts = new Array(n).fill(1);
    for (let k = 0; k < s.length; k++) {
        if (k % 5 === 0) sample.push({ counts: counts.slice(), lengths: A.huffmanLengths(counts) });
        counts[s[k]]++; if (counts.reduce((a, b) => a + b, 0) > A.DEFAULT_LIMIT) for (let i = 0; i < n; i++) counts[i] = Math.max(1, Math.ceil(counts[i] / 2));
    }
}
const PYREF = `
import sys, json, heapq
req = json.loads(sys.stdin.read()); res = []
for q in req:
    c, L = q['counts'], q['lengths']
    kraft = sum(2.0 ** -l for l in L)
    h = list(c); heapq.heapify(h); opt = 0
    while len(h) > 1:
        a = heapq.heappop(h); b = heapq.heappop(h); opt += a + b; heapq.heappush(h, a + b)
    cost = sum(ci * li for ci, li in zip(c, L))
    res.append({'kraft': kraft, 'cost': cost, 'opt': opt})
print(json.dumps(res))
`;
const r = cp.spawnSync(PY, ['-I', '-c', PYREF], { input: JSON.stringify(sample), encoding: 'utf8', timeout: 120000 });
assert.strictEqual(r.status, 0, r.stderr);
const ref = JSON.parse(r.stdout);
let badK = 0, badC = 0;
ref.forEach((x) => { if (Math.abs(x.kraft - 1) > 1e-12) badK++; if (x.cost !== x.opt) badC++; });
ok(badK === 0 && badC === 0, '狀態檢查失敗：Kraft ' + badK + '、成本 ' + badC);
console.log('② ' + sample.length + ' 個採樣狀態：碼長 Kraft 和＝1、加權成本等於獨立 Python heapq 的最佳成本（不一致 ' + (badK + badC) + '）');

// ③ 偏態序列壓縮
const n = 16; const s = Array.from({ length: 3000 }, () => skewed(n)); const bits = A.encode(n, s).length;
const fixed = s.length * 4;
ok(bits < fixed, '偏態序列：動態霍夫曼 ' + bits + ' 位元，定長 4 位元 ' + fixed);
console.log('③ 偏態序列 3000 符號：動態霍夫曼 ' + bits + ' 位元，定長 ' + fixed + ' 位元（節省 ' + (100 - Math.round(bits * 100 / fixed)) + '%）');
console.log(passed + ' passed, 0 failed');
