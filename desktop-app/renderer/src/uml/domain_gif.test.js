'use strict';
// 領域包「GIF 讀寫」：測資由測試內的 Python 產生器產生（解碼題：隨機調色盤與索引影像，LZW 編碼後包成 GIF，夾註解擴充與圖形控制擴充；
// 寫出題：隨機原始封包）。參考解是另寫的 Python（位元字串式 LZW，與骨架的位元累加寫法不同）。
// 另有 Pillow 外部驗證（python3 的 Pillow）：寫出端的輸出 Pillow 必須能開，並還原出同樣的索引；Pillow 寫的 GIF 也必須被我們的參考解碼還原。
// train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。
const cp = require('child_process');
const H = require('./domain_harness.js'); const { rnd } = H;
const GF = require('./domain_gif_core.js');
const PY = process.env.FA_PYTHON || 'python3';
const py = (src, input) => { const r = cp.spawnSync(PY, ['-I', '-c', src], { input: input || '', encoding: 'utf8', timeout: 60000 }); if (r.status !== 0) throw new Error('python 失敗：' + r.stderr); return r.stdout.trim(); };

// 共用的 Python 片段（產生器與參考編碼器用）：碼寬、LZW（位元字串式）、子區塊
const LZW_PY = `
def gw(k, mcs):
    L = (1 << mcs) + 2 + max(0, k - 1)
    s = mcs + 1
    while (1 << s) <= L and s < 12: s += 1
    return s
def lzw(px, mcs):
    clear = 1 << mcs; eoi = clear + 1
    dic = {bytes([i]): i for i in range(clear)}; nxt = clear + 2
    seq = [(clear, mcs + 1)]; k = 0; w = bytes()
    for c in px:
        if w + bytes([c]) in dic:
            w = w + bytes([c])
        else:
            seq.append((dic[w], gw(k, mcs))); k += 1
            dic[w + bytes([c])] = nxt; nxt += 1; w = bytes([c])
    seq.append((dic[w], gw(k, mcs))); k += 1
    seq.append((clear + 1, gw(k, mcs)))
    s = "".join(format(code, "0%db" % wd)[::-1] for code, wd in seq)
    s += "0" * (-len(s) % 8)
    return bytes(int(s[i:i + 8][::-1], 2) for i in range(0, len(s), 8))
def subs(d):
    out = bytes()
    for i in range(0, len(d), 255):
        ch = d[i:i + 255]; out += bytes([len(ch)]) + ch
    return out + bytes([0])
`;

// ---- 解碼題的產生器：隨機調色盤＋索引影像 → LZW → GIF 檔（LOCAL＝影像自帶局部調色盤）----
const GEN_DEC = (seed, big, local) => `
import random
random.seed(${seed})
k = random.randint(2, ${big ? 256 : 8})
bits = max(1, (k - 1).bit_length()); mcs = max(2, bits)
w = random.randint(1, ${big ? 40 : 9}); h = random.randint(1, ${big ? 30 : 6})
pal = bytes(random.randrange(256) for _ in range(3 * k))
pal = pal + bytes(3 * (1 << bits) - len(pal))
px = bytes(random.randrange(k) for _ in range(w * h))
${LZW_PY}
le = lambda v: v.to_bytes(2, "little")
local = ${local ? 'True' : 'False'}
gct = b"" if local else pal
lct = pal if local else b""
hdr_flag = 0 if local else 128 | (bits - 1)
desc_flag = 128 | (bits - 1) if local else 0
ext = bytes([33, 254]) + subs(b"hi") + bytes([33, 249, 4, 0, 0, 0, 0, 0])
out = b"GIF89a" + le(w) + le(h) + bytes([hdr_flag, 0, 0]) + gct + ext
out += bytes([44]) + bytes(4) + le(w) + le(h) + bytes([desc_flag]) + lct + bytes([mcs]) + subs(lzw(px, mcs)) + bytes([59])
print(out.hex())
`;
const genDec = (local) => (b) => py(GEN_DEC(rnd(1, 1e9), b, local)) + '\n';

// ---- 參考解碼器（位元字串式 LZW）：MODE 為 px（每像素 RGB 十六進位）、hex（整列索引十六進位）、dec（整列索引十進位）----
const REF_DEC = (mode) => `import sys
f = bytes.fromhex(sys.stdin.read().strip())
flags = f[10]; p = 13; gct = bytes()
if flags & 128:
    n = 3 * (1 << ((flags & 7) + 1)); gct = f[p:p + n]; p += n
while f[p] == 33:
    p += 2
    while f[p] != 0: p += f[p] + 1
    p += 1
assert f[p] == 44
W = f[p + 5] | (f[p + 6] << 8); H = f[p + 7] | (f[p + 8] << 8)
lf = f[p + 9]; p += 10
pal = gct
if lf & 128:
    n = 3 * (1 << ((lf & 7) + 1)); pal = f[p:p + n]; p += n
mcs = f[p]; p += 1
data = bytes()
while f[p] != 0:
    data += f[p + 1:p + 1 + f[p]]; p += f[p] + 1
bitstr = "".join(format(b, "08b")[::-1] for b in data)
clear = 1 << mcs; eoi = clear + 1
tab = {i: bytes([i]) for i in range(clear)}; nxt = clear + 2; size = mcs + 1; prev = None
idx = []; pos = 0
while pos + size <= len(bitstr):
    code = int(bitstr[pos:pos + size][::-1], 2); pos += size
    if code == clear:
        tab = {i: bytes([i]) for i in range(clear)}; nxt = clear + 2; size = mcs + 1; prev = None
        continue
    if code == eoi: break
    cur = tab[code] if code in tab else prev + prev[:1]
    if prev is not None:
        tab[nxt] = prev + cur[:1]; nxt += 1
    idx += list(cur); prev = cur
    if nxt >= (1 << size) and size < 12: size += 1
for y in range(H):
    r = idx[y * W:(y + 1) * W]
    if "${mode}" == "px": print(" ".join(pal[3 * v:3 * v + 3].hex() for v in r))
    elif "${mode}" == "hex": print(bytes(r).hex())
    else: print(" ".join(str(v) for v in r))
`;

// ---- 寫出題的產生器與參考編碼器（同一套確定性演算法，位元字串式寫法）----
const GEN_ENC = (seed, big) => `
import random
random.seed(${seed})
w = random.randint(1, ${big ? 30 : 6}); h = random.randint(1, ${big ? 20 : 4})
k = random.randint(2, ${big ? 255 : 12})
pal = bytes(random.randrange(256) for _ in range(3 * k))
px = bytes(random.randrange(k) for _ in range(w * h))
print((w.to_bytes(2, "big") + h.to_bytes(2, "big") + bytes([k]) + pal + px).hex())
`;
const genEnc = (b) => py(GEN_ENC(rnd(1, 1e9), b)) + '\n';
const REF_ENC = `import sys
${LZW_PY}
d = bytes.fromhex(sys.stdin.read().strip())
w = int.from_bytes(d[0:2], "big"); h = int.from_bytes(d[2:4], "big"); k = d[4]
pal = d[5:5 + 3 * k]; px = d[5 + 3 * k:5 + 3 * k + w * h]
bits = max(1, (k - 1).bit_length()); mcs = max(2, bits)
pal = pal + bytes(3 * (1 << bits) - len(pal))
le = lambda v: v.to_bytes(2, "little")
out = b"GIF89a" + le(w) + le(h) + bytes([128 | (bits - 1), 0, 0]) + pal
out += bytes([44]) + bytes(4) + le(w) + le(h) + bytes([0]) + bytes([mcs]) + subs(lzw(px, mcs)) + bytes([59])
print(out.hex())
`;

const SEEDS = [
    { id: 'dec-px', want: 'gif.decode', st: '輸入一行十六進位字串，是一張 GIF 檔（只有一個影格，沒有交錯，全域調色盤）。請跳過擴充區塊，接起影像資料，做 LZW 解碼。每列輸出一行，每個像素以調色盤中對應顏色的 RGB 三個位元組的十六進位表示（小寫、不加空白），像素之間以空格分隔，由上到下。', ref: REF_DEC('px'), gen: genDec(false) },
    { id: 'dec-hex', want: 'gif.decode', st: '輸入一行十六進位字串，是一張 GIF 檔（單一影格、非交錯）。請解碼影像的索引值。每列輸出一行，內容是整列索引位元組的十六進位（小寫、不加空白），由上到下。', ref: REF_DEC('hex'), gen: genDec(false) },
    { id: 'dec-dec', want: 'gif.decode', st: '輸入一行十六進位字串，是 GIF 檔，影像只有一張。解壓後把每列的像素索引（調色盤編號）印出來，每列一行，數字以空格分隔，由上到下。', ref: REF_DEC('dec'), gen: genDec(false) },
    { id: 'dec-local', want: 'gif.decode', st: '輸入一行十六進位字串，是一張 GIF 檔，檔案本身沒有全域調色盤，影像描述子帶有自己的局部調色盤。請解碼 LZW 影像資料，每列輸出一行，每個像素以調色盤顏色的 RGB 十六進位表示，像素之間以空格分隔，由上到下。', ref: REF_DEC('px'), gen: genDec(true) },
    { id: 'enc-rgb', want: 'gif.encode', st: '輸入一行十六進位字串，是一個原始影像封包：前 2 個位元組是寬（大端）、接著 2 個位元組是高（大端）、再 1 個位元組是調色盤顏色數 k，之後是 3k 個位元組的 RGB 調色盤，其餘是 寬×高 個索引位元組（列由上到下）。請組出一張 GIF 檔（GIF89a，全域調色盤補到 2 的冪次），影像資料用 LZW 編碼（起始送清除碼，碼寬隨碼表長度增加），以子區塊存放，輸出整個檔案的十六進位（小寫、不加空白）。', ref: REF_ENC, gen: genEnc },
    { id: 'enc-gray2', want: 'gif.encode', st: '輸入一行十六進位字串，是原始影像封包：前 2 位元組為寬（大端）、其後 2 位元組為高（大端）、第 5 個位元組為調色盤顏色數 k（k 可為 2），接著 3k 位元組為調色盤，其餘為索引（列由上到下）。請編成 GIF 檔，LZW 採清除碼開頭的確定性編碼，輸出檔案的十六進位。', ref: REF_ENC, gen: genEnc },
    { id: 'enc-big', want: 'gif.encode', st: '輸入一行十六進位字串，是原始影像封包（寬、高各 2 位元組大端，接著 1 位元組的調色盤顏色數，然後是 RGB 調色盤，最後是索引，列由上到下）。請組出 GIF 檔，影像資料要切成最多 255 位元組的子區塊，輸出整個檔案的十六進位。', ref: REF_ENC, gen: (b) => py(GEN_ENC(rnd(1, 1e9), true)) + '\n' },
    // holdout：另寫措辭，只量測，不教
    { id: 'ho-dec-rrggbb', split: 'holdout', st: '給一行十六進位，內容是一張 GIF 圖片（一個影格）。把它解開，按列由上到下，每列印出一行；列中每個像素用它的顏色表示成六位十六進位的 RRGGBB，像素之間以空格隔開。', ref: REF_DEC('px'), gen: genDec(false) },
    { id: 'ho-enc-pack', split: 'holdout', st: '給一行十六進位，是原始封包：開頭 2 位元組寬、接著 2 位元組高（都是大端），第 5 個位元組是顏色數，之後是 RGB 調色盤與像素索引。請把它做成 GIF 圖檔並輸出十六進位。', ref: REF_ENC, gen: genEnc }
];
// Pillow 外部驗證（不依賴我們的任何程式）：
//  (a) 寫出：我們的參考編碼器輸出的 GIF，Pillow 必須能開，索引與調色盤逐一相同；
//  (b) 解碼：Pillow 寫出的 GIF，我們的參考解碼器必須還原出同樣的索引。
const PILLOW_GEN = `
import io, json, random
from PIL import Image
random.seed(${20261112})
cases = []
for t in range(16):
    w = random.randint(1, 30); h = random.randint(1, 20); k = random.randint(2, 255)
    pal = bytes(random.randrange(256) for _ in range(3 * k))
    px = bytes(random.randrange(k) for _ in range(w * h))
    # interlace=False：Pillow 預設可能寫交錯列（描述子 packed 的 0x40 位元），本領域包不支援交錯，故外部驗證明確關閉
    im = Image.frombytes("P", (w, h), px); im.putpalette(list(pal)); buf = io.BytesIO(); im.save(buf, "GIF", interlace=False)
    cases.append({"w": w, "h": h, "k": k, "pal": pal.hex(), "px": px.hex(), "gif": buf.getvalue().hex()})
print(json.dumps(cases))
`;
const PILLOW_CHECK = `
import io, json, sys
from PIL import Image
cases = json.loads(sys.stdin.read())
ok = 0
for c in cases:
    im = Image.open(io.BytesIO(bytes.fromhex(c["gif"]))); im.load()
    same = list(im.getdata()) == list(bytes.fromhex(c["px"])) and im.getpalette()[:3 * c["k"]] == list(bytes.fromhex(c["pal"]))
    ok += 1 if same else 0
print(ok, len(cases))
`;
function pillowCheck() {
    const cases = JSON.parse(py(PILLOW_GEN));
    // (a) 寫出端：參考編碼器（我們的確定性 LZW）→ Pillow 開啟比對
    const encIn = cases.map((c) => {
        const packet = Buffer.concat([Buffer.from([c.w >> 8, c.w & 255, c.h >> 8, c.h & 255, c.k]), Buffer.from(c.pal, 'hex'), Buffer.from(c.px, 'hex')]).toString('hex');
        return { ...c, gif: py(REF_ENC, packet) };
    });
    const encRes = py(PILLOW_CHECK, JSON.stringify(encIn));
    // (b) 解碼端：Pillow 寫出的 GIF → 參考解碼器（px 模式，逐像素 RGB）→ 與原像素的 RGB 比對。
    // 比顏色而不比索引：Pillow 寫出時會去掉未用到的調色盤項並重新編號，索引不必與原始相同。
    let decOk = 0; const decBad = [];
    cases.forEach((c, t) => {
        const pal = Buffer.from(c.pal, 'hex'), px = Buffer.from(c.px, 'hex');
        const want = Array.from(px).map((v) => pal.subarray(3 * v, 3 * v + 3).toString('hex'));
        const got = py(REF_DEC('px'), c.gif).split('\n').map((r) => r.trim()).filter(Boolean).join(' ').split(' ').filter(Boolean);
        if (got.length === want.length && got.every((v, i) => v === want[i])) decOk++; else decBad.push(t + '（' + c.w + '×' + c.h + '，k=' + c.k + '）');
    });
    if (decBad.length) console.log('  · 解碼端不符的案例：' + decBad.join('、'));
    console.log('Pillow 外部驗證：寫出端（Pillow 開啟並比對索引與調色盤）' + encRes + '；解碼端（參考解碼器還原 Pillow 寫出的檔，比 RGB）' + decOk + '/' + cases.length);
    const [a, b] = encRes.split(' ').map(Number);
    if (a !== b || decOk !== cases.length) throw new Error('Pillow 外部驗證未全過');
}
pillowCheck();
H.main({ name: '領域包 gif', packs: [GF], seeds: SEEDS, minSkeletons: 2, judge: { checker: 'tokens', timeoutMs: 60000 } });
