'use strict';
// 矩陣層清單草圖（matrix_list_core）：
//  ① 全部候選的 JS 版與輸出的 Python 版在多組輸入上輸出一致（真 python，一個行程跑完）；
//  ② 題庫：heldout9_list（凍結，補清單草圖前基線 1/16）與 heldout7 的清單／括號題（只看前 2 筆當範例，其餘＋hidden 給 judge）；
//  ③ 誠實失敗：沒範例、形狀不認得、範本庫沒有的題型（例如最長遞增子序列）；範例太少有多個候選時要標 ambiguous 並附 suggest。
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process');
const S = require('./matrix_synth_core.js'); const K = require('./matrix_list_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
assert.strictEqual(K.install(S), true); const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'); let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
// ① 等價
{
    const arrs = [[3, 1, 2], [5, 5, 3, 3, 3, 9], [-2, 4, -1, 6, 0, 6, 2], [1], [7, 7], [2, 9, 4, 4, 1, 8, 5], [0, 3, 1, 2, 5, 4], [10, 1, 10, 1, 10], [-5, -3, -9, -1]];
    const strs = ['()', '([)]', '(()', '{[()]}', ')(', '((()))', '()[]{}', '[(])', '(', '))', '(()())'];
    const progs = []; const exps = [];
    for (const c of K.cands) {
        const ins = []; const exp = [];
        if (c.str) for (const s of strs) { ins.push(s + '\n'); exp.push({ s }); }
        else if (c.two) for (let i = 0; i < arrs.length - 1; i++) { const a = [...new Set(arrs[i])].sort((x, y) => x - y), b = [...new Set(arrs[i + 1])].sort((x, y) => x - y); ins.push(a.length + '\n' + a.join(' ') + '\n' + b.length + '\n' + b.join(' ') + '\n'); exp.push({ a, b }); }
        else for (const a of arrs) for (const k of c.needK ? [1, 2, 3] : [null]) { if (c.needK && k > a.length) continue; ins.push(c.needK ? a.length + ' ' + k + '\n' + a.join(' ') + '\n' : a.length + '\n' + a.join(' ') + '\n'); exp.push({ a, k }); }
        const shape = { two: !!c.two, noN: false, kpos: c.needK ? 'nk' : null };
        const labels = c.out === 'bool'; progs.push({ id: c.id, src: K.pyProgram(c, shape, 'Y', 'N') + '\n', ins }); exps.push({ c, exp, labels });
    }
    const harness = 'import sys, json, io, builtins\nP = json.loads(sys.stdin.read())\nres = []\nfor p in P:\n    outs = []\n    ns = {"__name__": "x"}\n    exec(p["src"], ns)\n    for text in p["ins"]:\n        it = iter(text.split("\\n"))\n        old_in = builtins.input\n        builtins.input = lambda *a: next(it)\n        buf = io.StringIO(); old = sys.stdout; sys.stdout = buf\n        try:\n            ns["main"]()\n            outs.append(buf.getvalue().strip())\n        except Exception as e:\n            outs.append("ERR " + type(e).__name__)\n        finally:\n            sys.stdout = old; builtins.input = old_in\n    res.append(outs)\nprint(json.dumps(res))\n';
    const r = cp.spawnSync(PY, ['-I', '-c', harness], { input: JSON.stringify(progs), encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 }); assert.strictEqual(r.status, 0, String(r.stderr).slice(0, 500));
    const got = JSON.parse(r.stdout); let cmp = 0, bad = 0;
    exps.forEach(({ c, exp, labels }, i) => exp.forEach((e, j) => { let v; try { v = c.f(e); } catch (err) { return; } if (v === null || v === undefined) return; const want = labels ? (v ? 'Y' : 'N') : c.out === 'list' ? v.join(' ') : String(v); cmp++; if (got[i][j] !== want) { bad++; if (bad < 8) console.log('不一致', c.id, JSON.stringify(e), 'JS=' + want, 'PY=' + got[i][j]); } }));
    ok(bad === 0, 'JS／Python 不一致 ' + bad + '/' + cmp); console.log('① ' + K.cands.length + ' 個候選、' + cmp + ' 次比對，JS 與 Python 全部一致');
}
const dir = path.join(__dirname, '..', 'recipe', 'seed'); const load = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
async function runSet(ps) { const out = []; for (const p of ps) { const ex = p.tests.slice(0, 2), hid = p.tests.slice(2).concat(p.hidden || []); const problem = { id: p.id, tests: ex, hidden: hid, checker: p.checker || 'tokens' }; const r = await S.synth({ statement: p.statement, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } }); out.push({ id: p.id, ok: !!r.ok, verified: !!r.verified, by: r.ok ? r.kind : '', desc: r.desc || '', reason: r.ok ? '' : (r.reason || '').slice(0, 70) }); } return out; }
const show = (r) => r.forEach((x) => console.log((x.ok ? (x.verified ? '✓ ' : '△ ') : '✗ ') + x.id + ' ' + x.by + ' ' + x.desc + x.reason));
(async () => {
    const r9 = await runSet(load('heldout9_list.jsonl')); show(r9); const n9 = r9.filter((x) => x.ok).length, v9 = r9.filter((x) => x.verified).length; console.log('② heldout9 ok ' + n9 + '/' + r9.length + '，verified ' + v9);
    const h7 = load('heldout7_mixed.jsonl').filter((p) => /^h7-(max-depth|dedup-adj|rotate|merge-sorted|inversions)$/.test(p.id)); const r7 = await runSet(h7); show(r7); const n7 = r7.filter((x) => x.ok).length; console.log('   heldout7 清單／括號 ok ' + n7 + '/' + r7.length);
    ok(n9 >= 12, 'heldout9 至少 12/16（基線 1/16）：' + n9); ok(n7 >= 4, 'heldout7 清單／括號至少 4/5：' + n7);
    ok(!(await K.synthList({ statement: 'x', examples: [] })).ok, '沒有範例要失敗'); ok(!(await K.synthList({ statement: 'x', examples: [{ in: 'hello world\nfoo\n', out: '1\n' }] })).ok, '形狀不認得要失敗');
    { const lis = load('heldout_all.jsonl').find((p) => p.id === 'ho-lis-len'); if (lis) { const r = await K.synthList({ statement: lis.statement, examples: lis.tests.slice(0, 2) }); ok(!r.ok || r.ambiguous, '最長遞增子序列不在庫裡：必須失敗或標 ambiguous'); } }
    { const r = await K.synthList({ statement: '輸入 n 與一些整數，輸出答案', examples: [{ in: '3\n1 2 3\n', out: '6\n' }] }); ok(r.ok && !r.verified && Array.isArray(r.suggest) && r.suggest.length > 0, '單一範例：不標 verified，並附 suggest'); }
    console.log(passed + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
