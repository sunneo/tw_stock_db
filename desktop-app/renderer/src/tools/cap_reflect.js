/* 「我沒有這個工具」的反思（UMD，純函式）：模型回覆說沒有某種工具／功能／能力，但它其實沒有查過別的領域（工具被分到各個領域，最上層看不到全部）。
 * 程式不讓這句話直接放行：先替它搜尋「所有領域的所有工具」，把找到的交還給它，叫它用找到的去做；真的都不符合才可以回答沒有，並說明查過哪些。
 * 設計見 DESIGN.unit-catalog.md 第三十五節。（2026-10-17 使用者實測：用英文語音說一句話，模型回「我沒有語音合成工具」，text_to_speech 其實就在影音領域。）
 * 全部是程式判斷：宣稱偵測（詞組）、工具搜尋（CJK 雙字詞＋英文字，依稀有度加權）、提示文字。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCapReflect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // ===== 偵測「沒有工具」的宣稱 =====
    const ZH_NEG = '(?:沒有|沒|無法|不能|不具備|缺少|找不到|沒辦法|無從|無)';
    const ZH_THING = '(?:工具|功能|能力|函式|函數|指令|API|api|skill|技能|服務|套件|模組)';
    const RE_ZH = new RegExp('(?:我|目前|現在|這裡|此時)?[^。！？\\n]{0,14}' + ZH_NEG + '([^。！？\\n]{0,26}?)' + ZH_THING);
    const RE_EN = /\b(?:i\s+)?(?:don'?t|do not|doesn'?t|cannot|can'?t|am unable to|have no|there(?:'s| is) no|no)\b([^.!?\n]{0,50}?)\b(?:tools?|functions?|abilit(?:y|ies)|capabilit(?:y|ies)|access|way to|api)\b/i;
    const FILLER_ZH = /(的|可以|相關|任何|直接|能夠|能|用來|來|這個|這種|那個|一個|適合|合適|對應)/g;
    const FILLER_EN = /(?<![\w-])(a|an|any|the|have|has|got|available|in|my|current|toolset|to|that|can|for|with|of|this|such|relevant|suitable|appropriate|directly|tool|tools|function|access)(?![\w-])/gi; // 連字號的字（text-to-speech）裡的 to 不能被當成填充字拿掉
    // 回覆很長、前面已經在做事的不算：只看開頭一小段（宣稱通常在最前面）
    function claimsNoTool(text) {
        const t = String(text || '').trim(); if (!t) return null; const head = t.slice(0, 320);
        // 排除「沒有的是別的東西」：說「沒有找到錯誤」「沒有問題」不是在說沒工具——這些不會同時出現工具／功能類的詞，上面已經要求要有
        let m = RE_ZH.exec(head) || RE_EN.exec(head); if (!m) return null;
        const sentence = (head.split(/[。！？!?\n]/).find((s) => s.includes(m[0].slice(0, 6)) || s.includes(m[0].slice(-6))) || m[0]).trim();
        const concept = String(m[1] || '').replace(FILLER_ZH, ' ').replace(FILLER_EN, ' ').replace(/[()（）,，、:：]+/g, ' ').replace(/\s+/g, ' ').trim(); // 「沒有〔語音合成〕的工具」中間那段才是它在找的東西
        return { claim: sentence.slice(0, 160), matched: m[0].slice(0, 80), concept };
    }

    // ===== 搜尋所有領域的工具 =====
    const STOP_ZH = new Set(['一個', '我們', '可以', '需要', '使用', '幫我', '請你', '你的', '這個', '那個', '如果', '因為', '所以', '但是', '目前', '現在', '沒有', '工具', '功能', '能力', '一下', '什麼', '怎麼', '來', '用英', '英文']);
    const STOP_EN = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'this', 'that', 'have', 'not', 'can', 'tool', 'tools', 'available', 'current', 'toolset', 'function', 'ability', 'don', 'any', 'are', 'from', 'use', 'using']);
    function tokens(text) {
        const out = new Set(); const t = String(text || '');
        for (const run of t.match(/[㐀-鿿]+/g) || []) for (let i = 0; i + 2 <= run.length; i++) { const bg = run.slice(i, i + 2); if (!STOP_ZH.has(bg)) out.add(bg); }
        for (const w of t.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) { for (const p of w.split(/_+/)) if (p.length >= 3 && !STOP_EN.has(p)) out.add(p); }
        return out;
    }
    // entries：[{ name, domains:[{id,label}], text（名稱＋說明）, direct（最上層就能直接呼叫）}]
    // 回傳依分數排序的前 k 個 { name, score, domains, direct, why:[命中的詞] }；分數沒到最高分的一半、或沒有任何命中的詞，不列
    function search(query, entries, opts) {
        const o = Object.assign({ k: 3, minScore: 5, labelWeight: 0.4 }, opts || {}); const q = tokens(query); if (!q.size) return [];
        const docs = entries.map((e) => ({ e, toks: tokens(e.name + ' ' + (e.text || '')), lab: tokens((e.domains || []).map((d) => d.label || d.id).join(' ')) })); const N = docs.length || 1;
        const df = new Map(); for (const d of docs) { for (const t of d.toks) df.set(t, (df.get(t) || 0) + 1); for (const t of d.lab) if (!d.toks.has(t)) df.set(t, (df.get(t) || 0) + 1); }
        const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
        const nameToks = (e) => tokens(e.name.replace(/_/g, ' '));
        const scored = docs.map(({ e, toks, lab }) => { let s = 0; const why = []; const nt = nameToks(e); for (const t of q) { if (toks.has(t)) { s += idf(t) * (nt.has(t) ? 2.5 : 1); why.push(t); } else if (lab.has(t)) { s += idf(t) * o.labelWeight; why.push(t + '(領域)'); } } return { name: e.name, score: Math.round(s * 100) / 100, domains: e.domains || [], direct: !!e.direct, why: why.slice(0, 6), text: e.text || '' }; });
        scored.sort((a, b) => b.score - a.score); const best = scored[0] ? scored[0].score : 0; if (best < o.minScore) return [];
        return scored.filter((x) => x.score >= o.minScore && x.score >= best * 0.5).slice(0, o.k);
    }

    // ===== 給模型的提示 =====
    function shortDesc(t) { return String(t || '').replace(/\s+/g, ' ').replace(/^把?/, '').slice(0, 90); }
    function nudgeText(claim, hits, userText) {
        const lines = hits.map((h, i) => (i + 1) + '. ' + h.name + (h.domains.length ? '（領域：' + h.domains.map((d) => d.id + (d.label ? '／' + d.label : '')).join('、') + '）' : '') + '：' + shortDesc(h.text) + '\n   ' + (h.direct ? '你的工具清單裡就有，直接呼叫。' : '最上層沒有直接列出，用 delegate_to_subagent，domain 填「' + ((h.domains[0] && h.domains[0].id) || '') + '」，task 裡把使用者要做的事與要用的字原樣寫清楚。'));
        return '[系統驗證] 你剛才說「' + String(claim).slice(0, 100) + '」，但你還沒有查過別的領域——工具被分到各個領域，最上層只列一部分，「最上層沒看到」不等於「沒有」。程式替你搜尋了所有領域的所有工具，找到可能相符的：\n' + lines.join('\n') + '\n請現在就用上面的工具去做使用者要的事（使用者說的字、語言、數字一個字都不要改、不要自己翻譯或改寫）。只有上面都真的不符合，才可以回答沒有，並說明你查過上面哪幾個、為什麼不符合。不要再提「我可以給你程式碼讓你自己做」這類替代方案，除非工具真的做不到。';
    }
    return { claimsNoTool, tokens, search, nudgeText };
});
