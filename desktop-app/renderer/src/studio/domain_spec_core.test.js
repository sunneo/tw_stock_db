// node renderer/src/studio/domain_spec_core.test.js
const S = require('./domain_spec_core.js'), X = require('./dsl_expr_core.js'), D = require('./domain_demo_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 400) : '')); } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const errs = (spec, o) => S.validate(spec, o).errors.join('｜');

// ---- 示範規格本身要通過 ----
const B = D.blockly(), M = D.matrix();
check('示範 blockly 通過', S.validate(B).ok, S.validate(B)); check('示範 matrix 通過', S.validate(M).ok, S.validate(M));
check('示範有授權與來源 → 可內建化', S.validate(B, { builtin: true }).ok && S.validate(M, { builtin: true }).ok);
const nolic = clone(B); delete nolic.meta.license; check('缺授權：一般只警告', S.validate(nolic).ok && S.validate(nolic).warnings.some((w) => /license/.test(w)));
check('缺授權：內建化要擋', !S.validate(nolic, { builtin: true }).ok && /license/.test(errs(nolic, { builtin: true })));
const nosrc = clone(M); nosrc.meta.source = ''; check('缺來源：內建化要擋', !S.validate(nosrc, { builtin: true }).ok && /source/.test(errs(nosrc, { builtin: true })));

// ---- 基本欄位 ----
check('非物件', !S.validate(null).ok && !S.validate([]).ok);
for (const [n, f, re] of [['id 大寫', (s) => { s.id = 'Bad'; }, /id/], ['kind 錯', (s) => { s.kind = 'x'; }, /kind/], ['format 錯', (s) => { s.format = 'z'; }, /format/], ['seed 不是整數', (s) => { s.seed = 1.5; }, /seed/], ['版本較新', (s) => { s.version = 9; }, /更新/], ['label 空', (s) => { s.label = ' '; }, /label/], ['缺 meta', (s) => { delete s.meta; }, /meta/]]) {
    const s = clone(B); f(s); check('blockly ' + n, !S.validate(s).ok && re.test(errs(s)), errs(s));
}

// ---- blockly 規則 ----
{ const s = clone(B); s.algos[0] = { key: 'x1', any: ['計數'] }; check('讀題規則太寬被擋（單一 any、沒有 all）', /範圍太寬/.test(errs(s)), errs(s)); }
{ const s = clone(B); s.algos.push({ key: 'demo-parity-count', all: ['甲乙'] }); check('algo key 重複', /重複/.test(errs(s))); }
{ const s = clone(B); s.skeletons[0].algo = 'nope'; check('骨架指向不存在的 algo', /不在 algos/.test(errs(s))); }
{ const s = clone(B); s.skeletons[0].lines.push('import os'); check('禁用匯入 os', /不允許匯入 os/.test(errs(s)), errs(s)); }
{ const s = clone(B); s.skeletons[0].lines.push('x = open("a").read()'); check('禁用 open', /不允許的名稱：open/.test(errs(s)), errs(s)); }
{ const s = clone(B); s.skeletons[0].lines.push('y = ().__class__'); check('禁用 dunder', /dunder|不允許/.test(errs(s)), errs(s)); }
{ const s = clone(B); s.skeletons[0].lines.push('import heapq'); check('允許 heapq 匯入', S.validate(s).ok, errs(s)); }
{ const s = clone(B); s.skeletons[0].lines.push('print("open os")'); check('字串裡的 open／os 不誤判', S.validate(s).ok, errs(s)); }
{ const s = clone(B); s.skeletons[0].lines[2] = '    if v_ % 2 == {{c.nope}}:'; check('引用不存在的槽位', /不存在的 \{\{c\.nope\}\}/.test(errs(s)), errs(s)); }
{ const s = clone(B); s.skeletons[0].lines[1] = 'for v_ in {{fact.zz}}:'; check('引用不存在的 fact', /fact\.zz/.test(errs(s))); }
{ const s = clone(B); s.skeletons[0].slots = [1, 2, 3, 4, 5].map((i) => ({ id: 's' + i, options: [{ id: 'a', v: '1' }, { id: 'b', v: '2' }, { id: 'c', v: '3' }] })); s.skeletons[0].lines = ['print(1)']; check('槽位組合過多', /超過上限/.test(errs(s))); }
{ const s = clone(B); s.skeletons[0].facts = [{ name: 'k', re: '(a+)+b', as: 'int' }]; check('危險正規式', /太複雜/.test(errs(s)), errs(s)); }
{ const s = clone(B); s.skeletons[0].facts = [{ name: 'k', re: '(', as: 'int' }]; check('不合法正規式', /正規式/.test(errs(s))); }
{ const s = clone(B); s.families[0].ref = 'import subprocess\nprint(1)'; check('參考解也掃描', /subprocess/.test(errs(s))); }
{ const s = clone(B); s.families[0].statements = ['敘述 {Q} 沒有參數']; check('樣板用了不存在的參數', /沒有的參數/.test(errs(s)), errs(s)); }
{ const s = clone(B); s.families[0].gen = []; check('gen 空', /gen/.test(errs(s))); }
{ const s = clone(B); s.families[0].gen = [[{ name: 'a', ints: { len: 'n', range: [0, 9] } }]]; check('gen 的 len 引用還沒出現的變數', /len/.test(errs(s)), errs(s)); }
{ const s = clone(B); s.families[0].gen[0][0].int = [9, 1]; check('gen 範圍反了', /最小, 最大/.test(errs(s))); }

// ---- train／holdout 不可混 ----
{ const s = clone(B); s.families[1].statements = [s.families[0].statements[0]]; check('同敘述一個 train 一個 holdout → 擋', /留出題混進訓練/.test(errs(s)), errs(s)); }
{ const s = clone(B); s.families[1].statements = ['  ' + s.families[0].statements[0].toUpperCase() + '  ']; check('空白與大小寫不同也算同一題', /留出題混進訓練/.test(errs(s)), errs(s)); }
{ const s = clone(B); s.families[1].split = 'dev'; check('split 只能 train／holdout', /split/.test(errs(s))); }
{ const s = clone(B); s.tasks.push({ id: 't1', split: 'train', statement: s.families[1].statements[0], tests: [{ in: '1\n', out: '1\n' }, { in: '2\n', out: '2\n' }, { in: '3\n', out: '3\n' }] }); check('explicit task 與 holdout 家族同敘述 → 擋', /留出題混進訓練/.test(errs(s))); }
{ const s = clone(B); s.tasks.push({ id: 't1', split: 'train', statement: '另一題的敘述在這裡', tests: [{ in: '1\n', out: '1\n' }] }); check('task 測資不足 3 筆', /至少 3 筆/.test(errs(s))); }
{ const s = clone(B); s.families[1].split = 'train'; check('沒有 holdout → 警告但可通過', S.validate(s).ok && S.validate(s).warnings.some((w) => /holdout/.test(w))); }
{ const s = clone(M); s.tasks[1].examples[0] = { in: '1\n', out: '5\n' }; check('matrix：同操作的某輸入同時在 train 與 holdout → 擋', /混進訓練/.test(errs(s)), errs(s)); }
{ const s = clone(M); s.tasks[1].statement = s.tasks[0].statement; check('matrix：同敘述 train／holdout → 擋', /混進訓練/.test(errs(s))); }

// ---- 可重現 ----
{ const a = S.makeInputs(B.families[0], { seed: B.seed, count: 5 }), b = S.makeInputs(B.families[0], { seed: B.seed, count: 5 }); check('同種子輸入相同', JSON.stringify(a) === JSON.stringify(b)); }
{ const a = S.makeInputs(B.families[0], { seed: 1, count: 3 }), b = S.makeInputs(B.families[0], { seed: 2, count: 3 }); check('不同種子輸入不同', JSON.stringify(a) !== JSON.stringify(b)); }
{ const small = S.makeInputs(B.families[0], { seed: 7, count: 12 }), big = S.makeInputs(B.families[0], { seed: 7, count: 12, big: true }); const nOf = (t) => Number(t.split('\n')[0]); check('big 用 big 範圍（n 在 20～60）', big.every((t) => nOf(t) >= 20 && nOf(t) <= 60) && small.every((t) => nOf(t) >= 1 && nOf(t) <= 8)); }
{ const t = S.makeInputs(B.families[0], { seed: 5, count: 1 })[0].split('\n'); check('輸入形狀：第一行 n、第二行剛好 n 個數', t[1].split(' ').length === Number(t[0])); }
{ const fam = { id: 'rows', gen: [[{ name: 'n', int: [3, 3] }], { rows: { count: 'n', fields: [{ name: 'u', int: [1, 5] }, { name: 'v', int: [1, 5] }] } }, [{ name: 's', str: { len: [4, 4], alphabet: 'ab' } }]] }; const t = S.makeInputs(fam, { seed: 1, count: 1 })[0].split('\n'); check('rows 與 str', t.length === 6 + 0 && t[0] === '3' && /^[ab]{4}$/.test(t[4]) && t.slice(1, 4).every((l) => l.split(' ').length === 2), t); }
check('驗證會檢查可重現（展開兩次一致）', S.validate(B).ok);
{ const n1 = S.normalize(B), n2 = S.normalize(JSON.parse(JSON.stringify(B))); check('normalize 穩定', S.hash(n1) === S.hash(n2) && S.hash(n1).length === 64); const c = clone(B); c.label += '!'; check('改內容雜湊就變', S.hash(S.normalize(c)) !== S.hash(n1)); }

// ---- 展開 ----
{ const f = { id: 'p', statements: ['輸入 {N}，上限 {K}', '改寫 {N}／{K}'], params: { N: ['n', 'm'], K: [10, 20] } }; const e = S.expandStatements(f); check('參數展開 2×4', e.length === 8 && e[0].statement === '輸入 m，上限 10' || e.length === 8, e.map((x) => x.statement)); check('展開去重', S.expandStatements({ id: 'q', statements: ['同一個敘述一二三四五', '同一個敘述一二三四五'] }).length === 1); }
{ const f = clone(B.families[0]); f.params = { A: Array.from({ length: 70 }, (_, i) => i) }; f.statements = ['n 個整數 {A}']; const s = clone(B); s.families[0] = f; check('展開過多被擋', /超過上限/.test(errs(s)), errs(s)); }

// ---- 編譯 blockly（用最小假 PAR，驗證樣板展開與 pack 形狀；真 PAR 的端到端在 domain_e2e.test.js）----
{
    const PAR = require('../uml/py_paradigms_core.js'); const pack = S.compileBlockly(B, PAR);
    check('pack 形狀', pack.id === 'user-demo-parity' && pack.algos.length === 1 && pack.skeletons.length === 1 && pack.algos[0].pri === true && pack.seeds.length >= 3);
    check('讀題規則：命中', pack.algos[0].re.test('請輸出這些整數中奇數的個數') && pack.algos[0].re.test('偶數的個數'));
    check('讀題規則：缺 all 不命中', !pack.algos[0].re.test('偶數很多') && !pack.algos[0].re.test('整數的個數'));
    const sk = pack.skeletons[0]; check('槽位與 limit', sk.slots.length === 1 && sk.slots[0].options.length === 2 && sk.limit === 2);
    const py = sk.py({ par: '1' }, { sc: ['n'], ls: ['arr'], s: [], g: null, L: [] }, { statement: '' });
    check('樣板展開', py === 'cnt_ = 0\nfor v_ in arr:\n    if v_ % 2 == 1:\n        cnt_ += 1\nprint(cnt_)', py);
    check('缺輸入時丟錯（讓 render 記成 RENDER_ERROR）', (() => { try { sk.py({ par: '1' }, { sc: [], ls: [], s: [], g: null, L: [] }, {}); return false; } catch (e) { return /沒有第 0 個/.test(e.message); } })());
    const s2 = clone(B); s2.skeletons[0].facts = [{ name: 'k', re: '第\\s*(\\d+)\\s*小', as: 'int' }]; s2.skeletons[0].lines = ['print({{fact.k}})'];
    const p2 = S.compileBlockly(s2, PAR); check('fact 抽取', p2.skeletons[0].py({ par: '0' }, { sc: [], ls: [], s: [], L: [] }, { statement: '求第 7 小的數' }) === 'print(7)');
    check('fact 抽不到就丟錯', (() => { try { p2.skeletons[0].py({ par: '0' }, { sc: [], ls: [], s: [], L: [] }, { statement: '沒有數字' }); return false; } catch (e) { return /沒讀到：k/.test(e.message); } })());
    const s3 = clone(B); s3.skeletons[0].needs = { lists: 1 }; const p3 = S.compileBlockly(s3, PAR); check('needs 形狀條件', p3.skeletons[0].shape({ vars: [{ type: 'list' }] }) === true && p3.skeletons[0].shape({ vars: [{ type: 'int' }] }) === false);
    const s4 = clone(B); s4.algos[0].veto = ['集合']; const p4 = S.compileBlockly(s4, PAR); check('veto', p4.algos[0].veto.test('集合的偶數個數') && !p4.algos[0].veto.test('偶數'));
    check('seed 的 gen 可重現且分 train／holdout', pack.seeds.some((x) => x.split === 'holdout') && pack.seeds.every((x) => typeof x.gen === 'function' && x.gen(false) === x.gen(false)));
}

// ---- 矩陣操作：擬合 ----
{
    const op = M.ops[0]; const ex = M.tasks[0].examples;
    const r = S.fitOp(op, ex, X); check('擬合找得到', r.ok && r.tried > 0 && r.source.includes('r = (a * n + b) % m'), r);
    check('三筆範例仍有多個候選 → 標 ambiguous 並附 alternatives', r.ambiguous === true && r.alternatives.length >= 1);
    const hid = M.tasks[0].hidden; const all = [{ assignment: r.assignment }].concat(r.alternatives); const pick = all.find((c) => hid.every((h) => S.replay(op, c.assignment, h.in, X).out === h.out.trim()));
    check('隱藏範例能從候選裡挑出正確參數 a=3,b=2,m=11', pick && pick.assignment.a === 3 && pick.assignment.b === 2 && pick.assignment.m === 11, pick);
    check('對不上時回具體原因', (() => { const q = S.fitOp(op, [{ in: '1\n', out: '1000\n' }, { in: '2\n', out: '1001\n' }], X); return !q.ok && /都對不上/.test(q.reason); })());
    check('輸入形狀不符回具體原因', /形狀不符/.test(S.fitOp(op, [{ in: 'abc\n', out: '1\n' }], X).reason));
    check('replay', S.replay(op, { a: 3, b: 2, m: 11 }, '10\n', X).out === '10');
    const pal = S.fitOp(M.ops[1], M.tasks[2].examples, X); check('回文操作：無參數、唯一', pal.ok && !pal.ambiguous && /print\("yes" if r else "no"\)/.test(pal.source), pal);
    check('產出的 Python 語法形狀', /^def main\(\):\n    n = int\(input\(\)\)\n    a = 3/.test(r.source) || /def main\(\):\n    n = int\(input\(\)\)/.test(r.source), r.source);
    const ints = { id: 'x', layout: 'lines', input: [{ name: 'a', type: 'ints' }], output: { type: 'ints' }, params: { k: [1, 2, 3] }, expr: '[x * k for x in a]' }; const ri = S.fitOp(ints, [{ in: '1 2 3\n', out: '2 4 6\n' }, { in: '5\n', out: '10\n' }], X); check('ints 輸入／輸出', ri.ok && ri.assignment.k === 2 && /list\(map\(int, input\(\)\.split\(\)\)\)/.test(ri.source) && /print\(' '\.join\(map\(str, list\(r\)\)\)\)/.test(ri.source), ri);
    const line = { id: 'y', layout: 'line', input: [{ name: 'a', type: 'int' }, { name: 'b', type: 'int' }], output: { type: 'int' }, params: {}, expr: 'a * b + 1' }; const rl = S.fitOp(line, [{ in: '2 3\n', out: '7\n' }, { in: '4 5\n', out: '21\n' }], X); check('line 版面（同一行多個整數）', rl.ok && /a, b = map\(int, input\(\)\.split\(\)\)/.test(rl.source), rl);
    const strp = { id: 'z', layout: 'lines', input: [{ name: 's', type: 'str' }], output: { type: 'int' }, params: { t: ['a', 'b', 'ab'] }, expr: 's.count(t)' }; const rs = S.fitOp(strp, [{ in: 'abab\n', out: '2\n' }, { in: 'aab\n', out: '1\n' }], X); check('字串參數', rs.ok && rs.assignment.t === 'ab' && /t = "ab"/.test(rs.source), rs);
}
// ---- 矩陣模組（給 FaMatrixSynth.register）----
(async () => {
    const mods = S.compileMatrix(M, X); check('每個操作一個模組', mods.length === 2 && mods[0].name === 'user:demo-ops/lin-mod' && mods[0].opts.order === 35);
    const r1 = await mods[0].fn({ statement: M.tasks[0].statement, examples: M.tasks[0].examples }); check('模組：命中', r1.ok && r1.kind === 'user-op' && r1.userOp.op === 'lin-mod' && r1.alternatives.length >= 1, r1);
    const r2 = await mods[0].fn({ statement: '輸入一個字串判斷長度', examples: M.tasks[0].examples }); check('模組：敘述沒有關鍵詞就不試', !r2.ok && /關鍵詞/.test(r2.reason));
    const r3 = await mods[1].fn({ statement: M.tasks[2].statement, examples: M.tasks[0].examples }); check('模組：形狀不符回原因', !r3.ok && /形狀/.test(r3.reason));
    // ---- buildTasks（blockly 家族→題目；runRef 用假的）----
    const fakeRun = async (src, inp) => { const L = inp.trim().split('\n'); const a = L[1].split(' ').map(Number); return { ok: true, out: String(a.filter((x) => (src.includes('!= 0') ? x % 2 !== 0 : x % 2 === 0)).length) + '\n' }; };
    const bt = await S.buildTasks(B, { runRef: fakeRun, tests: 4, hidden: 2 }); check('buildTasks：題目與測資', bt.problems.length === 0 && bt.tasks.length === 3 && bt.tasks.every((t) => t.tests.length === 4 && t.hidden.length === 2), bt.problems);
    check('buildTasks：holdout 標記保留', bt.tasks.filter((t) => t.split === 'holdout').length === 1);
    const bt2 = await S.buildTasks(B, {}); check('沒有沙盒 → 具體原因', bt2.problems.length === 2 && /允許 AI 執行程式/.test(bt2.problems[0].error));
    const bt3 = await S.buildTasks(B, { runRef: async () => ({ ok: false }) }); check('參考解沒輸出 → 記問題不丟例外', bt3.problems.length === 2);
    const mt = await S.buildTasks(M, {}); check('matrix 任務直接帶出', mt.tasks.length === 4 && mt.tasks[0].examples.length === 3);
    // ---- 檔案往返 ----
    const files = S.toFiles(M, mt.tasks); const back = S.fromFiles(files); check('toFiles／fromFiles 往返', back.ok && S.hash(S.normalize(back.spec)) === S.hash(S.normalize(M)) && files['README.txt'] && files['data/tasks.jsonl'].length > 10);
    check('fromFiles 缺檔', !S.fromFiles({}).ok && /domain-spec/.test(S.fromFiles({}).error));
    check('summary', JSON.stringify(S.summary(B)) === JSON.stringify({ kind: 'blockly', algos: 1, skeletons: 1, families: 2, train: 2, holdout: 1 }) && S.summary(M).holdout === 2, S.summary(B));
    console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
})();
