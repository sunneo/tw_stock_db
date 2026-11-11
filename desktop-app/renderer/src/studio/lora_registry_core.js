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

    function validateEntry(e) {
        const errors = [];
        if (!e || typeof e !== 'object') return ['登錄項必須是物件'];
        if (!e.id || typeof e.id !== 'string') errors.push('缺 id');
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
        if (Array.isArray(env.rank_slots) && env.rank_slots.length && env.rank_slots.indexOf(entry.rank) < 0) reasons.push({ field: 'rank', expected: env.rank_slots, actual: entry.rank, message: 'LoRA 秩（rank）' + entry.rank + ' 放不進模型的 rank 槽（槽版 ONNX 只有 ' + env.rank_slots.join('、') + '）' });
        if (env.prompt_format_version !== undefined && String(entry.prompt_format_version) !== String(env.prompt_format_version)) reasons.push({ field: 'prompt_format_version', expected: env.prompt_format_version, actual: entry.prompt_format_version, message: '提示格式版本不同：主程式 ' + env.prompt_format_version + '，adapter ' + entry.prompt_format_version + '（格式一改一定要重訓）' });
        if (env.tool_catalog_sha256 && entry.tool_catalog_sha256 && entry.tool_catalog_sha256 !== env.tool_catalog_sha256) warnings.push({ field: 'tool_catalog_sha256', message: '工具清單已變動，建議重訓或更新 adapter（仍可載入）' });
        if (env.tool_catalog_sha256 && !entry.tool_catalog_sha256) warnings.push({ field: 'tool_catalog_sha256', message: 'adapter 沒記錄工具清單雜湊，無法判斷是否過期' });
        return { ok: reasons.length === 0, level: reasons.length ? 'reject' : (warnings.length ? 'warn' : 'ok'), reasons, warnings };
    }

    // 評量分數：manifest.eval.groups 每組 {adapter, base}；任何一組輸給基底→ lose；沒資料→ null（不自動選用，可手動）
    function evalVerdict(ev) {
        if (!ev || typeof ev !== 'object') return { known: false };
        const g = ev.groups; if (!g || typeof g !== 'object') return { known: typeof ev.score === 'number', score: ev.score, lose: [] };
        const names = Object.keys(g), lose = [], win = [];
        for (const n of names) { const x = g[n]; if (!x || typeof x.adapter !== 'number' || typeof x.base !== 'number') continue; if (x.adapter < x.base) lose.push(n); else if (x.adapter > x.base) win.push(n); }
        return { known: names.length > 0, lose, win, score: typeof ev.score === 'number' ? ev.score : win.length - lose.length };
    }

    function createRegistry(opts) {
        opts = opts || {};
        const env = opts.env || {};
        const loader = opts.loader || null;
        const budget = opts.budgetBytes > 0 ? opts.budgetBytes : DEFAULT_BUDGET;
        const maxActive = opts.maxActive >= 1 ? opts.maxActive : 1;
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
            if (live.has(e.id)) throw new Error('adapter ' + e.id + ' 載入中，先卸載再取代');
            entries.set(e.id, e);
            return e;
        }
        function get(id) { return entries.get(id) || null; }
        function list(filter) { filter = filter || {}; return Array.from(entries.values()).filter((e) => (!filter.source || e.source === filter.source) && (!filter.domain || e.domains.indexOf(filter.domain) >= 0) && (filter.enabled === undefined || e.enabled === filter.enabled)); }
        async function unload(id) {
            const l = live.get(id); if (!l) return false;
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
        function triggerHit(e, text) {
            if (!text) return false;
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
                    if (v.lose && v.lose.length) { skipped.push({ id: e.id, reason: '評量有組別輸給基底：' + v.lose.join('、') + '，不自動選用（可手動指定）' }); continue; }
                }
                pool.push({ e, manual, specific: manual || byDomain || byTrigger });
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

        // 讓 plan 裡的 adapter 都載入：預算不夠就依 LRU 卸載不在 plan 裡的；單靠 plan 就超預算則丟掉排序最後的
        async function ensure(plan) {
            if (!loader || typeof loader.load !== 'function') throw new Error('沒有注入載入器（opts.loader）');
            const loaded = [], unloaded = [], skipped = [];
            const keep = plan.slice();
            const sum = (xs) => xs.reduce((s, e) => s + e.size, 0);
            while (keep.length && sum(keep) > budget) { const d = keep.pop(); skipped.push({ id: d.id, reason: '超過記憶體預算（需要 ' + sum(keep.concat([d])) + '，上限 ' + budget + '）' }); }
            const keepIds = new Set(keep.map((e) => e.id));
            // 不在計畫內、但超過 maxActive 的一律先讓出（同時駐留數也受 maxActive 限制）
            const need = keep.filter((e) => !live.has(e.id));
            const residentSize = () => Array.from(live.values()).reduce((s, l) => s + l.size, 0);
            const victims = () => Array.from(live.keys()).filter((id) => !keepIds.has(id)).sort((a, b) => live.get(a).lastUsed - live.get(b).lastUsed);
            for (const e of need) {
                while ((residentSize() + e.size > budget || live.size >= maxActive) && victims().length) {
                    const v = victims()[0]; await unload(v); unloaded.push(v);
                }
                if (residentSize() + e.size > budget || live.size >= maxActive) { skipped.push({ id: e.id, reason: '預算或同時啟用數不足，且沒有可卸載的（其餘都在本次計畫內）' }); continue; }
                try {
                    const handle = await loader.load(e);
                    live.set(e.id, { handle, size: e.size, lastUsed: stamp() }); loaded.push(e.id);
                } catch (err) { skipped.push({ id: e.id, reason: '載入失敗：' + (err && err.message || err) }); }
            }
            for (const e of keep) { const l = live.get(e.id); if (l) l.lastUsed = stamp(); }
            return { loaded, unloaded, skipped, active: keep.filter((e) => live.has(e.id)).map((e) => e.id) };
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
        return { env, budget, maxActive, register, unregister, get, list, setEnabled, checkCompat: compat, select, ensure, request, unload, unloadAll, loaded: loadedList, snapshot, restore };
    }

    // 由 pack_adapter.js 的 manifest.json（或 fa-training-asset kind:'lora' 的 manifest）轉成登錄項
    function entryFromManifest(m, extra) {
        extra = extra || {};
        const c = (m && m.compat) || {};
        const trained = (m && m.trained_on) || {};
        return Object.assign({
            id: extra.id || (m.name || 'lora') + '@' + String(m.sha256 || '').slice(0, 8),
            name: m.name || extra.id,
            source: extra.source || 'imported',
            base: m.base || c.base, base_sha256: m.base_sha256 || c.base_sha256,
            rank: m.rank !== undefined ? m.rank : c.rank, alpha: m.alpha !== undefined ? m.alpha : c.alpha,
            prompt_format_version: m.prompt_format_version !== undefined ? m.prompt_format_version : c.prompt_format_version,
            tool_catalog_sha256: m.tool_catalog_sha256 || c.tool_catalog_sha256 || trained.tool_catalog_sha256,
            domains: extra.domains || m.domains || [], location: extra.location, size: m.total_size !== undefined ? m.total_size : m.size, sha256: m.sha256,
            eval: m.eval || null, enabled: extra.enabled !== false,
        }, extra);
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

    return { SOURCES, DEFAULT_BUDGET, validateEntry, checkCompat, evalVerdict, createRegistry, entryFromManifest, nrEngineLoader };
});
