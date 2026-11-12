'use strict';
// 領域包「影音壓縮 2」子元件：CAVLC 的 total_zeros 解碼（4×4 區塊，tzVlcIndex 1 至 15，表 9-7、9-8）。骨架 h264.totalzeros 在 domain_h264dec_core.js。
// 表來源：libavc ih264_cavlc_tables.c（Apache 2.0）；本檔以相同的表做參考解，自檢（互不為前綴、Kraft 和不超過 1）後才進判題。
// 限制：表的內容是對照源碼還原，未對照規格原文；外部解碼對照路徑不存在（見 DESIGN.media-codec-domain.md）。
const H = require('./domain_harness.js');
const DH = require('./domain_h264dec_core.js');

const TZ = {1: [[0, '1'], [1, '011'], [2, '010'], [3, '0011'], [4, '0010'], [5, '00011'], [6, '00010'], [7, '000011'], [8, '000010'], [9, '0000011'], [10, '0000010'], [11, '00000011'], [12, '00000010'], [13, '000000011'], [14, '000000010'], [15, '000000001']], 2: [[0, '111'], [1, '110'], [2, '101'], [3, '100'], [4, '011'], [5, '0101'], [6, '0100'], [7, '0011'], [8, '0010'], [9, '00011'], [10, '00010'], [11, '000011'], [12, '000010'], [13, '000001'], [14, '000000']], 3: [[0, '0101'], [1, '111'], [2, '110'], [3, '101'], [4, '0100'], [5, '0011'], [6, '100'], [7, '011'], [8, '0010'], [9, '00011'], [10, '00010'], [11, '000001'], [12, '00001'], [13, '000000']], 4: [[0, '00011'], [1, '111'], [2, '0101'], [3, '0100'], [4, '110'], [5, '101'], [6, '100'], [7, '0011'], [8, '011'], [9, '0010'], [10, '00010'], [11, '00001'], [12, '00000']], 5: [[0, '0101'], [1, '0100'], [2, '0011'], [3, '111'], [4, '110'], [5, '101'], [6, '100'], [7, '011'], [8, '0010'], [9, '00001'], [10, '0001'], [11, '00000']], 6: [[0, '000001'], [1, '00001'], [2, '111'], [3, '110'], [4, '101'], [5, '100'], [6, '011'], [7, '010'], [8, '0001'], [9, '001'], [10, '000000']], 7: [[0, '000001'], [1, '00001'], [2, '101'], [3, '100'], [4, '011'], [5, '11'], [6, '010'], [7, '0001'], [8, '001'], [9, '000000']], 8: [[0, '000001'], [1, '0001'], [2, '00001'], [3, '011'], [4, '11'], [5, '10'], [6, '010'], [7, '001'], [8, '000000']], 9: [[0, '000001'], [1, '000000'], [2, '0001'], [3, '11'], [4, '10'], [5, '001'], [6, '01'], [7, '00001']], 10: [[0, '00001'], [1, '00000'], [2, '001'], [3, '11'], [4, '10'], [5, '01'], [6, '0001']], 11: [[0, '0000'], [1, '0001'], [2, '001'], [3, '010'], [4, '1'], [5, '011']], 12: [[0, '0000'], [1, '0001'], [2, '01'], [3, '1'], [4, '001']], 13: [[0, '000'], [1, '001'], [2, '1'], [3, '01']], 14: [[0, '00'], [1, '01'], [2, '1']], 15: [[0, '0'], [1, '1']]};

for (const k of Object.keys(TZ)) {
    const cw = TZ[k].map((x) => x[1]);
    let kraft = 0;
    for (const a of cw) {
        kraft += Math.pow(2, -a.length);
        for (const b of cw) if (a !== b && b.startsWith(a)) throw new Error(`total_zeros 表 ${k} 碼字 ${a} 是 ${b} 的前綴`);
    }
    if (kraft > 1 + 1e-12) throw new Error(`total_zeros 表 ${k} Kraft 和 ${kraft} 超過 1`);
}
console.log('total_zeros 表自檢通過（15 列，互不為前綴，Kraft 和不超過 1）');

const REF = `import sys
v = [int(t) for t in sys.stdin.read().split()]
tzi = v[0]
bits = "".join(str(x) for x in v[1:11])
tab = ${JSON.stringify(Object.fromEntries(Object.entries(TZ).map(([k, rows]) => [k, rows.map(([v2, c]) => [v2, c])])))}
ans = None
for tz, cw in tab[str(tzi)]:
    if ans is None and bits.startswith(cw):
        ans = tz
print(ans)
`;

const ST_LO = 'CAVLC 解碼 total_zeros（4×4 區塊）：輸入一行 11 個整數，第一個是 tzVlcIndex（1 到 7），其後 10 個是位元（每個為 0 或 1）。依 H.264 表 9-7 查 tzVlcIndex 那一列，從位元開頭比對碼字，輸出 total_zeros（一個整數）。';
const ST_HI = 'CAVLC 解碼 total_zeros（4×4 區塊）：輸入一行 11 個整數，第一個是 tzVlcIndex（8 到 15），其後 10 個是位元（每個為 0 或 1）。依 H.264 表 9-8 查 tzVlcIndex 那一列，從位元開頭比對碼字，輸出 total_zeros（一個整數）。';
// holdout：另寫措辭（只量測）
const ST_HO = 'total_zeros 的 CAVLC 解碼：輸入一行 11 個整數，第一個是 tzVlcIndex（1 到 15），其後 10 個位元（0 或 1）。依 H.264 規則找出位元開頭的碼字，印出 total_zeros。';

const genTZ = (lo, hi) => (b, { rnd }) => {
    const t = rnd(lo, hi);
    const rows = TZ[String(t)];
    const pick = rows[rnd(0, rows.length - 1)];
    let bits = pick[1];
    while (bits.length < 10) bits += rnd(0, 1);
    return `${t} ` + bits.split('').join(' ');
};

const SEEDS = [
    { id: 'tz-lo', want: 'h264.totalzeros', st: ST_LO, ref: REF, gen: genTZ(1, 7) },
    { id: 'tz-hi', want: 'h264.totalzeros', st: ST_HI, ref: REF, gen: genTZ(8, 15) },
    { id: 'tz-ho', split: 'holdout', st: ST_HO, ref: REF, gen: genTZ(1, 15) },
];

H.main({ name: '領域包 h264totalzeros', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
