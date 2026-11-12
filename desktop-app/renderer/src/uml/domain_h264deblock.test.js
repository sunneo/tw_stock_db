'use strict';
// 領域包「影音壓縮 2」子元件：去區塊亮度邊界濾波（H.264 8.7.2.3、8.7.2.4，8 位元）。骨架 h264.deblock 在 domain_h264dec_core.js。
// 表：α、β、tC0 來自 libavc common/ih264_deblk_tables.c（Apache 2.0）。已核對 tC0 表：indexA 23 的 bS 1 至 3 為 1、1、1，與規格表 8-17 的此列一致（依記憶，尚未對照規格原文）。
// 參考解：獨立寫成 Python，用函式與 dict 寫法，與骨架的一行式寫法不同。
// 限制：沒有外部解碼器可逐樣本對照單一邊界濾波；本題只量測「公式與表」的一致性，不含跨區塊的順序與色度濾波。
const H = require('./domain_harness.js');
const DH = require('./domain_h264dec_core.js');

const REF = `import sys
v = [int(t) for t in sys.stdin.read().split()]
ia, ib, bs = v[0], v[1], v[2]
p3, p2, p1, p0, q0, q1, q2, q3 = v[3:11]
ALPHA = [0]*16 + [4,4,5,6,7,8,9,10,12,13,15,17,20,22,25,28,32,36,40,45,50,56,63,71,80,90,101,113,127,144,162,182,203,226,255,255]
BETA = [0]*16 + [2,2,2,3,3,3,3,4,4,4,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,14,14,15,15,16,16,17,17,18,18]
TC0 = {}
for i in range(52):
    TC0[i] = [0, 0, 0, 0]
TC0[17] = [0, 0, 0, 1]
TC0[18] = [0, 0, 0, 1]
TC0[19] = [0, 0, 0, 1]
TC0[20] = [0, 0, 0, 1]
TC0[21] = [0, 0, 1, 1]
TC0[22] = [0, 0, 1, 1]
TC0[23] = [0, 1, 1, 1]
TC0[24] = [0, 1, 1, 1]
TC0[25] = [0, 1, 1, 1]
TC0[26] = [0, 1, 1, 1]
TC0[27] = [0, 1, 1, 2]
TC0[28] = [0, 1, 1, 2]
TC0[29] = [0, 1, 1, 2]
TC0[30] = [0, 1, 1, 2]
TC0[31] = [0, 1, 2, 3]
TC0[32] = [0, 1, 2, 3]
TC0[33] = [0, 2, 2, 3]
TC0[34] = [0, 2, 2, 4]
TC0[35] = [0, 2, 3, 4]
TC0[36] = [0, 2, 3, 4]
TC0[37] = [0, 3, 3, 5]
TC0[38] = [0, 3, 4, 6]
TC0[39] = [0, 3, 4, 6]
TC0[40] = [0, 4, 5, 7]
TC0[41] = [0, 4, 5, 8]
TC0[42] = [0, 4, 6, 9]
TC0[43] = [0, 5, 7, 10]
TC0[44] = [0, 6, 8, 11]
TC0[45] = [0, 6, 8, 13]
TC0[46] = [0, 7, 10, 14]
TC0[47] = [0, 8, 11, 16]
TC0[48] = [0, 9, 12, 18]
TC0[49] = [0, 10, 13, 20]
TC0[50] = [0, 11, 15, 23]
TC0[51] = [0, 13, 17, 25]
def clip(lo, hi, x):
    return lo if x < lo else (hi if x > hi else x)
a = ALPHA[ia]
b = BETA[ib]
out = {"p2": p2, "p1": p1, "p0": p0, "q0": q0, "q1": q1, "q2": q2}
if bs >= 1 and abs(p0 - q0) < a and abs(p1 - p0) < b and abs(q1 - q0) < b:
    ap = abs(p2 - p0)
    aq = abs(q2 - q0)
    if bs in (1, 2, 3):
        t0 = TC0[ia][bs]
        tc = t0 + (ap < b) + (aq < b)
        delta = clip(-tc, tc, (((q0 - p0) * 4) + (p1 - q1) + 4) // 8)
        out["p0"] = clip(0, 255, p0 + delta)
        out["q0"] = clip(0, 255, q0 - delta)
        if ap < b:
            out["p1"] = p1 + clip(-t0, t0, (p2 + (p0 + q0 + 1) // 2 - 2 * p1) // 2)
        if aq < b:
            out["q1"] = q1 + clip(-t0, t0, (q2 + (p0 + q0 + 1) // 2 - 2 * q1) // 2)
    if bs == 4:
        strong = abs(p0 - q0) < (a // 4) + 2
        if ap < b and strong:
            out["p0"] = (p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) // 8
            out["p1"] = (p2 + p1 + p0 + q0 + 2) // 4
            out["p2"] = (2 * p3 + 3 * p2 + p1 + p0 + q0 + 4) // 8
        else:
            out["p0"] = (2 * p1 + p0 + q1 + 2) // 4
        if aq < b and strong:
            out["q0"] = (p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) // 8
            out["q1"] = (p0 + q0 + q1 + q2 + 2) // 4
            out["q2"] = (2 * q3 + 3 * q2 + q1 + q0 + p0 + 4) // 8
        else:
            out["q0"] = (2 * q1 + q0 + p1 + 2) // 4
print(out["p2"], out["p1"], out["p0"], out["q0"], out["q1"], out["q2"])
`;

// 產生：indexA、indexB、bS，以及以某基準值加小擾動的 8 個樣本（讓 α、β 條件常成立）。
const genDb = (lo, hi) => (b, { rnd }) => {
    const ia = rnd(lo, hi);
    const ib = rnd(lo, hi);
    const bs = rnd(1, 4);
    const base = rnd(40, 215);
    const s = [];
    for (let i = 0; i < 8; i++) {
        const v = base + rnd(-6, 6) + (rnd(0, 9) === 0 ? rnd(-40, 40) : 0);
        s.push(Math.max(0, Math.min(255, v)));
    }
    return `${ia} ${ib} ${bs} ` + s.join(' ');
};

const SEEDS = [
    { id: 'db-bs12', want: 'h264.deblock', st: '去區塊濾波（亮度邊界）：輸入一行 11 個整數，依序是 indexA、indexB、邊界強度 bS（1 至 4）、p3、p2、p1、p0、q0、q1、q2、q3。依 H.264 的 α、β、tC0 表與濾波公式，輸出 6 個整數：p2、p1、p0、q0、q1、q2 濾波後的值。', ref: REF, gen: genDb(16, 51) },
    { id: 'db-bs4', want: 'h264.deblock', st: '去區塊濾波（亮度邊界，強濾波）：輸入一行 11 個整數，依序是 indexA、indexB、邊界強度 bS（1 至 4）、p3、p2、p1、p0、q0、q1、q2、q3。依 H.264 的 α、β 表與強濾波公式，輸出 6 個整數：p2、p1、p0、q0、q1、q2 濾波後的值。', ref: REF, gen: genDb(0, 51) },
    // holdout：另寫措辭（只量測，不教）
    { id: 'db-ho', split: 'holdout', st: '去區塊的亮度邊界濾波：輸入一行 11 個整數，順序為 indexA、indexB、bS、p3、p2、p1、p0、q0、q1、q2、q3。依 H.264 規則判斷是否濾波並計算，印出 p2、p1、p0、q0、q1、q2 六個整數。', ref: REF, gen: genDb(0, 51) },
];

H.main({ name: '領域包 h264deblock', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
