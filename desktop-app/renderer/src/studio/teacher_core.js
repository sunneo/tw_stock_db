/* 訓練工作室老師迴圈核心（UMD，純邏輯＋依賴注入）。設計 §6、§15.2。線上 AI 當「老師」擴充資料集（不是直接改模型）。
 * 鐵則全部由程式強制，不靠提示：
 *   1. 每筆資料經程式驗證（verifyRow）才收，記 verified_by 與證據；驗證不了的種類／環境一律拒收並說明（不收「模型說對」）。
 *   2. 只收 split:'train'；標 heldout／holdout 的列、以及與留出題內容相同的列都拒收；老師看不到留出題的內容（list／read 過濾，eval 只給通過率）。
 *   3. 每列記 author:'teacher'、來源（工具、工作階段、模型）、時間、驗證證據；使用者可逐筆拒絕（reject）。
 *   4. 不自動開始訓練：這裡只產生資料集（commit 才寫進資產 data/teacher.jsonl）；訓練是另一個動作。
 *   5. 單次擴充上限：maxRows（筆）、maxChars（總字元，當 token 的保守代理）、maxRounds（輪）。
 *   缺口驅動：先 gap_report → 讓老師針對弱項補 → 每輪後重評量（trial 試算）→ 沒改善就回報、回滾這一輪、不再繼續灌。
 *   隱私：送給線上 AI 的只有資料集條目（train 的簡述）與評量摘要；preview() 先回「會送什麼」，使用者確認（confirmed＋hash 相符）才送。
 * createTeacher(d)，d：{ now, Eval(eval_core), kinds: { [kind]: { verifyRow(row, ctx) → {ok, verified_by, evidence, problems?} | Promise, key(row) → 去重鍵, brief(row) } },
 *    evaluate(kind) → eval_core 結果, trial(kind, rows) → eval_core 結果 | null（把 rows 當作已加入試算，不改任何東西）, ai({system, prompt, tools, maxRounds}) → {text}|null,
 *    loadExisting(kind, name) → {train:[rows], heldout:[rows]}, hash(str) } */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioTeacher = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const LIMITS = { maxRows: 30, maxChars: 60000, maxRounds: 3 };
    const TOOLS = ['studio_dataset_list', 'studio_dataset_read', 'studio_dataset_add', 'studio_dataset_remove', 'studio_dataset_verify', 'studio_dataset_eval', 'studio_gap_report'];
    const SYSTEM = '你是離線訓練工作室的「老師」。你的工作是替資料集補充訓練資料，不是直接改模型。規則（程式會強制，違反的資料會被拒收）：\n1) 先呼叫 studio_gap_report 看弱項，只針對弱項補資料。\n2) 每筆資料用 studio_dataset_add 加入；程式會驗證，驗證沒過的不收，請依回傳的原因修正後再加。\n3) 只能加訓練資料（split:"train"）；看不到也不得猜測留出（heldout）題的內容。\n4) 補完用 studio_dataset_eval 看有沒有改善；沒改善就停止並回報，不要繼續灌資料。\n5) 不要開始訓練，不要要求使用者的檔案內容。\n最後回覆一行 JSON：{"status":"done|no_improvement|blocked","added":數字,"summary":"一句話"}。';
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
    const size = (o) => { try { return JSON.stringify(o).length; } catch (_) { return 0; } };

    function createTeacher(d) {
        const now = () => (d.now ? d.now() : Date.now()); let seq = 0;
        const sessions = new Map();
        const view = (s) => ({ id: s.id, kind: s.kind, goal: s.goal, target: s.target, state: s.state, limits: s.limits, rounds: s.rounds, items: s.items.map((x) => ({ id: x.id, status: x.status, brief: x.brief, verified_by: x.verified_by, round: x.round, at: x.at, reason: x.reason })), counts: counts(s), report: s.report || null, log: s.log.slice(-40), preview: s.preview ? { hash: s.preview.hash, prompt: s.preview.prompt, tools: s.preview.tools, bytes: s.preview.bytes } : null });
        const counts = (s) => { const c = { accepted: 0, rejected_by_user: 0, rolled_back: 0, refused: s.refused.length }; s.items.forEach((x) => { c[x.status] = (c[x.status] || 0) + 1; }); return c; };
        const logS = (s, t) => { s.log.push({ at: now(), text: t }); if (s.log.length > 300) s.log.shift(); };
        const activeRows = (s) => s.items.filter((x) => x.status === 'accepted');
        const chars = (s) => s.items.filter((x) => x.status === 'accepted').reduce((n, x) => n + size(x.row), 0);

        async function plan(o) {
            o = o || {}; const kind = String(o.kind || ''); const K = d.kinds && d.kinds[kind];
            if (!K) return { ok: false, error: kind + ' 沒有老師可用的驗證器：' + ((d.whyNot && d.whyNot(kind)) || '這個種類的資料（採用／退回標註、離線訓練器的成功案例）由使用者的實際使用產生，老師不能代做標註；解除條件：改用 blockly／matrix／uml／lora') };
            if (!d.ai) return { ok: false, error: '沒有線上 AI 可用（需要設定 AI 模型並離開離線模式）；老師迴圈只在有線上 AI 時能跑。解除條件：在設定→AI 加一個線上模型' };
            const goal = String(o.goal || '').trim(); const limits = Object.assign({}, LIMITS, o.limits || {}); limits.maxRows = Math.max(1, Math.min(200, Math.floor(limits.maxRows))); limits.maxRounds = Math.max(1, Math.min(8, Math.floor(limits.maxRounds)));
            const existing = d.loadExisting ? await d.loadExisting(kind, o.fromAsset) : { train: [], heldout: [] };
            const s = { id: 't' + (++seq) + '_' + now().toString(36), kind, goal: goal || '補強弱項', target: String(o.target || ''), fromAsset: o.fromAsset || '', state: 'planned', limits, rounds: [], items: [], refused: [], log: [], existing, heldoutKeys: new Set((existing.heldout || []).map((r) => K.key(r))), trainKeys: new Set((existing.train || []).map((r) => K.key(r))), created: now() };
            const before = await d.evaluate(kind); s.before = before;
            s.gap = gapOf(before, s); sessions.set(s.id, s);
            s.preview = buildPreview(s, K); logS(s, '建立工作階段；弱項 ' + s.gap.weak.length + ' 組'); return { ok: true, session: view(s) };
        }
        function gapOf(res, s) {
            const tv = d.Eval.teacherView(res); const weak = tv.groups.filter((g) => g.ran && !g.passedGate).map((g) => ({ group: g.group, rate: g.rate, gate: g.gate, heldout: !!g.heldout, gap: Math.round(((g.gate || 0) - g.rate) * 1000) / 1000 })).sort((a, b) => b.gap - a.gap);
            const notRun = tv.groups.filter((g) => !g.ran).map((g) => ({ group: g.group, why: g.unavailable }));
            return { weak, notRun, releaseOk: tv.summary.releaseOk };
        }
        function buildPreview(s, K) {
            const brief = (s.existing.train || []).slice(0, 40).map((r) => K.brief(r));
            const payload = { goal: s.goal, kind: s.kind, limits: s.limits, gap: s.gap, existing_train_rows: brief, existing_train_total: (s.existing.train || []).length, heldout: '（不送出，老師不可見）' };
            const prompt = '目標：' + s.goal + '\n種類：' + s.kind + '\n單次上限：最多新增 ' + s.limits.maxRows + ' 筆、 ' + s.limits.maxRounds + ' 輪。\n以下是目前評量缺口與資料集摘要（不含使用者檔案內容、不含留出題）：\n' + JSON.stringify(payload, null, 1);
            return { prompt, payload, tools: TOOLS.slice(), bytes: prompt.length, hash: d.hash ? d.hash(prompt) : String(prompt.length) };
        }

        // ---- 白名單工具（綁在 session 上；每個回傳純資料）----
        function makeTools(s) {
            const K = d.kinds[s.kind]; const refuse = (row, why) => { s.refused.push({ at: now(), why, brief: clip(JSON.stringify(row), 120) }); return { ok: false, error: why }; };
            const addOne = async (row, round, dry) => {
                if (!row || typeof row !== 'object') return refuse(row, '不是物件');
                const sp = row.split == null ? 'train' : String(row.split); if (sp !== 'train') return refuse(row, 'split 只能是 train（收到 ' + sp + '）；留出題不可教');
                const key = K.key(row); if (s.heldoutKeys.has(key)) return refuse(row, '內容與留出題相同，不收（不得用留出題教）');
                if (s.trainKeys.has(key) || activeRows(s).some((x) => x.key === key)) return refuse(row, '資料集裡已經有相同內容');
                if (!dry && activeRows(s).length >= s.limits.maxRows) return refuse(row, '已達單次擴充上限（' + s.limits.maxRows + ' 筆）');
                if (!dry && chars(s) + size(row) > s.limits.maxChars) return refuse(row, '已達單次擴充大小上限（' + s.limits.maxChars + ' 字元）');
                let v; try { v = await K.verifyRow(row, { session: s }); } catch (e) { v = { ok: false, problems: ['驗證器出錯：' + String((e && e.message) || e)] }; }
                if (!v || !v.ok) return refuse(row, '程式驗證沒過：' + ((v && v.problems && v.problems.join('；')) || (v && v.reason) || '未知原因'));
                if (dry) return { ok: true, dry: true, verified_by: v.verified_by, evidence: v.evidence };
                const item = { id: 'r' + (s.items.length + 1), key, status: 'accepted', round, at: now(), author: 'teacher', source: { tool: 'studio_dataset_add', session: s.id, model: s.model || null }, verified_by: v.verified_by, evidence: v.evidence, brief: K.brief(row), row: Object.assign({}, row, { split: 'train', meta: Object.assign({}, row.meta, { author: 'teacher', source_session: s.id, verified_by: v.verified_by }) }) };
                s.items.push(item); return { ok: true, id: item.id, verified_by: v.verified_by };
            };
            const T = {
                studio_dataset_list: { description: '列出目前資料集的訓練列摘要（不含留出題）與這次已新增的列', parameters: { type: 'object', properties: {} }, call: async () => ({ ok: true, train_total: (s.existing.train || []).length, existing: (s.existing.train || []).slice(0, 60).map((r, i) => ({ i, brief: K.brief(r) })), added: activeRows(s).map((x) => ({ id: x.id, brief: x.brief })), limits: s.limits, remaining: s.limits.maxRows - activeRows(s).length }) },
                studio_dataset_read: { description: '讀一列（existing 的索引 i，或這次新增的 id）；留出題讀不到', parameters: { type: 'object', properties: { i: { type: 'number' }, id: { type: 'string' } } }, call: async (a) => { a = a || {}; if (a.id) { const x = s.items.find((q) => q.id === a.id && q.status === 'accepted'); return x ? { ok: true, row: x.row } : { ok: false, error: '沒有這筆' }; } const r = (s.existing.train || [])[Number(a.i)]; return r ? { ok: true, row: r } : { ok: false, error: '沒有這筆（或是留出題，不可見）' }; } },
                studio_dataset_add: { description: '新增訓練資料列（rows 陣列）。每列都會被程式驗證，沒過的回原因', parameters: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } } }, required: ['rows'] }, call: async (a) => { const rows = Array.isArray(a && a.rows) ? a.rows : []; const out = []; for (const r of rows.slice(0, 50)) out.push(await addOne(r, s.rounds.length, false)); return { ok: true, results: out, accepted: out.filter((x) => x.ok).length, total_added: activeRows(s).length, remaining: s.limits.maxRows - activeRows(s).length }; } },
                studio_dataset_remove: { description: '移除這次自己新增的某一列（id）', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, call: async (a) => { const x = s.items.find((q) => q.id === (a && a.id) && q.status === 'accepted'); if (!x) return { ok: false, error: '只能移除這次新增且仍有效的列' }; x.status = 'rolled_back'; x.reason = '老師自己移除'; return { ok: true }; } },
                studio_dataset_verify: { description: '只驗證不加入（dry run）', parameters: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } } }, required: ['rows'] }, call: async (a) => { const rows = Array.isArray(a && a.rows) ? a.rows : []; const out = []; for (const r of rows.slice(0, 20)) out.push(await addOne(r, 0, true)); return { ok: true, results: out }; } },
                studio_dataset_eval: { description: '重新評量（含這次新增的列試算）；留出組只給通過率', parameters: { type: 'object', properties: {} }, call: async () => { const r = await trialEval(s); return r.ok ? { ok: true, mode: r.mode, result: d.Eval.teacherView(r.after), improvement: r.improvement } : r; } },
                studio_gap_report: { description: '目前評量弱項（低於上線門檻的組，由缺口大到小）', parameters: { type: 'object', properties: {} }, call: async () => ({ ok: true, gap: s.gap }) }
            };
            return T;
        }
        // 試算：有 trial 就把新增列當作已加入再評量；沒有就用「離線重做通過」的列數當唯一依據並明說
        async function trialEval(s) {
            const rows = activeRows(s).map((x) => x.row); const before = s.before;
            if (d.trial) { const after = await d.trial(s.kind, rows); if (after) { const imp = d.Eval.improvement(before, after); return { ok: true, mode: 'trial', after, improvement: imp }; } }
            const after = await d.evaluate(s.kind); const imp = d.Eval.improvement(before, after);
            return { ok: true, mode: d.trial ? 'trial_unavailable' : 'no_trial', after, improvement: Object.assign({ note: '這個種類沒有「試算」接口：加資料不訓練，評量分數不會變。改善以「新增的列都通過程式驗證（含離線自己重做）」為準，實際分數要使用者訓練後再評量。' }, imp) };
        }

        async function run(id, o) {
            o = o || {}; const s = sessions.get(id); if (!s) return { ok: false, error: '沒有這個老師工作階段' };
            if (s.state === 'running') return { ok: false, error: '已在執行' };
            if (!o.confirmed || o.previewHash !== s.preview.hash) return { ok: false, needsConfirm: true, error: '送給線上 AI 前要先確認：請檢視「會送出的內容」後以 confirmed:true＋previewHash 再呼叫', preview: view(s).preview };
            s.state = 'running'; s.stop = false; const K = d.kinds[s.kind]; const tools = makeTools(s); s.model = o.model || null;
            try {
                for (let round = 1; round <= s.limits.maxRounds && !s.stop; round++) {
                    const beforeCount = activeRows(s).length; const r = { n: round, startedAt: now(), added: 0 }; s.rounds.push(r);
                    const prompt = round === 1 ? s.preview.prompt : s.preview.prompt + '\n（第 ' + round + ' 輪：上一輪後的缺口）\n' + JSON.stringify(s.gap) + '\n目前已新增 ' + beforeCount + ' 筆。';
                    let ai; try { ai = await d.ai({ system: SYSTEM, prompt, tools, maxRounds: o.aiRounds || 12 }); } catch (e) { ai = null; r.error = String((e && e.message) || e); }
                    if (!ai) { r.stopped = 'AI 沒有回應：' + (r.error || '未知'); logS(s, r.stopped); s.state = 'blocked'; break; }
                    r.text = clip(ai.text, 400); r.added = activeRows(s).length - beforeCount; logS(s, '第 ' + round + ' 輪新增 ' + r.added + ' 筆');
                    if (!r.added) { r.stopped = '這一輪沒有任何一筆通過驗證，停止'; s.state = 'no_improvement'; break; }
                    const t = await trialEval(s); r.eval = { mode: t.mode, improvement: t.improvement }; s.after = t.after;
                    s.gap = gapOf(t.after, s);
                    if (t.mode === 'trial' && !t.improvement.improved) {
                        // 試算沒改善：回滾這一輪新增的列，回報，不繼續灌
                        s.items.filter((x) => x.round === round && x.status === 'accepted').forEach((x) => { x.status = 'rolled_back'; x.reason = '試算沒有改善（' + t.improvement.better + ' 組變好、' + t.improvement.worse + ' 組變差）'; });
                        r.stopped = '試算沒有改善，已回滾這一輪並停止'; s.state = 'no_improvement'; break;
                    }
                    if (!s.gap.weak.length) { s.state = 'done'; r.stopped = '已沒有低於門檻的弱項'; break; }
                    if (activeRows(s).length >= s.limits.maxRows) { s.state = 'done'; r.stopped = '已達單次擴充上限'; break; }
                }
                if (s.state === 'running') s.state = s.stop ? 'stopped' : 'done';
            } catch (e) { s.state = 'error'; logS(s, '出錯：' + String((e && e.message) || e)); }
            s.report = { state: s.state, added: activeRows(s).length, rolledBack: s.items.filter((x) => x.status === 'rolled_back').length, refused: s.refused.length, refusedSamples: s.refused.slice(-5), rounds: s.rounds.map((r) => ({ n: r.n, added: r.added, stopped: r.stopped, mode: r.eval && r.eval.mode })), note: '資料尚未寫入資產、也沒有開始訓練。逐筆檢視後按「寫入資產」（commit）；訓練是另一個動作。', gapLeft: s.gap.weak.length };
            return { ok: true, session: view(s) };
        }
        function reject(id, itemId, reason) { const s = sessions.get(id); if (!s) return { ok: false, error: '沒有這個老師工作階段' }; const x = s.items.find((q) => q.id === itemId); if (!x) return { ok: false, error: '沒有這一筆' }; if (x.status !== 'accepted') return { ok: false, error: '這筆已是 ' + x.status }; x.status = 'rejected_by_user'; x.reason = String(reason || '使用者拒絕'); return { ok: true, counts: counts(s) }; }
        function stop(id) { const s = sessions.get(id); if (!s) return { ok: false, error: '沒有這個老師工作階段' }; s.stop = true; return { ok: true }; }
        // 取出可寫入資產的列（只含 accepted）
        function rowsToCommit(id) { const s = sessions.get(id); return s ? activeRows(s).map((x) => ({ id: x.id, author: 'teacher', source: x.source, at: x.at, verified_by: x.verified_by, evidence: x.evidence, row: x.row })) : null; }
        return { plan, run, reject, stop, view: (id) => (sessions.has(id) ? view(sessions.get(id)) : null), list: () => Array.from(sessions.values()).map(view), rowsToCommit, makeTools: (id) => (sessions.has(id) ? makeTools(sessions.get(id)) : null), sessions, SYSTEM, TOOLS, LIMITS };
    }
    return { createTeacher, TOOLS, SYSTEM, LIMITS };
});
