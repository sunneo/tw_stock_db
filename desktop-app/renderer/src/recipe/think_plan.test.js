// CoLU+Thinking 階段 2 測試：thinkingPlan 與 jsonStep 的 thinking 參數／退路。假模型，不載入任何真模型。
// 用法：node renderer/src/recipe/think_plan.test.js
const R = require('./recipe_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info))); } }

// 假的 generate：依序回傳 queue 的項目；項目可以是字串，或 { throw: '訊息' }。每次呼叫的參數都記在 calls 裡。
function fakeGen(queue) {
    const calls = []; let i = 0;
    const generate = async (req) => {
        calls.push(req); const item = queue[Math.min(i, queue.length - 1)]; i++;
        if (item && typeof item === 'object' && item.throw) throw new Error(item.throw);
        return item;
    };
    return { generate, calls };
}
const VALID = (o) => (o.choice === 1 ? [] : ['bad']);
const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
const TH = { enabled: true, maxTokens: 1600, timeoutMs: 30000 };

(async () => {
    // ---- thinkingPlan：模型與階段 ----
    const p = R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'plan', contextTokens: 4096 });
    check('plan qwen3-0.6b on', p.enabled === true, p);
    check('plan timeout 30000', p.timeoutMs === 30000, p);
    check('plan budget 4096 ctx => 1638 (proportional, inside clamp)', p.maxTokens === 1638, p);
    const r1 = R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'reflect', contextTokens: 4096 });
    check('reflect qwen3-0.6b on', r1.enabled === true && r1.timeoutMs === 15000, r1);
    check('reflect budget 4096 ctx => 307', r1.maxTokens === 307, r1);
    check('route off for qwen3-0.6b', R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'route', contextTokens: 4096 }).enabled === false);
    check('fill off for qwen3-0.6b', R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'fill', contextTokens: 4096 }).enabled === false);
    check('other model qwen3-1.7b off', R.thinkingPlan({ modelId: 'qwen3-1.7b', stage: 'plan', contextTokens: 8192 }).enabled === false);
    check('other model qwen2.5-0.5b off', R.thinkingPlan({ modelId: 'qwen2.5-0.5b', stage: 'plan', contextTokens: 8192 }).enabled === false);
    check('missing model off', R.thinkingPlan({ stage: 'plan', contextTokens: 4096 }).enabled === false);
    check('unknown stage off', R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'chat', contextTokens: 4096 }).enabled === false);

    // ---- thinkingPlan：開關與退化 ----
    check('enabled false turns plan off', R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'plan', contextTokens: 4096, enabled: false }).enabled === false);
    check('enabled omitted means on', R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'plan', contextTokens: 4096 }).enabled === true);
    const off = R.thinkingPlan({ modelId: 'qwen1', stage: 'plan', contextTokens: 4096 });
    check('off object has null budget and timeout', off.maxTokens === null && off.timeoutMs === null, off);
    check('no arguments does not throw and is off', R.thinkingPlan().enabled === false);

    // ---- thinkingPlan：預算縮放與夾限 ----
    const pm = (c) => R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'plan', contextTokens: c }).maxTokens;
    check('plan clamps to min 1500 for tiny context', pm(2048) === 1500, pm(2048));
    check('plan clamps to max 3000 for big context', pm(8192) === 3000, pm(8192));
    check('plan scales between 4096 and 8192', pm(4096) < pm(6144) && pm(6144) < pm(8192), [pm(4096), pm(6144), pm(8192)]);
    const rm = (c) => R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'reflect', contextTokens: c }).maxTokens;
    check('reflect clamps to max 600', rm(8192) === 600, rm(8192));
    check('reflect clamps to min 300', rm(1000) === 300, rm(1000));
    check('reflect scales between 4096 and 8192', rm(4096) < rm(6144) && rm(6144) < rm(8192), [rm(4096), rm(6144), rm(8192)]);
    check('missing contextTokens uses 4096 default', pm(undefined) === 1638, pm(undefined));
    check('plan budget always integer', Number.isInteger(pm(5000)), pm(5000));

    // ---- jsonStep：沒有 thinking 時行為不變 ----
    const f0 = fakeGen(['{"choice": 1}']);
    const r0 = await R.jsonStep({ generate: f0.generate, messages: msgs, validate: VALID, maxTokens: 40, prefill: '{"choice":' });
    check('no thinking: ok and one call', r0.ok && f0.calls.length === 1 && r0.tries === 1, r0);
    check('no thinking: request has only the old keys', Object.keys(f0.calls[0]).sort().join(',') === 'maxTokens,messages,prefill', Object.keys(f0.calls[0]));
    check('no thinking: maxTokens from ctx', f0.calls[0].maxTokens === 40, f0.calls[0]);
    const f0b = fakeGen(['{"choice": 9}', '{"choice": 1}']);
    const r0b = await R.jsonStep({ generate: f0b.generate, messages: msgs, validate: VALID });
    check('no thinking: retry uses the same shape and default 160 tokens', r0b.ok && f0b.calls.length === 2 && f0b.calls[1].maxTokens === 160 && !('enableThinking' in f0b.calls[1]), f0b.calls);
    const f0c = fakeGen([{ throw: 'boom' }]);
    const r0c = await R.jsonStep({ generate: f0c.generate, messages: msgs, validate: VALID });
    check('no thinking: generate throw gives ok false, error kept', !r0c.ok && r0c.error === 'boom' && r0c.tries === 1, r0c);

    // ---- jsonStep：thinking 開著 ----
    const reply = '<think>先想一下，選 1</think>\n{"choice": 1}';
    const f1 = fakeGen([reply]);
    const r1j = await R.jsonStep({ generate: f1.generate, messages: msgs, validate: VALID, thinking: TH });
    check('thinking ok first try', r1j.ok && r1j.value.choice === 1 && r1j.tries === 1 && f1.calls.length === 1, r1j);
    check('thinking request enableThinking true, budget and timeout passed', f1.calls[0].enableThinking === true && f1.calls[0].maxTokens === 1600 && f1.calls[0].timeoutMs === 30000, f1.calls[0]);
    check('thinking text returned as reasoning, not in answer', r1j.reasoning === '先想一下，選 1' && r1j.value.choice === 1, r1j.reasoning);

    // 思考不合法 → 第二次還是 thinking（同一輪重試）→ 再退路：同一題 enableThinking false
    const f2 = fakeGen(['<think>想</think>{"choice": 9}', '<think>又想</think>{"choice": 8}', '{"choice": 1}']);
    const r2 = await R.jsonStep({ generate: f2.generate, messages: msgs, validate: VALID, thinking: TH });
    check('fallback: ok after thinking round fails', r2.ok && r2.value.choice === 1 && r2.tries === 3, r2);
    check('fallback: third call has enableThinking false', f2.calls.length === 3 && f2.calls[2].enableThinking === false, f2.calls.map((c) => c.enableThinking));
    check('fallback: third call starts from original messages', f2.calls[2].messages === msgs, f2.calls[2].messages);
    check('fallback: reasoning from both thinking tries kept', r2.reasoning === '想\n\n又想', r2.reasoning);
    check('fallback: thinking text not sent back into messages', f2.calls.every((c) => JSON.stringify(c.messages).indexOf('想') < 0 || c.messages === msgs), 'leak');

    // 全部失敗：兩次 thinking + 一次退路，仍失敗 → ok:false
    const f3 = fakeGen(['{"choice": 9}', '{"choice": 9}', '{"choice": 9}']);
    const r3 = await R.jsonStep({ generate: f3.generate, messages: msgs, validate: VALID, thinking: TH });
    check('all fail: ok false after 3 calls', !r3.ok && f3.calls.length === 3 && typeof r3.error === 'string' && r3.error.length > 0, r3);
    check('all fail: last call is non-thinking', f3.calls[2].enableThinking === false && f3.calls[0].enableThinking === true, f3.calls.map((c) => c.enableThinking));
    check('all fail: rejected list has every reply', r3.rejected.length === 3 && r3.rejected.every((x) => Array.isArray(x.errors)), r3.rejected.length);

    // generate 拋錯：不做退路，直接 ok:false
    const f4 = fakeGen([{ throw: '逾時' }]);
    const r4 = await R.jsonStep({ generate: f4.generate, messages: msgs, validate: VALID, thinking: TH });
    check('throw in thinking round: ok false, no fallback', !r4.ok && r4.error === '逾時' && f4.calls.length === 1, r4);

    // ctx.thinking 關閉 → 等同沒有 thinking
    const f5 = fakeGen(['{"choice": 1}']);
    const r5 = await R.jsonStep({ generate: f5.generate, messages: msgs, validate: VALID, thinking: { enabled: false, maxTokens: null, timeoutMs: null } });
    check('thinking enabled false: request keys unchanged', r5.ok && Object.keys(f5.calls[0]).sort().join(',') === 'maxTokens,messages,prefill', Object.keys(f5.calls[0]));

    console.log(ok + ' passed, ' + bad.length + ' failed', bad);
    process.exit(bad.length ? 1 : 0);
})();
