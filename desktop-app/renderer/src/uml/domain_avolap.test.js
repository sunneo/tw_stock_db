'use strict';
// 領域包「影音壓縮 4」子元件：端對端重疊相加（TDAC），骨架 aud.olap8 在 domain_avaudio_core.js。
// 參考解：獨立寫成 Python，核採用 π(2n＋1＋N)(2k＋1)/(4N)（N＝8）的寫法，與骨架的 π/8·(n＋1/2＋4)(k＋1/2) 不同，兩式代數相等。
// 限制：只檢查「公式與縮放」的一致性；沒有外部工具（ffmpeg 的 aac、Python 的 scipy）逐樣本對照，也不含多段串接後的整段誤差。
const H = require('./domain_harness.js');
const DH = require('./domain_avaudio_core.js');

const REF = `import sys, math
v = [int(t) for t in sys.stdin.read().split()]
N = 8
def basis(n, k):
    return math.cos(math.pi * (2 * n + 1 + N) * (2 * k + 1) / (4 * N))
def win(n):
    return math.sin(math.pi * (2 * n + 1) / (2 * 16))
def block(c):
    res = []
    for n in range(16):
        acc = 0.0
        for k in range(N):
            acc += c[k] * basis(n, k)
        res.append(win(n) * acc * 2 / N)
    return res
prev = block(v[0:8])
cur = block(v[8:16])
out = []
for n in range(N):
    x = prev[N + n] + cur[n]
    out.append(math.floor(x + 0.5))
print(*out)
`;

const genOL = (b, { rnd }) => {
    const xs = [];
    for (let i = 0; i < 16; i++) xs.push(rnd(-40, 40));
    return xs.join(' ');
};

const ST = '重疊相加（TDAC）：輸入一行 16 個整數，前 8 個是前一段的 MDCT 係數，後 8 個是這一段的 MDCT 係數。兩段各自做 IMDCT（窗長 16、正弦窗、縮放 2/8，先不取整），前段輸出的後半 8 格與這段輸出的前半 8 格逐格相加，每格加 0.5 後向下取整，輸出 8 個整數。';
// holdout：另寫措辭（只量測，不教）
const HO = '端對端 TDAC 還原：輸入一行 16 個整數，前 8 個為前段係數，後 8 個為這段係數。兩段各做 IMDCT（不取整，窗長 16，縮放 2/8），前段後半與這段前半逐格相加，每格加 0.5 向下取整，印出 8 個整數。';

const SEEDS = [
    { id: 'olap-tr', want: 'aud.olap8', st: ST, ref: REF, gen: genOL },
    { id: 'olap-ho', split: 'holdout', st: HO, ref: REF, gen: genOL },
];

H.main({ name: '領域包 avolap', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
