'use strict';
// C++／C#／Perl／Ruby 輸出器的實跑驗證：Python 樣本 → IR → 該語言原始碼 → 真的編譯／執行 → 輸出與原 Python 逐字一致。
// 工具鏈：C++＝J:\msys64\mingw64\bin\g++（PATH 要放最前面；usr\bin 那支沒有標頭）；C#＝dotnet SDK（build 一次、每個樣本一個類別、用參數選樣本）；
//        Perl＝J:\msys64\usr\bin\perl；Ruby＝這台沒有（Get-Command ruby 找不到）→ 只做產生與靜態檢查，標「未實跑」。找不到工具鏈就略過該語言並印原因。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const IR = require('./ir_core.js'), PREP = require('./ir_prep_core.js'), INPY = require('./ir_in_python_core.js'), SAMPLES = require('./ir_samples.js');
const OUT = { cpp: require('./ir_out_cpp_core.js'), cs: require('./ir_out_cs_core.js') };
try { OUT.perl = require('./ir_out_perl_core.js'); } catch (e) { /* 尚未提供 */ }
try { OUT.ruby = require('./ir_out_ruby_core.js'); } catch (e) { /* 尚未提供 */ }
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
const MING = process.env.FA_MINGW_BIN || 'J:\\msys64\\mingw64\\bin'; const PERL = process.env.FA_PERL || 'J:\\msys64\\usr\\bin\\perl.exe';
const ENVM = Object.assign({}, process.env, { PATH: MING + path.delimiter + (process.env.PATH || '') });
const which = (cmd, args, env) => { try { const r = cp.spawnSync(cmd, args, { encoding: 'utf8', env: env || process.env, timeout: 20000 }); return r.status === 0 ? String(r.stdout || r.stderr).split('\n')[0].trim() : null; } catch (e) { return null; } };
let PY = null; for (const c of ['python', 'python3']) { if (which(c, ['-I', '-c', 'print(1)']) === '1') { PY = c; break; } }
let pass = 0, fail = 0; const notes = []; const table = {};
const t = (name, fn) => { try { fn(); pass++; return true; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 30).join('\n   ')); return false; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'irm-'));
const runIn = (cmd, args, input, env) => { const r = cp.spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 30000, env: env || process.env }); return r.status === 0 ? r.stdout.replace(/\r\n/g, '\n') : 'ERR(' + r.status + '):' + String(r.stderr).slice(-300); };
const norm = (s) => s.replace(/\r\n/g, '\n');
(async () => {
    if (!DIR || !PY) { console.log('略過：找不到 tree-sitter 快取或 python\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') }); const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')));
    const expected = {}; SAMPLES.forEach((s) => { fs.writeFileSync(path.join(tmp, 'o.py'), s.py); expected[s.id] = s.inputs.map((inp) => norm(runIn(PY, ['-I', path.join(tmp, 'o.py')], inp))); });
    const irOf = (s) => PREP.prepare(INPY.fromTree(P.parse(s.py).rootNode, { source: s.py }).ir).ir;
    const sid = (s) => s.id.replace(/[^A-Za-z0-9]/g, '_');
    const sameAll = (lang, s, runOne) => { s.inputs.forEach((inp, i) => { const got = norm(runOne(inp)); assert.strictEqual(got, expected[s.id][i], lang + '／' + s.id + ' 輸入 ' + JSON.stringify(inp) + '\n期望 ' + JSON.stringify(expected[s.id][i]) + '\n實際 ' + JSON.stringify(got)); }); };
    const noErr = (lang, s, em) => assert.ok(!em.diags.some((d) => d.level === 'error'), lang + '／' + s.id + ' 輸出器報 error：' + em.diags.filter((d) => d.level === 'error').map((d) => d.msg).slice(0, 3).join(';'));

    // ---- C++ ----
    const GPP = which(MING + '\\g++.exe', ['--version'], ENVM) || (fs.existsSync(MING) ? null : which('g++', ['--version']));
    if (!GPP) { notes.push('C++：找不到 g++（' + MING + '）→ 略過'); table.cpp = '這台沒有環境（g++ 找不到）'; }
    else {
        let ok = 0;
        for (const s of SAMPLES) t('C++／' + s.id, () => {
            const em = OUT.cpp.emit(irOf(s)); noErr('cpp', s, em); const f = path.join(tmp, 'c_' + sid(s) + '.cpp'), exe = path.join(tmp, 'c_' + sid(s) + '.exe'); fs.writeFileSync(f, em.code);
            const c = cp.spawnSync(path.join(MING, 'g++.exe'), ['-std=c++17', '-O0', '-o', exe, f], { encoding: 'utf8', env: ENVM, timeout: 90000 }); assert.strictEqual(c.status, 0, 'g++ 編譯失敗：\n' + String(c.stderr).slice(0, 1500) + '\n' + em.code);
            sameAll('cpp', s, (inp) => runIn(exe, [], inp, ENVM)); ok++;
        });
        table.cpp = '實跑通過 ' + ok + '/' + SAMPLES.length + '（' + GPP + '）';
    }
    // ---- C# ----
    const DOTNET = which('dotnet', ['--version']);
    if (!DOTNET) { notes.push('C#：找不到 dotnet → 略過'); table.cs = '這台沒有環境（dotnet 找不到）'; }
    else {
        const dir = path.join(tmp, 'cs'); fs.mkdirSync(dir, { recursive: true }); const ems = {}; let ok = 0, built = false;
        for (const s of SAMPLES) t('C#／' + s.id + '（產生）', () => { const em = OUT.cs.emit(irOf(s), { className: 'S_' + sid(s), entryName: 'Run' }); noErr('cs', s, em); ems[s.id] = em; fs.writeFileSync(path.join(dir, 'S_' + sid(s) + '.cs'), em.code); });
        const ids = SAMPLES.filter((s) => ems[s.id]);
        fs.writeFileSync(path.join(dir, 'Entry.cs'), 'public static class Entry { public static void Main(string[] a) { switch (a[0]) {\n' + ids.map((s) => 'case "' + s.id + '": S_' + sid(s) + '.Run(); break;').join('\n') + '\n } } }\n');
        fs.writeFileSync(path.join(dir, 'cs.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><Nullable>disable</Nullable><ImplicitUsings>disable</ImplicitUsings><StartupObject>Entry</StartupObject><InvariantGlobalization>true</InvariantGlobalization></PropertyGroup></Project>\n');
        t('C#：整個專案 dotnet build', () => { const b = cp.spawnSync('dotnet', ['build', '-nologo', '-v', 'q', '-o', path.join(dir, 'out')], { cwd: dir, encoding: 'utf8', timeout: 240000 }); assert.strictEqual(b.status, 0, 'dotnet build 失敗：\n' + String(b.stdout).split('\n').filter((l) => /error/.test(l)).slice(0, 12).join('\n')); built = true; });
        if (built) for (const s of ids) t('C#／' + s.id, () => { sameAll('cs', s, (inp) => runIn('dotnet', [path.join(dir, 'out', 'cs.dll'), s.id], inp)); ok++; });
        table.cs = '實跑通過 ' + ok + '/' + SAMPLES.length + '（dotnet ' + DOTNET + '）';
    }
    // ---- Perl ----
    if (OUT.perl) {
        const PV = which(PERL, ['-e', 'print "ok"']);
        if (!PV) { notes.push('Perl：找不到 ' + PERL + ' → 略過'); table.perl = '這台沒有環境（perl 找不到）'; }
        else { let ok = 0; for (const s of SAMPLES) t('Perl／' + s.id, () => { const em = OUT.perl.emit(irOf(s)); noErr('perl', s, em); const f = path.join(tmp, 'p_' + sid(s) + '.pl'); fs.writeFileSync(f, em.code); sameAll('perl', s, (inp) => runIn(PERL, [f], inp)); ok++; }); table.perl = '實跑通過 ' + ok + '/' + SAMPLES.length; }
    } else table.perl = '輸出器尚未提供';
    // ---- Ruby ----
    if (OUT.ruby) {
        const RV = which('ruby', ['-e', 'print "ok"']);
        let gen = 0, syn = 0; let rubyP = null; if (fs.existsSync(path.join(DIR, 'tree-sitter-ruby.wasm'))) { rubyP = new Parser(); rubyP.setLanguage(await Parser.Language.load(path.join(DIR, 'tree-sitter-ruby.wasm'))); } for (const s of SAMPLES) t('Ruby／' + s.id + '（產生）', () => { const em = OUT.ruby.emit(irOf(s)); noErr('ruby', s, em); assert.ok(/def /.test(em.code) && /\bend\b/.test(em.code)); gen++; if (rubyP) { const tr = rubyP.parse(em.code); assert.ok(!tr.rootNode.hasError(), 'Ruby 語法檢查（tree-sitter-ruby）有錯：\n' + em.code); syn++; } if (RV) { const f = path.join(tmp, 'r_' + sid(s) + '.rb'); fs.writeFileSync(f, em.code); sameAll('ruby', s, (inp) => runIn('ruby', [f], inp)); } });
        table.ruby = RV ? '實跑通過' : '這台沒有環境，未實跑（Get-Command ruby：找不到；只驗證能產生 ' + gen + '/' + SAMPLES.length + ' 個樣本的原始碼、無 error 診斷；tree-sitter-ruby 語法檢查通過 ' + syn + '/' + SAMPLES.length + '）';
    } else table.ruby = '輸出器尚未提供';
    notes.push(JSON.stringify(table)); notes.forEach((x) => console.log('  · ' + x));
    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
