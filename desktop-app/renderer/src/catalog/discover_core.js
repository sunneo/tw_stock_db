/* 缺口驅動的探索迴圈（UMD，純函式＋注入的主機函式）：需求（UML 使用案例）→ 接線 → 找出『沒有單元可用』的缺口 → 為每個缺口產生搜尋關鍵字 →
 * 搜尋（wiki、GitHub、SourceForge、CodeProject、StackOverflow…）→ 讀 README／說明（地圖縮放＋多片段投票，見 card_core.js）→ 整理成能力卡片 →
 * 依缺口排名挑最合適的專案 → （可選）抽取成單元再接一次線 → 直到沒有缺口、沒有進展或用完預算 → 產出計畫。
 * 每一步先用程式；模型只是可注入的『多投一票』（host.vote）。搜尋、下載、抽取、執行都由主機函式注入（host.search／fetchText／onboard／tryRun），
 * 所以這個檔案可以用假的主機完整測試。出錯時 classifyError 把錯誤訊息歸類成『下一步該做什麼』，nextAttempt 避免重複同樣的失敗。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./card_core.js'), require('./select_core.js'));
    else root.FaCatalogDiscover = factory(root.FaCatalogCard || (typeof FaCatalogCard !== 'undefined' ? FaCatalogCard : undefined), root.FaCatalogSelect || (typeof FaCatalogSelect !== 'undefined' ? FaCatalogSelect : undefined));
})(typeof self !== 'undefined' ? self : this, function (Card, SEL) {
    'use strict';
    const snake = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    const words = (s) => snake(s).split('_').filter((w) => w.length > 1);

    // ===== 中文需求詞 → 搜尋用的英文 =====
    const GLOSSARY = { '拍貼機': 'photo booth', '拍貼': 'photo booth', '美顏': 'face beautify skin smoothing', '磨皮': 'skin smoothing', '相機': 'camera', '攝影機': 'webcam camera', '鏡頭': 'webcam', '人臉': 'face detection', '臉部': 'face', '濾鏡': 'image filter', '照片': 'photo image', '圖片': 'image', '影片': 'video', '音訊': 'audio', '字幕': 'subtitle', '轉檔': 'convert', '轉換': 'convert', '合併': 'merge', '合成': 'merge combine compose', '壓縮': 'compress', '縮放': 'resize', '裁切': 'crop', '旋轉': 'rotate', '條碼': 'barcode', '二維碼': 'qr code', 'QR': 'qr code', '圖表': 'chart', '表格': 'table spreadsheet', '試算表': 'spreadsheet', '文件': 'document', '簡報': 'presentation slides', '語音': 'speech', '辨識': 'recognition recognize detect', '偵測': 'detection', '追蹤': 'tracking', '貼紙': 'sticker overlay', '列印': 'print', '下載': 'download', '上傳': 'upload', '瀏覽器': 'browser', '網頁': 'web page', '動畫': 'animation', '三維': '3d', '3D': '3d', '地圖': 'map', '時間': 'date time', '加密': 'encrypt', '搜尋': 'search', '爬蟲': 'scraper crawler', '解析': 'parse', '壓縮檔': 'zip archive', '錄影': 'video recording', '錄音': 'audio recording', '截圖': 'screenshot', '擷取': 'capture grab', '抓取': 'capture grab fetch', '截取': 'capture grab', '拼貼': 'collage', '邊框': 'frame border', '背景移除': 'background removal', '去背': 'background removal', '畫成': 'plot draw', '畫出': 'plot draw', '繪製': 'plot draw', '畫面': 'frame screen video frame', '長條圖': 'chart bar', '折線圖': 'line chart', '圓餅圖': 'pie chart', '資料': 'data', '讀取': 'read parse', '寫入': 'write export', '匯出': 'export', '匯入': 'import', '檔案': 'file', 'Excel': 'excel xlsx spreadsheet', 'CSV': 'csv', 'PDF': 'pdf', 'JSON': 'json', 'XML': 'xml', '大小': 'size resize', '調整': 'adjust resize', '圖形': 'graphics', '視覺化': 'visualization', '編輯': 'editor edit', '播放': 'player play', '影音': 'media', '串流': 'stream', '通知': 'notification', '郵件': 'email', '登入': 'login authentication', '資料庫': 'database', '排程': 'scheduler cron', '產生': 'generate', '生成': 'generate', '掃描': 'scan read decode', '手勢': 'gesture', '姿勢': 'pose estimation', '表情': 'facial expression', '年齡': 'age', '翻譯': 'translate', '文字轉語音': 'text to speech', '語音轉文字': 'speech to text', '手機': 'mobile', '遊戲': 'game', '拖曳': 'drag drop', '表單': 'form', '驗證': 'validation', '日期': 'date', '壓縮圖片': 'image compress' };
    function toEnglish(text) { let out = String(text || ''); const found = []; const groups = []; for (const k of Object.keys(GLOSSARY).sort((a, b) => b.length - a.length)) if (out.includes(k)) { found.push(GLOSSARY[k]); groups.push(GLOSSARY[k].split(/\s+/)); out = out.split(k).join(' '); } return { english: found.join(' '), groups, rest: out.replace(/[㐀-鿿，。、；：！？（）]+/g, ' ').replace(/\s+/g, ' ').trim() }; }

    // ===== 從接線結果找缺口 =====
    // bindResult：catalog_bind 的結果（results[].steps／issues）；回傳 [{ id, usecase, step, op, cls, params, returns, issues }]
    function gapsFrom(bind) {
        const out = []; for (const r of (bind && bind.results) || []) for (const s of r.steps || []) { if (s.unit || (s.units && s.units.length)) continue; const m = /^([^.]+)\.(.+)$/.exec(s.step || ''); out.push({ id: r.usecase + '/' + s.step, usecase: r.usecase, step: s.step, cls: m ? m[1] : '', op: m ? m[2] : s.step, params: s.op_params || [], returns: s.returns || 'any', text: ((m ? m[1] : '') + ' ' + (m ? m[2] : s.step)).trim() }); }
        return out;
    }
    // 沒有 UML、只有一串需要的能力（['擷取相機畫面', '美顏', '存成圖片']）時，每條當一個缺口
    function gapsFromNeeds(needs) { return (needs || []).map((n, i) => ({ id: 'need/' + i, usecase: 'need', step: String(n), op: String(n), cls: '', params: [], returns: 'any', text: String(n) })); }

    // 網址 → 種類。project＝可以採用的專案頁（GitHub 倉庫、SourceForge 專案、一般說明頁）；wiki／qa／article＝參考資料（了解概念、看別人怎麼做），不拿來當採用對象
    function kindOf(url) { const u = String(url || ''); if (/wikipedia\.org|\/wiki\/|wikimedia|deepwiki/i.test(u)) return 'wiki'; if (/stackoverflow\.com|stackexchange\.com|superuser\.com|askubuntu\.com/i.test(u)) return 'qa'; if (/codeproject\.com/i.test(u)) return 'article'; return 'project'; }

    // ===== 搜尋關鍵字 =====
    // 產生 3 組：功能描述＋library、功能描述＋執行環境、替代說法；來源提示（github、npm、pypi…）放在 sources
    // GitHub 這類搜尋是『每個字都要出現』，字一多就一筆都搜不到（實測：「pdf image pdf library」0 筆，「pdf image library javascript」有十筆好的）。
    // 所以每組只放 2～3 個最有代表性的字，加上語言；依概念組輪流組成，最多 3 組。
    function queriesFor(gap, opts) {
        opts = opts || {}; const env = opts.runtime || 'browser'; const lang = env === 'python' ? 'python' : 'javascript'; const groups = conceptGroups(gap, opts.context).filter((g) => g.length); const dedupe = (ws) => Array.from(new Set(ws));
        const spec = groups.map((g) => { const sp = g.filter((w) => !GENERIC.has(w)); return sp.length ? sp : g; }); const q = [];
        if (spec.length) {
            q.push(dedupe(spec.slice(0, 2).map((g) => g[0])).concat([lang]).join(' ')); // 前兩個概念各一個字
            q.push(dedupe(spec[0].slice(0, 2).concat(spec[1] ? [spec[1][0]] : [])).concat([lang]).join(' ')); // 第一個概念的同義字＋第二個概念
            if (spec.length > 1) q.push(dedupe(spec[spec.length > 2 ? 2 : 1].slice(0, 2)).concat([lang]).join(' ')); // 另一個概念單獨搜
            else q.push(dedupe(spec[0].slice(0, 2)).concat([lang, 'library']).join(' '));
        }
        for (const x of (opts.extraQueries || [])) if (/[a-z]{3}/i.test(x)) q.push(String(x).trim());
        const clean = Array.from(new Set(q.map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.split(' ').length >= 2)));
        return { queries: clean.slice(0, opts.extraQueries && opts.extraQueries.length ? 5 : 3), base: spec.map((g) => g[0]).join(' '), sources: opts.sources || ['github', 'sourceforge', 'codeproject', 'stackoverflow'] };
    }

    // ===== 候選排名 =====
    // 需求拆成『概念組』：詞庫命中的一個詞條是一組同義詞（拍貼機＝photo booth），其餘的英文字各自一組。
    // 相關度＝文件裡找得到的概念組的加權比例（權重＝稀有度，所有候選都有的字權重低但不為零）——這是絕對分數（0～1），
    // 不是『每題最高分都正規化成 1』，所以門檻（預設 0.35）有意義：沒有任何一組概念對得上的候選，不會因為環境相容之類的加分混過門檻。
    function conceptGroups(gap, context) {
        const t = toEnglish(gap.text + ' ' + (context || '')); const groups = t.groups.map((g) => g.map((w) => w.toLowerCase()));
        const seen = new Set(groups.flat()); const extra = Array.from(new Set(words(t.rest + ' ' + gap.op + ' ' + gap.cls))).filter((w) => !seen.has(w) && !['get', 'set', 'do', 'run', 'make', 'the', 'and', 'for', 'new'].includes(w));
        for (const w of extra) groups.push([w]); return groups;
    }
    const GENERIC = new Set(['file', 'files', 'data', 'image', 'images', 'read', 'write', 'code', 'page', 'web', 'size', 'adjust', 'make', 'use', 'tool', 'tools', 'library', 'create', 'text', 'edit', 'convert', 'output', 'input', 'new', 'get', 'set', 'run', 'do', 'the', 'and', 'for']);
    const stemW = (w) => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
    // cards：[{ id, name, url, summary, card }]；回傳依分數排序 [{ ...candidate, score, relevance, why:[…] }]
    function rank(gap, cards, opts) {
        opts = opts || {}; const want = (opts.runtime || 'browser'); const groups = conceptGroups(gap, opts.context);
        const heads = cards.map((c) => new Set(SEL.tokenize([c.name, c.summary, Card.cardText(c.card)].join('. ')).map(stemW))); // 名稱、一句話說明、能力、函式
        const docs = cards.map((c, i) => new Set(Array.from(heads[i]).concat(SEL.tokenize((c.card.terms || []).join(' ')).map(stemW)))); // 加上 README 讀過的字
        const N = docs.length || 1; const idf = (w) => { const n = docs.filter((d) => d.has(stemW(w))).length; return 0.5 + Math.log(1 + (N - n + 0.5) / (n + 0.5)); };
        const spec = groups.map((g) => { const sp = g.filter((w) => !GENERIC.has(w)); return sp.length ? sp : g; }); const gw = spec.map((g, gi) => Math.max(...g.map(idf)) * (g.every((w) => GENERIC.has(w)) ? 0.35 : 1)); const total = gw.reduce((a, b) => a + b, 0) || 1; const out = [];
        // 語意：opts.dense = { q: 需求句向量, cards: Map(候選 id → 向量) }，向量已正規化
        let semArr = null; if (opts.dense && opts.dense.q && opts.dense.cards) { const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }; const cos = cards.map((c) => { const v = opts.dense.cards.get(c.id); return v ? dot(opts.dense.q, v) : null; }); const vals = cos.filter((x) => x != null); if (vals.length >= 2) { const mean = vals.reduce((a, b) => a + b, 0) / vals.length; const sd = Math.max(0.02, Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length)); semArr = cos.map((x) => (x == null ? null : { cos: x, sem: 0.5 * Math.min(1, Math.max(0, (x - 0.78) / 0.1)) + 0.5 * Math.min(1, Math.max(0, 0.5 + (x - mean) / sd / 4)) })); } }
        cards.forEach((c, i) => {
            const k = c.card; const why = []; let hit = 0; const missed = []; spec.forEach((g, gi) => { if (g.some((w) => heads[i].has(stemW(w)))) hit += gw[gi]; else if (g.some((w) => docs[i].has(stemW(w)))) hit += gw[gi] * 0.5; else missed.push(g[0]); }); // 只在 README 某處出現過的字，只算一半
            const rel0 = hit / total; const sm = semArr && semArr[i]; const rel = sm ? 0.65 * rel0 + 0.35 * sm.sem : rel0; let s = rel; if (rel0 > 0) why.push('概念對上 ' + Math.round(rel0 * 100) + '%' + (missed.length ? '（缺 ' + missed.slice(0, 3).join('、') + '）' : '')); if (sm) why.push('語意相近 ' + Math.round(sm.sem * 100) + '%（餘弦 ' + Math.round(sm.cos * 1000) / 1000 + '）');
            if (rel >= 0.15) {
                const qw = spec.flat().filter((w) => !GENERIC.has(w)); if ((k.api || []).some((a) => qw.some((w) => snake(a.name).includes(w)))) { s += 0.1; why.push('函式名稱對得上'); }
                if ((k.runtime || []).includes(want)) { s += k.runtime_guess ? 0.03 : 0.1; why.push((k.runtime_guess ? '大概可在 ' : '可在 ') + want + ' 執行'); } else if (k.runtime && k.runtime.length) { const soft = (want === 'browser' && k.language === 'js') || (want === 'node' && k.language === 'js'); s -= soft ? 0.08 : 0.3; why.push('執行環境是 ' + k.runtime.join('/') + '，不是 ' + want + (soft ? '（JavaScript 函式庫，可能也能用）' : '')); }
                if (k.deprecated) { s *= 0.5; why.push('已停止維護'); } if (!(k.installs && k.installs.length) && !(k.cdn && k.cdn.length) && !(k.api && k.api.length) && !k.language) { s *= 0.5; why.push('不像可以直接用的函式庫（沒有安裝方式、函式、語言）'); } if (!k.license) why.push('授權不明'); if ((k.installs && k.installs.length) || (k.cdn && k.cdn.length)) s += 0.03;
                if ((k.needs || []).includes('api_key')) { s -= 0.1; why.push('需要 API 金鑰'); } if ((k.needs || []).includes('server')) { s -= 0.1; why.push('需要伺服器'); }
            } else if (k.deprecated) why.push('已停止維護');
            out.push(Object.assign({}, c, { score: Math.round(Math.max(0, s) * 1000) / 1000, relevance: Math.round(rel * 1000) / 1000, why }));
        });
        return out.sort((a, b) => b.score - a.score);
    }

    // ===== 能力層級的缺口偵測：每個需要的能力，最接近的卡片是誰、夠不夠近 =====
    function coverage(needs, cards, opts) {
        opts = opts || {}; const th = opts.threshold == null ? 0.35 : opts.threshold; const rows = needs.map((n) => { const g = gapsFromNeeds([n])[0]; const r = rank(g, cards, opts); const top = r[0]; return { need: n, best: top ? top.id : null, score: top ? top.score : 0, covered: !!top && top.score >= th }; });
        return { rows, gaps: rows.filter((r) => !r.covered).map((r) => r.need), covered_pct: rows.length ? Math.round((rows.filter((r) => r.covered).length / rows.length) * 100) : 100 };
    }

    // ===== 錯誤 → 下一步 =====
    const ERRORS = [
        [/ModuleNotFoundError|No module named|Cannot find module|Failed to resolve module|Module not found|ImportError|ERR_MODULE_NOT_FOUND/i, 'missing_module', 'install_or_import', '缺套件：安裝它，或在瀏覽器改用 CDN／ES 模組網址'],
        [/\b(\w[\w$.]*) is not defined|ReferenceError|NameError: name/i, 'not_defined', 'add_import', '用了沒有宣告／匯入的名稱：補 import 或載入該函式庫'],
        [/is not a function|is not a constructor|has no attribute|AttributeError|has no exported member|is not exported|Cannot read propert(?:y|ies) of undefined/i, 'wrong_api', 'check_api_version', '呼叫的 API 不存在或版本不同：對照 README 的範例與版本'],
        [/NotAllowedError|Permission denied|PermissionDeniedError|NotFoundError.*(?:device|camera)|getUserMedia|denied|not allowed to/i, 'permission', 'grant_permission', '權限被擋（相機、麥克風、檔案）：請使用者授權，或換成上傳檔案'],
        [/CORS|Access-Control-Allow-Origin|cross-origin|Failed to fetch|NetworkError|ERR_CONNECTION|ECONNREFUSED|ENOTFOUND|net::/i, 'network', 'use_proxy_or_cdn', '網路／跨來源被擋：改用 CDN、本機代理，或離線取得檔案'],
        [/WebGL|webgl|GPU|out of memory|OOM|RangeError: Invalid array length|Maximum call stack|memory access out of bounds/i, 'resource', 'lighter_alternative', '資源不夠或環境不支援：換比較輕的做法／縮小輸入'],
        [/SyntaxError|Unexpected token|Unexpected identifier|IndentationError|invalid syntax|Unexpected end of input/i, 'syntax', 'fix_syntax', '語法錯誤：修正產生的程式碼'],
        [/TypeError.*(?:argument|undefined|null)|expected .* got|TypeError: .* takes|missing \d+ required|required positional/i, 'wrong_args', 'fix_arguments', '參數數量或型別不對：對照函式簽名修正'],
        [/await|Promise|async|not iterable.*Promise|\[object Promise\]/i, 'async', 'add_await', '漏了 await／回傳是 Promise'],
        [/timed? ?out|Timeout|deadline|ETIMEDOUT/i, 'timeout', 'retry_or_smaller', '逾時：重試一次，或縮小輸入、換更快的做法'],
        [/404|Not Found|no such file|ENOENT|FileNotFoundError/i, 'missing_resource', 'fix_path', '找不到檔案／網址：檢查路徑或模型檔下載位置'],
    ];
    function classifyError(err) { const s = String((err && (err.message || err.stack)) || err || ''); for (const [re, kind, action, hint] of ERRORS) if (re.test(s)) return { kind, action, hint, matched: (re.exec(s) || [''])[0].slice(0, 60) }; return { kind: 'unknown', action: 'ask_user', hint: '看不出原因：把錯誤訊息原文交給使用者或更強的模型', matched: '' }; }
    // history：之前試過的 [{ candidate, kind, action }]；current：現在用的候選；candidates：可以換的候選 [{ id }]。
    // 規則：同一個候選＋同一個動作不重複；同一種錯在同一個候選上最多修 2 次；修不動就換候選；沒有候選可換就放棄；看不出原因交給人。
    function nextAttempt(history, err, candidates, current) {
        const c = classifyError(err); const hist = history || []; const tried = new Set(hist.map((h) => h.candidate + '|' + h.action)); const cur = current || (hist.length ? hist[hist.length - 1].candidate : null);
        if (c.action === 'ask_user') return Object.assign({ next: 'ask_user', candidate: cur }, c);
        const sameKind = hist.filter((h) => h.kind === c.kind && h.candidate === cur).length;
        if (cur && !tried.has(cur + '|' + c.action) && sameKind < 2) return Object.assign({ next: c.action, candidate: cur }, c);
        const alt = (candidates || []).find((x) => x.id !== cur && !hist.some((h) => h.candidate === x.id) && x.id !== undefined);
        if (alt) return Object.assign({ next: 'switch_candidate', candidate: alt.id }, c);
        return Object.assign({ next: 'give_up', candidate: cur }, c);
    }

    // ===== 迴圈 =====
    // host：{ bind(), search(query, sources) → [{title,url,snippet}], fetchText(url) → string, vote?(slice) → facts, onboard?(candidate) → {units}, tryRun?(plan) → {ok, error} }
    // need：{ uml } 或 { needs:[…] }；opts：{ runtime, maxRounds, maxGaps, perGap（每個缺口最多讀幾個候選）, minScore, budgetChars, contextTokens }
    async function run(host, need, opts) {
        opts = Object.assign({ runtime: 'browser', maxRounds: 2, maxGaps: 6, perGap: 4, minScore: 0.35, budgetChars: 12000 }, opts || {}); const trace = []; const log = (e) => trace.push(Object.assign({ at: trace.length }, e));
        let gaps = []; let bindRes = null;
        if (need.uml && host.bind) { bindRes = await host.bind(need.uml); if (!bindRes || bindRes.ok === false) return { ok: false, error: (bindRes && bindRes.error) || '接線失敗', trace }; gaps = gapsFrom(bindRes); log({ step: 'bind', usecases: (bindRes.results || []).length, gaps: gaps.length }); } else gaps = gapsFromNeeds(need.needs || []);
        const chosen = {}; const references = []; const cardCache = new Map(); const unresolved = []; let round = 0; const initial = gaps.length;
        while (gaps.length && round < opts.maxRounds) {
            round++; const todo = gaps.slice(0, opts.maxGaps); const rest = gaps.slice(opts.maxGaps); const progress = [];
            for (const gap of todo) {
                let extra = []; if (host.rewrite) { try { extra = (await host.rewrite(gap)) || []; } catch (e) { log({ step: 'rewrite_error', gap: gap.id, error: String((e && e.message) || e) }); } } const q = queriesFor(gap, Object.assign({}, opts, { extraQueries: extra })); log({ step: 'queries', rewritten: extra.length, gap: gap.id, queries: q.queries }); const found = new Map();
                for (const query of q.queries) { let hits = []; try { hits = (await host.search(query, q.sources)) || []; } catch (e) { log({ step: 'search_error', gap: gap.id, error: String((e && e.message) || e) }); } for (const h of hits) if (h && h.url && !found.has(h.url)) found.set(h.url, h); if (found.size >= opts.perGap * 3) break; }
                const cards = []; for (const h of Array.from(found.values()).slice(0, opts.perGap * 2)) {
                    if (cards.length >= opts.perGap) break; let c = cardCache.get(h.url);
                    if (!c) { let text = '', dk = null, desc = ''; try { const got = await host.fetchText(h.url); if (got && typeof got === 'object') { text = got.text; dk = got.kind; desc = got.description || ''; } else text = got; } catch (e) { log({ step: 'fetch_error', url: h.url, error: String((e && e.message) || e) }); continue; } if (!text || text.length < 40) continue; const votes = host.vote ? await host.vote({ url: h.url, text }) : []; const kind = kindOf(h.url); const card = Card.cardFromReadme(text, { name: h.title, description: desc || h.snippet, budgetChars: opts.budgetChars, contextTokens: opts.contextTokens, kind: kind === 'project' ? (dk || h.kind) : kind, votes: votes || [] }); c = { id: h.url, name: h.title || h.url, url: h.url, kind, summary: card.summary, card }; cardCache.set(h.url, c); }
                    if (c.kind !== 'project' && !opts.allowKnowledge) { if (!references.some((r) => r.url === c.url) && references.length < 8) references.push({ gap: gap.id, kind: c.kind, name: c.name, url: c.url, summary: c.summary, install: (c.card.installs[0] && c.card.installs[0].line) || null, api: c.card.api.slice(0, 5).map((a) => a.name) }); continue; }
                    cards.push(c);
                }
                let dense = null; if (host.embed && cards.length) { try { const gq = conceptGroups(gap, opts.context).map((g) => g.join(' ')).join(' '); const vs = await host.embed([{ text: gq, role: 'query' }].concat(cards.map((c) => ({ text: [c.name, c.summary, Card.cardText(c.card)].join('. ').slice(0, 700), role: 'passage' })))); if (vs && vs.length === cards.length + 1) dense = { q: vs[0], cards: new Map(cards.map((c, i) => [c.id, vs[i + 1]])) }; } catch (e) { log({ step: 'embed_error', gap: gap.id, error: String((e && e.message) || e) }); } }
                const ranked = rank(gap, cards, Object.assign({}, opts, { dense })); log({ step: 'rank', gap: gap.id, candidates: ranked.map((r) => ({ id: r.id, score: r.score, why: r.why })) });
                const best = ranked.find((r) => r.score >= opts.minScore); if (best) { chosen[gap.id] = { gap, pick: best, alternatives: ranked.filter((r) => r !== best).slice(0, 3) }; progress.push(gap.id); } else unresolved.push({ gap, reason: ranked.length ? '最像的也只有 ' + (ranked[0].score) + ' 分（門檻 ' + opts.minScore + '）' : '搜不到可用的候選' });
            }
            // 抽成單元後再接一次線，看缺口有沒有真的補上
            if (host.onboard && progress.length) { let added = 0; for (const id of progress) { try { const r = await host.onboard(chosen[id].pick); if (r && r.units && r.units.length) { chosen[id].units = r.units.length; added += r.units.length; } } catch (e) { log({ step: 'onboard_error', gap: id, error: String((e && e.message) || e) }); } } log({ step: 'onboard', added }); if (added && need.uml && host.bind) { bindRes = await host.bind(need.uml); const left = gapsFrom(bindRes); log({ step: 'rebind', gaps: left.length }); gaps = left.filter((g) => !chosen[g.id] || !chosen[g.id].units); if (!gaps.length) break; if (gaps.length >= initial && !progress.length) break; continue; } }
            gaps = rest.filter((g) => !chosen[g.id]); if (!progress.length) break;
        }
        const planOut = { ok: true, runtime: opts.runtime, rounds: round, gaps_initial: initial, resolved: Object.keys(chosen).length, unresolved: unresolved.filter((u) => !chosen[u.gap.id]).map((u) => ({ gap: u.gap.id, reason: u.reason })), references, candidates: Object.values(chosen).map((c) => ({ gap: c.gap.id, name: c.pick.name, url: c.pick.url, score: c.pick.score, why: c.pick.why, summary: c.pick.summary, language: c.pick.card.language, runtime: c.pick.card.runtime, install: (c.pick.card.installs[0] && c.pick.card.installs[0].line) || (c.pick.card.cdn[0] ? '<script src="' + c.pick.card.cdn[0] + '">' : null), api: c.pick.card.api.slice(0, 5).map((a) => a.name), needs: c.pick.card.needs, license: c.pick.card.license, units: c.units || 0, alternatives: c.alternatives.map((a) => ({ name: a.name, score: a.score })) })), trace };
        // 自我修正：照計畫試跑，錯誤歸類後換做法
        if (host.tryRun && planOut.candidates.length) {
            const history = []; let attempt = 0; let cur = planOut.candidates[0] && planOut.candidates[0].url; const all = Object.values(chosen).flatMap((c) => [c.pick].concat(c.alternatives)).map((c) => ({ id: c.id })); let r = await host.tryRun(planOut); log({ step: 'tryRun', ok: !!(r && r.ok) });
            while (r && !r.ok && attempt < (opts.maxFixes || 3)) {
                attempt++; const nx = nextAttempt(history, r.error, all, cur); history.push({ candidate: cur, kind: nx.kind, action: nx.next });
                log({ step: 'fix', attempt, error: String(r.error).slice(0, 120), kind: nx.kind, next: nx.next, candidate: nx.candidate }); if (nx.next === 'give_up' || nx.next === 'ask_user') break;
                if (nx.next === 'switch_candidate') cur = nx.candidate; r = await host.tryRun(Object.assign({}, planOut, { fix: nx })); log({ step: 'tryRun', ok: !!(r && r.ok) });
            }
            planOut.run = { ok: !!(r && r.ok), error: r && !r.ok ? String(r.error).slice(0, 200) : null, attempts: attempt };
        }
        return planOut;
    }
    function toText(plan) {
        if (!plan.ok) return '⚠️ ' + plan.error; const L = ['缺口 ' + plan.gaps_initial + ' 個，找到候選的 ' + plan.resolved + ' 個（' + plan.rounds + ' 輪）'];
        for (const c of plan.candidates) { L.push('▸ ' + c.gap + ' → ' + c.name + '（' + c.score + '）' + (c.language ? ' [' + c.language + (c.runtime && c.runtime.length ? '/' + c.runtime.join('/') : '') + ']' : '')); if (c.summary) L.push('    ' + c.summary.slice(0, 120)); if (c.install) L.push('    安裝：' + c.install); if (c.api.length) L.push('    主要函式：' + c.api.join('、')); if (c.needs.length) L.push('    需要：' + c.needs.join('、')); L.push('    ' + c.why.join('；') + (c.alternatives.length ? '；備選：' + c.alternatives.map((a) => a.name).join('、') : '')); }
        for (const u of plan.unresolved) L.push('✗ ' + u.gap + '：' + u.reason); if (plan.references && plan.references.length) { L.push('參考資料（概念、別人的做法，不是採用對象）：'); for (const r of plan.references.slice(0, 5)) L.push('  · [' + r.kind + '] ' + r.name + (r.summary ? '：' + r.summary.slice(0, 80) : '')); } if (plan.run) L.push(plan.run.ok ? '試跑通過' : '試跑失敗（' + plan.run.attempts + ' 次修正）：' + plan.run.error); return L.join('\n');
    }
    return { GLOSSARY, kindOf, toEnglish, gapsFrom, gapsFromNeeds, queriesFor, rank, coverage, classifyError, nextAttempt, run, toText };
});
