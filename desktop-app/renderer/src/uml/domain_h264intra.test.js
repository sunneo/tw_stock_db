'use strict';
// 領域包「影音壓縮 2」子元件：4×4 幀內預測。骨架 h264.intra4 在 domain_h264dec_core.js。
// 模式 0 垂直、1 水平、2 DC：輸入 12 個整數。模式 3 至 8（DDL、DDR、VR、HD、VL、HU）：輸入 13 個整數（上方 8、左方 4、左上角 1）。
// 參考解各模式獨立寫成 Python（p(x,y) 直接照規格的邊界索引寫，與骨架的平坦陣列 E 寫法不同）。
// train＝教過的措辭；holdout＝另寫措辭，只量測、不教。
// 注意：外部工具（ffmpeg／libx264）無法強制單一幀內模式，因此本檔的參考解沒有外部交叉比對；限制見 DESIGN.media-codec-domain.md。
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

// 模式 3 至 8 的參考解：p(x,y) 依規格邊界（y＝-1 取上方含右上 T[0..7]；x＝-1 取左方 L[0..3]；(-1,-1) 取左上角 C）
const P13 = `import sys
v = [int(t) for t in sys.stdin.read().split()]
T = v[0:8]
L = v[8:12]
C = v[12]
def p(x, y):
    if x == -1 and y == -1:
        return C
    if y == -1:
        return T[x]
    return L[y]
`;
const REF_DDL = P13 + `for y in range(4):
    row = []
    for x in range(4):
        if x == 3 and y == 3:
            row.append((p(6, -1) + 3 * p(7, -1) + 2) >> 2)
        else:
            row.append((p(x + y, -1) + 2 * p(x + y + 1, -1) + p(x + y + 2, -1) + 2) >> 2)
    print(*row)
`;
const REF_DDR = P13 + `for y in range(4):
    row = []
    for x in range(4):
        if x > y:
            row.append((p(x - y - 2, -1) + 2 * p(x - y - 1, -1) + p(x - y, -1) + 2) >> 2)
        elif x < y:
            row.append((p(-1, y - x - 2) + 2 * p(-1, y - x - 1) + p(-1, y - x) + 2) >> 2)
        else:
            row.append((p(0, -1) + 2 * p(-1, -1) + p(-1, 0) + 2) >> 2)
    print(*row)
`;
const REF_VR = P13 + `for y in range(4):
    row = []
    for x in range(4):
        z = 2 * x - y
        if z >= 0 and z % 2 == 0:
            row.append((p(x - (y >> 1) - 1, -1) + p(x - (y >> 1), -1) + 1) >> 1)
        elif z >= 0:
            row.append((p(x - (y >> 1) - 2, -1) + 2 * p(x - (y >> 1) - 1, -1) + p(x - (y >> 1), -1) + 2) >> 2)
        elif z == -1:
            row.append((p(-1, 0) + 2 * p(-1, -1) + p(0, -1) + 2) >> 2)
        else:
            row.append((p(-1, y - 1) + 2 * p(-1, y - 2) + p(-1, y - 3) + 2) >> 2)
    print(*row)
`;
const REF_HD = P13 + `for y in range(4):
    row = []
    for x in range(4):
        z = 2 * y - x
        if z >= 0 and z % 2 == 0:
            row.append((p(-1, y - (x >> 1) - 1) + p(-1, y - (x >> 1)) + 1) >> 1)
        elif z >= 0:
            row.append((p(-1, y - (x >> 1) - 2) + 2 * p(-1, y - (x >> 1) - 1) + p(-1, y - (x >> 1)) + 2) >> 2)
        elif z == -1:
            row.append((p(-1, 0) + 2 * p(-1, -1) + p(0, -1) + 2) >> 2)
        else:
            row.append((p(x - 1, -1) + 2 * p(x - 2, -1) + p(x - 3, -1) + 2) >> 2)
    print(*row)
`;
const REF_VL = P13 + `for y in range(4):
    row = []
    for x in range(4):
        if y % 2 == 0:
            row.append((p(x + (y >> 1), -1) + p(x + (y >> 1) + 1, -1) + 1) >> 1)
        else:
            row.append((p(x + (y >> 1), -1) + 2 * p(x + (y >> 1) + 1, -1) + p(x + (y >> 1) + 2, -1) + 2) >> 2)
    print(*row)
`;
const REF_HU = P13 + `for y in range(4):
    row = []
    for x in range(4):
        z = x + 2 * y
        k = y + (x >> 1)
        if z < 5 and z % 2 == 0:
            row.append((p(-1, k) + p(-1, k + 1) + 1) >> 1)
        elif z < 5:
            row.append((p(-1, k) + 2 * p(-1, k + 1) + p(-1, k + 2) + 2) >> 2)
        elif z == 5:
            row.append((p(-1, 2) + 3 * p(-1, 3) + 2) >> 2)
        else:
            row.append(p(-1, 3))
    print(*row)
`;

const ST_V = '輸入一行 12 個整數：前 8 個是上方參考像素（只用前 4 個），後 4 個是左方參考像素。做 H.264 的 4×4 幀內預測，模式為垂直：預測區塊的每一欄都等於上方對應的像素。輸出 4 行，每行 4 個整數，以空格分隔。';
const ST_H = '輸入一行 12 個整數：前 8 個是上方參考像素（只用前 4 個），後 4 個是左方參考像素。做 4×4 幀內預測，模式為水平：預測區塊的每一列都等於左方對應的像素。輸出 4 行，每行 4 個整數。';
const ST_DC = '輸入一行 12 個整數：前 8 個是上方參考像素（只用前 4 個），後 4 個是左方參考像素。做 4×4 幀內預測的 DC 模式：把上方 4 個與左方 4 個像素加總，加 4 後右移 3 位，得到的數填滿整個 4×4 區塊。輸出 4 行，每行 4 個整數。';
// 補寫敘述（寫出 4×4，並教）：對應 intra4-h-ho 的根因（原敘述沒有 4×4）
const ST_H2 = '輸入一行 12 個整數：前 8 個是上方參考像素（只用前 4 個），後 4 個是左方參考像素。做 4×4 幀內預測的水平模式：區塊第 y 列全部填入左方第 y 個參考像素。輸出 4 行，每行 4 個整數。';
// holdout：原措辭（保留為根因紀錄，仍未解）
const ST_HO_DC = '一行有 12 個像素值（0 到 255）：先 8 個是區塊上方的參考列（取前 4 個就夠），後 4 個是左邊的參考行。畫面內預測選 DC：把上方四個與左方四個的和加 4、除以 8（向下取整），然後四行、每行四格都填這個值，印出來。';
const ST_HO_H = '12 個像素值一行，前 4 個（忽略其後 4 個上方候選）是上方，後 4 個是左方參考。幀內預測採水平模式：第 y 列全部填成左方第 y 個參考值，印出 4 行。';
// holdout：新措辭（寫出 4×4，首次量測）
// holdout 新措辭（寫出 4×4、輸入句型同通過的題，首次量測）：對應 intra4-h-ho 的根因
const ST_HO2_H = '以 4×4 幀內預測的水平模式產生預測區塊：輸入一行 12 個 0 到 255 的整數，前 8 格為上方（只看前 4 格）、後 4 格為左方。第 y 列整列填入左方第 y 格的值。印出 4 行，每行 4 個整數。';
const ST_HO2_DC = '以 4×4 幀內預測的 DC 模式產生預測區塊：輸入一行 12 個 0 到 255 的整數，前 8 格為上方（只看前 4 格）、後 4 格為左方。把上方 4 格與左方 4 格的和加 4、再右移 3 位，填滿整個區塊。印出 4 行，每行 4 個整數。';

// 模式 3 至 8：train（教過的措辭，寫出 4×4）與 holdout（另寫措辭）
const ST_DDL = '輸入一行 13 個整數：前 8 個是上方參考像素（含右上 4 格）、接著 4 個是左方參考像素、最後 1 個是左上角像素。做 4×4 幀內預測，模式為對角向左下：預測值依 x＋y 決定，用三點加權平均 (a＋2b＋c＋2) 右移 2 位；右下角（x 為 3、y 為 3）改用 (p6＋3×p7＋2) 右移 2 位。輸出 4 行，每行 4 個整數。';
const ST_DDR = '輸入一行 13 個整數：前 8 個是上方參考像素、接著 4 個是左方參考像素、最後 1 個是左上角像素。做 4×4 幀內預測，模式為對角向右下：x 大於 y 的位置用上方像素、x 小於 y 的位置用左方像素，都是三點加權平均 (a＋2b＋c＋2) 右移 2 位；x 等於 y 的對角線用左上角與左方、上方第一個像素。輸出 4 行，每行 4 個整數。';
const ST_VR = '輸入一行 13 個整數：前 8 個是上方參考像素、接著 4 個是左方參考像素、最後 1 個是左上角像素。做 4×4 幀內預測，模式為垂直偏右：依 2x－y 的值分段，偶數用兩個上方像素的平均、奇數用三點加權平均，負值時改用左方與左上角的像素。輸出 4 行，每行 4 個整數。';
const ST_HD = '輸入一行 13 個整數：前 8 個是上方參考像素、接著 4 個是左方參考像素、最後 1 個是左上角像素。做 4×4 幀內預測，模式為水平偏下：依 2y－x 的值分段，偶數用兩個左方像素的平均、奇數用三點加權平均，負值時改用上方與左上角的像素。輸出 4 行，每行 4 個整數。';
const ST_VL = '輸入一行 13 個整數：前 8 個是上方參考像素（含右上 4 格）、接著 4 個是左方參考像素、最後 1 個是左上角像素。做 4×4 幀內預測，模式為垂直偏左：y 為偶數的列用兩點平均、y 為奇數的列用三點加權平均，取值位置依 x 與 y 右移一位的和決定。輸出 4 行，每行 4 個整數。';
const ST_HU = '輸入一行 13 個整數：前 8 個是上方參考像素、接著 4 個是左方參考像素、最後 1 個是左上角像素。做 4×4 幀內預測，模式為水平偏上：依 x＋2y 的值分段，小於 5 的偶數與奇數分別用兩點平均與三點加權平均，等於 5 用左方後兩個像素，大於 5 直接用左方最後一個像素。輸出 4 行，每行 4 個整數。';
const HO_DDL = '以 4×4 幀內預測（DDL，對角向左下）產生預測區塊：輸入 13 個 0 到 255 的整數，順序為上方 8 格、左方 4 格、左上角 1 格（一行）。印出 4 行，每行 4 個整數。';
// 原 HO_DDL（intra4-ddl-ho）「輸入 13 個…」讀不出；新措辭改成與讀得出的題相同的「輸入一行 13 個…」句型（首次量測）
const HO2_DDL = '以 4×4 幀內預測（DDL，對角向左下）產生預測區塊：輸入一行 13 個 0 到 255 的整數，順序為上方 8 格、左方 4 格、左上角 1 格。印出 4 行，每行 4 個整數。';
const HO_DDR ='以 4×4 幀內預測（DDR，對角向右下）產生預測區塊：輸入一行 13 個 0 到 255 的整數，順序為上方 8 格、左方 4 格、左上角 1 格。印出 4 行，每行 4 個整數。';
const HO_VR = '以 4×4 幀內預測（VR，垂直偏右）產生預測區塊：輸入一行 13 個 0 到 255 的整數，順序為上方 8 格、左方 4 格、左上角 1 格。印出 4 行，每行 4 個整數。';
const HO_HD = '以 4×4 幀內預測（HD，水平偏下）產生預測區塊：輸入一行 13 個 0 到 255 的整數，順序為上方 8 格、左方 4 格、左上角 1 格。印出 4 行，每行 4 個整數。';
const HO_VL = '以 4×4 幀內預測（VL，垂直偏左）產生預測區塊：輸入一行 13 個 0 到 255 的整數，順序為上方 8 格、左方 4 格、左上角 1 格。印出 4 行，每行 4 個整數。';
const HO_HU = '以 4×4 幀內預測（HU，水平偏上）產生預測區塊：輸入一行 13 個 0 到 255 的整數，順序為上方 8 格、左方 4 格、左上角 1 格。印出 4 行，每行 4 個整數。';

const genPix = (b, { rnd: rr }) => Array.from({ length: 12 }, () => rr(0, 255)).join(' ');
const genPix13 = (b, { rnd: rr }) => Array.from({ length: 13 }, () => rr(0, 255)).join(' ');

const SEEDS = [
    { id: 'intra4-v', want: 'h264.intra4', st: ST_V, ref: REF_V, gen: genPix },
    { id: 'intra4-h', want: 'h264.intra4', st: ST_H, ref: REF_H, gen: genPix },
    { id: 'intra4-dc', want: 'h264.intra4', st: ST_DC, ref: REF_DC, gen: genPix },
    { id: 'intra4-h-tr2', want: 'h264.intra4', st: ST_H2, ref: REF_H, gen: genPix },
    { id: 'intra4-dc-ho', split: 'holdout', st: ST_HO_DC, ref: REF_DC, gen: genPix },
    { id: 'intra4-h-ho', split: 'holdout', st: ST_HO_H, ref: REF_H, gen: genPix },
    { id: 'intra4-h-ho2', split: 'holdout', st: ST_HO2_H, ref: REF_H, gen: genPix },
    { id: 'intra4-dc-ho2', split: 'holdout', st: ST_HO2_DC, ref: REF_DC, gen: genPix },
    { id: 'intra4-ddl', want: 'h264.intra4', st: ST_DDL, ref: REF_DDL, gen: genPix13 },
    { id: 'intra4-ddr', want: 'h264.intra4', st: ST_DDR, ref: REF_DDR, gen: genPix13 },
    { id: 'intra4-vr', want: 'h264.intra4', st: ST_VR, ref: REF_VR, gen: genPix13 },
    { id: 'intra4-hd', want: 'h264.intra4', st: ST_HD, ref: REF_HD, gen: genPix13 },
    { id: 'intra4-vl', want: 'h264.intra4', st: ST_VL, ref: REF_VL, gen: genPix13 },
    { id: 'intra4-hu', want: 'h264.intra4', st: ST_HU, ref: REF_HU, gen: genPix13 },
    { id: 'intra4-ddl-ho', split: 'holdout', st: HO_DDL, ref: REF_DDL, gen: genPix13 },
    { id: 'intra4-ddl-ho2', split: 'holdout', st: HO2_DDL, ref: REF_DDL, gen: genPix13 },
    { id: 'intra4-ddr-ho', split: 'holdout', st: HO_DDR, ref: REF_DDR, gen: genPix13 },
    { id: 'intra4-vr-ho', split: 'holdout', st: HO_VR, ref: REF_VR, gen: genPix13 },
    { id: 'intra4-hd-ho', split: 'holdout', st: HO_HD, ref: REF_HD, gen: genPix13 },
    { id: 'intra4-vl-ho', split: 'holdout', st: HO_VL, ref: REF_VL, gen: genPix13 },
    { id: 'intra4-hu-ho', split: 'holdout', st: HO_HU, ref: REF_HU, gen: genPix13 },
];

H.main({ name: '領域包 h264intra', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
