// node renderer/src/recipe/news_digest_core.test.js
// 新聞摘要執行器：假網頁（列表頁文字、RSS、內文）＋假模型，跑完整流程。斷言：選來源、篩選、逐篇讀與摘要、合併、誠實標示、步驟順序。
const D = require('./news_digest_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 300))); } };

const YAHOO = 'https://tw.news.yahoo.com/';
const CNA = 'https://www.cna.com.tw/';
const A1 = 'https://tw.news.yahoo.com/a/1001';
const A2 = 'https://tw.news.yahoo.com/a/1002';
const A3 = 'https://tw.news.yahoo.com/a/1003';
const PAGES = {
    [YAHOO]: [
        '首頁', '登入', '2 小時前',
        '黃仁勳宣布新一代 AI 晶片 Blackwell 量產 ' + A1,
        '今天天氣晴朗，午後偶有陣雨 ' + A3,
        '輝達股價盤中創高 黃仁勳：AI 需求仍強 ' + A2,
    ].join('\n'),
    [CNA]: '中央社導覽\n頭條新聞標題沒有連結也沒有網址\n更多',
};
const BODIES = {
    [A1]: '黃仁勳在 GTC 宣布 Blackwell 晶片進入量產，首批出貨給雲端業者。',
    [A2]: '輝達股價盤中創歷史新高，黃仁勳表示 AI 需求仍然強勁。',
    [A3]: '今天天氣晴朗，午後偶有陣雨，氣溫約 28 度。',
    'https://news.google.com/rss/articles/X1': '颱風逼近，東部與離島可能出現強風，交通部提醒注意行車安全。',
};
const RSS = '<?xml version="1.0"?><rss><channel>' +
    '<item><title><![CDATA[颱風逼近 東部防強風 - 中央社]]></title><link>https://news.google.com/rss/articles/X1</link></item>' +
    '<item><title>黃仁勳訪台 &amp; 行程公布</title><link>https://news.google.com/rss/articles/X2</link></item>' +
    '</channel></rss>';

// 假的 deps：記錄每次呼叫，trace 收集到 steps
function fakeDeps(opts) {
    const o = opts || {};
    const calls = { fetchList: [], readArticle: [], summarize: [] }; const steps = [];
    return {
        calls, steps,
        deps: {
            fetchList: async (url) => { calls.fetchList.push(url); if (o.listError && url === YAHOO) return { ok: false, error: '逾時' }; return { ok: true, text: (o.pages || PAGES)[url] != null ? (o.pages || PAGES)[url] : (o.rss && /news\.google\.com/.test(url) ? RSS : '') }; },
            readArticle: async (url) => { calls.readArticle.push(url); return BODIES[url] != null ? { ok: true, text: BODIES[url] } : { ok: false, error: '404' }; },
            summarize: async (body, q) => { calls.summarize.push({ body, q }); return o.noModel ? { ok: true, text: '程式摘錄：' + body.slice(0, 16), method: 'extractive' } : { ok: true, text: '重點：' + body.slice(0, 18), method: 'model' }; },
            trace: (line) => steps.push(line),
        },
    };
}

(async () => {
    // A. 「看今天有哪些黃仁勳新聞」：沒說站名 → 預設兩個來源；Yahoo 有連結、CNA 沒有；只讀相關的兩篇
    {
        const f = fakeDeps();
        const r = await D.run('看今天有哪些黃仁勳新聞', f.deps);
        check('A 成功', r.ok === true && r.handled === true, r);
        // 命中詞數多的排前面：A2 同時含「黃仁勳」與「輝達」（2 個詞），A1 只含「黃仁勳」
    check('A 讀的是相關的 2 篇（不讀天氣），命中詞數多的排前', JSON.stringify(f.calls.readArticle) === JSON.stringify([A2, A1]), f.calls.readArticle);
        check('A 每篇都經過模型（summarize 收到內文）', f.calls.summarize.length === 2 && f.calls.summarize.every((c) => /黃仁勳|輝達/.test(c.body)), f.calls.summarize);
        check('A 摘要問題帶目標詞', f.calls.summarize.every((c) => c.q.includes('黃仁勳')), f.calls.summarize);
        check('A 合併標題為「N 則」', r.text.startsWith('今天有哪些黃仁勳新聞：2 則'), r.text);
        check('A 內容含模型摘要（不是程式吐的原文）', r.text.includes('重點：黃仁勳在 GTC') && !r.text.includes('沒有經過 AI'), r.text);
        check('A 沒有把天氣標題混進來', !r.text.includes('天氣'), r.text);
        const order = ['選來源', '拆字', '取清單', '取清單', '取清單', '取清單', '篩選', '讀第 1 篇', '逐篇摘要', '讀第 2 篇', '逐篇摘要', '合併'];
        const got = f.steps.map((s) => s.split('｜')[1]);
        check('A 步驟順序正確', JSON.stringify(got) === JSON.stringify(order), got);
        check('A 每步有輪次編號', f.steps.every((s, i) => s.startsWith('第 ' + (i + 1) + ' 輪｜')), f.steps);
        check('A 逐篇摘要標明誰做（模型）', f.steps.filter((s) => s.includes('逐篇摘要')).every((s) => s.includes('｜模型｜')), f.steps);
    }
    // B. 「去 yahoo 看黃仁勳的新聞」：說了站名 → 只用 Yahoo 新聞首頁
    {
        const f = fakeDeps();
        const r = await D.run('去 yahoo 看黃仁勳的新聞', f.deps);
        check('B 只抓 Yahoo 新聞首頁', JSON.stringify(f.calls.fetchList) === JSON.stringify([YAHOO]), f.calls.fetchList);
        check('B 結果 2 則', r.ok && r.text.startsWith('今天有哪些黃仁勳新聞：2 則'), r.text);
    }
    // C. 「看 yahoo 新聞有沒有颱風」：沒有相關 → 明說沒有，不讀、不充數
    {
        const f = fakeDeps();
        const r = await D.run('看 yahoo 新聞有沒有颱風', f.deps);
        check('C 明說沒有相關新聞', r.ok === false && r.text.includes('沒有找到跟「颱風」有關的新聞') && r.text.includes('不拿不相關的標題充數'), r.text);
        check('C 沒有讀任何內文', f.calls.readArticle.length === 0, f.calls.readArticle);
    }
    // D. 「看 yahoo 股市 的黃仁勳新聞」：不支援的站名 → 問，不猜
    {
        const f = fakeDeps();
        const r = await D.run('看 yahoo 股市 的黃仁勳新聞', f.deps);
        check('D 不猜成新聞：回問', r.ok === false && r.text.includes('不確定你說的是哪個網站'), r.text);
        check('D 沒有抓任何頁面', f.calls.fetchList.length === 0, f.calls.fetchList);
    }
    // E. Google 新聞 RSS：有連結，直接讀
    {
        const f = fakeDeps({ rss: true });
        const r = await D.run('看 google 新聞 颱風', f.deps);
        check('E RSS 取到 2 則，篩出颱風 1 則並摘要', r.ok === true && r.text.startsWith('今天有哪些颱風新聞：1 則') && r.text.includes('颱風逼近') && !r.text.includes('黃仁勳訪台'), r.text);
        check('E 進入點帶 RSS 關鍵字', f.calls.fetchList.length === 1 && f.calls.fetchList[0].startsWith('https://news.google.com/rss/search?q=') && f.calls.fetchList[0].includes('%E9%A2%B1%E9%A2%A8'), f.calls.fetchList);
    }
    // F. 沒有模型：每篇都是程式摘錄，合併時誠實標示
    {
        const f = fakeDeps({ noModel: true });
        const r = await D.run('看今天有哪些黃仁勳新聞', f.deps);
        check('F 全部程式摘錄時誠實標示', r.text.includes('⚠️ 這次沒有經過 AI（程式摘錄）'), r.text);
    }
    // G. 列表頁沒有文章連結：不猜、明說讀不到內文
    {
        const f = fakeDeps({ pages: { [YAHOO]: '首頁\n黃仁勳宣布新一代 AI 晶片 Blackwell 量產\n登入', [CNA]: '' } });
        const r = await D.run('看今天有哪些黃仁勳新聞', f.deps);
        check('G 沒有連結就明說，不瞎猜網址', r.ok === false && r.text.includes('沒有可讀的文章連結'), r.text);
    }
    // H2. 找到相關標題但讀不到內文：不能說成「沒有相關新聞」
    {
        const f = fakeDeps({ rss: true });
        f.deps.readArticle = async () => ({ ok: false, error: '404' });
        const r = await D.run('看 google 新聞 颱風', f.deps);
        check('H2 讀不到內文時如實說，不說沒有相關新聞', r.ok === false && r.text.includes('找到 1 則') && r.text.includes('都讀不到內文') && !r.text.includes('沒有找到'), r.text);
    }
    // H. parseRss／extractLinks 單元
    {
        const items = D.parseRss(RSS);
        check('H RSS 解析 CDATA 與實體', items.length === 2 && items[0].title === '颱風逼近 東部防強風 - 中央社' && items[1].title === '黃仁勳訪台 & 行程公布', items);
        const links = D.extractLinks('標題文字很長的新聞 ' + A1 + '\n第二則標題也夠長 ' + A2);
        check('H 列表頁網址取前面的標題', links.length === 2 && links[0].url === A1 && links[0].title.includes('標題文字'), links);
    }

    // I. 模型摘要被退回（checkExtractive）：步驟行要帶退回原因與模型原文開頭，讓 transcribe 看得出為什麼落到程式摘錄
    {
        const f = fakeDeps();
        const base = f.deps.summarize;
        f.deps.summarize = async (body, q) => Object.assign(await base(body, q), { ok: true, text: '程式摘錄：' + body.slice(0, 16), method: 'extractive', rejects: [{ reason: '有 40% 的詞來源裡沒有', raw: '模型這樣寫的一段話' }] });
        const r = await D.run('看今天有哪些黃仁勳新聞', f.deps);
        const row = f.steps.find((s) => s.includes('逐篇摘要'));
        check('I 退回時步驟行標示程式（沒經過 AI）', !!row && row.includes('程式（沒經過 AI）'), row);
        check('I 步驟行含退回原因', !!row && row.includes('退回：有 40% 的詞來源裡沒有'), row);
        check('I 步驟行含模型原文開頭', !!row && row.includes('模型原文「模型這樣寫的一段話」'), row);
        check('I 退回時最終回答標示沒有經過 AI', r.text.includes('沒有經過 AI'), r.text);
    }

    // J. 模型斷路器：第一次載入失敗後，本輪後面的文章不再叫模型（不每篇白等）
    {
        const f = fakeDeps(); let calls = 0;
        f.deps.summarize = async () => { calls++; return { ok: false, failed: true, reason: '模型載入失敗：webgpu：std::bad_alloc；wasm：Aborted()' }; };
        const r = await D.run('看今天有哪些黃仁勳新聞', f.deps);
        check('J 模型載入失敗後只叫一次模型（斷路器）', calls === 1, calls);
        check('J 其餘文章都改用程式摘要並照常回答', r.ok === true && r.articles.length === 2 && r.articles.every((a) => a.method === 'extractive'), r.articles);
        check('J 步驟行含真實原因', f.steps.some((s) => s.includes('原因：模型載入失敗：webgpu：std::bad_alloc')), f.steps);
        check('J 後續文章的步驟行說明不再重試', f.steps.some((s) => s.includes('本輪模型已失敗') && s.includes('不再重試')), f.steps);
    }
    // K. 單篇逾時：走程式摘要，本輪之後不再叫模型；整體不會卡住
    {
        const f = fakeDeps(); let calls = 0;
        f.deps.summarize = () => { calls++; return new Promise(() => {}); }; // 永遠不回
        const t0 = Date.now();
        const r = await D.run('看今天有哪些黃仁勳新聞', f.deps, { summarizeTimeoutMs: 20 });
        check('K 逾時後照常完成', r.ok === true && r.articles.length === 2, r);
        check('K 逾時不觸發斷路器：每篇各自試一次（逾時只讓那一篇走退路）', calls === 2, calls);
        check('K 步驟行含卡住原因（沒有任何進度）', f.steps.some((s) => s.includes('卡住') && s.includes('沒有任何進度')), f.steps);
        check('K 整體在幾秒內結束', Date.now() - t0 < 5000, Date.now() - t0);
    }
    // L. 程式摘要（退路）：去掉 ▲ 圖說與署名，取完整句，不從中間截斷
    {
        const S1 = '輝達（NVIDIA）於17日正式宣布，已在董事會通過新一代 AI 晶片量產計畫。';
        const S2 = '市場預期這將帶動供應鏈在明年上半年出現明顯的訂單成長。';
        const body = '▲黃仁勳在台北出席活動（資料照）\n【文／王小明】記者李四台北報導。\n' + S1 + S2 + '第三句不應該出現在摘要裡，因為已經超過兩句的上限。';
        const out = D.leadSummary(body);
        check('L 去掉 ▲ 圖說與【文／…】署名', !out.includes('▲') && !out.includes('文／') && !out.includes('資料照'), out);
        check('L 取前兩個完整句（60～120 字，句子不截斷）', out === S1 + S2, out);
        check('L 不含第三句', !out.includes('第三句'), out);
        const one = D.leadSummary('短句但夠長可以當摘要用的第一句話。第二句。');
        check('L 只有一句夠長：取那一句完整（第二句太短被略過）', one === '短句但夠長可以當摘要用的第一句話。', one);
        check('L 空內文回空字串', D.leadSummary('   ') === '', D.leadSummary('   '));
    }
    // J2. 頁首狀態：每篇都要更新「第 i／n 篇」，不能停在「準備中」
    {
        const f = fakeDeps(); const statuses = [];
        f.deps.status = (s) => statuses.push(s);
        f.deps.summarize = async (body) => ({ ok: true, text: '重點：' + body.slice(0, 10), method: 'model' });
        await D.run('看今天有哪些黃仁勳新聞', f.deps);
        check('J2 頁首狀態含「第 1／2 篇」與「第 2／2 篇」', statuses.some((s) => s.includes('第 1／2 篇')) && statuses.some((s) => s.includes('第 2／2 篇')), statuses);
        check('J2 每篇完成後頁首顯示完成與耗時', statuses.some((s) => s.includes('模型摘要完成') && s.includes('ms')), statuses);
    }
    // P. 逾時計算、活動逾時、斷路器只看明確失敗
    {
        // 活動逾時：有進度就不逾時
        let resolvedAfter = null;
        const slowButActive = (touch) => new Promise((resolve) => {
            let n = 0; const iv = setInterval(() => { touch(); n++; if (n === 5) { clearInterval(iv); resolve('ok'); } }, 30);
        });
        D.withActivityTimeout(slowButActive, 60).then((v) => { resolvedAfter = v; });
        // 完全沒有進度才逾時
        const silent = D.withActivityTimeout(() => new Promise(() => {}), 40).then(() => 'resolved', (e) => ({ timeout: e.timeout, idleMs: e.idleMs }));
        const sres = await silent;
        check('P 完全沒有進度 → 逾時（timeout=true，附 idleMs）', sres && sres.timeout === true && sres.idleMs === 40, sres);
        await new Promise((r) => setTimeout(r, 250));
        check('P 有進度（每 30 毫秒 touch）就不逾時，正常完成', resolvedAfter === 'ok', resolvedAfter);
        // 斷路器只看明確失敗
        check('P isHardFail：載入錯誤與記憶體不足', D.isHardFail('模型載入失敗：webgpu：std::bad_alloc') && D.isHardFail('out of memory'), null);
        check('P isHardFail：逾時與單純慢不算', !D.isHardFail('逾時（30 秒內沒有進度）') && !D.isHardFail('生成很慢'), null);
    }
    // R. 沒有總時間上限：慢但每 30 毫秒都有新進度，就一直等到完成（不因為總時間長而中斷）
    {
        const slowProgress = (touch) => new Promise((resolve) => { let n = 0; const iv = setInterval(() => { touch(); n++; if (n === 15) { clearInterval(iv); resolve('done'); } }, 30); });
        const v = await D.withActivityTimeout(slowProgress, 120).then((x) => x, (e) => 'ERR:' + e.message);
        check('R 慢但持續出詞元（總長 450 毫秒 > 門檻 120）不會被中斷', v === 'done', v);
    }
    // S. 真的卡死（完全沒有新進度）才中斷，並附上無進度的秒數
    {
        const stuck = await D.withActivityTimeout(() => new Promise(() => {}), 50).then(() => 'resolved', (e) => ({ timeout: e.timeout, idleMs: e.idleMs }));
        check('S 完全沒有進度才中斷（timeout=true）', stuck && stuck.timeout === true && stuck.idleMs === 50, stuck);
    }
    // T. 明確失敗才觸發斷路器；慢與逾時不算
    {
        check('T 明確失敗：載入錯誤、記憶體不足、KV 超限', D.isHardFail('模型載入失敗：std::bad_alloc') && D.isHardFail('out of memory') && D.isHardFail('KV 上限 1024：上下文太長'), null);
        check('T 慢與卡死不算明確失敗', !D.isHardFail('卡住（180 秒內沒有任何進度）') && !D.isHardFail('生成很慢，約 1 字／秒'), null);
    }
    // U. 使用者取消：取消後不再處理下一篇
    {
        const f = fakeDeps(); let calls = 0; let cancelled = false;
        f.deps.isCancelled = () => cancelled;
        f.deps.summarize = async () => { calls++; cancelled = true; return { ok: true, text: 'x', method: 'model' }; };
        const r = await D.run('看今天有哪些黃仁勳新聞', f.deps);
        check('U 取消後只做完目前這一篇，不再處理下一篇', calls === 1 && f.steps.some((s) => s.includes('使用者取消')), { calls, steps: f.steps.slice(-2) });
    }
    // Q. 逾時不觸發斷路器：第一篇逾時後，第二篇仍會叫模型（若成功就用模型摘要）
    {
        const f = fakeDeps(); let calls = 0;
        f.deps.summarize = async (body) => { calls++; if (calls === 1) return new Promise(() => {}); return { ok: true, text: '重點：' + body.slice(0, 8), method: 'model' }; };
        const r = await D.run('看今天有哪些黃仁勳新聞', f.deps, { summarizeTimeoutMs: 30 });
        check('Q 第一篇逾時後第二篇仍用模型（斷路器未觸發）', calls === 2 && r.articles[1].method === 'model', { calls, m: r.articles.map((a) => a.method) });
    }
    // N. 整輪耗時上限：超過就不再讀下一篇，步驟行說明
    {
        const f = fakeDeps(); let calls = 0;
        f.deps.summarize = async () => { calls++; return { ok: true, text: 'x', method: 'model' }; };
        await D.run('看今天有哪些黃仁勳新聞', f.deps, { roundTimeoutMs: 0 });
        check('N 沒有整輪總時間上限：兩篇都照做，步驟行沒有整輪上限', calls === 2 && !f.steps.some((s) => s.includes('整輪上限')), f.steps);
    }
    // M. 沒有實質目標詞（只有功能詞）：不比對，取前幾則
    {
        const f = fakeDeps();
        const r = await D.run('開瀏覽器看今日新聞，總結給我', f.deps);
        check('M 沒有目標詞時取前幾則（不拿功能詞比對）', r.ok === true && r.articles.length > 0, r);
        check('M 步驟行說明取前幾則', f.steps.some((s) => s.includes('沒有實質目標詞') && s.includes('取前幾則')), f.steps);
    }

    console.log(ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
