/* LoRA 登錄與按需載入核心（UMD，純函式＋依賴注入；不碰 DOM／網路／檔案系統／onnxruntime；Node 與瀏覽器都能載入）。
 * 設計見 DESIGN.TODO.offline-training-studio.md §2、§7、§13 與 DESIGN.lora-training.md §7、§10。
 *
 *  createRegistry(opts) → 登錄表物件
 *    opts.env      目前主程式的環境：{base, base_sha256?, rank_slots:[16]（LoRA 槽版 ONNX 的 rank，entry.rank 必須落在其中）,
 *                  prompt_format_version, tool_catalog_sha256}
 *    opts.loader   載入器介面（真正套到 ONNX 的部分由它負責）：
 *                    async load(entry)           → handle（任意物件；例：{id, bytes}）
 *                    async unload(entry, handle) → 釋放
 *                  現有主程式接點：nr-engine.js 的 loadModel(modelPath, tokenizerPath, threads, lora)，lora＝{id, bytes}（bytes＝lora.bin），
 *                  換 adapter＝傳不同 id/bytes，session 會重建。nrEngineLoader() 就是把這個接點包成載入器。
 *    opts.budgetBytes  同時駐留記憶體的 adapter 大小總和上限（預設 256 MiB；0 或未給＝用預設）
 *    opts.maxActive    同時啟用幾個 adapter（預設 1；桌面版原生套用器存在時由 studio_server_core 放寬到 4：多個 adapter 在主程序依 rank 串接成一個槽檔，容量不夠的逐項被拒；見 DESIGN.TODO.native-runner.md §9.2）
 *    opts.now          時間函式（測試用）
 *  登錄項 entry：{id, name, source:'builtin'|'user'|'imported', base, base_sha256?, rank, alpha?, prompt_format_version, tool_catalog_sha256?,
 *                domains:[…], triggers?:[字串或正規表示式原始碼]（使用者指令出現就視為想用）, conflicts_with?:[id], priority?（數字，大者優先）,
 *                location（檔案位置：fap／絕對路徑／分片資料夾，由載入器解讀）, size, sha256, enabled, eval?:{score?, groups?:{名稱:{adapter,base}}}, added}
 *  方法：register、unregister、get、list、setEnabled、checkCompat、select、request、unload、unloadAll、loaded、snapshot、restore。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaLoraRegistry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const SOURCES = ['builtin', 'user', 'imported'];
    const SOURCE_RANK = { user: 2, imported: 1, builtin: 0 }; // DESIGN §7：使用者啟用的 > 內建
    const DEFAULT_BUDGET = 256 * 1024 * 1024;
    const HEX64 = /^[0-9a-f]{64}$/;
    // 工具清單雜湊的格式 shape-v2：輸入＝「app 內建工具登記的快照」（_registerBuiltinAiTools 登記的名稱＋參數結構，見 lora-train/tool_snapshot.js），
    // 只取「工具名稱＋參數結構（名稱、型別、必填、enum）」，不取說明文字。v1 的輸入是訓練端的全部盤點，兩邊集合不同，已淘汰。
    // 說明文字在主程式裡會依平台插值（${…}），執行時的文字與離線掃描（real_tools_all.json）不會逐字相同，拿來比對會永遠誤報。
    // 代價：只改說明、不改參數的變動偵測不到（DESIGN.lora-training.md §26.2）。沒有 tool_catalog_scheme 的舊雜湊是檔案位元組，無法比對。
    const TOOL_HASH_SCHEME = 'shape-v2';
    function toolShape(t) {
        const s = (t && (t.parameters || t.parametersSchema || t.schema)) || {};
        const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
        const req = Array.isArray(s.required) ? s.required.map(String) : [];
        return { name: String(t.name), params: Object.keys(props).sort().map((k) => {
            const p = props[k] || {};
            return [k, p.type == null ? null : String(p.type), req.indexOf(k) >= 0 ? 1 : 0, Array.isArray(p.enum) ? p.enum.map(String) : null];
        }), required: req.slice().sort() };
    }
    function toolCatalogShapeText(tools) {
        const rows = (Array.isArray(tools) ? tools : []).filter((t) => t && t.name).map(toolShape);
        rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return JSON.stringify(rows);
    }
    // 同一份雜湊：訓練端（pack_adapter.js）與主程式（floating-assistant.js 的 _toolCatalogSha256）都呼叫這一個函式。
    // shaOfBytes(Uint8Array) → hex（主程式傳 FaStudioAsset.sha256Hex，訓練端傳 node crypto）。
    function toolCatalogHash(tools, shaOfBytes) {
        return shaOfBytes(new TextEncoder().encode(toolCatalogShapeText(tools)));
    }

    function validateEntry(e) {
        const errors = [];
        if (!e || typeof e !== 'object') return ['登錄項必須是物件'];
        if (!e.id || typeof e.id !== 'string') errors.push('缺 id');
        if (e.version !== undefined && (typeof e.version !== 'string' || !e.version)) errors.push('version 必須是非空字串');
        if (SOURCES.indexOf(e.source) < 0) errors.push('source 必須是 ' + SOURCES.join('／') + '，收到 ' + JSON.stringify(e.source));
        if (!e.base || typeof e.base !== 'string') errors.push('缺 base（基底模型 id）');
        if (!(Number.isInteger(e.rank) && e.rank > 0)) errors.push('rank 必須是正整數');
        if (!e.prompt_format_version && e.prompt_format_version !== 0) errors.push('缺 prompt_format_version');
        if (!Array.isArray(e.domains)) errors.push('domains 必須是陣列（可為空，空＝通用）');
        if (!e.location) errors.push('缺 location');
        if (!(Number.isFinite(e.size) && e.size >= 0)) errors.push('size 必須是位元組數');
        if (e.sha256 !== undefined && !HEX64.test(String(e.sha256))) errors.push('sha256 必須是 64 位十六進位小寫');
        if (e.tool_catalog_sha256 !== undefined && e.tool_catalog_sha256 !== null && !HEX64.test(String(e.tool_catalog_sha256))) errors.push('tool_catalog_sha256 格式不對');
        return errors;
    }

    // 相容性檢查：reject＝一定不能載（回具體原因）；warn＝可載但提示（對應 DESIGN.lora-training §10）
    function checkCompat(entry, env) {
        const reasons = [], warnings = [];
        env = env || {};
        if (env.base && entry.base !== env.base) reasons.push({ field: 'base', expected: env.base, actual: entry.base, message: '基底模型不同：主程式用 ' + env.base + '，adapter 是為 ' + entry.base + ' 訓練的' });
        if (env.base_sha256 && entry.base_sha256 && entry.base_sha256 !== env.base_sha256) reasons.push({ field: 'base_sha256', expected: env.base_sha256, actual: entry.base_sha256, message: '基底模型檔案雜湊不同（同名但檔案不是同一份）' });
        const slotRank = entry.slot_rank != null ? entry.slot_rank : entry.rank;
        if (Array.isArray(env.rank_slots) && env.rank_slots.length && env.rank_slots.indexOf(slotRank) < 0) reasons.push({ field: 'rank', expected: env.rank_slots, actual: slotRank, message: 'LoRA 槽寬（rank 槽 ' + slotRank + '）與模型的槽版 ONNX（' + env.rank_slots.join('、') + '）不符，放不進去' });
        if (env.prompt_format_version !== undefined && String(entry.prompt_format_version) !== String(env.prompt_format_version)) reasons.push({ field: 'prompt_format_version', expected: env.prompt_format_version, actual: entry.prompt_format_version, message: '提示格式版本不同：主程式 ' + env.prompt_format_version + '，adapter ' + entry.prompt_format_version + '（格式一改一定要重訓）' });
        // 工具清單：只有同格式（shape-v2）的雜湊才比得出來；舊格式、主程式算不出、adapter 沒記錄都要說出來，不靜默通過
        if (entry.tool_catalog_sha256 && env.tool_catalog_sha256) {
            if (entry.tool_catalog_scheme !== TOOL_HASH_SCHEME) warnings.push({ field: 'tool_catalog_sha256', message: '工具清單雜湊是舊格式，無法與現在的工具清單比對；用新版重新打包後才判斷得出' });
            else if (entry.tool_catalog_sha256 !== env.tool_catalog_sha256) warnings.push({ field: 'tool_catalog_sha256', message: '工具清單已變動，建議重訓或更新 adapter（仍可載入）' });
        } else if (entry.tool_catalog_sha256 && !env.tool_catalog_sha256) warnings.push({ field: 'tool_catalog_sha256', message: '主程式算不出工具清單雜湊，無法判斷這顆 adapter 是否過期' });
        else if (env.tool_catalog_sha256 && !entry.tool_catalog_sha256) warnings.push({ field: 'tool_catalog_sha256', message: 'adapter 沒記錄工具清單雜湊，無法判斷是否過期' });
        return { ok: reasons.length === 0, level: reasons.length ? 'reject' : (warnings.length ? 'warn' : 'ok'), reasons, warnings };
    }

    // 描述檔 fa-lora-descriptor v1（DESIGN.lora-training.md §13.2）：每顆 adapter 資料夾內的 lora.descriptor.json
    const DESCRIPTOR_FORMAT = 'fa-lora-descriptor';
    const DESCRIPTOR_FORMAT_VERSION = 1;
    const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
    function descriptorErrors(d) {
        const errs = [];
        if (!d || typeof d !== 'object' || Array.isArray(d)) return ['描述檔必須是物件'];
        if (d.format !== DESCRIPTOR_FORMAT) errs.push('format 必須是 ' + DESCRIPTOR_FORMAT);
        if (d.format_version !== DESCRIPTOR_FORMAT_VERSION) errs.push('format_version 必須是 ' + DESCRIPTOR_FORMAT_VERSION + '，收到 ' + JSON.stringify(d.format_version));
        if (typeof d.id !== 'string' || !ID_RE.test(d.id)) errs.push('id 格式不對（小寫英數與 -._，最長 64）');
        if (!d.version || typeof d.version !== 'string') errs.push('缺 version');
        if (!d.base || typeof d.base !== 'string') errs.push('缺 base（基底模型 id）');
        if (!(Number.isInteger(d.rank) && d.rank > 0)) errs.push('rank 必須是正整數');
        if (d.prompt_format_version === undefined || d.prompt_format_version === null || d.prompt_format_version === '') errs.push('缺 prompt_format_version');
        if (!d.applies || typeof d.applies !== 'object' || Array.isArray(d.applies)) errs.push('缺 applies（物件）');
        else {
            if (d.applies.domains !== undefined && !Array.isArray(d.applies.domains)) errs.push('applies.domains 必須是陣列');
            if (d.applies.triggers !== undefined) {
                if (!Array.isArray(d.applies.triggers)) errs.push('applies.triggers 必須是陣列');
                else d.applies.triggers.forEach((t, i) => { try { new RegExp(String(t), 'i'); } catch (_) { errs.push('applies.triggers 第 ' + i + ' 項不是合法正規表示式'); } });
            }
        }
        if (!(Number.isInteger(d.size) && d.size >= 0)) errs.push('size 必須是非負整數');
        if (!(typeof d.sha256 === 'string' && HEX64.test(d.sha256))) errs.push('sha256 必須是 64 位十六進位小寫');
        if (!d.location || typeof d.location !== 'string') errs.push('缺 location');
        if (d.base_sha256 != null && !HEX64.test(String(d.base_sha256))) errs.push('base_sha256 格式不對');
        if (d.description !== undefined && typeof d.description !== 'string') errs.push('description 必須是字串');
        if (d.tool_catalog_sha256 != null && !HEX64.test(String(d.tool_catalog_sha256))) errs.push('tool_catalog_sha256 格式不對');
        if (d.tool_catalog_scheme != null && d.tool_catalog_scheme !== TOOL_HASH_SCHEME) errs.push('tool_catalog_scheme 不認得：' + d.tool_catalog_scheme);
        return errs;
    }
    // 描述檔 → 登錄項（不讀權重）；不合法就丟出列出所有原因的錯誤
    function descriptorFromJson(d, extra) {
        const errs = descriptorErrors(d);
        if (errs.length) throw new Error('描述檔不合法：' + errs.join('；'));
        const a = d.applies || {};
        return Object.assign({
            id: d.id, name: d.name || d.id, version: d.version, description: d.description || '', source: 'imported',
            base: d.base, base_sha256: d.base_sha256 || undefined, rank: d.rank, alpha: d.alpha,
            prompt_format_version: d.prompt_format_version, tool_catalog_sha256: d.tool_catalog_sha256 || undefined, tool_catalog_scheme: d.tool_catalog_scheme || undefined,
            domains: (a.domains || []).slice(), triggers: (a.triggers || []).slice(),
            location: d.location, size: d.size, sha256: d.sha256, eval: d.eval || null, enabled: true,
        }, extra || {});
    }

    // 評量分數：manifest.eval.groups 每組 {adapter, base}；任何一組輸給基底→ lose；沒資料→ null（不自動選用，可手動）
    // model card 的評量格式（fa-lora-card：split_legal_rate／fc_format_rate 各有 base、tuned、n）：贏＝微調高於基底，輸＝低於基底
    const CARD_METRIC_KEYS = ['split_legal_rate', 'fc_format_rate'];
    function metricsVerdict(m) {
        const win = [], lose = [];
        for (const k of CARD_METRIC_KEYS) { const x = m[k]; if (!x || typeof x.base !== 'number' || typeof x.tuned !== 'number') continue; if (x.tuned > x.base) win.push(k); else if (x.tuned < x.base) lose.push(k); }
        return { known: win.length + lose.length > 0, win, lose, score: win.length - lose.length };
    }
    // 已知內建 adapter 的評量（DESIGN.lora-training.md §19，留出集實測；卡片的 eval 欄位只定義兩個指標，這兩顆的數字沒有寫進卡片，已匯入的資產也補不上，
    // 所以登錄時卡片沒有評量就查這張表）。只認 id 與名稱「完全相同」的條目（colu-r4／plan-r4 的 v1），改過權重的新版本要自帶卡片評量。
    const KNOWN_EVAL = {
        'colu-r4': { groups: { colu_letter_choice: { adapter: 30, base: 11 }, colu_letter_choice_nonefirst: { adapter: 25, base: 0 } }, source: 'DESIGN §19' },
        'plan-r4': { groups: { plan_check_valid: { adapter: 60, base: 52 }, review_return_items: { adapter: 50, base: 0 }, self_validate_ok: { adapter: 47, base: 25 } }, source: 'DESIGN §19' },
    };
    function knownEval(e) { const k = KNOWN_EVAL[e.id] || KNOWN_EVAL[e.name]; return k ? JSON.parse(JSON.stringify(k)) : null; }
    // 評量判定（給登錄與管理畫面）。回傳：
    //   lose：任一組輸給基底；
    //   degenerate：有負例（標準答案 ok=false，eval 組內 neg.n>0）而模型對負例全錯 → 退化答案，只靠正例得分，不算贏；
    //   noData：base 與 tuned 都是 0 → 無資料，不算贏也不算輸；
    //   win：清楚贏的組（不含退化與無資料）；
    //   blocked：自動選用被擋下的人話原因（空＝可自動選用）。手動指定不受 blocked 影響。
    // 評量腳本寫的判定 ev.verdict.ship === false 時，未贏的目標組也列入 blocked（退化與無資料已在上面各自列出）。
    function evalVerdict(ev) {
        if (!ev || typeof ev !== 'object') return { known: false, lose: [], win: [], degenerate: [], noData: [], blocked: [] };
        if (ev.metrics && typeof ev.metrics === 'object') return withBlocked(metricsVerdict(ev.metrics));
        if (CARD_METRIC_KEYS.some((k) => k in ev)) return withBlocked(metricsVerdict(ev));
        const g = ev.groups; if (!g || typeof g !== 'object') return { known: typeof ev.score === 'number', score: ev.score, lose: [], win: [], degenerate: [], noData: [], blocked: [] };
        const names = Object.keys(g), lose = [], win = [], degenerate = [], noData = [], outOfScope = [], smallN = [];
        for (const n of names) {
            const x = g[n]; if (!x || typeof x !== 'object') continue;
            // scope：'out'＝不在這顆的適用範圍（例：decompose 的 think_stack）。範圍外的組只報告，不計入輸贏、退化與無資料（§32.2）
            if (x.scope === 'out') { outOfScope.push(n); continue; }
            // n < 20 只報告，不作輸贏或退化的判斷（§18.2 第 3 條、EVAL_CRITERIA_v2）
            if (typeof x.n === 'number' && x.n < 20) { smallN.push(n); continue; }
            const tuned = typeof x.adapter === 'number' ? x.adapter : x.tuned;   // 評量腳本的格式是 tuned；打包後的描述檔是 adapter
            if (typeof tuned !== 'number' || typeof x.base !== 'number') continue;
            if (tuned < x.base) { lose.push(n); continue; }
            if (oneSided(x)) { degenerate.push(n); continue; }
            if (x.base === 0 && tuned === 0) { noData.push(n); continue; }
            if (tuned > x.base) win.push(n);
        }
        return withBlocked({ known: names.length > 0, lose, win, degenerate, noData, outOfScope, smallN, score: win.length - lose.length }, ev.verdict, outOfScope);
    }
    // 退化：負例全錯（neg.tuned==0）或正例全錯（pos.tuned==0），只靠另一邊得分（§31、§32.2：後者是新加的，原本只擋負例全錯）
    function oneSided(x) {
        if (x.neg && x.neg.n > 0 && x.neg.tuned === 0) return true;
        if (x.pos && x.pos.n > 0 && x.pos.tuned === 0) return true;
        return false;
    }
    function withBlocked(v, verdict, outOfScope) {
        v.lose = v.lose || []; v.win = v.win || []; v.degenerate = v.degenerate || []; v.noData = v.noData || []; v.outOfScope = v.outOfScope || []; v.smallN = v.smallN || [];
        const blocked = [];
        if (v.lose.length) blocked.push('輸給基底：' + v.lose.join('、'));
        if (v.degenerate.length) blocked.push('退化答案（負例全錯、只靠正例得分，不算贏）：' + v.degenerate.join('、'));
        if (v.noData.length) blocked.push('無資料（基底與微調都是 0，不算通過）：' + v.noData.join('、'));
        if (verdict && typeof verdict === 'object') {
            const seen = new Set([].concat(v.lose, v.degenerate, v.noData));
            const oos = new Set(outOfScope || []);
            const nw = (verdict.not_winning || []).filter((n) => !seen.has(n) && !oos.has(n));
            if (nw.length) blocked.push('目標組未清楚贏：' + nw.join('、'));
            // 整體 DO NOT SHIP 只在沒有範圍外組時才當原因（有範圍外組時，判定含了範圍外的目標組，看範圍內的組別即可）
            if (verdict.ship === false && !blocked.length && !(outOfScope && outOfScope.length)) blocked.push('評量判定為 DO NOT SHIP');
        }
        v.blocked = blocked;
        return v;
    }

    // 把關（§30.3）：「內建」標示與自動選用都要求——有評測數字，而且每一組都不輸基底。沒有數字或有組輸給基底 → 不通過，要寫原因。
    // 自動選用的判斷在 select() 裡仍用原本的兩個訊息（測試依賴）；這裡給卡片與畫面一句話的結論。
    function gateOf(ev) {
        const v = evalVerdict(ev);
        if (!v.known) return { pass: false, reason: '沒有評測數字，不自動選用（可手動指定）' };
        if (v.lose && v.lose.length) return { pass: false, reason: '評測有組別輸給基底：' + v.lose.join('、') + '，不自動選用（可手動指定）' };
        if (v.degenerate && v.degenerate.length) return { pass: false, reason: '評測有退化答案（只靠一邊得分，不算贏）：' + v.degenerate.join('、') + '，不自動選用（可手動指定）' };
        if (v.noData && v.noData.length) return { pass: false, reason: '評測無資料（基底與微調都是 0）：' + v.noData.join('、') + '，不自動選用（可手動指定）' };
        return { pass: true, reason: '評測數字齊全，所有範圍內的組都不輸基底' + (v.outOfScope && v.outOfScope.length ? '（範圍外不計：' + v.outOfScope.join('、') + '）' : '') };
    }

    function createRegistry(opts) {
        opts = opts || {};
        const env = opts.env || {};
        const loader = opts.loader || null;
        const budget = opts.budgetBytes > 0 ? opts.budgetBytes : DEFAULT_BUDGET;
        const maxActive = opts.maxActive >= 1 ? opts.maxActive : 1;
        const slotCapacity = opts.slotCapacity >= 1 ? opts.slotCapacity : 0;   // 槽的 rank 總容量（0＝不限）；桌面版＝槽版 ONNX 的 rank（匯出時固定）
        const pins = new Set();               // 釘選：自動淘汰不碰（DESIGN §14）
        const inUse = new Map();              // id → 推論中的計數；>0 不可淘汰、不可替換
        const lastUsedById = new Map();       // id → 最後使用時間（卸載後仍保留，給模型卡）
        const now = opts.now || (() => Date.now());
        const entries = new Map();            // id → entry
        const live = new Map();               // id → {handle, size, lastUsed}（Map 插入順序不代表 LRU，靠 lastUsed）
        let tick = 0;                         // 同一毫秒內的先後也要分得出來
        const stamp = () => now() * 1000 + (tick++ % 1000);

        function register(entry) {
            const errs = validateEntry(entry);
            if (errs.length) throw new Error('登錄項不合法：' + errs.join('；'));
            const e = Object.assign({ enabled: true, priority: 0, domains: [], triggers: [], conflicts_with: [], added: now() }, entry);
            e.domains = e.domains.slice(); e.triggers = (e.triggers || []).slice(); e.conflicts_with = (e.conflicts_with || []).slice();
            if (!e.eval) e.eval = knownEval(e);
            if (live.has(e.id)) throw new Error('adapter ' + e.id + ' 載入中，先卸載再取代');
            entries.set(e.id, e);
            return e;
        }
        function get(id) { return entries.get(id) || null; }
        function list(filter) { filter = filter || {}; return Array.from(entries.values()).filter((e) => (!filter.source || e.source === filter.source) && (!filter.domain || e.domains.indexOf(filter.domain) >= 0) && (filter.enabled === undefined || e.enabled === filter.enabled)); }
        async function unload(id) {
            const l = live.get(id); if (!l) return false;
            lastUsedById.set(id, l.lastUsed);
            live.delete(id);
            if (loader && loader.unload) await loader.unload(entries.get(id), l.handle);
            return true;
        }
        async function unregister(id) { await unload(id); return entries.delete(id); }
        async function setEnabled(id, on) {
            const e = entries.get(id); if (!e) throw new Error('沒有這個 adapter：' + id);
            e.enabled = !!on; if (!on) await unload(id); return e;
        }
        const compat = (e) => checkCompat(e, env);

        // 候選評分用的排序鍵：來源（使用者>匯入>內建）→ priority → 評量 → 較新
        function order(a, b) {
            return (SOURCE_RANK[b.source] - SOURCE_RANK[a.source]) || ((b.priority || 0) - (a.priority || 0)) ||
                ((evalVerdict(b.eval).score || 0) - (evalVerdict(a.eval).score || 0)) || ((b.added || 0) - (a.added || 0)) || (a.id < b.id ? -1 : 1);
        }
        // 產品端的觸發政策（DESIGN §32.11）：descriptor 裡的觸發字太寬（reading 的「文章／根據」、codewrite 的「程式」會讓一般聊天被選到），
        // 這兩個領域改用這裡的規則，不看 descriptor 的觸發字。reading：必須附文章（【文章】標記）且問依文作答；codewrite：必須明確要寫程式或實作函式。
        const TRIGGER_POLICY = {
            reading: (t) => /【文章】/.test(t) && /文中|依文|引用|原文/.test(t),
            codewrite: (t) => /寫程式|實作函式|寫[^\n]{0,8}函式|code\s*write|write\s+(a\s+)?function/i.test(t),
        };
        function triggerHit(e, text) {
            if (!text) return false;
            const pol = (e.domains || []).find((d) => Object.prototype.hasOwnProperty.call(TRIGGER_POLICY, d));
            if (pol) return TRIGGER_POLICY[pol](String(text));
            const low = String(text).toLowerCase();
            for (const t of e.triggers || []) { try { if (new RegExp(t, 'i').test(text)) return true; } catch (_) { if (low.indexOf(String(t).toLowerCase()) >= 0) return true; } }
            return false;
        }
        /* select({domain?, domains?, text?, ids?, manual?}) → {plan:[entry…], skipped:[{id, reason}]}
         * 規則：
         *  1. 停用、相容性 reject 的一律跳過並寫原因；
         *  2. 指定 ids（使用者手動點名）優先於領域比對，且允許沒有評量資料；
         *  3. 其餘靠領域標籤（domain/domains）或指令觸發字比對；領域標籤空陣列＝通用，只有在沒有任何領域專屬者時才補上；
         *  4. 沒有評量資料的 adapter 不自動選用（DESIGN §10：只自動採用評量不輸基底的版本），手動 ids 例外；有任一組輸給基底也不自動選用；
         *  5. 同一領域只留排序最前的一個；conflicts_with 與已選者衝突的跳過；最後取前 maxActive 個。 */
        function select(req) {
            req = req || {};
            const want = new Set([].concat(req.domain || [], req.domains || []).filter(Boolean));
            const skipped = [], chosen = [];
            const ids = Array.isArray(req.ids) ? req.ids : [];
            const pool = [];
            for (const e of entries.values()) {
                if (!e.enabled) { skipped.push({ id: e.id, reason: '已停用' }); continue; }
                const c = compat(e);
                if (!c.ok) { skipped.push({ id: e.id, reason: '不相容：' + c.reasons.map((r) => r.message).join('；') }); continue; }
                const manual = ids.indexOf(e.id) >= 0;
                const byDomain = e.domains.some((d) => want.has(d));
                const byTrigger = triggerHit(e, req.text);
                const general = e.domains.length === 0;
                if (!(manual || byDomain || byTrigger || (general && (want.size || req.text)))) continue;
                if (!manual) {
                    const v = evalVerdict(e.eval);
                    if (!v.known) { skipped.push({ id: e.id, reason: '沒有評量資料，不自動選用（可手動指定）' }); continue; }
                    if (v.blocked && v.blocked.length) { skipped.push({ id: e.id, reason: '評量未過，不自動選用（可手動指定）：' + v.blocked.join('；') }); continue; }
                }
                pool.push({ e, manual, byDomain, byTrigger, specific: manual || byDomain || byTrigger });
            }
            // 領域已經由任務類型確定時，只靠指令觸發字命中的別領域 adapter 讓位（colu 題目文字裡有「工具」不該改選 toolcall）；沒有領域符合者時觸發字照舊可選用
            if (want.size && pool.some((p) => p.byDomain && !p.manual)) {
                for (let i = pool.length - 1; i >= 0; i--) { const p = pool[i]; if (!p.manual && !p.byDomain && p.byTrigger && p.e.domains.length) { skipped.push({ id: p.e.id, reason: '任務領域（' + Array.from(want).join('、') + '）已有符合的 adapter，不因指令觸發字改選別的領域' }); pool.splice(i, 1); } }
            }
            const hasSpecific = pool.some((p) => p.specific);
            const cands = pool.filter((p) => p.specific || (!hasSpecific)).map((p) => p).sort((a, b) => (b.manual - a.manual) || order(a.e, b.e));
            for (const p of pool) if (cands.indexOf(p) < 0) skipped.push({ id: p.e.id, reason: '通用 adapter 讓位給領域專屬者' });
            const taken = new Set(); // 已有 adapter 的領域
            for (const p of cands) {
                const e = p.e;
                const conflict = chosen.find((c) => (c.conflicts_with || []).indexOf(e.id) >= 0 || (e.conflicts_with || []).indexOf(c.id) >= 0);
                if (conflict) { skipped.push({ id: e.id, reason: '與已選的 ' + conflict.id + ' 衝突（conflicts_with）' }); continue; }
                const dom = e.domains.filter((d) => want.has(d));
                if (!p.manual && dom.length && dom.every((d) => taken.has(d))) { skipped.push({ id: e.id, reason: '同領域（' + dom.join('、') + '）已有排序較前的 adapter' }); continue; }
                if (chosen.length >= maxActive) { skipped.push({ id: e.id, reason: '超過同時啟用上限 ' + maxActive }); continue; }
                chosen.push(e); dom.forEach((d) => taken.add(d));
            }
            return { plan: chosen, skipped };
        }

        const residentSize = () => Array.from(live.values()).reduce((s, l) => s + l.size, 0);
        const rankOf = (id) => (entries.get(id) || {}).rank || 0;
        const usedRank = () => Array.from(live.keys()).reduce((s, id) => s + rankOf(id), 0);
        const busy = (id) => (inUse.get(id) || 0) > 0;
        const protectedId = (id) => pins.has(id) || busy(id);
        const fits = (e) => residentSize() + e.size <= budget && live.size < maxActive && (!slotCapacity || usedRank() + e.rank <= slotCapacity);
        function noRoomReason(e) {
            if (slotCapacity && usedRank() + e.rank > slotCapacity) return '槽已滿（rank 容量 ' + slotCapacity + '，已用 ' + usedRank() + '，需要 ' + e.rank + '）且沒有可卸載的（釘選或推論中，或都在本次計畫內）';
            if (residentSize() + e.size > budget) return '預算或同時啟用數不足，且沒有可卸載的（其餘都在本次計畫內）';
            return '同時啟用數已達上限 ' + maxActive + '，且沒有可卸載的（其餘都在本次計畫內）';
        }

        // 讓 plan 裡的 adapter 都載入：超過槽容量或預算就依 LRU 卸載「不釘選、不推論中、不在計畫內」的；卸不掉就寫原因，不硬塞
        async function ensure(plan) {
            if (!loader || typeof loader.load !== 'function') throw new Error('沒有注入載入器（opts.loader）');
            const loaded = [], unloaded = [], skipped = [];
            const keep = plan.slice();
            const sum = (xs) => xs.reduce((s, e) => s + e.size, 0);
            while (keep.length && sum(keep) > budget) { const d = keep.pop(); skipped.push({ id: d.id, reason: '超過記憶體預算（需要 ' + sum(keep.concat([d])) + '，上限 ' + budget + '）' }); }
            if (slotCapacity) while (keep.length && keep.reduce((s, e) => s + e.rank, 0) > slotCapacity) { const d = keep.pop(); skipped.push({ id: d.id, reason: '計畫的 rank 總和超過槽容量 ' + slotCapacity + '（' + d.rank + ' 放不下）' }); }
            const keepIds = new Set(keep.map((e) => e.id));
            const need = keep.filter((e) => !live.has(e.id));
            const victims = () => Array.from(live.keys()).filter((id) => !keepIds.has(id) && !protectedId(id)).sort((a, b) => live.get(a).lastUsed - live.get(b).lastUsed);
            for (const e of need) {
                while (!fits(e) && victims().length) { const v = victims()[0]; await unload(v); unloaded.push(v); }
                if (!fits(e)) { skipped.push({ id: e.id, reason: noRoomReason(e) }); continue; }
                try {
                    const handle = await loader.load(e);
                    live.set(e.id, { handle, size: e.size, lastUsed: stamp() }); loaded.push(e.id);
                } catch (err) { skipped.push({ id: e.id, reason: '載入失敗：' + (err && err.message || err) }); }
            }
            for (const e of keep) { const l = live.get(e.id); if (l) l.lastUsed = stamp(); }
            return { loaded, unloaded, skipped, active: keep.filter((e) => live.has(e.id)).map((e) => e.id) };
        }
        function pin(id, on) {
            if (!entries.get(id)) throw new Error('沒有這個 adapter：' + id);
            if (on) pins.add(id); else pins.delete(id);
            return { id, pinned: pins.has(id) };
        }
        // 推論中標記：推論開始 acquire、結束 release；推論中的 adapter 不會被淘汰或替換
        function acquire(id) { if (!live.has(id)) return false; inUse.set(id, (inUse.get(id) || 0) + 1); return true; }
        function release(id) { const n = (inUse.get(id) || 0) - 1; if (n > 0) inUse.set(id, n); else inUse.delete(id); }
        // 手動卸載：釘選與推論中都拒絕（與自動淘汰同一套保護）
        async function manualUnload(id) {
            if (!live.has(id)) return { ok: false, error: id + ' 沒有載入' };
            if (pins.has(id)) return { ok: false, error: id + ' 已釘選，先解除釘選再卸載' };
            if (busy(id)) return { ok: false, error: id + ' 推論中，不能卸載' };
            await unload(id); return { ok: true, id };
        }
        function currentHandles() { return Array.from(live.entries()).map(([id, l]) => ({ id, handle: l.handle })); }
        async function safeUnload(e, h) { try { if (loader && loader.unload) await loader.unload(e, h); } catch (_) { /* 卸載失敗不影響狀態 */ } }
        const errText = (err) => String((err && err.message) || err);
        /* replace(outId, inId, {applyFn?, force?}) → {ok, active, rolledBack?, state?, error?}
         * 原子性（DESIGN §14.4）：①先載入新的，失敗原狀不動；②扣掉舊的後容量不夠，還原舊的、卸新的；
         * ③applyFn（通知推論端套用新組合）失敗：卸新、重新載入舊、再套一次舊組合，回報 rolledBack；④都成功才釋放舊的。
         * 舊的釘選或推論中一律拒絕（force 只能繞過釘選，推論中永遠不行）。 */
        // 替換進行中的記錄（給畫面：status().replacing；完成或失敗都會清掉）
        let replacing = null;
        async function replace(outId, inId, o) {
            replacing = { out: outId, in: inId };
            try { return await replaceInner(outId, inId, o); }
            finally { replacing = null; }
        }
        async function replaceInner(outId, inId, o) {
            o = o || {};
            const out = entries.get(outId), inn = entries.get(inId);
            if (!out || !inn) return { ok: false, error: '沒有這個 adapter', active: currentHandles().map((x) => x.id) };
            if (!live.has(outId)) return { ok: false, error: outId + ' 沒有載入，無法替換（請直接載入 ' + inId + '）', active: currentHandles().map((x) => x.id) };
            if (live.has(inId)) return { ok: false, error: inId + ' 已經載入', active: currentHandles().map((x) => x.id) };
            if (pins.has(outId) && !o.force) return { ok: false, error: outId + ' 已釘選，先解除釘選', active: currentHandles().map((x) => x.id) };
            if (busy(outId)) return { ok: false, error: outId + ' 推論中，不能替換', active: currentHandles().map((x) => x.id) };
            const c = compat(inn); if (!c.ok) return { ok: false, error: '不相容：' + c.reasons.map((r) => r.message).join('；'), active: currentHandles().map((x) => x.id) };
            let h;
            try { h = await loader.load(inn); }
            catch (err) { return { ok: false, error: '載入 ' + inId + ' 失敗，原狀保留：' + errText(err), rolledBack: false, active: currentHandles().map((x) => x.id) }; }
            const old = live.get(outId); live.delete(outId); lastUsedById.set(outId, old.lastUsed);
            if (!fits(inn)) {
                const why = noRoomReason(inn); live.set(outId, old); await safeUnload(inn, h);
                return { ok: false, error: '容量不足，替換不成立，原狀保留（' + why + '）', rolledBack: true, active: currentHandles().map((x) => x.id) };
            }
            live.set(inId, { handle: h, size: inn.size, lastUsed: stamp() });
            if (typeof o.applyFn === 'function') {
                let r; try { r = await o.applyFn(currentHandles()); } catch (err) { r = { ok: false, error: errText(err) }; }
                if (!r || r.ok === false) {
                    live.delete(inId); await safeUnload(inn, h);
                    try { const h0 = await loader.load(out); live.set(outId, { handle: h0, size: out.size, lastUsed: old.lastUsed }); }
                    catch (err) { return { ok: false, error: '套用失敗，且無法還原 ' + outId + '：' + errText(err), state: 'degraded', active: currentHandles().map((x) => x.id) }; }
                    try { await o.applyFn(currentHandles()); } catch (_) { /* 舊組合再套一次；失敗就維持登錄狀態，由呼叫端顯示 */ }
                    return { ok: false, error: '套用 ' + inId + ' 失敗，已還原為 ' + outId + '：' + ((r && (r.error || r.message)) || '未知原因'), rolledBack: true, active: currentHandles().map((x) => x.id) };
                }
            }
            await safeUnload(out, old.handle);
            return { ok: true, out: outId, in: inId, active: currentHandles().map((x) => x.id) };
        }
        // 模型卡（給 LoRA 管理畫面）：與 DESIGN §14.6 對齊
        function card(e) {
            const ev = evalVerdict(e.eval), c = compat(e), gate = gateOf(e.eval);
            const lu = live.has(e.id) ? live.get(e.id).lastUsed : (lastUsedById.has(e.id) ? lastUsedById.get(e.id) : null);
            return { id: e.id, name: e.name || e.id, version: e.version || null, description: e.description || '', base: e.base, rank: e.rank, size: e.size, added: e.added || null, lastUsed: lu,
                domains: e.domains.slice(), triggers: (e.triggers || []).slice(), prompt_format_version: e.prompt_format_version, source: e.source, enabled: !!e.enabled,
                location: e.location, eval: ev.known ? { lose: ev.lose, win: ev.win, degenerate: ev.degenerate, noData: ev.noData, blocked: ev.blocked } : null, compat: c.level, compatReasons: c.reasons.map((r) => r.message), compatWarnings: c.warnings.map((w) => w.message), pinned: pins.has(e.id),
                slotRank: e.slot_rank != null ? e.slot_rank : e.rank, limits: (e.limits || []).slice(), evalMetrics: e.eval && (e.eval.metrics || (CARD_METRIC_KEYS.some((k) => k in e.eval) ? e.eval : null)) || null, gate: { pass: gate.pass, reason: gate.reason } };
        }
        // 狀態（給 LoRA 管理畫面）：槽位、已載入、最後使用時間、釘選、推論中
        function status() {
            const slots = Array.from(live.keys()).map((id) => { const l = live.get(id), e = entries.get(id) || {}; return { id, name: e.name || id, version: e.version || null, rank: e.rank, size: l.size, loaded: true, pinned: pins.has(id), inUse: inUse.get(id) || 0, lastUsed: l.lastUsed }; }).sort((a, b) => b.lastUsed - a.lastUsed);
            return { replacing: replacing ? Object.assign({}, replacing) : null, slotCapacity: slotCapacity || null, usedRank: usedRank(),freeRank: slotCapacity ? slotCapacity - usedRank() : null, maxActive, budget, usedBytes: residentSize(), slots, registered: list().map(card) };
        }

        // 依需求載入：select ＋ ensure；handles 給呼叫端交給推論（nr-engine 的 opts.lora）
        async function request(req) {
            const s = select(req);
            const r = await ensure(s.plan);
            const handles = r.active.map((id) => ({ id, handle: live.get(id).handle }));
            return { active: r.active, handles, loaded: r.loaded, unloaded: r.unloaded, skipped: s.skipped.concat(r.skipped) };
        }
        async function unloadAll() { const ids = Array.from(live.keys()); for (const id of ids) await unload(id); return ids; }
        function loadedList() { return Array.from(live.entries()).map(([id, l]) => ({ id, size: l.size, lastUsed: l.lastUsed })).sort((a, b) => b.lastUsed - a.lastUsed); }
        function snapshot() { return { format: 'fa-lora-registry', version: 1, entries: Array.from(entries.values()).map((e) => Object.assign({}, e)) }; }
        function restore(snap) {
            if (!snap || snap.format !== 'fa-lora-registry') throw new Error('不是 fa-lora-registry 快照');
            const bad = [];
            for (const e of snap.entries || []) { try { register(e); } catch (err) { bad.push({ id: e && e.id, error: err.message }); } }
            return { bad };
        }
        // 呼叫端用的出口：永不丟例外。沒有 adapter 可用（沒選到、全部載入失敗、沒有載入器）→ fallback:'base'，原因寫在 skipped
        async function resolve(req) {
            let r;
            try { r = await request(req); }
            catch (err) { return { active: [], handles: [], loaded: [], unloaded: [], skipped: [{ id: '*', reason: '登錄表錯誤，退回基底：' + String((err && err.message) || err) }], fallback: 'base' }; }
            return Object.assign(r, { fallback: r.active.length ? 'lora' : 'base' });
        }
        return { env, budget, maxActive, slotCapacity, register, unregister, get, list, setEnabled, checkCompat: compat, select, ensure, request, resolve, unload, unloadAll, loaded: loadedList, snapshot, restore, pin, acquire, release, manualUnload, replace, status, card };
    }

    // 由 pack_adapter.js 的 manifest.json（或 fa-training-asset kind:'lora' 的 manifest）轉成登錄項
    function entryFromManifest(m, extra) {
        extra = extra || {};
        const c = (m && m.compat) || {};
        const trained = (m && m.trained_on) || {};
        const lx = (m && m.extra && m.extra.lora) || {};
        // rank＝實際佔用的秩（訓練秩，零補齊到槽寬不算）；slot_rank＝檔案寫進的槽寬（相容性檢查用）
        const slotRank = c.rank !== undefined ? c.rank : m.rank;
        return Object.assign({
            id: extra.id || (m.name || 'lora') + '@' + String(m.sha256 || '').slice(0, 8),
            name: m.name || extra.id,
            version: lx.version || m.version_tag || undefined,
            description: lx.description || undefined,
            limits: Array.isArray(lx.known_limits) ? lx.known_limits.slice() : [],
            source: extra.source || 'imported',
            base: m.base || c.base, base_sha256: m.base_sha256 || c.base_sha256,
            rank: lx.trained_rank !== undefined ? lx.trained_rank : (m.rank !== undefined ? m.rank : c.rank), slot_rank: slotRank, alpha: m.alpha !== undefined ? m.alpha : c.alpha,
            prompt_format_version: m.prompt_format_version !== undefined ? m.prompt_format_version : c.prompt_format_version,
            tool_catalog_sha256: m.tool_catalog_sha256 || c.tool_catalog_sha256 || trained.tool_catalog_sha256,
            tool_catalog_scheme: m.tool_catalog_scheme || c.tool_catalog_scheme || trained.tool_catalog_scheme || undefined,
            domains: extra.domains || m.domains || [], location: extra.location, size: m.total_size !== undefined ? m.total_size : m.size, sha256: m.sha256,
            eval: m.eval || null, enabled: extra.enabled !== false,
        }, extra);
    }

    // 權重檔在資產裡的路徑（weights/lora.bin 或 .safetensors）；找不到就回 null（不可靜默略過，見 studio_server_core.syncRegistry）
    const WEIGHT_RE = /^weights\/.*(lora\.bin|\.safetensors|\.bin)$/;
    function weightFile(manifest) { return Object.keys((manifest && manifest.sha256) || {}).find((p) => WEIGHT_RE.test(p)) || null; }

    // 一個 LoRA 資產的摘要（給版本比較與匯入說明用）
    function summaryOf(e) {
        const ev = e.eval && (e.eval.metrics || (CARD_METRIC_KEYS.some((k) => k in e.eval) ? e.eval : null));
        const metrics = {};
        if (ev) CARD_METRIC_KEYS.forEach((k) => { if (ev[k] && typeof ev[k].tuned === 'number') metrics[k] = { base: ev[k].base, tuned: ev[k].tuned, n: ev[k].n }; });
        return { id: e.id, name: e.name || e.id, version: e.version || null, rank: e.rank, slotRank: e.slot_rank != null ? e.slot_rank : e.rank, base: e.base || null,
            domains: (e.domains || []).slice(), metrics: Object.keys(metrics).length ? metrics : null, limits: (e.limits || []).slice() };
    }
    // 兩個摘要的差異：版本、rank、槽寬、基底、領域、每項評量的數字、已知限制增減；same＝沒有任何差異
    function diffSummaries(a, b) {
        const rows = [];
        const row = (field, av, bv) => rows.push({ field, a: av == null ? '無資料' : String(av), b: bv == null ? '無資料' : String(bv), changed: String(av == null ? '' : av) !== String(bv == null ? '' : bv) });
        row('版本', a.version || '未標註', b.version || '未標註');
        row('訓練秩（rank）', a.rank, b.rank);
        row('槽寬', a.slotRank, b.slotRank);
        row('基底', a.base, b.base);
        row('適用領域', (a.domains || []).join('、') || '通用', (b.domains || []).join('、') || '通用');
        for (const k of CARD_METRIC_KEYS) {
            const am = a.metrics && a.metrics[k], bm = b.metrics && b.metrics[k];
            const f = (m) => (m ? (m.tuned * 100).toFixed(1) + '%（基底 ' + (m.base * 100).toFixed(1) + '%，n=' + m.n + '）' : '無資料');
            rows.push({ field: '評量 ' + k, a: f(am), b: f(bm), changed: f(am) !== f(bm) });
        }
        const la = a.limits || [], lb = b.limits || [];
        const added = lb.filter((x) => la.indexOf(x) < 0), removed = la.filter((x) => lb.indexOf(x) < 0);
        return { same: !rows.some((r) => r.changed) && !added.length && !removed.length, rows, limitsAdded: added, limitsRemoved: removed };
    }
    // 匯入 .fatrain 的 LoRA 時的說明：相容性（reject＝載入會被拒、warn＝可載但要注意）、與同名現有資產的版本差異
    function importReport(manifest, opts) {
        opts = opts || {};
        const wf = weightFile(manifest);
        if (!wf) return { ok: false, level: 'reject', error: '沒有權重檔（weights/*.bin 或 .safetensors），不是可載入的 LoRA', compat: null, summary: null, versionDiff: null };
        const build = (m) => {
            const lx = (m.extra && m.extra.lora) || {};
            const m2 = Object.assign({}, m, { sha256: m.sha256[wf], total_size: m.counts && m.counts.weight_bytes });
            return entryFromManifest(m2, { id: m.name, source: 'imported', location: 'asset:lora/' + m.name, domains: lx.domains || [], enabled: true });
        };
        const e = build(manifest), c = checkCompat(e, opts.env || {});
        const summary = summaryOf(e);
        const versionDiff = opts.existing ? diffSummaries(summaryOf(build(opts.existing)), summary) : null;
        return { ok: c.ok, level: c.level, compat: { reasons: c.reasons.map((r) => r.message), warnings: c.warnings.map((w) => w.message) }, summary, versionDiff, error: c.ok ? null : c.reasons.map((r) => r.message).join('；') };
    }

    // 載入器：把 nr-engine.js 的 lora 接點（{id, bytes}）包成注入用載入器。readBytes(entry) → Uint8Array（讀分片＋合併由呼叫端做）；
    // sha256Hex 注入（例 asset_core.sha256Hex）時，載入前核對整檔雜湊，不符就拒載。
    function nrEngineLoader(o) {
        o = o || {};
        return {
            async load(entry) {
                const bytes = await o.readBytes(entry);
                if (entry.sha256 && o.sha256Hex && o.sha256Hex(bytes) !== entry.sha256) throw new Error('sha256 不符，拒絕載入 ' + entry.id);
                return { id: entry.id, bytes };
            },
            async unload() { /* bytes 交給 GC；nr-engine 下次 loadModel 傳不同 id/空值時會重建 session */ },
        };
    }

    return { SOURCES, DEFAULT_BUDGET, DESCRIPTOR_FORMAT, DESCRIPTOR_FORMAT_VERSION, TOOL_HASH_SCHEME, toolCatalogShapeText, toolCatalogHash, validateEntry, descriptorErrors, descriptorFromJson, checkCompat, evalVerdict, gateOf, createRegistry, entryFromManifest, weightFile, summaryOf, diffSummaries, importReport, nrEngineLoader };
});
