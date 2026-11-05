// WASM 端（產品相同設定：ort.webgpu.min.mjs 1.22.0、wasm、graphOptimizationLevel all、無 proxy、執行緒＝crossOriginIsolated ? min(8,核心) : 1）逐階段，與原生端存的 .bin 比對。
return (async () => {
    const MODELS = '__MODELS__', OUT = '__OUT__', fsx = window.desktopAPI.rawfs, R = { steps: [] };
    const note = async (o) => { R.steps.push(o); await fsx.writeFile(OUT + '/wasm-result.json', { text: JSON.stringify(R, null, 1) }); };
    const b64 = async (p) => { const r = await fsx.readFile(p, 'base64'); const bin = atob(r.base64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    const bigBytes = async (p, tag) => { const st = await fsx.stat(p); if (st.size <= 150 * 1048576) return b64(p); const pd = OUT + '/parts-' + tag + '/'; const cc = await fsx.copyChunked(p, pd + 'p', 64 * 1048576); const bytes = new Uint8Array(cc.size); let o = 0; for (const q of cc.parts) { const u = await b64(pd + q.name); bytes.set(u, o); o += u.length; } await fsx.remove(pd, true); return bytes; };
    const f32 = async (n) => { const u = await b64(OUT + '/' + n + '.bin'); return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4); };
    const stat = (a, b) => { let mx = 0, se = 0, sp = 0, dyn = [Infinity, -Infinity]; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; if (Math.abs(d) > mx) mx = Math.abs(d); se += d * d; sp += b[i] * b[i]; if (b[i] < dyn[0]) dyn[0] = b[i]; if (b[i] > dyn[1]) dyn[1] = b[i]; } const mse = se / a.length; return { max_abs: mx, rmse: Math.sqrt(mse), snr_db: 10 * Math.log10((sp / a.length) / (mse || 1e-30)), range: dyn }; };
    const SD = FaLocalSd;
    const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
    const ort = await import(ORT + 'ort.webgpu.min.mjs'); ort.env.wasm.wasmPaths = ORT;
    const THREADS = +'__THREADS__' || (self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1); ort.env.wasm.numThreads = THREADS;
    const GOPT = '__GOPT__' || 'all';
    await note({ step: 'env', threads: THREADS, coi: self.crossOriginIsolated, cores: navigator.hardwareConcurrency, gopt: GOPT });
    const ids = await (async () => { const u = await b64(OUT + '/ids.bin'); return new Int32Array(u.buffer, u.byteOffset, u.byteLength / 4); })();
    const hsN = await f32('hs_native'), x = await f32('x'), epsN = await f32('eps_native'), x0N = await f32('x0_native'), imgN = await f32('img_native');
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: GOPT };
    // 文字編碼器：同一份 ids
    let hsW;
    { const s = await ort.InferenceSession.create(await bigBytes(MODELS + '/text_encoder.onnx', 't'), opts); const ts = [];
        for (let k = 0; k < 2; k++) { const t = performance.now(); const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('int32', ids.slice(), [1, 77]) }); ts.push(Math.round(performance.now() - t)); hsW = r[s.outputNames[0]].data.slice(); }
        await note({ step: 'text', wasm_ms: ts, native_vs_wasm: stat(hsW, hsN) }); await s.release(); }
    // unet：兩種輸入——①跟原生同一份文字向量（隔離 unet 本身的差異）②WASM 自己的文字向量（整條）
    let epsW, epsW2;
    { const s = await ort.InferenceSession.create(await bigBytes(MODELS + '/unet.onnx', 'u'), opts);
        const names = s.inputNames, nS = names.find((n) => /sample/i.test(n)) || names[0], nT = names.find((n) => /time/i.test(n)) || names[1], nC = names.find((n) => /encoder|hidden|context/i.test(n)) || names[2];
        const run = async (hs) => { const t = performance.now(); const r = await s.run({ [nS]: new ort.Tensor('float32', SD.scaleInput(x), [1, 4, 64, 64]), [nT]: new ort.Tensor('float32', Float32Array.from([999]), [1]), [nC]: new ort.Tensor('float32', hs.slice(), [1, 77, 768]) }); return { d: r[s.outputNames[0]].data.slice(), ms: Math.round(performance.now() - t) }; };
        const a = await run(hsN), b = await run(hsN); epsW = a.d; const c = await run(hsW); epsW2 = c.d; window.__unetMs = c.ms;
        await note({ step: 'unet_same_input', wasm_ms: [a.ms, b.ms], native_vs_wasm: stat(epsW, epsN), wasm_run_to_run: stat(a.d, b.d) });
        await note({ step: 'unet_own_text', wasm_ms: c.ms, vs_native_eps: stat(epsW2, epsN) }); await s.release(); }
    // vae：①同一份 x0（原生 eps 算出）②各自整條
    {
        const s = await ort.InferenceSession.create(await bigBytes(MODELS + '/vae_decoder.onnx', 'v'), opts);
        const run = async (x0) => { const t = performance.now(); const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', x0.slice(), [1, 4, 64, 64]) }); return { d: r[s.outputNames[0]].data.slice(), ms: Math.round(performance.now() - t) }; };
        const a = await run(x0N), b = await run(SD.denoise(x, epsW2));
        const psnr = (p, q) => { let se = 0; for (let i = 0; i < p.length; i++) { const u = Math.max(0, Math.min(1, p[i] / 2 + 0.5)), v = Math.max(0, Math.min(1, q[i] / 2 + 0.5)); se += (u - v) * (u - v); } return 10 * Math.log10(1 / (se / p.length || 1e-30)); };
        await note({ step: 'vae_same_input', wasm_ms: a.ms, native_vs_wasm: stat(a.d, imgN), psnr_db: psnr(a.d, imgN) });
        { const u8 = new Uint8Array(b.d.buffer, b.d.byteOffset, b.d.byteLength); let bs = ''; for (let i = 0; i < u8.length; i += 0x8000) bs += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); await fsx.writeFile(OUT + '/img_wasm.bin', { base64: btoa(bs) }); }
        await note({ step: 'full_pipeline', unet_ms: window.__unetMs, vae_ms: b.ms, wasm_own_vs_native_psnr_db: psnr(b.d, imgN), wasm_unet_same_x0_psnr_db: (() => { return null; })() });
        await s.release(); }
    await note({ step: 'done' });
    return 'ok';
})();
