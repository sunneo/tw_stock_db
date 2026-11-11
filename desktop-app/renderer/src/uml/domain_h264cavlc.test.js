'use strict';
// 領域包「影音壓縮 2」子元件：CAVLC 的 run_before 解碼（H.264 表 9-10）。骨架 h264.runbefore 在 domain_h264dec_core.js。
// 表的正確性先做兩項自檢（碼字互不為前綴；Kraft 和不超過 1），再進判題。
// 參考解獨立寫成 Python（enumerate 逐列比對，與骨架寫法不同）。train＝教過的措辭；holdout＝另寫措辭，只量測、不教。
// 限制：本機沒有 H.264 位元流的外部解碼對照路徑（x264 無法單獨指定 run_before 碼字）；表的正確性靠自檢與兩份獨立抄寫的一致。
const H = require('./domain_harness.js');
const DH = require('./domain_h264dec_core.js');

const TAB = {
    1: ['1', '0'],
    2: ['1', '01', '00'],
    3: ['11', '10', '01', '00'],
    4: ['11', '10', '01', '001', '000'],
    5: ['11', '10', '011', '010', '001', '000'],
    6: ['11', '000', '001', '011', '010', '101', '100'],
    7: ['111', '110', '101', '100', '011', '010', '001', '0001', '00001', '000001', '0000001', '00000001', '000000001', '0000000001', '00000000001'],
};

// 自檢：碼字互不為前綴、Kraft 和不超過 1
for (const k of Object.keys(TAB)) {
    const cw = TAB[k];
    let kraft = 0;
    for (const a of cw) {
        kraft += Math.pow(2, -a.length);
        for (const b of cw) if (a !== b && b.startsWith(a)) throw new Error(`run_before 表 ${k} 碼字 ${a} 是 ${b} 的前綴`);
    }
    if (kraft > 1 + 1e-12) throw new Error(`run_before 表 ${k} Kraft 和 ${kraft} 超過 1`);
    console.log(`表 ${k}：${cw.length} 碼字，Kraft 和 ${kraft}，互不為前綴`);
}

const REF = `import sys
v = [int(t) for t in sys.stdin.read().split()]
zl = v[0]
bits = "".join(str(x) for x in v[1:13])
codes = {1: ['1', '0'], 2: ['1', '01', '00'], 3: ['11', '10', '01', '00'], 4: ['11', '10', '01', '001', '000'], 5: ['11', '10', '011', '010', '001', '000'], 6: ['11', '000', '001', '011', '010', '101', '100']}
big = ['111', '110', '101', '100', '011', '010', '001', '0001', '00001', '000001', '0000001', '00000001', '000000001', '0000000001', '00000000001']
c = codes[zl] if zl <= 6 else big
ans = None
for run, cw in enumerate(c):
    if ans is None and bits.startswith(cw):
        ans = run
print(ans)
`;

const ST_1_6 = 'CAVLC 解碼 run_before：輸入一行 13 個整數，第一個是 zerosLeft（剩餘的零個數，1 到 6），其後 12 個是位元（每個為 0 或 1）。依 H.264 表 9-10 中 zerosLeft 那一張表，從位元字串開頭比對碼字，輸出對應的 run_before（一個整數）。';
const ST_7_14 = 'CAVLC 解碼 run_before：輸入一行 13 個整數，第一個是 zerosLeft（7 到 14），其後 12 個是位元（每個為 0 或 1）。zerosLeft 大於 6 時用表 9-10 的共用那一張表，從位元字串開頭比對碼字，輸出 run_before（一個整數）。';
// holdout：另寫措辭（只量測）
const ST_HO = 'run_before 的 CAVLC 解碼：輸入一行 13 個整數，第一個是 zerosLeft（1 到 14），其後 12 個是位元（0 或 1）。依 H.264 規則找出位元字串開頭的碼字，印出其 run_before。';

// 產生：先抽 zerosLeft 與 run（0..zl），取該碼字再接 6 個隨機位元
const genRB = (lo, hi) => (b, { rnd }) => {
    const zl = rnd(lo, hi);
    const r = rnd(0, zl);
    const table = zl <= 6 ? TAB[zl] : TAB[7];
    let bits = table[r];
    while (bits.length < 12) bits += rnd(0, 1);
    return `${zl} ` + bits.split("").join(" ");
};

const SEEDS = [
    { id: 'rb-zl1-6', want: 'h264.runbefore', st: ST_1_6, ref: REF, gen: genRB(1, 6) },
    { id: 'rb-zl7-14', want: 'h264.runbefore', st: ST_7_14, ref: REF, gen: genRB(7, 14) },
    { id: 'rb-ho', split: 'holdout', st: ST_HO, ref: REF, gen: genRB(1, 14) },
];

H.main({ name: '領域包 h264cavlc', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
