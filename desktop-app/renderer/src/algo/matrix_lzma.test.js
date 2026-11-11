'use strict';
// G7 完整 LZMA（matrix_lzma_core）：① 我們的編碼器輸出交給真的 liblzma（Python lzma，FORMAT_ALONE）解，逐位元組一致；② liblzma 的壓縮輸出（多種 preset、未知大小＋結束標記）交給我們的解碼器解，逐位元組一致；③ 我們的編碼器→我們的解碼器往返；④ 覆蓋率：比對、四種重複距離、shortrep 都真的出現過；⑤ 壓縮率。
const assert = require('assert'), cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const L = require('./matrix_lzma_core.js');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 2024; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 65536) % n; };

// 測試資料
const cases = [];
const add = (name, bytes) => cases.push({ name, bytes: Uint8Array.from(bytes) });
add('empty', []);
add('one', [65]);
add('zeros', new Array(5000).fill(0));
for (let t = 0; t < 8; t++) add('rand' + t, Array.from({ length: 1 + rnd(4000) }, () => rnd(256)));
add('text', Buffer.from('The quick brown fox jumps over the lazy dog. abcabcabc 0123456789 '.repeat(120)));
add('periodic', Array.from({ length: 9000 }, (_, i) => (i % 37) * 7 & 0xFF));
add('reps', Buffer.from(Array.from({ length: 600 }, (_, i) => ['alpha-', 'beta--', 'gamma-', 'delta-', 'alpha-', 'omega-'][rnd(6)] + (i % 5)).join('')));
add('ff-run', Array.from({ length: 6000 }, (_, i) => (i % 97 < 60 ? 0xFF : rnd(256))));
add('long-match', Array.from(Buffer.from('0123456789abcdef'.repeat(40))).concat(Array.from(Buffer.from('0123456789abcdef'.repeat(40)))));
const src = fs.readFileSync(path.join(__dirname, 'matrix_lzma_core.js'));
add('source', src);

// ① 我們的編碼器 → liblzma
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lzma-'));
const stats = {};
const ours = cases.map((c, i) => { const f = path.join(tmp, 'ours' + i + '.lzma'); const enc = L.lzmaEncode(c.bytes, { stats }); fs.writeFileSync(f, enc); return { f, enc }; });
const PYDEC = `
import sys, json, lzma, base64
req = json.loads(sys.stdin.read()); out = {}
for p in req:
    try:
        out[p] = base64.b64encode(lzma.decompress(open(p, 'rb').read(), format=lzma.FORMAT_ALONE)).decode()
    except Exception as e:
        out[p] = 'ERR ' + str(e)
print(json.dumps(out))
`;
const rd = cp.spawnSync(PY, ['-I', '-c', PYDEC], { input: JSON.stringify(ours.map((o) => o.f)), encoding: 'utf8', timeout: 300000, maxBuffer: 256 * 1024 * 1024 });
assert.strictEqual(rd.status, 0, rd.stderr);
const dec1 = JSON.parse(rd.stdout); let lib1 = 0;
cases.forEach((c, i) => { const got = dec1[ours[i].f]; if (got === Buffer.from(c.bytes).toString('base64')) lib1++; else console.log('liblzma 不一致：' + c.name, String(got).slice(0, 80)); });
ok(lib1 === cases.length, 'liblzma 解我們的檔 ' + lib1 + '/' + cases.length);
console.log('① 我們的編碼器輸出，liblzma 解碼逐位元組一致：' + lib1 + '/' + cases.length + ' 個（含空檔、單位元組、全零、隨機、文字、長比對、重複距離、0xFF 進位、原始碼本身）');

// ② liblzma 的壓縮 → 我們的解碼器（preset 0、6、9，FORMAT_ALONE 預設為未知大小＋結束標記）
const pyIn = []; const PYENC = `
import sys, json, lzma
req = json.loads(sys.stdin.read()); out = {}
for p, preset in req:
    data = open(p, 'rb').read()
    out[p + '.' + str(preset)] = len(lzma.compress(data, format=lzma.FORMAT_ALONE, preset=preset))
    open(p + '.' + str(preset) + '.lzma', 'wb').write(lzma.compress(data, format=lzma.FORMAT_ALONE, preset=preset))
print(json.dumps(out))
`;
const libFiles = [];
cases.forEach((c, i) => { const p = path.join(tmp, 'in' + i + '.bin'); fs.writeFileSync(p, Buffer.from(c.bytes)); pyIn.push(p); });
const req = []; for (const p of pyIn) for (const pr of [0, 6, 9]) req.push([p, pr]);
const re = cp.spawnSync(PY, ['-I', '-c', PYENC], { input: JSON.stringify(req), encoding: 'utf8', timeout: 300000, maxBuffer: 256 * 1024 * 1024 });
assert.strictEqual(re.status, 0, re.stderr);
let lib2 = 0, lib2n = 0;
for (let i = 0; i < cases.length; i++) for (const pr of [0, 6, 9]) {
    const f = pyIn[i] + '.' + pr + '.lzma'; libFiles.push(f);
    const got = L.lzmaDecode(fs.readFileSync(f)); lib2n++;
    if (Buffer.from(got).equals(Buffer.from(cases[i].bytes))) lib2++; else console.log('我們的解碼器不一致：' + cases[i].name + ' preset ' + pr);
}
ok(lib2 === lib2n, 'liblzma 壓縮 → 我們的解碼 ' + lib2 + '/' + lib2n);
console.log('② liblzma 壓縮（preset 0／6／9，未知大小＋結束標記）→ 我們的解碼器：' + lib2 + '/' + lib2n + ' 個逐位元組一致');

// ③ 我們的編碼器 → 我們的解碼器
cases.forEach((c, i) => { assert.deepStrictEqual(Array.from(L.lzmaDecode(ours[i].enc)), Array.from(c.bytes), '往返 ' + c.name); passed++; });
console.log('③ 同一批資料，我們的編碼器→我們的解碼器往返一致（' + cases.length + ' 組）');

// ④ 覆蓋率：每種符號在測試資料中都真的出現
for (const k of ['lit', 'match', 'rep0', 'rep1', 'rep2', 'rep3', 'shortrep']) ok((stats[k] || 0) > 0, '覆蓋不足：' + k);
console.log('④ 符號種類次數：' + JSON.stringify(stats));

// ⑤ 壓縮率：重複文字與原始碼要明顯小於原文（只有字面量時做不到）
const txt = cases.find((c) => c.name === 'text').bytes;
const packed = L.lzmaEncode(txt).length;
ok(packed < txt.length / 10, '文字壓縮 ' + packed + ' / ' + txt.length);
const srcPacked = L.lzmaEncode(src).length;
ok(srcPacked < src.length * 0.6, '原始碼壓縮 ' + srcPacked + ' / ' + src.length);
console.log('⑤ 壓縮率：文字 ' + txt.length + ' → ' + packed + ' 位元組；原始碼 ' + src.length + ' → ' + srcPacked + ' 位元組');

// ⑥ 損毀檔案要報錯，不能靜默輸出
const bad = Buffer.from(ours[4].enc); bad[0] = 0; assert.throws(() => L.lzmaDecode(bad), /props/); passed++;
const trunc = ours[6].enc.subarray(0, 20); let threw = false; try { L.lzmaDecode(trunc); } catch (e) { threw = true; } ok(threw, '截斷檔應報錯'); passed++;
console.log('⑥ 錯誤的 props、截斷的檔案都會報錯');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('LZMA 測試通過 ' + passed + ' 項');
