/* 領域包：JPEG 讀寫（基線、8 位元、灰階、單一元件 1×1 取樣；標準量化表與霍夫曼表）。格式見 domain_registry_core.js。
 * jpeg.decode：輸入一行十六進位的整個 JPEG 檔；讀 DQT／DHT／SOF0／SOS，接著解霍夫曼（DC 差分、AC 游程與 ZRL／EOB），
 *   反量化、整數 IDCT（與 jpeg.encode 共用同一張 2^12 縮放的餘弦表），每列輸出灰階值（十進位或十六進位）。
 * jpeg.encode：輸入一行十六進位的「原始影像封包」：寬（2 位元組大端）、高（2 位元組大端），其後 寬×高 個灰階位元組（列由上到下）。
 *   輸出 JPEG 檔的十六進位：SOI＋DQT（固定為 quality 50 的標準亮度表）＋SOF0＋DHT（標準 DC、AC 表）＋SOS＋熵編碼資料（位元組填充 0xFF00、尾端以 1 補齊）＋EOI。
 *   寬高不是 8 的倍數時，邊界以最後一列／行複製補齊。整數 FDCT、四捨五入量化，全部是確定性的整數運算。
 * 標準表的來源：由 Pillow（quality=50、optimize=False）寫出的檔抽取 DQT（zigzag 順序）與 DHT，常數寫在下方 JPG_TABLES，不手抄。
 * 誠實限制：只做灰階、單一元件、1×1 取樣、非漸進式、沒有重新啟動標記；不做彩色（YCbCr、4:2:0）與漸進式；不驗證 EOI。
 * 與 libjpeg 的差異：IDCT／FDCT 是精確公式的整數版（不是 libjpeg 的 islow），解碼結果與 Pillow 可能差 ±1～2，外部驗證以容許誤差判定。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainJpeg = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const JPG_TABLES = {
      Q: [16, 11, 12, 14, 12, 10, 16, 14, 13, 14, 18, 17, 16, 19, 24, 40, 26, 24, 22, 22, 24, 49, 35, 37, 29, 40, 58, 51, 61, 60, 57, 51, 56, 55, 64, 72, 92, 78, 64, 68, 87, 69, 55, 56, 80, 109, 81, 87, 95, 98, 103, 104, 103, 62, 77, 113, 121, 112, 100, 120, 92, 101, 103, 99],
      DC_BITS: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
      DC_VALS: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      AC_BITS: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125],
      AC_VALS: [1, 2, 3, 0, 4, 17, 5, 18, 33, 49, 65, 6, 19, 81, 97, 7, 34, 113, 20, 50, 129, 145, 161, 8, 35, 66, 177, 193, 21, 82, 209, 240, 36, 51, 98, 114, 130, 9, 10, 22, 23, 24, 25, 26, 37, 38, 39, 40, 41, 42, 52, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73, 74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105, 106, 115, 116, 117, 118, 119, 120, 121, 122, 131, 132, 133, 134, 135, 136, 137, 138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196, 197, 198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250]
    };

    const HELP = {
        // 之字形順序：第 k 個係數在自然順序（列×8＋行）中的位置
        jpg_zz: { params: [], py: [
            'return sorted(range(64), key=lambda n: ((n // 8) + (n % 8), (n // 8) if ((n // 8) + (n % 8)) % 2 else -(n // 8)))'
        ] },
        // 餘弦表（含 C(u)），2^12 縮放並四捨五入：T[u][x]
        jpg_T: { params: [], py: [
            'import math',
            'return [[round(4096 * (math.sqrt(0.5) if u == 0 else 1.0) * math.cos((2 * x + 1) * u * math.pi / 16)) for x in range(8)] for u in range(8)]'
        ] },
        // 霍夫曼解碼表：(碼長, 碼字) → 符號（標準正則碼）
        jpg_huff: { params: ['bits', 'vals'], py: [
            'tbl = {}',
            'code = 0',
            'k = 0',
            'for l in range(1, 17):',
            '    for _ in range(bits[l - 1]):',
            '        tbl[(l, code)] = vals[k]',
            '        code += 1',
            '        k += 1',
            '    code <<= 1',
            'return tbl'
        ] },
        // 霍夫曼編碼表：符號 → (碼字, 碼長)
        jpg_hcode: { params: ['bits', 'vals'], py: [
            'tbl = {}',
            'code = 0',
            'k = 0',
            'for l in range(1, 17):',
            '    for _ in range(bits[l - 1]):',
            '        tbl[vals[k]] = (code, l)',
            '        code += 1',
            '        k += 1',
            '    code <<= 1',
            'return tbl'
        ] },
        // 熵編碼資料：從 p 讀到下一個標記；0xFF00 還原為 0xFF；回傳位元字串（高位先）
        jpg_bits: { params: ['f', 'p'], py: [
            'out = []',
            'while True:',
            '    b = f[p]',
            '    if b == 255:',
            '        if f[p + 1] == 0:',
            '            out.append(255)',
            '            p += 2',
            '            continue',
            '        break',
            '    out.append(b)',
            '    p += 1',
            'return "".join(format(b, "08b") for b in out)'
        ] },
        // 霍夫曼符號：逐位元走碼表，回傳（符號, 新位置）
        jpg_sym: { params: ['bits', 'pos', 'tbl'], py: [
            'code = 0',
            'for l in range(1, 17):',
            '    code = (code << 1) | int(bits[pos])',
            '    pos += 1',
            '    if (l, code) in tbl:',
            '        return tbl[(l, code)], pos',
            'raise ValueError("bad huffman code")'
        ] },
        // 接收並擴展 n 個位元：高位為 0 時為負數（JPEG 的 receive_extend）
        jpg_ext: { params: ['bits', 'pos', 'n'], py: [
            'if n == 0:',
            '    return 0, pos',
            'v = int(bits[pos:pos + n], 2)',
            'if v < (1 << (n - 1)):',
            '    v -= (1 << n) - 1',
            'return v, pos + n'
        ] },
        // 解一個區塊：DC 差分（回傳新的預測值）、AC 游程（之字形順序的係數）
        jpg_block: { params: ['bits', 'pos', 'dct', 'act', 'pred'], py: [
            't, pos = jpg_sym(bits, pos, dct)',
            'd, pos = jpg_ext(bits, pos, t)',
            'pred += d',
            'co = [0] * 64',
            'co[0] = pred',
            'k = 1',
            'while k < 64:',
            '    rs, pos = jpg_sym(bits, pos, act)',
            '    r = rs >> 4',
            '    s = rs & 15',
            '    if s == 0:',
            '        if r == 15:',
            '            k += 16',
            '            continue',
            '        break',
            '    k += r',
            '    v, pos = jpg_ext(bits, pos, s)',
            '    co[k] = v',
            '    k += 1',
            'return co, pos, pred'
        ] },
        // 整數 IDCT：nat 為自然順序的反量化係數；回傳 64 個取樣（列由上到下），+128 並夾在 0～255
        jpg_idct: { params: ['nat', 'T'], py: [
            'out = [0] * 64',
            'for y in range(8):',
            '    for x in range(8):',
            '        S = 0',
            '        for v in range(8):',
            '            for u in range(8):',
            '                S += nat[v * 8 + u] * T[v][y] * T[u][x]',
            '        val = ((S + (1 << 25)) >> 26) + 128',
            '        out[y * 8 + x] = 0 if val < 0 else (255 if val > 255 else val)',
            'return out'
        ] },
        // 整數 FDCT：blk 為 8×8（已減 128），回傳自然順序的係數（四捨五入）
        jpg_fdct: { params: ['blk', 'T'], py: [
            'F = [0] * 64',
            'for v in range(8):',
            '    for u in range(8):',
            '        S = 0',
            '        for y in range(8):',
            '            for x in range(8):',
            '                S += blk[y][x] * T[v][y] * T[u][x]',
            '        F[v * 8 + u] = (S + (1 << 25)) >> 26',
            'return F'
        ] },
        // 編碼一個區塊（C 為量化後、之字形順序的係數）：DC 差分類別＋擴展位元；AC 游程（ZRL、EOB）；回傳位元字串
        jpg_block_enc: { params: ['C', 'pred', 'dct', 'act'], py: [
            'out = []',
            'diff = C[0] - pred',
            's = abs(diff).bit_length()',
            'code, l = dct[s]',
            'out.append(format(code, "0%db" % l))',
            'if s:',
            '    v = diff if diff > 0 else diff + (1 << s) - 1',
            '    out.append(format(v, "0%db" % s))',
            'run = 0',
            'for k in range(1, 64):',
            '    v = C[k]',
            '    if v == 0:',
            '        run += 1',
            '        continue',
            '    while run > 15:',
            '        code, l = act[240]',
            '        out.append(format(code, "0%db" % l))',
            '        run -= 16',
            '    s = abs(v).bit_length()',
            '    code, l = act[(run << 4) | s]',
            '    out.append(format(code, "0%db" % l))',
            '    vb = v if v > 0 else v + (1 << s) - 1',
            '    out.append(format(vb, "0%db" % s))',
            '    run = 0',
            'if run > 0:',
            '    code, l = act[0]',
            '    out.append(format(code, "0%db" % l))',
            'return "".join(out)'
        ] },
        // 位元字串 → 含填充的位元組（尾端以 1 補齊；0xFF 後補 0x00）
        jpg_pack: { params: ['bits'], py: [
            'bits += "1" * (-len(bits) % 8)',
            'out = bytearray()',
            'for i in range(0, len(bits), 8):',
            '    b = int(bits[i:i + 8], 2)',
            '    out.append(b)',
            '    if b == 255:',
            '        out.append(0)',
            'return bytes(out)'
        ] }
    };
    const pick = (names) => names.map((n) => ({ name: n, params: HELP[n].params, py: HELP[n].py }));
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'binary-format', label, slots, py }, extra || {});
        const hexIn = (I) => I.inputs.length === 1 && I.inputs[0].k === 'hex';
        const hx = (N) => N.s[0];
        const PYL = (v) => JSON.stringify(v);
        const TBL = [
            'QZ = ' + PYL(JPG_TABLES.Q), 'DCB = ' + PYL(JPG_TABLES.DC_BITS), 'DCV = ' + PYL(JPG_TABLES.DC_VALS),
            'ACB = ' + PYL(JPG_TABLES.AC_BITS), 'ACV = ' + PYL(JPG_TABLES.AC_VALS)
        ];
        const skeletons = [
            D('jpeg.decode', 'jpeg-decode', 'JPEG 解碼（灰階基線）：解析標記（DQT、DHT、SOF0、SOS），霍夫曼解碼（DC 差分、AC 游程），反量化、整數 IDCT；每列輸出灰階值（十進位或十六進位）',
                [S('out', '每列輸出', [['dec', '" ".join(str(v) for v in row)'], ['hex', 'bytes(row).hex()']])],
                (c, N) => code(['f = bytes.fromhex(' + hx(N) + '.strip())',
                    'ZZ = jpg_zz()', 'T = jpg_T()',
                    'tables = {}', 'dqt = []', 'Hh = 0', 'Ww = 0',
                    'p = 2',
                    'while f[p + 1] != 218:',
                    '    m = f[p + 1]',
                    '    L = f[p + 2] * 256 + f[p + 3]',
                    '    seg = f[p + 4:p + 2 + L]',
                    '    if m == 219:',
                    '        dqt = list(seg[1:65])',
                    '    if m == 196:',
                    '        q = 0',
                    '        while q < len(seg):',
                    '            tc = seg[q]',
                    '            bl = list(seg[q + 1:q + 17])',
                    '            n = sum(bl)',
                    '            tables[tc] = jpg_huff(bl, list(seg[q + 17:q + 17 + n]))',
                    '            q += 17 + n',
                    '    if m == 192:',
                    '        Hh = seg[1] * 256 + seg[2]',
                    '        Ww = seg[3] * 256 + seg[4]',
                    '    p += 2 + L',
                    'Ls = f[p + 2] * 256 + f[p + 3]',
                    'bits = jpg_bits(f, p + 2 + Ls)',
                    'dct = tables[0]', 'act = tables[16]',
                    'bw = (Ww + 7) // 8', 'bh = (Hh + 7) // 8',
                    'img = [[0] * (bw * 8) for _ in range(bh * 8)]',
                    'pos = 0', 'pred = 0',
                    'for by in range(bh):',
                    '    for bx in range(bw):',
                    '        co, pos, pred = jpg_block(bits, pos, dct, act, pred)',
                    '        nat = [0] * 64',
                    '        for k in range(64):',
                    '            nat[ZZ[k]] = co[k] * dqt[k]',
                    '        smp = jpg_idct(nat, T)',
                    '        for y in range(8):',
                    '            for x in range(8):',
                    '                img[by * 8 + y][bx * 8 + x] = smp[y * 8 + x]',
                    'for y in range(Hh):',
                    '    row = img[y][:Ww]',
                    '    print(' + c.out + ')']),
                { shape: hexIn, limit: 2, helpers: () => pick(['jpg_zz', 'jpg_T', 'jpg_huff', 'jpg_bits', 'jpg_sym', 'jpg_ext', 'jpg_block', 'jpg_idct']) }),
            D('jpeg.encode', 'jpeg-encode', 'JPEG 編碼（灰階基線，固定標準表）：整數 FDCT、四捨五入量化（quality 50 的亮度表）、之字形、DC 差分與 AC 游程霍夫曼編碼，組出 SOI／DQT／SOF0／DHT／SOS／EOI，輸出檔案的十六進位',
                [],
                (c, N) => code(TBL.concat(['d = bytes.fromhex(' + hx(N) + '.strip())',
                    'W = int.from_bytes(d[0:2], "big")', 'H = int.from_bytes(d[2:4], "big")',
                    'px = d[4:4 + W * H]',
                    'ZZ = jpg_zz()', 'T = jpg_T()',
                    'dce = jpg_hcode(DCB, DCV)', 'ace = jpg_hcode(ACB, ACV)',
                    'bw = (W + 7) // 8', 'bh = (H + 7) // 8',
                    'bits = []', 'pred = 0',
                    'for by in range(bh):',
                    '    for bx in range(bw):',
                    '        blk = [[0] * 8 for y in range(8)]',
                    '        for y in range(8):',
                    '            for x in range(8):',
                    '                blk[y][x] = px[min(by * 8 + y, H - 1) * W + min(bx * 8 + x, W - 1)] - 128',
                    '        F = jpg_fdct(blk, T)',
                    '        C = []',
                    '        for k in range(64):',
                    '            q = QZ[k]', '            v = F[ZZ[k]]',
                    '            a = (abs(v) + q // 2) // q',
                    '            C.append(a if v >= 0 else -a)',
                    '        bits.append(jpg_block_enc(C, pred, dce, ace))',
                    '        pred = C[0]',
                    'seg = lambda m, dat: bytes([255, m]) + (len(dat) + 2).to_bytes(2, "big") + dat',
                    'out = bytes([255, 216])',
                    'out += seg(219, bytes([0]) + bytes(QZ))',
                    'out += seg(192, bytes([8]) + H.to_bytes(2, "big") + W.to_bytes(2, "big") + bytes([1, 1, 17, 0]))',
                    'out += seg(196, bytes([0]) + bytes(DCB) + bytes(DCV))',
                    'out += seg(196, bytes([16]) + bytes(ACB) + bytes(ACV))',
                    'out += seg(218, bytes([1, 1, 0, 0, 63, 0]))',
                    'out += jpg_pack("".join(bits))',
                    'out += bytes([255, 217])',
                    'print(out.hex())'])),
                { shape: hexIn, limit: 2, helpers: () => pick(['jpg_zz', 'jpg_T', 'jpg_hcode', 'jpg_fdct', 'jpg_block_enc', 'jpg_pack']) })
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'jpeg-decode', re: ALL('JPEG', '(?:解碼|解壓|還原|讀取|解析|讀|解開)'), veto: /寫出|編碼|組出|產生|寫成|壓縮成/ },
            { key: 'jpeg-encode', re: ALL('JPEG', '(?:編碼|編成|寫出|組出|寫成|壓縮成|產生)'), veto: /解碼|解壓|還原|讀取|解析|解開/ }
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['binary-format'];
        return { id: 'jpeg', label: 'JPEG 讀寫（灰階基線，標準霍夫曼與量化表，整數 DCT）', requires: [], judge: { checker: 'tokens', timeoutMs: 60000 }, algos, paradigms, skeletons };
    }
    return { make, HELP, TABLES: JPG_TABLES };
});
