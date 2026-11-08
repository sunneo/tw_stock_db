'use strict';
// 第 4 級以上（VM 程式）給出區塊：VM → 結構化 Python → 區塊 → Python，與 VM 在隨機輸入上輸出一致。需 tree-sitter 快取與 python；沒有時略過並說明。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const VM = require('./matrix_vm_core.js'), ST = require('./matrix_structure_core.js'), MB = require('./matrix_blocks_core.js');
const C2U = require('../uml/py_code2uml_core.js'), PB = require('../uml/py_blocks_core.js');
const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
let PY = null; for (const c of ['python', 'python3']) { const r = cp.spawnSync(c, ['-I', '-c', 'print(1)'], { encoding: 'utf8' }); if (r.status === 0 && r.stdout.trim() === '1') { PY = c; break; } }
let seed = 77; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm')) || !PY) { console.log('略過：找不到 tree-sitter 文法（' + DIR + '）或 python\n0 passed, 0 failed'); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') }); const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const B = PB.makeBlocks({ parseTree: (s) => P.parse(s), C2U }); const M = MB.makeMatrixBlocks({ B, C2U, parseTree: (s) => P.parse(s), ST });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvb-')); const run = (src, toks) => { fs.writeFileSync(path.join(tmp, 'p.py'), src); const r = cp.spawnSync(PY, ['-I', path.join(tmp, 'p.py')], { input: toks.join(' ') + '\n', encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? r.stdout.trim().split(/\s+/).filter(Boolean).map(Number) : 'ERR:' + String(r.stderr).slice(-200); };
    const exp = (prog, toks) => { try { const r = VM.run(prog, toks); return (prog.code.some((i) => i.op === 'print') ? r.out : [r.value]).map(Number); } catch (e) { return null; } };
    const edges = (n, m) => { const t = []; for (let k = 0; k < m; k++) t.push(ri(0, n - 1), ri(0, n - 1)); return t; };
    const cases = [['fib', VM.fibVM(1000000007), () => [ri(0, 30)]], ['gcd', VM.gcdVM(), () => [ri(1, 60), ri(0, 60)]], ['brackets', VM.bracketsVM(), () => Array.from({ length: ri(0, 8) }, () => ri(1, 6))],
        ['bfs', VM.bfsVM(), () => { const n = ri(2, 6), m = ri(1, 7); return [n, m].concat(edges(n, m)); }], ['unionFind', VM.unionFindVM(), () => { const n = ri(1, 6), m = ri(0, 6); return [n, m].concat(edges(n, m)); }],
        ['lowerBound', VM.lowerBoundVM(), () => { const n = ri(1, 8); return [n].concat(Array.from({ length: n }, () => ri(0, 20)).sort((a, b) => a - b), [ri(0, 21)]); }]];
    let ok = 0; const bad = []; const chk = (n, c, i) => { if (c) ok++; else { bad.push(n); console.log('FAIL ' + n, i === undefined ? '' : JSON.stringify(i).slice(0, 400)); } };
    for (const [name, prog, gen] of cases) {
        const dec = M.decompileVm(prog); chk(name + '：反編譯成區塊', dec.ok, dec.reason); if (!dec.ok) continue;
        chk(name + '：有分段', dec.segments.length >= 1 && dec.stats.blocks > 3, dec.stats); const src2 = M.compile(dec) + '\n'; let same = 0, tot = 0, bd = null;
        for (let t = 0; t < 25; t++) { const toks = gen(); const e = exp(prog, toks); if (e === null) continue; tot++; const g = run(src2, toks); if (JSON.stringify(g) === JSON.stringify(e)) same++; else if (!bd) bd = { toks, e, g }; }
        chk(name + '：區塊編回 Python 與 VM 在 ' + tot + ' 筆輸入上一致（' + (dec.readable ? '結構化' : '狀態分派') + '，區塊 ' + dec.stats.blocks + '，一般積木 ' + dec.stats.generic + '）', tot > 5 && same === tot, bd);
        const cnl = M.cnl(dec); chk(name + '：受控自然語言非空', cnl.length > 20);
    }
    console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
