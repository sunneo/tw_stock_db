// 第一步比對（WASM 側，真 Electron）：與應用程式相同的 transformers.js 與模型（qwen3-0.6b，cpu 版 q8，wasm 裝置），
// 餵入 %TEMP%\nvw-out\first-native.json 裡「同一串 ids」，取第一步（整段預填）最後位置的 logits，寫入 %TEMP%\nvw-out\first-wasm.json。
// 只做第一步（沒有生成迴圈，沒有重複懲罰），因此與 first_step_native.js 的比對對象完全一致。
return (async () => {
    const REPO = 'D:\\Downloads\\videos-嗨投資-desktop-app\\desktop-app';
    const NV = 'C:\\Users\\sunneo\\AppData\\Local\\Temp\\nvw-out';
    const rawfs = window.desktopAPI.rawfs;
    const native = JSON.parse((await rawfs.readFile(NV + '\\first-native.json', 'utf8')).text);
    const L = await import(FA_ASSET_URLS.transformersJs);
    L.env.useBrowserCache = true; L.env.allowLocalModels = false;
    const repo = 'onnx-community/Qwen3-0.6B-ONNX';
    const t0 = Date.now();
    const model = await L.AutoModelForCausalLM.from_pretrained(repo, { dtype: 'q8', device: 'wasm' });
    const loadMs = Date.now() - t0;
    const out = [];
    for (const row of native) {
        const n = row.ids.length;
        const input_ids = new L.Tensor('int64', BigInt64Array.from(row.ids.map(BigInt)), [1, n]);
        const attention_mask = new L.Tensor('int64', BigInt64Array.from(Array(n).fill(1n)), [1, n]);
        const r = await model.forward({ input_ids, attention_mask });
        const V = r.logits.dims[2], last = (n - 1) * V;
        const data = r.logits.data;
        const f = new Float32Array(V); for (let i = 0; i < V; i++) f[i] = data[last + i];
        // base64（分段，避免大字串的堆疊問題）
        const bytes = new Uint8Array(f.buffer); let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        out.push({ id: row.id, n, V, logits_b64: btoa(bin) });
        console.log('[first-wasm] ' + row.id + ' n=' + n + ' V=' + V);
    }
    await rawfs.writeFile(NV + '\\first-wasm.json', { text: JSON.stringify({ repo, dtype: 'q8', device: 'wasm', load_ms: loadMs, rows: out }) });
    return { rows: out.length, load_ms: loadMs };
})();
