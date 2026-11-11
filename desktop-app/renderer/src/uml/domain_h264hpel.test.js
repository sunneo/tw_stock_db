'use strict';
// 領域包「影音壓縮 3」子元件：亮度半像素內插（6 抽頭，H.264 8.4.2.2.1），骨架 h264.hpel 在 domain_h264dec_core.js。
// 公式：b1＝E−5F＋20G＋20H−5I＋J；b＝clip0_255((b1＋16)>>5)。
// 參考解：獨立寫成 Python，用權重向量內積（與骨架的展開式不同）。
// 限制：沒有外部解碼器可單獨對照一個半像素樣本；公式來自規格的記憶，尚未對照規格原文。
const H = require('./domain_harness.js');
const DH = require('./domain_h264dec_core.js');

const REF = `import sys
v = [int(t) for t in sys.stdin.read().split()]
w = [1, -5, 20, 20, -5, 1]
b1 = sum(w[i] * v[i] for i in range(6))
b = (b1 + 16) >> 5
print(max(0, min(255, b)))
`;

const genHP = (b, { rnd }) => {
    const xs = [];
    for (let i = 0; i < 6; i++) xs.push(rnd(0, 255));
    return xs.join(' ');
};

const ST = '亮度半像素內插（6 抽頭）：輸入一行 6 個整數 E、F、G、H、I、J（0 至 255）。先算 b1＝E 減 5 倍 F 加 20 倍 G 加 20 倍 H 減 5 倍 I 加 J；再算 b＝(b1 加 16) 右移 5 位，並限制在 0 至 255；輸出一個整數 b。';
// holdout：另寫措辭（只量測，不教）
const HO = '半像素樣本的 6 抽頭內插：輸入一行 6 個整數，依序為 E、F、G、H、I、J（0 至 255）。按權重 1、−5、20、20、−5、1 加總得到 b1，再取（b1＋16）除以 32 的整數部分並夾在 0 至 255 之間，印出結果。';

const SEEDS = [
    { id: 'hp-tr', want: 'h264.hpel', st: ST, ref: REF, gen: genHP },
    { id: 'hp-ho', split: 'holdout', st: HO, ref: REF, gen: genHP },
];

H.main({ name: '領域包 h264hpel', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
