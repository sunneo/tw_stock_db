// SlimSAM 編碼器原生路徑真 Electron 驗證（由 native_audio_e2e.js 以 NAB_EVAL_FILE=native_slimsam_e2e.eval.js 複製到暫存執行；__MODELS__ 內要有 slimsam_vision_encoder_q8.onnx，
// 輸入用 __MODELS__/../final/inputs/slimsam-encoder_q0_pixel_values.bin；沒有就用亂數）。
// 沒有下載完整的 SlimSAM（解碼器、處理器設定），所以這裡驗證的是 fa._samNativeEnc／_samNativeReady（Worker 橋接的主程序端）：原生對 onnxruntime-web（WASM）的輸出誤差與時間、閘門、三種退回。
return (async () => {
    const MODELS = '__MODELS__', OUT = '__OUT__', fsx = window.desktopAPI.rawfs, R = { steps: [], t0: Date.now() };
    const note = async (o) => { R.steps.push(o); try { await fsx.writeFile(OUT, { text: JSON.stringify(R, null, 1) }); } catch (_) { /* */ } };
    const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const b64u8 = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    const readBig = async (path, tmp) => { const cc = await fsx.copyChunked(path, MODELS + '/../' + tmp + '/p', 8 * 1048576), parts = []; for (const p of cc.parts) parts.push(b64u8((await fsx.readFile(MODELS + '/../' + tmp + '/' + p.name, 'base64')).base64)); const all = new Uint8Array(cc.size); let o = 0; for (const u of parts) { all.set(u, o); o += u.length; } await fsx.remove(MODELS + '/../' + tmp, true); return all; };
    const all = await readBig(MODELS + '/slimsam_vision_encoder_q8.onnx', 'seed-sam');
    const url = 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder_quantized.onnx';
    const dc = await caches.open('transformers-cache'); await dc.put(url, new Response(all.slice(), { headers: { 'content-length': String(all.length), 'content-type': 'application/octet-stream' } }));
    await note({ step: 'seed', bytes: all.length });
    let px; try { px = new Float32Array((await readBig(MODELS + '/../final/inputs/slimsam-encoder_q0_pixel_values.bin', 'seed-px')).buffer); } catch (e) { px = null; }
    if (!px || px.length !== 3 * 1024 * 1024) { px = new Float32Array(3 * 1024 * 1024); let s = 7; for (let i = 0; i < px.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; px[i] = (s / 4294967296 - 0.5) * 3; } await note({ step: 'input', source: 'random' }); } else await note({ step: 'input', source: 'bench-bin' });
    try { localStorage.setItem('fa.native.enabled', '1'); } catch (_) { /* */ }
    const ort = await FaAudioRuntime.loadOrt();
    const cmp = (a, b) => { let mx = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > mx) mx = d; } return mx; };
    const mkMsg = () => ({ data: px.slice(), dims: [1, 3, 1024, 1024] });
    let calls = 0; const orig = fa._nrCall.bind(fa); fa._nrCall = (...a) => { calls++; return orig(...a); };

    // ① 原生對 WASM：同一份輸入，各量三次（原生第一次含載入，另記）
    { const w = await FaAudioRuntime.createSession(ort, all.slice(), ['wasm'], {}); const wasT = []; let ref;
        await w.session.run({ pixel_values: new ort.Tensor('float32', px.slice(), [1, 3, 1024, 1024]) });
        for (let k = 0; k < 3; k++) { const t = performance.now(); ref = await w.session.run({ pixel_values: new ort.Tensor('float32', px.slice(), [1, 3, 1024, 1024]) }); wasT.push(Math.round(performance.now() - t)); }
        const refE = ref.image_embeddings.data.slice(), refP = ref.image_positional_embeddings.data.slice();
        const natT = []; let first, r; const t0 = performance.now(); first = await fa._samNativeEnc(mkMsg()); const firstMs = Math.round(performance.now() - t0);
        if (!first.ok) await note({ step: 'compare', error: first.error });
        else {
            r = first; for (let k = 0; k < 3; k++) { const t = performance.now(); r = await fa._samNativeEnc(mkMsg()); natT.push(Math.round(performance.now() - t)); }
            await note({ step: 'compare', native_first_ms: firstMs, native_ms: natT, wasm_ms: wasT, native_median: median(natT), wasm_median: median(wasT), err_embeddings: cmp(r.e, refE), err_positional: cmp(r.p, refP), dims: [r.ed, r.pd], is_f32: r.e instanceof Float32Array });
        }
        await w.session.release(); await fa._nrCall('onnx_release', { id: 'slimsam-encoder' }, 8000); fa._nrSamSess = null; }

    // ② 部分原生閘門：WebGPU／逐模型開關關閉／原生總開關關閉／別的模型 → _samNativeReady 回 false、信箱 0 次
    { calls = 0; const model = { id: 'slimsam-77-uniform' };
        const on = await fa._samNativeReady(model, 'wasm'); const gpu = await fa._samNativeReady(model, 'webgpu'); const other = await fa._samNativeReady({ id: 'x' }, 'wasm');
        localStorage.setItem('fa.native.model.slimsam-encoder', '0'); const sw = await fa._samNativeReady(model, 'wasm'); localStorage.removeItem('fa.native.model.slimsam-encoder');
        localStorage.setItem('fa.native.enabled', '0'); const oi = await fa._samNativeReady(model, 'wasm'); localStorage.setItem('fa.native.enabled', '1');
        await note({ step: 'partial_native', ready_on: on, webgpu: gpu, other_model: other, switch_off: sw, optin_off: oi, mailbox_calls: calls }); }

    // ③ 快取沒有編碼器檔案 → ok:false 並寫原因
    { await dc.delete(url); const a = await fa._samNativeEnc(mkMsg()); await note({ step: 'no_cache', ok: a.ok, error: a.error }); await dc.put(url, new Response(all.slice(), { headers: { 'content-length': String(all.length) } })); }

    // ④ 載入失敗：原生資料夾的模型檔被換成同大小垃圾
    { const box = await fa._nrBox(), sep = box.indexOf(String.fromCharCode(92)) >= 0 ? String.fromCharCode(92) : '/', ud = box.slice(0, box.lastIndexOf(sep));
        const mp = ud + sep + 'native-models' + sep + 'slimsam-encoder' + sep + 'vision_encoder_quantized.onnx';
        await fa._nrCall('onnx_release', { id: 'slimsam-encoder' }, 8000); fa._nrSamSess = null; await fsx.writeFile(mp, { base64: btoa('x'.repeat(all.length)) });
        const a = await fa._samNativeEnc(mkMsg()); await note({ step: 'load_fail', ok: a.ok, error: a.error });
        await fsx.remove(mp, false); try { await fsx.remove(mp + '.ok', false); } catch (_) { /* */ } fa._nrSamSess = null; }

    // ⑤ 執行到一半出錯：載入成功、跑完一次後釋放主程序端模型 → 第二次 ok:false；之後重新要求會自動重新載入並成功
    { const a = await fa._samNativeEnc(mkMsg()); await fa._nrCall('onnx_release', { id: 'slimsam-encoder' }, 8000); const b = await fa._samNativeEnc(mkMsg()); const c = await fa._samNativeEnc(mkMsg());
        await note({ step: 'midrun_fail', first_ok: a.ok, second_ok: b.ok, second_error: b.error, third_ok_after_reload: c.ok, same_as_first: a.ok && c.ok ? cmp(a.e, c.e) : null }); }
    fa._nrCall = orig; R.total_ms = Date.now() - R.t0; await note({ step: 'done' });
    return { ok: true, steps: R.steps.length };
})();
