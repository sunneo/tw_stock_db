// 聲紋模型探測（真 Electron）：讀取工作階段暫存的 ECAPA ONNX、用 onnxruntime-web 開啟，確認輸入／輸出名稱與形狀。
// 只讀檔、不寫入倉庫。需要環境變數無：路徑寫在下面。
return (async () => {
    const R = { checks: [], notes: [] };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const MODEL_PATH = 'C:/Users/sunneo/AppData/Local/Temp/claude/1845096e089295dd/297b791e-2c3f-4f8b-b5fd-9058de6fe069/scratchpad/ecapa/ecapa_tdnn.onnx';
    try {
        const t0 = Date.now();
        const rf = await window.desktopAPI.rawfs.readFile(MODEL_PATH, 'base64');
        R.notes.push('讀檔 ' + (rf.sizeBytes || 0) + ' 位元組，耗時 ' + (Date.now() - t0) + 'ms');
        ck('讀到模型檔', rf.sizeBytes === 83404680, rf.sizeBytes);
        const bin = atob(rf.base64); const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const ort = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs');
        ort.env.wasm.numThreads = 1;
        const sess = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
        R.notes.push('inputNames=' + JSON.stringify(sess.inputNames) + ' outputNames=' + JSON.stringify(sess.outputNames));
        ck('onnxruntime-web 開啟模型', true);
        const tryShape = async (shape) => {
            const n = shape.reduce((a, b) => a * b, 1);
            const x = new ort.Tensor('float32', new Float32Array(n), shape);
            const out = await sess.run({ [sess.inputNames[0]]: x });
            const o = out[sess.outputNames[0]];
            return { dims: o.dims, size: o.data.length };
        };
        for (const shape of [[1, 300, 80], [1, 80, 300]]) {
            try { const r = await tryShape(shape); R.notes.push('輸入 ' + JSON.stringify(shape) + ' 成功，輸出 dims ' + JSON.stringify(r.dims)); }
            catch (e) { R.notes.push('輸入 ' + JSON.stringify(shape) + ' 失敗：' + String((e && e.message) || e).slice(0, 200)); }
        }
    } catch (e) {
        R.checks.push({ name: '探測過程例外', ok: false, extra: String((e && e.stack) || e).slice(0, 500) });
    }
    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] ecapa_probe ' + JSON.stringify(R));
    return R;
})();
