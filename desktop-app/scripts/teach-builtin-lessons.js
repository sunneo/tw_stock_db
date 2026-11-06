'use strict';
// 老師迴圈（Node 版，跑的是 /offline-trainer-by-ai 同一套流程）：老師＝Claude 的解答（scripts/teacher-solutions.js），驗證＝判題器（含隱藏測資）。
// 每個任務：① 先讓離線組合自己試（uml_design → 配方／課 → 沙盒）② 驗證沒過才請老師 ③ 老師的解答自己也要過驗證 ④ 訓練器把解答抽成課
// ⑤ 離線自己重做並通過 ⑥ 回歸（先前會的題不能退步）⑦ 通過才接受，否則回滾這堂課。最後把接受的課寫成內建資料檔 renderer/src/uml/py_lessons_builtin.js。
//   node scripts/teach-builtin-lessons.js [--write] [--only id,id]
const fs = require('fs'), path = require('path'), os = require('os');
const REPO = path.join(__dirname, '..'); const U = (f) => require(path.join(REPO, 'renderer/src/uml', f));
const C2U = U('py_code2uml_core.js'), PBL = U('py_blocks_core.js'), RU = U('py_blocks_rules_core.js'), PB = U('py_body_core.js'), UC = U('uml_core.js'), AI = U('algo_intent_core.js'), PL = U('py_uml_pipeline_core.js'), CH = U('py_cnl_choose_core.js'), LS = U('py_lessons_core.js');
const J = require(path.join(REPO, 'judge-runner.js')); const SOL = require('./teacher-solutions.js'); const has = (k) => process.argv.includes('--' + k); const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
(async () => {
    const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts'); const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang); const parseTree = (s) => P.parse(s);
    const B = PBL.makeBlocks({ parseTree, C2U }); const R = RU.makeRules(B);
    let probs = fs.readFileSync(path.join(REPO, 'renderer/src/recipe/seed/problems.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); if (arg('only')) probs = probs.filter((p) => arg('only').split(',').includes(p.id));
    const lessons = []; const log = [];
    // 離線組合（不問任何模型）：uml_design → 配方／課 → 沙盒（只用範例測資，跟產品裡一樣）
    const offline = { async run(task) {
        const uml = await UC.scenarioToModel(task.statement, { readers: [AI.reader] }); if (!uml.ok || !uml.fromHints) return { error: 'uml_design 讀不出這題' };
        const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: Object.assign({}, task, { hidden: [] }) }); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement: task.statement, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge, Lessons: LS, lessons }); return r.ok ? { source: r.source, by: r.recipe ? '配方：' + r.recipe : r.lesson ? '課：' + r.lesson : '?' } : { error: r.reason };
    } };
    const verify = async (task, result) => { if (!result || !result.source) return { ok: false, detail: (result && result.error) || '沒有程式' }; const j = await J.judge({ lang: 'python', source: result.source + '\nmain()\n', problem: task }); return { ok: j.verdict === 'AC', detail: j.verdict + (j.detail ? '：' + String(j.detail).slice(0, 120) : '') }; };
    const verifyTeacher = async (task, solutionSrc) => { // 老師的解答也要過判題：接進同一個骨架（read_input 讀好 → solve → main）
        const intent = AI.read(task.statement); const bl = LS.deriveLesson({ statement: task.statement, intent, source: solutionSrc, B, C2U, parseTree, serial: 0 }); if (!bl.ok) return { ok: false, detail: bl.reason };
        const uml = await UC.scenarioToModel(task.statement, { readers: [AI.reader] }); const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: task }); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement: task.statement, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge, Lessons: LS, lessons: [bl.lesson] }); return { ok: !!(r.ok && r.verdict === 'AC'), detail: r.ok ? r.verdict + ' ' + (r.rounds.map((x) => x.detail).filter(Boolean).pop() || '') : r.reason, lesson: bl.lesson };
    };
    const st = { offline: 0, taught: 0, unresolved: 0, rejected: 0, teacherCalls: 0 }; const solved = []; const per = {};
    let base = 0; for (const t of probs) { if ((await verify(t, await offline.run(t))).ok) base++; }
    console.log('開始前：離線組合（不問模型、沒有課）自己解決 ' + base + '/' + probs.length);
    for (const task of probs) {
        const tr = { id: task.id, steps: [] }; per[task.id] = tr;
        const v0 = await verify(task, await offline.run(task)); tr.steps.push('try_offline:' + (v0.ok ? 'pass' : 'fail'));
        if (v0.ok) { st.offline++; solved.push(task); console.log('  ✓ ' + task.id.padEnd(16) + '離線自己會'); continue; }
        let done = false; for (let attempt = 1; attempt <= 3 && !done; attempt++) {
            const sol = SOL[task.id]; st.teacherCalls++; if (!sol) { tr.steps.push('teach:沒有解答'); break; }
            const tv = await verifyTeacher(task, sol); tr.steps.push('verify_teacher:' + (tv.ok ? 'pass' : 'fail')); if (!tv.ok) { console.log('  ! ' + task.id + ' 老師的解答沒過：' + tv.detail); break; }
            const lesson = Object.assign(tv.lesson, { id: tv.lesson.algo + '#1', createdBy: 'claude', note: task.id }); lessons.push(lesson); tr.steps.push('learn:' + lesson.id);
            const v1 = await verify(task, await offline.run(task)); tr.steps.push('reverify:' + (v1.ok ? 'pass' : 'fail'));
            if (!v1.ok) { lessons.pop(); st.rejected++; console.log('  ↩ ' + task.id + ' 課離線重做沒過：' + v1.detail); continue; }
            const bad = []; for (const t of solved) { if (!(await verify(t, await offline.run(t))).ok) bad.push(t.id); } tr.steps.push('regress:' + (bad.length ? 'fail ' + bad.join(',') : 'pass'));
            if (bad.length) { lessons.pop(); st.rejected++; console.log('  ↩ ' + task.id + ' 課讓這些退步：' + bad.join('、')); continue; }
            st.taught++; solved.push(task); done = true; console.log('  ✓ ' + task.id.padEnd(16) + '老師教會（課 ' + lesson.id + '）');
        }
        if (!done) { st.unresolved++; console.log('  ✗ ' + task.id + ' 教不會'); }
    }
    let after = 0; for (const t of probs) { if ((await verify(t, await offline.run(t))).ok) after++; }
    console.log('\n離線自己解決（不問任何模型）：開始前 ' + base + '/' + probs.length + ' → 教完後 ' + after + '/' + probs.length + '；原本就會 ' + st.offline + '、老師教會 ' + st.taught + '、教不會 ' + st.unresolved + '、退回的課 ' + st.rejected + '、老師被問 ' + st.teacherCalls + ' 次；內建的課 ' + lessons.length + ' 堂');
    if (has('write') && !arg('only')) {
        const out = path.join(REPO, 'renderer/src/uml/py_lessons_builtin.js'); const data = lessons.map((l) => ({ id: l.id, algo: l.algo, shape: l.shape, nparams: l.nparams, roles: l.roles, paradigms: l.paradigms, body: l.body, prelude: l.prelude, cnl: l.cnl, createdBy: l.createdBy, note: l.note }));
        fs.writeFileSync(out, "/* 內建的課（lesson）：老師（Claude）教、判題器（含隱藏測資）驗證、對先前會的題做過回歸才收的做法。由 scripts/teach-builtin-lessons.js 產生，不要手改。\n * 離線時 py_uml_pipeline_core.buildFromUML 直接套用（同一種算法 + 同樣的輸入形狀），不問任何模型。 */\n(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPyLessonsBuiltin = factory(); })(typeof self !== 'undefined' ? self : this, function () {\n    'use strict';\n    return { generatedAt: " + JSON.stringify(new Date().toISOString().slice(0, 10)) + ', verified: ' + JSON.stringify({ tasks: probs.length, offlineAfter: after, offlineBefore: base }) + ', lessons: ' + JSON.stringify(data) + ' };\n});\n'); console.log('已寫入 ' + path.relative(REPO, out));
    }
    process.exit(after === probs.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
