'use strict';
// 領域包「PCX 讀寫」：測資由測試內的 Python 產生器產生（解碼題：隨機影像，取少數幾個值以產生 RLE 連續段，另含 ≥192 的字面值；
// 寫出題：隨機原始封包）。參考解是另寫的 Python（解碼用位置索引式、編碼用 itertools.groupby 切段，與骨架的寫法不同）。
// 另有 Pillow 外部驗證（python3 的 Pillow 9.0.1；寬度取 ≥2：Pillow 9.0.1 對寬 1 的三平面 RGB 寫出的 RLE 長度不符表頭，屬 Pillow 的問題，我們的解碼器依規格實作）：寫出端的輸出 Pillow 必須能開並還原像素；Pillow 寫出的 PCX 必須能被參考解碼器還原（比 RGB）。
// train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。
const cp = require('child_process');
const H = require('./domain_harness.js'); const { rnd } = H;
const PC = require('./domain_pcx_core.js');
const PY = process.env.FA_PYTHON || 'python3';
const py = (src, input) => { const r = cp.spawnSync(PY, ['-I', '-c', src], { input: input || '', encoding: 'utf8', timeout: 60000 }); if (r.status !== 0) throw new Error('python 失敗：' + r.stderr); return r.stdout.trim(); };

// 表頭（128 位元組，版本 5）：寬高由 Xmin／Ymin／Xmax／Ymax 算出，平面數在 65，bytes_per_line 在 66～67
const HDR_PY = `
def le(v): return v.to_bytes(2, "little")
def hdr(w, h, npl):
    return bytes([10, 5, 1, 8]) + bytes(4) + le(w - 1) + le(h - 1) + bytes(4) + bytes(48) + bytes([0, npl]) + le(w) + le(1) + bytes(4) + bytes(54)
`;

// ---- 解碼題的產生器：隨機影像（取少數值以產生連續段）→ RLE → PCX 檔（planes＝1 帶調色盤，3 為 RGB）----
const GEN_DEC = (planes, seed, big) => `
import random
random.seed(${seed})
w = random.randint(1, ${big ? 30 : 8}); h = random.randint(1, ${big ? 20 : 6})
${HDR_PY}
pool = random.sample(range(256), 3) + [200]
def rle(line):
    out = bytearray(); i = 0
    while i < len(line):
        v = line[i]; n = 1
        while i + n < len(line) and line[i + n] == v and n < 63: n += 1
        if n > 1 or v >= 192: out += bytes([192 | n, v])
        else: out.append(v)
        i += n
    return bytes(out)
if ${planes} == 1:
    pal = bytes(random.randrange(256) for _ in range(768))
    px = [[random.choice(pool) for _ in range(w)] for _ in range(h)]
    lines = [bytes(r) for r in px]
    tail = bytes([12]) + pal
else:
    lines = []
    cols = [[tuple(random.choice(pool) for _ in range(3)) for _ in range(w)] for _ in range(h)]
    for row in cols:
        for ch in range(3): lines.append(bytes(c[ch] for c in row))
    tail = b""
f = hdr(w, h, ${planes}) + b"".join(rle(x) for x in lines) + tail
print(f.hex())
`;
const genDec = (planes) => (b) => py(GEN_DEC(planes, rnd(1, 1e9), b)) + '\n';

// ---- 參考解碼器（位置索引式）：MODE 為 px（每像素 RGB 十六進位，空格分隔）、hex（整列 RGB 十六進位）----
const REF_DEC = (mode) => `import sys
f = bytes.fromhex(sys.stdin.read().strip())
W = (f[8] + 256 * f[9]) - (f[4] + 256 * f[5]) + 1
H = (f[10] + 256 * f[11]) - (f[6] + 256 * f[7]) + 1
planes = f[65]; bpl = f[66] + 256 * f[67]
need = H * planes * bpl
buf = []; p = 128
while len(buf) < need:
    b = f[p]; p += 1
    if (b >> 6) == 3:
        n = b & 63; buf.extend([f[p]] * n); p += 1
    else:
        buf.append(b)
buf = buf[:need]
pal = f[-768:]
for y in range(H):
    px = []
    for x in range(W):
        if planes == 1:
            v = buf[y * bpl + x]; px.append(bytes(pal[3 * v:3 * v + 3]))
        else:
            base = y * planes * bpl
            px.append(bytes([buf[base + x], buf[base + bpl + x], buf[base + 2 * bpl + x]]))
    if "${mode}" == "px": print(" ".join(c.hex() for c in px))
    else: print("".join(c.hex() for c in px))
`;

// ---- 寫出題的產生器與參考編碼器 ----
const GEN_ENC = (planes, seed, big) => `
import random
random.seed(${seed})
w = random.randint(1, ${big ? 30 : 8}); h = random.randint(1, ${big ? 20 : 6})
pool = random.sample(range(256), 3) + [200]
pl = ${planes}
head = w.to_bytes(2, "big") + h.to_bytes(2, "big") + bytes([pl])
if pl == 1:
    body = bytes(random.randrange(256) for _ in range(768)) + bytes(random.choice(pool) for _ in range(w * h))
else:
    body = bytes(random.choice(pool) for _ in range(3 * w * h))
print((head + body).hex())
`;
const genEnc = (planes) => (b) => py(GEN_ENC(planes, rnd(1, 1e9), b)) + '\n';
const REF_ENC = `import sys
from itertools import groupby
${HDR_PY}
d = bytes.fromhex(sys.stdin.read().strip())
w = int.from_bytes(d[0:2], "big"); h = int.from_bytes(d[2:4], "big"); pl = d[4]
body = d[5:]
if pl == 1:
    pal = body[:768]; px = body[768:768 + w * h]
    lines = [px[y * w:(y + 1) * w] for y in range(h)]
    tail = bytes([12]) + pal
else:
    px = body[:3 * w * h]; lines = []
    for y in range(h):
        row = px[3 * w * y:3 * w * (y + 1)]
        for ch in range(3): lines.append(bytes(row[ch::3]))
    tail = bytes()
out = bytearray()
for line in lines:
    for v, grp in groupby(line):
        n = len(list(grp))
        while n > 0:
            m = min(n, 63)
            if m > 1 or v >= 192: out += bytes([192 | m, v])
            else: out.append(v)
            n -= m
print((hdr(w, h, pl) + bytes(out) + tail).hex())
`;

const SEEDS = [
    { id: 'dec-pal-px', want: 'pcx.decode', st: '輸入一行十六進位字串，是 PCX 檔（版本 5、8 位元、RLE、單平面，檔尾 256 色調色盤）。解開後每列輸出一行，每個像素的 RGB 十六進位以空格分隔，由上到下。', ref: REF_DEC('px'), gen: genDec(1) },
    { id: 'dec-rgb-hex', want: 'pcx.decode', st: '輸入一行十六進位字串，是 PCX 檔（版本 5、8 位元、RLE、三平面，每條掃描線依序為紅、綠、藍）。解開後每列輸出一行，內容是整列像素的 RGB 十六進位（小寫、不加空白），由上到下。', ref: REF_DEC('hex'), gen: genDec(3) },
    { id: 'dec-rgb-px', want: 'pcx.decode', st: '輸入一行十六進位字串，是 PCX 檔（版本 5、8 位元、RLE、三平面，每條掃描線依序為紅、綠、藍）。解開後每列輸出一行，每個像素的 RGB 十六進位以空格分隔，由上到下。', ref: REF_DEC('px'), gen: genDec(3) },
    { id: 'dec-pal-hex', want: 'pcx.decode', st: '輸入一行十六進位字串，是 PCX 檔（版本 5、8 位元、RLE、單平面，檔尾 256 色調色盤）。解開後每列輸出一行，內容是整列像素的 RGB 十六進位（小寫、不加空白），由上到下。', ref: REF_DEC('hex'), gen: genDec(1) },
    { id: 'enc-pal', want: 'pcx.encode', st: '輸入一行十六進位字串，是原始影像封包：前 2 個位元組是寬（大端）、接著 2 個位元組是高（大端）、再 1 個位元組是平面數 1；之後 768 個位元組是 256 色 RGB 調色盤，其餘是 寬×高 個索引（列由上到下）。請組出 PCX 檔（ZSoft 版本 5，8 位元，RLE 逐掃描線編碼，檔尾加 0x0C 與調色盤），輸出檔案的十六進位（小寫、不加空白）。', ref: REF_ENC, gen: genEnc(1) },
    { id: 'enc-rgb', want: 'pcx.encode', st: '輸入一行十六進位字串，是原始影像封包：前 2 個位元組是寬（大端）、接著 2 個位元組是高（大端）、再 1 個位元組是平面數 3，其餘是 RGB 像素（每像素 3 位元組，列由上到下）。請組出 PCX 檔（版本 5、8 位元、RLE，每條掃描線依紅、綠、藍平面分開編碼），輸出檔案的十六進位。', ref: REF_ENC, gen: genEnc(3) },
    { id: 'enc-big', want: 'pcx.encode', st: '輸入一行十六進位字串，是原始封包（寬、高各 2 位元組大端，接著 1 位元組平面數 1，之後是 768 位元組調色盤與像素索引）。請編成 PCX 檔並輸出十六進位，RLE 每條掃描線分別編碼，且一段連續相同值最多 63 個。', ref: REF_ENC, gen: (b) => py(GEN_ENC(1, rnd(1, 1e9), true)) + '\n' },
    // holdout：另寫措辭，只量測，不教
    { id: 'ho-pcx-rrggbb', split: 'holdout', st: '給一行十六進位，是一張 PCX 圖（三個平面，RLE 壓縮，每條掃描線先是紅色平面、再綠色、最後藍色）。把它還原，每列印出一行，每個像素用六位十六進位的 RRGGBB 表示，像素之間以空格隔開。', ref: REF_DEC('px'), gen: genDec(3) },
    { id: 'ho-pcx-enc', split: 'holdout', st: '給一行十六進位，前 2 位元組寬、接著 2 位元組高（都是大端），第 5 位元組是平面數 1，之後是 768 位元組的調色盤與像素索引。請把它做成 PCX 檔並輸出十六進位。', ref: REF_ENC, gen: genEnc(1) }
];

// Pillow 外部驗證（不依賴我們的程式）：
//  (a) 寫出：參考編碼器的輸出，Pillow 必須能開，單平面比索引與調色盤、三平面比 RGB 逐像素相同；
//  (b) 解碼：Pillow 寫出的 PCX，參考解碼器（px 模式）還原的 RGB 必須與原影像相同。
const PILLOW_GEN = `
import io, json, random
from PIL import Image
random.seed(${20261112})
cases = []
for t in range(12):
    w = random.randint(2, 30); h = random.randint(1, 20); planes = 1 if t % 2 == 0 else 3
    if planes == 1:
        k = random.randint(2, 256)
        pal = bytes(random.randrange(256) for _ in range(768))
        px = bytes(random.randrange(k) for _ in range(w * h))
        im = Image.frombytes("P", (w, h), px); im.putpalette(list(pal))
        rgb_want = [tuple(pal[3 * v:3 * v + 3]) for v in px]
    else:
        raw = bytes(random.randrange(256) for _ in range(3 * w * h))
        im = Image.frombytes("RGB", (w, h), raw)
        rgb_want = [tuple(raw[3 * i:3 * i + 3]) for i in range(w * h)]
    buf = io.BytesIO(); im.save(buf, "PCX")
    cases.append({"w": w, "h": h, "planes": planes, "pcx": buf.getvalue().hex(), "rgb": [list(c) for c in rgb_want]})
print(json.dumps(cases))
`;
const PILLOW_CHECK = `
import io, json, sys
from PIL import Image
cases = json.loads(sys.stdin.read())
ok = 0
for c in cases:
    im = Image.open(io.BytesIO(bytes.fromhex(c["pcx"]))); im.load()
    got = [tuple(x) for x in im.convert("RGB").getdata()] if im.mode != "P" else None
    if im.mode == "P":
        pal = im.getpalette()
        got = [tuple(pal[3 * v:3 * v + 3]) for v in im.getdata()]
    ok += 1 if got == [tuple(x) for x in c["rgb"]] else 0
print(ok, len(cases))
`;
function pillowCheck() {
    // (a) 寫出端：隨機封包（Python）→ 參考編碼器 → Pillow 開啟，比對 RGB（單平面用原調色盤換算）
    const encPy = `
import io, json, random
random.seed(${20261113})
out = []
for t in range(12):
    w = random.randint(2, 30); h = random.randint(1, 20); planes = 1 if t % 2 == 0 else 3
    if planes == 1:
        k = random.randint(2, 256)
        pal = bytes(random.randrange(256) for _ in range(768))
        px = bytes(random.randrange(k) for _ in range(w * h))
        packet = w.to_bytes(2, "big") + h.to_bytes(2, "big") + bytes([1]) + pal + px
        want = [tuple(pal[3 * v:3 * v + 3]) for v in px]
    else:
        raw = bytes(random.randrange(256) for _ in range(3 * w * h))
        packet = w.to_bytes(2, "big") + h.to_bytes(2, "big") + bytes([3]) + raw
        want = [tuple(raw[3 * i:3 * i + 3]) for i in range(w * h)]
    out.append({"packet": packet.hex(), "want": [list(x) for x in want]})
print(json.dumps(out))
`;
    const enc = JSON.parse(py(encPy)).map((c) => ({ pcx: py(REF_ENC, c.packet), rgb: c.want }));
    const encRes = py(PILLOW_CHECK, JSON.stringify(enc));
    // (b) 解碼端：Pillow 寫出的 PCX（PILLOW_GEN）→ 參考解碼器（px 模式）→ RGB 比對
    const cases = JSON.parse(py(PILLOW_GEN));
    let decOk = 0; const decBad = [];
    cases.forEach((c, t) => {
        const got = py(REF_DEC('px'), c.pcx).split('\n').map((r) => r.trim()).filter(Boolean).join(' ').split(' ').filter(Boolean);
        const want = c.rgb.map((x) => Buffer.from(x).toString('hex'));
        if (got.length === want.length && got.every((v, i) => v === want[i])) decOk++; else decBad.push(t + '（' + c.w + '×' + c.h + '，平面 ' + c.planes + '）');
    });
    if (decBad.length) console.log('  · 解碼端不符的案例：' + decBad.join('、'));
    console.log('Pillow 外部驗證：寫出端（Pillow 開啟並比對 RGB）' + encRes + '；解碼端（參考解碼器還原 Pillow 寫出的檔）' + decOk + '/' + cases.length);
    const [a, b] = encRes.split(' ').map(Number);
    if (a !== b || decOk !== cases.length) throw new Error('Pillow 外部驗證未全過');
}
pillowCheck();
H.main({ name: '領域包 pcx', packs: [PC], seeds: SEEDS, minSkeletons: 2, judge: { checker: 'tokens', timeoutMs: 60000 } });
