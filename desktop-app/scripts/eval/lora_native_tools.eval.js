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
        // ---- §27.6 第 4 項：真的 tools 參數與預填走原生（DESIGN.lora-training.md §32.4）----
        // 不改產品程式：只呼叫產品的 _llmGenerate，與產品的 toolcall 呼叫同一個形狀（task／tools／prefill）。
        const specs = [
            { name: 'get_weather', description: '查天氣', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
            { name: 'add_numbers', description: '兩數相加', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
            { name: 'search_notes', description: '搜尋筆記', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        ];
        const queries = [['查台北的天氣', 'get_weather', { city: '台北' }], ['幫我算 3 加 4', 'add_numbers', { a: 3, b: 4 }], ['搜尋筆記裡的預算', 'search_notes', { query: '預算' }]];
        const cases = [
            { name: 'tools-only', tools: true, prefill: null },
            { name: 'prefill-only', tools: false, prefill: '{' },
            { name: 'tools+prefill', tools: true, prefill: '<tool_call>\n{' },
        ];
        const model = FaVlm.byId('qwen3-0.6b'); R.nativeTools = [];
        for (const c of cases) {
            for (const [q, name, args] of queries) {
                const msgs = [{ role: 'system', content: '你是助理。需要時使用工具；不需要工具時直接簡短回答。' }, { role: 'user', content: q }];
                const logs = []; let text = '', err = null; const t0 = Date.now();
                const a = { task: 'toolcall', messages: msgs, deterministic: true, maxTokens: 160 };
                if (c.tools) a.tools = specs;
                if (c.prefill) a.prefill = c.prefill;
                try { text = await fa._llmGenerate(model, a, { log: (s) => logs.push(String(s)) }); } catch (e) { err = String((e && e.message) || e); }
                const native = logs.some((s) => /後端：原生/.test(s));
                const m = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/.exec(String(text)) || /(\{[\s\S]*\})/.exec(String(text));
                let j = null; try { j = m ? JSON.parse(m[1]) : null; } catch (_) { j = null; }
                const fmt = !!(j && typeof j.name === 'string' && specs.some((s) => s.name === j.name));
                const match = !!(fmt && j.name === name && JSON.stringify(j.arguments || j) === JSON.stringify(args));
                R.nativeTools.push({ case: c.name, q, native, ms: Date.now() - t0, fmt, match, err, why: logs.filter((s) => /原生未使用|原生/.test(s) && !/後端：原生/.test(s)).slice(0, 2), text: String(text).slice(0, 300) });
            }
        }
        const byCase = {}; for (const r of R.nativeTools) { const b = byCase[r.case] = byCase[r.case] || { n: 0, native: 0, fmt: 0, match: 0 }; b.n++; b.native += r.native; b.fmt += r.fmt; b.match += r.match; }
        R.byCase = byCase;
        ck('tools-only 走原生', byCase['tools-only'].native === byCase['tools-only'].n, byCase['tools-only']);
        ck('prefill-only 走原生', byCase['prefill-only'].native === byCase['prefill-only'].n, byCase['prefill-only']);
        ck('tools+prefill 走原生', byCase['tools+prefill'].native === byCase['tools+prefill'].n, byCase['tools+prefill']);
        R.pass = R.checks.every((c) => c.ok);
        return fin(null);
    } catch (e) { return fin(e); }
})();
