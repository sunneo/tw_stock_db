'use strict';
// 矩陣層校驗碼模組（CRC 的 GF(2) 矩陣、Adler／Fletcher／總和／互斥或、位元組清單、端序）：
//  ① 每個 CRC 規格：位元逐步版對標準檢查值 "123456789"；② 矩陣連乘版與位元逐步版在 300 個隨機位元組串上完全一致；
//  ③ CRC32 與 zlib.crc32、CRC16-XMODEM 與 binascii.crc_hqx、CRC32 的矩陣對 zlib（真 python）；
//  ④ 整數加法下 CRC 不線性、GF(2) 下線性（互斥或疊加）；⑤ 題庫：bench_linux_all train 的 crc32／adler32／endian／delta、heldout7 的校驗類；⑥ 誠實失敗。
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process');
const S = require('./matrix_synth_core.js'); const K = require('./matrix_checksum_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
assert.strictEqual(K.install(S), true);
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'); let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 65536) % n; };
const chk = K.enc('123456789');
for (const [name, sp] of Object.entries(K.SPECS)) { ok(K.crcBitwise(sp, chk) === sp.check, name + ' 位元逐步版檢查值 0x' + sp.check.toString(16) + ' 得 0x' + K.crcBitwise(sp, chk).toString(16)); }
console.log('① ' + Object.keys(K.SPECS).length + ' 個 CRC 規格的檢查值正確');
for (const [name, sp] of Object.entries(K.SPECS)) { const A = K.crcMatrix(sp); for (let t = 0; t < 300; t++) { const bs = Array.from({ length: rnd(20) }, () => rnd(256)); ok(K.crcBitwise(sp, bs) === K.crcViaMatrix(sp, bs, A), name + ' 矩陣版與位元逐步版一致'); } }
console.log('② 矩陣連乘版與位元逐步版各 300 個隨機串一致');
{ // ③ 對真 python
    const strs = Array.from({ length: 60 }, () => Array.from({ length: rnd(30) }, () => String.fromCharCode(32 + rnd(90))).join(''));
    const res = cp.spawnSync(PY, ['-I', '-c', 'import sys,json,zlib,binascii\nfor s in json.loads(sys.stdin.read()):\n    b=s.encode()\n    print(zlib.crc32(b)&0xffffffff, binascii.crc_hqx(b,0))\n'], { input: JSON.stringify(strs), encoding: 'utf8' }); assert.strictEqual(res.status, 0, res.stderr);
    const want = res.stdout.trim().split('\n').map((l) => l.split(' ').map(Number)); const A32 = K.crcMatrix(K.SPECS.crc32), AX = K.crcMatrix(K.SPECS['crc16-xmodem']);
    strs.forEach((s, i) => { ok(K.crcViaMatrix(K.SPECS.crc32, K.enc(s), A32) === want[i][0], 'CRC32 矩陣版對 zlib：' + s); ok(K.crcViaMatrix(K.SPECS['crc16-xmodem'], K.enc(s), AX) === want[i][1], 'XMODEM 矩陣版對 crc_hqx：' + s); });
    console.log('③ CRC32 矩陣版對 zlib、XMODEM 對 binascii.crc_hqx：60 個隨機串一致');
}
{ // ④ 線性：GF(2) 下 f(a⊕b⊕c) = f(a)⊕f(b)⊕f(c)（等長、init=0 xorout=0 的線性部分）；整數加法下不成立
    const sp = Object.assign({}, K.SPECS.crc32, { init: 0, xorout: 0 }); let lin = 0, nonlin = 0;
    for (let t = 0; t < 100; t++) { const n = 4 + rnd(6); const a = Array.from({ length: n }, () => rnd(256)), b = Array.from({ length: n }, () => rnd(256)); const x = a.map((v, i) => v ^ b[i]); if (K.crcBitwise(sp, x) === (K.crcBitwise(sp, a) ^ K.crcBitwise(sp, b)) >>> 0) lin++; const sum = a.map((v, i) => (v + b[i]) & 255); if (K.crcBitwise(sp, sum) === ((K.crcBitwise(sp, a) + K.crcBitwise(sp, b)) >>> 0)) nonlin++; }
    ok(lin === 100, 'GF(2) 線性 100/100'); ok(nonlin < 5, '整數加法下不線性（幾乎都不成立）：' + nonlin); console.log('④ 線性：GF(2) ' + lin + '/100，整數加法 ' + nonlin + '/100');
}
const dir = path.join(__dirname, '..', 'recipe', 'seed'); const load = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
async function runSet(ps) { const out = []; for (const p of ps) { const ex = p.tests.slice(0, 2), hid = p.tests.slice(2).concat(p.hidden || []); const problem = { id: p.id, tests: ex, hidden: hid, checker: p.checker || 'tokens' }; const r = await S.synth({ statement: p.statement, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } }); out.push({ id: p.id, ok: !!r.ok, verified: !!r.verified, by: r.ok ? r.kind : '', desc: r.desc || '', reason: r.ok ? '' : (r.reason || '').slice(0, 60) }); } return out; }
(async () => {
    const lx = load('bench_linux_all.jsonl').filter((p) => p.split === 'train' && /^lx-(crc32|adler32|endian-pack|xz-delta)$/.test(p.id));
    const r1 = await runSet(lx); r1.forEach((x) => console.log((x.ok ? (x.verified ? '✓ ' : '△ ') : '✗ ') + x.id + ' ' + x.by + ' ' + x.desc + x.reason)); const n1 = r1.filter((x) => x.ok).length; ok(n1 === lx.length, 'Linux train 校驗類全過：' + n1 + '/' + lx.length);
    const h7 = load('heldout7_mixed.jsonl').filter((p) => /^h7-(byte-sum|xor-all|crc32-text|fletcher16)$/.test(p.id)); const r2 = await runSet(h7); r2.forEach((x) => console.log((x.ok ? (x.verified ? '✓ ' : '△ ') : '✗ ') + x.id + ' ' + x.by + ' ' + x.desc + x.reason)); const n2 = r2.filter((x) => x.ok).length; ok(n2 === h7.length, 'heldout7 校驗類全過：' + n2 + '/' + h7.length);
    ok(!(await K.synthChecksum({ statement: 'x', examples: [] })).ok, '沒有範例要失敗'); ok(!(await K.synthChecksum({ statement: '輸出雜湊', examples: [{ in: 'abc\n', out: '0123456789abcdef\n' }] })).ok, '不認得的雜湊要失敗');
    ok(!(await K.synthByteList({ statement: 'x', examples: [{ in: 'a b\n', out: 'c\n' }] })).ok, '位元組清單形狀不認得要失敗');
    console.log(passed + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
