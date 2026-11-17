// node renderer/src/recipe/web_news_core.test.js
// 來源登錄表、站名別名、拆字、頁面切單位、比對：全是純函式，用使用者提過的說法驗。
const W = require('./web_news_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };

// ---- 站名別名 ----
{
    const a = W.resolveSite('去 yahoo 看黃仁勳的新聞');
    check('去 yahoo → 新聞首頁來源（不是 yahoo 首頁）', a && a.source && a.source.id === 'yahoo_tw_news' && a.source.entry === 'https://tw.news.yahoo.com/', a);
    const b = W.resolveSite('看 yahoo 股市');
    check('yahoo 股市 → 不支援，不猜成新聞', b && b.unsupported === 'yahoo股市' && !b.source, b);
    const c = W.resolveSite('看奇摩股市');
    check('奇摩股市 → 不支援', c && c.unsupported === '奇摩股市', c);
    const d = W.resolveSite('看奇摩');
    check('單獨「奇摩」→ 不確定，不猜', d && d.unsupported === '奇摩', d);
    const e = W.resolveSite('看奇摩新聞');
    check('奇摩新聞 → Yahoo 新聞（長別名優先，不被「奇摩」截走）', e && e.source && e.source.id === 'yahoo_tw_news', e);
    const f = W.resolveSite('看中央社');
    check('中央社 → cna', f && f.source && f.source.id === 'cna', f);
    const g = W.resolveSite('看 google 新聞 黃仁勳');
    check('google 新聞 → Google RSS 來源', g && g.source && g.source.id === 'google_news_tw', g);
    check('沒有站名 → null', W.resolveSite('看今天有哪些黃仁勳新聞') === null);
}

// ---- 來源挑選 ----
{
    const named = W.pickSources('看 中央社 的黃仁勳新聞');
    check('說了站名 → 只用那一個', named.mode === 'named' && named.sources.length === 1 && named.sources[0].id === 'cna', named);
    const ask = W.pickSources('看 yahoo 股市 的黃仁勳新聞');
    check('說了不支援的站名 → ask（問使用者）', ask.mode === 'ask' && ask.sources.length === 0, ask);
    const def = W.pickSources('看今天有哪些黃仁勳新聞', { defaultCount: 2 });
    check('沒說站名 → 登錄表預設前兩個（依 order）', def.mode === 'default' && def.sources.map((s) => s.id).join(',') === 'yahoo_tw_news,cna', def);
    const rss = W.entryFor(W.SOURCES.find((s) => s.id === 'google_news_tw'), '黃仁勳');
    check('RSS 進入點把關鍵字 URL 編碼放進 {q}', rss.startsWith('https://news.google.com/rss/search?q=%E9%BB%83') && rss.includes('hl=zh-TW'), rss);
}

// ---- 拆字 ----
{
    const a = W.goalOf('看今天有哪些黃仁勳新聞');
    check('看今天有哪些黃仁勳新聞 → 目標詞 黃仁勳', a.keyword === '黃仁勳' && !a.askExist, a);
    const b = W.goalOf('去 yahoo 看黃仁勳的新聞');
    check('去 yahoo 看黃仁勳的新聞 → 黃仁勳＋站點 yahoo_tw_news', b.keyword === '黃仁勳' && b.site === 'yahoo_tw_news', b);
    const c = W.goalOf('看 yahoo 新聞有沒有颱風');
    check('看 yahoo 新聞有沒有颱風 → 颱風＋問有沒有', c.keyword === '颱風' && c.askExist === true && c.site === 'yahoo_tw_news', c);
    const terms = W.expandTerms('黃仁勳');
    check('近義展開：黃仁勳 → Jensen Huang、輝達、NVIDIA', terms[0] === '黃仁勳' && terms.includes('Jensen Huang') && terms.includes('NVIDIA'), terms);
}

// ---- 頁面切單位（去導覽列、時間戳、重複）----
const PAGE = [
    '首頁',
    '登入',
    '2 小時前',
    '黃仁勳宣布新一代 AI 晶片 Blackwell 量產',
    '黃仁勳宣布新一代 AI 晶片 Blackwell 量產',
    '輝達股價盤中創高 Jensen Huang：AI 需求仍強',
    '今天天氣晴朗，午後偶有陣雨',
    '2026-11-17 10:20',
    '更多',
].join('\n');
{
    const units = W.splitPage(PAGE);
    check('切單位：去掉導覽列、時間戳、重複', units.length === 3 && units.every((u) => u.length >= 6), units);
    check('切單位：保留新聞標題', units.some((u) => u.includes('Blackwell')) && units.some((u) => u.includes('Jensen Huang')), units);
}

// ---- 端到端：目標詞 → 近義 → 比對 ----
{
    const units = W.splitPage(PAGE);
    const g = W.goalOf('看今天有哪些黃仁勳新聞');
    const hits = W.matchUnits(units, W.expandTerms(g.keyword));
    check('黃仁勳：比對到 2 則（中文標題＋英文近義 Jensen Huang）', hits.length === 2, hits);
    check('黃仁勳：不拿天氣標題充數', !hits.some((h) => h.unit.includes('天氣')), hits);
    const g2 = W.goalOf('看 yahoo 新聞有沒有颱風');
    const hits2 = W.matchUnits(units, W.expandTerms(g2.keyword));
    check('颱風：沒有相關新聞 → 0 則（明說沒有，不充數）', hits2.length === 0, hits2);
}

console.log(ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
