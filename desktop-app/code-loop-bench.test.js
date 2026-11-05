// node code-loop-bench.test.js   基準腳本本身的測試：回放模式、以及用本機假的 OpenAI 相容服務走一遍 http 路徑（不是真模型）
const http = require('http'); const assert = require('assert');
const Bench = require('./scripts/eval/code_loop_bench.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };

(async () => {
  await t('回放模式：3 題全 AC、一次通過、報表有警語', async () => {
    const rep = await Bench.run({ backend: 'replay', problems: 'a-plus-b,fibonacci,anagram' });
    assert.strictEqual(rep.summary.problems, 3); assert.strictEqual(rep.summary.ac, 3); assert.strictEqual(rep.summary.first_try, 3); assert.deepStrictEqual(rep.summary.overfit, []);
    const md = Bench.toMarkdown(rep); assert.ok(md.indexOf('回放模式') >= 0 && md.indexOf('| a-plus-b | AC | ✓ |') >= 0, md);
    await assert.rejects(() => Bench.run({ backend: 'replay', lang: 'c' }), /回放模式只有 python/);
  });
  await t('http 路徑：假的 OpenAI 相容服務（依提示回切割／程式）→ 經 jsonStep 與迴圈 → AC；同時驗證請求形狀', async () => {
    const problems = Bench.loadProblems('a-plus-b,gcd-lcm'); const seen = [];
    const server = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        const j = JSON.parse(body); seen.push(j); const sys = j.messages.find((m) => m.role === 'system').content; const all = j.messages.map((m) => m.content).join('\n');
        let content;
        if (sys.indexOf('切成幾個小函式') >= 0) content = '{"functions":[{"name":"main","signature":"def main()","purpose":"整個程式","calls":[]}]}';
        else { const p = problems.find((x) => all.indexOf(x.statement.slice(0, 20)) >= 0); content = '<think>想</think>\n```python\n' + p.ref.python + '\n```'; }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
    try {
      const rows = []; const rep = await Bench.run({ backend: 'http', url: 'http://127.0.0.1:' + port + '/v1/chat/completions', model: 'fake-0.6b', problems: 'a-plus-b,gcd-lcm', stackChecks: false, progress: (r) => rows.push(r) });
      assert.strictEqual(rep.summary.ac, 2, JSON.stringify(rep.rows)); assert.strictEqual(rep.summary.model, 'fake-0.6b'); assert.strictEqual(rows.length, 2);
      assert.ok(seen.every((j) => j.model === 'fake-0.6b' && j.temperature === 0 && j.stream === false && !('prefill' in j)), '請求形狀');
      assert.ok(seen.some((j) => j.messages.some((m) => m.content.indexOf('【目標】') >= 0)), '提示帶了思考堆疊的焦點標頭');
      assert.ok(!JSON.stringify(seen).includes(problems[0].hidden[0].out.trim()) || problems[0].hidden[0].out.trim().length < 3, '提示沒有洩漏 hidden');
    } finally { server.close(); }
  });
  await t('http 服務掛掉：每題 ERROR／失敗但不丟例外，報表照出，不假裝通過', async () => {
    const rep = await Bench.run({ backend: 'http', url: 'http://127.0.0.1:9/v1/chat/completions', model: 'x', problems: 'a-plus-b', stackChecks: false });
    assert.strictEqual(rep.summary.ac, 0); assert.notStrictEqual(rep.rows[0].verdict, 'AC');
  });
  console.log('\n' + n + ' passed');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
