'use strict';
// uml_design → 骨架 → 區塊 → 沙盒：20 題種子的「程式讀情境」部分（不需要模型）。
//  uml_design 要讀得出 UML（0 次模型呼叫、驗證無錯）、readInput 與 main 由程式生成、讀入的資料跟參考解答一致、
//  能走配方的題目配方要過沙盒（AC）；配方對不出來的題目明確標示「需要模型」。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const C2U = require('./py_code2uml_core.js'), PBL = require('./py_blocks_core.js'), RU = require('./py_blocks_rules_core.js'), PB = require('./py_body_core.js'), U = require('./uml_core.js'), AI = require('./algo_intent_core.js'), PL = require('./py_uml_pipeline_core.js'), CH = require('./py_cnl_choose_core.js');
const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const B = PBL.makeBlocks({ parseTree: (s) => P.parse(s), C2U }); const R = RU.makeRules(B); const J = require('../../../judge-runner.js');
    const probs = fs.readFileSync(path.join(__dirname, '..', 'recipe', 'seed', 'problems.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let umlOk = 0, recipeAC = 0, needModel = 0, bad = []; const need = [];
    for (const p of probs) {
        const uml = await U.scenarioToModel(p.statement, { readers: [AI.reader] });
        if (!(uml.ok && uml.fromHints && uml.errors.length === 0 && uml.decisions.every((d) => d.by === 'program'))) { bad.push(p.id + '：uml_design 讀不出或有驗證錯誤'); continue; } umlOk++;
        const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: p }); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement: p.statement, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge });
        if (r.ok && !r.usedModel && r.verdict === 'AC') recipeAC++; else if (!r.ok && /需要模型|沒有配方|沒通過/.test(r.reason || '')) { needModel++; need.push(p.id); } else bad.push(p.id + '：' + (r.reason || r.verdict));
    }
    console.log('uml_design 讀出 UML（0 次模型）' + umlOk + '/20；程式直接解出且 AC ' + recipeAC + '；需要模型 ' + needModel + '：' + need.join('、')); bad.forEach((b) => console.log('  ✗ ' + b));
    assert.strictEqual(umlOk, 20, 'uml_design 要讀出全部 20 題'); assert.strictEqual(bad.length, 0, bad.join('；')); assert.ok(recipeAC >= 2, '至少 a-plus-b 與 max-of-array 要由配方直接解出');
    // 沒見過的寫法（不是種子題）：讀取器與配方要能泛化，而且產生的程式真的會跑
    const held = [
        { s: '輸入兩個整數 x y，輸出 x*y。', tests: [{ in: '3 4\n', out: '12\n' }, { in: '-2 5\n', out: '-10\n' }] },
        { s: '第一行一個整數 n，第二行 n 個整數。求最大值並輸出。', tests: [{ in: '3\n5 9 2\n', out: '9\n' }, { in: '2\n-4 -7\n', out: '-4\n' }] },
        { s: '第一行 n，第二行 n 個整數。輸出這些數的總和。', tests: [{ in: '3\n1 2 3\n', out: '6\n' }] },
        { s: '輸入一行兩個整數 p q，輸出 p-q。', tests: [{ in: '10 3\n', out: '7\n' }] },
    ];
    let heldOk = 0; for (const h of held) {
        const uml = await U.scenarioToModel(h.s, { readers: [AI.reader] }); if (!(uml.ok && uml.fromHints)) { console.log('  ✗ 沒讀出：' + h.s); continue; }
        const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: { id: 'h', tests: h.tests } }); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement: h.s, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge }); if (r.ok && r.verdict === 'AC' && !r.usedModel) heldOk++; else console.log('  ✗ 配方沒解出：' + h.s + '／' + (r.reason || r.verdict));
    }
    console.log('沒見過的寫法 ' + heldOk + '/' + held.length + ' 由程式讀情境直接解出且 AC'); assert.strictEqual(heldOk, held.length);
    console.log((recipeAC + heldOk) + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.log('0 passed, 1 failed'); process.exit(1); });
