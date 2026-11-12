'use strict';
// 領域包「影音壓縮 2」子元件：CAVLC level 解碼（H.264 9.2.2.1）。骨架 h264.level 在 domain_h264dec_core.js。
// 規則：levelCode＝(min(15,prefix)<<suffixLength)+suffix；prefix≥15 且 suffixLength＝0 時加 15；prefix≥16 時加 (1<<(prefix−3))−4096；
//      加 2 旗標為真時加 2；偶數 levelVal＝(code+2)>>1，奇數＝(−code−1)>>1；suffixLength 0 時先設為 1；
//      |levelVal| 超過 3<<(suffixLength−1) 且 suffixLength<6 時加 1。
// 參考解：獨立寫成 Python（用乘法與整數除法，與骨架的位元移位寫法不同）。
// 限制：這是規格公式的兩份獨立寫法互相對照，沒有外部解碼器可逐值對照（ffmpeg 的 level 解碼無法單獨呼叫）。
const H = require('./domain_harness.js');
const DH = require('./domain_h264dec_core.js');

const REF = `import sys
v = [int(t) for t in sys.stdin.read().split()]
sl, lp, ls, fl = v
lc = min(15, lp) * (2 ** sl) + ls
if lp >= 15 and sl == 0:
    lc += 15
if lp >= 16:
    lc += 2 ** (lp - 3) - 4096
if fl == 1:
    lc += 2
lv = (lc + 2) // 2 if lc % 2 == 0 else -((lc + 1) // 2)
s = sl
if s == 0:
    s = 1
if abs(lv) > 3 * 2 ** (s - 1) and s < 6:
    s += 1
print(lv, s)
`;

// 產生：suffixLength、level_prefix、level_suffix（依 prefix 與 suffixLength 決定位元數）、加 2 旗標。
const genLevel = (plo, phi) => (b, { rnd }) => {
    const sl = rnd(0, 6);
    const lp = rnd(plo, phi);
    let size = sl;
    if (lp === 14 && sl === 0) size = 4;
    if (lp >= 15) size = lp - 3;
    const ls = rnd(0, (1 << size) - 1);
    const fl = rnd(0, 1);
    return `${sl} ${lp} ${ls} ${fl}`;
};

const SEEDS = [
    { id: 'lv-low', want: 'h264.level', st: 'CAVLC 的 level 解碼：輸入一行 4 個整數，依序是 suffixLength、level_prefix、level_suffix（已讀出的整數值）、加 2 旗標（0 或 1）。依 H.264 規則先算 levelCode，再換成 levelVal，並依 suffixLength 規則更新，輸出兩個整數：levelVal 與更新後的 suffixLength。', ref: REF, gen: genLevel(0, 13) },
    { id: 'lv-esc', want: 'h264.level', st: 'CAVLC 的 level 解碼（含 level_prefix 15 以上的逃脫碼）：輸入一行 4 個整數，依序是 suffixLength、level_prefix、level_suffix（已讀出的整數值）、加 2 旗標（0 或 1）。依 H.264 規則算 levelCode 與 levelVal，並更新 suffixLength，輸出兩個整數。', ref: REF, gen: genLevel(14, 15) },
    { id: 'lv-big', want: 'h264.level', st: 'CAVLC 的 level 解碼（level_prefix 16 以上）：輸入一行 4 個整數，依序是 suffixLength、level_prefix、level_suffix（已讀出的整數值）、加 2 旗標（0 或 1）。依 H.264 規則算 levelCode 與 levelVal，並更新 suffixLength，輸出兩個整數。', ref: REF, gen: genLevel(16, 17) },
    // holdout：另寫措辭（只量測，不教）
    { id: 'lv-ho', split: 'holdout', st: 'level 的讀取：輸入一行 4 個整數，順序為 suffixLength、level_prefix、level_suffix、加 2 旗標。依 H.264 規則求 levelCode、levelVal，並更新 suffixLength，印出 levelVal 與新的 suffixLength。', ref: REF, gen: genLevel(0, 17) },
];

H.main({ name: '領域包 h264level', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
