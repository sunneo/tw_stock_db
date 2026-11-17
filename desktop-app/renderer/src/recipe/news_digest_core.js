// 新聞摘要的執行器（純函式；抓網頁與摘要都由呼叫端注入，所以 Node 測試可以用假網頁＋假模型跑完整流程）。
// 流程（逐層歸約：第 0 層取回、第 1 層逐篇讀與摘要、第 2 層合併）：
//   選來源（pickSources：說了站名用那個；說了不支援的站名就問；沒說用登錄表預設）
//   → 取清單（RSS 解析 <item>；列表頁只在文字裡有文章網址時才用）
//   → 篩選（有目標詞：goalOf＋expandTerms＋matchUnits；沒有目標詞：取前幾則）
//   → 逐篇讀內文 → 逐篇摘要（呼叫端的 summarize 一定是經過模型的路徑，或明確標示程式摘錄）
//   → 合併成「N 則」；沒有相關就明說沒有，不拿無關標題充數。
// 每一步都會呼叫 trace(line)，讓使用者看得到多輪在做什麼（輪次、階段、誰做的、參數、結果）。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./web_news_core.js'));
    else root.FaNewsDigest = factory(root.FaWebNews);
})(typeof self !== 'undefined' ? self : this, function (W) {
    'use strict';

    const decode = (s) => String(s || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
        .trim();

    // Google News 等 RSS：每個 <item> 取 <title> 與 <link>。回傳 [{title, url}]
    function parseRss(xml) {
        const out = []; const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi; let m;
        while ((m = re.exec(String(xml || '')))) {
            const body = m[1];
            const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body); const l = /<link\b[^>]*>([\s\S]*?)<\/link>/i.exec(body);
            const title = t ? decode(t[1]) : ''; const url = l ? decode(l[1]) : '';
            if (title && /^https?:\/\//.test(url)) out.push({ title, url });
        }
        return out;
    }

    // 列表頁的文字裡若含絕對網址：每個網址的標題取它前面最近的一行非網址文字。沒有網址就回傳空陣列（不猜）。
    function extractLinks(text) {
        const lines = String(text || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
        const out = []; const seen = new Set();
        lines.forEach((line, i) => {
            const u = (line.match(/https?:\/\/[^\s)\]"'<>]+/) || [])[0];
            if (!u || seen.has(u)) return;
            seen.add(u);
            let title = line.replace(u, '').replace(/[\s|｜·•-]+$/, '').trim();
            if (title.length < 6) { for (let j = i - 1; j >= 0; j--) { const p = lines[j]; if (!/https?:\/\//.test(p) && p.length >= 6) { title = p; break; } } }
            if (title.length >= 6) out.push({ title, url: u });
        });
        return out;
    }

    // 主流程。deps：
    //   fetchList(url) → { ok, text, error? }           取清單頁（RSS 或列表頁的全文）
    //   readArticle(url) → { ok, text, error? }         讀一篇內文（全文）
    //   summarize(body, question) → { ok, text, method } method：'model'｜'mixed'｜'extractive'（沒經過模型）
    //   trace(line) → void                               每一步一行（輪次、階段、誰做、參數、結果）
    // opts：{ defaultCount: 2, maxArticles: 5 }
    async function run(userText, deps, opts) {
        const o = Object.assign({ defaultCount: 2, maxArticles: 5 }, opts || {});
        const say = (s) => { try { if (deps.trace) deps.trace(s); } catch (_) { /* 顯示失敗不影響流程 */ } };
        let round = 0; const step = (stage, by, detail) => say(`第 ${++round} 輪｜${stage}｜${by}｜${detail}`);

        const pick = W.pickSources(userText, { defaultCount: o.defaultCount });
        if (pick.mode === 'ask') {
            step('選來源', '程式', '說的網站不確定：' + pick.why);
            return { handled: true, ok: false, text: '我不確定你說的是哪個網站（' + pick.why + '）。請說明，例如「yahoo 新聞」「中央社」「google 新聞」。', rounds: round, articles: [] };
        }
        step('選來源', '程式', (pick.mode === 'named' ? '站名：' + pick.alias : '沒說站名，用登錄表預設') + ' → ' + pick.sources.map((s) => s.name).join('、'));

        const goal = W.goalOf(userText);
        const terms = goal.keyword ? W.expandTerms(goal.keyword) : [];
        const topic = goal.keyword || '今天';
        step('拆字', '程式', '目標詞「' + (goal.keyword || '（無）') + '」' + (terms.length > 1 ? '，近義：' + terms.slice(1).join('、') : ''));

        const candidates = []; const seenUrl = new Set(); const checked = []; const noLinks = [];
        for (const src of pick.sources) {
            const url = W.entryFor(src, goal.keyword);
            step('取清單', '程式', src.name + ' ' + url);
            const page = await deps.fetchList(url).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
            checked.push(src.name);
            if (!page || !page.ok) { step('取清單', '程式', src.name + ' 失敗：' + ((page && page.error) || '未知')); continue; }
            const items = src.kind === 'rss' ? parseRss(page.text) : extractLinks(page.text);
            if (!items.length) { noLinks.push(src.name); step('取清單', '程式', src.name + '：頁面文字裡沒有文章連結，無法進入內文'); continue; }
            step('取清單', '程式', src.name + '：' + items.length + ' 則有連結');
            for (const it of items) if (!seenUrl.has(it.url)) { seenUrl.add(it.url); candidates.push(Object.assign({ source: src.name }, it)); }
        }

        let picked = candidates;
        if (terms.length) {
            const hits = W.matchUnits(candidates.map((c) => c.title), terms).map((h) => h.unit);
            picked = candidates.filter((c) => hits.includes(c.title));
            step('篩選', '程式', '用「' + terms.join('、') + '」比對 ' + candidates.length + ' 則 → 相關 ' + picked.length + ' 則');
        }
        picked = picked.slice(0, o.maxArticles);

        const articles = [];
        const question = terms.length ? '這篇跟「' + goal.keyword + '」有關的重點，繁體中文 1～2 句。' : '這篇的重點，繁體中文 1～2 句。';
        for (let i = 0; i < picked.length; i++) {
            const c = picked[i];
            const art = await deps.readArticle(c.url).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
            if (!art || !art.ok || !String(art.text || '').trim()) { step('讀第 ' + (i + 1) + ' 篇', '程式', '讀不到內文：' + c.title.slice(0, 30)); continue; }
            const body = String(art.text);
            step('讀第 ' + (i + 1) + ' 篇', '程式', c.url + '（' + body.length + ' 字，開頭「' + body.slice(0, 20).replace(/\s+/g, ' ') + '」）');
            const t0 = Date.now();
            const s = await deps.summarize(body, question).catch((e) => ({ ok: false, text: String((e && e.message) || e), method: 'extractive' }));
            const method = (s && s.method) || 'extractive'; const ms = Date.now() - t0;
            step('逐篇摘要', method === 'extractive' ? '程式（沒經過 AI）' : '模型', (s && s.ok ? '完成' : '失敗') + '，' + method + '，' + ms + ' ms，問「' + question.slice(0, 18) + '」，答「' + String((s && s.text) || '').replace(/\s+/g, ' ').slice(0, 24) + '」');
            articles.push({ title: c.title, source: c.source, url: c.url, summary: s && s.ok ? s.text : '（摘要失敗）', method });
        }

        step('合併', '程式', articles.length + ' 則');
        if (!articles.length && picked.length) {
            return { handled: true, ok: false, text: '找到 ' + picked.length + ' 則跟「' + goal.keyword + '」有關的標題，但都讀不到內文，我沒有摘要它們。', rounds: round, articles: [] };
        }
        if (!articles.length) {
            const why = noLinks.length && !candidates.length ? '（' + noLinks.join('、') + ' 的頁面沒有可讀的文章連結，我沒有進去看內文）' : '';
            const text = terms.length
                ? '查了' + checked.join('、') + '，沒有找到跟「' + goal.keyword + '」有關的新聞。我不拿不相關的標題充數。' + why
                : '查了' + checked.join('、') + '，沒有可以讀的文章。' + why;
            return { handled: true, ok: false, text, rounds: round, articles: [] };
        }
        const allExtractive = articles.every((a) => a.method === 'extractive');
        const head = (terms.length ? '今天有哪些' + goal.keyword + '新聞：' : '今天的新聞摘要：') + articles.length + ' 則（來源：' + checked.join('、') + '）' + (allExtractive ? '\n⚠️ 這次沒有經過 AI（程式摘錄）' : '');
        const lines = articles.map((a, i) => (i + 1) + '. ' + a.title + '（' + a.source + '）\n   ' + a.summary.replace(/\s+/g, ' ').trim());
        return { handled: true, ok: true, text: head + '\n\n' + lines.join('\n'), rounds: round, articles };
    }

    return { parseRss, extractLinks, run };
});
