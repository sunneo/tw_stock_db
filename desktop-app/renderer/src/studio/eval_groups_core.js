/* 評量組定義（純函式，UMD，node 可測）：toolcall（工具呼叫格式與參數）、plan（plan_check）、decompose（split_legal_rate）、
 * code_write（code_write_fn：產生程式後用判題或單元斷言檢查）、reading（閱讀理解：依文答題、引用句逐字比對、無答案拒答）。
 * 題目：由下面的程式生成（固定種子，每組 20 題，題目與答案都在程式裡，不取自 lora-train/data 的留出集——那批資料不在這個倉庫裡）。
 * 每組的 source 寫明來源，畫面上會顯示。留出組（heldout）只給通過率；題目與答案不外露（模型評測的 publicView 會去掉）。
 * 判定規則沿用 lora-train/EVAL_CRITERIA_v2.md：工具組的缺工具拒絕句型、題數 20（≥ 20 才判斷退步）。
 * 不碰 DOM／網路：生成（generate）與判題沙盒（judgeCode）由呼叫端注入。
 * 測試：renderer/src/studio/eval_groups_core.test.js。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioEvalGroups = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const N_PER_GROUP = 20;
    const REFUSAL = /not available|isn't available|does not exist|doesn't exist|not in the list|不存在|沒有這個|工具清單裡沒有|清單裡沒有|沒有「[^」]*」這個工具/;
    // 固定種子的線性同餘亂數（每次產生的題目一樣，才能比較基底與模型）
    function rng(seed) { let s = seed >>> 0 || 1; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
    function pick(r, xs) { return xs[Math.floor(r() * xs.length)]; }
    function deepEq(a, b) { return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b)); }
    function sortKeys(x) { if (Array.isArray(x)) return x.map(sortKeys); if (x && typeof x === 'object') { const o = {}; Object.keys(x).sort().forEach((k) => { o[k] = sortKeys(x[k]); }); return o; } return x; }
    function parseJson(t) { try { return JSON.parse(String(t).trim()); } catch (_) { return undefined; } }

    // ---- toolcall：格式（<tool_call>{JSON}</tool_call>）與參數；缺工具的題目要拒絕 ----
    const TOOLS = [
        { name: 'get_weather', args: ['city'] }, { name: 'add_numbers', args: ['a', 'b'] }, { name: 'search_notes', args: ['query'] },
    ];
    const CITIES = ['台北', '高雄', '台中', '花蓮'], WORDS = ['預算', '會議', '旅行', '食譜'];
    function genToolcall(seed) {
        const r = rng(seed); const out = [];
        for (let i = 0; i < N_PER_GROUP; i++) {
            if (i % 5 === 4) { out.push({ id: 'tc-missing-' + i, prompt: '請用 send_email 工具寄信給老師。可用工具只有：get_weather、add_numbers、search_notes。', gold: { refuse: true } }); continue; }
            const t = TOOLS[i % TOOLS.length];
            const args = t.name === 'get_weather' ? { city: pick(r, CITIES) } : t.name === 'add_numbers' ? { a: Math.floor(r() * 90) + 1, b: Math.floor(r() * 90) + 1 } : { query: pick(r, WORDS) };
            out.push({ id: 'tc-' + i, prompt: '可用工具：get_weather(city)、add_numbers(a,b)、search_notes(query)。請用工具完成：' + describe(t.name, args), gold: { name: t.name, arguments: args } });
        }
        return out;
    }
    function describe(name, a) { return name === 'get_weather' ? '查' + a.city + '的天氣' : name === 'add_numbers' ? '計算 ' + a.a + ' 加 ' + a.b : '搜尋筆記「' + a.query + '」'; }
    function scoreToolcall(item, output) {
        const m = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/.exec(String(output || '')); const call = m ? parseJson(m[1]) : undefined;
        const formatOk = !!(call && typeof call === 'object' && typeof call.name === 'string');
        if (item.gold.refuse) return { pass: REFUSAL.test(String(output || '')), formatOk: null };
        return { pass: formatOk && call.name === item.gold.name && deepEq(call.arguments || {}, item.gold.arguments), formatOk };
    }

    // ---- plan：規劃輸出是合法 JSON，有 checks 陣列，每筆有 item（文字）與 ok（布林） ----
    const PLAN_TASKS = ['發布一個新版本', '整理每週的報表', '部署測試環境', '備份資料庫', '更新使用說明'];
    function genPlan(seed) {
        const r = rng(seed); const out = [];
        for (let i = 0; i < N_PER_GROUP; i++) { const t = PLAN_TASKS[i % PLAN_TASKS.length], min = 2 + Math.floor(r() * 3); out.push({ id: 'plan-' + i, prompt: '請為「' + t + '」列出至少 ' + min + ' 項檢查清單，輸出 JSON：{"checks":[{"item":"…","ok":true}]}。', gold: { task: t, min: min } }); }
        return out;
    }
    function scorePlan(item, output) {
        const j = parseJson(String(output || '').replace(/^```(json)?|```$/g, '')); const ok = !!(j && Array.isArray(j.checks) && j.checks.length >= item.gold.min && j.checks.every((c) => c && typeof c.item === 'string' && c.item && typeof c.ok === 'boolean'));
        return { pass: ok, formatOk: !!j };
    }

    // ---- decompose：函式分解；函式名稱集合與標準答案完全相同＝合法（split_legal） ----
    const DECOMP = [
        { task: '讀入一串數字，找出最大值並輸出', fns: ['read_input', 'find_max', 'write_output'] },
        { task: '讀取兩個整數，相加後輸出', fns: ['read_input', 'add_pair', 'write_output'] },
        { task: '讀取文字，統計每個字出現的次數', fns: ['read_input', 'count_words', 'write_output'] },
        { task: '讀取列表，去掉重複後排序再輸出', fns: ['read_input', 'dedupe', 'sort_list', 'write_output'] },
    ];
    function genDecompose() { const out = []; for (let i = 0; i < N_PER_GROUP; i++) { const d = DECOMP[i % DECOMP.length]; out.push({ id: 'dec-' + i, prompt: '把這個任務拆成函式，輸出 JSON：{"functions":[{"name":"…"}]}。任務：' + d.task, gold: { fns: d.fns } }); } return out; }
    function scoreDecompose(item, output) {
        const j = parseJson(String(output || '').replace(/^```(json)?|```$/g, '')); const names = j && Array.isArray(j.functions) ? j.functions.map((f) => f && f.name) : null;
        const ok = !!names && names.length === item.gold.fns.length && item.gold.fns.every((n) => names.indexOf(n) >= 0);
        return { pass: ok, formatOk: !!names };
    }

    // ---- code_write：產生 Python 函式，用單元斷言檢查（需要判題沙盒；沒有就寫原因，不假裝通過） ----
    const CODE = [
        { name: 'add2', desc: '回傳兩數相加', asserts: [[[1, 2], 3], [[-4, 4], 0]] },
        { name: 'maxof', desc: '回傳 list 裡最大的數', asserts: [[[[3, 9, 2]], 9], [[[-1, -5]], -1]] },
        { name: 'is_even', desc: '判斷整數是否為偶數，回傳布林值', asserts: [[[4], true], [[7], false]] },
        { name: 'upper', desc: '把字串全部轉成大寫', asserts: [[['abc'], 'ABC'], [['Hi'], 'HI']] },
    ];
    function genCode() { const out = []; for (let i = 0; i < N_PER_GROUP; i++) { const c = CODE[i % CODE.length]; out.push({ id: 'code-' + i, prompt: '寫一個 Python 函式 ' + c.name + '，' + c.desc + '。只輸出程式碼。', gold: { name: c.name, asserts: c.asserts } }); } return out; }

    // ---- reading：依文答題；答案要用「」引用原文，引用句必須逐字出現在文中；無答案的題要拒答 ----
    const PASSAGES = [
        { text: '小林在週二下午三點到了圖書館。他借了三本書，其中一本是關於海洋的。', qa: [{ q: '小林幾點到圖書館？', a: '週二下午三點' }, { q: '小林借了幾本書？', a: '三本' }], none: '小林最喜歡的食物是什麼？' },
        { text: '工廠每天生產兩百個零件，週末不上班。品管員會抽查每批的前十個。', qa: [{ q: '工廠每天生產多少零件？', a: '兩百個零件' }, { q: '品管員抽查哪裡？', a: '每批的前十個' }], none: '工廠的電費是多少？' },
        { text: '阿明的貓叫橘子，牠每天早上六點準時叫醒主人。', qa: [{ q: '阿明的貓叫什麼名字？', a: '橘子' }, { q: '貓幾點叫醒主人？', a: '早上六點' }], none: '阿明住在哪一個城市？' },
        { text: '這座橋在一九八二年完工，全長四百公尺，是當地最長的吊橋。', qa: [{ q: '這座橋哪一年完工？', a: '一九八二年' }, { q: '橋有多長？', a: '四百公尺' }], none: '這座橋的設計者是誰？' },
    ];
    function genReading() {
        const out = []; for (let i = 0; i < N_PER_GROUP; i++) {
            const p = PASSAGES[i % PASSAGES.length];
            if (i % 5 === 4) out.push({ id: 'rd-none-' + i, prompt: '閱讀：' + p.text + '\n問題：' + p.none + '\n若文中沒有答案，請回答「文中沒有提到」，不要猜。', passage: p.text, gold: { refuse: true } });
            else { const qa = p.qa[i % p.qa.length]; out.push({ id: 'rd-' + i, prompt: '閱讀：' + p.text + '\n問題：' + qa.q + '\n請用「」引用原文中的句子回答。', passage: p.text, gold: { answer: qa.a } }); }
        }
        return out;
    }
    function scoreReading(item, output) {
        const s = String(output || '');
        if (item.gold.refuse) return { pass: /文中沒有提到|沒有提到|無法從文中|文中沒有|不知道/.test(s), formatOk: null };
        const quotes = []; const re = /「([^」]+)」/g; let m; while ((m = re.exec(s))) quotes.push(m[1]);
        const hit = quotes.some((q) => q === item.gold.answer && item.passage.indexOf(q) >= 0);
        return { pass: hit, formatOk: quotes.length > 0 };
    }

    const GROUPS = [
        { id: 'toolcall', group: 'toolcall/工具呼叫格式與參數', kind: 'toolcall', make: genToolcall, score: scoreToolcall, seed: 11,
          source: 'eval_groups_core 程式生成 20 題（3 個工具，每 5 題一題缺工具要拒絕）；判準同 lora-train/EVAL_CRITERIA_v2.md（格式合法率、缺工具拒絕句型）' },
        { id: 'plan', group: 'plan_check', kind: 'plan', make: genPlan, score: scorePlan, seed: 23,
          source: 'eval_groups_core 程式生成 20 題（5 個任務）；判準：JSON 合法、checks 陣列至少 2～4 筆、每筆有 item 與布林 ok' },
        { id: 'decompose', group: 'decompose/split_legal_rate', kind: 'decompose', make: genDecompose, score: scoreDecompose, seed: 37,
          source: 'eval_groups_core 程式生成 20 題（4 個任務）；判準：JSON 合法、函式名稱集合與標準答案完全相同' },
        { id: 'code_write', group: 'code_write/code_write_fn', kind: 'code', make: genCode, score: null, seed: 41, needsJudge: true,
          source: 'eval_groups_core 程式生成 20 題（4 個函式）；判準：產生的程式通過單元斷言' },
        { id: 'reading', group: 'reading/依文答題與拒答', kind: 'reading', make: genReading, score: scoreReading, seed: 53,
          source: 'eval_groups_core 程式生成 20 題（4 段短文，每 5 題一題文中沒有答案要拒答）；判準：引用句逐字出現在文中、答案正確、無答案拒答' },
    ];
    // 畫面用的描述（全部從定義產生）
    function describeAll(opts) { const hasJudge = !!(opts && opts.judge); return GROUPS.map((g) => ({ id: g.id, group: g.group, kind: g.kind, heldout: true, n: N_PER_GROUP, source: g.source, needsJudge: !!g.needsJudge, available: !g.needsJudge || hasJudge, unavailable: g.needsJudge && !hasJudge ? '需要判題沙盒（桌面版 Python）才能執行產生的程式；網頁版沒有這個環境。' : null })); }
    // 逐題執行：generate(prompt) → 輸出；clock() 回毫秒（測延遲）；判題沙盒 judge(code, asserts) → {pass}
    async function runGroups(opts) {
        opts = opts || {}; const out = [];
        for (const g of GROUPS) {
            const items = g.make(g.seed); const res = { group: g.group, kind: g.kind, heldout: true, n: items.length, pass: 0, formatN: 0, formatPass: 0, latencies: [] };
            if (g.needsJudge && !opts.judge) { Object.assign(res, { n: 0, pass: 0, unavailable: '需要判題沙盒（桌面版 Python）才能執行產生的程式；網頁版沒有這個環境。' }); out.push(res); continue; }
            for (const it of items) {
                const t0 = opts.clock ? opts.clock() : 0; let output = '';
                try { output = await opts.generate(it.prompt); } catch (e) { output = ''; }
                const dt = opts.clock ? opts.clock() - t0 : null; if (dt != null) res.latencies.push(dt);
                let r;
                if (g.kind === 'code') { try { const v = await opts.judge(extractCode(output), it.gold.asserts); r = { pass: !!(v && v.pass) }; } catch (e) { r = { pass: false }; } }
                else r = g.score(it, output);
                if (r.pass) res.pass++;
                if (r.formatOk != null) { res.formatN++; if (r.formatOk) res.formatPass++; }
            }
            res.rate = res.n ? Math.round((res.pass / res.n) * 10000) / 10000 : null;
            res.latencyMs = res.latencies.length ? median(res.latencies) : null; delete res.latencies;
            out.push(res);
        }
        return out;
    }
    function extractCode(t) { const m = /```(?:python)?\n?([\s\S]*?)```/.exec(String(t || '')); return m ? m[1] : String(t || ''); }
    function median(xs) { const v = xs.slice().sort((a, b) => a - b); const m = v.length >> 1; return v.length % 2 ? Math.round(v[m]) : Math.round((v[m - 1] + v[m]) / 2); }
    return { GROUPS, N_PER_GROUP, REFUSAL, describeAll, runGroups, genToolcall, genPlan, genDecompose, genCode, genReading, scoreToolcall, scorePlan, scoreDecompose, scoreReading, extractCode };
});
