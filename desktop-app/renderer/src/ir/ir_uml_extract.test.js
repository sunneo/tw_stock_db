'use strict';
// 從程式抽回 UML 設計（convert_code 的 action:"to_uml"，橋的 umlFrom）：任何有「進」的來源語言 → 中間語言 → 設計 → UML 模型（過 uml_core 驗證）＋ DSL／Mermaid／PlantUML。
// 驗證：①同一份 Python 樣本輸出成 nodejs／java／c／cpp／csharp／ruby／perl 後，各語言抽回的函式清單與呼叫關係，和直接從 Python 抽回的一致（跨語言一致性）；
//       ②UML 模型通過 uml_core 驗證、DSL 可再解析（parseDsl）、圖含每個函式；③只讀（來源字串不變）；④宿主有 to_uml 動作與工具說明。
// 用嵌入版（floating-assistant.js 的 FaIrBundle）。需要 tree-sitter 文法快取（沒有的語言略過並說明）。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const C2U = require('../uml/py_code2uml_core.js'), PB = require('../uml/py_blocks_core.js'), UML = require('../uml/uml_core.js'); const SAMPLES = require('./ir_samples.js');
let pass = 0, fail = 0; const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 20).join('\n   ')); } };
const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
(async () => {
    const a = fa.indexOf('/* IR-BEGIN */'), b = fa.indexOf('/* IR-END */'); assert.ok(a > 0 && b > a); const H = new Function(fa.slice(a + '/* IR-BEGIN */'.length, b).replace('const FaIrBundle', 'var FaIrBundle') + '\nreturn FaIrBundle;')();
    if (!DIR) { console.log('略過：找不到 tree-sitter 文法快取\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const load = async (w) => { if (!fs.existsSync(path.join(DIR, w))) return null; const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, w))); return P; };
    const PY = await load('tree-sitter-python.wasm'); const LP = { nodejs: await load('tree-sitter-javascript.wasm'), java: await load('tree-sitter-java.wasm'), c: await load('tree-sitter-c.wasm'), cpp: await load('tree-sitter-cpp.wasm'), csharp: await load('tree-sitter-c_sharp.wasm'), ruby: await load('tree-sitter-ruby.wasm'), perl: {} };
    const parseTree = (s) => PY.parse(s); const B = PB.makeBlocks({ parseTree, C2U });
    const bridge = H.FaIrBlocks.make({ parseTree, C2U, B, IN: H.FaIrInPython, PREP: H.FaIrPrep, OUT: { nodejs: H.FaIrOutJs, java: H.FaIrOutJava, c: H.FaIrOutC, cpp: H.FaIrOutCpp, csharp: H.FaIrOutCs, perl: H.FaIrOutPerl, ruby: H.FaIrOutRuby, python: H.FaIrOutPython }, INB: H.FaIrInBrace, INT: H.FaIrInTyped, INR: H.FaIrInRuby, INP: H.FaIrInPerl, UML, BD: H.FaIrBehavior, DES: H.FaIrDesign, IR: H.FaIr });
    const EMIT = { nodejs: H.FaIrOutJs, java: H.FaIrOutJava, c: H.FaIrOutC, cpp: H.FaIrOutCpp, csharp: H.FaIrOutCs, ruby: H.FaIrOutRuby, perl: H.FaIrOutPerl };
    const emitFrom = (s, lang) => { const ir = H.FaIrPrep.prepare(H.FaIrInPython.fromTree(PY.parse(s.py).rootNode, { source: s.py }).ir).ir; const em = EMIT[lang].emit(ir); return em.diags.some((d) => d.level === 'error') ? null : em.code; };
    const norm = (d) => ({ fns: d.functions.map((f) => f.name).sort(), calls: d.callGraph.map((e) => e.join('>')).sort(), entry: d.entry });

    await t('Python 樣本：UML 模型通過驗證、DSL 可再解析、圖含每個函式、使用案例是入口的呼叫順序、來源字串不變', () => {
        for (const s of SAMPLES) {
            const before = s.py; const u = bridge.umlFrom(s.py, 'python', s.id); assert.strictEqual(s.py, before); assert.ok(u.ok, s.id + ' ' + (u.errors || []).join(';'));
            assert.deepStrictEqual(u.errors, []); const back = UML.parseDsl(u.dsl); assert.deepStrictEqual(back.errors || [], [], s.id + ' DSL 再解析：' + JSON.stringify(back.errors));
            u.design.functions.forEach((f) => { assert.ok(u.dsl.indexOf(f.name) >= 0, s.id + ' DSL 缺 ' + f.name); assert.ok(u.mermaid.class.indexOf(f.name) >= 0, s.id + ' 類別圖缺 ' + f.name); assert.ok(u.plantuml.indexOf(f.name) >= 0, s.id + ' PlantUML 缺 ' + f.name); });
            assert.ok(u.design.entry === 'main'); if (u.design.functions.find((f) => f.name === 'main').calls.length) assert.ok(u.mermaid.sequence && /sequenceDiagram/.test(u.mermaid.sequence), s.id + ' 缺序列圖');
        }
    });
    const stat = {};
    for (const lang of Object.keys(LP)) {
        if (!LP[lang]) { console.log('略過 ' + lang + '：沒有文法'); continue; }
        await t(lang + ' 來源：抽回的函式清單、呼叫關係、入口與直接從 Python 抽回的一致', () => {
            let n = 0; for (const s of SAMPLES) {
                const code = emitFrom(s, lang); if (!code) continue; // 該語言輸出器不支援的樣本（例如 c 的字典）略過
                const ref = norm(bridge.umlFrom(s.py, 'python', s.id).design); const u = bridge.umlFrom(code, lang, s.id, LP[lang]); assert.ok(u.ok, s.id + ' ' + lang + ' ' + (u.errors || []).join(';'));
                // 輔助函式（fa_*）是輸出器加的，抽回時不該出現在設計裡
                assert.ok(!u.design.functions.some((f) => /^fa_/.test(f.name)), s.id + ' 設計裡出現輔助函式');
                assert.deepStrictEqual(norm(u.design), ref, s.id + ' ' + lang + ' 與 Python 抽回的設計不同'); n++;
            }
            stat[lang] = n + ' 個樣本與 Python 抽回的設計一致'; assert.ok(n >= 8, lang + ' 只比對了 ' + n + ' 個樣本');
        });
    }
    await t('宿主：convert_code 有 to_uml 動作（只讀）與工具說明', () => {
        assert.ok(/if \(action === 'to_uml'\)/.test(fa)); assert.ok(/br\.umlFrom\(a\.source, from, a\.name, fromParser/.test(fa)); const i = fa.indexOf("registerOptional('convert_code',"); const seg = fa.slice(i, i + 6500);
        assert.ok(/enum: \['convert', 'to_blocks', 'to_uml'\]/.test(seg)); assert.ok(/action:"to_uml" 從程式抽回 UML 設計/.test(seg)); assert.ok(/UML: FaUml/.test(fa));
    });
    console.log('  · ' + JSON.stringify(stat)); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
