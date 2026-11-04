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
        s = s.replace(/^(?:請|幫我|幫忙|麻煩|可以)?(?:你)?(?:幫我)?(?:上網|網路上|網上|google|谷歌)?(?:搜尋|搜索|查詢|查一下|查一查|查查|查|找一下|找)\s*/i, '').replace(/\s*(?:是什麼意思|是什麼|是啥|什麼意思|是甚麼|的資料|相關資料|的相關資料|嗎|呢)[？?。.!！]*$/, '').replace(/[，,、\s]*(?:並|然後|再|且|還有)?(?:幫我|請)?(?:整理|摘要|總結|彙整|分析)(?:一下)?(?:成?(?:重點|報告|列表|表格|條列))?[。.!！]*$/, '').trim();
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
            else if (d.type === 'string' && /^(?:query|q|keyword|keywords|search|search_query|text|prompt|question|problem|problem_text|task|message|content|topic|scenario|requirement|requirements|description)$/i.test(n)) v = (sl.quoted || cleanQuery(text)) || undefined;
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
    // 去掉思考區塊：<think>…</think>（<thinking>…</thinking> 同樣處理），大小寫不分；只有開頭沒閉合時，從開頭到結尾都當作思考。
    // 回傳 { answer 去掉思考後的答案, reasoning 思考文字（多段以空行串接；沒有思考時為空字串）, unclosed 是否有未閉合的思考區塊 }
    function stripThink(text) {
        let s = String(text == null ? '' : text); const parts = [];
        s = s.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, (_, inner) => { const t = String(inner).trim(); if (t) parts.push(t); return ''; });
        let unclosed = false; const open = s.match(/<think(?:ing)?>([\s\S]*)$/i);
        if (open) { unclosed = true; const t = open[1].trim(); if (t) parts.push(t); s = s.slice(0, open.index); }
        return { answer: s.trim(), reasoning: parts.join('\n\n'), unclosed };
    }
    // CoLU+Thinking：某階段要不要開 thinking、預算與逾時（純函式，不呼叫模型）。
    // 只對 qwen3-0.6b 生效；enabled 預設 true，false 時一律關；只有 plan（計畫）與 reflect（反思）會開，route／fill 永遠關。
    // 預算＝contextTokens × 比例，再夾在 [min, max]，所以跟模型上下文一起縮放（不寫死單一常數）。
    const THINK_MODELS = new Set(['qwen3-0.6b']);
    const THINK_STAGES = {
        plan: { ratio: 0.4, min: 1500, max: 3000, timeoutMs: 30000 },
        reflect: { ratio: 0.075, min: 300, max: 600, timeoutMs: 15000 },
    };
    function thinkingPlan(opts) {
        opts = opts || {}; const off = { enabled: false, maxTokens: null, timeoutMs: null };
        if (opts.enabled === false) return off;
        if (!THINK_MODELS.has(String(opts.modelId == null ? '' : opts.modelId))) return off;
        const sp = Object.prototype.hasOwnProperty.call(THINK_STAGES, opts.stage) ? THINK_STAGES[opts.stage] : null; if (!sp) return off;
        const c = Number(opts.contextTokens); const ctxTok = Number.isFinite(c) && c > 0 ? c : 4096;
        return { enabled: true, maxTokens: Math.round(Math.min(sp.max, Math.max(sp.min, ctxTok * sp.ratio))), timeoutMs: sp.timeoutMs };
    }
    // ---------- CoLU+Thinking 反思（模型 thinking 反思；與「反思①②」程式流程、catalog/reflect_core.js 字詞反思都不同）----------
    // 反思題是封閉題：「這個計畫有沒有缺口？A 沒有 B 有：缺口是…」。只在 thinkingPlan({stage:'reflect'}) 開啟時才問。
    // 解析失敗、逾時、generate 拋錯一律視為「沒有缺口」（程式預設退路，不阻擋流程）。推理只回傳給呼叫端顯示，不進 messages。
    function coluThinkBudget(opts) { opts = opts || {}; return { total: 0, max: opts.max != null ? opts.max : 2, perQ: {}, perQMax: opts.perQMax != null ? opts.perQMax : 1 }; }
    // 回傳 { gap, note, reasoning, ok, error? }；沒有 thinking 時 skipped:true 且不呼叫 generate。
    function coluThinkReflect(opts) {
        opts = opts || {};
        const th = thinkingPlan({ modelId: opts.modelId, stage: 'reflect', contextTokens: opts.contextTokens, enabled: opts.enabled });
        if (!th.enabled || typeof opts.generate !== 'function') return Promise.resolve({ gap: false, note: '', reasoning: '', ok: false, skipped: true });
        const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : th.timeoutMs;
        const msgs = [
            { role: 'system', content: '你在檢查一個計畫有沒有缺口。只輸出一個 JSON 物件，格式：{"gap": true 或 false, "note": "缺口是什麼（一句話；沒有缺口就填空字串）"}。' },
            { role: 'user', content: '計畫：\n' + String(opts.question || '').slice(0, 1200) + '\n\n這個計畫有沒有缺口？A 沒有 B 有：缺口是…' },
        ];
        const work = jsonStep({ generate: opts.generate, messages: msgs, maxTries: 2, maxTokens: 160, prefill: '{"gap":', thinking: th,
            validate: (o) => { if (typeof o.gap !== 'boolean') return ['「gap」必須是 true 或 false']; if (o.gap && (typeof o.note !== 'string' || !o.note.trim())) return ['有缺口時「note」不能是空的']; return []; } })
            .then((r) => r, (e) => ({ ok: false, error: String((e && e.message) || e), reasoning: '' }));
        let timer = null;
        const cut = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: '逾時', reasoning: '' }), timeoutMs); });
        return Promise.race([work, cut]).then((r) => {
            clearTimeout(timer); const reasoning = String(r.reasoning || '');
            if (!r.ok) return { gap: false, note: '', reasoning, ok: false, error: r.error || '沒有合格的回覆' };
            const gap = r.value.gap === true; return { gap, note: gap ? String(r.value.note).trim().slice(0, 200) : '', reasoning, ok: true };
        });
    }
    // 反思後修正（一輪）：反思 → 有缺口就把 note 交回 redo(note) 重做一次 →（secondCheck 時）重做結果再反思一次，仍有缺口就用原本的。
    // budget（coluThinkBudget）：整份計畫最多 max 次反思；qid 不是 'plan' 的題目（答案核對失敗那一種）每題最多 perQMax 次。
    // opts: { qid, budget, generate, modelId, contextTokens, enabled, original, describe(value)→string, redo(note)→value|null（null＝重做也不合格）, secondCheck }
    // 回傳 { value, reflected 次數, gap, note, redone, fallback, reasoning, unsure }；value 預設是 original，只有通過才換成重做結果。
    async function coluThinkRevise(opts) {
        const b = opts.budget || coluThinkBudget(); const qid = String(opts.qid || 'plan'); const perQ = qid !== 'plan';
        const out = { value: opts.original, reflected: 0, gap: false, note: '', redone: false, fallback: false, reasoning: '', unsure: false };
        if (!thinkingPlan({ modelId: opts.modelId, stage: 'reflect', contextTokens: opts.contextTokens, enabled: opts.enabled }).enabled) return out;
        const take = () => { if (b.total >= b.max || (perQ && (b.perQ[qid] || 0) >= b.perQMax)) return false; b.total++; if (perQ) b.perQ[qid] = (b.perQ[qid] || 0) + 1; return true; };
        const ask = (value) => coluThinkReflect({ generate: opts.generate, modelId: opts.modelId, contextTokens: opts.contextTokens, enabled: opts.enabled, question: opts.describe(value) });
        if (!take()) { out.fallback = true; return out; }
        const r1 = await ask(opts.original); out.reflected = 1; out.reasoning = r1.reasoning; out.unsure = !r1.ok;
        if (!r1.gap) return out;
        out.gap = true; out.note = r1.note;
        let cand = null; try { cand = await opts.redo(r1.note); } catch (_) { cand = null; }
        if (cand == null) { out.fallback = true; return out; }
        out.redone = true;
        if (!opts.secondCheck) { out.value = cand; return out; }
        if (!take()) { out.fallback = true; return out; } // 第二次反思超過上限：用原計畫
        const r2 = await ask(cand); out.reflected = 2;
        if (r2.gap) { out.fallback = true; return out; } // 重做後仍有缺口：用原計畫
        out.value = cand; return out;
    }
    // 一個小而有型別的決策：ctx = { generate({messages,maxTokens})→string, messages, validate(obj)→[錯誤], maxTries=2, maxTokens=160 }
    // 回覆不合格 → 退回：模型只看到「它自己最後一次的回覆＋精確的錯誤」（不累積歷史）；連續兩次回覆完全相同就提前停止（小模型會原樣複誦錯誤答案）。
    // prefill：先替模型寫好回覆的開頭（例如 {"choice":），小模型就不會改用散文回答；generate 回傳的文字要包含這個開頭
    // ctx.thinking（選用，來自 thinkingPlan）：有且 enabled 時，先開 thinking 問一輪（maxTokens 用 thinking.maxTokens）；
    // 答案仍不合法 → 同一題改 enableThinking:false 再問一次（只一次）；再不行才走下面的 ok:false。
    // 沒有 ctx.thinking 時，generate 收到的參數與以前完全相同（不多帶任何欄位）。
    async function jsonStep(ctx) {
        const reasoning = []; const rejected = []; const th = ctx.thinking && ctx.thinking.enabled ? ctx.thinking : null; let calls = 0;
        const finish = (ok, extra) => Object.assign({ ok, tries: calls, rejected, reasoning: reasoning.join('\n\n') }, extra);
        const failErr = () => rejected.length ? rejected[rejected.length - 1].errors.join('；') : '沒有回覆';
        // 一輪：最多 maxTries 次，回覆不合格就退回重問（同前）；generate 拋錯回傳 thrown
        async function round(maxTries, maxTokens, enableThinking) {
            let last = null; let msgs = ctx.messages;
            for (let t = 1; t <= maxTries; t++) {
                const req = { messages: msgs, maxTokens, prefill: ctx.prefill }; if (th) { req.enableThinking = enableThinking; req.timeoutMs = th.timeoutMs; if (enableThinking) delete req.prefill; } // 開 thinking 那一輪不帶 prefill：prefill 會把 JSON 開頭寫死，模型就沒機會先想（退路那一輪才帶）
                calls++;
                let raw; try { raw = await ctx.generate(req); } catch (e) { return { thrown: true, error: String((e && e.message) || e) }; }
                // 先去掉思考區塊，驗證與退回都只看答案；思考文字另存在 reasoning（只給使用者看，不進 messages）
                const st = stripThink(raw); const text = st.answer; if (st.reasoning) reasoning.push(st.reasoning); const obj = parseJsonLoose(text);
                const errs = obj && typeof obj === 'object' && !Array.isArray(obj) ? (ctx.validate ? ctx.validate(obj) : []) : ['不是合法的 JSON 物件'];
                if (!errs.length) return { ok: true, value: obj };
                rejected.push({ reply: text.slice(0, 200), errors: errs });
                if (last !== null && text.trim() === last.trim()) break;
                last = text;
                msgs = ctx.messages.concat([{ role: 'assistant', content: text.slice(0, 300) }, { role: 'user', content: '上一個回覆不合格：' + errs.join('；') + '。請只輸出修正後的 JSON，不要多說別的。' }]);
            }
            return { ok: false };
        }
        const maxTries = ctx.maxTries || 2; const base = ctx.maxTokens || 160;
        if (!th) {
            const r = await round(maxTries, base, false);
            if (r.thrown) return finish(false, { error: r.error });
            return r.ok ? finish(true, { value: r.value }) : finish(false, { error: failErr() });
        }
        const a = await round(maxTries, th.maxTokens, true);
        if (a.thrown) return finish(false, { error: a.error });
        if (a.ok) return finish(true, { value: a.value });
        const b = await round(1, base, false); // 退路：同一題，關掉 thinking 再問一次
        if (b.thrown) return finish(false, { error: b.error });
        return b.ok ? finish(true, { value: b.value }) : finish(false, { error: failErr() });
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
        const r = await jsonStep({ generate: opts.generate, messages: fillMessages(opts.question, defs, opts.toolName), validate: validateFill(defs, opts.numbers), maxTries: opts.maxTries || 2, prefill: '{"' + defs[0].name + '":' });
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
        const n = opts.cands.length; const r = await jsonStep({ generate: opts.generate, messages: menuMessages(opts.question, opts.cands), maxTokens: 40, maxTries: opts.maxTries || 2, prefill: '{"choice":', validate: (o) => { const c = o.choice; if (!Number.isInteger(c)) return ['「choice」必須是整數']; if (c < 0 || c > n) return ['「choice」必須是 0～' + n + ' 之間的整數']; return []; } });
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

    // ---------- 參考資料包：把「線上 AI 養出來的」離線訓練器與 RAG，整理成離線模型能參考的樣子 ----------
    // items: [{ kind:'rule'|'steps'|'example'|'qa'|'rag', title, text, ts?, score? }]。依種類排優先（規則／做法 > 相似範例 > 過去問答 > RAG），
    // 每筆標明出處與年齡（過去問答可能過期，要讓模型知道），整體不超過 budgetTokens（呼叫端依模型上下文按比例給，不寫死）。
    const REF_LABEL = { rule: '離線訓練器的規則', steps: '離線訓練器學到的做法', example: '類似的問法', qa: '過去的問答', rag: 'RAG 知識庫' };
    const REF_ORDER = ['steps', 'rule', 'example', 'qa', 'rag'];
    function ageText(ts, now) { if (!ts) return ''; const d = Math.max(0, Math.floor(((now || Date.now()) - ts) / 86400000)); return d === 0 ? '今天' : d + ' 天前'; }
    function estTok(s) { s = String(s || ''); let cjk = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 0x3000 && c <= 0x9fff) cjk++; } return Math.ceil(cjk + (s.length - cjk) / 3.5); }
    function clip(s, tokens) { s = String(s || '').replace(/\s+/g, ' ').trim(); if (estTok(s) <= tokens) return s; let lo = 0, hi = Math.min(s.length, tokens * 4 + 8); while (lo < hi) { const m = (lo + hi + 1) >> 1; if (estTok(s.slice(0, m)) <= tokens) lo = m; else hi = m - 1; } return s.slice(0, lo) + '…'; }
    function buildReferencePack(items, budgetTokens, opts) {
        opts = opts || {}; const now = opts.now || Date.now(); const maxItems = opts.maxItems || 8;
        const sorted = (items || []).filter((x) => x && String(x.text || '').trim()).slice().sort((a, b) => REF_ORDER.indexOf(a.kind) - REF_ORDER.indexOf(b.kind) || (Number(b.score) || 0) - (Number(a.score) || 0));
        const picked = sorted.slice(0, maxItems); const per = Math.max(40, Math.floor(budgetTokens / Math.max(1, picked.length)));
        const lines = []; let used = 0; let dropped = sorted.length - picked.length;
        for (const it of picked) {
            const head = '【' + (REF_LABEL[it.kind] || it.kind) + (it.title ? '：' + String(it.title).slice(0, 40) : '') + (it.kind === 'qa' && it.ts ? '，' + ageText(it.ts, now) + '，可能已過期' : '') + '】';
            const line = head + clip(it.text, Math.max(20, per - estTok(head))); const n = estTok(line);
            if (used + n > budgetTokens) { dropped++; continue; } lines.push(line); used += n;
        }
        return { lines, text: lines.map((l, i) => (i + 1) + '. ' + l).join('\n'), used, dropped };
    }
    // ---------- 離線摘要：沒有模型（或模型失敗）時的程式摘要＋長文切段 ----------
    function splitSentences(text) { return String(text || '').replace(/\r/g, '').split(/(?<=[。！？!?；;])\s*|\n+|(?<=[a-z0-9])\.\s+(?=[A-Z])/).map((s) => s.trim()).filter((s) => s.length >= 4); }
    function extractiveSummary(text, maxSentences) {
        const sents = splitSentences(text); if (sents.length <= (maxSentences || 5)) return sents.join('\n');
        const freq = new Map(); const toks = sents.map((s) => Array.from(tokensOf(s))); toks.forEach((ts) => ts.forEach((t) => freq.set(t, (freq.get(t) || 0) + 1)));
        const score = sents.map((s, i) => { const ts = toks[i]; if (!ts.length) return 0; let sc = 0; for (const t of ts) { const f = freq.get(t); if (f > 1) sc += Math.log(1 + f); } return sc / Math.sqrt(ts.length) + (i < 2 ? 0.8 : 0) + (s.length > 220 ? -0.5 : 0); });
        const top = score.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, maxSentences || 5).map((x) => x[1]).sort((a, b) => a - b);
        return top.map((i) => sents[i].slice(0, 200)).join('\n');
    }
    // 依 token 預算把長文切成幾段（盡量在句子邊界切）；maxTokens 由呼叫端依模型上下文給
    function chunkText(text, maxTokens) {
        const sents = splitSentences(text); const chunks = []; let cur = []; let n = 0;
        for (const s of sents) { const t = estTok(s); if (cur.length && n + t > maxTokens) { chunks.push(cur.join('\n')); cur = []; n = 0; } cur.push(s.length > maxTokens * 3 ? s.slice(0, maxTokens * 3) : s); n += t; }
        if (cur.length) chunks.push(cur.join('\n')); return chunks;
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

    // ---------- CoLU+Thinking 介面（設定開關與推理區塊；純函式，設定面板、進度卡片與測試共用）----------
    // 開關值：未設定（undefined／null）或 true 都視為開（預設打開）；只有明確的 false 才關。
    function coluThinkingSetting(raw) { return raw !== false; }
    const REASONING_SHOW_MAX = 20000;
    function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    // 推理內容的顯示規則：去掉頭尾空白後為空就不顯示；超過 max 字（預設 20000）就截斷，並記下總字數。
    function reasoningView(text, max) {
        const lim = max != null && max > 0 ? max : REASONING_SHOW_MAX;
        const full = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
        if (!full) return { show: false, text: '', truncated: false, total: 0, limit: lim };
        if (full.length <= lim) return { show: true, text: full, truncated: false, total: full.length, limit: lim };
        return { show: true, text: full.slice(0, lim), truncated: true, total: full.length, limit: lim };
    }
    // 推理區塊（預設收合）：摘要寫「思考過程」（可加階段名）；內容是純文字、先跳脫 HTML；截斷時註明已截斷與總字數。空推理回傳空字串（不顯示區塊）。
    function reasoningBlockHtml(text, label, max) {
        const v = reasoningView(text, max); if (!v.show) return '';
        const cut = v.truncated ? '<div class="colu-think-note" style="opacity:.75; margin-top:4px;">（已截斷：只顯示前 ' + v.limit + ' 字，共 ' + v.total + ' 字）</div>' : '';
        return '<details class="colu-think-block" style="margin-top:6px;"><summary style="cursor:pointer; opacity:.85;">思考過程' + (label ? '（' + escapeHtml(label) + '）' : '') + '</summary>' +
            '<pre class="colu-think-text" style="white-space:pre-wrap; word-break:break-word; margin:6px 0 0; max-height:320px; overflow:auto; font:11px/1.5 ui-monospace,Consolas,monospace; color:#475569;">' + escapeHtml(v.text) + '</pre>' + cut + '</details>';
    }
    return { buildReferencePack, extractiveSummary, chunkText, splitSentences, parseAttachments, stripAttachments, kindOf, cleanQuery, narrowByEvidence, relevantOptional, slotsFromSchema, programFill, parseJsonLoose, stripThink, thinkingPlan, coluThinkBudget, coluThinkReflect, coluThinkRevise, coluThinkingSetting, escapeHtml, reasoningView, reasoningBlockHtml, REASONING_SHOW_MAX, jsonStep,fillMessages, validateFill, modelFill, autoPick, menuMessages, chooseTool, tokensOf, checkExtractive, phraseMessages, newTrace, decide, pushRing, tracesToLines, validateRecipe, runRecipe, interp, MAX_STEPS };
});
