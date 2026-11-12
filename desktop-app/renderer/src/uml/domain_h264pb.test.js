'use strict';
// 領域包「影音壓縮 3」P／B 條帶子元件：ctxIdx 11 至 59 的初始化、運動向量預測（中位數與單一匹配）、次像素代價選擇、mvd 二值化。
// 骨架在 domain_h264pb_core.js。參考解獨立寫成 Python（各自用不同寫法：例如中位數用「和減最大減最小」、次像素用 min 加鍵值）。
// 限制：ctxinitPB 的表依記憶寫入，與 x264 的對照在 DESIGN（不在 repo 內，見交接節）；mvpred 不含 C 改用 D 的代入；次像素的 λ 與平手規則為題目自訂。
const H = require('./domain_harness.js');
const PBC = require('./domain_h264pb_core.js');

const TABLE = `PB = ${JSON.stringify(PBC.PB_T)}
`;

const REF_CI = `import sys
${TABLE}v = [int(t) for t in sys.stdin.read().split()]
ctx, idc, qp_raw = v
m, n = PB[str(idc)][str(ctx)]
qp = min(max(qp_raw, 0), 51)
pre = min(max((m * qp) // 16 + n, 1), 126)
if pre <= 63:
    print(63 - pre, 0)
else:
    print(pre - 64, 1)
`;

const REF_MVP = `import sys
v = [int(t) for t in sys.stdin.read().split()]
cur = v[0]
A = [v[1], v[2], v[3]]
B = [v[4], v[5], v[6]]
C = [v[7], v[8], v[9]]
if B[0] == -1 and C[0] == -1 and A[0] != -1:
    B = list(A)
    C = list(A)
found = [t for t in (A, B, C) if t[0] == cur]
if len(found) == 1:
    print(found[0][1], found[0][2])
else:
    xs = [A[1], B[1], C[1]]
    ys = [A[2], B[2], C[2]]
    print(sum(xs) - max(xs) - min(xs), sum(ys) - max(ys) - min(ys))
`;

const REF_SUB = `import sys
v = [int(t) for t in sys.stdin.read().split()]
px, py, lam = v[0], v[1], v[2]
sad = v[3:12]
pos = [(-1, -1), (0, -1), (1, -1), (-1, 0), (0, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]
cost = [sad[k] + lam * (abs(pos[k][0] - px) + abs(pos[k][1] - py)) for k in range(9)]
k = min(range(9), key=lambda i: (cost[i], i))
print(pos[k][0], pos[k][1], cost[k])
`;

const REF_MVD = `import sys
v = [int(t) for t in sys.stdin.read().split()]
mvd, s = v
a = abs(mvd)
def inc_first(s):
    return 0 if s < 3 else (1 if s <= 32 else 2)
def inc_later(i):
    return {1: 3, 2: 4, 3: 5}.get(i, 6)
bins = []
for i in range(min(a, 9)):
    ctx = inc_first(s) if i == 0 else inc_later(i)
    bins.append('c%d=1' % ctx)
if a < 9:
    ctx = inc_first(s) if a == 0 else inc_later(a)
    bins.append('c%d=0' % ctx)
else:
    rest = a - 9
    k = 3
    while rest >= 2 ** k:
        bins.append('b=1')
        rest -= 2 ** k
        k += 1
    bins.append('b=0')
    bins += ['b=%d' % ((rest >> j) & 1) for j in reversed(range(k))]
if mvd != 0:
    bins.append('b=%d' % (1 if mvd < 0 else 0))
print(' '.join(bins))
`;

const REF_RI = `import sys
v = [int(t) for t in sys.stdin.read().split()]
r, cond = v
bins = []
for i in range(r):
    ctx = cond if i == 0 else (4 if i == 1 else 5)
    bins.append('c%d=1' % ctx)
ctx = cond if r == 0 else (4 if r == 1 else 5)
bins.append('c%d=0' % ctx)
print(' '.join(bins))
`;

const rndInt = (rnd, lo, hi) => rnd(lo, hi);

const genCI = (b, { rnd }) => [rndInt(rnd, 11, 59), rnd(0, 2), rnd(-5, 60)].join(' ');

const genMVP = (b, { rnd }) => {
    const cur = rnd(0, 2);
    const nb = () => {
        if (rnd(0, 3) === 0) return [-1, 0, 0];
        return [rnd(0, 2), rnd(-16, 16), rnd(-16, 16)];
    };
    return [cur, ...nb(), ...nb(), ...nb()].join(' ');
};

const genSUB = (b, { rnd }) => {
    const xs = [rnd(-4, 4), rnd(-4, 4), rnd(0, 10)];
    for (let i = 0; i < 9; i++) xs.push(rnd(0, 500));
    return xs.join(' ');
};

const genMVD = (b, { rnd }) => {
    const big = b;
    const mvd = big ? rnd(-400, 400) : rnd(-40, 40);
    return [mvd, rnd(0, 70)].join(' ');
};

const ST_CI = 'CABAC 上下文初始化（P 或 B 條帶，ctxIdx 11 至 59）：輸入一行 3 個整數，依序為 ctxIdx、cabac_init_idc（0、1 或 2）與 SliceQPY。ctxIdx 只會是 11 至 59 之間的整數。由標準表 9-13 至 9-16 中該 cabac_init_idc 的 m、n 查得該 ctxIdx 的 m 與 n。令 qp 為 SliceQPY 夾在 0 至 51 之間的值，preCtxState 為 ((m 乘 qp) 右移 4 位加 n) 夾在 1 至 126 之間的值。若 preCtxState 不大於 63，則 pStateIdx 為 63 減 preCtxState、valMPS 為 0；否則 pStateIdx 為 preCtxState 減 64、valMPS 為 1。輸出兩個整數：pStateIdx、valMPS。';
const HO_CI = 'P 條帶與 B 條帶的 CABAC 上下文初始化：一行 3 個整數，依序是 ctxIdx（11 至 59）、cabac_init_idc（0 至 2）、SliceQPY。查出該 cabac_init_idc 下的 m、n，qp 取 SliceQPY 夾在 0 到 51。preCtxState 等於 (m 乘 qp 右移 4 位加 n) 夾在 1 到 126；小於等於 63 時 pStateIdx 為 63 減 preCtxState、valMPS 為 0，否則 pStateIdx 為 preCtxState 減 64、valMPS 為 1。輸出 pStateIdx 與 valMPS。';

const ST_MVP = '運動向量預測（中位數）：輸入一行 10 個整數，依序為目前參考索引 cur，其後為鄰居 A、B、C 各三個數：參考索引、水平分量、垂直分量。參考索引為 −1 表示該鄰居不可用。規則如下：若 B 與 C 都不可用而 A 可用，則把 B 與 C 都換成 A 的參考索引與向量。接著看 A、B、C 的參考索引中，等於 cur 的恰有一個，則輸出該鄰居的向量。否則輸出 A、B、C 水平分量的中位數與垂直分量的中位數。輸出兩個整數：預測的水平分量與垂直分量。';
const HO_MVP = '運動向量的預測值：一行 10 個整數，第一個是 cur，後面依序是鄰居 A、B、C 的參考索引、水平與垂直分量（參考索引 −1 表示不可用）。若 B、C 都不可用而 A 可用，把 B、C 換成 A。若 A、B、C 中參考索引等於 cur 的只有一個，輸出那一個的向量；否則輸出三者水平分量的中位數與垂直分量的中位數。';

const ST_SUB = '次像素精修（半像素層）的代價選擇：輸入一行 13 個整數，依序為 px、py（預測點的水平與垂直分量，半像素單位）、lam（λ，非負整數），其後 9 個整數為 SAD，依序對應位移 (−1,−1)、(0,−1)、(1,−1)、(−1,0)、(0,0)、(1,0)、(−1,1)、(0,1)、(1,1)。每個位移 (dx,dy) 的代價為 SAD 加上 lam 乘 (|dx 減 px| 加 |dy 減 py|)。依上列順序檢查，只有嚴格小於目前最小代價時才更新，因此平手取先出現者。輸出三個整數：最佳的 dx、dy 與其代價。';
const HO_SUB = '次像素搜尋的代價比較：一行 13 個整數，前三個為 px、py、lam，其後 9 個為九個位置的 SAD，依序為 (−1,−1)、(0,−1)、(1,−1)、(−1,0)、(0,0)、(1,0)、(−1,1)、(0,1)、(1,1)。每個位置的代價是 SAD 加上 lam 乘以（dx 與 px 之差的絕對值加上 dy 與 py 之差的絕對值）。代價最小者勝出，平手取列表中較前面的位置。輸出 dx、dy 與代價。';

const ST_MVD = 'CABAC 運動向量差（mvd）的二值化（UEG3、uCoff＝9、有號）：輸入一行 2 個整數，依序為 mvd（可為負數）與 s（左邊與上面鄰居的 mvd 絕對值分量之和，非負）。令 absV 為 mvd 的絕對值。前綴為截斷一元碼，上限 9：absV 小於 9 時送出 absV 個 1 再送一個 0，absV 不小於 9 時送出 9 個 1。前綴的第 0 個二值的上下文增量：s 小於 3 為 0，s 在 3 至 32 之間為 1，s 大於 32 為 2；第 1、2、3 個二值的增量分別為 3、4、5；第 4 個及以後的二值增量為 6。absV 不小於 9 時，後綴為指數哥倫布 k＝3 的旁路二值，編碼 absV 減 9。最後若 mvd 不為 0，送一個旁路符號位元：正數為 0、負數為 1。輸出一行，以空白分隔：上下文編碼的二值寫成 c 加增量加等號加位元（例如 c0=1），旁路二值寫成 b=位元。';
const HO_MVD = 'CABAC 的運動向量差二值化，參數 uCoff 為 9 且為有號：一行 2 個整數，mvd 與 s（A、B 兩鄰居 mvd 絕對值之和）。絕對值小於 9 時，前綴為該數個 1 加一個 0；否則為 9 個 1，後面接 k 為 3 的指數哥倫布旁路碼，編碼絕對值減 9。前綴各位元的上下文增量：第一位依 s 分 0、1、2（s 小於 3、3 到 32、大於 32），第二、三、四位分別為 3、4、5，之後為 6。最後非零時送旁路符號位元，負數為 1。以 c增量=位元 或 b=位元 的形式以空白分隔輸出。';

const genRI = (b, { rnd }) => [rnd(0, 4), rnd(0, 3)].join(' ');

const ST_RI = 'CABAC 參考索引（ref_idx）的二值化（一元碼）：輸入一行 2 個整數，依序為 refIdx（非負整數）與 cond（0 至 3，即 condTermFlagA 加 2 乘 condTermFlagB）。一元碼送出 refIdx 個 1 再送一個 0。第 0 個二值的上下文增量為 cond；第 1 個二值的增量為 4；第 2 個及以後的二值增量為 5。輸出一行，以空白分隔：上下文編碼的二值寫成 c 加增量加等號加位元（例如 c0=1）。';
const HO_RI = 'CABAC 中參考索引的一元二值化：一行 2 個整數，refIdx 與 cond（0 到 3）。得到 refIdx 個 1 再接一個 0；第一個位元用上下文增量 cond，第二個用 4，其餘用 5。以 c增量=位元 的形式、空白分隔輸出。';

const REF_QSUB = `import sys
v = [int(t) for t in sys.stdin.read().split()]
hx, hy, px, py, lam = v[0:5]
sad = v[5:14]
offs = [(-1, -1), (0, -1), (1, -1), (-1, 0), (0, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]
cands = []
for k, (ox, oy) in enumerate(offs):
    mx, my = 2 * hx + ox, 2 * hy + oy
    cands.append((sad[k] + lam * (abs(mx - px) + abs(my - py)), k, mx, my))
best = min(cands, key=lambda t: (t[0], t[1]))
print(best[2], best[3], best[0])
`;

const REF_SKIP = `import sys
v = [int(t) for t in sys.stdin.read().split()]
avA, skA, avB, skB = v
condA = 1 if avA and not skA else 0
condB = 1 if avB and not skB else 0
print(condA + condB)
`;

const genQSUB = (b, { rnd }) => {
    const xs = [rnd(-6, 6), rnd(-6, 6), rnd(-12, 12), rnd(-12, 12), rnd(0, 10)];
    for (let i = 0; i < 9; i++) xs.push(rnd(0, 500));
    return xs.join(' ');
};
const genSKIP = (b, { rnd }) => [rnd(0, 1), rnd(0, 1), rnd(0, 1), rnd(0, 1)].join(' ');

const ST_QSUB = '次像素精修（四分之一層）的代價選擇：輸入一行 14 個整數，依序為 hx、hy（半像素層的最佳位移，半像素單位）、px、py（預測點，四分之一像素單位）、lam（λ，非負整數），其後 9 個整數為 SAD，依序對應四分之一單位的偏移 (−1,−1)、(0,−1)、(1,−1)、(−1,0)、(0,0)、(1,0)、(−1,1)、(0,1)、(1,1)。候選向量為 (2 乘 hx 加偏移 dx, 2 乘 hy 加偏移 dy)，代價為 SAD 加上 lam 乘 (|mvx 減 px| 加 |mvy 減 py|)。依上列順序檢查，只有嚴格小於目前最小代價時才更新，因此平手取先出現者。輸出三個整數：最佳的 mvx、mvy（四分之一單位）與其代價。';
const HO_QSUB = '四分之一像素的次像素搜尋：一行 14 個整數，前兩個為半像素最佳位移 hx、hy，接著 px、py（預測，四分之一單位）與 lam，其後 9 個 SAD 依序對應四分之一偏移 (−1,−1) 到 (1,1)（順序同上）。候選為 (2hx＋dx, 2hy＋dy)，代價是 SAD 加 lam 乘以向量與預測的分量差絕對值之和。代價最小者勝，平手取先出現者。輸出 mvx、mvy 與代價。';
const ST_SKIP = 'CABAC 的 mb_skip_flag 上下文增量：輸入一行 4 個整數，依序為左邊鄰居可用與否 availA、左邊鄰居是否略過 skipA、上面鄰居可用與否 availB、上面鄰居是否略過 skipB（各為 0 或 1）。某鄰居的條件項為 1，當且僅當該鄰居可用且不是略過；否則為 0。上下文增量為兩個條件項之和，輸出這個整數。';
const HO_SKIP = 'mb_skip_flag 的 CABAC 上下文：一行 4 個 0 或 1 的整數，依序是左鄰可用、左鄰略過、上鄰可用、上鄰略過。左鄰若可用且未略過計 1，上鄰同理；兩者相加即為增量。輸出該增量。';

const SEEDS = [

    { id: 'pb-ci-tr', want: 'h264.cabac.ctxinitPB', st: ST_CI, ref: REF_CI, gen: genCI },
    { id: 'pb-ci-ho', split: 'holdout', st: HO_CI, ref: REF_CI, gen: genCI },
    { id: 'pb-mv-tr', want: 'h264.mvpred.median', st: ST_MVP, ref: REF_MVP, gen: genMVP },
    { id: 'pb-mv-ho', split: 'holdout', st: HO_MVP, ref: REF_MVP, gen: genMVP },
    { id: 'pb-sp-tr', want: 'h264.subpel.refine', st: ST_SUB, ref: REF_SUB, gen: genSUB },
    { id: 'pb-sp-ho', split: 'holdout', st: HO_SUB, ref: REF_SUB, gen: genSUB },
    { id: 'pb-md-tr', want: 'h264.cabac.mvd', st: ST_MVD, ref: REF_MVD, gen: genMVD },
    { id: 'pb-md-ho', split: 'holdout', st: HO_MVD, ref: REF_MVD, gen: genMVD },
    { id: 'pb-ri-tr', want: 'h264.cabac.refidx', st: ST_RI, ref: REF_RI, gen: genRI },
    { id: 'pb-ri-ho', split: 'holdout', st: HO_RI, ref: REF_RI, gen: genRI },
    { id: 'pb-qs-tr', want: 'h264.subpel.quarter', st: ST_QSUB, ref: REF_QSUB, gen: genQSUB },
    { id: 'pb-qs-ho', split: 'holdout', st: HO_QSUB, ref: REF_QSUB, gen: genQSUB },
    { id: 'pb-sk-tr', want: 'h264.cabac.skipinc', st: ST_SKIP, ref: REF_SKIP, gen: genSKIP },
    { id: 'pb-sk-ho', split: 'holdout', st: HO_SKIP, ref: REF_SKIP, gen: genSKIP },
];

H.main({ name: '領域包 h264pb', packs: [PBC], seeds: SEEDS, minSkeletons: 6, judge: { checker: 'tokens', timeoutMs: 60000 } });
