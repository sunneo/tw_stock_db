/* 訓練工作室：五種符號式 kind（trainer／colu／uml／blockly／matrix）的「評量組」與「訓練包裝」（UMD，純邏輯＋依賴注入，不碰 DOM／網路）。設計 §8、§15.1、§15.3。
 * 評量：evalSuites(kind, deps) → eval_core.runEval 吃的 suites 陣列（每組 {group, run|unavailable, heldout?, recorded?}）。
 * 訓練：prepareTrain(kind, deps, opts) → { ok, units:[{label, run(ctx)}], finish(ctx) → {files, counts, extra}, note } 或 { ok:false, error }。
 *   units 是一小段一小段的工作，執行器（sym_train_core）在每段之間檢查暫停／停止；finish 把結果寫成資產檔。
 * deps（全部選填，缺了就在畫面寫具體原因與解除條件，不假裝做了）：
 *   UC, UmlBench              uml_core／uml_bench_core
 *   Rank, Feedback, rankUse    rank_train／feedback_core／排名特徵名稱清單；feedbackStore() → async store
 *   Synth                      matrix_synth_core（已 install 其他模組）
 *   judge({lang,source,problem}) → {verdict}   判題器（桌面版且允許執行程式才有）
 *   lessons                    FaPyLessonsBuiltin
 *   blocklyLearn(task) → async {ok,lesson?,reason?}   把一題「敘述＋解答＋判題條件」收成課（_pyLearnLesson，內含自己重做驗證）
 *   trainerDomains() → async 領域陣列；toolNames() → 現有工具名稱陣列；trainerDistill() → async {…}；trainerSnapshot() → async bundle
 *   rankModelSet(model) → async  （選填）把訓練出的排名模型寫成執行期使用的模型；沒給就只存成資產
 *   loraEvals() → async [{name, eval}]  帶評量結果的 LoRA 資產 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioSym = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const enc = (o) => new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o, null, 1));
    const jl = (rows) => enc(rows.map((x) => JSON.stringify(x)).join('\n'));
    const NO_JUDGE = '需要判題器：桌面版並在設定開啟「允許 AI 執行程式」（判題器會叫 Python 子行程）；網頁版沒有 Python 子行程，改在桌面版執行';
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };

    // ===== matrix 內建評量題（獨立手寫參考解，來源同 algo/matrix_synth.test.js 的題型）=====
    const lcg = (() => { let s = 20261111; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; }; })();
    const rint = (a, b) => a + (lcg() >> 8) % (b - a + 1); const rstr = (al, n) => Array.from({ length: n }, () => al[rint(0, al.length - 1)]).join('');
    const MATRIX_CASES = [
        { id: 'jacobsthal', lv: 'L1', st: 'F(0)=0，F(1)=1，F(n)=F(n-1)+2F(n-2)。輸入 n（0≤n≤60），輸出 F(n)。', gen: () => rint(0, 60) + '\n', ref: (i) => { let a = 0n, b = 1n; for (let k = 0; k < Number(i); k++) { const c = b + 2n * a; a = b; b = c; } return String(a); } },
        { id: 'contains-010', lv: 'L2', st: '輸入一個由 0、1 組成的字串（長度 1～30），若含有子字串 "010" 印 yes，否則印 no。', gen: () => rstr('01', rint(1, 20)) + '\n', ref: (s) => (s.includes('010') ? 'yes' : 'no') },
        { id: 'odd-b', lv: 'L2', st: '輸入一個由 a、b 組成的字串，若 b 出現奇數次印 yes，否則印 no。', gen: () => rstr('ab', rint(1, 25)) + '\n', ref: (s) => ((s.split('b').length - 1) % 2 ? 'yes' : 'no') },
        { id: 'starts-1', lv: 'L2', st: '輸入一個由 0、1 組成的字串，若以 1 開頭印 yes，否則印 no。', gen: () => rstr('01', rint(1, 20)) + '\n', ref: (s) => (s[0] === '1' ? 'yes' : 'no') },
        { id: 'no-000', lv: 'L2', st: '輸入一個由 0、1 組成的字串，若不含連續三個 0 印 yes，否則印 no。', gen: () => rstr('01', rint(1, 25)) + '\n', ref: (s) => (s.includes('000') ? 'no' : 'yes') },
        { id: 'median3', lv: 'L0', st: '輸入三個整數，輸出中位數', gen: () => [rint(1, 99), rint(1, 99), rint(1, 99)].join(' ') + '\n', ref: (s) => String(s.split(' ').map(Number).sort((a, b) => a - b)[1]) }
    ];
    function mkExamples(c, n) { const out = [], seen = new Set(); let guard = 0; while (out.length < n && guard++ < n * 50) { const i = c.gen(); if (seen.has(i)) continue; seen.add(i); out.push({ in: i, out: c.ref(i.trim()) + '\n' }); } return out; }
    async function synthAndJudge(S, judge, statement, fit, held) {
        const r = await S.synth({ statement, examples: fit }); if (!r.ok) return { ok: false, reason: r.reason };
        const problem = { id: 'sym', tests: fit, hidden: held, checker: 'tokens' }; const j = await judge({ lang: 'python', source: r.source + '\nmain()\n', problem });
        return { ok: j.verdict === 'AC', verdict: j.verdict, result: r, detail: j.detail };
    }

    // ===== 評量組 =====
    function evalSuites(kind, d) {
        d = d || {}; const U = [];
        if (kind === 'uml') {
            if (!d.UC || !d.UmlBench) return [{ group: 'uml/讀情境', unavailable: '沒有載入 uml_core／uml_bench_core（舊版嵌入）；更新到含這兩個模組的版本即可' }];
            const run = async (fixtures, field) => { let sum = 0, n = 0; const detail = []; for (const fx of fixtures) { const r = await d.UC.scenarioToModel(fx.scenario, {}); const sc = r.ok && r.model ? d.UmlBench.gradeModel(fx, r.model) : { actors: 0, classes: 0, usecases: 0, sequences: 0 }; sum += sc[field]; n++; detail.push({ id: fx.id, ok: !!r.ok, score: Math.round(sc[field] * 100) / 100 }); } return { n, pass: sum, detail }; };
            ['actors', 'classes', 'usecases', 'sequences'].forEach((f) => { U.push({ group: '情境→設計（程式先讀、不問模型）/小題/' + f, note: '5 個固定情境，程式讀情境直接產生設計，與標準詞彙比對命中率', run: () => run(d.UmlBench.FIXTURES, f) }); U.push({ group: '情境→設計（程式先讀、不問模型）/組合題/' + f, note: '3 個由小題拼成的大情境', run: () => run(d.UmlBench.BIG, f) }); });
            return U;
        }
        if (kind === 'colu') {
            const ready = async () => { const st = await d.feedbackStore(); const rows = d.Feedback.toRows(st); const s = d.Feedback.stats(st); return { rows, s }; };
            if (!d.Rank || !d.Feedback || !d.feedbackStore) U.push({ group: 'colu/排序命中率', unavailable: '沒有載入 rank_train／feedback_core' });
            else U.push({ group: 'colu/排序（留一組交叉驗證 F1）', run: async () => { const { rows, s } = await ready(); if (!s.ready_to_train) return { unavailable: '回饋資料不夠，交叉驗證會抖：' + s.missing.join('、') + '。解除條件：在探索計畫裡採用／退回推薦累積到門檻，或匯入別人的回饋資產' }; const cv = d.Rank.crossValidate(rows, { use: d.rankUse, l2: 0.5 }, 0.5); return { n: 100, pass: cv.f1, detail: { precision: cv.precision, recall: cv.recall, top1: cv.top1, top3: cv.top3 } }; } });
            U.push({ group: 'colu/內建模型體檢（已記錄，不重跑）', recorded: true, run: async () => { const ps = d.presetProfiles ? d.presetProfiles() : null; if (!ps) return { unavailable: '沒有接上內建模型狀態' }; return { n: ps.length, pass: ps.filter((p) => p.advice === 'self').length, detail: ps.map((p) => ({ model: p.model, advice: p.advice })) }; } });
            return U;
        }
        if (kind === 'trainer') {
            if (!d.trainerDomains) return [{ group: 'trainer/規則自檢', unavailable: '沒有接上離線訓練器儲存（IndexedDB 的 domains 表）' }];
            return [{ group: 'trainer/規則自檢（規則可編譯、工具存在、信心值合法）', run: async () => {
                const ds = await d.trainerDomains(); const tools = new Set(d.toolNames ? d.toolNames() : []); let n = 0, pass = 0; const bad = [];
                for (const dom of ds) for (const p of dom.patterns || []) {
                    n++; let ok = true, why = ''; if (p.type === 'regex') { try { new RegExp(p.expr); } catch (e) { ok = false; why = '正規式不合法'; } }
                    if (ok && p.tool && tools.size && !tools.has(p.tool) && !(dom.tools || []).some((t) => t.name === p.tool)) { ok = false; why = '工具不存在：' + p.tool; }
                    if (ok && p.confidence != null && !(p.confidence >= 0 && p.confidence <= 1)) { ok = false; why = '信心值不在 0..1'; }
                    if (ok) pass++; else bad.push({ domain: dom.name, id: p.id, why });
                }
                return { n, pass, detail: { bad: bad.slice(0, 20) } }; } }];
        }
        if (kind === 'matrix') {
            return MATRIX_CASES.map((c) => ({ group: 'matrix/' + c.lv + '/' + c.id, note: '範例 2 筆擬合、隱藏 20 筆驗證；L4–L6 沒有內建題（只有窮舉，不保證）', unavailable: !d.Synth ? '沒有載入 matrix_synth_core' : (!d.judge ? NO_JUDGE : undefined),
                run: async () => { const fit = mkExamples(c, 2), held = mkExamples(c, 20); const r = await synthAndJudge(d.Synth, d.judge, c.st, fit, held); return { n: 1, pass: r.ok ? 1 : 0, detail: { verdict: r.verdict || '沒解出', reason: r.reason, desc: r.result && r.result.desc } }; } }));
        }
        if (kind === 'blockly') {
            const L = d.lessons; const v = L && L.verified;
            U.push({ group: 'blockly/內建課（建置時已驗證，不重跑）', recorded: true, run: async () => (v ? { n: v.tasks, pass: v.offlineAfter, detail: { before: v.offlineBefore, generatedAt: L.generatedAt } } : { unavailable: '內建課沒有驗證記錄' }) });
            U.push({ group: 'blockly/領域包種子題（需 tree-sitter＋判題器，題目在測試檔）', unavailable: '種子題只寫在 uml/domain_*.test.js（打包不含），執行還需要 tree-sitter 與 Python 判題器。解除條件：在原始碼倉庫跑 node renderer/src/uml/domain_*.test.js；或把題目存成資產 data/tasks.jsonl 後在這裡跑「使用者題目」組' });
            return U;
        }
        if (kind === 'lora') return [{ group: 'lora/資產評量結果', run: async () => { const l = d.loraEvals ? await d.loraEvals() : []; if (!l.length) return { unavailable: '沒有任何帶評量結果的 LoRA 資產；評量由 lora-train/eval_run.py 產生並寫入資產 manifest.eval，解除條件：先完成一次 LoRA 訓練並匯入結果' }; let n = 0, pass = 0; l.forEach((x) => { const e = x.eval || {}; if (typeof e.n === 'number' && typeof e.pass === 'number') { n += e.n; pass += e.pass; } }); return n ? { n, pass } : { unavailable: 'LoRA 資產的 eval 欄位沒有 n／pass 數字' }; } }];
        return [{ group: kind, unavailable: '未知的種類' }];
    }
    // 使用者資產裡的題目也可以成為評量組（data/tasks.jsonl：blockly 要 {id,statement,solution,tests}；matrix 要 {id,statement,examples}）
    function taskSuites(kind, tasks, d) {
        d = d || {};
        if (kind === 'matrix') return tasks.map((t) => ({ group: 'matrix/使用者題/' + t.id, unavailable: !d.Synth ? '沒有載入 matrix_synth_core' : (!d.judge ? NO_JUDGE : (!t.examples || t.examples.length < 3 ? '至少要 3 筆範例（2 筆擬合、其餘當隱藏驗證）' : undefined)),
            run: async () => { const fit = t.examples.slice(0, 2), held = t.examples.slice(2); const r = await synthAndJudge(d.Synth, d.judge, t.statement, fit, held); return { n: 1, pass: r.ok ? 1 : 0, detail: { verdict: r.verdict || '沒解出', reason: r.reason } }; } }));
        return [];
    }

    // ===== 訓練包裝 =====
    async function prepareTrain(kind, d, opts) {
        d = d || {}; opts = opts || {};
        if (kind === 'colu') {
            if (!d.Rank || !d.Feedback || !d.feedbackStore) return { ok: false, error: 'colu 訓練需要 rank_train／feedback_core（舊版嵌入沒有）；更新後即可' };
            const st = await d.feedbackStore(); const rows = d.Feedback.toRows(st); const s = d.Feedback.stats(st);
            if (!rows.length) return { ok: false, error: '還沒有可以訓練的回饋（要有特徵的採用／退回紀錄）。解除條件：在探索計畫採用或退回推薦累積資料，或匯入別人的回饋資產' };
            if (!s.ready_to_train && !opts.force) return { ok: false, error: '回饋資料還沒到門檻（' + s.missing.join('、') + '），訓練出的模型不可信。要仍然訓練請勾「資料不足也訓練」（force），結果只當參考' };
            const l2s = [0.05, 0.5, 2], tries = []; const units = l2s.map((l2) => ({ label: '留一組交叉驗證 l2=' + l2, run: async () => { const cv = d.Rank.crossValidate(rows, { use: d.rankUse, l2 }, 0.5); tries.push({ l2, f1: cv.f1, precision: cv.precision, recall: cv.recall, top1: cv.top1 }); } }));
            let model = null; units.push({ label: '用全部資料訓練最後的模型', run: async () => { const best = tries.slice().sort((a, b) => b.f1 - a.f1)[0]; model = d.Rank.fit(rows, { use: d.rankUse, l2: best.l2 }); model.trained_at = (d.now ? d.now() : Date.now()); model.report = { tries, best }; } });
            return { ok: true, units, note: '訓練產物存成資產；不會自動換掉目前使用中的排名模型（要換請匯出後用 catalog_feedback 的 train+save，或按「套用」）。', finish: async () => ({ files: { 'data/rank-model.json': enc(model), 'data/feedback-rows.jsonl': jl(rows.map((r) => ({ group: r.group, id: r.id, y: r.y, w: r.w }))), 'README.txt': enc('CoLU 排名模型（邏輯迴歸）。訓練 ' + rows.length + ' 列、' + s.groups + ' 組。交叉驗證：' + JSON.stringify(tries)) }, counts: { rows: rows.length, groups: s.groups, tries: tries.length }, eval: { n: 100, pass: Math.max.apply(null, tries.map((t) => t.f1)), kind: 'cv_f1', tries }, extra: { rank_model: model } }) };
        }
        if (kind === 'trainer') {
            if (!d.trainerDistill || !d.trainerSnapshot) return { ok: false, error: 'trainer 訓練需要離線訓練器的整理（蒸餾）接口，這個環境沒有接上' };
            let before = null, res = null, after = null;
            return { ok: true, note: '蒸餾＝把重複出現 ≥3 次的成功做法升格成技能；使用者改過的不覆蓋。開始前自動拍一份快照（資產 -before），結果不滿意可套用回去。', units: [
                { label: '拍整理前快照', run: async () => { before = await d.trainerSnapshot(); } },
                { label: '蒸餾成功案例成技能', run: async () => { res = await d.trainerDistill(opts); if (res && res.ok === false) throw new Error(res.error || '整理失敗'); } },
                { label: '拍整理後快照', run: async () => { after = await d.trainerSnapshot(); } }],
            finish: async () => ({ bundleBefore: before, bundleAfter: after, counts: { turns: res && res.turns || 0, proposals: res && res.proposals || 0, adopted: res && res.adopted || 0, updated: res && res.updated || 0 }, extra: { distill: res } }) };
        }
        if (kind === 'uml') {
            if (!d.UC) return { ok: false, error: '沒有載入 uml_core' };
            const pairs = opts.pairs || []; if (!pairs.length) return { ok: false, error: 'uml 訓練要情境與設計對：資產 data/pairs.jsonl 的每列 {scenario, model}（model 要能通過 uml_core.validateModel）。解除條件：在資料集匯入一份，或選一個含 data/pairs.jsonl 的資產' };
            const ok = [], bad = [], vocab = { actors: {}, nouns: {}, verbs: {} };
            const units = pairs.map((p, i) => ({ label: '驗證第 ' + (i + 1) + ' 對', run: async () => {
                let errs; try { const v = d.UC.validateModel(p.model); errs = Array.isArray(v) ? v : (v && v.errors) || (v && v.ok === false ? [v.reason || '不合法'] : []); } catch (e) { errs = ['結構不合法：' + String((e && e.message) || e)]; }
                if (errs.length) { bad.push({ i, errors: errs.slice(0, 3) }); return; } ok.push(p);
                (p.model.actors || []).forEach((a) => { vocab.actors[a] = (vocab.actors[a] || 0) + 1; }); (p.model.classes || []).forEach((c) => { vocab.nouns[c.name] = (vocab.nouns[c.name] || 0) + 1; });
            } }));
            return { ok: true, units, note: '產物是「詞彙補強」資產（通過結構驗證的設計對＋新出現的 actor／類別名）。uml 的詞彙表與模板寫在 uml_core.js 的常數裡，執行期不能直接改；阻礙：常數表沒有「執行期擴充」接口。解除條件：把資產匯出後由開發者合併進原始碼表（或日後在 uml_core 加 extend() 接口）。', finish: async () => ({ files: { 'data/pairs.jsonl': jl(ok), 'data/vocab.json': enc(vocab), 'data/rejected.json': enc(bad), 'README.txt': enc('UML 詞彙補強：通過結構驗證 ' + ok.length + ' 對，拒收 ' + bad.length + ' 對。') }, counts: { accepted: ok.length, rejected: bad.length }, eval: { n: pairs.length, pass: ok.length, kind: 'structure_valid' } }) };
        }
        if (kind === 'blockly') {
            const tasks = opts.tasks || []; if (!tasks.length) return { ok: false, error: 'blockly 訓練要題目：資產 data/tasks.jsonl 的每列 {id, statement, solution（Python 解答）, tests:[{in,out}]}。解除條件：在資料集匯入題目，或選含 data/tasks.jsonl 的資產' };
            if (!d.blocklyLearn) return { ok: false, error: 'blockly 訓練需要 tree-sitter 解析器與判題器（桌面版並開啟「允許 AI 執行程式」）；' + NO_JUDGE };
            const got = [], miss = [];
            const units = tasks.map((t, i) => ({ label: (t.id || ('第 ' + (i + 1) + ' 題')) + '：窮舉＋判題收成課', run: async () => { const r = await d.blocklyLearn(t); if (r && r.ok) got.push({ id: t.id, lesson: r.lesson }); else miss.push({ id: t.id, reason: r && r.reason }); } }));
            return { ok: true, units, note: '每題：解答抽成課，只靠這堂課重做一次並通過判題（含隱藏測資）才收；不通過的不收。收下的課同時存進執行期課庫。', finish: async () => ({ files: { 'data/lessons.jsonl': jl(got.map((x) => x.lesson)), 'data/missed.json': enc(miss), 'README.txt': enc('積木課程：' + got.length + '／' + tasks.length + ' 題收成課。') }, counts: { lessons: got.length, missed: miss.length }, eval: { n: tasks.length, pass: got.length, kind: 'learned' } }) };
        }
        if (kind === 'matrix') {
            const tasks = opts.tasks || []; if (!tasks.length) return { ok: false, error: 'matrix 訓練要輸入輸出範例：資產 data/tasks.jsonl 的每列 {id, statement, examples:[{in,out}]}（至少 3 筆：2 筆擬合、其餘隱藏驗證）' };
            if (!d.Synth) return { ok: false, error: '沒有載入 matrix_synth_core' };
            const progs = [], miss = [];
            const units = tasks.map((t, i) => ({ label: (t.id || ('第 ' + (i + 1) + ' 題')) + '：範式擬合', run: async () => {
                const ex = t.examples || []; if (ex.length < 2) { miss.push({ id: t.id, reason: '範例不足' }); return; }
                const fit = ex.slice(0, 2), held = ex.slice(2);
                if (held.length && d.judge) { const r = await synthAndJudge(d.Synth, d.judge, t.statement, fit, held); if (r.ok) progs.push({ id: t.id, level: r.result.level, kind: r.result.kind, source: r.result.source, desc: r.result.desc, verified: true, heldout: held.length }); else miss.push({ id: t.id, reason: r.reason || ('隱藏驗證 ' + r.verdict) }); }
                else { const r = await d.Synth.synth({ statement: t.statement, examples: ex }); if (r.ok) progs.push({ id: t.id, level: r.level, kind: r.kind, source: r.source, desc: r.desc, verified: false, heldout: 0 }); else miss.push({ id: t.id, reason: r.reason }); }
            } }));
            return { ok: true, units, note: 'L0–L3 有真演算法（公式／遞推／自動機／圖與格子）；L4–L6 只有窮舉，不保證。' + (d.judge ? '' : '目前沒有判題器，產物標「未用隱藏測資驗證」。'), finish: async () => ({ files: { 'data/programs.jsonl': jl(progs), 'data/missed.json': enc(miss), 'README.txt': enc('矩陣層擬合：' + progs.length + '／' + tasks.length + ' 題擬合成功。L4–L6 不保證。') }, counts: { fitted: progs.length, missed: miss.length, verified: progs.filter((p) => p.verified).length }, eval: { n: tasks.length, pass: progs.length, kind: 'fitted' } }) };
        }
        return { ok: false, error: '不支援的種類：' + kind };
    }
    // ===== 老師迴圈的驗證器（teacher_core 用）：程式驗證才收 =====
    const keyOf = (s) => { s = String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) + ':' + s.length; };
    function teacherKinds(d) {
        d = d || {}; const K = {};
        K.blockly = { key: (r) => keyOf(r.statement), brief: (r) => clip(r.statement, 80), async verifyRow(r) {
            if (!r.statement || !r.solution || !Array.isArray(r.tests) || r.tests.length < 2) return { ok: false, problems: ['blockly 列要有 statement、solution（Python）、tests（至少 2 筆 {in,out}）'] };
            if (!d.judge) return { ok: false, problems: [NO_JUDGE] };
            const j = await d.judge({ lang: 'python', source: String(r.solution).replace(/\n?main\(\)\s*$/, '') + '\nmain()\n', problem: { id: 'teacher', tests: r.tests.slice(0, 2), hidden: r.tests.slice(2), checker: 'tokens' } });
            return j.verdict === 'AC' ? { ok: true, verified_by: 'judge', evidence: { verdict: 'AC', tests: r.tests.length } } : { ok: false, problems: ['判題器結果 ' + j.verdict + (j.detail ? '：' + clip(j.detail, 120) : '')] }; } };
        K.matrix = { key: (r) => keyOf(r.statement), brief: (r) => clip(r.statement, 80), async verifyRow(r) {
            if (!r.statement || !Array.isArray(r.examples) || r.examples.length < 3) return { ok: false, problems: ['matrix 列要有 statement 與至少 3 筆 examples（2 筆擬合、其餘隱藏驗證）'] };
            if (!d.Synth) return { ok: false, problems: ['沒有載入 matrix_synth_core'] }; if (!d.judge) return { ok: false, problems: [NO_JUDGE] };
            const v = await synthAndJudge(d.Synth, d.judge, r.statement, r.examples.slice(0, 2), r.examples.slice(2));
            return v.ok ? { ok: true, verified_by: 'synth+judge（離線自己重做通過）', evidence: { level: v.result.level, desc: v.result.desc, heldout: r.examples.length - 2 } } : { ok: false, problems: ['離線矩陣層自己重做沒過：' + (v.reason || v.verdict)] }; } };
        K.uml = { key: (r) => keyOf(r.scenario), brief: (r) => clip(r.scenario, 80), async verifyRow(r) {
            if (!r.scenario || !r.model) return { ok: false, problems: ['uml 列要有 scenario 與 model'] }; if (!d.UC) return { ok: false, problems: ['沒有載入 uml_core'] };
            let errs; try { const v = d.UC.validateModel(r.model); errs = Array.isArray(v) ? v : (v && v.errors) || (v && v.ok === false ? [v.reason || '不合法'] : []); } catch (e) { errs = ['結構不合法：' + String((e && e.message) || e)]; }
            return errs.length ? { ok: false, problems: errs.slice(0, 4) } : { ok: true, verified_by: 'uml_core.validateModel', evidence: { classes: (r.model.classes || []).length, usecases: (r.model.usecases || []).length } }; } };
        K.lora = { key: (r) => keyOf(JSON.stringify(r.messages || r.prompt || r)), brief: (r) => clip((r.messages && r.messages[0] && r.messages[0].content) || r.prompt || JSON.stringify(r), 80), async verifyRow(r) {
            const cid = r.meta && r.meta.chunk_id; const chunk = cid && d.ingestChunk ? d.ingestChunk(cid) : null;
            if (!chunk) return { ok: false, problems: ['lora 資料要有語料塊依據：meta.chunk_id 必須是已匯入的語料塊（答案要逐字出自語料，不收「模型說對」）'] };
            if (!d.cleanValidateRow) return { ok: false, problems: ['沒有載入 clean_core'] };
            const pr = d.cleanValidateRow(Object.assign({ verified_by: 'rejection_sampling' }, r)); if (pr && pr.length) return { ok: false, problems: pr.slice(0, 4) };
            const vt = d.verifyTeacherSample ? d.verifyTeacherSample(Object.assign({ verified_by: 'rejection_sampling' }, r), chunk, {}) : { ok: true };
            return vt.ok ? { ok: true, verified_by: 'schema+chunk_grounded', evidence: { chunk_id: cid } } : { ok: false, problems: vt.problems || ['語料依據檢查沒過'] }; } };
        return K;
    }
    return { evalSuites, taskSuites, prepareTrain, teacherKinds, MATRIX_CASES, NO_JUDGE };
});
