'use strict';
// C# 慣用法的「進」（2026-11-12）：手寫 C# 常見的 a.Max()（擴充方法）、int.Parse(Console.ReadLine())、$"n={n}"（內插字串）原本是原生區塊。
// 驗證：手寫 C# → 「進」→ IR（原生區塊 0 個）→ 輸出 Python → 實跑，輸出與預期逐字一致；另檢查格式子句的內插仍是原生區塊（不丟原文）。
// 需要 tree-sitter 的 c_sharp 文法與 python3，沒有就略過並說明。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const INT = require('./ir_in_typed_core.js'), PREP = require('./ir_prep_core.js'), OUTPY = require('./ir_out_python_core.js');
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
const which = (exe, args) => { const r = cp.spawnSync(exe, args, { encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? String(r.stdout || '').trim() : null; };
let PY = null; for (const c of ['python3', 'python']) if (which(c, ['-I', '-c', 'import sys; print(sys.version_info[0])']) === '3') { PY = c; break; }
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 12).join('\n   ')); } };

const CS = `using System;
using System.Collections.Generic;
using System.Linq;

class Program {
    static long Biggest(List<long> a) {
        return a.Max();
    }
    static void Main() {
        int n = int.Parse(Console.ReadLine());
        Console.WriteLine($"n={n}");
        Console.WriteLine(Biggest(new List<long> { n, 3 }));
    }
}
`;
const CS_FMT = `using System;
class Program {
    static void Main() {
        int n = 3;
        Console.WriteLine($"v={n:F2}");
    }
}
`;

(async () => {
    if (!DIR || !PY) { console.log('略過：' + (!DIR ? '找不到 tree-sitter 快取' : '找不到 python3') + '\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, 'tree-sitter-c_sharp.wasm')));
    const pats = INT.buildPatterns('cs', (s) => P.parse(s).rootNode);
    const reader = (src) => INT.fromTree(P.parse(src).rootNode, { lang: 'cs', source: src, patterns: pats });

    t('手寫 C#（a.Max、int.Parse、$"n={n}"）：「進」後原生區塊 0 個，IR 通過驗證', () => {
        const r = reader(CS); assert.strictEqual(r.coverage.natives, 0, JSON.stringify(r.coverage));
        const ops = []; (function w(x) { if (!x || typeof x !== 'object') return; if (x.k === 'call' && x.op) ops.push(x.op); for (const k of Object.keys(x)) { if (k !== 'pos') { const v = x[k]; if (Array.isArray(v)) v.forEach(w); else if (v && typeof v === 'object') w(v); } } })(r.ir);
        assert.ok(ops.indexOf('list.max') >= 0, '應認出 list.max：' + ops.join(','));
        assert.ok(ops.indexOf('conv.int') >= 0, '應認出 conv.int（int.Parse）：' + ops.join(','));
        assert.ok(ops.indexOf('conv.str') >= 0, '應認出 conv.str（內插字串）：' + ops.join(','));
    });

    t('手寫 C# → IR → Python 實跑：輸出與預期逐字一致（輸入 7）', () => {
        const r = reader(CS); const py = OUTPY.emit(PREP.prepare(r.ir).ir); assert.ok(!py.diags.some((d) => d.level === 'error'), py.diags.map((d) => d.msg).join(';'));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ics-')); const pf = path.join(dir, 'p.py'); fs.writeFileSync(pf, py.code + '\nMain()\n'); // C# 的 Main 是程式進入點，輸出器不會自動呼叫，測試補上
        const out = cp.spawnSync(PY, ['-I', pf], { input: '7\n', encoding: 'utf8', timeout: 20000 });
        assert.strictEqual(out.status, 0, '實跑失敗：' + out.stderr + '\n' + py.code);
        assert.strictEqual(out.stdout.replace(/\r\n/g, '\n'), 'n=7\n7\n', '輸出：' + JSON.stringify(out.stdout) + '\n' + py.code);
    });

    t('內插字串的格式子句（:F2）仍是原生區塊，且保留原文', () => {
        const r = reader(CS_FMT); assert.ok(r.coverage.natives >= 1, '格式子句應該是原生區塊');
        const nats = []; (function w(x) { if (!x || typeof x !== 'object') return; if (x.k === 'native') nats.push(x.src); for (const k of Object.keys(x)) { if (k !== 'pos') { const v = x[k]; if (Array.isArray(v)) v.forEach(w); else if (v && typeof v === 'object') w(v); } } })(r.ir);
        assert.ok(nats.some((s) => /F2/.test(s)), '原生區塊應保留 F2 原文：' + JSON.stringify(nats));
    });

    console.log(pass + ' passed, ' + fail + ' failed');
    if (fail) process.exitCode = 1;
})();
