'use strict';
// 領域包「影音壓縮 3」子元件：CABAC（H.264 9.3）。骨架在 domain_h264cabac_core.js。
// 表（rangeTabLPS、transIdxLPS、transIdxMPS）依規格寫成；外部核對用 x264 的表，逐項比對 256 個 rangeTabLPS 與 256 個轉移值，全部相同（見 DESIGN）。
// 參考解：獨立寫成 Python。解碼參考用 class 寫，編碼參考用 class 寫，與骨架的寫法不同。
// 限制：只做單一上下文；m、n 由題目直接給；未對照 FFmpeg 的 CABAC 位元流逐位元輸出。
const H = require('./domain_harness.js');
const CB = require('./domain_h264cabac_core.js');

const TABS = `RANGE = ${JSON.stringify(CB.RANGE_LPS)}
TL = ${JSON.stringify(CB.TRANS_LPS)}
`;

const REF_DEC = `import sys
${TABS}
v = [int(t) for t in sys.stdin.read().split()]
class Ctx:
    def __init__(self, p, m):
        self.p, self.m = p, m
def decide(ctx, rng, off, bits):
    q = (rng >> 6) & 3
    lps = RANGE[ctx.p][q]
    rng_mps = rng - lps
    if off < rng_mps:
        b = ctx.m
        ctx.p = min(ctx.p + 1, 62) if ctx.p < 62 else ctx.p
        rng = rng_mps
    else:
        b = 1 - ctx.m
        off = off - rng_mps
        rng = lps
        if ctx.p == 0:
            ctx.m = 1 - ctx.m
        ctx.p = TL[ctx.p]
    i = 0
    while rng < 256:
        rng <<= 1
        off = (off << 1) | bits[i]
        i += 1
    return b, rng, off
c = Ctx(v[0], v[1])
b, r, o = decide(c, v[2], v[3], v[4:10])
print(b, c.p, c.m, r, o)
`;

const REF_BYP = `import sys
v = [int(t) for t in sys.stdin.read().split()]
rng, off, bit = v[0], v[1], v[2]
off = off * 2 + bit
if off >= rng:
    print(1, off - rng)
else:
    print(0, off)
`;

const REF_INIT = `import sys
v = [int(t) for t in sys.stdin.read().split()]
m, n, qp_raw = v
qp = max(0, min(51, qp_raw))
pre = ((m * qp) >> 4) + n
pre = max(1, min(126, pre))
if pre > 63:
    print(pre - 64, 1)
else:
    print(63 - pre, 0)
`;

const REF_ENC = `import sys
${TABS}
v = [int(t) for t in sys.stdin.read().split()]
class Enc:
    def __init__(self):
        self.low, self.range_, self.first, self.outstanding, self.bits = 0, 510, True, 0, []
    def put_bit(self, b):
        if self.first:
            self.first = False
        else:
            self.bits.append(b)
        for _ in range(self.outstanding):
            self.bits.append(1 - b)
        self.outstanding = 0
    def renorm(self):
        while self.range_ < 256:
            if self.low < 256:
                self.put_bit(0)
            elif self.low >= 512:
                self.low -= 512
                self.put_bit(1)
            else:
                self.low -= 256
                self.outstanding += 1
            self.range_ <<= 1
            self.low <<= 1
    def encode(self, state, mps, bn):
        lps = RANGE[state][(self.range_ >> 6) & 3]
        self.range_ -= lps
        if bn == mps:
            state = min(state + 1, 62) if state < 62 else state
        else:
            self.low += self.range_
            self.range_ = lps
            if state == 0:
                mps = 1 - mps
            state = TL[state]
        self.renorm()
        return state, mps
    def flush(self):
        self.range_ = 2
        self.renorm()
        self.put_bit((self.low >> 9) & 1)
        t = ((self.low >> 7) & 3) | 1
        self.bits += [(t >> 1) & 1, t & 1]
e = Enc()
st, mp = v[0], v[1]
for bn in v[2:14]:
    st, mp = e.encode(st, mp, bn)
e.flush()
print(''.join(str(x) for x in e.bits))
`;

const ST_DEC = 'CABAC 解碼一個上下文二元決策：輸入一行 10 個整數，依序為 pStateIdx、valMPS、codIRange、codIOffset，其後 6 個位元（每個為 0 或 1，正規化時依序讀入）。依 rangeTabLPS 查 LPS 範圍，更新區間與狀態；輸出五個整數：解出的二進位值 binVal、新的 pStateIdx、新的 valMPS、新的 codIRange、新的 codIOffset。';
const HO_DEC = 'CABAC 上下文二元決策的解碼：一行 10 個整數，依序為狀態索引 pStateIdx、最可能值 valMPS、區間 codIRange、偏移 codIOffset，之後 6 個位元。用 rangeTabLPS 取得最不可能符號的區間，比較偏移後決定二進位值，再依規則更新狀態與區間並正規化。輸出 binVal、pStateIdx、valMPS、codIRange、codIOffset 五個整數。';
const ST_BYP = 'CABAC 旁路解碼（bypass）：輸入一行 3 個整數，依序為 codIRange、codIOffset、一個位元 bit（0 或 1）。令 codIOffset 先左移 1 位再加上 bit；若 codIOffset 不小於 codIRange，則 binVal 為 1 且 codIOffset 減去 codIRange，否則 binVal 為 0。輸出兩個整數：binVal、新的 codIOffset。';
const HO_BYP = 'CABAC 的 bypass 旁路解碼：輸入一行三個整數 codIRange、codIOffset、bit，其中 bit 為 0 或 1。先把 codIOffset 左移一位後加 bit，若結果不小於 codIRange，binVal 為 1 並從 codIOffset 扣掉 codIRange；否則 binVal 為 0。輸出 binVal 與新的 codIOffset。';
const ST_INIT = 'CABAC 上下文初始化：輸入一行 3 個整數，依序為 m、n、SliceQPY。令 qp 為 SliceQPY 夾在 0 至 51 之間的值，preCtxState 為 ((m 乘 qp) 右移 4 位加 n) 夾在 1 至 126 之間的值。若 preCtxState 不大於 63，則 pStateIdx 為 63 減 preCtxState、valMPS 為 0；否則 pStateIdx 為 preCtxState 減 64、valMPS 為 1。輸出兩個整數：pStateIdx、valMPS。';
const HO_INIT = 'CABAC 上下文變數初始化：輸入一行三個整數 m、n、SliceQPY。把 SliceQPY 夾在 0 到 51 之間記為 qp；計算 ((m 乘 qp) 右移 4 位) 加 n，再夾在 1 到 126 之間記為 preCtxState。若 preCtxState 不大於 63，輸出 pStateIdx 為 63 減 preCtxState 與 valMPS 為 0；否則 pStateIdx 為 preCtxState 減 64 與 valMPS 為 1。輸出兩個整數。';
const ST_ENC = 'CABAC 二進位算術編碼（單一上下文）：輸入一行 14 個整數，依序為 pStateIdx、valMPS，其後 12 個位元（每個為 0 或 1）。全部使用同一個上下文：每編一個值，先依 rangeTabLPS 查 LPS 範圍，若值不等於 valMPS 則低點加上 MPS 範圍、區間改為 LPS 範圍；然後依 transIdxLPS 或 transIdxMPS 更新狀態，並做正規化（RenormE 與 PutBit，含位元欠款 bitsOutstanding）。全部編完後做收尾（EncodeFlush）。輸出一個由 0 與 1 組成的位元字串。';
const HO_ENC = 'CABAC 單一上下文的二元算術編碼：輸入一行 14 個整數，依序為起始 pStateIdx、起始 valMPS，其後 12 個二進位值。逐個編碼時依 rangeTabLPS 與 transIdxLPS、transIdxMPS 更新，並做 RenormE 與 PutBit（含 bitsOutstanding）。全部編完後做 EncodeFlush。輸出由 0 與 1 組成的位元字串。';

const genDec = (b, { rnd }) => {
    const R = rnd(256, 510);
    const xs = [rnd(0, 63), rnd(0, 1), R, rnd(0, R - 1)];
    for (let i = 0; i < 6; i++) xs.push(rnd(0, 1));
    return xs.join(' ');
};
const genByp = (b, { rnd }) => { const R = rnd(256, 510); return [R, rnd(0, R - 1), rnd(0, 1)].join(' '); };
const genInit = (b, { rnd }) => [rnd(-40, 40), rnd(-40, 40), rnd(0, 51)].join(' ');
const genEnc = (b, { rnd }) => {
    const xs = [rnd(0, 63), rnd(0, 1)];
    for (let i = 0; i < 12; i++) xs.push(rnd(0, 1));
    return xs.join(' ');
};

const REF_LEV = `import sys
${TABS}
v = [int(t) for t in sys.stdin.read().split()]
bins = []
for x in v:
    for i in range(min(x, 6)):
        bins.append((i, 1))
    if x < 6:
        bins.append((x, 0))
ctx = {i: [0, 0] for i in range(6)}
low, rng, first, outst, out = 0, 510, True, 0, []
def put(b):
    global first, outst
    if first:
        first = False
    else:
        out.append(b)
    while outst > 0:
        out.append(1 - b)
        outst -= 1
def renorm():
    global low, rng, outst
    while rng < 256:
        if low < 256:
            put(0)
        elif low >= 512:
            low -= 512
            put(1)
        else:
            low -= 256
            outst += 1
        rng <<= 1
        low <<= 1
for c, bn in bins:
    p, m = ctx[c]
    lps = RANGE[p][(rng >> 6) & 3]
    rng -= lps
    if bn == m:
        p = min(p + 1, 62) if p < 62 else p
    else:
        low += rng
        rng = lps
        if p == 0:
            m = 1 - m
        p = TL[p]
    ctx[c] = [p, m]
    renorm()
rng = 2
renorm()
put((low >> 9) & 1)
t = ((low >> 7) & 3) | 1
out += [(t >> 1) & 1, t & 1]
print(''.join(str(x) for x in out))
`;

const ST_LEV = '有損影像係數的多上下文熵編碼：輸入一行 12 個整數，每個為 0 至 6 的係數絕對值。截斷一元二值化：值為 v 時送出 v 個 1（至多 6 個），v 小於 6 再送出一個 0。第 i 個二進位值用第 i 個上下文（共 6 個，各自從 pStateIdx 0、valMPS 0 開始），各上下文依 rangeTabLPS 與狀態轉移各自更新。全部用同一個算術編碼器（RenormE、PutBit、位元欠款）編碼，最後收尾。輸出一個由 0 與 1 組成的位元字串。';
const HO_LEV = '影像係數的二值化與算術編碼：一行 12 個整數，各為 0 到 6 的係數絕對值。截斷一元碼：v 個 1 後接一個 0（v 等於 6 時不接 0）。第 i 位二值使用第 i 個上下文，六個上下文各自從狀態 0、最可能值 0 開始，依 rangeTabLPS 更新。以同一個算術編碼器依序編碼，最後收尾。輸出 0 與 1 組成的位元字串。';
const genLev = (b, { rnd }) => { const xs = []; for (let i = 0; i < 12; i++) xs.push(rnd(0, 6)); return xs.join(' '); };

const SEEDS = [
    { id: 'cab-dec-tr', want: 'h264.cabac.decision', st: ST_DEC, ref: REF_DEC, gen: genDec },
    { id: 'cab-dec-ho', split: 'holdout', st: HO_DEC, ref: REF_DEC, gen: genDec },
    { id: 'cab-byp-tr', want: 'h264.cabac.bypass', st: ST_BYP, ref: REF_BYP, gen: genByp },
    { id: 'cab-byp-ho', split: 'holdout', st: HO_BYP, ref: REF_BYP, gen: genByp },
    { id: 'cab-init-tr', want: 'h264.cabac.init', st: ST_INIT, ref: REF_INIT, gen: genInit },
    { id: 'cab-init-ho', split: 'holdout', st: HO_INIT, ref: REF_INIT, gen: genInit },
    { id: 'cab-enc-tr', want: 'h264.cabac.encode', st: ST_ENC, ref: REF_ENC, gen: genEnc },
    { id: 'cab-enc-ho', split: 'holdout', st: HO_ENC, ref: REF_ENC, gen: genEnc },
    { id: 'cab-lev-tr', want: 'h264.cabac.levels', st: ST_LEV, ref: REF_LEV, gen: genLev },
    { id: 'cab-lev-ho', split: 'holdout', st: HO_LEV, ref: REF_LEV, gen: genLev },
];

H.main({ name: '領域包 h264cabac', packs: [CB], seeds: SEEDS, minSkeletons: 4, judge: { checker: 'tokens', timeoutMs: 60000 } });
