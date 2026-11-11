'use strict';
// 領域包「影音壓縮 3」運動子元件：全搜尋 SAD、B 幀預設雙向平均、1/4 像素內插。骨架在 domain_h264motion_core.js。
// 參考解：獨立寫成 Python（SAD 用「先收集所有候選再取最小」，與骨架的逐一更新寫法不同）。
// 限制：全搜尋只做整數位移 −1 至 1 的 3×3 位置；平手規則是本題自訂（寫在題目裡），不是編碼器的規則。
const H = require('./domain_harness.js');
const MO = require('./domain_h264motion_core.js');

const REF_SAD = `import sys
v = [int(t) for t in sys.stdin.read().split()]
blk = v[:16]
win = v[16:52]
cands = []
for dy in (-1, 0, 1):
    for dx in (-1, 0, 1):
        sad = 0
        for i in range(4):
            for j in range(4):
                sad += abs(blk[i * 4 + j] - win[(i + 1 + dy) * 6 + (j + 1 + dx)])
        cands.append((sad, dx, dy))
best = min(c[0] for c in cands)
for c in cands:
    if c[0] == best:
        print(c[1], c[2], c[0])
        break
`;

const REF_BI = `import sys
v = [int(t) for t in sys.stdin.read().split()]
a, b = v[:4], v[4:8]
print(*[(a[i] + b[i] + 1) // 2 for i in range(4)])
`;

const REF_QP = `import sys
v = [int(t) for t in sys.stdin.read().split()]
G, b = v
print((G + b + 1) // 2)
`;

const ST_SAD = '運動搜尋（全搜尋 SAD）：輸入一行 52 個整數，前 16 個為目前區塊的樣本（4 列、每列 4 個，依列排列），其後 36 個為參考窗的樣本（6 列、每列 6 個，依列排列）。參考窗的左上角對應位移 (−1, −1)。對位移 dx 與 dy 各取 −1、0、1 共九個位置，計算目前區塊與參考窗對應樣本的絕對差總和 SAD。依 dy 由小到大、同一 dy 內依 dx 由小到大檢查，只有嚴格小於目前最小值時才更新，因此平手取先出現者。輸出三個整數：最佳的 dx、dy 與該位置的 SAD。';
const HO_SAD = '運動估計的全搜尋：一行 52 個整數，先給 16 個數為目前的區塊（依列），再給 36 個數為參考窗（6 列，依列排列）。參考窗左上角對應位移 (−1, −1)。位移 dx、dy 各取 −1、0、1，逐一算絕對差總和；dy 較小者先比，同一 dy 中 dx 較小者先比，只有更小才換，平手保留先出現者。輸出 dx、dy 與最小的絕對差總和。';
const ST_BI = 'B 幀雙向預測的預設平均：輸入一行 8 個整數，前 4 個為清單 0 的預測樣本 a0 至 a3，後 4 個為清單 1 的預測樣本 b0 至 b3。每個位置的結果為 (a 加 b 加 1) 右移 1 位。輸出 4 個整數，依序為四個位置的結果。';
const HO_BI = 'B 幀的雙向預測取平均：輸入一行 8 個整數，前 4 個是清單 0 的預測值，後 4 個是清單 1 的預測值。逐一位置計算 (a 加 b 加 1) 除以 2 的整數部分，輸出四個整數。';
const ST_QP = '1/4 像素內插（a 位置）：輸入一行 2 個整數，依序為整數位置的樣本 G 與半像素樣本 b（都是 0 至 255）。a 的值為 (G 加 b 加 1) 右移 1 位。輸出一個整數 a。';
const HO_QP = '四分之一像素位置 a 的內插：輸入一行 2 個整數，第一個是整數位置樣本 G，第二個是半像素樣本 b，兩者都在 0 到 255。a 等於 G 加 b 再加 1 後除以 2 取整數部分。輸出 a。';

const genSad = (b, { rnd }) => { const xs = []; for (let i = 0; i < 52; i++) xs.push(rnd(0, 255)); return xs.join(' '); };
const genBi = (b, { rnd }) => { const xs = []; for (let i = 0; i < 8; i++) xs.push(rnd(0, 255)); return xs.join(' '); };
const genQp = (b, { rnd }) => [rnd(0, 255), rnd(0, 255)].join(' ');

const REF_QD = `import sys
v = [int(t) for t in sys.stdin.read().split()]
b, h, m, s = v
print((b + h + 1) // 2, (b + m + 1) // 2, (h + s + 1) // 2, (m + s + 1) // 2)
`;

const ST_QD = '四分之一像素的對角位置：輸入一行 4 個整數，依序為半像素樣本 b、h、m、s（都是 0 至 255）。e 為 (b 加 h 加 1) 右移 1 位；g 為 (b 加 m 加 1) 右移 1 位；p 為 (h 加 s 加 1) 右移 1 位；r 為 (m 加 s 加 1) 右移 1 位。輸出四個整數，依序為 e、g、p、r。';
const HO_QD = '1/4 像素位置 e、g、p、r 的值：一行 4 個整數，依序是 b、h、m、s 四個半像素樣本。取 b 與 h 的平均（加 1 後右移 1 位）得 e；b 與 m 得 g；h 與 s 得 p；m 與 s 得 r。依序輸出 e、g、p、r 四個整數。';
const genQd = (b, { rnd }) => [rnd(0, 255), rnd(0, 255), rnd(0, 255), rnd(0, 255)].join(' ');

const REF_ED = `import sys
v = [int(t) for t in sys.stdin.read().split()]
G, H, M, b, h = v
print((H + b + 1) // 2, (G + h + 1) // 2, (M + h + 1) // 2)
`;
const ST_ED = '1/4 像素的邊緣位置 c、d、n：輸入一行 5 個整數，依序為整數位置的樣本 G、H、M（都是 0 至 255）與半像素樣本 b、h。c 為 (H 加 b 加 1) 右移 1 位；d 為 (G 加 h 加 1) 右移 1 位；n 為 (M 加 h 加 1) 右移 1 位。輸出三個整數，依序為 c、d、n。';
const HO_ED = '1/4 像素的 c、d、n 位置：一行 5 個整數，依序為整數樣本 G、H、M，再為半像素樣本 b、h。c 取 H 與 b 的平均（加 1 後右移 1 位）；d 取 G 與 h 的平均；n 取 M 與 h 的平均。依序輸出 c、d、n。';
const genEd = (b, { rnd }) => [rnd(0, 255), rnd(0, 255), rnd(0, 255), rnd(0, 255), rnd(0, 255)].join(' ');

const REF_TP = `import sys
v = [int(t) for t in sys.stdin.read().split()]
taps = [1, -5, 20, 20, -5, 1]
b1 = sum(t * x for t, x in zip(taps, v))
print(min(255, max(0, (b1 + 16) // 32)))
`;
const ST_TP = '六分接頭半像素樣本 b：輸入一行 6 個整數，依序為同一列的整數位置樣本 E、F、G、H、I、J（都是 0 至 255）。先算 b1 等於 E 減 5F 加 20G 加 20H 減 5I 加 J，再算 b 等於 (b1 加 16) 右移 5 位，並限制在 0 至 255。輸出一個整數 b。';
const HO_TP = '六分接頭的半像素值 b：一行 6 個整數 E、F、G、H、I、J（0 至 255）。先算 E 減 5 乘 F 加 20 乘 G 加 20 乘 H 減 5 乘 I 加 J，記為 b1；再算 (b1 加 16) 除以 32 取整數部分，並限制在 0 至 255。輸出 b。';
const genTp = (b, { rnd }) => [0, 1, 2, 3, 4, 5].map(() => rnd(0, 255)).join(' ');

const REF_JC = `import sys
v = [int(t) for t in sys.stdin.read().split()]
taps = [1, -5, 20, 20, -5, 1]
j1 = sum(t * x for t, x in zip(taps, v))
print(min(255, max(0, (j1 + 512) // 1024)))
`;
const ST_JC = '六分接頭中心位置 j：輸入一行 6 個整數，依序為未截斷的中間值 cc、dd、h1、m1、ee、ff（可為負數）。j1 等於 cc 減 5dd 加 20h1 加 20m1 減 5ee 加 ff。j 等於 (j1 加 512) 右移 10 位，並限制在 0 至 255。輸出一個整數 j。';
const HO_JC = '六分接頭中心位置 j：一行 6 個整數，依序為中間值 cc、dd、h1、m1、ee、ff（未截斷，可為負數）。j1 等於 cc 減 5 乘 dd 加 20 乘 h1 加 20 乘 m1 減 5 乘 ee 加 ff。j 等於 (j1 加 512) 除以 1024 取整數部分，限制在 0 至 255。輸出 j。';
const genJc = (b, { rnd }) => [0, 1, 2, 3, 4, 5].map(() => rnd(-2550, 10710)).join(' ');

const REF_FK = `import sys
v = [int(t) for t in sys.stdin.read().split()]
b, h, j, m, s = v
print((b + j + 1) // 2, (h + j + 1) // 2, (j + m + 1) // 2, (j + s + 1) // 2)
`;
const ST_FK = '1/4 像素的 f、i、k、q 位置：輸入一行 5 個整數，依序為半像素樣本 b、h、j、m、s（都是 0 至 255）。f 為 (b 加 j 加 1) 右移 1 位；i 為 (h 加 j 加 1) 右移 1 位；k 為 (j 加 m 加 1) 右移 1 位；q 為 (j 加 s 加 1) 右移 1 位。輸出四個整數，依序為 f、i、k、q。';
const HO_FK = '1/4 像素的 f、i、k、q 位置：一行 5 個整數，依序為 b、h、j、m、s（0 至 255）。f 取 b 與 j 的平均（加 1 後右移 1 位）；i 取 h 與 j；k 取 j 與 m；q 取 j 與 s。依序輸出 f、i、k、q。';
const genFk = (b, { rnd }) => [0, 1, 2, 3, 4].map(() => rnd(0, 255)).join(' ');

const SEEDS = [
    { id: 'mo-sad-tr', want: 'h264.motion.sad', st: ST_SAD, ref: REF_SAD, gen: genSad },
    { id: 'mo-sad-ho', split: 'holdout', st: HO_SAD, ref: REF_SAD, gen: genSad },
    { id: 'mo-bi-tr', want: 'h264.bipred', st: ST_BI, ref: REF_BI, gen: genBi },
    { id: 'mo-bi-ho', split: 'holdout', st: HO_BI, ref: REF_BI, gen: genBi },
    { id: 'mo-qp-tr', want: 'h264.qpel', st: ST_QP, ref: REF_QP, gen: genQp },
    { id: 'mo-qp-ho', split: 'holdout', st: HO_QP, ref: REF_QP, gen: genQp },
    { id: 'mo-qd-tr', want: 'h264.qpel.diag', st: ST_QD, ref: REF_QD, gen: genQd },
    { id: 'mo-qd-ho', split: 'holdout', st: HO_QD, ref: REF_QD, gen: genQd },
    { id: 'mo-ed-tr', want: 'h264.qpel.edge', st: ST_ED, ref: REF_ED, gen: genEd },
    { id: 'mo-ed-ho', split: 'holdout', st: HO_ED, ref: REF_ED, gen: genEd },
    { id: 'mo-tp-tr', want: 'h264.qpel.tap6', st: ST_TP, ref: REF_TP, gen: genTp },
    { id: 'mo-tp-ho', split: 'holdout', st: HO_TP, ref: REF_TP, gen: genTp },
    { id: 'mo-jc-tr', want: 'h264.qpel.j', st: ST_JC, ref: REF_JC, gen: genJc },
    { id: 'mo-jc-ho', split: 'holdout', st: HO_JC, ref: REF_JC, gen: genJc },
    { id: 'mo-fk-tr', want: 'h264.qpel.fikq', st: ST_FK, ref: REF_FK, gen: genFk },
    { id: 'mo-fk-ho', split: 'holdout', st: HO_FK, ref: REF_FK, gen: genFk },
];

H.main({ name: '領域包 h264motion', packs: [MO], seeds: SEEDS, minSkeletons: 3, judge: { checker: 'tokens', timeoutMs: 60000 } });
