'use strict';
// 領域包「完整 DEFLATE inflate」：輸入由 Python zlib 真的壓出來（raw／zlib／gzip，含未壓縮／固定／動態區塊、多區塊），
// 解壓題的期望輸出由 zlib 解壓得出（獨立參考解）；區塊統計與碼長表題用測試裡另寫的位元讀取類別解析（與骨架寫法不同）。
// train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。
const cp = require('child_process');
const H = require('./domain_harness.js'); const { rnd } = H;
const IN = require('./domain_inflate_core.js');
const PY = process.env.FA_PYTHON || 'python3';
const py = (src) => { const r = cp.spawnSync(PY, ['-I', '-c', src], { encoding: 'utf8', timeout: 30000 }); if (r.status !== 0) throw new Error('python 失敗：' + r.stderr); return r.stdout.trim(); };
// 獨立的區塊解析器（類別式位元讀取，與骨架的字串位元流寫法不同），回傳 (types, dyn)；dyn 為每個動態區塊的 (hlit, hdist, hclen, 字面碼長, 距離碼長)
const PARSE = `
class BR:
    def __init__(s, d): s.d = d; s.i = 0
    def bit(s):
        v = (s.d[s.i >> 3] >> (s.i & 7)) & 1; s.i += 1; return v
    def n(s, k):
        v = 0
        for j in range(k): v |= s.bit() << j
        return v
def mk(lens):
    code = 0; res = {}
    for L in range(1, 16):
        for sym, l in enumerate(lens):
            if l == L: res[(L, code)] = sym; code += 1
        code <<= 1
    return res
def dec(br, t):
    c = 0; L = 0
    while True:
        c = (c << 1) | br.bit(); L += 1
        if (L, c) in t: return t[(L, c)]
def parse(raw):
    br = BR(raw); types = []; dyn = []
    EX = [0]*8 + [1]*4 + [2]*4 + [3]*4 + [4]*4 + [5]*4 + [0]
    DX = [0,0,0,0] + [k for k in range(1, 14) for _ in (0, 1)]
    while True:
        fin = br.bit(); t = br.n(2); types.append(t)
        if t == 0:
            br.i = (br.i + 7) // 8 * 8; n = br.n(16); br.n(16); br.i += 8 * n
        else:
            if t == 1:
                ll = [8]*144 + [9]*112 + [7]*24 + [8]*8; dl = [5]*30
            else:
                hl = br.n(5) + 257; hd = br.n(5) + 1; hc = br.n(4) + 4
                cl = [0]*19
                for k in range(hc): cl[[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15][k]] = br.n(3)
                ct = mk(cl); ls = []
                while len(ls) < hl + hd:
                    s = dec(br, ct)
                    if s < 16: ls.append(s)
                    elif s == 16: ls += [ls[-1]] * (3 + br.n(2))
                    elif s == 17: ls += [0] * (3 + br.n(3))
                    else: ls += [0] * (11 + br.n(7))
                ll = ls[:hl]; dl = ls[hl:hl+hd]; dyn.append((hl, hd, hc, ll, dl))
            lt = mk(ll); dt = mk(dl)
            while True:
                s = dec(br, lt)
                if s == 256: break
                if s > 256:
                    br.n(EX[s - 257]); d = dec(br, dt); br.n(DX[d])
        if fin: break
    return types, dyn
`;
// 產生：kind＝text 或 mix（文字夾雜隨機位元組）；mode＝dyn（保證有動態區塊）、fixed、stored、multi（多區塊）、any；wrap＝raw／zlib／gzip；want＝要求動態區塊存在
const GEN = (wrap, mode, big, seed, nameField) => PARSE + `
import zlib, random, struct
random.seed(${seed})
ws = ["alpha", "beta", "gamma", "delta", "huffman", "tree", "block", "code", "length", "dist", "the", "of", "and", "zz", "q"]
def make(mode, big):
    n = random.randint(600, 4000) if big else random.randint(200, 700)
    if mode == "mix":
        raw = bytearray()
        while len(raw) < n:
            raw += (" ".join(random.choice(ws) for _ in range(random.randint(3, 12)))).encode() if random.random() < 0.6 else bytes(random.randrange(256) for _ in range(random.randint(1, 20)))
        raw = bytes(raw[:n])
    else:
        raw = (" ".join(random.choice(ws) for _ in range(n // 4 + 2)))[:n].encode()
    return raw
while True:
    mode = ${JSON.stringify(mode)}
    raw = make("mix" if random.random() < 0.4 else "text", ${big ? 'True' : 'False'})
    if mode == "stored": co = zlib.compressobj(0, zlib.DEFLATED, -15); z = co.compress(raw) + co.flush()
    elif mode == "fixed": co = zlib.compressobj(6, zlib.DEFLATED, -15, 8, zlib.Z_FIXED); z = co.compress(raw) + co.flush()
    elif mode == "multi":
        co = zlib.compressobj(random.choice([1, 6, 9]), zlib.DEFLATED, -15); cut = len(raw) // 3
        z = co.compress(raw[:cut]) + co.flush(zlib.Z_FULL_FLUSH) + co.compress(raw[cut:2 * cut]) + co.flush(zlib.Z_FULL_FLUSH) + co.compress(raw[2 * cut:]) + co.flush()
    else: co = zlib.compressobj(random.choice([6, 9]), zlib.DEFLATED, -15); z = co.compress(raw) + co.flush()
    types, dyn = parse(z)
    if mode in ("dyn", "multi", "any") and not dyn: continue
    break
if ${JSON.stringify(wrap)} == "zlib": out = b"\\x78\\x9c" + z + struct.pack(">I", zlib.adler32(raw))
elif ${JSON.stringify(wrap)} == "gzip":
    flg = ${nameField ? '8' : '0'}
    out = bytes([0x1f, 0x8b, 8, flg]) + struct.pack("<I", random.randint(0, 2**31)) + b"\\x00\\x03" + (b"data" + str(random.randint(0, 99)).encode() + b".txt\\x00" if flg else b"") + z + struct.pack("<II", zlib.crc32(raw), len(raw))
else: out = z
print(out.hex())
`;
const gen = (wrap, mode, nameField) => (b) => py(GEN(wrap, mode, b, rnd(1, 1e9), nameField)) + '\n';
// 參考解
const UNWRAP = { raw: 'zlib.decompress(d, -15)', zlib: 'zlib.decompress(d)', gzip: 'zlib.decompress(d, 31)' };
const REF_DEC = (wrap, tail) => 'import sys, zlib\nd = bytes.fromhex(sys.stdin.read().strip())\nr = ' + UNWRAP[wrap] + '\nprint(' + tail + ')\n';
const strip = (wrap) => (wrap === 'zlib' ? 'd[2:-4]' : wrap === 'gzip' ? 'GZ(d)' : 'd');
const GZ = 'def GZ(d):\n    f = d[3]; p = 10\n    if f & 8:\n        p = d.index(0, p) + 1\n    return d[p:-8]\n';
const REF_PARSE = (wrap, tail) => PARSE + 'import sys\n' + GZ + 'd = bytes.fromhex(sys.stdin.read().strip())\ntypes, dyn = parse(' + strip(wrap) + ')\n' + tail + '\n';
const REF_COUNTS = (wrap) => REF_PARSE(wrap, 'print(types.count(0), types.count(1), types.count(2))');
const REF_TOTAL = (wrap) => REF_PARSE(wrap, 'print(len(types))');
const REF_LIT = (wrap) => REF_PARSE(wrap, 'for s, l in enumerate(dyn[0][3]):\n    if l: print(s, l)');
const REF_BOTH = (wrap) => REF_PARSE(wrap, 'for s, l in enumerate(dyn[0][3]):\n    if l: print(s, l)\nfor s, l in enumerate(dyn[0][4]):\n    if l: print(s, l)');
const REF_HDR = (wrap) => REF_PARSE(wrap, 'print(dyn[0][0], dyn[0][1], dyn[0][2])');

H.main({ name: '領域包 inflate', packs: [IN], seeds: H.loadSeeds(require('path').join(__dirname, 'seeds', 'domain_inflate.json')), minSkeletons: 3, judge: { checker: 'tokens', timeoutMs: 60000 } });
