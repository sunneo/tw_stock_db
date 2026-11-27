/* 工具與領域的多層壓縮索引（UMD，純函式，不碰 DOM／網路／儲存）。設計見 docs/DESIGN.compact-tool-index.md
 *  - 目錄格式：{ 領域鍵: { label, tools: { 工具名: 完整說明 } } }（呼叫端從領域登錄表組出來；本模組不認識任何站別）
 *  - 三層：領域層（每領域一行）→ 工具層（每工具一行摘要）→ 完整層（只在 get_tool_details／申請載入時才給，不在本模組）
 *  - 快取：每個工具的「介紹文字」→雜湊→{summary, keywords}；介紹變了才重算那一個。整個工具集的雜湊變了才重組索引文字。
 *    儲存是可注入的轉接器 {get():string|null, set(string)}，壞掉、版本不符一律當空的重建，不丟錯。
 *  - 描述式比對：select(index, 文字) → 候選＋有沒有把握＋字母選擇題（沒把握不悄悄猜）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./tool_budget_core.js'));
    else root.FaCompactIndex = factory(typeof FaToolBudget !== 'undefined' ? FaToolBudget : root.FaToolBudget);
})(typeof self !== 'undefined' ? self : this, function (B) {
    'use strict';

    const CACHE_VERSION = 1;
    const SUMMARY_MAX = 90;
    const KEYWORD_MAX = 40;
    const MAX_PICK = 4;
    const LETTERS = 'ABCDEFGH';

    // 手寫的橋接：使用者怎麼說 → 工具介紹裡出現的字（鍵與值都是小寫詞）
    const SYNONYMS = {
        '壓縮檔': ['archive', 'zip', 'tar'], '解壓縮': ['archive', 'extract'], zip: ['archive'], tar: ['archive'], gz: ['archive'],
        '合併': ['merge', 'combine'], merge: ['combine'], '轉換': ['convert'], convert: ['conversion'],
        '圖片': ['image', 'picture'], '照片': ['image', 'picture'], '畫圖': ['image', 'render'],
        '簡報': ['deck', 'slide', 'presentation'], slide: ['deck', 'presentation'], deck: ['presentation'],
        '動畫': ['animation'], '語音': ['tts', 'speech', 'audio'], '朗讀': ['tts', 'speech'], '字幕': ['subtitle', 'transcribe'],
        '搜尋': ['search'], '網頁': ['web', 'page', 'browser'], '表格': ['sheet', 'table', 'csv'], '試算表': ['sheet', 'csv'],
        '圖表': ['chart', 'plot'], '統計': ['statistics', 'stats'], '翻譯': ['translate'], '截圖': ['screenshot']
    };

    // ───────────────────────── 雜湊（同步、不依賴 crypto；53 位元） ─────────────────────────
    function hash(str) {
        str = String(str == null ? '' : str); let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }
    // 一個工具的介紹文字：名稱、所屬領域、領域標籤、完整說明任何一項變了，雜湊就變
    function introText(name, description, domainKey, label) {
        const head = String(label || '').trim() ? domainKey + ' (' + String(label).trim().slice(0, 60) + ')' : domainKey;
        return name + ' [' + head + ']: ' + String(description || '').trim();
    }

    // ───────────────────────── 快取 ─────────────────────────
    // adapter：{ get(): string|null, set(string): void }。省略＝只在記憶體。所有讀寫都包起來：壞掉就是空的，永遠不丟錯。
    function createCache(adapter) {
        let data = null;
        const fresh = () => ({ version: CACHE_VERSION, entries: {}, routerText: null });
        function load() {
            if (data) return data;
            data = fresh();
            try {
                const raw = adapter && adapter.get ? adapter.get() : null;
                if (raw) { const p = JSON.parse(raw); if (p && p.version === CACHE_VERSION && p.entries && typeof p.entries === 'object') data = { version: CACHE_VERSION, entries: p.entries, routerText: p.routerText || null }; }
            } catch (_) { data = fresh(); }
            return data;
        }
        return {
            fetch(key) { return load().entries[key] || null; },
            store(key, value) { load().entries[key] = value; },
            // 只留這次還在用的條目（工具被移除後不讓快取一直長）
            prune(liveKeys) { const d = load(); const keep = new Set(liveKeys); for (const k of Object.keys(d.entries)) if (!keep.has(k)) delete d.entries[k]; },
            routerText() { return load().routerText; },
            setRouterText(v) { load().routerText = v; },
            save() { try { if (adapter && adapter.set) adapter.set(JSON.stringify(load())); return true; } catch (_) { return false; } }
        };
    }

    // ───────────────────────── 建索引 ─────────────────────────
    function summaryOf(name, description) { return B.shortOf(name, description, null).slice(0, SUMMARY_MAX + 20); }
    function keywordsOf(name, description) {
        const words = String(name).split('_').filter((w) => w.length >= 2);
        for (const w of B.tokens(String(description || '')).values()) { words.push(w); if (words.length > 160) break; }
        return Array.from(new Set(words)).slice(0, KEYWORD_MAX);
    }
    // catalog → index。core：常駐完整 schema 的工具名（索引裡不列）。回傳：
    //   { tools:{名:{h,domain,summary,keywords}}, domains:{鍵:{label,tools:[名],h}}, setHash, recomputed, reused, core }
    function build(catalog, opt) {
        opt = opt || {}; const cache = opt.cache || createCache(null); const core = new Set(opt.core || []);
        const tools = {}, domains = {}; let recomputed = 0, reused = 0; const liveKeys = [];
        for (const key of Object.keys(catalog || {}).sort()) {
            const entry = catalog[key] || {}; const label = String(entry.label || ''); const names = [];
            for (const name of Object.keys(entry.tools || {}).sort()) {
                if (core.has(name)) continue;
                if (tools[name]) continue; // 同一個工具出現在多個領域：以第一個領域為準
                const intro = introText(name, entry.tools[name], key, label); const h = hash(intro); liveKeys.push(h);
                let hit = cache.fetch(h);
                if (hit) reused++; else { recomputed++; hit = { summary: summaryOf(name, entry.tools[name]), keywords: keywordsOf(name, entry.tools[name]) }; cache.store(h, hit); }
                tools[name] = { h, domain: key, summary: hit.summary, keywords: hit.keywords }; names.push(name);
            }
            domains[key] = { label, tools: names, h: hash(key + '|' + label + '|' + names.map((n) => tools[n].h).join(',')) };
        }
        const setHash = hash(Object.keys(domains).map((k) => k + ':' + domains[k].h).join('|'));
        if (recomputed) cache.prune(liveKeys);
        return { tools, domains, setHash, recomputed, reused, core: Array.from(core) };
    }

    // ───────────────────────── 索引文字 ─────────────────────────
    // level 0：只有領域層；level 1：領域層＋每個工具一行。budgetChars 給了而且第 1 層超過，自動降到第 0 層（overBudget=true）。
    function keysOf(index, only) { const all = Object.keys(index.domains); return only ? all.filter((k) => only.indexOf(k) >= 0) : all; }
    function layer0(index, only) {
        return keysOf(index, only).map((k) => { const d = index.domains[k]; return '- ' + k + (d.label ? '（' + d.label.slice(0, 60) + '）' : '') + '：' + d.tools.length + ' 個工具：' + d.tools.slice(0, 4).join('、') + (d.tools.length > 4 ? '…' : ''); }).join('\n');
    }
    function layer1(index, only) {
        const out = [];
        for (const k of keysOf(index, only)) { const d = index.domains[k]; if (!d.tools.length) continue; out.push('## ' + k + (d.label ? '（' + d.label.slice(0, 60) + '）' : '')); for (const n of d.tools) out.push('- ' + n + ': ' + index.tools[n].summary); }
        return out.join('\n');
    }
    // 第 0 層也超過預算時（小視窗模型）：照領域順序截到預算內，尾巴註明還有幾個領域沒列、用 description 申請
    function trim0(index, only, budget) {
        const lines = layer0(index, only).split('\n'); const out = []; let used = 0;
        for (let i = 0; i < lines.length; i++) {
            if (used + lines[i].length + 1 > budget) { out.push('…（另有 ' + (lines.length - i) + ' 個領域沒列出，用 description 申請）'); break; }
            out.push(lines[i]); used += lines[i].length + 1;
        }
        return out.join('\n');
    }
    function text(index, opt) {
        opt = opt || {}; const only = opt.only || null; const budget = opt.budgetChars || 0;
        const want0 = opt.level === 0; const full = want0 ? '' : layer1(index, only);
        if (!want0 && (!budget || full.length <= budget)) return { text: full, level: 1, overBudget: false, chars: full.length };
        const z = layer0(index, only); const over = !want0 && !!budget; // 想要第 1 層卻放不下＝降級
        if (budget && z.length > budget) { const t = trim0(index, only, budget); return { text: t, level: 0, overBudget: true, chars: t.length }; }
        return { text: z, level: 0, overBudget: over, chars: z.length };
    }
    // 路由用索引文字的快取：集合雜湊沒變（也沒換層級／預算）就直接用上次存的，不重組
    function cachedText(index, cache, opt) {
        const tag = index.setHash + '|' + ((opt && opt.level) === 0 ? 0 : 1) + '|' + ((opt && opt.budgetChars) || 0); const hit = cache.routerText();
        if (hit && hit.tag === tag) return { text: hit.text, level: hit.level, overBudget: hit.overBudget, chars: hit.text.length, fromCache: true };
        const r = text(index, opt); cache.setRouterText({ tag, text: r.text, level: r.level, overBudget: r.overBudget }); return Object.assign({ fromCache: false }, r);
    }

    // ───────────────────────── 描述式比對 ─────────────────────────
    function queryTokens(description) {
        const q = new Set(B.tokens(description)); const raw = String(description || '').toLowerCase();
        for (const [k, vs] of Object.entries(SYNONYMS)) if (raw.indexOf(k) >= 0) for (const v of vs) q.add(v);
        return q;
    }
    // 回傳 { candidates:[{name,domain,score}], confident, choices:[{letter,name}], domainsHit:[鍵] }
    // 有把握＝第一名分數夠高、命中至少 2 個詞，且領先第二名一個明顯差距（或只有一個候選）；其餘一律回選擇題讓呼叫端確認，不悄悄猜。
    function select(index, description, opt) {
        opt = opt || {}; const max = opt.max || MAX_PICK; const exclude = new Set(opt.exclude || []);
        const names = Object.keys(index.tools).filter((n) => !exclude.has(n));
        const docs = names.map((n) => { const t = index.tools[n]; const d = index.domains[t.domain] || {}; return { id: n, text: n.replace(/_/g, ' ') + ' ' + t.summary + ' ' + t.keywords.join(' ') + ' ' + (d.label || '') + ' ' + t.domain.replace(/_/g, ' '), nameText: n, extra: t.domain }; });
        const q = queryTokens(description);
        const ranked = B.rank(B.buildIndex(docs), q, { minHit: opt.minHit || 2, minScore: 0, ratio: opt.ratio == null ? 0.5 : opt.ratio, max: max + 4, minKeep: 0 });
        const cands = ranked.slice(0, max).map((r) => ({ name: r.id, domain: r.extra, score: r.score, hit: r.hit }));
        const first = cands[0], second = cands[1];
        const confident = !!first && first.hit >= 2 && first.score >= (opt.minConfident || 10) && (!second || first.score >= second.score * (opt.lead || 1.5));
        return { candidates: cands, confident, choices: cands.slice(0, LETTERS.length).map((c, i) => ({ letter: LETTERS[i], name: c.name })), domainsHit: Array.from(new Set(cands.map((c) => c.domain))) };
    }
    // 字母選擇題文字（給模型答一個字母；程式再用 answer 解回工具名）
    function choiceQuestion(sel) {
        if (!sel.choices.length) return '';
        return '找到這幾個可能的工具，哪個符合你的需求？只回一個字母（都不是就回 Z）：\n' + sel.choices.map((c) => c.letter + '. ' + c.name).join('\n');
    }
    function answer(sel, reply) {
        const m = /^\s*([A-Za-z])\b/.exec(String(reply || '')); if (!m) return null; const L = m[1].toUpperCase(); if (L === 'Z') return []; const hit = sel.choices.find((c) => c.letter === L); return hit ? [hit.name] : null;
    }

    // ───────────────────────── 載入解析 ─────────────────────────
    // 申請載入（精確名稱與／或領域鍵）：回 { names, domains, notFound }。名稱不在索引、也不是核心工具 → notFound。
    function resolve(index, req) {
        req = req || {}; const core = new Set(index.core || []); const names = [], doms = [], notFound = [];
        for (const n of [].concat(req.names || [])) { if (core.has(n)) continue; if (index.tools[n]) names.push(n); else notFound.push(n); }
        for (const k of [].concat(req.domains || [])) { if (index.domains[k]) { doms.push(k); for (const n of index.domains[k].tools) if (!names.includes(n)) names.push(n); } else notFound.push(k); }
        return { names, domains: doms, notFound };
    }
    function reachable(index, name) { return (index.core || []).indexOf(name) >= 0 || !!index.tools[name]; }

    return { CACHE_VERSION, hash, introText, createCache, build, text, cachedText, select, choiceQuestion, answer, resolve, reachable, queryTokens };
});
