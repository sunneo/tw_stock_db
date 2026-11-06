// 涵蓋率基準（模式 A＝只用 Blockly 離線組合，不問模型）：對 bench_*.jsonl（60 題，種子沒見過的，分 L0～L6／other）跑 write_code 的離線管線，
//   輸出每級題數／解出數／用到哪層／嘗試次數／耗時，以及解不出的清單與原因。設計見 DESIGN.matrix-fallback.md §7。
//   矩陣層（模式 B）與模型（模式 C）做完後在這裡加。
// 用法：xvfb-run -a node scripts/eval/run_eval.js scripts/eval/bench-coverage.eval.js 17962
const fa = window.fa; const R = {};
const api = window.desktopAPI; const execApi = api.exec || api.execApi || null; if (execApi && execApi.setSettings) await execApi.setSettings({ execEnabled: true, execConfirmRequired: false });
const FILES = ['bench_L1_L2', 'bench_L3_L4', 'bench_L0_L5_L6', 'bench_extra'];
const probs = []; for (const f of FILES) { const t = await (await fetch('src/recipe/seed/' + f + '.jsonl').catch(() => ({ text: async () => '' }))).text(); for (const l of t.split('\n').filter(Boolean)) probs.push(JSON.parse(l)); }
R.total = probs.length; if (!probs.length) { R.error = '讀不到 bench_*.jsonl'; return R; }
fa._pyNoLessons = false; const rows = []; const t0 = Date.now();
for (const p of probs) {
    const t1 = Date.now(); let w; try { w = await fa._codeAgent({ task: p.statement, language: 'python', tests: p.tests.concat(p.hidden || []).slice(0, 8) }); } catch (e) { w = { ok: false, error: String((e && e.message) || e) }; }
    const pass = !!(w.verified && w.mode === 'offline'); const o = w.offline || {};
    rows.push({ id: p.id, level: p.level, pass, by: o.paradigm ? 'paradigm:' + o.paradigm : o.lesson ? 'lesson:' + o.lesson : o.recipe ? 'recipe:' + o.recipe : '-', tried: o.tried, err: w.ok ? undefined : String(w.error || (w.gaps && w.gaps.join('；')) || '').slice(0, 120), ms: Date.now() - t1 });
}
R.totalMs = Date.now() - t0; R.passed = rows.filter((r) => r.pass).length;
R.byLevel = {}; for (const r of rows) { const b = R.byLevel[r.level] || (R.byLevel[r.level] = { total: 0, passed: 0, ms: 0 }); b.total++; b.ms += r.ms; if (r.pass) b.passed++; }
R.failed = rows.filter((r) => !r.pass).map((r) => r.level + ' ' + r.id + '：' + (r.err || '沒有範式骨架／配方可套'));
R.rows = rows.map((r) => r.level + ' ' + r.id + (r.pass ? ' ✓ ' : ' ✗ ') + r.by + ' tried=' + r.tried + ' ' + r.ms + 'ms');
return R;
