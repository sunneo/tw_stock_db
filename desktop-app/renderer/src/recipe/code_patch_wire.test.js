'use strict';
// merge diff patcher 接進產品：runCode(source+patch+parser) 會用到語法樹（docstring 內的同樣文字不被改）；floating-assistant.js 真的有把剖析器和 patch 傳進去。
const assert = require('assert'), cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const Agent = require('./code_agent_core.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const hasPy = cp.spawnSync('python', ['-c', '1']).status === 0;
const tmpf = path.join(os.tmpdir(), 'fa-patchwire-' + process.pid + '.py');
const check = async ({ source }) => { if (!hasPy) return { ok: true, verdict: 'AC' }; fs.writeFileSync(tmpf, source, 'utf8'); const r = cp.spawnSync('python', ['-I', '-c', 'import sys;compile(open(sys.argv[1],encoding="utf8").read(),"x","exec")', tmpf], { encoding: 'utf8' }); return { ok: r.status === 0, verdict: r.status === 0 ? 'AC' : 'CE', detail: r.stderr }; };
(async () => {
    const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
    ok(/async _codePatchParser\(\)/.test(fa), '宿主有 _codePatchParser');
    ok(/const parser = lang === 'python' \? await this\._codePatchParser\(\)/.test(fa) && /fileName: a\.file_name, parser, check/.test(fa), 'merge_patch 把 parser 傳給 applyPatch');
    ok(/patch: \(source != null && typeof \(a\.patch \|\| a\.diff\)/.test(fa) && /parser: \(source != null && \(a\.patch \|\| a\.diff\)/.test(fa), '_codeAgent 把 patch 與 parser 傳給 runCode');
    ok(/onEvent: a\.onEvent, patch: a\.patch, patchFile: a\.patchFile, parser: a\.parser/.test(fa), '嵌入的 runCode0 把 patch／parser 傳給 editCode');
    const TSDIR = path.join(__dirname, '..', '..', 'vendor', 'tree-sitter'); let parser = null;
    if (fs.existsSync(path.join(TSDIR, 'tree-sitter-python.wasm'))) {
        const Parser = require(path.join(TSDIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(TSDIR, 'tree-sitter.wasm') });
        const lang = await Parser.Language.load(path.join(TSDIR, 'tree-sitter-python.wasm')); parser = new Parser(); parser.setLanguage(lang);
    }
    const SRC = 'def f(x):\n    """範例：\n    return x\n    """\n    return x\n';
    const DIFF = '--- a/m.py\n+++ b/m.py\n@@ -3,3 +3,3 @@\n     """\n-    return x\n+    return x + 1\n';
    const run = (p) => Agent.runCode({ text: '套用修補', lang: 'python', source: SRC, patch: DIFF, parser: p, check, judge: undefined, backend: undefined });
    if (parser && hasPy) {
        const r = await run(parser);
        ok(r && r.source.includes('return x + 1'), '有剖析器：修補套用了');
        ok(r.source.includes('    return x\n    """') , '有剖析器：docstring 裡的範例沒被改');
        ok(r.patch && r.patch.ok, '結果帶 patch 資訊');
    }
    console.log('code_patch_wire.test.js（python ' + (hasPy ? '有' : '沒有') + '、語法樹 ' + (parser ? '有' : '沒有') + '）：' + n + ' passed, 0 failed');
})().catch((e) => { console.error(e); process.exit(1); });
