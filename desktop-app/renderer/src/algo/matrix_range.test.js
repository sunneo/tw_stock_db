'use strict';
// G7 算術編碼（matrix_range_core）：① 隨機位元（隨機機率情境）、位元樹、直接位元的範圍編碼往返；② 我們寫的 LZMA 字面量串流交給真的 liblzma（Python lzma，FORMAT_ALONE）解，逐位元組一致（含隨機資料、文字、大量 0xFF 觸發進位）；③ 我們自己的解碼器往返；④ 重複文字壓縮後較小。
const assert = require('assert'), cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const R = require('./matrix_range_core.js');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 404; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 65536) % n; };

// ① 範圍編碼往返
for (let t = 0; t < 100; t++) {
    const nctx = 1 + rnd(8); const N = 200 + rnd(2000);
    const ops = []; for (let i = 0; i < N; i++) { const kind = rnd(10); ops.push(kind < 7 ? { k: 'bit', c: rnd(nctx), b: rnd(10) < (1 + (rnd(3))) ? 0 : 1 } : kind < 9 ? { k: 'tree', m: 3, v: rnd(8) } : { k: 'direct', n: 1 + rnd(12), v: rnd(4096) }); }
    const enc = new R.RangeEncoder(); const pe = Array.from({ length: nctx }, () => R.newProbs(1)); const te = R.newProbs(16);
    for (const o of ops) { if (o.k === 'bit') enc.encodeBit(pe[o.c], 0, o.b); else if (o.k === 'tree') R.bitTreeEncode(enc, te, o.m, o.v); else enc.encodeDirect(o.v & ((1 << o.n) - 1), o.n); }
    const bytes = enc.finish();
    const dec = new R.RangeDecoder(bytes); const pd = Array.from({ length: nctx }, () => R.newProbs(1)); const td = R.newProbs(16);
    for (const o of ops) {
        if (o.k === 'bit') assert.strictEqual(dec.decodeBit(pd[o.c], 0), o.b, '第 ' + t + ' 組 bit');
        else if (o.k === 'tree') assert.strictEqual(R.bitTreeDecode(dec, td, o.m), o.v, '第 ' + t + ' 組 tree');
        else assert.strictEqual(dec.decodeDirect(o.n), o.v & ((1 << o.n) - 1), '第 ' + t + ' 組 direct');
    }
    passed++;
}
console.log('① 100 組隨機操作（位元、位元樹、直接位元）的範圍編碼往返一致');

// ② liblzma 解我們的檔案
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rng-'));
const cases = [];
const addCase = (name, bytes) => cases.push({ name, bytes });
for (let t = 0; t < 12; t++) addCase('rand' + t, Array.from({ length: 1 + rnd(3000) }, () => rnd(256)));
addCase('ff-run', Array.from({ length: 5000 }, (_, i) => (i % 97 < 60 ? 0xFF : rnd(256))));
addCase('zeros', new Array(4000).fill(0));
addCase('text', Array.from(Buffer.from('The range coder carries bits across bytes; hello world! 0123456789 '.repeat(60))));
const files = cases.map((c) => { const p = path.join(tmp, c.name + '.lzma'); fs.writeFileSync(p, R.lzmaLiteralsEncode(Uint8Array.from(c.bytes), 1 << 20)); return { p, name: c.name }; });
const PYREF = `
import sys, json, lzma, base64
req = json.loads(sys.stdin.read()); out = {}
for p in req:
    try:
        out[p] = base64.b64encode(lzma.decompress(open(p, 'rb').read(), format=lzma.FORMAT_ALONE)).decode()
    except Exception as e:
        out[p] = 'ERR ' + str(e)
print(json.dumps(out))
`;
const r = cp.spawnSync(PY, ['-I', '-c', PYREF], { input: JSON.stringify(files.map((f) => f.p)), encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
assert.strictEqual(r.status, 0, r.stderr);
const dec = JSON.parse(r.stdout); let liblzmaOk = 0;
cases.forEach((c, i) => { const got = dec[files[i].p]; const want = Buffer.from(c.bytes).toString('base64'); if (got === want) liblzmaOk++; else console.log('不一致：' + c.name, String(got).slice(0, 80)); });
ok(liblzmaOk === cases.length, 'liblzma 解碼一致 ' + liblzmaOk + '/' + cases.length);
console.log('② liblzma 解我們的 LZMA 字面量串流：' + liblzmaOk + '/' + cases.length + ' 個檔案逐位元組一致（含隨機、0xFF 進位、全零、文字）');

// ③ 我們的解碼器
for (const c of cases) { const f = R.lzmaLiteralsEncode(Uint8Array.from(c.bytes), 1 << 20); assert.deepStrictEqual(Array.from(R.lzmaLiteralsDecode(f)), c.bytes, c.name); passed++; }
console.log('③ 同一批檔案用我們的解碼器往返一致');

// ④ 壓縮：重複文字的字面量模型會學到機率，檔案比原文小
const text = Buffer.from('abcabcabc the quick brown fox jumps over the lazy dog '.repeat(80));
const packed = R.lzmaLiteralsEncode(Uint8Array.from(text), 1 << 20).length - 13;
ok(packed < text.length, '文字壓縮：' + packed + ' 位元組，原文 ' + text.length);
console.log('④ 重複文字（' + text.length + ' 位元組）字面量模型壓成 ' + packed + ' 位元組（只有字面量，沒有比對，所以壓縮率有限）');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(passed + ' passed, 0 failed');
