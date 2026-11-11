'use strict';
// 領域包「JPEG 讀寫」（灰階、基線、標準表）。測資：解碼題由 Pillow 寫出（quality 隨機 50 或 80，寬高不是 8 的倍數）；寫出題由 Python 產生平滑梯度加雜訊的封包。
// 參考解是另寫的 Python：之字形用規格的標準表（骨架用 sorted 公式產生，兩者必須相同），霍夫曼解碼與編碼用不同的寫法（位元字串游標、符號對照表）。
// 整數 IDCT／FDCT 的公式與骨架相同（2^12 餘弦表），所以骨架與參考解的輸出可逐位元比對。
// Pillow 外部驗證（python3 的 Pillow 9.0.1）：(a) Pillow 寫出的 JPEG，參考解碼器結果與 Pillow 解碼相差 ≤ 2（libjpeg 用整數 islow IDCT，有 ±1～2 的差）；
//   (b) 參考編碼器的輸出，Pillow 必須能開，且與參考解碼器的結果相差 ≤ 2。
// train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。
const cp = require('child_process');
const H = require('./domain_harness.js'); const { rnd } = H;
const JC = require('./domain_jpeg_core.js');
const PY = process.env.FA_PYTHON || 'python3';
const py = (src, input) => { const r = cp.spawnSync(PY, ['-I', '-c', src], { input: input || '', encoding: 'utf8', timeout: 120000 }); if (r.status !== 0) throw new Error('python 失敗：' + r.stderr); return r.stdout.trim(); };

// 標準表（與骨架共用同一份來源：domain_jpeg_core.js 的 JPG_TABLES，由 Pillow 寫出的檔抽取）
const T = JC.TABLES;
const PYL = (v) => JSON.stringify(v);
const TBL_PY = `QZ = ${PYL(T.Q)}\nDCB = ${PYL(T.DC_BITS)}\nDCV = ${PYL(T.DC_VALS)}\nACB = ${PYL(T.AC_BITS)}\nACV = ${PYL(T.AC_VALS)}\n`;

// ---- 解碼題的產生器：Pillow 寫出灰階 JPEG（quality 隨機 50 或 80，optimize 關閉）----
const GEN_DEC = (seed, big) => `
import io, random
from PIL import Image
random.seed(${seed})
w = random.randint(1, ${big ? 40 : 20}); h = random.randint(1, ${big ? 30 : 12})
q = random.choice([50, 80])
px = bytes(random.randrange(256) for _ in range(w * h))
im = Image.frombytes("L", (w, h), px); buf = io.BytesIO(); im.save(buf, "JPEG", quality=q, optimize=False)
print(buf.getvalue().hex())
`;
const genDec = (b) => py(GEN_DEC(rnd(1, 1e9), b)) + '\n';

// ---- 參考解碼器（獨立寫法）：MODE 為 dec（每列十進位，空格分隔）或 hex（每列十六進位）----
const REF_DEC = (mode) => `import sys, math
data = bytes.fromhex(sys.stdin.read().strip())
ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]
def cu(u): return math.sqrt(0.5) if u == 0 else 1.0
TB = [[round(4096 * cu(u) * math.cos((2 * x + 1) * u * math.pi / 16)) for x in range(8)] for u in range(8)]
pos = 2; qt = None; tabs = {}; HH = WW = 0
while True:
    mk = data[pos + 1]; ln = data[pos + 2] * 256 + data[pos + 3]; seg = data[pos + 4:pos + 2 + ln]
    if mk == 0xDB:
        qt = list(seg[1:65])
    elif mk == 0xC4:
        j = 0
        while j < len(seg):
            cls = seg[j]; cnt = list(seg[j + 1:j + 17]); n = sum(cnt)
            tabs[cls] = (cnt, list(seg[j + 17:j + 17 + n])); j += 17 + n
    elif mk == 0xC0:
        HH = seg[1] * 256 + seg[2]; WW = seg[3] * 256 + seg[4]
    elif mk == 0xDA:
        pos += 2 + ln; break
    pos += 2 + ln
def lookup(cnt, syms):
    t = {}; code = 0; k = 0
    for L in range(1, 17):
        for _ in range(cnt[L - 1]):
            t[(L, code)] = syms[k]; code += 1; k += 1
        code <<= 1
    return t
dct = lookup(*tabs[0]); act = lookup(*tabs[16])
ent = bytearray(); j = pos
while True:
    b = data[j]
    if b == 0xFF:
        if data[j + 1] == 0:
            ent.append(0xFF); j += 2; continue
        break
    ent.append(b); j += 1
bitstr = "".join(format(b, "08b") for b in ent)
cur = [0]
def take(n):
    v = int(bitstr[cur[0]:cur[0] + n], 2) if n else 0
    cur[0] += n
    return v
def sym(t):
    code = 0
    for L in range(1, 17):
        code = (code << 1) | take(1)
        if (L, code) in t: return t[(L, code)]
    raise ValueError("code")
def extend(v, n):
    if n == 0: return 0
    return v if v >= (1 << (n - 1)) else v - ((1 << n) - 1)
BW = (WW + 7) // 8; BH = (HH + 7) // 8
image = [[0] * (BW * 8) for _ in range(BH * 8)]
pred = 0
for by in range(BH):
    for bx in range(BW):
        s = sym(dct); pred += extend(take(s), s)
        coef = [0] * 64; coef[0] = pred; k = 1
        while k < 64:
            rs = sym(act); r, s = rs >> 4, rs & 15
            if s == 0:
                if r == 15:
                    k += 16; continue
                break
            k += r
            coef[k] = extend(take(s), s); k += 1
        nat = [0] * 64
        for k in range(64): nat[ZZ[k]] = coef[k] * qt[k]
        for y in range(8):
            for x in range(8):
                S = 0
                for v in range(8):
                    for u in range(8):
                        S += nat[v * 8 + u] * TB[v][y] * TB[u][x]
                val = ((S + (1 << 25)) >> 26) + 128
                image[by * 8 + y][bx * 8 + x] = min(255, max(0, val))
for y in range(HH):
    row = image[y][:WW]
    if "${mode}" == "dec": print(" ".join(str(v) for v in row))
    else: print(bytes(row).hex())
`;

// ---- 寫出題的產生器與參考編碼器 ----
const GEN_ENC = (seed, big) => `
import random
random.seed(${seed})
w = random.randint(1, ${big ? 40 : 20}); h = random.randint(1, ${big ? 30 : 12})
px = bytes(max(0, min(255, 4 * x + 3 * y + random.randrange(40) - 20 + 40)) for y in range(h) for x in range(w))
print((w.to_bytes(2, "big") + h.to_bytes(2, "big") + px).hex())
`;
const genEnc = (b) => py(GEN_ENC(rnd(1, 1e9), b)) + '\n';
const REF_ENC = `import sys, math
${TBL_PY}
d = bytes.fromhex(sys.stdin.read().strip())
W = int.from_bytes(d[0:2], "big"); HH = int.from_bytes(d[2:4], "big")
px = d[4:4 + W * HH]
ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]
def cu(u): return math.sqrt(0.5) if u == 0 else 1.0
TB = [[round(4096 * cu(u) * math.cos((2 * x + 1) * u * math.pi / 16)) for x in range(8)] for u in range(8)]
def codes(cnt, syms):
    m = {}; code = 0; k = 0
    for L in range(1, 17):
        for _ in range(cnt[L - 1]):
            m[syms[k]] = format(code, "0%db" % L); code += 1; k += 1
        code <<= 1
    return m
DC = codes(DCB, DCV); AC = codes(ACB, ACV)
def mag(v): return abs(v).bit_length()
def bits_of(v, s): return format(v if v >= 0 else v + (1 << s) - 1, "0%db" % s) if s else ""
blocks = []
BW = (W + 7) // 8; BH = (HH + 7) // 8
for by in range(BH):
    for bx in range(BW):
        blk = [[px[min(by * 8 + y, HH - 1) * W + min(bx * 8 + x, W - 1)] - 128 for x in range(8)] for y in range(8)]
        F = []
        for v in range(8):
            for u in range(8):
                S = 0
                for y in range(8):
                    for x in range(8):
                        S += blk[y][x] * TB[v][y] * TB[u][x]
                F.append((S + (1 << 25)) >> 26)
        C = [0] * 64
        for k in range(64):
            val = F[ZZ[k]]; q = QZ[k]
            m = (abs(val) + q // 2) // q
            C[k] = m if val >= 0 else -m
        blocks.append(C)
out_bits = []; pred = 0
for C in blocks:
    diff = C[0] - pred; pred = C[0]
    s = mag(diff)
    out_bits.append(DC[s] + bits_of(diff, s))
    run = 0
    for k in range(1, 64):
        if C[k] == 0:
            run += 1; continue
        while run >= 16:
            out_bits.append(AC[0xF0]); run -= 16
        s = mag(C[k])
        out_bits.append(AC[(run << 4) | s] + bits_of(C[k], s))
        run = 0
    if run > 0: out_bits.append(AC[0])
bitstr = "".join(out_bits)
bitstr += "1" * (-len(bitstr) % 8)
ent = bytearray()
for i in range(0, len(bitstr), 8):
    b = int(bitstr[i:i + 8], 2); ent.append(b)
    if b == 255: ent.append(0)
def seg(m, dat): return bytes([255, m]) + (len(dat) + 2).to_bytes(2, "big") + dat
jf = bytes([255, 216]) + seg(219, bytes([0]) + bytes(QZ))
jf += seg(192, bytes([8]) + HH.to_bytes(2, "big") + W.to_bytes(2, "big") + bytes([1, 1, 17, 0]))
jf += seg(196, bytes([0]) + bytes(DCB) + bytes(DCV)) + seg(196, bytes([16]) + bytes(ACB) + bytes(ACV))
jf += seg(218, bytes([1, 1, 0, 0, 63, 0])) + bytes(ent) + bytes([255, 217])
print(jf.hex())
`;

const SEEDS = [
    { id: 'dec-dec', want: 'jpeg.decode', st: '輸入一行十六進位字串，是 JPEG 檔（灰階、基線，只有一張影像，使用霍夫曼表）。解碼後每列輸出一行，列中的灰階值以十進位表示，數字之間以空格分隔，由上到下。', ref: REF_DEC('dec'), gen: genDec },
    { id: 'dec-hex', want: 'jpeg.decode', st: '輸入一行十六進位字串，是 JPEG 檔（灰階，基線，使用霍夫曼表）。解碼後每列輸出一行，內容是整列灰階值的十六進位（小寫、不加空白），由上到下。', ref: REF_DEC('hex'), gen: genDec },
    { id: 'dec-big', want: 'jpeg.decode', st: '輸入一行十六進位字串，是灰階基線 JPEG 檔（寬高可能不是 8 的倍數）。解碼後每列輸出一行，數字以十進位表示並以空格分隔，由上到下。', ref: REF_DEC('dec'), gen: (b) => genDec(true) },
    { id: 'enc-gray', want: 'jpeg.encode', st: '輸入一行十六進位字串，是原始影像封包：前 2 個位元組是寬（大端）、接著 2 個位元組是高（大端），其餘是灰階像素（每個 1 位元組，列由上到下）。請編成 JPEG 檔（灰階、基線，量化表用 quality 50 的標準亮度表，霍夫曼用標準表），輸出檔案的十六進位。', ref: REF_ENC, gen: genEnc },
    { id: 'enc-big', want: 'jpeg.encode', st: '輸入一行十六進位字串，是原始封包（寬、高各 2 位元組大端，其後是灰階像素，列由上到下）。請編成灰階 JPEG 檔並輸出十六進位，寬高不是 8 的倍數時邊界要補齊。', ref: REF_ENC, gen: (b) => py(GEN_ENC(rnd(1, 1e9), true)) + '\n' },
    // holdout：另寫措辭，只量測，不教
    { id: 'ho-jpg-dec', split: 'holdout', st: '給一行十六進位，內容是一張灰階 JPEG 圖。把它還原成每列的像素值，每列印一行，數字用空格隔開。', ref: REF_DEC('dec'), gen: genDec },
    { id: 'ho-jpg-enc', split: 'holdout', st: '給一行十六進位，是原始封包：開頭 2 位元組寬、接著 2 位元組高（都是大端），之後是灰階像素。請把它做成 JPEG 檔並輸出十六進位。', ref: REF_ENC, gen: genEnc }
];

// Pillow 外部驗證
const PILLOW_CHECK = `
import io, json, sys
from PIL import Image
cases = json.loads(sys.stdin.read())
ok = 0; worst = 0
for c in cases:
    im = Image.open(io.BytesIO(bytes.fromhex(c["jpg"]))); im.load()
    got = list(im.getdata())
    want = c["want"]
    diff = max(abs(a - b) for a, b in zip(got, want)) if len(got) == len(want) else 999
    worst = max(worst, diff)
    ok += 1 if diff <= 2 else 0
print(ok, len(cases), worst)
`;
const PILLOW_WRITE = `
import io, json, random
from PIL import Image
random.seed(${20261114})
out = []
for t in range(10):
    w = random.randint(1, 30); h = random.randint(1, 20); q = [50, 80][t % 2]
    px = bytes(random.randrange(256) for _ in range(w * h))
    im = Image.frombytes("L", (w, h), px); buf = io.BytesIO(); im.save(buf, "JPEG", quality=q, optimize=False)
    out.append({"w": w, "h": h, "jpg": buf.getvalue().hex()})
print(json.dumps(out))
`;
function pillowCheck() {
    // (a) Pillow 寫出 → 參考解碼器（dec）與 Pillow 解碼比對（容許 ±2）
    const pw = JSON.parse(py(PILLOW_WRITE));
    const decPairs = pw.map((c) => {
        const mine = py(REF_DEC('dec'), c.jpg).split('\n').flatMap((r) => r.trim().split(' ').filter(Boolean).map(Number));
        return { jpg: c.jpg, want: mine };
    });
    // 注意：PILLOW_CHECK 的 want 是參考解碼器結果；判定的是 Pillow 的解碼與參考解碼器相差 ≤ 2
    const resA = py(PILLOW_CHECK, JSON.stringify(decPairs));
    // (b) 參考編碼器輸出 → Pillow 開啟並與參考解碼器（dec）相差 ≤ 2
    const enc = JSON.parse(py(`
import random, json
random.seed(${20261115})
out = []
for t in range(8):
    w = random.randint(1, 30); h = random.randint(1, 20)
    px = bytes(max(0, min(255, 4 * x + 3 * y + random.randrange(40) - 20 + 40)) for y in range(h) for x in range(w))
    out.append((w.to_bytes(2, "big") + h.to_bytes(2, "big") + px).hex())
print(json.dumps(out))
`)).map((pk) => {
        const jpg = py(REF_ENC, pk);
        const want = py(REF_DEC('dec'), jpg).split('\n').flatMap((r) => r.trim().split(' ').filter(Boolean).map(Number));
        return { jpg, want };
    });
    const resB = py(PILLOW_CHECK, JSON.stringify(enc));
    console.log('Pillow 外部驗證 (a) Pillow 寫出、參考解碼器 vs Pillow 解碼（±2 內）：' + resA + '（格式：通過數 總數 最大差）');
    console.log('Pillow 外部驗證 (b) 參考編碼器寫出、Pillow 解碼 vs 參考解碼器（±2 內）：' + resB);
    const [a1, a2] = resA.split(' ').map(Number), [b1, b2] = resB.split(' ').map(Number);
    if (a1 !== a2 || b1 !== b2) throw new Error('Pillow 外部驗證未全過');
}
pillowCheck();
H.main({ name: '領域包 jpeg', packs: [JC], seeds: SEEDS, minSkeletons: 2, judge: { checker: 'tokens', timeoutMs: 120000 } });
