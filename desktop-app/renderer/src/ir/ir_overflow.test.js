'use strict';
// 大整數／溢位語意（2026-11-11）：Python 的 int 沒有上限，Java／C／C++／C# 是 64 位元、JavaScript 是 2^53 精確、Perl 超過 64 位元悄悄變浮點。
// prepare(ir, {overflow:'check'}) 把整數 + - * ** 換成「檢查溢位」的標準操作：超出範圍就明確失敗（程式以非 0 結束），不悄悄給錯的數。
// 驗證：Python → IR → 各語言 → 真的編譯執行；範圍內輸出與 Python 逐字一致；超出範圍必須「失敗」且不得印出與 Python 不同的數字；
// 對照組：不開檢查時 Java 悄悄環繞（印出錯的數、結束碼 0），證明這個樣本測得到差異。工具鏈找不到就略過該語言並印原因。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const PREP = require('./ir_prep_core.js'), INPY = require('./ir_in_python_core.js'), OPS = require('./ir_ops_core.js');
const OUT = { nodejs: require('./ir_out_js_core.js'), java: require('./ir_out_java_core.js'), c: require('./ir_out_c_core.js'), cpp: require('./ir_out_cpp_core.js'), cs: require('./ir_out_cs_core.js'), perl: require('./ir_out_perl_core.js'), ruby: require('./ir_out_ruby_core.js'), python: require('./ir_out_python_core.js') };
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
const MING = process.env.FA_MINGW_BIN || 'J:\\msys64\\mingw64\\bin'; const PERL = process.env.FA_PERL || 'J:\\msys64\\usr\\bin\\perl.exe';
const ENVM = Object.assign({}, process.env, { PATH: MING + path.delimiter + (process.env.PATH || '') });
let pass = 0, fail = 0; const notes = [];
const t = (name, fn) => { try { fn(); pass++; return true; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 20).join('\n   ')); return false; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-'));
const sh = (cmd, args, o) => cp.spawnSync(cmd, args, Object.assign({ encoding: 'utf8', timeout: 60000 }, o || {}));
const norm = (s) => String(s).replace(/\r\n/g, '\n');
const which = (cmd, args, env) => { try { const r = sh(cmd, args, { env: env || process.env, timeout: 20000 }); return r.status === 0 ? String(r.stdout || r.stderr).split('\n')[0].trim() : null; } catch (e) { return null; } };
let PY = null; for (const c of ['python3', 'python']) if (which(c, ['-I', '-c', 'print(1)']) === '1') { PY = c; break; }

const SRC = `def fact(n: int) -> int:
    r: int = 1
    for i in range(1, n + 1):
        r = r * i
    return r


def fib(n: int) -> int:
    a: int = 0
    b: int = 1
    for i in range(n):
        a, b = b, a + b
    return a


def main():
    n: int = int(input())
    print(fact(n))
    print(fib(n * 4))
    print(2 ** n)
    print(n - 1000000 * 1000)


main()
`;
// 範圍內（所有語言都應與 Python 相同）：n=10；中等（超過 2^53 但在 64 位元內）：n=20 的階乘＝2.4e18、2**20、fib(80)=2.3e16 → JavaScript 應失敗，其餘一致；
// 太大（超過 64 位元）：n=25（25! = 1.5e25）→ 靜態語言與 JavaScript、Perl 都應失敗；Python／Ruby 與 Python 相同
const IN_SMALL = '10\n', IN_MID = '20\n', IN_BIG = '25\n';

(async () => {
    if (!DIR || !PY) { console.log('略過：找不到 tree-sitter 快取或 python\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') }); const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')));
    fs.writeFileSync(path.join(tmp, 'o.py'), SRC);
    const ref = {}; [IN_SMALL, IN_MID, IN_BIG].forEach((i) => { ref[i] = norm(sh(PY, ['-I', path.join(tmp, 'o.py')], { input: i }).stdout); });
    const irOf = () => INPY.fromTree(P.parse(SRC).rootNode, { source: SRC }).ir;
    const emitCheck = (lang, check) => { const prep = PREP.prepare(irOf(), check ? { overflow: 'check' } : {}); const em = OUT[lang].emit(prep.ir, lang === 'cs' ? { className: 'Main_', entryName: 'Main' } : {}); const errs = em.diags.filter((d) => d.level === 'error'); assert.strictEqual(errs.length, 0, lang + ' 輸出器報 error：' + errs.map((d) => d.msg).slice(0, 3).join(';')); return em.code; };

    t('目錄：檢查操作 5 個、每個語言都有樣板、輔助函式存在', () => {
        ['int.cadd', 'int.csub', 'int.cmul', 'int.cpow'].forEach((id) => { assert.ok(OPS.has(id), id); OPS.LANGS.forEach((l) => assert.ok(OPS.get(id).cells[l] != null, id + ' ' + l)); });
        ['nodejs', 'c', 'cpp', 'pl'].forEach((l) => ['fa_cadd', 'fa_csub', 'fa_cmul', 'fa_cpow'].forEach((h) => assert.ok(OPS.HELPERS[l][h], l + ' ' + h)));
        assert.ok(OPS.HELPERS.java.fa_cpow && OPS.HELPERS.cs.fa_cpow);
    });
    t('prepare：開檢查才換成 int.c* 操作，預設不換', () => {
        const a = JSON.stringify(PREP.prepare(irOf(), { overflow: 'check' }).ir), b = JSON.stringify(PREP.prepare(irOf()).ir);
        assert.ok(/int\.cmul/.test(a) && /int\.cadd/.test(a) && /int\.csub/.test(a) && /int\.cpow/.test(a)); assert.ok(!/int\.c(add|sub|mul|pow)/.test(b));
    });
    t('Python／Ruby：檢查模式輸出與 Python 相同（原本就是大整數）', () => {
        const py = emitCheck('python', true); fs.writeFileSync(path.join(tmp, 'p.py'), py); [IN_SMALL, IN_MID, IN_BIG].forEach((i) => assert.strictEqual(norm(sh(PY, ['-I', path.join(tmp, 'p.py')], { input: i }).stdout), ref[i]));
        assert.ok(!/fa_c/.test(py));
    });

    // 每個語言：產生 → 編譯 → 三種輸入
    const check = (lang, run) => {
        const r1 = run(IN_SMALL); assert.strictEqual(r1.status, 0, lang + ' 小數失敗：' + r1.stderr.slice(0, 300)); assert.strictEqual(norm(r1.stdout), ref[IN_SMALL], lang + ' 小數輸出與 Python 不同');
        const r2 = run(IN_MID);
        if (lang === 'nodejs') { assert.notStrictEqual(r2.status, 0, 'nodejs 超過 2^53 應失敗'); assert.ok(/overflow/.test(r2.stderr), r2.stderr.slice(0, 200)); }
        else if (lang === 'perl') { /* Perl 的 IV 是 64 位元：範圍內與 Python 相同；fib 與 2**n 都在範圍 */ assert.strictEqual(r2.status, 0, 'perl 中等失敗：' + r2.stderr.slice(0, 300)); assert.strictEqual(norm(r2.stdout), ref[IN_MID], 'perl 中等輸出不同'); }
        else { assert.strictEqual(r2.status, 0, lang + ' 中等失敗：' + r2.stderr.slice(0, 300)); assert.strictEqual(norm(r2.stdout), ref[IN_MID], lang + ' 中等輸出與 Python 不同'); }
        const r3 = run(IN_BIG);
        if (lang === 'ruby') { assert.strictEqual(r3.status, 0); assert.strictEqual(norm(r3.stdout), ref[IN_BIG]); }
        else { assert.notStrictEqual(r3.status, 0, lang + ' 超過 64 位元應失敗，卻成功並印出：' + r3.stdout.slice(0, 120)); assert.ok(/overflow/i.test(r3.stderr), lang + ' 錯誤訊息應說明溢位：' + r3.stderr.slice(0, 200)); }
        // 失敗前印出的每一行都必須是 Python 的前綴（不得先印錯的數字）
        const lines = norm(r3.stdout).split('\n').filter(Boolean), refl = ref[IN_BIG].split('\n').filter(Boolean); lines.forEach((l, i) => assert.strictEqual(l, refl[i], lang + ' 第 ' + (i + 1) + ' 行與 Python 不同'));
    };
    t('nodejs 檢查模式', () => { const f = path.join(tmp, 'a.js'); fs.writeFileSync(f, emitCheck('nodejs', true)); check('nodejs', (i) => sh(process.execPath, [f], { input: i })); });
    const JAVAC = which('javac', ['-version']) || which('javac', ['--version']);
    if (!JAVAC) notes.push('java：找不到 javac → 略過'); else {
        t('java 檢查模式', () => { const d = path.join(tmp, 'j'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'Main.java'), emitCheck('java', true)); const c = sh('javac', ['-encoding', 'UTF-8', '-d', d, path.join(d, 'Main.java')]); assert.strictEqual(c.status, 0, c.stderr.slice(0, 800)); check('java', (i) => sh('java', ['-cp', d, 'Main'], { input: i })); });
        t('對照組：不開檢查時 java 悄悄環繞（印出與 Python 不同的數、結束碼 0）', () => {
            const d = path.join(tmp, 'j2'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'Main.java'), emitCheck('java', false)); const c = sh('javac', ['-encoding', 'UTF-8', '-d', d, path.join(d, 'Main.java')]); assert.strictEqual(c.status, 0, c.stderr.slice(0, 800));
            const r = sh('java', ['-cp', d, 'Main'], { input: IN_BIG }); assert.strictEqual(r.status, 0); assert.notStrictEqual(norm(r.stdout), ref[IN_BIG]);
        });
    }
    const GCC = fs.existsSync(path.join(MING, 'gcc.exe')) ? path.join(MING, 'gcc.exe') : null, GPP = fs.existsSync(path.join(MING, 'g++.exe')) ? path.join(MING, 'g++.exe') : null;
    if (!GCC) notes.push('c／cpp：找不到 ' + MING + ' → 略過'); else {
        t('c 檢查模式', () => { const f = path.join(tmp, 'a.c'), exe = path.join(tmp, 'a_c.exe'); fs.writeFileSync(f, emitCheck('c', true)); const c = sh(GCC, ['-O1', '-Wall', '-o', exe, f, '-lm'], { env: ENVM }); assert.strictEqual(c.status, 0, c.stderr.slice(0, 800)); check('c', (i) => sh(exe, [], { input: i, env: ENVM })); });
        t('cpp 檢查模式', () => { const f = path.join(tmp, 'a.cpp'), exe = path.join(tmp, 'a_cpp.exe'); fs.writeFileSync(f, emitCheck('cpp', true)); const c = sh(GPP, ['-std=c++17', '-O1', '-o', exe, f], { env: ENVM }); assert.strictEqual(c.status, 0, c.stderr.slice(0, 800)); check('cpp', (i) => sh(exe, [], { input: i, env: ENVM })); });
    }
    if (!which('dotnet', ['--version'])) notes.push('c#：找不到 dotnet → 略過'); else {
        t('c# 檢查模式', () => {
            const d = path.join(tmp, 'cs'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'Main_.cs'), emitCheck('cs', true));
            fs.writeFileSync(path.join(d, 'cs.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><Nullable>disable</Nullable><ImplicitUsings>disable</ImplicitUsings><InvariantGlobalization>true</InvariantGlobalization></PropertyGroup></Project>\n');
            const b = sh('dotnet', ['build', '-nologo', '-v', 'q', '-o', path.join(d, 'out')], { cwd: d, timeout: 240000 }); assert.strictEqual(b.status, 0, String(b.stdout).split('\n').filter((l) => /error/.test(l)).slice(0, 8).join('\n'));
            check('cs', (i) => sh('dotnet', [path.join(d, 'out', 'cs.dll')], { input: i }));
        });
    }
    if (!which(PERL, ['-e', 'print "ok"'])) notes.push('perl：找不到 → 略過'); else t('perl 檢查模式', () => { const f = path.join(tmp, 'a.pl'); fs.writeFileSync(f, emitCheck('perl', true)); check('perl', (i) => sh(PERL, [f], { input: i })); });
    if (!which('ruby', ['-e', 'print "ok"'])) notes.push('ruby：找不到 → 略過'); else t('ruby 檢查模式（原生大整數，輸出與 Python 相同）', () => { const f = path.join(tmp, 'a.rb'); fs.writeFileSync(f, emitCheck('ruby', true)); check('ruby', (i) => sh('ruby', [f], { input: i })); });

    notes.forEach((x) => console.log('  · ' + x)); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
