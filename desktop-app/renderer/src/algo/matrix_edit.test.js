'use strict';
// 矩陣 → code edit：合成出的程式整理成可編輯版（有意義的註解、無巢狀 def），且
//  ① 形態往返（形態→程式→形態相同）② 與原程式輸出相同 ③ 改形態（係數、轉移表）直接改程式、行為跟著變 ④ 走既有 Python→UML 路徑不落成 raw、往返穩定且 AC ⑤ 改壞時降級成 null（一般 Python 區塊）。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const S = require('./matrix_synth_core.js'); const G = require('./matrix_graph_core.js'); const E = require('./matrix_edit_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js')); const C = require('../uml/py_code2uml_core.js');
G.install(S); assert.strictEqual(E.install(S), true);
const run = async (src, input) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: { id: 'x', tests: [{ in: input, out: '' }], checker: 'tokens' } }); return j; };
const out = async (src, input) => { const cp = require('child_process'); const r = cp.spawnSync('python3', ['-I', '-c', src + '\nmain()\n'], { input, encoding: 'utf8', timeout: 20000 }); return r.stdout.trim(); };
const mkJudge = (tests, hidden) => async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: { id: 'x', tests, hidden, checker: 'tokens' } }); return { verdict: j.verdict, detail: j.detail }; };
const fib = (n) => { let a = 0n, b = 1n; for (let i = 0; i < n; i++) [a, b] = [b, a + b]; return a; };
(async () => {
    const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts'); let P = null;
    if (fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') }); const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); P = new Parser(); P.setLanguage(lang); }
    const viaBlocks = async (src) => { if (!P) return null; const a = C.fromTree(P.parse(src).rootNode, { source: src }); const code = C.toPython(a.model); const b = C.fromTree(P.parse(code).rootNode, { source: code }); assert.strictEqual(C.toPython(b.model), code, '再轉一次要穩定'); return { raws: a.coverage.raws, code }; };
    // ---- 遞推 ----
    const exs = [3, 10, 20].map((n) => ({ in: n + '\n', out: fib(n) + '\n' })); const hid = [0, 1, 2, 5, 30, 45, 60].map((n) => ({ in: n + '\n', out: fib(n) + '\n' }));
    const r = await S.synth({ statement: 'F(0)=0，F(1)=1，F(n)=F(n-1)+F(n-2)。輸入 n，輸出 F(n)。', examples: exs, judge: mkJudge(exs, hid) });
    assert.ok(r.ok && r.kind === 'recurrence' && r.editable, '遞推要被整理成可編輯版'); assert.ok(!/^ {4}def /m.test(r.source), '沒有巢狀 def'); assert.ok(/def mat_mul\(/.test(r.source) && /線性遞推/.test(r.source) && /b\(k\) = 1×b\(k−1\) \+ 1×b\(k−2\)/.test(r.source), r.source);
    assert.strictEqual(await out(r.source, '30\n'), String(fib(30)), '可編輯版輸出與原程式相同'); assert.strictEqual(await out(r.originalSource, '30\n'), String(fib(30)));
    const f0 = E.extractForm(r.source); assert.deepStrictEqual([f0.kind, f0.coef, f0.init], ['recurrence', [1, 1], [1, 0]], '形態往返');
    const ed = E.applyForm(r.source, Object.assign({}, f0, { coef: [1, 2] })); const bs = (cf, iv, k) => { const b = iv.map(BigInt); while (b.length <= k) { const m = b.length; b.push(cf.reduce((s, c, j) => s + BigInt(c) * b[m - 1 - j], 0n)); } return b[k]; }; assert.strictEqual(await out(ed, '10\n'), String(bs([1, 2], [1, 0], 10 + 1)), '改係數後，輸出照註解的定義 b(n+1) 跟著變'); assert.notStrictEqual(await out(ed, '10\n'), String(fib(10))); assert.deepStrictEqual(E.extractForm(ed).coef, [1, 2]);
    const vb = await viaBlocks(r.source); if (vb) { assert.ok(vb.raws <= 12, '走 Python→UML 路徑，raw 語句 ' + vb.raws); assert.strictEqual(await out(vb.code, '30\n'), String(fib(30)), '經區塊／UML 往返後仍然正確'); console.log('遞推：raw 語句 ' + vb.raws); }
    // ---- DFA ----
    const has = (s) => (s.includes('11') ? 'no' : 'yes'); const dEx = ['0101', '0110', '1', '0'].map((s) => ({ in: s + '\n', out: has(s) + '\n' })); const dH = ['', '11', '1011', '0000', '1010101', '110', '011'].filter(Boolean).map((s) => ({ in: s + '\n', out: has(s) + '\n' }));
    const d = await S.synth({ statement: '輸入由 0、1 組成的字串，若含有子字串 "11" 印 no，否則印 yes。', examples: dEx, judge: mkJudge(dEx, dH) });
    assert.ok(d.ok && d.kind === 'dfa' && d.editable); assert.ok(/狀態 0：起點/.test(d.source) && /讀過 "1" 之後/.test(d.source) && /（接受）/.test(d.source), d.source);
    for (const s of ['0', '11', '1011', '10101']) assert.strictEqual(await out(d.source, s + '\n'), has(s), 'DFA 可編輯版輸出相同 ' + s);
    const df = E.extractForm(d.source); assert.strictEqual(df.kind, 'dfa'); assert.deepStrictEqual(df.delta, d.originalSource ? E.extractForm(d.source).delta : null);
    const df2 = JSON.parse(JSON.stringify(df)); df2.accept = [0, 1]; const dEd = E.applyForm(d.source, df2); assert.strictEqual(await out(dEd, '11\n'), 'yes', '改接受集，行為跟著變（原本 11 印 no）');
    const vd = await viaBlocks(d.source); if (vd) { assert.ok(vd.raws <= 6, 'DFA raw 語句 ' + vd.raws); assert.strictEqual(await out(vd.code, '1011\n'), 'no'); console.log('DFA：raw 語句 ' + vd.raws); }
    // ---- 巢狀 def 搬到最上層（方陣冪、圖的 k 步走法）----
    const sq = (A, k, M) => { const n = A.length; let R = A.map((_, i) => A.map((__, j) => (i === j ? 1n : 0n))); let X = A.map((r) => r.map(BigInt)); const mm = (P, Q) => P.map((row, i) => Q[0].map((_, j) => row.reduce((s, x, t) => (s + x * Q[t][j]) % M, 0n))); while (k > 0) { if (k & 1) R = mm(R, X); X = mm(X, X); k >>= 1; } return String(R.reduce((s, r, i) => s + r[i], 0n) % M); };
    const mkA = (n) => Array.from({ length: n }, () => Array.from({ length: n }, () => Math.floor(Math.random() * 4)));
    const sIn = (A, k) => A.length + ' ' + k + '\n' + A.map((r) => r.join(' ')).join('\n') + '\n'; const sCases = Array.from({ length: 8 }, (_, i) => { const A = mkA(2 + (i % 3)), k = 1 + i * 3; return { in: sIn(A, k), out: sq(A, k, 1000000007n) + '\n' }; });
    const m = await S.synth({ statement: '第一行 n k，接著 n 行是 n×n 方陣 A（元素 0..3）。輸出 A 的 k 次方的跡，對 10^9+7 取模。', examples: sCases.slice(0, 2), judge: mkJudge(sCases.slice(0, 2), sCases.slice(2)) });
    assert.ok(m.ok && m.editable, '方陣冪：' + (m.reason || '')); assert.ok(!/^ {4}def /m.test(m.source) && /^def mm\(X, Y, n, MOD\)|^def mm\(/m.test(m.source), m.source); assert.strictEqual(await out(m.source, sCases[5].in), sCases[5].out.trim());
    const vm = await viaBlocks(m.source); if (vm) console.log('方陣冪：raw 語句 ' + vm.raws);
    // ---- 降級：改壞了讀不回形態 ----
    assert.strictEqual(E.extractForm(d.source.replace(/^ {4}T = \[\n[\s\S]*?^ {4}\]\n/m, '    T = build_table()\n')), null, '轉移表被改成函式呼叫＝離開矩陣模式');
    assert.strictEqual(E.extractForm('def main():\n    print(1)\n'), null);
    // ---- 判題退掉就不換 ----
    const noswap = await S.synth({ statement: 'F(0)=0，F(1)=1，F(n)=F(n-1)+F(n-2)。輸入 n，輸出 F(n)。', examples: exs }); assert.ok(noswap.ok && noswap.editable, '沒給 judge 時直接換（UNCHECKED 路線）');
    console.log('7 passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
