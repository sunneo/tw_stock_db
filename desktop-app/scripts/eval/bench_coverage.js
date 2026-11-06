// 涵蓋率基準（Node 版，不需要 Electron／模型）：對 renderer/src/recipe/seed/bench_*.jsonl 跑 buildFromUML 的離線管線。
//   模式 A＝Blockly 現況（配方→課→範式骨架）；矩陣層做完後加 B。設計見 DESIGN.matrix-fallback.md §7。
// 用法：FA_TS_DIR=/tmp/fa-ts-cache node scripts/eval/bench_coverage.js [--json out.json] [--mode A]
const fs = require('fs'), path = require('path'), os = require('os');
const U_ = path.join(__dirname, '..', '..', 'renderer', 'src', 'uml');
const r = (f) => require(path.join(U_, f));
const C2U = r('py_code2uml_core.js'), PBL = r('py_blocks_core.js'), RU = r('py_blocks_rules_core.js'), PB = r('py_body_core.js'), UC = r('uml_core.js'), AI = r('algo_intent_core.js'), PL = r('py_uml_pipeline_core.js'), CH = r('py_cnl_choose_core.js'), PAR = r('py_paradigms_core.js'), LS = r('py_lessons_core.js'), BI = r('py_lessons_builtin.js');
const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const B = PBL.makeBlocks({ parseTree: (s) => P.parse(s), C2U }); const R = RU.makeRules(B); const J = require('../../judge-runner.js');
    const seedDir = path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'seed');
    const probs = []; for (const f of fs.readdirSync(seedDir).filter((x) => /^bench_.*\.jsonl$/.test(x)).sort()) for (const l of fs.readFileSync(path.join(seedDir, f), 'utf8').split('\n').filter(Boolean)) probs.push(JSON.parse(l));
    const rows = [];
    for (const p of probs) {
        const t0 = Date.now(); const row = { id: p.id, level: p.level, pass: false, by: '-', tried: 0, reason: '' };
        try {
            const uml = await UC.scenarioToModel(p.statement, { readers: [AI.reader] });
            if (!(uml.ok && uml.fromHints)) row.reason = '讀取器讀不出意圖';
            else {
                const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: p }); return { verdict: j.verdict, detail: j.detail }; };
                const res = await PL.buildFromUML({ statement: p.statement, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge, Paradigms: PAR, Lessons: LS, lessons: BI.lessons });
                row.tried = res.tried || 0; row.by = res.paradigm ? 'paradigm:' + res.paradigm : res.lesson ? 'lesson:' + res.lesson : res.recipe ? 'recipe:' + res.recipe : '-';
                if (res.ok && res.verdict === 'AC') row.pass = true; else row.reason = (res.reason || res.verdict || '未通過') + (res.rounds ? ' [' + res.rounds.map((x) => x.by + ':' + (x.verdict || x.ok)).join(',') + ']' : '');
            }
        } catch (e) { row.reason = '例外：' + String((e && e.message) || e).slice(0, 100); }
        row.ms = Date.now() - t0; rows.push(row); console.log('[' + rows.length + '/' + probs.length + '] ' + row.level + ' ' + row.id + ' ' + (row.pass ? '✓ ' + row.by : '✗ ' + row.reason.slice(0, 90)) + ' tried=' + row.tried + ' ' + row.ms + 'ms');
    }
    console.log('\n模式 A（Blockly 現況，無模型）：' + rows.filter((x) => x.pass).length + '/' + rows.length);
    const lv = {}; for (const x of rows) { const b = lv[x.level] || (lv[x.level] = { total: 0, passed: 0, ms: 0, tried: 0 }); b.total++; b.ms += x.ms; b.tried += x.tried; if (x.pass) b.passed++; }
    for (const k of Object.keys(lv).sort()) console.log('  ' + k + '  ' + lv[k].passed + '/' + lv[k].total + '  ' + lv[k].ms + 'ms  tried=' + lv[k].tried);
    console.log('用到哪層：' + JSON.stringify(rows.filter((x) => x.pass).reduce((a, x) => (a[x.by] = (a[x.by] || 0) + 1, a), {})));
    console.log('解不出：'); rows.filter((x) => !x.pass).forEach((x) => console.log('  ' + x.level + ' ' + x.id + '：' + x.reason));
    if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify({ mode: 'A', rows, byLevel: lv }, null, 1));
    process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
