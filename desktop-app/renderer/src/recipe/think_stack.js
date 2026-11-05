/* 思考堆疊（純函式，UMD，不碰 DOM／I/O）：小模型（0.5～1.7B、窗口 4096）深入解題時「忘記剛剛在做什麼」的補救。
 * 原則：堆疊由程式持有，不靠模型記；每次呼叫模型前，程式把「目標／路徑／現在這題／上層已定的決定」濃縮成一小段焦點標頭，
 * 重新放進這次的提示；做完一層就 pop，結果（一行摘要）變成上層的「已定決定」。設計見 DESIGN.think-stack.md。
 *   create(goal, opts)           → stack（純 JSON：{goal, frames:[…], done:[…], opts}）
 *   push(stack, {path, question, note}) → frame（超過 maxDepth 時最舊的開放框架被壓成一行摘要，不丟）
 *   decide(stack, text)          目前框架記一條已定的決定（每個框架最多 maxDecisions 條，舊的擠掉）
 *   pop(stack, {summary, ok, verify, result}) → { ok, frame, retry? }  verify(result) 不過就不 pop、記一次重試（超過 maxRetries 才放行並標 failed）
 *   header(stack, opts)          → 焦點標頭文字（有字元上限，超過依序丟：舊決定 → 舊框架摘要 → 截斷）
 *   wrap(messages, stack, opts)  → 新的 messages：標頭放在最後一則 user 訊息的最前面；opts.repeat 把「現在這題」在最後再說一次（思考模式用）
 *   planChecks(stack,{ask,next,defaults})  往下一層之前：請模型列「回來前要檢查的事」（最多 3 項，存在目前框架；問不出來用程式預設）；下層的標頭會帶【回到上層後要檢查】
 *   reviewReturn(stack,{ask,returned})     回來後：把上層的檢查逐項核對 → {items, problems:[{check,fix}], unsure}
 *   selfValidate(stack,{ask,result})       離開這一層之前自問：結果有回答這一題嗎？→ {ok, missing?, unsure?}
 *   toJsonl(stack)／fromJsonl(lines)  一個框架一行 {id,parent,path,question,state,decisions,summary,retries}，可還原
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaThinkStack = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const DEF = { maxDepth: 4, maxDecisions: 5, maxHeaderChars: 600, maxRetries: 1, summaryChars: 60 };
    const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
    const copy = (o) => JSON.parse(JSON.stringify(o));

    function create(goal, opts) {
        const o = Object.assign({}, DEF, opts || {});
        return { goal: clip(goal, 200), frames: [], done: [], nextId: 1, opts: o };
    }
    function current(stack) { return stack.frames.length ? stack.frames[stack.frames.length - 1] : null; }
    function push(stack, spec) {
        spec = spec || {}; const parent = current(stack);
        const f = { id: stack.nextId++, parent: parent ? parent.id : null, path: clip(spec.path, 60), question: clip(spec.question, 160), note: clip(spec.note, 120), state: 'open', decisions: [], summary: '', retries: 0, checks: [], reviews: [] };
        stack.frames.push(f); return f;
    }
    function decide(stack, text) {
        const f = current(stack); if (!f || !String(text || '').trim()) return null;
        f.decisions.push(clip(text, 100)); while (f.decisions.length > stack.opts.maxDecisions) f.decisions.shift(); return f;
    }
    // 做完目前這一層。verify（選用）檢查結果有沒有回答這個框架的問題；不過就留在原地、記一次重試。
    function pop(stack, spec) {
        spec = spec || {}; const f = current(stack); if (!f) return { ok: false, error: '堆疊是空的' };
        if (typeof spec.verify === 'function') {
            let v; try { v = spec.verify(spec.result, f); } catch (e) { v = { ok: false, reason: String((e && e.message) || e) }; }
            const good = v === true || (v && v.ok !== false && v !== false);
            if (!good && f.retries < stack.opts.maxRetries) { f.retries++; return { ok: false, retry: true, reason: (v && v.reason) || '結果沒有回答這一題', frame: f }; }
            if (!good) f.failed = true;
        }
        stack.frames.pop(); f.state = f.failed || spec.ok === false ? 'failed' : 'done'; f.summary = clip(spec.summary || '', stack.opts.summaryChars * 2);
        stack.done.push(f);
        const up = current(stack); if (up && f.summary) { up.decisions.push(clip((f.path ? f.path + '：' : '') + f.summary, 100)); while (up.decisions.length > stack.opts.maxDecisions) up.decisions.shift(); }
        return { ok: true, frame: f };
    }
    // ---- 標頭
    function header(stack, o) {
        o = Object.assign({}, stack.opts, o || {}); const fr = stack.frames; if (!fr.length) return '';
        const cur = fr[fr.length - 1];
        const keepFull = 2; // 最近 2 個框架完整列，其餘壓成一行
        const pp = fr.map((f) => f.path || ('#' + f.id)); const pathStr = (pp.length > o.maxDepth ? '… > ' : '') + pp.slice(-o.maxDepth).join(' > ');
        const build = (decLimit, olderFrames, hard) => {
            const L = ['【目標】' + stack.goal, '【路徑】' + pathStr, '【現在這題】' + cur.question + (cur.note ? '（' + cur.note + '）' : '')];
            const decs = []; // 已定的決定：目前框架最新的優先，再往上層
            for (let i = fr.length - 1; i >= 0; i--) { const ds = fr[i].decisions.slice().reverse(); for (const d of ds) decs.push(d); }
            const shown = decs.slice(0, decLimit); if (shown.length) L.push('【已定，不要改】\n' + shown.map((d) => '- ' + d).join('\n'));
            if (olderFrames) { const older = fr.slice(0, Math.max(0, fr.length - keepFull - 0)).slice(0, -1); if (older.length) L.push('【上層】' + older.map((f) => (f.path || '#' + f.id) + '：' + clip(f.question, 30)).join('；')); }
            if (fr.length > 1) L.push('【做完回到】' + clip(fr[fr.length - 2].question, 60));
            const pend = []; for (const f of fr.slice(0, -1)) for (const c of (f.checks || [])) pend.push(c); if (pend.length) L.push('【回到上層後要檢查】' + pend.slice(-3).map(fmtCheck).join('；'));
            let t = L.join('\n'); if (hard && t.length > o.maxHeaderChars) t = t.slice(0, o.maxHeaderChars - 1) + '…'; return t;
        };
        let t = build(o.maxDecisions * 3, true, false);
        for (const [d, ol] of [[6, true], [4, false], [2, false], [0, false]]) { if (t.length <= o.maxHeaderChars) break; t = build(d, ol, false); }
        if (t.length > o.maxHeaderChars) t = build(0, false, true);
        return t;
    }
    function wrap(messages, stack, o) {
        o = o || {}; const h = header(stack, o); if (!h) return messages;
        const m = (messages || []).map((x) => Object.assign({}, x)); let i = m.length - 1; while (i >= 0 && m[i].role !== 'user') i--; if (i < 0) return m;
        const cur = current(stack);
        m[i].content = h + '\n\n' + m[i].content + (o.repeat && cur ? '\n\n（再提醒一次，你現在只回答這一題：' + cur.question + '）' : '');
        return m;
    }
        // ---- 往下一層之前先想「回來前有什麼要檢查」；回來時逐項核對
    // ask(messages, validate) 是注入的（呼叫端用 jsonStep 包起來）：回傳通過 validate 的物件，失敗回 null。沒有 ask 或失敗就用程式的預設檢查（defaults），不阻擋流程。
    // 檢查項＝{check:要檢查什麼, standard:怎樣算通過}；字串（舊格式）當成只有 check
    function sanitizeChecks(list, n) {
        const out = [], seen = new Set();
        for (const x of Array.isArray(list) ? list : []) {
            const check = clip(typeof x === 'string' ? x : (x && (x.check || x.what)) || '', 50); const standard = clip(typeof x === 'string' ? '' : (x && (x.standard || x.criteria || x.pass)) || '', 70);
            if (check && !seen.has(check)) { seen.add(check); out.push({ check, standard }); } if (out.length >= (n || 3)) break;
        }
        return out;
    }
    const fmtCheck = (c) => c.check + (c.standard ? '（標準：' + c.standard + '）' : '');
    async function planChecks(stack, o) {
        o = o || {}; const f = current(stack); if (!f) return { ok: false, error: '堆疊是空的', checks: [] };
        let checks = [], by = 'program';
        if (typeof o.ask === 'function') {
            const base = [{ role: 'system', content: '你在規劃深入解題的步驟，像交代一個常常忘記前面做了什麼的工程師。只輸出一個 JSON 物件：{"checks":[{"check":"要檢查什麼","standard":"怎樣算通過（可以一眼判斷）"}]}。' }, { role: 'user', content: '我現在要往下一層做：' + clip(o.next, 120) + '\n做完回到這裡之前，有什麼要先記下來、回來後要檢查的嗎？最多 3 項：check 寫要檢查什麼，standard 寫怎樣算通過（具體、可判斷，例如「每個類別至少一個屬性或操作」）；沒有就給空陣列。' }];
            let v = null; try { v = await o.ask(wrap(base, stack, { repeat: !!o.repeat }), (x) => (x && Array.isArray(x.checks) ? [] : ['「checks」必須是陣列'])); } catch (_) { v = null; }
            if (v && Array.isArray(v.checks)) { checks = sanitizeChecks(v.checks, 3); by = 'model'; }
        }
        if (!checks.length && Array.isArray(o.defaults)) { checks = sanitizeChecks(o.defaults, 3); by = checks.length ? 'program' : by; }
        f.checks = checks; f.checksBy = by; return { ok: true, checks, by };
    }
    // 回來後核對：frame 是回來的那一層（上層的 checks 逐項問）。回傳 { ok, items:[{check, ok, fix}], problems:[{check, fix}], unsure }；問不出來 → unsure:true、沒有 problems（不把沉默當成有問題，也不當成都對）
    async function reviewReturn(stack, o) {
        o = o || {}; const up = current(stack); const checks = (up && up.checks) || []; const out = { ok: true, items: [], problems: [], unsure: false, checks };
        if (!checks.length) return out;
        if (typeof o.ask !== 'function') { out.unsure = true; return out; }
        const base = [{ role: 'system', content: '你在核對剛做完的結果。只輸出一個 JSON 物件：{"results":[{"i":1,"ok":true,"fix":""}]}，每一項檢查一筆；ok 為 false 時 fix 寫一句話說明要修什麼。' },
            { role: 'user', content: '剛做完：' + clip(o.returned || '', 200) + '\n要檢查的項目：\n' + checks.map((c, i) => (i + 1) + '. ' + c.check + (c.standard ? '（通過標準：' + c.standard + '）' : '')).join('\n') + '\n照每一項的通過標準判斷 ok 或 fix。' }];
        let v = null; try { v = await o.ask(wrap(base, stack, { repeat: !!o.repeat }), (x) => (x && Array.isArray(x.results) ? [] : ['「results」必須是陣列'])); } catch (_) { v = null; }
        if (!v || !Array.isArray(v.results)) { out.unsure = true; return out; }
        checks.forEach((c, i) => { const r = v.results.find((x) => x && Number(x.i) === i + 1); if (!r) { out.items.push({ check: c.check, standard: c.standard, ok: null, fix: '' }); return; } const ok = r.ok !== false; out.items.push({ check: c.check, standard: c.standard, ok, fix: ok ? '' : clip(r.fix || '沒有說明', 100) }); if (!ok) out.problems.push({ check: c.check, standard: c.standard, fix: clip(r.fix || '沒有說明', 100) }); });
        if (up) up.reviews.push({ returned: clip(o.returned || '', 80), problems: out.problems.length });
        return out;
    }
        // 自問（validate）：離開這一層之前，讓模型問自己「我的結果有回答這一題嗎？」。A 有、B 沒有（缺什麼）。問不出來 → unsure（不阻擋）。
    async function selfValidate(stack, o) {
        o = o || {}; const f = current(stack); if (!f) return { ok: true, unsure: true };
        if (typeof o.ask !== 'function') return { ok: true, unsure: true };
        const base = [{ role: 'system', content: '你在自我檢查剛做完的一題。只輸出一個 JSON 物件：{"ok":true 或 false,"missing":"缺什麼（一句話；ok 為 true 就填空字串）"}。' },
            { role: 'user', content: '這一題是：' + clip(f.question, 120) + '\n我的結果：' + clip(o.result, 300) + '\n結果有回答這一題嗎？A 有 B 沒有：缺…' }];
        let v = null; try { v = await o.ask(wrap(base, stack, { repeat: !!o.repeat }), (x) => (x && typeof x.ok === 'boolean' ? (x.ok === false && !String(x.missing || '').trim() ? ['ok 為 false 時「missing」不能是空的'] : []) : ['「ok」必須是 true 或 false'])); } catch (_) { v = null; }
        if (!v || typeof v.ok !== 'boolean') return { ok: true, unsure: true };
        f.selfChecks = (f.selfChecks || 0) + 1;
        return v.ok ? { ok: true } : { ok: false, missing: clip(v.missing, 100) };
    }
    // ---- JSONL（一個框架一行；先放已完成的，再放開放中的，id 小的在前）
    function toJsonl(stack) {
        const all = stack.done.concat(stack.frames).sort((a, b) => a.id - b.id);
        const meta = JSON.stringify({ _stack: { goal: stack.goal, opts: stack.opts, nextId: stack.nextId } });
        return [meta].concat(all.map((f) => JSON.stringify({ id: f.id, parent: f.parent, path: f.path, question: f.question, note: f.note || undefined, state: f.state, decisions: f.decisions, summary: f.summary || undefined, retries: f.retries || undefined, failed: f.failed || undefined, checks: (f.checks && f.checks.length) ? f.checks : undefined })));
    }
    function fromJsonl(lines) {
        let st = null; const frames = []; const done = [];
        for (const l of lines) { let r; try { r = typeof l === 'string' ? JSON.parse(l) : l; } catch (_) { continue; } if (!r || typeof r !== 'object') continue;
            if (r._stack) { st = create(r._stack.goal, r._stack.opts); st.nextId = r._stack.nextId || 1; continue; }
            const f = { id: r.id, parent: r.parent == null ? null : r.parent, path: r.path || '', question: r.question || '', note: r.note || '', state: r.state || 'open', decisions: r.decisions || [], summary: r.summary || '', retries: r.retries || 0, checks: sanitizeChecks(r.checks || [], 5), reviews: [] }; if (r.failed) f.failed = true;
            (f.state === 'open' ? frames : done).push(f); }
        if (!st) return null; st.frames = frames.sort((a, b) => a.id - b.id); st.done = done.sort((a, b) => a.id - b.id); return st;
    }
    return { DEF, create, push, decide, pop, current, header, wrap, planChecks, reviewReturn, selfValidate, sanitizeChecks, fmtCheck, toJsonl, fromJsonl, copy };
});
