'use strict';
// Ruby 慣用法的「進」（2026-11-12）：手寫 Ruby 的 a.each { |x| … }（區塊迭代）與 "n=#{n}"（字串插值）原本是原生區塊。
// 驗證：手寫 Ruby → 「進」→ IR（原生區塊 0 個）→ 輸出 Python → 實跑，輸出與預期逐字一致；多個區塊參數的 each 仍是原生區塊、保留原文。
// 需要 tree-sitter 的 ruby 文法與 python3，沒有就略過並說明。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const INR = require('./ir_in_ruby_core.js'), PREP = require('./ir_prep_core.js'), OUTPY = require('./ir_out_python_core.js');
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
const which = (exe, args) => { const r = cp.spawnSync(exe, args, { encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? String(r.stdout || '').trim() : null; };
let PY = null; for (const c of ['python3', 'python']) if (which(c, ['-I', '-c', 'import sys; print(sys.version_info[0])']) === '3') { PY = c; break; }
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 12).join('\n   ')); } };

const RB = `# 讀 n 與 n 個整數，印平方和與最大值
def sum_squares(a)
  s = 0
  a.each { |x| s += x * x }
  s
end

def biggest(a)
  a.max
end

n = gets.to_i
nums = gets.split.map(&:to_i)
puts sum_squares(nums)
puts biggest(nums)
puts "n=#{n}"
`;
const RB_PAIR = `pairs = [[1, 2]]
pairs.each { |a, b| puts a + b }
`;

(async () => {
    if (!DIR || !PY) { console.log('略過：' + (!DIR ? '找不到 tree-sitter 快取' : '找不到 python3') + '\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, 'tree-sitter-ruby.wasm')));
    const patterns = INR.buildPatterns((s) => P.parse(s).rootNode);
    const reader = (src) => INR.fromTree(P.parse(src).rootNode, { source: src, patterns });

    t('手寫 Ruby（each 區塊、字串插值）：「進」後原生區塊 0 個，IR 通過驗證', () => {
        const r = reader(RB); assert.strictEqual(r.coverage.natives, 0, JSON.stringify(r.coverage));
        const ops = []; (function w(x) { if (!x || typeof x !== 'object') return; if (x.k === 'foreach') ops.push('foreach'); if (x.k === 'call' && x.op) ops.push(x.op); for (const k of Object.keys(x)) { if (k !== 'pos') { const v = x[k]; if (Array.isArray(v)) v.forEach(w); else if (v && typeof v === 'object') w(v); } } })(r.ir);
        assert.ok(ops.indexOf('foreach') >= 0, '應認出 each 區塊迭代成 foreach：' + ops.join(','));
        assert.ok(ops.indexOf('conv.str') >= 0, '應認出字串插值的 conv.str：' + ops.join(','));
    });

    t('手寫 Ruby → IR → Python 實跑：輸出與預期逐字一致（輸入 3、1 2 3）', () => {
        const r = reader(RB); const py = OUTPY.emit(PREP.prepare(r.ir).ir); assert.ok(!py.diags.some((d) => d.level === 'error'), py.diags.map((d) => d.msg).join(';'));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irb-')); const pf = path.join(dir, 'p.py'); fs.writeFileSync(pf, py.code);
        const out = cp.spawnSync(PY, ['-I', pf], { input: '3\n1 2 3\n', encoding: 'utf8', timeout: 20000 });
        assert.strictEqual(out.status, 0, '實跑失敗：' + out.stderr + '\n' + py.code);
        assert.strictEqual(out.stdout.replace(/\r\n/g, '\n'), '14\n3\nn=3\n', '輸出：' + JSON.stringify(out.stdout) + '\n' + py.code);
    });

    t('多個區塊參數的 each 仍是原生區塊，且保留原文（不亂轉）', () => {
        const r = reader(RB_PAIR); assert.ok(r.coverage.natives >= 1, '應為原生區塊');
        const nats = []; (function w(x) { if (!x || typeof x !== 'object') return; if (x.k === 'native') nats.push(x.src); for (const k of Object.keys(x)) { if (k !== 'pos') { const v = x[k]; if (Array.isArray(v)) v.forEach(w); else if (v && typeof v === 'object') w(v); } } })(r.ir);
        assert.ok(nats.some((s) => /each/.test(s) && /a, b/.test(s)), '原生區塊應保留原文：' + JSON.stringify(nats));
    });

    console.log(pass + ' passed, ' + fail + ' failed');
    if (fail) process.exitCode = 1;
})();
