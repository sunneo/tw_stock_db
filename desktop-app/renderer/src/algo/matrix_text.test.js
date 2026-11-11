'use strict';
// 矩陣層文字模組（text-string／text-lines）：
//  ① 字串函式庫的 JS 版與 Python 版在探測字串上輸出一致（真 python）；
//  ② 逐行管線：JS 驗證版與輸出的 Python 在隨機輸入上輸出一致；
//  ③ 題庫：bench_linux_all（train 題用來開發）、heldout7_mixed（凍結，文字類題）— 只看前 2 筆當範例，其餘＋hidden 給 judge；
//  ④ 誠實失敗：不認得的形狀／沒有範例／恆等函式不算解。
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process');
const S = require('./matrix_synth_core.js'); const T = require('./matrix_text_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
assert.strictEqual(T.install(S), true); const names = S.list().map((x) => x.name); assert.ok(names.includes('text-string') && names.includes('text-lines'));
const PY = process.env.PYTHON || 'python';
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
// ① JS 版與 Python 版
{
    const probes = ['Hello World 123', 'abc xyz', 'Tab\there', 'ZzAa09', 'aabbbcccc', 'Mississippi', '  lead', 'x y  z', 'a', '4b32', '3a1b2c', 'a3b1', 'aGVsbG8=', '255', ''];
    const rows = T.SF.map((f) => f.id + '\t' + f.py('s')); const script = 'import sys, json\nP = json.loads(sys.stdin.read())\nout = {}\nfor line in P["fns"]:\n    k, e = line.split("\\t", 1)\n    r = []\n    for s in P["probes"]:\n        try:\n            r.append(str(eval(e)))\n        except Exception:\n            r.append(None)\n    out[k] = r\nprint(json.dumps(out))\n';
    const res = cp.spawnSync(PY, ['-I', '-c', script], { input: JSON.stringify({ fns: rows, probes }), encoding: 'utf8' }); assert.strictEqual(res.status, 0, res.stderr);
    const py = JSON.parse(res.stdout); let bad = 0;
    for (const f of T.SF) for (let i = 0; i < probes.length; i++) { let js; try { js = f.js(probes[i]); } catch (e) { js = null; } if (js === null || py[f.id][i] === null) continue; if (js !== py[f.id][i]) { bad++; console.log('不一致', f.id, JSON.stringify(probes[i]), JSON.stringify(js), JSON.stringify(py[f.id][i])); } }
    ok(bad === 0, '字串函式 JS／Python 一致'); console.log('① ' + T.SF.length + ' 個函式 × ' + probes.length + ' 個探測字串 JS 與 Python 一致');
}
const dir = path.join(__dirname, '..', 'recipe', 'seed'); const load = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
async function runSet(ps) { const out = []; for (const p of ps) { const ex = p.tests.slice(0, 2), hid = p.tests.slice(2).concat(p.hidden || []); const problem = { id: p.id, tests: ex, hidden: hid, checker: p.checker || 'tokens' }; const r = await S.synth({ statement: p.statement, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } }); out.push({ id: p.id, ok: !!r.ok, verified: !!r.verified, by: r.ok ? r.kind : '', reason: r.ok ? '' : (r.reason || '').slice(0, 60) }); } return out; }
(async () => {
    const lx = load('bench_linux_all.jsonl').filter((p) => p.split === 'train' && /^lx-(xxd-encode|xxd-bits|cat-n|cat-A|grep-fixed|grep-i|grep-n|rle-encode)$/.test(p.id));
    const r1 = await runSet(lx); r1.forEach((x) => console.log((x.ok ? (x.verified ? '✓ ' : '△ ') : '✗ ') + x.id + ' ' + x.by + ' ' + x.reason)); const n1 = r1.filter((x) => x.ok).length;
    console.log('② Linux train 文字類 ' + n1 + '/' + lx.length); ok(n1 >= 7, 'Linux train 文字類至少 7/8：' + n1);
    const h7 = load('heldout7_mixed.jsonl').filter((p) => /^h7-(number-lines-colon|upper-lines|reverse-each-line|word-count-lines|grep-v|grep-count|hex-upper|hex-decode|caesar|rle-decode-digit|swapcase|drop-vowels|base64-enc|rev-digits)$/.test(p.id));
    const r2 = await runSet(h7); r2.forEach((x) => console.log((x.ok ? (x.verified ? '✓ ' : '△ ') : '✗ ') + x.id + ' ' + x.by + ' ' + x.reason)); const n2 = r2.filter((x) => x.ok).length;
    console.log('③ heldout7 文字類 ' + n2 + '/' + h7.length); ok(n2 >= 12, 'heldout7 文字類至少 12/14：' + n2);
    // ④ 誠實失敗
    ok(!(await T.synthString({ statement: '', examples: [] })).ok, '沒有範例要失敗');
    { const r = await T.synthString({ statement: 'x', examples: [{ in: 'abc\n', out: 'abc\n' }] }); ok(!r.ok || r.ambiguous, '輸入輸出相同＝範例沒有資訊：不能標成確定'); }
    ok(!(await T.synthLines({ statement: 'x', examples: [{ in: '1 2\n', out: '3\n' }] })).ok, '形狀不認得要失敗');
    ok(!(await T.synthString({ statement: 'x', examples: [{ in: 'ab\n', out: 'zq9!\n' }] })).ok, '庫裡沒有的轉換要失敗');
    console.log(passed + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
