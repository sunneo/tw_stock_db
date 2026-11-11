/* 領域包：影音壓縮階段 5「有損影像」的小波部分（見 DESIGN.blockly-curriculum.md §5、DESIGN.media-codec-domain.md §2E）。
 * 本檔目前做兩個整數小波子元件：
 *   img.haar1d：一層 Haar（整數版）：每對 (a,b) 得低頻 (a+b)>>1 與高頻 a-b。
 *   img.legall53：一層 LeGall 5/3 整數提升（JPEG 2000 可逆版）：先算高頻 d，再算低頻 s；邊界用對稱延伸。
 * 格式同 domain_h264dec_core.js：make(PAR) 回傳 {id, label, requires, judge, algos, paradigms, skeletons}。
 * 輸入：一行 8 個整數；輸出：兩行，第一行是低頻（4 個），第二行是高頻（4 個）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainAvimage = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'codec-transform', label, slots, py }, extra || {});
        const numIn = (I) => I.inputs.length === 1 && (I.inputs[0].k === 'list' || (I.inputs[0].k === 'str' && I.inputs[0].raw));
        const nums = (N, I) => (I.inputs[0].k === 'list' ? N.ls[0] : '[int(t) for t in ' + N.s[0] + '.split()]');
        const skeletons = [
            D('img.haar1d', 'img-haar1d', '一層 Haar 小波（整數版）：輸入一行 8 個整數，兩兩一組 (a,b)；低頻為 (a+b) 右移 1 位（向下取整），高頻為 a 減 b；輸出兩行，第一行為低頻（4 個），第二行為高頻（4 個）',
                [],
                (c, N, I) => code(['v = ' + nums(N, I), 'lo = []', 'hi = []', 'for i in range(0, len(v), 2):', '    lo.append((v[i] + v[i + 1]) >> 1)', '    hi.append(v[i] - v[i + 1])', 'print(*lo)', 'print(*hi)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            D('img.legall53', 'img-legall53', 'LeGall 5/3 整數提升（一層，可逆）：輸入一行 8 個整數，記為 x0 至 x7。先算高頻 d[i]＝x[2i+1] 減去 (x[2i] 加上右鄰 x[2i+2]) 右移 1 位（右鄰超出右端時用 x[2i]，即對稱延伸）；再算低頻 s[i]＝x[2i] 加上 (d[i-1] 加上 d[i] 加 2) 右移 2 位（i 為 0 時 d[-1] 取 d[0]）。輸出兩行：第一行是 s（4 個），第二行是 d（4 個）',
                [],
                (c, N, I) => code(['v = ' + nums(N, I), 'n = len(v)', 'N2 = n // 2', 'd = []', 'for i in range(N2):', '    xr = v[2 * i]', '    if 2 * i + 2 < n:', '        xr = v[2 * i + 2]', '    d.append(v[2 * i + 1] - ((v[2 * i] + xr) >> 1))', 's = []', 'for i in range(N2):', '    dl = d[i]', '    if i > 0:', '        dl = d[i - 1]', '    s.append(v[2 * i] + ((dl + d[i] + 2) >> 2))', 'print(*s)', 'print(*d)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 8×8 二維 DCT-II（正交縮放：a(0)＝√(1/8)，其餘 a＝1/2）後以均勻量化步長 Q 量化，捨入為 floor(c/Q＋0.5)。
            D('img.dct8q', 'img-dct8q', '8×8 二維 DCT 與量化：輸入一行 65 個整數，第一個是量化步長 Q，其後 64 個是 8×8 區塊的像素（依列排列，已減去 128）。以 DCT-II 正交縮放（第 0 個係數的縮放為 √(1/8)，其餘為 1/2），每個係數 c 先除以 Q 再加 0.5 後向下取整，得到量化係數。輸出 8 行，每行 8 個整數（依 u 列、v 行）',
                [],
                (c, N, I) => code(['import math', 'v = ' + nums(N, I), 'Q = v[0]', 'out = []', 'for u in range(8):', '    row = []', '    for w in range(8):', '        s = 0.0', '        for x in range(8):', '            for y in range(8):', '                s = s + v[1 + 8 * x + y] * math.cos((2 * x + 1) * u * math.pi / 16) * math.cos((2 * y + 1) * w * math.pi / 16)', '        au = 0.5', '        if u == 0:', '            au = math.sqrt(0.125)', '        aw = 0.5', '        if w == 0:', '            aw = math.sqrt(0.125)', '        row.append(math.floor(au * aw * s / Q + 0.5))', '    print(*row)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 8×8 Z 字形掃描（JPEG 之字形）：依反對角線 s＝i＋j 由 0 到 14；s 為偶數時 i 由大到小（左下往右上），奇數時 i 由小到大（右上往左下）。
            D('img.zigzag8', 'img-zigzag8', '8×8 Z 字形掃描：輸入一行 64 個整數，依列優先排列（第 i 列第 j 行的位置為 8i＋j）。依反對角線 s＝i＋j 由 0 到 14 走訪：s 為偶數時 i 由大到小（左下往右上），s 為奇數時 i 由小到大（右上往左下）。輸出一行 64 個整數（依掃描順序）',
                [],
                (c, N, I) => code(['v = ' + nums(N, I), 'out = []', 'for s in range(15):', '    cells = []', '    for i in range(8):', '        j = s - i', '        if j >= 0 and j < 8:', '            cells.append((i, j))', '    if s % 2 == 0:', '        cells.reverse()', '    for i, j in cells:', '        out.append(v[8 * i + j])', 'print(*out)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 零游程編碼（已依 Z 字形排成一行 64 個係數）：每個非零值輸出一行「前面連續零的個數 值」，最後輸出一行 EOB。
            D('img.rle64', 'img-rle64', '零游程編碼：輸入一行 64 個整數（已依 Z 字形排好的量化係數）。從前往後逐一查看，每遇到一個非零值，輸出一行兩個整數：它前面連續的零的個數，以及該非零值本身；全部掃完後輸出一行 EOB。',
                [],
                (c, N, I) => code(['v = ' + nums(N, I), 'run = 0', 'for x in v:', '    if x == 0:', '        run = run + 1', '    else:', '        print(run, x)', '        run = 0', 'print("EOB")']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 霍夫曼解碼（canonical 規則）：輸入一行 16 個整數：前 4 個是符號 0 至 3 的碼長，其後 12 個是位元。依碼長由小到大、同長依符號由小到大指派碼字（碼由 0 開始遞增，碼長增加時左移），輸出位元開頭符合的第一個符號。
            D('img.huff4', 'img-huff4', '霍夫曼解碼（canonical 規則）：輸入一行 16 個整數，前 4 個是符號 0 至 3 的碼長（1 至 3），其後 12 個是位元（0 或 1）。依碼長由小到大、同長依符號由小到大指派碼字（碼由 0 開始逐一遞增，碼長增加時左移），從位元開頭比對，輸出第一個解出的符號',
                [],
                (c, N, I) => code(['v = ' + (I.inputs[0].k === 'list' ? N.ls[0] : '[int(t) for t in ' + N.s[0] + '.split()]'), 'L = v[0:4]', 'bits = ""', 'for x in v[4:16]:', '    bits = bits + str(x)', 'order = []', 'for l in range(1, 4):', '    for s in range(4):', '        if L[s] == l:', '            order.append(s)', 'cw = {}', 'code = 0', 'prevlen = L[order[0]]', 'for s in order:', '    code = code << (L[s] - prevlen)', '    cw[s] = format(code, "0%db" % L[s])', '    code = code + 1', '    prevlen = L[s]', 'ans = -1', 'for s in order:', '    if ans < 0 and bits.startswith(cw[s]):', '        ans = s', 'print(ans)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'img-haar1d', re: ALL('(?:Haar|哈爾)', '(?:小波|wavelet)'), veto: /5\s*\/\s*3|LeGall|提升/i },
            { key: 'img-legall53', re: ALL('(?:5\\s*/\\s*3|LeGall|萊加爾)', '(?:小波|提升|lifting|wavelet)'), veto: /Haar|哈爾/i },
            { key: 'img-dct8q', re: ALL('8\\s*[x×*乘]\\s*8', '(?:DCT|離散餘弦)'), veto: /小波|Haar|哈爾|5\s*\/\s*3|掃描/i },
            { key: 'img-rle64', re: ALL('(?:游程|run-?length|RLE)', '(?:零|zero|係數)'), veto: /小波|Haar|哈爾|DCT|MDCT|CAVLC/i },
            { key: 'img-zigzag8', re: ALL('(?:Z\\s*字形|之字形|zig-?zag)', '(?:8\\s*[x×*乘]\\s*8|掃描|走訪)'), veto: /DCT|小波|Haar|哈爾/i },
            { key: 'img-huff4', re: ALL('(?:霍夫曼|Huffman)', '(?:碼長|碼字|canonical)'), veto: /算術|小波|Haar|哈爾|游程|零/i },
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['codec-transform'];
        return { id: 'avimage', label: '影音壓縮 5：有損影像（小波）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make };
});
