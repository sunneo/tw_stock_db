'use strict';
// 領域包「影音壓縮 2」子元件：4×4 幀內預測（本批只做 0 垂直、1 水平、2 DC）。骨架 h264.intra4 在 domain_h264dec_core.js。
// 參考解各模式獨立寫成 Python。train＝教過的措辭；holdout＝另寫措辭，只量測、不教。
// 尚未做：模式 3 至 8（對角與水平向上等，見 DESIGN.media-codec-domain.md §4）。
const H = require('./domain_harness.js');
const DH = require('./domain_h264dec_core.js');

const refOf = (body) => `import sys
v = [int(t) for t in sys.stdin.read().split()]
top = v[0:4]
left = v[8:12]
dc = (sum(top) + sum(left) + 4) >> 3
${body}
for y in range(4):
    print(*rows[y])
`;
const REF_V = refOf('rows = [[top[x] for x in range(4)] for y in range(4)]');
const REF_H = refOf('rows = [[left[y] for x in range(4)] for y in range(4)]');
const REF_DC = refOf('rows = [[dc for x in range(4)] for y in range(4)]');

const ST_V = '輸入一行 12 個整數：前 8 個是上方參考像素（只用前 4 個），後 4 個是左方參考像素。做 H.264 的 4×4 幀內預測，模式為垂直：預測區塊的每一欄都等於上方對應的像素。輸出 4 行，每行 4 個整數，以空格分隔。';
const ST_H = '輸入一行 12 個整數：前 8 個是上方參考像素（只用前 4 個），後 4 個是左方參考像素。做 4×4 幀內預測，模式為水平：預測區塊的每一列都等於左方對應的像素。輸出 4 行，每行 4 個整數。';
const ST_DC = '輸入一行 12 個整數：前 8 個是上方參考像素（只用前 4 個），後 4 個是左方參考像素。做 4×4 幀內預測的 DC 模式：把上方 4 個與左方 4 個像素加總，加 4 後右移 3 位，得到的數填滿整個 4×4 區塊。輸出 4 行，每行 4 個整數。';
// holdout：另寫措辭（新措辭，首次量測）
const ST_HO_DC = '一行有 12 個像素值（0 到 255）：先 8 個是區塊上方的參考列（取前 4 個就夠），後 4 個是左邊的參考行。畫面內預測選 DC：把上方四個與左方四個的和加 4、除以 8（向下取整），然後四行、每行四格都填這個值，印出來。';
const ST_HO_H = '12 個像素值一行，前 4 個（忽略其後 4 個上方候選）是上方，後 4 個是左方參考。幀內預測採水平模式：第 y 列全部填成左方第 y 個參考值，印出 4 行。';

const genPix = (b, { rnd: rr }) => Array.from({ length: 12 }, () => rr(0, 255)).join(' ');

const SEEDS = [
    { id: 'intra4-v', want: 'h264.intra4', st: ST_V, ref: REF_V, gen: genPix },
    { id: 'intra4-h', want: 'h264.intra4', st: ST_H, ref: REF_H, gen: genPix },
    { id: 'intra4-dc', want: 'h264.intra4', st: ST_DC, ref: REF_DC, gen: genPix },
    { id: 'intra4-dc-ho', split: 'holdout', st: ST_HO_DC, ref: REF_DC, gen: genPix },
    { id: 'intra4-h-ho', split: 'holdout', st: ST_HO_H, ref: REF_H, gen: genPix },
];

H.main({ name: '領域包 h264intra', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
