'use strict';
/* 離線寫程式路徑的思考堆疊（純函式 UMD；思考堆疊缺口 C、E、I，見 DESIGN.think-stack.md 末節）。不碰 floating-assistant.js，由管理者接線。
 *   fromRounds(goal, rounds, opts)   C：把 buildFromUML 的 rounds（{by, ok, tried, reason}）變成堆疊——根框架「離線寫程式」開著，
 *                                    每一層（配方／課／範式／矩陣／區塊迴圈）一個子框架，成功 pop 成 done、失敗 pop 成 failed，
 *                                    並把「這一層試過沒解出來」記成根框架的已定決定。結果是純 JSON，可 toJsonl／fromJsonl。
 *   modelHeader(stack)               離線失敗轉模型路線時，給模型的焦點標頭（含各層摘要），取代 roundsNote 的單行字串
 *   stuckAt(stack)                   卡在哪一層（第一個 failed 之後沒有 done 的最後一層；全部成功則 null）
 *   selfCheck(stack, o)              E：離線成品離開前的檢查。程式檢查（style／syntax 由呼叫端注入，純函式）永遠跑；
 *                                    問模型的自問（selfValidate）只在 o.enabled 且有 o.ask 時才跑（預設跟隨 stack_checks 設定，預設關）
 *   measureRoute(o)                  I：選工具路由的堆疊效果量測骨架：同一批題目、同一個 generate，比較無堆疊／有堆疊的正確率與呼叫數
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./think_stack.js'), require('./recipe_core.js')); else root.FaOfflineStack = factory(root.FaThinkStack, root.FaRecipe);
})(typeof self !== 'undefined' ? self : this, function (T, R) {
    const NAME = { recipe: '配方', lesson: '課', paradigm: '範式', matrix: '矩陣', blocks: '區塊迴圈' };
    const QUESTION = { recipe: '食譜有現成做法嗎？', lesson: '教過的課能解這題嗎？', paradigm: '範式骨架＋槽位窮舉能解這題嗎？', matrix: '矩陣層能解這題嗎？', blocks: '區塊迴圈能解這題嗎？' };
    const clip = (s, n) => { s = String(s == null ? '' : s).split(String.fromCharCode(10)).join(' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

    function fromRounds(goal, rounds, opts) {
        const st = T.create(goal, Object.assign({ maxDepth: 3, maxDecisions: 6 }, opts || {}));
        T.push(st, { path: '離線寫程式', question: '不用模型，把這題解出來' });
        (Array.isArray(rounds) ? rounds : []).filter((r) => r && r.by).forEach((r) => {
            const nm = NAME[r.by] || r.by; T.push(st, { path: nm, question: QUESTION[r.by] || (nm + '能解這題嗎？') });
            if (r.ok) { T.decide(st, '解出來了'); T.pop(st, { ok: true, summary: '✔' + (r.tried ? '（試 ' + r.tried + ' 個）' : '') }); }
            else { T.decide(st, '沒解出來：' + clip(r.reason || '不明', 40)); T.pop(st, { ok: false, summary: '✘' + (r.tried ? '（試 ' + r.tried + ' 個）' : '') + (r.reason ? ' ' + clip(r.reason, 30) : '') }); }
        });
        return st;
    }
    const layers = (st) => st.done.filter((f) => f.parent != null);
    function stuckAt(st) {
        const ls = layers(st); const last = ls[ls.length - 1]; if (!last || last.state !== 'failed') return null; return last.path;
    }
    // 離線失敗轉模型：標頭帶著「前面各層已經試過、沒成」；根框架保持開著，所以 header() 會列出已定決定
    function modelHeader(st) {
        const ls = layers(st); if (!ls.length) return '';
        const line = ls.map((f) => f.path + f.summary).join('→');
        return T.header(st) + '\n【離線已試】' + line + '。請用不同的做法，不要重複前面失敗的路。';
    }
    // E：成品檢查。progChecks：[{name, run(result)→{ok, msg?}}]（純函式，永遠跑）；模型自問只在 enabled 且有 ask 時
    async function selfCheck(st, o) {
        o = o || {}; const res = { ok: true, problems: [], asked: false };
        (o.progChecks || []).forEach((c) => { let r; try { r = c.run(o.result); } catch (e) { r = { ok: false, msg: String((e && e.message) || e) }; } if (r && r.ok === false) { res.ok = false; res.problems.push({ by: 'program', check: c.name, msg: clip(r.msg || '', 80) }); } });
        if (o.enabled && typeof o.ask === 'function') {
            T.push(st, { path: '成品自問', question: o.question || '這份程式有回答這一題嗎？' });
            const v = await T.selfValidate(st, { ask: o.ask, result: typeof o.result === 'string' ? o.result : JSON.stringify(o.result || '') }); res.asked = !v.unsure;
            if (v.ok === false) { res.ok = false; res.problems.push({ by: 'model', check: '自問', msg: v.missing }); }
            T.pop(st, { ok: res.ok, summary: v.unsure ? '問不出來' : v.ok ? '有回答' : '缺：' + v.missing });
        }
        return res;
    }
    // I：選工具路由。cases: [{question, cands:[{tool,intent}], want: tool 或 null(都不合適)}]；generate: 模型呼叫（messages→字串）
    async function measureRoute(o) {
        const out = {};
        for (const variant of o.variants || ['off', 'stack']) {
            let ok = 0, calls = 0, failed = 0, rows = [];
            for (const c of o.cases) {
                const stack = variant === 'stack' ? fromRounds(o.goal || '路由', o.rounds || [{ by: 'recipe', ok: false, reason: '沒有現成做法' }]) : null;
                const gen = async (req) => { calls++; return o.generate(req); };
                let r; try { r = await R.chooseTool({ cands: c.cands, question: c.question, generate: gen, stack, stackMod: stack ? T : null, label: '選工具' }); } catch (e) { r = { ok: false, error: String(e && e.message) }; }
                const got = r.ok ? (r.none ? null : c.cands[r.index] && c.cands[r.index].tool) : undefined; const hit = r.ok && got === c.want; if (hit) ok++; if (!r.ok) failed++; rows.push({ q: clip(c.question, 30), want: c.want, got, hit });
            }
            out[variant] = { n: o.cases.length, correct: ok, failed, calls, accuracy: o.cases.length ? Math.round(1000 * ok / o.cases.length) / 1000 : null, rows };
        }
        return out;
    }
    // E 的內建程式檢查：命名風格（styleCheck 由 ir_blocks_core 的橋提供，注入進來）。只是提醒，不擋——風格混用不代表答錯，成品已過沙盒判題
    function styleProgCheck(styleFn) { return { name: '命名風格', run: (src) => { const r = styleFn(String(src)); const mixed = [].concat((r.functions && r.functions.mixed) || [], (r.variables && r.variables.mixed) || []); return { ok: r.ok !== false, msg: '命名風格混用：' + mixed.slice(0, 4).join('、') }; } }; }
    // 接線用的一個入口（給 _codeOffline）：offline 結果 → C 的層框＋卡在哪＋給模型的標頭＋E 的成品檢查。
    // 失敗（沒有 source）時只做 C；成功時再做 E。所有輸出都是純資料（stack 是 JSONL 行），不丟例外。
    async function wireOffline(o) {
        o = o || {}; const res = o.result || {}; const out = { stack: null, stuckAt: null, header: '', check: null, note: '' };
        try {
            const st = fromRounds(o.goal || '離線寫程式', res.rounds); out.stuckAt = stuckAt(st); out.header = res.ok ? '' : modelHeader(st);
            if (res.ok && typeof res.source === 'string') {
                const progChecks = (o.progChecks || []).slice(); if (typeof o.styleFn === 'function') progChecks.push(styleProgCheck(o.styleFn));
                out.check = await selfCheck(st, { result: res.source, progChecks, enabled: !!o.enabled, ask: o.ask, question: o.question });
                if (!out.check.ok) out.note = '成品檢查提醒：' + out.check.problems.map((p) => p.check + '（' + p.msg + '）').join('；');
            }
            out.stack = T.toJsonl(st);
        } catch (e) { out.note = '思考堆疊出錯（不影響結果）：' + String((e && e.message) || e); }
        return out;
    }
    return { fromRounds, stuckAt, modelHeader, selfCheck, measureRoute, styleProgCheck, wireOffline, NAME };
});
