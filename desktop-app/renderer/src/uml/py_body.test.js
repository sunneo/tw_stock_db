'use strict';
// 用「照脚本回答」的假模型驗證寫 body 的流程（不需要真模型）：補全式一行一行寫、縮排變淺結束區塊、else 接在 if 後面、
// 不合格的行（語法錯誤／名稱未定義）被退回並帶原因、函式寫完；以及受控自然語言（區塊）版本。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const C2U = require('./py_code2uml_core.js'); const PB = require('./py_body_core.js'); const BL = require('./py_blocks_core.js'); const CW = require('./py_cnl_write_core.js'); const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang); const parseTree = (s) => P.parse(s);
    const validate = PB.makeValidator({ parseTree, C2U }); const problem = { statement: '輸入 a b，印出較大的數。' }; let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };
    // 腳本：以「目前已寫了幾行」決定下一句（模型是確定性的：同樣的前文給同樣的續寫）
    const scripted = (table) => async (messages, prefill) => { const body = prefill.split('\n').filter((l) => /^ {4}/.test(l)).length; const hit = table.filter((x) => x.have === body && (!x.err || messages[1].content.includes(x.err))).pop(); return hit ? hit.out : '```'; };
    await t('補全式：一般語句、區塊標頭往下一層、縮排變淺回上層、else 接在 if 後、最後用圍欄結束', async () => {
        const table = [{ have: 0, out: '    a, b = map(int, input().split())' }, { have: 1, out: '    if a > b:' }, { have: 2, out: '        print(a)' }, { have: 3, out: '    else:' }, { have: 4, out: '        print(b)' }, { have: 5, out: '```' }];
        // 縮排變淺的那一步（print(a) 之後輸出 "    else:"）：第一次會 dedent 再問，第二次接受
        const r = await PB.writeBody({ op: { name: 'main', params: [], sig: 'def main():' }, ops: [{ name: 'main', sig: 'def main():' }], problem, complete: scripted(table), validate });
        assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual(r.lines.map((l) => l.d + ':' + l.t), ['0:a, b = map(int, input().split())', '0:if a > b:', '1:print(a)', '0:else:', '1:print(b)']);
    });
    await t('不合格的行被退回並帶原因：語法錯誤、名稱沒定義；改對之後繼續', async () => {
        const table = [{ have: 0, out: '    x = (1 +' }, { have: 0, out: '    x = 1', err: '語法錯誤' }, { have: 1, out: '    print(y)' }, { have: 1, out: '    print(x)', err: '名稱 y' }, { have: 2, out: '```' }];
        const r = await PB.writeBody({ op: { name: 'main', params: [], sig: 'def main():' }, ops: [], problem, complete: scripted(table), validate });
        assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.retries, 2); assert.deepStrictEqual(r.lines.map((l) => l.t), ['x = 1', 'print(x)']);
    });
    await t('永遠寫不出合格的行 → 失敗並說明原因（不會無窮迴圈）；函式內不准再寫 def', async () => {
        const r = await PB.writeBody({ op: { name: 'main', params: [], sig: 'def main():' }, ops: [], problem, complete: async () => '    def main():', validate });
        assert.strictEqual(r.ok, false); assert.ok(/def|簽名/.test(r.reason), r.reason);
    });
    await t('整個程式：設計函式簽名 → 輔助函式先寫 → main 最後 → 組成 UML 模型（含 body）並輸出可執行的 Python', async () => {
        const ask = async () => 'def best(a, b):\ndef main():';
        const outs = { best: ['    return a if a > b else b', '```'], main: ['    a, b = map(int, input().split())', '    print(best(a, b))', '```'] };
        const complete = async (messages, prefill) => { const cur = /def (best|main)\([^)]*\):\n((?: {4}.*\n?)*)$/.exec(prefill); const name = cur[1]; const have = cur[2].split('\n').filter(Boolean).length; return outs[name][have] || '```'; };
        const r = await PB.writeProgram({ problem, ask, complete, validate, parseTree, C2U });
        assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual(r.ops.map((o) => o.name), ['best', 'main']); assert.ok(/def best\(a, b\):/.test(r.source) && /print\(best\(a, b\)\)/.test(r.source));
        assert.strictEqual(r.model.classes[0].ops.length, 2); assert.ok(r.model.classes[0].ops[1].body.length === 2);
        const R = require('../../../judge-runner.js'); const j = await R.judge({ lang: 'python', source: r.source + '\nmain()\n', problem: { id: 'mx', tests: [{ in: '3 9\n', out: '9\n' }, { in: '7 2\n', out: '7\n' }] } }); assert.strictEqual(j.verdict, 'AC', JSON.stringify(j));
    });
    await t('區塊（受控自然語言）版：一行一個區塊、縮排表示子區塊、如果…否則、名稱檢查、轉成 Python 後判題 AC', async () => {
        const B = BL.makeBlocks({ parseTree, C2U });
        const lines = ['讀入一行整數 a, b', '如果 a > b 就：', '  印出 a', '否則：', '  印出 b'];
        const complete = async (messages, prefill) => { const body = prefill.slice(prefill.lastIndexOf('\n區塊：\n') + 5).split('\n').filter(Boolean).length; return lines[body] || '```'; };
        const r = await CW.writeCNLBody({ op: { name: 'main', params: [], sig: 'def main():' }, ops: [], problem, complete, B, namesOf: PB.namesOf, examples: [{ statement: '例', cnl: '印出 1' }], builtins: PB.BUILTINS });
        assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.cnl, lines.join('\n'));
        const model = { name: 'M', classes: [{ name: 'M', kind: 'class', attrs: [], values: [], ops: [{ name: 'main', params: [], returns: { base: 'any', args: [] }, static: true, visibility: '+', body: B.toIR(B.parseCNL(r.cnl).blocks) }] }], relations: [], prelude: [], order: [] }; model.order = [{ t: 'f', o: model.classes[0].ops[0] }];
        const R = require('../../../judge-runner.js'); const j = await R.judge({ lang: 'python', source: C2U.toPython(model) + '\nmain()\n', problem: { id: 'mx', tests: [{ in: '3 9\n', out: '9\n' }, { in: '7 2\n', out: '7\n' }] } }); assert.strictEqual(j.verdict, 'AC', JSON.stringify(j));
        const bad = await CW.writeCNLBody({ op: { name: 'main', params: [], sig: 'def main():' }, ops: [], problem, complete: async () => '印出 zzz', B, namesOf: PB.namesOf, examples: [], builtins: PB.BUILTINS }); assert.strictEqual(bad.ok, false); assert.ok(/zzz/.test(bad.reason), bad.reason);
    });
    console.log('\n' + n + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
