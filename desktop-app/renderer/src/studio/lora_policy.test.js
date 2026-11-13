// node renderer/src/studio/lora_policy.test.js
// 六顆內建 LoRA 的路由政策（DESIGN §32.11）：codewrite／reading 的觸發規則、任務標籤、反例（一般聊天不應被搶走）、每輪只開一顆。
const Rt = require('./lora_route_core.js'); const R = require('./lora_registry_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); } };
const H = (c) => c.repeat(64);
const ENV = { base: 'Qwen/Qwen3-0.6B', rank_slots: [16], prompt_format_version: 3, tool_catalog_sha256: H('a') };
const MB = 1024 * 1024;
const GOOD_EVAL = { score: 1, groups: { g: { adapter: 0.9, base: 0.5, n: 60 } } };
// 與 descriptor 相同的寬鬆觸發字（打包時寫進去的）：政策必須蓋過它
const mk = (id, o) => Object.assign({ id, source: 'builtin', base: ENV.base, rank: 16, prompt_format_version: 3, tool_catalog_sha256: H('a'), domains: [], location: 'fap:x/' + id, size: 4 * MB, sha256: H('b'), enabled: true, eval: GOOD_EVAL }, o || {});
const mkLoader = () => { const log = []; return { log, load: async (e) => { log.push('load ' + e.id); return { id: e.id }; }, unload: async (e) => { log.push('unload ' + e.id); } }; };
const regWith = (entries, maxActive) => { const L = mkLoader(); const reg = R.createRegistry({ env: ENV, loader: L, budgetBytes: 500 * MB, maxActive: maxActive || 1, now: () => 1 }); for (const e of entries) reg.register(e); return { reg, L }; };
const SIX = () => [
    mk('decompose-r4-v2', { domains: ['decompose'], triggers: ['拆題'] }),
    mk('toolcall-r4', { domains: ['toolcall'], triggers: ['工具|呼叫|tool|function call|參數'] }),
    mk('colu-r4', { domains: ['colu'] }),
    mk('plan-r4', { domains: ['plan'] }),
    mk('codewrite-r4', { domains: ['codewrite'], triggers: ['寫程式|程式|函式|code|def'] }),
    mk('reading-r4', { domains: ['reading'], triggers: ['文中|文章|引用|原文|閱讀|根據'] }),
];

(async () => {
    // 1. 任務標籤
    check('任務標籤：codewrite／code_write → codewrite', Rt.taskDomain('codewrite') === 'codewrite' && Rt.taskDomain('code_write') === 'codewrite');
    check('任務標籤：reading／read_comp → reading', Rt.taskDomain('reading') === 'reading' && Rt.taskDomain('read_comp') === 'reading');
    check('任務標籤：舊的六個不受影響', Rt.taskDomain('decompose') === 'decompose' && Rt.taskDomain('toolcall') === 'toolcall' && Rt.taskDomain('plan') === 'plan');

    // 2. reading：必須附文章且問依文作答
    {
        const { reg } = regWith(SIX());
        const hit = (t) => reg.select({ text: t }).plan.map((e) => e.id);
        const yes = hit('【文章】台灣的首都是台北。\n【問題】文中說首都是哪裡？');
        check('reading 正例：有【文章】且問依文作答 → 選到', yes.indexOf('reading-r4') >= 0, yes);
        const no1 = hit('今天天氣如何？根據你的看法我應該帶傘嗎');
        check('reading 反例：一般聊天「根據」不選', no1.indexOf('reading-r4') < 0, no1);
        const no2 = hit('請解釋這篇文章的寫作風格');
        check('reading 反例：只提「文章」沒有附文章不選', no2.indexOf('reading-r4') < 0, no2);
        const no3 = hit('【文章】內容很短。\n這個概念是什麼意思？');
        check('reading 反例：有文章但沒有依文作答的字眼不選', no3.indexOf('reading-r4') < 0, no3);
    }
    // 3. codewrite：必須明確要寫程式或實作函式
    {
        const { reg } = regWith(SIX());
        const hit = (t) => reg.select({ text: t }).plan.map((e) => e.id);
        const yes = hit('請幫我寫程式算 3 加 4');
        check('codewrite 正例：寫程式', yes.indexOf('codewrite-r4') >= 0, yes);
        const yes2 = hit('實作函式 fib(n)');
        check('codewrite 正例：實作函式', yes2.indexOf('codewrite-r4') >= 0, yes2);
        const no1 = hit('請介紹一下程式語言的歷史');
        check('codewrite 反例：一般聊天提「程式語言」不選', no1.indexOf('codewrite-r4') < 0, no1);
        const no2 = hit('這個函式是什麼意思？');
        check('codewrite 反例：只問函式含義不選', no2.indexOf('codewrite-r4') < 0, no2);
    }
    // 4. 每輪只開一顆（maxActive=1）與一般聊天不被搶走
    {
        const { reg } = regWith(SIX());
        const s = reg.select({ text: '請幫我寫程式並引用原文' });
        check('每輪最多一顆（maxActive=1）', s.plan.length <= 1, s.plan.map((e) => e.id));
        const chat = reg.select({ text: '你好，今天過得怎麼樣？' });
        check('一般問答不選任何 LoRA', chat.plan.length === 0, chat.plan.map((e) => e.id));
    }
    // 5. 路由整段（routeTurn）：reading 只有附文章時才會經由文字觸發載入
    {
        const { reg, L } = regWith(SIX());
        const r1 = await Rt.routeTurn(reg, 'reading', { text: '一般問答' });
        check('reading 任務但沒附文章：仍由任務標籤選到（手動的任務路由）', r1.domain === 'reading', r1);
    }
    console.log('lora_policy 測試：通過 ' + ok + '、失敗 ' + bad);
    if (bad) process.exit(1);
})();
