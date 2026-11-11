/* 領域包：影音壓縮階段 3「CABAC（H.264 9.3）」，骨架與表都是依 H.264 規格自己寫成。
 * 表：rangeTabLPS（表 9-44，依 pStateIdx 由 0 到 63 排列）、transIdxLPS 與 transIdxMPS（表 9-45）。
 * 外部核對（不是來源）：x264 的 x264_cabac_range_lps、x264_cabac_transition 是倒序排列，逐項比對結果寫在 DESIGN.media-codec-domain.md。
 * 骨架（格式同 domain_h264dec_core.js：make(PAR) 回傳 {id, label, requires, judge, algos, paradigms, skeletons}）：
 *   h264.cabac.decision：一次上下文二元決策的解碼（9.3.3.2.1），輸出 binVal 與更新後的狀態與區間。
 *   h264.cabac.bypass：旁路解碼（9.3.3.2.3）。
 *   h264.cabac.init：上下文變數初始化（9.3.1.1），由 m、n、SliceQPY 得到 pStateIdx 與 valMPS。
 *   h264.cabac.encode：單一上下文的二元算術編碼（9.3.4.2、PutBit、EncodeFlush），輸出位元字串。
 * 限制：只涵蓋單一上下文與題目直接給的 m、n；不含 ctxIdx 表、二值化與語法元素；解碼器的位元讀取以題目給定的位元列為準。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainH264cabac = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // rangeTabLPS[pStateIdx][qCodIRangeIdx]（H.264 表 9-44）
    const RANGE_LPS = [
        [128, 176, 208, 240], [128, 167, 197, 227], [128, 158, 187, 216], [123, 150, 178, 205], [116, 142, 169, 195], [111, 135, 160, 185], [105, 128, 152, 175], [100, 122, 144, 166],
        [95, 116, 137, 158], [90, 110, 130, 150], [85, 104, 123, 142], [81, 99, 117, 135], [77, 94, 111, 128], [73, 89, 105, 122], [69, 85, 100, 116], [66, 80, 95, 110],
        [62, 76, 90, 104], [59, 72, 86, 99], [56, 69, 81, 94], [53, 65, 77, 89], [51, 62, 73, 85], [48, 59, 69, 80], [46, 56, 66, 76], [43, 53, 63, 72],
        [41, 50, 59, 69], [39, 48, 56, 65], [37, 45, 54, 62], [35, 43, 51, 59], [33, 41, 48, 56], [32, 39, 46, 53], [30, 37, 43, 50], [29, 35, 41, 48],
        [27, 33, 39, 45], [26, 31, 37, 43], [24, 30, 35, 41], [23, 28, 33, 39], [22, 27, 32, 37], [21, 26, 30, 35], [20, 24, 29, 33], [19, 23, 27, 31],
        [18, 22, 26, 30], [17, 21, 25, 28], [16, 20, 23, 27], [15, 19, 22, 25], [14, 18, 21, 24], [14, 17, 20, 23], [13, 16, 19, 22], [12, 15, 18, 21],
        [12, 14, 17, 20], [11, 14, 16, 19], [11, 13, 15, 18], [10, 12, 15, 17], [10, 12, 14, 16], [9, 11, 13, 15], [9, 11, 12, 14], [8, 10, 12, 14],
        [8, 9, 11, 13], [7, 9, 11, 12], [7, 9, 10, 12], [7, 8, 10, 11], [6, 8, 9, 11], [6, 7, 9, 10], [6, 7, 8, 9], [2, 2, 2, 2],
    ];
    // transIdxLPS（表 9-45）；transIdxMPS 為 min(p＋1, 62)，但 62 到 62、63 到 63。
    const TRANS_LPS = [0, 0, 1, 2, 2, 4, 4, 5, 6, 7, 8, 9, 9, 11, 11, 12, 13, 13, 15, 15, 16, 16, 18, 18, 19, 19, 21, 21, 22, 22, 23, 24, 24, 25, 26, 26, 27, 27, 28, 29, 29, 30, 30, 30, 31, 32, 32, 33, 33, 33, 34, 34, 35, 35, 35, 36, 36, 36, 37, 37, 37, 38, 38, 63];
    const TRANS_MPS = (p) => (p < 62 ? p + 1 : p);
    const nums = (N, I) => (I.inputs[0].k === 'list' ? N.ls[0] : '[int(t) for t in ' + N.s[0] + '.split()]');

    function make(PAR) {
        const { code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'codec-cabac', label, slots, py }, extra || {});
        const numIn = (I) => I.inputs.length === 1 && (I.inputs[0].k === 'list' || (I.inputs[0].k === 'str' && I.inputs[0].raw));
        const tabs = ['tab = ' + JSON.stringify(RANGE_LPS), 'tl = ' + JSON.stringify(TRANS_LPS)];
        // RenormE＋PutBit（9.3.4.2），內嵌於迴圈（不用函式）；pb 為 -1 表示只累加位元欠款。
        const RN = ['while rng < 256:', '    if low < 256:', '        pb = 0', '    elif low >= 512:', '        low = low - 512', '        pb = 1', '    else:', '        low = low - 256', '        outst = outst + 1', '        pb = -1', '    if pb >= 0:', '        if first:', '            first = False', '        else:', '            out.append(pb)', '        while outst > 0:', '            out.append(1 - pb)', '            outst = outst - 1', '    rng = rng << 1', '    low = low << 1'];
        const skeletons = [
            // 單一決策解碼：輸入一行 10 個整數：pStateIdx、valMPS、codIRange、codIOffset，其後 6 個位元（正規化時依序讀入）。
            D('h264.cabac.decision', 'h264-cabac-decision', 'CABAC 解碼一個上下文二元決策：輸入一行 10 個整數，依序為 pStateIdx、valMPS、codIRange、codIOffset，其後 6 個位元（每個為 0 或 1，正規化時依序讀入）。依 rangeTabLPS 查 LPS 範圍，更新區間與狀態；輸出五個整數：解出的二進位值 binVal、新的 pStateIdx、新的 valMPS、新的 codIRange、新的 codIOffset。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'ps = v[0]', 'mps = v[1]', 'rng = v[2]', 'off = v[3]', 'bits = v[4:10]', ...tabs,
                    'q = (rng >> 6) & 3', 'lps = tab[ps][q]', 'rng = rng - lps',
                    'if off >= rng:', '    b = 1 - mps', '    off = off - rng', '    rng = lps', '    if ps == 0:', '        mps = 1 - mps', '    ps = tl[ps]',
                    'else:', '    b = mps', '    ps = ps + 1 if ps < 62 else ps',
                    'k = 0', 'while rng < 256:', '    rng = rng << 1', '    off = (off << 1) | bits[k]', '    k = k + 1',
                    'print(b, ps, mps, rng, off)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 旁路解碼：輸入一行 3 個整數 codIRange、codIOffset、bit；輸出 binVal 與新的 codIOffset。
            D('h264.cabac.bypass', 'h264-cabac-bypass', 'CABAC 旁路解碼（bypass）：輸入一行 3 個整數，依序為 codIRange、codIOffset、一個位元 bit（0 或 1）。令 codIOffset 先左移 1 位再加上 bit；若 codIOffset 不小於 codIRange，則 binVal 為 1 且 codIOffset 減去 codIRange，否則 binVal 為 0。輸出兩個整數：binVal、新的 codIOffset。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'rng = v[0]', 'off = (v[1] << 1) | v[2]',
                    'if off >= rng:', '    b = 1', '    off = off - rng', 'else:', '    b = 0',
                    'print(b, off)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 上下文初始化：輸入一行 3 個整數 m、n、SliceQPY；輸出 pStateIdx 與 valMPS。
            D('h264.cabac.init', 'h264-cabac-init', 'CABAC 上下文初始化：輸入一行 3 個整數，依序為 m、n、SliceQPY。令 qp 為 SliceQPY 夾在 0 至 51 之間的值，preCtxState 為 ((m 乘 qp) 右移 4 位加 n) 夾在 1 至 126 之間的值。若 preCtxState 不大於 63，則 pStateIdx 為 63 減 preCtxState、valMPS 為 0；否則 pStateIdx 為 preCtxState 減 64、valMPS 為 1。輸出兩個整數：pStateIdx、valMPS。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'm = v[0]', 'n = v[1]', 'qp = min(max(v[2], 0), 51)', 'pre = min(max(((m * qp) >> 4) + n, 1), 126)',
                    'if pre <= 63:', '    ps = 63 - pre', '    mps = 0', 'else:', '    ps = pre - 64', '    mps = 1',
                    'print(ps, mps)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 算術編碼：輸入一行 14 個整數：起始 pStateIdx、起始 valMPS，其後 12 個二進位值（全部使用同一個上下文）。
            // 依 9.3.4.2 初始化（低點 0、區間 510、firstBitFlag、bitsOutstanding），每編一個值就做 RenormE；最後做 EncodeFlush。輸出一個由 0 與 1 組成的位元字串。
            D('h264.cabac.encode', 'h264-cabac-encode', 'CABAC 算術編碼（單一上下文）：輸入一行 14 個整數，依序為起始 pStateIdx、起始 valMPS，其後 12 個二進位值（0 或 1）。全部使用同一個上下文：每編一個值，先依 rangeTabLPS 查 LPS 範圍，若值不等於 valMPS 則低點加上 MPS 範圍、區間改為 LPS 範圍；然後依 transIdxLPS 或 transIdxMPS 更新狀態，並做正規化（RenormE 與 PutBit，含位元欠款 bitsOutstanding）。全部編完後做收尾（EncodeFlush）。輸出一個由 0 與 1 組成的位元字串。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'ps = v[0]', 'mps = v[1]', 'bins = v[2:]', ...tabs,
                    'low = 0', 'rng = 510', 'out = []', 'first = True', 'outst = 0', ...tabs,
                    'for bn in bins:', '    q = (rng >> 6) & 3', '    lps = tab[ps][q]', '    rng = rng - lps', '    if bn != mps:', '        low = low + rng', '        rng = lps', '        if ps == 0:', '            mps = 1 - mps', '        ps = tl[ps]', '    else:', '        ps = ps + 1 if ps < 62 else ps', ...RN.map((l) => '    ' + l),
                    'rng = 2', ...RN, 'pb = (low >> 9) & 1', 'if first:', '    first = False', 'else:', '    out.append(pb)', 'while outst > 0:', '    out.append(1 - pb)', '    outst = outst - 1', 'w = ((low >> 7) & 3) | 1', 'out.append((w >> 1) & 1)', 'out.append(w & 1)',
                    'print("".join(str(x) for x in out))']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 多上下文係數熵編碼：輸入一行 12 個整數，每個為 0 至 6 的係數絕對值。截斷一元二值化：值為 v 時送出 v 個 1（至多 6 個），v 小於 6 再送出一個 0。第 i 個二進位值用第 i 個上下文（共 6 個，各自從 pStateIdx 0、valMPS 0 開始），各上下文依 rangeTabLPS 與狀態轉移各自更新。全部用同一個算術編碼器（RenormE、PutBit、位元欠款）編碼，最後收尾。輸出一個由 0 與 1 組成的位元字串。
            D('h264.cabac.levels', 'h264-cabac-levels', '有損影像係數的多上下文熵編碼：輸入一行 12 個整數，每個為 0 至 6 的係數絕對值。截斷一元二值化：值為 v 時送出 v 個 1（至多 6 個），v 小於 6 再送出一個 0。第 i 個二進位值用第 i 個上下文（共 6 個，各自從 pStateIdx 0、valMPS 0 開始），各上下文依 rangeTabLPS 與狀態轉移各自更新。全部用同一個算術編碼器（RenormE、PutBit、位元欠款）編碼，最後收尾。輸出一個由 0 與 1 組成的位元字串。',
                [], (c, N, I) => code(['v = ' + nums(N, I)].concat(['bins = []', 'for x in v:', '    for i in range(min(x, 6)):', '        bins.append((i, 1))', '    if x < 6:', '        bins.append((x, 0))'], tabs, ['ps = [0] * 6', 'mps = [0] * 6', 'low = 0', 'rng = 510', 'out = []', 'first = True', 'outst = 0',
                    'for c, bn in bins:', '    q = (rng >> 6) & 3', '    lps = tab[ps[c]][q]', '    rng = rng - lps', '    if bn != mps[c]:', '        low = low + rng', '        rng = lps', '        if ps[c] == 0:', '            mps[c] = 1 - mps[c]', '        ps[c] = tl[ps[c]]', '    else:', '        ps[c] = ps[c] + 1 if ps[c] < 62 else ps[c]'], RN.map((l) => '    ' + l), ['rng = 2'], RN, ['pb = (low >> 9) & 1', 'if first:', '    first = False', 'else:', '    out.append(pb)', 'while outst > 0:', '    out.append(1 - pb)', '    outst = outst - 1', 'w = ((low >> 7) & 3) | 1', 'out.append((w >> 1) & 1)', 'out.append(w & 1)', 'print("".join(str(x) for x in out))'])),
                { shape: numIn, limit: 1, helpers: () => [] }),
            D('h264.cabac.ctxinit', 'h264-cabac-ctxinit', 'CABAC 上下文初始化（I 條帶查表）：輸入一行 2 個整數，依序為 ctxIdx 與 SliceQPY。ctxIdx 只會是 0 至 10 或 60 至 69；由 I 條帶的 m、n 表（標準表 9-12 與表 9-18）查得該 ctxIdx 的 m 與 n。令 qp 為 SliceQPY 夾在 0 至 51 之間的值，preCtxState 為 ((m 乘 qp) 右移 4 位加 n) 夾在 1 至 126 之間的值。若 preCtxState 不大於 63，則 pStateIdx 為 63 減 preCtxState、valMPS 為 0；否則 pStateIdx 為 preCtxState 減 64、valMPS 為 1。輸出兩個整數：pStateIdx、valMPS。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'T = {0: (20, -15), 1: (2, 54), 2: (3, 74), 3: (20, -15), 4: (2, 54), 5: (3, 74), 6: (-28, 127), 7: (-23, 104), 8: (-6, 53), 9: (-1, 54), 10: (7, 51), 60: (0, 41), 61: (0, 63), 62: (0, 63), 63: (0, 63), 64: (-9, 83), 65: (4, 86), 66: (0, 97), 67: (-7, 72), 68: (13, 41), 69: (3, 62)}',
                    'm = T[v[0]][0]', 'n = T[v[0]][1]', 'qp = min(max(v[1], 0), 51)', 'pre = min(max(((m * qp) >> 4) + n, 1), 126)',
                    'if pre <= 63:', '    ps = 63 - pre', '    mps = 0', 'else:', '    ps = pre - 64', '    mps = 1',
                    'print(ps, mps)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            D('h264.cabac.ueg0', 'h264-cabac-ueg0', 'CABAC 旁路的指數哥倫布 k=0 後綴二值化（EG0，H.264 9.3.2.3）：輸入一行 1 個整數 v（0 以上）。令 k 為 0，依下列規則產生位元：當 v 不小於 2 的 k 次方時，送出 1、v 減去 2 的 k 次方、k 加 1；否則送出 0，再以 k 個位元由高位到低位送出 v。全部位元都以旁路方式送出，不使用上下文。輸出由 0 與 1 組成的位元字串。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'x = v[0]', 'k = 0', 'out = []', 'while x >= (1 << k):', '    out.append(1)', '    x = x - (1 << k)', '    k = k + 1', 'out.append(0)', 'for i in range(k - 1, -1, -1):', '    out.append((x >> i) & 1)', 'print("".join(str(b) for b in out))']),
                { shape: numIn, limit: 1, helpers: () => [] }),
        ];
        const ALL =(...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'h264-cabac-decision', re: ALL('(?:CABAC|上下文)', '(?:DecodeDecision|rangeTabLPS|codIRange)', '(?:解碼|決策)'), veto: /編碼|EncodeDecision|旁路|bypass|初始化|preCtxState|CAVLC|coeff_token/i },
            { key: 'h264-cabac-bypass', re: ALL('CABAC', '(?:旁路|bypass)'), veto: /編碼|初始化|rangeTabLPS|DecodeDecision|指數哥倫布|EG0/i },
            { key: 'h264-cabac-init', re: ALL('CABAC', '(?:初始化|preCtxState|上下文初始)'), veto: /編碼|旁路|bypass|rangeTabLPS|解碼一個|ctxIdx/i },
            { key: 'h264-cabac-ctxinit', re: ALL('CABAC', 'ctxIdx', 'I 條帶'), veto: /編碼|旁路|bypass|rangeTabLPS|DecodeDecision|解碼一個/i },
            { key: 'h264-cabac-ueg0', re: ALL('CABAC', '(?:指數哥倫布|EG0)', '(?:旁路|k\\s*=\\s*0)'), veto: /解碼|DecodeDecision|rangeTabLPS|初始化|ctxIdx/i },
            { key: 'h264-cabac-levels', re: ALL('(?:影像|係數)', '上下文', '(?:熵編碼|算術編碼)'), veto: /DecodeDecision|旁路|初始化|bypass|解碼|CABAC/i },
            { key: 'h264-cabac-encode', re: ALL('CABAC', '(?:編碼|EncodeDecision|算術編碼)'), veto: /解碼|DecodeDecision|旁路|初始化|bypass/i },
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['codec-cabac'];
        return { id: 'h264cabac', label: '影音壓縮 3：CABAC（決策解碼、旁路、初始化、算術編碼）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make, RANGE_LPS, TRANS_LPS };
});
