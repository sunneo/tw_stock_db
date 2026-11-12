'use strict';
// 混用接點（matrix_hybrid_core）：只有隱藏測資判過、非多候選的矩陣答案才採用；其餘一律回原因。
const assert = require('assert'), path = require('path');
const H = require('./matrix_hybrid_core.js'); const S = require('./matrix_synth_core.js');
const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 4242; const rnd = (a, b) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return a + ((seed >>> 8) % (b - a + 1)); };
const arr = (n) => Array.from({ length: n }, () => rnd(-50, 50));
const gen = () => { const n = rnd(2, 12); return n + '\n' + arr(n).join(' ') + '\n'; };
const ref = (s) => { const ls = s.trim().split('\n'); const a = ls[1].trim().split(/\s+/).map(Number); const o = []; for (let i = 1; i < a.length; i++) o.push(a[i] - a[i - 1]); return o.join(' '); };
const ST = '第一行 n（2≤n≤12），第二行 n 個整數。輸出相鄰兩數的差 a[i]−a[i−1]，以空格分隔。';

(async () => {
    // ① 真的合成器＋真的判題器：相鄰差（範本庫有）→ 隱藏測資判過才採用
    const seen = new Set(); const mk = (k) => { const out = []; while (out.length < k) { const i = gen(); if (seen.has(i)) continue; seen.add(i); out.push({ in: i, out: ref(i) + '\n' }); } return out; };
    const ex = mk(2), hid = mk(20); const problem = { id: 'hyb-adjdiff', tests: ex, hidden: hid, checker: 'tokens' };
    const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; };
    const r1 = await H.tryMatrix({ statement: ST, examples: ex, judge, synth: (x) => S.synth(x) });
    ok(r1.ok && r1.by === 'matrix', '相鄰差：矩陣答案經隱藏測資判過，採用：' + r1.reason);
    console.log('  ✓ 真合成＋判題：相鄰差採用（' + r1.desc + '）');

    // ② 矩陣答案在隱藏測資上不對（判題器回 WA）→ 不採用
    const wrong = async () => ({ verdict: 'WA' });
    const r2 = await H.tryMatrix({ statement: ST, examples: ex, judge: wrong, synth: (x) => S.synth(x) });
    ok(!r2.ok && /WA/.test(r2.reason), '判題 WA 時不採用（原因要帶出 WA）：' + r2.reason);
    console.log('  ✓ 判題 WA → 不採用');

    // ③ 矩陣層沒有範本 → 不採用，原因要寫出來
    const sq = { statement: '第一行 n，第二行 n 個整數。輸出平方和。', examples: [{ in: '2\n1 2\n', out: '5\n' }, { in: '1\n3\n', out: '9\n' }] };
    const r3 = await H.tryMatrix({ statement: sq.statement, examples: sq.examples, judge: judge, synth: (x) => S.synth(x) });
    ok(!r3.ok && /沒有合成/.test(r3.reason), '沒有範本時回原因：' + r3.reason);
    console.log('  ✓ 沒有範本 → 不採用（' + r3.reason.slice(0, 40) + '…）');

    // ④ 沒有獨立判題器（只有範例）→ 不採用，不能把「只對範例」當驗證
    const r4 = await H.tryMatrix({ statement: ST, examples: ex, judge: undefined, synth: (x) => S.synth(x) });
    ok(!r4.ok && /沒有獨立判題器/.test(r4.reason), '沒有判題器不採用：' + r4.reason);
    console.log('  ✓ 沒有判題器 → 不採用');

    // ⑤ 多候選（ambiguous）即使判題過也不採用
    const amb = async () => ({ ok: true, source: 'def main():\n    pass\n', verdict: 'AC', ambiguous: true, verified: false, level: 'L4', desc: 'x' });
    const r5 = await H.tryMatrix({ statement: ST, examples: ex, judge, synth: amb });
    ok(!r5.ok && /多個候選/.test(r5.reason), '多候選不採用：' + r5.reason);
    console.log('  ✓ 多候選 → 不採用');

    // ⑥ 合成器丟例外 → 不採用，不往外丟
    const boom = async () => { throw new Error('壞掉'); };
    const r6 = await H.tryMatrix({ statement: ST, examples: ex, judge, synth: boom });
    ok(!r6.ok && /矩陣層出錯/.test(r6.reason), '例外被收斂：' + r6.reason);
    console.log('  ✓ 例外 → 收斂成原因');

    // ⑦ 沒有可見測資 → 不採用
    const r7 = await H.tryMatrix({ statement: ST, examples: [], judge, synth: (x) => S.synth(x) });
    ok(!r7.ok && /沒有可見測資/.test(r7.reason), '沒有範例不採用');
    console.log('  ✓ 沒有範例 → 不採用');

    console.log(passed + ' passed, 0 failed');
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.log('0 passed, 1 failed'); process.exit(1); });
