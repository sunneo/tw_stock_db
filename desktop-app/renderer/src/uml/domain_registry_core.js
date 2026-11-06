/* 領域包（domain pack）註冊：block-writer 從競賽算法題擴成多領域。純函式 UMD，Python 專屬（每個語言各自一份）。
 * 一個領域包是一份資料＋骨架，格式（make(PAR) 回傳）：
 *   { id, label, requires:[領域 id], judge:{checker, eps}, algos:[{key, re}], paradigms:{algo: [範式名…]}, skeletons:[骨架…], seeds:[種子題…] }
 *     algos       這個領域的「算法種類」詞彙（敘述的關鍵字 → key）；register 時插在通用詞彙之前（領域詞彙比通用詞彙具體）
 *     skeletons   跟 py_paradigms_core.PARADIGMS 同格式 {id, paradigm, algo, label, slots, py(c, N), when?}，每個 ≤12 個槽位組合
 *     judge       這個領域的判題方式（DSP＝float 容差）；host 組判題題目時用 judgeOf(algo)
 *     requires    領域之間的積木相依：被相依的領域要先註冊；骨架可用 uses(領域 id, 骨架 id) 引用別的領域的片段（snippet）
 *     seeds       自帶的種子題 {id, st, ref, gen, rw?, want, hidden?}；領域測試用同一個驗證流程（不給課、0 次模型、原敘述＋改寫＋選項反序）
 *   register(pack, {AI, PAR}) → {ok, algos, skeletons}     先檢查 requires、id 不重複，再把 algos 加進 AI、skeletons 加進 PAR
 *   judgeOf(algo) → {checker, eps} | null                  算法種類屬於哪個領域、該怎麼判
 *   snippet(領域 id, 名稱) → 字串                           領域公開的程式片段（供相依它的領域引用）
 *   list() → [{id, label, algos, skeletons}] */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomains = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const packs = new Map(); const algoDomain = new Map();
    function register(pack, env) {
        if (!pack || !pack.id) return { ok: false, reason: '領域包要有 id' };
        if (packs.has(pack.id)) return { ok: true, already: true, algos: 0, skeletons: 0 };
        for (const r of pack.requires || []) if (!packs.has(r)) return { ok: false, reason: '領域 ' + pack.id + ' 相依 ' + r + '，要先註冊它' };
        const na = env.AI.addAlgos(pack.algos, pack.paradigms); const ns = env.PAR.addSkeletons(pack.skeletons, pack.id);
        packs.set(pack.id, pack); for (const a of pack.algos || []) algoDomain.set(a.key, pack.id);
        return { ok: true, algos: na, skeletons: ns };
    }
    const judgeOf = (algo) => { const d = packs.get(algoDomain.get(algo)); return d && d.judge ? d.judge : null; };
    const snippet = (domain, name) => { const d = packs.get(domain); return d && d.snippets && d.snippets[name] || ''; };
    const list = () => [...packs.values()].map((p) => ({ id: p.id, label: p.label, algos: (p.algos || []).length, skeletons: (p.skeletons || []).length }));
    const get = (id) => packs.get(id) || null;
    return { register, judgeOf, snippet, list, get };
});
