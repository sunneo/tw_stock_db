/* 每一輪聊天的 LoRA 路由（UMD，純函式＋注入的登錄表；不碰 DOM、網路、檔案系統）。設計見 DESIGN.lora-training.md §15。
 *  任務類型 → 領域（登錄表的 applies.domains）：
 *    decompose（拆題）→ decompose；toolcall（工具呼叫）→ toolcall；colu（選單）→ colu；plan（規劃）→ plan。
 *  沒有對應 LoRA 就用基底，不載入（不呼叫登錄表的 request，也不呼叫載入器）。
 *  API：
 *   taskDomain(task) → 領域字串或 null（未知任務類型回 null）
 *   decideTurn(prevActive, nextActive) → 'keep'（同一組，不重建 session）｜'switch'（換組合）｜'clear'（回到基底）
 *   routeTurn(registry, task, opts) → Promise<{task, domain, fallback:'lora'|'base', active, handles, skipped, action, reason}>
 *     registry：lora_registry_core 的 createRegistry 回傳物件（需要 resolve）；opts.prevActive：上一輪的 active（陣列）。
 *     永不丟例外：登錄表錯誤也回基底並寫原因。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaLoraRoute = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const TASK_DOMAIN = { decompose: 'decompose', toolcall: 'toolcall', tool_call: 'toolcall', colu: 'colu', menu: 'colu', plan: 'plan', planning: 'plan' };

    function taskDomain(task) {
        const k = String(task || '').trim().toLowerCase();
        return Object.prototype.hasOwnProperty.call(TASK_DOMAIN, k) ? TASK_DOMAIN[k] : null;
    }

    function sameSet(a, b) {
        const x = (a || []).slice().sort().join('\u0001'), y = (b || []).slice().sort().join('\u0001');
        return x === y;
    }
    function decideTurn(prevActive, nextActive) {
        if (!nextActive || !nextActive.length) return (prevActive && prevActive.length) ? 'clear' : 'keep';
        return sameSet(prevActive, nextActive) ? 'keep' : 'switch';
    }

    async function routeTurn(registry, task, opts) {
        opts = opts || {};
        const prev = Array.isArray(opts.prevActive) ? opts.prevActive : [];
        const domain = taskDomain(task);
        const base = (reason, skipped) => ({ task: task == null ? null : String(task), domain, fallback: 'base', active: [], handles: [], skipped: skipped || [], action: decideTurn(prev, []), reason });
        if (!domain) return base('任務類型沒有對應的 LoRA（' + String(task) + '），用基底，不載入');
        if (!registry || typeof registry.resolve !== 'function') return base('沒有登錄表，用基底');
        let r;
        // 文字（使用者這一輪的話）一併給登錄表：applies.triggers 的觸發字也會選用（不靠任務類型）
        try { r = await registry.resolve({ domains: [domain], text: opts.text ? String(opts.text) : undefined }); }
        catch (err) { return base('登錄表錯誤，退回基底：' + String((err && err.message) || err)); }
        if (!r || !r.active || !r.active.length) return base('沒有符合「' + domain + '」的可用 LoRA，用基底', r && r.skipped);
        return { task: String(task), domain, fallback: 'lora', active: r.active, handles: r.handles || [], skipped: r.skipped || [], action: decideTurn(prev, r.active), reason: '「' + domain + '」→ ' + r.active.join('、') };
    }

    return { TASK_DOMAIN, taskDomain, decideTurn, routeTurn };
});
