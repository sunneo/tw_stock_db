'use strict';
// 領域包「影音壓縮 1：位元級基礎」。真實位元流由本機 ffmpeg（libx264）產生（沒有 ffmpeg 就用手寫位元流的題），
// 期望輸出由測試裡另寫的參考解算出（類別式位元讀取，與骨架的字串位元流寫法不同）；開頭另做一次「參考解 vs ffprobe」的交叉驗證。
// train＝教過的措辭；holdout＝另寫措辭，只量測、不教。
const cp = require('child_process'); const assert = require('assert');
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const AV = require('./domain_avbits_core.js');
const PY = process.env.FA_PYTHON || 'python3';
const FF = process.env.FA_FFMPEG || 'ffmpeg', FP = process.env.FA_FFPROBE || 'ffprobe';
const HAVE_FF = cp.spawnSync(FF, ['-version']).status === 0;
const hexOf = (a) => Buffer.from(a).toString('hex');
// 用 libx264 產生 Annex B 串流（幾個畫面、profile、qp）
const stream = (w, h, frames, profile, qp, extra) => {
    const r = cp.spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=' + w + 'x' + h + ':rate=5', '-frames:v', String(frames), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-profile:v', profile, '-bf', '0', '-g', String(frames + 1), '-qp', String(qp)].concat(extra || [], ['-f', 'h264', '-']), { maxBuffer: 1 << 26 });
    assert.strictEqual(r.status, 0, 'ffmpeg 失敗：' + r.stderr); return r.stdout;
};
const even = (a, b) => 2 * rnd(a / 2, b / 2);
const streamGen = (profiles, big) => () => { const p = pick(profiles); const w = even(16, big ? 96 : 64), h = even(16, big ? 64 : 48); const ex = p === 'baseline' ? ['-x264-params', 'cabac=0'] : []; return hexOf(stream(w, h, 2, p, rnd(20, 40), ex)) + '\n'; };
// 獨立參考解（類別式位元讀取）
const BR = `
class BR:
    def __init__(s, d): s.d = d; s.i = 0
    def bit(s):
        v = (s.d[s.i >> 3] >> (7 - (s.i & 7))) & 1; s.i += 1; return v
    def u(s, n):
        v = 0
        for _ in range(n): v = (v << 1) | s.bit()
        return v
    def ue(s):
        z = 0
        while s.bit() == 0: z += 1
        return (1 << z) - 1 + s.u(z)
    def se(s):
        k = s.ue(); return (k + 1) // 2 if k & 1 else -(k // 2)
def nals(d):
    out = []; i = 0; st = []
    while i + 3 <= len(d):
        if d[i:i+3] == b"\\x00\\x00\\x01": st.append(i + 3); i += 3
        else: i += 1
    for k, s0 in enumerate(st):
        e = st[k + 1] - 3 if k + 1 < len(st) else len(d)
        n = d[s0:e].rstrip(b"\\x00"); out.append(n)
    return out
def unesc(b):
    o = bytearray(); z = 0
    for x in b:
        if z >= 2 and x == 3: z = 0; continue
        o.append(x); z = z + 1 if x == 0 else 0
    return bytes(o)
def sps_of(d):
    n = [x for x in nals(d) if x[0] & 31 == 7][0]; r = BR(unesc(n[1:]))
    pr = r.u(8); cf = r.u(8); lv = r.u(8); sid = r.ue()
    if pr in (100, 110, 122, 244):
        c = r.ue()
        if c == 3: r.u(1)
        r.ue(); r.ue(); r.u(1); assert r.u(1) == 0
    lfn = r.ue() + 4; poc = r.ue()
    if poc == 0: r.ue()
    nref = r.ue(); r.u(1); wm = r.ue() + 1; hm = r.ue() + 1; fmo = r.u(1)
    if not fmo: r.u(1)
    r.u(1); crop = [0, 0, 0, 0]
    if r.u(1): crop = [r.ue(), r.ue(), r.ue(), r.ue()]
    w = wm * 16 - 2 * (crop[0] + crop[1]); h = (2 - fmo) * hm * 16 - 2 * (2 - fmo) * (crop[2] + crop[3])
    return dict(pr=pr, lv=lv, sid=sid, lfn=lfn, poc=poc, nref=nref, w=w, h=h, mbw=wm, mbh=(2 - fmo) * hm)
def pps_of(d):
    n = [x for x in nals(d) if x[0] & 31 == 8][0]; r = BR(unesc(n[1:]))
    pid = r.ue(); sid = r.ue(); cabac = r.u(1); r.u(1); r.ue(); ref0 = r.ue() + 1; r.ue(); r.u(1); r.u(2)
    qp = 26 + r.se(); r.se(); cq = r.se(); dbf = r.u(1)
    return dict(pid=pid, sid=sid, cabac=cabac, ref0=ref0, qp=qp, cq=cq, dbf=dbf)
`;
const sh = (x) => x;   // 參考解沒有 ffprobe 時也能用
const PYREF = (tail) => 'import sys\n' + BR + 'd = bytes.fromhex(sys.stdin.read().strip())\n' + tail + '\n';
const EG_REF = (kind, tail) => 'import sys\n' + BR + `d = bytes.fromhex(sys.stdin.read().strip())
r = BR(d); total = len(d) * 8
last = 0
for i in range(total):
    if (d[i >> 3] >> (7 - (i & 7))) & 1: last = i
res = []
while r.i < last:
    res.append(r.${kind}())
print(*res)
`;
const egVals = (kind, big) => { const n = rnd(2, big ? 30 : 8); const v = []; for (let i = 0; i < n; i++) v.push(kind === 'ue' ? (rnd(0, 3) === 0 ? rnd(0, 3000) : rnd(0, 20)) : (rnd(0, 3) === 0 ? rnd(-1500, 1500) : rnd(-10, 10))); return v; };
const egEnc = (vals, kind, tail) => { let b = ''; for (const v of vals) { const k = kind === 'ue' ? v + 1 : (v > 0 ? 2 * v - 1 : -2 * v) + 1; const s = k.toString(2); b += '0'.repeat(s.length - 1) + s; } if (tail) b += '1'; while (b.length % 8) b += '0'; let o = ''; for (let i = 0; i < b.length; i += 8) o += ('0' + parseInt(b.slice(i, i + 8), 2).toString(16)).slice(-2); return o; };
const egGen = (kind) => (big) => egEnc(egVals(kind, big), kind, true) + '\n';
const egEncGen = (kind) => (big) => egVals(kind, big).join(' ') + '\n';
const EGENC_REF = (kind, tail) => `import sys
v = list(map(int, sys.stdin.read().split()))
bits = []
for x in v:
    k = ${kind === 'ue' ? 'x + 1' : '(2 * x - 1 if x > 0 else -2 * x) + 1'}
    s = bin(k)[2:]
    bits.append("0" * (len(s) - 1) + s)
bits = "".join(bits)${tail ? ' + "1"' : ''}
while len(bits) % 8: bits += "0"
print("".join("%02x" % int(bits[i:i + 8], 2) for i in range(0, len(bits), 8)))
`;
// 防競爭位元組：多 0 的隨機位元組
const zeroHeavy = (big) => { const n = rnd(6, big ? 200 : 30); const a = []; for (let i = 0; i < n; i++) a.push(rnd(0, 2) ? 0 : pick([0, 1, 2, 3, 3, 4, 255, 17])); return a; };
const escGen = (big) => hexOf(zeroHeavy(big)) + '\n';
const ESC_REF = (ins) => ins ? `import sys
d = bytes.fromhex(sys.stdin.read().strip())
o = bytearray(); z = 0
for x in d:
    if z >= 2 and x <= 3: o.append(3); z = 0
    o.append(x); z = z + 1 if x == 0 else 0
if o and o[-1] == 0: o.append(3)
print(o.hex())
` : `import sys
d = bytes.fromhex(sys.stdin.read().strip())
o = bytearray(); z = 0
for x in d:
    if z >= 2 and x == 3: z = 0; continue
    o.append(x); z = z + 1 if x == 0 else 0
print(o.hex())
`;
// 沒有零連續 00 00 的「有效」逸出輸入（移除題）：先隨機 RBSP 再逸出
const unescGen = (big) => { const r = zeroHeavy(big); const o = []; let z = 0; for (const x of r) { if (z >= 2 && x <= 3) { o.push(3); z = 0; } o.push(x); z = x === 0 ? z + 1 : 0; } if (o[o.length - 1] === 0) o.push(3); return hexOf(o) + '\n'; };
// 手寫 Annex B：隨機負載（沒有 0 位元組）、起始碼 3／4 位元組混用
const synthStream = (big) => { const n = rnd(2, big ? 12 : 5); const out = []; for (let i = 0; i < n; i++) { out.push(...(rnd(0, 1) ? [0, 0, 1] : [0, 0, 0, 1])); out.push(pick([1, 5, 6, 7, 8, 9]) + 32 * rnd(0, 3)); const m = rnd(1, big ? 40 : 10); for (let j = 0; j < m; j++) out.push(rnd(1, 255)); } return hexOf(out) + '\n'; };
const NAL_REF = (tail) => PYREF('ns = nals(d)\n' + tail);
const trailGen = (big) => { const n = rnd(1, big ? 20 : 6); const a = []; for (let i = 0; i < n - 1; i++) a.push(rnd(0, 255)); a.push(pick([0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01, 0xa0, 0xc8, 0x91])); return hexOf(a) + '\n'; };
const TR_REF = (tail) => `import sys
d = bytes.fromhex(sys.stdin.read().strip())
b = bin(int.from_bytes(d, "big"))[2:].zfill(len(d) * 8)
n = b.rfind("1")
${tail}
`;
// SPS／PPS 寫出：手寫參考（類別式位元寫入）
const BW = `
class BW:
    def __init__(s): s.b = []
    def u(s, n, v): s.b.append(format(v, "0%db" % n) if n else "")
    def ue(s, v):
        k = v + 1; s.b.append("0" * (k.bit_length() - 1) + format(k, "b"))
    def se(s, v): s.ue(2 * v - 1 if v > 0 else -2 * v)
    def done(s):
        t = "".join(s.b) + "1"; t += "0" * (-len(t) % 8)
        return int(t, 2).to_bytes(len(t) // 8, "big")
def esc(r):
    o = bytearray(); z = 0
    for x in r:
        if z >= 2 and x <= 3: o.append(3); z = 0
        o.append(x); z = z + 1 if x == 0 else 0
    if o[-1] == 0: o.append(3)
    return bytes(o)
`;
const SPSW_REF = (cf, sc) => 'import sys\n' + BW + `pr, lv, sid, w, h, nr = map(int, sys.stdin.read().split()[:6])
b = BW(); b.u(8, pr); b.u(8, ${cf}); b.u(8, lv); b.ue(sid); b.ue(0); b.ue(2); b.ue(nr); b.u(1, 0)
b.ue((w + 15) // 16 - 1); b.ue((h + 15) // 16 - 1); b.u(1, 1); b.u(1, 1)
cr = w % 16 or h % 16
if cr:
    b.u(1, 1); b.ue(0); b.ue((16 - w % 16) % 16 // 2); b.ue(0); b.ue((16 - h % 16) % 16 // 2)
else: b.u(1, 0)
b.u(1, 0)
print((${sc} + b"\\x67" + esc(b.done())).hex())
`;
const spswGen = (big) => { const w = even(16, big ? 400 : 100), h = even(16, big ? 300 : 80); return pick([66, 66, 77]) + ' ' + pick([10, 11, 20, 30, 31, 40]) + ' ' + rnd(0, 5) + ' ' + w + ' ' + h + ' ' + rnd(1, 4) + '\n'; };
const PPSW_REF = (sc, hd) => 'import sys\n' + BW + `pid, sid, qp, cq, rf, dc = map(int, sys.stdin.read().split()[:6])
b = BW(); b.ue(pid); b.ue(sid); b.u(1, 0); b.u(1, 0); b.ue(0); b.ue(rf - 1); b.ue(0); b.u(1, 0); b.u(2, 0)
b.se(qp - 26); b.se(0); b.se(cq); b.u(1, dc); b.u(1, 0); b.u(1, 0)
print((${sc} + bytes([${hd}]) + esc(b.done())).hex())
`;
const ppswGen = () => rnd(0, 7) + ' ' + rnd(0, 5) + ' ' + rnd(10, 45) + ' ' + rnd(-6, 6) + ' ' + rnd(1, 4) + ' ' + rnd(0, 1) + '\n';
const SL_REF = (tail) => PYREF(`sps = sps_of(d); pps = pps_of(d)
n = [x for x in nals(d) if x[0] & 31 in (1, 5)][0]; r = BR(unesc(n[1:]))
first = r.ue(); st = r.ue() % 5; pid = r.ue(); fnum = r.u(sps["lfn"])
idr = r.ue() if n[0] & 31 == 5 else -1
if sps["poc"] == 0: r.ue()
if st == 0:
    if r.u(1): r.ue()
    if r.u(1):
        while True:
            op = r.ue()
            if op == 3: break
            r.ue()
if n[0] >> 5 & 3:
    if n[0] & 31 == 5: r.u(1); r.u(1)
    else:
        if r.u(1):
            while True:
                op = r.ue()
                if op == 0: break
                if op in (1, 3): r.ue()
                if op == 2: r.ue()
                if op in (3, 6): r.ue()
                if op == 4: r.ue()
sqp = pps["qp"] + r.se()
` + tail);

const OPENING = '輸入一行十六進位字串，';
// 開頭交叉驗證：參考解 vs ffprobe
if (HAVE_FF) {
    for (const [p, w, h] of [['baseline', 50, 34], ['main', 64, 48], ['high', 30, 18]]) {
        const hex = hexOf(stream(w, h, 2, p, 28, p === 'baseline' ? ['-x264-params', 'cabac=0'] : []));
        const o = cp.spawnSync(PY, ['-I', '-c', 'import sys\n' + BR + 'd = bytes.fromhex(sys.stdin.read().strip())\ns = sps_of(d)\nprint(s["w"], s["h"], s["pr"], s["lv"])'], { input: hex, encoding: 'utf8' }).stdout.trim();
        const f = cp.spawnSync(FP, ['-v', 'error', '-show_entries', 'stream=width,height,profile,level', '-of', 'default=nw=1:nk=0', '-f', 'h264', '-i', 'pipe:0'], { input: Buffer.from(hex, 'hex'), encoding: 'utf8' }).stdout;
        const g = (k) => +(new RegExp(k + '=(\\d+)').exec(f) || [])[1];
        assert.strictEqual(o.split(' ').slice(0, 2).join(' '), g('width') + ' ' + g('height'), '參考解與 ffprobe 不一致：' + o + ' / ' + f);
        assert.strictEqual(+o.split(' ')[3], g('level'));
    }
    console.log('參考解與 ffprobe 的寬高／level 交叉驗證通過');
} else console.log('略過 ffprobe 交叉驗證（找不到 ffmpeg）');
if (!HAVE_FF) { console.log('略過：沒有 ffmpeg，真實位元流題無法產生'); console.log('0 passed, 0 failed'); process.exit(0); }
H.main({ name: '領域包 avbits', packs: [AV], seeds: H.loadSeeds(require('path').join(__dirname, 'seeds', 'domain_avbits.json')), minSkeletons: 11, judge: { checker: 'tokens', timeoutMs: 60000 } });
