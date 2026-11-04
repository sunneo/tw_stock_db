// CoLU+Thinking 階段 4 測試：反思（coluThinkReflect／coluThinkRevise／coluThinkBudget）。假模型，不載入任何真模型。
// 用法：node renderer/src/recipe/think_reflect.test.js
const R = require('./recipe_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info))); } }

// 假的 generate：依序回傳 queue 的項目；項目可以是字串，或 { throw: '訊息' }，或 { hang: true }（永遠不回）。每次呼叫的參數都記在 calls 裡。
function fakeGen(queue) {
    const calls = []; let i = 0;
    const generate = async (req) => {
        calls.push(req); const item = queue[Math.min(i, queue.length - 1)]; i++;
        if (item && typeof item === 'object' && item.throw) throw new Error(item.throw);
        if (item && typeof item === 'object' && item.hang) return new Promise(() => {});
        return item;
    };
    return { generate, calls };
}
const Q = 'qwen3-0.6b';
const GAP = '{"gap":true,"note":"缺少付款步驟"}';
const NOGAP = '{"gap":false,"note":""}';
const base = (extra) => Object.assign({ modelId: Q, contextTokens: 4096, enabled: true, question: '計畫：A→B' }, extra);

(async () => {
    // ---- coluThinkReflect：單次反思 ----
    let g = fakeGen(['<think>檢查一下流程</think>' + NOGAP]);
    let r = await R.coluThinkReflect(base({ generate: g.generate }));
    check('1 no gap → gap false, ok', r.gap === false && r.ok === true && r.note === '', r);
    check('1b reasoning is captured for progress only', r.reasoning === '檢查一下流程', r.reasoning);

    g = fakeGen([GAP]);
    r = await R.coluThinkReflect(base({ generate: g.generate }));
    check('2 gap with note', r.gap === true && r.note === '缺少付款步驟', r);

    g = fakeGen(['not json at all', 'still not json']);
    r = await R.coluThinkReflect(base({ generate: g.generate }));
    check('3 parse failure twice → treated as no gap', r.gap === false && r.ok === false, r);

    g = fakeGen(['{"gap":true,"note":""}', '{"gap":true,"note":"  "}']);
    r = await R.coluThinkReflect(base({ generate: g.generate }));
    check('4 gap true without note fails validation → no gap', r.gap === false && r.ok === false, r);

    g = fakeGen([{ hang: true }]);
    r = await R.coluThinkReflect(base({ generate: g.generate, timeoutMs: 30 }));
    check('5 timeout → no gap with 逾時', r.gap === false && r.error === '逾時', r);

    g = fakeGen([{ throw: 'worker 壞掉' }]);
    r = await R.coluThinkReflect(base({ generate: g.generate }));
    check('6 generate throws → no gap, no exception', r.gap === false && r.ok === false, r);

    g = fakeGen([GAP]);
    r = await R.coluThinkReflect(base({ generate: g.generate, modelId: 'qwen3-1.7b' }));
    check('7 other model is skipped and generate not called', r.skipped === true && g.calls.length === 0, r);

    g = fakeGen([GAP]);
    r = await R.coluThinkReflect(base({ generate: g.generate, enabled: false }));
    check('8 switch off → skipped, generate not called', r.skipped === true && g.calls.length === 0, r);

    g = fakeGen(['<think>SECRET 推理</think>not json', NOGAP]);
    r = await R.coluThinkReflect(base({ generate: g.generate }));
    const retryText = JSON.stringify(g.calls[1] && g.calls[1].messages || []);
    check('9 reasoning never goes back into messages', g.calls.length === 2 && retryText.indexOf('SECRET') < 0, retryText.slice(0, 200));

    g = fakeGen([NOGAP]);
    await R.coluThinkReflect(base({ generate: g.generate }));
    check('10 reflect budget: maxTokens 307 at 4096 ctx, thinking on', g.calls[0].enableThinking === true && g.calls[0].maxTokens === 307 && g.calls[0].timeoutMs === 15000, g.calls[0]);

    // ---- coluThinkBudget ----
    const b0 = R.coluThinkBudget();
    check('11 default budget: 2 total, 1 per question', b0.max === 2 && b0.perQMax === 1 && b0.total === 0, b0);

    // ---- coluThinkRevise：答案層（secondCheck 關）----
    const origA = { v: 'orig' };
    g = fakeGen([NOGAP]);
    let budget = R.coluThinkBudget();
    let rv = await R.coluThinkRevise({ qid: 'ans:members:Cart', budget, generate: g.generate, modelId: Q, contextTokens: 4096, enabled: true, original: origA, describe: () => '答案沒過', redo: async () => { throw new Error('不該重做'); } });
    check('12 answer no gap → original kept, no redo', rv.value === origA && rv.redone === false && rv.reflected === 1 && rv.fallback === false, rv);

    g = fakeGen([GAP]);
    const notes = []; budget = R.coluThinkBudget();
    rv = await R.coluThinkRevise({ qid: 'ans:members:Cart', budget, generate: g.generate, modelId: Q, contextTokens: 4096, enabled: true, original: origA, describe: () => '答案沒過', redo: async (note) => { notes.push(note); return { v: 'redone' }; } });
    check('13 answer gap → redo once with note, redo value used', rv.redone === true && rv.value.v === 'redone' && notes.length === 1 && notes[0] === '缺少付款步驟', rv);

    g = fakeGen([GAP]);
    budget = R.coluThinkBudget(); let redoCount = 0;
    rv = await R.coluThinkRevise({ qid: 'ans:members:Cart', budget, generate: g.generate, modelId: Q, contextTokens: 4096, enabled: true, original: origA, describe: () => '答案沒過', redo: async () => { redoCount++; return null; } });
    check('14 redo fails → original (program default) used, fallback', rv.value === origA && rv.fallback === true && redoCount === 1, rv);

    g = fakeGen([GAP, GAP]);
    budget = R.coluThinkBudget();
    const first = await R.coluThinkRevise({ qid: 'ans:classes:', budget, generate: g.generate, modelId: Q, contextTokens: 4096, enabled: true, original: origA, describe: () => 'x', redo: async () => ({ v: 'r1' }) });
    const second = await R.coluThinkRevise({ qid: 'ans:classes:', budget, generate: g.generate, modelId: Q, contextTokens: 4096, enabled: true, original: origA, describe: () => 'x', redo: async () => ({ v: 'r2' }) });
    check('15 per-question cap: second reflection on same question falls back without calling generate', first.redone === true && second.fallback === true && second.reflected === 0 && g.calls.length === 1, { first, second, calls: g.calls.length });

    g = fakeGen([GAP]);
    budget = R.coluThinkBudget({ max: 0 });
    rv = await R.coluThinkRevise({ qid: 'ans:x:', budget, generate: g.generate, modelId: Q, contextTokens: 4096, enabled: true, original: origA, describe: () => 'x', redo: async () => ({ v: 'r' }) });
    check('16 total cap reached → fallback, no generate', rv.value === origA && rv.fallback === true && g.calls.length === 0, rv);

    // ---- coluThinkRevise：計畫層（secondCheck 開）----
    g = fakeGen([GAP, GAP]);
    budget = R.coluThinkBudget(); const planRedo = []; const origP = { plan: 'orig' };
    rv = await R.coluThinkRevise({ qid: 'plan', budget, generate: g.generate, modelId: Q, contextTokens: 4096, enabled: true, original: origP, describe: (x) => JSON.stringify(x), secondCheck: true, redo: async (note) => { planRedo.push(note); return { plan: 'redo' }; } });
    check('17 plan gap twice → redo once, then original plan used', rv.value === origP && rv.fallback === true && planRedo.length === 1 && rv.reflected === 2 && g.calls.length === 2, rv);

    g = fakeGen([GAP, NOGAP]);
    budget = R.coluThinkBudget();
    rv = await R.coluThinkRevise({ qid: 'plan', budget, generate: g.generate, modelId: Q, contextTokens: 4096, enabled: true, original: origP, describe: (x) => JSON.stringify(x), secondCheck: true, redo: async () => ({ plan: 'redo' }) });
    check('18 plan gap then clean after redo → redo plan used', rv.value.plan === 'redo' && rv.redone === true && rv.reflected === 2 && rv.fallback === false, rv);

    g = fakeGen([NOGAP]);
    budget = R.coluThinkBudget();
    rv = await R.coluThinkRevise({ qid: 'plan', budget, generate: g.generate, modelId: Q, contextTokens: 4096, enabled: true, original: origP, describe: () => 'p', secondCheck: true, redo: async () => { throw new Error('no'); } });
    check('19 plan no gap → original, one reflection', rv.value === origP && rv.reflected === 1 && rv.gap === false && g.calls.length === 1 && budget.total === 1, rv);

    // ---- 退路與開關 ----
    g = fakeGen([GAP]); budget = R.coluThinkBudget();
    rv = await R.coluThinkRevise({ qid: 'plan', budget, generate: g.generate, modelId: 'qwen3-1.7b', contextTokens: 4096, enabled: true, original: origP, describe: () => 'p', secondCheck: true, redo: async () => ({ plan: 'redo' }) });
    check('20 other model: no reflection, no budget used, original kept', rv.value === origP && g.calls.length === 0 && budget.total === 0 && rv.reflected === 0, rv);

    g = fakeGen([GAP]); budget = R.coluThinkBudget();
    rv = await R.coluThinkRevise({ qid: 'plan', budget, generate: g.generate, modelId: Q, contextTokens: 4096, enabled: false, original: origP, describe: () => 'p', secondCheck: true, redo: async () => ({ plan: 'redo' }) });
    check('21 switch off: no call, no budget used', rv.value === origP && g.calls.length === 0 && budget.total === 0, rv);

    g = fakeGen([{ throw: '壞掉' }]); budget = R.coluThinkBudget();
    rv = await R.coluThinkRevise({ qid: 'plan', budget, generate: g.generate, modelId: Q, contextTokens: 4096, enabled: true, original: origP, describe: () => 'p', secondCheck: true, redo: async () => ({ plan: 'redo' }) });
    check('22 reflect throws → treated as no gap, original kept, unsure flag', rv.value === origP && rv.gap === false && rv.unsure === true, rv);

    // 不認得的模型或缺 generate：不拋例外
    r = await R.coluThinkReflect({ modelId: Q, contextTokens: 4096, enabled: true, question: 'x' });
    check('23 missing generate → skipped, no exception', r.skipped === true && r.gap === false, r);

    console.log(ok + ' passed, ' + bad.length + ' failed' + (bad.length ? ': ' + bad.join(', ') : ''));
    if (bad.length) process.exitCode = 1;
})();
