'use strict';
// 領域包 par3（歸約、競爭條件、熵編碼位元打包、Haar 有損框變換）：train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測。
// 參考解獨立寫成循序 Python。判題器真的執行 Python，與參考解的輸出逐字比對。
const H = require('./domain_harness.js'); const { rnd } = H;
const PK = require('./domain_par3_core.js');
const arr = (lo, hi, n) => Array.from({ length: n }, () => rnd(lo, hi));
const gRed = (b) => { const n = rnd(1, b ? 30 : 10), p = rnd(1, 5); return n + ' ' + p + '\n' + arr(0, 99, n).join(' ') + '\n'; };
const gRace = (b) => { const n = rnd(1, b ? 9 : 6), p = rnd(1, 5); return n + ' ' + p + '\n'; };
const gPack = (b) => { const n = rnd(1, b ? 12 : 6), p = rnd(1, 4); const L = arr(0, 6, n); L[0] = rnd(1, 6); const v = L.map((l) => rnd(0, (1 << l) - 1)); return n + ' ' + p + '\n' + L.join(' ') + '\n' + v.join(' ') + '\n'; };
const gHaar = (b) => { const m = rnd(1, b ? 6 : 3), k = 2 * rnd(1, 3), p = rnd(1, 5), n = m * k; return n + ' ' + p + ' ' + k + '\n' + arr(0, 255, n).join(' ') + '\n'; };
const RD = 'import sys\nL = sys.stdin.read().split("\\n")\nv = L[0].split()\nn = int(v[0]); p = int(v[1]); k = int(v[2]) if len(v) > 2 else 1\n';
const X = RD + 'x = list(map(int, L[1].split()))\n';
const REF_SUM = X + 'print(sum(x[:n]))\n', REF_MAX = X + 'print(max(x[:n]))\n', REF_MIN = X + 'print(min(x[:n]))\n';
const REF_ATOM = RD + 'print(n * p)\n', REF_LOST = RD + 'print(n * p - n)\n', REF_UNSYNC = RD + 'print(n)\n';
const REF_BITS = RD + 'Ln = list(map(int, L[1].split())); vals = list(map(int, L[2].split()))\ns = ""\nfor i in range(n):\n    if Ln[i] > 0:\n        s += format(vals[i], "0%db" % Ln[i])\nprint(s)\n';
const REF_TOTAL = RD + 'Ln = list(map(int, L[1].split()))\nprint(sum(Ln))\n';
const REF_SUMQ = RD + 'x = list(map(int, L[1].split())); t = 0\nfor f in range(n // k):\n    for j in range(f * k, f * k + k, 2):\n        lo = (x[j] + x[j + 1]) >> 1; hi = x[j] - x[j + 1]\n        t += lo // 4 + hi // 4\nprint(t)\n';
const REF_SUMABS = RD + 'x = list(map(int, L[1].split())); t = 0\nfor f in range(n // k):\n    for j in range(f * k, f * k + k, 2):\n        lo = (x[j] + x[j + 1]) >> 1; hi = x[j] - x[j + 1]\n        t += abs(lo // 4) + abs(hi // 4)\nprint(t)\n';
const rw = (s) => s.replace(/\bn\b/g, 'm');
const SEEDS = [
    { id: 'red-sum', want: 'par.reduce', st: '第一行 n p，第二行 n 個整數 x。用 OpenMP 風格的歸約（reduction(+)）：把 x 的迭代以區塊排程分給 p 個執行緒，每個執行緒先算自己的部分和，最後合併。輸出總和。', rw, ref: REF_SUM, gen: gRed },
    { id: 'red-max', want: 'par.reduce', st: '第一行 n p，第二行 n 個整數 x。平行歸約（reduction(max)）：用循環排程把 x 分給 p 個執行緒，各自取部分最大值，最後合併。輸出最大值。', rw, ref: REF_MAX, gen: gRed },
    { id: 'ho-red-min', split: 'holdout', st: '第一行 n p，第二行 n 個整數 x。p 個執行緒各自找自己區段的最小值，最後做最小值的合併（歸約）。輸出整體的最小值。', ref: REF_MIN, gen: gRed },
    { id: 'race-atomic', want: 'par.race', st: '第一行 n p。p 個執行緒各做 n 次計數器加一，用原子加法（atomic）更新，不會遺失更新。輸出最後的計數器值。', rw, ref: REF_ATOM, gen: gRace },
    { id: 'race-lost', want: 'par.race', st: '第一行 n p。p 個執行緒各做 n 次計數器加一，沒有同步，有競爭條件：每一輪所有執行緒先同時讀到共享值 v，再各自寫回 v+1。輸出遺失的更新次數（應有次數減去最後的值）。', rw, ref: REF_LOST, gen: gRace },
    { id: 'ho-race-final', split: 'holdout', st: '第一行 n p。p 個執行緒各做 n 次計數器加一，沒有鎖也沒有原子操作，臨界區沒有保護：每一輪大家讀到同一個值再寫回加一。輸出最後的計數器值。', ref: REF_UNSYNC, gen: gRace },
    { id: 'pack-bits', want: 'par.bitpack', st: '第一行 n p，第二行 n 個區塊的位元長度 L（每個 0 到 6），第三行 n 個值 v（第 i 塊的值小於 2 的 L[i] 次方）。熵編碼的位元打包用兩趟平行：第一趟各執行緒算自己區段的位元長度和，第二趟算出每個區塊的寫入位移後平行寫入位元。輸出寫出的位元串（0 與 1 連在一起，每塊由高位寫到低位）。', rw, ref: REF_BITS, gen: gPack },
    { id: 'pack-total', want: 'par.bitpack', st: '第一行 n p，第二行 n 個區塊的位元長度 L，第三行 n 個值 v。熵編碼的位元打包用兩趟平行（區段和、位移、寫入）。輸出總位元數。', rw, ref: REF_TOTAL, gen: gPack },
    { id: 'ho-pack-bits', split: 'holdout', st: '第一行 n p，第二行 n 個區塊的位元長度 L，第三行 n 個值 v。把每塊的 v 寫成 L 位元（高位在前）接在一起輸出；每塊的寫入位置用兩趟平行計算的位元位移。輸出位元串。', ref: REF_BITS, gen: gPack },
    { id: 'haar-sumq', want: 'par.haar', st: '第一行 n p k，第二行 n 個整數 x（n 是 k 的倍數，k 是偶數）。有損小波：每 k 個取樣為一框，框內每兩個相鄰取樣做整數 Haar 提升（低頻 (a+b)>>1、高頻 a-b），再把每個係數量化為 // 4。框用區塊排程分給 p 個執行緒。輸出全部量化係數的總和。', rw, ref: REF_SUMQ, gen: gHaar },
    { id: 'haar-abs', want: 'par.haar', st: '第一行 n p k，第二行 n 個整數 x（n 是 k 的倍數，k 是偶數）。整數 Haar 提升（低頻 (a+b)>>1、高頻 a-b），每個係數量化為 // 4，框用動態排程分給 p 個執行緒。輸出全部量化係數絕對值的總和。', rw, ref: REF_SUMABS, gen: gHaar },
    { id: 'ho-haar-guided', split: 'holdout', st: '第一行 n p k，第二行 n 個整數 x（n 是 k 的倍數，k 為偶數）。有損的整數 Haar 變換：每框 k 個取樣，框以引導式排程（guided）分給 p 個執行緒；係數以 // 4 量化，輸出總和。', ref: REF_SUMQ, gen: gHaar },
];
H.main({ name: '領域包 par3', packs: [PK], seeds: SEEDS, minSkeletons: 4 });
