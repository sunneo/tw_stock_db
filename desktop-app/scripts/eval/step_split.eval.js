// 函式內部再切成步驟：真實 Electron、不問模型，走 write_code 完整離線管線（讀取器→配方／課／範式骨架→矩陣層→步驟切割→沙盒＝真判題器）。
// 三題：1 層／2 層／3 層；每題跑兩次——只切一層（_stepMaxDepth=1）與全深度——對照命中、嘗試數與耗時。
// 用法：node scripts/eval/run_eval.js scripts/eval/step_split.eval.js 17962（需要 python3 在 PATH；tree-sitter 要本機快取或網路）
const fa = window.fa; const R = {}; const api = window.desktopAPI; const execApi = api.exec || api.execApi || null;
if (execApi && execApi.setSettings) await execApi.setSettings({ execEnabled: true, execConfirmRequired: false });
const mk = (arr) => arr.map(([i, o]) => ({ in: i, out: o }));
const P = [
    { id: 'l1-sort', st: '輸入一行整數，由小到大排序後依序輸出。', ex: mk([['3 1 2\n', '1 2 3\n'], ['5 -1 4 0\n', '-1 0 4 5\n']]), hid: mk([['9 8 7 6\n', '6 7 8 9\n'], ['2\n', '2\n']]) },
    { id: 'l2-pos-square-sum', st: '輸入一行整數。去掉負數後，每個數平方，輸出總和。', ex: mk([['1 -2 3\n', '10\n'], ['-5 4 0 2\n', '20\n'], ['-1 -2\n', '0\n']]), hid: mk([['6 -6 1 -1 2\n', '41\n'], ['0\n', '0\n']]) },
    { id: 'l3-abs-dedup-sort', st: '輸入一行整數。取絕對值、去掉重複、由小到大排序後，依序輸出。', ex: mk([['3 -1 1 -3 2\n', '1 2 3\n'], ['-5 5 -4 4 4\n', '4 5\n'], ['0 0 -2\n', '0 2\n']]), hid: mk([['-9 7 -7 9 1 -1\n', '1 7 9\n'], ['8\n', '8\n']]) },
];
R.rows = [];
for (const p of P) for (const depth of [1, 0]) {
    fa._stepMaxDepth = depth || undefined; fa._pyNoLessons = true; const t0 = Date.now(); let w;
    try { w = await fa._codeAgent({ task: p.st, language: 'python', tests: p.ex, hidden: p.hid }); } catch (e) { w = { ok: false, error: String((e && e.message) || e) }; }
    const o = w.offline || {}; const sp = o.stepPlan;
    R.rows.push({ id: p.id, maxDepth: depth || 'full', ok: !!w.ok, verified: !!w.verified, mode: w.mode, by: o.by, level: sp && sp.level, tried: sp && sp.tried, chain: sp && sp.chain && sp.chain.join('>') + '|' + sp.reducer, stepChecked: sp && sp.stepChecked, ms: Date.now() - t0, err: w.ok ? undefined : String(w.error || w.reason || '').slice(0, 160) });
}
fa._stepMaxDepth = undefined; fa._pyNoLessons = false; return R;
