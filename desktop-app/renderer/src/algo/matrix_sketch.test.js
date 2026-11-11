'use strict';
// 矩陣層 L4 草圖合成（matrix_sketch_core）：
//  ① 候選的 JS 版與輸出的 Python 版在隨機輸入上輸出一致（抽樣各家族，真 python）；
//  ② 題庫：heldout8_l4（凍結，補草圖前基線見 DESIGN §13）、heldout7 的 L4 題；只看前 2 筆當範例，其餘＋hidden 給 judge；
//  ③ 誠實失敗：範本庫沒有的題型（例如行列式、非整數輸入）必須失敗或標 ambiguous；沒有範例要失敗。
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process');
const S = require('./matrix_synth_core.js'); const K = require('./matrix_sketch_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
assert.strictEqual(K.install(S), true); assert.ok(S.list().some((x) => x.name === 'sketch'));
const PY = process.env.PYTHON || 'python'; let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
// ① 抽樣比對
{
    const all = K.cands.concat(K.rangeCands([3, 5]), K.seriesCands([1000000007]), K.twoIntCands([1000000007]), K.baseCands);
    const byFam = {}; for (const c of all) (byFam[c.fam] = byFam[c.fam] || []).push(c);
    const sample = []; for (const fam of Object.keys(byFam)) { const L = byFam[fam]; const step = Math.max(1, Math.floor(L.length / 40)); for (let i = 0; i < L.length; i += step) sample.push(L[i]); }
    const inputsFor = (ar) => (ar === 1 ? [[1], [2], [6], [12], [28], [97], [100], [360]] : ar === 2 ? [[12, 18], [7, 3], [100, 6], [20, 7], [5, 5], [255, 16]] : [[12, 18, 24], [7, 3, 11], [100, 6, 13]]);
    const progs = []; const expect = [];
    for (const c of sample) {
        const label = c.label; const src = K.pyProgram(c, label, 'Y', 'N'); const ins = inputsFor(c.arity); const exp = [];
        for (const a of ins) { const cx = K.context(a[0]); cx.args = a; let v; try { v = c.f(cx); } catch (e) { v = null; } exp.push(v === null || v === undefined ? null : label ? (v ? 'Y' : 'N') : String(v)); }
        progs.push({ id: c.id, src, ins: ins.map((a) => a.join(' ')), exp }); expect.push(c);
    }
    const harness = 'import sys, json, io, builtins\nP = json.loads(sys.stdin.read())\nres = []\nfor p in P:\n    outs = []\n    for line in p["ins"]:\n        ns = {"__name__": "x"}\n        try:\n            exec(p["src"], ns)\n            it = iter([line])\n            builtins_input = builtins.input\n            builtins.input = lambda *a: next(it)\n            buf = io.StringIO(); old = sys.stdout; sys.stdout = buf\n            try:\n                ns["main"]()\n            finally:\n                sys.stdout = old; builtins.input = builtins_input\n            outs.append(buf.getvalue().strip())\n        except Exception as e:\n            outs.append("ERR " + type(e).__name__)\n    res.append(outs)\nprint(json.dumps(res))\n';
    const r = cp.spawnSync(PY, ['-I', '-c', harness], { input: JSON.stringify(progs), encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 }); assert.strictEqual(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout); let cmp = 0, bad = 0;
    progs.forEach((p, i) => p.exp.forEach((e, j) => { if (e === null) return; cmp++; if (got[i][j] !== e) { bad++; if (bad < 8) console.log('不一致', p.id, p.ins[j], 'JS=' + e, 'PY=' + got[i][j]); } }));
    ok(bad === 0, 'JS／Python 不一致 ' + bad + '/' + cmp); console.log('① 抽樣 ' + sample.length + ' 個草圖候選 × 多筆輸入，共 ' + cmp + ' 次比對，JS 與 Python 全部一致');
}
const dir = path.join(__dirname, '..', 'recipe', 'seed'); const load = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
async function runSet(ps) { const out = []; for (const p of ps) { const ex = p.tests.slice(0, 2), hid = p.tests.slice(2).concat(p.hidden || []); const problem = { id: p.id, tests: ex, hidden: hid, checker: p.checker || 'tokens' }; const r = await S.synth({ statement: p.statement, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } }); out.push({ id: p.id, ok: !!r.ok, verified: !!r.verified, by: r.ok ? r.kind : '', desc: r.desc || '', reason: r.ok ? '' : (r.reason || '').slice(0, 70) }); } return out; }
const show = (r) => r.forEach((x) => console.log((x.ok ? (x.verified ? '✓ ' : '△ ') : '✗ ') + x.id + ' ' + x.by + ' ' + x.desc + x.reason));
(async () => {
    const r8 = await runSet(load('heldout8_l4.jsonl')); show(r8); const n8 = r8.filter((x) => x.ok).length, v8 = r8.filter((x) => x.verified).length; console.log('② heldout8 ok ' + n8 + '/' + r8.length + '，verified ' + v8);
    const h7 = load('heldout7_mixed.jsonl').filter((p) => p.level === 'L4'); const r7 = await runSet(h7); show(r7); const n7 = r7.filter((x) => x.ok).length; console.log('   heldout7 L4 ok ' + n7 + '/' + r7.length);
    ok(n8 >= 11, 'heldout8 至少 11/17（基線見 DESIGN）：' + n8); ok(n7 >= 8, 'heldout7 L4 至少 8/9：' + n7);
    ok(!(await K.synthSketch({ statement: 'x', examples: [] })).ok, '沒有範例要失敗'); ok(!(await K.synthSketch({ statement: '輸入一個矩陣，輸出行列式', examples: [{ in: '2\n1 2\n3 4\n', out: '-2\n' }] })).ok, '形狀不是整數行要失敗');
    { const r = await K.synthSketch({ statement: '輸入 n，輸出答案', examples: [{ in: '5\n', out: '17\n' }] }); ok(!r.ok || r.ambiguous, '單一範例＋沒有線索：不能標確定'); }
    console.log(passed + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
