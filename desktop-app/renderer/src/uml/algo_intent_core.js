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
    const INT_WORDS = /整數|面額|查詢|數字|價值|重量/; const FLOAT_WORDS = /小數|實數|取樣值|取樣點|振幅/; const STR_WORDS = /單字|字串|字元|文字/;
    // 動作表：關鍵字（中文）→ 目的。recipe 是「語言中立的配方」：which＝作用在哪一種輸入（list／words／str）、op＝要做的運算
    const GOALS = [
        { key: /最大值|最大的|最大總/, op: 'max', which: ['list'] }, { key: /最小值|最小的/, op: 'min', which: ['list'] }, { key: /總和|的和|加總/, op: 'sum', which: ['list'] },
        { key: /順序反過來|反過來|反轉/, op: 'reverse', which: ['words', 'str'] }, { key: /排序|由大到小|由小到大/, op: 'sort', which: ['list', 'words'] },
        { key: /迴文/, op: 'palindrome', which: ['str'] }, { key: /質數/, op: 'primes', which: [] }, { key: /最大公因數|gcd/, op: 'gcd', which: [] }, { key: /費氏/, op: 'fib', which: [] },
        { key: /最少|最短|最長|個數|幾個|次數|連通分量/, op: 'search', which: [] },
    ];
    // 動作表（算法種類）：敘述的關鍵字 → 這題屬於哪一種算法。語言中立；各語言的區塊白名單（FOCUS）用這個 key 查。由具體到籠統，第一個符合的算數
    const ALGOS = [
        // 通用補充（2026-11-06，依基準失敗原因分群補的；由具體到籠統）：遞推／封閉式／字串自動機／圖／數論／堆疊佇列字串
        { key: 'linear-rec', re: /[A-Za-z]\(n\)\s*=\s*[^。]*[A-Za-z]\(n\s*-\s*\d+\)|每次(?:可以)?爬\s*[\d、或,，\s]+階|鋪滿\s*2\s*[×xX*]\s*n/ },
        { key: 'series-sum', re: /1(?:\^[23]|[²³])?\s*\+\s*2(?:\^[23]|[²³])?\s*\+\s*(?:…|\.\.\.|⋯)\s*\+\s*n/ }, { key: 'tri-area', re: /三角形面積/ }, { key: 'order-stat', re: /中間大|中位數|夾在|輸入(?:兩|三|四|五)個整數.*由[小大]到[大小]/ },
        { key: 'string-dfa', re: /能被\s*\d+\s*整除|不含連續|含有連續|出現(?:偶|奇)數次|以\s*["「“][^"」”]+["」”]\s*(?:結尾|開頭)|子字串\s*["「“]|個數除以\s*\d+\s*的餘數|整數.*除以\s*\d+\s*的餘數/ },
        { key: 'walks-k', re: /走恰好\s*\w+\s*步/ }, { key: 'grid-paths', re: /只能向右或向下/ }, { key: 'closure-queries', re: /是否能走到|能否走到/ }, { key: 'conn-queries', re: /是否連通/ }, { key: 'reach-count', re: /能到達的點數|可以到達的點數/ },
        { key: 'binom', re: /\bC\(\s*n\s*,\s*k\s*\)|二項式係數/ }, { key: 'coin-ways', re: /組合數/ }, { key: 'in-degree', re: /入度|出度/ }, { key: 'topo', re: /拓撲序/ },
        { key: 'collatz', re: /3n\s*\+\s*1/ }, { key: 'digit-sum', re: /各位數字的(?:和|積)|數位和/ }, { key: 'isqrt', re: /r\s*\*\s*r\s*≤|整數平方根/ }, { key: 'power-mod', re: /a\^e\s*mod|模冪/ }, { key: 'count-divisors', re: /因數個數|因數的和|因數和/ }, { key: 'trailing-zeros', re: /末尾有幾個\s*0/ }, { key: 'bit-count', re: /二進位表示中\s*[01]\s*的個數/ },
        { key: 'cmd-sim', re: /(?:push|enq)\s*x/ }, { key: 'rpn', re: /後序.*運算式|逆波蘭/ }, { key: 'max-depth', re: /巢狀最大深度|最大深度/ }, { key: 'next-greater', re: /右邊第一個比它大/ }, { key: 'valid-tags', re: /標籤.*配對/ }, { key: 'str-reverse', re: /反轉後的字串/ },
        { key: 'word-top', re: /出現最多次的單字/ }, { key: 'caesar', re: /往(?:後|前)移\s*k\s*位|凱薩/ }, { key: 'rle', re: /連續相同字元壓縮/ }, { key: 'roman', re: /羅馬數字/ }, { key: 'sort-list', re: /由小到大(?:輸出|排序)|去重後/ },
        { key: 'inversions', re: /逆序對/ }, { key: 'n-queens', re: /皇后/ }, { key: 'dijkstra', re: /最短距離|加權.*最短|Dijkstra/i }, { key: 'fenwick', re: /樹狀陣列|線段樹|單點.*(修改|更新)|把\s*a\[\w+\]\s*加上/ }, { key: 'str-match', re: /KMP|出現的次數|出現幾次|出現的位置/ }, { key: 'tree-traversal', re: /走訪/ }, { key: 'kth-smallest', re: /第\s*[a-zA-Z]\s*小/ }, { key: 'lps', re: /回文子序列/ }, { key: 'lcs', re: /公共子序列|LCS/ },
        { key: 'palindrome', re: /迴文/ }, { key: 'anagram', re: /重新排列|變位詞|字母異位/ }, { key: 'brackets', re: /括號.*(配對|匹配)/ }, { key: 'gcd-lcm', re: /gcd|lcm|最大公因數|最小公倍數/i },
        { key: 'fib', re: /費氏/ }, { key: 'primes', re: /質數/ }, { key: 'kth-largest', re: /由大到小.*第\s*[a-zA-Z]\s*個|第\s*[a-zA-Z]\s*(大|個)/ }, { key: 'word-count', re: /每個不同的單字|單字.*次數|次數.*單字/ },
        { key: 'lower-bound', re: /第一個滿足.*(>=|≥|大於等於)|二分|lower_bound/ }, { key: 'pair-sum', re: /i\s*<\s*j.*a\[i\]\s*\+\s*a\[j\]|兩數之和|兩數相加等於/ }, { key: 'range-sum', re: /a\[\w+\.\.\w+\]|區間.*(和|總和)|每個查詢輸出.*和/ },
        { key: 'coin-min', re: /硬幣|面額/ }, { key: 'lis', re: /遞增子序列/ }, { key: 'grid-bfs', re: /最少步數|最短路|最少幾步/ }, { key: 'components', re: /連通分量|連通塊/ }, { key: 'intervals-merge', re: /合併.*區間|區間.*合併|重疊.*合併/ }, { key: 'knapsack', re: /每件物品最多選一次|背包/ },
        { key: 'reverse-words', re: /單字順序反過來/ }, { key: 'list-max', re: /最大值/ }, { key: 'list-min', re: /最小值/ }, { key: 'list-sum', re: /總和|的和/ },
    ];
    // 處理模型（範式）：算法種類 → 它屬於哪些解題範式（分治、DFS、BFS、樹走訪、資料結構對應、動態規劃、矩陣相乘…）。一種算法可以有多個範式（例如費氏數：DP 或矩陣快速冪）。
    // 之後的「範式骨架」（每個範式一個帶槽位的區塊骨架）用這個 key 查；新題只要套到某個範式、填幾個槽位，不必每題各教一堂課。
    const PARADIGMS = {
        'fib': ['dynamic-programming', 'matrix-power'], 'n-queens': ['backtracking'], 'dijkstra': ['shortest-path', 'heap'], 'fenwick': ['fenwick-tree', 'segment-tree'], 'str-match': ['kmp', 'string'], 'inversions': ['divide-and-conquer'], 'tree-traversal': ['tree-traversal', 'dfs'], 'kth-smallest': ['heap', 'data-structure-mapping'], 'lps': ['dynamic-programming', 'interval-dp'], 'lcs': ['dynamic-programming', '2d-dp'], 'coin-min': ['dynamic-programming'], 'lis': ['dynamic-programming'], 'knapsack': ['dynamic-programming'],
        'grid-bfs': ['bfs'], 'components': ['dfs', 'union-find'], 'lower-bound': ['divide-and-conquer', 'binary-search'], 'range-sum': ['prefix-sum', 'data-structure-mapping'],
        'word-count': ['data-structure-mapping'], 'brackets': ['data-structure-mapping'], 'intervals-merge': ['sort-and-sweep'], 'pair-sum': ['brute-force'], 'kth-largest': ['sort'],
        'primes': ['sieve', 'number-theory'], 'gcd-lcm': ['number-theory', 'divide-and-conquer'], 'palindrome': ['two-pointers', 'string'], 'anagram': ['data-structure-mapping', 'string'],
    };
    Object.assign(PARADIGMS, { 'linear-rec': ['dynamic-programming', 'matrix-power'], 'series-sum': ['closed-form'], 'tri-area': ['geometry'], 'order-stat': ['sort'], 'string-dfa': ['finite-automaton'], 'walks-k': ['matrix-power', 'dynamic-programming'], 'grid-paths': ['dynamic-programming'], 'closure-queries': ['dfs', 'transitive-closure'], 'conn-queries': ['union-find', 'dfs'], 'reach-count': ['dfs', 'bfs'], 'binom': ['combinatorics'], 'coin-ways': ['dynamic-programming'], 'in-degree': ['data-structure-mapping'], 'topo': ['topological-sort', 'heap'], 'collatz': ['simulation'], 'digit-sum': ['number-theory'], 'isqrt': ['number-theory', 'binary-search'], 'power-mod': ['number-theory', 'fast-power'], 'count-divisors': ['number-theory'], 'trailing-zeros': ['number-theory'], 'bit-count': ['bit-manipulation'], 'cmd-sim': ['data-structure-mapping'], 'rpn': ['stack'], 'max-depth': ['stack'], 'next-greater': ['monotonic-stack'], 'valid-tags': ['stack'], 'str-reverse': ['string'], 'word-top': ['data-structure-mapping'], 'caesar': ['string'], 'rle': ['string'], 'roman': ['string'], 'sort-list': ['sort'] });
    const toNum = (s) => (/^\d+$/.test(s) ? +s : CN[s] || 0);
    const stripNote = (s) => String(s).replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');

    // 從敘述抽出「參數」（語言中立）：骨架的槽位外還需要的題目參數（模數、遞推式、字串條件、yes/no 字樣…）。抽不到就不給，骨架自己判斷（缺了就不渲染）
    const parseBig = (t) => { const x = String(t).replace(/\s/g, ''); if (/^10\^9\+7$|^1e9\+7$|^1000000007$/i.test(x)) return 1000000007; if (/^998244353$/.test(x)) return 998244353; if (/^10\^9\+9$/.test(x)) return 1000000009; const p = /^10\^(\d+)$/.exec(x); if (p) return Math.pow(10, +p[1]); return /^\d+$/.test(x) ? +x : 0; };
    function extractFacts(text) {
        const f = {}; const t = String(text);
        const yn2 = /(?:印|輸出)\s*([A-Za-z]+)\s*[，,]\s*(?:否則|不然|其餘)\s*(?:印|輸出)?\s*([A-Za-z]+)/.exec(t); const y = /\b(yes|YES|Yes)\b/.exec(t), n = /\b(no|NO|No)\b/.exec(t); if (yn2) f.yn = [yn2[1], yn2[2]]; else if (y && n) f.yn = [y[1], n[1]];
        const nn = /沒有則輸出\s*(-?\d+|[A-Za-z]+)/.exec(t); if (nn) f.none = nn[1]; const ur = /(?:到不了|不可達|無法到達|走不到|不存在)[^，。]*輸出\s*(-?\d+|[A-Za-z]+)/.exec(t); if (ur) f.unreach = ur[1];
        const em = /(?:空時|為空時)輸出\s*([A-Za-z]+)/.exec(t); if (em) f.empty = em[1];
        const subs = []; let mm; const qre = /["“「]([A-Za-z0-9]+)["”」]/g; while ((mm = qre.exec(t))) subs.push(mm[1]);
        const run = /連續(兩|二|三|四)個\s*([A-Za-z0-9])/.exec(t); if (run) subs.push(run[2].repeat({ 兩: 2, 二: 2, 三: 3, 四: 4 }[run[1]])); if (subs.length) f.subs = subs;
        const ch = /([A-Za-z0-9])\s*出現(?:偶|奇)數次/.exec(t) || /([A-Za-z0-9])\s*的個數/.exec(t); if (ch) f.chr = ch[1];
        const md = /除以\s*(10\s*\^\s*9\s*\+\s*7|10\s*\^\s*9\s*\+\s*9|998244353|1000000007|\d+)\s*(?:的餘數|取餘|的餘)/.exec(t) || /被\s*(\d+)\s*整除/.exec(t) || /\bmod\s*(\d+)/i.exec(t); if (md) { const v = parseBig(md[1]); if (v) f.mod = v; }
        // 遞推：F(n)=c1F(n-1)+c2F(n-2)+…（係數可省略）＋初值 F(0)=… ；爬樓梯（每次爬 1、2 或 3 階）；2×n 鋪磚
        const rm = /([A-Za-z])\(n\)\s*=\s*([^。，]*?)(?=。|，|$|輸入)/.exec(t.replace(/，/g, '，'));
        if (rm) { const nm = rm[1]; const coef = []; const tre = new RegExp('(?:(\\d+)\\s*\\*?\\s*)?' + nm + '\\(n\\s*-\\s*(\\d+)\\)', 'g'); let tm, ok = rm[2].trim().length > 0; const rest = rm[2].replace(tre, (_a, c, d) => { const k = +d; while (coef.length < k) coef.push(0); coef[k - 1] += c ? +c : 1; return ''; }); if (/[^\s+]/.test(rest)) ok = false;
            const init = {}; const ire = new RegExp(nm + '\\((\\d+)\\)\\s*=\\s*(-?\\d+)', 'g'); while ((tm = ire.exec(t))) init[+tm[1]] = +tm[2]; const K = coef.length; const iv = []; for (let i = 0; i < K; i++) { if (init[i] == null) ok = false; iv.push(init[i]); }
            if (ok && K) f.rec = { coef, init: iv };
        } else {
            const st = /每次(?:可以)?爬\s*([\d、或,，\s]+)階/.exec(t);
            if (st) { const steps = (st[1].match(/\d+/g) || []).map(Number); const K = Math.max.apply(null, steps); const coef = new Array(K).fill(0); steps.forEach((x) => { coef[x - 1] = 1; }); const g = [1]; for (let i = 1; i < K; i++) { let v = 0; for (let j = 0; j < K; j++) if (coef[j] && i - 1 - j >= 0) v += g[i - 1 - j]; g.push(v); } f.rec = { coef, init: g };
            } else if (/鋪滿\s*2\s*[×xX*]\s*n/.test(t)) f.rec = { coef: [1, 1], init: [1, 1] };
        }
        if (f.rec && f.mod) f.rec.mod = f.mod; else if (f.rec && /餘數|取模|mod/i.test(t) && !f.mod) f.rec.mod = 1000000007;
        return f;
    }
    function read(statement) {
        const text = String(statement || '').trim(); const inputs = []; const names = new Set(); let strCount = 0;
        const addNames = (ns) => ns.forEach((n) => names.add(n));
        // 切成子句：句號、逗號、分號、冒號都切；括號註解先拿掉（不然「（0<=n<=90）」會干擾）
        const clauses = stripNote(text.replace(/只含\s*\S+\s*的/g, '只含括號的')).split(/[。，,；;：:]+/).map((c) => c.trim()).filter(Boolean);
        let m; let seenOutput = false; let rowsN = 0; const rowName = () => (rowsN++ ? 'rows' + rowsN : 'rows');
        for (let i = 0; i < clauses.length; i++) {
            const c = clauses[i]; if (/^(輸出|求|找出|判斷|把|只看|對每個|每個|若|保證|有多組)/.test(c)) { seenOutput = true; }
            if (seenOutput) continue;
            if ((m = /^輸入(?:一行)?(兩|三|四|五)個(?:正)?整數$/.exec(c))) { const ns = 'abcde'.slice(0, { 兩: 2, 三: 3, 四: 4, 五: 5 }[m[1]]).split(''); inputs.push({ k: 'scalars', names: ns, type: 'int', line: true }); addNames(ns); continue; } // 輸入三個整數（沒有名字：a b c）
            if ((m = new RegExp('^(?:接著|再|然後|之後)\\s*(' + NAME + ')\\s*行字元').exec(c))) { inputs.push({ k: 'grid', count: m[1], width: null, name: 'g' }); addNames(['g']); continue; } // 接著 n 行字元 "." 或 "#"
            if ((m = new RegExp('^(?:接著|再|然後|之後)\\s*(' + NAME + ')\\s*行(?:指令|操作)$').exec(c))) { inputs.push({ k: 'grid', count: m[1], width: null, name: 'g' }); addNames(['g']); continue; } // 之後 q 行指令（每行一個字串，由程式自己拆）
            if ((m = new RegExp('^(?:接著|再|然後|之後)\\s*(' + NAME + ')\\s*行\\s*(' + NAMES + ')(?:\\s*(?:表示|代表).*)?$').exec(c))) { const ns = m[2].split(/\s+/); const rn_ = rowName(); inputs.push({ k: 'rows', count: m[1], names: ns, name: rn_ }); addNames([rn_]); continue; } // 接著 m 行 a b／再 q 行 x y
            if ((m = new RegExp('^輸入(?:一行)?(?:(?:兩|三|四|五)個)?(?:正)?(整數|小數)\\s*(' + NAMES + ')$').exec(c))) { const ns = m[2].split(/\s+/); inputs.push({ k: 'scalars', names: ns, type: m[1] === '小數' ? 'float' : 'int', line: true }); addNames(ns); continue; }
            if ((m = new RegExp('^接著\\s*(' + NAME + ')\\s*行(?:每行|各)\\s*(.+)$').exec(c))) {
                const cnt = m[1]; const rest = m[2].trim(); let g;
                if ((g = new RegExp('^(' + NAME + ')\\s*個字元').exec(rest))) { inputs.push({ k: 'grid', count: cnt, width: g[1], name: 'g' }); addNames(['g']); continue; }
                const rn = new RegExp('^(' + NAMES + ')(?:\\s*(?:表示|代表).*)?$').exec(rest); if (rn) { const ns = rn[1].split(/\s+/); const rn_ = rowName(); inputs.push({ k: 'rows', count: cnt, names: ns, name: rn_ }); addNames([rn_]); continue; }
            }
            if ((m = new RegExp('^第([一二三四五六七八九\\d]+)行\\s*(' + NAME + ')\\s*(?:個|種)(.*)$').exec(c))) { // 第二行 n 個整數／第三行 q 個查詢 x
                const tail = m[3]; const nm = (new RegExp('(?:查詢|每個|記為|稱為)\\s*(' + NAME + ')\\s*$').exec(tail) || [])[1];
                const isStr = STR_WORDS.test(tail) && !INT_WORDS.test(tail); const isFloat = !isStr && FLOAT_WORDS.test(tail) && !INT_WORDS.test(tail); const listName = nm || (isStr ? 'w' : 'a'); inputs.push({ k: 'list', name: listName, size: m[2], elem: isStr ? 'str' : isFloat ? 'float' : 'int' }); addNames([listName, m[2]]); continue;
            }
            if ((m = new RegExp('^第([一二三四五六七八九\\d]+)行(?:一個|兩個|三個|四個|五個|六個)?小數\\s*(' + NAMES + ')$').exec(c))) { const ns = m[2].split(/\s+/); inputs.push({ k: 'scalars', names: ns, type: 'float', line: true }); addNames(ns); continue; } // 第二行小數 alpha／第二行五個小數 b0 b1 b2 a1 a2
            if ((m = new RegExp('^第([一二三四五六七八九\\d]+)行(?:一個|兩個|三個|四個)?(?:正)?(?:整數)?\\s*(' + NAMES + ')$').exec(c))) { const ns = m[2].split(/\s+/); inputs.push({ k: 'scalars', names: ns, type: 'int', line: true }); addNames(ns); continue; }
            if ((m = new RegExp('^輸入\\s*(' + NAME + ')$').exec(c))) { inputs.push({ k: 'scalars', names: [m[1]], type: 'int', line: true }); addNames([m[1]]); continue; }
            if (/^由若干單字組成/.test(c) && inputs.length && inputs[inputs.length - 1].k === 'pending') { inputs[inputs.length - 1] = { k: 'words', name: 'w' }; addNames(['w']); continue; }
            if (/^輸入一行$/.test(c)) { inputs.push({ k: 'pending' }); continue; }
            if (/^輸入一行.*單字/.test(c)) { inputs.push({ k: 'words', name: 'w' }); addNames(['w']); continue; }
            if ((m = /^輸入(一|兩|二)行(?:小寫)?(?:字串|文字)$/.exec(c))) { const cnt = m[1] === '一' ? 1 : 2; for (let j = 0; j < cnt; j++) { const nm = strCount++ === 0 ? 's' : 't'; inputs.push({ k: 'str', name: nm }); addNames([nm]); } continue; }
            if (/^輸入一行.*(字串|文字)/.test(c)) { inputs.push({ k: 'str', name: 's' }); addNames(['s']); continue; }
            if (new RegExp('^第([一二三四五六七八九\\d]+)行(?:小寫|大寫)?(?:英文)?(?:字串|文字)$').test(c)) { inputs.push({ k: 'str', name: 's' }); addNames(['s']); continue; } // 第二行小寫英文字串
            if ((m = new RegExp('^第([一二三四五六七八九\\d]+)行\\s*(' + NAME + ')\\s*(?:與|和)\\s*[^a-zA-Z\\s]*\\s*(' + NAME + ')$').exec(c))) { inputs.push({ k: 'scalars', names: [m[2], m[3]], type: 'int', line: true }); addNames([m[2], m[3]]); continue; } // 第一行 k 與目標 t
            if ((m = new RegExp('^第([一二三四五六七八九\\d]+)行[^a-zA-Z0-9]{1,8}\\s*(' + NAMES + ')$').exec(c))) { const ns = m[2].split(/\s+/); inputs.push({ k: 'scalars', names: ns, type: 'int', line: true }); addNames(ns); continue; } // 第一行偏移量 k
            if (/^輸入(?:一行|一個)?[^，]*?(?:字串|文字|羅馬數字)$/.test(c) || /^輸入一個很長的.*整數$/.test(c)) { inputs.push({ k: 'str', name: 's' }); addNames(['s']); continue; } // 輸入一個由 0、1 組成的字串／輸入小寫字串／輸入一個很長的非負整數（以字串給）
            if (/^輸入(?:一行)?以空格分隔的/.test(c)) { inputs.push({ k: 'words', name: 'w' }); addNames(['w']); continue; } // 輸入以空格分隔的後序運算式
            if ((m = new RegExp('^輸入[^a-zA-Z0-9]{0,14}?\\s*(' + NAMES + ')$').exec(c)) && !/小數|字串|文字/.test(c)) { const ns = m[1].split(/\s+/); inputs.push({ k: 'scalars', names: ns, type: 'int', line: true }); addNames(ns); continue; } // 輸入 a e m／輸入三個點的整數座標 x1 y1 x2 y2 x3 y3
        }
        if (!inputs.length) { const im = /(?:≤|<=)\s*([a-z][a-z0-9]{0,3})\s*(?:≤|<=)/.exec(text); if (im) { inputs.push({ k: 'scalars', names: [im[1]], type: 'int', line: true }); addNames([im[1]]); } } // 沒寫「輸入」只在範圍裡出現變數（爬到第 n 階（1≤n≤80））：一個整數
        // ---- 輸出 ----
        const goal = { verbs: [], yesno: /YES\s*(?:或|或者)\s*NO|YES，否則|輸出\s*YES/.test(text) };
        const om = /輸出\s*([^，。；;\n（(]+)/.exec(stripNote(text));
        if (om) { // 「輸出 a+b」：敘述裡直接寫了運算式
            const raw = om[1].trim().replace(/[　]/g, ' '); if (/^[a-z0-9_+\-*/%() .]+$/.test(raw) && /[a-z]/.test(raw) && /[+\-*/%]/.test(raw)) { const used = raw.match(/[a-z][a-z0-9]*/g) || []; if (used.every((u) => names.has(u))) goal.expr = raw; }
        }
        if (!goal.expr) { // 敘述裡的運算式夾在文字中間（輸出華氏溫度 c*9/5+32，無條件捨去…）：找第一段含變數的運算式；有「捨去」就把 / 當整數除法
            const seg = (/輸出([^。]*)/.exec(stripNote(text)) || [])[1] || ''; const em2 = /[a-z0-9_]+(?:\s*[+\-*/%]\s*[a-z0-9_]+)+/.exec(seg);
            if (em2 && /[a-z]/.test(em2[0])) { const used = em2[0].match(/[a-z][a-z0-9]*/g) || []; if (used.every((u) => names.has(u))) goal.expr = /捨去|向下取整|整數部分|取整/.test(seg) ? em2[0].replace(/\//g, '//') : em2[0]; }
        }
        for (const g of GOALS) if (g.key.test(text)) goal.verbs.push(g.op);
        const algo = (ALGOS.find((a) => a.re.test(text)) || {}).key || null; const paradigms = (algo && PARADIGMS[algo]) || [];
        const pend = inputs.findIndex((x) => x.k === 'pending'); if (pend >= 0) inputs.splice(pend, 1);
        const vars = []; for (const inp of inputs) { if (inp.k === 'scalars') inp.names.forEach((n) => vars.push({ name: n, type: inp.type })); else if (inp.k === 'list') { if (!vars.some((v) => v.name === inp.size)) vars.push({ name: inp.size, type: 'int' }); vars.push({ name: inp.name, type: 'list' }); } else if (inp.k === 'rows') vars.push({ name: inp.name, type: 'list' }); else if (inp.k === 'grid') vars.push({ name: inp.name, type: 'list' }); else if (inp.k === 'str') vars.push({ name: inp.name, type: 'str' }); else if (inp.k === 'words') vars.push({ name: inp.name, type: 'list' }); }
        // 同一個名稱在不同行出現（第一行 n，第二行 n 個…）只留一個
        const seen = new Set(); const uvars = vars.filter((v) => (seen.has(v.name) ? false : seen.add(v.name)));
        return { ok: inputs.length > 0, algo, paradigms, inputs, vars: uvars, goal, facts: extractFacts(text), statement: text, ops: [{ name: 'readInput', params: [], returns: 'any' }, { name: 'solve', params: uvars.map((v) => v.name), returns: 'void' }] };
    }
    const UMLTYPE = { int: 'int', float: 'float', str: 'str', list: 'List<any>' };
    function umlHints(intent) {
        if (!intent || !intent.ok) return { actors: [], usecases: [], classes: [], relations: [], unknown: [] };
        const solve = { name: 'solve', params: intent.vars.map((v) => ({ name: v.name, type: UMLTYPE[v.type] || 'any' })), returns: 'void' };
        const cls = { name: 'Solver', kind: 'class', label: '解題程式', attrs: [], ops: [{ name: 'main', params: [], returns: 'void' }, { name: 'readInput', params: [], returns: 'any' }, solve] };
        return { actors: ['User'], classes: [cls], relations: [], unknown: [], usecases: [{ name: 'RunSolver', actor: 'User', summary: '讀入資料並輸出答案', steps: [{ to: 'Solver', op: 'main' }, { to: 'Solver', op: 'readInput' }, { to: 'Solver', op: 'solve' }] }] };
    }
    const reader = (statement) => { const it = read(statement); return it.ok ? Object.assign(umlHints(it), { intent: it }) : null; };
    // 領域包（domain pack）註冊：新領域的算法種類插在最前面（領域詞彙比通用詞彙具體），並補上它的範式對照
    function addAlgos(list, paradigms) { const have = new Set(ALGOS.map((x) => x.key)); const fresh = (list || []).filter((x) => !have.has(x.key)); ALGOS.unshift(...fresh); Object.assign(PARADIGMS, paradigms || {}); return fresh.length; }
    return { read, umlHints, reader, GOALS, ALGOS, PARADIGMS, addAlgos };
});
