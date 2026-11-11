'use strict';
// 領域包「影音壓縮 2」子元件：CAVLC coeff_token 解碼（H.264 表 9-5）。骨架 h264.coefftoken 在 domain_h264dec_core.js。
// 表來源：libavc common/ih264_cavlc_tables.c（Apache 2.0），由 web-fetch 子代理逐字取得。
// 欄位約定：列＝TrailingOnes、欄＝TotalCoeff−1；已核對 nC 0 至 2 的 TotalCoeff 1、TrailingOnes 0 碼字為 000101（長度 6），與規格表 9-5 一致（核對者：本棒作者，依記憶，尚未對照規格原文）。
// 參考解：獨立寫成 Python，逐格掃描（與骨架的字典查表寫法不同）；表本身的數字與骨架共用同一來源，因此不是獨立來源的對照。
// 自檢：每張表互不為前綴、Kraft 和不超過 1。
// 限制：沒有外部解碼器可單獨對照 coeff_token 的一個碼字；nC 等於 −2（4:2:2 色度直流）沒有表，未涵蓋。
const H = require('./domain_harness.js');
const DH = require('./domain_h264dec_core.js');

// 自檢
for (const k of Object.keys(DH.ctTables)) {
    const cw = DH.ctTables[k];
    let kraft = 0;
    for (const a of cw) {
        kraft += Math.pow(2, -a[2].length);
        for (const b of cw) if (a !== b && b[2].startsWith(a[2]) && a[2] !== b[2]) throw new Error(`coeff_token 表 ${k} 碼字 ${a[2]} 是 ${b[2]} 的前綴`);
    }
    if (kraft > 1 + 1e-12) throw new Error(`coeff_token 表 ${k} Kraft 和 ${kraft} 超過 1`);
    console.log(`coeff_token 表 ${k}：${cw.length} 碼字，Kraft 和 ${kraft.toFixed(6)}，互不為前綴`);
}

const REF = `import sys
v = [int(t) for t in sys.stdin.read().split()]
nc = v[0]
bits = "".join(str(x) for x in v[1:17])
C = [[[5,7,7,7,7,15,11,8,15,11,15,11,15,11,7,4],[1,4,6,6,6,6,14,10,14,10,14,10,1,14,10,6],[0,1,5,5,5,5,5,13,9,13,9,13,9,13,9,5],[0,0,3,3,4,4,4,4,4,12,12,8,12,8,12,8]],[[11,7,7,7,4,7,15,11,15,11,8,15,11,7,9,7],[2,7,10,6,6,6,6,14,10,14,10,14,10,11,8,6],[0,3,9,5,5,5,5,13,9,13,9,13,9,6,10,5],[0,0,5,4,6,8,4,4,4,12,8,12,12,8,1,4]],[[15,11,8,15,11,9,8,15,11,15,11,8,13,9,5,1],[14,15,12,10,8,14,10,14,14,10,14,10,7,12,8,4],[0,13,14,11,9,13,9,13,10,13,9,13,9,11,7,3],[0,0,12,11,10,9,8,13,12,12,12,8,12,10,6,2]]]
S = [[[6,8,9,10,11,13,13,13,14,14,15,15,16,16,16,16],[2,6,8,9,10,11,13,13,14,14,15,15,15,16,16,16],[0,3,7,8,9,10,11,13,13,14,14,15,15,16,16,16],[0,0,5,6,7,8,9,10,11,13,14,14,15,15,16,16]],[[6,6,7,8,8,9,11,11,12,12,12,13,13,13,14,14],[2,5,6,6,7,8,9,11,11,12,12,13,13,14,14,14],[0,3,6,6,7,8,9,11,11,12,12,13,13,13,14,14],[0,0,4,4,5,6,6,7,9,11,11,12,13,13,13,14]],[[6,6,6,7,7,7,7,8,8,9,9,9,10,10,10,10],[4,5,5,5,5,6,6,7,8,8,9,9,9,10,10,10],[0,4,5,5,5,6,6,7,7,8,8,9,9,10,10,10],[0,0,4,4,4,4,4,5,6,7,8,8,9,10,10,10]]]
CC = [[7,4,3,2],[1,6,3,3],[0,1,2,2],[0,0,5,0]]
CS = [[6,6,6,6],[1,6,7,8],[0,3,7,8],[0,0,6,7]]
def table(ci):
    if ci == 'chroma':
        code, size = CC, CS
    else:
        code, size = C[ci], S[ci]
    out = []
    for t1 in range(4):
        for c in range(len(size[t1])):
            if size[t1][c] > 0:
                out.append((c + 1, t1, format(code[t1][c], "0%db" % size[t1][c])))
    return out
if nc == -1:
    tab = [(0, 0, "01")] + table('chroma')
elif nc >= 8:
    tab = [(0, 0, "000011")]
    for tc in range(1, 17):
        for t1 in range(0, min(3, tc) + 1):
            tab.append((tc, t1, format((tc - 1) * 4 + t1, "06b")))
else:
    idx = 0 if nc < 2 else (1 if nc < 4 else 2)
    tab = [(0, 0, ["1", "11", "1111"][idx])] + table(idx)
ans = None
for tc, t1, cw in tab:
    if ans is None and bits.startswith(cw):
        ans = (tc, t1)
print(ans[0], ans[1])
`;

// 產生：依 key 挑一個碼字，再補隨機位元到 16 位；nC 依 key 指定。
const genCT = (keys) => (b, { rnd }) => {
    const k = keys[rnd(0, keys.length - 1)];
    const list = DH.ctTables[k];
    const e = list[rnd(0, list.length - 1)];
    let bits = e[2];
    while (bits.length < 16) bits += rnd(0, 1);
    const nc = { n0: rnd(0, 1), n2: rnd(2, 3), n4: rnd(4, 7), flc: rnd(8, 16), chroma: -1 }[k];
    return `${nc} ` + bits.split('').join(' ');
};

const ST_N0 = 'CAVLC 的 coeff_token 解碼（nC 0 至 2 那一欄）：輸入一行 17 個整數，第一個是 nC，其後 16 個是位元（每個為 0 或 1）。依 H.264 表 9-5 從位元開頭比對碼字，輸出兩個整數：TotalCoeff 與 TrailingOnes。';
const ST_N2 = 'CAVLC 的 coeff_token 解碼（nC 2 至 4 那一欄）：輸入一行 17 個整數，第一個是 nC，其後 16 個是位元（每個為 0 或 1）。依 H.264 表 9-5 從位元開頭比對碼字，輸出兩個整數：TotalCoeff 與 TrailingOnes。';
const ST_N4 = 'CAVLC 的 coeff_token 解碼（nC 4 至 8 那一欄）：輸入一行 17 個整數，第一個是 nC，其後 16 個是位元（每個為 0 或 1）。依 H.264 表 9-5 從位元開頭比對碼字，輸出兩個整數：TotalCoeff 與 TrailingOnes。';
const ST_N8 = 'CAVLC 的 coeff_token 解碼（nC 8 以上，固定 6 位元那一欄）：輸入一行 17 個整數，第一個是 nC，其後 16 個是位元（每個為 0 或 1）。依 H.264 表 9-5 從位元開頭比對碼字，輸出兩個整數：TotalCoeff 與 TrailingOnes。';
const ST_CH = 'CAVLC 的 coeff_token 解碼（色度直流，nC 為 −1）：輸入一行 17 個整數，第一個是 nC，其後 16 個是位元（每個為 0 或 1）。依 H.264 表 9-5 的色度直流那一欄從位元開頭比對碼字，輸出兩個整數：TotalCoeff 與 TrailingOnes。';
// holdout：另寫措辭（只量測，不教）
const ST_HO = 'coeff_token 的查表：輸入一行 17 個整數，第一個為 nC（−1、0 至 16），其後 16 個為位元（0 或 1）。依 H.264 規則找出位元開頭符合的碼字，印出 TotalCoeff 與 TrailingOnes。';

const SEEDS = [
    { id: 'ct-n0', want: 'h264.coefftoken', st: ST_N0, ref: REF, gen: genCT(['n0']) },
    { id: 'ct-n2', want: 'h264.coefftoken', st: ST_N2, ref: REF, gen: genCT(['n2']) },
    { id: 'ct-n4', want: 'h264.coefftoken', st: ST_N4, ref: REF, gen: genCT(['n4']) },
    { id: 'ct-n8', want: 'h264.coefftoken', st: ST_N8, ref: REF, gen: genCT(['flc']) },
    { id: 'ct-chroma', want: 'h264.coefftoken', st: ST_CH, ref: REF, gen: genCT(['chroma']) },
    { id: 'ct-ho', split: 'holdout', st: ST_HO, ref: REF, gen: genCT(['n0', 'n2', 'n4', 'flc', 'chroma']) },
];

H.main({ name: '領域包 h264coefftoken', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
