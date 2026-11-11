'use strict';
// 矩陣層位元組／位元機器（matrix_bytes_core）：
//  ① 每台機器的 JS 版與 Python 版在隨機輸入上輸出一致（真 python；JS 版丟例外的輸入略過）；② 與獨立的 python 參考對照（varint 對 protobuf 規則、DEFLATE stored 對 zlib 解壓、霍夫曼成本對 heapq 參考）；
//  ③ 題庫：bench_linux_all train 的 xz-varint-dec、bit-reader、lz77-decode、huffman-cost、xxd-reverse、deflate-stored（前 2 筆當範例）；④ 誠實失敗。
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process'), zlib = require('zlib');
const S = require('./matrix_synth_core.js'); const K = require('./matrix_bytes_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
assert.strictEqual(K.install(S), true); const PY = process.env.PYTHON || 'python'; let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 31337; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 65536) % n; };
const hx = (b) => b.map((x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
// 每台機器的輸入產生器
const GEN = {
    'varint-dec-le': () => { const n = 1 + rnd(4); const o = []; for (let i = 0; i < n; i++) { let v = rnd(1 << 20); const g = []; do { g.push(v & 127); v >>= 7; } while (v > 0); g.forEach((d, j) => o.push(d | (j < g.length - 1 ? 128 : 0))); } return hx(o) + '\n'; },
    'varint-enc-le': () => Array.from({ length: 1 + rnd(4) }, () => rnd(1 << 24)).join(' ') + '\n',
    'bit-reader-lsb': () => { const b = Array.from({ length: 6 }, () => rnd(256)); const ws = []; let tot = 0; while (true) { const w = 1 + rnd(9); if (tot + w > 48) break; ws.push(w); tot += w; } return hx(b) + '\n' + ws.join(' ') + '\n'; },
    'lz77-dec': () => { const toks = []; let len = 0; for (let i = 0; i < 2 + rnd(5); i++) { if (len < 2 || rnd(3) === 0) { toks.push('abc'[rnd(3)]); len++; } else { const d = 1 + rnd(len), L = 1 + rnd(5); toks.push('<' + L + ',' + d + '>'); len += L; } } return toks.join(' ') + '\n'; },
    'huffman-cost': () => { const k = 2 + rnd(8); return k + '\n' + Array.from({ length: k }, () => 1 + rnd(40)).join(' ') + '\n'; },
    'xxd-reverse': () => { const n = 1 + rnd(3); let s = n + '\n'; for (let i = 0; i < n; i++) { const b = Array.from({ length: 1 + rnd(16) }, () => rnd(256)); let hexs = ''; for (let j = 0; j < b.length; j += 2) hexs += hx(b.slice(j, j + 2)) + ' '; s += (i * 16).toString(16).padStart(8, '0') + ': ' + hexs.padEnd(40, ' ') + ' ' + 'x'.repeat(b.length) + '\n'; } return s; },
    'deflate-stored': () => Array.from({ length: 1 + rnd(20) }, () => 'abcdefghij'[rnd(10)]).join('') + '\n',
};
GEN['varint-dec-be'] = GEN['varint-dec-le']; GEN['varint-enc-be'] = GEN['varint-enc-le']; GEN['bit-reader-msb'] = GEN['bit-reader-lsb'];
{
    const progs = []; const meta = [];
    for (const m of K.MACHINES) { const ins = [], exp = []; for (let t = 0; t < 30; t++) { const inp = GEN[m.id](); let r; try { r = m.js(inp); } catch (e) { continue; } ins.push(inp); exp.push(String(r).trim()); } progs.push({ id: m.id, src: m.py.join('\n') + '\n', ins }); meta.push({ m, exp }); }
    const harness = 'import sys, json, io, builtins\nP = json.loads(sys.stdin.read())\nres = []\nfor p in P:\n    outs = []\n    ns = {"__name__": "x"}\n    exec(p["src"], ns)\n    for text in p["ins"]:\n        it = iter(text.split("\\n"))\n        old_in = builtins.input\n        builtins.input = lambda *a: next(it)\n        buf = io.StringIO(); old = sys.stdout; sys.stdout = buf\n        try:\n            ns["main"]()\n            outs.append(buf.getvalue().strip())\n        except Exception as e:\n            outs.append("ERR " + type(e).__name__)\n        finally:\n            sys.stdout = old; builtins.input = old_in\n    res.append(outs)\nprint(json.dumps(res))\n';
    const r = cp.spawnSync(PY, ['-I', '-c', harness], { input: JSON.stringify(progs), encoding: 'utf8', timeout: 120000 }); assert.strictEqual(r.status, 0, String(r.stderr).slice(0, 400)); const got = JSON.parse(r.stdout); let cmp = 0;
    meta.forEach(({ m, exp }, i) => exp.forEach((e, j) => { cmp++; ok(got[i][j] === e, m.id + ' JS／Python 不一致：' + JSON.stringify(progs[i].ins[j]) + ' JS=' + e + ' PY=' + got[i][j]); }));
    console.log('① ' + K.MACHINES.length + ' 台機器、' + cmp + ' 次比對，JS 與 Python 一致');
}
{ // ② 獨立參考
    const m = (id) => K.MACHINES.find((x) => x.id === id);
    for (let t = 0; t < 100; t++) { const v = rnd(1 << 30); const enc = m('varint-enc-le').js(v + '\n'); const b = Buffer.from(enc, 'hex'); let dec = 0n, shift = 0n; for (const x of b) { dec |= BigInt(x & 127) << shift; shift += 7n; } ok(dec === BigInt(v) && m('varint-dec-le').js(enc + '\n') === String(v), 'varint 往返 ' + v); }
    for (let t = 0; t < 60; t++) { const s = Array.from({ length: 1 + rnd(40) }, () => 'abcxyz'[rnd(6)]).join(''); const hex = m('deflate-stored').js(s + '\n'); const out = zlib.inflateRawSync(Buffer.from(hex, 'hex')).toString(); ok(out === s, 'DEFLATE stored 對 zlib 解壓：' + s); }
    for (let t = 0; t < 60; t++) { const k = 2 + rnd(8); const a = Array.from({ length: k }, () => 1 + rnd(50)); const h = a.slice(); let c = 0; while (h.length > 1) { h.sort((x, y) => x - y); const x = h.shift(), y = h.shift(); c += x + y; h.push(x + y); } ok(m('huffman-cost').js(k + '\n' + a.join(' ') + '\n') === String(c), '霍夫曼成本'); }
    console.log('② varint 往返、DEFLATE stored 對 zlib、霍夫曼成本對獨立實作：一致');
}
const dir = path.join(__dirname, '..', 'recipe', 'seed'); const load = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
(async () => {
    const ps = load('bench_linux_all.jsonl').filter((p) => p.split === 'train' && /^lx-(xz-varint-dec|bit-reader|lz77-decode|huffman-cost|xxd-reverse|deflate-stored)$/.test(p.id)); let n = 0;
    for (const p of ps) { const ex = p.tests.slice(0, 2), hid = p.tests.slice(2).concat(p.hidden || []); const problem = { id: p.id, tests: ex, hidden: hid, checker: p.checker || 'tokens' }; const r = await S.synth({ statement: p.statement, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } }); console.log((r.ok ? (r.verified ? '✓ ' : '△ ') : '✗ ') + p.id + ' ' + (r.desc || r.reason || '').slice(0, 90)); if (r.ok) n++; }
    console.log('③ Linux train 位元組類 ' + n + '/' + ps.length); ok(n >= 5, '至少 5/6：' + n);
    ok(!(await K.synthBytes({ statement: 'x', examples: [] })).ok, '沒有範例要失敗'); ok(!(await K.synthBytes({ statement: 'x', examples: [{ in: 'zz\n', out: '7\n' }] })).ok, '庫裡沒有的要失敗');
    console.log(passed + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
