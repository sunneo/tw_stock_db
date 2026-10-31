/* 環境基準線的主機轉接層（FaEnvHost，混進 FloatingAssistant.prototype）。設計見 DESIGN.env-baseline.md。
 * 原則：寧可跑得慢，也不要因為記憶體不足被瀏覽器直接殺掉（手機尤其）。
 *   - 依環境（手機、記憶體、heap 上限、省流量、電量、有沒有 GPU）自動決定「檔位」low／mid／high，各自有預設政策（預算、跑完就卸載、閒置多久卸載、同時幾個任務、圖最大幾像素…）
 *   - 離線模型、Worker 等重資源登記到 Governor：載入前先讓位（卸載閒置的）、放不下又有別人在用就排隊、跑完依政策卸載；背景分頁（手機）全卸
 *   - 記憶體壓力（Chrome 的 performance.memory）與 OOM 錯誤會讓這個工作階段降一級並卸載；/env 可以看、指定檔位、全部卸載 */
(function () {
    'use strict';
    const M = {}, MB = 1048576;
    M._envRawSync = function () {
        const n = typeof navigator !== 'undefined' ? navigator : {}, raw = {};
        try { raw.mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(n.userAgent || '') || (n.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820); } catch (_) { raw.mobile = false; }
        raw.deviceMemory = n.deviceMemory || 0; raw.cores = n.hardwareConcurrency || 1; raw.gpu = !!n.gpu;
        try { const pm = typeof performance !== 'undefined' && performance.memory; if (pm) { raw.heapLimit = pm.jsHeapSizeLimit; raw.heapUsed = pm.usedJSHeapSize; } } catch (_) { /* 只有 Chrome 有 */ }
        try { if (n.connection && n.connection.saveData) raw.saveData = true; } catch (_) { /* */ }
        return raw;
    };
    // 慢的、非同步的資訊（電量、儲存空間、桌面版主行程給的真實記憶體）補進來；沒有就算了
    M._envRefresh = async function () {
        const raw = Object.assign({}, this._envRaw || {}, this._envRawSync()), n = typeof navigator !== 'undefined' ? navigator : {};
        try { if (n.getBattery) { const b = await n.getBattery(); raw.batteryLow = !b.charging && b.level < 0.15; } } catch (_) { /* */ }
        try { if (n.storage && n.storage.estimate) { const e = await n.storage.estimate(); raw.quotaBytes = e.quota; } } catch (_) { /* */ }
        try { if (window.desktopAPI && typeof window.desktopAPI.systemInfo === 'function') { const si = await window.desktopAPI.systemInfo(); if (si && si.totalMem) { raw.totalMem = si.totalMem; raw.freeMem = si.freeMem; } } } catch (_) { /* 舊版主程式沒有這個介面 */ }
        this._envRaw = raw; return raw;
    };
    M._envSettings = function () { const a = this.advancedSettings || {}; return { profile: ['low', 'mid', 'high'].includes(a.envProfile) ? a.envProfile : 'auto', overrides: (a.envOverrides && typeof a.envOverrides === 'object') ? a.envOverrides : {} }; };
    M._envGov = function () {
        if (this._envGovernor) return this._envGovernor; if (typeof FaEnv === 'undefined') return null; const self = this;
        if (!this._envRaw) this._envRaw = this._envRawSync();
        const g = this._envGovernor = new FaEnv.Governor({ policy: () => self._envPolicy(), log: (x) => { try { console.log('[env] ' + x); } catch (_) { /* */ } } });
        // 已知的重資源：由各自的程式追蹤「有沒有載入」，這裡只負責「什麼時候卸載」
        for (const slot of ['gpu', 'cpu']) g.register('vlm:' + slot, { kind: 'model', label: '看圖模型（' + slot + '）', bytes: () => 700 * MB, resident: () => !!(self._vlmWks && self._vlmWks[slot]), unload: async () => { self._vlmTerminate && self._vlmTerminate(slot); } });
        g.register('whisper', { kind: 'model', label: '語音辨識模型', bytes: () => 300 * MB, resident: () => !!self._whisperTranscriber, unload: async () => { const t = self._whisperTranscriber; self._whisperTranscriber = null; self._whisperTranscriberDevice = null; try { if (t && t.dispose) await t.dispose(); } catch (_) { /* */ } } });
        // 本機生圖（SDXS，onnxruntime 工作階段）與本機 TTS（Kokoro 的 Worker）：載入前讓位、跑完依政策卸載
        g.register('localsd', { kind: 'model', label: '本機生圖模型', bytes: () => 900 * MB, resident: () => !!self._localSdSess, unload: async () => { if (self._localSdUnload) await self._localSdUnload(); } });
        g.register('tts', { kind: 'model', label: '語音合成（Kokoro）', bytes: () => 350 * MB, resident: () => !!self._ttsWorker, unload: async () => { try { if (self._ttsWorker) { self._ttsWorker.terminate(); self._ttsWorker = null; } } catch (_) { /* */ } } });
        return g;
    };
    // 模擬 swap：大塊的中間資料放 IndexedDB、記憶體只留最近用的（熱區＝預算的 1/4）。慢一點、但不會因為同時握太多大塊資料被殺掉
    M._envSwap = function () {
        if (this._envSwapObj) return this._envSwapObj; if (typeof FaSwap === 'undefined' || typeof indexedDB === 'undefined') return null; const self = this, hot = () => Math.max(8, Math.round(self._envPolicy().budgetMB / 4)) * MB;
        const sw = this._envSwapObj = FaSwap.create({ hotBytes: hot() }); sw.clear().catch(() => {});   // 啟動時清掉上次沒清乾淨的
        const g = this._envGov(); if (g) g.register('swap', { kind: 'cache', label: '暫存區（swap）', bytes: () => sw.stats().hotBytes, resident: () => sw.stats().hotBytes > 0, unload: async () => { await sw.setHotBytes(0); await sw.setHotBytes(hot()); } });
        return sw;
    };
    M._envTier = function () { const st = this._envSettings(), g = this._envGovernor; return FaEnv.tierOf(FaEnv.detect(this._envRaw || this._envRawSync()), st.profile, g ? g.degradeLevel : 0); };
    M._envPolicy = function () { return FaEnv.policyOf(this._envTier(), this._envSettings().overrides); };
    // 取政策裡的一個欄位（沒有環境基準線時用預設值）
    M._envPol = function (key, d) { try { const v = this._envPolicy()[key]; return v == null ? d : v; } catch (_) { return d; } };
    // 一件重運算：載入前先讓位／排隊（acquire）、記憶體不足就降級卸載（_envGuard）、跑完依政策卸載（release）。單一個就超過預算時不拒絕（沒有更小的替代）：已經卸掉所有別的，載不起來由 _envGuard 接住
    M._envHeavy = async function (id, estBytes, fn) {
        const g = this._envGov(); if (!g || !g.res.has(id)) return fn();
        await g.acquire(id, estBytes); try { return await this._envGuard(fn); } finally { g.release(id); }
    };
    // 同一時間最多 parallelTasks 件（低檔 1 件）：超過的排隊，不要同時開一堆 Worker 吃光記憶體
    M._envLane = async function (fn) {
        const lane = this._envLaneState = this._envLaneState || { running: 0, waiting: [] };
        while (lane.running >= Math.max(1, Number(this._envPol('parallelTasks', 2)) || 1)) await new Promise((res) => lane.waiting.push(res));
        lane.running++; try { return await fn(); } finally { lane.running--; const w = lane.waiting.shift(); if (w) w(); }
    };
    // /env set key=value …（個別覆寫政策欄位）、/env set reset
    const OVERRIDE_KEYS = { budgetMB: [100, 16000], maxImagePx: [256, 8192], parallelTasks: [1, 8], maxWorkers: [1, 16], fileCacheMB: [8, 4096], tilePx: [128, 4096], batch: [1, 16], renderScale: [0.5, 3], fps: [10, 120], graceMs: [0, 600000] };
    M._envSetOverride = function (argsText) {
        const a = String(argsText || '').trim(); if (/^reset$/i.test(a)) { this.advancedSettings.envOverrides = {}; this._saveAdvancedSettings(); this._envApplyPolicy(); return '已清掉個別覆寫。\n\n'; }
        const ov = Object.assign({}, this._envSettings().overrides), done = [], bad = [];
        a.split(/[\s,]+/).filter(Boolean).forEach((kv) => { const m = /^([A-Za-z]+)=(.+)$/.exec(kv); if (!m || !OVERRIDE_KEYS[m[1]]) { bad.push(kv); return; } const n = Number(m[2]), r = OVERRIDE_KEYS[m[1]]; if (!isFinite(n)) { bad.push(kv); return; } ov[m[1]] = Math.max(r[0], Math.min(r[1], n)); done.push(m[1] + '=' + ov[m[1]]); });
        if (done.length) { this.advancedSettings.envOverrides = ov; this._saveAdvancedSettings(); this._envApplyPolicy(); }
        return (done.length ? '已覆寫：' + done.join('、') + '。' : '') + (bad.length ? '不認得：' + bad.join('、') + '（可用：' + Object.keys(OVERRIDE_KEYS).join('、') + '）。' : '') + (done.length || bad.length ? '\n\n' : '用法：/env set budgetMB=900 maxImagePx=1024；/env set reset 取消。\n\n');
    };
    // 政策變了（換檔、降級、覆寫）：已經建好的東西跟著調整
    M._envApplyPolicy = function () { try { if (this.fileCache && this.fileCache.setMaxBytes && this._getFileCacheLimitBytes) this.fileCache.setMaxBytes(this._getFileCacheLimitBytes()); } catch (_) { /* */ } try { if (this._envSwapObj) this._envSwapObj.setHotBytes(Math.max(8, Math.round(this._envPolicy().budgetMB / 4)) * MB); } catch (_) { /* */ } };
    // 重資源用完了一次（外部追蹤的資源）：依政策排程卸載
    M._envSettle = function (id) { try { const g = this._envGov(); if (g) g.settle(id); } catch (_) { /* */ } };
    // 載入前先讓位／排隊；回傳 {fits}。fits:false 代表單一個就超過預算：呼叫端應改用小模型或分塊（不硬載）
    M._envAcquire = async function (id, estBytes, o) { const g = this._envGov(); if (!g) return { fits: true }; return g.acquire(id, estBytes, o); };
    M._envRelease = function (id, o) { try { const g = this._envGov(); if (g) g.release(id, o); } catch (_) { /* */ } };
    // OOM：這個工作階段降一級、全部卸載、通知一次（寧可慢）
    M._envOom = async function (err) {
        const g = this._envGov(); if (!g) return; const now = Date.now(); g.degrade('OOM：' + String((err && err.message) || err).slice(0, 80)); try { await g.unloadAll(); } catch (_) { /* */ } this._envApplyPolicy();
        if (!this._envOomAt || now - this._envOomAt > 60000) { this._envOomAt = now; try { this._pushAssistantMessage('⚠️ 記憶體不足：已卸載模型並改用較省的設定（目前檔位：' + this._envTier() + '）。這次可以再試一次，會跑得比較慢但不會被瀏覽器關掉。用 /env 可以看或調整。', null); this._renderMessageHistory(); } catch (_) { /* */ } }
    };
    // 包住一件重運算：記憶體不足就降級卸載並丟出明確的錯誤，不讓它拖垮整個頁面
    M._envGuard = async function (fn) { try { return await fn(); } catch (e) { if (typeof FaEnv !== 'undefined' && FaEnv.isOom(e)) { await this._envOom(e); throw new Error('記憶體不足：已降低設定並卸載模型，請再試一次（會改用較省的設定、跑得比較慢）'); } throw e; } };
    M._envInit = function () {
        if (this._envStarted || typeof FaEnv === 'undefined' || typeof window === 'undefined') return; this._envStarted = true; const self = this; this._envGov(); window.__faRenderScale = () => Math.max(1, Number(self._envPol('renderScale', 2)) || 2);   // 編輯器的畫布解析度上限（低檔 1、mid 1.5、high 2） this._envRefresh().catch(() => {});
        // 背景分頁（手機被切到別的 App）：低檔把沒在用的全卸載，讓作業系統不要為了記憶體殺掉這個分頁
        document.addEventListener('visibilitychange', () => { try { if (document.hidden && self._envTier() === 'low') self._envGov().unloadAll(); } catch (_) { /* */ } });
        window.addEventListener('pagehide', () => { try { self._envGov().unloadAll(); } catch (_) { /* */ } });
        // 全域的 OOM 錯誤（WebAssembly、WebGPU、ArrayBuffer…）：降級並卸載
        window.addEventListener('unhandledrejection', (ev) => { try { if (FaEnv.isOom(ev && ev.reason)) self._envOom(ev.reason); } catch (_) { /* */ } });
        window.addEventListener('error', (ev) => { try { if (FaEnv.isOom(ev && (ev.error || ev.message))) self._envOom(ev.error || ev.message); } catch (_) { /* */ } });
        // 記憶體壓力（Chrome 才有 performance.memory）：80% 以上先卸載閒置的、92% 以上全卸並降級
        if (typeof performance !== 'undefined' && performance.memory) this._envTimer = setInterval(() => { try { const m = performance.memory, r = m.usedJSHeapSize / m.jsHeapSizeLimit; if (r >= 0.92) self._envGov().pressure('critical'); else if (r >= 0.8) self._envGov().pressure('high'); } catch (_) { /* */ } }, 5000);
    };
    M._envReport = function () {
        const g = this._envGov(), f = FaEnv.detect(this._envRaw || this._envRawSync()), st = this._envSettings(), p = this._envPolicy(), s = g ? g.state() : null, mb = (x) => (x ? Math.round(x / MB) + ' MB' : '未知');
        const L = ['**執行環境基準線**（寧可慢、不要被瀏覽器因記憶體不足殺掉）', '', '- 目前檔位：**' + this._envTier() + '**（' + (st.profile === 'auto' ? '自動偵測' : '你指定：' + st.profile) + (s && s.degradeLevel ? '，這個工作階段已因記憶體吃緊降了 ' + s.degradeLevel + ' 級' : '') + '）',
            '- 偵測到：' + [f.mobile ? '手機／觸控裝置' : '桌機', '記憶體 ' + (f.memKnown ? f.memGB + ' GB' + (f.totalMem ? '' : '（瀏覽器回報，最多到 8）') : '未知'), 'CPU ' + f.cores + ' 核', 'JS heap 上限 ' + mb(f.heapLimit), f.gpu ? 'WebGPU' : '沒有 WebGPU', f.saveData ? '省流量' : '', f.batteryLow ? '電量很低' : ''].filter(Boolean).join('、'),
            '- 政策：記憶體預算 ' + p.budgetMB + ' MB；' + (p.unloadAfterTask ? '模型**跑完任務就卸載**（' + Math.round(p.graceMs / 1000) + ' 秒內又要用就不卸）' : '模型閒置 ' + (Number.isFinite(p.idleMs) ? Math.round(p.idleMs / 1000) + ' 秒' : '永遠不') + '才卸載') + '；同時 ' + p.parallelTasks + ' 個重任務；Worker 最多 ' + p.maxWorkers + ' 個；圖最大 ' + p.maxImagePx + ' px；' + (p.preferSmall ? '優先用小模型' : '可以用大模型')];
        const sw = this._envSwapObj ? this._envSwapObj.stats() : null; if (sw && sw.items) L.push('- swap：' + sw.items + ' 份，記憶體 ' + Math.round(sw.hotBytes / MB) + ' MB、磁碟 ' + Math.round(sw.diskBytes / MB) + ' MB');
        if (s) { L.push('- 目前常駐：' + s.residentMB + ' / ' + s.budgetMB + ' MB'); s.resources.forEach((r) => L.push('  - ' + r.label + '：' + (r.resident ? '已載入' + (r.busy ? '（使用中）' : '（閒置）') : '未載入'))); if (s.events.length) L.push('- 最近：' + s.events.slice(-4).map((e) => e.id + ' ' + e.why).join('；')); }
        L.push('', '用法：`/env auto|low|mid|high` 指定檔位（auto＝自動偵測）、`/env unload` 現在全部卸載、`/env reset` 取消降級。'); return L.join('\n');
    };
    window.FaEnvHost = { methods: M };
})();
