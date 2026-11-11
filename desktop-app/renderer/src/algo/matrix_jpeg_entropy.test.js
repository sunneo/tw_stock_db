'use strict';
// JPEG 熵編碼（matrix_jpeg_entropy_core）：① 隨機稀疏區塊往返（500 組）；② 標準 DC／AC 亮度表與 libjpeg（PIL）輸出的 DHT 逐一相同；③ 我們寫的檔案交給 PIL（libjpeg）解碼，像素與我們的反量化＋IDCT 重建差 ≤2；④ libjpeg 寫的檔案（PIL 生成），用我們的解碼器讀掃描，像素與 PIL 解碼結果差 ≤2。
const assert = require('assert'), cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const J = require('./matrix_jpeg_entropy_core.js'); const I = require('./matrix_image_core.js');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 77; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 65536) % n; };
const ZZ = I.zigzagOrder(8).map(([i, j]) => i * 8 + j);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpegent-'));

// ① 往返
let bad = 0;
for (let t = 0; t < 500; t++) {
    const blocks = [];
    for (let b = 0; b < 8; b++) {
        const blk = new Array(64).fill(0); blk[0] = rnd(2048) - 1024;
        const nz = rnd(12); for (let i = 0; i < nz; i++) blk[1 + rnd(63)] = rnd(3) === 0 ? rnd(2000) - 1000 : rnd(9) - 4;
        if (rnd(4) === 0) blk[1 + rnd(20)] = 0; if (rnd(5) === 0) blk[63] = rnd(5) - 2;
        blocks.push(blk);
    }
    if (t % 10 === 0) { blocks[0][40] = 3; blocks[0][1] = 0; }
    if (JSON.stringify(J.decodeScan(J.encodeScan(blocks), blocks.length)) !== JSON.stringify(blocks)) bad++;
}
ok(bad === 0, '往返失敗 ' + bad + ' 組');
console.log('① 500 組隨機稀疏區塊（含 ZRL、大值、DC 差分）編碼→解碼往返一致');

// 共用：寫一個灰階基線 JPEG 檔（SOI、DQT、SOF0、DHT×2、SOS、掃描、EOI）
function writeJpeg(file, w, h, Q, scanBytes) {
    const seg = (m, payload) => Buffer.concat([Buffer.from([0xFF, m, (payload.length + 2) >> 8, (payload.length + 2) & 255]), Buffer.from(payload)]);
    const dqt = [0x00, ...ZZ.map((n) => Q[Math.floor(n / 8)][n % 8])];
    const sof = [8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0];
    const dht = [0x00, ...J.DC_LUMA.bits, ...J.DC_LUMA.vals, 0x10, ...J.AC_LUMA.bits, ...J.AC_LUMA.vals];
    const sos = [1, 1, 0x00, 0, 63, 0];
    const bufs = [Buffer.from([0xFF, 0xD8]), seg(0xDB, dqt), seg(0xC0, sof), seg(0xC4, dht), seg(0xDA, sos), Buffer.from(scanBytes), Buffer.from([0xFF, 0xD9])];
    fs.writeFileSync(file, Buffer.concat(bufs));
}
// 像素重建：區塊（Z 字形係數）→ 反量化 → IDCT → +128 → 夾在 0..255 → 四捨五入
function reconstruct(blocks, w, h, Q) {
    const px = Array.from({ length: h }, () => new Array(w).fill(0)); const bw = w / 8;
    blocks.forEach((blk, b) => {
        const F = Array.from({ length: 8 }, () => new Array(8).fill(0));
        for (let k = 0; k < 64; k++) { const n = ZZ[k]; F[Math.floor(n / 8)][n % 8] = blk[k] * Q[Math.floor(n / 8)][n % 8]; }
        const X = I.idct2(F); const by = Math.floor(b / bw), bx = b % bw;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[by * 8 + y][bx * 8 + x] = Math.min(255, Math.max(0, Math.round(X[y][x] + 128)));
    });
    return px;
}
const PYREF = `
import sys, json
from PIL import Image
req = json.loads(sys.stdin.read()); out = {}
if req.get('make'):
    im = Image.new('L', (16, 16), 128); px = im.load()
    for x in range(16):
        for y in range(16): px[x, y] = (x * 16 + y * 3) % 256
    im.save(req['make'], quality=75, optimize=False)
for key in ('decode',):
    for p in req.get(key, []):
        im = Image.open(p); im.load(); out[p] = [list(im.getdata())[r*im.size[0]:(r+1)*im.size[0]] for r in range(im.size[1])]
# 標準表：從 libjpeg 的 DHT 讀
data = open(req['make'] if req.get('make') else req['decode'][0], 'rb').read()
tabs = []; i = 2
while i < len(data) and data[i+1] != 0xDA:
    if data[i] != 0xFF: i += 1; continue
    m = data[i+1]; L = (data[i+2] << 8) | data[i+3]
    if m == 0xC4:
        j = i + 4; end = i + 2 + L
        while j < end:
            tc = data[j]; bits = list(data[j+1:j+17]); n = sum(bits); vals = list(data[j+17:j+17+n]); tabs.append({'tc': tc, 'bits': bits, 'vals': vals}); j += 17 + n
    i += 2 + L
out['tables'] = tabs
print(json.dumps(out))
`;
function py(input) { const r = cp.spawnSync(PY, ['-I', '-c', PYREF], { input: JSON.stringify(input), encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 }); assert.strictEqual(r.status, 0, r.stderr); return JSON.parse(r.stdout); }

// ② 標準表與 libjpeg 一致；同時產生 libjpeg 的參照檔
const refJpg = path.join(tmp, 'ref.jpg');
const r0 = py({ make: refJpg, decode: [refJpg] });
const dcRef = r0.tables.find((t) => t.tc === 0x00), acRef = r0.tables.find((t) => t.tc === 0x10);
ok(JSON.stringify(dcRef.bits) === JSON.stringify(J.DC_LUMA.bits) && JSON.stringify(dcRef.vals) === JSON.stringify(J.DC_LUMA.vals), 'DC 亮度表與 libjpeg 相同');
ok(JSON.stringify(acRef.bits) === JSON.stringify(J.AC_LUMA.bits) && JSON.stringify(acRef.vals) === JSON.stringify(J.AC_LUMA.vals), 'AC 亮度表與 libjpeg 相同');
console.log('② DC（12 符號）與 AC（162 符號）標準亮度表與 libjpeg 的 DHT 逐一相同');

// ③ 我們寫的檔案 → PIL 解碼 → 與我們的重建比對
const W = 64, H = 64, Q = I.qualityTable(75); const nb = (W / 8) * (H / 8);
const coefBlocks = Array.from({ length: nb }, () => { const b = new Array(64).fill(0); b[0] = rnd(17) - 8; const nz = rnd(6); for (let i = 0; i < nz; i++) b[1 + rnd(20)] = rnd(7) - 3; return b; });
const ours = path.join(tmp, 'ours.jpg');
writeJpeg(ours, W, H, Q, J.encodeScan(coefBlocks));
const r3 = py({ decode: [ours] });
const pilPx = r3[ours]; const mine = reconstruct(coefBlocks, W, H, Q);
let maxA = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) maxA = Math.max(maxA, Math.abs(pilPx[y][x] - mine[y][x]));
ok(maxA <= 2, '我們的檔案經 PIL 解碼，與我們的重建最大差 ' + maxA);
console.log('③ 我們寫的 64×64 檔案經 libjpeg（PIL）解碼，與我們的反量化＋IDCT 重建最大差 ' + maxA + '（要 ≤2）');

// ④ libjpeg 寫的 16×16 參照檔 → 我們的解碼器讀掃描 → 與 PIL 解碼結果比對
const bytes = new Uint8Array(fs.readFileSync(refJpg));
let p = 2, qt = null, sosAt = -1, w4 = 0, h4 = 0;
while (p < bytes.length) {
    if (bytes[p] !== 0xFF) { p++; continue; }
    const m = bytes[p + 1]; const L = (bytes[p + 2] << 8) | bytes[p + 3];
    if (m === 0xDB) qt = Array.from(bytes.slice(p + 5, p + 2 + L)); // 8 位元 Pq=0，Tq=0
    if (m === 0xC0) { h4 = (bytes[p + 5] << 8) | bytes[p + 6]; w4 = (bytes[p + 7] << 8) | bytes[p + 8]; }
    if (m === 0xDA) { sosAt = p + 2 + L; break; }
    p += 2 + L;
}
assert.ok(sosAt > 0 && qt && qt.length === 64, '解析參照檔失敗');
const Q4 = Array.from({ length: 8 }, () => new Array(8).fill(0)); ZZ.forEach((n, k) => { Q4[Math.floor(n / 8)][n % 8] = qt[k]; });
const blocks4 = J.decodeScan(bytes.slice(sosAt), (w4 / 8) * (h4 / 8));
const mine4 = reconstruct(blocks4, w4, h4, Q4);
const pil4 = r0[refJpg];
let maxB = 0; for (let y = 0; y < h4; y++) for (let x = 0; x < w4; x++) maxB = Math.max(maxB, Math.abs(pil4[y][x] - mine4[y][x]));
ok(maxB <= 2, 'libjpeg 掃描經我們解碼，與 PIL 像素最大差 ' + maxB);
console.log('④ libjpeg 寫的 16×16 掃描經我們的解碼器，與 PIL 像素最大差 ' + maxB + '（要 ≤2）');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(passed + ' passed, 0 failed');
