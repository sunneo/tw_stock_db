'use strict';
// 乾淨的 holdout（凍結後只量一次，2026-11-12，blockly-finish-3 續）。
// 規則：這 27 題的措辭與題型是在「沒有讀過既有 train／holdout 敘述的修補」之後，依規格另寫的；
//   題型刻意與舊 train／舊 holdout 不同（以欄位查詢、計數、統計為主，不是「解碼成文字」）。
//   數字只能量一次。量完若未解，根因寫進 DESIGN.blockly-gaps.md；之後的教法調整只能用新的 train 題，不得再碰這批。
// 參考解：Python 標準函式庫（zlib、gzip、tarfile、struct）與 Pillow（只用在 BMP／PNG／GIF／PCX／JPEG 的像素讀取）。
// 測資由 Python 產生器依隨機種子產生（種子由 harness 的 rnd 給）。
const cp = require('child_process');
const H = require('./domain_harness.js'); const { rnd } = H;
const PY = process.env.FA_PYTHON || 'python3';
const runPy = (src, seed) => { const r = cp.spawnSync(PY, ['-I', '-c', src, String(seed)], { encoding: 'utf8', timeout: 60000 }); if (r.status !== 0) throw new Error('python 失敗：' + r.stderr.slice(0, 300)); return r.stdout.trim(); };
// 產生器：以 harness 的 rnd 取種子，回傳一行十六進位輸入
const GEN = (src) => (b, o) => runPy(src, o.rnd(1, 2000000000));
// 參考解：標準輸入是十六進位，標準輸出是答案
const REF = (body) => 'import sys\nimport io, struct, zlib, gzip, tarfile\ndata = bytes.fromhex(sys.stdin.read().strip())\n' + body + '\n';
const PRE = 'import sys, random, io, struct, zlib, gzip, tarfile\nrandom.seed(int(sys.argv[1]))\n';

const SEEDS = [
    // ── inflate（zlib／DEFLATE 層）──
    { id: 'fz-len', split: 'holdout', st: '輸入一行十六進位，是一段 zlib 資料。請輸出解壓後的位元組長度，一個十進位整數。',
        ref: REF('print(len(zlib.decompress(data)))'),
        gen: GEN(PRE + 'n = random.randint(0, 3000)\nd = bytes(random.randint(0, 255) for _ in range(n))\nprint(zlib.compress(d, random.choice([1, 6, 9])).hex())') },
    { id: 'fg-head5', split: 'holdout', st: '輸入一行十六進位，是一個 gzip 檔。請輸出解壓後的前 5 個位元組，小寫十六進位，不要空白。',
        ref: REF('print(gzip.decompress(data)[:5].hex())'),
        gen: GEN(PRE + 'n = random.randint(6, 2000)\nd = bytes(random.choice(b"abcdef\\n") for _ in range(n))\nprint(gzip.compress(d, mtime=0).hex())') },
    { id: 'fr-dec', split: 'holdout', st: '輸入一行十六進位，是一段原始 DEFLATE 串流（沒有 zlib 或 gzip 外殼）。請把解壓後的每個位元組以十進位輸出，空格隔開。',
        ref: REF('print(" ".join(str(x) for x in zlib.decompress(data, -15)))'),
        gen: GEN(PRE + 'n = random.randint(1, 40)\nd = bytes(random.randint(0, 255) for _ in range(n))\nc = zlib.compressobj(6, zlib.DEFLATED, -15)\nprint((c.compress(d) + c.flush()).hex())') },
    // ── tar ──
    { id: 'ta-size', split: 'holdout', st: '輸入一行十六進位，是一個 tar 封存檔。請依封存中的順序，列出每個一般檔案（不含目錄）的位元組大小，每行一個十進位整數。',
        ref: REF('t = tarfile.open(fileobj=io.BytesIO(data), mode="r")\nfor m in t.getmembers():\n    if m.isfile(): print(m.size)'),
        gen: GEN(PRE + 'buf = io.BytesIO()\nt = tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT)\nfor i in range(random.randint(2, 4)):\n    d = bytes(random.randint(0, 255) for _ in range(random.randint(0, 300)))\n    info = tarfile.TarInfo("f%d.bin" % i); info.size = len(d); info.mtime = 0\n    t.addfile(info, io.BytesIO(d))\nt.close()\nprint(buf.getvalue().hex())') },
    { id: 'ta-second', split: 'holdout', st: '輸入一行十六進位，是一個 tar 封存檔，至少有兩個檔案。請輸出第二個成員的內容，小寫十六進位，不要空白。',
        ref: REF('t = tarfile.open(fileobj=io.BytesIO(data), mode="r")\nms = t.getmembers()\nprint(t.extractfile(ms[1]).read().hex())'),
        gen: GEN(PRE + 'buf = io.BytesIO()\nt = tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT)\nfor i in range(3):\n    d = bytes(random.randint(1, 255) for _ in range(random.randint(1, 60)))\n    info = tarfile.TarInfo("g%d" % i); info.size = len(d); info.mtime = 0\n    t.addfile(info, io.BytesIO(d))\nt.close()\nprint(buf.getvalue().hex())') },
    { id: 'ta-count', split: 'holdout', st: '輸入一行十六進位，是一個 tar 封存檔。請輸出封存中成員的總數（目錄與檔案都算），一個十進位整數。',
        ref: REF('t = tarfile.open(fileobj=io.BytesIO(data), mode="r")\nprint(len(t.getmembers()))'),
        gen: GEN(PRE + 'buf = io.BytesIO()\nt = tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT)\nfor i in range(random.randint(1, 5)):\n    d = bytes(random.randint(0, 255) for _ in range(random.randint(0, 80)))\n    info = tarfile.TarInfo("h%d" % i); info.size = len(d); info.mtime = 0\n    t.addfile(info, io.BytesIO(d))\nt.close()\nprint(buf.getvalue().hex())') },
    // ── BMP ──
    { id: 'bm-wh', split: 'holdout', st: '輸入一行十六進位，是一個未壓縮的 BMP 檔。請輸出影像的寬與高，以空格隔開，寬在前。',
        ref: REF('w, h = struct.unpack_from("<ii", data, 18)\nprint(w, h)'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(1, 40), random.randint(1, 40)\nimg = Image.new("RGB", (w, h))\nimg.putdata([(random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "BMP")\nprint(b.getvalue().hex())') },
    { id: 'bm-topleft', split: 'holdout', st: '輸入一行十六進位，是一個 24 位元 BMP 檔。請輸出左上角像素的紅、綠、藍值，三個十進位整數，以空格隔開。',
        ref: REF('from PIL import Image\nimg = Image.open(io.BytesIO(data)).convert("RGB")\nprint(*img.getpixel((0, 0)))'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(1, 30), random.randint(1, 30)\nimg = Image.new("RGB", (w, h))\nimg.putdata([(random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "BMP")\nprint(b.getvalue().hex())') },
    { id: 'bm-off', split: 'holdout', st: '輸入一行十六進位，是一個 BMP 檔。請輸出檔頭中「像素資料起點」的位元組偏移量（小端 4 位元組讀出），十進位整數。',
        ref: REF('print(struct.unpack_from("<I", data, 10)[0])'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(1, 20), random.randint(1, 20)\nimg = Image.new("P", (w, h))\npal = []\nfor i in range(256): pal += [i, 255 - i, (i * 7) % 256]\nimg.putpalette(pal)\nimg.putdata([random.randint(0, 255) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "BMP")\nprint(b.getvalue().hex())') },
    // ── PNG ──
    { id: 'pn-depth', split: 'holdout', st: '輸入一行十六進位，是一個 PNG 檔。請輸出 IHDR 中的位元深度與色彩型別，以空格隔開，位元深度在前。',
        ref: REF('print(data[24], data[25])'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(1, 20), random.randint(1, 20)\nimg = Image.new("L", (w, h))\nimg.putdata([random.randint(0, 255) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "PNG")\nprint(b.getvalue().hex())') },
    { id: 'pn-area', split: 'holdout', st: '輸入一行十六進位，是一個 PNG 檔。請輸出影像的寬乘以高，一個十進位整數。',
        ref: REF('w, h = struct.unpack_from(">II", data, 16)\nprint(w * h)'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(1, 30), random.randint(1, 30)\nimg = Image.new("RGB", (w, h))\nimg.putdata([(random.randint(0, 255), 0, 0) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "PNG")\nprint(b.getvalue().hex())') },
    { id: 'pn-row0', split: 'holdout', st: '輸入一行十六進位，是一個灰階 PNG 檔。請輸出第一列（最上面一列）的所有像素值，每個是十進位，以空格隔開，由左到右。',
        ref: REF('from PIL import Image\nimg = Image.open(io.BytesIO(data)).convert("L")\nw, h = img.size\nprint(" ".join(str(img.getpixel((x, 0))) for x in range(w)))'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(1, 25), random.randint(1, 25)\nimg = Image.new("L", (w, h))\nimg.putdata([random.randint(0, 255) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "PNG")\nprint(b.getvalue().hex())') },
    // ── GIF ──
    { id: 'gf-screen', split: 'holdout', st: '輸入一行十六進位，是一個 GIF 檔。請輸出邏輯螢幕的寬與高，以空格隔開，寬在前，兩者都是小端 2 位元組讀出。',
        ref: REF('w, h = struct.unpack_from("<HH", data, 6)\nprint(w, h)'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(1, 30), random.randint(1, 30)\nimg = Image.new("P", (w, h))\npal = []\nfor i in range(4): pal += [i * 60, 0, 255 - i * 60]\nimg.putpalette(pal)\nimg.putdata([random.randint(0, 3) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "GIF")\nprint(b.getvalue().hex())') },
    { id: 'gf-pal0', split: 'holdout', st: '輸入一行十六進位，是一個 GIF 檔，全域調色盤至少有一個顏色。請輸出調色盤第 0 個顏色的紅、綠、藍值，三個十進位整數，以空格隔開。',
        ref: REF('from PIL import Image\nimg = Image.open(io.BytesIO(data)).convert("RGB")\nprint(*img.getpixel((0, 0)))'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = 1, 1\nimg = Image.new("P", (w, h))\npal = [random.randint(0, 255) for _ in range(3)]\nimg.putpalette(pal + [0] * (3 * 255))\nimg.putdata([0])\nb = io.BytesIO(); img.save(b, "GIF")\nprint(b.getvalue().hex())') },
    { id: 'gf-frames', split: 'holdout', st: '輸入一行十六進位，是一個 GIF 動畫檔。請輸出影格數，一個十進位整數。',
        ref: REF('from PIL import Image\nprint(Image.open(io.BytesIO(data)).n_frames)'),
        gen: GEN(PRE + 'from PIL import Image\nfs = [Image.new("P", (4, 4)) for _ in range(random.randint(2, 4))]\nfor f in fs: f.putpalette([random.randint(0, 255) for _ in range(768)])\nb = io.BytesIO(); fs[0].save(b, "GIF", save_all=True, append_images=fs[1:])\nprint(b.getvalue().hex())') },
    // ── PCX ──
    { id: 'pc-wh', split: 'holdout', st: '輸入一行十六進位，是一個 PCX 檔。請由視窗欄位（XMin、YMin、XMax、YMax，小端 2 位元組）算出寬與高，以空格隔開，寬在前。',
        ref: REF('xmin, ymin, xmax, ymax = struct.unpack_from("<HHHH", data, 4)\nprint(xmax - xmin + 1, ymax - ymin + 1)'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(1, 30), random.randint(1, 30)\nimg = Image.new("RGB", (w, h))\nimg.putdata([(random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "PCX")\nprint(b.getvalue().hex())') },
    { id: 'pc-bpp', split: 'holdout', st: '輸入一行十六進位，是一個 PCX 檔。請輸出每像素位元數與平面數，兩個十進位整數，以空格隔開，位元數在前（分別是檔頭第 3 位元組與第 65 位元組）。',
        ref: REF('print(data[3], data[65])'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(1, 20), random.randint(1, 20)\nimg = Image.new("RGB", (w, h))\nimg.putdata([(random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "PCX")\nprint(b.getvalue().hex())') },
    { id: 'pc-topleft', split: 'holdout', st: '輸入一行十六進位，是一個 PCX 檔（24 位元 RGB）。請輸出左上角像素的紅、綠、藍值，三個十進位整數，以空格隔開。',
        ref: REF('from PIL import Image\nimg = Image.open(io.BytesIO(data)).convert("RGB")\nprint(*img.getpixel((0, 0)))'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(1, 20), random.randint(1, 20)\nimg = Image.new("RGB", (w, h))\nimg.putdata([(random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "PCX")\nprint(b.getvalue().hex())') },
    // ── JPEG ──
    { id: 'jp-wh', split: 'holdout', st: '輸入一行十六進位，是一個 JPEG 檔（基線 SOF0）。請找出 SOF0 區段，輸出影像的寬與高，以空格隔開，寬在前。',
        ref: REF('i = data.index(b"\\xff\\xc0")\ny, x = struct.unpack_from(">HH", data, i + 5)\nprint(x, y)'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(8, 40), random.randint(8, 40)\nimg = Image.new("L", (w, h))\nimg.putdata([random.randint(0, 255) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "JPEG", quality=90)\nprint(b.getvalue().hex())') },
    { id: 'jp-comp', split: 'holdout', st: '輸入一行十六進位，是一個 JPEG 檔（基線 SOF0）。請輸出影像的色彩元件數（SOF0 中的元件數），一個十進位整數。',
        ref: REF('i = data.index(b"\\xff\\xc0")\nprint(data[i + 9])'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(8, 30), random.randint(8, 30)\nmode = random.choice(["L", "RGB"])\nimg = Image.new(mode, (w, h))\nimg.putdata([random.randint(0, 255) if mode == "L" else (random.randint(0, 255), 1, 2) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "JPEG", quality=90)\nprint(b.getvalue().hex())') },
    { id: 'jp-dht', split: 'holdout', st: '輸入一行十六進位，是一個 JPEG 檔。請輸出檔中霍夫曼表區段（標記 FFC4）的出現次數，一個十進位整數。',
        ref: REF('print(data.count(b"\\xff\\xc4"))'),
        gen: GEN(PRE + 'from PIL import Image\nw, h = random.randint(8, 30), random.randint(8, 30)\nimg = Image.new("L", (w, h))\nimg.putdata([random.randint(0, 255) for _ in range(w * h)])\nb = io.BytesIO(); img.save(b, "JPEG", quality=75)\nprint(b.getvalue().hex())') },
    // ── gzip（標頭欄位）──
    { id: 'gz-name', split: 'holdout', st: '輸入一行十六進位，是一個 gzip 檔，標頭有檔名欄位。請輸出檔名（不含結尾的 0 位元組），以文字輸出。',
        ref: REF('i = 10\nif data[3] & 0x08:\n    j = data.index(b"\\x00", i)\n    print(data[i:j].decode("latin-1"))'),
        gen: GEN(PRE + 'names = ["notes", "data1", "abc_x"]\nbuf = io.BytesIO()\nwith gzip.GzipFile(filename=random.choice(names) + ".txt", mode="wb", fileobj=buf, mtime=0) as g:\n    g.write(bytes(random.randint(65, 90) for _ in range(20)))\nprint(buf.getvalue().hex())') },
    { id: 'gz-mtime', split: 'holdout', st: '輸入一行十六進位，是一個 gzip 檔。請輸出標頭中的修改時間（位元組 4 到 7，小端讀出），一個十進位整數。',
        ref: REF('print(struct.unpack_from("<I", data, 4)[0])'),
        gen: GEN(PRE + 'mt = random.randint(1000000, 2000000000)\nbuf = io.BytesIO()\nwith gzip.GzipFile(fileobj=buf, mode="wb", mtime=mt) as g:\n    g.write(b"hello gzip")\nprint(buf.getvalue().hex())') },
    { id: 'gz-isize', split: 'holdout', st: '輸入一行十六進位，是一個 gzip 檔。請輸出尾端 ISIZE 欄位（最後 4 個位元組，小端讀出），即原始內容的位元組數，一個十進位整數。',
        ref: REF('print(struct.unpack_from("<I", data, len(data) - 4)[0])'),
        gen: GEN(PRE + 'n = random.randint(1, 700)\nbuf = io.BytesIO()\nwith gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as g:\n    g.write(bytes(random.randint(0, 255) for _ in range(n)))\nprint(buf.getvalue().hex())') },
    // ── zlib（標頭與校驗）──
    { id: 'zl-head', split: 'holdout', st: '輸入一行十六進位，是一段 zlib 資料。請輸出前兩個位元組（zlib 標頭）的小寫十六進位，不要空白。',
        ref: REF('print(data[:2].hex())'),
        gen: GEN(PRE + 'n = random.randint(1, 200)\nd = bytes(random.randint(0, 255) for _ in range(n))\nprint(zlib.compress(d, random.choice([1, 6, 9])).hex())') },
    { id: 'zl-adler', split: 'holdout', st: '輸入一行十六進位，是一段 zlib 資料。請輸出尾端 Adler-32 校驗值（最後 4 個位元組，大端讀出），十進位整數。',
        ref: REF('print(struct.unpack_from(">I", data, len(data) - 4)[0])'),
        gen: GEN(PRE + 'n = random.randint(1, 500)\nd = bytes(random.randint(0, 255) for _ in range(n))\nprint(zlib.compress(d, 6).hex())') },
    { id: 'zl-crc', split: 'holdout', st: '輸入一行十六進位，是一段 zlib 資料。請把它解壓縮後，計算原始內容的 CRC-32 值，十進位整數輸出。',
        ref: REF('print(zlib.crc32(zlib.decompress(data)) & 0xffffffff)'),
        gen: GEN(PRE + 'n = random.randint(1, 400)\nd = bytes(random.randint(0, 255) for _ in range(n))\nprint(zlib.compress(d, 9).hex())') },
];

// 只量測，不教：harness 的 holdout 路徑只印解出數與未解題；train 為 0 題。
const packs = ['domain_inflate_core.js', 'domain_tarx_core.js', 'domain_bmpx_core.js', 'domain_png_core.js', 'domain_gif_core.js', 'domain_pcx_core.js', 'domain_jpeg_core.js'].map((f) => require('./' + f));
H.main({ name: '乾淨 holdout（凍結，只量一次）', packs, seeds: SEEDS, minSkeletons: 2, judge: { checker: 'tokens', timeoutMs: 60000 } });
