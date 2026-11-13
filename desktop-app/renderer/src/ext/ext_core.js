/* 擴充點（extension points）核心：內建技能（目前是 media-presentation）可以被別的模組或網頁環境「注入」強化。
 *
 * 一份擴充是宣告式的 JSON（設計見 DESIGN.extension-points.md）：
 *   - tool：對外的工具（線上 AI 直接當工具呼叫；離線 AI 透過工具目錄與 CoLU 路由選用）
 *   - context：情境偵測（由網址、標題、選取文字抽股票代號與名稱）
 *   - research：要查的公開來源（網址模板、抽取方式、缺條件就跳過並說明）
 *   - contribute：整理好的段落貢獻到 media-presentation 的一章（每頁附來源，最後一頁固定免責聲明）
 *
 * 純函式（UMD），不碰 DOM、不直接上網、不呼叫模型：抓網頁用注入的 fetchText，所以能用固定快照完整測試。
 * 安全與誠實規則（程式強制）：抽到的數字必須出現在來源；抽不到寫「查不到」；每筆附來源；不給買賣建議；免責聲明固定最後一頁。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaExt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var DISCLAIMER_DEFAULT = '本簡報為公開資料整理，僅供參考，不構成任何投資建議；買賣請自行判斷並承擔風險。';
    var ADVICE_RE = /買進|賣出|加碼|減碼|停損|停利|目標價|必漲|必跌|穩賺|強力推薦/;
    var MAX_FACTS = 8;
    var LABELS = { code: '股票代號', name: '股票名稱', date: '日期' };
    var LIMITS = { chapters: 30, slides: 150, bullets: 6, bullet: 220, narration: 1200 };

    function str(x) { return x == null ? '' : String(x); }
    function clip(s, n) { s = str(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
    function normNum(s) { return str(s).replace(/,/g, ''); }
    function uniq(a) { var out = []; a.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); }); return out; }
    function decodeEntities(s) {
        return str(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    }
    function tag(xml, name) {
        var m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>').exec(xml);
        return m ? decodeEntities(m[1]).trim() : '';
    }

    // 抽取檢查沿用食譜核心的 checkExtractive（有 FaRecipe 時）；沒有就只做數字檢查。
    function recipeCore() {
        try { if (typeof FaRecipe !== 'undefined' && FaRecipe) return FaRecipe; } catch (_) { /* 沒有全域的 FaRecipe */ }
        try { if (typeof require === 'function') return require('../recipe/recipe_core.js'); } catch (_) { /* 瀏覽器沒有 require */ }
        return null;
    }

    // ───── 格式驗證 ─────
    function validate(ext) {
        var errs = [];
        function err(p, m) { errs.push(p + '：' + m); }
        if (!ext || typeof ext !== 'object') return { ok: false, errors: ['擴充不是物件'] };
        if (!/^[a-z][a-z0-9_]{1,40}$/.test(str(ext.id))) err('id', '只能是小寫英文、數字、底線，2～41 字');
        if (!str(ext.name).trim()) err('name', '必填');
        var t = ext.tool || {};
        if (!/^ext_[a-z0-9_]{1,50}$/.test(str(t.name))) err('tool.name', '必須以 ext_ 開頭，只能是小寫英文、數字、底線');
        if (!str(t.description).trim()) err('tool.description', '必填（線上與離線的 AI 都靠這段說明選用它）');
        var c = ext.context || {};
        if (!Array.isArray(c.patterns) || !c.patterns.length) err('context.patterns', '至少要有一條情境規則');
        (Array.isArray(c.patterns) ? c.patterns : []).forEach(function (p, i) {
            var where = 'context.patterns[' + i + ']';
            try { new RegExp(str(p && p.re)); } catch (_) { err(where + '.re', '正規表示式不合法'); }
            if (!(p && p.code >= 1)) err(where + '.code', '必須是要取代號的群組編號（從 1 起算）');
        });
        try { if (c.urlPattern) new RegExp(c.urlPattern); } catch (_) { err('context.urlPattern', '正規表示式不合法'); }
        try { if (c.codeRe) new RegExp(c.codeRe); } catch (_) { err('context.codeRe', '正規表示式不合法'); }
        var r = ext.research;
        if (!Array.isArray(r) || r.length < 1 || r.length > 8) err('research', '需要 1～8 個來源');
        var ids = {};
        (Array.isArray(r) ? r : []).forEach(function (s, i) {
            var p = 'research[' + i + ']';
            if (!/^[a-z][a-z0-9_]{0,30}$/.test(str(s && s.id))) err(p + '.id', '只能是小寫英文、數字、底線');
            else if (ids[s.id]) err(p + '.id', '重複的 id「' + s.id + '」');
            ids[str(s && s.id)] = true;
            if (!str(s && s.label).trim()) err(p + '.label', '必填');
            if (typeof (s && s.url) !== 'string') err(p + '.url', '必須是字串（沒有網址模板就用空字串並標 optional）');
            else if (s.url && !/^https:\/\//.test(s.url)) err(p + '.url', '必須是 https 網址');
            else if (!s.url && !s.optional) err(p + '.url', '沒有網址的來源必須標 optional');
            var k = s && s.extract && s.extract.kind;
            if (['json_rows', 'rss', 'text'].indexOf(k) < 0) err(p + '.extract.kind', '必須是 json_rows、rss 或 text');
        });
        var ct = ext.contribute || {};
        if (ct.target !== 'media-presentation') err('contribute.target', '目前只支援 media-presentation');
        if (ct.position != null && ['end', 'start'].indexOf(ct.position) < 0) err('contribute.position', '必須是 end 或 start');
        if (ct.maxBulletsPerSlide != null && !(ct.maxBulletsPerSlide >= 1 && ct.maxBulletsPerSlide <= LIMITS.bullets)) err('contribute.maxBulletsPerSlide', '必須是 1～' + LIMITS.bullets);
        return { ok: errs.length === 0, errors: errs };
    }

    // ───── 登錄（可以多個擴充，依加入順序）─────
    function createRegistry() { return { items: {}, order: [] }; }
    function register(reg, ext) {
        var v = validate(ext);
        if (!v.ok) return { ok: false, errors: v.errors };
        var replaced = !!reg.items[ext.id];
        if (!replaced) reg.order.push(ext.id);
        reg.items[ext.id] = ext;
        return { ok: true, replaced: replaced };
    }
    function loadAll(reg, list) {
        var loaded = [], rejected = [];
        (Array.isArray(list) ? list : []).forEach(function (ext) {
            var r = register(reg, ext);
            if (r.ok) loaded.push(ext.id); else rejected.push({ id: ext && ext.id, errors: r.errors });
        });
        return { loaded: loaded, rejected: rejected };
    }
    function remove(reg, id) {
        if (!reg.items[id]) return false;
        delete reg.items[id];
        reg.order = reg.order.filter(function (x) { return x !== id; });
        return true;
    }
    function list(reg, opts) {
        opts = opts || {};
        return reg.order.map(function (id) { return reg.items[id]; }).filter(function (e) { return !opts.enabledOnly || e.enabled !== false; });
    }

    // ───── 情境偵測（網址、標題、選取文字 → 代號與名稱）─────
    function detectContext(ext, ctx) {
        ctx = ctx || {};
        var c = ext.context || {};
        var url = str(ctx.url), title = str(ctx.title), sel = str(ctx.selection);
        if (c.urlPattern && !new RegExp(c.urlPattern).test(url)) return { matched: false, reason: '網址不是這類網頁' };
        var codeRe = new RegExp(c.codeRe || '^\\d{4,6}$');
        var hay = [['url', url], ['title', title], ['selection', sel]];
        for (var i = 0; i < c.patterns.length; i++) {
            var p = c.patterns[i], re = new RegExp(p.re);
            for (var j = 0; j < hay.length; j++) {
                var m = re.exec(hay[j][1]);
                if (!m) continue;
                var code = str(m[p.code]).trim();
                if (!codeRe.test(code)) continue;
                return { matched: true, entities: { code: code, name: p.name ? str(m[p.name]).trim() : '' }, from: hay[j][0], rule: i };
            }
        }
        return { matched: false, reason: '找不到股票代號' };
    }

    // 工具參數優先（模型或使用者明說的），網頁情境補不足的部分。
    function resolveEntities(ext, detected, args) {
        var codeRe = new RegExp((ext.context && ext.context.codeRe) || '^\\d{4,6}$');
        var a = args || {}, d = (detected && detected.entities) || {};
        var argCode = str(a.code).trim(), argName = str(a.name).trim();
        var code = codeRe.test(argCode) ? argCode : (codeRe.test(str(d.code)) ? str(d.code) : '');
        var name = argName || str(d.name).trim();
        if (name === code) name = '';
        return { code: code, name: name };
    }

    // ───── 來源規劃（網址模板、缺條件就跳過並說明）─────
    // 模板變數：{code}、{name}（網址裡會做 URL 編碼）、{date}（yyyymmdd）。
    function fill(tpl, ent, date, encode) {
        var missing = [];
        var out = str(tpl).replace(/\{(code|name|date)\}/g, function (_, k) {
            var v = k === 'code' ? ent.code : k === 'name' ? ent.name : date;
            if (!v) { missing.push(k); return ''; }
            return encode && k === 'name' ? encodeURIComponent(v) : String(v);
        });
        return { text: out, missing: uniq(missing) };
    }

    function planResearch(ext, ent, opts) {
        opts = opts || {};
        return (ext.research || []).map(function (s) {
            var base = { id: s.id, label: s.label, optional: !!s.optional, extract: s.extract, must: (s.extract && s.extract.must) || null };
            if (!s.url) return Object.assign(base, { url: '', skipped: true, reason: '未設定來源網址' });
            var f = fill(s.url, ent, opts.date, true);
            var missing = f.missing.slice();
            (s.needs || []).forEach(function (k) { if (!ent[k] && missing.indexOf(k) < 0) missing.push(k); });
            if (missing.length) return Object.assign(base, { url: '', skipped: true, reason: '缺少' + missing.map(function (k) { return LABELS[k] || k; }).join('、') });
            return Object.assign(base, { url: f.text, skipped: false, reason: '' });
        });
    }

    // ───── 抽取（三種格式；每種都回傳事實條目與說明）─────
    function jsonRows(ex, body, ent) {
        var o;
        try { o = JSON.parse(body); } catch (_) { return { facts: [], note: '不是 JSON（可能是登入頁或錯誤頁）' }; }
        var rows = o && o[ex.rowsKey || 'data'];
        var fields = (o && o[ex.fieldsKey || 'fields']) || [];
        if (!Array.isArray(rows) || !rows.length) return { facts: [], note: '沒有資料列（可能是休市日或當日尚未公布）' };
        if (ex.match) {
            var want = fill(ex.match.equals, ent, '', false).text;
            rows = rows.filter(function (r) { return Array.isArray(r) && str(r[ex.match.col]).trim() === want; });
            if (!rows.length) return { facts: [], note: '資料中找不到這檔股票' };
        }
        if (ex.pick === 'last') rows = rows.slice(-(ex.count || 1));
        var facts = [];
        var missingCols = [];
        (ex.show || []).forEach(function (lab) { if (fields.indexOf(lab) < 0) missingCols.push(lab); });
        rows.forEach(function (row) {
            (ex.show || []).forEach(function (lab) {
                var idx = fields.indexOf(lab);
                if (idx < 0 || !Array.isArray(row)) return;
                var v = str(row[idx]).trim();
                if (v) facts.push({ text: lab + '：' + v });
            });
        });
        if (!facts.length) return { facts: [], note: missingCols.length ? '欄位名稱對不上（' + missingCols.slice(0, 2).join('、') + '）' : '沒有可用的數值' };
        return { facts: facts, note: '' };
    }

    function rssItems(ex, body, ent) {
        var must = (ex.must || []).map(function (t) { return fill(t, ent, '', false).text; }).filter(Boolean);
        var re = /<item>([\s\S]*?)<\/item>/g, m, out = [];
        while ((m = re.exec(body)) && out.length < 50) {
            var title = tag(m[1], 'title'), date = tag(m[1], 'pubDate');
            if (!title) continue;
            if (must.length && !must.some(function (t) { return title.indexOf(t) >= 0; })) continue;
            out.push({ text: title + (date ? '（' + date + '）' : '') });
        }
        out = out.slice(0, ex.max || 5);
        return out.length ? { facts: out, note: '' } : { facts: [], note: '沒有含股票名稱或代號的新聞' };
    }

    function textSentences(ex, body, ent) {
        var plain = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
        plain = decodeEntities(plain).replace(/\s+/g, ' ');
        var keys = [ent.name, ent.code].filter(Boolean);
        var sents = plain.split(/(?<=[。！？!?])/).map(function (s) { return s.trim(); })
            .filter(function (s) { return s.length >= 8 && s.length <= 200 && keys.some(function (k) { return s.indexOf(k) >= 0; }); });
        sents = uniq(sents).slice(0, ex.max || 5);
        return sents.length ? { facts: sents.map(function (s) { return { text: s }; }), note: '' } : { facts: [], note: '頁面裡沒有提到這檔股票' };
    }

    // 數字必須出現在來源；有 FaRecipe 時再過 checkExtractive（只濃縮、不新增）。
    function verifyFacts(facts, body) {
        var rc = recipeCore();
        var srcNums = {};
        (normNum(body).match(/\d+(?:\.\d+)?/g) || []).forEach(function (n) { srcNums[n] = true; });
        var kept = [], dropped = 0;
        facts.forEach(function (f) {
            var nums = normNum(f.text).match(/\d+(?:\.\d+)?/g) || [];
            if (nums.some(function (n) { return !srcNums[n]; })) { dropped++; return; }
            // 千分位逗號先拿掉（來源與段落都一樣），不然 2,345,678 會被切成三個數字而對不上
            if (rc && typeof rc.checkExtractive === 'function' && !rc.checkExtractive(normNum(f.text), [normNum(body)], { min: 0.5, cjkMin: 0.5 }).ok) { dropped++; return; }
            kept.push(f);
        });
        return { kept: kept, dropped: dropped };
    }

    function looksLikeLogin(body) {
        return /<input[^>]+type=["']?password|請先登入|Sign in to|登入後/i.test(body);
    }

    // 抽取一個來源：回傳 { label, url, facts, dropped, note }；facts 已通過數字核對。
    function extractSource(plan, body, ent) {
        var source = { label: plan.label, url: plan.url };
        body = str(body);
        if (!body.trim()) return { source: source, facts: [], dropped: 0, note: '抓不到內容（沒有回應或空白）' };
        var ex = plan.extract || {}, r;
        if (ex.kind === 'json_rows') r = jsonRows(ex, body, ent);
        else if (ex.kind === 'rss') r = rssItems(ex, body, ent);
        else r = textSentences(ex, body, ent);
        var facts = (r.facts || []).slice(0, MAX_FACTS);
        var v = verifyFacts(facts, body);
        var note = r.note || '';
        if (!v.kept.length && !note) note = '抽到的內容沒有通過數字核對';
        if (!v.kept.length && looksLikeLogin(body)) note = '需要登入，未取得';
        return { source: source, facts: v.kept, dropped: v.dropped, note: note };
    }

    // ───── 段落（事實→段落；買賣建議丟掉；查不到就寫明）─────
    function buildSections(ext, ent, results, opts) {
        opts = opts || {};
        var sections = [], unavailable = [], adviceRemoved = 0;
        var chapter = fill((ext.contribute && ext.contribute.chapter) || ext.name, ent, opts.date, false).text;
        results.forEach(function (r) {
            var bullets = [];
            (r.facts || []).forEach(function (f) {
                if (ADVICE_RE.test(f.text)) { adviceRemoved++; return; }
                bullets.push({ text: f.text, source: r.source });
            });
            if (!bullets.length) {
                var why = r.note || (r.status === 'skipped' ? '來源條件不足' : '查不到');
                bullets.push({ text: '查不到（' + why + '）', source: r.source });
                unavailable.push({ id: r.id, label: r.label, note: why });
            }
            sections.push({ id: r.id, heading: r.label, bullets: bullets });
        });
        return { title: chapter, sections: sections, unavailable: unavailable, adviceRemoved: adviceRemoved };
    }

    function disclaimerOf(ext) {
        var d = str(ext.disclaimer).trim();
        return /投資/.test(d) ? d : DISCLAIMER_DEFAULT;
    }

    // ───── 貢獻到 media-presentation 的簡報（一章；每頁附來源；最後一頁固定免責聲明）─────
    function contributeToDeck(deck, built, ext) {
        var d = JSON.parse(JSON.stringify(deck || {}));
        if (!Array.isArray(d.chapters)) d.chapters = [];
        var per = (ext.contribute && ext.contribute.maxBulletsPerSlide) || 5;
        var chap = { title: clip(built.title, 120), slides: [] };
        chap.slides.push({ title: clip(built.title, 120), layout: 'title', narration: clip(built.title, LIMITS.narration) });
        built.sections.forEach(function (sec) {
            var items = sec.bullets;
            var srcs = uniq(items.map(function (b) { return b.source.label + (b.source.url ? '（' + b.source.url + '）' : ''); }));
            for (var i = 0, part = 0; i < items.length; i += per, part++) {
                var chunk = items.slice(i, i + per);
                var texts = chunk.map(function (b) { return clip(b.text, LIMITS.bullet); });
                chap.slides.push({
                    title: clip(sec.heading + (part ? '（續）' : ''), 120),
                    layout: 'content',
                    bullets: texts,
                    caption: clip('來源：' + srcs.join('；'), 400),
                    narration: clip(texts.join('。') + '。', LIMITS.narration),
                });
            }
        });
        var disc = disclaimerOf(ext);
        chap.slides.push({ title: '免責聲明', layout: 'content', bullets: [clip(disc, LIMITS.bullet)], narration: disc });
        var title = chap.title;
        d.chapters = d.chapters.filter(function (c) { return !(c && c.title === title); });
        if (ext.contribute && ext.contribute.position === 'start') d.chapters.unshift(chap); else d.chapters.push(chap);
        var nSlides = d.chapters.reduce(function (n, c) { return n + ((c && c.slides) || []).length; }, 0);
        if (d.chapters.length > LIMITS.chapters || nSlides > LIMITS.slides) return { ok: false, error: '簡報超過上限（' + LIMITS.chapters + ' 章／' + LIMITS.slides + ' 頁）' };
        return { ok: true, deck: d, chapter: title, added: chap.slides.length };
    }

    // ───── 工具說明（線上 AI 的工具表、離線工具目錄都用這一份）─────
    function toolSpec(ext) {
        return {
            name: ext.tool.name,
            description: ext.tool.description,
            parametersSchema: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: '股票代號（例如 2001）；省略時用目前網頁的代號' },
                    name: { type: 'string', description: '股票名稱（例如 大成鋼）；省略時用目前網頁的名稱' },
                    date: { type: 'string', description: '日期 yyyymmdd；省略時用今天' },
                },
                required: [],
            },
        };
    }

    // ───── 整條流程（注入 fetchText：宿主用代理抓，測試用固定快照）─────
    // input: { ctx:{url,title,selection}, args:{code,name,date}, date, fetchText(url) → Promise<string|null> }
    async function investigate(ext, input) {
        input = input || {};
        var v = validate(ext);
        if (!v.ok) return { ok: false, error: '擴充格式不合法：' + v.errors.join('；') };
        var det = detectContext(ext, input.ctx);
        var ent = resolveEntities(ext, det, input.args);
        if (!ent.code) return { ok: false, error: '找不到股票代號：請提供 code，或在股票網頁上使用' };
        var date = str(input.date || (input.args && input.args.date)).replace(/\D/g, '');
        var plans = planResearch(ext, ent, { date: date });
        var results = [];
        for (var i = 0; i < plans.length; i++) {
            var p = plans[i];
            if (p.skipped) { results.push({ id: p.id, label: p.label, source: { label: p.label, url: '' }, facts: [], status: 'skipped', note: p.reason }); continue; }
            var body = null, fetchErr = '';
            try { body = await (input.fetchText ? input.fetchText(p.url) : null); } catch (e) { fetchErr = '抓取失敗：' + str(e && e.message || e); }
            var ex = fetchErr ? { source: { label: p.label, url: p.url }, facts: [], dropped: 0, note: fetchErr } : extractSource(p, body, ent);
            var status = ex.facts.length ? 'ok' : (fetchErr || !str(body).trim() ? 'failed' : 'empty');
            results.push({ id: p.id, label: p.label, source: ex.source, facts: ex.facts, dropped: ex.dropped, status: status, note: ex.note });
        }
        var built = buildSections(ext, ent, results, { date: date });
        var contrib = contributeToDeck(input.deck || null, built, ext);
        return {
            ok: true, entities: ent, title: built.title, sections: built.sections, unavailable: built.unavailable,
            adviceRemoved: built.adviceRemoved, dropped: results.reduce(function (n, r) { return n + (r.dropped || 0); }, 0),
            results: results.map(function (r) { return { id: r.id, label: r.label, status: r.status, note: r.note, url: r.source.url }; }),
            disclaimer: disclaimerOf(ext), deck: contrib.ok ? contrib.deck : null, chapter: contrib.chapter || built.title, deckError: contrib.ok ? '' : contrib.error,
        };
    }

    return {
        DISCLAIMER_DEFAULT: DISCLAIMER_DEFAULT, ADVICE_RE: ADVICE_RE, LIMITS: LIMITS, LABELS: LABELS,
        validate: validate, createRegistry: createRegistry, register: register, loadAll: loadAll, remove: remove, list: list,
        detectContext: detectContext, resolveEntities: resolveEntities, fill: fill, planResearch: planResearch,
        extractSource: extractSource, verifyFacts: verifyFacts, buildSections: buildSections,
        contributeToDeck: contributeToDeck, toolSpec: toolSpec, investigate: investigate, disclaimerOf: disclaimerOf,
    };
});
