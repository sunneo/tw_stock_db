// 四顆 LoRA（decompose-r4-v2、toolcall-r4、colu-r4、plan-r4）在產品視窗的實測（由 lora_four_adapters.run.js 啟動；真 Electron、渲染程序）。
// 流程：匯入 .fatrain 進工作室儲存層 → 登錄表（lora_registry）列出／相容性 → 基底對照（不套用）→ 逐題型：
//   (a) 每輪路由（fa._llmGenerate 帶 task，經 lora_route → 登錄表 resolve → _loraSwitch → 主程序 lora_apply）；
//   (b) 路由沒選到（例如沒有評量數字、不自動選用）就走工作室「手動載入」（/api/lora/load 帶 ids，與畫面按鈕同一條路），再生成；
//   (c) 最後四顆同時套用（lora_apply_set，rank 4×4 = 槽寬 16）各題型再跑一次。
// 不改產品程式：只呼叫產品自己的函式與路由；包一層記錄（wrap）不改行為。題目由 lora_four_adapters.make_items.py 從留出集抽出。
return (async () => {
    const R = { checks: [], imports: [], rows: [], routes: [], notes: [], t0: Date.now() };
    const ITEMS = __ITEMS__; const ASSET_DIR = __ASSET_DIR__;
    const IDS = { decompose: 'decompose-r4-v2', toolcall: 'toolcall-r4', colu: 'colu-r4', plan: 'plan-r4' };
    const FILES = ['decompose-r4-v2.fatrain', 'toolcall-r4.fatrain', 'colu-r4.fatrain', 'plan-r4.fatrain'];
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const fa = window.fa; fa.advancedSettings.offlineMode = false;
    const fin = (e) => { R.error = e ? String((e && e.stack) || e).slice(0, 1500) : undefined; R.totalMs = Date.now() - R.t0; console.log('[eval-file] lora4 ' + JSON.stringify(R)); return R; };
    try {
        fa._nrSetOptIn(true);
        // 產品設定「離線模型裝置」預設是 gpu；這台（xvfb）沒有 WebGPU，預設值會讓原生路徑被略過、整個退到 WASM（第一次實跑就踩到：12 題全走 WASM、LoRA 完全沒生效）。這裡用產品自己的設定值選 CPU，原生才會被問。
        fa.advancedSettings.offlineDevicePreference = 'cpu';
        // ---- 原生執行包狀態 ----
        const st0 = await fa._nrCall('status');
        R.native = { runtime: st0 && st0.runtime, engine: st0 && st0.engine, lora: st0 && st0.lora };
        ck('原生執行包就緒且為最新版（含 lora 功能）', st0 && st0.ok && st0.runtime && st0.runtime.ok && !st0.runtime.legacy && (st0.runtime.features || []).indexOf('lora') >= 0, R.native.runtime);
        const ns = await fa._nrNativeState(); ck('原生執行器可用（執行包與模型檔就緒）', ns && ns.ok === true, ns);
        // ---- LoRA 槽版：套 adapter 需要槽版模型（layout.json）。走產品的 slot_prepare（工作室「準備槽版」按鈕同一個 op），輪詢 slot_status ----
        R.slot0 = await fa._nrCall('slot_status', {}, 60000).catch((e) => ({ ok: false, error: String(e) }));
        const tSlot = Date.now(); R.slotPrepare = await fa._nrCall('slot_prepare', {}, 60000).catch((e) => ({ ok: false, error: String(e) }));
        for (let i = 0; i < 600; i++) { const s = await fa._nrCall('slot_status', {}, 60000).catch(() => null); R.slot = s; if (s && s.slot && s.slot.model) break; if (s && s.phase === 'failed') break; await wait(1000); }
        R.slotMs = Date.now() - tSlot; ck('LoRA 槽版模型已就緒', !!(R.slot && R.slot.slot && R.slot.slot.model), R.slot);
        // ---- 匯入 .fatrain 進工作室儲存層（Fatrain.importAsset，與工作室「匯入」按鈕確認後同一函式）----
        const store = await fa._studioStorage(); fa._studioStoreSync = store;
        const Fat = FaStudio.FaFatrain || FaStudio.Fatrain || null; R.studioKeys = Object.keys(FaStudio).slice(0, 80);
        if (!Fat) throw new Error('找不到 FaStudio.FaFatrain（匯入核心）：' + R.studioKeys.join(','));
        for (const f of FILES) {
            const p = ASSET_DIR + '/' + f; const t = Date.now();
            const st = await window.desktopAPI.rawfs.stat(p).catch(() => null);
            const rr = await window.desktopAPI.rawfs.readFile(p, 'base64'); const b64 = typeof rr === 'string' ? rr : (rr && (rr.base64 || rr.data));
            const u8 = fa._studioB64ToU8(b64);
            const pre = await Fat.importAsset(u8, { storage: store, confirmed: false });
            const r = await Fat.importAsset(u8, { storage: store, confirmed: true, mode: 'auto' });
            R.imports.push({ file: f, bytes: u8.length, statSize: st && st.size, ok: !!r.ok, error: r.error || null, plan: r.plan || null, preOk: !!pre.ok, ms: Date.now() - t });
        }
        ck('四個 .fatrain 都匯入成功', R.imports.every((x) => x.ok), R.imports.filter((x) => !x.ok));
        const listed = (await store.listAssets()).filter((x) => x.kind === 'lora').map((x) => x.name); R.storeLoras = listed;
        ck('儲存層裡看得到四顆 lora 資產', Object.values(IDS).every((n) => listed.indexOf(n) >= 0), listed);
        // ---- 登錄表 ----
        const srv = await fa._studioServer();
        const api = async (m, p, b) => { const t = Date.now(); const x = await srv.core.route(m, new URL('http://mock.local' + p), b || null); return Object.assign({ _s: x.s || 200, _ms: Date.now() - t }, x.j); };
        let lst = await api('GET', '/api/lora');
        R.registry0 = { maxActive: lst.maxActive, budget: lst.budget, applyBlocker: lst.applyBlocker, invalid: lst.invalid, dataOnly: lst.dataOnly, entries: (lst.entries || []).map((e) => ({ id: e.id, rank: e.rank, size: e.size, domains: e.domains, enabled: e.enabled, verdict: e.verdict, compat: e.compat, version: e.version })) };
        for (const e of lst.entries || []) if (!e.enabled) { const x = await api('POST', '/api/lora/enable', { id: e.id, on: true }); R.notes.push('啟用 ' + e.id + '：HTTP ' + x._s); }
        lst = await api('GET', '/api/lora'); R.registry1 = (lst.entries || []).map((e) => ({ id: e.id, enabled: e.enabled, verdict: e.verdict, compat: e.compat }));
        // ---- 包一層記錄（不改行為）----
        let lastSwitch = null, lastRoute = null;
        const origRoute = fa._loraRouteTurn.bind(fa), origSwitch = fa._loraSwitch.bind(fa);
        fa._loraRouteTurn = async (task, text) => { const r = await origRoute(task, text); lastRoute = r && { task: r.task, domain: r.domain, fallback: r.fallback, active: r.active, skipped: r.skipped, action: r.action, reason: r.reason }; return r; };
        fa._loraSwitch = async (route) => { const t = Date.now(); const r = await origSwitch(route); lastSwitch = { ms: Date.now() - t, applied: r && r.applied, applyError: r && r.applyError, active: r && r.active, action: r && r.action, fallback: r && r.fallback }; return r; };
        const model = FaVlm.byId('qwen3-0.6b');
        const strip = (s) => String(s == null ? '' : s).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        const jparse = (s) => { try { return JSON.parse(s); } catch (_) { return undefined; } };
        const lenient = (s) => { const a = s.indexOf('{'), b = s.lastIndexOf('}'); return a >= 0 && b > a ? jparse(s.slice(a, b + 1)) : undefined; };
        const score = (it, raw) => {
            const t = strip(raw); const o = { fmt: false, match: false, note: '' };
            if (it.type === 'decompose') {
                const j = jparse(t); const jl = j !== undefined ? j : lenient(t);
                const fs = jl && Array.isArray(jl.functions) ? jl.functions : null; o.strictJson = j !== undefined;
                if (fs && fs.length) { const names = fs.map((f) => f && f.name); const hasMain = names.indexOf('main') >= 0; const callsOk = fs.every((f) => f && Array.isArray(f.calls) && f.calls.every((c) => names.indexOf(c) >= 0)); o.fmt = hasMain && callsOk && fs.every((f) => f.name && f.signature && f.purpose); o.note = 'functions=' + names.join(',') + (hasMain ? '' : '；缺 main') + (callsOk ? '' : '；calls 指到清單外'); }
                else o.note = 'JSON 沒有 functions 陣列';
                const g = jparse(it.gold); o.match = !!(fs && g && JSON.stringify(fs.map((f) => f.name).sort()) === JSON.stringify(g.functions.map((f) => f.name).sort()));
            } else if (it.type === 'toolcall') {
                const m = /<tool_call>\s*(\{[\s\S]*\})\s*<\/tool_call>/.exec(t); const j = m ? jparse(m[1]) : undefined; const g = jparse(/<tool_call>\s*(\{[\s\S]*\})\s*<\/tool_call>/.exec(it.gold)[1]);
                o.fmt = !!(j && typeof j.name === 'string' && j.arguments && typeof j.arguments === 'object' && it.toolNames.indexOf(j.name) >= 0);
                o.match = !!(o.fmt && j.name === g.name && JSON.stringify(j.arguments) === JSON.stringify(g.arguments));
                o.note = m ? (j ? 'name=' + j.name + ' args=' + JSON.stringify(j.arguments).slice(0, 80) : '<tool_call> 內不是合法 JSON') : '沒有 <tool_call> 標籤';
            } else if (it.type === 'colu') {
                o.strictLetter = /^[A-E]$/.test(t); const m = /[A-E]/.exec(t); o.fmt = o.strictLetter; o.match = !!(m && m[0] === it.gold.trim() && t.length <= 8); o.note = o.strictLetter ? '單一字母' : '不是單一字母';
            } else if (it.type === 'plan') {
                const j = jparse(t); const jl = j !== undefined ? j : lenient(t); o.strictJson = j !== undefined;
                o.fmt = !!(jl && Array.isArray(jl.checks) && jl.checks.length <= 3 && jl.checks.every((c) => c && typeof c.check === 'string' && typeof c.standard === 'string'));
                o.note = jl && Array.isArray(jl.checks) ? 'checks=' + jl.checks.length : '沒有 checks 陣列';
                const g = jparse(it.gold); o.match = !!(o.fmt && JSON.stringify(jl) === JSON.stringify(g));
            }
            return o;
        };
        const gen = async (it, mode, useTask, extra) => {
            lastRoute = null; lastSwitch = null; const logs = []; const t0 = Date.now(); let text = '', err = null;
            try { text = await fa._llmGenerate(model, { messages: it.messages, maxTokens: it.maxTokens, deterministic: true, task: useTask ? it.task : undefined }, { log: (s) => logs.push(String(s)) }); }
            catch (e) { err = String((e && e.message) || e); }
            const ms = Date.now() - t0; const sc = err ? { fmt: false, match: false, note: '生成例外' } : score(it, text);
            const row = Object.assign({ type: it.type, id: it.id.slice(0, 70), mode, ms, native: logs.some((s) => /後端：原生/.test(s)), logs: logs.filter((s) => !/後端：原生/.test(s)).slice(0, 3), text: String(text).slice(0, 420), err, sc, route: lastRoute, sw: lastSwitch }, extra || {});
            R.rows.push(row); return row;
        };
        const nativeLora = async () => { const s = await fa._nrCall('lora_status', {}, 20000).catch((e) => ({ error: String(e) })); return s && (s.active || s.lora || s); };
        // ---- 基底對照（不套用）：先確認 LoRA 已清空，再用「不帶 task」生成（不路由、不動目前的 LoRA）----
        const applier = await fa._studioLoraApplier(); await applier.clear(); fa._loraTurnState = { active: [] };
        R.nativeLoraBase = await nativeLora();
        for (const it of ITEMS) await gen(it, 'base', false, { nativeLora: 'none' });
        // ---- 逐題型：每輪路由 → 沒選到就手動載入 ----
        for (const type of ['decompose', 'toolcall', 'colu', 'plan']) {
            const its = ITEMS.filter((x) => x.type === type);
            const first = await gen(its[0], 'auto-route', true); R.routes.push({ type, expect: IDS[type], route: first.route, switch: first.sw, firstMs: first.ms });
            const picked = first.route && first.route.fallback === 'lora' && first.route.active.indexOf(IDS[type]) >= 0 && first.sw && first.sw.applied;
            if (picked) {
                first.sel = { how: 'auto', active: first.route.active }; first.nativeLora = await nativeLora();
                for (const it of its.slice(1)) { const r = await gen(it, 'auto-route', true); r.sel = { how: 'auto', active: r.route && r.route.active }; r.nativeLora = await nativeLora(); }
            } else {
                // 自動沒選到：記下原因，改走工作室手動載入（同一條 /api/lora/load）
                first.sel = { how: 'auto 沒選到', reason: first.route && first.route.reason, skipped: first.route && first.route.skipped };
                const ld = await api('POST', '/api/lora/load', { ids: [IDS[type]] });
                R.routes.push({ type, manualLoad: { active: ld.active, applied: ld.applied, applyNote: ld.applyNote, applyItems: ld.applyItems, unloaded: ld.unloaded, skipped: ld.skipped, ms: ld._ms, http: ld._s } });
                const nl = await nativeLora();
                for (const it of its) { const r = await gen(it, 'manual-load', false); r.sel = { how: 'manual', active: ld.active, applied: ld.applied }; r.nativeLora = nl; }
            }
        }
        // ---- 四顆同時套用（rank 4×4＝槽寬 16）----
        const ld4 = await api('POST', '/api/lora/load', { ids: Object.values(IDS) });
        R.all4 = { active: ld4.active, applied: ld4.applied, applyNote: ld4.applyNote, applyItems: ld4.applyItems, skipped: ld4.skipped, ms: ld4._ms, http: ld4._s, nativeLora: await nativeLora() };
        if (ld4.applied) for (const it of ITEMS) { const r = await gen(it, 'all4', false); r.sel = { how: 'all4', active: ld4.active }; }
        const stF = await api('GET', '/api/lora/status'); R.statusFinal = { budget: stF.budget, slots: stF.slots, native: stF.native && stF.native.native };
        await applier.clear();
        R.summary = {}; for (const mode of ['base', 'auto-route', 'manual-load', 'all4']) { for (const type of ['decompose', 'toolcall', 'colu', 'plan']) { const rs = R.rows.filter((r) => r.mode === mode && r.type === type); if (rs.length) R.summary[mode + '/' + type] = { n: rs.length, fmt: rs.filter((r) => r.sc.fmt).length, match: rs.filter((r) => r.sc.match).length, native: rs.filter((r) => r.native).length, medianMs: rs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rs.length / 2)] }; } }
        ck('每一題都走原生後端（log 記錄為原生）', R.rows.every((r) => r.native), R.rows.filter((r) => !r.native).length + ' 題不是原生');
        R.pass = R.checks.every((c) => c.ok);
        return fin(null);
    } catch (e) { return fin(e); }
})();
