'use strict';
// 乾淨 holdout v2（2026-11-12，blockly-finish-3 續五）。只量一次；量完不重試、不改題目、不改教法去湊數字。
// ── 凍結判準（寫在提交前，提交後不改；事後若要改，必須在 DESIGN.blockly-gaps.md §13 標明「事後修改」並另列數字）──
//   1. 題數 27：inflate 3、tar 3、BMP 3、PNG 3、GIF 3、PCX 3、JPEG 3、gzip 3、zlib 3。
//   2. 題型：只用「原始位元組上的固定位移欄位（讀欄位）」與「位元組標記的出現次數／位元組值的個數（計數）」；不要求解壓、不要求重組檔案。
//      措辭與 train（domain_fieldcount.test.js）、舊 holdout（domain_fresh_holdout.test.js，§12）都不同；有的刻意用與 train 相近、有的用不同說法。
//   3. 測資：參考解用 Python 標準函式庫（zlib、gzip、tarfile、struct）與 Pillow 產生檔案與答案；隨機種子由 harness 給；不做人工挑選。
//   4. 判準：一題「解出」＝ 原敘述（無改寫、無選項反序）由 harness 產生的測資全部 AC，且在 harness 的 holdout 路徑計為解出；無範式限制（不指定 want）。
//   5. 系統：量測時註冊的領域包＝ domain_fieldcount_core.js（新）＋ 既有 7 個格式包（inflate／tarx／bmpx／png／gif／pcx／jpeg）＋ binfmt；未註冊 linux 系列與其他領域。
//   6. 只量測一次；未解的題照實列出 harness 回報的原因，不改敘述、不改參考解。
// 參考解：Python 標準函式庫（zlib、gzip、tarfile、struct）與 Pillow（只用來產生 BMP／PNG／GIF／PCX／JPEG 檔案）。
const cp = require('child_process');
const H = require('./domain_harness.js'); const { rnd } = H;
const PY = process.env.FA_PYTHON || 'python3';
const runPy = (src, seed) => { const r = cp.spawnSync(PY, ['-I', '-c', src, String(seed)], { encoding: 'utf8', timeout: 60000 }); if (r.status !== 0) throw new Error('python 失敗：' + r.stderr.slice(0, 300)); return r.stdout.trim(); };
const GEN = (src) => (b, o) => runPy(src, o.rnd(1, 2000000000));
const REF = (body) => 'import sys\nimport io, struct, zlib, gzip, tarfile\ndata = bytes.fromhex(sys.stdin.read().strip())\n' + body + '\n';
const PRE = 'import sys, random, io, struct, zlib, gzip, tarfile\nrandom.seed(int(sys.argv[1]))\n';
const PILPRE = PRE + 'from PIL import Image\n';

const SEEDS = [
    // ── inflate 層（zlib 外殼、原始 DEFLATE）──
    { id: 'v2-zl-cmf', split: 'holdout', st: '輸入一行十六進位，是一段 zlib 壓縮資料。CMF 位元組位於位移 0。請讀出它（位移 0、長度 1 個位元組），無號，十進位輸出。',
        ref: REF('print(data[0])'),
        gen: GEN(PRE + 'n = random.randint(1, 300)\nd = bytes(random.randint(0, 255) for _ in range(n))\nprint(zlib.compress(d, random.choice([1, 6, 9])).hex())') },
    { id: 'v2-zl-sync', split: 'holdout', st: '輸入一行十六進位，是一段 zlib 資料，中間可能有同步清除點。請計算標記「00 00 ff ff」出現的次數，不重疊，十進位輸出。',
        ref: REF('print(data.count(bytes([0, 0, 255, 255])))'),
        gen: GEN(PRE + 'c = zlib.compressobj(6)\nout = c.compress(bytes(random.randint(0, 255) for _ in range(40)))\nfor _ in range(random.randint(0, 3)):\n    out += c.compress(b"xyz" * 4) + c.flush(zlib.Z_SYNC_FLUSH)\nout += c.flush()\nprint(out.hex())') },
    { id: 'v2-raw-ff', split: 'holdout', st: '輸入一行十六進位，是一段原始 DEFLATE 串流（沒有 zlib 外殼）。數出位元組值等於 0xff 的個數，十進位輸出。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nprint(sum(1 for b_ in d if b_ == 255))\n',
        gen: GEN(PRE + 'n = random.randint(20, 200)\nd = bytes(random.choice([255, 0, 7]) for _ in range(n))\nc = zlib.compressobj(6, zlib.DEFLATED, -15)\nprint((c.compress(d) + c.flush()).hex())') },
    // ── tar（512 位元組表頭）──
    { id: 'v2-tar-type', split: 'holdout', st: '輸入一行十六進位，是只含一個檔案的 tar 封存。請讀出位移 156 處的 typeflag 位元組（長度 1），無號，十進位輸出。',
        ref: REF('print(data[156])'),
        gen: GEN(PRE + 'buf = io.BytesIO()\nt = tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT)\nd = bytes(random.randint(0, 255) for _ in range(random.randint(0, 100)))\ninfo = tarfile.TarInfo("one.bin"); info.size = len(d); info.mtime = 0\nt.addfile(info, io.BytesIO(d))\nt.close()\nprint(buf.getvalue().hex())') },
    { id: 'v2-tar-magic', split: 'holdout', st: '輸入一行十六進位，是一個 tar 封存。計算 USTAR 標記「75 73 74 61 72」（即 ustar）出現的次數，不重疊，十進位輸出。',
        ref: REF('print(data.count(bytes([117, 115, 116, 97, 114])))'),
        gen: GEN(PRE + 'buf = io.BytesIO()\nt = tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT)\nfor i in range(random.randint(1, 4)):\n    d = bytes(random.randint(0, 255) for _ in range(random.randint(0, 60)))\n    info = tarfile.TarInfo("m%d.bin" % i); info.size = len(d); info.mtime = 0\n    t.addfile(info, io.BytesIO(d))\nt.close()\nprint(buf.getvalue().hex())') },
    { id: 'v2-tar-zero', split: 'holdout', st: '輸入一行十六進位，是一個 tar 封存。數出位元組值為 0 的位元組個數，十進位輸出。',
        ref: REF('print(sum(1 for b_ in data if b_ == 0))'),
        gen: GEN(PRE + 'buf = io.BytesIO()\nt = tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT)\nd = bytes(random.randint(1, 255) for _ in range(random.randint(1, 50)))\ninfo = tarfile.TarInfo("z.bin"); info.size = len(d); info.mtime = 0\nt.addfile(info, io.BytesIO(d))\nt.close()\nprint(buf.getvalue().hex())') },
    // ── BMP ──
    { id: 'v2-bmp-bpp', split: 'holdout', st: '輸入一行十六進位，是一個 BMP 檔。位移 28 處是每像素位元數，占 2 個位元組、小端、無號。請輸出這個值，十進位。',
        ref: REF('print(int.from_bytes(data[28:30], "little", signed=False))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 12), random.randint(1, 12)\nmode = random.choice(["1", "L", "RGB"])\nimg = Image.new(mode, (w, h))\nb = io.BytesIO(); img.save(b, "BMP")\nprint(b.getvalue().hex())') },
    { id: 'v2-bmp-w', split: 'holdout', st: '輸入一行十六進位，是一個 BMP 檔。從位移 18 取 4 個位元組，以小端讀成有號整數，這是影像寬度，十進位輸出。',
        ref: REF('print(int.from_bytes(data[18:22], "little", signed=True))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 30), random.randint(1, 30)\nimg = Image.new("RGB", (w, h))\nb = io.BytesIO(); img.save(b, "BMP")\nprint(b.getvalue().hex())') },
    { id: 'v2-bmp-bm', split: 'holdout', st: '輸入一行十六進位，是一個 BMP 檔。計算標記「42 4d」（即 BM）出現的次數，不重疊，十進位輸出。',
        ref: REF('print(data.count(bytes([66, 77])))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 10), random.randint(1, 10)\nimg = Image.new("RGB", (w, h))\nimg.putdata([(random.choice([66, 0]), random.choice([77, 1]), 2) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "BMP")\nprint(b.getvalue().hex())') },
    // ── PNG ──
    { id: 'v2-png-w', split: 'holdout', st: '輸入一行十六進位，是一個 PNG 檔。位移 16 起的 4 個位元組是影像寬度（大端、無號）。請輸出寬度，十進位。',
        ref: REF('print(int.from_bytes(data[16:20], "big", signed=False))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 40), random.randint(1, 40)\nimg = Image.new("RGB", (w, h))\nb = io.BytesIO(); img.save(b, "PNG")\nprint(b.getvalue().hex())') },
    { id: 'v2-png-depth', split: 'holdout', st: '輸入一行十六進位，是一個 PNG 檔。讀出位移 24、長度 1 個位元組的位元深度，無號，十進位輸出。',
        ref: REF('print(data[24])'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 20), random.randint(1, 20)\nmode = random.choice(["1", "L", "RGB"])\nimg = Image.new(mode, (w, h))\nb = io.BytesIO(); img.save(b, "PNG")\nprint(b.getvalue().hex())') },
    { id: 'v2-png-iend', split: 'holdout', st: '輸入一行十六進位，是一個 PNG 檔。計算標記「49 45 4e 44」（IEND 區塊的型別）出現的次數，不重疊，十進位輸出。',
        ref: REF('print(data.count(bytes([73, 69, 78, 68])))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 15), random.randint(1, 15)\nimg = Image.new("L", (w, h))\nimg.putdata([random.choice([73, 69, 78, 68, 0]) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "PNG")\nprint(b.getvalue().hex())') },
    // ── GIF ──
    { id: 'v2-gif-w', split: 'holdout', st: '輸入一行十六進位，是一個 GIF 檔。從位移 6 讀 2 個位元組，小端、無號，就是邏輯螢幕的寬度。請輸出它，十進位。',
        ref: REF('print(int.from_bytes(data[6:8], "little", signed=False))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 60), random.randint(1, 60)\nimg = Image.new("P", (w, h))\nimg.putpalette([0, 0, 0] * 256)\nb = io.BytesIO(); img.save(b, "GIF")\nprint(b.getvalue().hex())') },
    { id: 'v2-gif-flags', split: 'holdout', st: '輸入一行十六進位，是一個 GIF 檔。邏輯螢幕描述子的打包欄位在位移 10，只占 1 個位元組，無號。請輸出這個位元組的十進位值。',
        ref: REF('print(data[10])'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 8), random.randint(1, 8)\nimg = Image.new("P", (w, h))\nimg.putpalette([random.randint(0, 255) for _ in range(768)])\nb = io.BytesIO(); img.save(b, "GIF")\nprint(b.getvalue().hex())') },
    { id: 'v2-gif-gce', split: 'holdout', st: '輸入一行十六進位，是一個 GIF 動畫。計算標記「21 f9」（圖形控制延伸）出現的次數，不重疊，十進位輸出。',
        ref: REF('print(data.count(bytes([33, 249])))'),
        gen: GEN(PILPRE + 'fs = [Image.new("P", (4, 4)) for _ in range(random.randint(1, 4))]\nfor f in fs: f.putpalette([random.randint(0, 255) for _ in range(768)])\nb = io.BytesIO(); fs[0].save(b, "GIF", save_all=True, append_images=fs[1:], duration=100)\nprint(b.getvalue().hex())') },
    // ── PCX ──
    { id: 'v2-pcx-xmax', split: 'holdout', st: '輸入一行十六進位，是一個 PCX 檔。位移 8 處的兩個位元組是 XMax（小端、無號）。請輸出 XMax，十進位。',
        ref: REF('print(int.from_bytes(data[8:10], "little", signed=False))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 40), random.randint(1, 40)\nimg = Image.new("RGB", (w, h))\nb = io.BytesIO(); img.save(b, "PCX")\nprint(b.getvalue().hex())') },
    { id: 'v2-pcx-bpp', split: 'holdout', st: '輸入一行十六進位，是一個 PCX 檔。位移 3 的位元組是每像素位元數，長度 1，無號。請輸出它，十進位。',
        ref: REF('print(data[3])'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 12), random.randint(1, 12)\nimg = Image.new("RGB", (w, h))\nb = io.BytesIO(); img.save(b, "PCX")\nprint(b.getvalue().hex())') },
    { id: 'v2-pcx-zero', split: 'holdout', st: '輸入一行十六進位，是一個 PCX 檔。數出位元組值等於 0 的個數，十進位輸出。',
        ref: REF('print(sum(1 for b_ in data if b_ == 0))'),
        gen: GEN(PILPRE + 'w, h = random.randint(2, 12), random.randint(2, 12)\nimg = Image.new("L", (w, h))\nimg.putdata([random.choice([0, 0, 200, 9]) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "PCX")\nprint(b.getvalue().hex())') },
    // ── JPEG ──
    { id: 'v2-jpg-soi', split: 'holdout', st: '輸入一行十六進位，是一個 JPEG 檔。計算標記「ff d8」出現的次數，不重疊，十進位輸出。',
        ref: REF('print(data.count(bytes([255, 216])))'),
        gen: GEN(PILPRE + 'w, h = random.randint(8, 24), random.randint(8, 24)\nimg = Image.new("L", (w, h))\nimg.putdata([random.randint(0, 255) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "JPEG", quality=80)\nprint(b.getvalue().hex())') },
    { id: 'v2-jpg-app0', split: 'holdout', st: '輸入一行十六進位，是一個 JPEG 檔。位移 4 起的 2 個位元組是 APP0 區段的長度（大端、無號）。請輸出這個長度，十進位。',
        ref: REF('print(int.from_bytes(data[4:6], "big", signed=False))'),
        gen: GEN(PILPRE + 'w, h = random.randint(8, 24), random.randint(8, 24)\nimg = Image.new("RGB", (w, h))\nb = io.BytesIO(); img.save(b, "JPEG", quality=70)\nprint(b.getvalue().hex())') },
    { id: 'v2-jpg-ff', split: 'holdout', st: '輸入一行十六進位，是一個 JPEG 檔。數出位元組值為 0xff 的個數，十進位輸出。',
        ref: REF('print(sum(1 for b_ in data if b_ == 255))'),
        gen: GEN(PILPRE + 'w, h = random.randint(8, 20), random.randint(8, 20)\nimg = Image.new("L", (w, h))\nimg.putdata([random.choice([255, 255, 3]) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "JPEG", quality=90)\nprint(b.getvalue().hex())') },
    // ── gzip ──
    { id: 'v2-gz-mtime', split: 'holdout', st: '輸入一行十六進位，是一個 gzip 檔。位移 4 起的 4 個位元組是修改時間（小端、無號）。請輸出它，十進位。',
        ref: REF('print(int.from_bytes(data[4:8], "little", signed=False))'),
        gen: GEN(PRE + 'mt = random.randint(1000000, 2000000000)\nbuf = io.BytesIO()\nwith gzip.GzipFile(fileobj=buf, mode="wb", mtime=mt) as g:\n    g.write(b"gzip header probe")\nprint(buf.getvalue().hex())') },
    { id: 'v2-gz-xfl', split: 'holdout', st: '輸入一行十六進位，是一個 gzip 檔。位移 8 的位元組是額外旗標 XFL，長度 1，無號。請輸出它，十進位。',
        ref: REF('print(data[8])'),
        gen: GEN(PRE + 'lv = random.choice([1, 6, 9])\nbuf = io.BytesIO()\nwith gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=lv, mtime=0) as g:\n    g.write(b"xfl probe")\nprint(buf.getvalue().hex())') },
    { id: 'v2-gz-magic', split: 'holdout', st: '輸入一行十六進位，是一個 gzip 檔。計算標記「1f 8b」（gzip 魔術數字）出現的次數，不重疊，十進位輸出。',
        ref: REF('print(data.count(bytes([31, 139])))'),
        gen: GEN(PRE + 'buf = io.BytesIO()\nwith gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as g:\n    g.write(bytes(random.choice([31, 139, 0]) for _ in range(random.randint(1, 60))))\nprint(buf.getvalue().hex())') },
    // ── zlib（標頭與位元組值）──
    { id: 'v2-zl-u16', split: 'holdout', st: '輸入一行十六進位，是一段 zlib 資料。位移 0 起的兩個位元組，依大端讀成無號整數（即 CMF 與 FLG 合成的值）。請輸出它，十進位。',
        ref: REF('print(int.from_bytes(data[0:2], "big", signed=False))'),
        gen: GEN(PRE + 'n = random.randint(1, 120)\nd = bytes(random.randint(0, 255) for _ in range(n))\nprint(zlib.compress(d, random.choice([1, 6, 9])).hex())') },
    { id: 'v2-zl-flg', split: 'holdout', st: '輸入一行十六進位，是一段 zlib 資料。位移 1、長度 1 個位元組的 FLG，無號，請輸出它，十進位。',
        ref: REF('print(data[1])'),
        gen: GEN(PRE + 'n = random.randint(1, 120)\nd = bytes(random.randint(0, 255) for _ in range(n))\nprint(zlib.compress(d, random.choice([1, 6, 9])).hex())') },
    { id: 'v2-zl-x78', split: 'holdout', st: '輸入一行十六進位，是一段 zlib 資料。數出位元組值等於 0x78 的個數，十進位輸出。',
        ref: REF('print(sum(1 for b_ in data if b_ == 120))'),
        gen: GEN(PRE + 'n = random.randint(20, 150)\nd = bytes(random.choice([120, 1, 2]) for _ in range(n))\nprint(zlib.compress(d, 6).hex())') }
];

const packsV2 = ['domain_inflate_core.js', 'domain_tarx_core.js', 'domain_bmpx_core.js', 'domain_png_core.js', 'domain_gif_core.js', 'domain_pcx_core.js', 'domain_jpeg_core.js'].map((f) => require('./' + f));
packsV2.push(require('./domain_binfmt_core.js'), require('./domain_fieldcount_core.js'));
H.main({ name: '乾淨 holdout v2（凍結，只量一次）', packs: packsV2, seeds: SEEDS, minSkeletons: 2, judge: { checker: 'tokens', timeoutMs: 60000 } });
