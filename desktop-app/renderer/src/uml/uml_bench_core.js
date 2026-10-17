/* UML 拆解題（UMD，純函式＋注入的 generate）：評估一個語言模型「把情境拆成極小的 UML 單元」的能力。設計見 DESIGN.unit-catalog.md 第三十二節。
 * 這是弱模型走 CoLU 路線（計畫 → UML 拆成極小單元 → 接線）最依賴的能力，所以直接用真正的拆解流程（uml_core.scenarioToModel，強制走模型、不讓程式讀情境代勞）
 * 一次一個封閉的小問題（參與者與使用案例 → 類別 → 每個類別的成員 → 關係 → 每個使用案例的呼叫順序），每個回覆由程式驗證，不合格退回重來。
 * 固定幾個情境，每個情境的「該有的東西」由人事先寫好（參與者、類別、使用案例的關鍵字，同義詞都算），評分全由程式判定：
 *   完成率、驗證通過率、各階段第一次就合格的比例、最終合格的比例（含退回重來）、該有的參與者／類別／使用案例找到幾成、使用案例呼叫順序有沒有 2 步以上、退化（空白、重複）。
 * 建議（uml）：self（第一次就合格的比例高，可以自己走 UML 拆解）／stepwise（要靠退回重來，用一次一小題的流程，不要整份一次生成）／program_first（連退回重來都撐不住，UML 由程式先讀情境、用片段種子，模型只補程式讀不出的）／unknown。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./uml_core.js'));
    else root.FaUmlBench = factory(root.FaUml || (typeof FaUml !== 'undefined' ? FaUml : undefined));
})(typeof self !== 'undefined' ? self : this, function (U) {
    'use strict';
    const DEFAULTS = { n: 3, maxTries: 2, selfFirstTry: 0.75, stepwiseEventual: 0.8, minRecall: 0.6, minCompletion: 0.8, minCalls: 5 };
    // 每個情境該有的東西：同義詞（英文名稱）與中文關鍵字，只要其中一個出現就算找到
    const FIXTURES = [
        { id: 'shop', scenario: '網路商店：顧客可以瀏覽商品、加入購物車、結帳。管理員可以上架商品。',
          actors: [['customer', 'user', 'buyer', 'client', 'member', '顧客'], ['admin', 'manager', 'staff', 'seller', 'merchant', '管理']], classes: [['product', 'item', 'goods', 'commodity'], ['cart', 'basket'], ['order', 'checkout']],
          usecases: [['browse', 'view', 'list', 'search', '瀏覽'], ['cart', 'basket', '購物車'], ['checkout', 'pay', 'order', '結帳'], ['publish', 'list', 'add', 'create', 'manage', 'upload', '上架']] },
        { id: 'library', scenario: '圖書館：學生可以借書、還書。館員可以新增書籍、查詢借閱紀錄。',
          actors: [['student', 'member', 'user', 'reader', 'borrower', '學生'], ['librarian', 'admin', 'staff', 'clerk', '館員']], classes: [['book'], ['loan', 'borrow', 'lend', 'checkout', 'record', 'transaction']],
          usecases: [['borrow', 'checkout', 'loan', 'lend', '借書'], ['return', '還書'], ['add', 'create', 'register', '新增'], ['query', 'search', 'view', 'list', 'history', '查詢']] },
        { id: 'member', scenario: '會員系統：使用者可以註冊、登入、修改個人資料。',
          actors: [['user', 'member', 'customer', '使用者']], classes: [['user', 'account', 'member', 'profile']],
          usecases: [['register', 'signup', 'sign up', '註冊'], ['login', 'sign in', 'signin', 'auth', '登入'], ['update', 'edit', 'modify', 'change', 'profile', '修改', '個人資料']] },
        { id: 'booking', scenario: '課程預約：會員可以預約課程、取消預約。教練可以建立課程。',
          actors: [['member', 'user', 'customer', 'student', '會員'], ['coach', 'trainer', 'instructor', 'teacher', 'admin', '教練']], classes: [['course', 'class', 'lesson', 'session'], ['reservation', 'booking', 'appointment']],
          usecases: [['reserve', 'book', 'appointment', '預約'], ['cancel', '取消'], ['create', 'add', 'publish', 'open', '建立']] },
        { id: 'clinic', scenario: '診所掛號：病人可以掛號、查看病歷。醫生可以開立處方。',
          actors: [['patient', 'user', 'customer', '病人'], ['doctor', 'physician', '醫生']], classes: [['appointment', 'registration', 'booking', 'visit'], ['record', 'chart', 'history', 'medical', '病歷'], ['prescription', 'medicine', 'drug', '處方']],
          usecases: [['register', 'appointment', 'book', '掛號'], ['view', 'record', 'history', 'chart', '查看', '病歷'], ['prescribe', 'prescription', 'issue', '處方', '開立']] },
    ];
    const low = (s) => String(s || '').toLowerCase();
    const hit = (alts, names) => alts.some((a) => names.some((n) => low(n).includes(low(a))));
    const frac = (ok, n) => ({ ok, n, rate: n ? Math.round((ok / n) * 100) / 100 : null });
    const mean = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null);
    const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

    // 評分一個跑完的模型（該有的東西找到幾成、順序有沒有 2 步、驗證）
    function gradeModel(fx, model) {
        const actorNames = model.actors || [], classNames = (model.classes || []).map((c) => c.name + ' ' + (c.label || '')); const ucNames = (model.usecases || []).map((u) => u.name + ' ' + (u.summary || ''));
        const r = (groups, names) => (groups.length ? groups.filter((g) => hit(g, names)).length / groups.length : 1);
        const ucs = model.usecases || []; return { actors: r(fx.actors, actorNames.concat(ucs.map((u) => u.actor))), classes: r(fx.classes, classNames), usecases: r(fx.usecases, ucNames), sequences: ucs.length ? ucs.filter((u) => (u.steps || []).length >= 2).length / ucs.length : 0 };
    }
    // 包一層 generate：記次數、耗時、失敗、退化（呼叫端給的 generate 要回傳字串，或丟錯誤）
    function wrapGenerate(generate, stats, degenerate) {
        return async (req) => {
            const t0 = Date.now(); stats.calls++; let text;
            try { text = await generate(req); } catch (e) { stats.failed++; stats.errors.push(String((e && e.message) || e).slice(0, 160)); stats.ms.push(Date.now() - t0); throw e; }
            stats.ms.push(Date.now() - t0); const t = String(text == null ? '' : text); const d = degenerate ? degenerate({ content: t }) : ''; if (d) { stats.degenerate++; if (!stats.degenerateKinds.includes(d)) stats.degenerateKinds.push(d); } return t;
        };
    }
    // 跑一個情境；回傳這個情境的結果列
    async function runScenario(fx, generate, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {}); const stats = { calls: 0, failed: 0, degenerate: 0, degenerateKinds: [], errors: [], ms: [] };
        let res; try { res = await U.scenarioToModel(fx.scenario, { generate: wrapGenerate(generate, stats, o.degenerate), program: false, maxTries: o.maxTries }); } catch (e) { res = { ok: false, error: String((e && e.message) || e), model: U.emptyModel ? U.emptyModel() : { actors: [], classes: [], usecases: [] }, decisions: [], warnings: [], errors: [] }; }
        const dec = (res.decisions || []).filter((d) => d.by === 'model'); const g = gradeModel(fx, res.model || {});
        return { id: fx.id, completed: !!res.ok, valid: !!res.ok && !(res.errors && res.errors.length), error: res.ok ? '' : res.error, stages: dec.map((d) => ({ stage: d.stage, label: d.label, ok: !!d.ok, tries: d.tries, rejected: (d.rejected || []).slice(0, 2).map((x) => (x.errors || []).join('；').slice(0, 120)) })),
            firstTry: dec.filter((d) => d.ok && d.tries === 1).length, eventual: dec.filter((d) => d.ok).length, stageN: dec.length, recall: g, warnings: (res.warnings || []).length, stats };
    }
    // 整理成模型的 UML 能力
    function summarize(rows, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {}); const stageN = rows.reduce((a, r) => a + r.stageN, 0); const calls = rows.reduce((a, r) => a + r.stats.calls, 0); const failed = rows.reduce((a, r) => a + r.stats.failed, 0);
        const completion = frac(rows.filter((r) => r.completed).length, rows.length), valid = frac(rows.filter((r) => r.valid).length, rows.length);
        const firstTry = frac(rows.reduce((a, r) => a + r.firstTry, 0), stageN), eventual = frac(rows.reduce((a, r) => a + r.eventual, 0), stageN);
        const done = rows.filter((r) => r.completed); const recall = { actors: mean(done.map((r) => r.recall.actors)), classes: mean(done.map((r) => r.recall.classes)), usecases: mean(done.map((r) => r.recall.usecases)), sequences: mean(done.map((r) => r.recall.sequences)) };
        const rc = [recall.actors, recall.classes, recall.usecases].filter((x) => x != null); const recallAvg = rc.length ? mean(rc) : null;
        const degN = rows.reduce((a, r) => a + r.stats.degenerate, 0); const degKinds = Array.from(new Set([].concat(...rows.map((r) => r.stats.degenerateKinds))));
        const byStage = {}; for (const r of rows) for (const s of r.stages) { const b = byStage[s.stage] = byStage[s.stage] || { ok: 0, first: 0, n: 0 }; b.n++; if (s.ok) b.ok++; if (s.ok && s.tries === 1) b.first++; }
        const worst = Object.entries(byStage).filter(([, b]) => b.n >= 2).sort((a, b) => (a[1].first / a[1].n) - (b[1].first / b[1].n))[0];
        const notes = []; let advice, why;
        if (calls < o.minCalls) { advice = 'unknown'; why = '能用的回應太少（只呼叫成功 ' + (calls - failed) + ' 次）' + (failed ? '，' + failed + ' 次呼叫失敗：' + Array.from(new Set(rows.flatMap((r) => r.stats.errors))).slice(0, 2).join('；') : '') + '，判斷不了'; }
        else if (completion.rate >= o.minCompletion && firstTry.rate >= o.selfFirstTry && recallAvg != null && recallAvg >= o.minRecall) { advice = 'self'; why = '各階段第一次就合格 ' + firstTry.ok + '/' + firstTry.n + '，該有的東西找到約 ' + Math.round(recallAvg * 100) + '%，可以自己走 UML 拆解（仍然用一次一小題）'; }
        else if (eventual.rate >= o.stepwiseEventual && completion.rate >= 0.6) { advice = 'stepwise'; why = '第一次合格只有 ' + firstTry.ok + '/' + firstTry.n + '，但退回重來之後有 ' + eventual.ok + '/' + eventual.n + '：用一次一小題＋退回重來的流程，不要整份一次生成'; }
        else { advice = 'program_first'; why = '連退回重來之後也只有 ' + eventual.ok + '/' + eventual.n + '、完成 ' + completion.ok + '/' + completion.n + '：UML 由程式先讀情境、用片段當種子，模型只補程式讀不出的部分'; }
        if (worst && advice !== 'unknown' && worst[1].first / worst[1].n < 0.5) notes.push('最容易出錯的階段：' + worst[0] + '（第一次合格 ' + worst[1].first + '/' + worst[1].n + '）');
        const rej = [].concat(...rows.map((r) => [].concat(...r.stages.map((s) => s.rejected)))).filter(Boolean); if (rej.length && advice !== 'self' && advice !== 'unknown') notes.push('常見被退回的原因：' + Array.from(new Set(rej)).slice(0, 2).join('｜'));
        if (degN) notes.push('退化 ' + degN + '/' + calls + ' 次（' + degKinds.join('、') + '）'); if (failed) notes.push(failed + ' 次呼叫失敗，沒算進階段成功率');
        if (recall.sequences != null && recall.sequences < 0.7 && advice !== 'unknown') notes.push('使用案例的呼叫順序常常少於 2 步（' + Math.round(recall.sequences * 100) + '% 達標）');
        if (rows.length < 5) notes.push('只測了 ' + rows.length + ' 個情境，只是粗略估計');
        return { completion, valid, firstTry, eventual, recall, recall_avg: recallAvg, degenerate: frac(degN, calls), calls, failed_calls: failed, median_ms: median([].concat(...rows.map((r) => r.stats.ms))), by_stage: byStage, advice, reason: why, notes };
    }
    const ADVICE_LABEL = { self: '可以自己拆', stepwise: '一次一小題＋退回重來', program_first: '程式先讀情境、模型只補', unknown: '資料不足' };
    function toText(model, p) {
        const f = (x) => (x.n ? x.ok + '/' + x.n : '—'); const pc = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
        return '🧩 UML 拆解題：' + model + '\n・完成：' + f(p.completion) + '　驗證通過：' + f(p.valid) + '\n・各階段第一次就合格：' + f(p.firstTry) + '　含退回重來：' + f(p.eventual) + '\n・該有的東西找到：參與者 ' + pc(p.recall.actors) + '、類別 ' + pc(p.recall.classes) + '、使用案例 ' + pc(p.recall.usecases) + '\n・呼叫 ' + p.calls + ' 次，中位耗時 ' + (p.median_ms != null ? p.median_ms + ' ms' : '—') + '\n\n建議：' + ADVICE_LABEL[p.advice] + '\n' + p.reason + (p.notes.length ? '\n\n' + p.notes.map((x) => '・' + x).join('\n') : '');
    }
    function hintFor(advice) {
        if (advice === 'program_first') return '【UML 輔助】你自己拆 UML 不穩定。需要設計系統、拆解需求或寫程式骨架時，不要自己一次寫完整份 UML：先呼叫 uml_guide 讓程式讀情境、用卡片逐步跟使用者確認，再依它的結果往下做。';
        if (advice === 'stepwise') return '【UML 輔助】你拆 UML 時第一次常常不合格。需要設計系統時，不要整份一次寫完：用 uml_design 或 uml_guide 一次處理一小塊（參與者、類別、成員、關係、呼叫順序），每塊檢查過再做下一塊。';
        return '';
    }
    return { DEFAULTS, FIXTURES, gradeModel, wrapGenerate, runScenario, summarize, toText, hintFor, ADVICE_LABEL };
});
