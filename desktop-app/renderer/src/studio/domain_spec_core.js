/* 訓練工作室：領域規格（domain spec）的格式、驗證器、題目展開、編譯（UMD，純函式，不碰 DOM／網路／檔案）。設計 §16。
 * 為什麼有它：blockly 與 matrix 兩種資產要能在工作室裡「新增領域」「新增操作」，而且使用者資產裡不能放任意 JS 直接執行。
 * 所以領域用宣告式、可序列化、可版本化的 JSON 描述；要執行的只有兩種東西：
 *   1. 受限運算式（dsl_expr_core.js，Python 運算式的子集，由解譯器試算，不是 eval）；
 *   2. Python 骨架／參考解的文字——只會被送進既有的判題沙盒（judge-runner）執行，工作室本身不執行；進沙盒前先過靜態掃描（匯入白名單＋禁用名稱）。
 *
 * 規格（format:'fa-domain-spec'，version:1）共同欄位：
 *   id        領域識別（小寫英數與連字號，2～40 字，開頭是字母）        kind  'blockly'｜'matrix'
 *   label     顯示名稱                                                  meta  { license, source, author?, description?, created? }（內建化要求 license 與 source 都在）
 *   seed      整數，題目展開用的亂數種子（可重現）
 * kind:'blockly'（積木課程領域包）：
 *   algos:[{ key, any?:[詞], all?:[詞], veto?:[詞] }]       讀題規則：敘述含 any 任一個且含 all 全部、不含 veto → 算法種類 key（領域詞彙優先於通用詞彙，所以至少要有 all 或 2 個以上 any，避免搶走別人的題）
 *   judge:{ checker:'tokens'|'float', eps? }
 *   skeletons:[{ id, algo, paradigm?, label, needs?:{scalars?,lists?,strs?}, facts?:[{name, re, group?, as?:'int'|'str'}], slots:[{id,label,options:[{id,v,label?}]}], lines:[Python 行，可含 {{c.槽位}} {{N.sc.0}} {{N.ls.0}} {{N.s.0}} {{N.g}} {{N.L.0}} {{fact.名稱}}] }]
 *   families:[{ id, algo, split:'train'|'holdout', want?, statements:[題目樣板，{P} 由 params 代入], params?:{P:[值…]}, ref:Python 參考解, gen:[輸入產生規則], note? }]
 *   tasks:[{ id, split, statement, solution?, tests:[{in,out}] }]          直接給題目（含測資）
 * kind:'matrix'（矩陣層操作）：
 *   ops:[{ id, label, level?, order?:1..89（小的先試，預設 35）, keywords?:[詞], layout?:'lines'|'line', input:[{name,type:'int'|'str'|'ints'}], output:{type:'int'|'str'|'ints'|'bool', yes?, no?}, params?:{名:[值…]}, expr:受限運算式 }]
 *   tasks:[{ id, op?, split, statement, examples:[{in,out}], hidden?:[{in,out}] }]
 * 公開函式：
 *   validate(spec, {builtin}) → {ok, errors[], warnings[]}        schema＋安全掃描＋ train／holdout 不混＋可重現（展開兩次雜湊相同）
 *   normalize(spec) → 正規化複本（補預設值、鍵排序）；hash(spec) → sha256
 *   expandStatements(family) → [{id, statement, params}]           只展開敘述（同步、可重現）
 *   makeInputs(family, {seed, count, big}) → [輸入字串]
 *   buildTasks(spec, {runRef, tests, hidden}) → async {tasks, problems}   blockly 家族 → 題目（參考解在 runRef 算答案；runRef 由判題沙盒提供）
 *   compileBlockly(spec, PAR) → 領域包（FaDomains.register 吃的形狀；seeds 的 gen 是函式，只在記憶體）
 *   compileMatrix(spec, Expr) → [{name, fn, opts}]                  給 FaMatrixSynth.register
 *   fitOp(op, examples, Expr, o) → {ok, assignment, source, alternatives[], ambiguous, tried, reason}
 *   replay(op, assignment, input, Expr) → {ok, out}                 用同一份運算式重新算一筆（不用判題器）
 *   scanPython(text) → [問題]                                        靜態掃描
 *   toFiles(spec, tasks) / fromFiles(files)                          資產檔案 ↔ 規格 */
(function (root, factory) {
    const A = (typeof module === 'object' && module.exports) ? require('./asset_core.js') : root.FaStudioAsset;
    const E = (typeof module === 'object' && module.exports) ? require('./dsl_expr_core.js') : root.FaStudioExpr;
    if (typeof module === 'object' && module.exports) module.exports = factory(A, E);
    else root.FaStudioDomainSpec = factory(A, E);
})(typeof self !== 'undefined' ? self : this, function (Asset, Expr) {
    'use strict';
    const FORMAT = 'fa-domain-spec', VERSION = 1;
    const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
    const KEY_RE = /^[a-z][a-z0-9-]{1,39}$/;
    const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,23}$/;
    const stable = (o) => (o === null || typeof o !== 'object' ? JSON.stringify(o) : Array.isArray(o) ? '[' + o.map(stable).join(',') + ']' : '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}');
    const hash = (spec) => Asset.sha256Hex(stable(spec));
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
    const isStr = (x) => typeof x === 'string', isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    const ALLOWED_IMPORTS = new Set(['heapq', 'collections', 'math', 'itertools', 'bisect', 'functools', 're', 'string', 'fractions', 'decimal', 'operator', 'copy']);
    const BANNED = /\b(open|exec|eval|compile|__import__|globals|locals|vars|getattr|setattr|delattr|breakpoint|exit|quit|os|sys|subprocess|socket|shutil|ctypes|pathlib|importlib|builtins|threading|multiprocessing|signal|input_|help|memoryview)\b/;
    const LIMITS = { statementsPerFamily: 60, families: 200, skeletons: 100, ops: 100, tasks: 2000, lines: 200, lineLen: 400, combos: 24, optionLen: 300, paramValues: 200, hypotheses: 60000 };

    // ---------- 靜態掃描（Python 文字只進判題沙盒，進去前先擋明顯危險的）----------
    function scanPython(text) {
        const out = []; const s = String(text);
        for (const m of s.matchAll(/^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w., ]*))/gm)) {
            const mods = (m[1] ? [m[1]] : m[2].split(',').map((x) => x.trim().split(/\s+as\s+/)[0])).map((x) => x.split('.')[0]);
            for (const mod of mods) if (!ALLOWED_IMPORTS.has(mod)) out.push('不允許匯入 ' + mod + '（允許：' + [...ALLOWED_IMPORTS].join('、') + '）');
        }
        const noStr = s.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""');
        const b = BANNED.exec(noStr); if (b) out.push('不允許的名稱：' + b[1]);
        if (/__\w+__/.test(noStr)) out.push('不允許 dunder 名稱');
        return out;
    }

    // ---------- 驗證 ----------
    function validate(spec, opts) {
        opts = opts || {}; const errors = [], warnings = []; const E_ = (m) => errors.push(m), W_ = (m) => warnings.push(m);
        if (!isObj(spec)) return { ok: false, errors: ['規格不是物件'], warnings };
        if (spec.format !== FORMAT) E_('format 應為 ' + FORMAT);
        if (!Number.isInteger(spec.version)) E_('version 缺少或不是整數'); else if (spec.version > VERSION) E_('規格版本（' + spec.version + '）比這個程式支援的（' + VERSION + '）新，請先更新程式');
        if (spec.kind !== 'blockly' && spec.kind !== 'matrix') E_('kind 必須是 blockly 或 matrix');
        if (!isStr(spec.id) || !ID_RE.test(spec.id)) E_('id 要是小寫英數與連字號、字母開頭、2～40 字：' + JSON.stringify(spec.id));
        if (!isStr(spec.label) || !spec.label.trim()) E_('label 不可空白');
        if (!Number.isInteger(spec.seed)) E_('seed 要是整數（題目展開用，才可重現）');
        const meta = spec.meta; if (!isObj(meta)) E_('缺少 meta（license、source）'); else {
            if (!isStr(meta.license) || !meta.license.trim()) (opts.builtin ? E_ : W_)('meta.license（授權）' + (opts.builtin ? '不可缺：內建化要有授權' : '沒填；內建化前一定要填'));
            if (!isStr(meta.source) || !meta.source.trim()) (opts.builtin ? E_ : W_)('meta.source（來源）' + (opts.builtin ? '不可缺：內建化要有來源' : '沒填；內建化前一定要填'));
        }
        if (errors.length && (spec.kind !== 'blockly' && spec.kind !== 'matrix')) return { ok: false, errors, warnings };
        if (spec.kind === 'blockly') validateBlockly(spec, E_, W_); else if (spec.kind === 'matrix') validateMatrix(spec, E_, W_);
        // 可重現：展開兩次，雜湊要一樣
        if (!errors.length && spec.kind === 'blockly') { try { const a = (spec.families || []).map((f) => stable(expandStatements(f))).join('|'), b = (spec.families || []).map((f) => stable(expandStatements(f))).join('|'); if (a !== b) E_('題目展開不可重現'); const g1 = (spec.families || []).map((f) => stable(makeInputs(f, { seed: spec.seed, count: 4 }))).join('|'), g2 = (spec.families || []).map((f) => stable(makeInputs(f, { seed: spec.seed, count: 4 }))).join('|'); if (g1 !== g2) E_('輸入產生不可重現'); } catch (e) { E_('題目展開失敗：' + e.message); } }
        return { ok: errors.length === 0, errors, warnings };
    }
    function checkSplitMix(items, E_, label) { // items: [{id, split, key}]：同 id 不可重複；同敘述不可同時在 train 與 holdout
        const ids = new Map(), byKey = new Map();
        for (const it of items) {
            if (ids.has(it.id)) E_(label + ' id 重複：' + it.id); ids.set(it.id, 1);
            if (it.split !== 'train' && it.split !== 'holdout') E_(label + ' ' + it.id + ' 的 split 要是 train 或 holdout');
            const k = it.key; if (!k) continue; const prev = byKey.get(k);
            if (prev && prev.split !== it.split) E_('留出題混進訓練：' + label + ' ' + it.id + ' 與 ' + prev.id + ' 的敘述相同，但一個是 train 一個是 holdout');
            if (!prev) byKey.set(k, it);
        }
    }
    function validateGen(g, where, E_) {
        if (!Array.isArray(g) || !g.length) { E_(where + '.gen 要是非空陣列（每個元素是一行的欄位陣列，或 {rows:{…}}）'); return; }
        const seen = new Set();
        const field = (f, w) => {
            if (!isObj(f) || !isStr(f.name) || !NAME_RE.test(f.name)) { E_(w + ' 欄位要有 name'); return; }
            const kinds = ['int', 'ints', 'str'].filter((k) => f[k] !== undefined); if (kinds.length !== 1) { E_(w + ' ' + f.name + ' 要恰好一種：int／ints／str'); return; }
            if (kinds[0] === 'int') { const r = f.int; if (!Array.isArray(r) || r.length !== 2 || !r.every(Number.isInteger) || r[0] > r[1]) E_(w + ' ' + f.name + '.int 要是 [最小, 最大]'); if (f.big && (!Array.isArray(f.big) || f.big.length !== 2 || !f.big.every(Number.isInteger) || f.big[0] > f.big[1])) E_(w + ' ' + f.name + '.big 要是 [最小, 最大]'); }
            if (kinds[0] === 'ints') { const o = f.ints; if (!isObj(o) || !Array.isArray(o.range) || o.range.length !== 2 || !o.range.every(Number.isInteger)) E_(w + ' ' + f.name + '.ints 要有 range:[最小,最大]'); else if (!(Number.isInteger(o.len) || (Array.isArray(o.len) && o.len.length === 2 && o.len.every(Number.isInteger)) || (isStr(o.len) && seen.has(o.len)))) E_(w + ' ' + f.name + '.ints.len 要是整數、[最小,最大]、或前面已出現的變數名'); }
            if (kinds[0] === 'str') { const o = f.str; if (!isObj(o) || !isStr(o.alphabet) || !o.alphabet.length || o.alphabet.length > 64) E_(w + ' ' + f.name + '.str 要有 alphabet（1～64 字元）'); else if (!(Number.isInteger(o.len) || (Array.isArray(o.len) && o.len.length === 2 && o.len.every(Number.isInteger)) || (isStr(o.len) && seen.has(o.len)))) E_(w + ' ' + f.name + '.str.len 要是整數、[最小,最大]、或前面已出現的變數名'); }
            if (seen.has(f.name)) E_(w + ' 欄位名稱重複：' + f.name); seen.add(f.name);
        };
        g.forEach((line, i) => {
            const w = where + '.gen[' + i + ']';
            if (Array.isArray(line)) line.forEach((f) => field(f, w));
            else if (isObj(line) && isObj(line.rows)) { const r = line.rows; if (!(Number.isInteger(r.count) || (isStr(r.count) && seen.has(r.count)))) E_(w + '.rows.count 要是整數或前面已出現的變數名'); if (!Array.isArray(r.fields) || !r.fields.length) E_(w + '.rows.fields 要是非空陣列'); else { const save = new Set(seen); r.fields.forEach((f) => field(f, w + '.rows')); seen.clear(); save.forEach((x) => seen.add(x)); } }
            else E_(w + ' 要是欄位陣列或 {rows:{count,fields}}');
        });
    }
    function validateBlockly(spec, E_, W_) {
        const algos = spec.algos || [], sks = spec.skeletons || [], fams = spec.families || [], tasks = spec.tasks || [];
        if (!Array.isArray(algos) || !Array.isArray(sks) || !Array.isArray(fams) || !Array.isArray(tasks)) { E_('algos／skeletons／families／tasks 都要是陣列'); return; }
        if (sks.length > LIMITS.skeletons) E_('骨架太多（上限 ' + LIMITS.skeletons + '）'); if (fams.length > LIMITS.families) E_('家族太多'); if (tasks.length > LIMITS.tasks) E_('題目太多');
        if (!algos.length) E_('至少要有一個讀題規則（algos）'); if (!sks.length) W_('沒有骨架：這個領域只有題目與讀題規則，離線 AI 不會因它多解出任何題');
        const keys = new Set(); const hasTerm = (a) => (a.all || []).length > 0 || (a.any || []).length >= 2;
        algos.forEach((a, i) => {
            const w = 'algos[' + i + ']'; if (!isObj(a)) { E_(w + ' 不是物件'); return; }
            if (!isStr(a.key) || !KEY_RE.test(a.key)) E_(w + '.key 不合法：' + JSON.stringify(a.key)); else if (keys.has(a.key)) E_(w + '.key 重複：' + a.key); else keys.add(a.key);
            for (const f of ['any', 'all', 'veto']) if (a[f] !== undefined && (!Array.isArray(a[f]) || a[f].some((x) => !isStr(x) || x.length < 2 || x.length > 40))) E_(w + '.' + f + ' 要是字串陣列（每個 2～40 字）');
            if (!(a.any || []).length && !(a.all || []).length) E_(w + ' 要有 any 或 all 的關鍵詞'); else if (!hasTerm(a)) E_(w + '：只有一個 any 詞、沒有 all，範圍太寬，會搶走內建領域的題目；請加 all 詞或再給一個 any 詞');
        });
        const sid = new Set();
        sks.forEach((s, i) => {
            const w = 'skeletons[' + i + ']'; if (!isObj(s)) { E_(w + ' 不是物件'); return; }
            if (!isStr(s.id) || !/^[a-z][a-z0-9.-]{1,59}$/.test(s.id)) E_(w + '.id 不合法'); else if (sid.has(s.id)) E_(w + '.id 重複：' + s.id); else sid.add(s.id);
            if (!keys.has(s.algo)) E_(w + '.algo「' + s.algo + '」不在 algos 裡');
            if (!isStr(s.label) || !s.label) E_(w + '.label 不可空白');
            if (!Array.isArray(s.lines) || !s.lines.length || s.lines.length > LIMITS.lines || s.lines.some((l) => !isStr(l) || l.length > LIMITS.lineLen)) E_(w + '.lines 要是 1～' + LIMITS.lines + ' 行的字串陣列（每行 ≤' + LIMITS.lineLen + ' 字）');
            else { const probs = scanPython(s.lines.join('\n')); probs.forEach((p) => E_(w + '：' + p)); }
            const slotIds = new Set(); let prod = 1;
            if (!Array.isArray(s.slots)) E_(w + '.slots 要是陣列'); else s.slots.forEach((sl, j) => {
                const ww = w + '.slots[' + j + ']'; if (!isObj(sl) || !isStr(sl.id) || !NAME_RE.test(sl.id)) { E_(ww + '.id 不合法'); return; } if (slotIds.has(sl.id)) E_(ww + ' 槽位 id 重複'); slotIds.add(sl.id);
                if (!Array.isArray(sl.options) || sl.options.length < 1 || sl.options.length > 12) { E_(ww + '.options 要有 1～12 個'); return; } prod *= sl.options.length;
                const oid = new Set(); sl.options.forEach((o) => { if (!isObj(o) || !isStr(o.id) || !o.id || !isStr(o.v) || o.v.length > LIMITS.optionLen) E_(ww + ' 選項要有 id 與字串 v（≤' + LIMITS.optionLen + ' 字）'); else { if (oid.has(o.id)) E_(ww + ' 選項 id 重複：' + o.id); oid.add(o.id); const pr = scanPython(o.v); pr.forEach((p) => E_(ww + ' 選項 ' + o.id + '：' + p)); } });
            });
            if (prod > LIMITS.combos) E_(w + ' 的槽位組合有 ' + prod + ' 個，超過上限 ' + LIMITS.combos + '（沙盒會逐個試，太多會變慢）');
            const factNames = new Set(); (s.facts || []).forEach((f, j) => { if (!isObj(f) || !isStr(f.name) || !NAME_RE.test(f.name) || !isStr(f.re)) { E_(w + '.facts[' + j + '] 要有 name 與 re'); return; } try { new RegExp(f.re); } catch (_) { E_(w + '.facts[' + j + '].re 不是合法的正規式'); } if (f.re.length > 200 || /(\.\*|\+|\*)\)?[+*]/.test(f.re)) E_(w + '.facts[' + j + '].re 太複雜或有巢狀重複（可能卡住）'); factNames.add(f.name); });
            if (Array.isArray(s.lines)) for (const l of s.lines) for (const m of l.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
                const r = m[1]; let okRef = false;
                if (/^c\.[A-Za-z_]\w*$/.test(r)) okRef = slotIds.has(r.slice(2)); else if (/^N\.(sc|ls|s|L)\.\d+$/.test(r) || r === 'N.g') okRef = true; else if (/^fact\.[A-Za-z_]\w*$/.test(r)) okRef = factNames.has(r.slice(5));
                if (!okRef) E_(w + ' 引用了不存在的 {{' + r + '}}');
            }
        });
        const fid = new Set(); const items = [];
        fams.forEach((f, i) => {
            const w = 'families[' + i + ']'; if (!isObj(f)) { E_(w + ' 不是物件'); return; }
            if (!isStr(f.id) || !/^[a-z][a-z0-9-]{1,59}$/.test(f.id)) E_(w + '.id 不合法'); else if (fid.has(f.id)) E_(w + '.id 重複'); else fid.add(f.id);
            if (!keys.has(f.algo)) E_(w + '.algo「' + f.algo + '」不在 algos 裡');
            if (f.split !== 'train' && f.split !== 'holdout') E_(w + '.split 要是 train 或 holdout');
            if (!Array.isArray(f.statements) || !f.statements.length || f.statements.some((x) => !isStr(x) || x.length < 8 || x.length > 2000)) E_(w + '.statements 要是非空的字串陣列');
            if (!isStr(f.ref) || !f.ref.trim()) E_(w + '.ref（Python 參考解）不可空白'); else scanPython(f.ref).forEach((p) => E_(w + '.ref：' + p));
            if (f.want !== undefined && !isStr(f.want)) E_(w + '.want 要是字串');
            if (f.params !== undefined) { if (!isObj(f.params)) E_(w + '.params 要是物件'); else for (const k of Object.keys(f.params)) { if (!/^[A-Za-z_]\w{0,15}$/.test(k) || !Array.isArray(f.params[k]) || !f.params[k].length || f.params[k].length > LIMITS.paramValues || f.params[k].some((x) => !isStr(x) && typeof x !== 'number')) E_(w + '.params.' + k + ' 要是非空的字串／數字陣列'); } }
            validateGen(f.gen, w, E_);
            try { const ex = expandStatements(f); if (ex.length > LIMITS.statementsPerFamily) E_(w + ' 展開出 ' + ex.length + ' 個敘述，超過上限 ' + LIMITS.statementsPerFamily); ex.forEach((x) => items.push({ id: f.id + ':' + x.id, split: f.split, key: norm(x.statement) })); } catch (e) { E_(w + ' 展開失敗：' + e.message); }
        });
        tasks.forEach((t, i) => { const w = 'tasks[' + i + ']'; if (!isObj(t) || !isStr(t.id) || !isStr(t.statement)) { E_(w + ' 要有 id 與 statement'); return; } if (!Array.isArray(t.tests) || t.tests.length < 3 || t.tests.some((x) => !isObj(x) || !isStr(x.in) || !isStr(x.out))) E_(w + '.tests 要至少 3 筆 {in,out}（2 筆顯示、其餘隱藏）'); if (t.solution !== undefined) scanPython(t.solution).forEach((p) => E_(w + '.solution：' + p)); items.push({ id: 'task:' + t.id, split: t.split, key: norm(t.statement) }); });
        checkSplitMix(items, E_, '題目');
        if (spec.judge !== undefined && (!isObj(spec.judge) || !['tokens', 'float', 'exact', 'lines'].includes(spec.judge.checker))) E_('judge.checker 要是 tokens／float／exact／lines');
        if (!fams.some((f) => f.split === 'holdout') && !tasks.some((t) => t.split === 'holdout')) W_('沒有任何 holdout 題：看不出泛化能力（建議至少留 1 個家族或 1 題當 holdout）');
        if (!fams.some((f) => f.split === 'train') && !tasks.some((t) => t.split === 'train')) W_('沒有任何 train 題');
    }
    function validateMatrix(spec, E_, W_) {
        const ops = spec.ops || [], tasks = spec.tasks || [];
        if (!Array.isArray(ops) || !Array.isArray(tasks)) { E_('ops／tasks 要是陣列'); return; } if (ops.length > LIMITS.ops) E_('操作太多'); if (tasks.length > LIMITS.tasks) E_('題目太多');
        if (!ops.length) E_('至少要定義一個操作（ops）');
        const oid = new Set();
        ops.forEach((op, i) => {
            const w = 'ops[' + i + ']'; if (!isObj(op)) { E_(w + ' 不是物件'); return; }
            if (!isStr(op.id) || !/^[a-z][a-z0-9-]{1,39}$/.test(op.id)) E_(w + '.id 不合法'); else if (oid.has(op.id)) E_(w + '.id 重複'); else oid.add(op.id);
            if (!isStr(op.label) || !op.label) E_(w + '.label 不可空白');
            if (op.keywords !== undefined && (!Array.isArray(op.keywords) || op.keywords.some((x) => !isStr(x) || !x))) E_(w + '.keywords 要是字串陣列');
            if (op.layout !== undefined && !['lines', 'line'].includes(op.layout)) E_(w + '.layout 要是 lines 或 line');
            if (op.order !== undefined && !(Number.isInteger(op.order) && op.order >= 1 && op.order <= 89)) E_(w + '.order 要是 1～89 的整數（小的先試；內建遞推 10、自動機 20、範本 40、公式枚舉 90；預設 35）');
            const vars = new Set(); if (!Array.isArray(op.input) || !op.input.length) E_(w + '.input 要是非空陣列'); else op.input.forEach((v) => { if (!isObj(v) || !isStr(v.name) || !NAME_RE.test(v.name) || !['int', 'str', 'ints'].includes(v.type)) E_(w + '.input 的每個變數要有 name 與 type（int／str／ints）'); else { if (vars.has(v.name)) E_(w + '.input 變數重複：' + v.name); vars.add(v.name); } });
            if ((op.layout || 'lines') === 'line' && Array.isArray(op.input) && op.input.some((v) => v.type !== 'int')) E_(w + ' 的 layout:"line" 只能全是 int 變數');
            if (!isObj(op.output) || !['int', 'str', 'ints', 'bool'].includes(op.output.type)) E_(w + '.output.type 要是 int／str／ints／bool');
            const params = op.params || {}; let hyp = 1;
            if (!isObj(params)) E_(w + '.params 要是物件'); else for (const k of Object.keys(params)) { if (!NAME_RE.test(k) || vars.has(k)) E_(w + '.params.' + k + ' 名稱不合法或與輸入變數重複'); const vs = params[k]; if (!Array.isArray(vs) || !vs.length || vs.length > LIMITS.paramValues || vs.some((x) => !Number.isInteger(x) && !isStr(x))) E_(w + '.params.' + k + ' 要是非空的整數／字串陣列（≤' + LIMITS.paramValues + ' 個）'); else hyp *= vs.length; }
            if (hyp > LIMITS.hypotheses) E_(w + ' 的假設空間有 ' + hyp + ' 個，超過上限 ' + LIMITS.hypotheses);
            if (!isStr(op.expr)) E_(w + '.expr 要是字串'); else {
                const pr = Expr.parse(op.expr); if (!pr.ok) E_(w + '.expr：' + pr.error); else {
                    const bad = pr.vars.filter((v) => !vars.has(v) && !Object.prototype.hasOwnProperty.call(params, v)); if (bad.length) E_(w + '.expr 用到沒宣告的變數：' + bad.join('、'));
                    if (pr.ast.t === 'call' && pr.ast.f === 'set') E_(w + '.expr 最外層不可是 set（Python 的集合沒有固定順序）；請用 sorted(set(…))');
                }
            }
        });
        const items = [];
        tasks.forEach((t, i) => {
            const w = 'tasks[' + i + ']'; if (!isObj(t) || !isStr(t.id) || !isStr(t.statement)) { E_(w + ' 要有 id 與 statement'); return; }
            if (t.op !== undefined && !oid.has(t.op)) E_(w + '.op「' + t.op + '」不在 ops 裡');
            const okEx = (a) => Array.isArray(a) && a.every((x) => isObj(x) && isStr(x.in) && isStr(x.out));
            if (!okEx(t.examples) || t.examples.length < 2) E_(w + '.examples 要至少 2 筆 {in,out}（用來擬合）'); if (t.hidden !== undefined && !okEx(t.hidden)) E_(w + '.hidden 要是 {in,out} 陣列');
            if (!(t.hidden || []).length) W_(w + '（' + t.id + '）沒有隱藏範例：擬合結果只能標「沒有被範例以外的資料驗證」');
            items.push({ id: 'task:' + t.id, split: t.split, key: norm(t.statement) });
            if (t.split === 'holdout') { /* 同一組輸入不可同時出現在 train 與 holdout */ }
        });
        checkSplitMix(items, E_, '題目');
        const trainIn = new Set(), hoIn = new Set(); tasks.forEach((t) => { if (!isObj(t) || !Array.isArray(t.examples)) return; for (const e of [].concat(t.examples, t.hidden || [])) if (isObj(e) && isStr(e.in)) (t.split === 'holdout' ? hoIn : trainIn).add(t.op + '\u0001' + e.in.trim()); });
        for (const k of hoIn) if (trainIn.has(k)) { E_('留出題混進訓練：同一個操作的某筆輸入同時出現在 train 與 holdout 範例裡（' + k.split('\u0001')[1].slice(0, 30).replace(/\n/g, '/') + '）'); break; }
        if (!tasks.some((t) => t && t.split === 'holdout')) W_('沒有任何 holdout 題：看不出泛化能力');
        if (!tasks.length) W_('沒有題目：操作定義好了但沒有東西可以評量');
    }

    // ---------- 正規化 ----------
    function normalize(spec) {
        const s = JSON.parse(JSON.stringify(spec)); s.format = FORMAT; s.version = s.version || VERSION; s.meta = s.meta || {};
        if (s.kind === 'blockly') { s.algos = s.algos || []; s.skeletons = s.skeletons || []; s.families = s.families || []; s.tasks = s.tasks || []; s.judge = s.judge || { checker: 'tokens' }; s.skeletons.forEach((k) => { k.paradigm = k.paradigm || 'user-' + s.id; k.slots = k.slots || []; k.facts = k.facts || []; }); s.tasks.forEach((t) => { t.split = t.split || 'train'; }); s.families.forEach((f) => { f.split = f.split || 'train'; }); }
        if (s.kind === 'matrix') { s.ops = s.ops || []; s.tasks = s.tasks || []; s.ops.forEach((o) => { o.level = o.level || 'L4'; o.layout = o.layout || 'lines'; o.params = o.params || {}; }); s.tasks.forEach((t) => { t.split = t.split || 'train'; }); }
        return JSON.parse(stable(s));
    }

    // ---------- 可重現亂數 ----------
    function rng(seedStr) { let h = 2166136261; const s = String(seedStr); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } let a = h >>> 0 || 1; return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; }; }
    const ri = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

    // ---------- 題目展開 ----------
    function expandStatements(fam) {
        const params = fam.params || {}; const names = Object.keys(params).sort(); let combos = [{}];
        for (const n of names) { const nx = []; for (const c of combos) for (const v of params[n]) nx.push(Object.assign({}, c, { [n]: v })); combos = nx; if (combos.length > 5000) throw new Error('參數組合太多'); }
        const out = []; let k = 0;
        for (let si = 0; si < fam.statements.length; si++) for (const c of combos) {
            let st = fam.statements[si]; const used = {};
            st = st.replace(/\{([A-Za-z_]\w*)\}/g, (m, p) => { if (!Object.prototype.hasOwnProperty.call(c, p)) throw new Error('敘述樣板用了沒有的參數 {' + p + '}'); used[p] = c[p]; return String(c[p]); });
            out.push({ id: 's' + si + (names.length ? '-' + (k++) : ''), statement: st, params: used });
        }
        const seen = new Set(); return out.filter((x) => { const kk = norm(x.statement); if (seen.has(kk)) return false; seen.add(kk); return true; });
    }
    function makeInputs(fam, o) {
        o = o || {}; const count = o.count || 6; const out = [];
        for (let t = 0; t < count; t++) {
            const r = rng((o.seed | 0) + '|' + fam.id + '|' + (o.big ? 'big' : 'small') + '|' + t); const env = {}; const lines = [];
            const val = (f) => {
                if (f.int) { const rg = (o.big && f.big) || f.int; const v = ri(r, rg[0], rg[1]); env[f.name] = v; return String(v); }
                const len = (L) => (typeof L === 'number' ? L : Array.isArray(L) ? ri(r, L[0], L[1]) : Number(env[L]));
                if (f.ints) { const n = Math.min(len(f.ints.len), 100000); const a = []; for (let i = 0; i < n; i++) a.push(ri(r, f.ints.range[0], f.ints.range[1])); env[f.name] = n; return a.join(' '); }
                const n = Math.min(len(f.str.len), 100000); let s = ''; for (let i = 0; i < n; i++) s += f.str.alphabet[Math.floor(r() * f.str.alphabet.length)]; return s;
            };
            for (const line of fam.gen) {
                if (Array.isArray(line)) lines.push(line.map(val).join(' '));
                else { const c = typeof line.rows.count === 'number' ? line.rows.count : Number(env[line.rows.count]); for (let i = 0; i < Math.min(c, 5000); i++) lines.push(line.rows.fields.map(val).join(' ')); }
            }
            out.push(lines.join('\n') + '\n');
        }
        return out;
    }
    // 展開成題目：參考解由 runRef 在判題沙盒算答案（runRef(source, input) → {ok,out}|{ok:false,error}）
    async function buildTasks(spec, o) {
        o = o || {}; const tasks = [], problems = [];
        for (const t of spec.tasks || []) if (spec.kind === 'blockly') tasks.push({ id: t.id, family: null, split: t.split, statement: t.statement, solution: t.solution, tests: t.tests });
        if (spec.kind !== 'blockly') return { tasks: (spec.tasks || []).map((t) => ({ id: t.id, op: t.op, split: t.split, statement: t.statement, examples: t.examples, hidden: t.hidden || [] })), problems };
        for (const f of spec.families || []) {
            if (!o.runRef) { problems.push({ family: f.id, error: '沒有判題沙盒（runRef），無法用參考解算答案；解除條件：桌面版並開啟「允許 AI 執行程式」' }); continue; }
            const vis = makeInputs(f, { seed: spec.seed, count: o.tests || 6 }), hid = makeInputs(f, { seed: spec.seed, count: o.hidden || 2, big: true });
            const answer = async (inputs) => { const r = []; for (const inp of inputs) { const a = await o.runRef(f.ref, inp); if (!a || !a.ok || !String(a.out || '').trim()) return null; r.push({ in: inp, out: a.out }); } return r; };
            const tests = await answer(vis), hidden = await answer(hid);
            if (!tests || !hidden) { problems.push({ family: f.id, error: '參考解在產生的輸入上沒有輸出（錯誤或空輸出）' }); continue; }
            for (const x of expandStatements(f)) tasks.push({ id: f.id + ':' + x.id, family: f.id, algo: f.algo, want: f.want || null, split: f.split, statement: x.statement, tests, hidden, params: x.params });
        }
        return { tasks, problems };
    }

    // ---------- 編譯 blockly → 領域包 ----------
    function termRe(list) { return list.map((x) => '(?=[\\s\\S]*' + x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')').join(''); }
    function algoRe(a) { const any = (a.any || []).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); return new RegExp('^' + termRe(a.all || []) + (any.length ? '(?=[\\s\\S]*(?:' + any.join('|') + '))' : ''), 'i'); }
    function vetoRe(a) { const v = (a.veto || []).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); return v.length ? new RegExp(v.join('|'), 'i') : undefined; }
    function renderLine(line, c, N, I, facts) {
        return line.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (m, r) => {
            if (r.startsWith('c.')) { if (!(r.slice(2) in c)) throw new Error('槽位 ' + r.slice(2) + ' 沒有值'); return String(c[r.slice(2)]); }
            if (r.startsWith('fact.')) { const v = facts[r.slice(5)]; if (v === undefined) throw new Error('敘述裡沒讀到：' + r.slice(5)); return String(v); }
            if (r === 'N.g') { if (!N.g) throw new Error('這題沒有網格輸入'); return N.g; }
            const mm = /^N\.(sc|ls|s|L)\.(\d+)$/.exec(r); const arr = N[mm[1]]; const v = arr && arr[Number(mm[2])]; if (v === undefined) throw new Error('這題沒有第 ' + mm[2] + ' 個「' + mm[1] + '」輸入'); return v;
        });
    }
    function readFacts(sk, I) {
        const out = {}; const st = String((I && I.statement) || '');
        for (const f of sk.facts || []) { const m = new RegExp(f.re).exec(st); if (!m) continue; const raw = m[f.group == null ? 1 : f.group]; if (raw == null) continue; out[f.name] = f.as === 'int' ? String(parseInt(raw, 10)) : String(raw); if (f.as === 'int' && !/^-?\d+$/.test(out[f.name])) delete out[f.name]; }
        return out;
    }
    function compileBlockly(spec, PAR) {
        const { S, code } = PAR.dsl; const par = spec.skeletons || [];
        const skeletons = par.map((s) => {
            const slots = (s.slots || []).map((sl) => S(sl.id, sl.label || sl.id, sl.options.map((o) => [o.id, o.v, o.label])));
            const prod = slots.reduce((n, sl) => n * sl.options.length, 1);
            const sk = { id: s.id, paradigm: s.paradigm || 'user-' + spec.id, algo: s.algo, label: s.label, slots, limit: Math.max(prod, 1), userDomain: spec.id,
                py: (c, N, I) => { const facts = readFacts(s, I); return code(s.lines.map((l) => renderLine(l, c, N, I, facts))); } };
            if (s.needs) { const nd = s.needs; sk.shape = (I) => { const cnt = { scalars: 0, lists: 0, strs: 0 }; for (const v of (I && I.vars) || []) { if (v.type === 'list') cnt.lists++; else if (v.type === 'str') cnt.strs++; else cnt.scalars++; } return (nd.scalars == null || cnt.scalars >= nd.scalars) && (nd.lists == null || cnt.lists >= nd.lists) && (nd.strs == null || cnt.strs >= nd.strs); }; }
            return sk;
        });
        const algos = (spec.algos || []).map((a) => Object.assign({ key: a.key, re: algoRe(a), pri: true }, vetoRe(a) ? { veto: vetoRe(a) } : {}));
        const paradigms = {}; for (const s of par) (paradigms[s.algo] = paradigms[s.algo] || []).includes(s.paradigm || 'user-' + spec.id) || paradigms[s.algo].push(s.paradigm || 'user-' + spec.id);
        const seeds = []; // 家族 → 種子題（gen 是函式；只在記憶體，與內建領域包的 seeds 同形）
        for (const f of spec.families || []) { const ex = expandStatements(f); ex.slice(0, 3).forEach((x, i) => seeds.push({ id: f.id + ':' + x.id, st: x.statement, ref: f.ref, want: f.want || undefined, split: f.split, gen: (big, h) => makeInputs(f, { seed: spec.seed + i, count: 1, big: !!big })[0] })); }
        return { id: 'user-' + spec.id, label: spec.label, requires: [], judge: spec.judge || { checker: 'tokens' }, algos, paradigms, skeletons, seeds, userDomain: true };
    }

    // ---------- 矩陣層操作 ----------
    function parseInput(op, text) {
        const lines = String(text).replace(/\s+$/, '').split('\n'); const env = {}; const layout = op.layout || 'lines';
        if (layout === 'line') { const t = (lines[0] || '').trim().split(/\s+/); if (lines.length !== 1 || t.length !== op.input.length || t.some((x) => !/^-?\d+$/.test(x))) return null; op.input.forEach((v, i) => { env[v.name] = BigInt(t[i]); }); return env; }
        if (lines.length !== op.input.length) return null;
        for (let i = 0; i < op.input.length; i++) {
            const v = op.input[i], l = lines[i];
            if (v.type === 'int') { if (!/^\s*-?\d+\s*$/.test(l)) return null; env[v.name] = BigInt(l.trim()); }
            else if (v.type === 'str') env[v.name] = l.replace(/\r$/, '').trim();
            else { const t = l.trim() === '' ? [] : l.trim().split(/\s+/); if (t.some((x) => !/^-?\d+$/.test(x))) return null; env[v.name] = t.map((x) => BigInt(x)); }
        }
        return env;
    }
    function assignments(op) { // 參數笛卡兒積（鍵排序，穩定）
        const names = Object.keys(op.params || {}).sort(); let acc = [{}];
        for (const n of names) { const nx = []; for (const a of acc) for (const v of op.params[n]) { nx.push(Object.assign({}, a, { [n]: v })); if (nx.length > LIMITS.hypotheses) return nx; } acc = nx; }
        return acc;
    }
    const pyConst = (v) => (typeof v === 'number' ? String(v) : JSON.stringify(String(v)));
    function opSource(op, asg) {
        const L = ['def main():'];
        if ((op.layout || 'lines') === 'line') L.push('    ' + op.input.map((v) => v.name).join(', ') + ' = map(int, input().split())' + (op.input.length === 1 ? '' : ''));
        else for (const v of op.input) L.push('    ' + v.name + ' = ' + (v.type === 'int' ? 'int(input())' : v.type === 'str' ? 'input().strip()' : 'list(map(int, input().split()))'));
        if ((op.layout || 'lines') === 'line' && op.input.length === 1) L[1] = '    ' + op.input[0].name + ' = int(input().split()[0])';
        for (const k of Object.keys(asg).sort()) L.push('    ' + k + ' = ' + pyConst(asg[k]));
        L.push('    r = ' + op.expr);
        const o = op.output; L.push(o.type === 'bool' ? '    print(' + JSON.stringify(o.yes != null ? String(o.yes) : 'yes') + ' if r else ' + JSON.stringify(o.no != null ? String(o.no) : 'no') + ')' : o.type === 'ints' ? "    print(' '.join(map(str, list(r))))" : o.type === 'int' ? '    print(int(r))' : '    print(r)');
        return L.join('\n') + '\n';
    }
    function evalOp(op, asg, env, E_) {
        const full = Object.assign({}, env); for (const k of Object.keys(asg)) full[k] = typeof asg[k] === 'number' ? BigInt(asg[k]) : asg[k];
        const r = E_.evaluate(op.expr, full); if (!r.ok) return r;
        try { return { ok: true, out: E_.format(r.value, op.output.type, op.output) }; } catch (e) { return { ok: false, error: e.message }; }
    }
    function fitOp(op, examples, E_, o) {
        o = o || {}; const parsed = [];
        for (const ex of examples) { const env = parseInput(op, ex.in); if (!env) return { ok: false, reason: '範例輸入的形狀不符操作 ' + op.id + ' 的 input 宣告', tried: 0 }; parsed.push({ env, out: String(ex.out).trim() }); }
        const all = assignments(op); const hits = []; let tried = 0, firstErr = '';
        for (const asg of all) {
            tried++; let good = true;
            for (const p of parsed) { const r = evalOp(op, asg, p.env, E_); if (!r.ok) { if (!firstErr) firstErr = r.error; good = false; break; } if (r.out.trim() !== p.out) { good = false; break; } }
            if (good) { hits.push(asg); if (hits.length >= (o.maxAlternatives || 40)) break; }
        }
        if (!hits.length) return { ok: false, reason: '操作 ' + op.id + '：' + tried + ' 個參數組合都對不上範例' + (firstErr ? '（例：' + firstErr + '）' : ''), tried };
        return { ok: true, assignment: hits[0], source: opSource(op, hits[0]), alternatives: hits.slice(1).map((a) => ({ ok: true, assignment: a, source: opSource(op, a), ambiguous: true })), ambiguous: hits.length > 1, tried };
    }
    function replay(op, asg, input, E_) { const env = parseInput(op, input); if (!env) return { ok: false, error: '輸入形狀不符' }; return evalOp(op, asg, env, E_); }
    function compileMatrix(spec, E_) {
        E_ = E_ || Expr;
        return (spec.ops || []).map((op) => {
            const name = 'user:' + spec.id + '/' + op.id;
            const fn = async (a) => {
                const st = String(a.statement || '').toLowerCase();
                if ((op.keywords || []).length && !op.keywords.some((k) => st.includes(String(k).toLowerCase()))) return { ok: false, reason: '敘述沒有出現操作 ' + op.id + ' 的關鍵詞（' + op.keywords.join('／') + '）', tried: 0 };
                const r = fitOp(op, a.examples || [], E_);
                if (!r.ok) return r;
                const mk = (x) => ({ ok: true, source: x.source, kind: 'user-op', level: op.level || 'L4', size: op.expr.length, tried: r.tried, ambiguous: !!x.ambiguous, desc: '使用者操作「' + op.label + '」：' + op.expr + (Object.keys(x.assignment).length ? '，參數 ' + JSON.stringify(x.assignment) : ''), matrixForm: { kind: 'user-op', name: name }, userOp: { domain: spec.id, op: op.id, assignment: x.assignment } });
                const first = mk({ source: r.source, assignment: r.assignment, ambiguous: r.ambiguous }); first.alternatives = r.alternatives.map(mk); return first;
            };
            return { name, fn, opts: { order: Number.isInteger(op.order) ? op.order : 35, level: op.level || 'L4', note: '使用者領域 ' + spec.id + '：' + op.label } };
        });
    }

    // ---------- 資產檔案 ----------
    const enc = (o) => new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o, null, 1));
    const dec = (u) => new TextDecoder('utf-8').decode(u);
    function toFiles(spec, tasks) {
        const s = normalize(spec); const files = { 'data/domain-spec.json': enc(s) };
        const rows = (tasks || []).map((t) => JSON.stringify(spec.kind === 'matrix' ? { id: t.id, op: t.op, split: t.split, statement: t.statement, examples: t.examples, hidden: t.hidden } : { id: t.id, family: t.family || undefined, split: t.split, statement: t.statement, solution: t.solution, tests: (t.tests || []).concat(t.hidden || []), want: t.want || undefined }));
        files['data/tasks.jsonl'] = enc(rows.join('\n') + (rows.length ? '\n' : ''));
        files['README.txt'] = enc('領域規格 ' + s.id + '（' + s.kind + '，v' + s.version + '）\n' + s.label + '\n授權：' + (s.meta.license || '(未填)') + '\n來源：' + (s.meta.source || '(未填)') + '\n規格雜湊：' + hash(s) + '\n');
        return files;
    }
    function fromFiles(files) {
        const f = files && files['data/domain-spec.json']; if (!f) return { ok: false, error: '資產裡沒有 data/domain-spec.json（不是領域規格資產）' };
        let spec; try { spec = JSON.parse(dec(f)); } catch (e) { return { ok: false, error: 'domain-spec.json 不是合法的 JSON：' + e.message }; }
        return { ok: true, spec };
    }
    function summary(spec) {
        const s = spec; const c = { holdout: 0, train: 0 }; const cnt = (x) => { c[x.split === 'holdout' ? 'holdout' : 'train']++; };
        if (s.kind === 'blockly') { (s.tasks || []).forEach(cnt); (s.families || []).forEach((f) => { const n = (() => { try { return expandStatements(f).length; } catch (_) { return 0; } })(); c[f.split === 'holdout' ? 'holdout' : 'train'] += n; }); return { kind: 'blockly', algos: (s.algos || []).length, skeletons: (s.skeletons || []).length, families: (s.families || []).length, train: c.train, holdout: c.holdout }; }
        (s.tasks || []).forEach(cnt); return { kind: 'matrix', ops: (s.ops || []).length, train: c.train, holdout: c.holdout };
    }
    return { FORMAT, VERSION, LIMITS, validate, normalize, hash, stable, scanPython, expandStatements, makeInputs, buildTasks, compileBlockly, compileMatrix, fitOp, replay, parseInput, opSource, toFiles, fromFiles, summary, algoRe };
});
