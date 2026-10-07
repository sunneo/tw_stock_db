/* 互動對話卡片（FaCard）：對話裡的表單，使用者可以填、送出；可以是單張表單、多步驟的 wizard，或「依使用者的回應產生下一張卡片」。
 *
 * 規格（spec）是純資料（JSON），畫面由宿主（DOM）渲染；這裡只管規格驗證、答案的形狀與驗證、條件顯示、步驟的分支、狀態機與可持久化的狀態。
 * 設計原則：
 *   - 題目可以放文字、圖片、色塊、或可以互動的 web widget（沙盒 iframe，用 postMessage 回傳答案）；
 *   - 題型：單選、多選、文字、多行文字、數字、下拉、顏色、widget；單選／多選的選項前可以放圖片或色塊，選項後面可以接 [文字]、[下拉選單]（選到那個選項才啟用），
 *     題目層級還可以固定附加「[文字][下拉]」（after）；
 *   - 條件顯示（showIf）、步驟分支（next 規則）、「回應 → 下一張卡片」由呼叫端的處理函式決定；
 *   - 狀態是可序列化的小物件：送出後、或頁面重新整理後卡片變成唯讀並保留使用者的回應；回應不會被記進送給 AI 的對話歷史（宿主負責排除）。
 * 純函式（UMD）。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const LIMITS = { steps: 12, questions: 24, options: 60, label: 200, text: 4000, html: 24000, answer: 6000, extras: 8 };
    const ID = /^[A-Za-z][A-Za-z0-9_\-]{0,40}$/;
    const TYPES = ['single', 'multi', 'text', 'textarea', 'number', 'dropdown', 'color', 'widget', 'info'];
    const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
    const safeImage = (u) => typeof u === 'string' && u.length < 400000 && (/^https:\/\/[^\s"'<>]+$/i.test(u) || /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(u));
    const str = (v, n) => String(v == null ? '' : v).slice(0, n || LIMITS.label);

    // ---------- 規格 ----------
    // 補預設值：questions 簡寫 → 一個步驟；mode；id
    function normalizeSpec(spec) {
        const s = Object.assign({}, spec || {}); if (!Array.isArray(s.steps) || !s.steps.length) s.steps = [{ id: 'step1', title: s.stepTitle || '', questions: Array.isArray(s.questions) ? s.questions : [] }];
        delete s.questions; s.steps = s.steps.map((st, i) => Object.assign({ id: 'step' + (i + 1), questions: [] }, st)); s.mode = s.steps.length > 1 ? 'wizard' : 'form'; s.id = s.id || 'card'; s.submitLabel = s.submitLabel || (s.steps.length > 1 ? '下一步' : '送出');
        return s;
    }
    function validateSpec(spec) {
        const errs = []; if (!spec || typeof spec !== 'object') return ['卡片規格不是物件']; const s = normalizeSpec(spec);
        if (s.steps.length > LIMITS.steps) errs.push('步驟最多 ' + LIMITS.steps + ' 個'); const stepIds = new Set();
        for (const st of s.steps) {
            if (!ID.test(st.id)) errs.push('步驟 id 不合法：' + st.id); if (stepIds.has(st.id)) errs.push('步驟 id 重複：' + st.id); stepIds.add(st.id);
            if (!Array.isArray(st.questions) || !st.questions.length) { errs.push('步驟 ' + st.id + ' 沒有題目'); continue; } if (st.questions.length > LIMITS.questions) errs.push('步驟 ' + st.id + ' 題目超過 ' + LIMITS.questions);
            const qids = new Set();
            for (const q of st.questions) {
                if (!q || !ID.test(q.id || '')) { errs.push('題目 id 不合法：' + (q && q.id)); continue; } if (qids.has(q.id)) errs.push('題目 id 重複：' + q.id); qids.add(q.id);
                if (!TYPES.includes(q.type)) { errs.push('題目 ' + q.id + ' 的 type 不認得：' + q.type); continue; }
                if (q.media) { if (q.media.image && !safeImage(q.media.image)) errs.push('題目 ' + q.id + ' 的圖片只能是 https 或 data:image'); if (q.media.html && String(q.media.html).length > LIMITS.html) errs.push('題目 ' + q.id + ' 的 widget 太大'); }
                if (q.type === 'single' || q.type === 'multi' || q.type === 'dropdown') {
                    if (!Array.isArray(q.options) || !q.options.length) errs.push('題目 ' + q.id + ' 沒有選項'); else if (q.options.length > LIMITS.options) errs.push('題目 ' + q.id + ' 選項超過 ' + LIMITS.options);
                    const oids = new Set(); for (const o of q.options || []) {
                        if (!o || !ID.test(o.id || '')) { errs.push('題目 ' + q.id + ' 的選項 id 不合法：' + (o && o.id)); continue; } if (oids.has(o.id)) errs.push('題目 ' + q.id + ' 的選項 id 重複：' + o.id); oids.add(o.id);
                        if (o.image && !safeImage(o.image)) errs.push('選項 ' + o.id + ' 的圖片只能是 https 或 data:image'); if (o.color && !HEX.test(o.color)) errs.push('選項 ' + o.id + ' 的色塊要是 #rgb 或 #rrggbb');
                        if (o.extra) { if (!['text', 'select'].includes(o.extra.kind)) errs.push('選項 ' + o.id + ' 的 extra.kind 只能是 text 或 select'); if (o.extra.kind === 'select' && !(Array.isArray(o.extra.options) && o.extra.options.length)) errs.push('選項 ' + o.id + ' 的 extra 下拉沒有選項'); }
                    }
                }
                if (q.after) { if (!Array.isArray(q.after) || q.after.length > LIMITS.extras) errs.push('題目 ' + q.id + ' 的 after 最多 ' + LIMITS.extras + ' 個'); else for (const a of q.after) { if (!a || !ID.test(a.id || '') || !['text', 'select'].includes(a.kind)) errs.push('題目 ' + q.id + ' 的 after 欄位不合法'); else if (a.kind === 'select' && !(Array.isArray(a.options) && a.options.length)) errs.push('題目 ' + q.id + ' 的 after 下拉沒有選項'); } }
                if (q.showIf && !(q.showIf.q && ('eq' in q.showIf || 'in' in q.showIf || 'nonEmpty' in q.showIf || 'has' in q.showIf))) errs.push('題目 ' + q.id + ' 的 showIf 要有 q 與 eq／in／has／nonEmpty 其中之一');
            }
            if (st.next) for (const r of st.next) if (!r || !r.goto) errs.push('步驟 ' + st.id + ' 的 next 規則要有 goto');
        }
        for (const st of s.steps) for (const r of st.next || []) if (r.goto !== 'done' && !stepIds.has(r.goto)) errs.push('步驟 ' + st.id + ' 的 next 指向不存在的步驟：' + r.goto);
        return errs;
    }

    // ---------- 答案 ----------
    // 一題的答案：{ v: 值（single＝選項 id；multi＝選項 id 陣列；其他＝字串／數字）, x: { 選項id: { text, select } }, a: { after 欄位 id: 值 } }
    const blank = (q) => (q.type === 'multi' ? { v: [], x: {}, a: {} } : { v: q.type === 'number' ? '' : '', x: {}, a: {} });
    function blankAnswers(step) { const out = {}; for (const q of step.questions) { const b = blank(q); if (q.default != null) b.v = q.type === 'multi' ? [].concat(q.default) : q.default; out[q.id] = b; } return out; }
    function matchCond(c, answers) { if (!c) return true; const a = answers[c.q]; const v = a ? a.v : undefined; const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]); if ('eq' in c) return arr.length === 1 && String(arr[0]) === String(c.eq); if ('in' in c) return arr.some((x) => c.in.map(String).includes(String(x))); if ('has' in c) return arr.map(String).includes(String(c.has)); if ('nonEmpty' in c) return c.nonEmpty ? arr.length > 0 : arr.length === 0; return true; }
    function visibleQuestions(step, answers) { return step.questions.filter((q) => matchCond(q.showIf, answers)); }
    function isEmpty(q, a) { if (!a) return true; if (q.type === 'multi') return !(a.v && a.v.length); return a.v === '' || a.v == null; }
    // 驗證一個步驟：回傳 { ok, errors:{題目id: 訊息} }（只驗看得到的題目）
    function validateAnswers(step, answers) {
        const errors = {};
        for (const q of visibleQuestions(step, answers)) {
            if (q.type === 'info') continue; const a = answers[q.id] || blank(q); const label = str(q.label || q.id, 40);
            if (q.required && isEmpty(q, a)) { errors[q.id] = '「' + label + '」必填'; continue; }
            if (isEmpty(q, a)) continue;
            if (q.type === 'single' || q.type === 'dropdown') { if (!(q.options || []).some((o) => o.id === a.v)) { errors[q.id] = '「' + label + '」選項不合法'; continue; } }
            if (q.type === 'multi') { const ids = new Set((q.options || []).map((o) => o.id)); if (!(a.v || []).every((x) => ids.has(x))) { errors[q.id] = '「' + label + '」有不合法的選項'; continue; } if (q.minSelect && a.v.length < q.minSelect) { errors[q.id] = '「' + label + '」至少選 ' + q.minSelect + ' 個'; continue; } if (q.maxSelect && a.v.length > q.maxSelect) { errors[q.id] = '「' + label + '」最多選 ' + q.maxSelect + ' 個'; continue; } }
            if (q.type === 'number') { const n = Number(a.v); if (!Number.isFinite(n)) { errors[q.id] = '「' + label + '」要是數字'; continue; } if (q.min != null && n < q.min) { errors[q.id] = '「' + label + '」不能小於 ' + q.min; continue; } if (q.max != null && n > q.max) { errors[q.id] = '「' + label + '」不能大於 ' + q.max; continue; } }
            if ((q.type === 'text' || q.type === 'textarea') && typeof a.v === 'string') { if (q.maxLength && a.v.length > q.maxLength) { errors[q.id] = '「' + label + '」最多 ' + q.maxLength + ' 字'; continue; } if (q.pattern) { let re = null; try { re = new RegExp(q.pattern); } catch (_) {} if (re && !re.test(a.v)) { errors[q.id] = q.patternHint || '「' + label + '」格式不對'; continue; } } }
            if (q.type === 'color' && !HEX.test(String(a.v))) { errors[q.id] = '「' + label + '」要是 #rrggbb'; continue; }
            // 選到的選項帶的 [文字]／[下拉]
            if (q.type === 'single' || q.type === 'multi') for (const id of [].concat(a.v)) { const o = (q.options || []).find((x) => x.id === id); if (o && o.extra && o.extra.required) { const xv = a.x && a.x[id] ? (o.extra.kind === 'text' ? a.x[id].text : a.x[id].select) : ''; if (!xv) { errors[q.id] = '「' + str(o.label || o.id, 30) + '」後面的欄位必填'; break; } } }
            if (!errors[q.id] && q.after) for (const f of q.after) if (f.required && !(a.a && a.a[f.id])) { errors[q.id] = '「' + str(f.label || f.id, 30) + '」必填'; break; }
        }
        return { ok: Object.keys(errors).length === 0, errors };
    }
    // 把答案清成乾淨、有大小上限的形狀（宿主收到使用者輸入／還原持久化資料時用）
    function sanitizeAnswer(q, a) {
        const out = blank(q); if (!a || typeof a !== 'object') return out;
        const optIds = new Set((q.options || []).map((o) => o.id));
        if (q.type === 'multi') out.v = (Array.isArray(a.v) ? a.v : []).filter((x) => optIds.has(x)).slice(0, LIMITS.options); else if (q.type === 'single' || q.type === 'dropdown') out.v = optIds.has(a.v) ? a.v : ''; else if (q.type === 'widget') { try { const j = JSON.stringify(a.v); out.v = j && j.length <= LIMITS.answer ? a.v : ''; } catch (_) { out.v = ''; } } else if (q.type === 'number') out.v = a.v === '' || a.v == null ? '' : (Number.isFinite(Number(a.v)) ? Number(a.v) : ''); else if (q.type === 'color') out.v = HEX.test(String(a.v)) ? String(a.v) : ''; else out.v = str(a.v, LIMITS.text);
        if (a.x && typeof a.x === 'object') for (const o of q.options || []) { const x = a.x[o.id]; if (x && typeof x === 'object' && o.extra) out.x[o.id] = { text: str(x.text, 400), select: o.extra.kind === 'select' && (o.extra.options || []).some((p) => p.id === x.select) ? x.select : '' }; }
        if (a.a && typeof a.a === 'object') for (const f of q.after || []) { const v = a.a[f.id]; out.a[f.id] = f.kind === 'select' ? ((f.options || []).some((p) => p.id === v) ? v : '') : str(v, 400); }
        return out;
    }
    // ---------- 步驟分支 ----------
    function stepIndexById(spec, id) { return spec.steps.findIndex((s) => s.id === id); }
    // 下一步：step.next 規則（依序，第一個符合的）→ 指到的步驟或 'done'；沒有規則就是下一個步驟（最後一個之後是 done）
    function nextStep(spec, idx, answers) {
        const st = spec.steps[idx]; for (const r of st.next || []) if (matchCond(r.when, answers)) return r.goto === 'done' ? 'done' : stepIndexById(spec, r.goto);
        return idx + 1 < spec.steps.length ? idx + 1 : 'done';
    }
    // ---------- 狀態機（可序列化）----------
    // status：open（可以填）／submitted（已送出，唯讀）／cancelled／expired（頁面重新整理後，流程已經不在，唯讀但保留已填的內容）
    function createState(spec) { const s = normalizeSpec(spec); return { status: 'open', stepIndex: 0, trail: [0], answers: Object.fromEntries(s.steps.map((st) => [st.id, blankAnswers(st)])), createdAt: Date.now() }; }
    function setAnswer(spec, state, stepId, qid, value) { if (state.status !== 'open') return false; const s = normalizeSpec(spec); const st = s.steps.find((x) => x.id === stepId); const q = st && st.questions.find((x) => x.id === qid); if (!q) return false; state.answers[stepId] = state.answers[stepId] || {}; state.answers[stepId][qid] = sanitizeAnswer(q, value); return true; }
    // 送出目前的步驟：驗證 → 前進（回傳 { ok, done, errors, stepIndex }）
    function submitStep(spec, state) {
        if (state.status !== 'open') return { ok: false, errors: { _: '這張卡片已經結束' } }; const s = normalizeSpec(spec); const st = s.steps[state.stepIndex]; const v = validateAnswers(st, state.answers[st.id] || {}); if (!v.ok) return { ok: false, errors: v.errors };
        const nx = nextStep(s, state.stepIndex, state.answers[st.id]); if (nx === 'done') { state.status = 'submitted'; state.submittedAt = Date.now(); return { ok: true, done: true, stepIndex: state.stepIndex }; }
        state.stepIndex = nx; state.trail.push(nx); return { ok: true, done: false, stepIndex: nx };
    }
    function back(spec, state) { if (state.status !== 'open' || state.trail.length < 2) return false; state.trail.pop(); state.stepIndex = state.trail[state.trail.length - 1]; return true; }
    function cancel(state) { if (state.status === 'open') state.status = 'cancelled'; return state; }
    function expire(state) { if (state.status === 'open') state.status = 'expired'; return state; }
    // 還原：只留規格裡存在的題目與合法的答案；還在 open 的一律變 expired（送出流程已經不在了）
    function restoreState(spec, saved) {
        const s = normalizeSpec(spec); const st = createState(s); if (!saved || typeof saved !== 'object') return expire(st);
        for (const step of s.steps) for (const q of step.questions) { const a = saved.answers && saved.answers[step.id] && saved.answers[step.id][q.id]; if (a) st.answers[step.id][q.id] = sanitizeAnswer(q, a); }
        st.status = ['submitted', 'cancelled', 'expired', 'open'].includes(saved.status) ? saved.status : 'expired'; st.stepIndex = Math.max(0, Math.min(s.steps.length - 1, Number(saved.stepIndex) || 0)); st.trail = Array.isArray(saved.trail) ? saved.trail.filter((x) => Number.isInteger(x) && x >= 0 && x < s.steps.length).slice(0, 40) : [st.stepIndex]; if (!st.trail.length) st.trail = [st.stepIndex]; st.submittedAt = saved.submittedAt; st.createdAt = saved.createdAt || st.createdAt;
        return expire(st);
    }
    // ---------- 結果與摘要 ----------
    // 一題答案的人可讀文字（唯讀視圖與工具結果共用）
    function describeAnswer(q, a) {
        if (!a || isEmpty(q, a)) return '（沒有填）'; const optOf = (id) => (q.options || []).find((o) => o.id === id);
        const extraText = (o, x) => { if (!o || !o.extra || !x) return ''; if (o.extra.kind === 'text') return x.text ? '：' + x.text : ''; const so = (o.extra.options || []).find((p) => p.id === x.select); return so ? '：' + (so.label || so.id) : ''; };
        let main;
        if (q.type === 'single' || q.type === 'dropdown') { const o = optOf(a.v); main = (o ? (o.label || o.id) : String(a.v)) + extraText(o, a.x && a.x[a.v]); }
        else if (q.type === 'multi') main = (a.v || []).map((id) => { const o = optOf(id); return (o ? (o.label || o.id) : id) + extraText(o, a.x && a.x[id]); }).join('、');
        else if (q.type === 'widget') main = typeof a.v === 'string' ? a.v : JSON.stringify(a.v); else main = String(a.v);
        const after = (q.after || []).map((f) => { const v = a.a && a.a[f.id]; if (!v) return ''; const lab = f.kind === 'select' ? ((f.options || []).find((p) => p.id === v) || {}).label || v : v; return (f.label || f.id) + '：' + lab; }).filter(Boolean);
        return main + (after.length ? '（' + after.join('；') + '）' : '');
    }
    // 結果物件（給呼叫端程式用）：{ confirmed, answers:{題目id: {v,x,a}}, flat:{題目id: 簡化值}, steps:[走過的步驟 id] }
    function result(spec, state) {
        const s = normalizeSpec(spec); const answers = {}; const flat = {};
        for (const si of state.trail || [state.stepIndex]) { const st = s.steps[si]; if (!st) continue; for (const q of visibleQuestions(st, state.answers[st.id] || {})) { if (q.type === 'info') continue; const a = (state.answers[st.id] || {})[q.id]; if (!a || isEmpty(q, a)) continue; answers[q.id] = a; flat[q.id] = a.v; for (const [oid, x] of Object.entries(a.x || {})) if ([].concat(a.v).includes(oid)) flat[q.id + '.' + oid] = x.text || x.select || ''; for (const [fid, v] of Object.entries(a.a || {})) if (v) flat[q.id + '.' + fid] = v; } }
        return { confirmed: state.status === 'submitted', status: state.status, answers, flat, steps: (state.trail || []).map((i) => s.steps[i] && s.steps[i].id).filter(Boolean) };
    }
    function summaryLines(spec, state) { const s = normalizeSpec(spec); const out = []; for (const si of state.trail || [0]) { const st = s.steps[si]; if (!st) continue; for (const q of visibleQuestions(st, state.answers[st.id] || {})) { if (q.type === 'info') continue; out.push((q.label || q.id) + '：' + describeAnswer(q, (state.answers[st.id] || {})[q.id])); } } return out; }
    // 簡寫工廠（程式組卡片時用）
    const opt = (id, label, more) => Object.assign({ id, label }, more || {});
    return { LIMITS, TYPES, safeImage, normalizeSpec, validateSpec, blankAnswers, matchCond, visibleQuestions, validateAnswers, sanitizeAnswer, nextStep, createState, setAnswer, submitStep, back, cancel, expire, restoreState, describeAnswer, result, summaryLines, opt };
});
