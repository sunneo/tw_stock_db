'use strict';
// 領域包「影音壓縮 5」子元件：霍夫曼（canonical Huffman）解碼，骨架 img.huff4 在 domain_avimage_core.js。
// 這是階段 5 熵編碼後段的最小子題：4 個符號的 canonical 碼，只輸出第一個解出的符號。
// 參考解：獨立寫成 Python，用排序鍵（碼長、符號）指派碼字，與骨架的逐碼長迴圈寫法不同。
// 限制：只涵蓋 canonical 指派與前綴比對；沒有整串資料的熵編碼器，也沒有 JPEG 或 DEFLATE 的外部對照。
const H = require('./domain_harness.js');
const DH = require('./domain_avimage_core.js');

const REF = `import sys
v = [int(t) for t in sys.stdin.read().split()]
L = v[0:4]
bits = "".join(str(x) for x in v[4:16])
order = sorted([s for s in range(4) if L[s] > 0], key=lambda s: (L[s], s))
codes = {}
c = 0
prev = L[order[0]]
for s in order:
    c = c << (L[s] - prev)
    codes[s] = format(c, "0%db" % L[s])
    c += 1
    prev = L[s]
ans = -1
for s in order:
    if ans == -1 and bits.startswith(codes[s]):
        ans = s
print(ans)
`;

// 產生：碼長取完整 Kraft 集合（[1,2,3,3] 或 [2,2,2,2]）隨機排列到符號上，位元隨機。
const genHF = (b, { rnd }) => {
    const base = rnd(0, 1) === 0 ? [1, 2, 3, 3] : [2, 2, 2, 2];
    const L = base.slice();
    for (let i = L.length - 1; i > 0; i--) {
        const j = rnd(0, i);
        const t = L[i]; L[i] = L[j]; L[j] = t;
    }
    const bits = [];
    for (let i = 0; i < 12; i++) bits.push(rnd(0, 1));
    return L.concat(bits).join(' ');
};

const ST = '霍夫曼解碼（canonical 規則）：輸入一行 16 個整數，前 4 個是符號 0 至 3 的碼長（1 至 3），其後 12 個是位元（0 或 1）。依碼長由小到大、同長依符號由小到大指派碼字（碼由 0 開始逐一遞增，碼長增加時左移），從位元開頭比對，輸出第一個解出的符號。';
// holdout：另寫措辭（只量測，不教）
const HO = '霍夫曼碼的讀取：輸入一行 16 個整數，前四個為符號 0 至 3 的碼長，後十二個為位元。用 canonical 方式給碼字（同碼長依符號序），由位元開頭找到符合的碼字，印出該符號。';

const SEEDS = [
    { id: 'hf-tr', want: 'img.huff4', st: ST, ref: REF, gen: genHF },
    { id: 'hf-ho', split: 'holdout', st: HO, ref: REF, gen: genHF },
];

H.main({ name: '領域包 avhuff', packs: [DH], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
