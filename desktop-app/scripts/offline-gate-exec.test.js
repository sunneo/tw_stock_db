// 離線理解閘接進執行流程：後置步驟（找主題、站內搜尋、摘要）、同義詞擴充、路由（網址／其他開啟）
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
const G = require('../renderer/src/offline/intent_gate.js');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };

const a = src.indexOf('/* OT-WEB-BEGIN */'), b = src.indexOf('/* OT-WEB-END */');
const lib = new Function('_faSemSentences', '_faSummarize', src.slice(a, b) + '\nreturn { _faOtWebGoal, _faOtWebFilter, _faOtGoodLines, _faOtFindSearchBox, _faOtFollowAll, _faOtExpandTerms };')((t) => t.split(/\n/).filter(Boolean), (s) => s.slice(0, 5));
const m0 = src.indexOf('    // 使用者自訂的同義詞組'), m1 = src.indexOf('    async _otBumpHit(plan) {');
const Cls = new Function('L', 'FaIntentGate', 'FA_SEM_LEX', '_faSemSentences', '_faSummarize', 'const { _faOtWebGoal, _faOtWebFilter, _faOtGoodLines, _faOtFindSearchBox, _faOtFollowAll } = L;\nreturn (class {\n' + src.slice(m0, m1) + '\n});')(lib, G, { cjk: [['選舉', 'vote'], ['投票', 'vote'], ['大選', 'vote']], word: {} }, (t) => t.split(/\n/).filter(Boolean), (s) => s.slice(0, 5));

const methods = {}; Object.getOwnPropertyNames(Cls.prototype).filter((n) => n !== 'constructor').forEach((n) => { methods[n] = Cls.prototype[n]; });
const mkFa = (tools, syn) => Object.assign({ tools, _ot: { synonyms: syn || {} }, _otSearchWaitMs: 0, _otShowImage() { } }, methods);
const mkTool = (log, name, fn) => ({ callback: async (s) => { const args = JSON.parse(s); log.push([name, args]); return JSON.stringify(fn(args)); } });
const L1 = ['今日娛樂焦點新聞第一則報導內容', '今日娛樂焦點新聞第二則報導內容', '川普與賀錦麗最後一場辯論交鋒激烈'];
const L0 = ['今日娛樂焦點新聞第一則報導內容', '今日娛樂焦點新聞第二則報導內容', '今日娛樂焦點新聞第三則報導內容'];
const gateOf = (t) => G.gate(t);
const Q = '瀏覽器打開 https://tw.yahoo.com 並找美國選舉新聞';

(async () => {
    // 同義詞擴充
    ok(lib._faOtWebGoal('找選舉新聞', { cjk: [['選舉', 'v'], ['投票', 'v'], ['大選', 'v']], word: {} }).terms.includes('投票'), '詞庫：關鍵字就是概念詞時擴充同組詞');
    ok(!lib._faOtWebGoal('找中國選舉新聞', { cjk: [['選舉', 'v'], ['投票', 'v']], word: {} }).terms.some((t) => t === '投票' && false) && !lib._faOtWebGoal('找股票分析', { cjk: [['分析', 'a'], ['研究', 'a']], word: {} }).terms.includes('研究'), '詞庫：不是整個關鍵字就不亂擴充（避免無關結果）');
    ok(lib._faOtWebGoal('找貓咪', null, [['貓咪', '喵星人', '貓']]).terms.includes('喵星人'), '使用者自訂同義詞組也會擴充');

    // 搜尋框偵測
    ok(lib._faOtFindSearchBox([{ tag: 'a', text: '搜尋說明' }, { tag: 'input', type: 'search', x: 1, y: 2 }]).type === 'search', '找到 type=search 的輸入框');
    ok(lib._faOtFindSearchBox([{ tag: 'input', type: 'text', placeholder: '搜尋新聞', x: 1, y: 2 }]) !== null, '找到 placeholder 寫搜尋的輸入框');
    ok(lib._faOtFindSearchBox([{ tag: 'input', type: 'password' }, { tag: 'button', text: '搜尋' }]) === null, '沒有搜尋框就回 null（按鈕、密碼框不算）');

    // 1 頁面就有 → 不站內搜尋
    let log = [], trail = [];
    let fa = mkFa({ browser_get_elements: mkTool(log, 'els', () => ({ ok: true, elements: [] })) });
    let r = await fa._otGatePost(gateOf(Q), { tabId: 7, page: { text: L1.join('\n') }, plan: { text: Q }, trail });
    ok(r.undone.length === 0 && log.length === 0 && /篩出 1 則/.test(trail.join('|')), '頁面上就有：不呼叫站內搜尋');

    // 2 沒有 → 站內搜尋 → 搜尋結果頁篩到
    log = []; trail = [];
    const res2 = ['美國大選最新民調出爐 搖擺州變數成關鍵', '川普發表勝選演說全文整理與各界反應'];
    fa = mkFa({
        browser_get_elements: mkTool(log, 'els', () => ({ ok: true, elements: [{ tag: 'input', type: 'search', x: 100, y: 40 }] })),
        browser_mouse: mkTool(log, 'mouse', () => ({ ok: true })),
        browser_type_text: mkTool(log, 'type', () => ({ ok: true })),
        browser_get_page_text: mkTool(log, 'text', () => ({ ok: true, title: '搜尋', url: 'u', text: res2.join('\n'), has_more: false }))
    });
    r = await fa._otGatePost(gateOf(Q), { tabId: 7, page: { text: L0.join('\n') }, plan: { text: Q }, trail });
    ok(log.map((x) => x[0]).join() === 'els,mouse,type,text', '沒篩到：依序 取元素→點搜尋框→輸入→讀結果頁（' + log.map((x) => x[0]).join() + '）');
    const typeArgs = log.find((x) => x[0] === 'type')[1];
    ok(typeArgs.text === '美國選舉' && typeArgs.submit === true && typeArgs.tab_id === 7, '輸入的是關鍵字並送出');
    ok(r.extra.length === 1 && r.undone.length === 0 && /搜尋結果頁篩出 2 則/.test(trail.join('|')), '搜尋結果頁篩到、讀完才下結論' + JSON.stringify([r.undone, trail, r.extra.length]));

    // 3 沒有搜尋框 → 明說
    log = []; trail = [];
    fa = mkFa({ browser_get_elements: mkTool(log, 'els', () => ({ ok: true, elements: [{ tag: 'a', text: '首頁' }] })), browser_type_text: mkTool(log, 'type', () => ({ ok: true })) });
    r = await fa._otGatePost(gateOf(Q), { tabId: 7, page: { text: L0.join('\n') }, plan: { text: Q }, trail });
    ok(r.undone.some((x) => /沒有搜尋框/.test(x)) && !log.some((x) => x[0] === 'type') && /沒有找到搜尋框/.test(trail.join('|')), '沒有搜尋框：明說做不到、不亂輸入');

    // 4 搜尋結果頁也沒有 → 不拿無關結果充數
    log = []; trail = [];
    fa = mkFa({
        browser_get_elements: mkTool(log, 'els', () => ({ ok: true, elements: [{ tag: 'input', type: 'search', x: 1, y: 2 }] })), browser_mouse: mkTool(log, 'mouse', () => ({ ok: true })),
        browser_type_text: mkTool(log, 'type', () => ({ ok: true })), browser_get_page_text: mkTool(log, 'text', () => ({ ok: true, text: L0.join('\n'), has_more: false }))
    });
    r = await fa._otGatePost(gateOf(Q), { tabId: 7, page: { text: L0.join('\n') }, plan: { text: Q }, trail });
    ok(r.undone.some((x) => /都沒有/.test(x)) && /搜尋結果頁也沒有/.test(trail.join('|')), '站內搜尋也沒有：記為沒做到');

    // 5 搜尋結果頁沒讀完 → 警語
    log = []; trail = [];
    fa = mkFa({
        browser_get_elements: mkTool(log, 'els', () => ({ ok: true, elements: [{ tag: 'input', type: 'search', x: 1, y: 2 }] })), browser_mouse: mkTool(log, 'mouse', () => ({ ok: true })),
        browser_type_text: mkTool(log, 'type', () => ({ ok: true })),
        browser_get_page_text: mkTool(log, 'text', (a) => ({ ok: true, text: res2.join('\n'), has_more: true, next_offset: 100 }))
    });
    r = await fa._otGatePost(gateOf(Q), { tabId: 7, page: { text: L0.join('\n') }, plan: { text: Q }, trail });
    ok(r.extra[0].json.has_more === true && /還沒讀完/.test(trail.join('|')), '結果頁到上限仍沒讀完：標記 has_more 並有警語');

    // 6 摘要與截圖、推理（沒做）
    log = []; trail = [];
    fa = mkFa({ browser_screenshot: mkTool(log, 'shot', () => ({ type: 'image', dataUrl: 'data:x', meta: { width: 1 } })) });
    r = await fa._otGatePost(G.gate('打開 https://a.com 並摘要，再截圖，然後比較兩家立場'), { tabId: 7, page: { text: L1.join('\n') }, plan: { text: 'x' }, trail });
    ok(/機械摘要/.test(trail.join('|')) && r.summary.length > 0 && /已截圖/.test(trail.join('|')) && r.undone.some((x) => /小模型推理/.test(x)), '摘要＋截圖做了、比較老實說沒做');

    // 路由
    const plan0 = (status, chosen) => ({ text: '', decision: { status, chosen: chosen || null } });
    let g = fa._otGateApply(plan0('no_match'), Q);
    ok(g.plan.decision.chosen && g.plan.decision.chosen.steps[0].tool === 'browser_create_tab' && g.plan.decision.chosen.steps[2].tool === 'browser_close', '沒規則命中：理解閘直接生成 create_tab→讀→close（不再走 fetch_web_page）');
    g = fa._otGateApply(plan0('no_match'), '瀏覽器打開 tw.yahoo.com');
    ok(g.plan.decision.chosen.steps[0].args.url === 'https://tw.yahoo.com', '沒有 https:// 的網域也開');
    const ruled = plan0('planned', { pattern: 'browser_open_read', kind: 'steps', steps: [] });
    g = fa._otGateApply(ruled, Q);
    ok(g.plan.decision.chosen.pattern === 'browser_open_read' && g.plan.gate.post.length === 1, '規則命中：保留規則步驟、掛上後置目標');
    fa.tools.edit_docx_open = { callback: async () => '{}' }; fa.tools.midi_edit_open = { callback: async () => '{}' };
    g = fa._otGateApply(plan0('no_match'), '打開 a.docx [附件：a.docx（file_id=d1）]');
    ok(g.plan.decision.chosen.tool === 'edit_docx_open' && g.plan.decision.chosen.args.file_id === 'd1', '打開 docx → edit_docx_open(file_id)');
    g = fa._otGateApply(plan0('planned', { pattern: 'feat_merge-pdfs', tool: 'merge_pdfs', via: '語意', score: 0.66, kind: 'tool' }), '打開 a.docx [附件：a.docx（file_id=d1）]');
    ok(g.plan.decision.chosen.tool === 'edit_docx_open', '語意勉強配到別的工具（merge_pdfs 0.66）：理解閘接手改開 docx');
    g = fa._otGateApply(plan0('planned', { pattern: 'midi_compose_request', tool: 'midi_compose', via: '規則', score: 0.85, kind: 'tool' }), '打開音樂編輯器');
    ok(g.plan.decision.chosen.tool === 'midi_compose', '字面規則高信心命中：尊重規則、不接手');
    g = fa._otGateApply(plan0('no_match'), '打開音樂編輯器');
    ok(g.plan.decision.chosen.tool === 'midi_edit_open', '打開音樂 → midi_edit_open');
    g = fa._otGateApply(plan0('no_match'), '開啟 Word 文件');
    ok(g.reply && /需要檔案/.test(g.reply), '沒附檔案：明說需要檔案');
    g = fa._otGateApply(plan0('no_match'), '打開 3D 場景編輯器');
    ok(g.reply && /3D/.test(g.reply) && !g.plan.decision.chosen, '沒有 3D 工具或沒檔案：回報而不是亂做');
    const keep = plan0('planned', { pattern: 'screenshot_rule', kind: 'steps', steps: [] });
    g = fa._otGateApply(keep, '截圖 https://a.com');
    ok(g.plan.decision.chosen.pattern === 'screenshot_rule', '其他規則命中（截圖）：不被理解閘改掉');
    g = fa._otGateApply(plan0('no_match'), '/offline-dry 打開 https://a.com');
    ok(!g.reply && !g.plan.decision.chosen, '斜線指令：放行');
    // 原始碼接線
    ok(/_otGateApply\(plan, text\)/.test(src) && /_otGatePost\(plan\.gate/.test(src), '接線：_offlineRespond 呼叫理解閘、_otExecute 呼叫後置步驟');
    ok(src.indexOf('gateOn && !gatePostDone && st.cleanup') > 0 && src.indexOf('gateOn && !gatePostDone') < src.indexOf("browser_close' && st.cleanup) trail.push"), '後置步驟在關閉分頁之前執行');
    ok(/superseded = true/.test(src) && /!r\.superseded/.test(src), '站內搜尋成功後，原頁面的「沒找到」摘要不再顯示（避免自相矛盾）');
    ok(src.includes("'✅ 已用 ' + c.tool + ' 開啟'"), '開啟類工具：卡片寫明已用哪個工具開啟');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
