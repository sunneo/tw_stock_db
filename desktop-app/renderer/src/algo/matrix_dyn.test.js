'use strict';
// G7 動態表（matrix_dyn_core）：① RFC 1951 §3.2.2 的範例碼字逐一相同；② 隨機碼長表的碼字與獨立的 Python 實作一致；③ 位元流編碼→解碼往返；④ 過度碼長表要報錯；⑤ MTF 與 Python 一致、往返。
const assert = require('assert'), cp = require('child_process');
const D = require('./matrix_dyn_core.js');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 9001; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 65536) % n; };
const bstr = (c) => c.code.toString(2).padStart(c.len, '0');

// ① RFC 1951 範例
const rfc = D.canonicalCodes([3, 3, 3, 3, 3, 2, 4, 4]).map(bstr).join(' ');
ok(rfc === '010 011 100 101 110 00 1110 1111', 'RFC 1951 §3.2.2 範例：' + rfc);
console.log('① RFC 1951 範例碼字相同');

// ② 獨立 Python 參照（照 RFC 文字寫，不共用程式）+ 隨機碼長表
const PYREF = `
import sys, json
def canon(lengths):
    MAXB = 15
    bl = [0]*(MAXB+1)
    for l in lengths:
        if l: bl[l] += 1
    nxt = [0]*(MAXB+2); code = 0
    for bits in range(1, MAXB+1):
        code = (code + bl[bits-1]) << 1
        nxt[bits] = code
    out = []
    for l in lengths:
        if l:
            out.append(format(nxt[l], '0%db' % l)); nxt[l] += 1
        else:
            out.append('')
    return out
def mtf(alpha, syms):
    t = list(alpha); r = []
    for s in syms:
        k = t.index(s); r.append(k); t.pop(k); t.insert(0, s)
    return r
req = json.loads(sys.stdin.read())
res = []
for q in req:
    if q['k'] == 'canon': res.append(canon(q['lengths']))
    else: res.append(mtf(q['alpha'], q['syms']))
print(json.dumps(res))
`;
const reqs = []; const exps = [];
for (let t = 0; t < 300; t++) {
    // 隨機、但 Kraft 和 ≤ 1 的碼長表：從 1..8 位元隨機取，過度的就丟掉
    const k = 2 + rnd(20); const lens = []; let kraft = 0;
    for (let i = 0; i < k; i++) { const l = rnd(9); if (l === 0) { lens.push(0); continue; } if (kraft + Math.pow(2, -l) <= 1 + 1e-12) { kraft += Math.pow(2, -l); lens.push(l); } else lens.push(0); }
    if (lens.every((x) => x === 0)) lens[0] = 1;
    reqs.push({ k: 'canon', lengths: lens });
    exps.push(D.canonicalCodes(lens).map((c) => (c ? bstr(c) : '')));
}
const alphaN = 8; for (let t = 0; t < 300; t++) {
    const alpha = Array.from({ length: alphaN }, (_, i) => i); const syms = Array.from({ length: 1 + rnd(30) }, () => rnd(alphaN));
    reqs.push({ k: 'mtf', alpha, syms }); exps.push(D.mtfEncode(alpha, syms).ranks);
}
const r = cp.spawnSync(PY, ['-I', '-c', PYREF], { input: JSON.stringify(reqs), encoding: 'utf8', timeout: 120000 });
assert.strictEqual(r.status, 0, r.stderr);
const got = JSON.parse(r.stdout); let cmp = 0;
reqs.forEach((q, i) => { cmp++; assert.deepStrictEqual(got[i], exps[i], '第 ' + i + ' 筆（' + q.k + '）與 Python 不一致'); });
ok(cmp === 600, '比對筆數');
console.log('② 300 組隨機碼長表（碼字）＋300 組 MTF，與獨立 Python 參照一致：' + cmp + '/600');

// ③ 位元流往返
for (let t = 0; t < 200; t++) {
    const k = 2 + rnd(12); const lens = []; let kraft = 0;
    for (let i = 0; i < k; i++) { const l = 1 + rnd(7); if (kraft + Math.pow(2, -l) <= 1 + 1e-12) { kraft += Math.pow(2, -l); lens.push(l); } else lens.push(0); }
    const used = lens.map((l, i) => (l ? i : -1)).filter((i) => i >= 0); if (!used.length) continue;
    const syms = Array.from({ length: 1 + rnd(40) }, () => used[rnd(used.length)]);
    const bits = D.encodeHuffman(lens, syms); const dec = D.decodeHuffman(lens, bits, syms.length);
    ok(JSON.stringify(dec.symbols) === JSON.stringify(syms) && dec.consumed === bits.length, '往返第 ' + t);
}
console.log('③ 200 組位元流編碼→解碼往返一致');

// ④ 錯誤輸入要報錯
let threw = false; try { D.canonicalCodes([1, 1, 1]); } catch (e) { threw = true; } ok(threw, 'Kraft 和 > 1 要報錯');
threw = false; try { D.decodeHuffman([2, 2], [0, 0, 0], 2); } catch (e) { threw = true; } ok(threw, '位元流提早結束要報錯');
console.log('④ 過度碼長表與位元流提早結束都報錯');

// ⑤ MTF 往返
for (let t = 0; t < 200; t++) { const alpha = [0, 1, 2, 3, 4, 5]; const syms = Array.from({ length: 1 + rnd(25) }, () => rnd(6)); const e = D.mtfEncode(alpha, syms); const d = D.mtfDecode(alpha, e.ranks); assert.deepStrictEqual(d.symbols, syms); assert.deepStrictEqual(d.table, e.table); passed++; }
console.log('⑤ 200 組 MTF 往返一致');
console.log(passed + ' passed, 0 failed');
