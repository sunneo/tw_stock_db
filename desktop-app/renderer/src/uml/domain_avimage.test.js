'use strict';
// 領域包「影音壓縮 5」有損影像的一層整數小波：img.haar1d、img.legall53。骨架在 domain_avimage_core.js。
// 自檢：LeGall 5/3 的正向提升必須可逆（反提升還原原值），否則參考解的邊界定義有誤；Haar 也做還原檢查。
// 參考解獨立寫成 Python（逐點算，與骨架的 list 寫法不同）。train＝教過的措辭；holdout＝另寫措辭，只量測、不教。
// 限制：沒有外部工具可交叉比對本定義（Pillow／ffmpeg 的小波實作邊界與捨入規則不同），正確性以可逆性與參考解一致為準。
const H = require('./domain_harness.js');
const DA = require('./domain_avimage_core.js');

// JS 自檢：正向與反向提升互逆（隨機 300 組）
const fwd = (x) => {
    const n = x.length, N = n / 2, d = [], s = [];
    for (let i = 0; i < N; i++) {
        const xr = 2 * i + 2 < n ? x[2 * i + 2] : x[2 * i];
        d.push(x[2 * i + 1] - ((x[2 * i] + xr) >> 1));
    }
    for (let i = 0; i < N; i++) {
        const dl = i > 0 ? d[i - 1] : d[i];
        s.push(x[2 * i] + ((dl + d[i] + 2) >> 2));
    }
    return { s, d };
};
const inv = ({ s, d }) => {
    const N = s.length, n = 2 * N, x = new Array(n);
    for (let i = 0; i < N; i++) {
        const dl = i > 0 ? d[i - 1] : d[i];
        x[2 * i] = s[i] - ((dl + d[i] + 2) >> 2);
    }
    for (let i = 0; i < N; i++) {
        const xr = 2 * i + 2 < n ? x[2 * i + 2] : x[2 * i];
        x[2 * i + 1] = d[i] + ((x[2 * i] + xr) >> 1);
    }
    return x;
};
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
for (let t = 0; t < 300; t++) {
    const x = Array.from({ length: 8 }, () => (rnd() % 256) - 128);
    const back = inv(fwd(x));
    if (back.join(',') !== x.join(',')) throw new Error('5/3 提升不可逆：' + x.join(' '));
}
console.log('LeGall 5/3 提升自檢通過（300 組隨機，反提升還原原值）');

const REF_HAAR = `import sys
v = [int(t) for t in sys.stdin.read().split()]
lo = []
hi = []
for i in range(0, 8, 2):
    lo.append((v[i] + v[i + 1]) // 2)
    hi.append(v[i] - v[i + 1])
print(*lo)
print(*hi)
`;

const REF_LEGALL = `import sys
x = [int(t) for t in sys.stdin.read().split()]
n = len(x)
half = n // 2
def right_of(i):
    if 2 * i + 2 < n:
        return x[2 * i + 2]
    return x[2 * i]
d = [x[2 * i + 1] - (x[2 * i] + right_of(i)) // 2 for i in range(half)]
s = []
for i in range(half):
    left_d = d[0] if i == 0 else d[i - 1]
    s.append(x[2 * i] + (left_d + d[i] + 2) // 4)
print(*s)
print(*d)
`;

const ST_HAAR = '一層 Haar 小波（整數版）：輸入一行 8 個整數，兩兩一組 (a,b)；低頻為 (a+b) 右移 1 位（向下取整），高頻為 a 減 b。輸出兩行，第一行為低頻（4 個），第二行為高頻（4 個）。';
const ST_LEGALL = 'LeGall 5/3 小波的整數提升（一層）：輸入一行 8 個整數，記為 x0 至 x7。先算高頻 d[i]＝x[2i+1] 減去 (x[2i] 加上右鄰 x[2i+2]) 右移 1 位，右鄰超出右端時用 x[2i]；再算低頻 s[i]＝x[2i] 加上 (d[i-1] 加 d[i] 加 2) 右移 2 位，i 為 0 時 d[-1] 取 d[0]。輸出兩行：第一行 s（4 個），第二行 d（4 個）。';
// holdout：另寫措辭（只量測）
const HO_HAAR = '以 Haar 小波做一層整數分解：輸入一行 8 個整數，每兩個相鄰數為一對 (a,b)。輸出第一行是 (a+b) 右移 1 位的低頻，第二行是 a 減 b 的高頻，各 4 個。';
const HO_LEGALL = 'JPEG 2000 可逆的 5/3 小波一層提升：輸入一行 8 個整數。先由奇數位置減去相鄰兩偶數的平均（取整數，向下取整）得高頻，再由偶數位置加上相鄰高頻的平均（取整，向下取整，加 2 後除以 4）得低頻。右端超出時用左側偶數代替，左端第一個低頻的左側高頻用第一個高頻代替。第一行印低頻、第二行印高頻。';

// 原 HO_LEGALL（legall-ho）的錯誤：「加上相鄰高頻的平均（…加 2 後除以 4）」把「平均」與「除以 4」寫成矛盾，讀取器與參考解的公式不一致，屬敘述錯誤；保留為紀錄。
// HO2_LEGALL：新措辭，把公式寫成「和」而非「平均」（首次量測）。
const HO2_LEGALL = 'JPEG 2000 可逆 5/3 小波一層（提升法）：輸入一行 8 個整數，記為 x0 至 x7。高頻 d[i] 為奇數位 x[2i+1] 減去 (x[2i] 與右鄰偶數之和) 右移 1 位，右鄰超出右端時用 x[2i]；低頻 s[i] 為偶數位 x[2i] 加上 (兩個相鄰高頻 d[i-1] 與 d[i] 之和加 2) 右移 2 位，左端 d[-1] 用 d[0]。第一行印 s，第二行印 d。';
// HO3_LEGALL：legall-ho2 未解的根因是輸出句「第一行印 s，第二行印 d」被讀成輸入（讀取器只認「輸出」字樣）；改寫輸出句後的第三次措辭。
// 注意：legall-ho 的 holdout 已改過兩次（ho→ho2→ho3），不再是乾淨 holdout，結果只能當措辭探索紀錄。
const HO3_LEGALL = 'JPEG 2000 可逆 5/3 小波一層（提升法）：輸入一行 8 個整數，記為 x0 至 x7。高頻 d[i] 為奇數位 x[2i+1] 減去 (x[2i] 與右鄰偶數之和) 右移 1 位，右鄰超出右端時用 x[2i]；低頻 s[i] 為偶數位 x[2i] 加上 (兩個相鄰高頻 d[i-1] 與 d[i] 之和加 2) 右移 2 位，左端 d[-1] 用 d[0]。輸出兩行：第一行 s（4 個），第二行 d（4 個）。';
const gen8 = (b, { rnd: rr }) => Array.from({ length: 8 }, () => rr(-128, 127)).join(' ');

const SEEDS = [
    { id: 'haar-tr', want: 'img.haar1d', st: ST_HAAR, ref: REF_HAAR, gen: gen8 },
    { id: 'legall-tr', want: 'img.legall53', st: ST_LEGALL, ref: REF_LEGALL, gen: gen8 },
    { id: 'haar-ho', split: 'holdout', st: HO_HAAR, ref: REF_HAAR, gen: gen8 },
    { id: 'legall-ho', split: 'holdout', st: HO_LEGALL, ref: REF_LEGALL, gen: gen8 },
    { id: 'legall-ho2', split: 'holdout', st: HO2_LEGALL, ref: REF_LEGALL, gen: gen8 },
    { id: 'legall-ho3', split: 'holdout', st: HO3_LEGALL, ref: REF_LEGALL, gen: gen8 },
];

H.main({ name: '領域包 avimage', packs: [DA], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
