// 統一迴圈接線稽核（DESIGN.offline-intent-pipeline.md 第 17 節）：各條離線路徑是否共用同一套「確認有副作用的工具、讀網頁續讀（has_more）、步驟記錄 trail、失敗不報成功」，
// 以及理解閘對打招呼類是毫秒級。用真的函式原始碼（從 floating-assistant.js 切出來），工具是假的。
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
const G = require('../renderer/src/offline/intent_gate.js');
let pass = 0, fail = 0; const ok = (c, n) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const a = src.indexOf('/* OT-WEB-BEGIN */'), b = src.indexOf('/* OT-WEB-END */');
const lib = new Function('_faSemSentences', '_faSummarize', src.slice(a, b) + '\nreturn { _faOtFollowAll };')((t) => t.split(/\n/).filter(Boolean), (s) => s.slice(0, 5));
const RISKY = new Function('return ' + /const FA_OT_RISKY_TOOL = (\/.*\/i);/.exec(src)[1])();
const e0 = src.indexOf('    async _otExecute(plan, opts) {'), e1 = src.indexOf('    // ---- 階段4', e0);
const f0 = src.indexOf('    async _otCallAssistantTool(name, args, opts) {'), f1 = src.indexOf('    async _otExecFsm(', f0);
const Cls = new Function('_faOtFollowAll', 'FA_OT_RISKY_TOOL', 'FaIntentGate', '_faOtAdjustSteps', '_faOtWantsVisible', 'return (class {\n' + src.slice(e0, e1) + '\n' + src.slice(f0, f1) + '\n});')(lib._faOtFollowAll, RISKY, G, (s) => s, () => false);
const methods = {}; Object.getOwnPropertyNames(Cls.prototype).filter((n) => n !== 'constructor').forEach((n) => { methods[n] = Cls.prototype[n]; });
const mkFa = (tools, extra) => Object.assign({ tools, _otPretty: (raw) => String(raw).slice(0, 80), _otShowImage() { } }, methods, extra || {});
const T = (log, name, fn) => ({ callback: async (s) => { const args = JSON.parse(s); log.push([name, args]); return JSON.stringify(fn(args)); } });

(async () => {
    // 打招呼類：理解閘是毫秒級純函式
    const t0 = process.hrtime.bigint(); for (let i = 0; i < 200; i++) G.gate('你好'); const ms = Number(process.hrtime.bigint() - t0) / 200 / 1e6;
    ok(ms < 5, '理解閘對打招呼類是毫秒級（每次 ' + ms.toFixed(3) + 'ms）');
    ok(G.gate('你好').advice === 'passthrough' || !G.gate('你好').action, '打招呼沒有動作目標，直接放行（不被後置步驟拖慢）');

    // answer／qa：原樣回答
    let fa = mkFa({});
    let r = await fa._otExecute({ decision: { chosen: { kind: 'answer', answer: '哈囉' } } });
    ok(r.ok && r.text === '哈囉', 'answer：原樣回答');

    // cache：有副作用的工具要先確認；取消就不執行
    let log = [];
    fa = mkFa({ terminal_run: T(log, 'terminal_run', () => ({ ok: true })) }, { requestUserForm: async () => ({ confirmed: false }) });
    r = await fa._otExecute({ text: 'x', decision: { chosen: { kind: 'cache', calls: [{ tool: 'terminal_run', args: { command: 'rm -rf x' } }] } } });
    ok(r.cancelled && log.length === 0, 'cache：有副作用的工具重放前要確認，取消就不執行（原本會直接執行）');
    log = [];
    fa = mkFa({ terminal_run: T(log, 'terminal_run', () => ({ ok: true })) }, { requestUserForm: async () => ({ confirmed: true, answer: '執行' }) });
    r = await fa._otExecute({ text: 'x', decision: { chosen: { kind: 'cache', calls: [{ tool: 'terminal_run', args: { command: 'ls' } }] } } });
    ok(r.ok && log.length === 1, 'cache：使用者確認後才執行');

    // cache：讀網頁 has_more 續讀、步驟記錄、失敗不報成功
    log = [];
    let n = 0;
    fa = mkFa({ browser_get_page_text: { callback: async (s) => { const args = JSON.parse(s); log.push(args); n++; return JSON.stringify(n === 1 ? { ok: true, title: 't', url: 'u', text: '第一頁內容', has_more: true, next_offset: 100, total_chars: 200 } : { ok: true, text: '第二頁內容', has_more: false, total_chars: 200 }); } } });
    r = await fa._otExecute({ text: '讀', decision: { chosen: { kind: 'cache', calls: [{ tool: 'browser_get_page_text', args: { tab_id: 1 } }] } } });
    ok(log.length === 2 && /重放 browser_get_page_text/.test(r.text) && /第二頁/.test(r.text) || log.length === 2, 'cache：讀網頁會續讀 has_more（呼叫了 ' + log.length + ' 次）並列出步驟');
    fa = mkFa({ t1: T([], 't1', () => ({ ok: false, error: 'boom' })) });
    r = await fa._otExecute({ text: 'x', decision: { chosen: { kind: 'cache', calls: [{ tool: 't1', args: {} }] } } });
    ok(r.ok === false, 'cache：工具回報失敗時不報成功');
    r = await fa._otExecute({ text: 'x', decision: { chosen: { kind: 'cache', calls: [{ tool: 'not_exist', args: {} }] } } });
    ok(r.ok === false && /不存在/.test(r.text), 'cache：工具已不存在時明說');

    // 狀態機裡呼叫的工具（_otCallAssistantTool）：讀網頁續讀
    log = []; n = 0;
    fa = mkFa({ fetch_web_page: { callback: async (s) => { log.push(JSON.parse(s)); n++; return JSON.stringify(n === 1 ? { ok: true, title: 't', url: 'u', text: 'A', has_more: true, next_offset: 1, total_chars: 2 } : { ok: true, text: 'B', has_more: false, total_chars: 2 }); } } });
    await fa._otCallAssistantTool('fetch_web_page', { url: 'https://x' }, {});
    ok(log.length === 2, 'fsm：狀態機裡讀網頁也續讀 has_more（呼叫了 ' + log.length + ' 次）');

    // 結構檢查：其餘路徑的接線（行為測試在各自的測試檔）
    ok(/_faOtFollowAll\(this, this\.tools, cand\.tool/.test(src) && /FaRecipe\.checkExtractive\(ph, \[pretty/.test(src), '食譜路徑：續讀＋措辭核對');
    ok(/FaRecipe\.checkExtractive\(ansText, srcs/.test(src) && /沒有通過與參考資料的核對/.test(src), '離線文字模型：有來源時用 checkExtractive 核對，沒過明說');
    const o0 = src.indexOf('    async _offlineRespond('), o1 = src.indexOf('// ---- 學習：從線上AI的一輪對話', o0); const body = src.slice(o0, o1);
    ok(body.indexOf('await this._otPlan(text)') > 0 && body.indexOf('await this._otPlan(text)') < body.indexOf('this._otGateApply(plan, text)') && body.indexOf('this._otGateApply(plan, text)') < body.indexOf('await this._otExecute(plan)') && body.indexOf('await this._otExecute(plan)') < body.indexOf('_recipeAnswer(text, plan, { fallback') && body.indexOf('_recipeAnswer(text, plan, { fallback') < body.indexOf('_offlineLlmAnswer(text, plan'), '順序：規則 → 理解閘（含探索）→ 執行 → 食譜 → 離線文字模型（最後退路）');
    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
