/* 領域包：完整 DEFLATE inflate（未壓縮／固定霍夫曼／動態霍夫曼三種區塊）＋ zlib／gzip 外殼 ＋ 區塊統計與碼長表。格式見 domain_registry_core.js。
 * 解碼器寫成輔助操作（helpers，G2 切割）：huff_table（由碼長依 RFC 1951 指派範式碼字）、huff_sym（逐位元走碼表）、inflate_raw（區塊迴圈：
 * 動態區塊先解碼長度碼的碼長，再用 16／17／18 的重複規則展開成字面／長度與距離兩份碼長）、gz_skip（gzip 標頭的 FEXTRA／FNAME／FCOMMENT／FHCRC 跳過）。
 * 外殼（raw／zlib／gzip）與輸出形式（hex／text）是槽位，由沙盒窮舉，不從敘述猜。
 * 誠實限制：只做解碼；不驗證 zlib 的 Adler-32 與 gzip 的 CRC-32／ISIZE（驗證版另在核心範式 gzip.stored-member 對未壓縮成員做過）；位元流用字串展開，只適合小資料。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainInflate = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const HELP = {
        huff_table: { params: ['lens'], py: [
            'mx = max(lens) if lens else 0',
            'cnt = [0] * (mx + 2)',
            'for l in lens:',
            '    if l:',
            '        cnt[l] += 1',
            'nxt = [0] * (mx + 2)',
            'code = 0',
            'for b in range(1, mx + 1):',
            '    code = (code + cnt[b - 1]) << 1',
            '    nxt[b] = code',
            'tbl = {}',
            'for s in range(len(lens)):',
            '    l = lens[s]',
            '    if l:',
            '        tbl[(l, nxt[l])] = s',
            '        nxt[l] += 1',
            'return tbl'
        ] },
        huff_sym: { params: ['bits', 'p', 'tbl'], py: [
            'code = 0',
            'ln = 0',
            'while True:',
            '    code = code * 2 + int(bits[p])',
            '    p += 1',
            '    ln += 1',
            '    if (ln, code) in tbl:',
            '        return tbl[(ln, code)], p'
        ] },
        // 回傳 (位元組, 結束位元組位置, 各區塊 BTYPE 列表, 每個動態區塊的 [hlit, hdist, hclen, 字面長度碼長, 距離碼長])
        inflate_raw: { params: ['data'], py: [
            'bits = "".join(format(x, "08b")[::-1] for x in data)',
            'p = 0',
            'out = bytearray()',
            'types = []',
            'dyn = []',
            'LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]',
            'LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]',
            'DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]',
            'DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]',
            'ORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]',
            'while True:',
            '    final = int(bits[p])',
            '    typ = int(bits[p + 1:p + 3][::-1], 2)',
            '    p += 3',
            '    types.append(typ)',
            '    if typ == 0:',
            '        p = (p + 7) // 8 * 8',
            '        n = int(bits[p:p + 16][::-1], 2)',
            '        p += 32',
            '        for _ in range(n):',
            '            out.append(int(bits[p:p + 8][::-1], 2))',
            '            p += 8',
            '    else:',
            '        if typ == 1:',
            '            ll = [8] * 144 + [9] * 112 + [7] * 24 + [8] * 8',
            '            dl = [5] * 30',
            '        else:',
            '            hlit = int(bits[p:p + 5][::-1], 2) + 257',
            '            hdist = int(bits[p + 5:p + 10][::-1], 2) + 1',
            '            hclen = int(bits[p + 10:p + 14][::-1], 2) + 4',
            '            p += 14',
            '            cl = [0] * 19',
            '            for i in range(hclen):',
            '                cl[ORD[i]] = int(bits[p:p + 3][::-1], 2)',
            '                p += 3',
            '            tl = huff_table(cl)',
            '            lens = []',
            '            while len(lens) < hlit + hdist:',
            '                s, p = huff_sym(bits, p, tl)',
            '                if s < 16:',
            '                    lens.append(s)',
            '                elif s == 16:',
            '                    lens += [lens[-1]] * (3 + int(bits[p:p + 2][::-1], 2))',
            '                    p += 2',
            '                elif s == 17:',
            '                    lens += [0] * (3 + int(bits[p:p + 3][::-1], 2))',
            '                    p += 3',
            '                else:',
            '                    lens += [0] * (11 + int(bits[p:p + 7][::-1], 2))',
            '                    p += 7',
            '            ll = lens[:hlit]',
            '            dl = lens[hlit:hlit + hdist]',
            '            dyn.append([hlit, hdist, hclen, ll, dl])',
            '        lt = huff_table(ll)',
            '        dt = huff_table(dl)',
            '        while True:',
            '            sym, p = huff_sym(bits, p, lt)',
            '            if sym < 256:',
            '                out.append(sym)',
            '            elif sym == 256:',
            '                break',
            '            else:',
            '                k = sym - 257',
            '                ln = LB[k] + (int(bits[p:p + LE[k]][::-1], 2) if LE[k] else 0)',
            '                p += LE[k]',
            '                dc, p = huff_sym(bits, p, dt)',
            '                d = DB[dc] + (int(bits[p:p + DE[dc]][::-1], 2) if DE[dc] else 0)',
            '                p += DE[dc]',
            '                for _ in range(ln):',
            '                    out.append(out[-d])',
            '    if final:',
            '        break',
            'return bytes(out), (p + 7) // 8, types, dyn'
        ] },
        gz_skip: { params: ['data'], py: [
            'flg = data[3]',
            'pos = 10',
            'if flg & 4:',
            '    pos += 2 + int.from_bytes(data[pos:pos + 2], "little")',
            'if flg & 8:',
            '    while data[pos] != 0:',
            '        pos += 1',
            '    pos += 1',
            'if flg & 16:',
            '    while data[pos] != 0:',
            '        pos += 1',
            '    pos += 1',
            'if flg & 2:',
            '    pos += 2',
            'return pos'
        ] }
    };
    const pick = (names) => names.map((n) => ({ name: n, params: HELP[n].params, py: HELP[n].py }));
    const NEED = ['huff_table', 'huff_sym', 'inflate_raw'];
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'binary-format', label, slots, py }, extra || {});
        const hexIn = (I) => I.inputs.length === 1 && I.inputs[0].k === 'hex';
        const hx = (N) => N.s[0];
        const wrap = S('wrap', '外殼', [['raw', 'data'], ['zlib', 'data[2:]'], ['gzip', 'data[gz_skip(data):]']]);
        const outSlot = S('out', '輸出', [['hex', 'hex'], ['text', 'text']]);
        // 外殼槽位的值是運算式字串（如 'data[gz_skip(data):]'），要看值是否呼叫 gz_skip，不能比對槽位名稱
        const need = (c) => NEED.concat(/gz_skip\(/.test(c.wrap) ? ['gz_skip'] : []);
        const skeletons = [
            D('df.inflate', 'inflate-any', 'DEFLATE 完整解壓：區塊迴圈（BFINAL／BTYPE：00 未壓縮、01 固定、10 動態），動態區塊先讀 HLIT／HDIST／HCLEN 與長度碼的碼長、展開 16／17／18 的重複，再以範式碼解字面／長度與距離，LZ77 複製；外殼 raw／zlib（2 位元組標頭）／gzip（10 位元組標頭加選用欄位）',
                [wrap, outSlot],
                (c, N) => code(['data = bytes.fromhex(' + hx(N) + '.strip())', 'res = inflate_raw(' + c.wrap + ')[0]', c.out === 'hex' ? 'print(res.hex())' : 'print(res.decode("utf-8"))']),
                { shape: hexIn, limit: 6, helpers: (c) => pick(need(c)) }),
            D('df.block-types', 'inflate-blocks', 'DEFLATE 區塊統計：走完整個串流，輸出未壓縮、固定、動態三種區塊各有幾個（空格分隔）；也可輸出總區塊數',
                [wrap, S('fmt', '輸出', [['three', 'types.count(0), types.count(1), types.count(2)'], ['total', 'len(types)'], ['seq', '*types']])],
                (c, N) => code(['data = bytes.fromhex(' + hx(N) + '.strip())', 'types = inflate_raw(' + c.wrap + ')[2]', 'print(' + c.fmt + ')']),
                { shape: hexIn, limit: 9, helpers: (c) => pick(need(c)) }),
            D('df.code-lengths', 'inflate-lengths', 'DEFLATE 動態區塊的碼長表：取第一個動態區塊，輸出字面／長度字母表裡碼長非 0 的「符號 碼長」逐行（或距離表、或先字面後距離）；也可只輸出 HLIT／HDIST／HCLEN',
                [wrap, S('what', '輸出', [['lit', 'lit'], ['dist', 'dist'], ['both', 'both'], ['hdr', 'hdr']])],
                (c, N) => {
                    const body = { lit: ['for s, l in enumerate(d[3]):', '    if l:', '        print(s, l)'], dist: ['for s, l in enumerate(d[4]):', '    if l:', '        print(s, l)'],
                        both: ['for s, l in enumerate(d[3]):', '    if l:', '        print(s, l)', 'for s, l in enumerate(d[4]):', '    if l:', '        print(s, l)'], hdr: ['print(d[0], d[1], d[2])'] }[c.what];
                    return code(['data = bytes.fromhex(' + hx(N) + '.strip())', 'd = inflate_raw(' + c.wrap + ')[3][0]'].concat(body));
                },
                { shape: hexIn, limit: 12, helpers: (c) => pick(need(c)) })
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const DEC = '(?:解壓|解碼|還原|inflate|展開)';
        const FMT = '(?:DEFLATE|deflate|zlib|gzip|inflate)';
        const algos = [
            { key: 'inflate-lengths', re: ALL(FMT, '(?:動態|dynamic|BTYPE\\s*[=＝]?\\s*(?:10|2))', '(?:碼長|code\\s*length|HLIT|HCLEN)'), veto: /解壓縮|還原成/ },
            { key: 'inflate-blocks', re: ALL(FMT, '(?:幾個|多少個|各有|統計|數量|區塊數)[^。]{0,16}區塊|區塊[^。]{0,12}(?:幾個|各有|統計|數量)'), veto: /碼長/ },
            { key: 'inflate-any', re: ALL(DEC, FMT, '(?:動態|dynamic|BTYPE\\s*[=＝]?\\s*(?:10|2)|三種(?:區塊|類型)|完整|任意|任何|一般|各種)'), veto: /只[含有]固定|僅固定|固定霍夫曼區塊[（(]BFINAL|碼長表|幾個[^。]{0,8}區塊|各有/ },
            // 通用：敘述點名外殼格式（zlib／gzip 的「格式／檔／資料」）且要求解壓，沒有額外限定詞時也走完整 inflate（不靠某一句的措辭）
            { key: 'inflate-any', re: ALL(DEC, '(?:zlib|gzip)\\s*(?:壓縮)?\\s*(?:資料|檔|格式|串流|外殼)'), veto: /只[含有]固定|僅固定|固定霍夫曼區塊[（(]BFINAL|碼長表|幾個[^。]{0,8}區塊|各有|碼長/ }
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['binary-format'];
        return { id: 'inflate', label: 'DEFLATE 完整 inflate（動態霍夫曼、zlib／gzip 外殼、區塊統計、碼長表）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make, HELP };
});
