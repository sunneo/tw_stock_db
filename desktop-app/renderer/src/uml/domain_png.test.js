'use strict';
// 領域包「PNG 讀寫」：測資由測試內的 Python 產生器產生（解碼題：隨機影像、每列隨機過濾型別 0～4、夾一個 tEXt 區塊；寫出題：隨機像素）。
// 參考解是另寫的 Python（獨立實作過濾與反過濾、區塊剖析），產生器會斷言參考解還原的像素與原影像一致。
// train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。
const cp = require('child_process');
const H = require('./domain_harness.js'); const { rnd } = H;
const PN = require('./domain_png_core.js');
const PY = process.env.FA_PYTHON || 'python3';
const py = (src) => { const r = cp.spawnSync(PY, ['-I', '-c', src], { encoding: 'utf8', timeout: 30000 }); if (r.status !== 0) throw new Error('python 失敗：' + r.stderr); return r.stdout.trim(); };

// 共用的 Python 片段：過濾、區塊、參考解碼（每個參考解各自內嵌一份，互不依賴）
const PAETH = `def paeth(a, b, c):
    p = a + b - c; pa = abs(p - a); pb = abs(p - b); pc = abs(p - c)
    if pa <= pb and pa <= pc: return a
    if pb <= pc: return b
    return c
`;
const PRED = `def pred(f, a, b, c):
    return {0: 0, 1: a, 2: b, 3: (a + b) // 2, 4: paeth(a, b, c)}[f]
`;

// ---- 解碼題的產生器：隨機影像 → 每列隨機過濾 → PNG 位元組 ----
const GEN_DEC = (ct, seed, big) => `
import random, struct, zlib
random.seed(${seed})
bpp = {0: 1, 2: 3, 4: 2, 6: 4}[${ct}]
w = random.randint(2, ${big ? 16 : 9}); h = random.randint(2, ${big ? 12 : 7})
img = [[random.randrange(256) for _ in range(w * bpp)] for _ in range(h)]
${PAETH}${PRED}
raw = bytearray(); prev = [0] * (w * bpp)
for row in img:
    f = random.randrange(5)
    raw.append(f)
    for i, x in enumerate(row):
        a = row[i - bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i - bpp] if i >= bpp else 0
        raw.append((x - pred(f, a, b, c)) & 255)
    prev = row
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
ih = struct.pack(">IIBBBBB", w, h, 8, ${ct}, 0, 0, 0)
half = len(zlib.compress(bytes(raw))) // 2
z = zlib.compress(bytes(raw))
f = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", ih) + chunk(b"tEXt", b"Comment\\x00test") + chunk(b"IDAT", z[:half]) + chunk(b"IDAT", z[half:]) + chunk(b"IEND", b"")
print(f.hex())
`;
const genDec = (ct) => (b) => py(GEN_DEC(ct, rnd(1, 1e9), b)) + '\n';

// 參考解碼器：依 MODE 輸出每列（px＝每像素十六進位，hex＝整列十六進位，dec＝整列十進位）
const REF_DEC = (mode) => `import sys, struct, zlib
${PAETH}${PRED}
f = bytes.fromhex(sys.stdin.read().strip())
pos = 8; ch = []
while pos + 8 <= len(f):
    n = struct.unpack(">I", f[pos:pos + 4])[0]; t = f[pos + 4:pos + 8]
    ch.append((t, f[pos + 8:pos + 8 + n])); pos += 12 + n
    if t == b"IEND": break
ih = ch[0][1]
w, h = struct.unpack(">II", ih[0:8]); ct = ih[9]
bpp = {0: 1, 2: 3, 4: 2, 6: 4}[ct]
raw = zlib.decompress(b"".join(d for t, d in ch if t == b"IDAT"))
st = w * bpp; prev = [0] * st; p = 0; rows = []
for y in range(h):
    fl = raw[p]; line = raw[p + 1:p + 1 + st]; p += 1 + st
    cur = [0] * st
    for i in range(st):
        a = cur[i - bpp] if i >= bpp else 0
        b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
        cur[i] = (line[i] + pred(fl, a, b, c)) & 255
    rows.append(cur); prev = cur
for r in rows:
    if "${mode}" == "px": print(" ".join(bytes(r[i:i + bpp]).hex() for i in range(0, st, bpp)))
    elif "${mode}" == "hex": print(bytes(r).hex())
    else: print(" ".join(str(v) for v in r))
`;

// ---- 寫出題的產生器與參考解 ----
const GEN_ENC = (c, seed, big) => `
import random
random.seed(${seed})
w = random.randint(2, ${big ? 14 : 6}); h = random.randint(1, ${big ? 10 : 5})
px = bytes(random.randrange(256) for _ in range(w * h * ${c}))
hdr = w.to_bytes(4, "big") + h.to_bytes(4, "big") + bytes([${c}])
print((hdr + px).hex())
`;
const genEnc = (c) => (b) => py(GEN_ENC(c, rnd(1, 1e9), b)) + '\n';
const REF_ENC = `import sys, struct, zlib
f = bytes.fromhex(sys.stdin.read().strip())
w = int.from_bytes(f[0:4], "big"); h = int.from_bytes(f[4:8], "big"); bpp = f[8]
px = f[9:]
st = w * bpp
raw = b"".join(b"\\x00" + px[y * st:(y + 1) * st] for y in range(h))
ct = {1: 0, 3: 2, 4: 6}[bpp]
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
out = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ct, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
print(out.hex())
`;

const SEEDS = [
    { id: 'dec-gray', want: 'png.decode', st: '輸入一行十六進位字串，是一個 8 位元灰階 PNG 檔（色彩型別 0，沒有交錯）。請解壓縮並還原每列像素（每列前面有一個過濾型別位元組，型別 0～4）。每列輸出一行，每個像素是一個兩位元的十六進位，像素之間以空格分隔，由上到下。', ref: REF_DEC('px'), gen: genDec(0) },
    { id: 'dec-rgb', want: 'png.decode', st: '輸入一行十六進位字串，是 8 位元 RGB 的 PNG（色彩型別 2，非交錯，IDAT 可能分成好幾段，其餘區塊要略過）。請解壓並還原像素，由上到下每列輸出一行，內容是整列位元組的十六進位（小寫、不加空白）。', ref: REF_DEC('hex'), gen: genDec(2) },
    { id: 'dec-rgba', want: 'png.decode', st: '輸入一行十六進位字串，是 8 位元 RGBA 的 PNG（色彩型別 6）。請解壓並依過濾型別還原每列，每列輸出一行，列中每個位元組是十進位數字，以空格分隔，由上到下。', ref: REF_DEC('dec'), gen: genDec(6) },
    { id: 'dec-ga', want: 'png.decode', st: '輸入一行十六進位字串，是 8 位元灰階加 alpha 的 PNG（色彩型別 4，每像素 2 個位元組）。請解壓並還原像素，每列輸出一行，每個像素以兩位十六進位輸出（灰階與 alpha 的位元組相連），像素之間以空格分隔，由上到下。', ref: REF_DEC('px'), gen: genDec(4) },
    { id: 'enc-rgb', want: 'png.encode', st: '輸入一行十六進位字串，是一個原始影像封包：前 4 個位元組是寬（大端）、接著 4 個位元組是高（大端）、再 1 個位元組是每像素位元組數（3 表示 RGB），其餘是全部像素的位元組（列由上到下）。請組出 PNG 檔：每列前面加過濾型別 0 的位元組，IDAT 用 zlib 預設壓縮，最後輸出整個檔案的十六進位（小寫、不加空白）。', ref: REF_ENC, gen: genEnc(3) },
    { id: 'enc-gray', want: 'png.encode', st: '輸入一行十六進位字串，是原始影像封包：前 4 個位元組為寬（大端）、其後 4 個位元組為高（大端）、第 9 個位元組為每像素位元組數（1 表示灰階），其餘為像素位元組（列由上到下）。請組出 PNG 檔：每列前置過濾型別 0，IDAT 為 zlib.compress 的預設結果，輸出檔案的十六進位。', ref: REF_ENC, gen: genEnc(1) },
    // holdout：另寫措辭，只量測，不教
    { id: 'ho-dec-rgb', split: 'holdout', st: '給一行十六進位，內容是一張 8 位元 RGB 的 PNG。把它解碼，按列由上到下，每列印出一行，列中每個像素以六位十六進位的 RRGGBB 表示，像素之間以空格隔開。', ref: REF_DEC('px'), gen: genDec(2) },
    { id: 'ho-enc-rgba', split: 'holdout', st: '給一行十六進位，是原始影像封包：開頭 4 個位元組寬、接著 4 個位元組高（都是大端），第 9 個位元組是每像素位元組數（4 表示 RGBA），之後是像素資料。請把它編成 PNG 檔（每列加上過濾型別 0 的位元組，IDAT 用 zlib 預設壓縮），輸出檔案的十六進位。', ref: REF_ENC, gen: genEnc(4) }
];
H.main({ name: '領域包 png', packs: [PN], seeds: SEEDS, minSkeletons: 2, judge: { checker: 'tokens', timeoutMs: 60000 } });
