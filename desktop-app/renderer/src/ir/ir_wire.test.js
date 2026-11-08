'use strict';
// 區塊橋／中間語言接進產品：floating-assistant.js 裡嵌入的 FaIrBundle 與來源模組一致、能轉 nodejs（實跑與 Python 輸出一致）；工具 convert_code 真的註冊並列在 coding 領域。
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const C2U = require('../uml/py_code2uml_core.js'), PB = require('../uml/py_blocks_core.js');
const SAMPLES = require('./ir_samples.js');
let pass = 0, fail = 0; const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 6).join('\n   ')); } };
const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
const TSDIR = path.join(__dirname, '..', '..', 'vendor', 'tree-sitter');
(async () => {
    const a = fa.indexOf('/* IR-BEGIN */'), b = fa.indexOf('/* IR-END */'); assert.ok(a > 0 && b > a, '嵌入標記');
    const block = fa.slice(a + '/* IR-BEGIN */'.length, b);
    await t('嵌入的每個中間語言模組與來源檔逐字一致（沒人改嵌入後那份）', () => {
        for (const f of ['ir_core', 'ir_ops_core', 'ir_prep_core', 'ir_in_python_core', 'ir_out_js_core', 'ir_out_java_core', 'ir_out_c_core', 'ir_out_python_core', 'ir_design_core', 'ir_behavior_core', 'ir_blocks_core']) {
            const src = fs.readFileSync(path.join(__dirname, f + '.js'), 'utf8').replace(/\r\n/g, '\n'); assert.ok(block.includes(src), f + ' 嵌入的版本和來源不同：請執行 node scripts/embed-code-ui.js');
        }
    });
    const FaIrBundle = new Function(block.replace('const FaIrBundle', 'var FaIrBundle') + '\nreturn FaIrBundle;')();
    await t('FaIrBundle 暴露橋所需的所有模組', () => { for (const k of ['FaIr', 'FaIrOps', 'FaIrPrep', 'FaIrInPython', 'FaIrOutJs', 'FaIrOutJava', 'FaIrOutC', 'FaIrOutPython', 'FaIrDesign', 'FaIrBehavior', 'FaIrBlocks']) assert.ok(FaIrBundle[k], k); });
    await t('宿主程式碼：_irBridge／_codeConvert 存在，convert_code 註冊並列在 coding 領域', () => {
        assert.ok(/async _irBridge\(\)/.test(fa) && /async _codeConvert\(a\)/.test(fa) && /registerOptional\('convert_code'/.test(fa));
        const dom = /coding: \{\s*enabled: true,[\s\S]*?toolNames: \[([^\]]*)\]/.exec(fa)[1]; assert.ok(dom.includes("'convert_code'"));
        assert.ok(/H\.FaIrBlocks\.make\(\{ parseTree, C2U: FaPyCode2Uml, B, IN: H\.FaIrInPython/.test(fa), '橋的依賴注入');
    });
    if (!fs.existsSync(path.join(TSDIR, 'tree-sitter-python.wasm'))) { console.log('略過語法樹部分：沒有 renderer/vendor/tree-sitter'); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
    const Parser = require(path.join(TSDIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(TSDIR, 'tree-sitter.wasm') });
    const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(TSDIR, 'tree-sitter-python.wasm'))); const parseTree = (s) => P.parse(s);
    const B = PB.makeBlocks({ parseTree, C2U }); const H = FaIrBundle;
    const bridge = H.FaIrBlocks.make({ parseTree, C2U, B, IN: H.FaIrInPython, PREP: H.FaIrPrep, OUT: { nodejs: H.FaIrOutJs, java: H.FaIrOutJava, c: H.FaIrOutC, python: H.FaIrOutPython }, BD: H.FaIrBehavior, DES: H.FaIrDesign, IR: H.FaIr });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-wire-')); const run = (exe, args, input) => { const r = cp.spawnSync(exe, args, { input, encoding: 'utf8', timeout: 30000 }); return { ok: !r.error && r.status === 0, out: String(r.stdout || '').replace(/\r\n/g, '\n'), err: String(r.stderr || '') }; };
    const hasPy = run('python', ['-c', '1'], '').ok; let nOk = 0;
    await t('嵌入版的橋：樣本 → 區塊 → nodejs／java／c 全部產生（支援的），nodejs 實跑與 Python 一致', () => {
        for (const s of SAMPLES) {
            const a2 = bridge.fromPython(s.py); const p = bridge.program(a2.funcs.map((f) => ({ name: f.name, params: f.params, cnl: f.cnl })), { ctx: a2.ctx }); assert.ok(p.ok, s.id);
            for (const lang of s.langs) { const e = bridge.emit(p.python, lang, s.id); assert.ok(e.ok, s.id + ' ' + lang + ' ' + JSON.stringify(e.diags).slice(0, 200)); if (lang === 'nodejs') { const f = path.join(tmp, s.id.replace(/\W/g, '_') + '.js'); fs.writeFileSync(f, e.code); const pf = path.join(tmp, s.id.replace(/\W/g, '_') + '.py'); fs.writeFileSync(pf, s.py); for (const inp of s.inputs.slice(0, 2)) { const g = run(process.execPath, [f], inp); assert.ok(g.ok, s.id + g.err.slice(0, 200)); if (hasPy) assert.strictEqual(g.out, run('python', [pf], inp).out, s.id); } nOk++; } }
        }
    });
    await t('不支援的目標被如實拒絕（c 不翻字典）；壞區塊回報錯誤不丟例外', () => {
        const bad = SAMPLES.find((s) => s.langs.indexOf('c') < 0); if (bad) { const e = bridge.emit(bad.py, 'c', bad.id); assert.strictEqual(e.ok, false); assert.ok(e.diags.length); }
        assert.strictEqual(bridge.program([{ name: 'main', params: [], cnl: '這不是任何已知的區塊 @@@' }]).ok, false);
    });
    await t('行為卡（唯讀）：嵌入版橋對每個樣本抽出卡片（函式名、標準操作、文字卡）；設計摘要有呼叫圖；不改來源', () => {
        let n = 0;
        for (const s of SAMPLES) {
            const cs = bridge.cards(s.py, s.id); assert.ok(cs.length >= 1, s.id); for (const c of cs) { const txt = bridge.cardText(c); assert.ok(txt.indexOf('### ' + c.name) === 0 && /控制流/.test(txt) && /標準操作/.test(txt), s.id + '.' + c.name); n++; }
            const d = H.FaIrDesign.extract(bridge.toIr(s.py, s.id).ir); assert.ok(d.callGraph && Array.isArray(d.effects), s.id);
        }
        assert.ok(n >= 10, '卡片數 ' + n);
    });
    await t('宿主程式碼：_behCards 與 behavior_card 工具存在並列在 coding 領域；工具描述講明唯讀', () => {
        assert.ok(/async _behCards\(a\)/.test(fa) && /registerOptional\('behavior_card'/.test(fa)); const dom = /coding: \{\s*enabled: true,[\s\S]*?toolNames: \[([^\]]*)\]/.exec(fa)[1]; assert.ok(dom.includes("'behavior_card'"));
        const i = fa.indexOf("registerOptional('behavior_card',"); assert.ok(/唯讀/.test(fa.slice(i, i + 400)));
    });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
    console.log('ir_wire.test.js（python ' + (hasPy ? '有' : '沒有') + '）：嵌入版 nodejs 實跑 ' + nOk + ' 個樣本'); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
