/* 訓練工作室：領域規格的評量（UMD，依賴注入，不碰 DOM／網路／檔案）。設計 §16.4。
 * domainSuites(spec, deps) → eval_core.runEval 吃的 suites：
 *   domain/<id>/train        每個 train 題各算一題：離線 AI（blockly）或矩陣層（matrix）能不能解出、通過隱藏測資
 *   domain/<id>/holdout      holdout 題（heldout:true，只給組別通過率，不給逐題內容；老師看不到、不能教）
 *   domain/<id>/不搶內建題    讀題規則是否搶走內建題（需要 deps.corpus；沒給就寫缺什麼）
 * deps（選填，缺了就在該組寫具體原因與解除條件）：
 *   runtime            domain_runtime_core 的實例（評量前把規格載入 FaDomains／FaMatrixSynth；載入失敗就整組回原因）
 *   solve({statement, tests, hidden, checker, eps}) → async {ok, verdict, paradigm, tried, reason}   blockly：離線 AI 解一題（不給課、0 次模型）
 *   runRef(src, input) → async {ok, out}                                                              blockly：判題沙盒執行參考解（算答案）
 *   Synth              FaMatrixSynth（要有 synth／register）；Expr 受限運算式；Spec domain_spec_core
 *   judge({lang, source, problem}) → async {verdict}   矩陣層內建合成器解出的程式用它驗證隱藏範例（沒有就標「未驗證」）
 *   corpus             [{id, statement}] 內建題敘述（檢查讀題規則是否搶題） */
(function (root, factory) {
    const S = (typeof module === 'object' && module.exports) ? require('./domain_spec_core.js') : root.FaStudioDomainSpec;
    const X = (typeof module === 'object' && module.exports) ? require('./dsl_expr_core.js') : root.FaStudioExpr;
    if (typeof module === 'object' && module.exports) module.exports = factory(S, X);
    else root.FaStudioDomainEval = factory(S, X);
})(typeof self !== 'undefined' ? self : this, function (Spec, Expr) {
    'use strict';
    const NO_SOLVE = '需要離線 AI 的解題入口與判題器：桌面版並開啟「允許 AI 執行程式」（判題器會叫 Python 子行程；解題要 tree-sitter）；網頁版沒有 Python 子行程，改在桌面版評量';
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };

    async function runMatrixTask(spec, t, d) {
        const ex = t.examples || [], hid = t.hidden || [];
        if (!hid.length) return { ok: false, verdict: 'NO_HIDDEN', reason: '沒有隱藏範例，無法驗證' };
        const r = await d.Synth.synth({ statement: t.statement, examples: ex });
        if (!r.ok) return { ok: false, verdict: 'NOT_FITTED', reason: clip(r.reason, 200) };
        const by = (r.matrixForm && r.matrixForm.name) || r.kind || '?';
        if (r.userOp) { // 使用者操作：同一份受限運算式重算隱藏範例，不需要判題器
            const op = (spec.ops || []).find((o) => o.id === r.userOp.op); const cands = [r].concat(r.alternatives || []); let chosen = null;
            for (const c of cands) { if (hid.every((h) => { const q = Spec.replay(op, c.userOp.assignment, h.in, d.Expr || Expr); return q.ok && q.out.trim() === String(h.out).trim(); })) { chosen = c; break; } }
            if (!chosen) return { ok: false, verdict: 'WA', by, reason: '擬合出的參數對不上隱藏範例（' + cands.length + ' 個候選都不過）' };
            return { ok: true, verdict: 'AC', by, verified: true, ambiguous: false, desc: chosen.desc, candidates: cands.length };
        }
        if (!d.judge) return { ok: false, verdict: 'UNCHECKED', by, verified: false, reason: '內建合成器解出（' + by + '），但沒有判題器驗證隱藏範例，不算通過；解除條件：桌面版並開啟「允許 AI 執行程式」，或把這個操作的 order 調小讓使用者操作先試' };
        const j = await d.judge({ lang: 'python', source: r.source + '\nmain()\n', problem: { id: 'dom', tests: ex, hidden: hid, checker: 'tokens' } });
        return { ok: j.verdict === 'AC', verdict: j.verdict, by, verified: j.verdict === 'AC' && !r.ambiguous, reason: j.verdict === 'AC' ? '' : clip(j.detail, 120) };
    }
    async function runBlocklyTask(spec, t, d) {
        const r = await d.solve({ statement: t.statement, tests: t.tests || [], hidden: t.hidden || [], checker: (spec.judge && spec.judge.checker) || 'tokens', eps: spec.judge && spec.judge.eps });
        if (!r) return { ok: false, verdict: 'NO_RESULT', reason: '解題入口沒有回傳' };
        const ac = !!r.ok && (!r.verdict || r.verdict === 'AC' || r.verdict === 'UNCHECKED');
        const wantOk = !t.want || (r.paradigm && (r.paradigm === t.want || String(r.paradigm).includes(t.want)));
        return { ok: ac && wantOk, verdict: ac ? (wantOk ? 'AC' : 'WRONG_PARADIGM') : (r.verdict || 'FAIL'), by: r.paradigm || r.by || '', tried: r.tried, reason: ac ? (wantOk ? '' : '解出了但不是靠這個領域的範式（' + r.paradigm + '）') : clip(r.reason, 200) };
    }
    // 取得所有題目（blockly 家族需要參考解算答案；算過的快取在 deps.cache）
    async function loadTasks(spec, d) {
        if (d.cache && d.cache.tasks && d.cache.hash === Spec.hash(Spec.normalize(spec))) return d.cache;
        let res; if (spec.kind === 'blockly') res = await Spec.buildTasks(spec, { runRef: d.runRef, tests: 4, hidden: 2 }); else res = await Spec.buildTasks(spec, {});
        const c = { hash: Spec.hash(Spec.normalize(spec)), tasks: res.tasks, problems: res.problems }; if (d.cache) Object.assign(d.cache, c); return c;
    }
    function domainSuites(spec, d) {
        d = d || {}; const out = []; const id = spec.id;
        const why = (() => {
            const v = Spec.validate(spec); if (!v.ok) return '規格沒通過驗證：' + v.errors.slice(0, 3).join('；');
            if (spec.kind === 'blockly' && (!d.solve || !d.runRef)) return NO_SOLVE;
            if (spec.kind === 'matrix' && !d.Synth) return '沒有載入 matrix_synth_core'; return '';
        })();
        for (const split of ['train', 'holdout']) {
            out.push({ group: 'domain/' + id + '/' + split, heldout: split === 'holdout', note: split === 'holdout' ? '留出題：只給組別通過率，不給逐題內容；老師不能看、不能教' : '訓練題：離線自己解，不給課、不問模型', unavailable: why || undefined,
                run: async () => {
                    if (d.runtime) { const l = await d.runtime.ensure(spec); if (!l.ok) return { unavailable: '領域載入失敗：' + l.error }; }
                    const c = await loadTasks(spec, d); const tasks = c.tasks.filter((t) => t.split === split);
                    if (!tasks.length) return { unavailable: (c.problems.length ? '題目產生失敗：' + c.problems.map((p) => p.family + '：' + p.error).join('；') : '這個領域沒有 ' + split + ' 題') + '。解除條件：補題目或修正參考解' };
                    const rows = []; let pass = 0;
                    for (const t of tasks) { let r; try { r = spec.kind === 'matrix' ? await runMatrixTask(spec, t, d) : await runBlocklyTask(spec, t, d); } catch (e) { r = { ok: false, verdict: 'ERROR', reason: String((e && e.message) || e) }; } if (r.ok) pass++; rows.push({ id: t.id, ok: r.ok, verdict: r.verdict, by: r.by, verified: r.verified, reason: r.reason }); }
                    return { n: tasks.length, pass, detail: split === 'holdout' ? undefined : rows };
                } });
        }
        out.push({ group: 'domain/' + id + '/不搶內建題', note: '讀題規則不可以把內建題的敘述搶過來（領域詞彙優先於通用詞彙）', unavailable: !d.corpus || !d.corpus.length ? '需要內建題敘述語料（deps.corpus）：App 內由內建課與種子題敘述提供；解除條件：接上語料' : (spec.kind !== 'blockly' ? '只有 blockly 領域有讀題規則' : undefined),
            run: async () => { const hit = collisions(spec, d.corpus); return { n: d.corpus.length, pass: d.corpus.length - hit.length, detail: hit.slice(0, 20) }; } });
        return out;
    }
    // 哪些語料的敘述會被這個領域的讀題規則搶走（排除這個領域自己的題）
    function collisions(spec, corpus) {
        const own = new Set(); try { for (const f of spec.families || []) Spec.expandStatements(f).forEach((x) => own.add(x.statement)); for (const t of spec.tasks || []) own.add(t.statement); } catch (_) { /* */ }
        const algos = (spec.algos || []).map((a) => ({ key: a.key, re: Spec.algoRe(a), veto: (a.veto || []).length ? new RegExp(a.veto.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null }));
        const hit = []; for (const c of corpus || []) { if (own.has(c.statement)) continue; const a = algos.find((x) => x.re.test(c.statement) && !(x.veto && x.veto.test(c.statement))); if (a) hit.push({ id: c.id, algo: a.key, statement: clip(c.statement, 80) }); }
        return hit;
    }
    // 一次跑完回總結（給精靈的「預覽／評量」與端到端測試用，不經過 eval_core）
    async function runDomain(spec, d) {
        const res = { id: spec.id, kind: spec.kind, groups: {} };
        for (const s of domainSuites(spec, d)) { if (s.unavailable) { res.groups[s.group] = { unavailable: s.unavailable }; continue; } const r = await s.run(); res.groups[s.group] = r; }
        return res;
    }
    return { domainSuites, collisions, runDomain, runMatrixTask, runBlocklyTask, loadTasks, NO_SOLVE };
});
