'use strict';
// 領域包「BMP 進階讀取」：測資由測試內的 Python 產生器依「已知影像」編碼成 RLE8／RLE4／遮罩格式的 BMP（含編碼模式、絕對模式、位移跳脫），
// 參考解是另寫的解碼器，且產生器會斷言參考解的輸出與已知影像一致（所以參考解本身有獨立驗證）。
// train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。
const cp = require('child_process');
const H = require('./domain_harness.js'); const { rnd } = H;
const BX = require('./domain_bmpx_core.js');
const PY = process.env.FA_PYTHON || 'python3';
const py = (src) => { const r = cp.spawnSync(PY, ['-I', '-c', src], { encoding: 'utf8', timeout: 30000 }); if (r.status !== 0) throw new Error('python 失敗：' + r.stderr); return r.stdout.trim(); };

// ---- RLE ----
const GEN_RLE = (bits, big, seed, delta) => `
import random, struct
random.seed(${seed})
bits = ${bits}
w = random.randint(${big ? '20, 60' : '5, 24'}); h = random.randint(${big ? '8, 20' : '3, 8'})
nc = random.randint(3, 16 if bits == 4 else 40)
pal = [tuple(random.randrange(256) for _ in range(3)) for _ in range(nc)]
img = []   # 儲存順序（第 0 列是影像最下面）
data = bytearray()
for y in range(h):
    row = []; pos = 0
    if ${delta ? 'True' : 'False'} and y > 0 and random.random() < 0.4 and w > 4:
        k = random.randint(1, w - 3); data += bytes([0, 2, k, 0]); row = [0] * k; pos = k
    while pos < w:
        left = w - pos; t = random.random()
        if t < 0.55 or left < 3:
            n = random.randint(1, min(left, 50))
            if bits == 8:
                v = random.randrange(nc); data += bytes([n, v]); row += [v] * n
            else:
                a, b = random.randrange(nc), random.randrange(nc); data += bytes([n, (a << 4) | b]); row += [a if i % 2 == 0 else b for i in range(n)]
        else:
            n = random.randint(3, min(left, 30)); vs = [random.randrange(nc) for _ in range(n)]
            if bits == 8:
                data += bytes([0, n]) + bytes(vs)
                if n % 2: data += b"\\x00"
            else:
                bs = bytearray()
                for i in range(0, n, 2): bs.append((vs[i] << 4) | (vs[i + 1] if i + 1 < n else 0))
                data += bytes([0, n]) + bs
                if len(bs) % 2: data += b"\\x00"
            row += vs
        pos += len(row) - pos if False else 0
        pos = len(row)
    img.append(row)
    data += bytes([0, 1]) if y == h - 1 else bytes([0, 0])
off = 14 + 40 + 4 * nc
hdr = b"BM" + struct.pack("<IHHI", off + len(data), 0, 0, off) + struct.pack("<IiiHHIIiiII", 40, w, h, 1, bits, 1 if bits == 8 else 2, len(data), 2835, 2835, nc, nc)
pl = b"".join(bytes([b, g, r, 0]) for r, g, b in pal)
f = hdr + pl + bytes(data)
# 另寫的參考解碼器（逐位元組走流），並斷言與已知影像一致
def refdec(f):
    off = int.from_bytes(f[10:14], "little"); w = int.from_bytes(f[18:22], "little"); h = int.from_bytes(f[22:26], "little")
    c = int.from_bytes(f[30:34], "little"); out = [[0] * w for _ in range(h)]; x = y = 0; p = off
    while True:
        a, b = f[p], f[p + 1]; p += 2
        if a:
            for i in range(a):
                out[y][x + i] = b if c == 1 else ((b >> 4) if i % 2 == 0 else b & 15)
            x += a
        elif b == 0: x = 0; y += 1
        elif b == 1: return out
        elif b == 2: x += f[p]; y += f[p + 1]; p += 2
        else:
            ln = b if c == 1 else (b + 1) // 2
            for i in range(b):
                out[y][x + i] = f[p + i] if c == 1 else ((f[p + i // 2] >> 4) if i % 2 == 0 else f[p + i // 2] & 15)
            x += b; p += ln + (ln % 2)
assert refdec(f) == img
print(f.hex())
`;
const genRle = (bits, delta) => (b) => py(GEN_RLE(bits, b, rnd(1, 1e9), delta)) + '\n';
const REF_RLE = (mode, order) => `import sys
f = bytes.fromhex(sys.stdin.read().strip())
off = int.from_bytes(f[10:14], "little"); w = int.from_bytes(f[18:22], "little"); h = int.from_bytes(f[22:26], "little"); c = int.from_bytes(f[30:34], "little")
nc = int.from_bytes(f[46:50], "little") or (1 << int.from_bytes(f[28:30], "little"))
pal = [tuple(f[54 + 4 * i + 2 - j] for j in range(3)) for i in range(nc)]
out = [[0] * w for _ in range(h)]; x = y = 0; p = off
while True:
    a, b = f[p], f[p + 1]; p += 2
    if a:
        for i in range(a):
            out[y][x + i] = b if c == 1 else ((b >> 4) if i % 2 == 0 else b & 15)
        x += a
    elif b == 0: x = 0; y += 1
    elif b == 1: break
    elif b == 2: x += f[p]; y += f[p + 1]; p += 2
    else:
        ln = b if c == 1 else (b + 1) // 2
        for i in range(b):
            out[y][x + i] = f[p + i] if c == 1 else ((f[p + i // 2] >> 4) if i % 2 == 0 else f[p + i // 2] & 15)
        x += b; p += ln + (ln % 2)
rows = out[::-1] if ${JSON.stringify(order)} == "top" else out
for r in rows:
    print(*[("%02x%02x%02x" % pal[k]) if ${JSON.stringify(mode)} == "rgb" else k for k in r])
`;

// ---- 遮罩 ----
// 格式：[bpp, comp, R, G, B, A, 標頭大小]
const FORMATS = {
    argb8888: [32, 0, 0xFF0000, 0xFF00, 0xFF, 0, 40], rgba_bf: [32, 3, 0xFF, 0xFF00, 0xFF0000, 0xFF000000, 56], r10: [32, 3, 0x3FF00000, 0xFFC00, 0x3FF, 0xC0000000, 108],
    rgb565: [16, 3, 0xF800, 0x7E0, 0x1F, 0, 40], rgb555: [16, 0, 0x7C00, 0x3E0, 0x1F, 0, 40], argb4444: [16, 3, 0x0F00, 0x00F0, 0x000F, 0xF000, 108], bgr_bf: [32, 3, 0xFF000000, 0xFF0000, 0xFF00, 0, 40]
};
const GEN_BF = (fmt, big, seed, neg) => `
import random, struct
random.seed(${seed})
bpp, comp, mr, mg, mb, ma, hs = ${JSON.stringify(FORMATS[fmt])}
w = random.randint(${big ? '6, 30' : '2, 9'}); h = random.randint(${big ? '4, 12' : '2, 5'})
def sh(m): return (m & -m).bit_length() - 1
rows = []
for y in range(h):
    r = bytearray()
    for x in range(w):
        px = 0
        for m in (mr, mg, mb, ma):
            if m: px |= (random.randint(0, m >> sh(m)) << sh(m))
        r += px.to_bytes(bpp // 8, "little")
    r += bytes((-len(r)) % 4)
    rows.append(bytes(r))
data = b"".join(rows[::-1] if not ${neg ? 'True' : 'False'} else rows)
extra = b""
if comp == 3 and hs == 40: extra = struct.pack("<III", mr, mg, mb)
info = struct.pack("<IiiHHIIiiII", hs, w, -h if ${neg ? 'True' : 'False'} else h, 1, bpp, comp, len(data), 2835, 2835, 0, 0)
if hs == 56: info += struct.pack("<IIII", mr, mg, mb, ma)
elif hs == 108: info += struct.pack("<IIII", mr, mg, mb, ma) + bytes(108 - 40 - 16)
elif hs == 40: info += extra
if hs == 56: pass
off = 14 + len(info)
print((b"BM" + struct.pack("<IHHI", off + len(data), 0, 0, off) + info + data).hex())
`;
const genBf = (fmt, neg) => (b) => py(GEN_BF(fmt, b, rnd(1, 1e9), neg)) + '\n';
// 參考解：另寫（以通道清單處理）；scale＝floor|round；fmt＝hex|dec|argb
const REF_BF = (scale, fmt) => `import sys
f = bytes.fromhex(sys.stdin.read().strip())
I = lambda a, n, s=False: int.from_bytes(f[a:a + n], "little", signed=s)
off, hs, w, h, bpp, comp = I(10, 4), I(14, 4), I(18, 4, True), I(22, 4, True), I(28, 2), I(30, 4)
if comp == 3: ms = [I(54, 4), I(58, 4), I(62, 4), I(66, 4) if hs >= 56 else 0]
elif bpp == 32: ms = [0xFF0000, 0xFF00, 0xFF, 0]
else: ms = [0x7C00, 0x3E0, 0x1F, 0]
def ch(px, m, dflt):
    if not m: return dflt
    s = 0
    while not (m >> s) & 1: s += 1
    mx = m >> s; v = (px & m) >> s
    return v * 255 // mx if ${JSON.stringify(scale)} == "floor" else int(v * 255 / mx + 0.5)
stride = (w * bpp + 31) // 32 * 4
for y in range(abs(h)):
    sy = y if h < 0 else abs(h) - 1 - y
    out = []
    for x in range(w):
        px = I(off + sy * stride + x * bpp // 8, bpp // 8)
        r, g, b = ch(px, ms[0], 0), ch(px, ms[1], 0), ch(px, ms[2], 0); a = ch(px, ms[3], 255)
        out.append(${JSON.stringify(fmt)} == "hex" and "%02x%02x%02x" % (r, g, b) or ${JSON.stringify(fmt)} == "dec" and "%d,%d,%d" % (r, g, b) or "%02x%02x%02x%02x" % (a, r, g, b))
    print(*out)
`;

const SEEDS = [
    { id: 'rle8-rgb', want: 'bmpx.rle', st: '輸入一行十六進位字串，是一個 8 位元 BMP，壓縮方式為 BI_RLE8（壓縮欄位＝1）：編碼模式（計數＋索引）、絕對模式（0 n 之後 n 個索引，補到偶數位元組）、跳脫碼（0 0 換行、0 1 結束、0 2 dx dy 位移，被跳過的像素索引為 0）。請解壓縮，並由上到下逐列輸出每個像素的調色盤顏色 RRGGBB（小寫十六進位），同一列以空格分隔。調色盤從位元組 14＋資訊標頭大小開始，每色 B G R 保留。', ref: REF_RLE('rgb', 'top'), gen: genRle(8, true) },
    { id: 'rle4-idx', want: 'bmpx.rle', st: '輸入一行十六進位字串，是一個 4 位元 BMP，壓縮方式為 RLE4（壓縮欄位＝2）：編碼模式的值位元組含兩個像素（高半位元組先、低半位元組後，計數超過 2 時交替重複）；絕對模式 0 n 後面有 ceil(n/2) 個位元組並補到偶數位元組；0 0 換行、0 1 結束、0 2 位移。請解壓縮，依儲存順序（第一列是影像最下面）逐列輸出每個像素的調色盤索引（十進位），同一列以空格分隔。', ref: REF_RLE('idx', 'st'), gen: genRle(4, true) },
    { id: 'rle4-rgb', want: 'bmpx.rle', st: '輸入一行十六進位字串，是一個 RLE4 壓縮的 BMP（壓縮欄位 2，4 位元調色盤，高度為正、列由下到上）。請解壓後由上到下輸出每個像素的顏色 RRGGBB（小寫十六進位），同列以空格分隔。', ref: REF_RLE('rgb', 'top'), gen: genRle(4, false) },
    { id: 'rle8-idx', want: 'bmpx.rle', st: '輸入一行十六進位字串，是 RLE8 壓縮的 BMP（BI_RLE8）。請解壓縮，由上到下逐列輸出每個像素的調色盤索引（十進位），同一列以空格分隔。', ref: REF_RLE('idx', 'top'), gen: genRle(8, false) },
    { id: 'bf-565-hex', want: 'bmpx.bitfields', st: '輸入一行十六進位字串，是一個 16 位元 BMP，壓縮欄位為 3（BI_BITFIELDS），紅綠藍的遮罩依序放在位元組 54、58、62（各 4 位元組小端）。每個像素取 (像素 & 遮罩) 右移到最低位後，以 值×255÷最大值（整數除法、無條件捨去）換成 8 位元。請由上到下逐列輸出每個像素的 RRGGBB（小寫十六進位），同列以空格分隔。', ref: REF_BF('floor', 'hex'), gen: genBf('rgb565', false) },
    { id: 'bf-32-dec', want: 'bmpx.bitfields', st: '輸入一行十六進位字串，是一個 32 位元 BMP（BI_BITFIELDS，壓縮欄位 3），紅綠藍遮罩在位元組 54、58、62。通道值是 (像素 & 遮罩) 右移遮罩最低位元的位置，再用 值×255÷最大值（整數除法）換成 0–255。請由上到下逐列輸出每個像素的「R,G,B」（十進位，逗號分隔），同一列的像素以空格分隔。', ref: REF_BF('floor', 'dec'), gen: genBf('bgr_bf', false) },
    { id: 'bf-10bit', want: 'bmpx.bitfields', st: '輸入一行十六進位字串，是一個 32 位元 BMP，用 BI_BITFIELDS 色彩遮罩（紅綠藍遮罩在位元組 54、58、62，每個通道可能不是 8 位元，例如 10 位元）。通道換成 8 位元的方式是 值×255÷最大值 四捨五入到整數。請由上到下逐列輸出每個像素的 RRGGBB（小寫十六進位），同一列以空格分隔。', ref: REF_BF('round', 'hex'), gen: genBf('r10', false) },
    { id: 'bf-argb4444', want: 'bmpx.bitfields', st: '輸入一行十六進位字串，是一個 16 位元的 V4 BMP（資訊標頭 108 位元組，壓縮欄位 3，紅綠藍 alpha 遮罩在位元組 54、58、62、66）。通道值以 值×255÷最大值 四捨五入換成 8 位元。請由上到下逐列輸出每個像素的 AARRGGBB（小寫十六進位），同一列以空格分隔。', ref: REF_BF('round', 'argb'), gen: genBf('argb4444', false) },
    { id: 'bf-default-neg', want: 'bmpx.bitfields', st: '輸入一行十六進位字串，是一個 32 位元 BMP，壓縮欄位 0（沒有遮罩，預設 B G R 各 8 位元，第四個位元組是 alpha 忽略）；高度為負值表示由上到下儲存。請逐列（影像由上到下）輸出每個像素的 RRGGBB（小寫十六進位），同一列以空格分隔。', ref: REF_BF('floor', 'hex'), gen: genBf('argb8888', true) },
    { id: 'bf-555-default', want: 'bmpx.bitfields', st: '輸入一行十六進位字串，是一個 16 位元 BMP，壓縮欄位 0（預設 5-5-5：紅 0x7C00、綠 0x03E0、藍 0x001F）。通道換成 8 位元用 值×255÷最大值 四捨五入。請由上到下逐列輸出每個像素的 RRGGBB（小寫十六進位），同一列以空格分隔。', ref: REF_BF('round', 'hex'), gen: genBf('rgb555', false) },
    // holdout：另寫措辭，只量測，不教
    { id: 'ho-rle8', split: 'holdout', st: '給一行十六進位，是以 RLE8 壓縮的 BMP 檔。請還原每個像素，從影像最上方那一列開始，每列輸出一行，內容是調色盤顏色的 RRGGBB（小寫），用空格隔開。', ref: REF_RLE('rgb', 'top'), gen: genRle(8, true) },
    { id: 'ho-rle4', split: 'holdout', st: '輸入一行十六進位字串，這是 4 位元、行程長度編碼（壓縮類型 2）的 BMP。請解碼後依序列出每一列（由上往下）每個像素的調色盤索引，列內以空格分隔。', ref: REF_RLE('idx', 'top'), gen: genRle(4, true) },
    { id: 'ho-565', split: 'holdout', st: '輸入一行十六進位字串，是一個 RGB565 的 BMP（每像素 16 位元，遮罩 F800／07E0／001F 記錄在檔頭的位元組 54 起）。請把每個像素換成 8 位元的 RGB（通道值×255÷最大值，無條件捨去），由上到下逐列輸出 RRGGBB 小寫十六進位，列內以空格分隔。', ref: REF_BF('floor', 'hex'), gen: genBf('rgb565', false) },
    { id: 'ho-bf32', split: 'holdout', st: '輸入一行十六進位字串，是一個 32 位元 BMP，用色彩遮罩（BITFIELDS）表示像素，遮罩順序是紅、綠、藍，可能含 alpha。請逐列由上到下輸出每個像素的 ARGB（AARRGGBB，小寫十六進位；沒有 alpha 遮罩時 alpha 為 ff），列內以空格分隔。通道以 值×255÷最大值 四捨五入。', ref: REF_BF('round', 'argb'), gen: genBf('rgba_bf', false) }
];
H.main({ name: '領域包 bmpx', packs: [BX], seeds: SEEDS, minSkeletons: 2, judge: { checker: 'tokens', timeoutMs: 60000 } });
