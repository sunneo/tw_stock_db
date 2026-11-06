// 離線組合（Python）：真實 Electron、完全不問模型，對 20 題種子算法題跑 write_code 的完整管線
//   （uml_design 算法題讀取器 → 配方／課／範式骨架 → 沙盒＝真的判題器 judge-runner），列出誰過誰沒過。跑兩輪：不給課（只靠範式骨架）、給課。
// 用法：xvfb-run -a node scripts/eval/run_eval.js scripts/eval/offline-code.eval.js 17961
// 需要 tree-sitter（web-tree-sitter＋python wasm）：第一次要網路，之後存在本機快取。這支會把「允許AI執行程式」打開、關掉確認框（只在暫時的資料夾裡）。
const fa = window.fa; const R = {};
const api = window.desktopAPI; const execApi = api.exec || api.execApi || null; if (execApi && execApi.setSettings) await execApi.setSettings({ execEnabled: true, execConfirmRequired: false });
const probs = (await (await fetch('src/recipe/seed/problems.jsonl').catch(() => ({ text: async () => '' }))).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
R.seedCount = probs.length; if (!probs.length) { R.error = '讀不到 problems.jsonl'; return R; }
R.skipped = [];
for (const mode of ['noLessons', 'withLessons']) {
    fa._pyNoLessons = mode === 'noLessons'; const rows = []; const t0 = Date.now();
    for (const p of probs) {
        const t1 = Date.now(); let w; try { w = await fa._codeAgent({ task: p.statement, language: 'python', tests: p.tests.concat((p.hidden || [])).slice(0, 8) }); } catch (e) { w = { ok: false, error: String((e && e.message) || e) }; }
        rows.push({ id: p.id, pass: !!(w.verified && w.mode === 'offline'), by: w.offline && (w.offline.paradigm || w.offline.lesson || w.offline.recipe), tried: w.offline && w.offline.tried, calls: w.calls && (w.calls.ask + w.calls.write), err: w.ok ? undefined : String(w.error || (w.gaps && w.gaps.join('；')) || '').slice(0, 100), ms: Date.now() - t1 });
    }
    R[mode] = { passed: rows.filter((r) => r.pass).length, total: rows.length, modelCalls: rows.reduce((s, r) => s + (r.calls || 0), 0), totalMs: Date.now() - t0, failed: rows.filter((r) => !r.pass).map((r) => r.id + '：' + r.err), rows: rows.map((r) => r.id + (r.pass ? ' ✓ ' : ' ✗ ') + (r.by || '-') + ' tried=' + r.tried) };
}
fa._pyNoLessons = false; return R;
