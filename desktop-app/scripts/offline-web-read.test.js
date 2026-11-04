// 離線訓練器：打開網頁、關鍵字篩選、has_more 續讀、步驟顯示（A～D）
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };

const a = src.indexOf('/* OT-WEB-BEGIN */'), b = src.indexOf('/* OT-WEB-END */');
if (a < 0 || b < 0) { console.log('FAIL 找不到 OT-WEB 區塊'); process.exit(1); }
const lib = new Function(src.slice(a, b) + '\nreturn { _faOtWebGoal, _faOtWebFilter, _faOtWantsVisible, _faOtAdjustSteps, _faOtFollowAll, FA_OT_MAX_PAGES };')();
// 取出 _otPageDigest 方法本體
const d0 = src.indexOf('    _otPageDigest(o, query) {'), d1 = src.indexOf('    _otPretty(raw, query, budget) {');
const digestObj = new Function('_faOtWebGoal', '_faOtWebFilter', '_faSemSentences', '_faSummarize', 'return ({\n' + src.slice(d0, d1) + '\n});')(lib._faOtWebGoal, lib._faOtWebFilter, (t) => t.split(/\n/), (s) => s.slice(0, 6));

(async () => {
    // A 規則步驟
    const steps = [{ tool: 'browser_create_tab', args: { url: '{url}' } }, { tool: 'browser_get_page_text', args: { tab_id: '{step1.tab_id}' } }, { tool: 'browser_close', args: { tab_id: '{step1.tab_id}' }, cleanup: true }];
    const vis = lib._faOtAdjustSteps(steps, '瀏覽器打開 https://tw.yahoo.com 並找美國選舉新聞');
    ok(vis[0].args.active === true && vis[0].args.keep_open === false, 'A 打開：前景開分頁、不保留');
    ok(vis.some((s) => s.tool === 'browser_close' && s.cleanup && s.args.tab_id === '{step1.tab_id}'), 'A 打開：仍有關閉自己開的分頁這一步');
    ok(vis.length === 3 && vis[2].tool === 'browser_close', 'A 打開：關閉在最後');
    ok(steps[0].args.active === undefined && steps.length === 3, 'A 不改動原規則');
    const quiet = lib._faOtAdjustSteps(steps, '用瀏覽器讀一下 https://example.com');
    ok(quiet === steps && quiet.length === 3, 'A 只讀不看：維持原狀');
    ok(lib._faOtAdjustSteps(steps, '前往 https://a.com')[0].args.active === true, 'A 前往也算');

    // B 目標詞與篩選
    const g = lib._faOtWebGoal('瀏覽器打開 https://tw.yahoo.com 並找美國選舉新聞');
    ok(g && g.keyword === '美國選舉', 'B 抓到目標詞：' + (g && g.keyword));
    ok(g.terms.includes('川普') && g.terms.includes('賀錦麗') && g.terms.includes('美國大選'), 'B 相近詞');
    ok(lib._faOtWebGoal('用瀏覽器控制開啟 https://a.com') === null, 'B 沒有後半句＝沒有目標');
    const mk = (extra) => ({ title: 'Yahoo', url: 'https://tw.yahoo.com', text: Array.from({ length: 20 }, (_, i) => '今日娛樂焦點新聞第' + i + '則報導內容').concat(extra).join('\n') });
    const q = '瀏覽器打開 https://tw.yahoo.com 並找美國選舉新聞';
    const hit = digestObj._otPageDigest(mk(['川普與賀錦麗最後一場辯論交鋒激烈', '美國大選倒數 搖擺州民調出爐']), q);
    ok(/篩出 2 則/.test(hit) && hit.includes('川普與賀錦麗') && !hit.includes('今日娛樂焦點新聞第0則'), 'B 篩出相關標題、不拿無關充數');
    const none = digestObj._otPageDigest(mk([]), q);
    ok(/沒有找到跟「美國選舉」有關的標題/.test(none) && /站內搜尋/.test(none) && !none.includes('今日娛樂焦點新聞第0則'), 'B 找不到就明說並提示站內搜尋');
    const plain = digestObj._otPageDigest(mk([]), '瀏覽器打開 https://tw.yahoo.com');
    ok(plain.includes('今日娛樂焦點新聞第0則'), 'B 沒目標詞時維持原本列表');

    // C 續讀
    const pages = ['甲'.repeat(300), '乙'.repeat(300), '丙'.repeat(300)];
    let calls = [];
    const tools = { browser_get_page_text: { callback: async (s) => { const a = JSON.parse(s); calls.push(a.offset || 0); const i = (a.offset || 0) / 300; return JSON.stringify({ ok: true, title: 'T', url: 'u', text: pages[i], has_more: i < 2, next_offset: (i + 1) * 300 }); } } };
    let trail = [];
    let out = JSON.parse(await lib._faOtFollowAll(null, tools, 'browser_get_page_text', { tab_id: 1 }, await tools.browser_get_page_text.callback('{}'), trail));
    ok(out.text.length === 900 && out.has_more === false && out.pages === 3 && calls.join() === '0,300,600', 'C 瀏覽器讀頁：續讀到讀完');
    ok(/3 頁.*900 字.*已讀完/.test(trail[0]), 'C/D 步驟記錄讀了幾頁');
    calls = []; trail = [];
    out = JSON.parse(await lib._faOtFollowAll(null, tools, 'browser_get_page_text', {}, await tools.browser_get_page_text.callback('{}'), trail, 2));
    ok(out.has_more === true && out.pages === 2 && /還沒讀完/.test(trail[0]), 'C 到上限仍沒讀完：標記 has_more');
    const warn = digestObj._otPageDigest(Object.assign({ text: '字'.repeat(600) }, out, { text: out.text }), '讀一下');
    ok(/沒有讀完.*只讀了前 600 字/.test(warn), 'C 到上限：明說只讀了前 N 字');
    // fetch_web_page 路線
    const fpages = ['A'.repeat(500), 'B'.repeat(500)];
    const tools2 = { parse_uploaded_file: { callback: async (s) => { const a = JSON.parse(s); const i = (a.offset || 0) / 500; return JSON.stringify({ ok: true, content: fpages[i], has_more: i < 1, next_offset: (i + 1) * 500 }); } } };
    trail = [];
    out = JSON.parse(await lib._faOtFollowAll(null, tools2, 'fetch_web_page', { url: 'https://x.com' }, JSON.stringify({ ok: true, file_id: 'f1', title: 'X', url: 'https://x.com', sizeChars: 1000, preview: 'A'.repeat(500) }), trail));
    ok(out.text.length === 1000 && out.has_more === false && out.pages === 2, 'C fetch_web_page 路線：用 offset 讀完整份');
    ok(trail.length === 1 && /2 頁/.test(trail[0]), 'D fetch 路線也記錄步驟');
    const bad = JSON.stringify({ ok: false, error: 'x' });
    ok(await lib._faOtFollowAll(null, tools2, 'fetch_web_page', {}, bad, []) === bad, 'C 失敗結果原樣回傳');

    // 階段0：執行器真的呼叫 browser_close（只關自己開的分頁），模擬執行器迴圈
    {
        const log = [];
        const subst = (v, r) => (typeof v === 'string' && v === '{step1.tab_id}' ? r : v);
        let tabId = null;
        const fake = { browser_create_tab: (a) => { tabId = 77; log.push(['create', a]); return { tab_id: 77 }; }, browser_get_page_text: (a) => { log.push(['text', a]); return { ok: true }; }, browser_close: (a) => { log.push(['close', a]); return { ok: true }; } };
        for (const st of vis) { const args = Object.fromEntries(Object.entries(st.args).map(([k, v]) => [k, subst(v, tabId)])); fake[st.tool](args); }
        const cl = log.find((x) => x[0] === 'close');
        ok(!!cl && cl[1].tab_id === 77 && log[0][1].active === true, '階段0 執行：前景開 77 號分頁，最後 browser_close(77)');
    }
    ok(/做完會自己關閉/.test(src) && !/切到前景，保留分頁/.test(src), '階段0 卡片文字與實際動作一致（不再寫保留分頁）');
    ok(src.includes("trail.push(ok === false ? '🧹") && /已關閉自己開的分頁/.test(src), '階段0 卡片列出關閉步驟');

    // D 卡片顯示步驟（原始碼接線）
    ok(/做了這些步驟/.test(src) && /開啟 ' \+ args\.url/.test(src) && /_faOtFollowAll\(this, this\.tools, cand\.tool/.test(src), 'D 卡片顯示步驟並接上食譜路線');
    ok(/_faOtAdjustSteps\(c\.steps \|\| \[\], plan\.text\)/.test(src), 'A 步驟執行器套用調整');

    console.log(`\n${pass} 過，${fail} 失敗`);
    process.exit(fail ? 1 : 0);
})();
