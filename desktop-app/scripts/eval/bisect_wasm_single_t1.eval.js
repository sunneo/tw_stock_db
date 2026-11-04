// 二分法 第 1 步（WASM 側，真 Electron）：直接用 transformers.js 載入的 ORT-web session（model.sessions）做「單次 forward」，
// 不經 generate，不經 transformers.js 的 forward 包裝。記錄：輸入清單（名稱、dtype、形狀）、輸出清單，以及 ids 最後位置的 logits。
// 輸入與原生端相同：input_ids、attention_mask、position_ids（0..n-1），以及空的 past_key_values（[1,8,0,128] float32）。
// 寫入 %TEMP%\nvw-out\bisect-wasm-single-t1.json（含 meta：模型路徑、大小）。
return (async () => {
    const NV = 'C:\\Users\\sunneo\\AppData\\Local\\Temp\\nvw-out';
    const rawfs = window.desktopAPI.rawfs;
    const native = JSON.parse((await rawfs.readFile(NV + '\\first-native.json', 'utf8')).text);
    const L = await import(FA_ASSET_URLS.transformersJs);
    L.env.useBrowserCache = true; L.env.allowLocalModels = false; L.env.backends.onnx.wasm.numThreads = 1;
    const model = await L.AutoModelForCausalLM.from_pretrained('onnx-community/Qwen3-0.6B-ONNX', { dtype: 'q8', device: 'wasm' });
    const sessKeys = Object.keys(model.sessions || {});
    const sess = model.sessions.model || model.sessions[sessKeys[0]];
    const inputs = sess.inputNames.map((n) => n);
    const outputs = sess.outputNames ? sess.outputNames.slice(0, 4).concat(['...']) : null;
    const meta = { sessions: sessKeys, inputNames: inputs, inputCount: inputs.length, outputNamesHead: outputs };
    const rows = [];
    for (const row of native.slice(0, 16)) {
        const n = row.ids.length;
        const feeds = {};
        feeds.input_ids = new L.Tensor('int64', BigInt64Array.from(row.ids.map(BigInt)), [1, n]);
        feeds.attention_mask = new L.Tensor('int64', BigInt64Array.from(Array(n).fill(1n)), [1, n]);
        if (inputs.indexOf('position_ids') >= 0) feeds.position_ids = new L.Tensor('int64', BigInt64Array.from(Array.from({ length: n }, (_, i) => BigInt(i))), [1, n]);
        for (const name of inputs) {
            if (name.indexOf('past_key_values.') === 0) feeds[name] = new L.Tensor('float32', new Float32Array(0), [1, 8, 0, 128]);
        }
        const out = await sess.run(feeds);
        const lg = out.logits || out[sess.outputNames[0]];
        const V = lg.dims[2], last = (n - 1) * V;
        const f = new Float32Array(V); for (let i = 0; i < V; i++) f[i] = lg.data[last + i];
        const bytes = new Uint8Array(f.buffer); let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        rows.push({ id: row.id, n, V, logits_b64: btoa(bin) });
        console.log('[bisect-wasm] ' + row.id + ' n=' + n + ' V=' + V + ' dims=' + lg.dims.join('x'));
    }
    await rawfs.writeFile(NV + '\\bisect-wasm-single-t1.json', { text: JSON.stringify({ meta, rows }) });
    return { meta, rows: rows.length };
})();
