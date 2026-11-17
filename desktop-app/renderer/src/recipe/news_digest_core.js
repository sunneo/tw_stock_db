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

    // 程式摘要（退路：沒有模型、模型失敗或逾時）：取前 1～2 個完整句，約 60～120 字，絕不從句子中間截斷。
    // 先去掉：▲ 圖說（有正文時整行不用）、開頭的【文／某某】「記者某某報導」這類署名句。
    const SIG_RE = /記者|報導|撰文|編譯|攝影|文\s*[／\/]/;
    function leadSummary(body) {
        let lines = String(body || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
        const prose = lines.filter((l) => !/^[▲△►▶]/.test(l));
        lines = (prose.length ? prose : lines).map((l) => l.replace(/^[▲△►▶]\s*/, ''));
        const sents = lines.join('').split(/(?<=[。！？!?])/).map((s) => s.trim()).filter((s) => s.length >= 6);
        const body2 = []; // 署名句只在最前面幾句拿掉（正文裡提到「記者」的句子不是署名）
        sents.forEach((s, i) => {
            const t = s.replace(/^【[^】]{0,40}】\s*/, '').replace(/^「文[／\/][^」]{0,30}」\s*/, '');
            if (i < 2 && t.length <= 40 && SIG_RE.test(t)) return;
            if (t.length >= 6) body2.push(t);
        });
        const picked = []; let len = 0;
        for (const s of body2) {
            if (picked.length >= 2) break;
            if (picked.length && len + s.length > 120) break;
            picked.push(s); len += s.length;
            if (len >= 60) break;
        }
        if (!picked.length) return '';
        let out = picked.join('');
        if (out.length > 160) { // 第一句就超長：只在逗號／分號這種子句邊界切，找不到就整句保留（不硬切）
            const cut = Math.max(out.lastIndexOf('，', 140), out.lastIndexOf('；', 140), out.lastIndexOf('、', 140));
            if (cut >= 60) out = out.slice(0, cut + 1);
        }
        return out;
    }

    // 目標詞命中的數量（標題裡含越多目標詞，越排前面）
    function hitCount(title, terms) {
        const nt = String(title || '').normalize('NFKC').toLowerCase();
        return terms.filter((t) => nt.includes(String(t).normalize('NFKC').toLowerCase())).length;
    }
    // 預算（毫秒）：模型尚未載入＝冷啟動，給數分鐘；已載入＝依提示長度與測得速度估，至少 60 秒、估計的 3 倍。
    // 估算只用已知的速度（預填每秒詞元 prefillTps、生成每秒詞元 genTps）；沒有測過就用保守值。
    function budgetMs(p) {
        const o = p || {};
        if (!o.loaded) return Math.max(60000, o.coldMs || 300000);
        const pre = (o.promptTokens || 0) / Math.max(1, o.prefillTps || 40);
        const gen = (o.maxNew || 200) / Math.max(0.5, o.genTps || 4);
        return Math.max(60000, Math.ceil((pre + gen) * 3 * 1000));
    }
    // 活動逾時：只有「整段時間內都沒有任何進度」才算逾時；每次 touch()（載入進度、新詞元）就重新計時。
    // 逾時的錯誤帶 timeout=true 與 idleMs，呼叫端據此記錄，不把它當成模型壞掉。
    function withActivityTimeout(start, ms) {
        return new Promise((resolve, reject) => {
            let timer = null; let done = false;
            const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { if (done) return; done = true; const e = new Error('逾時：' + ms + ' ms 內沒有任何進度'); e.timeout = true; e.idleMs = ms; reject(e); }, ms); };
            const finish = (fn, v) => { if (done) return; done = true; if (timer) clearTimeout(timer); fn(v); };
            arm();
            let p; try { p = start(arm); } catch (e) { finish(reject, e); return; }
            Promise.resolve(p).then((v) => finish(resolve, v), (e) => finish(reject, e));
        });
    }
    // 斷路器只在「明確失敗」才觸發（載入錯誤、記憶體不足）；單純慢或逾時不算。
    const HARD_FAIL_RE = /載入|bad_alloc|記憶體|memory|out of|Aborted|create a session|OOM/i;
    const isHardFail = (reason) => HARD_FAIL_RE.test(String(reason || ''));

    // 主流程。deps：
    //   fetchList(url) → { ok, text, error? }           取清單頁（RSS 或列表頁的全文）
    //   readArticle(url) → { ok, text, error? }         讀一篇內文（全文）
    //   summarize(body, question) → { ok, text, method } method：'model'｜'mixed'｜'extractive'（沒經過模型）
    //   trace(line) → void                               每一步一行（輪次、階段、誰做、參數、結果）
    // opts：{ defaultCount: 2, maxArticles: 5, summarizeTimeoutMs: 30000 }
    // 模型斷路器：本輪第一次摘要失敗（模型載入失敗、呼叫失敗或單篇逾時）後，後面的文章不再叫模型，直接用程式摘要，不每篇白等。
    async function run(userText, deps, opts) {
        const o = Object.assign({ defaultCount: 2, maxArticles: 5, summarizeTimeoutMs: 300000, roundTimeoutMs: 600000 }, opts || {});
        const roundDeadline = Date.now() + o.roundTimeoutMs; // 整輪耗時上限：超過就不再讀下一篇，已摘要的照常回答
        const say = (s) => { try { if (deps.trace) deps.trace(s); } catch (_) { /* 顯示失敗不影響流程 */ } };
    // 頁首狀態（進度卡片的 status）：第 i／n 篇、目前在做什麼；deps.status 可省略
    const status = (s) => { try { if (deps.status) deps.status(s); } catch (_) { /* 顯示失敗不影響流程 */ } };
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
            picked.sort((a, b) => hitCount(b.title, terms) - hitCount(a.title, terms)); // 命中越多詞越前面（同分保留頁面順序）
            step('篩選', '程式', '用「' + terms.join('、') + '」任一命中比對 ' + candidates.length + ' 則 → 相關 ' + picked.length + ' 則');
        } else {
            step('篩選', '程式', '沒有實質目標詞，不比對，取前幾則');
        }
        picked = picked.slice(0, o.maxArticles);

        const articles = [];
        const question = terms.length ? '這篇跟「' + goal.keyword + '」有關的重點，繁體中文 1～2 句。' : '這篇的重點，繁體中文 1～2 句。';
        let modelDown = ''; // 斷路器：第一次模型失敗的真實原因；有值之後本輪不再叫模型
        for (let i = 0; i < picked.length; i++) {
            const c = picked[i];
            if (Date.now() > roundDeadline) { step('整輪上限', '程式', '已超過整輪耗時上限 ' + o.roundTimeoutMs + ' ms，之後的 ' + (picked.length - i) + ' 篇不再處理'); break; }
            status('第 ' + (i + 1) + '／' + picked.length + ' 篇：讀內文中');
            const art = await deps.readArticle(c.url).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
            if (!art || !art.ok || !String(art.text || '').trim()) { step('讀第 ' + (i + 1) + ' 篇', '程式', '讀不到內文：' + c.title.slice(0, 30) + '（' + ((art && art.error) || '沒有內文') + '）'); continue; }
            const body = String(art.text);
            step('讀第 ' + (i + 1) + ' 篇', '程式', c.url + '（' + body.length + ' 字，開頭「' + body.slice(0, 20).replace(/\s+/g, ' ') + '」）');
            const t0 = Date.now();
            let s = null;
            status('第 ' + (i + 1) + '／' + picked.length + ' 篇：摘要中' + (modelDown ? '（程式摘要）' : '（模型）'));
            if (modelDown) s = { ok: false, skipped: true };
            else {
                const ms = deps.budgetMs ? deps.budgetMs(body, question) : o.summarizeTimeoutMs;
                const stageAtStart = deps.stage ? deps.stage() : '';
                try { s = await withActivityTimeout((touch) => deps.summarize(body, question, { touch }), ms); }
                catch (e) {
                    const st = deps.stage ? deps.stage() : '';
                    if (e && e.timeout) { s = { ok: false, failed: true, timedOut: true, reason: '逾時（' + Math.round(e.idleMs / 1000) + ' 秒內沒有進度；卡在「' + (st || stageAtStart || '未知') + '」）', stage: st || stageAtStart }; }
                    else s = { ok: false, failed: true, reason: 'summarize 失敗：' + String((e && e.message) || e) };
                }
            }
            const modelErr = s && !s.skipped && (s.failed ? s.reason : ((s.rejects || []).find((r) => /模型呼叫失敗/.test(String(r.reason))) || {}).reason);
            // 斷路器：只有明確失敗（載入錯誤、記憶體不足）才停用模型；逾時或單純慢，只讓這一篇走退路
            if (modelErr && !modelDown && isHardFail(modelErr)) modelDown = String(modelErr);
            const usedModel = !!(s && s.ok && !s.skipped && s.method && s.method !== 'extractive');
            // 退路：沒有模型或模型失敗 → 程式取前 1～2 句（完整句，不硬切）
            const summary = usedModel ? String(s.text || '') : (leadSummary(body) || '（沒有可讀的句子）');
            const method = usedModel ? s.method : 'extractive';
            const ms = Date.now() - t0;
            const rj = (s && s.rejects && s.rejects[0]) || null; // 模型的摘要被退回時，把第一個退回原因與原始輸出開頭放進步驟行（診斷用）
            const why = s && s.skipped ? '｜本輪模型已失敗（' + modelDown.slice(0, 200) + '），不再重試' : (modelErr ? '｜原因：' + String(modelErr).slice(0, 200) : (rj ? '｜退回：' + rj.reason + '，模型原文「' + String(rj.raw || '').replace(/\s+/g, ' ').slice(0, 60) + '」' : ''));
            step('逐篇摘要', method === 'extractive' ? '程式（沒經過 AI）' : '模型', (usedModel ? '完成' : '退回程式摘要') + '，' + method + '，' + ms + ' ms' + why + '，問「' + question.slice(0, 18) + '」，答「' + summary.replace(/\s+/g, ' ').slice(0, 120) + '」');
            status('第 ' + (i + 1) + '／' + picked.length + ' 篇：' + (usedModel ? '模型摘要完成' : '程式摘要') + '，' + ms + ' ms');
            articles.push({ title: c.title, source: c.source, url: c.url, summary, method });
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

    return { parseRss, extractLinks, leadSummary, budgetMs, withActivityTimeout, isHardFail, run };
});
