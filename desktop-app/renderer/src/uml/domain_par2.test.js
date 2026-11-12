'use strict';
// 領域包 par2（相依分析、兩趟前綴和、框式量化）：train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測。
// 參考解獨立寫成循序 Python（不用骨架的寫法）。判題器真的執行 Python，與參考解的輸出逐字比對。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const PK = require('./domain_par2_core.js');
const arr = (b, n) => Array.from({ length: n }, () => rnd(0, b ? 255 : 40));
const np = (b, maxN) => { const n = rnd(1, b ? maxN : Math.min(10, maxN)), p = rnd(1, 5); return { n, p }; };
// 輸入：n p 與 x（第二行）
const gScan = (b) => { const { n, p } = np(b, 30); return n + ' ' + p + '\n' + arr(b, n).join(' ') + '\n'; };
const gFrame = (b) => { const { n, p } = np(b, 30), k = rnd(1, 6); return n + ' ' + p + ' ' + k + '\n' + arr(b, n).join(' ') + '\n'; };
const gWave = (b) => { const n = rnd(1, b ? 30 : 10), d = rnd(1, 6); return n + ' ' + d + '\n' + arr(b, n).join(' ') + '\n'; };
// 獨立寫的循序參考解（每一題的 Python）
const RD = 'import sys\nL = sys.stdin.read().split("\\n")\nv = L[0].split()\nn = int(v[0]); q = int(v[1]); k = int(v[2]) if len(v) > 2 else 1\nx = list(map(int, L[1].split()))\n';
const REF_INCL = RD + 'out = []; s = 0\nfor i in range(n):\n    s += x[i]; out.append(s)\nprint(" ".join(map(str, out)))\n';
const REF_EXCL = RD + 'out = []; s = 0\nfor i in range(n):\n    out.append(s); s += x[i]\nprint(" ".join(map(str, out)))\n';
const REF_TOTAL = RD + 'print(sum(x[:n]))\n';
const REF_SUMQ = RD + 'print(sum(v // 4 for v in x[:n]))\n';
const REF_MAXERR = RD + 'print(max(v % 4 for v in x[:n]))\n';
const REF_WARR = RD + 'a = []\nfor i in range(n):\n    a.append(x[i] if i < q else a[i - q] + x[i])\nprint(" ".join(map(str, a)))\n';
const REF_WSTEPS = RD + 'print(-(-n // q))\n';
const REF_WWIDTH = RD + 'print(min(q, n))\n';
const rw = (s) => s.replace(/\bn\b/g, 'm');
const SEEDS = [
    { id: 'scan-incl', want: 'par.scan2', st: '第一行 n p，第二行 n 個整數 x。用平行的區段前綴和：把 x 切成 p 個連續區段，每段先算區段和（第一趟，各執行緒同時做），再把前面各段的總和加到自己這段（第二趟）。輸出 x 的前綴和（第 i 個輸出是 x[0] 到 x[i] 的和），以空白隔開。', rw, ref: REF_INCL, gen: gScan },
    { id: 'scan-excl', want: 'par.scan2', st: '第一行 n p，第二行 n 個區塊的位元長度 x。用兩趟平行計算每個區塊的位元位移：第一趟各執行緒算自己區段的長度和，第二趟把前面區段的總和加上去。輸出每個區塊的起始位元位移（第 i 個是 x[0] 到 x[i-1] 的和，第一個是 0），以空白隔開。', rw, ref: REF_EXCL, gen: gScan },
    { id: 'ho-scan-total', split: 'holdout', st: '第一行 n p，第二行 n 個區塊的位元長度 x。各區塊的位元位移用兩趟平行計算（區段內先加總，再加上前段總和）。輸出所有區塊的位元總長。', ref: REF_TOTAL, gen: gScan },
    { id: 'frame-sum', want: 'par.frame', st: '第一行 n p k，第二行 n 個整數取樣值 x。把取樣每 k 個分成一框（frame），框用區塊排程分給 p 個執行緒（框數除不盡時前面的執行緒多拿一框）。每個取樣做有損量化 x // 4，輸出所有量化值的總和。', rw, ref: REF_SUMQ, gen: gFrame },
    { id: 'frame-err', want: 'par.frame', st: '第一行 n p k，第二行 n 個像素值 x。每 k 個像素為一框，用循環排程把框分給 p 個執行緒（第 f 框給執行緒 f mod p）。每個像素量化的誤差是 x 除以 4 的餘數，輸出全部像素中最大的量化誤差。', rw, ref: REF_MAXERR, gen: gFrame },
    { id: 'ho-frame-dyn', split: 'holdout', st: '第一行 n p k，第二行 n 個取樣值 x。每 k 個取樣為一框，框由先閒下來的執行緒領取（動態排程）。取樣以步長 4 量化（x // 4）。輸出所有量化值的總和。', ref: REF_SUMQ, gen: gFrame },
    { id: 'wave-array', want: 'par.wave', st: '第一行 n d，第二行 n 個整數 x。迴圈 for i 做 a[i] = a[i-d] + x[i]（i ≥ d），i < d 時 a[i] = x[i]。這個迴圈有攜帶相依（迭代 i 依賴 i-d），但同一層 [j·d, (j+1)·d) 的迭代互不相依，可以按層平行。輸出 a，以空白隔開。', rw, ref: REF_WARR, gen: gWave },
    { id: 'wave-width', want: 'par.wave', st: '第一行 n d，第二行 n 個整數 x。迴圈 a[i] = a[i-d] + x[i] 有迴圈攜帶相依（距離 d）。相依分析後，最多有幾個迭代能同時執行？輸出這個數字（不超過 n）。', rw, ref: REF_WWIDTH, gen: gWave },
    { id: 'ho-wave-steps', split: 'holdout', st: '第一行 n d，第二行 n 個整數 x。a[i] = a[i-d] + x[i]（i ≥ d）是有相依的迴圈，依距離 d 分層執行。輸出需要幾個平行步驟（層數）。', ref: REF_WSTEPS, gen: gWave },
];
H.main({ name: '領域包 par2', packs: [PK], seeds: SEEDS, minSkeletons: 3 });
