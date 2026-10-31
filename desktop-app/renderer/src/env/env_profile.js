/* 環境基準線（UMD、純函式＋可注入計時器，不碰 DOM）：依「這個環境現在有多少記憶體可用」決定預設值，並管理離線模型／Worker 等重資源的載入與卸載。設計見 DESIGN.env-baseline.md。
 *   FaEnv.detect(raw) → facts          raw：{ mobile, deviceMemory, cores, heapLimit, heapUsed, totalMem, freeMem, saveData, batteryLow, gpu, quotaBytes }（缺的就是沒有）
 *   FaEnv.tierOf(facts, override, degrade) → 'low'|'mid'|'high'     override：'auto'|'low'|'mid'|'high'；degrade：這個工作階段已經降了幾級
 *   FaEnv.policyOf(tier, overrides) → { budgetMB, unloadAfterTask, graceMs, idleMs, maxWorkers, maxImagePx, fileCacheMB, parallelTasks, preferSmall, renderScale, fps }
 *   new FaEnv.Governor({ policy, now, setTimeout, clearTimeout, log }) → register／acquire／release／pressure／degrade／unload／state（見下）*/
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaEnv = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const MB = 1048576, TIERS = ['low', 'mid', 'high'];
    function detect(raw) {
        raw = raw || {}; const f = Object.assign({}, raw);
        f.mobile = !!raw.mobile; f.cores = Math.max(1, Number(raw.cores) || 1);
        // 實際記憶體：桌面版主行程給的 totalMem 最準；瀏覽器的 deviceMemory 最大只回報到 8；Chrome 的 heapLimit 在手機通常只有幾百 MB 到 1 GB
        f.memGB = raw.totalMem ? raw.totalMem / (1024 * MB) : (Number(raw.deviceMemory) || 0);
        f.memKnown = f.memGB > 0; f.heapLimitMB = raw.heapLimit ? raw.heapLimit / MB : 0;
        return f;
    }
    // 先看「最弱的那個指標」：手機、省流量、記憶體小、heap 上限小都往低檔走；沒有任何資訊時保守地當 mid
    function baseTier(f) {
        if (f.mobile || f.saveData) return 'low';
        if (f.heapLimitMB && f.heapLimitMB < 1100) return 'low';
        if (f.memKnown) { if (f.memGB <= 4) return 'low'; if (f.totalMem) { return f.memGB < 6 ? 'low' : f.memGB < 12 ? 'mid' : 'high'; } return f.memGB >= 8 && f.cores >= 8 ? 'high' : 'mid'; }
        return f.cores >= 8 ? 'mid' : f.cores <= 2 ? 'low' : 'mid';
    }
    function tierOf(f, override, degrade) {
        let i = TIERS.indexOf(override) >= 0 ? TIERS.indexOf(override) : TIERS.indexOf(baseTier(f));
        if (f && f.batteryLow && override !== 'high' && TIERS.indexOf(override) < 0) i -= 1;   // 電量很低又沒插電：降一級（不是使用者指定的檔位才降）
        i -= Math.max(0, degrade | 0); return TIERS[Math.max(0, Math.min(2, i))];
    }
    const POLICIES = {
        // unloadAfterTask：跑完一個任務就卸載（graceMs 內又要用就不卸，連續的步驟不會反覆載入）；idleMs：閒置多久卸載（Infinity＝不卸）
        low:  { budgetMB: 600,  unloadAfterTask: true,  graceMs: 4000,  idleMs: 30000,   maxWorkers: 2, maxImagePx: 1024, fileCacheMB: 64,   parallelTasks: 1, preferSmall: true,  renderScale: 1,   fps: 30, tilePx: 512,  batch: 1 },
        mid:  { budgetMB: 1800, unloadAfterTask: false, graceMs: 0,     idleMs: 120000,  maxWorkers: 4, maxImagePx: 2048, fileCacheMB: 256,  parallelTasks: 2, preferSmall: false, renderScale: 1.5, fps: 60, tilePx: 1024, batch: 2 },
        high: { budgetMB: 5000, unloadAfterTask: false, graceMs: 0,     idleMs: 600000,  maxWorkers: 8, maxImagePx: 4096, fileCacheMB: 1024, parallelTasks: 3, preferSmall: false, renderScale: 2,   fps: 60, tilePx: 2048, batch: 4 },
    };
    function policyOf(tier, overrides) { return Object.assign({}, POLICIES[tier] || POLICIES.mid, overrides || {}); }
    // 這些錯誤訊息代表「記憶體不夠」（WebAssembly、WebGPU、ArrayBuffer、onnxruntime 的各種說法；也包含 Worker 回報的數字錯誤碼）
    const OOM_RE = /out of memory|oom|allocation failed|array buffer allocation|cannot allocate|memory access out of bounds|failed to allocate|device (?:was )?lost|context lost|std::bad_alloc|記憶體不足|Invalid (?:typed )?array length|Invalid string length|無法配置/i;
    function isOom(e) { const t = typeof e === 'number' ? 'code ' + e : String((e && (e.message || e.reason)) || e || ''); return OOM_RE.test(t) || (typeof e === 'number' && e > 1000000); }

    class Governor {
        constructor(o) {
            o = o || {}; this.policyFn = o.policy || (() => policyOf('mid')); this.now = o.now || (() => Date.now()); /* 包一層：瀏覽器的 setTimeout 不能用別的物件當 this 呼叫 */ const st0 = o.setTimeout, ct0 = o.clearTimeout; this.st = (fn, ms) => (st0 ? st0(fn, ms) : setTimeout(fn, ms)); this.ct = (id) => (ct0 ? ct0(id) : clearTimeout(id)); this.log = o.log || (() => {});
            this.res = new Map(); this.degradeLevel = 0; this.events = []; this.waiters = [];
        }
        policy() { return this.policyFn(); }
        // register：unload() 真的釋放（終止 Worker、dispose 管線、把引用設成 null）；bytes() 估計常駐大小；kind 只是標籤
        // def.resident()：資源常駐與否由外面的程式自己追蹤時給（例如 this._whisperTranscriber 有沒有值）；不給就由 acquire／unload 追蹤
        register(id, def) { const r = this.res.get(id) || { id, busy: 0, last: 0, timer: null, _res: false }; Object.assign(r, { unload: def.unload, bytes: def.bytes || (() => 0), kind: def.kind || 'model', label: def.label || id, isRes: def.resident || null }); Object.defineProperty(r, 'resident', { configurable: true, get() { return this.isRes ? !!this.isRes() : this._res; }, set(v) { this._res = !!v; } }); this.res.set(id, r); return r; }
        residentBytes(except) { let n = 0; for (const r of this.res.values()) if (r.resident && r.id !== except) n += Number(r.bytes()) || 0; return n; }
        // settle：外部追蹤的資源用完一次（不經過 acquire）：依政策排程卸載（低檔 graceMs、其他檔 idleMs）
        settle(id, o) { const r = this.res.get(id); if (!r || r.busy > 0) return; this.clearTimer(r); r.last = this.now(); const p = this.policy(), ms = (o && o.immediate) ? 0 : p.unloadAfterTask ? p.graceMs : p.idleMs; if (!Number.isFinite(ms)) return; r.timer = this.st(() => { r.timer = null; if (r.busy === 0) this.unload(id, p.unloadAfterTask ? '任務完成' : '閒置'); }, ms); }
        // acquire：要載入／使用 id（預估 estBytes 位元組）。寧可慢、不要被瀏覽器因記憶體不足殺掉：
        //   ① 先把別的閒置資源依最久沒用的順序卸載到放得下；② 還放不下、但有別的資源正在用 → **排隊等它們用完**（不超額同時載入）；
        //   ③ 沒有別的在用、單一個就比預算大 → 回報 fits:false，由呼叫端改用小模型或分塊（不硬載）。maxWaitMs 到了還是等不到就丟錯（說明在等誰）。
        async acquire(id, estBytes, o) {
            const r = this.res.get(id); if (!r) throw new Error('FaEnv：沒有登記的資源 ' + id);
            o = o || {}; this.clearTimer(r); estBytes = Number(estBytes) || Number(r.bytes()) || 0; const t0 = this.now(), maxWait = o.maxWaitMs == null ? 30 * 60 * 1000 : o.maxWaitMs;
            for (;;) {
                const budget = this.policy().budgetMB * MB, need = () => this.residentBytes(id) + estBytes - budget;
                if (need() > 0) { const idle = [...this.res.values()].filter((x) => x.resident && x.id !== id && x.busy === 0).sort((a, b) => a.last - b.last); for (const x of idle) { if (need() <= 0) break; await this.unload(x.id, '讓出記憶體給 ' + r.label); } }
                const busyOthers = [...this.res.values()].filter((x) => x.resident && x.id !== id && x.busy > 0);
                if (need() > 0 && busyOthers.length && o.wait !== false) {
                    if (this.now() - t0 > maxWait) throw new Error('等太久了（記憶體被 ' + busyOthers.map((x) => x.label).join('、') + ' 佔著），為了不讓瀏覽器因記憶體不足被關掉，這次先不載入 ' + r.label);
                    await new Promise((res) => { this.waiters.push(res); if (o.pollMs) this.st(res, o.pollMs); }); continue;
                }
                r.busy++; r.resident = true; r.last = this.now(); return { fits: need() <= 0, free: Math.max(0, budget - this.residentBytes(id) - estBytes), waited: this.now() - t0 };
            }
        }
        wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => { try { f(); } catch (_) { /* */ } }); }
        touch(id) { const r = this.res.get(id); if (r) { r.last = this.now(); } }
        // release：這次任務用完了。低檔：graceMs 後卸載；其他檔：閒置 idleMs 後卸載（Infinity 不卸）
        release(id, o) {
            const r = this.res.get(id); if (!r) return; r.busy = Math.max(0, r.busy - 1); r.last = this.now(); if (r.busy > 0) return; this.wake();
            const p = this.policy(), immediate = o && o.immediate; this.clearTimer(r);
            const ms = immediate ? 0 : p.unloadAfterTask ? p.graceMs : p.idleMs; if (!Number.isFinite(ms)) return;
            r.timer = this.st(() => { r.timer = null; if (r.busy === 0) this.unload(id, p.unloadAfterTask ? '任務完成' : '閒置'); }, ms);
        }
        clearTimer(r) { if (r.timer) { this.ct(r.timer); r.timer = null; } }
        async unload(id, why) {
            const r = this.res.get(id); if (!r || !r.resident) return false; this.clearTimer(r);
            try { await r.unload(); } catch (e) { this.log('卸載 ' + r.label + ' 時出錯：' + ((e && e.message) || e)); }
            r.resident = false; r.busy = 0; this.wake(); this.events.push({ t: this.now(), id, why: why || '' }); if (this.events.length > 50) this.events.shift(); this.log('已卸載 ' + r.label + (why ? '（' + why + '）' : '')); return true;
        }
        async unloadAll(except) { let n = 0; for (const r of [...this.res.values()]) if (r.id !== except && r.resident && r.busy === 0 && await this.unload(r.id, '全部卸載')) n++; return n; }
        // 記憶體壓力：high＝把閒置的卸載到剩預算的 70%；critical＝閒置的全卸，並降一級（這個工作階段）
        async pressure(level) {
            if (level === 'ok') return 0; const budget = this.policy().budgetMB * MB; let n = 0;
            const idle = () => [...this.res.values()].filter((x) => x.resident && x.busy === 0).sort((a, b) => a.last - b.last);
            if (level === 'critical') { n = await this.unloadAll(); this.degrade('記憶體吃緊'); return n; }
            for (const x of idle()) { if (this.residentBytes() <= budget * 0.7) break; if (await this.unload(x.id, '記憶體壓力')) n++; } return n;
        }
        degrade(reason) { if (this.degradeLevel < 2) { this.degradeLevel++; this.events.push({ t: this.now(), id: '*', why: '降級（' + (reason || '') + '）' }); this.log('環境降一級：' + (reason || '')); return true; } return false; }
        recover() { this.degradeLevel = 0; }
        state() { return { degradeLevel: this.degradeLevel, residentMB: Math.round(this.residentBytes() / MB), budgetMB: this.policy().budgetMB, resources: [...this.res.values()].map((r) => ({ id: r.id, label: r.label, kind: r.kind, resident: r.resident, busy: r.busy, mb: Math.round((Number(r.bytes()) || 0) / MB) })), events: this.events.slice(-10) }; }
    }
    // 服務端（Node）：用 os 模組填 raw，之後 detect／tierOf／policyOf／Governor 與瀏覽器共用同一套。FaEnv.rawFromNode(require('os'))
    function rawFromNode(os) { const raw = { mobile: false, cores: (os.cpus() || []).length || 1, totalMem: os.totalmem(), freeMem: os.freemem() }; try { const hs = require('v8').getHeapStatistics(); raw.heapLimit = hs.heap_size_limit; raw.heapUsed = hs.used_heap_size; } catch (_) { /* 沒有 v8 就算了 */ } return raw; }
    return { rawFromNode, detect, tierOf, policyOf, baseTier, isOom, Governor, POLICIES, TIERS };
});
