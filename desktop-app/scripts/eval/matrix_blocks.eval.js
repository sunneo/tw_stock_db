// 矩陣轉區塊在真 Electron：write_code 由矩陣層解出一題 → 結果帶區塊 → matrix_blocks 工具看／改 → 編回 Python。用法：node scripts/eval/real_electron.run.js matrix_blocks
const fa = window.fa; const R = {}; const ok = (k, v) => { R[k] = v; };
const api = window.desktopAPI; const execApi = api.exec || api.execApi || null; if (execApi && execApi.setSettings) await execApi.setSettings({ execEnabled: true, execConfirmRequired: false });
ok('scripts', [].slice.call(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)));
ok('module', typeof FaMatrixBlocks === 'object' && typeof FaMatrixBlocks.makeMatrixBlocks === 'function'); ok('tool', !!fa.tools.matrix_blocks);
const call = async (a) => JSON.parse(await fa.tools.matrix_blocks.callback.call(fa, JSON.stringify(a)));
const has = (s) => (s.includes('11') ? 'no' : 'yes');
const dTests = ['0101', '0110', '1', '0'].map((s) => ({ in: s + '\n', out: has(s) + '\n' })), dHid = ['11', '1011', '0000', '1010101', '110', '011'].map((s) => ({ in: s + '\n', out: has(s) + '\n' }));
const fib = (n) => { let a = 0n, b = 1n; for (let i = 0; i < n; i++) [a, b] = [b, a + b]; return String(a); };
const rEx = [3, 10, 20].map((n) => ({ in: n + '\n', out: fib(n) + '\n' })), rHid = [0, 1, 2, 5, 30, 45, 60].map((n) => ({ in: n + '\n', out: fib(n) + '\n' }));
// 讀取器讀得懂的題目會走範式骨架（不經矩陣層）；所以依序試幾種敘述，找出真的由矩陣層解出的
const cands = [
  { task: '輸入由 0、1 組成的字串，若含有子字串 "11" 印 no，否則印 yes。', tests: dTests, hidden: dHid },
  { task: '有一個數列，F(0)=0，F(1)=1，之後每一項是前兩項的和。輸入 n，輸出 F(n)。', tests: rEx, hidden: rHid },
  { task: '看範例找規則：輸入一個數字，輸出對應的神祕數字。', tests: rEx, hidden: rHid },
  { task: '照範例的規律計算。', tests: dTests, hidden: dHid }
];
let res = null; const tried = [];
for (const c of cands) { const r = await fa._codeAgent(Object.assign({ language: 'python' }, c)); tried.push({ task: c.task.slice(0, 16), ok: r.ok, by: r.offline && r.offline.by, kind: r.offline && r.offline.matrix && r.offline.matrix.kind, hasBlocks: !!(r.offline && r.offline.matrix && r.offline.matrix.blocks) }); if (r.ok && r.offline && r.offline.matrix) { res = r; break; } }
ok('tried', tried);
if (res) {
  ok('write_code_matrix', { ok: res.ok, verified: res.verified, kind: res.offline.matrix.kind, segments: res.offline.matrix.blocks && res.offline.matrix.blocks.segments.map((s) => s.role), stats: res.offline.matrix.blocks && res.offline.matrix.blocks.stats });
  const show = await call({ action: 'show' }); ok('show_last', { ok: show.ok, kind: show.kind, form: show.form, cnlHead: (show.cnl || '').split('\n').slice(0, 6) });
  if (show.ok && show.kind === 'dfa') {
    const flip = show.form.delta.map((_, i) => i).filter((i) => !show.form.accept.includes(i));
    const expected = ['0101', '0110', '11', '1'].map((s) => ({ in: s + '\n', out: (has(s) === 'no' ? 'yes' : 'no') + '\n' }));
    const ed = await call({ action: 'edit', patch: { accept: flip }, expected }); ok('edit_accept', { ok: ed.ok, changed: ed.changed, verified: ed.verified, verdict: ed.verdict, accept: ed.form && ed.form.accept });
  } else if (show.ok && show.kind === 'recurrence') {
    const ed = await call({ action: 'edit', patch: { init: [2, 1] } }); ok('edit_init', { ok: ed.ok, changed: ed.changed, init: ed.form && ed.form.init, verified: ed.verified });
  }
}
// 直接給 source＋kind（不依賴最近一次結果）
const DFA_SRC = 'def main():\n    s = input().strip()\n    T = [{"0": 0, "1": 1}, {"0": 0, "1": 2}, {"0": 2, "1": 2}]\n    q = 0\n    for ch in s:\n        q = T[q][ch]\n    print("yes" if q in [0, 1] else "no")\n';
const show2 = await call({ action: 'show', source: DFA_SRC, kind: 'dfa' }); ok('show_source', { ok: show2.ok, kind: show2.kind, segments: show2.segments && show2.segments.map((s) => s.role), accept: show2.form && show2.form.accept, error: show2.error });
if (show2.ok && show2.form) {
  const ed2 = await call({ action: 'edit', source: DFA_SRC, kind: 'dfa', patch: { accept: [2] }, expected: ['0101', '11', '1'].map((s) => ({ in: s + '\n', out: (has(s) === 'no' ? 'yes' : 'no') + '\n' })) });
  ok('edit_source_accept', { ok: ed2.ok, changed: ed2.changed, verified: ed2.verified, verdict: ed2.verdict, accept: ed2.form && ed2.form.accept });
}
const none = await call({ action: 'edit', source: DFA_SRC, kind: 'dfa' }); ok('edit_without_patch', { ok: none.ok, error: none.error });
const nosrc = await call({ action: 'show', source: 'print(1)', kind: 'dfa' }); ok('show_non_matrix_source', { ok: nosrc.ok, error: nosrc.error });
return R;
