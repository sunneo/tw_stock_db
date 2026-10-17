/* CoLU 接線題（UMD，純函式）：評估一個語言模型「串接多個工具」的能力，並建議該用哪種輔助方式。設計見 DESIGN.unit-catalog.md 第三十節。
 * 題目從單元目錄的接線矩陣出（走一條合法的路，再加幾個干擾的單元），評分全由程式用型別接線矩陣判定，不靠模型自評：
 *   A. 自己排（self）：給一堆函式（名稱、參數型別、回傳型別），要模型排出呼叫順序。合法＝第一個吃得下起始型別、每相鄰兩步接得上、最後一個產出目標型別、
 *      名稱都在清單裡、沒有重複。不要求跟出題的那條一模一樣（只要合法都算對）。
 *   B. CoLU 先給計畫（assisted）：程式算出幾條合法接線讓模型選，需求用白話描述（優先用函式的說明，沒有才用名稱），要模型選出最符合需求的那一條。
 *   C. CoLU 直接排（auto）：不呼叫模型。只統計「CoLU 的第一名剛好是出題那條」的比例，當作參考（CoLU 不知道使用者的意圖，只保證合法）。
 * 結果：自己排的成功率、選計畫的成功率、輸出格式正確率、退化率（空白、只有思考、重複輸出）、中位耗時，以及建議（self／guided／auto／unknown）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog_core.js'), require('./matrix_core.js'));
    else root.FaColuBench = factory(root.FaCatalog || (typeof FaCatalog !== 'undefined' ? FaCatalog : undefined), root.FaCatalogMatrix || (typeof FaCatalogMatrix !== 'undefined' ? FaCatalogMatrix : undefined));
})(typeof self !== 'undefined' ? self : this, function (Cat, MX) {
    'use strict';
    const DEFAULTS = { n: 6, minLen: 2, maxLen: 3, distractors: 5, options: 3, high: 0.8, unstable: 0.25, minCalls: 3, minEdge: 0.9, requireOptions: true };
    const mkRng = (seed) => { let s = (seed >>> 0) || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
    const shuffle = (arr, rnd) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const typeStr = (t) => Cat.typeToString(t);
    const generic = (t) => t.k === 'json' || t.k === 'any' || t.k === 'dict' || t.k === 'null';
    const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

    function describeUnit(M, i) {
        const u = M.units[i]; const ps = M.ins[i].map((p) => p.name + (p.required ? '' : '?') + ': ' + typeStr(p.type)).join(', ');
        return { id: u.id, name: u.name, line: u.name + '(' + ps + ') → ' + short(u.returns && u.returns.type, 60) + (u.summary ? '　// ' + short(u.summary, 40) : ''), summary: short(u.summary, 60) };
    }
    const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

    // 出題：從矩陣走合法的路（只走分數夠高的接線、起訖只用具體的型別），再用 CoLU 找同起訖的其他合法接線當選項。回傳 { tasks, skipped }
    // 出完每一題都先用評分器驗證「出題那條」自己是對的、清單裡沒有同名的函式——題目自己有問題就不出，免得把模型的分數算低。
    const specific = (t) => MX.matchScore(t, t) >= 0.9;
    function makeTasks(M, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {}); const rnd = mkRng(o.seed == null ? 20261017 : o.seed); const n = M.units.length; const tasks = []; const seen = new Set(); let tries = 0; const skipped = { dup: 0, no_types: 0, few_options: 0, inconsistent: 0, dup_names: 0 };
        const strongOut = (i) => Array.from(M.edges[i].entries()).filter(([, e]) => e.score >= o.minEdge).map(([j]) => j);
        const starts = M.units.map((_, i) => i).filter((i) => strongOut(i).length);
        if (n < 4 || !starts.length) return { tasks, skipped, reason: '單元太少或接得起來的接線太少（' + n + ' 個單元），出不了題' };
        while (tasks.length < o.n && tries++ < o.n * 120) {
            const len = o.minLen + Math.floor(rnd() * (o.maxLen - o.minLen + 1)); const start = starts[Math.floor(rnd() * starts.length)]; const path = [start];
            while (path.length < len) { const nexts = strongOut(path[path.length - 1]).filter((j) => !path.includes(j)); if (!nexts.length) break; path.push(nexts[Math.floor(rnd() * nexts.length)]); }
            if (path.length < o.minLen) continue; const key = path.join('>'); if (seen.has(key)) { skipped.dup++; continue; } seen.add(key);
            const inP = M.ins[path[0]].filter((p) => !generic(p.type) && specific(p.type)); const outP = M.outs[path[path.length - 1]].filter((x) => !generic(x.type) && specific(x.type));
            if (!inP.length || !outP.length) { skipped.no_types++; continue; }
            const from = typeStr((inP.find((p) => p.required) || inP[0]).type), to = typeStr(outP[0].type);
            const intended = path.map((i) => M.ids[i]); const found = MX.findPipelines(M, { from, to }, { k: 12, maxLen: o.maxLen + 1 }).paths;
            const rank = found.findIndex((p) => sameIds(p.units, intended)); const others = found.filter((p) => !sameIds(p.units, intended));
            const hasOpts = others.length >= o.options - 1; if (!hasOpts && o.requireOptions) { skipped.few_options++; continue; }
            const rest = [], pool = shuffle(M.units.map((_, i) => i).filter((i) => !path.includes(i)), rnd); for (const i of pool) { if (rest.length >= o.distractors) break; rest.push(i); }
            const cand = shuffle(path.concat(rest), rnd).map((i) => describeUnit(M, i));
            if (new Set(cand.map((c) => c.name.toLowerCase())).size !== cand.length) { skipped.dup_names++; continue; }
            const task = { id: 't' + tasks.length, from, to, intended, candidates: cand, rank, options: null, answerIndex: -1, need: null };
            const self = grade(M, task, JSON.stringify({ steps: intended.map((id) => cand.find((c) => c.id === id).name) }), 'self'); if (!self.ok) { skipped.inconsistent++; continue; }
            if (hasOpts) {
                const opts2 = shuffle([intended].concat(others.slice(0, o.options - 1).map((p) => p.units)), rnd); const idx = new Map(M.ids.map((id, i) => [id, i]));
                task.options = opts2.map((us) => us.map((id) => describeUnit(M, idx.get(id)))); task.answerIndex = opts2.findIndex((us) => sameIds(us, intended));
                task.need = '我有一個「' + from + '」，想得到「' + to + '」。需要的步驟是：' + intended.map((id) => { const d = describeUnit(M, idx.get(id)); return d.summary || d.name; }).join('，接著');
            } else skipped.few_options++;
            tasks.push(task);
        }
        return { tasks, skipped };
    }
    // 亂猜的成功率：從清單裡隨機挑 2～3 個、隨機排，有多少機率碰巧合法。拿來對照「自己排」的成功率，看它是不是比亂猜好
    function randomBaseline(M, tasks, opts) {
        const rnd = mkRng((opts && opts.seed) || 99); const trials = (opts && opts.trials) || 200; let okN = 0, total = 0;
        for (const t of tasks) for (let k = 0; k < trials; k++) { const len = 2 + Math.floor(rnd() * 2); const pick = shuffle(t.candidates, rnd).slice(0, len); total++; if (grade(M, t, JSON.stringify({ steps: pick.map((c) => c.name) }), 'self').ok) okN++; }
        return total ? Math.round((okN / total) * 1000) / 1000 : null;
    }

    const SYS_A = '你是工具串接的助手。只回 JSON，不要多說話。';
    function buildPrompt(task, mode) {
        if (mode === 'self') return { system: SYS_A, user: '手上有一個「' + task.from + '」型別的資料，要得到「' + task.to + '」型別的結果。下面是可以用的函式（括號裡是參數，→ 後面是回傳）：\n\n' + task.candidates.map((c) => '- ' + c.line).join('\n') + '\n\n請排出呼叫順序：第一個要吃得下「' + task.from + '」，前一個的輸出要能接給下一個的輸入，最後一個要產出「' + task.to + '」；每個函式最多用一次，只用清單裡的函式。\n只回這個格式：{"steps":["函式名稱","函式名稱"]}' };
        return { system: SYS_A, user: '需求：' + task.need + '\n\n程式已經算好幾條接得起來的接線，選出最符合需求的那一條：\n\n' + task.options.map((us, i) => (i + 1) + '. ' + us.map((d) => d.name + (d.summary ? '（' + d.summary + '）' : '')).join(' → ')).join('\n') + '\n\n只回這個格式：{"choice":編號}' };
    }

    function extractJson(text) {
        const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, ''); const m = t.match(/\{[\s\S]*\}|\[[\s\S]*\]/); if (!m) return null;
        try { return JSON.parse(m[0]); } catch (_) { const m2 = t.match(/\{[^{}]*\}/); if (m2) { try { return JSON.parse(m2[0]); } catch (_2) { return null; } } return null; }
    }
    function parseAnswer(text, mode) {
        const j = extractJson(text);
        if (mode === 'self') { const steps = Array.isArray(j) ? j : (j && Array.isArray(j.steps) ? j.steps : null); return steps ? { parsed: true, steps: steps.map(String) } : { parsed: false }; }
        let c = j && typeof j === 'object' && !Array.isArray(j) ? (j.choice != null ? j.choice : j.answer) : null; if (c == null) { const m = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').match(/(?:choice|選|第)\D{0,3}(\d+)/i) || String(text || '').trim().match(/^\D{0,3}(\d+)\D{0,3}$/); if (m) c = m[1]; }
        const num = Number(c); return Number.isFinite(num) && num >= 1 ? { parsed: true, choice: Math.floor(num) } : { parsed: false };
    }
    function grade(M, task, text, mode) {
        const a = parseAnswer(text, mode); if (!a.parsed) return { parsed: false, ok: false, reason: '格式不對' };
        if (mode === 'assisted') { if (!task.options) return { parsed: true, ok: false, reason: '這題沒有選項', skip: true }; const ok = a.choice - 1 === task.answerIndex; return { parsed: true, ok, reason: ok ? '' : (a.choice > task.options.length ? '編號超出範圍' : '選錯了') }; }
        const byName = new Map(task.candidates.map((c) => [c.name.toLowerCase(), c.id])); const ids = []; for (const s of a.steps) { const id = byName.get(String(s).trim().toLowerCase()); if (!id) return { parsed: true, ok: false, reason: '用了清單裡沒有的函式：' + String(s).slice(0, 30) }; ids.push(id); }
        if (!ids.length) return { parsed: true, ok: false, reason: '沒有排任何步驟' }; if (new Set(ids).size !== ids.length) return { parsed: true, ok: false, reason: '同一個函式用了兩次' };
        const idx = ids.map((id) => M.index.get(id)); const ft = Cat.parseType(task.from), tt = Cat.parseType(task.to); const min = M.opts.minScore;
        if (!M.ins[idx[0]].some((p) => MX.matchScore(ft, p.type) >= min)) return { parsed: true, ok: false, reason: '第一個函式吃不下「' + task.from + '」' };
        for (let k = 0; k + 1 < idx.length; k++) if (!M.edges[idx[k]].has(idx[k + 1])) return { parsed: true, ok: false, reason: '「' + M.units[idx[k]].name + '」的輸出接不到「' + M.units[idx[k + 1]].name + '」' };
        if (!M.outs[idx[idx.length - 1]].some((o) => MX.matchScore(o.type, tt) >= min)) return { parsed: true, ok: false, reason: '最後一個函式產不出「' + task.to + '」' };
        return { parsed: true, ok: true, reason: '', exact: sameIds(ids, task.intended) };
    }

    // 退化：空白、只有思考沒有答案、同一行或同一段重複好幾次
    function degenerate(call) {
        const text = String((call && call.content) || '').trim(); if (!text) return call && call.reasoning ? '只有思考、沒有答案' : '空白回應';
        const lines = text.split('\n').map((x) => x.trim()).filter((x) => x.length >= 4); const cnt = new Map(); for (const l of lines) cnt.set(l, (cnt.get(l) || 0) + 1); if (Array.from(cnt.values()).some((c) => c >= 3)) return '同一行重複輸出';
        const tail = text.slice(-120); if (text.length > 400 && text.split(tail.slice(0, 40)).length - 1 >= 3) return '同一段重複輸出';
        return '';
    }
    const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
    const frac = (ok, n) => ({ ok, n, rate: n ? Math.round((ok / n) * 100) / 100 : null });

    // results：[{ mode:'self'|'assisted', task, ok, parsed, http_ok, degenerate:'', ms, error, reason }]
    function summarize(results, tasks, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {}); const baseline = o.baseline == null ? null : o.baseline; const good = results.filter((r) => r.http_ok !== false); const failed = results.length - good.length;
        const A = good.filter((r) => r.mode === 'self'), B = good.filter((r) => r.mode === 'assisted' && !r.skip);
        const self = frac(A.filter((r) => r.ok).length, A.length), assisted = frac(B.filter((r) => r.ok).length, B.length);
        const parsed = frac(good.filter((r) => r.parsed).length, good.length), deg = frac(good.filter((r) => r.degenerate).length, good.length);
        const withOpt = (tasks || []).filter((t) => t.options); const auto = frac(withOpt.filter((t) => t.rank === 0).length, withOpt.length);
        const notes = []; let advice, why;
        if (A.length < o.minCalls || B.length < o.minCalls) { advice = 'unknown'; why = '能用的回應太少（自己排 ' + A.length + ' 次、選計畫 ' + B.length + ' 次，至少要各 ' + o.minCalls + ' 次）' + (failed ? '，有 ' + failed + ' 次連線或呼叫失敗' : '') + '，判斷不了'; }
        else if (self.rate >= o.high && deg.rate < o.unstable) { advice = 'self'; why = '自己排的成功率 ' + self.ok + '/' + self.n + '，夠穩，不需要 CoLU 代勞'; }
        else if (assisted.rate >= o.high) { advice = 'guided'; why = '自己排只有 ' + self.ok + '/' + self.n + (deg.rate >= o.unstable ? '，而且常退化（' + deg.ok + '/' + deg.n + '）' : '') + '，但給它算好的計畫選就有 ' + assisted.ok + '/' + assisted.n + '：由 CoLU 先算計畫，模型只負責選與填參數'; }
        else { advice = 'auto'; why = '自己排 ' + self.ok + '/' + self.n + '、選計畫 ' + assisted.ok + '/' + assisted.n + '，都不穩：串接這一步交給 CoLU 直接排（取第一名），模型只負責講解與填參數'; if (assisted.rate < 0.5) notes.push('連選擇題都不穩，不建議讓這個模型做工具串接'); }
        if (deg.rate >= o.unstable && advice !== 'unknown') notes.push('退化率偏高（' + deg.ok + '/' + deg.n + '：' + Array.from(new Set(good.filter((r) => r.degenerate).map((r) => r.degenerate))).join('、') + '）');
        if (parsed.rate != null && parsed.rate < 0.8) notes.push('輸出格式正確率只有 ' + parsed.ok + '/' + parsed.n + '，常常不照指定的 JSON 格式回');
        if (failed) notes.push(failed + ' 次連線或呼叫失敗，沒算進成功率');
        if (auto.n) notes.push('參考：CoLU 的第一名剛好是題目那條的比例 ' + auto.ok + '/' + auto.n + '（CoLU 只保證合法，不知道你的意圖）');
        if (baseline != null) notes.push('對照：隨機亂排碰巧合法的機率約 ' + Math.round(baseline * 100) + '%' + (A.length >= o.minCalls && self.rate != null && self.rate <= baseline + 0.15 ? '——它自己排的成功率跟亂猜差不多' : ''));
        const n = Math.max(A.length, B.length); if (n < 10) notes.push('每種只測了 ' + n + ' 題，只是粗略估計；要更準可以增加題數');
        return { self, assisted, parsed, degenerate: deg, auto_top1: auto, median_ms: median(good.map((r) => r.ms).filter((x) => x != null)), failed_calls: failed, advice, reason: why, notes };
    }
    const ADVICE_LABEL = { self: '自己排就好', guided: 'CoLU 先給計畫、模型只選', auto: '交給 CoLU 直接排', unknown: '資料不足' };
    function toText(model, p) {
        const f = (x) => (x.n ? x.ok + '/' + x.n : '—');
        return '🧪 CoLU 接線題：' + model + '\n・自己排接線：' + f(p.self) + '\n・給計畫、選一條：' + f(p.assisted) + '\n・輸出格式正確：' + f(p.parsed) + '\n・退化（空白、只有思考、重複）：' + f(p.degenerate) + '\n・中位耗時：' + (p.median_ms != null ? p.median_ms + ' ms' : '—') + '\n\n建議：' + ADVICE_LABEL[p.advice] + '\n' + p.reason + (p.notes.length ? '\n\n' + p.notes.map((x) => '・' + x).join('\n') : '');
    }
    // 之後使用這個模型時，加在系統提示裡的一句話（self／unknown 不加）
    function hintFor(advice) {
        if (advice === 'guided') return '【CoLU 輔助】你串接多個工具的順序不穩定。需要把兩個以上的工具串起來時，先呼叫 catalog_query（action:"path"，from＝手上資料的型別，to＝要得到的型別）取得程式算好的合法接線，從它給的幾條裡選最符合需求的，照順序用；不要自己憑感覺排順序。';
        if (advice === 'auto') return '【CoLU 輔助】你串接多個工具的能力不可靠。需要把兩個以上的工具串起來時，先呼叫 catalog_query（action:"plan"，from＝手上資料的型別，to＝要得到的型別）取得程式排好的接線骨架，直接照它執行，只負責填參數與向使用者說明；不要自己重排順序。';
        return '';
    }
    return { DEFAULTS, makeTasks, randomBaseline, buildPrompt, extractJson, parseAnswer, grade, degenerate, summarize, toText, hintFor, ADVICE_LABEL };
});
