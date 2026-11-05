'use strict';
// 把種子題的參考解答用真 tree-sitter 解析 → 神諭照著回答建樹器 → 反解成原始碼 → 結構相同、判題器 AC。
const fs = require('fs'), path = require('path'), os = require('os');
const A = require('./ast_build_core.js'); const O = require('./ast_replay_core.js'); const S = A.load(require('./python.grammar.json'), { deny: ['print_statement', 'exec_statement', 'future_import_statement', 'type_alias_statement', 'match_statement'] });
const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
const sx = (t) => (t.type === 'parenthesized_list_splat' ? 'parenthesized_expression' : t.type) + (t.kids.length ? '(' + t.kids.map(sx).join(' ') + ')' : '');
function conv(n) { const kids = []; if (n.type === 'string') return { type: 'string', kids }; for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c.type === 'comment') continue; kids.push(conv(c)); } return { type: n.type, kids }; }
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR + '（tree-sitter 快取）'); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const R = require('../../../judge-runner.js'); const probs = fs.readFileSync(path.join(__dirname, '..', 'recipe', 'seed', 'problems.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let built = 0, same = 0, ac = 0; const fails = [];
    for (const p of probs) {
        const src = p.ref.python; const t = P.parse(src);
        try {
            const root = await A.build(S, O.makeOracle(t.rootNode, src)); built++;
            const { text, tree } = A.unparse(root, S); const t2 = P.parse(text);
            const eq = sx(tree) === sx(conv(t2.rootNode)) && !t2.rootNode.hasError(); if (eq) same++;
            const j = await R.judge({ lang: 'python', source: text + '\nmain()\n', problem: p }); if (j.verdict === 'AC') ac++; else fails.push(p.id + ' ' + j.verdict + ' ' + (j.detail || ''));
            if (!eq) fails.push(p.id + ' 結構不同');
            if (process.argv[2] === 'show' && p === probs[0]) console.log(text);
        } catch (e) { fails.push(p.id + ' 建樹失敗：' + String(e.message).slice(0, 160)); }
    }
    console.log('種子題 ' + probs.length + '：建成 ' + built + '、結構一致 ' + same + '、判題 AC ' + ac); fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(ac === probs.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
