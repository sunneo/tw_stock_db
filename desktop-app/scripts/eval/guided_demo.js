'use strict';
// 文法引導寫作的逐步紀錄（真模型）：每一步印出「合法選項裡它選了哪個、前三名與分數」。
//   node scripts/eval/guided_demo.js --model-dir D --ort-dir D [--problem max-of-array] [--lang python] [--sig "def main()"]
const fs = require('fs'); const path = require('path');
const { makeNativeGenerate } = require('./native_gen_adapter.js'); const W = require('../../renderer/src/recipe/guided_write_core.js'); const LC = require('../../renderer/src/recipe/lang_colu_core.js'); const B = require('./code_loop_bench.js');
const argv = process.argv.slice(2); const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
(async () => {
  const lang = get('lang', 'python'); const p = B.loadProblems(get('problem', 'max-of-array'))[0]; const colu = LC.get(lang);
  const gen = makeNativeGenerate({ modelDir: get('model-dir'), ortDir: get('ort-dir'), threads: +get('threads', 8) });
  const sig = get('sig', lang === 'python' ? 'def main()' : lang === 'c' ? 'int main(void)' : 'int main()');
  const spec = p.statement + '\n範例：\n' + p.tests.slice(0, 2).map((t) => '輸入：\n' + t.in.trim() + '\n輸出：\n' + t.out.trim()).join('\n');
  const t0 = Date.now(); const r = await W.guidedWriteFunction({ lang, spec, node: { name: 'main', signature: sig, purpose: '整個程式' }, lm: { open: (m, pre) => gen.openCursor(m, pre) }, opts: { deadlineMs: 120000 }, rules: colu.rules, langLabel: colu.label, onEvent: (e) => { if (e.t === 'pick') console.log(String(e.kind).padEnd(7), JSON.stringify(e.text).padEnd(14), e.top ? e.top.map((x) => JSON.stringify(x.t) + ':' + x.lp).join('  ') : ''); else if (e.t === 'auto') console.log('auto   ', JSON.stringify(e.token)); } });
  console.log('\n結果：' + (r.ok ? '寫完' : '失敗（' + r.reason + '）') + '；打分 ' + r.calls.rank + ' 次；' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒\n' + r.code);
  if (r.ok) { const R = require('../../judge-runner.js'); const prog = (r.imports || []).join('\n') + '\n' + r.code + (lang === 'python' ? '\nmain()\n' : ''); const j = await R.judge({ lang, source: prog, problem: p }); console.log('判題：' + j.verdict + ' ' + (j.detail || '')); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
