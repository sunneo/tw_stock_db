'use strict';
// 乾淨 holdout v3（2026-11-12，blockly-finish-3 續六）。只量一次；量完不重試、不改題目、判準、參考解或教法。
// ── 凍結判準（提交於量測前；提交後不改。事後修改須在 DESIGN.blockly-gaps.md §14 標明「事後」並另列數字）──
//   1. 題數 27：inflate 3、tar 3、BMP 3、PNG 3、GIF 3、PCX 3、JPEG 3、gzip 3、zlib 3。
//   2. 題型：原始位元組上的固定位移欄位讀取，與位元組標記出現次數／位元組值個數。措辭與 train（domain_fieldcount.test.js）與 v2（domain_fresh_holdout_v2.test.js，已被看過）都不同；
//      有的刻意只用「偏移」「位移 N 處」「統計」「出現幾次」等說法，有的寫法與 train 近似，不做人工挑選。
//   3. 測資：參考解用 Python 標準函式庫（zlib、gzip、tarfile、struct）與 Pillow 產生檔案與答案；隨機種子由 harness 給。
//   4. 判準：原敘述（無改寫、無選項反序）由 harness 產生的測資全部 AC，且在 holdout 路徑計為解出；不指定範式。
//   5. 系統：註冊的包與 v2 相同（fieldcount＋既有 7 個格式包＋binfmt），讀取器觸發詞為 2026-11-12 續五放寬後的版本。
//   6. 只量測一次；未解的題照實列出 harness 回報的原因。
const cp = require('child_process');
const H = require('./domain_harness.js'); const { rnd } = H;
const PY = process.env.FA_PYTHON || 'python3';
const runPy = (src, seed) => { const r = cp.spawnSync(PY, ['-I', '-c', src, String(seed)], { encoding: 'utf8', timeout: 60000 }); if (r.status !== 0) throw new Error('python 失敗：' + r.stderr.slice(0, 300)); return r.stdout.trim(); };
const GEN = (src) => (b, o) => runPy(src, o.rnd(1, 2000000000));
const REF = (body) => 'import sys\nimport io, struct, zlib, gzip, tarfile\ndata = bytes.fromhex(sys.stdin.read().strip())\n' + body + '\n';
const PRE = 'import sys, random, io, struct, zlib, gzip, tarfile\nrandom.seed(int(sys.argv[1]))\n';
const PILPRE = PRE + 'from PIL import Image\n';

const SEEDS = [
    // inflate
    { id: 'v3-zl-cmf', split: 'holdout', st: '輸入一行十六進位，是一段 zlib 資料。偏移 0 的 1 個位元組是 CMF，無號，十進位輸出。',
        ref: REF('print(data[0])'),
        gen: GEN(PRE + 'n = random.randint(1, 300)\nd = bytes(random.randint(0, 255) for _ in range(n))\nprint(zlib.compress(d, random.choice([1, 6, 9])).hex())') },
    { id: 'v3-zl-sync2', split: 'holdout', st: '輸入一行十六進位，是一段 zlib 資料，中間可能有同步清除點。數一數標記「00 00 ff ff」在這段資料裡出現幾次，可以重疊，十進位輸出。',
        ref: REF('print(sum(1 for i in range(len(data) - 3) if data[i:i + 4] == bytes([0, 0, 255, 255])))'),
        gen: GEN(PRE + 'c = zlib.compressobj(6)\nout = c.compress(bytes(random.randint(0, 255) for _ in range(40)))\nfor _ in range(random.randint(0, 3)):\n    out += c.compress(b"xyz" * 4) + c.flush(zlib.Z_SYNC_FLUSH)\nout += c.flush()\nprint(out.hex())') },
    { id: 'v3-raw-nine', split: 'holdout', st: '輸入一行十六進位，是原始 DEFLATE 串流。統計位元組值為 9 的個數，十進位輸出。',
        ref: REF('print(sum(1 for b_ in data if b_ == 9))'),
        gen: GEN(PRE + 'n = random.randint(20, 200)\nd = bytes(random.choice([9, 1, 0, 200]) for _ in range(n))\nc = zlib.compressobj(6, zlib.DEFLATED, -15)\nprint((c.compress(d) + c.flush()).hex())') },
    // tar
    { id: 'v3-tar-ftype', split: 'holdout', st: '輸入一行十六進位，是只含一個檔案的 tar 封存。位移 156 起的 1 位元組是 typeflag，無號，十進位輸出。',
        ref: REF('print(data[156])'),
        gen: GEN(PRE + 'buf = io.BytesIO()\nt = tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT)\nd = bytes(random.randint(0, 255) for _ in range(random.randint(0, 100)))\ninfo = tarfile.TarInfo("one.bin"); info.size = len(d); info.mtime = 0\nt.addfile(info, io.BytesIO(d))\nt.close()\nprint(buf.getvalue().hex())') },
    { id: 'v3-tar-ustar2', split: 'holdout', st: '輸入一行十六進位，是 tar 封存。標記「75 73 74 61 72」在這裡出現幾次，不重疊，十進位輸出。',
        ref: REF('print(data.count(bytes([117, 115, 116, 97, 114])))'),
        gen: GEN(PRE + 'buf = io.BytesIO()\nt = tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT)\nfor i in range(random.randint(1, 4)):\n    d = bytes(random.randint(0, 255) for _ in range(random.randint(0, 60)))\n    info = tarfile.TarInfo("m%d.bin" % i); info.size = len(d); info.mtime = 0\n    t.addfile(info, io.BytesIO(d))\nt.close()\nprint(buf.getvalue().hex())') },
    { id: 'v3-tar-zero2', split: 'holdout', st: '輸入一行十六進位，是 tar 封存。數出位元組值等於 0 的個數，十進位輸出。',
        ref: REF('print(sum(1 for b_ in data if b_ == 0))'),
        gen: GEN(PRE + 'buf = io.BytesIO()\nt = tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT)\nd = bytes(random.randint(1, 255) for _ in range(random.randint(1, 50)))\ninfo = tarfile.TarInfo("z.bin"); info.size = len(d); info.mtime = 0\nt.addfile(info, io.BytesIO(d))\nt.close()\nprint(buf.getvalue().hex())') },
    // BMP
    { id: 'v3-bmp-depth', split: 'holdout', st: '輸入一行十六進位，是 BMP 檔。偏移 28 起的 2 位元組，小端、無號，是每像素位元數，十進位輸出。',
        ref: REF('print(int.from_bytes(data[28:30], "little", signed=False))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 12), random.randint(1, 12)\nmode = random.choice(["1", "L", "RGB"])\nimg = Image.new(mode, (w, h))\nb = io.BytesIO(); img.save(b, "BMP")\nprint(b.getvalue().hex())') },
    { id: 'v3-bmp-w2', split: 'holdout', st: '輸入一行十六進位，是 BMP 檔。欄位寬 4 位元組，位移 18，小端有號，是影像寬度，十進位輸出。',
        ref: REF('print(int.from_bytes(data[18:22], "little", signed=True))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 30), random.randint(1, 30)\nimg = Image.new("RGB", (w, h))\nb = io.BytesIO(); img.save(b, "BMP")\nprint(b.getvalue().hex())') },
    { id: 'v3-bmp-bm2', split: 'holdout', st: '輸入一行十六進位，是 BMP 檔。統計 BM 標記「42 4d」的出現次數，不重疊，十進位輸出。',
        ref: REF('print(data.count(bytes([66, 77])))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 10), random.randint(1, 10)\nimg = Image.new("RGB", (w, h))\nimg.putdata([(random.choice([66, 0]), random.choice([77, 1]), 2) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "BMP")\nprint(b.getvalue().hex())') },
    // PNG
    { id: 'v3-png-w2', split: 'holdout', st: '輸入一行十六進位，是 PNG 檔。位移 16 處的 4 位元組是寬度，大端、無號，十進位輸出。',
        ref: REF('print(int.from_bytes(data[16:20], "big", signed=False))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 40), random.randint(1, 40)\nimg = Image.new("RGB", (w, h))\nb = io.BytesIO(); img.save(b, "PNG")\nprint(b.getvalue().hex())') },
    { id: 'v3-png-bits', split: 'holdout', st: '輸入一行十六進位，是 PNG 檔。位移 24 處長為 1 位元組，表示位元深度，無號，十進位輸出。',
        ref: REF('print(data[24])'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 20), random.randint(1, 20)\nmode = random.choice(["1", "L", "RGB"])\nimg = Image.new(mode, (w, h))\nb = io.BytesIO(); img.save(b, "PNG")\nprint(b.getvalue().hex())') },
    { id: 'v3-png-iend2', split: 'holdout', st: '輸入一行十六進位，是 PNG 檔。計算「49 45 4e 44」出現次數，允許重疊，十進位輸出。',
        ref: REF('print(sum(1 for i in range(len(data) - 3) if data[i:i + 4] == bytes([73, 69, 78, 68])))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 15), random.randint(1, 15)\nimg = Image.new("L", (w, h))\nimg.putdata([random.choice([73, 69, 78, 68, 0]) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "PNG")\nprint(b.getvalue().hex())') },
    // GIF
    { id: 'v3-gif-w3', split: 'holdout', st: '輸入一行十六進位，是 GIF 檔。偏移 6 起共 2 位元組，小端、無號，為邏輯螢幕寬度，十進位輸出。',
        ref: REF('print(int.from_bytes(data[6:8], "little", signed=False))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 60), random.randint(1, 60)\nimg = Image.new("P", (w, h))\nimg.putpalette([0, 0, 0] * 256)\nb = io.BytesIO(); img.save(b, "GIF")\nprint(b.getvalue().hex())') },
    { id: 'v3-gif-pk', split: 'holdout', st: '輸入一行十六進位，是 GIF 檔。位移 10 的 1 位元組，無號，是打包欄位，十進位輸出。',
        ref: REF('print(data[10])'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 8), random.randint(1, 8)\nimg = Image.new("P", (w, h))\nimg.putpalette([random.randint(0, 255) for _ in range(768)])\nb = io.BytesIO(); img.save(b, "GIF")\nprint(b.getvalue().hex())') },
    { id: 'v3-gif-gce2', split: 'holdout', st: '輸入一行十六進位，是 GIF 動畫。標記「21 f9」在檔中出現了幾次，不重疊，十進位輸出。',
        ref: REF('print(data.count(bytes([33, 249])))'),
        gen: GEN(PILPRE + 'fs = [Image.new("P", (4, 4)) for _ in range(random.randint(1, 4))]\nfor f in fs: f.putpalette([random.randint(0, 255) for _ in range(768)])\nb = io.BytesIO(); fs[0].save(b, "GIF", save_all=True, append_images=fs[1:], duration=100)\nprint(b.getvalue().hex())') },
    // PCX
    { id: 'v3-pcx-xmax2', split: 'holdout', st: '輸入一行十六進位，是 PCX 檔。位移 8 起的兩個位元組，依小端讀為無號整數，即 XMax，十進位輸出。',
        ref: REF('print(int.from_bytes(data[8:10], "little", signed=False))'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 40), random.randint(1, 40)\nimg = Image.new("RGB", (w, h))\nb = io.BytesIO(); img.save(b, "PCX")\nprint(b.getvalue().hex())') },
    { id: 'v3-pcx-bpp2', split: 'holdout', st: '輸入一行十六進位，是 PCX 檔。位移 3 處有 1 個位元組，無號，表示每像素位元數，十進位輸出。',
        ref: REF('print(data[3])'),
        gen: GEN(PILPRE + 'w, h = random.randint(1, 12), random.randint(1, 12)\nimg = Image.new("RGB", (w, h))\nb = io.BytesIO(); img.save(b, "PCX")\nprint(b.getvalue().hex())') },
    { id: 'v3-pcx-zero2', split: 'holdout', st: '輸入一行十六進位，是 PCX 檔。統計位元組值為 0 的個數，十進位輸出。',
        ref: REF('print(sum(1 for b_ in data if b_ == 0))'),
        gen: GEN(PILPRE + 'w, h = random.randint(2, 12), random.randint(2, 12)\nimg = Image.new("L", (w, h))\nimg.putdata([random.choice([0, 0, 200, 9]) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "PCX")\nprint(b.getvalue().hex())') },
    // JPEG
    { id: 'v3-jpg-soi2', split: 'holdout', st: '輸入一行十六進位，是 JPEG 檔。計算標記「ff d8」出現的次數，允許重疊，十進位輸出。',
        ref: REF('print(sum(1 for i in range(len(data) - 1) if data[i:i + 2] == bytes([255, 216])))'),
        gen: GEN(PILPRE + 'w, h = random.randint(8, 24), random.randint(8, 24)\nimg = Image.new("L", (w, h))\nimg.putdata([random.randint(0, 255) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "JPEG", quality=80)\nprint(b.getvalue().hex())') },
    { id: 'v3-jpg-app0b', split: 'holdout', st: '輸入一行十六進位，是 JPEG 檔。偏移 4 處起的 2 位元組，大端、無號，是 APP0 區段長度，十進位輸出。',
        ref: REF('print(int.from_bytes(data[4:6], "big", signed=False))'),
        gen: GEN(PILPRE + 'w, h = random.randint(8, 24), random.randint(8, 24)\nimg = Image.new("RGB", (w, h))\nb = io.BytesIO(); img.save(b, "JPEG", quality=70)\nprint(b.getvalue().hex())') },
    { id: 'v3-jpg-ffb', split: 'holdout', st: '輸入一行十六進位，是 JPEG 檔。統計位元組值為 255 的個數，十進位輸出。',
        ref: REF('print(sum(1 for b_ in data if b_ == 255))'),
        gen: GEN(PILPRE + 'w, h = random.randint(8, 20), random.randint(8, 20)\nimg = Image.new("L", (w, h))\nimg.putdata([random.choice([255, 255, 3]) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "JPEG", quality=90)\nprint(b.getvalue().hex())') },
    // gzip
    { id: 'v3-gz-mt2', split: 'holdout', st: '輸入一行十六進位，是 gzip 檔。偏移 4 起長 4 位元組，小端、無號，是修改時間，十進位輸出。',
        ref: REF('print(int.from_bytes(data[4:8], "little", signed=False))'),
        gen: GEN(PRE + 'mt = random.randint(1000000, 2000000000)\nbuf = io.BytesIO()\nwith gzip.GzipFile(fileobj=buf, mode="wb", mtime=mt) as g:\n    g.write(b"gzip header probe")\nprint(buf.getvalue().hex())') },
    { id: 'v3-gz-xfl2', split: 'holdout', st: '輸入一行十六進位，是 gzip 檔。位移 8 處占 1 位元組，無號，是 XFL，十進位輸出。',
        ref: REF('print(data[8])'),
        gen: GEN(PRE + 'lv = random.choice([1, 6, 9])\nbuf = io.BytesIO()\nwith gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=lv, mtime=0) as g:\n    g.write(b"xfl probe")\nprint(buf.getvalue().hex())') },
    { id: 'v3-gz-magic2', split: 'holdout', st: '輸入一行十六進位，是 gzip 檔。數出標記「1f 8b」的次數，不重疊，十進位輸出。',
        ref: REF('print(data.count(bytes([31, 139])))'),
        gen: GEN(PRE + 'buf = io.BytesIO()\nwith gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as g:\n    g.write(bytes(random.choice([31, 139, 0]) for _ in range(random.randint(1, 60))))\nprint(buf.getvalue().hex())') },
    // zlib
    { id: 'v3-zl-u16b', split: 'holdout', st: '輸入一行十六進位，是 zlib 資料。偏移 0 起的 2 位元組依大端讀成無號整數，十進位輸出。',
        ref: REF('print(int.from_bytes(data[0:2], "big", signed=False))'),
        gen: GEN(PRE + 'n = random.randint(1, 120)\nd = bytes(random.randint(0, 255) for _ in range(n))\nprint(zlib.compress(d, random.choice([1, 6, 9])).hex())') },
    { id: 'v3-zl-flg2', split: 'holdout', st: '輸入一行十六進位，是 zlib 資料。位移 1 的位元組是 FLG，長為 1 位元組，無號，十進位輸出。',
        ref: REF('print(data[1])'),
        gen: GEN(PRE + 'n = random.randint(1, 120)\nd = bytes(random.randint(0, 255) for _ in range(n))\nprint(zlib.compress(d, random.choice([1, 6, 9])).hex())') },
    { id: 'v3-zl-count2', split: 'holdout', st: '輸入一行十六進位，是 zlib 資料。統計位元組值為 120 的個數，十進位輸出。',
        ref: REF('print(sum(1 for b_ in data if b_ == 120))'),
        gen: GEN(PRE + 'n = random.randint(20, 150)\nd = bytes(random.choice([120, 1, 2]) for _ in range(n))\nprint(zlib.compress(d, 6).hex())') }
];

H.main({ name: '乾淨 holdout v3（凍結，只量一次）', packs: ['domain_inflate_core.js', 'domain_tarx_core.js', 'domain_bmpx_core.js', 'domain_png_core.js', 'domain_gif_core.js', 'domain_pcx_core.js', 'domain_jpeg_core.js'].map((f) => require('./' + f)).concat([require('./domain_binfmt_core.js'), require('./domain_fieldcount_core.js')]), seeds: SEEDS, minSkeletons: 2, judge: { checker: 'tokens', timeoutMs: 60000 } });
