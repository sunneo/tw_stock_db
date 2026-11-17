// 網頁新聞的確定性核心（純函式、無 DOM、無 I/O；UMD，Node 與瀏覽器都能載入）。
// 三件事都是程式做，不叫模型猜：
//   1) 來源登錄表（SOURCES，純資料）＋站名別名（resolveSite）：「去 yahoo」「看中央社」→ 進入點
//   2) 拆字：使用者的話去掉功能詞，抽出目標詞（goalOf），展開近義（expandTerms）
//   3) 頁面文字切成單位（splitPage），再逐單位比對目標詞（matchUnits）
// 設計見 desktop-app/DESIGN.plan-template.md §2.2、§2.3。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaWebNews = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // 來源登錄表。欄位：id、名稱、語言、進入點（列表頁）或 RSS 樣板（{q} 是關鍵字槽）、可靠度（0～1）、預設順序（越小越先）、別名（小寫比對）。
    // 別名只放「明確指到這一家」的字；歧義字（如只有「奇摩」）放在 UNSUPPORTED，讓程式回報「不確定」而不是猜。
    const SOURCES = [
        { id: 'yahoo_tw_news', name: 'Yahoo 新聞（台灣）', lang: 'zh-TW', kind: 'list', entry: 'https://tw.news.yahoo.com/', reliability: 0.8, order: 1,
            aliases: ['yahoo新聞', 'yahoo 新聞', 'yahoo奇摩新聞', '奇摩新聞', '雅虎新聞', 'yahoo'] },
        { id: 'cna', name: '中央社', lang: 'zh-TW', kind: 'list', entry: 'https://www.cna.com.tw/', reliability: 0.9, order: 2,
            aliases: ['中央社', 'cna'] },
        { id: 'udn', name: '聯合新聞網', lang: 'zh-TW', kind: 'list', entry: 'https://udn.com/', reliability: 0.8, order: 3,
            aliases: ['聯合新聞網', '聯合報', 'udn'] },
        { id: 'ltn', name: '自由時報', lang: 'zh-TW', kind: 'list', entry: 'https://news.ltn.com.tw/', reliability: 0.8, order: 4,
            aliases: ['自由時報', 'ltn'] },
        { id: 'pts', name: '公視新聞網', lang: 'zh-TW', kind: 'list', entry: 'https://news.pts.org.tw/', reliability: 0.85, order: 5,
            aliases: ['公視新聞', '公視'] },
        { id: 'google_news_tw', name: 'Google 新聞（搜尋 RSS）', lang: 'zh-TW', kind: 'rss', entry: 'https://news.google.com/rss/search?q={q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', reliability: 0.75, order: 6,
            aliases: ['google新聞', 'google 新聞', '谷歌新聞', 'google news'] },
    ];

    // 明確不支援的說法：程式回報「不確定是哪一個」，不自動換成別的站（例：yahoo 股市不是新聞）。
    const UNSUPPORTED = [
        { alias: 'yahoo股市', why: 'yahoo 股市不在來源登錄表內' },
        { alias: '奇摩股市', why: '奇摩股市不在來源登錄表內' },
        { alias: '奇摩', why: '「奇摩」單獨出現不確定是哪一個 Yahoo 服務' },
    ];

    // 近義展開（目標詞 → 相關詞）。資料層，可擴充；比對時不分大小寫。
    const SYNONYMS = {
        '黃仁勳': ['Jensen Huang', 'Jensen', '黃仁勳', '輝達', 'NVIDIA'],
        '輝達': ['NVIDIA', 'Nvidia', '輝達', '黃仁勳', 'Jensen Huang'],
    };

    // 功能詞：拆字時去掉（只用來找目標詞，不影響站名與關鍵字本身）。較長的先去。
    // 分三類：問法（有沒有、今天）、動作（看、開瀏覽器、查）、輸出要求（總結給我、摘要、整理、告訴我）。
    const FUNCTION_WORDS = [
        // 問法與時間
        '有沒有', '有哪些', '有什麼', '今天的', '今天有', '今天', '今日的', '今日', '最新的', '最新', '最近', '一下', '哪些', '有無', '新聞', '文章', '消息',
        // 動作（含工具名：瀏覽器、網站）
        '幫我看', '請幫我', '幫我', '幫忙', '看看', '打開', '瀏覽器', '網站', '網頁', '頁面', '上網', '開', '看', '去', '進', '查', '找', '要',
        // 輸出要求
        '總結給我', '總結給', '總結', '摘要給我', '摘要', '整理給我', '整理', '告訴我', '告訴', '給我', '給', '重點',
        // 單字虛詞（最後才去，避免先吃掉詞中的字）
        '的', '嗎', '呢', '請', '我', '在', '有',
    ];
    const ASK_EXIST = /有沒有|有無/;

    const norm = (s) => String(s == null ? '' : s).normalize('NFKC').toLowerCase().trim();
    // 比對用：忽略所有空白（「yahoo 股市」「yahoo股市」視為同一個說法）
    const squash = (s) => norm(s).replace(/\s+/g, '');
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 別名的正規表示式：字與字之間允許任意空白
    const aliasRe = (a) => new RegExp(squash(a).split('').map(escRe).join('\\s*'), 'g');

    // 站名：先比對不支援的說法（較長的先），再比對登錄表別名（較長的先）。回傳 { source, alias } | { unsupported, why } | null。
    function resolveSite(text) {
        const t = squash(text);
        const hits = [];
        for (const u of UNSUPPORTED) { const i = t.indexOf(squash(u.alias)); if (i >= 0) hits.push({ at: i, len: squash(u.alias).length, unsupported: u.alias, why: u.why }); }
        for (const s of SOURCES) for (const a of s.aliases) { const i = t.indexOf(squash(a)); if (i >= 0) hits.push({ at: i, len: squash(a).length, source: s, alias: a }); }
        if (!hits.length) return null;
        // 同一段文字裡，較長的別名優先（yahoo股市 > yahoo）；長度相同取出現較早的
        hits.sort((x, y) => (y.len - x.len) || (x.at - y.at));
        const best = hits[0];
        if (best.unsupported) return { unsupported: best.unsupported, why: best.why };
        return { source: best.source, alias: best.alias };
    }

    // 決定要用哪些來源：說了站名就只用那一個；說了不支援的 → ask（問使用者）；沒說 → 登錄表預設（依 order，取前 n 個）
    function pickSources(text, opts) {
        const n = (opts && opts.defaultCount) || 2;
        const site = resolveSite(text);
        if (site && site.unsupported) return { mode: 'ask', why: site.why, sources: [] };
        if (site && site.source) return { mode: 'named', sources: [site.source], alias: site.alias };
        const sorted = SOURCES.filter((s) => s.kind === 'list').slice().sort((a, b) => a.order - b.order);
        return { mode: 'default', sources: sorted.slice(0, n) };
    }

    // 進入點：列表型用 entry；RSS 型把關鍵字放進 {q}（encodeURIComponent）
    function entryFor(source, keyword) {
        if (source.kind === 'rss') return source.entry.replace('{q}', encodeURIComponent(keyword || ''));
        return source.entry;
    }

    // 拆字：去掉站名、功能詞，剩下的就是目標詞（可能有好幾個，用空白隔開；keywords 是陣列）。askExist 表示使用者問「有沒有」。
    // 去完功能詞沒有實質詞 → keyword 為空字串，呼叫端改成「取前幾則」，不拿功能詞去比對。
    function goalOf(text) {
        const raw = String(text == null ? '' : text);
        let t = norm(raw);
        const askExist = ASK_EXIST.test(t);
        const site = resolveSite(raw);
        const kill = [];
        if (site && site.alias) kill.push(site.alias);
        if (site && site.unsupported) kill.push(site.unsupported);
        for (const k of kill) t = t.replace(aliasRe(k), ' ');
        for (const w of FUNCTION_WORDS.slice().sort((a, b) => b.length - a.length)) t = t.split(norm(w)).join(' ');
        const keywords = t.replace(/[\s，,。.！!？?、:：;；"'「」『』()（）\[\]【】]+/g, ' ').trim().split(' ').filter((w) => w.length > 0);
        return { keyword: keywords.join(' '), keywords, askExist, site: site && site.source ? site.source.id : null };
    }

    // 近義展開：每個目標詞本身排前面，再加登錄的近義（不分大小寫去重）。keyword 可以是字串（空白分開）或陣列。
    // 多個目標詞之間是「任一命中」，所以這裡只是把它們攤平成一張詞表，不做整串比對。
    function expandTerms(keyword, synonyms) {
        const table = synonyms || SYNONYMS;
        const tokens = Array.isArray(keyword) ? keyword : String(keyword == null ? '' : keyword).split(/\s+/);
        const out = []; const seen = new Set();
        const add = (x) => { const k = norm(x); if (k && !seen.has(k)) { seen.add(k); out.push(String(x).trim()); } };
        for (const tok of tokens) {
            if (!norm(tok)) continue;
            add(tok);
            const key = Object.keys(table).find((k) => norm(k) === norm(tok));
            if (key) table[key].forEach(add);
        }
        return out;
    }

    // 頁面文字切成單位：一行一則；去掉太短、太長、導覽列、時間戳、純數字、重複的行
    const NOISE = [/^\S{0,16}[•·]\s*\d+\s*(?:秒|分鐘|分|小時|天|週|周|月)前$/, /^[\d\s:：\-\/.,]+$/, /^(?:登入|註冊|首頁|更多|搜尋|選單|廣告|分享|訂閱|回到頂端|關於|隱私|服務條款|新聞熱搜)/, /^\d+\s*(?:秒|分鐘|小時|天)前(?:更新)?$/];
    function splitPage(text) {
        const lines = String(text == null ? '' : text).split(/\n+/).map((x) => x.trim()).filter(Boolean);
        const seen = new Set(); const units = [];
        for (const l of lines) {
            if (l.length < 6 || l.length > 140) continue;
            if (NOISE.some((re) => re.test(l))) continue;
            if (seen.has(l)) continue; seen.add(l); units.push(l);
        }
        return units;
    }

    // 逐單位比對：任一近義詞出現在單位裡就算命中（不分大小寫）；回傳命中的單位與命中的詞，依頁面順序
    function matchUnits(units, terms) {
        const ts = (terms || []).map(norm).filter(Boolean);
        const hits = [];
        for (const u of units || []) {
            const nu = norm(u);
            const term = ts.find((x) => nu.includes(x));
            if (term) hits.push({ unit: u, term });
        }
        return hits;
    }

    return { SOURCES, UNSUPPORTED, SYNONYMS, resolveSite, pickSources, entryFor, goalOf, expandTerms, splitPage, matchUnits };
});
