'use strict';
// 領域包「影音壓縮 2」第二個子元件：4×4 反量化（平坦縮放，權重 16）。骨架在 domain_h264dec_core.js（h264.dequant4）。
// 參考解獨立寫成 Python（查表以 divmod 取位置、以 q6 分支），與骨架的寫法不同。
// train＝教過的措辭（給出 normAdjust 表與移位規則）；holdout＝另寫措辭，只量測、不教。
const H = require('./domain_harness.js');
const DH = require('./domain_h264dec_core.js');

const REF = `import sys
v = [int(t) for t in sys.stdin.read().split()]
qp = v[0]
co = v[1:17]
nav = [[10, 16, 13], [11, 18, 14], [13, 20, 16], [14, 23, 18], [16, 25, 20], [18, 29, 23]]
out = []
for k in range(16):
    i, j = divmod(k, 4)
    col = 0 if (i % 2 == 0 and j % 2 == 0) else (1 if (i % 2 == 1 and j % 2 == 1) else 2)
    ls = 16 * nav[qp % 6][col]
    q6 = qp // 6
    if qp >= 24:
        out.append((co[k] * ls) << (q6 - 4))
    else:
        out.append((co[k] * ls + (1 << (3 - q6))) >> (4 - q6))
for i in range(4):
    print(*out[4 * i:4 * i + 4])
`;

const ST_TRAIN = '輸入一行 17 個整數：第一個是量化參數 qP，後面 16 個是係數，依列排成 4×4。請做 4×4 反量化（平坦縮放，權重全為 16）：位置 (i,j) 若 i、j 都是偶數，用 normAdjust 表的第 0 欄；都是奇數用第 1 欄；其餘用第 2 欄。表的列由 qP 除以 6 的餘數決定，依序為 [10,16,13]、[11,18,14]、[13,20,16]、[14,23,18]、[16,25,20]、[18,29,23]。LevelScale 為 16 乘 normAdjust。若 qP 不小於 24，結果是（係數乘 LevelScale）左移（qP 除以 6 的商減 4）位；否則是（係數乘 LevelScale 加上 2 的（3 減 qP 除以 6 的商）次方）右移（4 減 qP 除以 6 的商）位。輸出 4 行，每行 4 個整數。';
const ST_HO = '一行 17 個有號整數，首項是 QP，其後 16 個是依列排列的 4 乘 4 反量化前係數。每個係數先乘上它位置的縮放值：縮放值＝16 乘上表中的數，表列由 QP 模 6 決定，欄由位置決定（列與行都偶數取第一欄、都奇數取第二欄、其餘第三欄；表的三欄數值是 10、16、13 起頭的那組）。之後若 QP 至少 24，就把乘積左移 QP 整除 6 再減 4 位；否則先加上 2 的 3 減 QP 整除 6 次方，再右移 4 減 QP 整除 6 位。印出四行，每行四個整數。';

// train 的 qP 0..51 與係數 ±20；holdout 的係數 ±200（數值範圍不同，措辭也不同）
const gen = (R) => (b, { rnd: rr }) => [rr(0, 51)].concat(Array.from({ length: 16 }, () => rr(-R, R))).join(' ');

const SEEDS = [
    { id: 'dequant4', want: 'h264.dequant4', st: ST_TRAIN, ref: REF, gen: gen(20) },
    { id: 'dequant4-rw', want: 'h264.dequant4', st: ST_TRAIN, rw: (s) => s.replace('係數，依列排成', '係數值，依列排成'), ref: REF, gen: gen(20) },
    { id: 'dequant4-ho', split: 'holdout', st: ST_HO, ref: REF, gen: gen(200) },
];

H.main({ name: '領域包 h264dequant', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
