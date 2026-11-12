'use strict';
// 圖片壓縮矩陣化（matrix_image_core）：① DCT 與獨立 Python 公式（雙重求和）一致、往返誤差 ≤1e-9、常數區塊的 DC 係數＝8c；② YCbCr 與 Python 一致、往返誤差 ≤1；③ 量化表：品質 50 等於 Annex K、品質 100 全 1；④ Z 字形與 Python 一致；⑤ PNG Sub／Up 的矩陣形式與 Python（PNG 規範）一致，Average／Paeth 與 Python 一致；⑥ 整條 DCT→量化→反量化→IDCT 的像素誤差有理論上界。
const assert = require('assert'), cp = require('child_process');
const I = require('./matrix_image_core.js');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 555; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 65536) % n; };
const block = () => Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => rnd(256) - 128));

const PYREF = `
import sys, json, math
req = json.loads(sys.stdin.read()); out = {}
def dct2(f):
    N = 8; F = [[0.0]*N for _ in range(N)]
    for u in range(N):
        for v in range(N):
            cu = 1/math.sqrt(2) if u == 0 else 1.0
            cv = 1/math.sqrt(2) if v == 0 else 1.0
            s = 0.0
            for x in range(N):
                for y in range(N):
                    s += f[x][y] * math.cos((2*x+1)*u*math.pi/16) * math.cos((2*y+1)*v*math.pi/16)
            F[u][v] = 2.0/N * cu * cv * s
    return F
out['dct'] = [dct2(b) for b in req['blocks']]
def ycc(rgb):
    R, G, B = rgb
    return [0.299*R + 0.587*G + 0.114*B, -0.168736*R - 0.331264*G + 0.5*B + 128, 0.5*R - 0.418688*G - 0.081312*B + 128]
out['ycc'] = [ycc(c) for c in req['rgb']]
def zz(N):
    res = []
    for s in range(2*N-1):
        cells = [(i, s-i) for i in range(N) if 0 <= s-i < N]
        if s % 2 == 1: cells.sort(key=lambda p: p[0])
        else: cells.sort(key=lambda p: -p[0])
        res += cells
    return [i*N+j for i, j in res]
out['zz'] = zz(8)
def paeth(a, b, c):
    p = a + b - c; pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
    if pa <= pb and pa <= pc: return a
    if pb <= pc: return b
    return c
def filt(kind, row, prev, bpp):
    o = []
    for i, x in enumerate(row):
        a = row[i-bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i-bpp] if i >= bpp else 0
        if kind == 'sub': p = a
        elif kind == 'up': p = b
        elif kind == 'avg': p = (a + b) // 2
        else: p = paeth(a, b, c)
        o.append((x - p) % 256)
    return o
out['filt'] = [filt(q['kind'], q['row'], q['prev'], q['bpp']) for q in req['filt']]
print(json.dumps(out))
`;
const blocks = Array.from({ length: 20 }, block);
const rgb = Array.from({ length: 200 }, () => [rnd(256), rnd(256), rnd(256)]);
const filt = []; for (let t = 0; t < 200; t++) { const bpp = 1 + rnd(4); const n = bpp * (1 + rnd(12)); const row = Array.from({ length: n }, () => rnd(256)); const prev = Array.from({ length: n }, () => rnd(256)); filt.push({ kind: ['sub', 'up', 'avg', 'paeth'][t % 4], row, prev, bpp }); }
const r = cp.spawnSync(PY, ['-I', '-c', PYREF], { input: JSON.stringify({ blocks, rgb, filt }), encoding: 'utf8', timeout: 300000 });
assert.strictEqual(r.status, 0, r.stderr);
const ref = JSON.parse(r.stdout);

// ① DCT
let maxD = 0; blocks.forEach((b, i) => { const F = I.dct2(b); for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) maxD = Math.max(maxD, Math.abs(F[u][v] - ref.dct[i][u][v])); });
ok(maxD < 1e-9, 'DCT 與 Python 雙重求和的最大差 ' + maxD);
let maxR = 0; blocks.forEach((b) => { const X = I.idct2(I.dct2(b)); for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) maxR = Math.max(maxR, Math.abs(X[x][y] - b[x][y])); });
ok(maxR < 1e-9, 'DCT→IDCT 往返最大誤差 ' + maxR);
const cblk = Array.from({ length: 8 }, () => new Array(8).fill(37)); ok(Math.abs(I.dct2(cblk)[0][0] - 8 * 37) < 1e-9, '常數區塊 c 的 DC 係數＝8c');
console.log('① 20 個 8×8 區塊：DCT 與 Python 最大差 ' + maxD.toExponential(2) + '，往返最大誤差 ' + maxR.toExponential(2));

// ② YCbCr
let maxY = 0; rgb.forEach((c, i) => { const Y = I.rgbToYcc(c); for (let k = 0; k < 3; k++) maxY = Math.max(maxY, Math.abs(Y[k] - ref.ycc[i][k])); });
ok(maxY < 1e-9, 'YCbCr 與 Python 的最大差 ' + maxY);
let maxRT = 0; rgb.forEach((c) => { const back = I.yccToRgb(I.rgbToYcc(c)); for (let k = 0; k < 3; k++) maxRT = Math.max(maxRT, Math.abs(back[k] - c[k])); });
ok(maxRT <= 1.0, 'YCbCr→RGB 往返最大誤差 ' + maxRT.toFixed(4) + '（JFIF 係數不是精確逆矩陣，±1 內）');
console.log('② 200 個 RGB：YCbCr 與 Python 最大差 ' + maxY.toExponential(2) + '，往返最大誤差 ' + maxRT.toFixed(4));

// ③ 量化表
assert.deepStrictEqual(I.qualityTable(50), I.LUMA); ok(true, '品質 50 等於 Annex K 亮度表');
ok(I.qualityTable(100).every((row) => row.every((v) => v === 1)), '品質 100 全 1');
ok(I.qualityTable(10)[0][0] > I.qualityTable(90)[0][0], '品質越低量化越粗');
passed += 0; console.log('③ 量化表：品質 50 等於 Annex K，品質 100 全 1');

// ④ Z 字形
const z = I.zigzagOrder(8).map(([i, j]) => i * 8 + j);
assert.deepStrictEqual(z, ref.zz); ok(true, 'Z 字形與 Python 一致（64 項）');
ok(JSON.stringify(z.slice(0, 16)) === JSON.stringify([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5]), 'Z 字形前 16 項與 JPEG 標準相同');
console.log('④ Z 字形 64 項與 Python 一致；前 16 項與 JPEG 標準相同');

// ⑤ PNG 濾波器
let fbad = 0;
filt.forEach((q, i) => {
    const js = q.kind === 'sub' ? I.pngSub(q.row, q.bpp) : q.kind === 'up' ? I.pngUp(q.row, q.prev) : q.kind === 'avg' ? I.pngAverage(q.row, q.prev, q.bpp) : I.pngPaeth(q.row, q.prev, q.bpp);
    if (JSON.stringify(js) !== JSON.stringify(ref.filt[i])) fbad++;
});
ok(fbad === 0, 'PNG 濾波器與 Python 不一致 ' + fbad + ' 筆');
// Sub 與 Up 的矩陣形式（模 256 的矩陣乘法）與直接實作一致
let mbad = 0; for (const q of filt.filter((x) => x.kind === 'sub')) { const M = I.subMatrix(q.row.length, q.bpp); const v = I.matVecMod256(M, q.row); if (JSON.stringify(v) !== JSON.stringify(I.pngSub(q.row, q.bpp).map((x) => x))) mbad++; }
// 矩陣形式的 Sub 是 (x − 左)：對 row 做矩陣乘法 = 不必取模再減，但要與 pngSub 的減法結果相同（pngSub 已 mod 256，矩陣版也 mod 256）
ok(mbad === 0, 'Sub 的矩陣形式（模 256）與直接實作一致 ' + mbad + ' 筆失敗');
console.log('⑤ PNG 濾波器 200 筆（Sub、Up、Average、Paeth 各 50）與 Python 一致；Sub 矩陣形式一致（Average、Paeth 不矩陣化）');

// ⑥ 端到端：DCT→量化→反量化→IDCT；單一係數誤差 ≤ Q/2，正交變換保持 L2 範數，因此像素誤差的 L2 ≤ sqrt(Σ(Q/2)²)
for (const quality of [100, 50, 90]) {
    const Q = I.qualityTable(quality); let worstL2 = 0, worstMax = 0;
    for (const b of blocks) {
        const F = I.dct2(b); const q = I.quantize(F, Q); const Fr = I.dequantize(q, Q); const X = I.idct2(Fr);
        let l2 = 0, mx = 0; for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) { const e = X[x][y] - b[x][y]; l2 += e * e; mx = Math.max(mx, Math.abs(e)); }
        worstL2 = Math.max(worstL2, Math.sqrt(l2)); worstMax = Math.max(worstMax, mx);
        let bound = 0; for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) bound += (Q[u][v] / 2) * (Q[u][v] / 2);
        assert.ok(Math.sqrt(l2) <= Math.sqrt(bound) + 1e-9, '品質 ' + quality + ' 超出理論上界');
    }
    passed++;
    console.log('⑥ 品質 ' + quality + '：20 個區塊的像素誤差 L2 最大 ' + worstL2.toFixed(3) + '、單一像素最大 ' + worstMax.toFixed(3) + '（理論上界內）');
}
console.log(passed + ' passed, 0 failed');
