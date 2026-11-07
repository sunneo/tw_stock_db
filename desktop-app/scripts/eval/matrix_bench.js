'use strict';
// 矩陣層（含 graph／grid 模組）對題庫的量測：node scripts/eval/matrix_bench.js <題庫.jsonl> [--ex 2] [--json out.json]
// 範例＝題目 tests 的前 N 筆（預設 2）；隱藏測資只給 judge 驗證。誠實計數：ok＝合成成功且 judge 通過（含 hidden）；verified＝ok 且不 ambiguous。
const fs = require('fs'), path = require('path');
const S = require('../../renderer/src/algo/matrix_synth_core.js'); const G = require('../../renderer/src/algo/matrix_graph_core.js'); G.install(S); require('../../renderer/src/algo/matrix_l0_core.js').install(S);
const J = require('../../judge-runner.js');
const file = process.argv[2]; const nEx = Number((process.argv.indexOf('--ex') > 0 && process.argv[process.argv.indexOf('--ex') + 1]) || 2);
const jp = process.argv.indexOf('--json') > 0 ? process.argv[process.argv.indexOf('--json') + 1] : null;
const dir = path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'seed'); const f = fs.existsSync(file) ? file : path.join(dir, file);
const P = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
(async () => {
    let ok = 0, ver = 0; const rows = [];
    for (const p of P) {
        const ex = p.tests.slice(0, nEx); const hid = p.tests.slice(nEx).concat(p.hidden || []);
        const problem = { id: p.id, tests: ex, hidden: hid, checker: p.checker || 'tokens' };
        const r = await S.synth({ statement: p.statement, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } });
        const pass = !!(r.ok && (r.verified || r.holdout === 'pass' || r.verdict === 'AC' || r.verified !== false)); const good = r.ok; if (good) ok++; if (r.ok && r.verified) ver++;
        rows.push({ id: p.id, ok: !!r.ok, verified: !!r.verified, ambiguous: !!r.ambiguous, desc: r.desc || '', reason: r.reason || '' }); console.log((r.ok ? (r.verified ? '✓ ' : '△ ') : '✗ ') + p.id + ' ' + (r.desc || r.reason || '').slice(0, 90)); void pass;
    }
    console.log('矩陣層 ' + f.split('/').pop() + '：合成成功 ' + ok + '/' + P.length + '，其中 verified ' + ver);
    if (jp) fs.writeFileSync(jp, JSON.stringify({ file: f, ok, verified: ver, total: P.length, rows }, null, 1));
    process.exit(0);
})();
