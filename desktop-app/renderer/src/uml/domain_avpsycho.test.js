'use strict';
// 領域包「影音壓縮 4」子元件：簡化心理聲學遮蔽（教學定義，非 ISO 11172 模型），骨架 aud.psycho4 在 domain_avaudio_core.js。
// 定義：8 係數分 4 帶（每帶 2 個）；帶能量＝係數平方和；門檻＝（左帶＋本帶＋右帶）的十分之一，超出邊界的帶視為 0；10×X²≥門檻 則為 1。
// 參考解：獨立寫成 Python，用逐帶迴圈與門檻直接比較（與骨架寫法不同）。
// 限制：這是教學用的簡化定義，不代表任何標準的心理聲學模型；沒有外部工具可逐值對照。
const H = require('./domain_harness.js');
const DH = require('./domain_avaudio_core.js');

const REF = `import sys
v = [int(t) for t in sys.stdin.read().split()]
bands = []
for b in range(4):
    e = 0
    for j in range(2):
        e += v[2 * b + j] ** 2
    bands.append(e)
flags = []
for k in range(8):
    b = k // 2
    nb = 0
    if b - 1 >= 0:
        nb += bands[b - 1]
    nb += bands[b]
    if b + 1 <= 3:
        nb += bands[b + 1]
    flags.append(1 if 10 * v[k] ** 2 >= nb else 0)
print(*flags)
`;

const genPS = (b, { rnd }) => {
    const xs = [];
    for (let i = 0; i < 8; i++) {
        // 讓各帶大小差很多，門檻比較才有 0 與 1 兩種結果
        const scale = rnd(0, 3) === 0 ? 40 : 6;
        xs.push(rnd(-scale, scale));
    }
    return xs.join(' ');
};

const ST = '簡化心理聲學遮蔽（教學定義）：輸入一行 8 個整數（MDCT 係數）。每兩個係數為一個頻帶，共 4 帶；頻帶能量為該帶係數平方和；某帶的遮蔽門檻為左帶、本帶、右帶能量和（超出邊界的帶視為 0）的十分之一。逐個係數判斷：係數平方的 10 倍不小於本帶門檻則輸出 1（可聽），否則輸出 0。輸出 8 個整數（旗標）。';
// holdout：另寫措辭（只量測，不教）
const HO = '遮蔽門檻判斷：輸入一行 8 個整數，每相鄰兩個係數成一頻帶（共 4 帶）。帶能量是該帶兩數平方和，門檻是左、中、右三帶能量和的十分之一（缺的鄰帶算 0）。若某係數平方乘 10 不小於其所在帶的門檻就印 1，否則印 0，輸出 8 個旗標。';

const SEEDS = [
    { id: 'psy-tr', want: 'aud.psycho4', st: ST, ref: REF, gen: genPS },
    { id: 'psy-ho', split: 'holdout', st: HO, ref: REF, gen: genPS },
];

H.main({ name: '領域包 avpsycho', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
