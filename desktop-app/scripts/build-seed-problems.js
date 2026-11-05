'use strict';
// node scripts/build-seed-problems.js
// 讀 seed-problems-src.js，用 python3 跑參考解：(1) 反驗手寫的範例輸出 (2) 產生 hidden 的輸出，寫成 renderer/src/recipe/seed/problems.jsonl。
// 注意：hidden 的輸出是參考解算的，所以 hidden 只保證「和參考解一致」；參考解本身只靠手寫範例與下面的結構檢查把關。
const fs = require('fs'); const os = require('os'); const path = require('path');
const R = require('../judge-runner.js'); const core = require('../renderer/src/recipe/judge_core.js');
const SRC = require('./seed-problems-src.js');
const OUT = path.join(__dirname, '..', 'renderer', 'src', 'recipe', 'seed', 'problems.jsonl');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-build-')); const file = path.join(dir, 'ref.py');
  const rows = []; const seen = new Set();
  try {
    for (const p of SRC) {
      if (seen.has(p.id)) throw new Error('id 重複：' + p.id); seen.add(p.id);
      fs.writeFileSync(file, p.ref + '\nmain()\n');
      const run = async (input) => { const r = await R.exec('python3', [file], { cwd: dir, input, timeoutMs: p.timeoutMs || 10000, maxOutput: 1 << 20 }); if (r.code !== 0 || r.timedOut) throw new Error(p.id + ' 參考解執行失敗：' + (r.timedOut ? '逾時' : r.stderr.slice(0, 200)) + '\n輸入：' + input.slice(0, 80)); return r.stdout; };
      for (const t of p.tests) { const got = await run(t.in); const c = core.compare(got, t.out, p.checker); if (!c.ok) throw new Error(p.id + ' 參考解和手寫範例不符：' + c.reason + '\n輸入：' + t.in); }
      const hidden = []; for (const input of p.hidden()) hidden.push({ in: input, out: await run(input) });
      const row = { id: p.id, title: p.title, statement: p.statement, tags: p.tags, checker: p.checker, timeoutMs: p.timeoutMs, tests: p.tests, hidden, ref: { python: p.ref } };
      const v = core.validateProblem(row); if (!v.ok) throw new Error(p.id + '：' + v.errors.join('；'));
      rows.push(row); console.log('ok ' + p.id + '（範例 ' + p.tests.length + '、hidden ' + hidden.length + '）');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log('寫入 ' + OUT + '：' + rows.length + ' 題');
})().catch((e) => { console.error('FAIL', e.message || e); process.exit(1); });
