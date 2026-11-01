/* 弱模型 harness 的封閉題迴圈（純函式，沒有檔案與模型呼叫；命令列與測試都用它）。
 *
 * 原則（跟專案的 CoLU 一致）：程式先決定能決定的（路由、列舉值、唯一數字、預設退路）；
 * 模型每次只收到一題封閉題（字母或固定欄位）；回答一律由程式核對，不合格附精確原因退回，最多 MAX_TRIES 次，
 * 仍不合格就用程式的預設退路，並記下 by:'default'。判定（verdict）完全由程式依紀錄算出，不看模型自述。
 *
 * 狀態是一個純 JSON 物件（SESSION_VERSION），可存檔、可續跑。
 */
(function (root, factory) {
    let R = null;
    const tryReq = (p) => { try { return require(p); } catch (_) { return null; } };
    if (typeof require === 'function') R = tryReq('./vendor/recipe_core.js') || tryReq('../../../renderer/src/recipe/recipe_core.js');
    if (!R && root && root.FaRecipe) R = root.FaRecipe;
    if (typeof module === 'object' && module.exports) module.exports = factory(R);
    else root.FaWeakLoop = factory(R);
})(typeof self !== 'undefined' ? self : this, function (R) {
    'use strict';
    if (!R) throw new Error('找不到 recipe_core（FaRecipe）');

    const SESSION_VERSION = 1, MAX_TRIES = 2;
    const letter = (i) => String.fromCharCode(65 + i);

    // ---------- 路由：關鍵字命中數 → autoPick；差距不夠才出路由題 ----------
    // hints：回流的經驗 [{ task, template }]；任務文字跟學過的相似（字元二連詞的相似度）就算命中。這是學習層真正改變路由的地方
    function bigrams(s) { s = String(s || '').toLowerCase().replace(/s+/g, '').replace(/d+/g, '#'); const out = new Set(); for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2)); return out; }
    function similarity(a, b) { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / (A.size + B.size - n); }
    const HINT_MIN = 0.4;
    function routeCands(templates, text, hints) {
        const low = String(text || '').toLowerCase();
        return templates.map((t) => {
            const hits = (t.keywords || []).filter((k) => low.includes(String(k).toLowerCase())).length;
            let score = hits ? Math.min(1, 0.4 + hits * 0.2) : 0, learned = 0;
            for (const h of hints || []) if (h.template === t.id) { const sim = similarity(text, h.task); if (sim >= HINT_MIN) learned = Math.max(learned, sim); }
            if (learned) score = Math.min(1, Math.max(score, 0.5 + learned * 0.5));
            return { tool: t.id, intent: t.label, score, hits, learned };
        }).sort((a, b) => b.score - a.score);
    }

    function createSession(templates, text, opts) {
        opts = opts || {};
        const s = { v: SESSION_VERSION, id: opts.id || ('hs_' + Date.now().toString(36)), task: String(text || '').slice(0, 600), templates: null, template: null,
            step: 0, slots: {}, steps: [], pending: { tries: 0, error: '' }, state: 'running', verdict: null, result: '', numbers: (String(text || '').match(/\d+(?:\.\d+)?/g) || []) };
        const cands = routeCands(templates, text, opts.hints);
        const pick = R.autoPick(cands.filter((c) => c.score > 0));
        if (pick) { s.template = templates.find((t) => t.id === cands[pick.index].tool); s.steps.push({ id: 'route', kind: 'route', by: 'program', tries: 0, ok: true, answer: s.template.id, learned: !!cands[pick.index].learned }); }
        else s.route = { options: templates.map((t) => ({ key: t.id, label: t.label })).concat([{ key: 'none', label: '以上都不是' }]) };
        s.library = templates;
        advanceByProgram(s);
        return s;
    }

        function questions(s) { return s.template ? s.template.questions : []; }

    // 能由程式決定的題目直接決定（唯一命中的選項、唯一的列舉值、唯一的數字）
    function advanceByProgram(s) {
        while (s.state === 'running' && s.template) {
            const qs = questions(s);
            if (s.step >= qs.length) { finish(s); return; }
            const q = qs[s.step];
            if (q.kind === 'choose') {
                const low = s.task.toLowerCase();
                const hit = q.options.filter((o) => (o.match || []).some((m) => low.includes(String(m).toLowerCase())));
                if (hit.length === 1) { s.slots[q.id] = hit[0].key; s.steps.push({ id: q.id, kind: 'choose', by: 'program', tries: 0, ok: true, answer: hit[0].key }); s.step++; continue; }
                return;
            }
            const filled = programFields(q.fields, s);
            for (const k of Object.keys(filled)) s.slots[k] = filled[k];
            const left = q.fields.filter((f) => !(f.name in filled));
            if (!left.length) { s.steps.push({ id: q.id, kind: 'fill', by: 'program', tries: 0, ok: true, answer: JSON.stringify(filled) }); s.step++; continue; }
            return;
        }
    }

    function programFields(fields, s) {
        const out = {}, low = s.task.toLowerCase();
        for (const f of fields) {
            if (f.enum) { const hit = f.enum.filter((e) => low.includes(String(e).toLowerCase())); if (hit.length === 1) out[f.name] = hit[0]; }
        }
        const numeric = fields.filter((f) => (f.type === 'integer' || f.type === 'number') && !(f.name in out));
        if (numeric.length === 1 && s.numbers.length === 1) { const v = Number(s.numbers[0]); if (!(numeric[0].min != null && v < numeric[0].min) && !(numeric[0].max != null && v > numeric[0].max)) out[numeric[0].name] = v; }
        return out;
    }

    // ---------- 目前這一題（給模型看的文字） ----------
    function currentQuestion(s) {
        if (s.state !== 'running') return null;
        if (!s.template) {
            return { id: 'route', kind: 'choose', options: s.route.options, text: '使用者的話：' + s.task + '\n這件事屬於哪一類？\n' + s.route.options.map((o, i) => letter(i) + '. ' + o.label).join('\n') + '\n只回答一個字母。' + errNote(s) };
        }
        const q = questions(s)[s.step]; const total = questions(s).length;
        if (q.kind === 'choose') return { id: q.id, kind: 'choose', options: q.options, text: '使用者的話：' + s.task + '\n' + q.prompt + '\n' + q.options.map((o, i) => letter(i) + '. ' + o.label).join('\n') + '\n只回答一個字母。' + errNote(s) };
        const left = q.fields.filter((f) => !(f.name in s.slots));
        const lines = left.map((f) => '- ' + f.name + '（' + typeText(f) + '）：' + (f.description || ''));
        return { id: q.id, kind: 'fill', fields: left, text: '使用者的話：' + s.task + '\n' + q.prompt + '\n要填的欄位：\n' + lines.join('\n') + '\n只回答一個 JSON 物件，鍵只能是上面列出的欄位；沒提到的填 null。' + errNote(s) };
    }
    function errNote(s) { return s.pending.error ? '\n上一次回答不合格：' + s.pending.error : ''; }
    function typeText(f) { return f.enum ? '只能是：' + f.enum.join('、') : f.type === 'integer' ? '整數' : f.type === 'number' ? '數字' : f.type === 'boolean' ? 'true 或 false' : '字串'; }

    // ---------- 核對答案 ----------
    function parseLetter(text, n) {
        let t = String(text == null ? '' : text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        const j = R.parseJsonLoose(t); if (j && typeof j === 'object') { const c = j.choice != null ? j.choice : j.answer; if (c != null) t = String(c).trim(); }
        t = t.replace(/^["'「『（(\s]+/, '');
        const m = /^([A-Za-z])(?![A-Za-z])/.exec(t); if (!m) return -1;
        const i = m[1].toUpperCase().charCodeAt(0) - 65; return i >= 0 && i < n ? i : -1;
    }

    function submitAnswer(s, answerText) {
        if (s.state !== 'running') return { ok: false, error: '工作已經結束' };
        const q = currentQuestion(s); const qid = q.id; let accepted = false, value;
        if (q.kind === 'choose') {
            const i = parseLetter(answerText, q.options.length);
            if (i < 0) s.pending.error = '要回答 A 到 ' + letter(q.options.length - 1) + ' 其中一個字母（你回了「' + String(answerText).slice(0, 40) + '」）';
            else { accepted = true; value = q.options[i].key; }
        } else {
            const obj = R.parseJsonLoose(answerText);
            const errs = obj && typeof obj === 'object' && !Array.isArray(obj) ? R.validateFill(q.fields, s.numbers.map(Number))(obj) : ['不是合法的 JSON 物件'];
            if (errs.length) s.pending.error = errs.join('；'); else { accepted = true; value = obj; }
        }
        if (accepted) { record(s, qid, q.kind, 'model', s.pending.tries + 1, true, value); apply(s, q, value); return { ok: true, accepted: true, state: s.state }; }
        s.pending.tries++;
        if (s.pending.tries < MAX_TRIES) return { ok: true, accepted: false, retry: true, error: s.pending.error, state: s.state };
        // 程式預設退路
        const dv = defaultFor(s, q);
        record(s, qid, q.kind, 'default', s.pending.tries, false, dv);
        apply(s, q, dv);
        return { ok: true, accepted: false, retry: false, usedDefault: true, state: s.state };
    }

    function defaultFor(s, q) {
        if (q.kind === 'choose') return q.id === 'route' ? 'none' : (questions(s)[s.step].default || q.options[0].key);
        const o = {}; for (const f of q.fields) o[f.name] = null; return o;
    }
    function record(s, id, kind, by, tries, ok, value) { s.steps.push({ id, kind, by, tries, ok, answer: typeof value === 'string' ? value : JSON.stringify(value) }); }
    function apply(s, q, value) {
        s.pending = { tries: 0, error: '' };
        if (q.id === 'route' && !s.template) {
            // 範本表由命令列帶進來；這裡只記 key，下面 bindTemplate 再綁
            s.routeKey = value; if (value === 'none') { s.state = 'done'; s.verdict = 'failed'; s.result = ''; s.reason = '路由不到任何範本'; } else bindTemplate(s);
            return;
        }
        if (q.kind === 'choose') s.slots[q.id] = value; else for (const k of Object.keys(value)) if (value[k] !== null && value[k] !== undefined) s.slots[k] = value[k];
        s.step++; advanceByProgram(s);
    }
    function bindTemplate(s) {
        const templates = s.library || [];
        if (s.template || !s.routeKey || s.routeKey === 'none') return;
        s.template = templates.find((t) => t.id === s.routeKey) || null; if (s.template) { advanceByProgram(s); } else { s.state = 'done'; s.verdict = 'failed'; s.reason = '不認得的範本'; }
    }

    // ---------- 完成：程式組裝與判定 ----------
    function finish(s) {
        const t = s.template; const missing = [];
        for (const q of t.questions) if (q.kind === 'fill') for (const f of q.fields) if (f.required && (s.slots[f.name] == null || s.slots[f.name] === '')) missing.push(f.name);
        for (const q of t.questions) if (q.kind === 'choose' && s.slots[q.id] == null) missing.push(q.id);
        s.missing = missing;
        const usedDefault = s.steps.some((x) => x.by === 'default');
        s.result = missing.length ? '' : R.interp(t.result, { slots: s.slots });
        s.verdict = missing.length ? 'failed' : usedDefault ? 'degraded' : 'ok';
        s.state = 'done';
    }

    function status(s) {
        return { id: s.id, state: s.state, verdict: s.verdict, template: s.template ? s.template.id : (s.routeKey || null), step: s.step, slots: s.slots, missing: s.missing || [], result: s.result, steps: s.steps, reason: s.reason || '' };
    }

    return { SESSION_VERSION, MAX_TRIES, similarity, routeCands, createSession, currentQuestion, submitAnswer, bindTemplate, finish, status, parseLetter, programFields };
});
