/* 領域包：檔案系統（純函式，Python 專屬）。格式見 domain_registry_core.js。
 * 範式：FAT 簇鏈（走訪、長度、最後一簇、不連續次數）、FAT 空閒簇（個數、前 k 個、最長連續）、inode 邏輯區塊落在哪一層（直接／一級／二級／三級間接）與佔用區塊數（含指標區塊）。
 * 差異點（簇編號從 0 或 1、結束標記、層級輸出的形式、是否多算指標區塊）是槽位，由沙盒窮舉；層級標籤只在敘述裡有三個以上的全大寫詞時才用，抽不到就拒絕渲染。骨架不含 def。train／holdout 見 domain_fs.test.js。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainFs = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'fs', label, slots, py }, extra || {});
        const need = (v, what) => { if (v === undefined || v === null || v === '') throw new Error('抽不到' + what); return v; };
        const q = (x) => JSON.stringify(x);
        const capsLabel = (I) => { const caps = [...new Set([...String(I.statement).matchAll(/(?:輸出|印出)\s*([A-Z][A-Z_]{2,})/g)].map((x) => x[1]))]; return caps.length === 1 ? caps[0] : null; };
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
            D('fs.path-normalize', 'path-normalize', 'path 正規化：把路徑照 / 切開，空字串與 . 略過，.. 退回上一層（絕對路徑的根目錄再往上還是根；相對路徑開頭的 .. 要保留）；輸出正規化路徑、層數、最後一層名稱或上一層目錄；相對路徑可先接在目前工作目錄後面',
                [S('kind', '路徑種類', [['abs', 'abs'], ['rel', 'rel'], ['cwd', 'cwd']]), S('out', '輸出', [['norm', 'norm'], ['depth', 'depth'], ['last', 'last'], ['parent', 'parent']])],
                (c, N) => { const items = N.L && N.L[0] ? N.L[0] : (N.s && N.s[0] ? '[' + N.s[0] + ']' : null); need(items, '路徑'); if (c.kind === 'cwd' && !(N.s && N.s[0] && N.L && N.L[0])) throw new Error('抽不到工作目錄');
                    const rel = c.kind === 'rel'; const j = rel ? "'/'.join(parts)" : "'/' + '/'.join(parts)", e = rel ? "'.'" : "'/'"; const fall = (x) => (rel ? "(" + x + " or '.')" : x);
                    const walk = (src, dst, keep) => ['for t in ' + src + '.split("/"):', '    if t == "" or t == ".":', '        continue', '    if t == "..":', '        if ' + dst + ' and ' + dst + '[-1] != "..":', '            ' + dst + '.pop()', '        elif ' + keep + ':', '            ' + dst + '.append("..")', '    else:', '        ' + dst + '.append(t)'];
                    const L = []; if (c.kind === 'cwd') { L.push('cw = []'); walk(N.s[0], 'cw', 'False').forEach((x) => L.push(x)); }
                    L.push('for raw_p in ' + items + ':', '    p = str(raw_p).strip()', '    parts = ' + (c.kind === 'cwd' ? '[] if p.startswith("/") else list(cw)' : '[]'));
                    walk('p', 'parts', rel ? 'True' : 'False').forEach((x) => L.push('    ' + x));
                    const o = { norm: 'print(' + fall(j) + ')', depth: 'print(len(parts))', last: 'print(parts[-1] if parts else ' + e + ')', parent: 'print(' + (rel ? "'/'.join(parts[:-1]) or '.'" : "'/' + '/'.join(parts[:-1])") + ')' }[c.out];
                    L.push('    ' + o); void e; return code(L); }, { limit: 12 }),
            D('fs.dir-resolve', 'dir-resolve', '目錄解析：維護目錄集合與目前工作目錄；mkdir 建立目錄（連同缺少的上層，或上層必須已存在）、cd 切換（路徑可相對或絕對，含 . 與 ..；目標不存在就留在原處或印標籤）、pwd 印目前目錄；輸出所有 pwd、每次 cd 之後的目錄或最後的目錄',
                [S('mk', 'mkdir 的上層', [['parents', 'parents'], ['strict', 'strict']]), S('fail', 'cd 到不存在的目錄', [['ignore', 'ignore'], ['label', 'label']]), S('emit', '輸出', [['pwd', 'pwd'], ['cd', 'cd'], ['final', 'final']])],
                (c, N, I) => { const cmds = need(N.g || (N.L && N.L[0]), '指令行'); const lab = capsLabel(I); if (c.fail === 'label' && !lab) throw new Error('抽不到 cd 失敗的標籤');
                    const L = ['dirs = {"/"}', 'cwd = []', 'for line in ' + cmds + ':', '    p = line.split()', '    if len(p) < 1:', '        continue', '    if len(p) > 1:', '        tgt = p[1]', '    else:', '        tgt = "/"', '    parts = [] if tgt.startswith("/") else list(cwd)', '    for t in tgt.split("/"):', '        if t == "" or t == ".":', '            continue', '        if t == "..":', '            if parts:', '                parts.pop()', '        else:', '            parts.append(t)', '    key = "/" + "/".join(parts)', '    if p[0] == "mkdir":'];
                    if (c.mk === 'parents') L.push('        for k in range(len(parts) + 1):', '            dirs.add("/" + "/".join(parts[:k]))'); else L.push('        if "/" + "/".join(parts[:-1]) in dirs:', '            dirs.add(key)');
                    L.push('    elif p[0] == "cd":', '        if key in dirs:', '            cwd = parts'); if (c.emit === 'cd') L.push('            print("/" + "/".join(cwd))');
                    L.push('        else:'); L.push(c.fail === 'label' && c.emit !== 'final' ? '            print(' + q(lab) + ')' : c.emit === 'cd' ? '            print("/" + "/".join(cwd))' : '            pass');
                    L.push('    elif p[0] == "pwd":'); L.push(c.emit === 'pwd' ? '        print("/" + "/".join(cwd))' : '        pass'); if (c.emit === 'final') L.push('print("/" + "/".join(cwd))'); return code(L); }, { limit: 12 }),
            D('fs.alloc-strategy', 'alloc-strategy', '連續配置策略：磁碟有 N 個區塊（0 空閒、1 已用）；每個檔案要連續 k 個空閒區塊，在所有夠長的空閒區段中依 first-fit（最前面）、best-fit（最短）或 worst-fit（最長）挑一段，同樣長取起點最小的；輸出每個檔案的起始區塊（失敗 -1）、失敗檔數、剩下幾段空閒、最長空閒段或外部碎片（空閒總數減最長一段）',
                [S('strat', '策略', [['first', 'first'], ['best', 'best'], ['worst', 'worst']]), S('base', '區塊編號從幾開始', [['0', '0'], ['1', '1']]), S('out', '輸出', [['starts', 'starts'], ['fails', 'fails'], ['runs', 'runs'], ['largest', 'largest'], ['frag', 'frag']])],
                (c, N) => { const bm = N.ls && N.ls[0] ? 'list(' + N.ls[0] + ')' : N.s && N.s[0] ? '[int(ch) for ch in ' + N.s[0] + ' if ch in "01"]' : null; need(bm, '區塊位元圖'); const ks = need(N.L && N.L[0], '檔案大小行'); const pick = { first: 'cand[0]', best: 'min(cand, key=lambda r: (r[1], r[0]))', worst: 'min(cand, key=lambda r: (-r[1], r[0]))' }[c.strat];
                    const runs = ['    runs = []', '    i = 0', '    while i < len(used):', '        if used[i] == 0:', '            j = i', '            while j < len(used) and used[j] == 0:', '                j += 1', '            runs.append((i, j - i))', '            i = j', '        else:', '            i += 1'];
                    const o = { starts: 'print(*res)', fails: 'print(res.count(-1))', runs: 'print(len(runs))', largest: 'print(max([r[1] for r in runs] or [0]))', frag: 'print(used.count(0) - max([r[1] for r in runs] or [0]))' }[c.out];
                    return code(['used = ' + bm, 'res = []', 'for raw_k in ' + ks + ':', '    k = int(raw_k)'].concat(runs, ['    cand = [r for r in runs if r[1] >= k]', '    if not cand:', '        res.append(-1)', '    else:', '        r = ' + pick, '        for x in range(r[0], r[0] + k):', '            used[x] = 1', '        res.append(r[0] + ' + c.base + ')'], ['runs = []', 'i = 0', 'while i < len(used):', '    if used[i] == 0:', '        j = i', '        while j < len(used) and used[j] == 0:', '            j += 1', '        runs.append((i, j - i))', '        i = j', '    else:', '        i += 1', o])); }, { limit: 30 }),
            D('fs.internal-frag', 'internal-frag', '內部碎片：檔案佔用的空間以區塊（叢集）為單位，大小 s 的檔案用掉 ceil(s / b) 個區塊，浪費 ceil(s / b) * b - s；輸出每個檔案浪費、全部浪費總和、浪費最多的檔案浪費量，或有浪費的檔案數',
                [S('out', '輸出', [['per', 'per'], ['sum', 'sum'], ['max', 'max'], ['cnt', 'cnt']])],
                (c, N) => { const b = need(N.sc[0], '區塊大小 b'); const Q = need((N.L && N.L[0]) || N.ls[0], '檔案大小');
                    const o = { per: 'print(w)', sum: 'tot += w', max: 'tot = max(tot, w)', cnt: 'tot += 1 if w > 0 else 0' }[c.out];
                    return code(['tot = 0', 'for raw_s in ' + Q + ':', '    s = int(raw_s)', '    nb = (s + ' + b + ' - 1) // ' + b, '    w = nb * ' + b + ' - s', '    ' + o].concat(c.out === 'per' ? [] : ['print(tot)'])); }, { limit: 4 }),
        ];
        const algos = [
            ['alloc-strategy', /(?=[\s\S]*(?:檔案|磁碟|硬碟|disk|file))(?=[\s\S]*(?:(?:first|best|worst)[\s-]*fit|首次適合|最佳適合|最差適合|最先適合|最適合))/i, /記憶體|分區|partition|行程|程序/i],
            ['internal-frag', /內部碎片|internal\s*fragmentation|叢集.{0,12}浪費|(?:簇|區塊).{0,8}(?:浪費|用不滿)|檔案.{0,16}(?:浪費|多佔)(?:的)?(?:空間|位元組)/i],
            ['dir-resolve', /(?:mkdir|cd)\s*[\S]*[\s\S]*pwd|pwd[\s\S]*(?:mkdir|cd)\s|目錄解析|工作目錄.{0,20}(?:切換|cd)/i],
            ['path-normalize', /正規化|規範化|化簡|簡化.{0,6}路徑|canonical|normaliz|realpath|路徑.{0,24}(?:\.\.|上一層|上層)|(?:\.\.|上一層|上層).{0,24}路徑/i],
            ['fat-free', /空閒簇|自由簇|空閒的簇|沒用到的簇|未使用的簇|沒(?:有)?被使用的簇|沒有使用的簇|閒置的簇/], ['fat-chain', /簇鏈|FAT\s*(?:表|鏈)|下一個簇|起始簇|file\s*allocation\s*table|接哪個簇|之後接.{0,6}簇|(?:占|佔)(?:用)?幾個簇|檔案第一個簇/i],
            ['inode-blocks', /(?:佔用|占用|需要|用掉)(?:的)?(?:磁碟)?區塊(?:總)?(?:數|個數)|區塊總數|資料區塊(?:加上|再加).{0,8}指標區塊|(?:佔用|占用|需要|用掉)(?:幾個|多少)(?:磁碟)?區塊/i, /tar\b|補\s*0|補零|對齊|512\s*(?:位元組|bytes?)/i], ['inode-level', /inode|直接區塊|間接區塊|直接指標|間接指標|邏輯區塊階層/i],
        ].map(([key, re, veto]) => (veto ? { key, re, pri: true, veto } : { key, re, pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['fs'];
        return { id: 'fs', label: '檔案系統（FAT 簇鏈／空閒簇、inode 區塊階層與佔用、路徑正規化、目錄解析、連續配置策略、內部碎片）', requires: [], judge: { checker: 'tokens' }, algos, paradigms, skeletons };
    }
    return { make };
});
