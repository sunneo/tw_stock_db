'use strict';
// 領域包 par 的程式產生器測試（不需要 tree-sitter 快取）：每個骨架的每個槽位組合都產生 Python，
// 用 python 真的執行，輸出與 renderer/src/algo/par_sched_core.js（獨立寫的 JS 參考實作）逐行比對。
// 之所以不用 domain_harness：它需要 ~/.cache/fa-ts 的 Python 文法，這台機器沒有、又不准下載，會直接「略過」假通過。
const assert = require('assert'), cp = require('child_process'), path = require('path');
const PAR = require('./py_paradigms_core.js'), PK = require('./domain_par_core.js');
const SCH = require('../algo/par_sched_core.js');
const PY = process.env.FA_PYTHON || 'python3.13';
const pk = PK.make(PAR);
const byId = Object.fromEntries(pk.skeletons.map((s) => [s.algo, s]));
const N = { sc: ['n', 'p', 'k'], ls: ['a'] };
// 包一層讀輸入：第一行 n p [k]，第二行是工作量（可省）
const WRAP = ['import sys', '_L = sys.stdin.read().split("\\n")', '_v = _L[0].split()', 'n = int(_v[0]); p = int(_v[1]); k = int(_v[2]) if len(_v) > 2 else 1',
    'a = list(map(int, _L[1].split())) if len(_L) > 1 and _L[1].strip() else []'].join('\n') + '\n';
const runPy = (src, input) => { const r = cp.spawnSync(PY, ['-I', '-c', src], { input, encoding: 'utf8', timeout: 20000 }); assert.strictEqual(r.status, 0, 'python 失敗：' + r.stderr + '\n' + src); return r.stdout; };
// 固定種子的小隨機（可重現）
let seed = 20261111; const rnd = (a, b) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return a + ((seed >> 8) % (b - a + 1)); };
const cases = []; for (let t = 0; t < 14; t++) { const n = rnd(1, 14), p = rnd(1, 5), k = rnd(1, 4); const c = Array.from({ length: n }, () => rnd(1, 20)); cases.push({ n, p, k, c }); }
cases.push({ n: 1, p: 4, k: 1, c: [7] }, { n: 3, p: 5, k: 2, c: [1, 1, 9] }, { n: 8, p: 3, k: 3, c: [1, 2, 3, 4, 5, 6, 7, 8] });
const inputOf = (t, withCost) => t.n + ' ' + t.p + ' ' + t.k + '\n' + (withCost ? t.c.join(' ') + '\n' : '');
const rowsOut = (rows, dash) => rows.map((r) => (r.length ? r.join(' ') : (dash ? '-' : ''))).join('\n') + '\n';
const fails = []; let checked = 0;
const check = (name, sk, c, want, withCost, cases2) => {
    for (const t of cases2) {
        const src = WRAP + sk.py(c, N) + '\n';
        let got; try { got = runPy(src, inputOf(t, withCost)); } catch (e) { fails.push(name + ' ' + JSON.stringify(c) + ' 失敗：' + String(e.message).split('\n')[0]); return; }
        const exp = want(t); checked++;
        if (got !== exp) { fails.push(name + ' ' + JSON.stringify(c) + ' n=' + t.n + ' p=' + t.p + ' k=' + t.k + '\n期望：' + JSON.stringify(exp) + '\n實得：' + JSON.stringify(got)); return; }
    }
};
// 1) 索引分配：JS 參考 schedule（static＝區塊、cyclic、chunked＝分塊循環）；blockceil 是 ceil 切塊，另外算
const ceilOwn = (t) => { const cs = Math.ceil(t.n / t.p); const rows = Array.from({ length: t.p }, () => []); for (let i = 0; i < t.n; i++) rows[Math.floor(i / cs)].push(i); return rows; };
for (const empty of ['blank', 'dash']) for (const kind of ['block', 'blockceil', 'cyclic', 'chunked']) {
    const want = (t) => { const rows = kind === 'blockceil' ? ceilOwn(t) : kind === 'block' ? SCH.schedule('static', t.n, t.p, 1) : kind === 'cyclic' ? SCH.schedule('cyclic', t.n, t.p, 1) : SCH.schedule('chunked', t.n, t.p, t.k); return rowsOut(rows, empty === 'dash'); };
    check('assign', byId['par-assign'], { kind, empty }, want, false, cases);
}
// 2) 負載：loads／span／speedup／imb
for (const kind of ['block', 'blockceil', 'cyclic', 'chunked']) for (const out of ['loads', 'span', 'speedup', 'imb']) {
    const loadsOf = (t) => { if (kind === 'blockceil') { const rows = ceilOwn(t); return rows.map((r) => r.reduce((s, i) => s + t.c[i], 0)); } const rows = kind === 'block' ? SCH.schedule('static', t.n, t.p, 1) : kind === 'cyclic' ? SCH.schedule('cyclic', t.n, t.p, 1) : SCH.schedule('chunked', t.n, t.p, t.k); return SCH.loads(rows, t.c); };
    const want = (t) => { const ld = loadsOf(t); const sum = ld.reduce((a, b) => a + b, 0), mx = Math.max(...ld);
        if (out === 'loads') return ld.join(' ') + '\n'; if (out === 'span') return mx + '\n'; if (out === 'speedup') return (sum / mx).toFixed(3) + '\n'; return (mx * t.p / sum - 1).toFixed(3) + '\n'; };
    check('load', byId['par-load'], { kind, out }, want, true, cases);
}
// 3) 動態／引導式：makespan／各執行緒領到的索引／塊數
for (const kind of ['dynamic', 'guided']) for (const out of ['makespan', 'assign', 'chunks']) {
    const want = (t) => { const rows = SCH.schedule(kind, t.n, t.p, t.k, t.c); const ld = SCH.loads(rows, t.c);
        if (out === 'makespan') return Math.max(...ld) + '\n'; if (out === 'assign') return rowsOut(rows, false);
        let s = 0, nc = 0; while (s < t.n) { const sz = kind === 'dynamic' ? t.k : Math.max(t.k, Math.ceil((t.n - s) / t.p)); s = Math.min(t.n, s + sz); nc++; } return nc + '\n'; };
    check('dyn', byId['par-dyn'], { kind, out }, want, true, cases);
}
// 4) 推薦排程：候選（all4 含 guided；no-guided）× 平手（first／last）× 輸出（name／span）
for (const cand of ['all4', 'no-guided']) for (const tie of ['first', 'last']) for (const out of ['name', 'span']) {
    const kinds = cand === 'all4' ? ['static', 'cyclic', 'dynamic', 'guided'] : ['static', 'cyclic', 'dynamic'];
    // 產生的程式印 best（kd 名稱：static／cyclic／dynamic／guided），span 則印最大負載；dynamic／guided 的 k 為 1
    const want = (t) => { let best = null, bs = -1; for (const kd of kinds) { const ld = SCH.loads(SCH.schedule(kd, t.n, t.p, 1, t.c), t.c); const m = Math.max(...ld); if (bs < 0 || (tie === 'first' ? m < bs : m <= bs)) { bs = m; best = kd; } } return out === 'name' ? best + '\n' : bs + '\n'; };
    check('pick', byId['par-pick'], { cand, tie, out }, want, true, cases);
}
console.log('codegen 比對 ' + checked + ' 次（骨架×槽位組合×測資）');
if (fails.length) { console.log(fails.length + ' 項失敗：\n' + fails.slice(0, 12).join('\n')); console.log(checked - fails.length + ' passed, ' + fails.length + ' failed'); process.exit(1); }
console.log(checked + ' passed, 0 failed'); process.exit(0);
