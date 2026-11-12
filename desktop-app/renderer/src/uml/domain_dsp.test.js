'use strict';
// 領域包 DSP：18 題種子（原敘述＋換變數名稱的改寫＋選項反序），不給課、0 次模型，float 容差判題（eps 1e-4），每題 6 筆測資＋2 筆大的隱藏測資（n 約 150～250）。
// 參考解是獨立寫的 Python（不用骨架）；期望輸出由參考解在同一份輸入上算出來。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), cp = require('child_process');
const C2U = require('./py_code2uml_core.js'), PBL = require('./py_blocks_core.js'), RU = require('./py_blocks_rules_core.js'), PB = require('./py_body_core.js'), UC = require('./uml_core.js'), AI = require('./algo_intent_core.js'), PL = require('./py_uml_pipeline_core.js'), CH = require('./py_cnl_choose_core.js'), PAR = require('./py_paradigms_core.js'), DR = require('./domain_registry_core.js'), DSP = require('./domain_dsp_core.js');
const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
let seed = 4242; const rnd = (a, b) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return a + ((seed >> 8) % (b - a + 1)); };
const fl = (n, lo, hi) => Array.from({ length: n }, () => (rnd(lo || -900, hi || 900) / 100).toFixed(2)).join(' ');
const NN = (big, a, b) => (big ? rnd(150, 250) : rnd(a, b));
const OUT = '每個數字保留 6 位小數。'; const F6 = '" ".join("%.6f" % v for v in out)';
const rd = 'import math\nL = [l.split() for l in __import__("sys").stdin.read().split("\\n") if l.strip()]\n';
const SEEDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'seeds', 'domain_dsp.json'), 'utf8')).seeds.map((x) => Object.assign({}, x, { rw: () => x.rw_st }));
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR); process.exit(0); }
    const reg = DR.register(DSP.make(PAR), { AI, PAR }); assert.ok(reg.ok, reg.reason); assert.ok(reg.skeletons >= 17);
    for (const sk of PAR.PARADIGMS) assert.ok(PAR.combos(sk, { limit: 999 }).length <= Math.max(18, sk.limit || 0), sk.id + ' 組合太多');
    assert.deepStrictEqual(DR.judgeOf('fir-conv'), { checker: 'float', eps: 1e-4 });
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const B = PBL.makeBlocks({ parseTree: (s) => P.parse(s), C2U }); const R = RU.makeRules(B); const J = require('../../../judge-runner.js');
    const rev = (sk, c) => -PAR.combos(sk, { limit: 999 }).findIndex((x) => JSON.stringify(x) === JSON.stringify(c));
    const run = async (e, st, tests, hidden, rank) => {
        const uml = await UC.scenarioToModel(st, { readers: [AI.reader] }); if (!uml.ok || !uml.fromHints) return { err: 'uml_design 讀不出' };
        const jd = DR.judgeOf((AI.read(st) || {}).algo) || {}; const problem = { id: e.id, tests, hidden, checker: jd.checker, eps: jd.eps };
        const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement: st, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge, Paradigms: PAR, paradigmRank: rank });
        if (!r.ok) return { err: r.reason }; const j = await J.judge({ lang: 'python', source: r.source + '\nmain()\n', problem }); return { r, v: j.verdict, detail: j.detail };
    };
    const bad = []; let ok = 0, revOk = 0, n = 0; const rows = [];
    for (const e of SEEDS) for (const [tag, st] of [['原敘述', e.st], ['改寫', e.rw(e.st)]]) {
        n++; const tests = e.tests.slice(), hidden = e.hidden.slice();
        if (tests.length < 4) { bad.push(e.id + '（' + tag + '）：參考解產生不出測資'); continue; }
        const o = await run(e, st, tests, hidden); if (o.err) { bad.push(e.id + '（' + tag + '）：' + o.err); continue; }
        if (o.v === 'AC' && o.r.paradigm === e.want) { ok++; rows.push(e.id + (tag === '改寫' ? '′' : '') + '←' + o.r.paradigm + '（試 ' + o.r.tried + '）'); } else bad.push(e.id + '（' + tag + '）：' + o.v + ' ' + (o.r.paradigm || '-') + ' ' + String(o.detail || '').slice(0, 100));
        const o2 = await run(e, st, tests, hidden, rev); if (!o2.err && o2.v === 'AC' && o2.r.paradigm === e.want) revOk++; else bad.push(e.id + '（' + tag + '，反序）：' + (o2.err || o2.v));
    }
    console.log('DSP 領域 ' + ok + '/' + n + ' AC（由指定範式解出）；選項反序 ' + revOk + '/' + n + '（不給課、0 次模型、float 容差、含隱藏大測資）'); console.log(rows.join('、')); bad.forEach((b) => console.log('  ✗ ' + b));
    assert.strictEqual(bad.length, 0, bad.join('；')); console.log((ok + revOk) + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.log('0 passed, 1 failed'); process.exit(1); });
