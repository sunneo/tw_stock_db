// 擴充點核心測試：node renderer/src/ext/ext_core.test.js
// 網頁內容都是固定的快照（仿照真實格式手寫），不連網路。
const X = require('./ext_core.js');
const EX = require('./examples/stock_drop_cause.json');
const R = require('../recipe/recipe_core.js');

let ok = 0; const bad = [];
function check(name, cond, info) {
    if (cond) ok++;
    else bad.push(name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 500) : ''));
}

// ---- 固定快照 ----
const TWSE_DAY = JSON.stringify({
    stat: 'OK', title: '115年11月 2001 大成鋼 各日成交資訊',
    fields: ['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌價差', '成交筆數'],
    data: [
        ['115/11/11', '1,000,000', '30,000,000', '30.10', '30.50', '29.90', '30.00', '+0.20', '900'],
        ['115/11/12', '2,345,678', '70,000,000', '30.20', '30.40', '28.80', '29.20', '-0.80', '1,500'],
    ],
});
const TWSE_T86 = JSON.stringify({
    stat: 'OK', fields: ['證券代號', '證券名稱', '外陸資買賣超股數(不含外資自營商)', '投信買賣超股數', '自營商買賣超股數'],
    data: [['2001', '大成鋼', '-500,000', '12,000', '-3,000'], ['2330', '台積電', '1,000', '0', '0']],
});
const TWSE_EMPTY = JSON.stringify({ stat: '很抱歉，沒有符合條件的資料!', fields: [], data: [] });
const RSS = '<?xml version="1.0"?><rss><channel>' +
    '<item><title>大成鋼 股價重挫 - 某財經網</title><link>https://n.example/a</link><pubDate>Thu, 12 Nov 2026 09:10:00 GMT</pubDate></item>' +
    '<item><title><![CDATA[2001 大成鋼 法說會 &amp; 產能]]></title><link>https://n.example/b</link><pubDate>Thu, 12 Nov 2026 10:00:00 GMT</pubDate></item>' +
    '<item><title>台積電 新廠動態</title><link>https://n.example/c</link><pubDate>Thu, 12 Nov 2026 08:00:00 GMT</pubDate></item>' +
    '</channel></rss>';
const LOGIN_PAGE = '<html><body><form><input type="password" name="p"></form>請先登入才能查看</body></html>';
const STOCK_PAGE_TITLE = '大成鋼(2001) 股價 - 股市網站';

(async () => {
    // ---- 格式驗證 ----
    check('example extension is valid', X.validate(EX).ok, X.validate(EX).errors);
    check('reject non-object', !X.validate(null).ok);
    const badExt = JSON.parse(JSON.stringify(EX)); badExt.tool.name = 'stock_cause'; badExt.research[0].url = 'http://insecure.example/x'; badExt.contribute.target = 'other';
    const vb = X.validate(badExt);
    check('reject: tool name without ext_, http url, unknown target', !vb.ok && vb.errors.length === 3, vb.errors);
    const noOptional = JSON.parse(JSON.stringify(EX)); noOptional.research[3].optional = false;
    check('reject: empty url must be optional', !X.validate(noOptional).ok);
    const badRe = JSON.parse(JSON.stringify(EX)); badRe.context.patterns[0].re = '([';
    check('reject: broken regex', !X.validate(badRe).ok);
    const reg = X.createRegistry();
    const lr = X.loadAll(reg, [EX, Object.assign({}, EX, { tool: { name: 'bad' } })]);
    check('registry loads valid, rejects invalid', lr.loaded.join() === 'stock_drop_cause' && lr.rejected.length === 1, lr);
    const again = X.register(reg, EX);
    check('re-register replaces, keeps order once', again.replaced === true && X.list(reg).length === 1);
    check('list enabledOnly', X.list(reg, { enabledOnly: true }).length === 1 && X.list(X.createRegistry(), {}).length === 0);
    check('remove', X.remove(reg, 'stock_drop_cause') && X.list(reg).length === 0);

    // ---- 情境偵測 ----
    const d1 = X.detectContext(EX, { url: 'https://stock.example/quote/2001', title: '', selection: '' });
    check('context: code from url path', d1.matched && d1.entities.code === '2001' && d1.entities.name === '', d1);
    const d2 = X.detectContext(EX, { url: 'https://stock.example/quote/2001', title: STOCK_PAGE_TITLE });
    check('context: name and code from title pattern', d2.matched && d2.entities.code === '2001' && d2.entities.name === '大成鋼', d2);
    const d3 = X.detectContext(EX, { url: 'https://shop.example/cart?id=2001', title: 'x' });
    check('context: url gate blocks non-stock pages', !d3.matched, d3);
    const d4 = X.detectContext(EX, { url: 'https://stock.example/home', title: '今日市場' });
    check('context: no code found', !d4.matched && /找不到/.test(d4.reason), d4);
    const d5 = X.detectContext(EX, { url: 'https://stock.example/quote/2001/abc', title: '', selection: '' });
    check('context: url code must be followed by non-digit', d5.matched && d5.entities.code === '2001', d5);
    check('resolve: args override page, page fills gaps', JSON.stringify(X.resolveEntities(EX, d2, { code: '2330' })) === '{"code":"2330","name":"大成鋼"}', X.resolveEntities(EX, d2, { code: '2330' }));
    check('resolve: bad code from args is ignored', X.resolveEntities(EX, d2, { code: 'abc' }).code === '2001');
    check('resolve: no page, no args → empty code', X.resolveEntities(EX, null, {}).code === '');

    // ---- 來源規劃 ----
    const ent = { code: '2001', name: '大成鋼' };
    const plan = X.planResearch(EX, ent, { date: '20261112' });
    check('plan: four sources, quote has date in url', plan.length === 4 && plan[0].url.indexOf('stockNo=2001') > 0 && plan[0].url.indexOf('date=20261112') > 0 && !plan[0].skipped, plan[0]);
    check('plan: news url encodes name', plan[1].url.indexOf('q=%E5%A4%A7') > 0 && plan[1].url.indexOf('2001') > 0, plan[1].url);
    check('plan: missing date skips the date sources with reason', X.planResearch(EX, ent, {})[0].skipped && /日期/.test(X.planResearch(EX, ent, {})[0].reason));
    check('plan: missing name skips news only', X.planResearch(EX, { code: '2001', name: '' }, { date: '20261112' })[1].skipped && /股票名稱/.test(X.planResearch(EX, { code: '2001', name: '' }, { date: '20261112' })[1].reason));
    check('plan: source without url is skipped as not configured', plan[3].skipped && /未設定/.test(plan[3].reason));

    // ---- 抽取 ----
    const q = X.extractSource(plan[0], TWSE_DAY, ent);
    check('extract json_rows: last row, shown fields', q.facts.length === 3 && q.facts[0].text === '收盤價：29.20' && q.facts[1].text === '漲跌價差：-0.80' && q.facts[2].text === '成交股數：2,345,678', q);
    check('extract: source carried on the result', q.source.label === '報價與成交量' && q.source.url.indexOf('twse.com.tw') > 0);
    const inst = X.extractSource(plan[2], TWSE_T86, ent);
    check('extract json_rows: match by code', inst.facts.length === 3 && inst.facts[0].text === '外陸資買賣超股數(不含外資自營商)：-500,000', inst);
    const instEmpty = X.extractSource(plan[2], TWSE_EMPTY, ent);
    check('extract: holiday / no data is explained, not invented', instEmpty.facts.length === 0 && /沒有資料列/.test(instEmpty.note), instEmpty);
    const instNoCode = X.extractSource(plan[2], TWSE_T86, { code: '9999', name: '' });
    check('extract: code not in data', instNoCode.facts.length === 0 && /找不到這檔股票/.test(instNoCode.note), instNoCode);
    const news = X.extractSource(plan[1], RSS, ent);
    check('extract rss: keeps only items that mention name or code, decodes entities', news.facts.length === 2 && news.facts[0].text.indexOf('大成鋼 股價重挫') === 0 && news.facts[1].text.indexOf('&') > 0, news.facts);
    const newsNone = X.extractSource(plan[1], RSS, { code: '1234', name: '不存在' });
    check('extract rss: nothing relevant', newsNone.facts.length === 0 && /沒有含股票名稱/.test(newsNone.note));
    const tplan = { label: '公告', url: 'https://x.example', extract: { kind: 'text', max: 3 } };
    const txt = X.extractSource(tplan, '<p>今天大成鋼公告重大訊息，股價下跌。</p><p>無關的句子在這裡，沒有公司名稱。</p>', ent);
    check('extract text: sentences with the company name only', txt.facts.length === 1 && txt.facts[0].text.indexOf('大成鋼') >= 0, txt);
    const lg = X.extractSource(plan[1], LOGIN_PAGE, ent);
    check('login page is labelled, not called "查不到"', /需要登入/.test(lg.note), lg);
    const blank = X.extractSource(plan[0], '   ', ent);
    check('blank body → failed note', /抓不到內容/.test(blank.note));

    // ---- 數字核對 ----
    const v1 = X.verifyFacts([{ text: '收盤價：29.20' }, { text: '收盤價：99.99' }], TWSE_DAY);
    check('verify: number not in source is dropped', v1.kept.length === 1 && v1.dropped === 1, v1);
    check('verify: uses checkExtractive when FaRecipe is available', typeof R.checkExtractive === 'function');
    const v2 = X.verifyFacts([{ text: '收盤價：29.20' }], TWSE_DAY);
    check('verify: thousands separators are ignored', X.verifyFacts([{ text: '成交股數：2345678' }], TWSE_DAY).kept.length === 1 && v2.kept.length === 1);

    // ---- 段落與買賣建議 ----
    const fakeResults = [
        { id: 'a', label: '報價與成交量', source: { label: '報價', url: 'https://u.example/a' }, facts: [{ text: '收盤價：29.20' }, { text: '建議買進，目標價 35' }], status: 'ok', note: '' },
        { id: 'b', label: '三大法人買賣超', source: { label: '法人', url: 'https://u.example/b' }, facts: [], status: 'empty', note: '沒有資料列' },
    ];
    const built = X.buildSections(EX, ent, fakeResults);
    check('sections: advice line removed and counted', built.adviceRemoved === 1 && built.sections[0].bullets.length === 1, built);
    check('sections: nothing found says 查不到 with reason', built.sections[1].bullets[0].text === '查不到（沒有資料列）' && built.unavailable.length === 1);
    check('sections: chapter title from template', built.title === '大成鋼（2001）下跌原因調查', built.title);

    // ---- 貢獻到簡報 ----
    const deckIn = { title: '主題', chapters: [{ title: '前言', slides: [{ title: '封面', layout: 'title' }] }] };
    const c1 = X.contributeToDeck(deckIn, built, EX);
    check('contribute: appended at end, original untouched', c1.ok && c1.deck.chapters.length === 2 && deckIn.chapters.length === 1 && c1.chapter === built.title);
    const chap = c1.deck.chapters[1];
    const last = chap.slides[chap.slides.length - 1];
    check('contribute: last slide is the disclaimer', last.title === '免責聲明' && /不構成任何投資建議/.test(last.bullets[0]), last);
    check('contribute: every content slide has a source caption', chap.slides.slice(1, -1).every((s) => /來源：/.test(s.caption)), chap.slides);
    check('contribute: slide shape follows deck format (layout, bullets ≤ 6, bullet ≤ 220)', chap.slides.every((s) => (s.layout === 'title' || s.layout === 'content') && (!s.bullets || (s.bullets.length <= 6 && s.bullets.every((b) => b.length <= 220)))));
    const c2 = X.contributeToDeck(c1.deck, built, EX);
    check('contribute: re-running replaces the same chapter (no duplicate)', c2.ok && c2.deck.chapters.length === 2);
    const many = { title: 'x', sections: [{ heading: '長', bullets: Array.from({ length: 12 }, (_, i) => ({ text: '第' + i + '項', source: { label: 's', url: '' } })) }], title: '章' };
    const c3 = X.contributeToDeck(null, many, Object.assign({}, EX, { contribute: Object.assign({}, EX.contribute, { position: 'start', maxBulletsPerSlide: 5 }) }));
    check('contribute: long section split into continued slides (5 per slide)', c3.ok && c3.deck.chapters[0].slides.filter((s) => s.layout === 'content').length === 4, c3);
    check('contribute: disclaimer without 投資 falls back to default', X.disclaimerOf({ disclaimer: '隨便寫' }) === X.DISCLAIMER_DEFAULT);

    // ---- 工具說明 ----
    const spec = X.toolSpec(EX);
    check('tool spec: name, description and optional code/name/date', spec.name === 'ext_stock_drop_cause' && spec.parametersSchema.properties.code && spec.parametersSchema.required.length === 0);

    // ---- 整條流程（固定快照）----
    const pages = {};
    pages[plan[0].url] = TWSE_DAY; pages[plan[1].url] = RSS; pages[plan[2].url] = TWSE_T86;
    const calls = [];
    const inv = await X.investigate(EX, {
        ctx: { url: 'https://stock.example/quote/2001', title: STOCK_PAGE_TITLE, selection: '' },
        args: {}, date: '20261112',
        fetchText: async (u) => { calls.push(u); return Object.prototype.hasOwnProperty.call(pages, u) ? pages[u] : null; },
    });
    check('investigate: ok, entities from page', inv.ok && inv.entities.code === '2001' && inv.entities.name === '大成鋼', inv);
    check('investigate: fetched three real sources, skipped the unconfigured one', calls.length === 3 && inv.results[3].status === 'skipped', calls);
    check('investigate: statuses', inv.results[0].status === 'ok' && inv.results[1].status === 'ok' && inv.results[2].status === 'ok', inv.results);
    check('investigate: deck contribution present and valid shape', inv.deck && inv.deck.chapters.length === 1 && inv.deck.chapters[0].slides.slice(-1)[0].title === '免責聲明', inv.deckError);
    check('investigate: unavailable lists the skipped source', inv.unavailable.length === 1 && inv.unavailable[0].id === 'announce', inv.unavailable);
    const noCode = await X.investigate(EX, { ctx: { url: 'https://stock.example/home', title: '首頁' }, fetchText: async () => null });
    check('investigate: no code → honest error', !noCode.ok && /找不到股票代號/.test(noCode.error), noCode);
    const throwing = await X.investigate(EX, { args: { code: '2001', name: '大成鋼' }, date: '20261112', fetchText: async () => { throw new Error('網路斷線'); } });
    check('investigate: fetch error becomes a failed source, not a crash', throwing.ok && throwing.results[0].status === 'failed' && /網路斷線/.test(throwing.results[0].note), throwing.results);
    check('investigate: failed sources show 查不到, never a number', throwing.sections[0].bullets[0].text.indexOf('查不到') === 0);

    console.log('ext_core: ' + ok + ' 項通過' + (bad.length ? '，' + bad.length + ' 項失敗' : '，全部通過'));
    bad.forEach((b) => console.log('FAIL ' + b));
    process.exit(bad.length ? 1 : 0);
})();
