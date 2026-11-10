'use strict';
// 領域包「LZMA 完整流程」：輸入是 Python 標準庫 lzma 真的壓出來的十六進位字串，期望輸出也由標準庫 lzma 解壓得出（獨立參考解）。
// train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。
const cp = require('child_process');
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const LZ = require('./domain_lzma_core.js');
const PY = process.env.FA_PYTHON || 'python3';
const py = (src) => { const r = cp.spawnSync(PY, ['-I', '-c', src], { encoding: 'utf8', timeout: 30000 }); if (r.status !== 0) throw new Error('python 失敗：' + r.stderr); return r.stdout.trim(); };
// 產生壓縮後的十六進位字串。kind：text（有重複詞，會有 match）／code（有 E8／E9 的 x86 風格位元組）；fmt：alone／raw／xz；flt：濾鏡鏈
const GENPY = (kind, fmt, flt, big, seed, text) => 'import lzma, random\nrandom.seed(' + seed + ')\nkind = ' + JSON.stringify(kind) + '\nn = random.randint(' + (big ? '300, 6000' : '20, 400') + ')\n' +
    'if kind == "text":\n    ws = ["ab", "lzma", "xz", "stream", "the", "bit", "tree", "zz", "q", "hello", "world", "range", "coder"]\n    raw = (" ".join(random.choice(ws) for _ in range(n // 4 + 1)))[:n].encode()\n' +
    'else:\n    b = bytearray()\n    while len(b) < n:\n        t = random.random()\n        if t < 0.25:\n            b += bytes([0xE8]) + (random.randint(-5000, 5000) & 0xFFFFFFFF).to_bytes(4, "little")\n        elif t < 0.3:\n            b += bytes([0xE9]) + (random.randint(-90, 90) & 0xFFFFFFFF).to_bytes(4, "little")\n        else:\n            b += bytes(random.choice([0x55, 0x89, 0xE5, 0x00, 0xFF, 0x8B, 0x45]) for _ in range(random.randint(1, 6)))\n    raw = bytes(b[:n])\n' +
    'fl = ' + flt + '\n' +
    (fmt === 'alone' ? 'o = lzma.compress(raw, format=lzma.FORMAT_ALONE, filters=[{"id": lzma.FILTER_LZMA1, "preset": random.choice([0, 1, 6]), "lc": random.choice([0, 3]), "lp": random.choice([0, 1]), "pb": random.choice([0, 2, 4])}])\n' :
        fmt === 'raw' ? 'o = lzma.compress(raw, format=lzma.FORMAT_RAW, filters=fl)\n' : 'o = lzma.compress(raw, format=lzma.FORMAT_XZ, check=random.choice([lzma.CHECK_NONE, lzma.CHECK_CRC32, lzma.CHECK_CRC64, lzma.CHECK_SHA256]), filters=fl)\n') + 'print(o.hex())\n';
const X86 = '[{"id": lzma.FILTER_X86}, {"id": lzma.FILTER_LZMA2, "preset": 1}]', L2 = '[{"id": lzma.FILTER_LZMA2, "preset": random.choice([0, 1, 6]), "lc": 3, "lp": 0, "pb": 2}]', DEL = '[{"id": lzma.FILTER_DELTA, "dist": 2}, {"id": lzma.FILTER_LZMA2}]';
const gen = (kind, fmt, flt) => (b) => py(GENPY(kind, fmt, flt, b, rnd(1, 1e9))) + '\n';
const RAWF = (flt) => 'filters=' + flt;
const refHex = (call, tail) => 'import sys, lzma\nd = bytes.fromhex(sys.stdin.read().strip())\n' + call + '\nprint(' + tail + ')\n';
const REF_ALONE = (t) => refHex('r = lzma.decompress(d, format=lzma.FORMAT_ALONE)', t === 'text' ? 'r.decode()' : 'r.hex()');
const REF_L2 = (t) => refHex('r = lzma.decompress(d, format=lzma.FORMAT_RAW, filters=[{"id": lzma.FILTER_LZMA2, "dict_size": 1 << 22}])', t === 'text' ? 'r.decode()' : 'r.hex()');
const REF_L2B = (t) => refHex('r = lzma.decompress(d, format=lzma.FORMAT_RAW, filters=[{"id": lzma.FILTER_X86}, {"id": lzma.FILTER_LZMA2, "dict_size": 1 << 22}])', t === 'text' ? 'r.decode()' : 'r.hex()');
const REF_XZ = (t) => refHex('r = lzma.decompress(d)', t === 'text' ? 'r.decode()' : 'r.hex()');

const SEEDS = [
    { id: 'alone-hex', want: 'lz.alone', st: '輸入一行十六進位字串，是一個 LZMA alone（.lzma）檔的全部位元組。請解壓縮，輸出還原後資料的十六進位（小寫、不加空白）。', ref: REF_ALONE('hex'), gen: gen('text', 'alone', '[]') },
    { id: 'alone-text', want: 'lz.alone', st: '輸入一行十六進位字串，是一個 .lzma 檔（LZMA alone 格式：13 位元組檔頭加範圍編碼串流）的內容。請解壓縮，輸出還原的 UTF-8 文字。', ref: REF_ALONE('text'), gen: gen('text', 'alone', '[]') },
    { id: 'lzma2-hex', want: 'lz.lzma2', st: '輸入一行十六進位字串，是一段 LZMA2 原始串流（沒有 xz 容器，以控制位元組 0 結尾）。請解碼，輸出還原後資料的十六進位（小寫、不加空白）。', ref: REF_L2('hex'), gen: gen('text', 'raw', L2) },
    { id: 'lzma2-text', want: 'lz.lzma2', st: '輸入一行十六進位字串，是一段 LZMA2 原始串流（含未壓縮區塊與 LZMA 區塊，最後一個控制位元組是 0）。請解壓縮，輸出還原的文字。', ref: REF_L2('text'), gen: gen('text', 'raw', L2) },
    { id: 'bcj-hex', want: 'lz.lzma2-bcj', st: '輸入一行十六進位字串，是先經過 x86 BCJ 過濾、再用 LZMA2 壓縮的原始串流。請先解 LZMA2、再做 BCJ 解碼，輸出原始資料的十六進位（小寫、不加空白）。', ref: REF_L2B('hex'), gen: gen('code', 'raw', X86) },
    { id: 'xz-hex', want: 'lz.xz-decode', st: '輸入一行十六進位字串，是一個 xz 檔案（單一串流、單一區塊，濾鏡鏈可能是 x86 BCJ 加 LZMA2、delta 加 LZMA2 或只有 LZMA2）。請解壓縮，輸出還原資料的十六進位（小寫、不加空白）。', ref: REF_XZ('hex'), gen: (b) => py(GENPY(pick(['text', 'code']), 'xz', pick([X86, L2, DEL]), b, rnd(1, 1e9))) + '\n' },
    { id: 'xz-text', want: 'lz.xz-decode', st: '輸入一行十六進位字串，是一個 xz 容器檔案（串流標頭、一個區塊、索引與頁尾；區塊的濾鏡鏈裡最後一個是 LZMA2）。請解壓縮，輸出還原的文字。', ref: REF_XZ('text'), gen: gen('text', 'xz', L2) },
    // holdout：另寫措辭（不同動詞、不同輸出說法、不同檔案稱呼），只量測
    { id: 'ho-alone', split: 'holdout', st: '給一行十六進位，內容是 LZMA alone 格式的壓縮檔。把它還原成原本的位元組，用十六進位印出（小寫，中間不要空格）。', ref: REF_ALONE('hex'), gen: gen('code', 'alone', '[]') },
    { id: 'ho-lzma2', split: 'holdout', st: '輸入一行十六進位字串，這是沒有外層容器的 LZMA2 串流。把它還原，印出十六進位（小寫、不加空白）。', ref: REF_L2('hex'), gen: gen('code', 'raw', L2) },
    { id: 'ho-xz', split: 'holdout', st: '輸入一行十六進位字串，代表一個 .xz 壓縮檔（只有一個區塊）。請把檔案還原成原始內容，用小寫十六進位印出，不要空白。', ref: REF_XZ('hex'), gen: gen('code', 'xz', X86) }
];
H.main({ name: '領域包 lzma', packs: [LZ], seeds: SEEDS, minSkeletons: 4, judge: { checker: 'tokens', timeoutMs: 60000 } });
