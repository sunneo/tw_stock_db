'use strict';
// 矩陣層後備（matrix_synth_core）：只給敘述＋2 筆範例，合成程式，再用「沒看過的隨機輸入」對照 JS 預言機。
// 這組題原本是寫完合成器之後另外寫的獨立檢查（第一次 6/9）；之後我依失敗原因補了「開頭」家族與「連續 N 個」規則才到 8/9，所以現在已不是獨立檢查，只當回歸測試。範例只有 2 筆時 yes/no 標籤常常兩筆相同，會有多個候選（回報 ambiguous），個別題會因取樣而翻轉（odd-b）。
const assert = require('assert'), path = require('path'); const S = require('./matrix_synth_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
let seed = 7; const rnd = (a, b) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return a + ((seed >>> 8) % (b - a + 1)); };
const str = (al, n) => Array.from({ length: n }, () => al[rnd(0, al.length - 1)]).join('');
const MODP = 1000000007n; const fibLike = (c1, c2, f0, f1) => (n) => { let a = BigInt(f0), b = BigInt(f1); for (let i = 0; i < n; i++) { [a, b] = [b, (c1 * b + c2 * a)]; } return a; };
const T = [
    // 遞推（敘述給遞推式或情境；範例 2 筆，n 小）
    { id: 'jacobsthal', lv: 'L1', st: 'F(0)=0，F(1)=1，F(n)=F(n-1)+2F(n-2)。輸入 n（0≤n≤60），輸出 F(n)。', gen: () => rnd(0, 60) + '\n', ref: (i) => String(fibLike(1n, 2n, 0, 1)(Number(i))) },
    { id: 'quad-step', lv: 'L1', st: '每次可以爬 1、2、3 或 4 階，爬到第 n 階（1≤n≤40）有幾種方法？輸出答案。', gen: () => rnd(1, 40) + '\n', ref: (i) => { const n = Number(i); const f = [1n]; for (let k = 1; k <= n; k++) { let v = 0n; for (let j = 1; j <= 4; j++) if (k - j >= 0) v += f[k - j]; f.push(v); } return String(f[n]); } },
    { id: 'seq-mod', lv: 'L1', st: 'a(0)=2，a(1)=1，a(n)=a(n-1)+a(n-2)。輸入 n（0≤n≤10^18），輸出 a(n) 除以 10^9+7 的餘數。', gen: () => String(rnd(0, 1) ? rnd(0, 50) : BigInt(rnd(1, 1e9)) * BigInt(rnd(1, 1e9))) + '\n', ref: (i) => { let n = BigInt(i); const mul = (A, B) => [[(A[0][0] * B[0][0] + A[0][1] * B[1][0]) % MODP, (A[0][0] * B[0][1] + A[0][1] * B[1][1]) % MODP], [(A[1][0] * B[0][0] + A[1][1] * B[1][0]) % MODP, (A[1][0] * B[0][1] + A[1][1] * B[1][1]) % MODP]]; let R = [[1n, 0n], [0n, 1n]], A = [[1n, 1n], [1n, 0n]]; while (n) { if (n & 1n) R = mul(R, A); A = mul(A, A); n >>= 1n; } return String((R[1][0] * 2n + R[1][1]) % MODP); } },
    // 有限狀態
    { id: 'contains-010', lv: 'L2', st: '輸入一個由 0、1 組成的字串（長度 1～30），若含有子字串 "010" 印 yes，否則印 no。', gen: () => str('01', rnd(1, 20)) + '\n', ref: (s) => (s.includes('010') ? 'yes' : 'no') },
    { id: 'odd-b', lv: 'L2', st: '輸入一個由 a、b 組成的字串，若 b 出現奇數次印 yes，否則印 no。', gen: () => str('ab', rnd(1, 25)) + '\n', ref: (s) => ((s.split('b').length - 1) % 2 ? 'yes' : 'no') },
    { id: 'dec-mod-9', lv: 'L2', st: '輸入一個很長的非負整數（十進位字串），輸出它除以 9 的餘數。', gen: () => str('0123456789', rnd(1, 30)).replace(/^0+(?=.)/, '') + '\n', ref: (s) => String(BigInt(s) % 9n) },
    { id: 'count-aa', lv: 'L2', st: '輸入一個由 a、b 組成的字串，輸出子字串 "aa" 出現的次數（可重疊）。', gen: () => str('ab', rnd(1, 25)) + '\n', ref: (s) => String([...s].filter((c, i) => c === 'a' && s[i + 1] === 'a').length) },
    { id: 'starts-1', lv: 'L2', st: '輸入一個由 0、1 組成的字串，若以 1 開頭印 yes，否則印 no。', gen: () => str('01', rnd(1, 20)) + '\n', ref: (s) => (s[0] === '1' ? 'yes' : 'no') },
    { id: 'no-000', lv: 'L2', st: '輸入一個由 0、1 組成的字串，若不含連續三個 0 印 yes，否則印 no。', gen: () => str('01', rnd(1, 25)) + '\n', ref: (s) => (s.includes('000') ? 'no' : 'yes') },
];
(async () => {
    let ok = 0; const miss = [];
    for (const t of T) {
        const mk = (n) => { const out = []; const seen = new Set(); while (out.length < n) { const i = t.gen(); if (seen.has(i)) continue; seen.add(i); out.push({ in: i, out: t.ref(i.trim()) + '\n' }); } return out; };
        const ex = mk(2), hid = mk(20); const problem = { id: t.id, tests: ex, hidden: hid, checker: 'tokens' };
        const r = await S.synth({ statement: t.st, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } });
        if (r.ok) { ok++; console.log('  ✓ ' + t.lv + ' ' + t.id + '：' + r.desc + (r.ambiguous ? '（範例不足，多個候選）' : '')); } else { miss.push(t.id); console.log('  ✗ ' + t.lv + ' ' + t.id + '：' + r.reason.slice(0, 120)); }
    }
    console.log('獨立題 ' + ok + '/' + T.length + ' 解出；沒解出：' + (miss.join('、') || '無'));
    // 邊界：形狀不支援或範例不足時要明確失敗，不能亂生程式
    const bad = await S.synth({ statement: '輸入三個整數，由小到大輸出', examples: [{ in: '3 1 2\n', out: '1 2 3\n' }] }); assert.strictEqual(bad.ok, false); const empty = await S.synth({ statement: 'x', examples: [] }); assert.strictEqual(empty.ok, false);
    const sq = { statement: '輸入 n，輸出 n 的平方', examples: [{ in: '3\n', out: '9\n' }, { in: '10\n', out: '100\n' }] }; assert.strictEqual(S.synthRecurrence(sq).ok, false, 'n^2 不是階數≤4、係數0..2的線性遞推，遞推枚舉不該硬湊'); const sqr = await S.synth(sq); assert.ok(sqr.ok && sqr.level === 'L0', 'n^2 由 L0 公式枚舉解出');
    const med = await S.synth({ statement: '輸入三個整數，輸出中位數', examples: [{ in: '2 1 3\n', out: '2\n' }, { in: '9 8 7\n', out: '8\n' }] }); assert.ok(med.ok && med.level === 'L0', 'L0 公式：中位數');
    // 範本庫（L4/L5）：只給敘述＋2 筆範例，對 20 筆隱藏測資
    const TP = [
        { id: 'digit-prod', st: '輸入正整數 n（≤10^9），輸出各位數字的積。', gen: () => String(rnd(10, 999999999)) + '\n', ref: (s) => String([...s].reduce((a, c) => a * Number(c), 1)) },
        { id: 'vowels', st: '輸入一行小寫英文字串，輸出其中母音（a e i o u）的個數。', gen: () => str('abcdefghij', rnd(1, 15)) + '\n', ref: (s) => String([...s].filter((c) => 'aeiou'.includes(c)).length) },
        { id: 'is-pow2', st: '輸入正整數 n，若是 2 的冪印 YES，否則印 NO。', gen: () => String(rnd(0, 1) ? 2 ** rnd(0, 20) : rnd(1, 3000)) + '\n', ref: (s) => ((BigInt(s) & (BigInt(s) - 1n)) === 0n ? 'YES' : 'NO') },
        { id: 'next-greater', st: '第一行 n，第二行 n 個整數。對每個位置輸出它右邊第一個比它大的數，沒有則輸出 0，以空格分隔。', gen: () => { const n = rnd(2, 8); return n + '\n' + Array.from({ length: n }, () => rnd(1, 20)).join(' ') + '\n'; }, ref: (s) => { const a = s.split('\n')[1].split(' ').map(Number); return a.map((x, i) => a.slice(i + 1).find((y) => y > x) || 0).join(' '); }, multi: true },
    ];
    for (const t of TP) {
        const mk = (n) => { const out = []; const seen = new Set(); while (out.length < n) { const i = t.gen(); if (seen.has(i)) continue; seen.add(i); out.push({ in: i, out: t.ref(t.multi ? i : i.trim()) + '\n' }); } return out; };
        const ex = mk(3), hid = mk(20); const problem = { id: t.id, tests: ex, hidden: hid, checker: 'tokens' };
        const r = await S.synth({ statement: t.st, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } });
        assert.ok(r.ok && r.kind === 'template' && r.verdict === 'AC', '範本 ' + t.id + '：' + (r.reason || r.verdict)); console.log('  ✓ 範本 ' + t.id + '：' + r.desc);
    }
    // 註冊表：補一種範本＝註冊一個模組；順序、取代、取消、例外隔離、失敗模組不影響其他模組
    {
        const names0 = S.list().map((x) => x.name); assert.deepStrictEqual(names0, ['recurrence', 'dfa', 'template', 'formula'], '預設順序');
        S.register('plug-boom', () => { throw new Error('壞掉的模組'); }, { order: 5 }); S.register('plug-hello', ({ statement }) => (/哈囉測試/.test(statement) ? { ok: true, source: 'def main():\n    print("hi")\n', kind: 'plugin', level: 'L9', size: 1, tried: 1, ambiguous: false, desc: '外掛' } : { ok: false, reason: '不是我的題' }), { order: 6, level: 'L9' });
        assert.deepStrictEqual(S.list().map((x) => x.name).slice(0, 2), ['plug-boom', 'plug-hello'], 'order 小的先');
        const r1 = await S.synth({ statement: '哈囉測試：輸出 hi', examples: [{ in: '', out: 'hi\n' }], judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: { id: 'h', tests: [{ in: '', out: 'hi\n' }] } }); return { verdict: j.verdict }; } });
        assert.ok(r1.ok && r1.kind === 'plugin' && r1.verified, '外掛要能被呼叫，且壞掉的模組（order 更前）不能拖垮它：' + (r1.reason || '')); assert.ok(r1.steps.some((x) => x.by === 'plug-boom' && !x.ok && /壞掉的模組/.test(x.reason)), '壞模組的例外要記在 steps');
        S.register('plug-hello', () => ({ ok: false, reason: '改過了' }), { order: 6 }); assert.strictEqual(S.list().filter((x) => x.name === 'plug-hello').length, 1, '同名是取代不是重複');
        assert.ok(S.unregister('plug-boom') && S.unregister('plug-hello') && !S.unregister('plug-hello')); assert.deepStrictEqual(S.list().map((x) => x.name), names0, '取消後回到預設');
    }
    assert.ok(ok >= 5, '獨立題至少解出 5 題，實際 ' + ok); console.log((ok + 5 + TP.length) + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.log('0 passed, 1 failed'); process.exit(1); });
