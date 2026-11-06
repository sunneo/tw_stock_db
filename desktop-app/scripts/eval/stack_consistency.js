'use strict';
// 思考堆疊的「兄弟一致性」實測：同一批情境、同一個真模型，跑「沒有堆疊／有堆疊（焦點標頭）／有堆疊＋往下前列檢查」三種，
// 用 uml_bench_core.siblingConsistency（純程式評分：命名風格、成員風格、參照存在、不重複）加上完成率、第一次合格率、呼叫次數比較。
//   node scripts/eval/stack_consistency.js --url http://127.0.0.1:18099/v1/chat/completions [--reps 2] [--tries 4] [--temp 0.7] [--fixtures shop,library] [--variants off,stack,checks] [--out f.json]
// 模型服務：任何 OpenAI 相容的聊天服務（llama.cpp server、這個 repo 旁的 mini_server 也行）；沒給 --url 就只印用法。
const B = require('../../renderer/src/uml/uml_bench_core.js'); const U = require('../../renderer/src/uml/uml_core.js');
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const url = opt('url'); if (!url) { console.log('用法：node scripts/eval/stack_consistency.js --url <OpenAI 相容的 chat/completions> [--reps 2] [--tries 4] [--temp 0.7] [--fixtures shop,library] [--variants off,stack,checks] [--out f.json]'); process.exit(0); }
const tries = +opt('tries', 4), reps = +opt('reps', 2), temp = +opt('temp', 0.7), outFile = opt('out');
const fxIds = (opt('fixtures', '') || '').split(',').filter(Boolean); const fixtures = fxIds.length ? B.FIXTURES.filter((f) => fxIds.includes(f.id)) : B.FIXTURES;
const VARIANTS = { off: { thinkStack: false }, stack: { thinkStack: true, stackChecks: false }, checks: { thinkStack: true, stackChecks: true } };
const variants = (opt('variants', 'off,stack,checks')).split(',').filter((v) => VARIANTS[v]);

function post(req) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: req.messages, max_tokens: req.maxTokens || 600, temperature: temp, chat_template_kwargs: { enable_thinking: !!req.enableThinking } }) })
        .then((r) => (r.ok ? r.json() : r.text().then((t) => { throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 100)); }))).then((j) => (j.choices[0].message.content || ''));
}
// 小模型（0.6b）連「識別字要英文 PascalCase」都做不到（實測：參與者與使用案例階段四次都被退回，完成率 0），所以「兄弟一致性」要在它能走到的階段量：
// 參與者／類別兩個階段由程式讀情境回答（就是 DESIGN 的 program_first 建議），類別成員、關係、呼叫順序（兄弟最多、最容易前後不一）交給真模型。--seed none 全交給模型。
const seed = opt('seed', 'fixture'); // fixture＝用 uml_bench_core 的人工答案（各情境的第一個英文名）；program＝程式讀情境（有些情境讀不出來）；none＝全交給模型
function makeGen(fx) {
    const pas = (w) => String(w).replace(/(^|[\s_-])([a-z])/g, (_, __, c) => c.toUpperCase()).replace(/[\s_-]/g, '');
    const ref = seed === 'fixture' ? { actors: fx.actors.map((g) => pas(g[0])), classes: fx.classes.map((g) => ({ name: pas(g[0]), kind: 'class', label: pas(g[0]) })), usecases: fx.usecases.map((g, i, a) => ({ name: pas(g[0]), actor: pas(fx.actors[Math.min(fx.actors.length - 1, Math.floor((i * fx.actors.length) / a.length))][0]), summary: g[g.length - 1] })) } : U.scenarioHints(fx.scenario);
    return async (req) => {
        const t = req.messages.map((m) => m.content).join('\n');
        if (seed === 'program' || seed === 'fixture') {
            if (/找出參與者/.test(t)) return JSON.stringify({ actors: ref.actors, usecases: ref.usecases.map((u) => ({ name: u.name, actor: u.actor, summary: u.summary })) });
            if (/找出系統需要的類別/.test(t)) return JSON.stringify({ classes: ref.classes.map((c) => ({ name: c.name, kind: c.kind || 'class', label: c.label || c.name })) });
        }
        return post(req);
    };
}
const avg = (a) => { a = a.filter((x) => x != null); return a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null; };

(async () => {
    const rows = []; const t0 = Date.now();
    for (const fx of fixtures) for (let rep = 0; rep < reps; rep++) for (const v of variants) {
        const t1 = Date.now(); let r; try { r = await B.runScenario(fx, makeGen(fx), Object.assign({ maxTries: tries }, VARIANTS[v])); } catch (e) { r = { id: fx.id, completed: false, error: String(e.message || e), consistency: {}, recall: {}, stats: { calls: 0 }, firstTry: 0, stageN: 0 }; }
        const row = { fixture: fx.id, rep, variant: v, completed: r.completed, valid: r.valid, firstTry: r.firstTry, stageN: r.stageN, calls: r.stats.calls, consistency: r.consistency, recall: r.recall, sec: Math.round((Date.now() - t1) / 1000), error: r.error };
        rows.push(row); console.log([fx.id, 'r' + rep, v.padEnd(6), r.completed ? 'done' : 'FAIL', 'score=' + (row.consistency.score == null ? '—' : row.consistency.score), 'refs=' + row.consistency.refs, 'first=' + r.firstTry + '/' + r.stageN, 'calls=' + r.stats.calls, row.sec + 's'].join('  '));
    }
    const summary = variants.map((v) => { const rs = rows.filter((r) => r.variant === v); const done = rs.filter((r) => r.completed); return { variant: v, runs: rs.length, completed: done.length, score: avg(done.map((r) => r.consistency.score)), naming: avg(done.map((r) => r.consistency.naming)), style: avg(done.map((r) => r.consistency.style)), refs: avg(done.map((r) => r.consistency.refs)), unique: avg(done.map((r) => r.consistency.unique)), firstTryRate: rs.reduce((a, r) => a + r.stageN, 0) ? Math.round((rs.reduce((a, r) => a + r.firstTry, 0) / rs.reduce((a, r) => a + r.stageN, 0)) * 100) / 100 : null, calls: avg(rs.map((r) => r.calls)), sec: avg(rs.map((r) => r.sec)) }; });
    console.log('\n變體       跑  完成  一致性  命名  風格  參照  不重複  一次合格  呼叫  秒');
    for (const s of summary) console.log([s.variant.padEnd(8), String(s.runs).padStart(3), String(s.completed).padStart(4), String(s.score).padStart(6), String(s.naming).padStart(5), String(s.style).padStart(5), String(s.refs).padStart(5), String(s.unique).padStart(6), String(s.firstTryRate).padStart(8), String(s.calls).padStart(5), String(s.sec).padStart(4)].join('  '));
    console.log('總耗時 ' + Math.round((Date.now() - t0) / 1000) + ' 秒；溫度 ' + temp + '；每格 ' + reps + ' 次');
    if (outFile) require('fs').writeFileSync(outFile, JSON.stringify({ temp, reps, summary, rows }, null, 1));
})();
