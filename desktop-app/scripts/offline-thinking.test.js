// 離線模型 Thinking 開關（offlineThinking，預設 off）：只對 qwen3-0.6b 的一般聊天回答；有工具／預填／呼叫端已指定的不動；設定存檔不被白名單洗掉
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const m0 = src.indexOf('    _offlineThinkingOn(model)'), m1 = src.indexOf('    async _llmGenerateInner(model, a, cb) {');
ok(m0 > 0 && m1 > m0, '找得到 _offlineThinkingOn／_offlineThinkingArgs');
const Cls = new Function('return (class {\n' + src.slice(m0, m1) + '\n});')();
const mk = (v) => { const o = new Cls(); o.advancedSettings = { offlineThinking: v }; return o; };
const M = { id: 'qwen3-0.6b' }, other = { id: 'smollm' };
let o = mk('off'); ok(o._offlineThinkingArgs(M, { messages: [], maxTokens: 100 }).enableThinking === undefined, '預設 off：不帶 enableThinking');
o = mk(undefined); ok(o._offlineThinkingOn(M) === false, '未設定視為關');
o = mk('on'); let r = o._offlineThinkingArgs(M, { messages: [], maxTokens: 100 });
ok(r.enableThinking === true && r.maxTokens === 1636, 'on：開思考並多給 1536 詞元（' + r.maxTokens + '）');
ok(o._offlineThinkingArgs(M, { messages: [] }).maxTokens === 2048, 'on：沒給 maxTokens 以 512 計');
ok(o._offlineThinkingArgs(other, { messages: [] }).enableThinking === undefined, 'on：其他模型不受影響');
ok(o._offlineThinkingArgs(M, { messages: [], enableThinking: false }).enableThinking === false, 'on：呼叫端明確指定 false 就尊重');
ok(o._offlineThinkingArgs(M, { messages: [], prefill: '{' }).enableThinking === undefined, 'on：有預填的呼叫（要固定格式）不開');
// 存檔白名單
ok(/offlineThinking: raw\.offlineThinking === 'on' \? 'on' : 'off'/.test(src), '_normalizeAdvancedSettings 白名單有 offlineThinking');
ok(/offlineThinking: 'off',/.test(src), '預設值 off');
ok(/bo\.native && a\.enableThinking === true/.test(src), '思考時原生路徑被略過');
ok(/advancedSettings\.offlineThinking = (on|e\.target\.checked === true) \? 'on' : 'off'/.test(src), '設定介面有開關並寫入 offlineThinking（勾選框或「離線模型開關」面板）');
console.log(pass + ' 通過 ' + fail + ' 失敗'); process.exit(fail ? 1 : 0);
