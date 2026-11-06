'use strict';
// 內建的課（老師教、驗證過）要能泛化：沒見過的改寫（換變數名稱、不同的隨機測資）完全不問模型、離線自己做對；
// 不認得的算法不會被亂套一堂課（要回報「需要模型」）。期望輸出由「種子題的參考程式」在同一份輸入上算出來。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), cp = require('child_process');
const C2U = require('./py_code2uml_core.js'), PBL = require('./py_blocks_core.js'), RU = require('./py_blocks_rules_core.js'), PB = require('./py_body_core.js'), UC = require('./uml_core.js'), AI = require('./algo_intent_core.js'), PL = require('./py_uml_pipeline_core.js'), CH = require('./py_cnl_choose_core.js'), LS = require('./py_lessons_core.js'), BUILTIN = require('./py_lessons_builtin.js');
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
    let ok = 0; const bad = []; let usedLesson = 0;
    for (const [id, rw] of VARIANTS) {
        const statement = rw(probs[id].statement); const tests = []; for (let k = 0; k < 6; k++) { const input = GEN[id](); const out = runRef(id, input); if (out !== null) tests.push({ in: input, out }); }
        const uml = await UC.scenarioToModel(statement, { readers: [AI.reader] }); if (!uml.ok || !uml.fromHints) { bad.push(id + '：uml_design 讀不出改寫後的題目'); continue; }
        const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: { id, tests: tests.slice(0, 2) } }); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge, Lessons: LS, lessons: BUILTIN.lessons });
        if (!r.ok) { bad.push(id + '：' + r.reason); continue; }
        const j = await J.judge({ lang: 'python', source: r.source + '\nmain()\n', problem: { id, tests } }); if (j.verdict === 'AC') { ok++; if (r.lesson) usedLesson++; } else bad.push(id + '：' + j.verdict + ' ' + String(j.detail || '').slice(0, 100));
    }
    console.log('沒見過的改寫（換變數名稱、隨機測資）' + ok + '/' + VARIANTS.length + ' 離線自己做對（不問任何模型；其中靠課 ' + usedLesson + '）'); bad.forEach((b) => console.log('  ✗ ' + b));
    // 不認得的算法：不能亂套課，要回報需要模型
    const odd = '輸入一行兩個整數 a b。輸出 a 的 b 次方除以 7 的餘數。'; const uml2 = await UC.scenarioToModel(odd, { readers: [AI.reader] }); const r2 = await PL.buildFromUML({ statement: odd, uml: { hints: uml2.hints, model: uml2.model }, B, R, C2U, FaPyBody: PB, Choose: CH, Lessons: LS, lessons: BUILTIN.lessons });
    assert.strictEqual(r2.ok, false); assert.ok(/需要模型|沒有配方/.test(r2.reason), r2.reason); assert.ok(!r2.lesson);
    assert.strictEqual(bad.length, 0, bad.join('；')); console.log((ok + 1) + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.log('0 passed, 1 failed'); process.exit(1); });
