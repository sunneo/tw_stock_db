'use strict';
// 改設計 → 改程式（橋的 designEdit）：任何有「進」的來源語言 → 中間語言 → UML 模型 → uml_edit 指令 → 模型差異（applyModelDiff）→ 輸出。
// 驗證：新增函式骨架（待實作，誠實列在 needImpl）、改名（刪＋加同簽名，呼叫處一起改，輸出實跑與改前一致）、刪還在被呼叫的函式被拒絕、
// 跨語言（nodejs／java 來源改設計再輸出成原語言與 python）、編修指令全被拒絕時回錯。需 tree-sitter 文法快取（python、javascript、java）與 python。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const C2U = require('../uml/py_code2uml_core.js'), PB = require('../uml/py_blocks_core.js'), UML = require('../uml/uml_core.js'), UE = require('../uml/uml_edit_core.js');
const IR = require('./ir_core.js'), PREP = require('./ir_prep_core.js'), IN = require('./ir_in_python_core.js'), INB = require('./ir_in_brace_core.js'), BD = require('./ir_behavior_core.js'), DES = require('./ir_design_core.js'), SAMPLES = require('./ir_samples.js'), BR = require('./ir_blocks_core.js');
const OUT = { nodejs: require('./ir_out_js_core.js'), java: require('./ir_out_java_core.js'), c: require('./ir_out_c_core.js'), python: require('./ir_out_python_core.js') };
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 12).join('\n   ')); } };
const run = (exe, args, input) => { const r = cp.spawnSync(exe, args, { input, encoding: 'utf8', timeout: 30000 }); return { ok: !r.error && r.status === 0, out: String(r.stdout || '').split('\r\n').join('\n'), err: String(r.stderr || '') }; };
(async () => {
    if (!DIR) { console.log('略過：找不到 tree-sitter 快取\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const load = async (w) => { const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, w))); return P; };
    const PY = await load('tree-sitter-python.wasm'); const JS = fs.existsSync(path.join(DIR, 'tree-sitter-javascript.wasm')) ? await load('tree-sitter-javascript.wasm') : null, JV = fs.existsSync(path.join(DIR, 'tree-sitter-java.wasm')) ? await load('tree-sitter-java.wasm') : null;
    const parseTree = (s) => PY.parse(s); const B = PB.makeBlocks({ parseTree, C2U });
    const bridge = BR.make({ parseTree, C2U, B, IN, PREP, OUT, BD, DES, IR, INB, UML, UE });
    let PYEXE = null; for (const exe of ['python3', 'python']) { const r = run(exe, ['-c', 'print(1)'], ''); if (r.ok && r.out.trim() === '1') { PYEXE = exe; break; } }
    if (!PYEXE) { console.log('略過：找不到 python\n0 passed, 0 failed'); return; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-de-'));
    const runPy = (code, inp) => { const f = path.join(tmp, 'm' + Math.random().toString(36).slice(2) + '.py'); fs.writeFileSync(f, code); return run(PYEXE, [f], inp); };
    const runNode = (code, inp) => { const f = path.join(tmp, 'm' + Math.random().toString(36).slice(2) + '.js'); fs.writeFileSync(f, code); return run(process.execPath, [f], inp); };
    const S = SAMPLES.find((x) => x.id === 'sum-array'); const inp = S.inputs[1];
    const cls = (src, lang, parser) => (lang === 'python' ? bridge.umlFrom(src, 'python', 'm') : bridge.umlFrom(src, lang, 'm', parser)).model.classes[0].name;

    await t('Python：新增操作 → 產生函式骨架（待實作）、原函式與輸出不變、needImpl 列出', () => {
        const c = cls(S.py, 'python');
        const r = bridge.designEdit(S.py, 'python', { name: 'm', ops: [{ op: 'add_member', cls: c, member: '+ average(values: List<int>): float' }] });
        assert.ok(r.ok, JSON.stringify(r.diags.slice(0, 3))); assert.deepStrictEqual(r.needImpl, ['average']); assert.ok(r.changes.some((x) => /新增函式骨架 average/.test(x)));
        assert.ok(/def average\(/.test(r.code), r.code); assert.strictEqual(runPy(r.code.replace(/def average[\s\S]*?(?=\n\n\n|\ndef |\nmain|$)/, ''), inp).out, runPy(S.py, inp).out);
    });
    await t('Python：改名（刪步驟、刪成員、加同簽名新名稱、加步驟）→ 呼叫處一起改，輸出實跑與改前一致', () => {
        const c = cls(S.py, 'python'); const m = bridge.umlFrom(S.py, 'python', 'm').model; const op = m.classes[0].ops.find((o) => o.name === 'total'); assert.ok(op);
        const sig = '+ sum_all(' + op.params.map((p) => p.name + ': ' + (p.type && p.type.base === 'List' ? 'List<int>' : 'int')).join(', ') + '): int';
        const r = bridge.designEdit(S.py, 'python', { name: 'm', ops: [{ op: 'remove_step', usecase: 'main', msg: 'total' }, { op: 'remove_member', cls: c, name: 'total' }, { op: 'add_member', cls: c, member: sig }, { op: 'add_step', usecase: 'main', to: c, msg: 'sum_all', args: op.params.map((p) => p.name) }] });
        assert.ok(r.changes.some((x) => /改名 total → sum_all/.test(x)), JSON.stringify(r.changes) + JSON.stringify(r.rejected));
        assert.ok(/def sum_all\(/.test(r.code) && !/\btotal\(/.test(r.code), r.code); assert.strictEqual(runPy(r.code, inp).out, runPy(S.py, inp).out);
    });
    await t('刪還在被呼叫的函式被拒絕，錯誤說明誰在呼叫', () => {
        const c = cls(S.py, 'python'); const r = bridge.designEdit(S.py, 'python', { name: 'm', ops: [{ op: 'remove_step', usecase: 'main', msg: 'total' }, { op: 'remove_member', cls: c, name: 'total' }] });
        assert.ok(!r.ok && /還被 main 呼叫/.test(r.error), JSON.stringify(r)); assert.ok(!r.code);
    });
    await t('編修指令全被拒絕 → 回錯與 rejected；沒有 ops → 回錯', () => {
        const r = bridge.designEdit(S.py, 'python', { name: 'm', ops: [{ op: 'remove_member', cls: 'NoSuchClass', name: 'x' }] }); assert.ok(!r.ok && r.rejected && r.rejected.length, JSON.stringify(r));
        assert.ok(!bridge.designEdit(S.py, 'python', { ops: [] }).ok);
    });
    if (JS) await t('nodejs 來源：改設計（加函式）→ 輸出 nodejs 仍可執行、輸出 python 也可執行，結果與原程式一致', () => {
        const js = OUT.nodejs.emit(PREP.prepare(IN.fromTree(PY.parse(S.py).rootNode, { source: S.py }).ir).ir).code; const c = cls(js, 'nodejs', JS);
        const ops = [{ op: 'add_member', cls: c, member: '+ average(values: List<int>): float' }];
        const r = bridge.designEdit(js, 'nodejs', { name: 'm', parser: JS, ops }); assert.ok(r.ok, JSON.stringify(r.diags.slice(0, 3)) + (r.error || '')); assert.deepStrictEqual(r.needImpl, ['average']);
        const code = r.code.replace(/function average[\s\S]*?\n\}\n?/, ''); const base = runNode(js, inp).out; assert.ok(base); assert.strictEqual(runNode(code, inp).out, base);
        const rp = bridge.designEdit(js, 'nodejs', { name: 'm', parser: JS, ops, target: 'python' }); assert.ok(rp.ok && /def average\(/.test(rp.code), JSON.stringify(rp.diags.slice(0, 3)));
    });
    if (JV) await t('java 來源：改設計（加函式）→ 輸出 java（含新函式骨架）', () => {
        const java = OUT.java.emit(PREP.prepare(IN.fromTree(PY.parse(S.py).rootNode, { source: S.py }).ir).ir).code; const c = cls(java, 'java', JV);
        const r = bridge.designEdit(java, 'java', { name: 'm', parser: JV, ops: [{ op: 'add_member', cls: c, member: '+ average(values: List<int>): float' }] });
        assert.ok(r.ok, JSON.stringify(r.diags.slice(0, 3)) + (r.error || '')); assert.deepStrictEqual(r.needImpl, ['average']); assert.ok(/average\(/.test(r.code));
    });
    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
