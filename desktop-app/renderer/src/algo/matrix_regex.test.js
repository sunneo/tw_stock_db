'use strict';
// 矩陣層樣式比對模組（matrix_regex_core）：
//  ① Python 引擎（NFA → 子集構造 DFA 轉移表）對 python re：隨機簡單 regex × 隨機字串，整行／找得到兩種語意；glob 對等價 regex，全部一致；
//  ② 題庫：bench_linux_all train 的 lx-glob、lx-regex-class（只看前 2 筆當範例，其餘＋hidden 給 judge）；
//  ③ 誠實失敗：形狀不對、輸出不是兩種標籤、沒有範例。
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process');
const S = require('./matrix_synth_core.js'); const R = require('./matrix_regex_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
assert.strictEqual(R.install(S), true); const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'); let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 99; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const ATOMS = ['a', 'b', 'c', '.', '[ab]', '[^a]', '[a-c]', '(a|b)', '(ab)', '(a|bc)', 'a|b'];
const genRe = () => { let s = ''; const n = 1 + rnd(4); for (let i = 0; i < n; i++) { let a = ATOMS[rnd(ATOMS.length - 1)]; s += a + ['', '', '?', '+', '*'][rnd(5)]; } return rnd(5) === 0 ? s + '|' + ATOMS[rnd(5)] + 'b' : s; };
const genGlob = () => { let s = ''; const n = 1 + rnd(4); for (let i = 0; i < n; i++) s += ['a', 'b', 'c', '*', '?', '*'][rnd(6)]; return s; };
const genStr = () => Array.from({ length: rnd(7) }, () => 'abc'[rnd(3)]).join('');
{
    const cases = []; for (let i = 0; i < 400; i++) { const glob = i % 4 >= 2; const search = i % 2 === 1; cases.push({ pat: glob ? genGlob() : genRe(), glob, search, strs: Array.from({ length: 12 }, genStr) }); }
    const exp = cases.map((c) => c.strs.map((s) => R.toRegExp(c.pat, c.glob, c.search).test(s) ? 1 : 0));
    // JS 參考本身再對 python re 驗一次（glob 轉成 re）
    const script = R.ENGINE.join('\n') + '\nimport sys, json, re\nC = json.loads(sys.stdin.read())\nout = []\nfor c in C:\n    m = make_matcher(c["pat"], c["glob"], c["search"])\n    out.append([1 if m(s) else 0 for s in c["strs"]])\n    if not c["glob"]:\n        r = re.compile(c["pat"])\n        want = [1 if (r.search(s) if c["search"] else r.fullmatch(s)) else 0 for s in c["strs"]]\n        if want != out[-1]:\n            out[-1] = ["PYRE-MISMATCH", c["pat"], want]\nprint(json.dumps(out))\n';
    const r = cp.spawnSync(PY, ['-I', '-c', script], { input: JSON.stringify(cases), encoding: 'utf8', timeout: 120000 }); assert.strictEqual(r.status, 0, r.stderr); const got = JSON.parse(r.stdout);
    let bad = 0; got.forEach((g, i) => { if (JSON.stringify(g) !== JSON.stringify(exp[i])) { bad++; if (bad < 6) console.log('不一致', JSON.stringify(cases[i].pat), cases[i].glob ? 'glob' : 'regex', cases[i].search ? 'search' : 'full', JSON.stringify(g).slice(0, 80), JSON.stringify(exp[i]).slice(0, 60)); } });
    ok(bad === 0, '引擎與 RegExp／python re 不一致 ' + bad + '/400'); console.log('① 400 組隨機（regex／glob × 整行／找得到）× 12 個字串：Python 引擎 = JS RegExp = python re');
}
const dir = path.join(__dirname, '..', 'recipe', 'seed'); const load = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
(async () => {
    const ps = load('bench_linux_all.jsonl').filter((p) => p.split === 'train' && /^lx-(glob|regex-class)$/.test(p.id)); let n = 0;
    for (const p of ps) { const ex = p.tests.slice(0, 2), hid = p.tests.slice(2).concat(p.hidden || []); const problem = { id: p.id, tests: ex, hidden: hid, checker: p.checker || 'tokens' }; const r = await S.synth({ statement: p.statement, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } }); console.log((r.ok ? (r.verified ? '✓ ' : '△ ') : '✗ ') + p.id + ' ' + (r.desc || r.reason || '').slice(0, 90)); if (r.ok) n++; }
    console.log('② Linux train 樣式題 ' + n + '/' + ps.length); ok(n === ps.length, '樣式題全過');
    ok(!(await R.synthRegex({ statement: 'x', examples: [] })).ok, '沒有範例要失敗'); ok(!(await R.synthRegex({ statement: 'x', examples: [{ in: 'abc\n', out: 'yes\n' }] })).ok, '形狀不對要失敗'); ok(!(await R.synthRegex({ statement: 'x', examples: [{ in: 'a\n2\na\nb\n', out: 'x\ny\n' }, { in: 'a\n1\nc\n', out: 'z\n' }] })).ok, '三種標籤要失敗');
    console.log(passed + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
