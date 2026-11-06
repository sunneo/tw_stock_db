/* 算法題的「程式讀情境」：把題目敘述（中文）用規則讀成結構，不問模型。純函式 UMD，語言中立（輸出的是意圖，不是某種語言的程式）。
 * 接在 uml_design 的「程式先讀情境」入口（uml_core 的 opts.readers）：算法題讀得出來，整份 UML 設計由程式決定（模型 0 次呼叫）。
 *
 *   read(statement) → { ok, inputs:[…], vars:[{name,type}], goal:{ expr?, verbs:[…], yesno?, lines? }, ops:[…] }
 *     inputs 的種類：
 *       {k:'scalars', names:[..]}            一行幾個整數（第一行 n t）
 *       {k:'list', name, size, elem}         一行 size 個 elem（整數／文字）
 *       {k:'rows', count, names, name}       接著 count 行，每行幾個整數（l r）
 *       {k:'grid', count, name}              接著 count 行，每行一個字串（網格）
 *       {k:'str', name} {k:'words', name}    一行字串／一行由單字組成
 *   umlHints(intent) → 跟 uml_core.scenarioHints 同形狀（actors／usecases／classes／relations／unknown），給 uml_design 用
 *   reader(statement) → hints | null        直接放進 uml_design 的 opts.readers
 *
 * 詞彙（資料，可擴充）：NUM（一二三…）、ELEM（整數／面額／查詢→int；單字／字元→str）、GOALS（動作表：中文動詞或名詞 → 配方）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaAlgoIntent = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const NAME = '[a-zA-Z][a-z0-9]{0,4}'; const NAMES = NAME + '(?:\\s+' + NAME + ')*';
    const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const INT_WORDS = /整數|面額|查詢|數字|價值|重量/; const STR_WORDS = /單字|字串|字元|文字/;
    // 動作表：關鍵字（中文）→ 目的。recipe 是「語言中立的配方」：which＝作用在哪一種輸入（list／words／str）、op＝要做的運算
    const GOALS = [
        { key: /最大值|最大的|最大總/, op: 'max', which: ['list'] }, { key: /最小值|最小的/, op: 'min', which: ['list'] }, { key: /總和|的和|加總/, op: 'sum', which: ['list'] },
        { key: /順序反過來|反過來|反轉/, op: 'reverse', which: ['words', 'str'] }, { key: /排序|由大到小|由小到大/, op: 'sort', which: ['list', 'words'] },
        { key: /迴文/, op: 'palindrome', which: ['str'] }, { key: /質數/, op: 'primes', which: [] }, { key: /最大公因數|gcd/, op: 'gcd', which: [] }, { key: /費氏/, op: 'fib', which: [] },
        { key: /最少|最短|最長|個數|幾個|次數|連通分量/, op: 'search', which: [] },
    ];
    const toNum = (s) => (/^\d+$/.test(s) ? +s : CN[s] || 0);
    const stripNote = (s) => String(s).replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');

    function read(statement) {
        const text = String(statement || '').trim(); const inputs = []; const names = new Set(); let strCount = 0;
        const addNames = (ns) => ns.forEach((n) => names.add(n));
        // 切成子句：句號、逗號、分號、冒號都切；括號註解先拿掉（不然「（0<=n<=90）」會干擾）
        const clauses = stripNote(text.replace(/只含\s*\S+\s*的/g, '只含括號的')).split(/[。，,；;：:]+/).map((c) => c.trim()).filter(Boolean);
        let m; let seenOutput = false;
        for (let i = 0; i < clauses.length; i++) {
            const c = clauses[i]; if (/^(輸出|求|找出|判斷|把|只看|對每個|每個|若|保證|有多組)/.test(c)) { seenOutput = true; }
            if (seenOutput) continue;
            if ((m = new RegExp('^輸入(?:一行)?(?:(?:兩|三|四|五)個)?(?:正)?(整數|小數)\\s*(' + NAMES + ')$').exec(c))) { const ns = m[2].split(/\s+/); inputs.push({ k: 'scalars', names: ns, type: m[1] === '小數' ? 'float' : 'int', line: true }); addNames(ns); continue; }
            if ((m = new RegExp('^接著\\s*(' + NAME + ')\\s*行(?:每行|各)\\s*(.+)$').exec(c))) {
                const cnt = m[1]; const rest = m[2].trim(); let g;
                if ((g = new RegExp('^(' + NAME + ')\\s*個字元').exec(rest))) { inputs.push({ k: 'grid', count: cnt, width: g[1], name: 'g' }); addNames(['g']); continue; }
                const rn = new RegExp('^(' + NAMES + ')(?:\\s*(?:表示|代表).*)?$').exec(rest); if (rn) { const ns = rn[1].split(/\s+/); inputs.push({ k: 'rows', count: cnt, names: ns, name: 'rows' }); addNames(['rows']); continue; }
            }
            if ((m = new RegExp('^第([一二三四五六七八九\\d]+)行\\s*(' + NAME + ')\\s*(?:個|種)(.*)$').exec(c))) { // 第二行 n 個整數／第三行 q 個查詢 x
                const tail = m[3]; const nm = (new RegExp('(?:查詢|每個)\\s*(' + NAME + ')\\s*$').exec(tail) || [])[1];
                const isStr = STR_WORDS.test(tail) && !INT_WORDS.test(tail); const listName = nm || (isStr ? 'w' : 'a'); inputs.push({ k: 'list', name: listName, size: m[2], elem: isStr ? 'str' : 'int' }); addNames([listName, m[2]]); continue;
            }
            if ((m = new RegExp('^第([一二三四五六七八九\\d]+)行(?:一個|兩個|三個|四個)?(?:正)?(?:整數)?\\s*(' + NAMES + ')$').exec(c))) { const ns = m[2].split(/\s+/); inputs.push({ k: 'scalars', names: ns, type: 'int', line: true }); addNames(ns); continue; }
            if ((m = new RegExp('^輸入\\s*(' + NAME + ')$').exec(c))) { inputs.push({ k: 'scalars', names: [m[1]], type: 'int', line: true }); addNames([m[1]]); continue; }
            if (/^由若干單字組成/.test(c) && inputs.length && inputs[inputs.length - 1].k === 'pending') { inputs[inputs.length - 1] = { k: 'words', name: 'w' }; addNames(['w']); continue; }
            if (/^輸入一行$/.test(c)) { inputs.push({ k: 'pending' }); continue; }
            if (/^輸入一行.*單字/.test(c)) { inputs.push({ k: 'words', name: 'w' }); addNames(['w']); continue; }
            if ((m = /^輸入(一|兩|二)行(?:小寫)?(?:字串|文字)$/.exec(c))) { const cnt = m[1] === '一' ? 1 : 2; for (let j = 0; j < cnt; j++) { const nm = strCount++ === 0 ? 's' : 't'; inputs.push({ k: 'str', name: nm }); addNames([nm]); } continue; }
            if (/^輸入一行.*(字串|文字)/.test(c)) { inputs.push({ k: 'str', name: 's' }); addNames(['s']); continue; }
        }
        // ---- 輸出 ----
        const goal = { verbs: [], yesno: /YES\s*(?:或|或者)\s*NO|YES，否則|輸出\s*YES/.test(text) };
        const om = /輸出\s*([^，。；;\n（(]+)/.exec(stripNote(text));
        if (om) { // 「輸出 a+b」：敘述裡直接寫了運算式
            const raw = om[1].trim().replace(/[　]/g, ' '); if (/^[a-z0-9_+\-*/%() .]+$/.test(raw) && /[a-z]/.test(raw) && /[+\-*/%]/.test(raw)) { const used = raw.match(/[a-z][a-z0-9]*/g) || []; if (used.every((u) => names.has(u))) goal.expr = raw; }
        }
        for (const g of GOALS) if (g.key.test(text)) goal.verbs.push(g.op);
        const pend = inputs.findIndex((x) => x.k === 'pending'); if (pend >= 0) inputs.splice(pend, 1);
        const vars = []; for (const inp of inputs) { if (inp.k === 'scalars') inp.names.forEach((n) => vars.push({ name: n, type: inp.type })); else if (inp.k === 'list') { if (!vars.some((v) => v.name === inp.size)) vars.push({ name: inp.size, type: 'int' }); vars.push({ name: inp.name, type: 'list' }); } else if (inp.k === 'rows') vars.push({ name: inp.name, type: 'list' }); else if (inp.k === 'grid') vars.push({ name: inp.name, type: 'list' }); else if (inp.k === 'str') vars.push({ name: inp.name, type: 'str' }); else if (inp.k === 'words') vars.push({ name: inp.name, type: 'list' }); }
        // 同一個名稱在不同行出現（第一行 n，第二行 n 個…）只留一個
        const seen = new Set(); const uvars = vars.filter((v) => (seen.has(v.name) ? false : seen.add(v.name)));
        return { ok: inputs.length > 0, inputs, vars: uvars, goal, ops: [{ name: 'readInput', params: [], returns: 'any' }, { name: 'solve', params: uvars.map((v) => v.name), returns: 'void' }] };
    }
    const UMLTYPE = { int: 'int', float: 'float', str: 'str', list: 'List<any>' };
    function umlHints(intent) {
        if (!intent || !intent.ok) return { actors: [], usecases: [], classes: [], relations: [], unknown: [] };
        const solve = { name: 'solve', params: intent.vars.map((v) => ({ name: v.name, type: UMLTYPE[v.type] || 'any' })), returns: 'void' };
        const cls = { name: 'Solver', kind: 'class', label: '解題程式', attrs: [], ops: [{ name: 'main', params: [], returns: 'void' }, { name: 'readInput', params: [], returns: 'any' }, solve] };
        return { actors: ['User'], classes: [cls], relations: [], unknown: [], usecases: [{ name: 'RunSolver', actor: 'User', summary: '讀入資料並輸出答案', steps: [{ to: 'Solver', op: 'main' }, { to: 'Solver', op: 'readInput' }, { to: 'Solver', op: 'solve' }] }] };
    }
    const reader = (statement) => { const it = read(statement); return it.ok ? Object.assign(umlHints(it), { intent: it }) : null; };
    return { read, umlHints, reader, GOALS };
});
