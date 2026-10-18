/* 技能→食譜編譯器（FaSkillC）：讀一份技能（SKILL.md／persona prompt，內建的或匯入的），解讀成「可重複執行的食譜」。
 *
 * CoLU 的形狀：程式讀、程式綁、程式檢查；模型只在歧義時從封閉選單挑；對不上的不猜，列成「缺口」交給 UML design（缺的能力）。
 *   extract：從文字抽出  ① 觸發詞（技能名稱、description 的關鍵詞）② 步驟（編號清單／Step N／「WORKFLOW」底下的項目）③ 每一步提到的工具（只認工具表裡真的有的名稱）④ 提到的腳本。
 *   compile：每個有工具的步驟 → 食譜的 tool 步驟；工具的欄位依「名稱＋型別」綁到手上有的東西（附件、網址、使用者的話、使用者說的選項）；
 *            綁不到的必填欄位、沒有對應工具的步驟、只提到腳本的步驟 → gaps（每個缺口附一句給 uml_design 的情境、以及搜尋到的相近現有工具）。
 *   最後一個 tool 步驟標成 final（由呼叫端執行）；有缺口的食譜是 draft（不自動使用），沒有缺口的是 compiled。
 * 純函式（UMD）；沒有任何模型呼叫（歧義用 pick 注入：封閉選擇題，沒有就用程式的第一名）。
 */
(function (root, factory) {
    const R = (typeof FaRecipe !== 'undefined' && FaRecipe) || (root && root.FaRecipe) || (typeof require === 'function' ? require('./recipe_core.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(R);
    else root.FaSkillC = factory(R);
})(typeof self !== 'undefined' ? self : this, function (R) {
    'use strict';

    const STOP = new Set('the and for with that this from into your you are will when then use used using not any all can its has have but also only each per via should must may one two'.split(' '));
    const MAX_STEPS = (R && R.MAX_STEPS) || 12;

    function stripFrontmatter(text) {
        const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(String(text || '')); if (!m) return { meta: {}, body: String(text || '') };
        const meta = {}; for (const ln of m[1].split('\n')) { const k = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(ln); if (k) meta[k[1].toLowerCase()] = k[2].replace(/^["']|["']$/g, '').trim(); }
        return { meta, body: String(text).slice(m[0].length) };
    }
    // 觸發詞：技能名稱的字、description 裡的關鍵詞（英文取 4 字母以上的非停用字；中文取 2～4 字的詞）
    function triggerWords(name, description) {
        const out = []; const add = (w) => { w = String(w).trim(); if (w && !out.includes(w) && out.length < 14) out.push(w); };
        String(name || '').split(/[-_\s]+/).filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase())).forEach(add);
        const d = String(description || '');
        (d.match(/[A-Za-z]{4,}/g) || []).filter((w) => !STOP.has(w.toLowerCase())).slice(0, 8).forEach((w) => add(w.toLowerCase()));
        (d.match(/[一-鿿]{2,4}/g) || []).slice(0, 8).forEach(add);
        return out;
    }
    function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    // 步驟：編號清單（1. / 1) / Step 1 / 步驟 1）；沒有編號就用「列點」；每項是一句話
    function steps(body) {
        const lines = String(body || '').replace(/\r/g, '').split('\n'); const out = [];
        let cur = null; const push = () => { if (cur && cur.text.trim()) out.push({ n: out.length + 1, text: cur.text.replace(/\s+/g, ' ').trim() }); cur = null; };
        for (const ln of lines) {
            const m = /^\s{0,3}(?:(\d{1,2})[.)、]\s+(.*)|(?:Step|步驟)\s*(\d{1,2})\s*[:：.、)]?\s*(.*))$/i.exec(ln);
            if (m) { push(); cur = { text: (m[2] != null ? m[2] : m[4]) || '' }; continue; }
            if (cur && /^\s{2,}\S/.test(ln)) { cur.text += ' ' + ln.trim(); continue; } // 縮排的接續行
            if (cur && /^\s*$/.test(ln)) { push(); continue; }
            if (cur && /^\s*#/.test(ln)) { push(); continue; }
        }
        push();
        if (out.length) return out;
        for (const ln of lines) { const b = /^\s{0,3}[-*•]\s+(.{12,})$/.exec(ln); if (b) out.push({ n: out.length + 1, text: b[1].replace(/\s+/g, ' ').trim() }); }
        return out;
    }
    function mentionedTools(text, toolNames) {
        const out = []; const t = String(text || '');
        for (const n of toolNames || []) { if (n.length < 4) continue; const re = new RegExp('(^|[^A-Za-z0-9_])' + escRe(n) + '(?![A-Za-z0-9_])'); const m = re.exec(t); if (m) out.push({ name: n, at: m.index + m[1].length }); }
        return out.sort((a, b) => a.at - b.at).map((x) => x.name);
    }
    function scriptsIn(text) { return Array.from(new Set((String(text || '').match(/(?:scripts?|bin)\/[\w./-]+\.(?:py|js|sh|ts)/g) || []))); }

    function extract(text, opts) {
        opts = opts || {}; const fm = stripFrontmatter(text); const name = opts.name || fm.meta.name || ''; const description = opts.description || fm.meta.description || '';
        const st = steps(fm.body).map((s) => Object.assign({}, s, { tools: mentionedTools(s.text, opts.toolNames), scripts: scriptsIn(s.text) }));
        return { name, description, triggers: triggerWords(name, description), steps: st, tools: mentionedTools(fm.body, opts.toolNames), scripts: scriptsIn(fm.body) };
    }

    // 欄位綁定：名稱＋型別 → 手上有的東西。回傳 { value }（要放進食譜 args 的 {{…}} 字串或常數）或 null（綁不到）
    function bindSlot(def, kindsAvail) {
        const n = String(def.name || '').toLowerCase(); const has = (k) => kindsAvail.indexOf(k) >= 0;
        if (/(^|_)(file_?id|image|img|picture|photo|video|audio|pdf|document|file)(_?id)?$/.test(n) || /file_?id/.test(n)) return def.type === 'array' ? { value: '{{slots.attachment_ids}}', kind: 'attachment' } : { value: '{{slots.attachments.0.id}}', kind: 'attachment' };
        if (/(^|_)(urls?|link|page_?url|website)$/.test(n)) return { value: '{{slots.url}}', kind: 'url' };
        if (/(^|_)(query|q|keyword|keywords|search)$/.test(n)) return { value: '{{slots.query}}', kind: 'usertext' };
        if (/(^|_)(text|content|prompt|question|task|message|body|instruction|goal|topic|need|scenario|input)$/.test(n)) return { value: '{{slots.task}}', kind: 'usertext' };
        if (/(^|_)(voice)$/.test(n)) return { value: '{{slots.voice}}', kind: 'option' };
        if (/(^|_)(speed|rate)$/.test(n)) return { value: '{{slots.speed}}', kind: 'option' };
        if (/(^|_)(lang|language)$/.test(n)) return { value: '{{slots.lang}}', kind: 'option' };
        if (def.default !== undefined) return { value: def.default, kind: 'default' };
        return null;
    }
    // 工具欄位的型別提示：file／url／文字 → 這個步驟需要什麼種類的材料（用在食譜的 needs）
    function needKind(def) { const n = String(def.name || '').toLowerCase(); if (/image|img|picture|photo/.test(n)) return 'image'; if (/video/.test(n)) return 'video'; if (/audio/.test(n)) return 'audio'; if (/pdf/.test(n)) return 'pdf'; if (/file|document/.test(n)) return 'doc'; if (/url|link|website/.test(n)) return 'url'; return ''; }

    // 編譯：info＝extract 的結果；toolDefs＝{ 工具名: { parametersSchema, description } }；search(text)→[{name,score}]（找相近的現有工具）；opts.id/skill/builtinId
    function compile(info, toolDefs, opts) {
        opts = opts || {}; const search = opts.search || (() => []); const recipeSteps = []; const gaps = []; const needs = new Set(); let n = 0;
        const used = new Set(); let prevId = '';
        for (const s of info.steps) {
            if (recipeSteps.length >= MAX_STEPS - 1) { gaps.push({ step: s.n, text: s.text.slice(0, 160), why: '步驟太多（食譜最多 ' + MAX_STEPS + ' 步）', scenario: s.text }); continue; }
            if (s.tools.length) {
                // 一句話裡提到好幾個工具：照出現順序各一步（同一個工具重複出現只算一次）
                for (const tn of s.tools) {
                    if (used.has(tn)) continue; const def = toolDefs[tn]; if (!def) { gaps.push({ step: s.n, text: s.text.slice(0, 160), why: '提到的工具「' + tn + '」目前沒有', scenario: s.text }); continue; }
                    const slots = R.slotsFromSchema(def.parametersSchema || {}); const args = {}; const missing = [];
                    const flow = /transcript|result|output|words|summary|content|text of|逐字|結果|內容|摘要|讀到/i.test(s.text);
                    for (const d of slots) { const b = (prevId && flow && /(^|_)(text|content|body|input|prompt)$/.test(d.name)) ? { value: '{{vars.' + prevId + '.text}}', kind: 'flow' } : bindSlot(d, []); if (b) { args[d.name] = b.value; const nk = needKind(d); if (nk && b.kind === 'attachment') needs.add(nk); if (b.kind === 'url') needs.add('url'); } else if (d.required) missing.push(d.name); }
                    if (missing.length) { gaps.push({ step: s.n, tool: tn, text: s.text.slice(0, 160), why: '工具「' + tn + '」的必填欄位綁不到手上的東西：' + missing.join('、'), scenario: s.text, missing }); continue; }
                    used.add(tn); n++; prevId = 's' + n; recipeSteps.push({ id: 's' + n, type: 'tool', name: tn, args, note: s.text.slice(0, 120) });
                }
            } else if (s.scripts.length) {
                gaps.push({ step: s.n, text: s.text.slice(0, 160), why: '這一步要執行腳本（' + s.scripts.join('、') + '），食譜不直接跑腳本', scenario: s.text, scripts: s.scripts, similar: search(s.text).slice(0, 2) });
            } else if (/^(?:read|check|open|call|run|use|get|fetch|write|create|generate|build|make|convert|extract|parse|search|find|send|post|讀|查|開|呼叫|執行|使用|取得|寫|建立|產生|轉換|抽出|解析|搜尋|找|寄|發)/i.test(s.text)) {
                const sim = search(s.text).slice(0, 3); gaps.push({ step: s.n, text: s.text.slice(0, 160), why: '這一步沒有指名工具', scenario: s.text, similar: sim });
            }
        }
        if (!recipeSteps.length) return { ok: false, error: '這份技能沒有對得上現有工具的步驟', gaps, recipe: null };
        recipeSteps[recipeSteps.length - 1].final = true;
        const trig = (info.triggers || []).map(escRe).join('|');
        const recipe = { id: String(opts.id || 'r_' + String(info.name || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')).slice(0, 30).replace(/^([^a-z])/, 'r$1'), skill: info.name || opts.skill || '', builtinId: opts.builtinId, label: String(info.description || info.name || '').slice(0, 120),
            needs: Array.from(needs), triggers: trig ? [trig] : [], steps: recipeSteps, status: gaps.length ? 'draft' : 'compiled', gaps, compiledAt: Date.now() };
        const errs = R.validateRecipe({ id: recipe.id, steps: recipeSteps.map((s) => ({ id: s.id, type: s.type, name: s.name, args: s.args })) }); if (errs.length) return { ok: false, error: '編出來的食譜不合法：' + errs.join('；'), gaps, recipe };
        return { ok: true, recipe, gaps };
    }
    // 缺口 → 給 uml_design 的情境（一段話）：把「這一步要做什麼」連同這份技能的目的交給它
    function gapScenario(info, gap) { return (info.description ? info.description + '\n' : '') + '這份技能的一個步驟需要新的能力：' + gap.scenario; }

    return { stripFrontmatter, triggerWords, steps, mentionedTools, scriptsIn, extract, bindSlot, needKind, compile, gapScenario };
});
