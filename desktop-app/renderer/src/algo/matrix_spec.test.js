'use strict';
// 矩陣層「只有需求、沒有測資」流程與待補教學佇列（matrix_spec_core）：
//  ① 讀輸入形狀：對題庫所有題（tests 的 ref 是答案來源）用 proposeInputs 生成輸入，丟給參考解執行——能跑出輸出才算「合法輸入」；回報讀得出的比例；
//  ② 沒有範例時：need-examples、verified:false、不產生程式、不編造答案，有卡片；③ 有預言機時：生成輸入→預言機答案→合成→在沒用來學的輸入上比對，標 dataSource:'oracle'；
//  ④ 使用者答案（卡片回填）→ dataSource:'user-answers'，沒有獨立驗證就 verified:false；⑤ 鑑別力排序；⑥ 待補教學佇列：去重、壞行略過、fallback 欄位。
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process');
const Sp = require('./matrix_spec_core.js'); const S = require('./matrix_synth_core.js');
const mods = ['matrix_graph_core', 'matrix_l0_core', 'matrix_text_core', 'matrix_checksum_core', 'matrix_sketch_core', 'matrix_os_core']; const G = require('./matrix_graph_core.js'); G.install(S);
for (const m of mods.slice(1)) { try { const X = require('./' + m + '.js'); if (X.install) X.install(S); } catch (e) { console.log('略過 ' + m + '：' + e.message); } }
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'); let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
const dir = path.join(__dirname, '..', 'recipe', 'seed'); const load = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const HARNESS = 'import sys, json, io, builtins\nP = json.loads(sys.stdin.read())\nres = []\nfor line in P["ins"]:\n    ns = {"__name__": "x"}\n    try:\n        exec(P["src"], ns)\n        it = iter(line.split("\\n"))\n        old_in = builtins.input\n        builtins.input = lambda *a: next(it)\n        buf = io.StringIO(); old = sys.stdout; sys.stdout = buf\n        try:\n            ns["main"]()\n        finally:\n            sys.stdout = old; builtins.input = old_in\n        res.append(buf.getvalue())\n    except Exception as e:\n        res.append(None)\nprint(json.dumps(res))\n';
const runMany = (src, ins) => { const r = cp.spawnSync(PY, ['-I', '-c', HARNESS], { input: JSON.stringify({ src, ins }), encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 }); assert.strictEqual(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
(async () => {
    // ① 形狀覆蓋
    const files = ['heldout_all', 'heldout2_graph', 'heldout3_graph', 'heldout4_graph', 'heldout5_l0', 'heldout6_compose', 'heldout7_mixed', 'heldout8_l4', 'bench_L0_L5_L6', 'bench_L1_L2', 'bench_L3_L4', 'bench_extra', 'bench_linux_all']; const stat = {}; let total = 0, readable = 0, valid = 0; const bad = [];
    for (const f of files) { let L; try { L = load(f + '.jsonl'); } catch (e) { continue; } for (const p of L) { total++; const g = Sp.proposeInputs(p.statement, { count: 6, seed: 7 }); if (!g.ok) { bad.push(p.id + '：' + g.reason.slice(0, 30)); continue; } readable++; const outs = runMany(p.ref.python, g.inputs); const good = outs.filter((x) => x !== null && x.trim() !== '').length; if (good >= Math.ceil(g.inputs.length * 0.8)) valid++; else bad.push(p.id + '：生成的輸入參考解跑不動（' + g.shape + '）'); stat[g.shape] = (stat[g.shape] || 0) + 1; } }
    console.log('① 形狀覆蓋：題數 ' + total + '，讀得出輸入格式 ' + readable + '，生成的輸入能讓參考解正常輸出 ' + valid + '；形狀分佈 ' + JSON.stringify(stat)); console.log('   讀不出／不合法（前 12）：' + bad.slice(0, 12).join('；'));
    ok(valid / total >= 0.3, '合法輸入至少涵蓋三成題：' + valid + '/' + total); ok(valid >= readable * 0.85, '讀得出的題裡 85% 以上生成的輸入是合法的：' + valid + '/' + readable);
    // ② 沒範例
    const h8 = load('heldout8_l4.jsonl'), h7 = load('heldout7_mixed.jsonl'); let called = 0; const spy = async (x) => { called++; return S.synth(x); };
    { const p = h8.find((x) => x.id === 'h8-sum-squares'); const r = await Sp.specFlow({ statement: p.statement, synth: spy }); ok(r.status === 'need-examples' && r.verified === false && r.dataSource === 'none' && !r.result && r.inputs.length >= 5 && r.card && r.card.items.length >= 3, 'need-examples'); ok(called === 0, '沒範例不啟動合成'); ok(/沒有被任何範例驗證/.test(r.reason + r.card.honesty), '要明說沒被驗證'); }
    { const r = await Sp.specFlow({ statement: '幫我寫個程式處理一些東西', synth: spy }); ok(r.status === 'cannot-read' && !r.verified, '敘述讀不出輸入格式要明說'); }
    console.log('② 沒有範例：need-examples／cannot-read，不合成、不編造');
    // ③ 預言機
    const oracleOf = (p) => async (inp) => { const o = runMany(p.ref.python, [inp])[0]; if (o === null) throw new Error('ref 失敗'); return o; };
    const runSource = async (src, inp) => runMany(src + '\nmain()\n', [inp])[0];
    let solved = 0, verifiedN = 0; const sample = ['h8-sum-squares', 'h8-lcm', 'h8-to-base', 'h8-count-primes', 'h8-prime-divisors'].map((id) => h8.find((x) => x.id === id)).concat(['h7-upper-lines', 'h7-caesar', 'h7-byte-sum', 'h7-lru-hits'].map((id) => h7.find((x) => x.id === id)));
    for (const p of sample) { const r = await Sp.specFlow({ statement: p.statement, oracle: oracleOf(p), runSource, synth: S.synth, nExamples: 3, count: 12, seed: 99 }); console.log('   ' + p.id + ' → ' + r.status + ' source=' + r.dataSource + ' verified=' + r.verified + (r.check ? ' 預言機比對 ' + r.check.pass + '/' + r.check.n : '') + (r.reason ? ' ' + r.reason.slice(0, 40) : '')); if (r.status === 'solved') { solved++; ok(r.dataSource === 'oracle', '資料來源標 oracle'); if (r.verified) verifiedN++; } }
    console.log('③ 預言機流程：' + solved + '/' + sample.length + ' 解出，其中 verified ' + verifiedN); ok(solved >= 5, '預言機流程至少解出 5/9：' + solved);
    // ④ 使用者答案
    { const p = h8.find((x) => x.id === 'h8-sum-squares'); const g = Sp.proposeInputs(p.statement, { count: 6, seed: 5 }); const outs = runMany(p.ref.python, g.inputs); const answers = g.inputs.slice(0, 3).map((i, k) => ({ in: i, out: outs[k] })); const r = await Sp.specFlow({ statement: p.statement, answers, synth: S.synth }); ok(r.dataSource === 'user-answers', '來源標 user-answers'); ok(r.status !== 'need-examples', '有答案就不再要範例'); if (r.status === 'solved') ok(r.verified === false, '使用者答案沒有獨立驗證：不能標 verified'); console.log('④ 使用者答案：' + r.status + ' verified=' + r.verified); }
    // ⑤ 鑑別力
    { const c = [{ id: 'a', run: (x) => x.length }, { id: 'b', run: (x) => x.length }, { id: 'c', run: (x) => (x.length > 3 ? 1 : x.length) }]; const q = Sp.pickDiscriminating(c, ['ab', 'abcdef', 'abc'], 2); ok(q.length === 1 && q[0].in === 'abcdef' && q[0].groups.length === 2, '鑑別力：只有候選不一致的輸入才會被問'); ok(Sp.pickDiscriminating([c[0], c[1]], ['a', 'bb'], 3).length === 0, '候選一致就不用問'); }
    // ⑥ 佇列
    { const e1 = Sp.teachEntry({ statement: '輸入 n，輸出 n 的歐拉函數', examples: [{ in: '6\n', out: '2\n' }], fallback: Sp.fallbackInfo({ ok: false, reason: '矩陣層：沒有符合', rounds: [{ by: 'paradigm', verdict: 'WA' }] }, { readOk: true, statement: 'x' }) });
      ok(e1.needTeaching && e1.stuckAt && e1.id.length === 8, '條目欄位'); let q = Sp.mergeQueue([], e1); q = Sp.mergeQueue(q, Object.assign({}, e1, { statement: ' 輸入 n，輸出  n 的歐拉函數 ' })); ok(q.length === 1 && q[0].count === 2, '同一題去重並累計次數'); q = Sp.mergeQueue(q, Sp.teachEntry({ statement: '另一題', examples: [] })); const text = Sp.queueText(q) + '壞掉的一行{\n'; const back = Sp.parseQueue(text); ok(back.length === 2, '壞行略過、好行保留'); ok(Sp.fallbackInfo({ ok: false }, { readOk: false, statement: 's' }).stage === 'reader', '讀取器讀不出 → stage reader'); ok(Sp.fallbackInfo({ ok: false }, { readOk: true, statement: 's' }).next.includes('teach'), 'next 含 teach'); }
    console.log(passed + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
