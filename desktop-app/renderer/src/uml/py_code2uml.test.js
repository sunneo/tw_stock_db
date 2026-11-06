'use strict';
// 種子題參考解答：程式 → tree-sitter → UML（含指令層級 body）→ Python → 判題器 AC；並檢查「再轉一次」結果相同（穩定）。
const fs = require('fs'), path = require('path'), os = require('os');
const C = require('./py_code2uml_core.js'); const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const R = require('../../../judge-runner.js'); const probs = fs.readFileSync(path.join(__dirname, '..', 'recipe', 'seed', 'problems.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const conv = (code) => { const t = P.parse(code); return C.fromTree(t.rootNode, { source: code }); };
    let ac = 0, stable = 0, stmts = 0, raws = 0; const kinds = {}; const fails = []; let showed = false;
    for (const p of probs) {
        try {
            const a = conv(p.ref.python); stmts += a.coverage.stmts; raws += a.coverage.raws; for (const k in a.coverage.rawKinds) kinds[k] = (kinds[k] || 0) + a.coverage.rawKinds[k];
            const code = C.toPython(a.model); const b = conv(code); const code2 = C.toPython(b.model); if (code === code2) stable++; else fails.push(p.id + ' 再轉一次不同');
            const j = await R.judge({ lang: 'python', source: code + '\nmain()\n', problem: p }); if (j.verdict === 'AC') ac++; else fails.push(p.id + ' ' + j.verdict + ' ' + (j.detail || '').slice(0, 100));
            if (process.argv[2] === 'show' && !showed && p.id === 'two-sum') { showed = true; console.log(JSON.stringify({ classes: a.model.classes.map((c) => ({ name: c.name, ops: c.ops.map((o) => o.name + '(' + o.params.map((x) => x.name) + ')') })), usecases: a.model.usecases }, null, 1)); console.log(code); }
        } catch (e) { fails.push(p.id + ' 例外：' + String(e.stack || e.message).slice(0, 200)); }
    }
    console.log('種子題 ' + probs.length + '：往返後 AC ' + ac + '、再轉穩定 ' + stable + '；敘述 ' + stmts + '、收成 raw ' + raws + ' ' + JSON.stringify(kinds)); fails.forEach((x) => console.log('  ✗ ' + x));
    const okN = Math.min(ac, stable); console.log(okN + ' passed, ' + (probs.length - okN) + ' failed');
    process.exit(ac === probs.length && stable === probs.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
