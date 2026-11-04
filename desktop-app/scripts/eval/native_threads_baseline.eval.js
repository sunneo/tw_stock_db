// 原生執行器階段 1.1：WASM 多執行緒的現況基準（真 Electron，不下載、不載入模型）。
// 量的是「現在的桌面版」：頁面與工作者的 crossOriginIsolated、SharedArrayBuffer 能否傳給 Worker（postMessage）、
// 文字／看圖路徑的執行緒判斷（fa._omThreadSupport／fa._omCores／resolveThreads）、音訊路徑的 loadOrt 結果。
// 用法：node scripts/eval/run_eval.js scripts/eval/native_threads_baseline.eval.js 17941
// 結果 JSON 由 run_eval 印出的 [eval-file] result 取得。
return (async () => {
    const R = {};
    R.protocol = location.protocol;
    R.page_cross_origin_isolated = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : null;
    R.page_sab_type = typeof SharedArrayBuffer;
    try { new MessageChannel().port1.postMessage(new SharedArrayBuffer(1)); R.page_post_sab = 'ok'; }
    catch (e) { R.page_post_sab = 'error: ' + ((e && e.name) || '') + ' ' + ((e && e.message) || e); }
    R.hardware_concurrency = navigator.hardwareConcurrency;

    // 文字／看圖路徑（_vlmEnsureLoaded 用的判斷）
    const ts = window.fa._omThreadSupport();
    R.vlm_thread_support = { ok: ts.ok, coi: ts.coi, reason: ts.reason };
    const cores = window.fa._omCores();
    R.vlm_cores = { hardware: cores.hardware, isolated: cores.isolated, reason: cores.reason || '' };
    R.vlm_resolve_threads = FaVlm.resolveThreads(0, cores.hardware, cores.isolated, cores.reason);

    // 工作者內（Blob 來源）的同一組值
    R.worker = await new Promise((resolve) => {
        const src = 'self.postMessage({ coi: typeof crossOriginIsolated === "undefined" ? "undefined" : crossOriginIsolated, sab: typeof SharedArrayBuffer, post: (() => { try { new MessageChannel().port1.postMessage(new SharedArrayBuffer(1)); return "ok"; } catch (e) { return "error: " + ((e && e.name) || "") + " " + ((e && e.message) || e); } })() });';
        let w;
        try { w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); }
        catch (e) { resolve({ error: String((e && e.message) || e) }); return; }
        w.onmessage = (ev) => { resolve(ev.data); w.terminate(); };
        w.onerror = (ev) => { resolve({ error: String(ev.message || 'worker error') }); w.terminate(); };
        setTimeout(() => { resolve({ error: 'timeout' }); try { w.terminate(); } catch (_) {} }, 5000);
    });

    // 音訊路徑（FaAudioRuntime.loadOrt，不載入模型，只設定 env）
    try {
        const ort = await FaAudioRuntime.loadOrt({});
        R.audio_loadort = { numThreads: ort.env.wasm.numThreads, proxy: ort.env.wasm.proxy };
    } catch (e) { R.audio_loadort = { error: String((e && e.message) || e) }; }

    console.log('[eval-file] baseline ' + JSON.stringify(R));
    return R;
})();
