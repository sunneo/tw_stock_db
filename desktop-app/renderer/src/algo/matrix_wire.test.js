'use strict';
// 矩陣轉區塊接進產品：嵌入版 FaMatrixBlocks 與來源逐字一致；矩陣層合成的 DFA 經嵌入版拆成區塊、改接受集、編回 Python 後輸出照新定義；
// 宿主有 matrix_blocks 工具（列在 coding 領域）、離線組合會把區塊摘要放進結果、管線把 matrixForm 帶出來。需 tree-sitter 與 python。
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const S = require('./matrix_synth_core.js'), CPm = require('./matrix_compose_core.js'); const C2U = require('../uml/py_code2uml_core.js'), PB = require('../uml/py_blocks_core.js');
let pass = 0, fail = 0; const t = async (n, f) => { try { await f(); pass++; } catch (e) { fail++; console.error('FAIL ' + n + '\n   ' + String(e.message).split('\n').slice(0, 6).join('\n   ')); } };
const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
const TSDIR = path.join(__dirname, '..', '..', 'vendor', 'tree-sitter');
(async () => {
    await t('嵌入的 matrix_blocks_core 與來源逐字一致；管線帶出 matrixForm', () => {
        const src = fs.readFileSync(path.join(__dirname, 'matrix_blocks_core.js'), 'utf8').replace(/\r\n/g, '\n'); const a = fa.indexOf('/* MATRIXBLOCKS-BEGIN */'), b = fa.indexOf('/* MATRIXBLOCKS-END */'); assert.ok(a > 0 && b > a && fa.slice(a, b).includes(src), '請執行 node scripts/embed-code-ui.js');
        const pl = fs.readFileSync(path.join(__dirname, '..', 'uml', 'py_uml_pipeline_core.js'), 'utf8'); assert.ok(/matrixForm: m\.matrixForm \|\| null/.test(pl) && fa.includes('editable: !!m.editable, matrixForm: m.matrixForm || null'), '管線沒帶 matrixForm');
    });
    await t('宿主：matrix_blocks 工具註冊並列在 coding 領域；離線組合把區塊放進 matrix.blocks；有 _matrixBlocksTool／_matrixBlocksFromResult', () => {
        assert.ok(/registerOptional\('matrix_blocks'/.test(fa) && /async _matrixBlocksTool\(a\)/.test(fa) && /async _matrixBlocksFromResult\(/.test(fa) && /mxBlocks = mx \? await this\._matrixBlocksFromResult\(mxSource, mx, exs\)/.test(fa));
        const dom = /coding: \{\s*enabled: true,[\s\S]*?toolNames: \[([^\]]*)\]/.exec(fa)[1]; assert.ok(dom.includes("'matrix_blocks'")); assert.ok(/CP: typeof FaMatrixCompose !== 'undefined'/.test(fa));
    });
    if (!fs.existsSync(path.join(TSDIR, 'tree-sitter-python.wasm'))) { console.log('略過語法樹部分'); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
    const pyOk = ['python3', 'python'].find((e) => cp.spawnSync(e, ['-c', 'print(1)']).status === 0); if (!pyOk) { console.log('略過：沒有 python'); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
    const Parser = require(path.join(TSDIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(TSDIR, 'tree-sitter.wasm') });
    const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(TSDIR, 'tree-sitter-python.wasm'))); const parseTree = (x) => P.parse(x);
    const a = fa.indexOf('/* MATRIXBLOCKS-BEGIN */'), b = fa.indexOf('/* MATRIXBLOCKS-END */'); const FaMatrixBlocks = new Function(fa.slice(a, b).replace('const FaMatrixBlocks', 'var FaMatrixBlocks') + '\nreturn FaMatrixBlocks;')();
    const B = PB.makeBlocks({ parseTree, C2U }); const M = FaMatrixBlocks.makeMatrixBlocks({ B, C2U, parseTree, CP: CPm });
    const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
    const mkJudge = (tests, hidden) => async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: { id: 'x', tests, hidden, checker: 'tokens' } }); return { verdict: j.verdict, detail: j.detail }; };
    const has = (s) => (s.includes('11') ? 'no' : 'yes'); const ex = ['0101', '0110', '1', '0'].map((s) => ({ in: s + '\n', out: has(s) + '\n' })); const hid = ['11', '1011', '0000', '1010101', '110', '011'].map((s) => ({ in: s + '\n', out: has(s) + '\n' }));
    const res = await S.synth({ statement: '輸入由 0、1 組成的字串，若含有子字串 "11" 印 no，否則印 yes。', examples: ex, judge: mkJudge(ex, hid) });
    const run = (src, inp) => { const f = path.join(os.tmpdir(), 'mw-' + process.pid + '.py'); fs.writeFileSync(f, src + '\nmain()\n'); const r = cp.spawnSync(pyOk, ['-I', f], { input: inp, encoding: 'utf8', timeout: 20000 }); return r.stdout.trim(); };
    await t('嵌入版：DFA 拆成區塊、分段有名字、改接受集後輸出照新定義、受控自然語言可看', () => {
        assert.ok(res.ok && res.kind === 'dfa' && res.matrixForm); const dec = M.decompile(res); assert.ok(dec.ok); assert.deepStrictEqual(dec.segments.map((s) => s.role), ['read', 'table', 'start', 'scan', 'print']);
        assert.ok(/轉移|T/.test(M.cnl(dec))); const f0 = M.readForm(dec); const flip = f0.delta.map((_, i) => i).filter((i) => !f0.accept.includes(i));
        const e = M.setForm(dec, { accept: flip }); assert.ok(e.ok, e.reason); const py = M.compile(e);
        for (const s of ['0101', '110', '1', '0']) assert.strictEqual(run(py, s + '\n'), has(s) === 'no' ? 'yes' : 'no', '接受集反轉後 ' + s); // 原來 no 的現在 yes
        assert.notStrictEqual(py, M.compile(dec)); assert.strictEqual(run(M.compile(dec), '11\n'), 'no', '沒改的版本和原程式一樣');
    });
    console.log('matrix_wire.test.js（python ' + pyOk + '）'); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
