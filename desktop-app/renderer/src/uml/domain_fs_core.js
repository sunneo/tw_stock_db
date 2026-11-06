/* 領域包：檔案系統（純函式，Python 專屬）。格式見 domain_registry_core.js。
 * 範式：FAT 簇鏈（走訪、長度、最後一簇、不連續次數）、FAT 空閒簇（個數、前 k 個、最長連續）、inode 邏輯區塊落在哪一層（直接／一級／二級／三級間接）與佔用區塊數（含指標區塊）。
 * 差異點（簇編號從 0 或 1、結束標記、層級輸出的形式、是否多算指標區塊）是槽位，由沙盒窮舉；層級標籤只在敘述裡有三個以上的全大寫詞時才用，抽不到就拒絕渲染。骨架不含 def。train／holdout 見 domain_fs.test.js。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainFs = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'fs', label, slots, py }, extra || {});
        const need = (v, what) => { if (v === undefined || v === null || v === '') throw new Error('抽不到' + what); return v; };
        const capsWords = (I) => { const out = []; for (const m of String(I.statement).matchAll(/\b([A-Z][A-Z_]{2,})\b/g)) if (!out.includes(m[1])) out.push(m[1]); return out; };
        const END = { m1: 'cur != -1', z: 'cur != 0', neg: 'cur >= 0' };
        const BASE = S('base', '簇編號從幾開始', [['0', '0'], ['1', '1']]);
        const skeletons = [
            D('fs.fat-chain', 'fat-chain', 'FAT 簇鏈：從起始簇出發，依 fat 表一路找下一簇，直到遇到結束標記；輸出鏈長度、整條鏈、最後一簇或不連續的次數（下一簇不是目前簇加一）',
                [BASE, S('end', '結束標記', [['m1', 'm1'], ['z', 'z'], ['neg', 'neg']]), S('out', '輸出', [['len', 'len'], ['chain', 'chain'], ['last', 'last'], ['jumps', 'jumps']])],
                (c, N) => { const f = need(N.ls[0], 'FAT 表'), s = need(N.sc[N.sc.length - 1], '起始簇');
                    return code(['cur = ' + s, 'chain = []', 'while ' + END[c.end] + ' and len(chain) <= len(' + f + '):', '    chain.append(cur)', '    cur = ' + f + '[cur - ' + c.base + ']', 'jumps = sum(1 for i in range(1, len(chain)) if chain[i] != chain[i - 1] + 1)', 'print(' + ({ len: 'len(chain)', chain: '*chain', last: 'chain[-1]', jumps: 'jumps' }[c.out]) + ')']); }, { limit: 24 }),
            D('fs.fat-free', 'fat-free', 'FAT 空閒簇：fat 表裡是 0（或 -1）的簇是空閒的；輸出空閒簇個數、最前面 k 個空閒簇的編號，或最長連續空閒簇的長度',
                [BASE, S('free', '空閒標記', [['0', '0'], ['-1', '-1']]), S('out', '輸出', [['count', 'count'], ['firstk', 'firstk'], ['run', 'run']])],
                (c, N) => { const f = need(N.ls[0], 'FAT 表');
                    const body = ['fr = [i + ' + c.base + ' for i in range(len(' + f + ')) if ' + f + '[i] == ' + c.free + ']'];
                    if (c.out === 'count') return code(body.concat(['print(len(fr))']));
                    if (c.out === 'firstk') return code(body.concat(['print(*fr[:' + need(N.sc[N.sc.length - 1], '個數 k') + '])']));
                    return code(['best = 0', 'run = 0', 'for x in ' + f + ':', '    if x == ' + c.free + ':', '        run += 1', '        best = max(best, run)', '    else:', '        run = 0', 'print(best)']); }, { limit: 12 }),
            D('fs.inode-level', 'inode-level', 'inode 邏輯區塊階層：位元組偏移除以區塊大小得邏輯區塊號；號碼小於直接指標數就是直接，再往後是一級間接（每個指標區塊有 p 個指標）、二級、三級；輸出階層編號、標籤，或讀到資料要幾次磁碟存取',
                [S('out', '輸出', [['lvl', 'lvl'], ['label', 'label'], ['reads', 'reads']]), S('add', '存取數多算', [['1', '1'], ['0', '0']])],
                (c, N, I) => { const [b, d, p] = [need(N.sc[0], '區塊大小 b'), need(N.sc[1], '直接指標數 d'), need(N.sc[2], '每個指標區塊的指標數 p')]; const Q = need((N.L && N.L[0]) || N.ls[0], '查詢偏移'); let lab = ['DIRECT'];
                    if (c.out === 'label') { lab = capsWords(I); if (lab.length < 3) throw new Error('抽不到階層標籤'); }
                    const out = c.out === 'lvl' ? 'lv' : c.out === 'reads' ? 'lv + ' + c.add : 'L[lv]';
                    return code((c.out === 'label' ? ['L = ' + JSON.stringify(lab)] : []).concat(['for t in ' + Q + ':', '    blk = int(t) // ' + b, '    if blk < ' + d + ':', '        lv = 0', '    elif blk < ' + d + ' + ' + p + ':', '        lv = 1', '    elif blk < ' + d + ' + ' + p + ' + ' + p + ' * ' + p + ':', '        lv = 2', '    else:', '        lv = 3', '    print(' + out + ')'])); }, { limit: 8 }),
            D('fs.inode-blocks', 'inode-blocks', 'inode 檔案佔用區塊數：檔案大小除以區塊大小（無條件進位）得資料區塊數；超過直接指標的部分要加一級間接指標區塊，再超過加二級間接的根區塊與其下用到的指標區塊；輸出資料區塊數或含指標區塊的總數',
                [S('out', '輸出', [['data', 'data'], ['total', 'total']])],
                (c, N) => { const [b, d, p] = [need(N.sc[0], '區塊大小 b'), need(N.sc[1], '直接指標數 d'), need(N.sc[2], '每個指標區塊的指標數 p')]; const Q = need((N.L && N.L[0]) || N.ls[0], '查詢檔案大小');
                    return code(['for t in ' + Q + ':', '    n = (int(t) + ' + b + ' - 1) // ' + b, '    tot = n', '    rest = n - ' + d, '    if rest > 0:', '        tot += 1', '        rest -= ' + p, '    if rest > 0:', '        tot += 1 + (min(rest, ' + p + ' * ' + p + ') + ' + p + ' - 1) // ' + p, '        rest -= ' + p + ' * ' + p, '    if rest > 0:', '        tot += 1 + (rest + ' + p + ' * ' + p + ' - 1) // (' + p + ' * ' + p + ') + (rest + ' + p + ' - 1) // ' + p, '    print(' + (c.out === 'data' ? 'n' : 'tot') + ')']); }, { limit: 4 }),
        ];
        const algos = [
            ['fat-free', /空閒簇|自由簇|空閒的簇|沒用到的簇|未使用的簇|沒(?:有)?被使用的簇|沒有使用的簇|閒置的簇/], ['fat-chain', /簇鏈|FAT\s*(?:表|鏈)|下一個簇|起始簇|file\s*allocation\s*table|接哪個簇|之後接.{0,6}簇|(?:占|佔)(?:用)?幾個簇|檔案第一個簇/i],
            ['inode-blocks', /(?:佔用|占用|需要|用掉)(?:的)?(?:磁碟)?區塊(?:總)?(?:數|個數)|區塊總數|資料區塊(?:加上|再加).{0,8}指標區塊|(?:佔用|占用|需要|用掉)(?:幾個|多少)(?:磁碟)?區塊/i], ['inode-level', /inode|直接區塊|間接區塊|直接指標|間接指標|邏輯區塊階層/i],
        ].map(([key, re]) => ({ key, re, pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['fs'];
        return { id: 'fs', label: '檔案系統（FAT 簇鏈／空閒簇、inode 區塊階層與佔用）', requires: [], judge: { checker: 'tokens' }, algos, paradigms, skeletons };
    }
    return { make };
});
