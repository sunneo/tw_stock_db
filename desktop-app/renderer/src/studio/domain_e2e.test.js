// node renderer/src/studio/domain_e2e.test.js
// 端到端：新增一個極小領域 → 驗證 → 載入（FaDomains.register／FaMatrixSynth.register）→ 評量（train／holdout）→ 離線 AI 解到一題沒教過的 holdout 題 → 停用後不再被用到。
// blockly 需要 tree-sitter 快取（FA_TS_DIR 或 ~/.cache/fa-ts）與 python；沒有就略過 blockly 部分（matrix 部分不需要）。
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const U = '../uml/';
const S = require('./domain_spec_core.js'), X = require('./dsl_expr_core.js'), D = require('./domain_demo_core.js'), EV = require('./domain_eval_core.js'), RT = require('./domain_runtime_core.js');
const AI = require(U + 'algo_intent_core.js'), PAR = require(U + 'py_paradigms_core.js'), DR = require(U + 'domain_registry_core.js'), SYN = require('../algo/matrix_synth_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 500) : '')); } };
const PY = process.env.FA_PYTHON || 'python';
const havePy = cp.spawnSync(PY, ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0;
const runRef = async (src, input) => { const r = cp.spawnSync(PY, ['-I', '-c', src], { input, encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, error: r.stderr }; };
const runtime = RT.createRuntime({ Domains: DR, AI, PAR, Synth: SYN, Spec: S, Expr: X });

(async () => {
    // ===== matrix =====
    const M = D.matrix();
    check('matrix：載入前矩陣層沒有使用者模組', !SYN.list().some((x) => /^user:/.test(x.name)));
    const lr = await runtime.ensure(M); check('matrix：ensure', lr.ok && lr.ops === 2, lr);
    check('matrix：註冊進 FaMatrixSynth（order 5／6，在遞推 10 之前）', SYN.list().filter((x) => /^user:demo-ops/.test(x.name)).length === 2 && SYN.list()[0].order === 5);
    check('matrix：重複 ensure 是 already', (await runtime.ensure(M)).already === true);
    const r1 = await SYN.synth({ statement: M.tasks[0].statement, examples: M.tasks[0].examples });
    check('matrix：矩陣層真的用到使用者操作', r1.ok && r1.kind === 'user-op' && r1.userOp.op === 'lin-mod', r1);
    const dMatrix = { Synth: SYN, Expr: X, runtime, cache: {} };
    const res = await EV.runDomain(M, dMatrix);
    const g = res.groups;
    check('matrix：train 2/2', g['domain/demo-ops/train'].n === 2 && g['domain/demo-ops/train'].pass === 2, g['domain/demo-ops/train']);
    check('matrix：holdout 2/2（沒教過的 5n+1 mod 9 與另一個回文敘述）', g['domain/demo-ops/holdout'].n === 2 && g['domain/demo-ops/holdout'].pass === 2, g['domain/demo-ops/holdout']);
    check('matrix：holdout 不回逐題內容', g['domain/demo-ops/holdout'].detail === undefined && Array.isArray(g['domain/demo-ops/train'].detail));
    check('matrix：train 逐題標 verified', g['domain/demo-ops/train'].detail.every((d) => d.verified === true && d.by.startsWith('user:demo-ops')), g['domain/demo-ops/train'].detail);
    // 退步偵測：把某個隱藏範例改錯 → 評量變低 → eval_core 標紅
    const Ev = require('./eval_core.js');
    const suites = EV.domainSuites(M, dMatrix); const first = await Ev.runEval('matrix', suites, {}); const base = {}; first.groups.forEach((x) => { if (x.ran) base[x.group] = x.rate; });
    const broken = JSON.parse(JSON.stringify(M)); broken.tasks[0].hidden[0].out = '99\n'; const dB = { Synth: SYN, Expr: X, runtime, cache: {} };
    const second = await Ev.runEval('matrix', EV.domainSuites(broken, dB), { baseline: base });
    const tr = second.groups.find((x) => x.group === 'domain/demo-ops/train'); check('matrix：退步標紅', tr.ran && tr.regressed === true && tr.rate < base['domain/demo-ops/train'], tr);
    check('matrix：holdout 組標 heldout', first.groups.find((x) => x.group === 'domain/demo-ops/holdout').heldout === true);
    // 停用：模組拿掉
    check('matrix：remove', runtime.remove('demo-ops').removed === true && !SYN.list().some((x) => /^user:/.test(x.name)));
    const r2 = await SYN.synth({ statement: M.tasks[0].statement, examples: M.tasks[0].examples }); check('matrix：停用後不再走使用者操作', !(r2.ok && r2.kind === 'user-op'));
    // 同步啟用表
    const store = { list: async () => [{ kind: 'matrix', name: 'demo-ops' }], load: async () => M };
    check('syncEnabled：沒啟用就不載入', (await runtime.syncEnabled(store, {})).loaded.length === 0 && !runtime.has('demo-ops'));
    check('syncEnabled：啟用才載入', (await runtime.syncEnabled(store, { 'matrix/demo-ops': true })).loaded[0] === 'demo-ops' && runtime.has('demo-ops'));
    check('syncEnabled：關掉會拿掉', (await runtime.syncEnabled(store, { 'matrix/demo-ops': false })).removed[0] === 'demo-ops' && !runtime.has('demo-ops'));
    // 安全：規格裡的壞運算式進不了執行期
    const evil = JSON.parse(JSON.stringify(M)); evil.ops[0].expr = '__import__("os").system("x")'; check('壞運算式不能載入', (await runtime.ensure(evil)).ok === false);

    // ===== blockly =====
    const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
    if (!havePy || !fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過 blockly 端到端：找不到 python 或 ' + DIR); console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0); }
    const C2U = require(U + 'py_code2uml_core.js'), PBL = require(U + 'py_blocks_core.js'), RU = require(U + 'py_blocks_rules_core.js'), PB = require(U + 'py_body_core.js'), UC = require(U + 'uml_core.js'), PL = require(U + 'py_uml_pipeline_core.js'), CH = require(U + 'py_cnl_choose_core.js');
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const B = PBL.makeBlocks({ parseTree: (s) => P.parse(s), C2U }); const R = RU.makeRules(B); const J = require('../../../judge-runner.js');
    const solve = async (t) => {
        const uml = await UC.scenarioToModel(t.statement, { readers: [AI.reader] }); if (!uml.ok || !uml.fromHints) return { ok: false, reason: 'uml_design 讀不出這題' };
        const problem = { id: 'e2e', tests: t.tests, hidden: t.hidden, checker: t.checker || 'tokens' };
        const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement: t.statement, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge, Paradigms: PAR });
        return r.ok ? { ok: true, verdict: r.verdict || 'AC', paradigm: r.paradigm, tried: r.tried } : { ok: false, reason: r.reason, verdict: 'FAIL' };
    };
    const Bs = D.blockly(); const holdoutStatement = Bs.families[1].statements[0];
    // 對照：載入前，領域的讀題規則不在，奇數計數題不會被標成領域的算法種類
    check('blockly：載入前沒有使用者算法種類', !AI.ALGOS.some((a) => a.key === 'demo-parity-count'));
    const lb = await runtime.ensure(Bs); check('blockly：ensure', lb.ok && lb.algos === 1 && lb.skeletons === 1, lb);
    check('blockly：讀題規則進 ALGOS 且排前面（領域優先）', AI.ALGOS[0].key === 'demo-parity-count' && AI.ALGOS[0].pri === true);
    check('blockly：讀題器把 holdout 敘述分到領域算法種類', (AI.read(holdoutStatement) || {}).algo === 'demo-parity-count', AI.read(holdoutStatement));
    check('blockly：骨架進 FaPyParadigms', !!PAR.byId['demo.parity-count'] && PAR.forIntent(AI.read(holdoutStatement), holdoutStatement).some((s) => s.id === 'demo.parity-count'));
    check('blockly：FaDomains.judgeOf 查得到領域判題設定', (DR.judgeOf('demo-parity-count') || {}).checker === 'tokens');
    check('blockly：沒有搶內建題（排序題照舊歸內建）', (AI.read('第一行 n，第二行 n 個整數。請由小到大排序後輸出。') || {}).algo !== 'demo-parity-count');
    const dB2 = { solve, runRef, runtime, cache: {} };
    const rb = await EV.runDomain(Bs, dB2);
    const bt = rb.groups['domain/demo-parity/train'], bh = rb.groups['domain/demo-parity/holdout'];
    check('blockly：train 2/2（由領域範式解出）', bt && bt.n === 2 && bt.pass === 2 && bt.detail.every((d) => d.by === 'demo.parity-count'), bt);
    check('blockly：離線 AI 解到沒教過的 holdout 題（奇數個數）', bh && bh.n === 1 && bh.pass === 1, bh);
    // 直接看這一題是怎麼解的
    const bt1 = await EV.loadTasks(Bs, dB2); const ho = bt1.tasks.find((t) => t.split === 'holdout'); const sr = await solve(ho);
    check('blockly：holdout 題是靠領域骨架解出（par=1）', sr.ok && sr.paradigm === 'demo.parity-count', sr);
    // 停用 → 拿掉
    runtime.remove('demo-parity');
    check('blockly：停用後讀題規則與骨架都拿掉', !AI.ALGOS.some((a) => a.key === 'demo-parity-count') && !PAR.byId['demo.parity-count'] && !AI.PARADIGMS['demo-parity-count']);
    const sr2 = await solve(ho); check('blockly：停用後這題不再由領域範式解', !(sr2.ok && sr2.paradigm === 'demo.parity-count'), sr2);
    // 重新啟用（雜湊不變也要能再註冊：packs 內舊 id 還在，所以用帶雜湊的 id）
    const again = await runtime.ensure(Bs); check('blockly：重新啟用', again.ok && !again.already, again);
    runtime.remove('demo-parity');
    // 與內建重名要擋
    const clash = JSON.parse(JSON.stringify(Bs)); clash.algos[0].key = AI.ALGOS.find((a) => !a.userDomain).key; clash.skeletons[0].algo = clash.algos[0].key; clash.families.forEach((f) => { f.algo = clash.algos[0].key; });
    const cr = await runtime.ensure(clash); check('blockly：算法種類與內建重名 → 擋並說明', cr.ok === false && /與內建重名/.test(cr.error), cr);
    console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.log(ok + ' passed, ' + (bad + 1) + ' failed'); process.exit(1); });
