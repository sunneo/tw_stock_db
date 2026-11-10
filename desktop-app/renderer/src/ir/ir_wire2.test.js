'use strict';
// 「進」接進產品：floating-assistant.js 嵌入的 FaIrBundle 含 nodejs／java／c 的「進」與 cpp／csharp／perl／ruby 的輸出器；
// 嵌入版的橋能 來源（nodejs／java／c）→ 中間語言 → 任意目標語言（含 perl 實跑與 Python 輸出一致）；宿主程式碼有 from 參數、_irLangParser、行為卡走第二層；/code 路由認得新語言。
// 需要 tree-sitter 文法快取（沒有就略過語法樹部分並說明）與 python／perl。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const C2U = require('../uml/py_code2uml_core.js'), PB = require('../uml/py_blocks_core.js'); const SAMPLES = require('./ir_samples.js');
let pass = 0, fail = 0; const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 20).join('\n   ')); } };
const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
const PERL = process.env.FA_PERL || 'J:\\msys64\\usr\\bin\\perl.exe';
const runCmd = (exe, args, input) => { const r = cp.spawnSync(exe, args, { input, encoding: 'utf8', timeout: 30000 }); return { ok: !r.error && r.status === 0, out: String(r.stdout || '').replace(/\r\n/g, '\n') }; };
(async () => {
    const a = fa.indexOf('/* IR-BEGIN */'), b = fa.indexOf('/* IR-END */'); assert.ok(a > 0 && b > a); const block = fa.slice(a + '/* IR-BEGIN */'.length, b);
    await t('嵌入的新模組與來源檔逐字一致', () => { for (const f of ['ir_in_brace_core', 'ir_in_typed_core', 'ir_in_ruby_core', 'ir_in_perl_core', 'ir_out_typed_core', 'ir_out_cpp_core', 'ir_out_cs_core', 'ir_out_dyn_core', 'ir_out_perl_core', 'ir_out_ruby_core', 'ir_ops_core', 'ir_blocks_core']) { const src = fs.readFileSync(path.join(__dirname, f + '.js'), 'utf8').replace(/\r\n/g, '\n'); assert.ok(block.includes(src), f + ' 嵌入的版本和來源不同：請執行 node scripts/embed-code-ui.js'); } });
    const H = new Function(block.replace('const FaIrBundle', 'var FaIrBundle') + '\nreturn FaIrBundle;')();
    await t('FaIrBundle 暴露新模組', () => { for (const k of ['FaIrInBrace', 'FaIrOutTyped', 'FaIrOutCpp', 'FaIrOutCs', 'FaIrOutDyn', 'FaIrOutPerl', 'FaIrOutRuby']) assert.ok(H[k], k); });
    await t('宿主程式碼：convert_code 有 from 參數與新目標、_irLangParser、行為卡 nodejs／java／c 走第二層、橋注入 INB', () => {
        assert.ok(/async _irLangParser\(lang\)/.test(fa)); assert.ok(/INB: H\.FaIrInBrace/.test(fa)); assert.ok(/cpp: H\.FaIrOutCpp, csharp: H\.FaIrOutCs, perl: H\.FaIrOutPerl, ruby: H\.FaIrOutRuby/.test(fa));
        const i = fa.indexOf("registerOptional('convert_code',"); const seg = fa.slice(i, i + 4000); assert.ok(/from: \{ type: 'string', enum: \['python', 'nodejs', 'java', 'c', 'cpp', 'csharp', 'ruby', 'perl'\]/.test(seg)); assert.ok(/'cpp', 'csharp', 'perl', 'ruby', 'python'\]/.test(seg));
        assert.ok(/\['nodejs', 'java', 'c', 'cpp', 'csharp', 'ruby', 'perl'\]\.includes\(lang\)\) && a\.level !== 1/.test(fa), '行為卡第二層');
    });
    await t('/code 路由：轉成 C++／C#／Ruby／Perl 都有目標；來源貼 java 程式不再被拒', () => {
        const m = /function targetOf\(prose\) \{[\s\S]*?\n    \}\n/.exec(fa); assert.ok(m); const targetOf = new Function(m[0] + '\nreturn targetOf;')();
        assert.strictEqual(targetOf('轉成 C++').target, 'cpp'); assert.strictEqual(targetOf('把這段 Java 轉成 ruby').target, 'ruby'); assert.strictEqual(targetOf('convert to c#').target, 'csharp'); assert.strictEqual(targetOf('轉成 perl').target, 'perl'); assert.strictEqual(targetOf('轉成 nodejs').target, 'nodejs');
        assert.ok(!/來源目前只支援 Python/.test(fa), '舊的來源限制還在');
    });
    if (!DIR) { console.log('略過語法樹部分：找不到 tree-sitter 文法快取\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const load = async (w) => { if (!fs.existsSync(path.join(DIR, w))) return null; const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, w))); return P; };
    const PY = await load('tree-sitter-python.wasm'); const LP = { nodejs: await load('tree-sitter-javascript.wasm'), java: await load('tree-sitter-java.wasm'), c: await load('tree-sitter-c.wasm'), cpp: await load('tree-sitter-cpp.wasm'), csharp: await load('tree-sitter-c_sharp.wasm'), ruby: await load('tree-sitter-ruby.wasm'), perl: {} };
    const parseTree = (s) => PY.parse(s); const B = PB.makeBlocks({ parseTree, C2U });
    const bridge = H.FaIrBlocks.make({ parseTree, C2U, B, IN: H.FaIrInPython, PREP: H.FaIrPrep, OUT: { nodejs: H.FaIrOutJs, java: H.FaIrOutJava, c: H.FaIrOutC, cpp: H.FaIrOutCpp, csharp: H.FaIrOutCs, perl: H.FaIrOutPerl, ruby: H.FaIrOutRuby, python: H.FaIrOutPython }, INB: H.FaIrInBrace, INT: H.FaIrInTyped, INR: H.FaIrInRuby, INP: H.FaIrInPerl, BD: H.FaIrBehavior, DES: H.FaIrDesign, IR: H.FaIr });
    const hasPy = runCmd('python', ['-c', '1'], '').ok; const hasPerl = runCmd(PERL, ['-e', '1'], '').ok; const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'irw2-'));
    const pyOut = (code, input) => { fs.writeFileSync(path.join(tmp, 'x.py'), code); return runCmd('python', ['-I', path.join(tmp, 'x.py')], input); };
    const stat = {};
    const EMIT = { nodejs: H.FaIrOutJs, java: H.FaIrOutJava, c: H.FaIrOutC, cpp: H.FaIrOutCpp, csharp: H.FaIrOutCs, ruby: H.FaIrOutRuby, perl: H.FaIrOutPerl };
    for (const lang of ['nodejs', 'java', 'c', 'cpp', 'csharp', 'ruby', 'perl']) {
        if (!LP[lang]) { console.log('略過 ' + lang + '：沒有文法'); continue; }
        await t(lang + ' 來源 → 嵌入版的橋 → python（實跑一致）／cpp／csharp／perl／ruby（產生無 error）／perl 實跑一致', () => {
            let nPy = 0, nPerl = 0, n = 0, nRefused = 0;
            for (const s of SAMPLES.filter((x) => lang === 'cpp' || lang === 'csharp' || lang === 'ruby' || lang === 'perl' || x.langs.indexOf(lang) >= 0)) {
                const o = EMIT[lang].emit(H.FaIrPrep.prepare(H.FaIrInPython.fromTree(PY.parse(s.py).rootNode, { source: s.py }).ir).ir).code; n++;
                for (const tg of ['cpp', 'csharp', 'ruby', 'perl']) { const e = bridge.emitFrom(o, lang, tg, s.id, LP[lang]); const errs = e.diags.filter((d) => d.level === 'error');
                    // JavaScript 沒有型別標註：目標是靜態語言（cpp、csharp）時，參數型別推不出來就如實拒絕（請在來源加型別），不亂猜
                    if ((lang === 'nodejs' || lang === 'ruby' || lang === 'perl') && tg !== 'ruby' && !e.ok) { assert.ok(errs.length && errs.every((d) => /型別|標註/.test(d.msg)), s.id + ' nodejs→' + tg + ' 失敗原因不是缺型別：' + JSON.stringify(errs).slice(0, 300)); nRefused++; continue; }
                    assert.ok(e.ok, s.id + ' ' + lang + '→' + tg + ' ' + JSON.stringify(errs).slice(0, 300)); }
                const ep = bridge.emitFrom(o, lang, 'python', s.id, LP[lang]); assert.ok(ep.ok, s.id + ' →python'); const el = bridge.emitFrom(o, lang, 'perl', s.id, LP[lang]); assert.ok(el.ok, s.id + ' →perl');
                if (hasPy) for (const inp of s.inputs) { assert.strictEqual(pyOut(ep.code, inp).out, pyOut(s.py, inp).out, s.id + ' ' + lang + '→python 輸出'); } nPy++;
                if (hasPerl) { fs.writeFileSync(path.join(tmp, 'x.pl'), el.code); for (const inp of s.inputs) assert.strictEqual(runCmd(PERL, [path.join(tmp, 'x.pl')], inp).out, pyOut(s.py, inp).out, s.id + ' ' + lang + '→perl 輸出'); nPerl++; }
            }
            stat[lang] = { samples: n, python實跑一致: nPy, perl實跑一致: nPerl, 缺型別而拒絕轉靜態語言: nRefused };
        });
        await t(lang + ' 來源的行為卡走第二層（嵌入版橋 cardsFrom）', () => { const s = SAMPLES.find((x) => lang === 'cpp' || lang === 'csharp' || lang === 'ruby' || lang === 'perl' || x.langs.indexOf(lang) >= 0); const o = EMIT[lang].emit(H.FaIrPrep.prepare(H.FaIrInPython.fromTree(PY.parse(s.py).rootNode, { source: s.py }).ir).ir).code; const cs = bridge.cardsFrom(o, lang, s.id, LP[lang]); assert.ok(cs.length >= 2 && cs.every((c) => c.name && c.params), JSON.stringify(cs.map((c) => c.name))); assert.ok(/控制流/.test(bridge.cardText(cs[0]))); });
    }
    await t('不支援的來源語言如實報錯（還沒有 lua 的「進」）', () => { assert.throws(() => bridge.toIrFrom('x = 1', 'lua', 'x', PY), /還沒有 lua 的「進」/); });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
    console.log('  · ' + JSON.stringify(stat)); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
