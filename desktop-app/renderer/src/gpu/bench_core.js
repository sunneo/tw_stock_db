// bench_core.js — GPU 運算後端基準的純規則（無 DOM、無 GPU、無計時；node 與瀏覽器共用）。
// 參考 redmine_ai_chat 的 ai_chat_gpu_bench.js（DESIGN.webgpu-cuda.md §7.3），改成我們的架構：
//   stats(samplesMs)                      → { n, median, p10, p90, mean, cv }   nearest-rank 百分位；cv＝樣本標準差／平均
//   validResult(r)                        → bool  有效：valid 不是 false、n ≥ 20、cv < 0.30、median > 0、錯誤數為 0
//   decide(current, candidates, opts)     → { backend, switched, reason }       遲滯：新後端 median 至少快 15% 才取代
//   pickBackend(op, shape, state)         → { backend, source, reason }         釘選 > 量測（有效且遲滯通過）> 保守預設
//   envKey(env)                           → string   瀏覽器版本＋介面卡＋相關設定；換機器或換介面卡就不沿用（正確性，不是過期）
//   relErr(out, ref)                      → number   誤差用整體尺度：max|out−ref| / max|ref|（不用逐元素相對誤差，RoPE 等會誤判）
//   pinKey(op, shape)                     → string   釘選表的鍵
// 注意：有效結果沒有 TTL。只有使用者按「重跑」（覆蓋）或「恢復預設」（清掉）才會改變。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaGpuBench = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const MIN_RUNS = 20, MAX_CV = 0.30, SWITCH_GAIN = 0.15, WARMUP = 3, MEASURE = 20;
    // 沒量過時每個運算都用 cudaweb（現行行為）。只有有效的量測結果才會改變選擇；沒有任何猜測。
    const DEFAULTS = { matmul: 'cudaweb', softmax: 'cudaweb', rmsnorm: 'cudaweb', silu: 'cudaweb', rope: 'cudaweb', adamw: 'cudaweb' };
    const BACKENDS = ['cudaweb', 'ort-webgpu', 'ort-wasm'];
    // 預設的矩陣乘形狀（M×K×N）：Redmine 外掛實測過的兩個；使用者可以在設定裡改成別的清單
    const DEFAULT_SHAPES = ['512x1024x1024', '512x1024x3072'];
    const MAX_SHAPES = 8;
    // 形狀字串 'MxKxN'（正整數）→ { M, K, N }；不合法回傳 null
    function parseShape(s) {
        const m = /^(\d{1,6})x(\d{1,6})x(\d{1,6})$/.exec(String(s || '').trim()); if (!m) return null;
        const M = +m[1], K = +m[2], N = +m[3]; if (!(M > 0 && K > 0 && N > 0)) return null;
        return { M, K, N };
    }
    // 設定用的形狀清單：去掉不合法與重複的，最多 MAX_SHAPES 個；全部不合法就用預設
    function normalizeShapes(list) {
        const out = []; for (const x of [].concat(list || [])) { const p = parseShape(x); if (!p) continue; const k = p.M + 'x' + p.K + 'x' + p.N; if (out.indexOf(k) < 0) out.push(k); if (out.length >= MAX_SHAPES) break; }
        return out.length ? out : DEFAULT_SHAPES.slice();
    }

    function stats(samples) {
        const a = (samples || []).filter((x) => typeof x === 'number' && isFinite(x) && x >= 0).slice().sort((x, y) => x - y);
        const n = a.length; if (!n) return { n: 0, median: null, p10: null, p90: null, mean: null, cv: null };
        const pct = (p) => a[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];   // nearest-rank
        const mean = a.reduce((s, x) => s + x, 0) / n;
        const sd = n > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1)) : 0;
        return { n, median: pct(0.5), p10: pct(0.1), p90: pct(0.9), mean, cv: mean > 0 ? sd / mean : null };
    }

    // 有效：可以用來做「量測選擇」。太吵（cv ≥ 0.30）或樣本不夠的不算。
    function validResult(r) {
        return !!r && r.valid !== false && (!r.errors || r.errors === 0) && !!r.stats && r.stats.n >= MIN_RUNS && r.stats.cv !== null && r.stats.cv < MAX_CV && r.stats.median > 0;
    }

    // 遲滯：只有有效、且 median 至少快 15% 的候選才能取代目前的後端。
    // 沒有目前量測時，最快的有效候選勝出；沒有有效候選時維持 current（或預設）。
    // 有候選明顯更快但太吵（不有效）時不把選擇交給較慢的有效候選：維持現況，說明要重跑。
    function decide(current, candidates, opts) {
        const def = (opts && opts.defaultBackend) || null;
        const cands = (candidates || []).filter((c) => c && c.stats);
        const ok = cands.filter(validResult).sort((x, y) => x.stats.median - y.stats.median);
        const best = ok[0] || null;
        const cur = cands.filter((c) => c.id === current)[0] || null;
        const curOk = !!cur && validResult(cur);
        if (!best) return { backend: current || def, switched: false, reason: '還沒有有效的量測結果（每個後端要 ' + MIN_RUNS + ' 次、變異係數 < ' + MAX_CV + '）；用預設' };
        const noisy = cands.find((c) => !validResult(c) && c.stats.median > 0 && c.stats.n > 0 && c.stats.median < best.stats.median * (1 - SWITCH_GAIN));
        if (noisy) return { backend: current || def, switched: false, reason: noisy.id + ' 比較快（median ' + noisy.stats.median.toFixed(2) + ' ms）但太吵（變異係數 ' + Math.round((noisy.stats.cv || 0) * 100) + '%）或次數不夠，不做決定，維持現況；請重跑' };
        if (!curOk || !current) return { backend: best.id, switched: best.id !== current, reason: '第一個有效結果：' + best.id + '（median ' + best.stats.median.toFixed(2) + ' ms）' };
        if (best.id === current) return { backend: current, switched: false, reason: '目前的後端就是量測中最快的（' + best.stats.median.toFixed(2) + ' ms）' };
        if (best.stats.median <= cur.stats.median * (1 - SWITCH_GAIN)) {
            return { backend: best.id, switched: true, reason: best.id + ' 比 ' + current + ' 快 ' + Math.round((1 - best.stats.median / cur.stats.median) * 100) + '%（門檻 ' + Math.round(SWITCH_GAIN * 100) + '%）' };
        }
        return { backend: current, switched: false, reason: best.id + ' 比較快，但沒有快到 ' + Math.round(SWITCH_GAIN * 100) + '%；維持 ' + current + '（遲滯）' };
    }

    function pinKey(op, shape) { return String(op) + '|' + String(shape); }

    // state: { results: [{op, shape, id, stats, valid, errors}], pins: { 'op|shape': backendId } }
    // 釘選優先於量測；量測只看有效結果；都沒有就是保守預設（現行行為）。
    function pickBackend(op, shape, state) {
        const st = state || {};
        const pin = st.pins && st.pins[pinKey(op, shape)];
        if (pin && BACKENDS.indexOf(pin) >= 0) return { backend: pin, source: 'pinned', reason: '使用者釘選：' + pin };
        const rows = (st.results || []).filter((r) => r && r.op === op && r.shape === shape);
        const def = DEFAULTS[op] || 'cudaweb';
        if (rows.length) {
            // 比較的基準是預設後端：它沒有有效量測就無法談「快 15%」，維持預設（不會因為另一個後端有結果就換掉）
            const defRow = rows.filter((r) => r.id === def)[0];
            if (!defRow || !validResult(defRow)) return { backend: def, source: 'default', reason: '預設 ' + def + ' 在這個形狀沒有有效量測，無法比較；維持預設' };
            const d = decide(def, rows.map((r) => ({ id: r.id, stats: r.stats, valid: r.valid, errors: r.errors })), { defaultBackend: def });
            return { backend: d.backend, source: 'measured', reason: d.reason };
        }
        return { backend: DEFAULTS[op] || 'cudaweb', source: 'default', reason: '這個形狀還沒有量測結果；用預設' };
    }

    // 快取 key：瀏覽器版本＋介面卡＋相關設定。換機器、換介面卡、換設定都不沿用。
    function envKey(env) {
        const e = env || {}, a = e.adapter || {};
        return [e.browser || '', a.vendor || '', a.architecture || '', a.description || '', e.profile || '', e.budgetMB || '', e.adapters || ''].join('|');
    }

    // 相對誤差（整體尺度）。ref 全為 0 時：out 也要全為 0 才算 0，否則回傳 Infinity。
    function relErr(out, ref) {
        const n = Math.min(out ? out.length : 0, ref ? ref.length : 0); if (!n) return Infinity;
        let maxDiff = 0, maxRef = 0;
        for (let i = 0; i < n; i++) {
            const d = Math.abs(out[i] - ref[i]); if (!isFinite(d)) return Infinity;
            if (d > maxDiff) maxDiff = d; const r = Math.abs(ref[i]); if (r > maxRef) maxRef = r;
        }
        if (maxRef === 0) return maxDiff === 0 ? 0 : Infinity;
        return maxDiff / maxRef;
    }

    return { stats, validResult, decide, pickBackend, pinKey, envKey, relErr, parseShape, normalizeShapes, DEFAULT_SHAPES, MAX_SHAPES, DEFAULTS, BACKENDS, MIN_RUNS, MAX_CV, SWITCH_GAIN, WARMUP, MEASURE };
}));
