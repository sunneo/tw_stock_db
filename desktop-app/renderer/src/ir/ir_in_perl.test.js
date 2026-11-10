'use strict';
// Perl 的「進」（ir_in_perl_core.js）：Python 樣本 → IR → 輸出 Perl 原始碼 → 再「進」成 IR → 輸出 Python → 實跑，輸出要和原本 Python 一致。
// 同時量：原生區塊（沒認得的）個數、註解數是否相等。需要 tree-sitter 的 ruby 文法（沒有就略過並說明）和 python。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const IR = require('./ir_core.js'), PREP = require('./ir_prep_core.js'), INPY = require('./ir_in_python_core.js'), INB = require('./ir_in_perl_core.js'), SAMPLES = require('./ir_samples.js');
const OUT = { perl: require('./ir_out_perl_core.js'), python: require('./ir_out_python_core.js') };
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
let PY = null; for (const c of ['python', 'python3']) { const r = cp.spawnSync(c, ['-I', '-c', 'print(1)'], { encoding: 'utf8' }); if (r.status === 0 && r.stdout.trim() === '1') { PY = c; break; } }
let pass = 0, fail = 0; const notes = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 40).join('\n   ')); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'irt-'));
const runPy = (code, input) => { fs.writeFileSync(path.join(tmp, 'p.py'), code); const r = cp.spawnSync(PY, ['-I', path.join(tmp, 'p.py')], { input, encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? r.stdout : 'ERR:' + String(r.stderr).slice(-300); };
(async () => {
    if (!DIR || !PY) { console.log('略過：找不到 tree-sitter 快取或 python\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const parsers = {}; const want = { python: 'tree-sitter-python.wasm' };
    for (const [l, w] of Object.entries(want)) { if (!fs.existsSync(path.join(DIR, w))) { notes.push('略過 ' + l + '：沒有 ' + w); continue; } const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, w))); parsers[l] = P; }
    if (!parsers.python) { console.log('略過：沒有 python 文法\n0 passed, 0 failed'); return; }
    const results = {};
    for (const lang of ['perl']) {
        const patterns = INB.buildPatterns();
        t(lang + '：樣式表有內容（目錄樣板可解析成語法樹）', () => { assert.ok(patterns.length > 50, '樣式數 ' + patterns.length); notes.push(lang + ' 樣式 ' + patterns.length + ' 個'); });
        let okN = 0, totN = 0, nat = 0, cmS = 0, cmK = 0;
        for (const s of SAMPLES) {
            t(lang + '／' + s.id + '：Python→IR→' + lang + '→IR→Python，實跑輸出一致', () => {
                totN++; const ir0 = INPY.fromTree(parsers.python.parse(s.py).rootNode, { source: s.py }).ir; const em = OUT[lang].emit(PREP.prepare(ir0).ir); assert.ok(!em.diags.some((d) => d.level === 'error'), '輸出 ' + lang + ' 失敗');
                const r = INB.fromSource(em.code, { patterns }); nat += r.coverage.natives; const v = IR.validate(r.ir, { ops: { has: require('./ir_ops_core.js').has } }); assert.ok(v.ok, '驗證：' + v.errors.slice(0, 3).join(';'));
                const c0 = IR.comments(ir0).length, c1 = IR.comments(r.ir).length; cmS += c0; cmK += Math.min(c0, c1);
                const back = OUT.python.emit(PREP.prepare(r.ir).ir); assert.ok(!back.diags.some((d) => d.level === 'error'), 'Python 輸出：' + back.diags.filter((d) => d.level === 'error').map((d) => d.msg).slice(0, 2).join(';') + '\n' + em.code.slice(0, 200));
                for (const inp of s.inputs) { const a = runPy(s.py, inp), b = runPy(back.code, inp); assert.strictEqual(b, a, '輸入 ' + JSON.stringify(inp) + '\n--- 還原的 Python:\n' + back.code); }
                okN++;
            });
        }
        results[lang] = { ok: okN, tot: totN, natives: nat, comments: cmS + ' 條原有、' + cmK + ' 條保留（數量）' };
    }

    // 手寫的 Perl（不是我們自己輸出的）：註解保存、不認得的整句收成原生區塊而不丟
    {
        const code = `# 計算總和
sub sum { # 標頭註解
    my ($a) = @_;
    my $s = 0; # 累加
    for my $x (@{$a}) { $s += $x; }
    local $| = 1;
    $s++ if $s > 100;
    return $s;
}
`;
        const r = INB.fromSource(code, { patterns: INB.buildPatterns() });
        t('手寫 Perl：前置註解、標頭行尾註解、行尾註解，local 與修飾語句收成原生區塊', () => {
            const fn = r.ir.body[0]; assert.strictEqual(fn.k, 'func'); assert.deepStrictEqual(fn.c && fn.c.b, ['計算總和']); assert.strictEqual(fn.c && fn.c.a, '標頭註解'); assert.strictEqual(fn.params.length, 1); assert.strictEqual(fn.body[0].c && fn.body[0].c.a, '累加'); assert.strictEqual(fn.body[1].k, 'foreach');
            assert.strictEqual(fn.body.filter((x) => x.k === 'native').length, 2, JSON.stringify(fn.body.map((x) => x.k))); assert.strictEqual(r.coverage.natives, 2);
        });
    }
    notes.push(JSON.stringify(results));
    notes.forEach((x) => console.log('  · ' + x));
    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
