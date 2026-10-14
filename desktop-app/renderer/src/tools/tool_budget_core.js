/* 工具預算核心（UMD，純函式，不碰 DOM／網路）：讓「很多工具」在小 context window 的模型上也能用。
 * 原則（不可打破）：所有工具對模型只給「一行短說明＋精簡參數」，完整說明與參數一律靠 get_tool_details 按需查詢。
 *  - shortOf        ：一個工具的一行短說明（明確的 short 優先，沒有就從完整說明取第一句、去掉括號補充、限長）
 *  - compactSchema  ：把參數 schema 精簡（保留名稱、型別、列舉、必填；欄位說明只留第一小句）
 *  - 詞彙檢索       ：tokens／buildIndex／rank——用任務文字找最相關的工具／領域（中文 bigram＋英文詞，依稀有度加權）
 *  - 領域切割       ：PHASE_GROUPS（程式設計的階段群組）＋ planSplit（工具太多的領域 → 「協調者＋階段子領域」的樹）＋ autoClusters（沒有現成分群時的建議）
 *  - 預算報告       ：budgetReport——哪個工具說明太長、哪個領域工具太多，各給具體建議（測試與執行時警告共用） */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaToolBudget = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const LIMITS = { shortChars: 90, domainTools: 20, domainTokens: 6000, toolSchemaTokens: 700, focusTools: 16, mixerChildren: 10 };

    function estimateTokens(s) {
        s = String(s == null ? '' : s); let cjk = 0; for (const ch of s) if (/[　-鿿＀-￯]/.test(ch)) cjk++;
        return Math.round(cjk * 1.1 + (s.length - cjk) / 3.6);
    }

    // ───────────────────────── 短說明 ─────────────────────────
    function shortOf(name, desc, explicit) {
        if (explicit) return String(explicit).replace(/\s+/g, ' ').trim().slice(0, LIMITS.shortChars + 20);
        let d = String(desc || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(); if (!d) return String(name || '');
        const bare = d.replace(/（[^）]*）|\([^)]*\)/g, '').replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim(); if (bare.length >= 10) d = bare;
        const m = /^(.{10,}?)(?:[。！？]|\. |；|; |\n|$)/.exec(d); let s = m ? m[1] : d;
        if (s.length > LIMITS.shortChars) { const c = s.search(/[，,：:—]/); s = (c >= 20 && c <= LIMITS.shortChars) ? s.slice(0, c) : s.slice(0, LIMITS.shortChars - 1) + '…'; }
        return s.replace(/[，,：:；;]\s*$/, '');
    }
    // 精簡參數 schema：不改變結構（型別、必填、列舉都在），只把每個欄位的說明縮成第一小句
    function compactSchema(schema, opt, depth) {
        opt = opt || {}; depth = depth || 0; const maxDesc = opt.maxParamDesc || 36; const maxDepth = opt.maxDepth || 3;
        if (!schema || typeof schema !== 'object') return schema; if (Array.isArray(schema)) return schema.map((x) => compactSchema(x, opt, depth + 1));
        // 太深的巢狀（陣列裡的物件的欄位…）只留型別：結構細節靠 get_tool_details／第一次失敗時附的完整說明
        if (depth >= maxDepth && schema.type) return { type: schema.type };
        const out = {};
        for (const [k, v] of Object.entries(schema)) {
            if (k === 'description' && typeof v === 'string') { const d = v.replace(/\s+/g, ' ').trim(); const c = d.search(/[。；;（(，,]/); const cut = (c >= 4 && c <= maxDesc) ? d.slice(0, c) : d.slice(0, maxDesc); out[k] = cut + (cut.length < d.length ? '…' : ''); }
            else if (k === 'properties' && v && typeof v === 'object') { out[k] = {}; for (const [pk, pv] of Object.entries(v)) out[k][pk] = compactSchema(pv, opt, depth + 1); }
            else if (k === 'items' || k === 'additionalProperties' || k === 'oneOf' || k === 'anyOf') out[k] = (v && typeof v === 'object') ? compactSchema(v, opt, depth + 1) : v;
            else if (k === 'default' || k === 'examples' || k === 'example') continue;
            else out[k] = v;
        }
        return out;
    }

    // 照預算收斂：先用一般精簡；還是超過就逐級更狠（欄位說明縮短→有列舉的欄位不留說明、巢狀只留型別→巢狀物件只列欄位名）。
    // 結構（欄位名、型別、必填、列舉）永遠留著，被砍掉的細節靠 get_tool_details／第一次失敗時附的完整說明
    function tighten(schema, level, depth) {
        if (!schema || typeof schema !== 'object') return schema; if (Array.isArray(schema)) return schema.map((x) => tighten(x, level, (depth || 0) + 1));
        depth = depth || 0; const out = {}; let collapsed = false;
        for (const [k, v] of Object.entries(schema)) {
            if (k === 'description' && typeof v === 'string') {
                // 級數：1＝說明縮到24字；2＝頂層欄位縮到12字、巢狀欄位不留說明；3＝所有欄位都不留說明、巢狀物件只列欄位名
                if (schema.enum || (level >= 3 && depth >= 1) || (level >= 2 && depth >= 2)) continue;
                const lim = level >= 2 ? 12 : 24; out[k] = v.length > lim ? v.slice(0, lim - 1) + '…' : v;
            } else if (k === 'properties' && v && typeof v === 'object') {
                if (level >= 3 && depth >= 1) { out.description = 'keys: ' + Object.keys(v).join(','); collapsed = true; continue; }
                out[k] = {}; for (const [pk, pv] of Object.entries(v)) out[k][pk] = tighten(pv, level, depth + 1);
            } else if (k === 'items' && v && typeof v === 'object') out[k] = tighten(v, level, depth + 1);
            else out[k] = v;
        }
        if (collapsed) delete out.required;
        return out;
    }
    function compactToBudget(schema, maxTokens, opt) {
        maxTokens = maxTokens || LIMITS.toolSchemaTokens; let cur = compactSchema(schema, opt);
        for (let level = 1; level <= 3 && estimateTokens(JSON.stringify(cur)) > maxTokens; level++) cur = tighten(compactSchema(schema, opt), level, 0);
        return cur;
    }

    // ───────────────────────── 詞彙檢索 ─────────────────────────
    function tokens(text) {
        const t = String(text || '').toLowerCase(); const out = new Set();
        for (const w of t.match(/[a-z][a-z0-9_]{2,}/g) || []) { out.add(w); for (const part of w.split('_')) if (part.length >= 3) out.add(part); }
        for (const run of t.match(/[㐀-鿿]+/g) || []) { if (run.length === 1) continue; for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2)); }
        for (const w of ['pdf', 'png', 'jpg', 'zip', 'csv', 'sql', 'git', 'api', 'url', 'mp3', 'mp4', 'gif', 'svg', 'tts', 'ci', 'uml']) if (t.includes(w)) out.add(w);
        return out;
    }
    // docs: [{id, text, nameText?, weight?}]；nameText 命中加倍（名稱比說明更能代表用途）
    function buildIndex(docs) {
        const df = new Map(); const list = docs.map((d) => { const toks = tokens(d.text); const nameToks = tokens(d.nameText || ''); for (const w of new Set([...toks, ...nameToks])) df.set(w, (df.get(w) || 0) + 1); return { id: d.id, toks, nameToks, extra: d.extra }; });
        return { docs: list, df, n: list.length };
    }
    function rank(index, query, opt) {
        opt = opt || {}; const q = typeof query === 'string' ? tokens(query) : query; const minHit = opt.minHit == null ? 3 : opt.minHit, minScore = opt.minScore == null ? 9 : opt.minScore, ratio = opt.ratio == null ? 0.7 : opt.ratio, max = opt.max || 6, minKeep = opt.minKeep || 0;
        if (q.size < 2) return []; const scored = [];
        for (const d of index.docs) {
            if (opt.exclude && opt.exclude.has(d.id)) continue; let sc = 0, hit = 0, nameHit = 0;
            for (const w of q) { const inDoc = d.toks.has(w), inName = d.nameToks.has(w); if (!inDoc && !inName) continue; const idf = Math.log(1 + index.n / (index.df.get(w) || 1)); sc += idf; hit++; if (inName) { nameHit++; sc += idf; } }
            if (sc > 0) scored.push({ id: d.id, score: Math.round(sc * 10) / 10, hit, nameHit, extra: d.extra });
        }
        scored.sort((a, b) => b.score - a.score); const top = scored.length ? scored[0].score : 0;
        let keep = scored.filter((x) => x.hit >= minHit && x.score >= minScore && x.score >= top * ratio);
        if (keep.length < minKeep) keep = scored.slice(0, minKeep);
        return keep.slice(0, max);
    }

    // ───────────────────────── 領域切割：階段群組 ─────────────────────────
    // 程式設計相關領域（coding 與 11 個 prog_*）幾乎共用同一組約 28 個工具。依「階段」分成幾個共用的子領域（每個 ≤ 12 個工具）：
    // 探索 → 讀懂 → 研究 → 試驗 → 修改 → 驗證 → CI → 設計 → 日誌。協調者（原本的領域）只留自己的狀態工具與專屬工具，用 delegate_subtask 把階段交給子領域。
    const PHASE_GROUPS = {
        ph_files: { phase: 'explore', label: '階段・探索檔案：列目錄、找檔案、讀檔、搜尋、大檔分析', tools: ['list_file_access_points', 'fap_list_files', 'fap_find_file', 'fs_read_file', 'fs_list_files', 'fs_find_file', 'fs_grep', 'fs_stat', 'coding_read_file', 'analyze_large_file', 'get_large_file_analysis_chunk', 'batch_process_items'] },
        ph_repo: { phase: 'understand', label: '階段・讀懂專案：專案索引、程式碼問答、解釋程式', tools: ['repo_map', 'repo_ask', 'repo_sql', 'repo_read_doc', 'repo_wiki', 'explain_code', 'behavior_define'] },
        ph_research: { phase: 'research', label: '階段・查資料與學新語言：知識卡、網路搜尋、抓網頁', tools: ['language_explore', 'programming_knowledge', 'browser_search', 'fetch_web_page'] },
        ph_sandbox: { phase: 'experiment', label: '階段・試驗：沙盒（HTML／Worker／Python／模擬後端）與腳本執行', tools: ['sandbox_capabilities', 'sandbox_html', 'sandbox_worker', 'sandbox_mock', 'sandbox_py_app', 'python_execute', 'bash_execute'] },
        ph_design: { phase: 'design', label: '階段・設計：UML、設計抉擇、骨架產生、互動確認', tools: ['uml_to_code', 'design_choices', 'uml_design', 'uml_guide', 'ask_user_card', 'render_uml_diagram', 'glue_list', 'glue_define', 'glue_report'] },
        ph_edit: { phase: 'implement', label: '階段・實作：暫存工作區、改檔、套 patch、commit', tools: ['coding_workspace', 'coding_edit', 'coding_patch_tool', 'apply_git_patch', 'git_inspect', 'git_commit'] },
        ph_verify: { phase: 'verify', label: '階段・驗證：語法檢查、跑測試、終端機', tools: ['coding_run_check', 'coding_run_tests', 'terminal_create', 'terminal_list', 'terminal_run', 'terminal_get_text', 'run_command'] },
        ph_ci: { phase: 'ci', label: '階段・CI／Review：Gerrit、GitHub、Jenkins、失敗分診、pipeline', tools: ['ci_connections', 'gerrit', 'github_ci', 'jenkins', 'ci_triage', 'pipeline_inspect', 'ci_guide'] },
        ph_logs: { phase: 'logs', label: '階段・日誌與混合內容：學日誌、問答、讀混合輸入', tools: ['log_learn', 'log_ask', 'mix_understand', 'mix_highlight'] },
    };
    const PHASE_ORDER = ['explore', 'understand', 'research', 'experiment', 'design', 'implement', 'verify', 'ci', 'logs'];

    // domains: { key: { own:[工具], category?, noSplit? } }。回傳：
    //   { groups: { gk: { label, phase, tools } }（只含有被用到的群組）,
    //     domains: { dk: { own:[留在協調者自己手上的工具], children:[{ group, tools:[這個領域真的有的工具（群組∩原工具）] }] } },
    //     skipped: [{ key, reason }] }
    // 每個子領域的視圖是「群組 ∩ 原領域工具」：切完之後協調者能叫到的工具聯集＝原本的工具集，不會多出原本沒有的能力。
    function planSplit(input, opt) {
        opt = opt || {}; const cap = opt.cap || LIMITS.domainTools; const groups = opt.groups || PHASE_GROUPS; const usedGroups = {}; const outDomains = {}; const skipped = [];
        for (const [dk, d] of Object.entries(input)) {
            const own = Array.from(new Set(d.own || [])); if (own.length <= cap) continue;
            if (d.noSplit) { skipped.push({ key: dk, reason: '標記為不切割' }); continue; }
            const children = []; const taken = new Set();
            for (const [gk, g] of Object.entries(groups)) {
                const inter = g.tools.filter((t) => own.includes(t) && !taken.has(t)); if (inter.length < 2) continue;
                inter.forEach((t) => taken.add(t)); children.push({ group: gk, tools: inter }); usedGroups[gk] = g;
            }
            const rest = own.filter((t) => !taken.has(t));
            if (!children.length) { skipped.push({ key: dk, reason: '沒有符合的階段群組（改用自動分群建議）' }); continue; }
            if (rest.length > cap) { skipped.push({ key: dk, reason: '切完協調者自己還有 ' + rest.length + ' 個工具' }); for (const c of children) delete usedGroups[c.group]; continue; }
            children.sort((a, b) => PHASE_ORDER.indexOf(groups[a.group].phase) - PHASE_ORDER.indexOf(groups[b.group].phase));
            outDomains[dk] = { own: rest, children };
        }
        const outGroups = {}; for (const [gk, g] of Object.entries(usedGroups)) outGroups[gk] = { label: g.label, phase: g.phase, tools: g.tools.slice() };
        return { groups: outGroups, domains: outDomains, skipped };
    }
    // 沒有現成階段群組時的建議：依工具名稱前綴分群（repo_*、git_*、browser_*…），太小的併成「其他」，太大的再平分。只給建議，不自動套用。
    function autoClusters(tools, maxSize) {
        maxSize = maxSize || 12; const by = {}; for (const t of tools) { const p = String(t).split('_')[0] || 'misc'; (by[p] = by[p] || []).push(t); }
        const groups = []; const misc = [];
        for (const [p, ts] of Object.entries(by)) { if (ts.length >= 3) { for (let i = 0; i < ts.length; i += maxSize) groups.push({ name: p + (ts.length > maxSize ? '_' + (i / maxSize + 1) : ''), tools: ts.slice(i, i + maxSize) }); } else misc.push(...ts); }
        for (let i = 0; i < misc.length; i += maxSize) groups.push({ name: 'misc' + (misc.length > maxSize ? '_' + (i / maxSize + 1) : ''), tools: misc.slice(i, i + maxSize) });
        return groups;
    }

    // ───────────────────────── 預算報告 ─────────────────────────
    // tools: [{ name, short, schemaTokens }]；domains: [{ key, tools:[名稱], mixer? }]。回傳 { ok, violations:[{ kind, key, detail, suggest }], totals }
    function budgetReport(input, opt) {
        const L = Object.assign({}, LIMITS, (opt && opt.limits) || {}); const v = []; const byName = new Map(input.tools.map((t) => [t.name, t]));
        for (const t of input.tools) {
            if (String(t.short || '').length > L.shortChars + 20) v.push({ kind: 'short_too_long', key: t.name, detail: '短說明 ' + String(t.short).length + ' 字', suggest: '補一個明確的 short（≤ ' + L.shortChars + ' 字）' });
            if ((t.schemaTokens || 0) > L.toolSchemaTokens) v.push({ kind: 'schema_too_big', key: t.name, detail: '精簡後 schema 約 ' + t.schemaTokens + ' token', suggest: '參數太多或欄位太複雜：拆成兩個工具，或把選項收進 get_tool_details' });
        }
        for (const d of input.domains) {
            const n = d.tools.length; const tok = d.tools.reduce((a, name) => a + ((byName.get(name) || {}).schemaTokens || 0), 0);
            if (!d.mixer && n > L.domainTools) v.push({ kind: 'domain_too_many_tools', key: d.key, detail: n + ' 個工具（上限 ' + L.domainTools + '）', suggest: '切成階段子領域＋協調者（planSplit／autoClusters）' });
            else if (!d.mixer && tok > L.domainTokens) v.push({ kind: 'domain_too_big', key: d.key, detail: '工具 schema 約 ' + tok + ' token（上限 ' + L.domainTokens + '）', suggest: '切割，或把冷門工具移到 request_additional_tools' });
            if (d.mixer && (d.children || 0) > L.mixerChildren) v.push({ kind: 'mixer_too_wide', key: d.key, detail: d.children + ' 個子領域（上限 ' + L.mixerChildren + '）', suggest: '再加一層協調者（樹狀）' });
        }
        return { ok: !v.length, violations: v, totals: { tools: input.tools.length, domains: input.domains.length } };
    }

    return { LIMITS, estimateTokens, shortOf, compactSchema, compactToBudget, tokens, buildIndex, rank, PHASE_GROUPS, PHASE_ORDER, planSplit, autoClusters, budgetReport };
});
