'use strict';
// Perl 慣用法的「進」（2026-11-12）：foreach my $x (@$a)（@$name 寫法）、語句修飾 EXPR if COND;、"…$name\n" 字串插值、print X, "\n" 與 print "…\n"、\@name 參考，原本是原生區塊。
// 驗證：手寫 Perl（只用這些慣用法，不需要標準輸入）→「進」→ IR（原生區塊 0 個）→ 輸出 Python → 實跑，輸出與預期逐字一致；
// 另檢查 unless 修飾語句、<STDIN> 仍是原生區塊（保留原文，不丟）。Perl 的「進」是自寫的子集剖析器，不需要文法；需要 python3。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const INP = require('./ir_in_perl_core.js'), PREP = require('./ir_prep_core.js'), OUTPY = require('./ir_out_python_core.js');
const which = (exe, args) => { const r = cp.spawnSync(exe, args, { encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? String(r.stdout || '').trim() : null; };
let PY = null; for (const c of ['python3', 'python']) if (which(c, ['-I', '-c', 'import sys; print(sys.version_info[0])']) === '3') { PY = c; break; }
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 12).join('\n   ')); } };

const PL = `use strict;
use warnings;
my @nums = (1, 2, 3);
my $s = 0;
foreach my $x (@nums) { $s += $x * $x; }
print "s=$s\\n";
print $s, "\\n";
my $m = 0;
foreach my $y (@nums) { $m = $y if $y > $m; }
print "m=$m\\n";
`;
const PL_UNLESS = `my $x = 1;
print "a\\n" unless $x;
`;
const PL_STDIN = `my $n = <STDIN>;
print "n=$n";
`;

(async () => {
    if (!PY) { console.log('略過：找不到 python3\n0 passed, 0 failed'); return; }
    t('手寫 Perl（@$a 迴圈、if 修飾、字串插值、print X, "\\n"）：「進」後原生區塊 0 個', () => {
        const r = INP.fromSource(PL, { patterns: INP.buildPatterns(), name: 'idioms' }); assert.strictEqual(r.coverage.natives, 0, JSON.stringify(r.coverage));
        const kinds = []; (function w(x) { if (!x || typeof x !== 'object') return; if (x.k === 'foreach' || x.k === 'if') kinds.push(x.k); if (x.k === 'call' && x.op) kinds.push(x.op); for (const k of Object.keys(x)) { if (k !== 'pos') { const v = x[k]; if (Array.isArray(v)) v.forEach(w); else if (v && typeof v === 'object') w(v); } } })(r.ir);
        assert.ok(kinds.indexOf('foreach') >= 0 && kinds.indexOf('if') >= 0 && kinds.indexOf('io.print_line') >= 0 && kinds.indexOf('conv.str') >= 0, kinds.join(','));
    });

    t('手寫 Perl → IR → Python 實跑：輸出與預期逐字一致（s=14、14、m=3）', () => {
        const r = INP.fromSource(PL, { patterns: INP.buildPatterns(), name: 'idioms' }); const py = OUTPY.emit(PREP.prepare(r.ir).ir);
        assert.ok(!py.diags.some((d) => d.level === 'error'), py.diags.map((d) => d.msg).join(';'));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipli-')); const pf = path.join(dir, 'p.py'); fs.writeFileSync(pf, py.code);
        const out = cp.spawnSync(PY, ['-I', pf], { encoding: 'utf8', timeout: 20000 });
        assert.strictEqual(out.status, 0, '實跑失敗：' + out.stderr + '\n' + py.code);
        assert.strictEqual(out.stdout.replace(/\r\n/g, '\n'), 's=14\n14\nm=3\n', '輸出：' + JSON.stringify(out.stdout) + '\n' + py.code);
    });

    t('unless 修飾語句仍是原生區塊；<STDIN> 仍是原生區塊（它保留換行，io.read_line 會去掉，不能直接對應）', () => {
        const u = INP.fromSource(PL_UNLESS, { patterns: INP.buildPatterns(), name: 'u' }); assert.ok(u.coverage.natives >= 1, 'unless 應為原生區塊');
        const s2 = INP.fromSource(PL_STDIN, { patterns: INP.buildPatterns(), name: 's' }); assert.ok(s2.coverage.natives >= 1, '<STDIN> 應為原生區塊');
        const nats = []; (function w(x) { if (!x || typeof x !== 'object') return; if (x.k === 'native') nats.push(x.src); for (const k of Object.keys(x)) { if (k !== 'pos') { const v = x[k]; if (Array.isArray(v)) v.forEach(w); else if (v && typeof v === 'object') w(v); } } })(s2.ir);
        assert.ok(nats.some((x) => /STDIN/.test(x)), '原生區塊應保留 <STDIN> 原文：' + JSON.stringify(nats));
    });

    console.log(pass + ' passed, ' + fail + ' failed');
    if (fail) process.exitCode = 1;
})();
