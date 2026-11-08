/* 函式內部再切成步驟（寫程式的 UML 切割往下一層）。純函式 UMD，可 new Function 載入；Python 輸出。
 *
 * 做法（由上而下、細切到不可再切再接線；不是寫死流程）：
 *   函式 solve ＝ 〔轉換步驟〕→〔歸約步驟〕。轉換步驟若湊不出符合範例的做法，就把它對半切成兩個子步驟（切割的層數 = 深度），
 *   第 1 層：轉換 ≤ 1 個積木；第 2 層：2 個；第 3 層：3～4 個；第 4 層：5～8 個。每一層只收「新增的長度」，所以淺層能解的絕不會往深層走（不切過頭）。
 *   每個積木（不可再切的步驟）有簽名（型別）、自己的小判題（積木內建的測資，加上範例實際流過它的中間值）。
 *   步驟級驗證：逐步丟沙盒，哪一步和預期不同，只把那一步的候選換掉，不整個重來。
 *   組裝：積木 → 子步驟函式 → 步驟函式 → solve → 程式；整體交判題器，沒過就回退到上一層（回報 fallback，不說成通過）。
 *   離線小模型：每一步的選擇只有「字母選擇題」（≤ maxChoices 個）；模型答不出合法字母，或沒有模型，就用敘述關鍵字排序（程式預設退路）。
 *   門檻（深度上限、嘗試上限、每題選項數、規格長度）全部由 contextWindowTokens 按比例算出（budgetFor），不寫死。
 *
 *   budgetFor(ctxTokens) → {maxDepth, maxAttempts, maxChoices, maxSpecChars, maxHits}
 *   shouldSplit({level, solved, atomic, attempts, budget, specChars, multi}) → {split, reason}
 *   wire(ids, {inType?, outType?}) → {ok, errors, types}      步驟簽名對不對得起來
 *   parseExample(text) → {mode:'plain'|'header', list} | null
 *   rankAtoms(statement) → {transforms, reducers}（依敘述關鍵字排序）;  letterChoices(items, n) → [{letter, id, label}]
 *   askPriors({pick, statement, maxChoices}) → Promise<{ids, by}>
 *   solve({statement, examples, judge, stepJudge?, ctxTokens?, maxDepth?, pick?, startLevel?}) → Promise<{ok, source, verdict, level, tree, tried, perLevel, redone, fallback, reason}>
 *   judge(source) → Promise<{verdict, detail}>（source 結尾不含 main()，由呼叫端補）；stepJudge({source, tests}) 同形（沒給就只做 JS 端檢查，並在結果標 stepChecked:false） */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaStepSplit = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const md = (x, m) => ((x % m) + m) % m;
    // ---------- 積木庫 ----------
    // 轉換：ints → ints；歸約：ints → text。py 是以變數 v（清單）為輸入的運算式（轉換）或敘述（歸約）
    const T = (id, label, kw, js, py, flags) => Object.assign({ id, label, kw, js, py, in: 'ints', out: 'ints' }, flags || {});
    const TRANSFORMS = [
        T('keep-pos', '只留正數', /正數|大於\s*0|大於零/, (v) => v.filter((x) => x > 0), '[x for x in v if x > 0]', { idem: 1 }),
        T('keep-nonneg', '去掉負數（留 ≥ 0）', /去掉負|不要負|非負|負數.*(去|刪|不)|忽略負/, (v) => v.filter((x) => x >= 0), '[x for x in v if x >= 0]', { idem: 1 }),
        T('keep-even', '只留偶數', /偶數/, (v) => v.filter((x) => md(x, 2) === 0), '[x for x in v if x % 2 == 0]', { idem: 1 }),
        T('keep-odd', '只留奇數', /奇數/, (v) => v.filter((x) => md(x, 2) === 1), '[x for x in v if x % 2 != 0]', { idem: 1 }),
        T('abs', '取絕對值', /絕對值/, (v) => v.map(Math.abs), '[abs(x) for x in v]', { idem: 1 }),
        T('square', '每個數平方', /平方/, (v) => v.map((x) => x * x), '[x * x for x in v]', {}),
        T('double', '每個數乘 2', /兩倍|加倍|乘\s*2|乘以\s*2|2\s*倍/, (v) => v.map((x) => x * 2), '[x * 2 for x in v]', {}),
        T('negate', '每個數變號', /變號|取負|相反數/, (v) => v.map((x) => -x), '[-x for x in v]', {}),
        T('sort-asc', '由小到大排序', /由小到大|遞增|升冪|從小到大|排序/, (v) => v.slice().sort((a, b) => a - b), 'sorted(v)', { sort: 1 }),
        T('sort-desc', '由大到小排序', /由大到小|遞減|降冪|從大到小/, (v) => v.slice().sort((a, b) => b - a), 'sorted(v, reverse=True)', { sort: 1 }),
        T('dedup', '去掉重複（保留第一次出現）', /去重|不重複|重複的.*(去|刪)|去掉重複|相異/, (v) => [...new Set(v)], 'list(dict.fromkeys(v))', { idem: 1 }),
        T('reverse', '整個反過來', /反過來|倒過來|反轉|倒序|逆序/, (v) => v.slice().reverse(), 'v[::-1]', { invol: 1 }),
        T('prefix-sum', '前綴和', /前綴和|累加|累計|逐步加總/, (v) => { let s = 0; return v.map((x) => (s += x)); }, '[sum(v[:i + 1]) for i in range(len(v))]', {}),
        T('diff', '相鄰兩數的差', /相鄰.*差|前後.*差|差分/, (v) => v.slice(1).map((x, i) => x - v[i]), '[v[i + 1] - v[i] for i in range(len(v) - 1)]', {}),
    ];
    const R = (id, label, kw, js, py) => ({ id, label, kw, js, py, in: 'ints', out: 'text' });
    const fmt = (v) => v.join(' ');
    const REDUCERS = [
        R('sum', '總和', /總和|加總|加起來|總計/, (v) => String(v.reduce((a, b) => a + b, 0)), 'print(sum(v))'),
        R('max', '最大值', /最大/, (v) => (v.length ? String(Math.max(...v)) : null), 'print(max(v))'),
        R('min', '最小值', /最小/, (v) => (v.length ? String(Math.min(...v)) : null), 'print(min(v))'),
        R('count', '個數', /個數|幾個|多少個|數量/, (v) => String(v.length), 'print(len(v))'),
        R('first', '第一個', /第一個|最前面/, (v) => (v.length ? String(v[0]) : null), 'print(v[0])'),
        R('last', '最後一個', /最後一個|最後面/, (v) => (v.length ? String(v[v.length - 1]) : null), 'print(v[-1])'),
        R('mean-floor', '平均（無條件捨去）', /平均/, (v) => (v.length ? String(Math.floor(v.reduce((a, b) => a + b, 0) / v.length)) : null), 'print(sum(v) // len(v))'),
        R('list', '清單（空白隔開，一行）', /輸出.*(清單|序列|依序|一行)|依序輸出/, (v) => fmt(v), 'print(" ".join(map(str, v)))'),
        R('lines', '清單（一個一行）', /每行一個|一行一個|各一行/, (v) => v.join('\n'), 'print("\\n".join(map(str, v)))'),
    ];
    const tById = new Map(TRANSFORMS.map((x) => [x.id, x])), rById = new Map(REDUCERS.map((x) => [x.id, x]));

    // ---------- 門檻（跟 contextWindowTokens 成比例）----------
    function budgetFor(ctxTokens) {
        const ctx = Math.max(512, Number(ctxTokens) || 4096);
        const stepTokens = Math.floor(ctx * 0.06); // 一步可用的 token（提示＋選項）
        return {
            ctx, stepTokens,
            maxDepth: ctx < 3000 ? 2 : ctx < 8000 ? 3 : 4, // 小視窗切不深：每多一層，子步驟與接線的提示就多一份
            maxChoices: Math.max(2, Math.min(8, Math.floor(stepTokens / 45))), // 每題字母選項數
            maxSpecChars: Math.floor(ctx * 0.5), // 規格（敘述）過長就先切
            maxAttempts: Math.floor(ctx * 40), // 候選鏈評估次數上限
            maxHits: 6, // 每層最多驗幾個「符合範例」的候選
        };
    }

    // ---------- 切割規則 ----------
    // 回答「這一步要不要再往下切」：只有沒解開才切；已經夠小（atomic）、層數或預算到頂、已解開，都不切。
    function shouldSplit(s) {
        if (s.solved) return { split: false, reason: 'solved（淺層已解開，不切）' };
        if (s.atomic) return { split: false, reason: 'atomic（已是不可再切的積木）' };
        if (s.level >= s.budget.maxDepth) return { split: false, reason: 'depth_cap（到達深度上限 ' + s.budget.maxDepth + '）' };
        if (s.attempts >= s.budget.maxAttempts) return { split: false, reason: 'budget（嘗試次數用完）' };
        if (s.specChars > s.budget.maxSpecChars) return { split: true, reason: 'too_long（規格太長）' };
        if (s.multi >= 2) return { split: true, reason: 'multi_sub（敘述含 ' + s.multi + ' 個獨立子問題）' };
        return { split: true, reason: 'judge_failed（這層湊不出符合範例的做法，縮小範圍往下切）' };
    }

    // ---------- 步驟簽名接線 ----------
    function wire(ids, o) {
        const errors = [], types = [(o && o.inType) || 'ints']; let cur = types[0];
        (ids || []).forEach((id, i) => {
            const a = tById.get(id) || rById.get(id); if (!a) { errors.push('第 ' + (i + 1) + ' 步 ' + id + '：積木庫沒有這個積木'); return; }
            if (a.in !== cur) { errors.push('第 ' + (i + 1) + ' 步 ' + id + '：要吃 ' + a.in + '，但上一步給的是 ' + cur); }
            cur = a.out; types.push(cur);
        });
        const want = (o && o.outType) || 'text'; if (!errors.length && cur !== want) errors.push('最後輸出是 ' + cur + '，函式要的是 ' + want + '（少了歸約步驟）');
        return { ok: !errors.length, errors, types };
    }

    // ---------- 範例解析 ----------
    function parseExample(text) {
        const L = String(text).replace(/\r/g, '').replace(/\n+$/, '').split('\n'); const ints = (s) => { const t = s.trim() === '' ? [] : s.trim().split(/\s+/); return t.every((x) => /^-?\d+$/.test(x)) ? t.map(Number) : null; };
        if (L.length === 2 && /^\s*\d+\s*$/.test(L[0])) { const n = Number(L[0]), l = ints(L[1]); if (l && l.length === n) return { mode: 'header', list: l }; }
        if (L.length === 1) { const l = ints(L[0]); if (l) return { mode: 'plain', list: l }; }
        if (L.length === 0 || (L.length === 1 && L[0] === '')) return { mode: 'plain', list: [] };
        return null;
    }
    const norm = (s) => String(s).trim().split(/\s+/).filter(Boolean).join(' ');

    // ---------- 排序與選擇題 ----------
    function rankAtoms(statement) {
        const st = String(statement || ''); const sc = (a) => (a.kw.test(st) ? 1 : 0);
        const order = (arr) => arr.map((a, i) => ({ a, i, s: sc(a) })).sort((x, y) => y.s - x.s || x.i - y.i).map((x) => x.a);
        return { transforms: order(TRANSFORMS), reducers: order(REDUCERS), multi: TRANSFORMS.filter(sc).length };
    }
    const LETTERS = 'ABCDEFGH';
    function letterChoices(items, n) { return items.slice(0, Math.min(n, LETTERS.length)).map((a, i) => ({ letter: LETTERS[i], id: a.id, label: a.label })); }
    // 讓模型只回答字母：「敘述裡提到哪些操作」。回答不合法（不是字母、超出選項、空）→ 退回關鍵字排序（by:'keyword'）
    async function askPriors(o) {
        const rk = rankAtoms(o.statement); const base = rk.transforms.map((a) => a.id);
        if (!o.pick) return { ids: base, by: 'keyword' };
        const ch = letterChoices(rk.transforms, o.maxChoices || 6); const q = '題目：' + String(o.statement).slice(0, 300) + '\n下列哪些操作是題目要求的？只回答字母（可多個，如 AC）：\n' + ch.map((c) => c.letter + '. ' + c.label).join('\n');
        let ans = null; try { ans = await o.pick(q, ch.map((c) => c.letter)); } catch (e) { ans = null; }
        const got = String(ans == null ? '' : ans).toUpperCase().replace(/[^A-H]/g, '').split('').filter((l, i, a) => a.indexOf(l) === i && ch.some((c) => c.letter === l));
        if (!got.length) return { ids: base, by: 'keyword' };
        const first = got.map((l) => ch.find((c) => c.letter === l).id); return { ids: first.concat(base.filter((x) => !first.includes(x))), by: 'pick' };
    }

    // ---------- 搜尋 ----------
    const REDUNDANT = (prev, cur) => !!prev && ((prev.id === cur.id && (cur.idem || cur.invol || cur.sort)) || (prev.sort && cur.sort) || (prev.id === 'square' && cur.id === 'abs') || (prev.id === 'abs' && cur.id === 'keep-nonneg') || (prev.id === 'keep-pos' && cur.id === 'keep-nonneg') || (prev.id === 'abs' && cur.id === 'negate') );
    const lenRange = (level) => (level <= 1 ? [0, 1] : [(1 << (level - 2)) + 1, 1 << (level - 1)]); // 該層新增的轉換長度
    function searchLevel(level, ctx, st) {
        const [lo, hi] = lenRange(level); const hits = []; let cur = lo;
        const dfs = (chain, vecs) => {
            if (hits.length >= ctx.budget.maxHits || st.attempts >= ctx.budget.maxAttempts) return;
            if (chain.length === cur) {
                for (const r of ctx.reducers) {
                    st.attempts++; let okAll = true;
                    for (let i = 0; i < vecs.length; i++) { let o; try { o = r.js(vecs[i]); } catch (e) { o = null; } if (o == null || norm(o) !== norm(ctx.expected[i])) { okAll = false; break; } }
                    if (okAll && !ctx.skip.has(key(chain, r))) hits.push({ chain: chain.slice(), reducer: r, vecs });
                    if (hits.length >= ctx.budget.maxHits) return;
                }
            }
            if (chain.length >= cur) return;
            for (const t of ctx.transforms) {
                if (REDUNDANT(chain[chain.length - 1], t)) continue; // 切過頭：連續做同一件事
                const nv = vecs.map((v) => t.js(v)); st.attempts++; chain.push(t); dfs(chain, nv); chain.pop();
                if (hits.length >= ctx.budget.maxHits || st.attempts >= ctx.budget.maxAttempts) return;
            }
        };
        for (cur = lo; cur <= hi && hits.length < ctx.budget.maxHits; cur++) dfs([], ctx.inputs); return hits;
    }
    const key = (chain, r) => chain.map((c) => c.id).join('>') + '|' + r.id;

    // ---------- 組裝 ----------
    // 轉換鏈對半切成樹：葉＝積木函式，內部節點＝子步驟函式（依序呼叫兩個子步驟）
    function buildTree(atoms, name) {
        if (atoms.length === 1) return { name, kind: 'atom', id: atoms[0].id, label: atoms[0].label, sig: '(ints)->ints', atom: atoms[0], children: [] };
        const mid = Math.ceil(atoms.length / 2); const kids = [buildTree(atoms.slice(0, mid), name + '_1'), buildTree(atoms.slice(mid), name + '_2')];
        return { name, kind: 'composite', label: kids.map((k) => k.label).join(' → '), sig: '(ints)->ints', children: kids };
    }
    function treeFuncs(node) {
        const out = []; for (const k of node.children) out.push(...treeFuncs(k));
        if (node.kind === 'atom') out.push(['def ' + node.name + '(v):', '    return ' + node.atom.py].join('\n'));
        else out.push(['def ' + node.name + '(v):'].concat(node.children.map((k) => '    v = ' + k.name + '(v)'), ['    return v']).join('\n'));
        return out;
    }
    const depthOf = (n) => 1 + (n.children.length ? Math.max(...n.children.map(depthOf)) : 0);
    function assemble(chain, reducer, mode) {
        const tree = chain.length ? buildTree(chain, 'transform') : null; const head = mode === 'header' ? ['    n = int(input())'] : [];
        const parts = ['def read_input():'].concat(head, ['    v = list(map(int, input().split()))', '    return v']).join('\n');
        const funcs = tree ? treeFuncs(tree) : []; const body = ['def solve(v):'].concat(tree ? ['    v = ' + tree.name + '(v)'] : [], ['    ' + reducer.py]).join('\n');
        const main = 'def main():\n    v = read_input()\n    solve(v)';
        return { source: [parts].concat(funcs, [body, main]).join('\n\n') + '\n', tree };
    }
    // 步驟級小判題：每個積木各自一支小程式；測資＝積木內建測資＋範例實際流過的中間值
    const SELF = [[3, -1, 4, -1, 5, 0, -2], [], [7], [2, 2, -3, 9, 9, 1]];
    function stepSource(a) { const rd = '    v = list(map(int, input().split()))'; return (a.out === 'ints' ? ['def step(v):', '    return ' + a.py, 'def main():', rd, '    print(" ".join(map(str, step(v))))'] : ['def main():', rd, '    ' + a.py]).join('\n') + '\n'; }
    function stepTests(a, inputs) {
        const tests = []; for (const v of SELF.concat(inputs)) { let o; try { o = a.js(v); } catch (e) { o = null; } if (o == null) continue; tests.push({ in: v.join(' ') + '\n', out: (a.out === 'ints' ? fmt(o) : String(o)) + '\n' }); }
        return tests;
    }
    // 逐步驗證：回傳第一個和預期不同的積木（只重做那一步）
    async function checkSteps(hit, stepJudge) {
        const seq = hit.chain.concat([hit.reducer]); let vecs = hit.inputsStart;
        for (const a of seq) {
            const tests = stepTests(a, vecs); if (stepJudge) { const j = await stepJudge({ source: stepSource(a), tests, step: a.id }); if (j && j.verdict !== 'AC' && j.verdict !== 'UNCHECKED') return { bad: a, detail: j.detail || j.verdict }; }
            if (a.out === 'ints') vecs = vecs.map((v) => a.js(v));
        }
        return { bad: null };
    }

    async function solve(o) {
        const t0 = Date.now(); const budget = Object.assign(budgetFor(o.ctxTokens), o.budget || {}); const maxDepth = Math.min(o.maxDepth || budget.maxDepth, budget.maxDepth); budget.maxDepth = maxDepth;
        const exs = o.examples || []; if (!exs.length) return { ok: false, reason: '沒有範例', perLevel: [] };
        const ps = exs.map((e) => parseExample(e.in)); if (ps.some((p) => !p || p.mode !== ps[0].mode)) return { ok: false, reason: '輸入不是「一行整數清單」（或「個數＋一行清單」）', perLevel: [] };
        const mode = ps[0].mode; const inputs = ps.map((p) => p.list); const expected = exs.map((e) => e.out);
        const rk = rankAtoms(o.statement); const pri = await askPriors({ pick: o.pick, statement: o.statement, maxChoices: budget.maxChoices }); const ord = new Map(pri.ids.map((id, i) => [id, i]));
        const transforms = rk.transforms.slice().sort((a, b) => (ord.get(a.id) ?? 99) - (ord.get(b.id) ?? 99)); const reducers = rk.reducers;
        const st = { attempts: 0 }; const skip = new Set(); const redone = []; const perLevel = []; let fallback = null;
        const ctx = { budget, transforms, reducers, inputs, expected, skip };
        for (let level = 1; level <= maxDepth; level++) {
            const tl = Date.now(); const a0 = st.attempts; const hits = searchLevel(level, ctx, st); let lv = { level, hits: hits.length, attempts: 0, ms: 0, accepted: false };
            for (const h of hits) {
                h.inputsStart = inputs;
                const chk = await checkSteps(h, o.stepJudge); if (chk.bad) { redone.push({ level, step: chk.bad.id, detail: String(chk.detail).slice(0, 120) }); skip.add(key(h.chain, h.reducer)); continue; } // 只換掉這一步的候選，其餘不動
                const asm = assemble(h.chain, h.reducer, mode); const v = await o.judge(asm.source); const cand = { level, source: asm.source, verdict: v.verdict, detail: v.detail, chain: h.chain.map((c) => c.id), reducer: h.reducer.id };
                if (v.verdict === 'AC' || v.verdict === 'UNCHECKED') {
                    lv.accepted = true; lv.attempts = st.attempts - a0; lv.ms = Date.now() - tl; perLevel.push(lv);
                    return { ok: true, source: asm.source, verdict: v.verdict, level, depth: asm.tree ? depthOf(asm.tree) : 0, tree: describe(asm.tree, h.reducer), chain: cand.chain, reducer: cand.reducer, tried: st.attempts, perLevel, redone, stepChecked: !!o.stepJudge, ms: Date.now() - t0, priors: pri.by };
                }
                if (!fallback) fallback = cand; // 範例過了但整體判題沒過：記下最淺的一個，供回退
                redone.push({ level, assembled: false, verdict: v.verdict });
            }
            lv.attempts = st.attempts - a0; lv.ms = Date.now() - tl; perLevel.push(lv);
            const d = shouldSplit({ level, solved: false, atomic: false, attempts: st.attempts, budget, specChars: String(o.statement || '').length, multi: rk.multi });
            lv.next = d.reason; if (!d.split) return fail(d.reason);
        }
        return fail('到達深度上限');
        function fail(why) { return { ok: false, reason: '切到第 ' + perLevel.length + ' 層仍沒有通過整體判題：' + why, tried: st.attempts, perLevel, redone, fallback, stepChecked: !!o.stepJudge, ms: Date.now() - t0, priors: pri.by }; }
    }
    function describe(tree, reducer) {
        const walk = (n) => (n ? { name: n.name, kind: n.kind, label: n.label, sig: n.sig, children: n.children.map(walk) } : null);
        return { name: 'solve', sig: '(ints)->text', children: (tree ? [walk(tree)] : []).concat([{ name: 'reduce:' + reducer.id, kind: 'atom', label: reducer.label, sig: '(ints)->text', children: [] }]) };
    }
    return { TRANSFORMS, REDUCERS, budgetFor, shouldSplit, wire, parseExample, rankAtoms, letterChoices, askPriors, solve, assemble, searchLevel, lenRange, stepSource };
});
