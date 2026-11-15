/* 計畫（多步驟）的 LoRA 步驟層（UMD，純函式；不碰 DOM、網路、檔案系統）。設計見 DESIGN.lora-training.md §28。
 *  stepDomain(step, opts) → 'decompose'｜'toolcall'｜'codewrite'｜'reading'｜null（對不上的步驟用基底）
 *    step：{ tool, local }；opts.codeTools：各語言「寫程式」的工具名（codewrite）。
 *  dependsMap(steps) → Map(步驟 id → Set(它直接或間接依賴的步驟 id))；依賴來自 bind[欄位].from（type:'step', ref）。
 *  orderSteps(steps, domainOf) → 新陣列：只在沒有相依的步驟之間重排，把同領域的步驟排在一起；最後一步固定在最後（它是最終成品）。
 *  switchCount(domains) → 依序走過的領域序列，要換幾次 LoRA 組合（null＝基底；開頭就是基底不算切換）。
 *  unionDomains(domains, max) → 不重複、保留順序的非空領域，最多 max 個（同時啟用上限）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaLoraPlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const CODEWRITE_FALLBACK = [];
    const READING_TOOLS = ['local_summarize', 'parse_uploaded_file', 'summarize_large_text'];

    // 步驟 → 領域。local＝宿主的本機函式（env.fns）；非本機＝AI 工具表裡的工具（env.tool）
    function stepDomain(step, opts) {
        const tool = step && step.tool ? String(step.tool) : '';
        if (!tool) return null;
        const codeTools = (opts && Array.isArray(opts.codeTools)) ? opts.codeTools : CODEWRITE_FALLBACK;
        if (codeTools.indexOf(tool) >= 0) return 'codewrite';
        if (tool === 'local_uml_design') return 'decompose';
        if (READING_TOOLS.indexOf(tool) >= 0) return 'reading';
        if (step.local) return null;               // 其他本機函式（pick_urls、uml_to_code…）不靠 LoRA
        return 'toolcall';                          // 一般工具呼叫（參數 JSON、填欄位）
    }

    // 直接依賴 → 遞移閉包（只算清單裡存在的步驟）
    function dependsMap(steps) {
        const list = Array.isArray(steps) ? steps : [];
        const ids = new Set(list.map((s) => s.id));
        const direct = new Map();
        for (const s of list) {
            const set = new Set();
            for (const b of Object.values(s.bind || {})) {
                const ref = b && b.from && b.from.type === 'step' ? b.from.ref : null;
                if (ref && ids.has(ref) && ref !== s.id) set.add(ref);
            }
            direct.set(s.id, set);
        }
        const out = new Map();
        for (const s of list) {
            const seen = new Set(); const stack = [...direct.get(s.id)];
            while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); for (const y of direct.get(x) || []) stack.push(y); }
            out.set(s.id, seen);
        }
        return out;
    }

    // 重排：拓撲排序，每次從「已經可以做」的步驟裡挑；有同領域的就先挑它（相鄰），否則挑原本順序最前的。
    // 最後一步視為依賴所有其他步驟，所以永遠排在最後。遇到循環依賴就回傳原順序（不冒險）。
    function orderSteps(steps, domainOf) {
        const list = Array.isArray(steps) ? steps.slice() : [];
        if (list.length < 2) return list;
        const deps = dependsMap(list); const last = list[list.length - 1];
        for (const s of list) if (s !== last) deps.get(last.id).add(s.id);
        const done = new Set(); const out = []; let cur = null;
        const dom = (s) => (typeof domainOf === 'function' ? domainOf(s) : null);
        while (out.length < list.length) {
            const ready = list.filter((s) => !done.has(s.id) && [...deps.get(s.id)].every((d) => done.has(d)));
            if (!ready.length) return list;
            const same = cur ? ready.find((s) => dom(s) === cur) : undefined;
            const pick = same || ready[0];
            out.push(pick); done.add(pick.id);
            const d = dom(pick); if (d) cur = d;
        }
        return out;
    }

    // 依序經過的領域（null＝基底）：每當組合改變就算一次。開頭若已經是基底不算。
    function switchCount(domains) {
        let cur = null; let n = 0;
        for (const d of (Array.isArray(domains) ? domains : [])) {
            const next = d || null;
            if (next !== cur) n++;
            cur = next;
        }
        return n;
    }

    // 不重複、保留順序的非空領域，最多 max 個
    function unionDomains(domains, max) {
        const cap = Number(max) >= 1 ? Math.floor(Number(max)) : 1; const out = [];
        for (const d of (Array.isArray(domains) ? domains : [])) { if (d && out.indexOf(d) < 0) out.push(d); }
        return out.slice(0, cap);
    }

    return { stepDomain, dependsMap, orderSteps, switchCount, unionDomains };
});
