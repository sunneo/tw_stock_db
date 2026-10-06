/* 離線小模型的「食譜」（Recipe）核心：決策樹＋狀態機＋選擇題／填空題，讓 0.5～1.7B 的離線模型也能完成工具型的服務。
 *
 * 設計原則（跟 redmine 那邊的 recipe 一致，細節見 DESIGN.offline-recipes.md）：
 *   - 程式能決定的就程式決定：路由（候選分數差距夠大）、欄位（網址、路徑、附件、列舉值、預設值）、驗證、版面、措辭樣板。
 *   - 模型只做剩下的、一次一個、沒有前面步驟的記憶：「從編號選單挑一個」「填這幾個型別固定的欄位」「用一兩句話說明（之後被檢查）」。
 *   - 每個決定都有紀錄（誰決定的、選項、被退回的原因），之後可以拿來訓練。
 *   - 純函式（UMD），generate／execTool 都是注入的，所以能用假模型完整測試；也能原封不動搬到別的宿主（redmine）。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaRecipe = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---------- 附件與檔案種類 ----------
    // 訊息裡的 [附件：a.png（file_id=xxx）、b.jpg（file_id=yyy）]
    function parseAttachments(text) {
        const out = []; const m = /\[附件：([^\]]*)\]/.exec(String(text || '')); if (!m) return out;
        const re = /([^、（]+?)（file_id=([\w-]+)）/g; let x; while ((x = re.exec(m[1]))) out.push({ filename: x[1].trim(), id: x[2] });
        return out;
    }
    function stripAttachments(text) { return String(text || '').replace(/\[附件：[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim(); }
    function kindOf(filename) {
        const e = (/\.([a-z0-9]+)$/i.exec(String(filename || '')) || [])[1]; const x = e ? e.toLowerCase() : '';
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(x)) return 'image';
        if (x === 'pdf') return 'pdf';
        if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(x)) return 'video';
        if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'].includes(x)) return 'audio';
        if (['srt', 'vtt', 'ass'].includes(x)) return 'subtitle';
        return 'other';
    }

    // ---------- 欄位（從工具的 JSON Schema 來）----------
    function slotsFromSchema(schema) {
        const props = (schema && schema.properties) || {}; const req = new Set((schema && schema.required) || []); const out = [];
        for (const name of Object.keys(props)) {
            const p = props[name] || {};
            out.push({ name, type: p.type || 'string', itemsType: p.items && p.items.type, enum: Array.isArray(p.enum) ? p.enum.slice() : null, required: req.has(name), description: String(p.description || '').replace(/\s+/g, ' ').slice(0, 120), default: p.default, min: p.minimum, max: p.maximum });
        }
        return out;
    }

    // 搜尋／查詢類欄位的內容：拿掉網址與附件標記、開頭的指令動詞（上網搜尋、幫我查…）與結尾的「是什麼」；冒號後面（不是網址裡的冒號）優先
    function cleanQuery(text) {
        let s = stripAttachments(text).replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
        const colon = /[:：]\s*(.+)$/.exec(s); if (colon && colon[1].trim().length >= 2) s = colon[1].trim();
        s = s.replace(/^(?:請|幫我|幫忙|麻煩|可以)?(?:你)?(?:幫我)?(?:上網|網路上|網上|google|谷歌)?(?:搜尋|搜索|查詢|查一下|查一查|查查|查|找一下|找)\s*/i, '').replace(/\s*(?:是什麼意思|是什麼|是啥|什麼意思|是甚麼|的資料|相關資料|的相關資料|嗎|呢)[？?。.!！]*$/, '').trim();
        return s || stripAttachments(text);
    }
    // ---------- 程式填欄位 ----------
    // ctx: { text, slots（_faOtSlots 的結果：url、path、quoted、after_colon…）, attachments:[{id,filename}] }
    // 回傳 { values, by:{欄位:'program'|'default'}, missing:[slot def] }——只有「程式真的決定不了」的欄位才會留在 missing，交給模型。
    function programFill(defs, ctx) {
        const values = {}; const by = {}; const text = String((ctx && ctx.text) || ''); const low = text.toLowerCase(); const sl = (ctx && ctx.slots) || {}; const atts = (ctx && ctx.attachments) || [];
        const clean = stripAttachments(text); const enumLow = clean.toLowerCase().replace(/https?:\/\/\S+/g, ' ');
        const attOfKind = (kinds) => atts.filter((a) => !kinds || kinds.includes(kindOf(a.filename)));
        const kindsFor = (name, desc) => { const s = name + ' ' + (desc || ''); return /image|img|photo|picture|png|jpg|圖片|圖像|照片|截圖/i.test(s) ? ['image'] : (/pdf/i.test(s) ? ['pdf'] : (/video|movie|clip|影片|視訊/i.test(s) ? ['video'] : (/audio|sound|voice|音檔|音訊|語音/i.test(s) ? ['audio'] : (/subtitle|srt|caption|字幕/i.test(s) ? ['subtitle'] : null)))); };
        const numericDefs = defs.filter((d) => (d.type === 'integer' || d.type === 'number') && d.required);
        for (const d of defs) {
            const n = d.name; let v;
            if (d.enum && d.enum.length) { // 列舉：文字裡剛好出現「一個」列舉值
                const hits = d.enum.filter((e) => String(e).length >= 2 && new RegExp('(?:^|[^a-z0-9])' + String(e).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^a-z0-9])').test(enumLow));
                if (hits.length === 1) v = hits[0];
            } else if (d.type === 'string' && /^(?:url|link|href|page_url|website)$/i.test(n)) v = sl.url || undefined;
            else if (d.type === 'array' && /^(?:files?|file_ids?|images?|attachments?|pdfs?|inputs?|paths?)$/i.test(n)) { const a = attOfKind(kindsFor(n, d.description)); if (a.length) v = a.map((x) => x.id); }
            else if (d.type === 'string' && /^(?:file(?:_id)?|image(?:_id)?|video(?:_id)?|audio(?:_id)?|pdf(?:_id)?|attachment(?:_id)?|input(?:_file)?|source)$/i.test(n)) { const a = attOfKind(kindsFor(n, d.description)); if (a.length) v = a[a.length - 1].id; else if (sl.path) v = sl.path; }
            else if (d.type === 'string' && /^(?:path|filepath|file_path|dir|directory|folder)$/i.test(n)) v = sl.path || undefined;
            else if (d.type === 'string' && /^(?:query|q|keyword|keywords|search|search_query|text|prompt|question|problem|problem_text|task|message|content|topic)$/i.test(n)) v = (sl.quoted || cleanQuery(text)) || undefined;
            else if ((d.type === 'integer' || d.type === 'number') && numericDefs.length === 1 && d.required && Array.isArray(sl.numbers) && sl.numbers.length === 1) { const x = Number(sl.numbers[0]); if (Number.isFinite(x)) v = d.type === 'integer' ? Math.round(x) : x; }
            if (v !== undefined && v !== '') { values[n] = v; by[n] = 'program'; continue; }
            if (d.default !== undefined) { values[n] = d.default; by[n] = 'default'; continue; }
        }
        // 沒填到、但選填的欄位不用問模型（留空由工具用自己的預設）；必填的才算 missing
        const missing = defs.filter((d) => values[d.name] === undefined && d.required);
        return { values, by, missing };
    }

    // ---------- 模型填空：強制 JSON、驗證、退回 ----------
    function parseJsonLoose(text) {
        let s = String(text == null ? '' : text).replace(/<think>[\s\S]*?<\/think>/g, '').trim(); s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        try { return JSON.parse(s); } catch (_) {}
        const i = s.indexOf('{'); if (i < 0) return null; let depth = 0, inStr = false, esc = false;
        for (let j = i; j < s.length; j++) { const c = s[j]; if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; } if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; } } } }
        return null;
    }
    // 一個小而有型別的決策：ctx = { generate({messages,maxTokens})→string, messages, validate(obj)→[錯誤], maxTries=2, maxTokens=160 }
    // 回覆不合格 → 退回：模型只看到「它自己最後一次的回覆＋精確的錯誤」（不累積歷史）；連續兩次回覆完全相同就提前停止（小模型會原樣複誦錯誤答案）。
    async function jsonStep(ctx) {
        const maxTries = ctx.maxTries || 2; const rejected = []; let last = null; let msgs = ctx.messages;
        for (let tries = 1; tries <= maxTries; tries++) {
            let raw; try { raw = await ctx.generate({ messages: msgs, maxTokens: ctx.maxTokens || 160 }); } catch (e) { return { ok: false, tries, rejected, error: String((e && e.message) || e) }; }
            const text = String(raw == null ? '' : raw); const obj = parseJsonLoose(text);
            const errs = obj && typeof obj === 'object' && !Array.isArray(obj) ? (ctx.validate ? ctx.validate(obj) : []) : ['不是合法的 JSON 物件'];
            if (!errs.length) return { ok: true, value: obj, tries, rejected };
            rejected.push({ reply: text.slice(0, 200), errors: errs });
            if (last !== null && text.trim() === last.trim()) break;
            last = text;
            msgs = ctx.messages.concat([{ role: 'assistant', content: text.slice(0, 300) }, { role: 'user', content: '上一個回覆不合格：' + errs.join('；') + '。請只輸出修正後的 JSON，不要多說別的。' }]);
        }
        return { ok: false, tries: rejected.length, rejected, error: rejected.length ? rejected[rejected.length - 1].errors.join('；') : '沒有回覆' };
    }
    // 填欄位：只問「還缺的」；prompt 不放範例數字或範例值（小模型會照抄）；不知道就填 null（不要編）
    function fillMessages(question, defs, toolName) {
        const lines = defs.map((d) => '- ' + d.name + '（' + (d.enum ? '只能是：' + d.enum.join('、') : (d.type === 'integer' ? '整數' : d.type === 'number' ? '數字' : d.type === 'boolean' ? 'true 或 false' : d.type === 'array' ? '字串陣列' : '字串')) + '）' + (d.description ? '：' + d.description : '')).join('\n');
        return [{ role: 'system', content: '你負責從使用者的話裡找出工具「' + toolName + '」需要的欄位。只輸出一個 JSON 物件，鍵只能是下面列出的欄位。使用者的話裡沒有提到、你不確定的欄位填 null，不要猜、不要編。' }, { role: 'user', content: '需要的欄位：\n' + lines + '\n\n使用者的話：\n' + String(question).slice(0, 1200) }];
    }
    // numbers：使用者的話裡出現過的數字（字串陣列）；給了就要求數字欄位的值必須是其中之一——小模型最常見的錯是編一個數字（例如把「前 5 秒」填成 fps=5 以外的隨便一個值）
    function validateFill(defs, numbers) {
        const by = new Map(defs.map((d) => [d.name, d])); const numSet = numbers ? new Set(numbers.map(Number)) : null;
        return (obj) => {
            const errs = [];
            for (const k of Object.keys(obj)) if (!by.has(k)) errs.push('不認得的欄位「' + k + '」（只能用：' + defs.map((d) => d.name).join('、') + '）');
            for (const d of defs) {
                if (!(d.name in obj)) { errs.push('缺少欄位「' + d.name + '」（不知道就填 null）'); continue; }
                const v = obj[d.name]; if (v === null) continue;
                if (d.enum && !d.enum.map(String).includes(String(v))) errs.push('「' + d.name + '」必須是：' + d.enum.join('、') + '（你填了 ' + JSON.stringify(v) + '）');
                else if (d.type === 'integer' && !(Number.isInteger(v))) errs.push('「' + d.name + '」必須是整數');
                else if (d.type === 'number' && !(typeof v === 'number' && Number.isFinite(v))) errs.push('「' + d.name + '」必須是數字');
                else if (d.type === 'boolean' && typeof v !== 'boolean') errs.push('「' + d.name + '」必須是 true 或 false');
                else if (d.type === 'array' && !Array.isArray(v)) errs.push('「' + d.name + '」必須是陣列');
                else if (d.type === 'string' && !d.enum && (typeof v !== 'string' || !v.trim() || v.length > 600)) errs.push('「' + d.name + '」必須是 1～600 字的字串');
                if ((d.type === 'integer' || d.type === 'number') && typeof v === 'number' && numSet && !numSet.has(v)) errs.push('「' + d.name + '」的數字 ' + v + ' 沒有出現在使用者的話裡（只能用使用者說過的數字；沒有就填 null）');
                if ((d.type === 'integer' || d.type === 'number') && typeof v === 'number') { if (d.min != null && v < d.min) errs.push('「' + d.name + '」不能小於 ' + d.min); if (d.max != null && v > d.max) errs.push('「' + d.name + '」不能大於 ' + d.max); }
            }
            return errs;
        };
    }
    // 讓模型補欄位。回傳 { ok, values（只含模型填了非 null 的）, missing（模型也填不出的）, tries, rejected, error? }
    async function modelFill(opts) {
        const defs = opts.missing; if (!defs.length) return { ok: true, values: {}, missing: [], tries: 0, rejected: [] };
        const r = await jsonStep({ generate: opts.generate, messages: fillMessages(opts.question, defs, opts.toolName), validate: validateFill(defs, opts.numbers), maxTries: opts.maxTries || 2 });
        if (!r.ok) return { ok: false, values: {}, missing: defs, tries: r.tries, rejected: r.rejected, error: r.error };
        const values = {}; const still = [];
        for (const d of defs) { const v = r.value[d.name]; if (v === null || v === undefined) still.push(d); else values[d.name] = d.type === 'string' && typeof v === 'string' ? v.trim() : v; }
        return { ok: true, values, missing: still, tries: r.tries, rejected: r.rejected };
    }

    // 選填欄位要不要問模型：使用者的話裡要有跟欄位名稱（fps、width…）或描述（幀率、寬度…）有關的字，或提到了列舉值——沒有關連就不問（避免模型為了填空而編）
    function relevantOptional(defs, question) {
        const q = tokensOf(question); const low = String(question || '').toLowerCase();
        return defs.filter((d) => {
            const parts = d.name.toLowerCase().split(/[_\W]+/).filter((x) => x.length >= 2); if (parts.some((x) => low.includes(x))) return true;
            for (const t of tokensOf(d.description)) if (!/^\d/.test(t) && q.has(t)) return true;
            return !!(d.enum && d.enum.some((e) => String(e).length >= 2 && low.includes(String(e).toLowerCase())));
        });
    }
    // ---------- 路由 ----------
    // 先用「證據」縮小候選（程式能決定的就程式決定）：文字裡有網址 → 只留有 url 欄位的工具；有附件 → 只留「必填的檔案欄位能用這些附件填」的工具。
    // 縮小之後只剩一個就不用問模型。defsByTool: { 工具名: [slot def] }；ctx 同 programFill
    function narrowByEvidence(cands, defsByTool, ctx) {
        let list = cands.slice(); const why = [];
        const atts = (ctx && ctx.attachments) || []; const hasUrl = !!(ctx && ctx.slots && ctx.slots.url);
        if (hasUrl) { const k = list.filter((c) => (defsByTool[c.tool] || []).some((d) => /^(?:url|link|href|page_url|website)$/i.test(d.name))); if (k.length) { list = k; why.push('文字裡有網址'); } }
        if (atts.length) {
            const fileSlot = (d) => /^(?:files?|file_ids?|file|image|images|video|audio|pdf|pdfs|attachment|attachments|input|source)$/i.test(d.name);
            const k = list.filter((c) => { const need = (defsByTool[c.tool] || []).filter((d) => d.required && fileSlot(d)); return need.length && programFill(need, ctx).missing.length === 0; });
            if (k.length) { list = k; why.push('有附件'); }
        }
        return { cands: list, why };
    }
    // ---------- 路由：候選分數差距夠大就程式決定，否則給模型一個編號選單 ----------
    // cands: [{ tool, intent, score }]（分數由離線訓練器給）；回傳 { index, by:'program' } 或 null（要問模型）
    function autoPick(cands, opts) {
        opts = opts || {}; const minScore = opts.minScore != null ? opts.minScore : 0.5, margin = opts.margin != null ? opts.margin : 0.12;
        if (!cands.length) return null; const s = cands.map((c) => Number(c.score) || 0);
        if (cands.length === 1) return s[0] >= (opts.minSingle != null ? opts.minSingle : 0.35) ? { index: 0, by: 'program' } : null;
        if (s[0] >= minScore && s[0] - s[1] >= margin) return { index: 0, by: 'program' };
        return null;
    }
    function menuMessages(question, cands) {
        const lines = cands.map((c, i) => (i + 1) + '. ' + String(c.intent || c.tool).replace(/\s+/g, ' ').slice(0, 60) + '（工具 ' + c.tool + '）').join('\n');
        return [{ role: 'system', content: '你負責替使用者的話挑一個合適的工具。只輸出一個 JSON 物件，格式：{"choice": 編號}。編號只能是選單裡有的數字；0 代表「這些都不合適，只是一般聊天或問答」。' }, { role: 'user', content: '選單：\n' + lines + '\n0. 都不是（一般聊天或問答）\n\n使用者的話：\n' + String(question).slice(0, 800) }];
    }
    async function chooseTool(opts) {
        const n = opts.cands.length; const r = await jsonStep({ generate: opts.generate, messages: menuMessages(opts.question, opts.cands), maxTokens: 40, maxTries: opts.maxTries || 2, validate: (o) => { const c = o.choice; if (!Number.isInteger(c)) return ['「choice」必須是整數']; if (c < 0 || c > n) return ['「choice」必須是 0～' + n + ' 之間的整數']; return []; } });
        if (!r.ok) return { ok: false, rejected: r.rejected, tries: r.tries, error: r.error };
        return { ok: true, index: r.value.choice - 1, none: r.value.choice === 0, by: 'model', tries: r.tries, rejected: r.rejected };
    }

    // ---------- 措辭：模型寫 1～2 句，之後被檢查（不過就用程式的樣板）----------
    function tokensOf(s) { s = String(s || '').toLowerCase(); const out = new Set(); (s.match(/\d+(?:\.\d+)?/g) || []).forEach((x) => out.add(x)); (s.match(/[a-z][a-z0-9_]{2,}/g) || []).forEach((x) => out.add(x)); (s.match(/[㐀-鿿]+/g) || []).forEach((run) => { if (run.length === 1) out.add(run); for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2)); }); return out; }
    // extractive：只濃縮、不新增。數字與英文識別字要（幾乎）全部出現在來源裡，而且不能有來源沒有的數字（小模型最常見的錯是編一個數字）；
    // 中文詞用較寬的門檻（cjkMin 預設 0.6）——改寫常會換動詞，但整段新內容（來源完全沒提的詞）會被擋下
    function checkExtractive(output, sources, opts) {
        opts = opts || {}; const min = opts.min != null ? opts.min : 0.85, cjkMin = opts.cjkMin != null ? opts.cjkMin : 0.6; const out = String(output || '').trim();
        if (!out) return { ok: false, reason: '空白' }; if (out.length > (opts.maxChars || 400)) return { ok: false, reason: '太長' };
        const src = tokensOf([].concat(sources).join('\n')); const toks = Array.from(tokensOf(out)); if (!toks.length) return { ok: false, reason: '沒有內容' };
        const isCjk = (t) => /[㐀-鿿]/.test(t); const strict = toks.filter((t) => !isCjk(t)), cjk = toks.filter(isCjk);
        const badNum = strict.filter((t) => /^\d/.test(t) && !src.has(t)); if (badNum.length) return { ok: false, reason: '出現來源沒有的數字：' + badNum.slice(0, 3).join('、') };
        const sCover = strict.length ? strict.filter((t) => src.has(t)).length / strict.length : 1; const cCover = cjk.length ? cjk.filter((t) => src.has(t)).length / cjk.length : 1;
        if (sCover < min) return { ok: false, reason: '有 ' + Math.round((1 - sCover) * 100) + '% 的英文／數字來源裡沒有', cover: sCover };
        if (cCover < cjkMin) return { ok: false, reason: '有 ' + Math.round((1 - cCover) * 100) + '% 的詞來源裡沒有', cover: cCover };
        return { ok: true, cover: Math.min(sCover, cCover) };
    }
    function phraseMessages(question, resultText, instruction) {
        return [{ role: 'system', content: '你根據「工具結果」用繁體中文寫 1～2 句話回答使用者。只能使用工具結果裡有的資訊、數字與名稱，不要新增、不要猜測。' + (instruction ? instruction : '') }, { role: 'user', content: '使用者的問題：' + String(question).slice(0, 400) + '\n\n工具結果：\n' + String(resultText).slice(0, 2400) + '\n\n請用 1～2 句話回答。' }];
    }

    // ---------- 決策紀錄 ----------
    function newTrace(question, meta) { return Object.assign({ at: Date.now(), question: String(question || '').slice(0, 300), decisions: [] }, meta || {}); }
    function decide(trace, d) { trace.decisions.push(Object.assign({ at: Date.now() }, d)); return trace; }
    // ring buffer：最多 max 筆、總大小最多 maxBytes（超過就丟最舊的）
    function pushRing(list, trace, max, maxBytes) { const out = (list || []).concat([trace]); while (out.length > (max || 30)) out.shift(); while (out.length > 1 && JSON.stringify(out).length > (maxBytes || 400000)) out.shift(); return out; }
    function tracesToLines(list) { return (list || []).map((t) => JSON.stringify(t)).join('\n'); }

    // ---------- 多步驟食譜引擎（steps：tool／compute／phrase／render）----------
    const MAX_STEPS = 12;
    function getPath(obj, p) { let cur = obj; for (const k of String(p).split('.')) { if (cur == null) return undefined; cur = cur[k]; } return cur; }
    function interp(v, scope) {
        if (typeof v === 'string') { const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(v); if (whole) return getPath(scope, whole[1]); return v.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, p) => { const x = getPath(scope, p); return x == null ? '' : (typeof x === 'object' ? JSON.stringify(x) : String(x)); }); }
        if (Array.isArray(v)) return v.map((x) => interp(x, scope));
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interp(x, scope)]));
        return v;
    }
    function validateRecipe(r) {
        const errs = []; if (!r || typeof r !== 'object') return ['食譜不是物件'];
        if (!/^[a-z][a-z0-9_]{0,30}$/.test(r.id || '')) errs.push('id 格式不合法');
        if (!Array.isArray(r.steps) || !r.steps.length) errs.push('沒有步驟'); else if (r.steps.length > MAX_STEPS) errs.push('步驟超過 ' + MAX_STEPS);
        const ids = new Set();
        for (const s of r.steps || []) { if (!['tool', 'compute', 'phrase', 'render'].includes(s.type)) errs.push('不認得的步驟類型：' + s.type); if (!/^[a-z][a-z0-9_]{0,30}$/.test(s.id || '')) errs.push('步驟 id 不合法：' + s.id); if (ids.has(s.id)) errs.push('步驟 id 重複：' + s.id); ids.add(s.id); }
        if (r.result && !ids.has(r.result)) errs.push('result 指向不存在的步驟：' + r.result);
        return errs;
    }
    // env: { tool(name,args)→{ok,text,raw}, fns:{name(args,scope)→值}, phrase({question,input,instruction,check})→string|null, trace?, question }
    async function runRecipe(recipe, slots, env) {
        const errs = validateRecipe(recipe); if (errs.length) return { ok: false, error: '食譜不合法：' + errs.join('；') };
        const scope = { slots: slots || {}, vars: {} }; const trace = env.trace;
        for (const s of recipe.steps) {
            try {
                if (s.type === 'tool') {
                    const args = interp(s.args || {}, scope); const r = await env.tool(s.name, args); scope.vars[s.id] = r;
                    if (trace) decide(trace, { stage: 'step', step: s.id, type: 'tool', tool: s.name, answer: r && r.ok ? 'ok' : 'failed', by: 'program' });
                    if (!r || !r.ok) { if (s.optional) continue; return { ok: false, error: '步驟「' + s.id + '」（工具 ' + s.name + '）失敗：' + String((r && r.text) || '').slice(0, 200), vars: scope.vars }; }
                } else if (s.type === 'compute') {
                    const fn = env.fns && env.fns[s.fn]; if (!fn) return { ok: false, error: '沒有註冊的函式：' + s.fn };
                    scope.vars[s.id] = await fn(interp(s.args || {}, scope), scope); if (trace) decide(trace, { stage: 'step', step: s.id, type: 'compute', fn: s.fn, by: 'program' });
                } else if (s.type === 'phrase') {
                    const input = interp(s.input, scope); const text = typeof input === 'string' ? input : (input && input.text) || JSON.stringify(input);
                    let out = null; if (env.phrase) { try { out = await env.phrase({ question: env.question, input: text, instruction: s.instruction, check: s.check || 'extractive' }); } catch (_) { out = null; } }
                    const fb = s.fallback != null ? interp(s.fallback, scope) : text; scope.vars[s.id] = out != null ? out : (typeof fb === 'string' ? fb : JSON.stringify(fb));
                    if (trace) decide(trace, { stage: 'step', step: s.id, type: 'phrase', by: out != null ? 'model' : 'program', answer: out != null ? 'model' : 'fallback' });
                } else if (s.type === 'render') { scope.vars[s.id] = interp(s.template, scope); }
            } catch (e) { if (s.optional) continue; return { ok: false, error: '步驟「' + s.id + '」出錯：' + String((e && e.message) || e), vars: scope.vars }; }
        }
        const res = recipe.result ? scope.vars[recipe.result] : scope.vars[recipe.steps[recipe.steps.length - 1].id];
        return { ok: true, text: typeof res === 'string' ? res : JSON.stringify(res), vars: scope.vars };
    }

    return { parseAttachments, stripAttachments, kindOf, cleanQuery, narrowByEvidence, relevantOptional, slotsFromSchema, programFill, parseJsonLoose, jsonStep, fillMessages, validateFill, modelFill, autoPick, menuMessages, chooseTool, tokensOf, checkExtractive, phraseMessages, newTrace, decide, pushRing, tracesToLines, validateRecipe, runRecipe, interp, MAX_STEPS };
});
