'use strict';
// 領域包「影音壓縮 2：H.264 解碼算術」第一個子元件：4×4 整數逆變換。
// 參考解是獨立寫的（先算每一列的一維變換，再算每一行，最後捨入），與骨架的寫法不同（骨架是逐列原地更新的寫法）。
// train＝教過的措辭（給出一維變換的完整公式）；holdout＝另寫措辭（同一個數學、不同的敘述與數值範圍），只量測、不教。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const DH = require('./domain_h264dec_core.js');
void pick;

// 參考解（獨立寫）：列方向一維變換（不捨入）→ 行方向一維變換 → 每個值 (x+32)>>6
const REF = `import sys
v = [int(t) for t in sys.stdin.read().split()]
m = [v[4 * i:4 * i + 4] for i in range(4)]
def t1(a, b, c, d):
    e = a + c
    f = a - c
    g = (b >> 1) - d
    h = b + (d >> 1)
    return [e + h, f + g, f - g, e - h]
rows = [t1(*m[i]) for i in range(4)]
cols = [t1(*[rows[i][j] for i in range(4)]) for j in range(4)]
for i in range(4):
    print(*[(cols[j][i] + 32) >> 6 for j in range(4)])
`;

const ST_TRAIN = '輸入一行 16 個有號整數，依列排列成 4×4 的係數矩陣 d。請算 H.264 的 4×4 整數逆變換：先對每一列做一維變換，再對每一行做一維變換；一維變換取四個輸入 a、b、c、d，令 e＝a＋c、f＝a－c、g＝(b 右移 1 位)－d、h＝b＋(d 右移 1 位)，輸出 e＋h、f＋g、f－g、e－h。兩個方向都做完後，每個值加 32 再右移 6 位，得到殘差。輸出 4 行，每行 4 個整數，以空格分隔。';
const ST_HO = '給一行 16 個有號整數，是 4 乘 4 的反量化後係數區塊，每 4 個一列。請做 H.264 的反變換：每一列先過一個一維的蝶形運算：四個數記為 a、b、c、d，依序算出 a 加 c、a 減 c、b 右移一位再減 d、d 右移一位再加 b，然後組成四個輸出：前兩者相加、後兩者相加、前兩者相減、後兩者相減（即 e＋h、f＋g、f－g、e－h）。接著對每一行做同樣的運算，最後每個數加 32、右移 6 位，印出 4 行，每行 4 個數。';

// 數值範圍：train 小（±40），holdout 大（±3000）。兩者都由同一個 gen 決定，不靠題目文字。
const genRange = (R) => (b, { rnd: rr }) => Array.from({ length: 16 }, () => rr(-R, R)).join(' ');

const ST_HO2 = '一行 16 個有號整數，代表 4 乘 4 的矩陣，逐列放置。對每一列 p、q、r、s（由左到右）做一次一維運算：先算 p＋r 與 p－r，再算 (q 右移 1 位)－s 與 q＋(s 右移 1 位)，設為 g 與 h；把 p＋r＋h、p－r＋g、p－r－g、p＋r－h 排成新的一列。全部列做完後，對每一行再做同樣的運算，最後每個數加 32、右移 6 位，以四行輸出，每行四個整數、以空格分隔。';
// holdout 新措辭：補上「逆變換」字樣與「輸入一行」句首（讀取器配對靠字樣）；舊 ST_HO2 保留為根因紀錄。
const ST_HO3 = '4 乘 4 整數逆變換（反變換）。輸入' + ST_HO2;
const SEEDS = [
    { id: 'idct4', want: 'h264.idct4', st: ST_TRAIN, ref: REF, gen: genRange(40) },
    { id: 'idct4-rw', want: 'h264.idct4', st: ST_TRAIN, rw: (s) => s.replace('係數矩陣 d', '係數矩陣 Q'), ref: REF, gen: genRange(40) },
    { id: 'idct4-ho', split: 'holdout', st: ST_HO, ref: REF, gen: genRange(3000) },
    { id: 'idct4-ho2', split: 'holdout', st: ST_HO2, ref: REF, gen: genRange(3000) },
    { id: 'idct4-ho3', split: 'holdout', st: ST_HO3, ref: REF, gen: genRange(3000) },
];

H.main({ name: '領域包 h264dec', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
