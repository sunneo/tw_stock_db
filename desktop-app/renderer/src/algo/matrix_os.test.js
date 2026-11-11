'use strict';
// 矩陣層作業系統模組：
//  ① 置換矩陣版 LRU 命中數 = 清單版（300 個隨機：容量 1～4、字母表 2～8、序列 5～34，與設計 §12.1 實測同設定）；環形移位矩陣版 FIFO 缺頁數 = 清單版；
//  ② Petri 網 M ← M + C·f 對逐步發射的字典版（200 個隨機網）；③ 題庫 heldout7 的 OS 題（lru／fifo／rr／petri）經 judge；④ 誠實失敗。
const assert = require('assert'), fs = require('fs'), path = require('path');
const S = require('./matrix_synth_core.js'); const O = require('./matrix_os_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
assert.strictEqual(O.install(S), true); let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 777; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
for (let t = 0; t < 300; t++) {
    const k = 1 + rnd(4), V = 2 + rnd(7), n = 5 + rnd(30); const seq = Array.from({ length: n }, () => rnd(V));
    const ref = O.cacheSim('lru', k, seq); const m = O.lruMatrix(k, V, seq); ok(m.hits === ref.hits, 'LRU 置換矩陣命中數 ' + m.hits + ' ≠ 清單版 ' + ref.hits);
    const rf = O.cacheSim('fifo', k, seq); const fm = O.fifoMatrix(k, V, seq); ok(fm.faults === rf.miss, 'FIFO 環形移位矩陣缺頁數不符');
    // 最後留在快取的集合也要一致（矩陣的非零列對應的鍵）
    const keysM = m.S.map((row) => row.indexOf(1)).filter((x) => x >= 0).sort((a, b) => a - b); ok(keysM.join() === ref.final.slice().sort((a, b) => a - b).join(), 'LRU 最後內容集合不符');
}
console.log('① LRU 置換矩陣、FIFO 環形移位矩陣各 300 個隨機序列與清單版一致（命中數／缺頁數／最後內容）');
for (let t = 0; t < 200; t++) {
    const p = 1 + rnd(4), tn = 1 + rnd(4); const tr = Array.from({ length: tn }, () => ({ c: Array.from({ length: p }, () => rnd(3)), g: Array.from({ length: p }, () => rnd(3)) }));
    const m0 = Array.from({ length: p }, () => rnd(10)); const seq = Array.from({ length: rnd(8) }, () => rnd(tn));
    let mk = m0.slice(); for (const j of seq) mk = mk.map((v, i) => v - tr[j].c[i] + tr[j].g[i]);
    const C = Array.from({ length: p }, (_, i) => tr.map((x) => x.g[i] - x.c[i])); ok(O.petriMatrix(C, m0, seq).join() === mk.join(), 'Petri 矩陣版不符');
}
console.log('② Petri 網 M ← M + C·f 對逐步發射一致（200 個隨機網）');
const dir = path.join(__dirname, '..', 'recipe', 'seed'); const load = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
(async () => {
    const ps = load('heldout7_mixed.jsonl').filter((p) => /^h7-(lru-hits|fifo-faults|rr-finish|petri)$/.test(p.id)); let n = 0;
    for (const p of ps) { const ex = p.tests.slice(0, 2), hid = p.tests.slice(2).concat(p.hidden || []); const problem = { id: p.id, tests: ex, hidden: hid, checker: 'tokens' }; const r = await S.synth({ statement: p.statement, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } }); console.log((r.ok ? (r.verified ? '✓ ' : '△ ') : '✗ ') + p.id + ' ' + (r.desc || r.reason || '').slice(0, 80)); if (r.ok) n++; }
    console.log('③ heldout7 OS 題 ' + n + '/' + ps.length); ok(n === ps.length, 'OS 題全過');
    ok(!(await O.synthCache({ statement: 'x', examples: [] })).ok, '沒有範例要失敗'); ok(!(await O.synthCache({ statement: 'x', examples: [{ in: '2 3\n1 2 3\n', out: '999\n' }] })).ok, '不符的輸出要失敗'); ok(!(await O.synthPetri({ statement: 'x', examples: [{ in: '1 2\n3 4\n', out: '5\n' }] })).ok, '形狀不符要失敗');
    console.log(passed + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
