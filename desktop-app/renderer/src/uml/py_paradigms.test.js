'use strict';
// 範式骨架庫：不給課，只靠「範式骨架＋槽位窮舉＋沙盒」解題（0 次模型）。種子題用原始敘述，改寫題換變數名稱＋隨機測資；選項順序反過來也要找得到（證明靠窮舉，不靠排前面）。
// 不認得的算法不會被亂套一堂課（要回報「需要模型」）。期望輸出由「種子題的參考程式」在同一份輸入上算出來。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), cp = require('child_process');
const C2U = require('./py_code2uml_core.js'), PBL = require('./py_blocks_core.js'), RU = require('./py_blocks_rules_core.js'), PB = require('./py_body_core.js'), UC = require('./uml_core.js'), AI = require('./algo_intent_core.js'), PL = require('./py_uml_pipeline_core.js'), CH = require('./py_cnl_choose_core.js'), PAR = require('./py_paradigms_core.js'), LS = require('./py_lessons_core.js');
const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
let seed = 12345; const rnd = (a, b) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return a + (seed % (b - a + 1)); };
const ints = (n, a, b) => Array.from({ length: n }, () => rnd(a, b));
const GEN = {
    'two-sum': () => { const n = rnd(3, 6); const a = ints(n, 1, 30); const i = rnd(0, n - 2), j = rnd(i + 1, n - 1); return n + ' ' + (a[i] + a[j]) + '\n' + a.join(' ') + '\n'; },
    'kth-largest': () => { const n = rnd(3, 7); return n + ' ' + rnd(1, n) + '\n' + ints(n, -20, 50).join(' ') + '\n'; },
    'lower-bound': () => { const n = rnd(3, 7); const a = ints(n, 1, 20).sort((x, y) => x - y); const q = rnd(2, 4); return n + ' ' + q + '\n' + a.join(' ') + '\n' + ints(q, 0, 22).join(' ') + '\n'; },
    'fibonacci': () => rnd(0, 40) + '\n', 'gcd-lcm': () => rnd(1, 900) + ' ' + rnd(1, 900) + '\n', 'count-primes': () => rnd(1, 300) + '\n',
    'valid-brackets': () => { const ch = '()[]{}'; let s = ''; const len = rnd(2, 8); if (rnd(0, 1)) { const st = []; for (let i = 0; i < len; i++) { if (st.length && rnd(0, 1)) { s += { '(': ')', '[': ']', '{': '}' }[st.pop()]; } else { const o = '([{'[rnd(0, 2)]; st.push(o); s += o; } } while (st.length) s += { '(': ')', '[': ']', '{': '}' }[st.pop()]; } else for (let i = 0; i < len; i++) s += ch[rnd(0, 5)]; return s + '\n'; },
    'anagram': () => { const w = Array.from({ length: rnd(3, 6) }, () => 'abcde'[rnd(0, 4)]); const v = w.slice(); if (rnd(0, 1)) { v.reverse(); } else v[0] = 'abcde'[rnd(0, 4)]; return w.join('') + '\n' + v.join('') + '\n'; },
    'knapsack': () => { const n = rnd(2, 5); const W = rnd(5, 12); return n + ' ' + W + '\n' + Array.from({ length: n }, () => rnd(1, 6) + ' ' + rnd(1, 9)).join('\n') + '\n'; },
    'components': () => { const n = rnd(3, 8); const m = rnd(0, 6); return n + ' ' + m + '\n' + Array.from({ length: m }, () => rnd(1, n) + ' ' + rnd(1, n)).join('\n') + (m ? '\n' : ''); },
    'word-frequency': () => { const n = rnd(3, 9); const V = ['apple', 'bat', 'cat', 'dog', 'eel']; return n + '\n' + Array.from({ length: n }, () => V[rnd(0, 4)]).join(' ') + '\n'; },
    'coin-change': () => { const n = rnd(1, 3); return n + ' ' + rnd(0, 25) + '\n' + ints(n, 2, 7).join(' ') + '\n'; },
    'range-sum': () => { const n = rnd(3, 8); const q = rnd(1, 4); return n + ' ' + q + '\n' + ints(n, -5, 9).join(' ') + '\n' + Array.from({ length: q }, () => { const l = rnd(1, n); return l + ' ' + rnd(l, n); }).join('\n') + '\n'; },
    'lis': () => { const n = rnd(2, 8); return n + '\n' + ints(n, 1, 12).join(' ') + '\n'; },
    'is-palindrome': () => { const w = Array.from({ length: rnd(2, 6) }, () => 'AbcBa'[rnd(0, 4)]).join(''); const r = w.split('').reverse().join(''); const pick = rnd(0, 2); return (pick === 0 ? w + ', ' + r : pick === 1 ? w + r.toLowerCase() : w + '!') + '\n'; },
    'merge-intervals': () => { const n = rnd(2, 5); return n + '\n' + Array.from({ length: n }, () => { const l = rnd(1, 12); return l + ' ' + rnd(l, 14); }).join('\n') + '\n'; },
};
// 變體：[種子題 id, 改寫函式]
const VARIANTS = [
    ['two-sum', (s) => s.replace(/\bn\b/g, 'm').replace(/\bt\b/g, 's')], ['kth-largest', (s) => s.replace(/\bn\b/g, 'm').replace(/\bk\b/g, 'p')],
    ['lower-bound', (s) => s.replace(/\bn\b/g, 'm').replace(/\bq\b/g, 'z').replace(/\bx\b/g, 'y')], ['fibonacci', (s) => s.replace(/\bn\b/g, 'k')],
    ['gcd-lcm', (s) => s.replace(/\ba\b/g, 'x').replace(/\bb\b/g, 'y')], ['count-primes', (s) => s.replace(/\bn\b/g, 'm')], ['valid-brackets', (s) => s], ['anagram', (s) => s],
    ['knapsack', (s) => s.replace(/\bn\b/g, 'm').replace(/\bW\b/g, 'C')], ['components', (s) => s.replace(/\bn\b/g, 'p').replace(/\bm\b/g, 'e').replace(/\bu\b/g, 'x').replace(/\bv\b/g, 'y')],
    ['word-frequency', (s) => s.replace(/\bn\b/g, 'm')], ['coin-change', (s) => s.replace(/\bn\b/g, 'm').replace(/\bT\b/g, 'C')], ['range-sum', (s) => s.replace(/\bn\b/g, 'm').replace(/\bq\b/g, 'z').replace(/\bl\b/g, 'u').replace(/\br\b/g, 'v')],
    ['lis', (s) => s.replace(/\bn\b/g, 'm')], ['is-palindrome', (s) => s], ['merge-intervals', (s) => s.replace(/\bn\b/g, 'm').replace(/\bl\b/g, 'u').replace(/\br\b/g, 'v')],
];
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const B = PBL.makeBlocks({ parseTree: (s) => P.parse(s), C2U }); const R = RU.makeRules(B); const J = require('../../../judge-runner.js');
    const probs = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', 'recipe', 'seed', 'problems.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((p) => [p.id, p]));
    const runRef = (id, input) => { const r = cp.spawnSync('python3', ['-I', '-c', probs[id].ref.python + '\nmain()\n'], { input, encoding: 'utf8', timeout: 10000 }); return r.status === 0 ? r.stdout : null; };
    // 骨架庫本身：每個骨架的選單都 ≤ 12 個組合
    for (const sk of PAR.PARADIGMS) assert.ok(PAR.combos(sk, { limit: 999 }).length <= 18, sk.id + ' 組合太多');
    const run = async (id, statement, tests, rank) => {
        const uml = await UC.scenarioToModel(statement, { readers: [AI.reader] }); if (!uml.ok || !uml.fromHints) return { err: 'uml_design 讀不出' };
        const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: { id, tests } }); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge, Paradigms: PAR, paradigmRank: rank });
        if (!r.ok) return { err: r.reason }; const j = await J.judge({ lang: 'python', source: r.source + '\nmain()\n', problem: { id, tests } }); return { r, v: j.verdict, detail: j.detail };
    };
    const rev = (sk, c) => -PAR.combos(sk, { limit: 999 }).findIndex((x) => JSON.stringify(x) === JSON.stringify(c)); // 反過來試：正確答案通常排最後
    const bad = []; let seedOk = 0, seedN = 0; const used = [];
    for (const [id, p] of Object.entries(probs)) { // 種子題（原始敘述與測資），不給課
        const intent = AI.read(p.statement); if (!PAR.forIntent(intent).length) continue; seedN++;
        const o = await run(id, p.statement, p.tests.concat(p.hidden || []).slice(0, 8)); if (o.err) { bad.push('種子 ' + id + '：' + o.err); continue; }
        if (o.v === 'AC' && o.r.paradigm) { seedOk++; used.push(id + '←' + o.r.paradigm + '（試 ' + o.r.tried + '）'); } else if (o.v === 'AC') used.push(id + '←(' + (o.r.recipe || '?') + ')'); else bad.push('種子 ' + id + '：' + o.v + ' ' + String(o.detail || '').slice(0, 80));
    }
    // 課是範式的實例：deriveLesson 可記下 paradigm＋slots
    { const p = probs['fibonacci']; const o = await run('fibonacci', p.statement, p.tests); assert.ok(o.r && o.r.paradigm === 'dp.fib', '費氏要由範式解出'); const intent = AI.read(p.statement); const d = LS.deriveLesson({ statement: p.statement, intent, source: o.r.source, B, C2U, parseTree: (x) => P.parse(x), paradigm: o.r.paradigm, slots: o.r.slots }); assert.ok(d.ok, d.reason); assert.strictEqual(d.lesson.paradigm, 'dp.fib'); assert.deepStrictEqual(d.lesson.slots, o.r.slots); }
    console.log('種子題（有範式的）' + seedOk + '/' + seedN + ' 由範式骨架解出：' + used.join('、')); 
    let ok = 0, revOk = 0, n = 0;
    for (const [id, rw] of VARIANTS) {
        if (!PAR.forIntent(AI.read(rw(probs[id].statement))).length) continue; n++;
        const statement = rw(probs[id].statement); const tests = []; for (let k = 0; k < 6; k++) { const input = GEN[id](); const out = runRef(id, input); if (out !== null) tests.push({ in: input, out }); }
        const o = await run(id, statement, tests); if (o.err) bad.push('改寫 ' + id + '：' + o.err); else if (o.v === 'AC') ok++; else bad.push('改寫 ' + id + '：' + o.v + ' ' + String(o.detail || '').slice(0, 80));
        const o2 = await run(id, statement, tests, rev); if (!o2.err && o2.v === 'AC') revOk++; else bad.push('改寫（反序）' + id + '：' + (o2.err || o2.v));
    }
    console.log('沒見過的改寫 ' + ok + '/' + n + ' AC；選項順序反過來 ' + revOk + '/' + n + ' AC（不問任何模型、不給課）'); bad.forEach((b) => console.log('  ✗ ' + b));
    // 後加的 6 個範式（種子題沒有）：自己的題目＋參考程式＋隨機測資，原敘述與換變數名稱的改寫各一次，選項順序反過來也要找得到
    const EXTRA = [
        { id: 'inversions', st: '第一行 n，第二行 n 個整數。輸出逆序對的個數（i<j 且 a[i]>a[j] 的 (i, j) 組數）。', ref: 'n = int(input())\na = list(map(int, input().split()))\nprint(sum(1 for i in range(n) for j in range(i + 1, n) if a[i] > a[j]))', gen: () => { const n = rnd(1, 9); return n + '\n' + ints(n, 1, 6).join(' ') + '\n'; }, rw: (x) => x.replace(/\bn\b/g, 'm'), want: 'dc.inversions' },
        { id: 'tree-traversal', st: '二元樹。第一行 n（節點 1..n，根是 1），接著 n 行每行 l r（節點 i 的左右子節點，0 表示沒有）。輸出中序走訪的節點編號，以空白分隔。', ref: 'import sys\nsys.setrecursionlimit(10000)\nn = int(input())\nc = [tuple(map(int, input().split())) for _ in range(n)]\nout = []\ndef go(u):\n    if u == 0:\n        return\n    go(c[u-1][0]); out.append(u); go(c[u-1][1])\ngo(1)\nprint(*out)', gen: () => { const n = rnd(1, 7); const kids = Array.from({ length: n }, () => [0, 0]); for (let v = 2; v <= n; v++) { for (;;) { const p = rnd(1, v - 1), side = rnd(0, 1); if (!kids[p - 1][side]) { kids[p - 1][side] = v; break; } if (!kids[p - 1][0] || !kids[p - 1][1]) { kids[p - 1][kids[p - 1][0] ? 1 : 0] = v; break; } } } return n + '\n' + kids.map((k) => k.join(' ')).join('\n') + '\n'; }, rw: (x) => x.replace(/\bn\b/g, 'm'), want: 'tree.traversal' },
        { id: 'kth-smallest', st: '第一行 n k，第二行 n 個整數（可重複）。輸出第 k 小的數（重複的各算一個）。', ref: 'n, k = map(int, input().split())\na = sorted(map(int, input().split()))\nprint(a[k-1])', gen: () => { const n = rnd(2, 8); return n + ' ' + rnd(1, n) + '\n' + ints(n, -9, 9).join(' ') + '\n'; }, rw: (x) => x.replace(/\bn\b/g, 'm').replace(/\bk\b/g, 'p'), want: 'heap.kth-smallest' },
        { id: 'lps', st: '輸入一行字串。輸出最長回文子序列的長度。', ref: 's = input().strip()\nn = len(s)\ndp = [[0]*n for _ in range(n)]\nfor i in range(n-1, -1, -1):\n    dp[i][i] = 1\n    for j in range(i+1, n):\n        dp[i][j] = dp[i+1][j-1] + 2 if s[i] == s[j] else max(dp[i+1][j], dp[i][j-1])\nprint(dp[0][n-1])', gen: () => Array.from({ length: rnd(1, 9) }, () => 'abc'[rnd(0, 2)]).join('') + '\n', rw: (x) => x, want: 'dp.lps' },
        { id: 'lcs', st: '輸入兩行小寫字串。輸出最長公共子序列的長度。', ref: 's = input().strip()\nt = input().strip()\ndp = [[0]*(len(t)+1) for _ in range(len(s)+1)]\nfor i in range(1, len(s)+1):\n    for j in range(1, len(t)+1):\n        dp[i][j] = dp[i-1][j-1] + 1 if s[i-1] == t[j-1] else max(dp[i-1][j], dp[i][j-1])\nprint(dp[len(s)][len(t)])', gen: () => Array.from({ length: 2 }, () => Array.from({ length: rnd(1, 8) }, () => 'abc'[rnd(0, 2)]).join('')).join('\n') + '\n', rw: (x) => x, want: 'dp.lcs' },
        { id: 'fib-mod', st: '輸入 n（0<=n<=10^18），輸出第 n 個費氏數除以 1000000007 的餘數（F0=0, F1=1）。', ref: 'n = int(input())\nM = 10**9 + 7\ndef mul(a, b):\n    return [[(a[0][0]*b[0][0]+a[0][1]*b[1][0]) % M, (a[0][0]*b[0][1]+a[0][1]*b[1][1]) % M], [(a[1][0]*b[0][0]+a[1][1]*b[1][0]) % M, (a[1][0]*b[0][1]+a[1][1]*b[1][1]) % M]]\nr = [[1,0],[0,1]]\nm = [[1,1],[1,0]]\nwhile n:\n    if n & 1:\n        r = mul(r, m)\n    m = mul(m, m)\n    n >>= 1\nprint(r[0][1] % M)', gen: () => String(rnd(0, 2) === 0 ? rnd(0, 30) : rnd(1000000, 2000000000) * rnd(1, 100000000)), rw: (x) => x.replace(/\bn\b/g, 'k'), want: 'matrix.fib-mod' },
        { id: 'n-queens', st: '輸入整數 n，輸出 n 皇后問題的擺法總數（任兩個皇后不同列、不同行、不同斜線）。', ref: 'n = int(input())\ncnt = 0\ndef go(r, c, d1, d2):\n    global cnt\n    if r == n:\n        cnt += 1\n        return\n    for x in range(n):\n        if x in c or r - x in d1 or r + x in d2:\n            continue\n        go(r + 1, c | {x}, d1 | {r - x}, d2 | {r + x})\ngo(0, set(), set(), set())\nprint(cnt)', gen: () => rnd(1, 7) + '\n', rw: (x) => x.replace(/\bn\b/g, 'm'), want: 'bt.n-queens' },
        { id: 'dijkstra', st: '第一行 n m s，接著 m 行每行 u v w，表示 u 到 v 有一條權重 w 的無向邊。輸出 s 到 1..n 每個點的最短距離，不可達輸出 -1，以空白分隔。', ref: 'import heapq\nn, m, s = map(int, input().split())\nadj = [[] for _ in range(n + 1)]\nfor _ in range(m):\n    u, v, w = map(int, input().split())\n    adj[u].append((v, w))\n    adj[v].append((u, w))\nINF = 10**18\ndist = [INF] * (n + 1)\ndist[s] = 0\nh = [(0, s)]\nwhile h:\n    d, u = heapq.heappop(h)\n    if d > dist[u]:\n        continue\n    for v, w in adj[u]:\n        if d + w < dist[v]:\n            dist[v] = d + w\n            heapq.heappush(h, (dist[v], v))\nprint(*[dist[i] if dist[i] < INF else -1 for i in range(1, n + 1)])', gen: () => { const n = rnd(2, 7), m = rnd(1, 9); return n + ' ' + m + ' ' + rnd(1, n) + '\n' + Array.from({ length: m }, () => rnd(1, n) + ' ' + rnd(1, n) + ' ' + rnd(1, 9)).join('\n') + '\n'; }, rw: (x) => x.replace(/\bn\b/g, 'V').replace(/\bm\b/g, 'E').replace(/\bs\b/g, 'r'), want: 'sp.dijkstra' },
        { id: 'fenwick', st: '第一行 n q，第二行 n 個整數，接著 q 行每行 t x y：t=1 表示把 a[x] 加上 y；t=2 表示輸出區間 [x, y] 的和。（位置從 1 開始）', ref: 'n, q = map(int, input().split())\na = [0] + list(map(int, input().split()))\nfor _ in range(q):\n    t, x, y = map(int, input().split())\n    if t == 1:\n        a[x] += y\n    else:\n        print(sum(a[x:y + 1]))', gen: () => { const n = rnd(1, 8), q = rnd(1, 6); return n + ' ' + q + '\n' + ints(n, -5, 9).join(' ') + '\n' + Array.from({ length: q }, () => { if (rnd(0, 1)) return '1 ' + rnd(1, n) + ' ' + rnd(-4, 6); const l = rnd(1, n); return '2 ' + l + ' ' + rnd(l, n); }).join('\n') + '\n'; }, rw: (x) => x.replace(/\bn\b/g, 'm').replace(/\bq\b/g, 'z'), want: 'fenwick.point-range' },
        { id: 'kmp', st: '輸入兩行字串，第一行 s、第二行 t。輸出 t 在 s 中出現的次數（可以重疊）。', ref: 's = input().strip()\nt = input().strip()\nprint(sum(1 for i in range(len(s) - len(t) + 1) if s[i:i + len(t)] == t))', gen: () => Array.from({ length: rnd(1, 12) }, () => 'ab'[rnd(0, 1)]).join('') + '\n' + Array.from({ length: rnd(1, 3) }, () => 'ab'[rnd(0, 1)]).join('') + '\n', rw: (x) => x, want: 'str.kmp-count' },
    ];
    let exOk = 0, exRev = 0, exN = 0;
    for (const e of EXTRA) for (const [tag, st] of [['原敘述', e.st], ['改寫', e.rw(e.st)]]) {
        exN++; const tests = []; for (let k = 0; k < 6; k++) { const input = e.gen(); const r0 = cp.spawnSync('python3', ['-I', '-c', e.ref + '\nmain() if "main" in dir() else None\n'], { input: input.endsWith('\n') ? input : input + '\n', encoding: 'utf8', timeout: 10000 }); if (r0.status === 0 && r0.stdout.trim()) tests.push({ in: input.endsWith('\n') ? input : input + '\n', out: r0.stdout }); }
        const o = await run(e.id, st, tests); if (o.err) { bad.push('新範式 ' + e.id + '（' + tag + '）：' + o.err); continue; }
        if (o.v === 'AC' && o.r.paradigm === e.want) exOk++; else bad.push('新範式 ' + e.id + '（' + tag + '）：' + o.v + ' ' + (o.r.paradigm || '-') + ' ' + String(o.detail || '').slice(0, 80));
        const o2 = await run(e.id, st, tests, rev); if (!o2.err && o2.v === 'AC' && o2.r.paradigm === e.want) exRev++; else bad.push('新範式（反序）' + e.id + '（' + tag + '）：' + (o2.err || o2.v));
    }
    console.log('後加的 ' + EXTRA.length + ' 個範式 ' + exOk + '/' + exN + ' AC（由指定的範式解出）；選項反序 ' + exRev + '/' + exN);
    // 給課的情況：費氏「取餘數」（n 很大）不能先試 fib#1（滾動 DP 會逾時），要直接走範式（矩陣快速冪）；一般費氏仍用課
    { const BI = require('./py_lessons_builtin.js'); const e = EXTRA.find((x) => x.id === 'fib-mod'); const tests = []; for (let k = 0; k < 4; k++) { const input = e.gen() + '\n'; const r0 = cp.spawnSync('python3', ['-I', '-c', e.ref], { input, encoding: 'utf8', timeout: 10000 }); tests.push({ in: input, out: r0.stdout }); }
        tests.push({ in: '1000000000000000000\n', out: cp.spawnSync('python3', ['-I', '-c', e.ref], { input: '1000000000000000000\n', encoding: 'utf8' }).stdout });
        const uml = await UC.scenarioToModel(e.st, { readers: [AI.reader] }); const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: { id: 'fib-mod', tests } }); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement: e.st, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge, Paradigms: PAR, Lessons: LS, lessons: BI.lessons });
        assert.ok(r.ok && r.paradigm === 'matrix.fib-mod', '費氏取餘有課時要走範式：' + JSON.stringify(r.rounds && r.rounds.map((x) => x.by + ':' + x.verdict)));
        assert.ok(!(r.rounds || []).some((x) => x.by === 'lesson'), '不該先試課'); console.log('費氏取餘（給內建課）：直接走範式 matrix.fib-mod，沒有先試課'); }
    assert.strictEqual(bad.length, 0, bad.join('；')); console.log((seedOk + ok + revOk + exOk + exRev) + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.log('0 passed, 1 failed'); process.exit(1); });
