// 基準自檢：每題的參考解丟進判題器（和 bench_coverage.js 同一個 judge），應該全部 AC；不是 AC 代表題庫或判題接線有問題。
const fs = require('fs'), path = require('path'); const J = require('../../judge-runner.js');
const seedDir = path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'seed');
(async () => { let bad = 0, n = 0;
    for (const f of fs.readdirSync(seedDir).filter((x) => /^bench_.*\.jsonl$/.test(x)).sort()) for (const l of fs.readFileSync(path.join(seedDir, f), 'utf8').split('\n').filter(Boolean)) {
        const p = JSON.parse(l); const j = await J.judge({ lang: 'python', source: p.ref.python + '\nmain()\n', problem: p }); n++;
        if (j.verdict !== 'AC') { bad++; console.log('✗ ' + p.id + ' ' + j.verdict + ' ' + String(j.detail).slice(0, 120)); } }
    console.log(n - bad + '/' + n + ' 參考解 AC'); process.exit(0); })();
