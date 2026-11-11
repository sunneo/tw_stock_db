'use strict';
// 領域包「影音壓縮 4」有損聲音的 MDCT 與量化（窗長 16、係數 8）。骨架 aud.mdct8q 在 domain_avaudio_core.js。
// 參考解獨立寫成 Python，核函數用 cos(π(2n＋1＋N)(2k＋1)／(4N))，與骨架的 π/N(n＋1/2＋N/2)(k＋1/2) 寫法不同。
// 自檢：參考解的核與骨架的核在隨機輸入上數值相等（以 JS 計算，誤差 < 1e-9）。
// train＝教過的措辭；holdout＝另寫措辭，只量測、不教。
// 限制：沒有外部工具（ffmpeg 的 aac 編碼器或 Python 的 scipy）逐係數對照；MDCT 正規化約定與窗的選擇已寫進敘述。
const H = require('./domain_harness.js');
const DA = require('./domain_avaudio_core.js');

{
    let maxErr = 0;
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let t = 0; t < 50; t++) {
        for (let k = 0; k < 8; k++) for (let n = 0; n < 16; n++) {
            const a = Math.sin(Math.PI * (n + 0.5) / 16) * Math.cos(Math.PI / 8 * (n + 0.5 + 4) * (k + 0.5));
            const b = Math.sin(Math.PI * (2 * n + 1) / 32) * Math.cos(Math.PI * (2 * n + 1 + 8) * (2 * k + 1) / 32);
            maxErr = Math.max(maxErr, Math.abs(a - b));
        }
        rnd();
    }
    if (maxErr > 1e-9) throw new Error('MDCT 核兩種寫法不一致，最大誤差 ' + maxErr);
    console.log(`MDCT 核兩種寫法自檢通過（最大誤差 ${maxErr.toExponential(2)}）`);
}

const REF = `import sys, math
v = [int(t) for t in sys.stdin.read().split()]
Q = v[0]
x = v[1:17]
N = 8
out = []
for k in range(N):
    s = 0.0
    for n in range(2 * N):
        w = math.sin(math.pi * (2 * n + 1) / (4 * N))
        s += w * x[n] * math.cos(math.pi * (2 * n + 1 + N) * (2 * k + 1) / (4 * N))
    out.append(math.floor(s / Q + 0.5))
print(*out)
`;

const ST = 'MDCT 與量化（有損聲音的變換，窗長 16、輸出 8 個係數）：輸入一行 17 個整數，第一個是量化步長 Q，其後 16 個是取樣值。以正弦窗 w[n]＝sin(π(n＋1/2)/16) 乘上取樣，做 MDCT：X[k]＝Σ w[n]x[n]cos(π/8 (n＋1/2＋4)(k＋1/2))，n 為 0 至 15、k 為 0 至 7；每個 X[k] 除以 Q 加 0.5 後向下取整，輸出一行 8 個整數。';
// holdout：另寫措辭（只量測）
const HO = 'MDCT 量化（音訊壓縮的變換步驟）：輸入一行 17 個整數，第一個是步長 Q，其後 16 個是取樣。用正弦窗（w[n]＝sin(π(2n＋1)/32)）與 N＝8 的 MDCT 核，X[k]＝Σ_{n=0}^{15} w[n]x[n]cos(π(2n＋1＋8)(2k＋1)/32)，各係數除以 Q 加 0.5 取整數部分，輸出一行 8 個整數。';

const gen = (b, { rnd: rr }) => [rr(4, 64)].concat(Array.from({ length: 16 }, () => rr(-100, 100))).join(' ');

// IMDCT（窗長 16、係數 8、縮放 2/N）：TDAC 自檢——相鄰兩區塊（位移 8）的重疊相加在中段必須還原原訊號。
{
    const N = 8, W = 16;
    const w = (n) => Math.sin(Math.PI * (n + 0.5) / W);
    const fwd = (x, off) => Array.from({ length: N }, (_, k) => { let s = 0; for (let n = 0; n < W; n++) s += w(n) * x[off + n] * Math.cos(Math.PI / N * (n + 0.5 + N / 2) * (k + 0.5)); return s; });
    const inv = (X) => Array.from({ length: W }, (_, n) => { let s = 0; for (let k = 0; k < N; k++) s += X[k] * Math.cos(Math.PI / N * (n + 0.5 + N / 2) * (k + 0.5)); return w(n) * s * (2 / N); });
    const x = Array.from({ length: 24 }, (_, i) => Math.sin(i * 0.7) * 100 + (i % 5));
    const y0 = inv(fwd(x, 0)), y1 = inv(fwd(x, 8));
    let maxErr = 0;
    for (let n = 0; n < 8; n++) maxErr = Math.max(maxErr, Math.abs((y0[8 + n] + y1[n]) - x[8 + n]));
    if (maxErr > 1e-9) throw new Error('TDAC 還原失敗，最大誤差 ' + maxErr);
    console.log(`TDAC 自檢通過（中段最大誤差 ${maxErr.toExponential(2)}）`);
}

// IMDCT：參考解獨立寫成 Python（核用 (2n＋1＋N)(2k＋1)/(4N) 式，與骨架寫法不同）
const REF_IMDCT = `import sys, math
X = [int(t) for t in sys.stdin.read().split()]
N = 8
out = []
for n in range(2 * N):
    s = 0.0
    for k in range(N):
        s += X[k] * math.cos(math.pi * (2 * n + 1 + N) * (2 * k + 1) / (4 * N))
    w = math.sin(math.pi * (2 * n + 1) / (4 * N))
    out.append(math.floor(w * (2.0 / N) * s + 0.5))
print(*out)
`;
const ST_IMDCT = 'IMDCT（窗長 16、係數 8）：輸入一行 8 個整數（MDCT 係數 X[0] 至 X[7]）。先算 Y[n]＝Σ X[k]cos(π/8 (n＋1/2＋4)(k＋1/2))，n 為 0 至 15、k 為 0 至 7；再乘上正弦窗 w[n]＝sin(π(n＋1/2)/16) 與係數 2/8，取 y＝w[n]·Y[n]/4，每個 y 加 0.5 後向下取整，輸出一行 16 個整數。';
// holdout：另寫措辭（只量測）
const HO_IMDCT = '反修正離散餘弦（窗長 16、8 個係數）：輸入一行 8 個整數 X[0] 至 X[7]。對 n＝0 至 15 算 Σ X[k]cos(π(2n＋1＋8)(2k＋1)/32)，乘上窗 sin(π(2n＋1)/32) 與 2/8，四捨五入（加 0.5 後取整數部分），輸出一行 16 個整數。';
const genIM = (b, { rnd: rr }) => Array.from({ length: 8 }, () => rr(-50, 50)).join(' ');

const SEEDS = [
    { id: 'imdct-tr', want: 'aud.imdct8', st: ST_IMDCT, ref: REF_IMDCT, gen: genIM },
    { id: 'imdct-ho', split: 'holdout', st: HO_IMDCT, ref: REF_IMDCT, gen: genIM },
    { id: 'mdct-tr', want: 'aud.mdct8q', st: ST, ref: REF, gen },
    { id: 'mdct-ho', split: 'holdout', st: HO, ref: REF, gen },
];

H.main({ name: '領域包 avaudio', packs: [DA], seeds: SEEDS, minSkeletons: 1, judge: { checker: 'tokens', timeoutMs: 60000 } });
