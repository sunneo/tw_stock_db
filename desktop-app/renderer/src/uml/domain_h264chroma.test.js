'use strict';
// 領域包「影音壓縮 3」子元件：色度 1/8 像素雙線性內插（H.264 8.4.2.2.2），骨架 h264.chroma8 在 domain_h264dec_core.js。
// 公式：pred＝((8−xF)(8−yF)A＋xF(8−yF)B＋(8−xF)yF C＋xF yF D＋32)>>6。
// 參考解：獨立寫成 Python，用四個權重的點積（與骨架的展開式寫法不同）。
// 限制：沒有外部解碼器可單獨對照一個色度樣本；公式來自規格的記憶，尚未對照規格原文。
const H = require('./domain_harness.js');
const DH = require('./domain_h264dec_core.js');

const REF = `import sys
v = [int(t) for t in sys.stdin.read().split()]
xf, yf, A, B, C, D = v
wts = [(8 - xf) * (8 - yf), xf * (8 - yf), (8 - xf) * yf, xf * yf]
val = wts[0] * A + wts[1] * B + wts[2] * C + wts[3] * D
print((val + 32) // 64)
`;

const genCH = (b, { rnd }) => {
    const xs = [rnd(0, 7), rnd(0, 7)];
    for (let i = 0; i < 4; i++) xs.push(rnd(0, 255));
    return xs.join(' ');
};

const ST = '色度 1/8 像素雙線性內插：輸入一行 6 個整數 xF、yF（0 至 7）、A、B、C、D（0 至 255，依序為左上、右上、左下、右下樣本）。算 pred＝((8 減 xF)乘(8 減 yF)乘 A 加 xF 乘(8 減 yF)乘 B 加 (8 減 xF)乘 yF 乘 C 加 xF 乘 yF 乘 D 加 32)右移 6 位；輸出一個整數 pred。';
// holdout：另寫措辭（只量測，不教）
const HO = '色度樣本的八分之一像素插值：輸入一行 6 個整數，依序為水平分數 xF、垂直分數 yF（0 至 7）、與四個鄰近樣本 A、B、C、D（0 至 255）。以雙線性權重加總後加 32 再除以 64 取整數部分，印出結果。';

const SEEDS = [
    { id: 'ch-tr', want: 'h264.chroma8', st: ST, ref: REF, gen: genCH },
    { id: 'ch-ho', split: 'holdout', st: HO, ref: REF, gen: genCH },
];

H.main({ name: '領域包 h264chroma', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
