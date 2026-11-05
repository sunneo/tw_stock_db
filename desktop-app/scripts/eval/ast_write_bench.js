'use strict';
// 語法樹寫程式的實機評估：模型逐步在合法節點選單裡選（不開思考），建成樹 → 反解 → 判題器。
//   node scripts/eval/ast_write_bench.js --model-dir D --ort-dir D [--problems a-plus-b,fibonacci|all] [--threads 8] [--deadline-sec 1200] [--out FILE.jsonl]
const fs = require('fs'), path = require('path'), os = require('os');
const REPO = path.join(__dirname, '..', '..'); const AST = path.join(REPO, 'renderer', 'src', 'ast');
const A = require(path.join(AST, 'ast_build_core.js')); const C = require(path.join(AST, 'ast_choose_core.js')); const { makeNativeGenerate } = require('./native_gen_adapter.js'); const R = require(path.join(REPO, 'judge-runner.js'));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
(async () => {
    const probs = fs.readFileSync(path.join(REPO, 'renderer', 'src', 'recipe', 'seed', 'problems.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const want = arg('problems', 'all'); const list = want === 'all' ? probs : want.split(',').map((id) => probs.find((p) => p.id === id)).filter(Boolean);
    const gen = makeNativeGenerate({ modelDir: arg('model-dir'), ortDir: arg('ort-dir'), threads: +arg('threads', 8) });
    const S = A.load(JSON.parse(fs.readFileSync(path.join(AST, 'python.grammar.json'), 'utf8')), { deny: A.ALGO_DENY });
    const out = arg('out', path.join(os.homedir(), '.cache', 'fa-eval', 'runs', 'ast_' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl')); fs.mkdirSync(path.dirname(out), { recursive: true });
    const log = (o) => fs.appendFileSync(out, JSON.stringify(o) + '\n'); let ac = 0; const verbose = process.argv.includes('--verbose');
    for (const p of list) {
        const t0 = Date.now(); const deadline = t0 + +arg('deadline-sec', 1200) * 1000; let root = null; const text = () => (root ? A.unparse(root, S).text : '');
        let plan = ''; try { plan = String(await gen({ messages: [{ role: 'system', content: '你是 Python 程式設計助手，用繁體中文回答。' }, { role: 'user', content: '題目：' + p.statement + '\n請用 3 到 7 行短句寫出解題步驟（每行一步，例如：讀入 n；用迴圈累加；輸出結果）。程式要定義 def main()，從標準輸入讀資料、用 print 輸出。只列步驟，不要寫程式碼。' }], maxTokens: 160, enableThinking: false })).replace(/<think>[\s\S]*?<\/think>/g, '').trim(); } catch (e) { plan = ''; }
        log({ id: p.id, t: 'plan', plan }); if (verbose) process.stderr.write('解法步驟：\n' + plan + '\n');
        const base = C.makeModelDecider({ generate: gen, plan, problem: p, text, trace: (r) => { log(Object.assign({ id: p.id }, r)); if (verbose) process.stderr.write('  ' + (r.t === 'leaf' ? '[葉 ' + r.hole + '] ' + r.value : '[' + r.kind + ' ' + r.hole + '] ' + r.label) + '\n'); } });
        const D = { setRoot: (r) => { root = r; }, enter: () => base.enter(), exit: () => base.exit(), choice: async (q) => { if (Date.now() > deadline) throw new Error('逾時'); return base.choice(q); }, leaf: async (q) => { if (Date.now() > deadline) throw new Error('逾時'); return base.leaf(q); } };
        let verdict = 'BUILD-FAIL', detail = '', src = '';
        try { const tree = await A.build(S, D, { maxDepth: 80 }); src = A.unparse(tree, S).text; const j = await R.judge({ lang: 'python', source: src + '\nmain()\n', problem: p }); verdict = j.verdict; detail = (j.detail || '').slice(0, 160); } catch (e) { detail = String(e.message).slice(0, 160); src = text(); }
        if (verdict === 'AC') ac++; const sec = ((Date.now() - t0) / 1000).toFixed(0);
        log({ id: p.id, t: 'result', verdict, detail, sec: +sec, stats: base.stats, source: src }); console.log(p.id.padEnd(18) + verdict.padEnd(11) + sec + ' 秒  選擇 ' + base.stats.choices + '、葉 ' + base.stats.leaves + '、單選項略過 ' + base.stats.forced + '、答案解析失敗 ' + base.stats.miss + (detail ? '  ' + detail : '')); if (verbose || process.argv.includes('--show')) console.log(src);
    }
    console.log('AC ' + ac + '/' + list.length + '  記錄：' + out);
})().catch((e) => { console.error(e); process.exit(2); });
