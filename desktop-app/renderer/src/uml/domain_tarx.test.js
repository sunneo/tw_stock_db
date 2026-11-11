'use strict';
// 領域包「tar 進階」：測資由測試內的 Python 手工組 tar（含 PAX x 標頭、GNU L 長檔名、ustar prefix、PAX size 覆蓋、UTF-8 檔名），
// 期望輸出由 Python 標準庫 tarfile 讀出（獨立參考解）。pax-encode 的參考解是另寫的位數不動點搜尋。
// train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。
const cp = require('child_process');
const H = require('./domain_harness.js'); const { rnd } = H;
const TX = require('./domain_tarx_core.js');
const PY = process.env.FA_PYTHON || 'python3';
const py = (src) => { const r = cp.spawnSync(PY, ['-I', '-c', src], { encoding: 'utf8', timeout: 30000 }); if (r.status !== 0) throw new Error('python 失敗：' + r.stderr); return r.stdout.trim(); };

const BUILD = `
import random, struct
def hdr(name, size, tf, prefix="", sizefield=None):
    b = bytearray(512)
    nb = name.encode("utf-8"); b[0:len(nb)] = nb
    b[100:108] = b"0000644\\x00"; b[108:116] = b"0000000\\x00"; b[116:124] = b"0000000\\x00"
    b[124:136] = ((sizefield if sizefield is not None else ("%011o" % size).encode()) + b"\\x00")[:12]
    b[136:148] = b"00000000000\\x00"; b[148:156] = b"        "; b[156] = ord(tf)
    b[257:263] = b"ustar\\x00"; b[263:265] = b"00"
    pb = prefix.encode("utf-8"); b[345:345 + len(pb)] = pb
    b[148:156] = ("%06o" % sum(b)).encode() + b"\\x00 "
    return bytes(b)
def pad(d): return d + bytes((-len(d)) % 512)
def rec(k, v):
    body = (" " + k + "=" + v + "\\n").encode("utf-8"); n = len(body) + len(str(len(body)))
    if len(str(n)) != len(str(len(body))): n = len(body) + len(str(n))
    return str(n).encode() + body
def pax(recs): return b"".join(rec(k, v) for k, v in recs)
`;
// kind：pax（PAX path，含 UTF-8）、gnu（GNU L 長檔名）、prefix（ustar prefix）、mix（全部混合）、size（PAX size 覆蓋）
const GEN = (kind, seed, big) => BUILD + `
random.seed(${seed})
def word(n): return "".join(random.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(n))
def content(): return bytes(random.randrange(256) for _ in range(random.choice([0, 3, 100, 511, 512, 513, 1100]) if ${big ? 'True' : 'False'} else random.choice([0, 5, 90, 512])))
kind = ${JSON.stringify(kind)}
out = b""
n = random.randint(${big ? '3, 6' : '2, 3'})
for i in range(n):
    k = kind if kind != "mix" else random.choice(["pax", "gnu", "prefix", "plain", "paxu"])
    data = content()
    if k == "plain":
        out += hdr(word(random.randint(3, 20)), len(data), "0") + pad(data)
    elif k == "pax" or k == "paxu":
        d = "/".join(word(random.randint(8, 30)) for _ in range(random.randint(4, 8))) if k == "pax" else "資料/" + word(5) + "/測試檔" + word(3) + ".txt"
        recs = [("path", d)] + ([("mtime", "1700000000.123456")] if random.random() < 0.5 else []) + ([("uname", "使用者" + word(2))] if random.random() < 0.3 else [])
        px = pax(recs)
        out += hdr("PaxHeaders/x", len(px), "x") + pad(px) + hdr(d[-90:] if k == "pax" else word(8), len(data), "0") + pad(data)
    elif k == "gnu":
        d = "/".join(word(random.randint(8, 30)) for _ in range(random.randint(4, 8))) + "\\x00"
        db = d.encode()
        out += hdr("././@LongLink", len(db), "L") + pad(db) + hdr(d[:99], len(data), "0") + pad(data)
    elif k == "prefix":
        pre = "/".join(word(random.randint(5, 20)) for _ in range(random.randint(2, 5)))
        out += hdr(word(random.randint(5, 30)), len(data), "0", pre) + pad(data)
    else:   # size：PAX size 覆蓋，標頭 size 欄寫 0，資料區長度以 PAX 為準
        px = pax([("size", str(len(data)))])
        nm = word(10)
        out += hdr("PaxHeaders/y", len(px), "x") + pad(px) + hdr(nm, 0, "0") + pad(data)
out += bytes(1024)
print(out.hex())
`;
const gen = (kind) => (b) => py(GEN(kind, rnd(1, 1e9), b)) + '\n';
const LIST = (fmt) => 'import sys, tarfile, io\nt = tarfile.open(fileobj=io.BytesIO(bytes.fromhex(sys.stdin.read().strip())))\nfor m in t:\n    print(' + fmt + ')\n';
const REF_NS = LIST('m.name, m.size'), REF_SN = LIST('m.size, m.name'), REF_N = LIST('m.name');
const REF_REC = (ord) => 'import sys, tarfile, io\nt = tarfile.open(fileobj=io.BytesIO(bytes.fromhex(sys.stdin.read().strip())))\nfor m in t:\n    if m.pax_headers:\n        for k, v in ' + (ord === 'sorted' ? 'sorted(m.pax_headers.items())' : 'm.pax_headers.items()') + ':\n            print(k + "=" + v)\n        break\n';
const GEN_REC = (b) => py(GEN('pax', rnd(1, 1e9), b) + '\n') + '\n';
// pax-encode：輸入「n」加 n 行「key value」
const genEnc = (b) => {
    const ws = ['path', 'mtime', 'uname', 'gname', 'comment', 'linkpath']; const n = rnd(1, b ? 5 : 3); const lines = [];
    for (let i = 0; i < n; i++) { const k = ws[rnd(0, ws.length - 1)]; const L = [4, 20, 80, 91, 92, 93, 97, 98, 99, 100, 101, 995, 996, 998][rnd(0, 13)]; let v = ''; for (let j = 0; j < L; j++) v += 'abcdefghij'[rnd(0, 9)]; if (rnd(0, 3) === 0) v = '資料' + v.slice(0, Math.max(1, L - 6)); lines.push(k + ' ' + v); }
    return n + '\n' + lines.join('\n') + '\n';
};
const REF_ENC = (out) => 'import sys\nL = sys.stdin.read().split("\\n")\nres = b""\nfor t in L[1:1 + int(L[0])]:\n    k, v = t.split(" ", 1)\n    kv = (k + "=" + v + "\\n").encode()\n    n = 1\n    while len(str(n).encode()) + 1 + len(kv) != n: n += 1\n    res += (str(n) + " ").encode() + kv\nprint(' + (out === 'hex' ? 'res.hex()' : 'res.decode(), end=""') + ')\n';

const SEEDS = [
    { id: 'list-pax', want: 'tarx.list', st: '輸入一行十六進位字串，是一個 tar 封存檔（POSIX.1-2001 PAX 格式）。有些條目前面有 typeflag 為 x 的擴充標頭，資料區是一連串記錄「長度 key=value\\n」（長度以位元組計、含長度欄自己和換行）；其中 path 取代下一個條目的檔名，size 取代下一個條目的大小。請依序輸出每個真正檔案的「檔名 大小」（空格分隔，一行一個）。檔名可能含 UTF-8 字元。', ref: REF_NS, gen: gen('paxu') },
    { id: 'list-gnu', want: 'tarx.list', st: '輸入一行十六進位字串，是一個 GNU 風格的 tar 封存檔。檔名超過 100 位元組時，前面會有一個 typeflag 為 L 的條目（名稱 ././@LongLink），其資料區就是下一個條目的完整檔名（以 NUL 結尾）。請依序輸出每個真正檔案的「檔名 大小」，一行一個。', ref: REF_NS, gen: gen('gnu') },
    { id: 'list-prefix', want: 'tarx.list', st: '輸入一行十六進位字串，是一個 ustar tar 封存檔。標頭位元組 345–499 是 prefix 欄，非空時完整檔名是 prefix 加上 "/" 再加位元組 0–99 的名稱。請依序輸出每個檔案的「檔名 大小」，一行一個（大小是八進位欄位的值）。', ref: REF_NS, gen: gen('prefix') },
    { id: 'list-mix-sn', want: 'tarx.list', st: '輸入一行十六進位字串，是一個 tar 封存檔，可能含 PAX 擴充標頭（typeflag x，記錄 path／size 覆蓋下一個條目）、GNU 長檔名條目（typeflag L）以及 ustar prefix。請依序輸出每個真正檔案的「大小 檔名」（空格分隔，一行一個）。', ref: REF_SN, gen: gen('mix') },
    { id: 'list-size-override', want: 'tarx.list', st: '輸入一行十六進位字串，是一個 PAX 格式的 tar 封存檔：有些檔案的標頭 size 欄是 0，真正大小放在前面 typeflag x 擴充標頭的 size=… 記錄裡，資料區依這個大小讀取並補到 512 的倍數。請依序輸出每個檔案的「檔名 大小」，一行一個。', ref: REF_NS, gen: gen('size') },
    { id: 'list-names-only', want: 'tarx.list', st: '輸入一行十六進位字串，是一個 tar 封存檔（可能有 PAX 擴充標頭 x 或 GNU 長檔名 L 或 ustar prefix）。請只輸出每個真正檔案的完整檔名，一行一個。', ref: REF_N, gen: gen('mix') },
    { id: 'pax-records', want: 'tarx.pax-records', st: '輸入一行十六進位字串，是一個 tar 封存檔，其中有 PAX 擴充標頭（typeflag x）。請取第一個擴充標頭，解析資料區的記錄「長度 key=value\\n」（長度含自身），依出現順序每行輸出 key=value。', ref: REF_REC('seq'), gen: GEN_REC },
    { id: 'pax-records-sorted', want: 'tarx.pax-records', st: '輸入一行十六進位字串，是一個含 PAX 擴充標頭（typeflag x）的 tar 封存檔。請把第一個擴充標頭的所有記錄（格式「長度 key=value\\n」）解析出來，依 key 的字典序排序後，每行輸出 key=value。', ref: REF_REC('sorted'), gen: GEN_REC },
    { id: 'pax-enc-hex', want: 'tarx.pax-encode', st: '第一行 n，接著 n 行，每行是「key value」（value 可含空格與 UTF-8 字元）。請把每筆編成 PAX 擴充標頭的記錄「長度 key=value\\n」：長度是整筆記錄的位元組數（UTF-8），且包含長度欄本身的位數與後面的空格和換行（長度位數進位時要重算）。所有記錄串接起來，輸出十六進位（小寫）。', ref: REF_ENC('hex'), gen: genEnc },
    { id: 'pax-enc-text', want: 'tarx.pax-encode', st: '第一行 n，接著 n 行，每行是「key value」（value 可含 UTF-8 字元）。請為每筆組出 PAX 擴充標頭記錄：十進位長度、一個空格、key=value、換行；長度是整筆記錄的 UTF-8 位元組數（含長度欄自身，位數進位時重算）。依序輸出所有記錄的文字內容。', ref: REF_ENC('text'), gen: genEnc },
    // holdout：另寫措辭，只量測，不教
    { id: 'ho-list', split: 'holdout', st: '輸入一行十六進位，內容是 tar 檔（有的檔案前面帶 PAX 的 x 型標頭，用 path 記錄指定很長的路徑）。請把封存檔裡每個檔案的路徑與位元組數印出來，每個檔案一行，路徑與大小以空格隔開。', ref: REF_NS, gen: gen('pax') },
    { id: 'ho-gnu', split: 'holdout', st: '輸入一行十六進位字串，這是用 GNU tar 做的封存檔，路徑太長的檔案前面附有 L 類型的長檔名區塊。請輸出每個檔案的名稱，一行一個。', ref: REF_N, gen: gen('gnu') },
    { id: 'ho-rec', split: 'holdout', st: '輸入一行十六進位字串，是一個 tar 檔，開頭附有 typeflag x 的 PAX 標頭。請把標頭裡每條「key=value」記錄列出來（依出現順序，一行一條）。', ref: REF_REC('seq'), gen: GEN_REC },
    { id: 'ho-enc', split: 'holdout', st: '輸入的第一行是整數 n，之後 n 行各有「欄位名 欄位值」。請產生 PAX 擴充標頭的資料內容：每筆是「總長度 欄位名=欄位值」加換行，總長度要把自己的位數也算進去（以 UTF-8 位元組計）。把全部串起來，用小寫十六進位印出。', ref: REF_ENC('hex'), gen: genEnc }
];
H.main({ name: '領域包 tarx', packs: [TX], seeds: SEEDS, minSkeletons: 3, judge: { checker: 'tokens', timeoutMs: 60000 } });
