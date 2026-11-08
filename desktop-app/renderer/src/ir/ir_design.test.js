'use strict';
// 抽回設計：Python → IR → 設計（簽名／呼叫關係／標準操作／副作用／摘要）→ UML 模型（過 uml_core 驗證）→ 編修設計（IR 層與 uml_edit 層）→ 重新產生程式碼 → 判題。
// 需要 tree-sitter 快取（沒有就略過）。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const IR = require('./ir_core.js'), OPS = require('./ir_ops_core.js'), PREP = require('./ir_prep_core.js'), IN = require('./ir_in_python_core.js'), D = require('./ir_design_core.js');
const OUT = { nodejs: require('./ir_out_js_core.js'), java: require('./ir_out_java_core.js'), c: require('./ir_out_c_core.js'), python: require('./ir_out_python_core.js') };
const U = require('../uml/uml_core.js'), UE = require('../uml/uml_edit_core.js');
const SAMPLES = require('./ir_samples.js');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 8).join('\n   ')); } };
const DIR = process.env.FA_TS_DIR || [path.join(os.tmpdir(), 'fa-ts-cache'), path.join(os.homedir(), '.cache', 'fa-ts'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
(async () => {
    if (!DIR) { console.log('略過：找不到 tree-sitter 文法快取（FA_TS_DIR）'); console.log('0 passed, 0 failed'); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const R = require('../../../judge-runner.js');
    const sample = (id) => SAMPLES.find((s) => s.id === id);
    const conv = (id) => { const s = sample(id); return IN.fromTree(P.parse(s.py).rootNode, { source: s.py, name: id }).ir; };
    const prepared = (ir) => PREP.prepare(ir).ir;

    await t('抽設計：簽名、呼叫關係、標準操作用量、副作用、純函式判斷、摘要', () => {
        const ir = prepared(conv('sum-array')); const d = D.extract(ir);
        assert.deepStrictEqual(d.functions.map((f) => f.name), ['total', 'main']); assert.strictEqual(d.entry, 'main');
        const tot = d.functions[0], main = d.functions[1];
        assert.deepStrictEqual(tot.params, [{ name: 'a', type: 'list<int>' }]); assert.strictEqual(tot.returns, 'int'); assert.strictEqual(tot.doc, 'Return the sum of all elements.');
        assert.ok(tot.pure && tot.effects.length === 0, 'total 是純函式'); assert.strictEqual(tot.loops, 1);
        assert.deepStrictEqual(main.calls, ['total']); assert.ok(main.effects.indexOf('讀標準輸入') >= 0 && main.effects.indexOf('寫標準輸出') >= 0, JSON.stringify(main.effects)); assert.ok(!main.pure);
        assert.ok(main.std.some((s) => s.op === 'io.read_line') && main.std.some((s) => s.op === 'str.split_ints') && main.std.some((s) => s.op === 'io.print_line'), JSON.stringify(main.std));
        assert.deepStrictEqual(d.callGraph, [['main', 'total']]); assert.ok(d.stdUsage['io.print_line'].indexOf('main') >= 0);
        assert.ok(/函式 total\(a: list<int>\) → int/.test(tot.summary) && /純函式/.test(tot.summary) && /1 個迴圈/.test(tot.summary), tot.summary);
    });
    await t('「函式呼叫產生語意」：同一個 len／sorted／print 在不同型別下被認成不同的標準操作；使用者函式維持使用者函式', () => {
        const d = D.extract(prepared(conv('frequency')));
        const main = d.functions.find((f) => f.name === 'main'); const freq = d.functions.find((f) => f.name === 'freq');
        assert.ok(main.std.some((s) => s.op === 'dict.sorted_keys'), 'sorted(dict) 不是 list.sorted：' + JSON.stringify(main.std));
        assert.ok(freq.std.some((s) => s.op === 'dict.get_default') && !freq.calls.length, JSON.stringify(freq));
        assert.deepStrictEqual(main.calls, ['freq']);
        const d2 = D.extract(prepared(conv('palindrome'))); assert.ok(d2.functions[0].std.some((s) => s.op === 'coll.len') && d2.functions[0].std.some((s) => s.op === 'str.char_at') === false, '字串索引是 index 節點，不是呼叫');
    });
    await t('設計 → UML 模型：通過 uml_core 驗證，可轉 DSL／Mermaid，使用案例是入口的呼叫順序', () => {
        SAMPLES.forEach((s) => {
            const ir = prepared(conv(s.id)); const model = D.toUmlModel(D.extract(ir), {}, ir); const errs = U.validateModel(model); assert.deepStrictEqual(errs, [], s.id + ' ' + errs.join(';'));
            assert.ok(U.toDsl(model).length > 10); assert.ok(U.toMermaidClass(model).indexOf('classDiagram') >= 0);
        });
        const m = D.toUmlModel(D.extract(prepared(conv('count-primes'))), {}, prepared(conv('count-primes'))); assert.deepStrictEqual(m.usecases[0].steps.map((x) => x.msg), ['is_prime']); assert.strictEqual(m.classes[0].ops[0].returns.base, 'bool');
    });
    const cp = require('child_process');
    const runNode = (code, input) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-n-')); const f = path.join(dir, 'main.js'); fs.writeFileSync(f, code); try { const r = cp.spawnSync(process.execPath, [f], { input, encoding: 'utf8', timeout: 10000 }); return { code: r.status, out: String(r.stdout).split('\r\n').join('\n'), err: String(r.stderr) }; } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } } };
    const outputs = (ir, id) => { const em = OUT.nodejs.emit(ir); assert.strictEqual(em.diags.filter((d) => d.level === 'error').length, 0, JSON.stringify(em.diags)); return { em, outs: sample(id).inputs.map((inp) => { const r = runNode(em.code, inp); assert.strictEqual(r.code, 0, r.err); return r.out; }) }; };
    await t('改設計→重新產生：改函式名（呼叫處一起改）後，nodejs 輸出與改前完全一致', async () => {
        const ir = conv('sum-array'); const before = outputs(prepared(ir), 'sum-array');
        const e = D.applyEdit(ir, { kind: 'rename_function', from: 'total', to: 'sum_all' }); assert.ok(e.ok, e.errors.join(';'));
        const after = outputs(prepared(e.ir), 'sum-array'); assert.ok(after.em.code.includes('function sum_all(') && after.em.code.includes('sum_all(a)') && !after.em.code.includes('total('));
        before.outs.forEach((b, i) => { assert.ok(b.length > 0); assert.strictEqual(after.outs[i], b, '輸出不同'); });
        assert.ok(after.em.code.includes('// accumulator') && after.em.code.includes('// walk the list'), '註解保留');
    });
    await t('改設計的錯誤被擋下：改成已存在的名稱、不存在的函式、不合法名稱、新增參數沒給預設值', () => {
        const ir = conv('sum-array');
        assert.ok(!D.applyEdit(ir, { kind: 'rename_function', from: 'total', to: 'main' }).ok); assert.ok(!D.applyEdit(ir, { kind: 'rename_function', from: 'nope', to: 'x' }).ok);
        assert.ok(!D.applyEdit(ir, { kind: 'rename_function', from: 'total', to: '1bad' }).ok); assert.ok(!D.applyEdit(ir, { kind: 'add_param', fn: 'total', name: 'k', type: 'int' }).ok);
    });
    await t('新增參數：每個呼叫處補預設值，Java 與 C 沒有預設參數也能用；輸出不變', async () => {
        const ir = conv('max-index'); const e = D.applyEdit(ir, { kind: 'add_param', fn: 'best', name: 'offset', type: 'int', default: IR.lit('int', '0') }); assert.ok(e.ok, e.errors.join(';'));
        const p = prepared(e.ir); const java = OUT.java.emit(p).code; assert.ok(/static long best\(List<Long> a, long offset\)/.test(java) && /best\(a, 0L\)/.test(java), java.split('\n').filter((l) => /best/.test(l)).join('\n'));
        const c = OUT.c.emit(p).code; assert.ok(/best\(IL a, long long offset\)/.test(c) && /best\(a, 0\)/.test(c));
        // 編修後的 Java 必須能編譯；Node 版輸出必須與編修前相同
        const chk = await R.check({ lang: 'java', source: java }); assert.strictEqual(chk.verdict, 'CHECKED', '編修後的 Java 要能編譯：' + chk.detail + chk.compileLog);
        const o0 = outputs(prepared(ir), 'max-index'), o1 = outputs(p, 'max-index'); assert.deepStrictEqual(o1.outs, o0.outs);
    });
    await t('UML 層編修（uml_edit）→ IR：刪還在被呼叫的函式被拒絕；新增操作產生函式骨架（待實作，不假裝完成）；改名由簽名推斷', () => {
        const ir = conv('sum-array'); const before = D.toUmlModel(D.extract(prepared(ir)), {}, prepared(ir));
        const m1 = JSON.parse(JSON.stringify(before)); const cn = m1.classes[0].name;
        // uml_edit 只改設計：只刪成員會被它的整理步驟補回（使用案例還在呼叫它），所以要先刪步驟再刪成員
        const only = UE.apply(JSON.parse(JSON.stringify(before)), [{ op: 'remove_member', cls: cn, name: 'total' }]); assert.deepStrictEqual(D.diffModels(before, only.model), { added: [], removed: [], renamed: [] }, '只刪成員，uml_edit 會補回');
        const rm = UE.apply(m1, [{ op: 'remove_step', usecase: 'main', msg: 'total' }, { op: 'remove_member', cls: cn, name: 'total' }]); assert.ok(!rm.errors.length, JSON.stringify(rm.errors));
        const r1 = D.applyModelDiff(ir, before, rm.model || m1); assert.ok(!r1.ok && /還被 main 呼叫/.test(r1.errors.join(';')), JSON.stringify(r1.errors));
        const m2 = JSON.parse(JSON.stringify(before)); const ad = UE.apply(m2, [{ op: 'add_member', cls: cn, member: '+ average(values: List<int>): float' }]);
        const r2 = D.applyModelDiff(ir, before, ad.model || m2); assert.ok(r2.ok, JSON.stringify(r2.errors)); const f = IR.funcs(r2.ir).find((x) => x.name === 'average'); assert.ok(f && f.body[0].k === 'native' && f.body[0].lang === 'todo');
        const em = OUT.java.emit(prepared(r2.ir)); assert.ok(em.diags.some((d) => d.level === 'error' && /原生區塊/.test(d.msg)), '骨架沒內容，輸出器要誠實回報');
        const m3 = JSON.parse(JSON.stringify(before)); m3.classes[0].ops[0].name = 'sum_all'; const r3 = D.applyModelDiff(ir, before, m3); assert.ok(r3.ok && r3.log.some((x) => /改名 total → sum_all/.test(x)), JSON.stringify(r3));
        assert.ok(IR.funcs(r3.ir).some((x) => x.name === 'sum_all') && JSON.stringify(r3.ir).includes('"fn":"sum_all"') && !JSON.stringify(r3.ir).includes('"fn":"total"'));
    });
    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
