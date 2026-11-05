// SDXS（CPU int8）原生路徑真 Electron 驗證（native_audio_e2e.js 以 NAB_EVAL_FILE=native_sdxs_e2e.eval.js 啟動；模型 id 欄位當模式：full＝完整驗證、noruntime＝沒有執行包時的退回）。
// __MODELS__ 要有 sdxs-int8/（text_encoder.onnx、unet.onnx、vae_decoder.onnx）；不下載、分詞器用固定 token 替身（「a photo of a cat」）。
return (async () => {
    const MODELS = '__MODELS__', OUT = '__OUT__', MODE = '__IDS__', fsx = window.desktopAPI.rawfs, R = { mode: MODE, steps: [], t0: Date.now() };
    const note = async (o) => { R.steps.push(o); try { await fsx.writeFile(OUT, { text: JSON.stringify(R, null, 1) }); } catch (_) { /* */ } };
    const b64u8 = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    const model = FaLocalSd.byId('sdxs-512-cpu-int8'), cache = await caches.open('fa-localsd');
    // 種子：把三個檔放進 fa-localsd 快取（產品下載後放的位置），用分片 Blob 避免一次配置 873 MB
    for (const f of model.files) {
        const dir = MODELS + '/../seed-sdxs-' + f.role + '/', cc = await fsx.copyChunked(MODELS + '/sdxs-int8/' + f.name, dir + 'p', 32 * 1048576), parts = [];
        for (const p of cc.parts) parts.push(b64u8((await fsx.readFile(dir + p.name, 'base64')).base64));
        await fsx.remove(dir, true);
        await cache.put(FaLocalSd.urlOf(model, f.name), new Response(new Blob(parts), { headers: { 'content-length': String(cc.size) } }));
        if (cc.size !== f.bytes) { await note({ step: 'seed', error: '位元組數不符 ' + f.name + ' ' + cc.size }); return { ok: false }; }
    }
    await note({ step: 'seed', ok: true });
    try { localStorage.setItem('fa.native.enabled', '1'); } catch (_) { /* */ }
    fa.advancedSettings = fa.advancedSettings || {};
    fa._localSdTokenize = async () => FaLocalSd.padIds([49406, 320, 1125, 539, 320, 2368, 49407]);
    let calls = 0; const orig = fa._nrCall.bind(fa); fa._nrCall = (...a) => { calls++; return orig(...a); };
    const px = async (blob) => { const bm = await createImageBitmap(blob), cv = new OffscreenCanvas(bm.width, bm.height), cx = cv.getContext('2d'); cx.drawImage(bm, 0, 0); return cx.getImageData(0, 0, bm.width, bm.height).data; };
    const psnr = (a, b) => { let se = 0; for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = (a[i + c] - b[i + c]) / 255; se += d * d; } return 10 * Math.log10(1 / (se / (a.length / 4 * 3) || 1e-30)); };
    const gen = async (seed, label) => { const msgs = []; const t = performance.now(); const r = await fa._localSdRun(model, 'wasm', { prompt: 'x', seed }, (m) => msgs.push(m)); return { label, ms: Math.round(performance.now() - t), blob: r.blob, stats: r.stats, note: fa._localSdNativeNote, nBackends: (fa._localSdSess && fa._localSdSess.sess) ? Object.fromEntries(Object.entries(fa._localSdSess.sess).map(([k, s]) => [k, s.backend || 'web'])) : null }; };
    const sw = (on) => { if (on) localStorage.removeItem('fa.native.model.sdxs-512-cpu-int8'); else localStorage.setItem('fa.native.model.sdxs-512-cpu-int8', '0'); };
    const unloadAll = async () => { await fa._localSdUnload(); };

    if (MODE === 'noruntime') {
        // 沒有執行包：原生不可用 → 整條走網頁版，照常出圖，原因寫出
        const g = await gen(1234, 'noruntime'); await note({ step: 'noruntime', ms: g.ms, backends: g.nBackends, note: g.note, size: g.blob.size, stats: g.stats, avail: fa._nrAvailable(), calls });
        await unloadAll(); fa._nrCall = orig; await note({ step: 'done' }); return { ok: true };
    }

    // ① 原生整條（第一次含寫進原生資料夾與載入，第二次是穩態）對網頁版（逐模型開關關閉）
    const n1 = await gen(1234, 'native-first'), n2 = await gen(1234, 'native-steady');
    await note({ step: 'native', first_ms: n1.ms, steady_ms: n2.ms, backends: n2.nBackends, note: n2.note });
    await unloadAll(); sw(false);
    const w1 = await gen(1234, 'web-first'), w2 = await gen(1234, 'web-steady');
    await note({ step: 'web', first_ms: w1.ms, steady_ms: w2.ms, backends: w2.nBackends });
    const pn = await px(n2.blob), pw = await px(w2.blob);
    await note({ step: 'compare', native_steady_ms: n2.ms, web_steady_ms: w2.ms, speedup: +(w2.ms / n2.ms).toFixed(2), psnr_db_rgb8: psnr(pn, pw), native_stats: n2.stats, web_stats: w2.stats });
    sw(true); await unloadAll();

    // ② 部分原生閘門：GPU 版（ep=webgpu）／逐模型開關關／原生總開關關／別的模型 → 不走原生、信箱 0 次
    { calls = 0; const a = await fa._localSdNativeApi(model, 'webgpu'), o = await fa._localSdNativeApi({ id: 'sdxs-512-webgpu' }, 'wasm');
        sw(false); const b = await fa._localSdNativeApi(model, 'wasm'); sw(true);
        localStorage.setItem('fa.native.enabled', '0'); const c = await fa._localSdNativeApi(model, 'wasm'); localStorage.setItem('fa.native.enabled', '1');
        const d = await fa._localSdNativeApi(model, 'wasm');
        await note({ step: 'partial_native', webgpu_null: a === null, other_model_null: o === null, switch_off_null: b === null, optin_off_null: c === null, on_not_null: d !== null, calls_before_on: calls }); }

    // ③ 載入失敗：原生資料夾裡 VAE 檔被換成同大小垃圾 → 只有 VAE 退回網頁版，其餘段仍原生，照常出圖
    { await unloadAll(); const box = await fa._nrBox(), sep = box.indexOf(String.fromCharCode(92)) >= 0 ? String.fromCharCode(92) : '/', ud = box.slice(0, box.lastIndexOf(sep));
        const mp = ud + sep + 'native-models' + sep + 'sdxs-512-cpu-int8-vae' + sep + 'vae_decoder.onnx'; await fa._nrCall('onnx_release', { id: 'sdxs-512-cpu-int8-vae' }, 8000);
        await fsx.writeFile(mp, { base64: btoa('x'.repeat(model.files.find((f) => f.role === 'vae').bytes)) });   // 同大小的損壞模型檔（大小不同會被當成沒裝好而自動重裝，測不到載入失敗）
        const st = await fsx.stat(mp);
        const g = await gen(1234, 'unet-garbage'); await note({ step: 'load_fail_vae', garbage_size: st.size, backends: g.nBackends, note: g.note, psnr_vs_web_rgb8: psnr(await px(g.blob), pw), ms: g.ms });
        await unloadAll(); await fsx.remove(mp, false); try { await fsx.remove(mp + '.ok', false); } catch (_) { /* */ } }

    // ④ 執行到一半出錯：載入成功、先跑一段後釋放主程序端的 unet → 該段退回網頁版（當場重做這一段），其餘段仍原生
    { await unloadAll(); const S = await fa._localSdLoad(model, 'wasm'); await fa._nrCall('onnx_release', { id: 'sdxs-512-cpu-int8-unet' }, 8000);
        const g = await gen(1234, 'midrun'); await note({ step: 'midrun_fail', backends: g.nBackends, note: g.note, psnr_vs_web_rgb8: psnr(await px(g.blob), pw), ms: g.ms }); void S; }
    fa._nrCall = orig; await unloadAll(); R.total_ms = Date.now() - R.t0; await note({ step: 'done' });
    return { ok: true };
})();
