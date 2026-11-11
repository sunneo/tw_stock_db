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

const SEEDS = [
    { id: 'mo-sad-tr', want: 'h264.motion.sad', st: ST_SAD, ref: REF_SAD, gen: genSad },
    { id: 'mo-sad-ho', split: 'holdout', st: HO_SAD, ref: REF_SAD, gen: genSad },
    { id: 'mo-bi-tr', want: 'h264.bipred', st: ST_BI, ref: REF_BI, gen: genBi },
    { id: 'mo-bi-ho', split: 'holdout', st: HO_BI, ref: REF_BI, gen: genBi },
    { id: 'mo-qp-tr', want: 'h264.qpel', st: ST_QP, ref: REF_QP, gen: genQp },
    { id: 'mo-qp-ho', split: 'holdout', st: HO_QP, ref: REF_QP, gen: genQp },
];

H.main({ name: '領域包 h264motion', packs: [MO], seeds: SEEDS, minSkeletons: 3, judge: { checker: 'tokens', timeoutMs: 60000 } });
