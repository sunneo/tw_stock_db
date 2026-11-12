/* 領域包：影音壓縮階段 3「P／B 條帶」的子元件（依 H.264 規格自己寫成，不是照抄任何實作）。
 * 骨架（格式同 domain_h264motion_core.js：make(PAR) 回傳 {id, label, requires, judge, algos, paradigms, skeletons}）：
 *   h264.cabac.ctxinitPB：P／B 條帶的上下文初始化（9.3.1.1），ctxIdx 11 至 59、cabac_init_idc 0 至 2，由 m、n 得 pStateIdx 與 valMPS。
 *   h264.mvpred.median：運動向量預測（8.4.1.3）：單一參考匹配規則加上分量中位數；B、C 不可用時以 A 代入。
 *   h264.subpel.refine：次像素精修的代價選擇（半像素層）：代價＝SAD＋λ 乘 (|dx−px|＋|dy−py|)，平手取先出現者。
 *   h264.cabac.mvd：運動向量差 mvd 的二值化（9.3.2.3，UEG3、uCoff＝9、signedValFlag＝1），含各二值的上下文增量。
 * 限制（寫在題目與這裡，誠實）：
 *   · ctxinitPB 的 m、n 表是依記憶寫入，與 x264 的 x264_cabac_context_init_PB 逐格比對（見 DESIGN.media-codec-domain.md）；標準正文表 9-13 至 9-16 未逐格核對。
 *   · mvpred 的輸入已是「C 不可用時改用 D」之後的結果，本骨架不含 D 的代入；「不可用」以參考索引 −1 表示，不區分幀內鄰居。
 *   · subpel 只做半像素層的一步，代價函數的 λ 與平手規則是本題自訂，不是編碼器的規則。
 *   · mvd 的上下文增量公式依記憶，未逐項對照標準正文；不含位元流的上下文狀態（只到二值化）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainH264pb = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // P／B 條帶的 (m, n)，ctxIdx 11 至 59，依 cabac_init_idc 0、1、2 分列；每列 49 組，順序為 ctxIdx 11, 12, …, 59。
    const PB_ROWS = [
        [[23, 33], [23, 2], [21, 0], [1, 9], [0, 49], [-37, 118], [5, 57], [-13, 78], [-11, 65], [1, 62], [12, 49], [-4, 73], [17, 50],
            [18, 64], [9, 43], [29, 0], [26, 67], [16, 90], [9, 104], [-46, 127], [-20, 104], [1, 67], [-13, 78], [-11, 65], [1, 62], [-6, 86], [-17, 95], [-6, 61], [9, 45],
            [-3, 69], [-6, 81], [-11, 96], [6, 55], [7, 67], [-5, 86], [2, 88], [0, 58], [-3, 76], [-10, 94], [5, 54], [4, 69], [-3, 81], [0, 88],
            [-7, 67], [-5, 74], [-4, 74], [-5, 80], [-7, 72], [1, 58]],
        [[22, 25], [34, 0], [16, 0], [-2, 9], [4, 41], [-29, 118], [2, 65], [-6, 71], [-13, 79], [5, 52], [9, 50], [-3, 70], [10, 54],
            [26, 34], [19, 22], [40, 0], [57, 2], [41, 36], [26, 69], [-45, 127], [-15, 101], [-4, 76], [-6, 71], [-13, 79], [5, 52], [6, 69], [-13, 90], [0, 52], [8, 43],
            [-2, 69], [-5, 82], [-10, 96], [2, 59], [2, 75], [-3, 87], [-3, 100], [1, 56], [-3, 74], [-6, 85], [0, 59], [-3, 81], [-7, 86], [-5, 95],
            [-1, 66], [-1, 77], [1, 70], [-2, 86], [-5, 72], [0, 61]],
        [[29, 16], [25, 0], [14, 0], [-10, 51], [-3, 62], [-27, 99], [26, 16], [-4, 85], [-24, 102], [5, 57], [6, 57], [-17, 73], [14, 57],
            [20, 40], [20, 10], [29, 0], [54, 0], [37, 42], [12, 97], [-32, 127], [-22, 117], [-2, 74], [-4, 85], [-24, 102], [5, 57], [-6, 93], [-14, 88], [-6, 44], [4, 55],
            [-11, 89], [-15, 103], [-21, 116], [19, 57], [20, 58], [4, 84], [6, 96], [1, 63], [-5, 85], [-13, 106], [5, 63], [6, 75], [-3, 90], [-1, 101],
            [3, 55], [-4, 79], [-2, 75], [-12, 97], [-7, 50], [1, 60]],
    ];
    // 把 PB_ROWS 展開成 {idc: {ctxIdx: [m, n]}}，供骨架內嵌與測試使用。
    const PB_T = {};
    for (let idc = 0; idc < 3; idc++) { PB_T[idc] = {}; PB_ROWS[idc].forEach((mn, i) => { PB_T[idc][11 + i] = mn; }); }

    function make(PAR) {
        const { code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'codec-pb', label, slots, py }, extra || {});
        const numIn = (I) => I.inputs.length === 1 && (I.inputs[0].k === 'list' || (I.inputs[0].k === 'str' && I.inputs[0].raw));
        const nums = (N, I) => (I.inputs[0].k === 'list' ? N.ls[0] : '[int(t) for t in ' + N.s[0] + '.split()]');
        const tabJs = 'PB = ' + JSON.stringify(PB_T);
        const skeletons = [
            // P／B 初始化：輸入一行 3 個整數：ctxIdx、cabac_init_idc、SliceQPY。
            D('h264.cabac.ctxinitPB', 'h264-cabac-ctxinitpb', 'CABAC 上下文初始化（P 或 B 條帶，ctxIdx 11 至 59）：輸入一行 3 個整數，依序為 ctxIdx、cabac_init_idc（0、1 或 2）與 SliceQPY。ctxIdx 只會是 11 至 59 之間的整數。由標準表 9-13 至 9-16 中該 cabac_init_idc 的 m、n 查得該 ctxIdx 的 m 與 n。令 qp 為 SliceQPY 夾在 0 至 51 之間的值，preCtxState 為 ((m 乘 qp) 右移 4 位加 n) 夾在 1 至 126 之間的值。若 preCtxState 不大於 63，則 pStateIdx 為 63 減 preCtxState、valMPS 為 0；否則 pStateIdx 為 preCtxState 減 64、valMPS 為 1。輸出兩個整數：pStateIdx、valMPS。',
                [], (c, N, I) => code(['v = ' + nums(N, I), tabJs, 'm, n = PB[str(v[1])][str(v[0])]', 'qp = min(max(v[2], 0), 51)', 'pre = min(max(((m * qp) >> 4) + n, 1), 126)',
                    'if pre <= 63:', '    ps = 63 - pre', '    mps = 0', 'else:', '    ps = pre - 64', '    mps = 1',
                    'print(ps, mps)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 運動向量預測：輸入一行 10 個整數：目前參考索引 cur，其後為 A、B、C 三個鄰居各 (refIdx, mvx, mvy)。refIdx 為 −1 表示不可用（此時 mv 為 0）。
            D('h264.mvpred.median', 'h264-mvpred-median', '運動向量預測（中位數）：輸入一行 10 個整數，依序為目前參考索引 cur，其後為鄰居 A、B、C 各三個數：參考索引、水平分量、垂直分量。參考索引為 −1 表示該鄰居不可用。規則如下：若 B 與 C 都不可用而 A 可用，則把 B 與 C 都換成 A 的參考索引與向量。接著看 A、B、C 的參考索引中，等於 cur 的恰有一個，則輸出該鄰居的向量。否則輸出 A、B、C 水平分量的中位數與垂直分量的中位數。輸出兩個整數：預測的水平分量與垂直分量。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'cur = v[0]', 'nb = [[v[1], v[2], v[3]], [v[4], v[5], v[6]], [v[7], v[8], v[9]]]',
                    'if nb[1][0] == -1 and nb[2][0] == -1 and nb[0][0] != -1:', '    nb[1] = list(nb[0])', '    nb[2] = list(nb[0])',
                    'hit = [k for k in range(3) if nb[k][0] == cur]',
                    'if len(hit) == 1:', '    print(nb[hit[0]][1], nb[hit[0]][2])',
                    'else:', '    xs = sorted(x[1] for x in nb)', '    ys = sorted(x[2] for x in nb)', '    print(xs[1], ys[1])']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 次像素精修（半像素層）：輸入一行 13 個整數：px、py（預測向量，半像素單位）、lam（λ）、其後 9 個 SAD 依序為位移 (−1,−1)、(0,−1)、(1,−1)、(−1,0)、(0,0)、(1,0)、(−1,1)、(0,1)、(1,1)。
            D('h264.subpel.refine', 'h264-subpel-refine', '次像素精修（半像素層）的代價選擇：輸入一行 13 個整數，依序為 px、py（預測點的水平與垂直分量，半像素單位）、lam（λ，非負整數），其後 9 個整數為 SAD，依序對應位移 (−1,−1)、(0,−1)、(1,−1)、(−1,0)、(0,0)、(1,0)、(−1,1)、(0,1)、(1,1)。每個位移 (dx,dy) 的代價為 SAD 加上 lam 乘 (|dx 減 px| 加 |dy 減 py|)。依上列順序檢查，只有嚴格小於目前最小代價時才更新，因此平手取先出現者。輸出三個整數：最佳的 dx、dy 與其代價。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'px, py, lam = v[0], v[1], v[2]', 'pos = [(-1, -1), (0, -1), (1, -1), (-1, 0), (0, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]',
                    'best = None', 'for k in range(9):', '    dx, dy = pos[k]', '    c = v[3 + k] + lam * (abs(dx - px) + abs(dy - py))', '    if best is None or c < best[2]:', '        best = (dx, dy, c)',
                    'print(best[0], best[1], best[2])']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // mvd 二值化：輸入一行 2 個整數：mvd（有號整數）與 s（A、B 兩鄰居絕對值分量的和，非負）。輸出一行 token：c<增量>=<位元> 表示上下文編碼的二值，b=<位元> 表示旁路二值。
            D('h264.cabac.mvd', 'h264-cabac-mvd', 'CABAC 運動向量差（mvd）的二值化（UEG3、uCoff＝9、有號）：輸入一行 2 個整數，依序為 mvd（可為負數）與 s（左邊與上面鄰居的 mvd 絕對值分量之和，非負）。令 absV 為 mvd 的絕對值。前綴為截斷一元碼，上限 9：absV 小於 9 時送出 absV 個 1 再送一個 0，absV 不小於 9 時送出 9 個 1。前綴的第 0 個二值的上下文增量：s 小於 3 為 0，s 在 3 至 32 之間為 1，s 大於 32 為 2；第 1、2、3 個二值的增量分別為 3、4、5；第 4 個及以後的二值增量為 6。absV 不小於 9 時，後綴為指數哥倫布 k＝3 的旁路二值，編碼 absV 減 9。最後若 mvd 不為 0，送一個旁路符號位元：正數為 0、負數為 1。輸出一行，以空白分隔：上下文編碼的二值寫成 c 加增量加等號加位元（例如 c0=1），旁路二值寫成 b=位元。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'mvd = v[0]', 's = v[1]', 'absV = abs(mvd)', 'out = []',
                    'cMax = min(absV, 9)',
                    'for i in range(cMax):', '    inc = (0 if s < 3 else (1 if s <= 32 else 2)) if i == 0 else min(i + 2, 6)', '    out.append("c%d=1" % inc)',
                    'if absV < 9:', '    inc = (0 if s < 3 else (1 if s <= 32 else 2)) if cMax == 0 else min(cMax + 2, 6)', '    out.append("c%d=0" % inc)',
                    'if absV >= 9:', '    rest = absV - 9', '    k = 3', '    while rest >= (1 << k):', '        out.append("b=1")', '        rest = rest - (1 << k)', '        k = k + 1',
                    '    out.append("b=0")', '    for j in range(k - 1, -1, -1):', '        out.append("b=%d" % ((rest >> j) & 1))',
                    'if mvd != 0:', '    out.append("b=%d" % (1 if mvd < 0 else 0))',
                    'print(" ".join(out))']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 參考索引 ref_idx 的二值化（一元碼，9.3.2.3 的 U）與上下文增量：輸入一行 2 個整數：refIdx（非負）與 cond（0 至 3，即 condTermFlagA 加 2 乘 condTermFlagB）。
            D('h264.cabac.refidx', 'h264-cabac-refidx', 'CABAC 參考索引（ref_idx）的二值化（一元碼）：輸入一行 2 個整數，依序為 refIdx（非負整數）與 cond（0 至 3，即 condTermFlagA 加 2 乘 condTermFlagB）。一元碼送出 refIdx 個 1 再送一個 0。第 0 個二值的上下文增量為 cond；第 1 個二值的增量為 4；第 2 個及以後的二值增量為 5。輸出一行，以空白分隔：上下文編碼的二值寫成 c 加增量加等號加位元（例如 c0=1）。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'r = v[0]', 'cond = v[1]', 'out = []',
                    'for i in range(r):', '    inc = cond if i == 0 else (4 if i == 1 else 5)', '    out.append("c%d=1" % inc)',
                    'inc = cond if r == 0 else (4 if r == 1 else 5)', 'out.append("c%d=0" % inc)',
                    'print(" ".join(out))']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 次像素精修（四分之一層）：輸入一行 14 個整數：hx、hy（半像素層的最佳位移，半像素單位）、px、py（預測點，四分之一像素單位）、lam（λ）、其後 9 個 SAD，依序對應四分之一單位的偏移 (−1,−1)、(0,−1)、(1,−1)、(−1,0)、(0,0)、(1,0)、(−1,1)、(0,1)、(1,1)。
            // 中心為 (2 乘 hx, 2 乘 hy)；每個候選的向量為中心加偏移，代價為 SAD 加 lam 乘 (|mvx 減 px| 加 |mvy 減 py|)。依上列順序，只有嚴格小於時才更新，平手取先出現者。輸出三個整數：最佳的 mvx、mvy（四分之一單位）與其代價。
            D('h264.subpel.quarter', 'h264-subpel-quarter', '次像素精修（四分之一層）的代價選擇：輸入一行 14 個整數，依序為 hx、hy（半像素層的最佳位移，半像素單位）、px、py（預測點，四分之一像素單位）、lam（λ，非負整數），其後 9 個整數為 SAD，依序對應四分之一單位的偏移 (−1,−1)、(0,−1)、(1,−1)、(−1,0)、(0,0)、(1,0)、(−1,1)、(0,1)、(1,1)。候選向量為 (2 乘 hx 加偏移 dx, 2 乘 hy 加偏移 dy)，代價為 SAD 加上 lam 乘 (|mvx 減 px| 加 |mvy 減 py|)。依上列順序檢查，只有嚴格小於目前最小代價時才更新，因此平手取先出現者。輸出三個整數：最佳的 mvx、mvy（四分之一單位）與其代價。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'hx, hy, px, py, lam = v[0], v[1], v[2], v[3], v[4]', 'pos = [(-1, -1), (0, -1), (1, -1), (-1, 0), (0, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]',
                    'best = None', 'for k in range(9):', '    mx, my = 2 * hx + pos[k][0], 2 * hy + pos[k][1]', '    c = v[5 + k] + lam * (abs(mx - px) + abs(my - py))', '    if best is None or c < best[2]:', '        best = (mx, my, c)',
                    'print(best[0], best[1], best[2])']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // mb_skip_flag 的上下文增量（9.3.3.1.1.1）：輸入一行 4 個整數：availA、skipA、availB、skipB（各為 0 或 1）。條件項為「可用且不是略過」；增量為兩個條件項之和。
            D('h264.cabac.skipinc', 'h264-cabac-skipinc', 'CABAC 的 mb_skip_flag 上下文增量：輸入一行 4 個整數，依序為左邊鄰居可用與否 availA、左邊鄰居是否略過 skipA、上面鄰居可用與否 availB、上面鄰居是否略過 skipB（各為 0 或 1）。某鄰居的條件項為 1，當且僅當該鄰居可用且不是略過；否則為 0。上下文增量為兩個條件項之和，輸出這個整數。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'ca = 1 if (v[0] == 1 and v[1] == 0) else 0', 'cb = 1 if (v[2] == 1 and v[3] == 0) else 0', 'print(ca + cb)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'h264-cabac-ctxinitpb', re: ALL('CABAC', 'ctxIdx', '(?:P|B)\\s*條帶|cabac_init_idc'), veto: /編碼|旁路|bypass|rangeTabLPS|DecodeDecision|解碼一個|mvd|I 條帶，ctxIdx/i },
            { key: 'h264-mvpred-median', re: ALL('(?:運動向量|motion vector|MV)', '(?:預測|predict)', '(?:中位數|median|參考索引)'), veto: /次像素|mvd|二值|SAD|全搜尋|CABAC/i },
            { key: 'h264-subpel-refine', re: ALL('(?:次像素|subpel|sub-pel)', '(?:精修|搜尋|refine|search)', '(?:代價|cost|λ|lam)'), veto: /mvd|二值|四分之一/i },
            { key: 'h264-cabac-mvd', re: ALL('CABAC', '(?:運動向量差|mvd)', '(?:二值|binar)'), veto: /上下文初始化|rangeTabLPS|DecodeDecision|ctxIdx 11/i },
            { key: 'h264-cabac-refidx', re: ALL('CABAC', '(?:參考索引|ref_?idx|refIdx)', '(?:二值|binar|一元)'), veto: /mvd|上下文初始化|rangeTabLPS|DecodeDecision|次像素/i },
            { key: 'h264-subpel-quarter', re: ALL('(?:次像素|subpel|sub-pel)', '四分之一', '(?:代價|cost|λ|lam)'), veto: /mvd|二值/i },
            { key: 'h264-cabac-skipinc', re: ALL('CABAC', 'mb_skip', '(?:上下文增量|增量)'), veto: /mvd|ref_?idx|二值化|ctxIdx 11 至/i },
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['codec-pb'];
        return { id: 'h264pb', label: '影音壓縮 3：P／B 條帶（初始化表 11 至 59、運動向量預測、次像素代價、mvd 二值化）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make, PB_T, PB_ROWS };
});
