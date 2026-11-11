/* 領域包：tar 進階（PAX 擴充標頭、GNU 長檔名、ustar prefix 欄）。格式見 domain_registry_core.js。
 * tarx.list：走訪封存檔——typeflag x（單檔 PAX）的記錄「長度 key=value\n」（長度含自身，以位元組計）、L（GNU 長檔名，資料是以 NUL 結尾的名稱）、
 *   g／K 略過；PAX 的 path 與 size 覆蓋下一個真正條目的標頭（size 覆蓋會改變資料區長度）；POSIX ustar（magic "ustar\0" 版本 "00"）的 prefix 欄（345–499）接在名稱前加 "/"；
 *   size 欄若最高位元為 1 是 base-256 大端。輸出順序是槽位。
 * tarx.pax-records：取第一個 PAX 擴充標頭，逐條輸出 key=value（依出現順序或依 key 排序）。
 * tarx.pax-encode：把 key／value 編成 PAX 記錄，長度欄含自身位數（位數進位時重算），輸出十六進位或文字。
 * 誠實限制：只做讀取與記錄編碼；不驗證檢查碼；g（全域擴充標頭）的內容不套用；寫出完整 PAX 封存檔（擴充標頭條目的名稱因實作而異）不在本包。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainTarx = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'binary-format', label, slots, py }, extra || {});
        const hexIn = (I) => I.inputs.length === 1 && I.inputs[0].k === 'hex';
        const hx = (N) => N.s[0];
        // 把 PAX 資料區（位元組）解成 [(key, value)]
        const PAXPARSE = (src, dst, ind) => [dst + ' = []', 'q_ = 0', 'while q_ < len(' + src + '):', '    sp_ = ' + src + '.index(b" ", q_)', '    ln_ = int(' + src + '[q_:sp_])', '    k_, v_ = ' + src + '[sp_ + 1:q_ + ln_ - 1].decode("utf-8").split("=", 1)', '    ' + dst + '.append((k_, v_))', '    q_ += ln_'].map((l) => ind + l);
        const skeletons = [
            D('tarx.list', 'tar-pax-list', 'tar 走訪（含 PAX 擴充標頭 x、GNU 長檔名 L、ustar prefix）：PAX 的 path／size 覆蓋下一個條目；size 覆蓋會改變資料區長度；輸出每個真正條目的名稱與大小',
                [S('out', '輸出', [['ns', '"%s %d" % (nm_, sz_)'], ['sn', '"%d %s" % (sz_, nm_)'], ['n', 'nm_']]), S('pre', 'ustar prefix', [['yes', 'yes'], ['no', 'no']])],
                (c, N) => code(['raw_ = bytes.fromhex(' + hx(N) + '.strip())', 'pos_ = 0', 'pn_ = None', 'ps_ = None',
                    'while pos_ + 512 <= len(raw_):', '    blk_ = raw_[pos_:pos_ + 512]', '    if blk_ == bytes(512):', '        break',
                    '    nm_ = blk_[0:100].split(b"\\x00")[0].decode("utf-8")',
                    c.pre === 'yes' ? '    if blk_[257:263] == b"ustar\\x00" and blk_[263:265] == b"00" and blk_[345] != 0:' : '    if False:',
                    '        nm_ = blk_[345:500].split(b"\\x00")[0].decode("utf-8") + "/" + nm_',
                    '    tf_ = chr(blk_[156])',
                    '    if blk_[124] & 0x80:', '        sz_ = int.from_bytes(blk_[124:136], "big") & ((1 << 95) - 1)', '    else:', '        sz_ = int(blk_[124:136].strip(b"\\x00 ").decode() or "0", 8)',
                    '    if tf_ in "xgLK":', '        dat_ = raw_[pos_ + 512:pos_ + 512 + sz_]', '        if tf_ == "x":'].concat(PAXPARSE('dat_', 'recs_', '            '), [
                    '            for k_, v_ in recs_:', '                if k_ == "path":', '                    pn_ = v_', '                elif k_ == "size":', '                    ps_ = int(v_)',
                    '        elif tf_ == "L":', '            pn_ = dat_.split(b"\\x00")[0].decode("utf-8")',
                    '    else:', '        if pn_ is not None:', '            nm_ = pn_', '        if ps_ is not None:', '            sz_ = ps_',
                    '        print(' + c.out + ')', '        pn_ = None', '        ps_ = None',
                    '    pos_ += 512 + (sz_ + 511) // 512 * 512'])),
                { shape: hexIn, limit: 6 }),
            D('tarx.pax-records', 'tar-pax-records', 'tar 的第一個 PAX 擴充標頭（typeflag x）：逐條解析「長度 key=value」記錄（長度以位元組計、含自身與換行），輸出 key=value（出現順序或依 key 排序）',
                [S('ord', '順序', [['seq', 'recs_'], ['sorted', 'sorted(recs_)']])],
                (c, N) => code(['raw_ = bytes.fromhex(' + hx(N) + '.strip())', 'pos_ = 0', 'recs_ = []',
                    'while pos_ + 512 <= len(raw_):', '    blk_ = raw_[pos_:pos_ + 512]', '    if blk_ == bytes(512):', '        break',
                    '    sz_ = int(blk_[124:136].strip(b"\\x00 ").decode() or "0", 8)', '    if chr(blk_[156]) == "x":', '        dat_ = raw_[pos_ + 512:pos_ + 512 + sz_]'].concat(PAXPARSE('dat_', 'recs_', '        '), [
                    '        break', '    pos_ += 512 + (sz_ + 511) // 512 * 512', 'for k_, v_ in ' + c.ord + ':', '    print(k_ + "=" + v_)'])),
                { shape: hexIn, limit: 2 }),
            D('tarx.pax-encode', 'tar-pax-encode', 'PAX 記錄編碼：每筆「長度 key=value\\n」，長度是整筆記錄的位元組數且包含長度欄自己的位數（UTF-8 位元組計；位數進位時重算）；輸出所有記錄串接後的十六進位或文字',
                [S('out', '輸出', [['hex', 'hex'], ['text', 'text']])],
                (c, N) => code(['L_ = ' + N.L[0], 'n_ = int(L_[0])', 'res_ = b""', 'for t_ in L_[1:1 + n_]:', '    k_, v_ = t_.split(" ", 1)', '    body_ = (" " + k_ + "=" + v_ + "\\n").encode("utf-8")',
                    '    ln_ = len(body_) + len(str(len(body_)))', '    if len(str(ln_)) != len(str(len(body_)) ):', '        ln_ = len(body_) + len(str(ln_))', '    res_ += str(ln_).encode() + body_',
                    c.out === 'hex' ? 'print(res_.hex())' : 'print(res_.decode("utf-8"), end="")']),
                { shape: (I) => I.inputs.some((x) => x.k === 'rest' || x.k === 'lines'), limit: 2 })
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const PAX = '(?:PAX|擴充標頭|extended\\s*header|typeflag\\s*[=＝]?\\s*[\'"「]?x)';
        const algos = [
            { key: 'tar-pax-encode', re: ALL(PAX, '(?:編碼|編成|組出|產生|輸出[^。]{0,10}記錄|寫出)', '(?:長度|length)', '(?:key|鍵)'), veto: /解析|走訪|列出/, rawAll: true },
            { key: 'tar-pax-records', re: ALL('tar', PAX, '(?:key\\s*=\\s*value|key=value|鍵值|記錄|records?)'), veto: /編碼|組出|寫出|產生|檔名|大小|真正檔案|覆蓋|prefix/ },
            { key: 'tar-pax-list', re: ALL('tar', '(?:' + PAX + '|prefix\\s*欄|GNU[^。]{0,8}(?:長檔名|LongLink|longname)|LongLink|\\./@LongLink|typeflag\\s*[=＝]?\\s*[\'"「]?[LK])', '(?:列出|檔名|名稱|path)'), veto: /編碼|組出|寫出|(?:輸出|列出)\s*key\s*=\s*value|依\s*key|逐條/ }
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['binary-format'];
        return { id: 'tarx', label: 'tar 進階（PAX 擴充標頭、GNU 長檔名、prefix）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make };
});
