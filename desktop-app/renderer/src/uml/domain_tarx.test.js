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

H.main({ name: '領域包 tarx', packs: [TX], seeds: H.loadSeeds(require('path').join(__dirname, 'seeds', 'domain_tarx.json')), minSkeletons: 3, judge: { checker: 'tokens', timeoutMs: 60000 } });
