/* 模型端的選擇器：把建樹器的每個空位變成選擇題（編號），請模型只回編號；識別名稱先從作用域挑，必要時才寫新名稱。
 * 不開思考。每個決定的提示都很短（題目＋目前已寫的程式＋這個空位＋選項）。
 *   makeModelDecider({ generate, problem, text() → 目前已寫的程式, trace?(rec), maxTokens? }) → decider（給 FaAstBuild.build）
 *   decider.stats = { choices, leaves, forced（只有一個選項、不問模型）, miss（答案解析不出來、用第一個）, ms }
 * generate(req)：req = {messages, maxTokens, enableThinking:false}，回傳字串。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaAstChoose = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const GLOSS = {
        identifier: '名稱（變數或函式）', integer: '整數', float: '小數', string: '字串', true: 'True', false: 'False', none: 'None', call: '函式呼叫 f(x)', attribute: '屬性或方法 a.b', subscript: '取索引 a[i]', slice: '切片 a:b',
        binary_operator: '二元運算 a+b', unary_operator: '一元運算 -a', comparison_operator: '比較 a<b', boolean_operator: 'and／or', not_operator: 'not', conditional_expression: '條件式 a if c else b',
        list: '清單 [..]', tuple: '元組 (a,b)', dictionary: '字典 {k:v}', set: '集合 {a,b}', list_comprehension: '清單生成式', generator_expression: '生成器運算式', dictionary_comprehension: '字典生成式', set_comprehension: '集合生成式',
        lambda: 'lambda 函式', parenthesized_expression: '括號 (a)', assignment: '指定 a = b', augmented_assignment: '複合指定 a += b', expression_statement: '運算式敘述', return_statement: 'return', if_statement: 'if 判斷', for_statement: 'for 迴圈',
        while_statement: 'while 迴圈', function_definition: '定義函式 def', import_statement: 'import', import_from_statement: 'from … import', pass_statement: 'pass', break_statement: 'break', continue_statement: 'continue', try_statement: 'try', raise_statement: 'raise', assert_statement: 'assert',
        pair: '鍵值對 k:v', elif_clause: 'elif', else_clause: 'else', block: '區塊', '⇥ 縮排區塊': '換行縮排的區塊（多行）',
    };
    const HOLE = { body: '區塊內容', left: '指定的左邊', right: '右邊', condition: '條件', consequence: '成立時的區塊', alternative: '否則', function: '被呼叫的東西', arguments: '參數', object: '物件', attribute: '屬性名稱', value: '值', name: '名稱', parameters: '參數列', operator: '運算符號', argument: '運算對象', subscript: '索引', _statement: '下一個敘述', _simple_statement: '下一個敘述', primary_expression: '運算式', expression: '運算式', pattern: '被指定的名稱', module: '整個程式', block: '區塊內容', return_type: '回傳型別', iterable: '可迭代', key: '鍵', collection: '集合', kindhole: '' };
    const KW = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
    const BUILTIN = ['input', 'int', 'print', 'len', 'range', 'map', 'sorted', 'sum', 'max', 'min', 'abs', 'str', 'list', 'dict', 'set', 'enumerate', 'zip', 'float', 'bool', 'tuple', 'reversed', 'any', 'all', 'ord', 'chr', 'divmod', 'pow', 'round', 'bin', 'isinstance', 'open'];
    const ATTRS = ['split', 'append', 'pop', 'strip', 'lower', 'upper', 'join', 'sort', 'reverse', 'get', 'items', 'keys', 'values', 'add', 'extend', 'count', 'index', 'isalnum', 'isalpha', 'isdigit', 'startswith', 'endswith', 'replace', 'popleft', 'appendleft', 'readline', 'read', 'write', 'format', 'insert', 'remove', 'copy', 'setdefault', 'update', 'discard', 'most_common'];
    function scopeNames(text) { const out = []; const seen = new Set(); for (const m of String(text).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) { const n = m[0]; if (KW.has(n) || seen.has(n) || BUILTIN.includes(n) || ATTRS.includes(n)) continue; seen.add(n); out.push(n); } return out; }
    const PRIO = ['identifier', 'integer', 'assignment', 'call', 'expression_statement', 'augmented_assignment', 'attribute', 'subscript', 'string', 'for_statement', 'if_statement', 'while_statement', 'return_statement', 'function_definition', 'comparison_operator', 'binary_operator', 'list', 'list_comprehension', 'generator_expression', 'tuple', 'dictionary', 'set', 'float', 'true', 'false', 'none', 'unary_operator', 'boolean_operator', 'not_operator', 'conditional_expression', 'parenthesized_expression', 'lambda', 'pass_statement', 'break_statement', 'continue_statement', 'import_statement', 'import_from_statement', 'try_statement', 'raise_statement', 'assert_statement'];
    const LEAFISH = new Set(['identifier', 'integer', 'float', 'string', 'true', 'false', 'none']);
    const LET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');
    const tail = (t, n) => { const L = String(t).split('\n'); return L.length > n ? L.slice(-n).join('\n') : String(t); };

    function makeModelDecider(o) {
        let depth = 0; const stats = { choices: 0, leaves: 0, forced: 0, miss: 0, ms: 0 }; const maxTokens = o.maxTokens || 8; const hint = o.hint || '程式要定義 def main()，從標準輸入讀資料、用 print 輸出答案。';
        const sys = '你是 Python 程式設計助手。我們用「語法樹」一步一步寫程式：每一步我會列出此位置合法的選項，你只回答選項前面的字母（一個字母），不要解釋。';
        const ask = async (user, kind) => {
            const t0 = Date.now(); let a = ''; try { a = await o.generate({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens, enableThinking: false, timeoutMs: o.timeoutMs }); } finally { stats.ms += Date.now() - t0; }
            return String(a || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        };
        const head = () => '題目：' + String(o.problem.statement || o.problem.title || '').slice(0, 600) + '\n' + hint + (o.plan ? '\n解法步驟：\n' + o.plan : '') + '\n\n目前已寫的程式（最後一行還沒寫完，□ 是要決定的位置）：\n```\n' + tail(o.text(), 30) + ' □\n```\n';
        const pickNumber = (ans, n) => { const m = /\d+/.exec(ans); if (m) { const k = +m[0]; if (k >= 1 && k <= n) return k - 1; } return -1; };
        // 受限選擇：有 generate.pick 就只比對字母標籤的機率（一次前向）；沒有就回頭用生成＋解析（假模型／測試用）
        const choose = async (mk, n) => {
            const t0 = Date.now(); try {
                if (o.generate.pick) {
                    const id = Array.from({ length: n }, (_, i) => i); const orders = o.noDebias ? [id] : [id, id.slice().reverse()]; const sum = new Array(n).fill(0);
                    for (const ord of orders) { const r = await o.generate.pick({ messages: [{ role: 'system', content: sys }, { role: 'user', content: mk(ord) }] }, LET.slice(0, n)); r.logprobs.forEach((lp, pos) => { sum[ord[pos]] += lp; }); }
                    let k = 0; for (let i = 1; i < n; i++) if (sum[i] > sum[k]) k = i; return { k, ans: LET[k], lp: sum };
                }
                const a = await ask(mk(Array.from({ length: n }, (_, i) => i)), 'c'); const m = /[A-Za-z]/.exec(a); const k = m ? LET.indexOf(m[0]) : -1; return { k: k >= 0 && k < n ? k : -1, ans: a };
            } finally { stats.ms += Date.now() - t0; }
        };
        const fmt = (opts, ord) => (ord ? ord.map((j) => opts[j]) : opts).map((x, i) => LET[i] + '. ' + x).join('\n');
        const holeName = (h) => HOLE[h] || h;
        return {
            stats, async enter() { depth++; }, async exit() { depth--; },
            async choice(q) {
                if (q.kind === 'node' && depth > (o.leafDepth || 9)) { const ix = q.options.map((x, i) => i).filter((i) => LEAFISH.has(q.options[i].label)); if (ix.length) q = Object.assign({}, q, { options: ix.map((i) => q.options[i]), _map: ix }); }
                if (q.kind === 'node' && q.options.length > 1) { const rk = (l) => { const i = PRIO.indexOf(l); return i < 0 ? 999 : i; }; const ord = q.options.map((x, i) => i).sort((a, b) => rk(q.options[a].label) - rk(q.options[b].label) || a - b); const prev = q._map; q = Object.assign({}, q, { options: ord.map((i) => q.options[i]), _map: ord.map((i) => (prev ? prev[i] : i)) }); }
                const r = await this._choice(q); return q._map ? q._map[r] : r;
            },
            async _choice(q) {
                const n = q.options.length; if (n === 1) { stats.forced++; return 0; } if (q.kind === 'repeat' && (q.count || 0) >= (o.maxRepeat || 25)) { stats.forced++; return 1; }
                let user, labels;
                if (q.kind === 'repeat') { labels = ['再加一個', '結束（這一串到此為止）']; user = (ord) => head() + '\n「' + holeName(q.hole) + '」這一串已經有 ' + (q.count || 0) + ' 個，要再加一個嗎？\n' + fmt(labels, ord) + '\n只回答選項的字母。'; }
                else if (q.kind === 'option') { labels = q.options.map((x) => x.label); user = (ord) => head() + '\n「' + holeName(q.hole) + '」這裡可以選擇要不要加：\n' + fmt(labels, ord) + '\n只回答選項的字母。'; }
                else { labels = q.options.map((x) => (x.token ? '「' + x.label + '」（固定的字）' : x.label + (GLOSS[x.label] ? '（' + GLOSS[x.label] + '）' : ''))); user = (ord) => head() + '\n現在要在「' + holeName(q.hole) + '」放什麼？\n' + fmt(labels, ord) + '\n只回答選項的字母。'; }
                stats.choices++; const c = await choose(user, Math.min(n, LET.length)); const ans = c.ans; let k = c.k; if (k < 0) { stats.miss++; k = 0; }
                if (o.trace) o.trace({ t: 'choice', kind: q.kind, hole: q.hole, n, ans, pick: k, label: q.options[k] && q.options[k].label }); return k;
            },
            async leaf(q) {
                stats.leaves++; const text = o.text();
                if (q.type === 'identifier') {
                    const names = scopeNames(text); const pool = (q.hole === 'attribute' ? ATTRS : q.hole === 'name' ? ['main'] : []).concat(names, q.hole === 'attribute' ? [] : BUILTIN);
                    const uniq = []; for (const x of pool) if (!uniq.includes(x)) uniq.push(x); const cap = uniq.slice(0, LET.length - 1); const opts = cap.concat(['（新名稱，我自己寫）']);
                    const user = (ord) => head() + '\n現在要在「' + holeName(q.hole) + '」寫一個名稱，從已有的名稱挑，或選最後一項自己寫新的：\n' + fmt(opts, ord) + '\n只回答選項的字母。';
                    const c = await choose(user, opts.length); const ans = c.ans; let k = c.k; if (k < 0) { stats.miss++; k = opts.length - 1; }
                    if (k < cap.length) { if (o.trace) o.trace({ t: 'leaf', type: 'identifier', hole: q.hole, ans, value: cap[k] }); return cap[k]; }
                    const v = await ask(head() + '\n請替「' + holeName(q.hole) + '」取一個新的英文名稱（小寫字母與底線），只回答名稱本身。', 'name'); const nm = (/[A-Za-z_][A-Za-z0-9_]*/.exec(v) || ['tmp'])[0]; if (o.trace) o.trace({ t: 'leaf', type: 'identifier', hole: q.hole, ans: v, value: nm }); return KW.has(nm) ? nm + '_' : nm;
                }
                const what = q.type === 'integer' ? '一個整數（只回答數字）' : q.type === 'float' ? '一個小數（只回答數字）' : '一段字串的內容（只回答內容，不要引號）';
                const v = await ask(head() + '\n現在要在「' + holeName(q.hole) + '」寫' + what + '。', 'lit'); let r;
                if (q.type === 'integer') r = (/-?\d+/.exec(v) || ['0'])[0]; else if (q.type === 'float') r = (/\d+\.\d+/.exec(v) || ['0.0'])[0]; else r = v.replace(/^["'`]+|["'`]+$/g, '').split('\n')[0];
                if (o.trace) o.trace({ t: 'leaf', type: q.type, hole: q.hole, ans: v, value: r }); return r;
            },
        };
    }
    return { makeModelDecider, scopeNames };
});
