'use strict';
// 函式內部再切成步驟：切割規則、簽名接線、步驟級驗證（只重做壞的那一步）、組裝與回退、選擇題退路、門檻縮放；
// 並用真判題器（python）跑三題：1 層／2 層／3 層，和「只切一層」對照。
const assert = require('assert'), path = require('path');
const S = require('./step_split_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
let pass = 0; const t = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; }, (e) => { console.error('FAIL', name, e.message); process.exit(1); });
const mk = (arr) => arr.map(([i, o]) => ({ in: i, out: o }));
const PROBS = {
    l1: { st: '輸入一行整數，由小到大排序後依序輸出。', ex: mk([['3 1 2\n', '1 2 3\n'], ['5 -1 4 0\n', '-1 0 4 5\n']]), hid: mk([['9 8 7 6\n', '6 7 8 9\n'], ['2\n', '2\n']]) },
    l2: { st: '輸入一行整數。去掉負數後，每個數平方，輸出總和。', ex: mk([['1 -2 3\n', '10\n'], ['-5 4 0 2\n', '20\n'], ['-1 -2\n', '0\n']]), hid: mk([['6 -6 1 -1 2\n', '41\n'], ['0\n', '0\n']]) },
    l3: { st: '輸入一行整數。取絕對值、去掉重複、由小到大排序後，依序輸出。', ex: mk([['3 -1 1 -3 2\n', '1 2 3\n'], ['-5 5 -4 4 4\n', '4 5\n'], ['0 0 -2\n', '0 2\n']]), hid: mk([['-9 7 -7 9 1 -1\n', '1 7 9\n'], ['8\n', '8\n']]) },
};
const judgeFor = (p) => async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: { id: 'x', tests: p.ex, hidden: p.hid, checker: 'tokens' } }); return { verdict: j.verdict, detail: j.detail }; };
const stepJ = async ({ source, tests }) => { const j = await J.judge({ lang: 'python', source: source + '\nmain()\n', problem: { id: 's', tests, hidden: [], checker: 'tokens' } }); return { verdict: j.verdict, detail: j.detail }; };
(async () => {
    await t('門檻跟 contextWindowTokens 成比例', () => { const a = S.budgetFor(2048), b = S.budgetFor(8192), c = S.budgetFor(32768); assert.ok(a.maxDepth <= b.maxDepth && b.maxDepth <= c.maxDepth); assert.ok(a.maxAttempts < b.maxAttempts && b.maxAttempts < c.maxAttempts); assert.ok(a.maxChoices <= b.maxChoices); assert.ok(a.maxSpecChars < c.maxSpecChars); assert.strictEqual(S.budgetFor(8192).maxAttempts, 8192 * 40); });
    await t('切割規則：解開不切、積木不切、到頂不切、其餘縮小範圍', () => {
        const B = S.budgetFor(4096), base = { level: 1, solved: false, atomic: false, attempts: 0, budget: B, specChars: 30, multi: 0 };
        assert.strictEqual(S.shouldSplit(Object.assign({}, base, { solved: true })).split, false); assert.strictEqual(S.shouldSplit(Object.assign({}, base, { atomic: true })).split, false);
        assert.strictEqual(S.shouldSplit(Object.assign({}, base, { level: B.maxDepth })).split, false); assert.strictEqual(S.shouldSplit(Object.assign({}, base, { attempts: B.maxAttempts })).split, false);
        assert.match(S.shouldSplit(Object.assign({}, base, { specChars: B.maxSpecChars + 1 })).reason, /too_long/); assert.match(S.shouldSplit(Object.assign({}, base, { multi: 3 })).reason, /multi_sub/); assert.match(S.shouldSplit(base).reason, /judge_failed/);
    });
    await t('簽名接線：對得起來／對不起來', () => {
        assert.ok(S.wire(['abs', 'dedup', 'sort-asc', 'list']).ok);
        const bad = S.wire(['sum', 'sort-asc']); assert.ok(!bad.ok && bad.errors.some((e) => /sort-asc/.test(e)), JSON.stringify(bad));
        assert.ok(!S.wire(['abs', 'square']).ok, '少歸約'); assert.ok(!S.wire(['nope', 'sum']).ok);
    });
    await t('範例解析', () => { assert.deepStrictEqual(S.parseExample('3 1 2\n'), { mode: 'plain', list: [3, 1, 2] }); assert.strictEqual(S.parseExample('3\n1 2 3\n').mode, 'header'); assert.strictEqual(S.parseExample('a b\n'), null); assert.strictEqual(S.parseExample('1 2\n3 4\n5 6\n'), null); });
    await t('選擇題：模型亂答／丟錯退回關鍵字；合法字母排到前面', async () => {
        const st = '去掉負數後平方'; const n = S.budgetFor(4096).maxChoices; assert.ok(S.letterChoices(S.TRANSFORMS, n).length <= n);
        assert.strictEqual((await S.askPriors({ statement: st })).by, 'keyword'); assert.strictEqual((await S.askPriors({ statement: st, pick: async () => '我覺得是 Z！' })).by, 'keyword'); assert.strictEqual((await S.askPriors({ statement: st, pick: async () => { throw new Error('x'); } })).by, 'keyword');
        const ok = await S.askPriors({ statement: st, pick: async (q, ls) => { assert.ok(ls.length >= 2); return 'B, B'; }, maxChoices: 6 }); assert.strictEqual(ok.by, 'pick'); assert.strictEqual(ok.ids.length, S.TRANSFORMS.length); assert.strictEqual(new Set(ok.ids).size, ok.ids.length);
    });
    const res = {};
    for (const k of ['l1', 'l2', 'l3']) {
        const p = PROBS[k];
        await t(k + '：切到對的層、整體過判題、一層對照', async () => {
            const full = await S.solve({ statement: p.st, examples: p.ex, judge: judgeFor(p), stepJudge: stepJ, ctxTokens: 8192 }); const one = await S.solve({ statement: p.st, examples: p.ex, judge: judgeFor(p), stepJudge: stepJ, ctxTokens: 8192, maxDepth: 1 });
            res[k] = { full, one }; assert.ok(full.ok && full.verdict === 'AC' && full.stepChecked, k + JSON.stringify(full.perLevel)); assert.strictEqual(full.level, { l1: 1, l2: 2, l3: 3 }[k]); assert.ok(/def solve/.test(full.source) && /def main/.test(full.source));
            assert.strictEqual(one.ok, k === 'l1', k + ' 只切一層：' + one.ok);
            console.log(k, '全深度 level=' + full.level, 'tried=' + full.tried, full.ms + 'ms', '| 一層 ok=' + one.ok, 'tried=' + one.tried, one.ms + 'ms', full.chain.join('>') + '|' + full.reducer);
        });
    }
    await t('不切過頭：l1 淺層解開就停；l3 的樹有子步驟', () => {
        assert.strictEqual(res.l1.full.perLevel.length, 1); assert.deepStrictEqual(res.l1.full.chain, ['sort-asc']);
        const kids = res.l3.full.tree.children[0]; assert.strictEqual(kids.kind, 'composite'); assert.ok(kids.children.length === 2 && kids.children[0].kind === 'composite', JSON.stringify(res.l3.full.tree)); assert.ok(res.l3.full.depth >= 3);
    });
    await t('步驟級驗證：某一步沙盒結果不符→只換掉那條候選，記 redone，不整個重來', async () => {
        const p = PROBS.l2; let bad = 0; const sj = async (a) => { if (a.step === 'square' && bad++ < 1) return { verdict: 'WA', detail: '假的壞積木' }; return stepJ(a); };
        const r = await S.solve({ statement: p.st, examples: p.ex, judge: judgeFor(p), stepJudge: sj, ctxTokens: 8192 }); assert.ok(r.redone.some((x) => x.step === 'square'), JSON.stringify(r.redone)); assert.ok(r.ok, r.reason);
    });
    await t('組裝後整體失敗→回退：不說成通過，回報 fallback（最淺的範例過關者）', async () => {
        const p = PROBS.l2; const r = await S.solve({ statement: p.st, examples: p.ex, judge: async () => ({ verdict: 'WA', detail: '隱藏測資不過' }), stepJudge: stepJ, ctxTokens: 8192 });
        assert.strictEqual(r.ok, false); assert.ok(r.fallback && r.fallback.verdict === 'WA' && r.fallback.level >= 1); assert.ok(/沒有通過整體判題/.test(r.reason));
    });
    await t('切過頭的反例：深層湊出的做法被整體判題拒絕，淺層答案是回退點', async () => {
        const p = PROBS.l2; const j = async (src) => (/def transform_1/.test(src) ? { verdict: 'WA', detail: '深層過擬合' } : judgeFor(p)(src)); const r = await S.solve({ statement: p.st, examples: p.ex, judge: j, ctxTokens: 8192, maxDepth: 3 });
        assert.strictEqual(r.ok, false); assert.ok(r.fallback, '要有回退點');
    });
    await t('範例解析不了／沒有範例／預算用完要明確失敗', async () => {
        assert.strictEqual((await S.solve({ statement: 'x', examples: [], judge: async () => ({}) })).ok, false); assert.strictEqual((await S.solve({ statement: 'x', examples: mk([['a b\n', '1\n']]), judge: async () => ({}) })).ok, false);
        const r = await S.solve({ statement: PROBS.l3.st, examples: PROBS.l3.ex, judge: judgeFor(PROBS.l3), budget: { maxAttempts: 30 }, ctxTokens: 8192 }); assert.strictEqual(r.ok, false);
    });
    await t('小視窗：深度壓在 2 層，3 層題誠實失敗', async () => { const r = await S.solve({ statement: PROBS.l3.st, examples: PROBS.l3.ex, judge: judgeFor(PROBS.l3), ctxTokens: 2048 }); assert.strictEqual(r.ok, false); assert.ok(r.perLevel.length <= 2); });
    console.log(pass + ' passed, 0 failed'); process.exit(0);
})();
