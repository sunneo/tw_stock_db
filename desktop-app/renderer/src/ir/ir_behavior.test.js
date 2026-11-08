'use strict';
// 行為描述（第一層）：用現有行為分析器（FaBeh2＋tree-sitter）抽 python 與 nodejs 的函式行為描述，與由完整中間語言轉出的描述比對；
// 並驗證只靠行為描述能產生的骨架（nodejs／java）可編譯。需 tree-sitter 快取（python＋javascript），沒有就略過。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const IR = require('./ir_core.js'), OPS = require('./ir_ops_core.js'), PREP = require('./ir_prep_core.js'), IN = require('./ir_in_python_core.js'), BD = require('./ir_behavior_core.js');
const OUTJS = require('./ir_out_js_core.js'), SAMPLES = require('./ir_samples.js');
const root = path.join(__dirname, '..', '..', '..');
let pass = 0, fail = 0; const notes = [];
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 6).join('\n   ')); } };
const DIR = process.env.FA_TS_DIR || [path.join(os.tmpdir(), 'fa-ts-cache'), path.join(os.homedir(), '.cache', 'fa-ts'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')) && fs.existsSync(path.join(d, 'tree-sitter-javascript.wasm')));
(async () => {
    await t('反向索引：由操作目錄的樣板自動建，常見呼叫認得出（同名多義保留成多個候選）', () => {
        const has = (lang, call, op) => assert.ok(BD.recognize(lang, call).indexOf(op) >= 0, lang + ' ' + call + ' → ' + JSON.stringify(BD.recognize(lang, call)));
        has('python', 'len', 'coll.len'); has('python', 'input', 'io.read_line'); has('python', 'x.append', 'list.append'); has('python', 'math.sqrt', 'math.sqrt'); has('python', 'print', 'io.print_line');
        has('nodejs', 'console.log', 'io.print_line'); has('nodejs', 'x.push', 'list.append'); has('nodejs', 'Math.sqrt', 'math.sqrt'); has('nodejs', 'a.join', 'str.join');
        has('java', 'x.add', 'list.append'); has('java', 'System.out.println', 'io.print_line'); has('java', 'Math.abs', 'num.abs'); has('c', 'strlen', 'coll.len');
        assert.deepStrictEqual(BD.recognize('python', 'no_such_function'), []);
        notes.push('反向索引條目數：' + OPS.LANGS.map((l) => l + ' ' + Object.keys(BD.index()[l]).length).join('、'));
    });
    if (!DIR) { console.log('略過 tree-sitter 相關測試'); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const langs = {}; for (const n of ['python', 'javascript']) { langs[n] = await Parser.Language.load(path.join(DIR, 'tree-sitter-' + n + '.wasm')); }
    const parse = (lang, src) => { const p = new Parser(); p.setLanguage(langs[lang]); return p.parse(src).rootNode; };
    const data = require(path.join(root, 'scripts', 'behavior-data.js')).load(root);
    const parts = ['engine_1_core.js', 'engine_2_scan.js', 'engine_3_narrative.js', 'engine_4_analyze.js', 'engine_5_api.js'].map((f) => fs.readFileSync(path.join(root, 'renderer', 'src', 'behavior', f), 'utf8')).join('\n');
    const FaBeh2 = new Function("'use strict';\n" + parts)();
    const host = { async loadTreeSitter() { return Parser; }, async loadLanguageWasm(name) { return new Uint8Array(fs.readFileSync(path.join(DIR, 'tree-sitter-' + name + '.wasm'))); } };
    const eng = FaBeh2.create({ patterns: data.patterns, api: data.api }, host, { categories: {}, api: {}, idioms: {}, notes: {}, mnemonics: {} });
    const bdOf = async (lang, file, src) => {
        const r = await eng.explain(file, src, { notes: {} }); const sigs = BD.sigsFromTree(lang, parse(lang, src), src);
        const fns = r.functions.filter((f) => !/^<anonymous/.test(f.name)); const names = fns.map((f) => f.name).filter((n) => !/^fa_|^__/.test(n));
        return fns.filter((f) => !/^fa_|^__/.test(f.name)).map((f) => BD.describe(lang, f, sigs[f.name], names));
    };
    const irOf = (s) => { const r = IN.fromTree(parse('python', s.py), { source: s.py, name: s.id }); return PREP.prepare(r.ir).ir; };
    const stats = { n: 0, calls: 0, loops: 0, effects: 0, arity: 0, jac: 0, recallNum: 0, recallDen: 0 }; const x = { n: 0, calls: 0, loops: 0, effects: 0, jac: 0, names: 0 };
    const detail = [];
    await t('python：行為分析器抽出的行為描述與完整中間語言轉出的描述一致（函式名、呼叫關係、迴圈數、參數個數）', async () => {
        for (const s of SAMPLES) {
            const a = await bdOf('python', s.id + '.py', s.py), b = BD.fromIr(irOf(s));
            assert.deepStrictEqual(a.map((f) => f.name), b.map((f) => f.name), s.id + ' 函式名');
            a.forEach((fa, i) => {
                const g = BD.agree(fa, b[i]); stats.n++; if (g.calls) stats.calls++; if (g.loops) stats.loops++; if (g.effects) stats.effects++; if (g.arity) stats.arity++; stats.jac += g.stdJaccard;
                const irOps = b[i].std.map((o) => o.op); stats.recallDen += irOps.length; stats.recallNum += irOps.filter((o) => fa.std.some((z) => z.op === o)).length;
                assert.ok(g.calls && g.loops && g.arity, s.id + '.' + fa.name + ' ' + JSON.stringify(g)); if (!g.effects) detail.push(s.id + '.' + fa.name + ' 副作用 ' + JSON.stringify(fa.effects) + ' vs ' + JSON.stringify(b[i].effects));
            });
        }
        notes.push('python 行為描述 vs 中間語言轉出：' + stats.n + ' 個函式；呼叫關係 ' + stats.calls + '、迴圈數 ' + stats.loops + '、參數個數 ' + stats.arity + '、副作用 ' + stats.effects + ' 個一致；標準操作平均重合度 ' + (stats.jac / stats.n).toFixed(2) + '、中間語言用到的操作被找回 ' + stats.recallNum + '/' + stats.recallDen + (detail.length ? '；副作用不一致：' + detail.slice(0, 4).join('；') : ''));
    });
    await t('nodejs：同一批程式（由中間語言產生的 JavaScript）用 tree-sitter 抽的行為描述，與 python 那份跨語言一致', async () => {
        for (const s of SAMPLES) {
            const js = OUTJS.emit(irOf(s)).code; const a = await bdOf('python', s.id + '.py', s.py), b = (await bdOf('nodejs'.replace('nodejs', 'javascript'), s.id + '.js', js)).filter((f) => !/^fa_|^__/.test(f.name));
            assert.deepStrictEqual(b.map((f) => f.name).sort(), a.map((f) => f.name).sort(), s.id + ' 函式名');
            a.forEach((fa) => { const fb = b.find((f) => f.name === fa.name); const g = BD.agree(fa, fb); x.n++; if (g.calls) x.calls++; if (g.loops) x.loops++; if (g.effects) x.effects++; x.jac += g.stdJaccard; assert.ok(g.calls, s.id + '.' + fa.name + ' 呼叫關係 ' + JSON.stringify([fa.calls, fb.calls])); });
        }
        notes.push('python vs nodejs 行為描述：' + x.n + ' 個函式；呼叫關係一致 ' + x.calls + '、迴圈數一致 ' + x.loops + '、副作用一致 ' + x.effects + '；標準操作平均重合度 ' + (x.jac / x.n).toFixed(2));
    });
    await t('只靠行為描述能產生骨架：nodejs 通過 node --check、java 通過 javac；本體是「待實作」，不假裝重現行為', async () => {
        const s = SAMPLES[0]; const a = await bdOf('python', 'a.py', s.py); const tot = a.find((f) => f.name === 'total');
        const jsSk = BD.skeleton(tot, 'nodejs'); assert.ok(/function total\(a\)/.test(jsSk) && /Return the sum/.test(jsSk) && /待實作/.test(jsSk));
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-')); try {
            fs.writeFileSync(path.join(d, 'a.js'), jsSk); const r = cp.spawnSync(process.execPath, ['--check', path.join(d, 'a.js')], { encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr);
            const jv = 'import java.util.*;\npublic class Main {\n' + BD.skeleton(tot, 'java') + '    public static void main(String[] a) {}\n}\n'; fs.writeFileSync(path.join(d, 'Main.java'), jv);
            const c = cp.spawnSync('javac', ['-encoding', 'UTF-8', '-d', d, path.join(d, 'Main.java')], { encoding: 'utf8' }); assert.strictEqual(c.status, 0, c.stderr + jv);
        } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
    });
    console.log(notes.join('\n')); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
