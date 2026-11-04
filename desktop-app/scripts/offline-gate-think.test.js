// 離線理解閘階段4：理解不了先思考、仍不懂才問使用者並記憶、最後核對（程式先判、不確定才問小模型 A／B）、has_more 警語
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
const G = require('../renderer/src/offline/intent_gate.js');
const R = require('../renderer/src/recipe/recipe_core.js');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };

// ---- 純函式：核對 ----
const gf = G.gate('瀏覽器打開 https://tw.yahoo.com 並找美國選舉新聞');
let v = G.verify(gf, { hits: 3 });
ok(v.verdict === 'answered' && /篩出 3 則/.test(v.conclusion) && !v.warn.length, '核對：篩出多則＝有回答');
v = G.verify(gf, { hits: 0, searched: true });
ok(v.verdict === 'not_answered' && /頁面與站內搜尋都沒有/.test(v.conclusion), '核對：0 則＝沒有回答，明說');
v = G.verify(gf, { hits: 1 });
ok(v.verdict === 'unsure' && v.ask === true, '核對：只有 1 則＝不確定，要問小模型');
v = G.verify(gf, { hits: 3, hasMore: true, readChars: 3000 });
ok(/沒有讀完.*只讀了前 3000 字/.test(v.conclusion) && v.warn.length === 1, '核對：has_more 沒讀完＝結論有警語');
v = G.verify(G.gate('打開 https://a.com 並摘要'), { summary: '重點' });
ok(v.verdict === 'answered' && /機械摘要/.test(v.conclusion), '核對：摘要有內容');
v = G.verify(G.gate('打開 https://a.com 並摘要'), { summary: '' });
ok(v.verdict === 'not_answered', '核對：摘要空＝沒做到');
v = G.verify(gf, { hits: 2, undone: ['截圖（沒有圖）'] });
ok(/有步驟沒做到：截圖/.test(v.conclusion), '核對：沒做到的步驟寫進結論');
ok(G.verifyMessages('美國選舉', ['a', 'b']).length === 2 && G.validateAB({ answer: 'A' }).length === 0 && G.validateAB({ answer: 'C' }).length === 1, '核對題是字母 A／B 的封閉題');

// ---- 記憶 ----
const unk = '打開 https://a.com 並幫我弄一下瑞士那段';
let g = G.gate(unk);
ok(g.advice === 'partial' && g.unhandled.length === 1, '看不懂的句子：只做動作並標示沒處理（' + g.unhandled + '）');
const mem = {}; mem[G.memKey(g.unhandled[0])] = 'find_topic';
g = G.gate(unk, { memory: mem });
ok(g.advice === 'open_post' && g.post[0].type === 'find_topic' && g.post[0].by === 'memory' && g.unhandled.length === 0, '記憶：以前回答過的說法直接懂');
ok(G.recall({ [G.memKey('弄一下瑞士那段')]: 'summarize' }, '幫我弄一下瑞士那段') === 'summarize', '記憶：相近說法（含關係）也認得');
g = G.gate(unk); G.resolveClause(g, g.unhandled[0], 'skip', 'user');
ok(g.unhandled.length === 0 && g.post.length === 0, '使用者回答「不用處理」：清掉沒處理的句子');

// ---- 方法：_otGateResolve／_otGateRemember／_otGateVerifyAsk ----
const m0 = src.indexOf('    // ---- 階段4：理解不了時先思考'), m1 = src.indexOf('    // 使用者自訂的同義詞組（Configure');
const Cls = new Function('FaIntentGate', 'FaRecipe', 'return (class {\n' + src.slice(m0, m1) + '\n});')(G, R);
const methods = {}; Object.getOwnPropertyNames(Cls.prototype).filter((n) => n !== 'constructor').forEach((n) => { methods[n] = Cls.prototype[n]; });
const store = {};
const mkFa = (over) => Object.assign({ _ot: { gateMemory: {} }, _otLoad: async () => { }, _otDb: () => ({ get: async (t, k) => store[k], put: async (t, o) => { store[o.k] = o; } }), advancedSettings: {} }, methods, over || {});
const mkGate = () => ({ text: unk, gate: G.gate(unk) });
const genChoice = (n, log) => async (req) => { log && log.push(req); return '{"choice": ' + n + '}'; };

(async () => {
    // 小模型思考後看得懂 → 不問使用者、不記憶
    let asked = 0, plan = mkGate(); const log = [];
    let fa = mkFa({ _otGateGen: genChoice(2, log), _otGateThinking: { enabled: true, maxTokens: 1500, timeoutMs: 30000 }, requestUserForm: async () => { asked++; return null; } });
    await fa._otGateResolve(plan, unk);
    ok(asked === 0 && plan.gate.post[0].type === 'summarize' && plan.gate.unhandled.length === 0, '小模型看懂（摘要）：不打擾使用者');
    ok(log.some((r) => r.enableThinking === true), '問小模型時帶 Thinking 設定（CoLU＋Thinking）');
    ok(/離線小模型.*Thinking.*摘要/.test(plan.gate.trace.join('|')) && Object.keys(fa._ot.gateMemory).length === 0, '卡片記錄小模型的判斷；小模型的猜測不寫進記憶');
    // 小模型仍不懂（選 5）→ 問使用者 → 記憶
    asked = 0; plan = mkGate();
    fa = mkFa({ _otGateGen: genChoice(5), requestUserForm: async (o) => { asked++; return { confirmed: true, answer: G.POST_CHOICES[0].label }; } });
    await fa._otGateResolve(plan, unk);
    ok(asked === 1 && plan.gate.post[0].type === 'find_topic' && plan.gate.post[0].by === 'user', '思考後仍不懂：問使用者，採用使用者的回答');
    ok(Object.values(fa._ot.gateMemory)[0] === 'find_topic' && store.gate_memory && Object.values(store.gate_memory.v)[0] === 'find_topic', '使用者回答後自動寫進記憶（含持久化）');
    ok(/已記住/.test(plan.gate.trace.join('|')), '卡片寫明已記住');
    // 下一次同類說法直接懂：不問模型也不問人
    asked = 0; let calls = 0;
    const g2 = G.gate(unk, { memory: fa._ot.gateMemory });
    ok(g2.unhandled.length === 0 && g2.post.length === 1, '下次同樣的說法：直接懂');
    // 沒有小模型 → 直接問使用者，並明說沒能思考
    plan = mkGate(); asked = 0;
    fa = mkFa({ requestUserForm: async () => { asked++; return { confirmed: true, answer: G.POST_CHOICES[1].label }; } });
    await fa._otGateResolve(plan, unk);
    ok(asked === 1 && plan.gate.post[0].type === 'summarize' && /沒載入，沒辦法先思考/.test(plan.gate.trace.join('|')), '小模型沒載入：明說沒能思考，直接問');
    // 使用者沒回答 → 維持只做動作
    plan = mkGate();
    fa = mkFa({ requestUserForm: async () => null });
    await fa._otGateResolve(plan, unk);
    ok(plan.gate.unhandled.length === 1 && plan.gate.post.length === 0 && /沒有得到回答，只做了動作/.test(plan.gate.trace.join('|')) && Object.keys(fa._ot.gateMemory).length === 0, '使用者沒回答：只做動作並註明，不亂記憶');
    // 模型亂答（不合格）→ 退回問使用者
    plan = mkGate(); asked = 0;
    fa = mkFa({ _otGateGen: async () => '{"choice": 99}', requestUserForm: async () => { asked++; return { confirmed: true, answer: G.POST_CHOICES[4].label }; } });
    await fa._otGateResolve(plan, unk);
    ok(asked === 1 && plan.gate.unhandled.length === 0, '模型亂答：退回問使用者；使用者說不用處理就清掉');
    // 核對題 A／B
    fa = mkFa({ _otGateGen: async () => '{"answer": "B"}' });
    ok(await fa._otGateVerifyAsk('美國選舉', ['x']) === 'B', '核對題：小模型回 B');
    fa = mkFa({ _otGateGen: async () => '{"answer": "A"}' });
    ok(await fa._otGateVerifyAsk('美國選舉', ['x']) === 'A', '核對題：小模型回 A');
    fa = mkFa({ _otGateGen: async () => { throw new Error('boom'); } });
    ok(await fa._otGateVerifyAsk('美國選舉', ['x']) === null, '核對題：模型出錯＝null（保守處理，不阻擋）');
    // 接線
    ok(/_otGateResolve\(plan, text\)/.test(src) && /FaIntentGate\.verify\(plan\.gate/.test(src) && /_otGateVerifyAsk\(kw/.test(src), '接線：離線對話呼叫思考與核對');
    ok(src.includes("verdict && verdict.conclusion, shotText"), '接線：結論放進卡片');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
