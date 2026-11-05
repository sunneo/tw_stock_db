// Whisper 編碼器原生路徑真 Electron 驗證（由 native_audio_e2e.js 以 NAB_EVAL_FILE=native_whisper_e2e.eval.js 複製到暫存執行；__MODELS__ 內要有 whisper_base_encoder_q8.onnx）。
// 沒有下載解碼器與分詞器（使用者只同意下載編碼器），所以這裡用「跟 transformers.js 相同介面」的替身：transcriber.model.sessions.model 是真的 onnxruntime-web（WASM）編碼器 session，
// 輸入輸出都是 ort.Tensor；fa._whisperNativeAttach 會把它的 run 換成原生。比較：原生對 WASM 的輸出誤差與時間、退回情況。
return (async () => {
    const MODELS = '__MODELS__', OUT = '__OUT__', fsx = window.desktopAPI.rawfs, R = { steps: [], t0: Date.now() };
    const note = async (o) => { R.steps.push(o); try { await fsx.writeFile(OUT, { text: JSON.stringify(R, null, 1) }); } catch (_) { /* */ } };
    const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const b64u8 = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    // 把編碼器放進這個隔離 profile 的 transformers 快取（transformers.js 平常放的位置；不下載）
    const cc = await fsx.copyChunked(MODELS + '/whisper_base_encoder_q8.onnx', MODELS + '/../seed-wh/p', 8 * 1048576), parts = [];
    for (const p of cc.parts) parts.push(b64u8((await fsx.readFile(MODELS + '/../seed-wh/' + p.name, 'base64')).base64));
    const all = new Uint8Array(cc.size); let o = 0; for (const u of parts) { all.set(u, o); o += u.length; } await fsx.remove(MODELS + '/../seed-wh', true);
    const url = 'https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model_quantized.onnx';
    const dc = await caches.open('transformers-cache'); await dc.put(url, new Response(all.slice(), { headers: { 'content-length': String(all.length), 'content-type': 'application/octet-stream' } }));
    await note({ step: 'seed', bytes: all.length });
    try { localStorage.setItem('fa.native.enabled', '1'); } catch (_) { /* */ }
    const ort = await FaAudioRuntime.loadOrt();
    const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
    const mk = (q) => { const a = new Float32Array(80 * 3000), r = rng(30 + q); for (let i = 0; i < a.length; i++) a[i] = -0.6 + (r() - 0.5) * 0.8; return new ort.Tensor('float32', a, [1, 80, 3000]); };
    const F = (t) => new ort.Tensor('float32', t.data.slice(), t.dims); // onnxruntime-web 的 proxy 模式會把輸入緩衝轉移掉，每次呼叫給新的副本
    const mkTranscriber = async () => { const w = await FaAudioRuntime.createSession(ort, all.slice(), ['wasm'], {}); return { w, tr: { model: { sessions: { model: w.session } } } }; };
    const cmp = (a, b) => { let mx = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > mx) mx = d; } return mx; };
    let calls = 0; const orig = fa._nrCall.bind(fa); fa._nrCall = (...a) => { calls++; return orig(...a); };

    // ① 原生對網頁版：同一組輸入交錯呼叫（先量網頁版 run，再換成原生，各三組輸入各跑三次取中位數）
    { const { w, tr } = await mkTranscriber(); const sess = tr.model.sessions.model, wrun = sess.run.bind(sess);
        const refs = [], wasT = [], natT = []; let worst = 0, retType = null, retCtor = null;
        for (let q = 0; q < 3; q++) { const x = mk(q); await wrun({ input_features: F(x) }); const ts = []; let out; for (let k = 0; k < 3; k++) { const t = performance.now(); out = await wrun({ input_features: F(x) }); ts.push(Math.round(performance.now() - t)); } wasT.push(median(ts)); refs.push(out.last_hidden_state.data.slice()); }
        const msgs = []; const att = await fa._whisperNativeAttach(tr, 'wasm', (m) => msgs.push(m));
        if (!att) { await note({ step: 'compare', error: '原生沒接上', why: fa._whisperNativeNote, msgs }); }
        else {
            for (let q = 0; q < 3; q++) { const x = mk(q); await sess.run({ input_features: F(x) }); const ts = []; let out; for (let k = 0; k < 3; k++) { const t = performance.now(); out = await sess.run({ input_features: F(x) }); ts.push(Math.round(performance.now() - t)); } natT.push(median(ts)); worst = Math.max(worst, cmp(out.last_hidden_state.data, refs[q])); retType = out.last_hidden_state.type; retCtor = out.last_hidden_state instanceof ort.Tensor; }
            await note({ step: 'compare', native_ms: natT, wasm_ms: wasT, native_median: median(natT), wasm_median: median(wasT), max_abs_err: worst, ret_type: retType, ret_is_ort_tensor: retCtor, still_native: att.native, msgs });
        }
        await w.session.release(); await fa._nrCall('onnx_release', { id: 'whisper-base-encoder' }, 8000); }

    // ② 部分原生：①裝置是 WebGPU ②逐模型開關關閉 → 回 null、完全沒打信箱、run 沒被換掉
    { const { w, tr } = await mkTranscriber(); const before = tr.model.sessions.model.run; calls = 0;
        const a = await fa._whisperNativeAttach(tr, 'webgpu'); const c1 = calls;
        localStorage.setItem('fa.native.model.whisper-base-encoder', '0'); const b = await fa._whisperNativeAttach(tr, 'wasm'); const c2 = calls; localStorage.removeItem('fa.native.model.whisper-base-encoder');
        localStorage.setItem('fa.native.enabled', '0'); const c = await fa._whisperNativeAttach(tr, 'wasm'); const c3 = calls; localStorage.setItem('fa.native.enabled', '1');
        await note({ step: 'partial_native', webgpu_null: a === null, webgpu_calls: c1, switch_off_null: b === null, switch_off_calls: c2 - c1, optin_off_null: c === null, optin_off_calls: c3 - c2, run_untouched: tr.model.sessions.model.run === before });
        await w.session.release(); }

    // ③ 快取沒有編碼器檔案 → 維持網頁版並寫原因
    { const { w, tr } = await mkTranscriber(); await dc.delete(url); const a = await fa._whisperNativeAttach(tr, 'wasm'); await note({ step: 'no_cache', null: a === null, why: fa._whisperNativeNote });
        await dc.put(url, new Response(all.slice(), { headers: { 'content-length': String(all.length) } })); await w.session.release(); }

    // ④ 載入失敗：原生資料夾裡的模型檔被換成同大小垃圾 → 維持網頁版並寫出載入錯誤，網頁版 run 照常
    { const { w, tr } = await mkTranscriber(); const box = await fa._nrBox(), sep = box.indexOf(String.fromCharCode(92)) >= 0 ? String.fromCharCode(92) : '/', ud = box.slice(0, box.lastIndexOf(sep));
        const mp = ud + sep + 'native-models' + sep + 'whisper-base-encoder' + sep + 'encoder_model_quantized.onnx';
        await fa._nrCall('onnx_release', { id: 'whisper-base-encoder' }, 8000); await fsx.writeFile(mp, { base64: btoa('x'.repeat(all.length)) });
        const a = await fa._whisperNativeAttach(tr, 'wasm'); const why = fa._whisperNativeNote; const out = await tr.model.sessions.model.run({ input_features: F(mk(0)) });
        await note({ step: 'load_fail', null: a === null, why, web_run_ok: !!out.last_hidden_state, shape: out.last_hidden_state.dims });
        await fsx.remove(mp, false); try { await fsx.remove(mp + '.ok', false); } catch (_) { /* */ } await w.session.release(); }

    // ⑤ 執行到一半出錯：載入成功、跑完第一次後把主程序那邊的模型釋放掉 → 第二次自動退回網頁版，輸出一致，原因寫出
    { const { w, tr } = await mkTranscriber(); const sess = tr.model.sessions.model; const a = await fa._whisperNativeAttach(tr, 'wasm');
        const x = mk(1), r1 = await sess.run({ input_features: F(x) }), nat1 = a && a.native; await fa._nrCall('onnx_release', { id: 'whisper-base-encoder' }, 8000);
        const r2 = await sess.run({ input_features: F(x) });
        await note({ step: 'midrun_fail', attached: !!a, first_native: nat1, fell_back: a && !a.native, reason: fa._whisperNativeNote, max_abs_diff: cmp(r1.last_hidden_state.data, r2.last_hidden_state.data) });
        await w.session.release(); }
    fa._nrCall = orig; R.total_ms = Date.now() - R.t0; await note({ step: 'done' });
    return { ok: true, steps: R.steps.length };
})();
