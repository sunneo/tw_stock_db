/* 領域包：PCX 讀寫（ZSoft 版本 5、RLE 逐掃描線；8 位元單平面＋檔尾 256 色調色盤，或 8 位元三平面 RGB）。格式見 domain_registry_core.js。
 * pcx.decode：輸入一行十六進位的整個 PCX 檔；表頭 128 位元組（寬高由 Xmin／Ymin／Xmax／Ymax 算出，平面數在第 65 位元組，每平面每列的位元組數 bytes_per_line 在 66～67 小端），
 *   資料用 RLE 解開（位元組 ≥ 0xC0 是「數量＋值」，其餘是字面值），然後每列輸出：每像素的 RGB 十六進位，或整列連成的 RGB 十六進位。
 * pcx.encode：輸入一行十六進位的「原始影像封包」：寬（2 位元組大端）、高（2 位元組大端）、平面數（1＝調色盤、3＝RGB）；
 *   平面 1：之後 768 位元組是 256 色 RGB 調色盤，再是 寬×高 個索引（列由上到下）；平面 3：之後是 寬×高×3 個 RGB 位元組（列由上到下）。
 *   輸出 PCX 檔的十六進位：128 位元組表頭（版本 5、RLE、8 位元、bytes_per_line＝寬），逐掃描線（每平面）做 RLE，單平面再加 0x0C 與 768 位元組調色盤。
 * 誠實限制：只支援 8 位元每平面、版本 5 表頭（表頭中的 16 色調色盤與解析度不解讀）；RLE 的單位是掃描線，寫出端不跨列；不支援 1／4 位元與 PCX 版本 2 的舊式表頭。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainPcx = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const HELP = {
        // 解開 RLE：從 p 開始讀，直到得到 total 個位元組；回傳前 total 個
        pcx_rle: { params: ['f', 'p', 'total'], py: [
            'out = bytearray()',
            'while len(out) < total:',
            '    b = f[p]',
            '    p += 1',
            '    if (b & 192) == 192:',
            '        n = b & 63',
            '        out += bytes([f[p]]) * n',
            '        p += 1',
            '    else:',
            '        out.append(b)',
            'return bytes(out[:total])'
        ] },
        // 一條掃描線的 RLE 編碼：連續相同的值 2 個以上（或值 ≥ 0xC0）就用 0xC0|數量 加值；每段最多 63
        pcx_rle_enc: { params: ['line'], py: [
            'out = bytearray()',
            'i = 0',
            'while i < len(line):',
            '    v = line[i]',
            '    n = 1',
            '    while i + n < len(line) and line[i + n] == v and n < 63:',
            '        n += 1',
            '    if n > 1 or v >= 192:',
            '        out.append(192 | n)',
            '        out.append(v)',
            '    else:',
            '        out.append(v)',
            '    i += n',
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
            D('pcx.decode', 'pcx-decode', 'PCX 解碼：讀 128 位元組表頭（寬高、平面數、每平面每列位元組數），解開 RLE；單平面用檔尾調色盤查 RGB，三平面依 R／G／B 平面組出 RGB；每列輸出（每像素 RGB 十六進位／整列 RGB 十六進位）',
                [S('out', '每列輸出', [['px', '" ".join(x.hex() for x in cols)'], ['hex', '"".join(x.hex() for x in cols)']])],
                (c, N) => code(['f = bytes.fromhex(' + hx(N) + '.strip())',
                    'np_ = f[65]', 'bpl = f[66] | (f[67] << 8)',
                    'w = (f[8] | (f[9] << 8)) - (f[4] | (f[5] << 8)) + 1',
                    'h = (f[10] | (f[11] << 8)) - (f[6] | (f[7] << 8)) + 1',
                    'raw = pcx_rle(f, 128, h * np_ * bpl)', 'pal = f[len(f) - 768:]',
                    'for y in range(h):',
                    '    base = y * np_ * bpl',
                    '    if np_ == 1:',
                    '        cols = [pal[3 * v:3 * v + 3] for v in raw[base:base + w]]',
                    '    else:',
                    '        R = raw[base:base + w]', '        G = raw[base + bpl:base + bpl + w]', '        B = raw[base + 2 * bpl:base + 2 * bpl + w]',
                    '        cols = [bytes([R[i], G[i], B[i]]) for i in range(w)]',
                    '    print(' + c.out + ')']),
                { shape: hexIn, limit: 2, helpers: () => pick(['pcx_rle']) }),
            D('pcx.encode', 'pcx-encode', 'PCX 編碼：由原始封包組 128 位元組版本 5 表頭（8 位元、RLE、bytes_per_line＝寬），逐掃描線做 RLE；單平面再接 0x0C 與 768 位元組調色盤，輸出檔案的十六進位',
                [],
                (c, N) => code(['d = bytes.fromhex(' + hx(N) + '.strip())',
                    'w = int.from_bytes(d[0:2], "big")', 'h = int.from_bytes(d[2:4], "big")', 'npl = d[4]',
                    'body = d[5:]',
                    'if npl == 1:',
                    '    pal = body[:768]', '    px = body[768:768 + w * h]',
                    '    lines = [px[y * w:(y + 1) * w] for y in range(h)]',
                    '    tail = bytes([12]) + pal',
                    'else:',
                    '    px = body[:3 * w * h]', '    lines = []',
                    '    for y in range(h):',
                    '        row = px[3 * w * y:3 * w * (y + 1)]',
                    '        lines += [row[0::3], row[1::3], row[2::3]]',
                    '    tail = b""',
                    'data = b"".join(pcx_rle_enc(x) for x in lines)',
                    'le = lambda v: v.to_bytes(2, "little")',
                    'hdr = bytes([10, 5, 1, 8]) + bytes(4) + le(w - 1) + le(h - 1) + bytes(4) + bytes(48) + bytes([0, npl]) + le(w) + le(1) + bytes(4) + bytes(54)',
                    'print((hdr + data + tail).hex())']),
                { shape: hexIn, limit: 2, helpers: () => pick(['pcx_rle_enc']) })
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'pcx-decode', re: ALL('PCX', '(?:解碼|解壓|還原|讀取|解析|讀|解開)'), veto: /寫出|編碼|組出|產生|寫成|壓縮成/ },
            { key: 'pcx-encode', re: ALL('PCX', '(?:編碼|寫出|組出|寫成|壓縮成|產生)'), veto: /解碼|解壓|還原|讀取|解析|解開/ }
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['binary-format'];
        return { id: 'pcx', label: 'PCX 讀寫（ZSoft 版本 5，RLE，8 位元調色盤或三平面 RGB）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make, HELP };
});
