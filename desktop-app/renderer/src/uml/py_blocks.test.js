'use strict';
// 區塊範本庫：種子程式 body → 區塊（反推）→ 受控自然語言 → 區塊 → Python → 判題 AC；並要求每一步都可逆（IR 相同）。
const fs = require('fs'), path = require('path'), os = require('os');
const C2U = require('./py_code2uml_core.js'); const PB = require('./py_blocks_core.js'); const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang); const parseTree = (s) => P.parse(s);
    const B = PB.makeBlocks({ parseTree, C2U }); const R = require('../../../judge-runner.js');
    const probs = fs.readFileSync(path.join(__dirname, '..', 'recipe', 'seed', 'problems.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let ac = 0, rev = 0, cnl = 0, blocks = 0, generic = 0; const fails = []; const tpl = {}; const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b); let shown = false;
    for (const p of probs) {
        try {
            const src = p.ref.python; const tree = parseTree(src); const u = C2U.fromTree(tree.rootNode, { source: src }); const ops = u.model.classes[0].ops;
            let allOk = true; let cnlOk = true; const newOps = [];
            for (const op of ops) {
                const bl = B.fromIR(op.body); const st = B.stats(bl); blocks += st.blocks; generic += st.generic; for (const k in st.byTemplate) tpl[k] = (tpl[k] || 0) + st.byTemplate[k];
                if (!eq(B.toIR(bl), op.body)) allOk = false;
                const text = B.toCNL(bl); const pr = B.parseCNL(text); if (!pr.ok || !eq(B.toIR(pr.blocks), op.body)) { cnlOk = false; if (!fails.length) fails.push(p.id + '／' + op.name + ' CNL 往返失敗：' + JSON.stringify(pr.errors.slice(0, 2)) + '\n' + text); }
                newOps.push(Object.assign({}, op, { body: B.toIR(bl) }));
                if (!shown && p.id === 'two-sum') { shown = true; console.log('--- two-sum 的區塊（受控自然語言）\n' + text + '\n'); }
            }
            if (allOk) rev++; else fails.push(p.id + ' IR 往返不同'); if (cnlOk) cnl++;
            const m = Object.assign({}, u.model, { classes: [Object.assign({}, u.model.classes[0], { ops: newOps })].concat(u.model.classes.slice(1)) });
            const j = await R.judge({ lang: 'python', source: C2U.toPython(m) + '\nmain()\n', problem: p }); if (j.verdict === 'AC') ac++; else fails.push(p.id + ' ' + j.verdict);
        } catch (e) { fails.push(p.id + ' 例外：' + String(e.stack || e.message).slice(0, 220)); }
    }
    console.log('範本 ' + B.TEMPLATES.length + ' 個；種子題 ' + probs.length + '：IR 往返相同 ' + rev + '、CNL 往返相同 ' + cnl + '、區塊後 AC ' + ac);
    console.log('區塊 ' + blocks + '，通用「程式」區塊 ' + generic + '（' + (100 * generic / blocks).toFixed(1) + '%）；用到的範本 ' + Object.keys(tpl).length + ' 種');
    fails.forEach((f) => console.log('  ✗ ' + f)); console.log(Math.min(rev, cnl, ac) + ' passed, ' + (probs.length - Math.min(rev, cnl, ac)) + ' failed'); process.exit(ac === probs.length && rev === probs.length && cnl === probs.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
