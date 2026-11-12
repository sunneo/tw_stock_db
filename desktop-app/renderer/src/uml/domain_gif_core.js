/* 領域包：GIF 讀寫（單張影格、非交錯、全域或局部調色盤、LZW 變長編碼）。格式見 domain_registry_core.js。
 * gif.decode：輸入一行十六進位的整個 GIF 檔；跳過擴充區塊（0x21），讀影像描述子（0x2C）與調色盤（局部優先、否則全域），
 *   把子區塊接起來做 LZW 解碼（碼寬 mcs+1 起算，碼表滿 4096 停止加長），輸出每列的索引或調色盤顏色。
 * gif.encode：輸入一行十六進位的「原始影像封包」：寬（2 位元組大端）、高（2 位元組大端）、調色盤顏色數 k（1 位元組，2～255）、
 *   3k 位元組 RGB 調色盤、其後是 w*h 個索引位元組（列由上到下）。輸出 GIF 檔的十六進位：GIF89a＋邏輯螢幕描述子＋全域調色盤（補到 2 的冪次）＋影像描述子＋LZW 子區塊＋尾碼。
 *   LZW 編碼是確定性的貪婪演算法（起始送一個清除碼；字典只加不清；碼寬依解碼器端的碼表長度推算）。小影像（碼數 < 4096）時不會觸發字典重置，輸出可逐位元比對。
 * 誠實限制：只支援單張影格、非交錯、不支援透明索引與動畫；不驗證區塊結尾之後的內容；寫出端的碼表不重置（只適合小影像）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainGif = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const HELP = {
        // 讀子區塊（長度前綴、以 0 結尾）：回傳（接起來的資料，結尾之後的位置）
        gif_sub: { params: ['f', 'p'], py: [
            'out = bytearray()',
            'while f[p]:',
            '    n = f[p]',
            '    out += f[p + 1:p + 1 + n]',
            '    p += 1 + n',
            'return bytes(out), p + 1'
        ] },
        // 解碼器端的碼寬：碼表長度 L＝2^mcs＋2＋max(0, k−1)，碼寬是能表示 L 的最小位數（上限 12）
        gif_w: { params: ['k', 'mcs'], py: [
            'L = (1 << mcs) + 2 + max(0, k - 1)',
            's = mcs + 1',
            'while (1 << s) <= L and s < 12:',
            '    s += 1',
            'return s'
        ] },
        // LZW 解碼（LSB 先）：清除碼重置碼表，結束碼停止，碼表長度到 2^碼寬 時加寬
        gif_lzw_dec: { params: ['data', 'mcs'], py: [
            'clear = 1 << mcs',
            'eoi = clear + 1',
            'table = [bytes([i]) for i in range(clear)] + [b"", b""]',
            'size = mcs + 1',
            'out = bytearray()',
            'prev = None',
            'acc = 0',
            'nb = 0',
            'p = 0',
            'while True:',
            '    while nb < size and p < len(data):',
            '        acc |= data[p] << nb',
            '        nb += 8',
            '        p += 1',
            '    if nb < size:',
            '        break',
            '    code = acc & ((1 << size) - 1)',
            '    acc >>= size',
            '    nb -= size',
            '    if code == clear:',
            '        table = table[:clear + 2]',
            '        size = mcs + 1',
            '        prev = None',
            '        continue',
            '    if code == eoi:',
            '        break',
            '    if code < len(table):',
            '        cur = table[code]',
            '        if prev is not None:',
            '            table.append(prev + cur[:1])',
            '    else:',
            '        cur = prev + prev[:1]',
            '        table.append(cur)',
            '    out += cur',
            '    prev = cur',
            '    if len(table) == (1 << size) and size < 12:',
            '        size += 1',
            'return bytes(out)'
        ] },
        // LZW 編碼（確定性貪婪）：起始清除碼；每次輸出一碼並加入一個新字典項；最後輸出殘餘碼與結束碼；碼寬依 gif_w(k, mcs)
        gif_lzw_enc: { params: ['px', 'mcs'], py: [
            'clear = 1 << mcs',
            'eoi = clear + 1',
            'dic = {bytes([i]): i for i in range(clear)}',
            'nxt = clear + 2',
            'items = [(clear, mcs + 1)]',
            'k = 0',
            'w = b""',
            'for c in px:',
            '    wc = w + bytes([c])',
            '    if wc in dic:',
            '        w = wc',
            '    else:',
            '        items.append((dic[w], gif_w(k, mcs)))',
            '        k += 1',
            '        dic[wc] = nxt',
            '        nxt += 1',
            '        w = bytes([c])',
            'items.append((dic[w], gif_w(k, mcs)))',
            'k += 1',
            'items.append((eoi, gif_w(k, mcs)))',
            'acc = 0',
            'nb = 0',
            'out = bytearray()',
            'for code, wd in items:',
            '    acc |= code << nb',
            '    nb += wd',
            '    while nb >= 8:',
            '        out.append(acc & 255)',
            '        acc >>= 8',
            '        nb -= 8',
            'if nb:',
            '    out.append(acc & 255)',
            'return bytes(out)'
        ] },
        // 把資料切成最多 255 位元組的子區塊，尾端補 0 結尾
        gif_sub_pack: { params: ['d'], py: [
            'out = bytearray()',
            'for i in range(0, len(d), 255):',
            '    ch = d[i:i + 255]',
            '    out.append(len(ch))',
            '    out += ch',
            'out.append(0)',
            'return bytes(out)'
        ] }
    };
    const pick = (names) => names.map((n) => ({ name: n, params: HELP[n].params, py: HELP[n].py }));
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'binary-format', label, slots, py }, extra || {});
        const hexIn = (I) => I.inputs.length === 1 && I.inputs[0].k === 'hex';
        const hx = (N) => N.s[0];
        const skeletons = [
            D('gif.decode', 'gif-decode', 'GIF 解碼：跳過擴充區塊、讀影像描述子與調色盤（局部優先）、接起子區塊做 LZW 解碼；每列輸出（每像素的 RGB 十六進位／整列索引十六進位／整列索引十進位）',
                [S('out', '每列輸出', [['px', '" ".join(pal[3 * v:3 * v + 3].hex() for v in r)'], ['hex', 'bytes(r).hex()'], ['dec', '" ".join(str(v) for v in r)']])],
                (c, N) => code(['f = bytes.fromhex(' + hx(N) + '.strip())',
                    'w = int.from_bytes(f[6:8], "little")', 'fl = f[10]', 'p = 13', 'gct = b""',
                    'if fl & 128:', '    n = 3 * (2 << (fl & 7))', '    gct = f[p:p + n]', '    p += n',
                    'while f[p] == 33:', '    p += 2', '    while f[p]:', '        p += 1 + f[p]', '    p += 1',
                    'w = int.from_bytes(f[p + 5:p + 7], "little")', 'h = int.from_bytes(f[p + 7:p + 9], "little")',
                    'lf = f[p + 9]', 'p += 10', 'pal = gct',
                    'if lf & 128:', '    n = 3 * (2 << (lf & 7))', '    pal = f[p:p + n]', '    p += n',
                    'mcs = f[p]', 'p += 1',
                    'data, p = gif_sub(f, p)', 'idx = gif_lzw_dec(data, mcs)',
                    'for y in range(h):', '    r = idx[y * w:(y + 1) * w]', '    print(' + c.out + ')']),
                { shape: hexIn, limit: 3, helpers: () => pick(['gif_sub', 'gif_lzw_dec']) }),
            D('gif.encode', 'gif-encode', 'GIF 編碼：由原始封包組出邏輯螢幕描述子與全域調色盤（補到 2 的冪次）、影像描述子、確定性 LZW 編碼的子區塊，輸出檔案的十六進位',
                [],
                (c, N) => code(['d = bytes.fromhex(' + hx(N) + '.strip())',
                    'w = int.from_bytes(d[0:2], "big")', 'h = int.from_bytes(d[2:4], "big")', 'k = d[4]',
                    'pal = d[5:5 + 3 * k]', 'px = d[5 + 3 * k:5 + 3 * k + w * h]',
                    'bits = max(1, (k - 1).bit_length())', 'mcs = max(2, bits)',
                    'pal = pal + bytes(3 * (1 << bits) - len(pal))',
                    'body = gif_lzw_enc(px, mcs)',
                    'le = lambda v: v.to_bytes(2, "little")',
                    'out = b"GIF89a" + le(w) + le(h) + bytes([128 | (bits - 1), 0, 0]) + pal + bytes([44]) + bytes(4) + le(w) + le(h) + bytes([0]) + bytes([mcs]) + gif_sub_pack(body) + bytes([59])',
                    'print(out.hex())']),
                { shape: hexIn, limit: 3, helpers: () => pick(['gif_w', 'gif_lzw_enc', 'gif_sub_pack']) })
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'gif-decode', re: ALL('GIF', '(?:解碼|解壓|還原|讀取|解析|讀|解開)'), veto: /寫出|編碼|組出|產生|寫成|壓縮成/ },
            { key: 'gif-encode', re: ALL('GIF', '(?:編碼|編成|做成|製成|製作|寫出|組出|寫成|壓縮成|產生)'), veto: /解碼|解壓|還原|讀取|解析|解開/ }
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['binary-format'];
        return { id: 'gif', label: 'GIF 讀寫（單張影格，LZW 變長碼，全域／局部調色盤）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make, HELP };
});
