'use strict';
// 領域包「影音壓縮 2／3」子元件：4×4 整數正變換與量化（H.264 intra，編碼端），骨架 h264.fwdquant4 在 domain_h264dec_core.js。
// 公式：W＝Cf·X·Cfᵀ，Cf＝[[1,1,1,1],[2,1,-1,-2],[1,-1,-1,1],[1,-2,2,-1]]；MF 表（H.264 表 8-13 的正向縮放因子）；
// 量化 Z＝sign(W)·((|W|·MF＋f)>>qbits)，qbits＝15＋qP//6，intra 的 f＝2^qbits//3。
// 參考解：獨立寫成 Python，用矩陣乘法函式與 MF 查表（與骨架的三層迴圈寫法不同），兩份由同一公式寫成。
// 限制：MF 表來自記憶中的規格數值，尚未對照規格原文；沒有外部編碼器（ffmpeg libx264）可單獨對照這一個區塊的量化輸出。
const H = require('./domain_harness.js');
const DH = require('./domain_h264dec_core.js');

const REF = `import sys
v = [int(t) for t in sys.stdin.read().split()]
qp = v[0]
X = [v[1:5], v[5:9], v[9:13], v[13:17]]
CF = [[1, 1, 1, 1], [2, 1, -1, -2], [1, -1, -1, 1], [1, -2, 2, -1]]
MF = [[13107, 5243, 8066], [11916, 4660, 7490], [10082, 4194, 6554], [9362, 3647, 5825], [8192, 3355, 5243], [7282, 2893, 4559]]
def mul(A, B):
    return [[sum(A[i][k] * B[k][j] for k in range(4)) for j in range(4)] for i in range(4)]
def tr(A):
    return [[A[j][i] for j in range(4)] for i in range(4)]
W = mul(mul(CF, X), tr(CF))
qbits = 15 + qp // 6
f = (1 << qbits) // 3
def pick(i, j):
    if i % 2 == 0 and j % 2 == 0:
        return MF[qp % 6][0]
    if i % 2 == 1 and j % 2 == 1:
        return MF[qp % 6][1]
    return MF[qp % 6][2]
res = []
for i in range(4):
    for j in range(4):
        w = W[i][j]
        q = (abs(w) * pick(i, j) + f) >> qbits
        res.append(q if w >= 0 else -q)
print(*res)
`;

// 產生：qP 0 至 51，殘差 −80 至 80。
const genFQ = (b, { rnd }) => {
    const xs = [rnd(0, 51)];
    for (let i = 0; i < 16; i++) xs.push(rnd(-80, 80));
    return xs.join(' ');
};

const ST = '4×4 整數正變換與量化（intra）：輸入一行 17 個整數，第一個是 qP，其後 16 個是殘差（依列）。先做 W＝Cf·X·Cfᵀ，Cf 為 [[1,1,1,1],[2,1,-1,-2],[1,-1,-1,1],[1,-2,2,-1]]；再依位置類別取 MF：兩個偶數位置用第 0 欄、兩個奇數位置用第 1 欄、其餘用第 2 欄，MF 表依 qP 除以 6 的餘數取列；量化 Z＝符號(W)·((|W|·MF＋f)>>qbits)，qbits＝15＋qP 除以 6 取整，f＝2 的 qbits 次方除以 3 取整。輸出 16 個整數（依列）。';
// holdout：另寫措辭（只量測，不教）
const HO = '正向整數轉換加量化（4×4，intra）：輸入一行 17 個整數，第一個為 qP，後 16 個為殘差（依列）。依 H.264 規則求 W＝Cf·X·Cfᵀ，再以 MF 與 qbits＝15＋qP 除以 6、f＝2 的 qbits 次方除以 3 量化，印出 16 個整數。';

const SEEDS = [
    { id: 'fq-tr', want: 'h264.fwdquant4', st: ST, ref: REF, gen: genFQ },
    { id: 'fq-ho', split: 'holdout', st: HO, ref: REF, gen: genFQ },
];

H.main({ name: '領域包 h264fwd', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
