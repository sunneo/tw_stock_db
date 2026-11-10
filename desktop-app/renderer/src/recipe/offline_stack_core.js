'use strict';
/* 離線寫程式路徑的思考堆疊（純函式 UMD；思考堆疊缺口 C、E、I，見 DESIGN.think-stack.md 末節）。不碰 floating-assistant.js，由管理者接線。
 *   fromRounds(goal, rounds, opts)   C：把 buildFromUML 的 rounds（{by, ok, tried, reason}）變成堆疊——根框架「離線寫程式」開著，
 *                                    每一層（配方／課／範式／矩陣／區塊迴圈）一個子框架，成功 pop 成 done、失敗 pop 成 failed，
 *                                    並把「這一層試過沒解出來」記成根框架的已定決定。結果是純 JSON，可 toJsonl／fromJsonl。
 *   modelHeader(stack)               離線失敗轉模型路線時，給模型的焦點標頭（含各層摘要），取代 roundsNote 的單行字串
 *   stuckAt(stack)                   卡在哪一層（第一個 failed 之後沒有 done 的最後一層；全部成功則 null）
 *   selfCheck(stack, o)              E：離線成品離開前的檢查。程式檢查（style／syntax 由呼叫端注入，純函式）永遠跑；
 *                                    問模型的自問（selfValidate）只在 o.enabled 且有 o.ask 時才跑（預設跟隨 stack_checks 設定，預設關）
 *   coluChoose／routeColu／parseLetter  CoLU 式推入取出：模型只答一個字母，格式／核對／重試／預設退路由程式處理
 *   measureRoute(o)                  I：選工具路由的堆疊效果量測骨架：同一批題目、同一個 generate，比較無堆疊／有堆疊的正確率與呼叫數
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./think_stack.js'), require('./recipe_core.js')); else root.FaOfflineStack = factory(typeof FaThinkStack !== 'undefined' ? FaThinkStack : root.FaThinkStack, typeof FaRecipe !== 'undefined' ? FaRecipe : root.FaRecipe); // 嵌入進 floating-assistant.js 時 root 是空物件，依賴取同檔的全域常數
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
    // ---- CoLU 式推入／取出（2026-11-10）：模型不輸出任何格式，只答一個字母；格式、核對、重試、預設退路都是程式的事 ----
    // 推入＝程式把「這一題」寫成堆疊框架（問題＋選項）；模型只看到標頭＋選單；取出＝程式讀回答、核對、把結果摘要 pop 成上層已定。
    // 回答解析很寬鬆（字母、數字、引號、「答案：B」、前後有字都行），解析不出來才算格式錯誤；重試是全新一次嘗試（不把壞回答餵回去），
    // 全部失敗就用程式預設（options 裡 isDefault 的那個，通常是「都不是」），並標 fallback:true，不丟例外。
    const LETTERS = 'ABCDEFGHIJ';
    function parseLetter(text, n, prefill) {
        let s = String(text == null ? '' : text); if (prefill && s.indexOf(prefill) === 0) s = s.slice(prefill.length);
        s = s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s"'`「『（(\[{:：]*(答案|答|選擇|選|choice|answer)?[\s"'`：:是為=]*/i, '');
        const m = s.match(/^[\s"'`「『（(\[]*([A-Ja-j]|\d{1,2})(?![A-Za-z])/); if (!m) return -1;
        const t = m[1]; const i = /\d/.test(t) ? (+t - 1) : LETTERS.indexOf(t.toUpperCase()); return i >= 0 && i < n ? i : -1;
    }
    // options: [{text, isDefault?}]（至少一個 isDefault；最後一項通常是「都不是」）。回傳 { ok, index, fallback, tries, badReplies:[...], calls }
    async function coluChoose(o) {
        const opts = o.options || [], n = opts.length, prefill = o.prefill || '答案：', maxTries = o.maxTries || 2;
        const Tm = o.stack && o.stackMod; if (Tm) Tm.push(o.stack, { path: o.label || '選一個', question: o.question || '從選單挑一個字母' });
        const menu = opts.map((x, i) => LETTERS[i] + '. ' + String(x.text).replace(/\s+/g, ' ').slice(0, 60)).join('\n');
        const base = [{ role: 'system', content: (o.system || '你負責替使用者的話挑一個合適的選項。') + '只回答一個大寫字母（' + LETTERS[0] + '～' + LETTERS[n - 1] + '），不要寫別的。' },
            { role: 'user', content: '選單：\n' + menu + '\n\n使用者的話：\n' + String(o.text || '').slice(0, 800) }];
        let idx = -1, tries = 0; const bad = [];
        for (let t = 1; t <= maxTries && idx < 0; t++) {
            tries = t; const msgs = Tm ? Tm.wrap(base, o.stack, {}) : base; let raw;
            try { raw = await o.generate({ messages: msgs, maxTokens: o.maxTokens || 6, prefill }); } catch (e) { bad.push('例外：' + String((e && e.message) || e).slice(0, 80)); continue; }
            idx = parseLetter(raw, n, prefill); if (idx < 0) bad.push(String(raw).slice(0, 40));
        }
        let fallback = false; if (idx < 0) { idx = Math.max(0, opts.findIndex((x) => x.isDefault)); fallback = true; }
        if (Tm) Tm.pop(o.stack, { ok: !fallback, summary: fallback ? '沒問出來，用預設：' + opts[idx].text : '選了 ' + opts[idx].text });
        return { ok: !fallback, index: idx, fallback, tries, badReplies: bad };
    }
    // 選工具（CoLU 式·可設定）：cands 同 chooseTool（可多帶 def＝一句定義）；回傳 { ok, index, none, tries, badReplies, votes? }，index 對應 cands，none＝都不合適
    // cfg（全是便宜的去位置偏誤辦法，各自可單獨量測）：
    //   orders  選項排列清單（每個是 0..N-1 的排列，N＝候選數＋「都不是」）；多個排列＝每個各問一次、字母對回原選項後多數決（平手用 cfg.tieBreak(票數表)→原索引，預設「都不是」）
    //   noneFirst  「都不是」放最前（只在沒給 orders 時用）
    //   defs  每個選項後面附 cand.def 一句定義
    //   restate  先讓模型寫工具名再寫字母，程式核對兩者一致（不一致算格式錯誤、重試）
    function makeRouteColu(cfg) {
        cfg = cfg || {};
        return async function routeColuCfg(o) {
            const base = o.cands.map((c) => ({ text: String(c.intent || c.tool) + '（工具 ' + c.tool + '）', def: c.def, key: c.tool })).concat([{ text: '都不是（一般聊天或問答）', isDefault: true, key: '都不是' }]);
            const N = base.length, ident = base.map((_, i) => i);
            const orders = cfg.orders && cfg.orders.length ? cfg.orders : [cfg.noneFirst ? [N - 1].concat(ident.slice(0, N - 1)) : ident];
            const tally = new Array(N).fill(0); let tries = 0; const badReplies = []; let okVotes = 0;
            for (let v = 0; v < orders.length; v++) {
                const ord = orders[v]; const options = ord.map((i) => ({ text: base[i].text + (cfg.defs && base[i].def ? '：' + base[i].def : ''), isDefault: base[i].isDefault, key: base[i].key }));
                const st = orders.length > 1 && o.mkStack ? o.mkStack() : o.stack; // 多票時每票一個乾淨的堆疊（不讓前一票的結果變成後一票的「已定」）
                const args = { stack: st, stackMod: st ? o.stackMod : null, generate: o.generate, options, text: o.question, label: (o.label || '選工具') + (orders.length > 1 ? ' 第' + (v + 1) + '票' : ''), question: '從選單挑一個合適的（或「都不是」）', system: '你負責替使用者的話挑一個合適的工具。' };
                const r = cfg.restate ? await coluRestate(args) : await coluChoose(args);
                tries += r.tries; (r.badReplies || []).forEach((b) => badReplies.push(b));
                if (!r.fallback) { okVotes++; tally[ord[r.index]]++; }
            }
            let best = N - 1, fallback = false;
            if (okVotes === 0) fallback = true; else {
                const mx = Math.max.apply(null, tally); const tops = tally.map((x, i) => (x === mx ? i : -1)).filter((i) => i >= 0);
                best = tops.length === 1 ? tops[0] : (cfg.tieBreak ? cfg.tieBreak(tally, tops) : N - 1);
            }
            const none = best === N - 1; return { ok: !fallback, fallback, index: none ? -1 : best, none, tries, badReplies, votes: tally };
        };
    }
    const routeColu = makeRouteColu({});
    // 先複述工具名再選字母：提示預填「工具：」，模型寫「工具：calc，答案：A」；程式核對名稱與字母是否指同一個選項
    async function coluRestate(o) {
        const opts = o.options, n = opts.length, maxTries = o.maxTries || 2;
        const Tm = o.stack && o.stackMod; if (Tm) Tm.push(o.stack, { path: o.label || '選一個', question: o.question || '先寫工具名再寫字母' });
        const menu = opts.map((x, i) => LETTERS[i] + '. ' + String(x.text).replace(/\s+/g, ' ').slice(0, 90)).join('\n');
        const base = [{ role: 'system', content: (o.system || '') + '先寫出你選的工具名稱，再寫答案字母。格式：工具：名稱，答案：字母（' + LETTERS[0] + '～' + LETTERS[n - 1] + '）。不要寫別的。' },
            { role: 'user', content: '選單：\n' + menu + '\n\n使用者的話：\n' + String(o.text || '').slice(0, 800) }];
        let idx = -1, tries = 0; const bad = []; const prefill = '工具：';
        for (let t = 1; t <= maxTries && idx < 0; t++) {
            tries = t; let raw; try { raw = await o.generate({ messages: Tm ? Tm.wrap(base, o.stack, {}) : base, maxTokens: 20, prefill }); } catch (e) { bad.push('例外：' + String((e && e.message) || e).slice(0, 80)); continue; }
            let s = String(raw); if (s.indexOf(prefill) === 0) s = s.slice(prefill.length);
            let nameIdx = -1, pos = 1e9; opts.forEach((x, i) => { const p = s.toLowerCase().indexOf(String(x.key || '').toLowerCase()); if (p >= 0 && p < pos && (/^[A-Za-z_]+$/.test(x.key) || p < 12)) { pos = p; nameIdx = i; } });
            const m = /答案[:：]?\s*["'「]?([A-Ja-j])/.exec(s); const letIdx = m ? LETTERS.indexOf(m[1].toUpperCase()) : -1;
            if (nameIdx >= 0 && letIdx >= 0 && nameIdx === letIdx) idx = nameIdx;
            else bad.push((nameIdx >= 0 && letIdx >= 0 ? '名稱與字母不一致：' : '讀不出：') + s.slice(0, 40));
        }
        let fallback = false; if (idx < 0) { idx = Math.max(0, opts.findIndex((x) => x.isDefault)); fallback = true; }
        if (Tm) Tm.pop(o.stack, { ok: !fallback, summary: fallback ? '沒問出來，用預設：' + opts[idx].text : '選了 ' + opts[idx].text });
        return { ok: !fallback, index: idx, fallback, tries, badReplies: bad };
    }
    // 選工具（CoLU 式·逐項是非）：不讓模型在多個選項裡挑（0.6B 幾乎都選第一個＝位置偏誤），改成每個候選一個框架、一題「是／否」；
    // 剛好一個「是」就選它；零個「是」＝都不是；多個「是」再從這幾個裡用字母題挑一次（順序反過來排，抵消位置偏誤）。
    async function routeColuYN(o) {
        const Tm = o.stack && o.stackMod; const yes = []; let tries = 0; const badReplies = []; let fb = false;
        for (let i = 0; i < o.cands.length; i++) {
            const c = o.cands[i];
            const r = await coluChoose({ stack: o.stack, stackMod: o.stackMod, generate: o.generate, options: [{ text: '是，需要這個工具' }, { text: '否，不需要', isDefault: true }], text: o.question, label: (o.label || '選工具') + ' > ' + c.tool,
                question: '這句話需要「' + (c.intent || c.tool) + '」嗎？', system: '判斷使用者的話是否需要工具「' + (c.intent || c.tool) + '」。' });
            tries += r.tries; (r.badReplies || []).forEach((b) => badReplies.push(b)); if (r.fallback) fb = true; if (!r.fallback && r.index === 0) yes.push(i);
        }
        if (yes.length === 1) return { ok: true, index: yes[0], none: false, tries, badReplies, fallback: false };
        if (yes.length === 0) return { ok: true, index: -1, none: true, tries, badReplies, fallback: false };
        const rev = yes.slice().reverse(); const pick = await coluChoose({ stack: o.stack, stackMod: o.stackMod, generate: o.generate, options: rev.map((i) => ({ text: String(o.cands[i].intent || o.cands[i].tool) })).concat([{ text: '都不是', isDefault: true }]), text: o.question, label: (o.label || '選工具') + ' > 複選', question: '幾個都說需要，挑最合適的一個' });
        (pick.badReplies || []).forEach((b) => badReplies.push(b)); const none = pick.index === rev.length;
        return { ok: !pick.fallback, fallback: pick.fallback, index: none ? -1 : rev[pick.index], none, tries: tries + pick.tries, badReplies };
    }
    // I：選工具路由。cases: [{question, cands:[{tool,intent}], want: tool 或 null(都不合適)}]；generate: 模型呼叫（messages→字串）
    // variants：'off'（無堆疊）、'stack'（舊：標頭＋JSON 封閉題）、'colu'（標頭＋字母題，格式全由程式處理）
    async function measureRoute(o) {
        const out = {};
        for (const variant of o.variants || ['off', 'stack']) {
            let ok = 0, calls = 0, failed = 0, fmtErr = 0, ms = 0, rows = []; const isColu = variant === 'colu' || variant === 'colu2' || !!(o.routers && o.routers[variant]);
            for (const c of o.cases) {
                const mkStack = () => fromRounds(o.goal || '路由', o.rounds || [{ by: 'recipe', ok: false, reason: '沒有現成做法' }]); const stack = variant !== 'off' ? fromRounds(o.goal || '路由', o.rounds || [{ by: 'recipe', ok: false, reason: '沒有現成做法' }]) : null;
                let callsHere = 0; const gen = async (req) => { calls++; callsHere++; return o.generate(req); };
                const t0 = Date.now(); let r;
                try {
                    r = (o.routers && o.routers[variant]) ? await o.routers[variant]({ cands: c.cands, question: c.question, generate: gen, stack, stackMod: stack ? T : null, mkStack, label: '選工具' }) : variant === 'colu2' ? await routeColuYN({ cands: c.cands, question: c.question, generate: gen, stack, stackMod: stack ? T : null, label: '選工具' }) : variant === 'colu' ? await routeColu({ cands: c.cands, question: c.question, generate: gen, stack, stackMod: stack ? T : null, label: '選工具' })
                        : await R.chooseTool({ cands: c.cands, question: c.question, generate: gen, stack, stackMod: stack ? T : null, label: '選工具' });
                } catch (e) { r = { ok: false, error: String(e && e.message) }; }
                ms += Date.now() - t0;
                const bad = isColu ? (r.badReplies || []).length : (r.rejected || []).length + (r.error && !(r.rejected || []).length ? 1 : 0); fmtErr += bad;
                const got = r.ok ? (r.none ? null : c.cands[r.index] && c.cands[r.index].tool) : (isColu && r.fallback ? '(預設)' : undefined);
                const hit = (r.ok && got === c.want); if (hit) ok++; if (!r.ok && !isColu) failed++; if (isColu && r.fallback) failed++;
                rows.push({ q: clip(c.question, 30), want: c.want, got, hit, tries: r.tries, calls: callsHere, bad, rejected: r.rejected, badReplies: r.badReplies, error: r.error });
            }
            out[variant] = { n: o.cases.length, correct: ok, failed, calls, fmtErrReplies: fmtErr, avgCalls: o.cases.length ? Math.round(100 * calls / o.cases.length) / 100 : null, avgSec: o.cases.length ? Math.round(10 * ms / 1000 / o.cases.length) / 10 : null, accuracy: o.cases.length ? Math.round(1000 * ok / o.cases.length) / 1000 : null, rows };
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
            const st = fromRounds(o.goal || '離線寫程式', res.rounds); out.stuckAt = res.ok ? null : stuckAt(st); /* 整體成功就沒有「卡住」，即使前面某層（例如矩陣層的探路）記了 ✘ */ out.header = res.ok ? '' : modelHeader(st);
            if (res.ok && typeof res.source === 'string') {
                const progChecks = (o.progChecks || []).slice(); if (typeof o.styleFn === 'function') progChecks.push(styleProgCheck(o.styleFn));
                out.check = await selfCheck(st, { result: res.source, progChecks, enabled: !!o.enabled, ask: o.ask, question: o.question });
                if (!out.check.ok) out.note = '成品檢查提醒：' + out.check.problems.map((p) => p.check + '（' + p.msg + '）').join('；');
            }
            out.stack = T.toJsonl(st);
        } catch (e) { out.note = '思考堆疊出錯（不影響結果）：' + String((e && e.message) || e); }
        return out;
    }
    return { fromRounds, stuckAt, modelHeader, selfCheck, measureRoute, coluChoose, coluRestate, makeRouteColu, routeColu, routeColuYN, parseLetter, styleProgCheck, wireOffline, NAME };
});
