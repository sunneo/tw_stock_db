'use strict';
// 領域包「Linux 格式型小工具家族」：train＝教過的措辭（含原本 Linux 題庫 holdout 的三題敘述，現在算被教過，不再是 holdout）；
// holdout＝另寫措辭／不同參數（區塊 4096、名稱含小寫與數字、輸出格式不同），只量測、不教。參考解獨立手寫（regex、直接算）。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const LF = require('./domain_linuxfmt_core.js');
const UP = 'ABCDEFGHIJ'; const LO = 'abcdefghij';
const nm = (al, n) => Array.from({ length: n }, () => pick([...al])).join('');
const envGen = (names) => (b) => { const n = rnd(1, 4); const ks = []; while (ks.length < n) { const k = names(); if (!ks.includes(k)) ks.push(k); } const tab = ks.map((k) => k + '=' + nm(LO, rnd(1, 5))); const parts = []; for (let i = 0; i < rnd(2, 5); i++) { const t = rnd(0, 3); const k = rnd(0, 4) === 0 ? names() : pick(ks); parts.push(t === 0 ? nm('xyz-.', rnd(1, 3)) : t === 1 ? '${' + k + '}' : t === 2 ? '$' + k : nm('xyz', 1)); } return n + '\n' + tab.join('\n') + '\n' + parts.join('') + '\n'; };
const ENVREF = (pat) => 'import re, sys\nd = sys.stdin.read().split("\\n")\nn = int(d[0])\nenv = dict(x.split("=", 1) for x in d[1:1+n])\nt = d[1+n]\n' + pat + '\nprint(re.sub(PAT, lambda m: env.get(m.group(1) or m.group(2), ""), t))\n';
const blGen = (hi) => (b) => rnd(0, hi) + '\n';
const BLK = (B, hdr, tl, out) => 's = int(input())\ndata = -(-s // ' + B + ')\nblocks = data + ' + hdr + '\n' + out + '\n';
const hufGen = (b) => { let leaves = [0]; const k = rnd(2, 7); while (leaves.length < k) { const i = rnd(0, leaves.length - 1); const d = leaves[i] + 1; leaves.splice(i, 1, d, d); } leaves = leaves.map((d) => d || 1); const lens = []; for (const d of leaves.sort(() => Math.random() - 0.5)) { if (rnd(0, 3) === 0) lens.push(0); lens.push(d); } return lens.length + '\n' + lens.join(' ') + '\n'; };
const HUF = (fmt) => 'k = int(input())\nL = list(map(int, input().split()))\nfrom collections import Counter\nc = Counter(x for x in L if x)\ncode = 0\nstart = {}\nfor l in range(1, max(L) + 1):\n    code = (code + c.get(l - 1, 0) * (l > 1)) << 1\n    start[l] = code\nused = {}\nfor i, l in enumerate(L):\n    if l:\n        v = start[l] + used.get(l, 0)\n        used[l] = used.get(l, 0) + 1\n        print(' + fmt + ')\n';
const SEEDS = [
    { id: 'env-orig', want: 'lf.env-expand', st: '第一行 n，接著 n 行「名稱=值」，最後一行是樣板。樣板中的 $名稱 或 ${名稱} 要換成值（名稱由大寫字母組成；$名稱 的名稱取到第一個非大寫字母為止；沒定義的名稱換成空字串）。輸出展開結果。', ref: ENVREF("PAT = r'\\$\\{([A-Za-z]+)\\}|\\$([A-Z]+)'"), gen: envGen(() => nm(UP, rnd(2, 4))) },
    { id: 'env-keep', want: 'lf.env-expand', st: '第一行 n，接著 n 行「名稱=值」，最後一行是樣板。樣板中的 $名稱 或 ${名稱} 要換成對應的值（名稱由大寫字母組成；$名稱 取到第一個非大寫字母為止）；沒有定義的名稱原樣保留不替換。輸出展開結果。', ref: 'import re, sys\nd = sys.stdin.read().split("\\n")\nn = int(d[0])\nenv = dict(x.split("=", 1) for x in d[1:1+n])\nt = d[1+n]\nprint(re.sub(r"\\$\\{([A-Za-z]+)\\}|\\$([A-Z]+)", lambda m: env.get(m.group(1) or m.group(2), m.group(0)), t))\n', gen: envGen(() => nm(UP, rnd(2, 4))) },
    { id: 'tar-orig', want: 'lf.block-count', st: '輸入一行檔案大小 s（位元組）。tar 以 512 位元組為區塊：一個檔案佔 1 個標頭區塊，加上資料區塊（資料補 0 補到 512 的倍數，s=0 沒有資料區塊）。輸出兩行：第一行是這一個檔案佔用的區塊數，第二行是只含這個檔案的完整封存檔位元組數（再加 2 個全 0 的結尾區塊）。', ref: BLK(512, 1, 2, 'print(blocks)\nprint((blocks + 2) * 512)'), gen: blGen(5000) },
    { id: 'tar-blocks-only', want: 'lf.block-count', st: '輸入一行檔案大小 s（位元組）。tar 以 512 位元組為區塊：一個檔案佔 1 個標頭區塊，加上資料區塊（資料補 0 補到 512 的倍數，s=0 沒有資料區塊）。輸出這個檔案佔用的區塊數。', ref: BLK(512, 1, 2, 'print(blocks)'), gen: blGen(5000) },
    { id: 'huff-orig', want: 'lf.canon-huffman', st: '第一行 k，第二行 k 個碼長 len[0..k-1]（0 表示該符號不使用）。依 RFC 1951 產生範式碼：bl_count[L]＝碼長為 L 的符號數（L≥1）；next_code[1]=0，next_code[L]=(next_code[L-1]+bl_count[L-1])*2；再依符號編號由小到大，碼長非 0 者取 code=next_code[len]++。對每個使用中的符號輸出一行「符號編號 碼（二進位字串，補零到 len 位）」。', ref: HUF('str(i) + " " + format(v, "0" + str(l) + "b")'), gen: hufGen },
    { id: 'huff-colon', want: 'lf.canon-huffman', st: '第一行 k，第二行 k 個碼長（0 表示不使用）。依 DEFLATE 的範式 Huffman 規則（bl_count、next_code）產生每個符號的碼，依符號編號由小到大，每個使用中的符號輸出一行「符號編號:碼」，碼是補零到碼長的二進位字串。', ref: HUF('str(i) + ":" + format(v, "0" + str(l) + "b")'), gen: hufGen },
    { id: 'ho-env-word', split: 'holdout', st: '第一行 n，接著 n 行「名稱=值」，最後一行是樣板。名稱由英文字母、數字與底線組成。樣板裡的 ${名稱} 與 $名稱 都要換成值，$名稱 的名稱盡量取最長；沒定義的名稱換成空字串。輸出展開後的樣板。', ref: ENVREF("PAT = r'\\$\\{([A-Za-z0-9_]+)\\}|\\$([A-Za-z0-9_]+)'"), gen: envGen(() => nm(LO + '_', rnd(2, 4)) + rnd(0, 9)) },
    { id: 'ho-fs-block', split: 'holdout', st: '輸入一行檔案大小 s（位元組）。檔案系統每個區塊 4096 位元組，檔案資料用掉的區塊數是 s 除以 4096 無條件進位（s=0 用 0 個區塊）。輸出兩行：第一行是用掉的區塊數，第二行是最後浪費的位元組數（內部碎片）。', ref: BLK(4096, 0, 0, 'print(data)\nprint(data * 4096 - s)'), gen: blGen(30000) },
    { id: 'ho-huff-codes', split: 'holdout', st: '第一行 k，第二行 k 個碼長，0 代表該符號沒有用到。依 DEFLATE 的範式前綴碼規則（先算每種碼長有幾個符號，再算每個碼長的起始碼）替每個有用到的符號指派碼，依符號編號順序，每行輸出一個碼（補零到碼長的二進位字串）。', ref: HUF('format(v, "0" + str(l) + "b")'), gen: hufGen },
    { id: 'ho-env-default', split: 'holdout', st: '第一行 n，接著 n 行「名稱=值」，最後一行是樣板。樣板裡的 ${名稱:-預設} 表示名稱沒定義或值為空時用「預設」，其他 ${名稱} 與 $名稱 換成值。輸出展開結果。', ref: 'import sys\nprint("unsupported")\n', gen: envGen(() => nm(UP, 3)) },
];
H.main({ name: '領域包 linuxfmt', packs: [LF], seeds: SEEDS, minSkeletons: 3 });
