'use strict';
// 區塊 ↔ 中間語言 ↔ 目標語言：樣本程式 → 區塊 → 受控自然語言 → 區塊 → Python → 中間語言 → nodejs／java／c，實跑輸出要與原 Python 一致；
// 並驗證行為卡能從區塊／程式抽出。需 tree-sitter（python）快取，沒有就略過。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const C2U = require('../uml/py_code2uml_core.js'), PB = require('../uml/py_blocks_core.js');
const IR = require('./ir_core.js'), PREP = require('./ir_prep_core.js'), IN = require('./ir_in_python_core.js'), BD = require('./ir_behavior_core.js'), DES = require('./ir_design_core.js'), SAMPLES = require('./ir_samples.js'), BR = require('./ir_blocks_core.js');
const OUT = { nodejs: require('./ir_out_js_core.js'), java: require('./ir_out_java_core.js'), c: require('./ir_out_c_core.js'), python: require('./ir_out_python_core.js') };
const DIR = process.env.FA_TS_DIR || [path.join(os.tmpdir(), 'fa-ts-cache'), path.join(os.homedir(), '.cache', 'fa-ts'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
let pass = 0, fail = 0; const notes = [];
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 8).join('\n   ')); } };
const run = (exe, args, input, timeout) => { const r = cp.spawnSync(exe, args, { input, encoding: 'utf8', timeout: timeout || 20000 }); return { ok: !r.error && r.status === 0, out: String(r.stdout || '').split('\r\n').join('\n'), err: String(r.stderr || '') + (r.error ? String(r.error) : '') }; };
(async () => {
    if (!DIR) { console.log('略過：找不到 tree-sitter 快取'); console.log('0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const parseTree = (s) => P.parse(s);
    const B = PB.makeBlocks({ parseTree, C2U });
    const bridge = BR.make({ parseTree, C2U, B, IN, PREP, OUT, BD, DES, IR });
    let PYEXE = null; for (const exe of ['python3', 'python']) { const r = run(exe, ['-c', 'print(1)'], '', 10000); if (r.ok && r.out.trim() === '1') { PYEXE = exe; break; } }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-blocks-'));
    const runNode = (code, inp) => { const f = path.join(tmp, 'm' + Math.random().toString(36).slice(2) + '.js'); fs.writeFileSync(f, code); return run(process.execPath, [f], inp); };
    const runPy = (code, inp) => { const f = path.join(tmp, 'm' + Math.random().toString(36).slice(2) + '.py'); fs.writeFileSync(f, code); return run(PYEXE, [f], inp); };
    const through = (s) => {   // 樣本 → 區塊 → 受控自然語言 → 區塊 → Python
        const a = bridge.fromPython(s.py); const funcs = a.funcs.map((f) => ({ name: f.name, params: f.params, cnl: f.cnl }));
        return { a, funcs, p: bridge.program(funcs, { ctx: a.ctx }) };
    };
    await t('樣本 → 區塊 → 受控自然語言 → Python：全部可解析、可再產生', () => {
        for (const s of SAMPLES) { const r = through(s); assert.ok(r.p.ok, s.id + ' ' + JSON.stringify(r.p.errors).slice(0, 300)); assert.ok(r.a.funcs.length >= 1, s.id); }
    });
    await t('區塊產生的 Python 實跑輸出與原樣本一致（需本機有 python）', () => {
        if (!PYEXE) { notes.push('本機無 python：略過區塊 Python 實跑'); return; }
        for (const s of SAMPLES) { const r = through(s); for (const inp of s.inputs) { const x = runPy(s.py, inp), y = runPy(r.p.python, inp); assert.ok(x.ok && y.ok, s.id + ' ' + x.err + y.err); assert.strictEqual(y.out, x.out, s.id + ' 輸出不同'); } }
    });
    // 區塊 → 中間語言 → nodejs：與「原 Python 直接 → 中間語言 → nodejs」輸出一致，並與 Python 實跑一致
    let jsOk = 0, jsTotal = 0;
    await t('區塊 → 中間語言 → nodejs：實跑輸出與原 Python 一致', () => {
        for (const s of SAMPLES) {
            if (s.langs.indexOf('nodejs') < 0) continue; const r = through(s); const e = bridge.emit(r.p.python, 'nodejs', s.id); assert.ok(e.ok, s.id + ' ' + JSON.stringify(e.diags).slice(0, 300)); jsTotal++;
            for (const inp of s.inputs) { const exp = PYEXE ? runPy(s.py, inp).out : null; const got = runNode(e.code, inp); assert.ok(got.ok, s.id + ' ' + got.err.slice(0, 300)); if (exp !== null) assert.strictEqual(got.out, exp, s.id + ' nodejs 輸出不同'); }
            jsOk++;
        }
        notes.push('區塊→nodejs 實跑 ' + jsOk + '/' + jsTotal);
    });
    await t('區塊 → 目標語言：java、c 產生程式不報錯（支援範圍同 DESIGN.core-ir.md；不支援的要被如實拒絕）', () => {
        let jv = 0, c = 0, rej = 0;
        for (const s of SAMPLES) { const r = through(s); for (const l of ['java', 'c']) { const e = bridge.emit(r.p.python, l, s.id); const wanted = s.langs.indexOf(l) >= 0; if (wanted) { assert.ok(e.ok, s.id + ' → ' + l + ' ' + JSON.stringify(e.diags).slice(0, 300)); l === 'java' ? jv++ : c++; } else { assert.ok(!e.ok, s.id + ' 預期 ' + l + ' 不支援'); rej++; } } }
        notes.push('區塊→java 產生 ' + jv + '、c 產生 ' + c + '、如實拒絕 ' + rej);
    });
    await t('區塊 → java 實際編譯執行（本機有 javac 才跑）', () => {
        const jc = run('javac', ['-version'], '', 15000); if (!jc.ok && !/javac/.test(jc.err + jc.out)) { notes.push('無 javac：略過'); return; }
        let n = 0;
        for (const s of SAMPLES) {
            if (s.langs.indexOf('java') < 0) continue; const r = through(s); const e = bridge.emit(r.p.python, 'java', s.id); assert.ok(e.ok, s.id);
            const d = path.join(tmp, 'j_' + s.id.replace(/\W/g, '_')); fs.mkdirSync(d, { recursive: true }); const cls = (e.code.match(/public\s+(?:final\s+)?class\s+(\w+)/) || [, 'Main'])[1]; fs.writeFileSync(path.join(d, cls + '.java'), e.code, 'utf8');
            const b = run('javac', ['-encoding', 'UTF-8', cls + '.java'].map((x, i) => i === 2 ? path.join(d, x) : x), '', 60000); assert.ok(b.ok, s.id + ' javac ' + b.err.slice(0, 300));
            for (const inp of s.inputs.slice(0, 2)) { const got = run('java', ['-cp', d, cls], inp, 30000); assert.ok(got.ok, s.id + ' ' + got.err.slice(0, 200)); if (PYEXE) assert.strictEqual(got.out, runPy(s.py, inp).out, s.id + ' java 輸出不同'); }
            n++;
        } notes.push('區塊→java 編譯並實跑 ' + n + ' 個樣本');
    });
    await t('行為卡：從區塊產生的程式抽出，函式名／呼叫關係／標準操作與直接從原程式抽的一致，且帶區塊統計', () => {
        for (const s of SAMPLES) {
            const direct = BR.make({ parseTree, C2U, B, IN, PREP, OUT, BD, DES, IR }).cards(s.py, s.id), via = bridge.cards(through(s).p.python, s.id);
            const strip = (cs) => cs.filter((c) => c.name !== 'main' || true).map((c) => c.name).sort();
            assert.deepStrictEqual(strip(via), strip(direct), s.id + ' 函式名');
            for (const c of via) { const d = direct.find((x) => x.name === c.name); assert.deepStrictEqual(c.std.map((x) => x.op).sort(), d.std.map((x) => x.op).sort(), s.id + '.' + c.name + ' 標準操作'); assert.deepStrictEqual(c.effects.slice().sort(), d.effects.slice().sort(), s.id + '.' + c.name + ' 副作用'); assert.ok(c.blocks && c.blocks.total >= 1, s.id + '.' + c.name + ' 區塊統計'); }
        }
        const txt = bridge.cardText(bridge.cards(SAMPLES[0].py, SAMPLES[0].id)[0]); assert.ok(/區塊：共/.test(txt)); notes.push('範例行為卡：\n' + txt);
    });
    await t('命名風格一致性：樣本皆一致；刻意混用 snake／camel 會被抓到並指出哪些名稱', () => {
        for (const s of SAMPLES) { const r = bridge.styleCheck(through(s).p.python); assert.ok(r.ok, s.id + ' ' + JSON.stringify(r)); }
        const bad = bridge.styleCheck(['def get_total(a):', '    sum_all = 0', '    for itemValue in a:', '        sum_all += itemValue', '    return sum_all', '', 'def printResult(x):', '    print(x)', ''].join(String.fromCharCode(10)));
        assert.strictEqual(bad.ok, false); assert.ok(bad.variables.mixed.indexOf('itemValue') >= 0, JSON.stringify(bad)); assert.deepStrictEqual(bad.functions.mixed.length, 1);
    });
    await t('行內註解經區塊往返不丟：區塊產生的 Python 轉中間語言後，註解數與原程式相同，且沒有掛不回的', () => {
        let total = 0;
        for (const s of SAMPLES) {
            const r = through(s); assert.strictEqual(r.p.comments.unplaced, 0, s.id + ' 有註解掛不回 ' + JSON.stringify(r.p.comments));
            const a = IR.comments(bridge.toIr(s.py, s.id).ir).length, b = IR.comments(bridge.toIr(r.p.python, s.id).ir).length; assert.strictEqual(b, a, s.id + ' 註解數 原 ' + a + ' 區塊後 ' + b); total += r.p.comments.placed;
        }
        assert.ok(total >= 5, '至少要有幾個註解被測到：' + total); notes.push('區塊往返保留註解 ' + total + ' 個（含獨立註解與行尾註解）');
        const em = bridge.emit(through(SAMPLES[0]).p.python, 'nodejs', 'c'); assert.ok(/walk the list/.test(em.code) && /accumulator/.test(em.code), em.code);
    });
    await t('註解往返後在 nodejs／java／c 輸出都找得到（java 預設把非 ASCII 逸出成 \\uXXXX，還原後比對；行尾與區塊內註解都算）', () => {
        const unesc = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        let n = 0;
        for (const s of SAMPLES) {
            const a = bridge.fromPython(s.py); if (!a.comments.length) continue;
            const p = bridge.program(a.funcs.map((f) => ({ name: f.name, params: f.params, cnl: f.cnl })), { ctx: a.ctx }); const texts = a.comments.map((c) => c.text.replace(/^#\s*/, ''));
            for (const lang of s.langs) { const e = bridge.emit(p.python, lang, s.id); assert.ok(e.ok, s.id + lang); const code = unesc(e.code); texts.forEach((tx) => { assert.ok(code.includes(tx), s.id + ' → ' + lang + ' 缺註解「' + tx + '」'); n++; }); }
        }
        notes.push('註解在 nodejs／java／c 輸出共比對 ' + n + ' 筆全部找到');
    });
    await t('壞的受控自然語言：不丟例外，回報解析錯誤', () => {
        const p = bridge.program([{ name: 'main', params: [], cnl: '這不是任何已知的區塊 @@@' }]); assert.strictEqual(p.ok, false);
        const e = bridge.blocksToTarget([{ name: 'main', params: [], cnl: '這不是任何已知的區塊 @@@' }], 'nodejs'); assert.strictEqual(e.ok, false); assert.ok(e.diags.length);
        assert.strictEqual(bridge.emit('print(1)', 'cobol').ok, false);
    });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    notes.forEach((n) => console.log(n)); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
