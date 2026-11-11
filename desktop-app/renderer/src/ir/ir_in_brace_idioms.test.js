'use strict';
// nodejs 慣用法的「進」（2026-11-12）：模板字串 `n=${n}`、單引號的 require('fs').readFileSync(0, 'utf8')（目錄樣板是雙引號）原本是原生區塊。
// 驗證：手寫 JavaScript（不需要標準輸入）→「進」→ IR（原生區塊 0 個）→ 輸出 Python → 實跑，輸出與預期逐字一致；
// 標籤模板 html`…` 仍是原生區塊（保留原文）。需要 tree-sitter 的 javascript 文法與 python3，沒有就略過。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const INB = require('./ir_in_brace_core.js'), PREP = require('./ir_prep_core.js'), OUTPY = require('./ir_out_python_core.js');
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
const which = (exe, args) => { const r = cp.spawnSync(exe, args, { encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? String(r.stdout || '').trim() : null; };
let PY = null; for (const c of ['python3', 'python']) if (which(c, ['-I', '-c', 'import sys; print(sys.version_info[0])']) === '3') { PY = c; break; }
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 12).join('\n   ')); } };

const JS = `const xs = [1, 2, 3];
let s = 0;
for (const x of xs) { s += x * x; }
console.log(\`s=\${s}\`);
console.log("done");
`;
const JS_TAG = 'function html(a) { return a[0]; }\nconst s = 1;\nconsole.log(html\`<b>\${s}</b>\`);\n';

(async () => {
    if (!DIR || !PY) { console.log('略過：' + (!DIR ? '找不到 tree-sitter 快取' : '找不到 python3') + '\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, 'tree-sitter-javascript.wasm')));
    const patterns = INB.buildPatterns('nodejs', (s) => P.parse(s).rootNode);
    const reader = (src) => INB.fromTree(P.parse(src).rootNode, { lang: 'nodejs', source: src, patterns });

    t('手寫 JavaScript（模板字串、for…of、console.log）：「進」後原生區塊 0 個', () => {
        const r = reader(JS); assert.strictEqual(r.coverage.natives, 0, JSON.stringify(r.coverage));
    });

    t('手寫 JavaScript → IR → Python 實跑：輸出與預期逐字一致（s=14、done）', () => {
        const r = reader(JS); const py = OUTPY.emit(PREP.prepare(r.ir).ir); assert.ok(!py.diags.some((d) => d.level === 'error'), py.diags.map((d) => d.msg).join(';'));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibi-')); const pf = path.join(dir, 'p.py'); fs.writeFileSync(pf, py.code);
        const out = cp.spawnSync(PY, ['-I', pf], { encoding: 'utf8', timeout: 20000 });
        assert.strictEqual(out.status, 0, '實跑失敗：' + out.stderr + '\n' + py.code);
        assert.strictEqual(out.stdout.replace(/\r\n/g, '\n'), 's=14\ndone\n', '輸出：' + JSON.stringify(out.stdout) + '\n' + py.code);
    });

    t('標籤模板 html`…` 仍是原生區塊，且保留原文', () => {
        const r = reader(JS_TAG); assert.ok(r.coverage.natives >= 1, '標籤模板應為原生區塊');
        const nats = []; (function w(x) { if (!x || typeof x !== 'object') return; if (x.k === 'native') nats.push(x.src); for (const k of Object.keys(x)) { if (k !== 'pos') { const v = x[k]; if (Array.isArray(v)) v.forEach(w); else if (v && typeof v === 'object') w(v); } } })(r.ir);
        assert.ok(nats.some((s) => /html/.test(s)), '原生區塊應保留原文：' + JSON.stringify(nats));
    });

    console.log(pass + ' passed, ' + fail + ' failed');
    if (fail) process.exitCode = 1;
})();
