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
    const NAME = '[a-zA-Z][a-z0-9]{0,4}'; const NAMES = NAME + '(?:[\\s、]+' + NAME + ')*';
    const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const INT_WORDS = /整數|面額|查詢(?!字串|單字|文字)|數字|價值|重量/; const FLOAT_WORDS = /小數|實數|取樣值|取樣點|振幅/; const STR_WORDS = /單字|字串|字元|文字/;
    // 動作表：關鍵字（中文）→ 目的。recipe 是「語言中立的配方」：which＝作用在哪一種輸入（list／words／str）、op＝要做的運算
    const GOALS = [
        { key: /最大值|最大的|最大總/, op: 'max', which: ['list'] }, { key: /最小值|最小的/, op: 'min', which: ['list'] }, { key: /總和|的和|加總/, op: 'sum', which: ['list'] },
        { key: /順序反過來|反過來|反轉/, op: 'reverse', which: ['words', 'str'] }, { key: /排序|由大到小|由小到大/, op: 'sort', which: ['list', 'words'] },
        { key: /迴文/, op: 'palindrome', which: ['str'] }, { key: /質數/, op: 'primes', which: [] }, { key: /最大公因數|gcd/, op: 'gcd', which: [] }, { key: /費氏/, op: 'fib', which: [] },
        { key: /最少|最短|最長|個數|幾個|次數|連通分量/, op: 'search', which: [] },
    ];
    // 動作表（算法種類）：敘述的關鍵字 → 這題屬於哪一種算法。語言中立；各語言的區塊白名單（FOCUS）用這個 key 查。由具體到籠統，第一個符合的算數
    // 否決條件（G17）：工具型題目（霍夫曼合併、Delta 還原、位元組…）即使撞到通用關鍵字（總和、第 i 個）也不是通用算法題，不給通用骨架；用於 ALGOS 條目的 veto 欄
    const TOOLISH = /霍夫曼|合併|編碼|解碼|還原|位元組|位元數|十六進位|過濾器|碼長/;
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
        { key: 'fib', re: /費氏/ }, { key: 'primes', re: /質數/ }, { key: 'kth-largest', re: /由大到小.*第\s*[a-zA-Z]\s*個|第\s*[a-zA-Z]\s*大/, veto: TOOLISH }, { key: 'word-count', re: /每個不同的單字|單字.*次數|次數.*單字/ },
        { key: 'lower-bound', re: /第一個滿足.*(>=|≥|大於等於)|二分|lower_bound/ }, { key: 'pair-sum', re: /i\s*<\s*j.*a\[i\]\s*\+\s*a\[j\]|兩數之和|兩數相加等於/ }, { key: 'range-sum', re: /a\[\w+\.\.\w+\]|區間.*(和|總和)|每個查詢輸出.*和/ },
        { key: 'coin-min', re: /硬幣|面額/ }, { key: 'lis', re: /遞增子序列/ }, { key: 'grid-bfs', re: /最少步數|最短路|最少幾步/ }, { key: 'components', re: /連通分量|連通塊/ }, { key: 'intervals-merge', re: /合併.*區間|區間.*合併|重疊.*合併/ }, { key: 'knapsack', re: /每件物品最多選一次|背包/ },
        { key: 'reverse-words', re: /單字順序反過來/ }, { key: 'list-max', re: /最大值/, veto: TOOLISH }, { key: 'list-min', re: /最小值/, veto: TOOLISH }, { key: 'list-sum', re: /總和|的和/, veto: TOOLISH },
    ];

    // 工具型題目的算法種類（G1）：形狀（輸入區的種類組合）＋敘述關鍵字；先於通用 ALGOS 判斷。sh(inputs) 是形狀條件
    const has = (ins, k, role) => ins.some((x) => x.k === k && (!role || x.role === role));
    // 同一個領域的算法種類（工具型題目）：其中一個命中時，其餘當候選，骨架全試、沙盒擇一，避免因敘述措辭（中序／中綴、傾印／dump…）沒抓到就整題放棄
    const TOOL_FAMILIES = [['infix-rpn', 'infix-eval', 'rpn-eval', 'lexer-expr'], ['crc32', 'adler32', 'gzip-member'], ['hex-encode', 'bits-expand', 'hex-decode', 'xxd-dump'], ['bmp-header', 'bmp-gray', 'bmp-read8', 'bmp-read1', 'bmp-pixel', 'bmp-stride'], ['tar-checksum', 'tar-write', 'tar-parse', 'tar-offsets', 'tar-blocks'], ['canonical-huffman', 'huffman-cost'], ['pattern-match', 'lines-filter'], ['lines-map', 'lines-filter']];
    const TOOLS = [
        { key: 'exec-env', re: /\$\{?\w+\}?|環境變數|展開/, sh: (ins) => has(ins, 'lines') && !ins.some((x) => x.role) },
        { key: 'vm-exec', re: /虛擬機|PUSH|指令集|直譯器/, sh: (ins) => ins.some((x) => x.k === 'lines' || x.k === 'grid') },
        { key: 'bmp-read1', re: /1\s*位元\s*BMP|單色|1-bit/i, sh: (ins) => ins.length === 1 && has(ins, 'hex') },
        { key: 'bmp-pixel', re: /BMP/, sh: (ins) => has(ins, 'hex') && (has(ins, 'lines') || has(ins, 'scalars')) },
        { key: 'xz-header', re: /xz|魔術/i, sh: (ins) => ins.length === 1 && has(ins, 'hex') },
        { key: 'xxd-dump', re: /傾印|dump|每\s*16\s*(?:個)?位元組/i, sh: (ins) => ins.length === 1 && has(ins, 'hex') },
        { key: 'canonical-huffman', re: /範式|canonical|碼長/i, sh: (ins) => has(ins, 'list') },
        { key: 'gzip-member', re: /gzip|\.gz|DEFLATE|stored|未壓縮/i, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'tar-write', re: /tar|ustar|封存檔/i, sh: (ins) => ins.length <= 2 && ins.every((x) => x.k === 'str') },
        { key: 'tar-blocks', re: /tar|封存檔|區塊/i, sh: (ins) => (has(ins, 'scalars') || has(ins, 'str')) && !has(ins, 'hex') && !has(ins, 'lines') && !has(ins, 'list') },
        { key: 'bmp-stride', re: /stride|BMP/i, sh: (ins) => (has(ins, 'scalars') || has(ins, 'str')) && !has(ins, 'hex') && !has(ins, 'rest') && !has(ins, 'lines') },
        { key: 'pipeline', re: /管線|\|/, sh: (ins) => ins.some((x) => x.k === 'str' && x.role === 'pl') && has(ins, 'lines') },
        { key: 'pattern-match', re: /任一字元|代表任意|任意長度|glob|regex|正規|Kernighan|完全符合|\^\s*\$/i, sh: (ins) => has(ins, 'str', 'pat') && has(ins, 'lines') },
        { key: 'assign-env', re: /賦值|變數名稱|環境/, sh: (ins) => has(ins, 'lines') && !ins.some((x) => x.role) },
        { key: 'lexer-expr', re: /(?:整數|數字)輸出\s*[A-Za-z]+\s*:/, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'shell-args', re: /命令列|argv|shell/i, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'infix-rpn', re: /(?:中序|中綴|算式|infix)[^。]*(?:後序|後綴|postfix|RPN)|調度場|shunting/i, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'rpn-eval', re: /後序|逆波蘭|RPN/i, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'infix-eval', re: /(?:求值|計算)[^。]*(?:括號|算式)|(?:括號|算式)[^。]*(?:求值|計算|結果)/, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'gunzip-stored', re: /gzip\s*成員/i, sh: (ins) => ins.length === 1 && has(ins, 'hex') },
        { key: 'inflate-fixed', re: /固定霍夫曼|BTYPE\s*=\s*01/, sh: (ins) => ins.length === 1 && has(ins, 'hex') },
        { key: 'tar-parse', re: /ustar|tar/i, sh: (ins) => ins.length === 1 && has(ins, 'hex') },
        { key: 'bmp-header', re: /(?:width|height|bpp|offset)\s*=/i, sh: (ins) => ins.length === 1 && has(ins, 'hex') },
        { key: 'bmp-gray', re: /BMP[\s\S]*灰階|灰階/, sh: (ins) => ins.length === 1 && has(ins, 'hex') },
        { key: 'bmp-read8', re: /BMP[\s\S]*調色盤|8 位元 BMP/, sh: (ins) => ins.length === 1 && has(ins, 'hex') },
        { key: 'bmp-write24', re: /BMP/, sh: (ins) => has(ins, 'rest') },
        { key: 'lzma-literals', re: /LZMA|範圍編碼/, sh: (ins) => has(ins, 'hex') && has(ins, 'scalars') },
        { key: 'tar-checksum', re: /檢查碼|chksum/, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'tar-offsets', re: /標頭.*位移|tar/i, sh: (ins) => has(ins, 'lines') && !ins.some((x) => x.role) },
        { key: 'xxd-reverse', re: /xxd|傾印/, sh: (ins) => has(ins, 'lines') && !ins.some((x) => x.role) },
        { key: 'deflate-stored', re: /未壓縮區塊|stored/i, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'adler32', re: /Adler/i, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'crc32', re: /CRC/i, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'base64', re: /base64/i, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'lz77', re: /LZ77|<L\s*,\s*d>/, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'endian-pack', re: /小端|大端/, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'rle-pair', re: /^(?![\s\S]*(?:解碼|還原|展開|解壓))[\s\S]*(?:行程長度|連續相同字元)/, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'bits-expand', re: /ASCII[^。]*二進位|二進位[^。]*(?:高位在前|低位在前)|\d+\s*位二進位/, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'hex-encode', re: /每個位元組.*十六進位|兩位.*十六進位|十六進位/, sh: (ins) => ins.length === 1 && has(ins, 'str') },
        { key: 'varint', re: /多位元組整數|varint|LEB128/i, sh: (ins) => !ins.some((x) => x.role) },
        { key: 'bit-reader', re: /位元序|由最低位元|位元欄位/, sh: (ins) => has(ins, 'hex') && has(ins, 'list') },
        { key: 'delta-filter', re: /Delta\s*(?:解碼|編碼|過濾器|filter)|位元組值/i, sh: (ins) => has(ins, 'scalars') && has(ins, 'list') },
        { key: 'huffman-cost', re: /霍夫曼|Huffman/i, sh: (ins) => has(ins, 'list') && !has(ins, 'hex') },
        { key: 'hex-decode', re: /(?:還原|解碼|轉回).{0,6}文字|還原成.{0,4}字串|xxd\s*-r/, sh: (ins) => ins.length === 1 && has(ins, 'hex') },
        { key: 'lines-grep-o', re: /grep\s*-o|不重疊|每個出現/, sh: (ins) => has(ins, 'lines') && has(ins, 'str', 'pat') },
        { key: 'lines-filter', re: /grep|含有|包含|搜尋字串|符合/, sh: (ins) => has(ins, 'lines') && has(ins, 'str', 'pat') },
        { key: 'lines-map', re: /行號|Tab|行尾|空行|連接|串接|每行|檔案|連續編號/, sh: (ins) => has(ins, 'lines') && !ins.some((x) => x.role) },
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
        const h8 = t.match(/0x[0-9A-Fa-f]{8}/g); if (h8) f.hex8 = h8; const hx = '(0x[0-9A-Fa-f]{8})'; const pm = new RegExp('多項式\\s*' + hx).exec(t), im = new RegExp('初值\\s*' + hx).exec(t), fm = new RegExp('(?:與|和)\\s*' + hx + '\\s*(?:互斥或|XOR)|互斥或\\s*' + hx, 'i').exec(t); if (pm || im || fm) f.crc = { poly: pm && pm[1], init: im && im[1], fin: fm && (fm[1] || fm[2]) }; // 敘述裡的 8 位十六進位常數（CRC 的多項式、初值、結尾互斥或…依出現順序）
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

    // ---- 工具型題目（cat／grep／xxd／tar／gzip／xz／bmp…）的輸入形狀：文字行串流、十六進位位元組、旗標行、多段 ----
    // 只看「輸入區」（開頭連續以 輸入／第N行／接著／再 起頭的句子），逐子句分類成：hex（單行十六進位）、str（一行原樣文字，含樣式 pat／旗標 flags）、
    // scalars（一行整數）、list（一行 k 個整數／一串整數）、lines（n 行原樣文字，行內容不丟）、rest（其餘所有行，行數由第一行決定）。
    const ZONE_START = /^(?:輸入|第[一二三四五六七八九\d]+(?:行|份|段|個)|接下來|接著|緊接著|隨後|最後(?=\s*(?:[一二兩\d]+|[a-z][a-z0-9]{0,4})\s*行)|再接著|再來|再|然後|之後)/;
    function readToolInput(text) {
        const sents = stripNote(String(text)).split(/。/).map((x) => x.trim()).filter(Boolean); const zone = [];
        for (const s of sents) { if (ZONE_START.test(s)) zone.push(s); else break; }
        if (!zone.length) { for (const s of sents) { if (/^(?:輸出|依序|對每|仿|求|把)/.test(s)) break; zone.push(s); } } // 輸入描述不是開頭句時：取第一個動作句之前的所有句子
        if (!zone.length) return null;
        const clauses = zone.join('，').split(/[，,；;：:]+/).map((c) => c.trim()).filter(Boolean); const out = []; const used = { s: 0, h: 0, lines: 0 };
        const nm = (k) => { const i = used[k]++; return k === 'lines' ? (i ? 'lines' + (i + 1) : 'lines') : k === 'h' ? (i ? 'h' + (i + 1) : 'h') : (i ? 't' : 's'); };
        let m;
        const A_RE = new RegExp('(?:接下來|接著|緊接著|隨後|再給|再來|然後|之後|最後|再)\\s*(' + NAME + ')\\s*行');
        const one = (c) => { // 一個子句（已拿掉「輸入」）→ 0～1 個輸入描述
            const head = /^(?:再來|再給|再|然後|接下來|接著|緊接著|隨後|之後|最後)?\s*(?:[^，，]{0,6}?第[一二三四五六七八九\d]+行|[一二兩]行)\s*(?:是|為)?\s*(.*)$/.exec(c); if (!head) return null; const d = head[1].trim(); let m;
            if (/十六進位/.test(d)) return { k: 'hex', name: nm('h') };
            if (/^base64|^[Bb]ase\s*64/.test(d)) return { k: 'str', name: nm('s'), raw: true };
            if (/^pat$/.test(d)) return { k: 'str', name: 'pat', raw: true, role: 'pat' };
            if (/^一串/.test(d) && !new RegExp('^一串[^a-zA-Z]*' + NAME).test(d)) return { k: 'list', name: 'a', size: null, elem: 'int' };
            if ((m = /^(?:搜尋字串|樣式|旗標|管線)\s*([a-z][a-z0-9]*)?/.exec(d))) { const nmx = m[1] || (/旗標/.test(d) ? 'flags' : /管線/.test(d) ? 'pl' : 'pat'); return { k: 'str', name: nmx, raw: true, role: /旗標/.test(d) ? 'flags' : /管線/.test(d) ? 'pl' : 'pat' }; }
            if (/^「[^」]*\s[^」]*」/.test(d)) return { k: 'str', name: nm('s'), raw: true };
            if ((m = new RegExp('^一串[^a-zA-Z]*(' + NAME + ')(?:\\s+' + NAME + ')*').exec(d))) return { k: 'list', name: m[1].replace(/\d+$/, '') || 'w', size: null, elem: 'int' };
            if ((m = new RegExp('^(' + NAME + ')\\s*個').exec(d))) return { k: 'list', name: 'a', size: m[1], elem: 'int' };
            if ((m = new RegExp('^[^a-zA-Z0-9]{0,8}?\\s*(' + NAME + ')$').exec(d)) && !/字串|文字/.test(d)) return { k: 'scalars', names: [m[1]], type: 'int', line: true };
            if ((m = new RegExp('^[^a-zA-Z0-9]{0,8}?\\s*(' + NAME + ')\\s*\\(?[^a-zA-Z]*$').exec(d)) && /^[a-z]/.test(m[1]) && !/字串|文字|算式|命令列|後序/.test(d)) return { k: 'scalars', names: [m[1]], type: 'int', line: true };
            if (/以空白分隔|若干|多個|一串/.test(d) && /整數|數字|數值/.test(d)) return { k: 'list', name: 'a', size: null, elem: 'int' };
            if (/字串|文字|算式|命令列|後序|記號|式$|行$/.test(d) || /^只含|^由/.test(d)) return { k: 'str', name: nm('s'), raw: true };
            if (d && !/^[a-z0-9\s]+$/i.test(d)) return { k: 'str', name: nm('s'), raw: true }; // 其餘「第N行是某某」：整行原樣（由範式自己解讀）
            return null;
        };
        for (let c of clauses) {
            c = c.replace(/^輸入(?=第|一行|(?:一|兩|二)行)/, '').replace(/^輸入\s*/, ''); if (!c) continue; let m;
            if (!/^(?:再來|再給|再|然後|接下來|接著|緊接著|隨後|之後|最後)?\s*[一二兩]行/.test(c) && (m = new RegExp('^(?:接下來|接著|緊接著|隨後|然後|之後|最後|再接著|再來|再)\\s*(' + NAME + '|[一-龥]{1,2})\\s*行').exec(c))) { out.push({ k: /^[a-zA-Z]/.test(m[1]) ? 'lines' : 'rest', count: /^[a-zA-Z]/.test(m[1]) ? m[1] : null, name: nm('lines'), raw: true }); continue; }
            const mA = A_RE.exec(c); const pre = mA ? c.slice(0, mA.index) : c; const r = pre.trim() ? one(pre.trim()) : null; if (r) out.push(r);
            if (mA) out.push({ k: 'lines', count: mA[1], name: nm('lines'), raw: true });
        }
        // 第一行只是個名稱（沒寫「樣式」「搜尋字串」）：若敘述把它當比對的字串用（含有 x、找出 x、x 的出現），它是樣式字串，不是整數
        if (out.some((x) => x.k === 'lines') && out[0] && out[0].k === 'scalars') { const v = out[0].names[0]; if (new RegExp('(?:含有?|包含|找出|搜尋|比對|符合)\\s*' + v + '(?![a-z0-9])|(?<![a-z0-9])' + v + '\\s*(?:的(?:所有)?(?:「?不重疊」?)?出現|本身)').test(text)) out[0] = { k: 'str', name: v, raw: true, role: 'pat' }; }
        return out.length ? out : null;
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
            if ((m = new RegExp('^(?:接下來|接著|緊接著|隨後|然後|之後|最後|再接著|再來|再)\\s*(' + NAME + ')\\s*行字元').exec(c))) { inputs.push({ k: 'grid', count: m[1], width: null, name: 'g' }); addNames(['g']); continue; } // 接著 n 行字元 "." 或 "#"
            if ((m = new RegExp('^(?:接下來|接著|緊接著|隨後|然後|之後|最後|再接著|再來|再)\\s*(' + NAME + ')\\s*行(?:指令|操作|事件|動作)$').exec(c))) { inputs.push({ k: 'grid', count: m[1], width: null, name: 'g' }); addNames(['g']); continue; } // 之後 q 行指令（每行一個字串，由程式自己拆）
            if ((m = new RegExp('^(?:接下來|接著|緊接著|隨後|然後|之後|最後|再接著|再來|再)\\s*(' + NAME + ')\\s*行\\s*(' + NAMES + ')(?:\\s*(?:表示|代表).*)?$').exec(c))) { const ns = m[2].split(/[\s、]+/); const rn_ = rowName(); inputs.push({ k: 'rows', count: m[1], names: ns, name: rn_ }); addNames([rn_]); continue; } // 接著 m 行 a b／再 q 行 x y
            if ((m = new RegExp('^輸入(?:一行)?(?:(?:兩|三|四|五)個)?(?:正)?(整數|小數)\\s*(' + NAMES + ')$').exec(c))) { const ns = m[2].split(/[\s、]+/); inputs.push({ k: 'scalars', names: ns, type: m[1] === '小數' ? 'float' : 'int', line: true }); addNames(ns); continue; }
            if ((m = new RegExp('^接著\\s*(' + NAME + ')\\s*行(?:每行|各)\\s*(.+)$').exec(c))) {
                const cnt = m[1]; const rest = m[2].trim(); let g;
                if ((g = new RegExp('^(' + NAME + ')\\s*個字元').exec(rest))) { inputs.push({ k: 'grid', count: cnt, width: g[1], name: 'g' }); addNames(['g']); continue; }
                const rn = new RegExp('^(' + NAMES + ')(?:\\s*(?:表示|代表).*)?$').exec(rest); if (rn) { const ns = rn[1].split(/[\s、]+/); const rn_ = rowName(); inputs.push({ k: 'rows', count: cnt, names: ns, name: rn_ }); addNames([rn_]); continue; }
            }
            if ((m = new RegExp('^第([一二三四五六七八九\\d]+)行\\s*(' + NAME + ')\\s*(?:個|種)(.*)$').exec(c))) { // 第二行 n 個整數／第三行 q 個查詢 x
                const tail = m[3]; const nm = (new RegExp('(?:查詢|每個|記為|稱為)\\s*(' + NAME + ')\\s*$').exec(tail) || [])[1];
                const isStr = STR_WORDS.test(tail) && !INT_WORDS.test(tail); const isFloat = !isStr && FLOAT_WORDS.test(tail) && !INT_WORDS.test(tail); const freshName = (cands) => cands.find((x) => !names.has(x)) || cands[0] + '2'; const listName = nm || (isStr ? freshName(['w', 'w2', 'w3']) : freshName(['a', 'b', 'c', 'd'])); inputs.push({ k: 'list', name: listName, size: m[2], elem: isStr ? 'str' : isFloat ? 'float' : 'int' }); addNames([listName, m[2]]); continue;
            }
            if ((m = new RegExp('^第([一二三四五六七八九\\d]+)行(?:一個|兩個|三個|四個|五個|六個)?小數\\s*(' + NAMES + ')$').exec(c))) { const ns = m[2].split(/[\s、]+/); inputs.push({ k: 'scalars', names: ns, type: 'float', line: true }); addNames(ns); continue; } // 第二行小數 alpha／第二行五個小數 b0 b1 b2 a1 a2
            if ((m = new RegExp('^第([一二三四五六七八九\\d]+)行(?:有|是|為)?(?:一個|兩個|三個|四個)?(?:正)?(?:整數)?\\s*(' + NAMES + ')$').exec(c))) { const ns = m[2].split(/[\s、]+/); inputs.push({ k: 'scalars', names: ns, type: 'int', line: true }); addNames(ns); continue; }
            if ((m = new RegExp('^輸入\\s*(' + NAME + ')$').exec(c))) { inputs.push({ k: 'scalars', names: [m[1]], type: 'int', line: true }); addNames([m[1]]); continue; }
            if (/^由若干單字組成/.test(c) && inputs.length && inputs[inputs.length - 1].k === 'pending') { inputs[inputs.length - 1] = { k: 'words', name: 'w' }; addNames(['w']); continue; }
            if (/^輸入一行$/.test(c)) { inputs.push({ k: 'pending' }); continue; }
            if (/^輸入一行.*單字/.test(c)) { inputs.push({ k: 'words', name: 'w' }); addNames(['w']); continue; }
            if ((m = /^輸入(一|兩|二)行(?:小寫)?(?:字串|文字)$/.exec(c))) { const cnt = m[1] === '一' ? 1 : 2; for (let j = 0; j < cnt; j++) { const nm = strCount++ === 0 ? 's' : 't'; inputs.push({ k: 'str', name: nm }); addNames([nm]); } continue; }
            if (/^輸入一行.*(字串|文字)/.test(c)) { inputs.push({ k: 'str', name: 's' }); addNames(['s']); continue; }
            if (new RegExp('^第([一二三四五六七八九\\d]+)行(?:小寫|大寫)?(?:英文)?(?:字串|文字)$').test(c)) { inputs.push({ k: 'str', name: 's' }); addNames(['s']); continue; } // 第二行小寫英文字串
            if ((m = new RegExp('^第([一二三四五六七八九\\d]+)行\\s*(' + NAME + ')\\s*(?:與|和)\\s*[^a-zA-Z\\s]*\\s*(' + NAME + ')$').exec(c))) { inputs.push({ k: 'scalars', names: [m[2], m[3]], type: 'int', line: true }); addNames([m[2], m[3]]); continue; } // 第一行 k 與目標 t
            if ((m = new RegExp('^第([一二三四五六七八九\\d]+)行[^a-zA-Z0-9]{1,8}\\s*(' + NAMES + ')$').exec(c))) { const ns = m[2].split(/[\s、]+/); inputs.push({ k: 'scalars', names: ns, type: 'int', line: true }); addNames(ns); continue; } // 第一行偏移量 k
            if ((m = /^輸入(?:一行|一個)?[^，]*?(?:字串|文字|羅馬數字)(?:\s*([a-z][a-z0-9]{0,3}))?$/.exec(c)) || /^輸入一個很長的.*整數$/.test(c)) { const sn = (m && m[1]) || 's'; inputs.push({ k: 'str', name: sn }); addNames([sn]); continue; } // 輸入一個由 0、1 組成的字串／輸入小寫字串／輸入一個很長的非負整數（以字串給）
            if (/^輸入(?:一行)?以空格分隔的/.test(c)) { inputs.push({ k: 'words', name: 'w' }); addNames(['w']); continue; } // 輸入以空格分隔的後序運算式
            if ((m = new RegExp('^輸入[^a-zA-Z0-9]{0,14}?\\s*(' + NAMES + ')$').exec(c)) && !/小數|字串|文字/.test(c)) { const ns = m[1].split(/[\s、]+/); inputs.push({ k: 'scalars', names: ns, type: 'int', line: true }); addNames(ns); continue; } // 輸入 a e m／輸入三個點的整數座標 x1 y1 x2 y2 x3 y3
        }
        { const ti = readToolInput(text); if (ti && !inputs.some((x) => x.k === 'grid' || x.k === 'rows') && (!inputs.length || ti.some((x) => (x.k === 'list' && x.size === null) || x.k === 'hex' || x.k === 'lines' || x.k === 'rest' || (x.k === 'str' && x.role)))) { const lead = ti.length >= 2 && ti[0].k === 'str' && !ti[0].role && inputs.length >= 1 && inputs[0].k === 'scalars' && inputs[0].line && ti.slice(1).every((x) => x.k === 'lines' || x.k === 'rest' || (x.k === 'list' && x.size)) ? inputs[0] : null; const keep = lead || ti.length >= 1 && ti.every((x) => x.k === 'lines' || x.k === 'rest' || (x.k === 'list' && x.size)) && ti.some((x) => x.k === 'lines' || x.k === 'rest') && inputs.length >= 1 && inputs[0].k === 'scalars' && inputs[0].line ? inputs[0] : null; inputs.length = 0; names.clear(); if (keep) { inputs.push(keep); keep.names.forEach((n) => names.add(n)); } (lead ? ti.slice(1) : ti).forEach((x) => inputs.push(x)); } } // 工具型題目的輸入形狀（文字行串流、十六進位、旗標行、多段）
        if (!inputs.length && /檔案/.test(text) && /行/.test(text) && /連接|串接|接在|依序|行號/.test(text)) { inputs.push({ k: 'rest', count: null, name: 'lines', raw: true, fallback: true }); } // 多段檔案的輸入措辭讀不出來：整份輸入當成行串流，由範式依「行數＋內容」逐段解析
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
        const toolAlgos = TOOLS.filter((a) => a.re.test(text) && a.sh(inputs)).map((a) => a.key).filter((k, i, arr) => arr.indexOf(k) === i); for (const fam of TOOL_FAMILIES) if (toolAlgos.some((k) => fam.includes(k))) for (const k of fam) if (!toolAlgos.includes(k)) toolAlgos.push(k); // 同家族的算法種類互為候選（敘述措辭抓不到時，由沙盒判決擇一）
        if (ALGOS.some((a) => a.pri && a.re.test(text) && !(a.veto && a.veto.test(text)))) toolAlgos.length = 0; // 領域包的條目標 pri:true＝比內建工具詞彙更具體（例如 sort／uniq／sed 的行為題），命中時不讓 lines-map 等通用工具詞彙搶走
        const toolAlgo = toolAlgos[0]; const algo = toolAlgo || (ALGOS.find((a) => a.re.test(text) && !(a.veto && a.veto.test(text))) || {}).key || null; const paradigms = (algo && PARADIGMS[algo]) || (toolAlgo ? ['text-lines'] : []);
        const pend = inputs.findIndex((x) => x.k === 'pending'); if (pend >= 0) inputs.splice(pend, 1);
        const vars = []; for (const inp of inputs) { if (inp.k === 'scalars') inp.names.forEach((n) => vars.push({ name: n, type: inp.type })); else if (inp.k === 'list') { if (inp.size && !vars.some((v) => v.name === inp.size)) vars.push({ name: inp.size, type: 'int' }); vars.push({ name: inp.name, type: 'list' }); } else if (inp.k === 'rows') vars.push({ name: inp.name, type: 'list' }); else if (inp.k === 'grid') vars.push({ name: inp.name, type: 'list' }); else if (inp.k === 'str' || inp.k === 'hex') vars.push({ name: inp.name, type: 'str' }); else if (inp.k === 'lines' || inp.k === 'rest') vars.push({ name: inp.name, type: 'list' }); else if (inp.k === 'words') vars.push({ name: inp.name, type: 'list' }); }
        // 同一個名稱在不同行出現（第一行 n，第二行 n 個…）只留一個
        const seen = new Set(); const uvars = vars.filter((v) => (seen.has(v.name) ? false : seen.add(v.name)));
        const arrs = (text.match(/\[\d+(?:\s*,\s*\d+)+\]/g) || []).length; const eqs = (text.match(/[=＝]/g) || []).length; const specLike = text.length > 300 || arrs >= 2 || eqs >= 6 ? { len: text.length, arrays: arrs, eqs } : null; // 規格即題目（G18）：敘述自帶完整演算法（大量步驟／公式／表格）：照規格翻譯，不是挑演算法；Blockly 側只偵測，沒有範式命中時應分流到老師／模型迴圈
        return { ok: inputs.length > 0, algo, specLike, algos: toolAlgos.length ? toolAlgos : undefined, paradigms, inputs, vars: uvars, goal, facts: extractFacts(text), statement: text, ops: [{ name: 'readInput', params: [], returns: 'any' }, { name: 'solve', params: uvars.map((v) => v.name), returns: 'void' }] };
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
