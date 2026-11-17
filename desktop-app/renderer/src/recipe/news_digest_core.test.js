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
        check('A 讀的是相關的 2 篇（不讀天氣）', JSON.stringify(f.calls.readArticle) === JSON.stringify([A1, A2]), f.calls.readArticle);
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

    console.log(ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
