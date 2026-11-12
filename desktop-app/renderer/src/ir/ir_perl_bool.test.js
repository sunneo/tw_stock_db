'use strict';
// Perl 布林輸出（2026-11-11）：Python 的 True／False 轉成字串時，Perl 原本輸出 1 與空字串（"" . (!!1)），與 Python 的 True／False 不一致。
// 驗證：Python 布林程式 → IR → Perl → 真的 perl 實跑，輸出與 Python 逐字一致；另檢查 conv.str 的布林格子是 True／False。
// 找不到 python3 或 perl 就略過並說明。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const PREP = require('./ir_prep_core.js'), INPY = require('./ir_in_python_core.js'), OUTPL = require('./ir_out_perl_core.js'), OPS = require('./ir_ops_core.js');
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
const PERL = process.env.FA_PERL || (process.platform === 'win32' ? 'J:\\msys64\\usr\\bin\\perl.exe' : 'perl');
const which = (exe, args) => { const r = cp.spawnSync(exe, args, { encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? String(r.stdout || '').trim() : null; };
let PY = null; for (const c of ['python3', 'python']) if (which(c, ['-I', '-c', 'import sys; print(sys.version_info[0])']) === '3') { PY = c; break; }
const hasPerl = which(PERL, ['-e', 'print 1']) === '1';
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 12).join('\n   ')); } };

const SRC = `def is_even(n: int) -> bool:
    return n % 2 == 0


def main():
    n = int(input())
    flag = is_even(n)
    print(flag)
    print(not flag)
    print(n > 3 and flag)
    print(True, False)
    print(1 == 1)
    print(None is None)


main()
`;

(async () => {
    if (!DIR || !PY || !hasPerl) { console.log('略過：' + (!DIR ? '找不到 tree-sitter 快取' : !PY ? '找不到 python3' : '找不到 perl') + '\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')));
    t('conv.str 的布林格子是 True／False（不是 Perl 的 1 或空字串）', () => {
        const cell = OPS.get('conv.str').cells.pl; assert.ok(cell && typeof cell === 'object' && /True/.test(cell.bool), JSON.stringify(cell));
    });
    t('Python 布林程式 → IR → Perl → 實跑，與 Python 輸出逐字一致（輸入 4、7）', () => {
        const ir0 = INPY.fromTree(P.parse(SRC).rootNode, { source: SRC }).ir; const em = OUTPL.emit(PREP.prepare(ir0).ir);
        assert.ok(!em.diags.some((d) => d.level === 'error'), em.diags.map((d) => d.msg).join(';'));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iplb-')); const pf = path.join(dir, 'b.py'), plf = path.join(dir, 'b.pl');
        fs.writeFileSync(pf, SRC); fs.writeFileSync(plf, em.code);
        for (const inp of ['4\n', '7\n']) {
            const a = cp.spawnSync(PY, ['-I', pf], { input: inp, encoding: 'utf8', timeout: 20000 }), b = cp.spawnSync(PERL, [plf], { input: inp, encoding: 'utf8', timeout: 20000 });
            assert.strictEqual(a.status, 0, 'python 失敗：' + a.stderr); assert.strictEqual(b.status, 0, 'perl 失敗：' + b.stderr);
            assert.strictEqual(b.stdout.replace(/\r\n/g, '\n'), a.stdout.replace(/\r\n/g, '\n'), '輸入 ' + JSON.stringify(inp));
        }
    });
    console.log(pass + ' passed, ' + fail + ' failed');
    if (fail) process.exitCode = 1;
})();
