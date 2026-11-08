'use strict';
// 矩陣 → Blockly 區塊：合成 → 拆成有名字的區塊段落 → 編回 Python，與原程式在「題庫全部測資＋隨機輸入」上輸出一致；
// 改槽位（轉移表／接受集／係數／初值／取模／組合層積木）後輸出照新形態的定義變；改壞時 setForm 回 ok:false（降級成一般區塊）。需 tree-sitter 快取與 python3。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const S = require('./matrix_synth_core.js'), G = require('./matrix_graph_core.js'), L0 = require('./matrix_l0_core.js'), CP = require('./matrix_compose_core.js'), E = require('./matrix_edit_core.js'), MB = require('./matrix_blocks_core.js');
const C2U = require('../uml/py_code2uml_core.js'), PB = require('../uml/py_blocks_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
G.install(S); L0.install(S); CP.install(S, G); E.install(S);
const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts'); const seed = path.join(__dirname, '..', 'recipe', 'seed');
const load = (f) => fs.readFileSync(path.join(seed, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// 一個 python 行程跑很多輸入（每個輸入重設 stdin、收 stdout；例外記成 ERR:型別）
const DRIVER = 'import sys,io,json\nsrc=open(sys.argv[1],encoding="utf8").read()\nns={}\nexec(compile(src,"x","exec"),ns)\nouts=[]\nfor inp in json.load(open(sys.argv[2],encoding="utf8")):\n    sys.stdin=io.StringIO(inp); buf=io.StringIO(); old=sys.stdout; sys.stdout=buf\n    try:\n        ns["main"]()\n    except BaseException as e:\n        buf.write("ERR:"+type(e).__name__)\n    sys.stdout=old; outs.append(buf.getvalue().strip())\nprint(json.dumps(outs))\n';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-')); fs.writeFileSync(path.join(tmp, 'drv.py'), DRIVER);
function runMany(src, inputs) { fs.writeFileSync(path.join(tmp, 's.py'), src); fs.writeFileSync(path.join(tmp, 'i.json'), JSON.stringify(inputs)); const r = cp.spawnSync('python3', ['-I', path.join(tmp, 'drv.py'), path.join(tmp, 's.py'), path.join(tmp, 'i.json')], { encoding: 'utf8', timeout: 60000 }); if (r.status !== 0) throw new Error('python 失敗：' + (r.stderr || '').slice(-300)); return JSON.parse(r.stdout); }
const rnd = (n) => Math.floor(Math.random() * n);
const mkJudge = (tests, hidden) => async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: { id: 'x', tests, hidden, checker: 'tokens' } }); return { verdict: j.verdict, detail: j.detail }; };
let checks = 0; const same = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR + '\n0 failed'); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') }); const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const B = PB.makeBlocks({ parseTree: (s) => P.parse(s), C2U }); const M = MB.makeMatrixBlocks({ B, C2U, parseTree: (s) => P.parse(s), CP });
    const roundTrip = (res, inputs, label) => { const dec = M.decompile(res); assert.ok(dec.ok, label + ' 反編譯：' + (dec.reason || '')); const src2 = M.compile(dec); const a = runMany(res.source, inputs), b = runMany(src2, inputs); same(b, a, label + ' 區塊編回的程式輸出要與原程式相同'); assert.ok(!a.some((x) => /^ERR:/.test(x)), label + ' 原程式不該丟例外：' + a.find((x) => /^ERR:/.test(x))); return { dec, src2, outs: a }; };
    // CNL 往返（區塊 → 受控自然語言 → 區塊 → 同一個程式）
    const cnlRound = (dec, label) => { for (const o of dec.ops) { const t = B.toCNL(o.blocks); const pr = B.parseCNL(t); assert.ok(pr.ok, label + ' CNL 解析：' + JSON.stringify(pr.errors.slice(0, 2)) + '\n' + t); assert.deepStrictEqual(B.toIR(pr.blocks), B.toIR(o.blocks), label + ' CNL 往返 IR 相同'); checks++; } };
    const stat = { ok: 0, n: 0, generic: 0, blocks: 0, byKind: {} };
    // ---- 1. DFA ----
    const has = (s) => (s.includes('11') ? 'no' : 'yes'); const dEx = ['0101', '0110', '1', '0'].map((s) => ({ in: s + '\n', out: has(s) + '\n' })); const dH = ['11', '1011', '0000', '1010101', '110', '011'].map((s) => ({ in: s + '\n', out: has(s) + '\n' }));
    const d = await S.synth({ statement: '輸入由 0、1 組成的字串，若含有子字串 "11" 印 no，否則印 yes。', examples: dEx, judge: mkJudge(dEx, dH) }); assert.ok(d.ok && d.kind === 'dfa');
    const rs = () => Array.from({ length: 80 }, () => Array.from({ length: rnd(14) + 1 }, () => rnd(2)).join('') + '\n');
    const dIn = rs(); const rd = roundTrip(d, dIn, 'DFA'); cnlRound(rd.dec, 'DFA');
    assert.deepStrictEqual(rd.dec.segments.map((s) => s.role), ['read', 'table', 'start', 'scan', 'print'], 'DFA 分段：' + rd.dec.segments.map((s) => s.role));
    same(rd.outs, dIn.map((s) => has(s.trim())), 'DFA 輸出與獨立的 JS 參考相同');
    const f0 = M.readForm(rd.dec); assert.strictEqual(f0.kind, 'dfa'); assert.deepStrictEqual(f0.delta, d.matrixForm.delta, '從區塊讀回的轉移表與合成時相同');
    const sim = (f, s) => { let q = f.start; for (const ch of s) q = f.delta[q][ch]; return f.accept.includes(q); };
    { const f2 = JSON.parse(JSON.stringify(f0)); const e1 = M.setForm(rd.dec, { accept: f2.accept.length ? [].concat(...[f2.delta.map((_, i) => i).filter((i) => !f2.accept.includes(i))]) : [0] }); assert.ok(e1.ok, '改接受集：' + e1.reason); const ff = M.readForm(e1); const outs = runMany(M.compile(e1), dIn); same(outs, dIn.map((s) => (sim(ff, s.trim()) ? 'no' : 'yes')), '改接受集後輸出照新形態'); assert.notDeepStrictEqual(outs, rd.outs, '接受集改了，輸出必須不同'); }
    { const f2 = JSON.parse(JSON.stringify(f0)); f2.delta = f2.delta.map((r) => Object.assign({}, r, { 0: r['0'] })); const dl = f0.delta.map((r) => Object.assign({}, r)); const q1 = dl.findIndex((r) => r['1'] !== undefined); dl[0] = Object.assign({}, dl[0], { '1': 0 }); const e2 = M.setForm(rd.dec, { delta: dl }); assert.ok(e2.ok, e2.reason); const ff = M.readForm(e2); same(runMany(M.compile(e2), dIn), dIn.map((s) => (sim(ff, s.trim()) ? 'no' : 'yes')), '改轉移表後輸出照新形態'); }
    { const noT = JSON.parse(JSON.stringify(rd.dec)); noT.segments = noT.segments.filter((s) => s.role !== 'table'); assert.strictEqual(M.readForm(noT), null, '轉移表區塊被刪＝離開矩陣模式'); assert.strictEqual(M.setForm(noT, { delta: [{}] }).ok, false, '找不到轉移表區塊要明確失敗'); checks++; }
    stat.byKind.dfa = rd.dec.stats;
    // ---- 2. 線性遞推（含取模）----
    const fib = (n, M_) => { let a = 0n, b = 1n; for (let i = 0; i < n; i++) [a, b] = [b, a + b]; return M_ ? String(a % BigInt(M_)) : String(a); };
    const rEx = [3, 10, 20].map((n) => ({ in: n + '\n', out: fib(n) + '\n' })); const rHid = [0, 1, 2, 5, 30, 45, 60].map((n) => ({ in: n + '\n', out: fib(n) + '\n' }));
    const r1 = await S.synth({ statement: 'F(0)=0，F(1)=1，F(n)=F(n-1)+F(n-2)。輸入 n，輸出 F(n)。', examples: rEx, judge: mkJudge(rEx, rHid) }); assert.ok(r1.ok && r1.kind === 'recurrence');
    const nIn = Array.from({ length: 60 }, () => rnd(200) + '\n'); const rr = roundTrip(r1, nIn, '遞推'); cnlRound(rr.dec, '遞推'); same(rr.outs, nIn.map((s) => fib(Number(s))), '遞推輸出與 JS 參考相同');
    const mOf = 1000000007; const mEx = [10, 50, 100].map((n) => ({ in: n + '\n', out: fib(n, mOf) + '\n' })); const mHid = [0, 1, 2, 77, 200, 1000].map((n) => ({ in: n + '\n', out: fib(n, mOf) + '\n' }));
    const r2 = await S.synth({ statement: 'F(0)=0，F(1)=1，F(n)=F(n-1)+F(n-2)。輸入 n，輸出 F(n) 對 1000000007 取模。', examples: mEx, judge: mkJudge(mEx, mHid) }); assert.ok(r2.ok && r2.kind === 'recurrence' && r2.matrixForm.mod === mOf, '取模遞推：' + (r2.reason || JSON.stringify(r2.matrixForm)));
    const nIn2 = Array.from({ length: 50 }, () => rnd(5000) + '\n'); const rm = roundTrip(r2, nIn2, '遞推取模'); same(rm.outs, nIn2.map((s) => fib(Number(s), mOf)), '取模遞推輸出與 JS 參考相同'); assert.strictEqual(M.readForm(rm.dec).mod, mOf);
    const bs = (cf, iv, k, M_) => { const b = iv.map(BigInt); while (b.length <= k) { const m = b.length; b.push(cf.reduce((s, c, j) => s + BigInt(c) * b[m - 1 - j], 0n) % (M_ ? BigInt(M_) : (1n << 4000n))); } return String(b[k]); };
    { const e = M.setForm(rr.dec, { coef: [1, 2] }); assert.ok(e.ok, e.reason); const f = M.readForm(e); same(f.coef, [1, 2]); const outs = runMany(M.compile(e), nIn.slice(0, 40)); same(outs, nIn.slice(0, 40).map((s) => bs([1, 2], f.init, Number(s) + 1 - 0 + (r1.matrixForm.offset ? 0 : 0))), '改係數後輸出照遞推定義（b(n+1)）'); }
    { const e = M.setForm(rm.dec, { mod: 998244353 }); assert.ok(e.ok, e.reason); const outs = runMany(M.compile(e), nIn2.slice(0, 30)); same(outs, nIn2.slice(0, 30).map((s) => fib(Number(s), 998244353)), '改取模後輸出照新模數'); const e3 = M.setForm(rr.dec, { init: [2, 1] }); assert.ok(e3.ok); const ff = M.readForm(e3); same(runMany(M.compile(e3), nIn.slice(0, 30)), nIn.slice(0, 30).map((s) => bs(ff.coef, [2, 1], Number(s) + 1)), '改初值後輸出照新初值'); }
    stat.byKind.recurrence = rr.dec.stats;
    // ---- 3. 題庫：圖（可達／最短路…）、格子、方陣、組合層：全部測資＋隱藏測資一致 ----
    const files = ['heldout2_graph.jsonl', 'heldout3_graph.jsonl', 'heldout4_graph.jsonl', 'heldout6_compose.jsonl']; const perKind = {}; let total = 0, okN = 0, rtN = 0, acN = 0; const fails = [];
    for (const f of files) for (const p of load(f)) {
        const ex = p.tests.slice(0, 2), hid = p.tests.slice(2).concat(p.hidden || []); const res = await S.synth({ statement: p.statement, examples: ex, judge: mkJudge(ex, hid) }); total++; if (!res.ok || !res.matrixForm) continue; okN++;
        const dec = M.decompile(res); if (!dec.ok) { fails.push(p.id + ' 反編譯：' + dec.reason); continue; } const src2 = M.compile(dec); const ins = p.tests.concat(p.hidden || []).map((t) => t.in);
        const a = runMany(res.source, ins), b = runMany(src2, ins); const k = res.matrixForm.kind; perKind[k] = perKind[k] || { n: 0, same: 0, blocks: 0, generic: 0 }; perKind[k].n++; perKind[k].blocks += dec.stats.blocks; perKind[k].generic += dec.stats.generic;
        if (JSON.stringify(a) === JSON.stringify(b)) { perKind[k].same++; rtN++; } else fails.push(p.id + ' 往返輸出不同');
        const expect = p.tests.concat(p.hidden || []).map((t) => t.out.trim().split(/\s+/).join(' ')); if (JSON.stringify(b.map((x) => x.split(/\s+/).join(' '))) === JSON.stringify(expect)) acN++;
        try { cnlRound(dec, p.id); } catch (e) { fails.push(p.id + ' CNL：' + String(e.message).split('\n')[0]); }
    }
    console.log('題庫 ' + total + ' 題，合成成功 ' + okN + '，區塊編回後輸出與原程式一致 ' + rtN + '，其中與題庫預期輸出完全相同 ' + acN); console.log(JSON.stringify(perKind)); if (fails.length) console.log('失敗：\n' + fails.join('\n'));
    assert.strictEqual(rtN, okN, '合成成功的題，區塊往返必須全部一致'); assert.ok(okN >= 40, '合成成功題數下限 40：' + okN); assert.ok(rtN === okN && fails.length === 0, fails.join(';'));
    // ---- 4. 圖：可達／最短路 隨機輸入對照 JS 參考 ----
    const mkG = (n, m, directed) => { const es = []; for (let i = 0; i < m; i++) es.push([rnd(n) + 1, rnd(n) + 1]); return es; };
    const gIn = (n, es, tail) => n + ' ' + es.length + '\n' + es.map((e) => e.join(' ')).join('\n') + (es.length ? '\n' : '') + (tail ? tail + '\n' : '');
    const reachSt = '第一行 n m，接著 m 行每行 u v 表示有向邊（節點編號 1..n）。輸出從節點 1 出發可以到達的節點個數（含自己）。'; const reachJs = (n, es) => { const adj = Array.from({ length: n + 1 }, () => []); es.forEach(([u, v]) => adj[u].push(v)); const seen = new Set([1]); const st = [1]; while (st.length) { const x = st.pop(); for (const y of adj[x]) if (!seen.has(y)) { seen.add(y); st.push(y); } } return String(seen.size); };
    const rg = () => { const n = rnd(7) + 2, es = mkG(n, rnd(10)); return { n, es }; }; const gs = Array.from({ length: 3 }, rg); const gex = gs.map((g) => ({ in: gIn(g.n, g.es), out: reachJs(g.n, g.es) + '\n' }));
    const gr = await S.synth({ statement: reachSt, examples: gex }); assert.ok(gr.ok && gr.kind === 'graph', '可達：' + (gr.reason || gr.kind));
    const rgs = Array.from({ length: 60 }, rg); const rgIn = rgs.map((g) => gIn(g.n, g.es)); const rgR = roundTrip(gr, rgIn, '圖可達'); same(rgR.outs, rgs.map((g) => reachJs(g.n, g.es)), '圖可達輸出與 JS 參考相同'); assert.ok(rgR.dec.segments.some((s) => s.role === 'graph'), '圖有「建圖」段：' + rgR.dec.segments.map((s) => s.role)); stat.byKind.graph = rgR.dec.stats;
    const hopSt = '第一行 n m，接著 m 行每行 u v 表示無向邊（節點編號 1..n），最後一行 s t。輸出 s 到 t 的最少邊數，走不到輸出 -1。'; const hopJs = (n, es, s, t) => { const adj = Array.from({ length: n + 1 }, () => []); es.forEach(([u, v]) => { adj[u].push(v); adj[v].push(u); }); const d = Array(n + 1).fill(-1); d[s] = 0; const q = [s]; for (let i = 0; i < q.length; i++) for (const y of adj[q[i]]) if (d[y] < 0) { d[y] = d[q[i]] + 1; q.push(y); } return String(d[t]); };
    const hg = () => { const n = rnd(7) + 2, es = mkG(n, rnd(9) + 1), s = rnd(n) + 1, t = rnd(n) + 1; return { n, es, s, t }; }; const hs = Array.from({ length: 4 }, hg); const hex = hs.map((g) => ({ in: gIn(g.n, g.es, g.s + ' ' + g.t), out: hopJs(g.n, g.es, g.s, g.t) + '\n' }));
    const hr = await S.synth({ statement: hopSt, examples: hex }); assert.ok(hr.ok && hr.kind === 'graph', '最短路：' + (hr.reason || hr.kind)); const hss = Array.from({ length: 60 }, hg); const hIn = hss.map((g) => gIn(g.n, g.es, g.s + ' ' + g.t)); const hR = roundTrip(hr, hIn, '圖最少邊數'); same(hR.outs, hss.map((g) => hopJs(g.n, g.es, g.s, g.t)), '最少邊數輸出與 JS 參考相同');
    // ---- 5. 格子 ----
    const gridP = load('heldout3_graph.jsonl').find((p) => p.id === 'h3-col-sums'); { const ex = gridP.tests.slice(0, 2); const res = await S.synth({ statement: gridP.statement, examples: ex }); assert.ok(res.ok && res.kind === 'grid'); const mk = () => { const r = rnd(5) + 1, c = rnd(5) + 1; const G_ = Array.from({ length: r }, () => Array.from({ length: c }, () => rnd(19) - 9)); return { r, c, G_ }; }; const gl = Array.from({ length: 50 }, mk); const ins = gl.map((g) => g.r + ' ' + g.c + '\n' + g.G_.map((x) => x.join(' ')).join('\n') + '\n'); const rt = roundTrip(res, ins, '格子每欄總和'); same(rt.outs, gl.map((g) => g.G_[0].map((_, j) => g.G_.reduce((s, row) => s + row[j], 0)).join(' ')), '格子每欄總和與 JS 參考相同'); stat.byKind.grid = rt.dec.stats; }
    // ---- 6. 組合層：分段、換積木 ----
    const cp6 = load('heldout6_compose.jsonl').find((p) => p.id === 'h6-ecc'); const cex = cp6.tests.slice(0, 2); const cres = await S.synth({ statement: cp6.statement, examples: cex }); assert.ok(cres.ok && cres.kind === 'compose', '組合層：' + (cres.reason || cres.kind));
    { const cdec = M.decompile(cres); assert.deepStrictEqual(cdec.segments.map((s) => s.role), ['read', 'vector', 'filter', 'reduce', 'print'], '組合層分成五段：' + cdec.segments.map((s) => s.role)); const ins = cp6.tests.concat(cp6.hidden || []).map((t) => t.in); const a = runMany(cres.source, ins); same(runMany(M.compile(cdec), ins), a, '組合層區塊編回後輸出一致'); cnlRound(cdec, '組合層');
        const sw = M.setCompose(cdec, { reducer: 'min' }); assert.ok(sw.ok, sw.reason); same(M.readForm(sw).reducer, 'min'); const ref = cres.source.replace('ans = max(v)', 'ans = min(v)'); assert.notStrictEqual(ref, cres.source); same(runMany(M.compile(sw), ins), runMany(ref, ins), '換歸約積木 max→min 後輸出照新積木'); assert.notDeepStrictEqual(runMany(M.compile(sw), ins), a, '換了積木輸出必須不同（否則測不到）');
        const sw2 = M.setCompose(cdec, { reducer: 'sorted-asc' }); assert.strictEqual(sw2.ok, false, '輸出型態不同要明確失敗（整數 → 清單）'); const sw3 = M.setCompose(cdec, { vector: 'degree', reducer: 'sum' }); assert.ok(sw3.ok, sw3.reason); const refB = cres.source; const gsrc = M.compile(sw3); assert.ok(/len\(adj\[i\]\)/.test(gsrc) && /ans = sum\(v\)/.test(gsrc), '換向量＋歸約：\n' + gsrc); const o3 = runMany(gsrc, ins); assert.ok(!o3.some((x) => /^ERR:/.test(x)), '換積木後程式能跑'); checks++;
        const nonGraph = M.setCompose(cdec, { vector: 'row-sum' }); assert.strictEqual(nonGraph.ok, false, '圖與格子的向量積木不能互換'); stat.byKind.compose = cdec.stats; }
    // ---- 7. 區塊統計 ----
    let blocks = 0, generic = 0; for (const k of Object.keys(perKind)) { blocks += perKind[k].blocks; generic += perKind[k].generic; } console.log('區塊總數 ' + blocks + '，其中通用「程式」區塊 ' + generic + '（比例 ' + (100 * generic / blocks).toFixed(1) + '%）');
    console.log(checks + ' checks; 12 passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
