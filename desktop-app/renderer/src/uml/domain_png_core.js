/* 領域包：PNG 讀寫（8 位元灰階／RGB／灰階加 alpha／RGBA，非交錯）。格式見 domain_registry_core.js。
 * png.decode：讀區塊（長度大端、型別、資料、CRC 不驗），把所有 IDAT 接起來用 zlib 解壓，再依每列的過濾型別 0～4 還原（Sub／Up／Average／Paeth）；
 *   每列輸出的形式是槽位（每像素的十六進位、整列十六進位、整列十進位位元組），由沙盒窮舉。
 * png.encode：輸入一行十六進位的「原始影像封包」：前 4 位元組寬（大端）、接著 4 位元組高（大端）、再 1 位元組每像素位元組數（1 灰階、3 RGB、4 RGBA），其餘是像素（列由上到下）；每列前置過濾型別 0，zlib.compress 預設壓縮，
 *   輸出 PNG 檔的十六進位（簽章＋IHDR＋IDAT＋IEND，CRC-32 用 zlib.crc32）。
 * 誠實限制：只支援 8 位元深度、非交錯（Adam7）、沒有調色盤（色彩型別 3）；不驗證 CRC；寫出端只用過濾型別 0（輸出可逐位元比對）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainPng = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const HELP = {
        // 回傳 [(型別位元組, 資料位元組), ...]，讀到 IEND 為止
        png_chunks: { params: ['data'], py: [
            'pos = 8',
            'out = []',
            'while pos + 8 <= len(data):',
            '    n = int.from_bytes(data[pos:pos + 4], "big")',
            '    t = data[pos + 4:pos + 8]',
            '    out.append((t, data[pos + 8:pos + 8 + n]))',
            '    pos += 12 + n',
            '    if t == b"IEND":',
            '        break',
            'return out'
        ] },
        // 把所有 IDAT 接起來並 zlib 解壓
        png_idat: { params: ['ch'], py: [
            'import zlib',
            'return zlib.decompress(b"".join(d for t, d in ch if t == b"IDAT"))'
        ] },
        // 依過濾型別還原像素（每列 1 個過濾位元組＋ w*bpp 個位元組）；回傳還原後的所有像素位元組
        png_unfilter: { params: ['raw', 'w', 'h', 'bpp'], py: [
            'st = w * bpp',
            'out = bytearray()',
            'prev = bytearray(st)',
            'p = 0',
            'for y in range(h):',
            '    f = raw[p]',
            '    line = bytearray(raw[p + 1:p + 1 + st])',
            '    p += 1 + st',
            '    for i in range(st):',
            '        a = line[i - bpp] if i >= bpp else 0',
            '        b = prev[i]',
            '        c = prev[i - bpp] if i >= bpp else 0',
            '        if f == 1:',
            '            line[i] = (line[i] + a) & 255',
            '        elif f == 2:',
            '            line[i] = (line[i] + b) & 255',
            '        elif f == 3:',
            '            line[i] = (line[i] + ((a + b) >> 1)) & 255',
            '        elif f == 4:',
            '            pp = a + b - c',
            '            pa = abs(pp - a)',
            '            pb = abs(pp - b)',
            '            pc = abs(pp - c)',
            '            pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)',
            '            line[i] = (line[i] + pr) & 255',
            '    out += line',
            '    prev = line',
            'return bytes(out)'
        ] },
        // 一個 PNG 區塊：長度（大端）＋型別＋資料＋CRC-32（涵蓋型別與資料，大端）
        png_chunk: { params: ['t', 'd'], py: [
            'import zlib',
            'return len(d).to_bytes(4, "big") + t + d + (zlib.crc32(t + d) & 4294967295).to_bytes(4, "big")'
        ] }
    };
    const pick = (names) => names.map((n) => ({ name: n, params: HELP[n].params, py: HELP[n].py }));
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'binary-format', label, slots, py }, extra || {});
        const hexIn = (I) => I.inputs.length === 1 && I.inputs[0].k === 'hex';
        const hx = (N) => N.s[0];
        const BPP = [['1', '1'], ['3', '3'], ['4', '4']];
        const skeletons = [
            D('png.decode', 'png-decode', 'PNG 解碼：讀區塊、接起所有 IDAT、zlib 解壓、依每列過濾型別 0～4 還原像素；每列輸出（每像素十六進位／整列十六進位／整列十進位）',
                [S('out', '每列輸出', [['px', '" ".join(r[i:i + bpp].hex() for i in range(0, len(r), bpp))'], ['hex', 'r.hex()'], ['dec', '" ".join(str(v) for v in r)']])],
                (c, N) => code(['ch = png_chunks(bytes.fromhex(' + hx(N) + '.strip()))',
                    'ihdr = ch[0][1]', 'w = int.from_bytes(ihdr[0:4], "big")', 'h = int.from_bytes(ihdr[4:8], "big")',
                    'bpp = {0: 1, 2: 3, 4: 2, 6: 4}[ihdr[9]]',
                    'img = png_unfilter(png_idat(ch), w, h, bpp)', 'st = w * bpp',
                    'for y in range(h):', '    r = img[y * st:(y + 1) * st]', '    print(' + c.out + ')']),
                { shape: hexIn, limit: 3, helpers: () => pick(['png_chunks', 'png_idat', 'png_unfilter']) }),
            D('png.encode', 'png-encode', 'PNG 編碼：每列前置過濾型別 0，zlib.compress 預設壓縮，組出簽章＋IHDR＋IDAT＋IEND，輸出完整檔案的十六進位',
                [],
                (c, N) => code(['import zlib',
                    'data_ = bytes.fromhex(' + hx(N) + '.strip())',
                    'w = int.from_bytes(data_[0:4], "big")', 'h = int.from_bytes(data_[4:8], "big")', 'bpp = data_[8]',
                    'px = data_[9:]', 'st = w * bpp',
                    'raw = b"".join(b"\\x00" + px[y * st:(y + 1) * st] for y in range(h))',
                    'ct = {1: 0, 3: 2, 4: 6}[bpp]',
                    'ihdr = w.to_bytes(4, "big") + h.to_bytes(4, "big") + bytes([8, ct, 0, 0, 0])',
                    'out = b"\\x89PNG\\r\\n\\x1a\\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", zlib.compress(raw)) + png_chunk(b"IEND", b"")',
                    'print(out.hex())']),
                { shape: hexIn, limit: 3, helpers: () => pick(['png_chunk']) })
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'png-decode', re: ALL('PNG', '(?:解碼|解壓|還原|讀取|解析|讀)'), veto: /寫出|編碼|組出|產生|寫成|壓縮成/ },
            { key: 'png-encode', re: ALL('PNG', '(?:編碼|寫出|組出|寫成|壓縮成|產生)'), veto: /解碼|解壓|還原|讀取|解析/ }
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['binary-format'];
        return { id: 'png', label: 'PNG 讀寫（8 位元灰階／RGB／RGBA，過濾 0～4，zlib）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make, HELP };
});
